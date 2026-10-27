"""Active diagnosis: choose the most discriminating next probe (spec section 7).

The base objective is expected information gain over the current hypothesis
posterior, penalised by time, risk and cognitive load:

.. math::

    q^* = \\arg\\max_q \\{ IG(q) + \\alpha TeachingValue(q)
          - \\beta Time(q) - \\gamma Risk(q) \\}

with an additional cognitive-load penalty.  Only gate-allowed candidates are
considered (fail-closed), and the student may skip at any time.

Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from .hypothesis import UNKNOWN_HYPOTHESIS_ID


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
            reasons=("curriculum_gate_rejected",),
            candidate=candidate,
        )

    info_gain = expected_information_gain(candidate, weights)
    score = (
        info_gain
        + policy.alpha * candidate.teaching_value
        - policy.beta * candidate.time_minutes
        - policy.gamma * candidate.risk
        - policy.delta * candidate.cognitive_load
    )
    return ProbeSelection(
        item_id=candidate.item_id,
        score=score,
        information_gain=info_gain,
        teaching_value=candidate.teaching_value,
        time_penalty=candidate.time_minutes,
        risk_penalty=candidate.risk,
        load_penalty=candidate.cognitive_load,
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


class DiagnosisSession:
    """A small stateful helper around :func:`select_probe`."""

    def __init__(
        self,
        weights: Mapping[str, float],
        probe_weights: ProbeWeights | None = None,
    ) -> None:
        self.weights: dict[str, float] = dict(weights)
        self.probe_weights = probe_weights or ProbeWeights()
        self.skipped = False
        self.asked: list[str] = []

    def skip(self) -> None:
        """The student declines further diagnosis; no probe is forced."""
        self.skipped = True

    def select(
        self, candidates: Iterable[DiagnosticCandidate]
    ) -> ProbeSelection | None:
        return select_probe(
            candidates,
            self.weights,
            probe_weights=self.probe_weights,
            skipped=self.skipped,
        )

    def observe(self, candidate: DiagnosticCandidate, *, correct: bool) -> None:
        self.weights = posterior_after(candidate, self.weights, correct=correct)
        self.asked.append(candidate.item_id)


__all__ = [
    "DiagnosticCandidate",
    "ProbeWeights",
    "ProbeSelection",
    "DiagnosisSession",
    "entropy",
    "posterior_after",
    "expected_information_gain",
    "score_candidate",
    "select_probe",
]
