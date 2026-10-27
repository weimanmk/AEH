"""Short-term virtual-student hypotheses (spec section 6).

A hypothesis is a small, structured cognitive assumption set -- not a
personality label.  The set supports ``spawn`` / ``split`` / ``reweight`` /
``merge`` / ``prune`` and always keeps the posterior normalised over the
active hypotheses plus an explicit ``unknown`` bucket.  When no candidate
explains the evidence, ``unknown`` can dominate and :meth:`dominant` returns
``None`` instead of forcing a choice.

Bayesian reweighting includes an explicit noise term (spec 6.3) so that a
single correct/incorrect answer cannot make the posterior spuriously sharp.

Step 13 completes the ensemble (spec 6.1-6.4 + 19.3):

* explicit generation triggers (``SPAWN_*``) and evidence-constrained
  ``generate`` instead of mechanically copying the strongest candidate;
* ``match`` turns an observation into per-hypothesis likelihoods and a
  posterior update;
* ``split_distinguishable`` refuses to split when the children are not
  separable, and ``merge_indistinguishable`` merges candidates that predict the
  same unseen behaviour while keeping their source history;
* elimination rules: ``prune_weak`` / ``prune_contradicted`` /
  ``prune_uninformative`` (all move mass to ``unknown``, never to another
  candidate);
* explicit ``unknown`` bucket management: ``set_unknown``,
  ``request_real_evidence`` and ``unknown_reasons``;
* ``fidelity`` reports behaviour-fidelity / calibration metrics (spec 19.3);
* ``to_snapshot`` / ``HypothesisSnapshotStore`` keep a snapshot session-scoped
  and TTL-bounded, and the persistence boundary is fail-closed:
  ``persist_to_twin`` always raises.

Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping, Sequence

UNKNOWN_HYPOTHESIS_ID = "unknown"

ACTIVE = "active"
ARCHIVED = "archived"
SPLIT = "split"
MERGED = "merged"
PRUNED = "pruned"

#: Version of the JSON-friendly snapshot/state representation.
SNAPSHOT_SCHEMA_VERSION = 1

#: Generation triggers from spec 6.2. A candidate is only spawned when one of
#: these conditions holds; str/candidate labels are recorded in the history.
SPAWN_UNEXPLAINED_STEP = "unexplained_step"
SPAWN_NEW_QUESTION_TYPE = "new_question_type"
SPAWN_CONFLICTING_EVIDENCE = "conflicting_evidence"
SPAWN_NEW_SUBJECT_SCOPE = "new_subject_scope"
SPAWN_DIVERSITY_COLLAPSE = "diversity_collapse"

#: Reasons the ``unknown`` bucket can grow (spec 6.2 "Unknown").
UNKNOWN_NO_CANDIDATE = "no_candidate"
UNKNOWN_NO_EXPLANATION = "no_explanation"
UNKNOWN_MISSING_EVIDENCE = "missing_evidence"
UNKNOWN_PRUNED_WEAK = "pruned_weak"
UNKNOWN_CONTRADICTED = "contradicted"
UNKNOWN_LOW_EXPLANATORY_POWER = "low_explanatory_power"

#: Likelihood of the chance level used by the noise term.
CHANCE_LIKELIHOOD = 0.5
#: Default prior mass reserved for the "unknown" explanation during updates.
DEFAULT_UNKNOWN_PRIOR = 0.05
#: Default snapshot lifetime (seconds) for the in-memory session store.
DEFAULT_SNAPSHOT_TTL_SECONDS = 15 * 60


class HypothesisError(Exception):
    """Base class for hypothesis-set errors."""


class DuplicateHypothesisError(HypothesisError):
    """A hypothesis id was spawned twice."""


class UnknownHypothesisError(HypothesisError):
    """An operation referenced a hypothesis that does not exist."""


class SnapshotScopeError(HypothesisError):
    """A snapshot was read or written with an invalid/foreign session scope."""


class HypothesisPersistenceError(HypothesisError):
    """Short-term hypotheses may never be written to the long-term twin."""


def _freeze_mapping(value: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return MappingProxyType(dict(value or {}))


@dataclass(frozen=True)
class Hypothesis:
    """A structured short-term cognitive hypothesis ``H_i``."""

    hypothesis_id: str
    subject_scope: tuple[str, ...] = ()
    knowledge_assumptions: Mapping[str, str] = field(default_factory=dict)
    strategy_policy: tuple[str, ...] = ()
    bug_rules: tuple[str, ...] = ()
    predicted_observable_behaviors: Mapping[str, float] = field(default_factory=dict)
    response_to_intervention_hypotheses: tuple[str, ...] = ()
    weight: float = 0.0
    evidence_refs: tuple[str, ...] = ()
    uncertainty: str = "high"
    status: str = ACTIVE
    parent_id: str | None = None
    merged_from: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "knowledge_assumptions", _freeze_mapping(self.knowledge_assumptions)
        )
        object.__setattr__(
            self,
            "predicted_observable_behaviors",
            _freeze_mapping(self.predicted_observable_behaviors),
        )
        if self.weight < 0.0:
            raise ValueError("weight must be >= 0")


@dataclass(frozen=True)
class HypothesisTransition:
    """Audit record for spawn/split/merge/prune/reweight."""

    kind: str
    hypothesis_ids: tuple[str, ...]
    detail: str = ""
    at: datetime | None = None


@dataclass(frozen=True)
class BehaviorObservation:
    """One (synthetic) observable behaviour used for matching/fidelity.

    ``behavior`` is a stable key shared with
    :attr:`Hypothesis.predicted_observable_behaviors`; ``outcome`` is whether
    the behaviour succeeded. The optional ``error_type`` / ``step`` /
    ``strategy`` fields let fidelity check whether the dominant hypothesis
    actually predicts the *kind* of error, not only its rate (spec 19.3).
    """

    observation_id: str
    behavior: str
    outcome: bool
    error_type: str | None = None
    step: str | None = None
    strategy: str | None = None


@dataclass(frozen=True)
class HypothesisMatch:
    """Result of matching observations against the ensemble (spec 6.3)."""

    likelihoods: Mapping[str, float]
    weights: Mapping[str, float]
    observed_behaviors: tuple[str, ...]
    covered_behaviors: tuple[str, ...]
    unexplained_behaviors: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "likelihoods", _freeze_mapping(self.likelihoods))
        object.__setattr__(self, "weights", _freeze_mapping(self.weights))


@dataclass(frozen=True)
class FidelityMetrics:
    """Hypothesis-ensemble fidelity metrics (spec 19.3).

    ``None`` always means "not computable from the supplied (synthetic)
    evidence", never a fabricated value. ``sufficient`` is False when there are
    fewer than ``min_observations`` observations.
    """

    observation_count: int
    covered: int
    coverage: float
    brier_score: float | None
    log_loss: float | None
    calibration_error: float | None
    accuracy: float | None
    unknown_share: float
    effective_hypotheses: float
    max_weight: float
    error_type_agreement: float | None
    step_agreement: float | None
    strategy_agreement: float | None
    anti_mismatch: float | None
    sufficient: bool


@dataclass(frozen=True)
class HypothesisSnapshot:
    """A session-scoped, non-durable short-term hypothesis snapshot.

    ``persists_to_long_term_twin`` is always ``False``: a snapshot is a
    transport/TTL object, not an observed event. The store never appends it to
    an event log and the long-term twin has no read or write path into it.
    """

    snapshot_id: str
    session_id: str
    schema_version: int
    created_at: datetime
    expires_at: datetime
    revision: int
    state: Mapping[str, Any]
    unknown_reasons: tuple[str, ...]
    needs_real_evidence: bool
    match_stats: Mapping[str, Any]
    bound_twin_version: int | None
    agent_id: str | None = None
    persists_to_long_term_twin: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "state", _freeze_mapping(self.state))
        object.__setattr__(self, "match_stats", _freeze_mapping(self.match_stats))


class HypothesisSet:
    """A normalised, auditable set of short-term hypotheses."""

    def __init__(
        self,
        hypotheses: Iterable[Hypothesis] = (),
        *,
        unknown_weight: float = 0.0,
    ) -> None:
        self._hypotheses: dict[str, Hypothesis] = {}
        self._history: list[HypothesisTransition] = []
        self._unknown_weight = max(0.0, float(unknown_weight))
        self._unknown_reasons: list[str] = []
        self._needs_real_evidence = False
        self._match_stats: dict[str, list[float]] = {}
        self._bound_twin_version: int | None = None
        for hypothesis in hypotheses:
            if hypothesis.hypothesis_id in self._hypotheses:
                raise DuplicateHypothesisError(hypothesis.hypothesis_id)
            self._hypotheses[hypothesis.hypothesis_id] = hypothesis
        self._normalize()

    # ------------------------------------------------------------------
    # Views
    # ------------------------------------------------------------------
    @property
    def unknown_weight(self) -> float:
        return self._unknown_weight

    @property
    def unknown_id(self) -> str:
        return UNKNOWN_HYPOTHESIS_ID

    @property
    def unknown_reasons(self) -> tuple[str, ...]:
        """Ordered, de-duplicated reasons the ``unknown`` bucket was grown."""
        return tuple(self._unknown_reasons)

    @property
    def needs_real_evidence(self) -> bool:
        """True when the ensemble refused to force a choice and asks for data."""
        return self._needs_real_evidence

    @property
    def match_stats(self) -> Mapping[str, Mapping[str, Any]]:
        """Per-hypothesis ``{count, mean}`` likelihood history for pruning."""
        return MappingProxyType(
            {
                hypothesis_id: MappingProxyType(
                    {"count": len(values), "mean": sum(values) / len(values)}
                )
                for hypothesis_id, values in self._match_stats.items()
                if values
            }
        )

    @property
    def history(self) -> tuple[HypothesisTransition, ...]:
        return tuple(self._history)

    @property
    def revision(self) -> int:
        """Monotonic revision of the hypothesis set (number of transitions)."""
        return len(self._history)

    @property
    def bound_twin_version(self) -> int | None:
        """The twin version this hypothesis set is bound to, if any."""
        return self._bound_twin_version

    def active(self) -> tuple[Hypothesis, ...]:
        return tuple(
            h
            for h in self._hypotheses.values()
            if h.status == ACTIVE and h.weight > 0.0
        )

    def get(self, hypothesis_id: str) -> Hypothesis | None:
        return self._hypotheses.get(hypothesis_id)

    def weights(self) -> dict[str, float]:
        """Posterior weights over active hypotheses plus ``unknown`` (sums to 1)."""
        result = {h.hypothesis_id: h.weight for h in self.active()}
        result[UNKNOWN_HYPOTHESIS_ID] = self._unknown_weight
        return result

    # Kept as an alias used by the other modules / docs.
    posterior_weights = weights

    def total_weight(self) -> float:
        return sum(self.weights().values())

    def dominant(self) -> Hypothesis | None:
        """Return the best active hypothesis, or ``None`` if ``unknown`` leads."""
        active = self.active()
        if not active:
            return None
        best = max(active, key=lambda h: (h.weight, h.hypothesis_id))
        if self._unknown_weight >= best.weight:
            return None
        return best

    # ------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------
    def spawn(
        self,
        hypothesis: Hypothesis,
        weight: float | None = None,
        *,
        trigger: str | None = None,
    ) -> Hypothesis:
        """Add a new candidate hypothesis.

        ``trigger`` is one of the ``SPAWN_*`` conditions (spec 6.2); it is
        recorded in the audit history. It is optional so the low-level call
        stays usable from tests and from :meth:`generate`.
        """
        if hypothesis.hypothesis_id in self._hypotheses:
            raise DuplicateHypothesisError(hypothesis.hypothesis_id)
        raw = hypothesis.weight if weight is None else weight
        if not self.active():
            # Before any candidate exists, all mass sits in ``unknown``.
            # The first spawned candidate claims that placeholder mass.
            self._unknown_weight = 0.0
        spawned = replace(hypothesis, weight=max(0.0, float(raw)), status=ACTIVE)
        self._hypotheses[spawned.hypothesis_id] = spawned
        self._normalize()
        self._record("spawn", (spawned.hypothesis_id,), trigger or "")
        return self._hypotheses[spawned.hypothesis_id]

    def split(
        self, hypothesis_id: str, children: Iterable[Hypothesis]
    ) -> tuple[Hypothesis, ...]:
        """Replace a hypothesis with distinguishable children (spec 6.2)."""
        parent = self._require(hypothesis_id)
        child_list = [c for c in children]
        if len(child_list) < 2:
            raise HypothesisError("split requires at least two children")
        for child in child_list:
            if child.hypothesis_id in self._hypotheses:
                raise DuplicateHypothesisError(child.hypothesis_id)
        total_relative = sum(max(0.0, float(c.weight)) for c in child_list) or 1.0
        parent_weight = parent.weight
        new_children = []
        for child in child_list:
            relative = max(0.0, float(child.weight)) / total_relative
            new_children.append(
                replace(
                    child,
                    weight=parent_weight * relative,
                    status=ACTIVE,
                    parent_id=parent.hypothesis_id,
                )
            )
        self._hypotheses[parent.hypothesis_id] = replace(
            parent, weight=0.0, status=SPLIT
        )
        for child in new_children:
            self._hypotheses[child.hypothesis_id] = child
        self._normalize()
        self._record(
            "split",
            (parent.hypothesis_id,) + tuple(c.hypothesis_id for c in new_children),
        )
        return tuple(self._hypotheses[c.hypothesis_id] for c in new_children)

    def merge(
        self,
        hypothesis_ids: Iterable[str],
        new_hypothesis: Hypothesis,
    ) -> Hypothesis:
        """Merge indistinguishable hypotheses, keeping source history."""
        ids = tuple(hypothesis_ids)
        if len(ids) < 2:
            raise HypothesisError("merge requires at least two hypotheses")
        if new_hypothesis.hypothesis_id in self._hypotheses:
            raise DuplicateHypothesisError(new_hypothesis.hypothesis_id)
        merged_weight = 0.0
        for hypothesis_id in ids:
            hypothesis = self._require(hypothesis_id)
            merged_weight += hypothesis.weight
            self._hypotheses[hypothesis_id] = replace(
                hypothesis, weight=0.0, status=MERGED
            )
        merged = replace(
            new_hypothesis,
            weight=merged_weight,
            status=ACTIVE,
            merged_from=ids,
        )
        self._hypotheses[merged.hypothesis_id] = merged
        self._normalize()
        self._record("merge", ids + (merged.hypothesis_id,))
        return self._hypotheses[merged.hypothesis_id]

    # ------------------------------------------------------------------
    # Generation / matching / split / merge / elimination rules (spec 6.2)
    # ------------------------------------------------------------------
    def similarity(self, first_id: str, second_id: str) -> float:
        """Return how indistinguishable two hypotheses are, in ``[0, 1]``.

        1.0 means "predicts the same unseen behaviour and carries the same
        rules"; 0.0 means maximally separable. Missing predictions default to
        chance (0.5) so an unmodelled behaviour is not treated as agreement.
        """
        return hypothesis_similarity(
            self._require(first_id), self._require(second_id)
        )

    def split_distinguishable(
        self,
        hypothesis_id: str,
        children: Iterable[Hypothesis],
        *,
        max_similarity: float = 0.9,
    ) -> tuple[Hypothesis, ...]:
        """Split only when the children are separable on the new question.

        Spec 6.2 requires that a split is actually distinguishable by a new
        item; otherwise the split is rejected and the parent stays intact.
        """
        if not 0.0 <= max_similarity <= 1.0:
            raise ValueError("max_similarity must be within [0, 1]")
        child_list = list(children)
        if len(child_list) < 2:
            raise HypothesisError("split requires at least two children")
        for index, first in enumerate(child_list):
            for second in child_list[index + 1 :]:
                if hypothesis_similarity(first, second) > max_similarity:
                    raise HypothesisError(
                        "split children are not distinguishable "
                        f"({first.hypothesis_id}, {second.hypothesis_id})"
                    )
        return self.split(hypothesis_id, child_list)

    def merge_indistinguishable(
        self,
        *,
        similarity_threshold: float = 0.9,
        id_factory: Callable[[tuple[str, ...]], str] | None = None,
    ) -> tuple[str, ...]:
        """Merge groups of active hypotheses that are nearly indistinguishable.

        Returns the ids of the merged hypotheses (in group order). Source ids
        are kept as :attr:`Hypothesis.merged_from` on the merged candidate.
        """
        if not 0.0 <= similarity_threshold <= 1.0:
            raise ValueError("similarity_threshold must be within [0, 1]")
        active = list(self.active())
        parent: dict[str, str] = {h.hypothesis_id: h.hypothesis_id for h in active}

        def find(item: str) -> str:
            while parent[item] != item:
                parent[item] = parent[parent[item]]
                item = parent[item]
            return item

        def union(first: str, second: str) -> None:
            root_first, root_second = find(first), find(second)
            if root_first != root_second:
                parent[max(root_first, root_second)] = min(root_first, root_second)

        for index, first in enumerate(active):
            for second in active[index + 1 :]:
                if hypothesis_similarity(first, second) >= similarity_threshold:
                    union(first.hypothesis_id, second.hypothesis_id)

        groups: dict[str, list[str]] = {}
        for hypothesis in active:
            groups.setdefault(find(hypothesis.hypothesis_id), []).append(
                hypothesis.hypothesis_id
            )
        merged_ids: list[str] = []
        for root in sorted(groups):
            members = sorted(groups[root])
            if len(members) < 2:
                continue
            new_id = (
                id_factory(tuple(members))
                if id_factory is not None
                else "m_" + "_".join(members)
            )
            new_id = self._unique_id(new_id)
            self.merge(members, self._merged_hypothesis(members, new_id))
            merged_ids.append(new_id)
        return tuple(merged_ids)

    def prune(self, hypothesis_id: str, reason: str = "") -> Hypothesis:
        """Archive a hypothesis; its mass moves to the ``unknown`` bucket."""
        hypothesis = self._require(hypothesis_id)
        moved = hypothesis.weight
        self._hypotheses[hypothesis_id] = replace(
            hypothesis, weight=0.0, status=PRUNED
        )
        self._unknown_weight += moved
        if reason and reason not in self._unknown_reasons:
            self._unknown_reasons.append(reason)
        self._normalize()
        self._record("prune", (hypothesis_id,), reason)
        return self._hypotheses[hypothesis_id]

    def prune_contradicted(
        self,
        *,
        min_matches: int = 2,
        max_mean_likelihood: float = 0.2,
        reason: str = UNKNOWN_CONTRADICTED,
    ) -> tuple[str, ...]:
        """Eliminate hypotheses whose matched likelihood stays very low.

        Only hypotheses with at least ``min_matches`` recorded matches are
        eligible, so one unusual answer cannot archive a candidate.
        """
        if min_matches < 1:
            raise ValueError("min_matches must be >= 1")
        if not 0.0 <= max_mean_likelihood <= 1.0:
            raise ValueError("max_mean_likelihood must be within [0, 1]")
        pruned: list[str] = []
        for hypothesis in sorted(
            self.active(), key=lambda h: (-h.weight, h.hypothesis_id)
        ):
            values = self._match_stats.get(hypothesis.hypothesis_id, [])
            if len(values) < min_matches:
                continue
            if sum(values) / len(values) < max_mean_likelihood:
                self.prune(hypothesis.hypothesis_id, reason)
                pruned.append(hypothesis.hypothesis_id)
        return tuple(pruned)

    def prune_uninformative(
        self,
        *,
        similarity_threshold: float = 0.95,
        reason: str = UNKNOWN_LOW_EXPLANATORY_POWER,
    ) -> tuple[str, ...]:
        """Archive candidates that add no unique explanation beyond a stronger one.

        A candidate is pruned when a *heavier* active hypothesis is at least
        ``similarity_threshold`` indistinguishable from it; the heavier
        candidate is kept, so the ensemble does not lose explanatory power.
        """
        if not 0.0 <= similarity_threshold <= 1.0:
            raise ValueError("similarity_threshold must be within [0, 1]")
        kept: list[Hypothesis] = []
        pruned: list[str] = []
        for hypothesis in sorted(
            self.active(), key=lambda h: (-h.weight, h.hypothesis_id)
        ):
            if any(
                hypothesis_similarity(hypothesis, stronger) >= similarity_threshold
                for stronger in kept
            ):
                self.prune(hypothesis.hypothesis_id, reason)
                pruned.append(hypothesis.hypothesis_id)
            else:
                kept.append(hypothesis)
        return tuple(pruned)

    # ------------------------------------------------------------------
    # Evidence-constrained generation and matching (spec 6.2 / 6.3)
    # ------------------------------------------------------------------
    def generate(
        self,
        observations: Mapping[str, float],
        candidates: Iterable[Hypothesis],
        *,
        behavior_threshold: float = 0.5,
        min_gain: float = 0.05,
        weight: float = 1.0,
        trigger: str = SPAWN_UNEXPLAINED_STEP,
    ) -> tuple[Hypothesis, ...]:
        """Spawn only candidates that explain currently unexplained behaviour.

        A behaviour is "unexplained" when no active hypothesis predicts it
        above ``behavior_threshold`` (or nobody predicts it at all). A
        candidate is spawned only if it beats the current best explanation by
        at least ``min_gain`` on at least one unexplained behaviour. This is
        the "resample under evidence constraints" rule from spec 6.2: new
        candidates are not mechanical copies of the leader.
        """
        if not 0.0 <= behavior_threshold <= 1.0:
            raise ValueError("behavior_threshold must be within [0, 1]")
        if not 0.0 <= min_gain <= 1.0:
            raise ValueError("min_gain must be within [0, 1]")
        active = self.active()
        unexplained: dict[str, float] = {}
        for behavior in observations:
            best = max(
                (
                    float(h.predicted_observable_behaviors.get(behavior, 0.0))
                    for h in active
                ),
                default=0.0,
            )
            if best < behavior_threshold:
                unexplained[behavior] = best
        if not unexplained:
            return ()
        spawned: list[Hypothesis] = []
        for candidate in candidates:
            if candidate.hypothesis_id in self._hypotheses:
                continue
            gain = max(
                (
                    float(candidate.predicted_observable_behaviors.get(behavior, 0.0))
                    - best
                    for behavior, best in unexplained.items()
                ),
                default=0.0,
            )
            if gain >= min_gain:
                spawned.append(
                    self.spawn(candidate, weight=weight, trigger=trigger)
                )
        return tuple(spawned)

    def match(
        self,
        observations: Mapping[str, float],
        *,
        evidence_id: str | None = None,
        noise: float = 0.05,
        unknown_prior: float | None = None,
        unknown_likelihood: float = CHANCE_LIKELIHOOD,
        smoothing: float = 0.02,
    ) -> HypothesisMatch:
        """Turn observations into per-hypothesis likelihoods + posterior.

        ``observations`` maps a behaviour key to its observed outcome in
        ``[0, 1]`` (0/1 for a single trial). Each active hypothesis gets a
        Bernoulli likelihood from its own
        :attr:`predicted_observable_behaviors`; a hypothesis that models none
        of the observed behaviours keeps a neutral chance likelihood so it is
        not spuriously rewarded or punished.
        """
        if not 0.0 <= smoothing < 0.5:
            raise ValueError("smoothing must be within [0, 0.5)")
        observed = {
            str(behavior): float(outcome)
            for behavior, outcome in observations.items()
        }
        for behavior, outcome in observed.items():
            if not 0.0 <= outcome <= 1.0:
                raise ValueError(f"observation[{behavior}] must be within [0, 1]")
        active = self.active()
        likelihoods: dict[str, float] = {}
        covered: set[str] = set()
        for hypothesis in active:
            log_likelihood = 0.0
            used = 0
            for behavior, outcome in observed.items():
                predicted = hypothesis.predicted_observable_behaviors.get(behavior)
                if predicted is None:
                    continue
                probability = smoothing + (1.0 - 2.0 * smoothing) * min(
                    1.0, max(0.0, float(predicted))
                )
                log_likelihood += outcome * math.log(probability) + (
                    1.0 - outcome
                ) * math.log(1.0 - probability)
                used += 1
                covered.add(behavior)
            likelihood = math.exp(log_likelihood) if used else CHANCE_LIKELIHOOD
            likelihoods[hypothesis.hypothesis_id] = min(1.0, max(0.0, likelihood))
            self._match_stats.setdefault(hypothesis.hypothesis_id, []).append(
                likelihoods[hypothesis.hypothesis_id]
            )
        unexplained = tuple(b for b in observed if b not in covered)
        weights = self.reweight(
            likelihoods,
            evidence_id=evidence_id,
            noise=noise,
            unknown_prior=unknown_prior,
            unknown_likelihood=unknown_likelihood,
        )
        return HypothesisMatch(
            likelihoods=likelihoods,
            weights=weights,
            observed_behaviors=tuple(observed.keys()),
            covered_behaviors=tuple(b for b in observed if b in covered),
            unexplained_behaviors=unexplained,
        )

    # ------------------------------------------------------------------
    # Unknown bucket management (spec 6.2 "Unknown")
    # ------------------------------------------------------------------
    def set_unknown(
        self, weight: float, reason: str = UNKNOWN_NO_CANDIDATE
    ) -> float:
        """Set the unknown mass explicitly and record why it changed."""
        value = float(weight)
        if not math.isfinite(value) or value < 0.0:
            raise ValueError("unknown weight must be a finite value >= 0")
        self._unknown_weight = value
        if reason and reason not in self._unknown_reasons:
            self._unknown_reasons.append(reason)
        self._normalize()
        self._record("unknown", (), f"reason={reason}")
        return self._unknown_weight

    def request_real_evidence(self, reason: str = UNKNOWN_NO_EXPLANATION) -> None:
        """Mark that the ensemble cannot explain the evidence and needs data."""
        if reason and reason not in self._unknown_reasons:
            self._unknown_reasons.append(reason)
        self._needs_real_evidence = True
        self._record("evidence_request", (), reason)

    def resolve_evidence_request(self) -> None:
        """Clear the "needs real evidence" flag once evidence arrived."""
        self._needs_real_evidence = False
        self._record("evidence_resolved", ())

    def persist_to_twin(self, *args: Any, **kwargs: Any) -> None:
        """Fail closed: short-term hypotheses are never long-term evidence."""
        raise HypothesisPersistenceError(
            "short-term hypothesis snapshots must not be written to the "
            "long-term twin; only observed events may be appended"
        )

    def reweight(
        self,
        likelihoods: Mapping[str, float],
        *,
        evidence_id: str | None = None,
        noise: float = 0.05,
        unknown_prior: float | None = None,
        unknown_likelihood: float = CHANCE_LIKELIHOOD,
    ) -> dict[str, float]:
        """Bayesian posterior update with an explicit noise term.

        ``likelihoods`` maps active hypothesis ids to ``P(E | H_i)``.  The
        posterior is normalised over active hypotheses plus ``unknown``.
        """
        if not 0.0 <= noise <= 1.0:
            raise ValueError("noise must be within [0, 1]")

        prior = self.weights()
        prior_unknown = (
            max(self._unknown_weight, DEFAULT_UNKNOWN_PRIOR)
            if unknown_prior is None
            else float(unknown_prior)
        )
        if not prior and prior_unknown <= 0.0:
            self._unknown_weight = 1.0
            return self.weights()

        posterior: dict[str, float] = {}
        for hypothesis in self.active():
            value = float(likelihoods.get(hypothesis.hypothesis_id, 0.5))
            p_observed = (1.0 - noise) * value + noise * CHANCE_LIKELIHOOD
            posterior[hypothesis.hypothesis_id] = (
                prior.get(hypothesis.hypothesis_id, hypothesis.weight) * p_observed
            )

        p_unknown = (1.0 - noise) * float(unknown_likelihood) + noise * CHANCE_LIKELIHOOD
        unknown_prior = max(0.0, float(prior_unknown))
        total = sum(posterior.values()) + unknown_prior * p_unknown
        if total <= 0.0:
            # No hypothesis (nor unknown) explains the evidence: stay unknown.
            self._unknown_weight = 1.0
            for hypothesis in self.active():
                self._hypotheses[hypothesis.hypothesis_id] = replace(
                    hypothesis, weight=0.0
                )
            self._mark_unknown_lead()
            return self.weights()

        for hypothesis in self.active():
            raw = posterior[hypothesis.hypothesis_id]
            refs = hypothesis.evidence_refs
            if evidence_id is not None and evidence_id not in refs:
                refs = refs + (evidence_id,)
            self._hypotheses[hypothesis.hypothesis_id] = replace(
                hypothesis,
                weight=raw / total,
                evidence_refs=refs,
            )
        self._unknown_weight = (unknown_prior * p_unknown) / total
        self._normalize()
        self._record("reweight", tuple(posterior.keys()), f"noise={noise}")
        if self.dominant() is None:
            self._mark_unknown_lead()
        return self.weights()

    def resample(
        self, candidates: Iterable[Hypothesis], *, min_diversity: float = 0.15
    ) -> tuple[Hypothesis, ...]:
        """Add evidence-constrained alternatives when diversity collapses."""
        active = self.active()
        max_weight = max((h.weight for h in active), default=0.0)
        if active and max_weight < 1.0 - min_diversity:
            return ()
        spawned = []
        for candidate in candidates:
            if candidate.hypothesis_id in self._hypotheses:
                continue
            spawned.append(self.spawn(candidate))
        return tuple(spawned)

    def active_evidence_refs(self) -> frozenset[str]:
        """Union of evidence ids referenced by active hypotheses."""
        refs: set[str] = set()
        for hypothesis in self.active():
            refs.update(hypothesis.evidence_refs)
        return frozenset(refs)

    def fidelity(
        self,
        observations: Sequence[BehaviorObservation],
        *,
        min_observations: int = 5,
        bins: int = 5,
        recent_evidence_id: str | None = None,
    ) -> FidelityMetrics:
        """Compute behaviour-fidelity and calibration metrics (spec 19.3).

        The ensemble probability for an observation is the posterior-weighted
        mixture of each active hypothesis's prediction plus the ``unknown``
        bucket at chance. Agreement metrics compare the observation's error
        type / step / strategy with the *dominant* hypothesis's rules, and are
        ``None`` when there is no dominant hypothesis or no relevant
        observation. ``anti_mismatch`` is the share of active mass that was
        updated by ``recent_evidence_id`` (None when not supplied).
        """
        if min_observations < 0:
            raise ValueError("min_observations must be >= 0")
        if bins < 1:
            raise ValueError("bins must be >= 1")
        active = self.active()
        weight_total = sum(h.weight for h in active)
        observed = list(observations)
        predictions: list[float] = []
        covered = 0
        for observation in observed:
            mixture = 0.0
            any_prediction = False
            for hypothesis in active:
                predicted = hypothesis.predicted_observable_behaviors.get(
                    observation.behavior
                )
                if predicted is None:
                    continue
                any_prediction = True
                mixture += hypothesis.weight * min(1.0, max(0.0, float(predicted)))
            if any_prediction:
                covered += 1
                probability = mixture
            else:
                probability = 0.0
            # Active weights plus unknown sum to 1; unknown predicts chance.
            predictions.append(probability + self._unknown_weight * CHANCE_LIKELIHOOD)

        count = len(observed)
        brier: float | None = None
        log_loss: float | None = None
        accuracy: float | None = None
        calibration_error: float | None = None
        if count:
            probabilities = predictions
            outcomes = [1.0 if o.outcome else 0.0 for o in observed]
            brier = sum(
                (p - y) ** 2 for p, y in zip(probabilities, outcomes)
            ) / count
            clipped = [min(1.0 - 1e-9, max(1e-9, p)) for p in probabilities]
            log_loss = -sum(
                y * math.log(p) + (1.0 - y) * math.log(1.0 - p)
                for p, y in zip(clipped, outcomes)
            ) / count
            accuracy = sum(
                1.0 for p, y in zip(probabilities, outcomes) if (p >= 0.5) == (y == 1.0)
            ) / count
            calibration_error = _expected_calibration_error(
                probabilities, outcomes, bins
            )
            predictions = probabilities

        weights = self.weights()
        effective = 1.0 / sum(value * value for value in weights.values())
        max_weight = max((h.weight for h in active), default=0.0)
        dominant = self.dominant()
        error_type_agreement = _agreement(
            dominant,
            [o for o in observed if not o.outcome and o.error_type is not None],
            lambda o: o.error_type,
            lambda h: h.bug_rules,
        )
        step_agreement = _agreement(
            dominant,
            [o for o in observed if not o.outcome and o.step is not None],
            lambda o: o.step,
            lambda h: h.bug_rules,
        )
        strategy_agreement = _agreement(
            dominant,
            [o for o in observed if o.strategy is not None],
            lambda o: o.strategy,
            lambda h: h.strategy_policy,
        )
        anti_mismatch: float | None = None
        if recent_evidence_id is not None and weight_total > 0.0:
            updated = sum(
                h.weight
                for h in active
                if recent_evidence_id in h.evidence_refs
            )
            anti_mismatch = updated / weight_total

        return FidelityMetrics(
            observation_count=count,
            covered=covered,
            coverage=(covered / count) if count else 0.0,
            brier_score=brier,
            log_loss=log_loss,
            calibration_error=calibration_error,
            accuracy=accuracy,
            unknown_share=self._unknown_weight,
            effective_hypotheses=effective,
            max_weight=max_weight,
            error_type_agreement=error_type_agreement,
            step_agreement=step_agreement,
            strategy_agreement=strategy_agreement,
            anti_mismatch=anti_mismatch,
            sufficient=count >= min_observations,
        )

    # ------------------------------------------------------------------
    # Snapshot / session boundary
    # ------------------------------------------------------------------
    def to_state(self) -> dict[str, Any]:
        """JSON-friendly wire state, identical to the TS ``toState()`` shape."""
        return {
            "hypotheses": [
                {
                    "hypothesisId": h.hypothesis_id,
                    "subjectScope": list(h.subject_scope),
                    "knowledgeAssumptions": dict(h.knowledge_assumptions),
                    "strategyPolicy": list(h.strategy_policy),
                    "bugRules": list(h.bug_rules),
                    "predictedObservableBehaviors": dict(
                        h.predicted_observable_behaviors
                    ),
                    "responseToIntervention": list(h.response_to_intervention_hypotheses),
                    "weight": h.weight,
                    "evidenceRefs": list(h.evidence_refs),
                    "uncertainty": h.uncertainty,
                    "status": h.status,
                    "parentId": h.parent_id,
                    "mergedFrom": list(h.merged_from),
                }
                for h in self._hypotheses.values()
            ],
            "unknownWeight": self._unknown_weight,
        }

    @classmethod
    def from_state(cls, state: Mapping[str, Any]) -> "HypothesisSet":
        """Rehydrate the wire state; unknown reasons/match stats start empty."""
        hypotheses = [
            Hypothesis(
                hypothesis_id=record["hypothesisId"],
                subject_scope=tuple(record.get("subjectScope", ())),
                knowledge_assumptions=dict(record.get("knowledgeAssumptions", {})),
                strategy_policy=tuple(record.get("strategyPolicy", ())),
                bug_rules=tuple(record.get("bugRules", ())),
                predicted_observable_behaviors=dict(
                    record.get("predictedObservableBehaviors", {})
                ),
                response_to_intervention_hypotheses=tuple(
                    record.get("responseToIntervention", ())
                ),
                weight=float(record.get("weight", 0.0)),
                evidence_refs=tuple(record.get("evidenceRefs", ())),
                uncertainty=record.get("uncertainty", "high"),
                status=record.get("status", ACTIVE),
                parent_id=record.get("parentId"),
                merged_from=tuple(record.get("mergedFrom", ())),
            )
            for record in state.get("hypotheses", ())
        ]
        return cls(hypotheses, unknown_weight=float(state.get("unknownWeight", 0.0)))

    def to_snapshot(
        self,
        session_id: str,
        *,
        snapshot_id: str | None = None,
        agent_id: str | None = None,
        ttl_seconds: int = DEFAULT_SNAPSHOT_TTL_SECONDS,
        now: datetime | None = None,
    ) -> HypothesisSnapshot:
        """Freeze a session-scoped snapshot (never long-term evidence)."""
        if not isinstance(session_id, str) or not session_id:
            raise SnapshotScopeError("session_id is required for a snapshot")
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
            raise ValueError("ttl_seconds must be an integer")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be > 0")
        created = now or datetime.now(timezone.utc)
        snapshot_id = snapshot_id or f"hyp_{session_id}_{self.revision}"
        return HypothesisSnapshot(
            snapshot_id=snapshot_id,
            session_id=str(session_id),
            schema_version=SNAPSHOT_SCHEMA_VERSION,
            created_at=created,
            expires_at=created + timedelta(seconds=ttl_seconds),
            revision=self.revision,
            state=self.to_state(),
            unknown_reasons=self.unknown_reasons,
            needs_real_evidence=self._needs_real_evidence,
            match_stats={
                hypothesis_id: {
                    "count": len(values),
                    "mean": sum(values) / len(values),
                }
                for hypothesis_id, values in self._match_stats.items()
                if values
            },
            bound_twin_version=self._bound_twin_version,
            agent_id=agent_id,
            persists_to_long_term_twin=False,
        )

    @classmethod
    def from_snapshot(cls, snapshot: HypothesisSnapshot) -> "HypothesisSet":
        """Restore a set from a snapshot; only the restoring session may do so."""
        if snapshot.persists_to_long_term_twin:
            raise HypothesisPersistenceError(
                "refusing to restore a snapshot marked as long-term evidence"
            )
        restored = cls.from_state(snapshot.state)
        restored._unknown_reasons = list(snapshot.unknown_reasons)
        restored._needs_real_evidence = bool(snapshot.needs_real_evidence)
        restored._bound_twin_version = snapshot.bound_twin_version
        restored._match_stats = {
            str(hypothesis_id): [float(stats["mean"])] * int(stats["count"])
            for hypothesis_id, stats in (snapshot.match_stats or {}).items()
        }
        return restored

    def _unique_id(self, candidate: str) -> str:
        if candidate not in self._hypotheses:
            return candidate
        suffix = 2
        while f"{candidate}_{suffix}" in self._hypotheses:
            suffix += 1
        return f"{candidate}_{suffix}"

    def _merged_hypothesis(
        self, member_ids: Sequence[str], new_id: str
    ) -> Hypothesis:
        members = [self._require(member_id) for member_id in member_ids]
        representative = min(
            members, key=lambda h: (-h.weight, h.hypothesis_id)
        )
        behavior_keys: set[str] = set()
        for member in members:
            behavior_keys.update(member.predicted_observable_behaviors.keys())
        predicted: dict[str, float] = {}
        for key in sorted(behavior_keys):
            values = [
                float(member.predicted_observable_behaviors[key])
                for member in members
                if key in member.predicted_observable_behaviors
            ]
            predicted[key] = sum(values) / len(values) if values else CHANCE_LIKELIHOOD
        return Hypothesis(
            hypothesis_id=new_id,
            subject_scope=tuple(
                dict.fromkeys(
                    scope for member in members for scope in member.subject_scope
                )
            ),
            knowledge_assumptions=dict(representative.knowledge_assumptions),
            strategy_policy=tuple(
                dict.fromkeys(
                    rule for member in members for rule in member.strategy_policy
                )
            ),
            bug_rules=tuple(
                dict.fromkeys(
                    rule for member in members for rule in member.bug_rules
                )
            ),
            predicted_observable_behaviors=predicted,
            response_to_intervention_hypotheses=tuple(
                dict.fromkeys(
                    rule
                    for member in members
                    for rule in member.response_to_intervention_hypotheses
                )
            ),
            weight=0.0,
            uncertainty="medium",
        )

    def prune_weak(
        self, threshold: float = 0.01, reason: str = UNKNOWN_PRUNED_WEAK
    ) -> tuple[str, ...]:
        """Prune active hypotheses whose posterior falls below ``threshold``.

        The mass of each pruned hypothesis moves to the explicit ``unknown``
        bucket, so the posterior stays normalised and the set never forces a
        choice between negligible candidates.
        """
        if not 0.0 <= threshold:
            raise ValueError("threshold must be >= 0")
        pruned: list[str] = []
        for hypothesis in list(self._hypotheses.values()):
            if (
                hypothesis.status == ACTIVE
                and 0.0 < hypothesis.weight < threshold
            ):
                self.prune(hypothesis.hypothesis_id, reason)
                pruned.append(hypothesis.hypothesis_id)
        return tuple(pruned)

    def bind_twin_version(self, version: int) -> None:
        """Record that this set belongs to a specific twin version (Step 12).

        The binding is part of the audit history and lets a twin checkpoint be
        restored together with the hypothesis revision it was created from.
        """
        if isinstance(version, bool) or not isinstance(version, int) or version < 0:
            raise ValueError("version must be a non-negative integer")
        self._bound_twin_version = version
        self._record("bind", (), f"twin_version={version}")

    def clone(self) -> "HypothesisSet":
        """Return an independent copy preserving weights, statuses and history.

        Frozen :class:`Hypothesis` values are shared safely; the containers and
        the transition list are copied so a twin checkpoint cannot be mutated
        by later hypothesis operations.
        """
        clone = HypothesisSet.__new__(HypothesisSet)
        clone._hypotheses = dict(self._hypotheses)
        clone._history = list(self._history)
        clone._unknown_weight = self._unknown_weight
        clone._unknown_reasons = list(self._unknown_reasons)
        clone._needs_real_evidence = self._needs_real_evidence
        clone._match_stats = {
            hypothesis_id: list(values)
            for hypothesis_id, values in self._match_stats.items()
        }
        clone._bound_twin_version = self._bound_twin_version
        return clone

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _require(self, hypothesis_id: str) -> Hypothesis:
        hypothesis = self._hypotheses.get(hypothesis_id)
        if hypothesis is None:
            raise UnknownHypothesisError(hypothesis_id)
        return hypothesis

    def _normalize(self) -> None:
        active = [h for h in self._hypotheses.values() if h.status == ACTIVE]
        total = sum(h.weight for h in active) + self._unknown_weight
        if total <= 0.0:
            for hypothesis in self._hypotheses.values():
                if hypothesis.status == ACTIVE:
                    self._hypotheses[hypothesis.hypothesis_id] = replace(
                        hypothesis, weight=0.0
                    )
            self._unknown_weight = 1.0
            return
        for hypothesis in active:
            self._hypotheses[hypothesis.hypothesis_id] = replace(
                hypothesis, weight=hypothesis.weight / total
            )
        self._unknown_weight /= total

    def _mark_unknown_lead(self) -> None:
        """When no candidate explains the evidence, ask for real data."""
        self._needs_real_evidence = True
        if UNKNOWN_NO_EXPLANATION not in self._unknown_reasons:
            self._unknown_reasons.append(UNKNOWN_NO_EXPLANATION)

    def _record(
        self, kind: str, hypothesis_ids: tuple[str, ...], detail: str = ""
    ) -> None:
        self._history.append(
            HypothesisTransition(
                kind=kind,
                hypothesis_ids=hypothesis_ids,
                detail=detail,
                at=datetime.now(timezone.utc),
            )
        )


def _set_jaccard(first: Iterable[str], second: Iterable[str]) -> float:
    first_set, second_set = set(first), set(second)
    if not first_set and not second_set:
        return 1.0
    union = first_set | second_set
    return len(first_set & second_set) / len(union) if union else 1.0


def hypothesis_similarity(first: Hypothesis, second: Hypothesis) -> float:
    """Similarity of two hypotheses on unseen-behaviour prediction + rules.

    Weighted so behaviour prediction (the spec 6.2 merge criterion) dominates,
    while equal bug rules / strategy policies still pull the value up. Both
    sides missing a prediction default to chance, so two hypotheses that model
    nothing are *not* automatically treated as distinguishable.
    """
    keys = set(first.predicted_observable_behaviors) | set(
        second.predicted_observable_behaviors
    )
    if keys:
        differences = [
            abs(
                float(first.predicted_observable_behaviors.get(key, CHANCE_LIKELIHOOD))
                - float(second.predicted_observable_behaviors.get(key, CHANCE_LIKELIHOOD))
            )
            for key in keys
        ]
        behavior_similarity = 1.0 - sum(differences) / len(differences)
    else:
        behavior_similarity = 1.0
    return (
        0.6 * behavior_similarity
        + 0.2 * _set_jaccard(first.bug_rules, second.bug_rules)
        + 0.2 * _set_jaccard(first.strategy_policy, second.strategy_policy)
    )


def _expected_calibration_error(
    probabilities: Sequence[float], outcomes: Sequence[float], bins: int
) -> float:
    total = len(probabilities)
    if total == 0:
        return 0.0
    error = 0.0
    for index in range(bins):
        low = index / bins
        high = (index + 1) / bins
        members = [
            (p, y)
            for p, y in zip(probabilities, outcomes)
            if (low <= p < high) or (index == bins - 1 and p == 1.0)
        ]
        if not members:
            continue
        mean_probability = sum(p for p, _ in members) / len(members)
        mean_outcome = sum(y for _, y in members) / len(members)
        error += (len(members) / total) * abs(mean_probability - mean_outcome)
    return error


def _agreement(
    dominant: Hypothesis | None,
    observations: Sequence[BehaviorObservation],
    value_of: Callable[[BehaviorObservation], str | None],
    rules_of: Callable[[Hypothesis], tuple[str, ...]],
) -> float | None:
    if dominant is None or not observations:
        return None
    rules = set(rules_of(dominant))
    agreed = sum(1 for observation in observations if value_of(observation) in rules)
    return agreed / len(observations)



class HypothesisSnapshotStore:
    """In-memory, session-scoped, TTL-bounded snapshot store.

    Mirrors the TypeScript ``HypothesisSnapshotStore`` / host session store: a
    snapshot is only readable by the exact session/agent scope that wrote it,
    expires after ``ttl_seconds``, and is dropped on ``end_session`` or
    ``clear``. The store exposes counts only (never hypothesis contents or raw
    scope ids) and can never write to the long-term twin. A production adapter
    still needs a durable, access-controlled session store with the same
    semantics.
    """

    def __init__(
        self,
        *,
        ttl_seconds: int = DEFAULT_SNAPSHOT_TTL_SECONDS,
        now: Callable[[], datetime] | None = None,
        max_entries_per_scope: int = 16,
        max_entries: int = 512,
    ) -> None:
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
            raise ValueError("ttl_seconds must be an integer")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be > 0")
        if not isinstance(max_entries_per_scope, int) or max_entries_per_scope <= 0:
            raise ValueError("max_entries_per_scope must be a positive integer")
        if not isinstance(max_entries, int) or max_entries <= 0:
            raise ValueError("max_entries must be a positive integer")
        self._ttl_seconds = ttl_seconds
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._max_entries_per_scope = max_entries_per_scope
        self._max_entries = max_entries
        self._records: dict[str, HypothesisSnapshot] = {}
        self._by_scope: dict[str, list[str]] = {}
        self._counter = 0

    @property
    def ttl_seconds(self) -> int:
        return self._ttl_seconds

    def put(
        self,
        hypothesis_set: HypothesisSet,
        *,
        session_id: str,
        agent_id: str | None = None,
        snapshot_id: str | None = None,
    ) -> HypothesisSnapshot:
        scope_key = _scope_key(session_id, agent_id)
        self.sweep()
        if snapshot_id is None:
            self._counter += 1
            snapshot_id = f"hyp_{self._counter:x}"
        snapshot = hypothesis_set.to_snapshot(
            session_id,
            snapshot_id=snapshot_id,
            agent_id=agent_id,
            ttl_seconds=self._ttl_seconds,
            now=self._now(),
        )
        self._records[snapshot.snapshot_id] = snapshot
        refs = self._by_scope.setdefault(scope_key, [])
        refs.append(snapshot.snapshot_id)
        self._enforce_caps()
        return snapshot

    def get(
        self,
        snapshot_id: str,
        *,
        session_id: str,
        agent_id: str | None = None,
    ) -> HypothesisSnapshot | None:
        scope_key = _scope_key(session_id, agent_id)
        snapshot = self._records.get(snapshot_id)
        if snapshot is None:
            return None
        if self._is_expired(snapshot):
            self._remove(snapshot_id)
            return None
        if _scope_key(snapshot.session_id, snapshot.agent_id) != scope_key:
            return None
        return snapshot

    def delete(
        self,
        snapshot_id: str,
        *,
        session_id: str,
        agent_id: str | None = None,
    ) -> bool:
        scope_key = _scope_key(session_id, agent_id)
        snapshot = self._records.get(snapshot_id)
        if snapshot is None:
            return False
        if _scope_key(snapshot.session_id, snapshot.agent_id) != scope_key:
            return False
        self._remove(snapshot_id)
        return True

    def end_session(self, session_id: str) -> int:
        """Remove every snapshot for a session (across agent scopes)."""
        if not isinstance(session_id, str) or not session_id:
            return 0
        removed = 0
        for snapshot_id, snapshot in list(self._records.items()):
            if snapshot.session_id == session_id:
                self._remove(snapshot_id)
                removed += 1
        return removed

    def sweep(self) -> int:
        removed = 0
        for snapshot_id, snapshot in list(self._records.items()):
            if self._is_expired(snapshot):
                self._remove(snapshot_id)
                removed += 1
        return removed

    def clear(self) -> int:
        removed = len(self._records)
        self._records.clear()
        self._by_scope.clear()
        return removed

    @property
    def size(self) -> int:
        return len(self._records)

    def snapshot(self) -> dict[str, Any]:
        """Counts-only audit view; never hypothesis contents or raw scope ids."""
        expired = sum(
            1 for snapshot in self._records.values() if self._is_expired(snapshot)
        )
        return {
            "entries": len(self._records),
            "scopes": len(self._by_scope),
            "expired": expired,
            "sessionScoped": True,
            "longTermTwinWrite": False,
        }

    def _is_expired(self, snapshot: HypothesisSnapshot) -> bool:
        return self._now() >= snapshot.expires_at

    def _remove(self, snapshot_id: str) -> None:
        snapshot = self._records.pop(snapshot_id, None)
        if snapshot is None:
            return
        key = _scope_key(snapshot.session_id, snapshot.agent_id)
        refs = self._by_scope.get(key)
        if refs is None:
            return
        next_refs = [ref for ref in refs if ref != snapshot_id]
        if next_refs:
            self._by_scope[key] = next_refs
        else:
            self._by_scope.pop(key, None)

    def _enforce_caps(self) -> None:
        for key, refs in self._by_scope.items():
            while len(refs) > self._max_entries_per_scope:
                oldest = refs.pop(0)
                self._records.pop(oldest, None)
        if len(self._records) <= self._max_entries:
            return
        ordered = sorted(
            self._records.values(), key=lambda snapshot: snapshot.created_at
        )
        excess = len(self._records) - self._max_entries
        for snapshot in ordered[:excess]:
            self._remove(snapshot.snapshot_id)


def _scope_key(session_id: str, agent_id: str | None) -> str:
    if not isinstance(session_id, str) or not session_id:
        raise SnapshotScopeError("session_id is required for session-scoped state")
    if len(session_id) > 200 or "\n" in session_id or "\r" in session_id:
        raise SnapshotScopeError("session_id must be a short single-line reference")
    if agent_id is not None and (
        not isinstance(agent_id, str) or not agent_id or len(agent_id) > 200
    ):
        raise SnapshotScopeError("agent_id must be a short non-empty reference")
    return f"{session_id}\u0000{agent_id or ''}"


__all__ = [
    "Hypothesis",
    "HypothesisSet",
    "HypothesisTransition",
    "HypothesisMatch",
    "BehaviorObservation",
    "FidelityMetrics",
    "HypothesisSnapshot",
    "HypothesisSnapshotStore",
    "HypothesisError",
    "DuplicateHypothesisError",
    "UnknownHypothesisError",
    "SnapshotScopeError",
    "HypothesisPersistenceError",
    "hypothesis_similarity",
    "UNKNOWN_HYPOTHESIS_ID",
    "ACTIVE",
    "ARCHIVED",
    "SPLIT",
    "MERGED",
    "PRUNED",
    "SNAPSHOT_SCHEMA_VERSION",
    "SPAWN_UNEXPLAINED_STEP",
    "SPAWN_NEW_QUESTION_TYPE",
    "SPAWN_CONFLICTING_EVIDENCE",
    "SPAWN_NEW_SUBJECT_SCOPE",
    "SPAWN_DIVERSITY_COLLAPSE",
    "UNKNOWN_NO_CANDIDATE",
    "UNKNOWN_NO_EXPLANATION",
    "UNKNOWN_MISSING_EVIDENCE",
    "UNKNOWN_PRUNED_WEAK",
    "UNKNOWN_CONTRADICTED",
    "UNKNOWN_LOW_EXPLANATORY_POWER",
    "CHANCE_LIKELIHOOD",
    "DEFAULT_UNKNOWN_PRIOR",
    "DEFAULT_SNAPSHOT_TTL_SECONDS",
]
