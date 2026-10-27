"""Active diagnosis: backward tracing and discriminating probe selection (spec §7).

The base objective is expected information gain over the current hypothesis
posterior, penalised by time, risk, answer uncertainty and cognitive load:

.. math::

    q^* = \\arg\\max_q \\{ IG(q) + \\alpha TeachingValue(q)
          - \\beta Time(q) - \\gamma Risk(q)
          - \\delta Load(q) - \\zeta Uncertainty(q) \\}

Only gate-allowed candidates are considered (fail-closed), and the student may
skip at any time.

Step 14 completes the loop on top of that core (spec §7.1–7.3):

* ``trace_backward`` implements Observe → Localize → Expand: it locates the
  first step that deviates from the expected rule, then expands the error-rule
  graph / ``REQUIRES`` relations into several upstream explanations
  (misconception, missing prerequisite, transient slip) with normalised
  plausibility weights that can be fed straight into
  :class:`aeh.hypothesis.HypothesisSet`;
* ``predictive_uncertainty`` adds the "uncertain answer" penalty missing from
  the base objective;
* :class:`DiagnosisSession` is an explicit state machine
  ``idle → awaiting_answer → updated → … → terminated`` with deterministic
  termination reasons (student skip, question cap, time/load budget,
  confidence/entropy resolved, no allowed probe, explicit stop);
* ``BurdenBudget`` / ``BurdenState`` cap how much diagnosis a student may be
  asked to carry; diagnosis is never forced.

Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from .hypothesis import UNKNOWN_HYPOTHESIS_ID, Hypothesis


class DiagnosisError(Exception):
    """Base class for diagnosis errors."""


def _normalize(weights: Mapping[str, float]) -> dict[str, float]:
    positive = {k: max(0.0, float(v)) for k, v in weights.items()}
    total = sum(positive.values())
    if total <= 0.0:
        if not positive:
            return {}
        uniform = 1.0 / len(positive)
        return {k: uniform for k in positive}
    return {k: v / total for k, v in positive.items()}


def entropy(weights: Mapping[str, float]) -> float:
    """Shannon entropy (bits) of a weight distribution."""
    normalized = _normalize(weights)
    return -sum(w * math.log2(w) for w in normalized.values() if w > 0.0)


@dataclass(frozen=True)
class DiagnosticCandidate:
    """A candidate diagnostic item and its predicted observable behaviour."""

    item_id: str
    predictions: Mapping[str, float] = field(default_factory=dict)
    time_minutes: float = 0.0
    risk: float = 0.0
    cognitive_load: float = 0.0
    teaching_value: float = 0.0
    gate_allowed: bool = True
    required_kcs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "predictions", MappingProxyType(dict(self.predictions)))
        for value in self.predictions.values():
            if not 0.0 <= float(value) <= 1.0:
                raise ValueError("predictions must be probabilities in [0, 1]")

    def probability_correct(self, hypothesis_id: str) -> float:
        """``P(correct | H_i)``; missing entries default to the chance level."""
        return float(self.predictions.get(hypothesis_id, 0.5))


@dataclass(frozen=True)
class ProbeWeights:
    """Policy weights for the diagnostic selection objective."""

    alpha: float = 0.2  # teaching value
    beta: float = 0.1  # time cost
    gamma: float = 0.5  # risk
    delta: float = 0.1  # cognitive load
    zeta: float = 0.1  # uncertain answer (predictive entropy)


@dataclass(frozen=True)
class ProbeSelection:
    """The chosen probe with its score decomposition."""

    item_id: str
    score: float
    information_gain: float
    teaching_value: float
    time_penalty: float
    risk_penalty: float
    load_penalty: float
    answer_uncertainty: float = 0.0
    reasons: tuple[str, ...] = ()
    candidate: DiagnosticCandidate | None = None


def posterior_after(
    candidate: DiagnosticCandidate,
    weights: Mapping[str, float],
    *,
    correct: bool,
) -> dict[str, float]:
    """Bayesian posterior over hypotheses after observing an answer."""
    prior = _normalize(weights)
    if not prior:
        return {}
    posterior: dict[str, float] = {}
    for hypothesis_id, prior_weight in prior.items():
        p_correct = candidate.probability_correct(hypothesis_id)
        likelihood = p_correct if correct else 1.0 - p_correct
        posterior[hypothesis_id] = prior_weight * likelihood
    if sum(posterior.values()) <= 0.0:
        # A deterministic prediction cannot be updated: keep the prior.
        return prior
    return _normalize(posterior)


def expected_information_gain(
    candidate: DiagnosticCandidate, weights: Mapping[str, float]
) -> float:
    """Expected reduction in hypothesis entropy from asking ``candidate``."""
    prior = _normalize(weights)
    if not prior:
        return 0.0
    prior_entropy = entropy(prior)

    p_correct = sum(
        w * candidate.probability_correct(h) for h, w in prior.items()
    )
    p_incorrect = 1.0 - p_correct

    posterior_correct = posterior_after(candidate, prior, correct=True)
    posterior_incorrect = posterior_after(candidate, prior, correct=False)
    expected_posterior_entropy = (
        p_correct * entropy(posterior_correct)
        + p_incorrect * entropy(posterior_incorrect)
    )
    return max(0.0, prior_entropy - expected_posterior_entropy)


def predictive_uncertainty(
    candidate: DiagnosticCandidate, weights: Mapping[str, float]
) -> float:
    """Entropy (bits) of the predicted correctness event for ``candidate``.

    This is the spec §7.2 "uncertain answer" cost: a probe whose predicted
    outcome is a coin flip (``P(correct) ≈ 0.5``) costs more than one that is
    expected to be clearly right or clearly wrong. Deterministic predictions
    have zero uncertainty.
    """
    prior = _normalize(weights)
    if not prior:
        return 0.0
    p_correct = sum(
        w * candidate.probability_correct(h) for h, w in prior.items()
    )
    p_correct = min(1.0, max(0.0, p_correct))
    if p_correct <= 0.0 or p_correct >= 1.0:
        return 0.0
    return -(
        p_correct * math.log2(p_correct)
        + (1.0 - p_correct) * math.log2(1.0 - p_correct)
    )


def score_candidate(
    candidate: DiagnosticCandidate,
    weights: Mapping[str, float],
    probe_weights: ProbeWeights | None = None,
) -> ProbeSelection:
    """Score one candidate; not gate-allowed candidates score ``-inf``."""
    policy = probe_weights or ProbeWeights()
    if not candidate.gate_allowed:
        return ProbeSelection(
            item_id=candidate.item_id,
            score=float("-inf"),
            information_gain=0.0,
            teaching_value=candidate.teaching_value,
            time_penalty=candidate.time_minutes,
            risk_penalty=candidate.risk,
            load_penalty=candidate.cognitive_load,
            answer_uncertainty=0.0,
            reasons=("curriculum_gate_rejected",),
            candidate=candidate,
        )

    info_gain = expected_information_gain(candidate, weights)
    uncertainty = predictive_uncertainty(candidate, weights)
    score = (
        info_gain
        + policy.alpha * candidate.teaching_value
        - policy.beta * candidate.time_minutes
        - policy.gamma * candidate.risk
        - policy.delta * candidate.cognitive_load
        - policy.zeta * uncertainty
    )
    return ProbeSelection(
        item_id=candidate.item_id,
        score=score,
        information_gain=info_gain,
        teaching_value=candidate.teaching_value,
        time_penalty=candidate.time_minutes,
        risk_penalty=candidate.risk,
        load_penalty=candidate.cognitive_load,
        answer_uncertainty=uncertainty,
        reasons=(),
        candidate=candidate,
    )


def select_probe(
    candidates: Iterable[DiagnosticCandidate],
    weights: Mapping[str, float],
    *,
    probe_weights: ProbeWeights | None = None,
    skipped: bool = False,
    min_score: float | None = None,
) -> ProbeSelection | None:
    """Choose the best gate-allowed probe, honouring an explicit student skip.

    Returns ``None`` when the student skipped, no candidate is allowed, or the
    best score is below ``min_score``.  Diagnosing is never forced.
    """
    if skipped:
        return None

    scored = [
        score_candidate(candidate, weights, probe_weights)
        for candidate in candidates
        if candidate.gate_allowed
    ]
    if not scored:
        return None
    scored.sort(key=lambda s: (-s.score, s.item_id))
    best = scored[0]
    if min_score is not None and best.score < min_score:
        return None
    return best


# ---------------------------------------------------------------------------
# Step 14: backward tracing (spec 7.1)
# ---------------------------------------------------------------------------

#: Diagnosis-session states (spec 7.1 stage 6).
STATE_IDLE = "idle"
STATE_AWAITING_ANSWER = "awaiting_answer"
STATE_UPDATED = "updated"
STATE_TERMINATED = "terminated"

#: Deterministic termination reasons for the diagnosis state machine.
TERMINATION_STUDENT_SKIPPED = "student_skipped"
TERMINATION_MAX_QUESTIONS = "max_questions"
TERMINATION_BURDEN_LIMIT = "burden_limit"
TERMINATION_RESOLVED = "resolved"
TERMINATION_NO_PROBE = "no_probe"
TERMINATION_EXPLICIT = "explicit"

#: Backward-trace explanation kinds (spec 7.1 stage 3).
TRACE_MISCONCEPTION = "misconception"
TRACE_PREREQUISITE_GAP = "prerequisite_gap"
TRACE_SLIP = "slip"

DEFAULT_MAX_TRACE_DEPTH = 3
#: A rule whose slip likelihood reaches this is explained as a slip first.
DEFAULT_SLIP_THRESHOLD = 0.6
#: Added to the slip prior when the deviation is an isolated error.
DEFAULT_SLIP_BOOST = 0.35
#: Prior decay applied to an upstream rule already observed correct.
DEFAULT_CONTRADICTION_DECAY = 0.25
#: Prior decay per hop of upstream distance.
DEFAULT_DEPTH_DECAY = 0.6
DEFAULT_TRACE_UNKNOWN_PRIOR = 0.05


class DiagnosisStateError(DiagnosisError):
    """An operation was attempted in a state that does not allow it."""


class BackwardTraceError(DiagnosisError):
    """The submitted solution steps or error graph cannot be traced."""


@dataclass(frozen=True)
class RuleNode:
    """One rule in the solution/error graph, with its ``REQUIRES`` edges."""

    rule_id: str
    kc: str
    requires_rules: tuple[str, ...] = ()
    misconception_ids: tuple[str, ...] = ()
    slip_likelihood: float = 0.0
    description: str = ""

    def __post_init__(self) -> None:
        if not 0.0 <= float(self.slip_likelihood) <= 1.0:
            raise ValueError("slip_likelihood must be in [0, 1]")


@dataclass(frozen=True)
class MisconceptionRule:
    """An error rule that can replace a correct rule, plus prerequisite KCs."""

    misconception_id: str
    kc: str
    requires_kcs: tuple[str, ...] = ()
    base_prior: float = 1.0
    description: str = ""

    def __post_init__(self) -> None:
        if self.base_prior <= 0.0:
            raise ValueError("base_prior must be > 0")


@dataclass(frozen=True)
class TraceGraph:
    """The local error-rule graph used by backward tracing (spec 7.1 step 3)."""

    rules: Mapping[str, RuleNode] = field(default_factory=dict)
    misconceptions: Mapping[str, MisconceptionRule] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "rules", MappingProxyType(dict(self.rules)))
        object.__setattr__(
            self, "misconceptions", MappingProxyType(dict(self.misconceptions))
        )

    def rule(self, rule_id: str) -> RuleNode | None:
        return self.rules.get(rule_id)

    def misconception(self, misconception_id: str) -> MisconceptionRule | None:
        return self.misconceptions.get(misconception_id)


@dataclass(frozen=True)
class SolutionStep:
    """One observed step of a (synthetic) worked solution."""

    step_id: str
    rule_id: str
    kc: str
    correct: bool
    depends_on: tuple[str, ...] = ()
    error_type: str | None = None
    result: str = ""


@dataclass(frozen=True)
class TraceExplanation:
    """One upstream explanation for the first deviating step."""

    hypothesis_id: str
    kind: str
    kc: str
    misconception_id: str | None
    label: str
    path: tuple[str, ...]
    depth: int
    is_slip: bool
    prior: float = 0.0
    plausibility: float = 0.0
    evidence_step_ids: tuple[str, ...] = ()
    required_kcs: tuple[str, ...] = ()

    def to_hypothesis(self, weight: float | None = None) -> Hypothesis:
        """Convert the explanation into a short-term hypothesis (spec section 6)."""
        resolved = self.plausibility if weight is None else float(weight)
        return Hypothesis(
            hypothesis_id=self.hypothesis_id,
            knowledge_assumptions={self.kc: self.label},
            bug_rules=(self.misconception_id,) if self.misconception_id else (),
            weight=resolved,
            uncertainty="high",
            evidence_refs=self.evidence_step_ids,
        )


@dataclass(frozen=True)
class BackwardTrace:
    """Result of Observe → Localize → Expand for one solution attempt."""

    first_deviation_step_id: str | None
    first_deviation_kc: str | None
    isolated_error: bool
    explanations: tuple[TraceExplanation, ...]
    weights: Mapping[str, float]
    unknown_weight: float
    notes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "weights", MappingProxyType(dict(self.weights)))

    def dominant(self) -> TraceExplanation | None:
        return self.explanations[0] if self.explanations else None

    def to_hypotheses(self) -> tuple[Hypothesis, ...]:
        return tuple(
            explanation.to_hypothesis(self.weights.get(explanation.hypothesis_id, 0.0))
            for explanation in self.explanations
        )


def order_steps(steps: Iterable[SolutionStep]) -> tuple[SolutionStep, ...]:
    """Order steps by their dependency graph, stable on the input order."""
    ordered_input = tuple(steps)
    index: dict[str, int] = {}
    for position, step in enumerate(ordered_input):
        if step.step_id in index:
            raise BackwardTraceError(f"duplicate step id: {step.step_id}")
        index[step.step_id] = position

    by_id = {step.step_id: step for step in ordered_input}
    for step in ordered_input:
        for dependency in step.depends_on:
            if dependency not in by_id:
                raise BackwardTraceError(
                    f"step {step.step_id} depends on unknown step {dependency}"
                )

    result: list[SolutionStep] = []
    placed: set[str] = set()
    remaining = list(ordered_input)
    while remaining:
        ready = [
            step
            for step in remaining
            if all(dependency in placed for dependency in step.depends_on)
        ]
        if not ready:
            raise BackwardTraceError("solution steps contain a dependency cycle")
        ready.sort(key=lambda step: index[step.step_id])
        chosen = ready[0]
        result.append(chosen)
        placed.add(chosen.step_id)
        remaining = [step for step in remaining if step.step_id != chosen.step_id]
    return tuple(result)


def localize_first_deviation(steps: Iterable[SolutionStep]) -> SolutionStep | None:
    """Return the first step (dependency order) that deviates from the rule."""
    for step in order_steps(steps):
        if not step.correct:
            return step
    return None


def is_isolated_error(
    steps: Iterable[SolutionStep], deviation: SolutionStep | None = None
) -> bool:
    """True when exactly one step is wrong and at least one step is correct."""
    ordered = order_steps(steps)
    incorrect = [step for step in ordered if not step.correct]
    if deviation is not None:
        if len(incorrect) != 1 or incorrect[0].step_id != deviation.step_id:
            return False
    return len(incorrect) == 1 and len(incorrect) < len(ordered)


def _normalize_trace(
    priors: Mapping[str, tuple[TraceExplanation, float]],
    unknown_prior: float,
) -> tuple[tuple[TraceExplanation, ...], dict[str, float], float]:
    total = sum(max(0.0, prior) for _, prior in priors.values()) + max(
        0.0, unknown_prior
    )
    if total <= 0.0:
        return (), {}, 1.0
    explanations: list[TraceExplanation] = []
    weights: dict[str, float] = {}
    for hypothesis_id, (explanation, prior) in priors.items():
        weight = max(0.0, prior) / total
        weights[hypothesis_id] = weight
        explanations.append(
            replace(explanation, prior=prior, plausibility=weight)
        )
    unknown_weight = max(0.0, unknown_prior) / total
    weights[UNKNOWN_HYPOTHESIS_ID] = unknown_weight
    explanations.sort(key=lambda item: (-item.plausibility, item.hypothesis_id))
    return tuple(explanations), weights, unknown_weight


def trace_backward(
    steps: Iterable[SolutionStep],
    graph: TraceGraph,
    *,
    max_depth: int = DEFAULT_MAX_TRACE_DEPTH,
    slip_threshold: float = DEFAULT_SLIP_THRESHOLD,
    slip_boost: float = DEFAULT_SLIP_BOOST,
    contradiction_decay: float = DEFAULT_CONTRADICTION_DECAY,
    depth_decay: float = DEFAULT_DEPTH_DECAY,
    unknown_prior: float = DEFAULT_TRACE_UNKNOWN_PRIOR,
) -> BackwardTrace:
    """Observe → Localize → Expand an attempt into upstream explanations.

    The deviation is located in dependency order; the deviating rule's error
    rules and ``REQUIRES`` edges are then expanded (bounded by ``max_depth``)
    into misconception, prerequisite-gap and transient-slip explanations. The
    priors are normalised over the explanations plus an explicit ``unknown``
    bucket, so the result can be used directly as a hypothesis posterior.
    """
    ordered = order_steps(steps)
    deviation = localize_first_deviation(ordered)
    if deviation is None:
        return BackwardTrace(
            first_deviation_step_id=None,
            first_deviation_kc=None,
            isolated_error=False,
            explanations=(),
            weights={UNKNOWN_HYPOTHESIS_ID: 1.0},
            unknown_weight=1.0,
            notes=("no_deviation",),
        )

    isolated = is_isolated_error(ordered, deviation)
    rule = graph.rule(deviation.rule_id)
    observed_rule_correct = {step.rule_id for step in ordered if step.correct}
    observed_rule_incorrect = {step.rule_id for step in ordered if not step.correct}
    observed_kc_correct = {step.kc for step in ordered if step.correct}
    observed_kc_incorrect = {step.kc for step in ordered if not step.correct}

    priors: dict[str, tuple[TraceExplanation, float]] = {}

    def add(explanation: TraceExplanation, prior: float) -> None:
        if prior <= 0.0:
            return
        existing = priors.get(explanation.hypothesis_id)
        if existing is None:
            priors[explanation.hypothesis_id] = (explanation, prior)
        else:
            priors[explanation.hypothesis_id] = (
                existing[0],
                existing[1] + prior,
            )

    # Expand 1: misconceptions attached to the deviating rule.
    misconception_ids = rule.misconception_ids if rule is not None else ()
    for misconception_id in misconception_ids:
        misconception = graph.misconception(misconception_id)
        base_prior = misconception.base_prior if misconception is not None else 1.0
        kc = misconception.kc if misconception is not None else deviation.kc
        label = (
            misconception.description
            if misconception is not None and misconception.description
            else misconception_id
        )
        add(
            TraceExplanation(
                hypothesis_id=f"misconception:{misconception_id}",
                kind=TRACE_MISCONCEPTION,
                kc=kc,
                misconception_id=misconception_id,
                label=label,
                path=(deviation.rule_id, misconception_id),
                depth=1,
                is_slip=False,
                evidence_step_ids=(deviation.step_id,),
                required_kcs=(
                    misconception.requires_kcs if misconception is not None else ()
                ),
            ),
            base_prior,
        )

    # Expand 2: prerequisite rules reachable through REQUIRES (bounded depth).
    if rule is not None:
        frontier: list[tuple[str, int]] = [
            (rule_id, 1) for rule_id in rule.requires_rules
        ]
        seen: set[str] = set()
        while frontier:
            rule_id, depth = frontier.pop(0)
            if rule_id in seen or depth > max_depth:
                continue
            seen.add(rule_id)
            upstream = graph.rule(rule_id)
            if upstream is None:
                continue
            factor = depth_decay ** (depth - 1)
            if rule_id in observed_rule_correct:
                factor *= contradiction_decay
            elif rule_id in observed_rule_incorrect:
                factor *= 1.5
            base_prior = 0.5 * factor
            path = (rule_id, deviation.rule_id)
            add(
                TraceExplanation(
                    hypothesis_id=f"prereq:{upstream.kc}",
                    kind=TRACE_PREREQUISITE_GAP,
                    kc=upstream.kc,
                    misconception_id=None,
                    label=f"missing prerequisite {upstream.kc}",
                    path=path,
                    depth=depth,
                    is_slip=False,
                    evidence_step_ids=tuple(
                        step.step_id
                        for step in ordered
                        if step.rule_id in {rule_id, deviation.rule_id}
                    ),
                    required_kcs=(upstream.kc,),
                ),
                base_prior,
            )
            frontier.extend(
                (next_rule_id, depth + 1)
                for next_rule_id in upstream.requires_rules
            )

    # Expand 3: prerequisite KCs named by the misconceptions.
    for misconception_id in misconception_ids:
        misconception = graph.misconception(misconception_id)
        if misconception is None:
            continue
        for kc in misconception.requires_kcs:
            factor = depth_decay
            if kc in observed_kc_correct:
                factor *= contradiction_decay
            elif kc in observed_kc_incorrect:
                factor *= 1.5
            explanatory = 0.5 * factor
            add(
                TraceExplanation(
                    hypothesis_id=f"prereq:{kc}",
                    kind=TRACE_PREREQUISITE_GAP,
                    kc=kc,
                    misconception_id=None,
                    label=f"missing prerequisite {kc}",
                    path=(deviation.rule_id, misconception_id, kc),
                    depth=2,
                    is_slip=False,
                    evidence_step_ids=(deviation.step_id,),
                    required_kcs=(kc,),
                ),
                explanatory,
            )

    # Expand 4: the transient operation-slip explanation.
    slip_prior = rule.slip_likelihood if rule is not None else 0.0
    if isolated:
        slip_prior = min(1.0, slip_prior + slip_boost)
    if slip_prior > 0.0 or (rule is not None and rule.slip_likelihood > 0.0):
        if not isolated and slip_prior < slip_threshold:
            # A systematic rule error is preferred; keep the slip explanation
            # but do not let it dominate a repeated failure pattern.
            slip_prior *= 0.5
        add(
            TraceExplanation(
                hypothesis_id="slip",
                kind=TRACE_SLIP,
                kc=deviation.kc,
                misconception_id=None,
                label="transient operation slip",
                path=(deviation.rule_id,),
                depth=1,
                is_slip=True,
                evidence_step_ids=(deviation.step_id,),
            ),
            slip_prior,
        )

    explanations, weights, unknown_weight = _normalize_trace(priors, unknown_prior)
    notes: list[str] = []
    if isolated:
        notes.append("isolated_error")
    if not explanations:
        notes.append("no_systematic_explanation")

    return BackwardTrace(
        first_deviation_step_id=deviation.step_id,
        first_deviation_kc=deviation.kc,
        isolated_error=isolated,
        explanations=explanations,
        weights=weights,
        unknown_weight=unknown_weight,
        notes=tuple(notes),
    )


# ---------------------------------------------------------------------------
# Step 14: diagnosis session state machine and burden budget (spec 7.2)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BurdenBudget:
    """Hard caps on how much diagnosis a student may be asked to carry."""

    max_questions: int | None = None
    max_total_minutes: float | None = None
    max_total_load: float | None = None

    def __post_init__(self) -> None:
        if self.max_questions is not None and self.max_questions < 0:
            raise ValueError("max_questions must be >= 0")
        if self.max_total_minutes is not None and self.max_total_minutes < 0.0:
            raise ValueError("max_total_minutes must be >= 0")
        if self.max_total_load is not None and self.max_total_load < 0.0:
            raise ValueError("max_total_load must be >= 0")


@dataclass(frozen=True)
class BurdenState:
    """Accumulated diagnostic burden for one session."""

    questions: int = 0
    total_minutes: float = 0.0
    total_load: float = 0.0


@dataclass(frozen=True)
class DiagnosisTransition:
    """Audit record for one session state transition."""

    kind: str
    item_id: str | None = None
    detail: str = ""


@dataclass(frozen=True)
class DiagnosisUpdate:
    """Result of applying one answered probe."""

    item_id: str
    correct: bool
    information_gain: float
    weights: Mapping[str, float]
    burden: BurdenState
    termination_reason: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "weights", MappingProxyType(dict(self.weights)))


def should_terminate(
    weights: Mapping[str, float],
    *,
    burden: BurdenState | None = None,
    budget: BurdenBudget | None = None,
    skipped: bool = False,
    explicit: bool = False,
    min_confidence: float | None = None,
    entropy_threshold: float | None = None,
) -> str | None:
    """Return the deterministic termination reason, or ``None`` to continue.

    Priority: explicit stop / student skip, then hard budget caps, then
    resolution (posterior confidence or entropy). A leading ``unknown`` bucket
    blocks a "resolved" verdict, so an unexplained deviation keeps being
    investigated instead of being declared understood.
    """
    if skipped:
        return TERMINATION_STUDENT_SKIPPED
    if explicit:
        return TERMINATION_EXPLICIT

    state = burden or BurdenState()
    limits = budget or BurdenBudget()
    if limits.max_questions is not None and state.questions >= limits.max_questions:
        return TERMINATION_MAX_QUESTIONS
    if (
        limits.max_total_minutes is not None
        and state.total_minutes >= limits.max_total_minutes - 1e-9
    ):
        return TERMINATION_BURDEN_LIMIT
    if (
        limits.max_total_load is not None
        and state.total_load >= limits.max_total_load - 1e-9
    ):
        return TERMINATION_BURDEN_LIMIT

    normalized = _normalize(weights)
    if not normalized:
        return None
    if min_confidence is not None:
        active = {
            key: value
            for key, value in normalized.items()
            if key != UNKNOWN_HYPOTHESIS_ID
        }
        best = max(active.values()) if active else 0.0
        unknown = normalized.get(UNKNOWN_HYPOTHESIS_ID, 0.0)
        if (
            best >= min_confidence
            and unknown <= 1.0 - min_confidence + 1e-9
        ):
            return TERMINATION_RESOLVED
    if (
        entropy_threshold is not None
        and entropy(normalized) <= entropy_threshold + 1e-12
    ):
        return TERMINATION_RESOLVED
    return None


class DiagnosisSession:
    """A diagnosis state machine around :func:`select_probe`.

    States: ``idle`` → ``awaiting_answer`` → ``updated`` (back to
    ``awaiting_answer`` on the next selection) → ``terminated``. Every
    termination is recorded with a deterministic reason and the student can
    skip at any point. When no budget is supplied the session never forces a
    stop by itself (backwards compatible with the Step 1 helper).
    """

    def __init__(
        self,
        weights: Mapping[str, float],
        probe_weights: ProbeWeights | None = None,
        *,
        budget: BurdenBudget | None = None,
        min_confidence: float | None = None,
        entropy_threshold: float | None = None,
    ) -> None:
        self.weights: dict[str, float] = dict(weights)
        self.probe_weights = probe_weights or ProbeWeights()
        self.budget = budget or BurdenBudget()
        self.min_confidence = min_confidence
        self.entropy_threshold = entropy_threshold
        self.skipped = False
        self.asked: list[str] = []
        self.state = STATE_IDLE
        self.termination_reason: str | None = None
        self.burden = BurdenState()
        self.history: list[DiagnosisTransition] = []
        self.pending: ProbeSelection | None = None
        self.realized_information_gain = 0.0

    @property
    def terminated(self) -> bool:
        return self.state == STATE_TERMINATED

    @property
    def pending_item_id(self) -> str | None:
        return self.pending.item_id if self.pending is not None else None

    def _record(self, kind: str, item_id: str | None = None, detail: str = "") -> None:
        self.history.append(DiagnosisTransition(kind, item_id, detail))

    def _terminate(self, reason: str) -> None:
        self.state = STATE_TERMINATED
        self.termination_reason = reason
        self._record("terminated", None, reason)

    def skip(self) -> None:
        """The student declines further diagnosis; no probe is forced."""
        self.skipped = True
        if not self.terminated:
            self._terminate(TERMINATION_STUDENT_SKIPPED)

    def terminate(self, reason: str = TERMINATION_EXPLICIT) -> None:
        """Stop the session explicitly (e.g. the teacher needs the time)."""
        if not self.terminated:
            self._terminate(reason)

    def select(
        self, candidates: Iterable[DiagnosticCandidate]
    ) -> ProbeSelection | None:
        """Ask (select) the next probe. Returns ``None`` once terminated."""
        if self.terminated:
            return None
        if self.state == STATE_AWAITING_ANSWER:
            raise DiagnosisStateError("an answer is still pending")
        reason = should_terminate(
            self.weights,
            burden=self.burden,
            budget=self.budget,
            skipped=self.skipped,
            min_confidence=self.min_confidence,
            entropy_threshold=self.entropy_threshold,
        )
        if reason is not None:
            self._terminate(reason)
            return None
        selection = select_probe(
            candidates,
            self.weights,
            probe_weights=self.probe_weights,
            skipped=self.skipped,
        )
        if selection is None:
            self._terminate(
                TERMINATION_STUDENT_SKIPPED
                if self.skipped
                else TERMINATION_NO_PROBE
            )
            return None
        self.pending = selection
        self.state = STATE_AWAITING_ANSWER
        self._record("selected", selection.item_id)
        return selection

    def observe(
        self, candidate: DiagnosticCandidate, *, correct: bool
    ) -> DiagnosisUpdate:
        """Update the posterior after the student answers, then check stopping."""
        if self.terminated:
            raise DiagnosisStateError("the diagnosis session is already terminated")
        prior_entropy = entropy(self.weights)
        self.weights = posterior_after(candidate, self.weights, correct=correct)
        self.asked.append(candidate.item_id)
        gain = max(0.0, prior_entropy - entropy(self.weights))
        self.realized_information_gain += gain
        self.burden = BurdenState(
            questions=self.burden.questions + 1,
            total_minutes=self.burden.total_minutes
            + max(0.0, float(candidate.time_minutes)),
            total_load=self.burden.total_load
            + max(0.0, float(candidate.cognitive_load)),
        )
        self.state = STATE_UPDATED
        self.pending = None
        self._record("observed", candidate.item_id, f"correct={correct}")
        reason = should_terminate(
            self.weights,
            burden=self.burden,
            budget=self.budget,
            skipped=self.skipped,
            min_confidence=self.min_confidence,
            entropy_threshold=self.entropy_threshold,
        )
        if reason is not None:
            self._terminate(reason)
        return DiagnosisUpdate(
            item_id=candidate.item_id,
            correct=correct,
            information_gain=gain,
            weights=self.weights,
            burden=self.burden,
            termination_reason=self.termination_reason,
        )


__all__ = [
    "DiagnosticCandidate",
    "ProbeWeights",
    "ProbeSelection",
    "DiagnosisSession",
    "DiagnosisUpdate",
    "DiagnosisTransition",
    "DiagnosisStateError",
    "DiagnosisError",
    "BackwardTraceError",
    "BurdenBudget",
    "BurdenState",
    "RuleNode",
    "MisconceptionRule",
    "TraceGraph",
    "SolutionStep",
    "TraceExplanation",
    "BackwardTrace",
    "entropy",
    "posterior_after",
    "expected_information_gain",
    "predictive_uncertainty",
    "score_candidate",
    "select_probe",
    "order_steps",
    "localize_first_deviation",
    "is_isolated_error",
    "trace_backward",
    "should_terminate",
    "STATE_IDLE",
    "STATE_AWAITING_ANSWER",
    "STATE_UPDATED",
    "STATE_TERMINATED",
    "TERMINATION_STUDENT_SKIPPED",
    "TERMINATION_MAX_QUESTIONS",
    "TERMINATION_BURDEN_LIMIT",
    "TERMINATION_RESOLVED",
    "TERMINATION_NO_PROBE",
    "TERMINATION_EXPLICIT",
    "TRACE_MISCONCEPTION",
    "TRACE_PREREQUISITE_GAP",
    "TRACE_SLIP",
    "DEFAULT_MAX_TRACE_DEPTH",
    "DEFAULT_SLIP_THRESHOLD",
    "DEFAULT_SLIP_BOOST",
    "DEFAULT_CONTRADICTION_DECAY",
    "DEFAULT_DEPTH_DECAY",
    "DEFAULT_TRACE_UNKNOWN_PRIOR",
]
