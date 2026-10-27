"""FSRS-style memory model (spec section 8.3 / 8.4 / 8.6).

Implements the illustrative retrievability formula

.. math::

    R_{u,k}(t) = \\left(1 + \\frac{19}{81}\\frac{t}{S_{u,k}}\\right)^{-1/2}

and the interval inverse

.. math::

    \\Delta t = \\frac{81}{19} S\\left(r_{target}^{-2} - 1\\right).

With the illustrative formula :math:`R(t=S) \\approx 0.9`.

Quality weighting follows spec 8.4: an independent, unhinted first attempt
updates the memory model more than a hint-assisted correction, and merely
reading an explanation is **not** counted as a successful retrieval.

Standard library only.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any

#: FSRS-4.5-like illustrative constants from spec 8.3.
FSRS_19_81 = 19.0 / 81.0
FSRS_81_19 = 81.0 / 19.0

INDEPENDENT_WEIGHT = 1.0
HINTED_WEIGHT = 0.3
READING_WEIGHT = 0.0

SUCCESS_GROWTH = 0.6
FAILURE_SHRINK = 0.4
MIN_STABILITY_DAYS = 0.4
INITIAL_STABILITY_DAYS = 1.0

KIND_ATTEMPT = "attempt"
KIND_HINT_FOLLOWUP = "hint_followup"
KIND_READING = "reading"


def retrievability(elapsed_days: float, stability_days: float) -> float:
    """Return the probability of independent retrieval after ``elapsed_days``."""
    if stability_days <= 0.0:
        raise ValueError("stability_days must be > 0")
    if elapsed_days < 0.0:
        raise ValueError("elapsed_days must be >= 0")
    return (1.0 + FSRS_19_81 * (elapsed_days / stability_days)) ** -0.5


def interval_for_target(
    stability_days: float, target_retention: float = 0.9
) -> float:
    """Invert the retention formula for a target retention probability."""
    if stability_days <= 0.0:
        raise ValueError("stability_days must be > 0")
    if not 0.0 < target_retention < 1.0:
        raise ValueError("target_retention must be within (0, 1)")
    return FSRS_81_19 * stability_days * (target_retention ** -2 - 1.0)


@dataclass(frozen=True)
class MemoryState:
    """Retrievable-memory state for one learner x one memory unit."""

    learner_id: str
    memory_unit_id: str
    stability_days: float = INITIAL_STABILITY_DAYS
    difficulty: float = 5.0
    observation_count: int = 0
    independent_success_count: int = 0
    last_independent_success_at: datetime | None = None
    uncertainty: str = "high"
    model_family: str = "fsrs_compatible"
    model_version: str = "fsrs_illustrative_19_81"

    def __post_init__(self) -> None:
        if self.stability_days <= 0.0:
            raise ValueError("stability_days must be > 0")
        if not 1.0 <= self.difficulty <= 10.0:
            raise ValueError("difficulty must be within [1, 10]")

    def expected_retrievability(self, elapsed_days: float) -> float:
        return retrievability(elapsed_days, self.stability_days)

    def next_review_interval_days(self, target_retention: float = 0.9) -> float:
        return interval_for_target(self.stability_days, target_retention)


@dataclass(frozen=True)
class MemoryObservation:
    """One practice/review observation with quality metadata (spec 8.4)."""

    observation_id: str
    success: bool
    independent: bool = True
    hint_level: int = 0
    kind: str = KIND_ATTEMPT
    transfer_level: str = "near"
    occurred_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.hint_level < 0:
            raise ValueError("hint_level must be >= 0")


def retrieval_weight(observation: MemoryObservation) -> float:
    """Effective weight of an observation for the memory model.

    Reading an explanation has weight ``0``; hint-assisted success has a low
    weight; independent unhinted attempts have full weight.
    """
    if observation.kind == KIND_READING:
        return READING_WEIGHT
    if observation.kind == KIND_HINT_FOLLOWUP:
        # A post-hint follow-up is hint-assisted even if a caller forgets to
        # flip the boolean flags; it never earns full independent-answer weight.
        return HINTED_WEIGHT
    if observation.independent and observation.hint_level == 0:
        return INDEPENDENT_WEIGHT
    return HINTED_WEIGHT


def is_independent_retrieval_success(observation: MemoryObservation) -> bool:
    """True only for a correct, unhinted, independent first attempt."""
    return (
        observation.success
        and observation.independent
        and observation.hint_level == 0
        and observation.kind == KIND_ATTEMPT
    )


def _uncertainty_for(count: int) -> str:
    if count >= 5:
        return "low"
    if count >= 2:
        return "medium"
    return "high"


def update_memory(
    state: MemoryState, observation: MemoryObservation
) -> MemoryState:
    """Return the updated memory state for one observation.

    Reading explanations leaves stability and observation counts unchanged;
    hint-assisted success grows stability less than independent success.
    """
    weight = retrieval_weight(observation)
    if weight <= 0.0:
        # Reading is not an independent retrieval success: no memory update.
        return state

    if observation.success:
        stability = state.stability_days * (1.0 + SUCCESS_GROWTH * weight)
        difficulty = max(1.0, state.difficulty - 0.2 * weight)
    else:
        stability = max(
            MIN_STABILITY_DAYS, state.stability_days * (1.0 - FAILURE_SHRINK * weight)
        )
        difficulty = min(10.0, state.difficulty + 0.5 * weight)

    independent = is_independent_retrieval_success(observation)
    count = state.observation_count + 1
    independent_count = state.independent_success_count + (1 if independent else 0)
    last_success = (
        observation.occurred_at if independent else state.last_independent_success_at
    )

    return replace(
        state,
        stability_days=stability,
        difficulty=difficulty,
        observation_count=count,
        independent_success_count=independent_count,
        last_independent_success_at=last_success,
        uncertainty=_uncertainty_for(count),
    )


def update_many(
    state: MemoryState, observations: list[MemoryObservation]
) -> MemoryState:
    for observation in observations:
        state = update_memory(state, observation)
    return state


def memory_snapshot(state: MemoryState, now: datetime | None = None) -> dict[str, Any]:
    """A minimal, JSON-friendly diagnosis view of a memory state."""
    return {
        "learner_id": state.learner_id,
        "memory_unit_id": state.memory_unit_id,
        "model_family": state.model_family,
        "model_version": state.model_version,
        "stability_days": round(state.stability_days, 6),
        "difficulty_state": round(state.difficulty, 6),
        "observation_count": state.observation_count,
        "independent_success_count": state.independent_success_count,
        "uncertainty": state.uncertainty,
    }


__all__ = [
    "MemoryState",
    "MemoryObservation",
    "retrievability",
    "interval_for_target",
    "retrieval_weight",
    "is_independent_retrieval_success",
    "update_memory",
    "update_many",
    "memory_snapshot",
    "FSRS_19_81",
    "FSRS_81_19",
    "KIND_ATTEMPT",
    "KIND_HINT_FOLLOWUP",
    "KIND_READING",
]
