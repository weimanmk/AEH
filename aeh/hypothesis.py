"""Short-term virtual-student hypotheses (spec section 6).

A hypothesis is a small, structured cognitive assumption set -- not a
personality label.  The set supports ``spawn`` / ``split`` / ``reweight`` /
``merge`` / ``prune`` and always keeps the posterior normalised over the
active hypotheses plus an explicit ``unknown`` bucket.  When no candidate
explains the evidence, ``unknown`` can dominate and :meth:`dominant` returns
``None`` instead of forcing a choice.

Bayesian reweighting includes an explicit noise term (spec 6.3) so that a
single correct/incorrect answer cannot make the posterior spuriously sharp.

Standard library only.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping

UNKNOWN_HYPOTHESIS_ID = "unknown"

ACTIVE = "active"
ARCHIVED = "archived"
SPLIT = "split"
MERGED = "merged"
PRUNED = "pruned"

#: Likelihood of the chance level used by the noise term.
CHANCE_LIKELIHOOD = 0.5
#: Default prior mass reserved for the "unknown" explanation during updates.
DEFAULT_UNKNOWN_PRIOR = 0.05


class HypothesisError(Exception):
    """Base class for hypothesis-set errors."""


class DuplicateHypothesisError(HypothesisError):
    """A hypothesis id was spawned twice."""


class UnknownHypothesisError(HypothesisError):
    """An operation referenced a hypothesis that does not exist."""


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
    def history(self) -> tuple[HypothesisTransition, ...]:
        return tuple(self._history)

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
    def spawn(self, hypothesis: Hypothesis, weight: float | None = None) -> Hypothesis:
        """Add a new candidate hypothesis."""
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
        self._record("spawn", (spawned.hypothesis_id,))
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

    def prune(self, hypothesis_id: str, reason: str = "") -> Hypothesis:
        """Archive a hypothesis; its mass moves to the ``unknown`` bucket."""
        hypothesis = self._require(hypothesis_id)
        moved = hypothesis.weight
        self._hypotheses[hypothesis_id] = replace(
            hypothesis, weight=0.0, status=PRUNED
        )
        self._unknown_weight += moved
        self._normalize()
        self._record("prune", (hypothesis_id,), reason)
        return self._hypotheses[hypothesis_id]

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


__all__ = [
    "Hypothesis",
    "HypothesisSet",
    "HypothesisTransition",
    "HypothesisError",
    "DuplicateHypothesisError",
    "UnknownHypothesisError",
    "UNKNOWN_HYPOTHESIS_ID",
    "ACTIVE",
    "ARCHIVED",
]
