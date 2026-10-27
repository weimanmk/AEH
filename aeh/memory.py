"""FSRS-style memory model (spec section 8.3 / 8.4 / 8.6, Step 12 §5 memory).

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

Step 12 adds the long-term integration pieces used by the student twin:

* :class:`MemoryParameters` -- the six FSRS dynamics parameters with a
  version string.  The spec-8.3 values are the baseline; a Step 11 calibrated
  parameter candidate can only be attached to a twin as a *pending* candidate
  and becomes effective only after explicit approval (enforced in
  :mod:`aeh.twin`, never by mutating a memory state from a candidate).
* :func:`update_memory` accepts an optional parameter set so review updates
  use the approved dynamics while remaining byte-identical to the baseline
  when no parameters are supplied.
* :func:`apply_forgetting` models time passing: retrievability decays and the
  uncertainty band is raised for overdue knowledge, but stability, difficulty
  and mastery are **never** silently lowered (spec 5.4: for a long-unanswered
  KC, raise uncertainty or schedule a calibration exercise rather than
  concluding "does not know").
* :func:`memory_health` / :func:`aggregate_memory` expose per-KC and multi-KC
  views for the twin without mutating anything.

Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

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
INITIAL_DIFFICULTY = 5.0
DIFFICULTY_MIN = 1.0
DIFFICULTY_MAX = 10.0
DIFFICULTY_REFERENCE = 5.0
DIFFICULTY_SUCCESS_DELTA = 0.2
DIFFICULTY_FAILURE_DELTA = 0.5

#: The spec-8.3 illustrative parameter version (baseline before calibration).
BASELINE_PARAMETER_VERSION = "fsrs_illustrative_19_81"

KIND_ATTEMPT = "attempt"
KIND_HINT_FOLLOWUP = "hint_followup"
KIND_READING = "reading"

#: Ordered parameter names, matching ``aeh.fsrs_calibration.PARAMETER_NAMES``.
MEMORY_PARAMETER_NAMES: tuple[str, ...] = (
    "initial_stability_days",
    "success_growth",
    "failure_shrink",
    "initial_difficulty",
    "difficulty_success_delta",
    "difficulty_failure_delta",
)


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
class MemoryParameters:
    """A validated FSRS dynamics parameter vector (Step 11 candidate shape).

    The defaults are exactly the spec-8.3 illustrative parameters, so using a
    baseline instance is numerically identical to the pre-Step-12 behaviour.
    A calibrated candidate is represented by the same fields plus a
    ``parameter_version``; the twin refuses to apply it until a host approval
    is recorded.
    """

    initial_stability_days: float = INITIAL_STABILITY_DAYS
    success_growth: float = SUCCESS_GROWTH
    failure_shrink: float = FAILURE_SHRINK
    initial_difficulty: float = INITIAL_DIFFICULTY
    difficulty_success_delta: float = DIFFICULTY_SUCCESS_DELTA
    difficulty_failure_delta: float = DIFFICULTY_FAILURE_DELTA
    parameter_version: str = BASELINE_PARAMETER_VERSION

    def __post_init__(self) -> None:
        for name in MEMORY_PARAMETER_NAMES:
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"{name} must be a finite number")
            value = float(value)
            if not math.isfinite(value):
                raise ValueError(f"{name} must be a finite number")
            if value < 0.0:
                raise ValueError(f"{name} must be >= 0")
            object.__setattr__(self, name, value)
        if self.initial_stability_days <= 0.0:
            raise ValueError("initial_stability_days must be > 0")
        if not 1.0 <= self.initial_difficulty <= 10.0:
            raise ValueError("initial_difficulty must be within [1, 10]")
        if not isinstance(self.parameter_version, str) or not self.parameter_version:
            raise ValueError("parameter_version must be a non-empty string")

    @classmethod
    def baseline(cls) -> "MemoryParameters":
        return cls()

    @classmethod
    def from_mapping(
        cls,
        data: Mapping[str, Any],
        *,
        parameter_version: str | None = None,
    ) -> "MemoryParameters":
        """Build parameters from a Step-11 candidate ``parameters`` mapping."""
        if not isinstance(data, Mapping):
            raise ValueError("parameters must be a mapping")
        missing = [name for name in MEMORY_PARAMETER_NAMES if name not in data]
        if missing:
            raise ValueError(f"parameters missing: {missing}")
        values = {name: data[name] for name in MEMORY_PARAMETER_NAMES}
        version = parameter_version
        if version is None:
            version = data.get("parameter_version", BASELINE_PARAMETER_VERSION)
        return cls(parameter_version=str(version), **values)

    def value_dict(self) -> dict[str, float]:
        return {name: float(getattr(self, name)) for name in MEMORY_PARAMETER_NAMES}

    def difficulty_factor(self, difficulty: float) -> float:
        return (DIFFICULTY_MAX - difficulty) / (
            DIFFICULTY_MAX - DIFFICULTY_REFERENCE
        )

    def effective_stability(self, stability_days: float, difficulty: float) -> float:
        effective = stability_days * self.difficulty_factor(difficulty)
        return effective if effective > MIN_STABILITY_DAYS else MIN_STABILITY_DAYS

    def predict(
        self, elapsed_days: float, stability_days: float, difficulty: float
    ) -> float:
        effective = self.effective_stability(stability_days, difficulty)
        return (1.0 + FSRS_19_81 * (elapsed_days / effective)) ** -0.5

    def next_interval_days(
        self, stability_days: float, difficulty: float, target_retention: float = 0.9
    ) -> float:
        effective = self.effective_stability(stability_days, difficulty)
        return interval_for_target(effective, target_retention)

    def update(
        self, stability_days: float, difficulty: float, success: bool, weight: float
    ) -> tuple[float, float]:
        """Apply one evidence-backed review to stability/difficulty."""
        if weight <= 0.0:
            return stability_days, difficulty
        if success:
            stability = stability_days * (1.0 + self.success_growth * weight)
            difficulty = difficulty - self.difficulty_success_delta * weight
            if difficulty < DIFFICULTY_MIN:
                difficulty = DIFFICULTY_MIN
        else:
            stability = stability_days * (1.0 - self.failure_shrink * weight)
            if stability < MIN_STABILITY_DAYS:
                stability = MIN_STABILITY_DAYS
            difficulty = difficulty + self.difficulty_failure_delta * weight
            if difficulty > DIFFICULTY_MAX:
                difficulty = DIFFICULTY_MAX
        return stability, difficulty


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
    #: Step 12: timestamp of the most recent (weighted) observation, so the
    #: twin can assess time-based forgetting without inventing an observation.
    last_observed_at: datetime | None = None
    #: Step 12: set when a KC is overdue relative to the target retention and a
    #: calibration exercise should be scheduled (spec 5.4).  It never lowers
    #: stability/difficulty/mastery by itself.
    needs_calibration: bool = False

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


def _bump_uncertainty(uncertainty: str) -> str:
    if uncertainty == "low":
        return "medium"
    return "high"


def update_memory(
    state: MemoryState,
    observation: MemoryObservation,
    *,
    parameters: MemoryParameters | None = None,
) -> MemoryState:
    """Return the updated memory state for one observation.

    Reading explanations leaves stability and observation counts unchanged;
    hint-assisted success grows stability less than independent success.  When
    ``parameters`` is supplied (an approved Step 11 calibration), the review
    uses that dynamics vector and the resulting state records its
    ``model_version``.
    """
    weight = retrieval_weight(observation)
    if weight <= 0.0:
        # Reading is not an independent retrieval success: no memory update.
        return state

    params = parameters or MemoryParameters()
    if observation.success:
        stability, difficulty = params.update(
            state.stability_days, state.difficulty, True, weight
        )
    else:
        stability, difficulty = params.update(
            state.stability_days, state.difficulty, False, weight
        )

    independent = is_independent_retrieval_success(observation)
    count = state.observation_count + 1
    independent_count = state.independent_success_count + (1 if independent else 0)
    last_success = (
        observation.occurred_at if independent else state.last_independent_success_at
    )
    last_observed = observation.occurred_at or state.last_observed_at
    model_version = (
        params.parameter_version if parameters is not None else state.model_version
    )

    return replace(
        state,
        stability_days=stability,
        difficulty=difficulty,
        observation_count=count,
        independent_success_count=independent_count,
        last_independent_success_at=last_success,
        last_observed_at=last_observed,
        uncertainty=_uncertainty_for(count),
        needs_calibration=False,
        model_version=model_version,
    )


def update_many(
    state: MemoryState,
    observations: Sequence[MemoryObservation],
    *,
    parameters: MemoryParameters | None = None,
) -> MemoryState:
    for observation in observations:
        state = update_memory(state, observation, parameters=parameters)
    return state


def apply_forgetting(
    state: MemoryState,
    now: datetime,
    *,
    target_retention: float = 0.9,
    parameters: MemoryParameters | None = None,
) -> MemoryState:
    """Age a memory state: decay retrievability, raise uncertainty only.

    Stability, difficulty and mastery are never lowered by the passage of
    time.  When the expected retrievability at ``now`` has fallen below
    ``target_retention`` the uncertainty band is raised one level and
    ``needs_calibration`` is set so the twin can schedule a calibration
    exercise (spec 5.4).
    """
    anchor = state.last_observed_at or state.last_independent_success_at
    if anchor is None or now <= anchor:
        return state
    elapsed_days = (now - anchor).total_seconds() / 86400.0
    params = parameters or MemoryParameters()
    expected = params.predict(elapsed_days, state.stability_days, state.difficulty)
    if expected >= target_retention:
        return state
    return replace(
        state,
        needs_calibration=True,
        uncertainty=_bump_uncertainty(state.uncertainty),
    )


def memory_health(
    state: MemoryState,
    now: datetime,
    *,
    target_retention: float = 0.9,
    parameters: MemoryParameters | None = None,
) -> dict[str, Any]:
    """A JSON-friendly, read-only forgetting assessment for one memory unit."""
    anchor = state.last_observed_at or state.last_independent_success_at
    elapsed_days = 0.0
    if anchor is not None and now > anchor:
        elapsed_days = (now - anchor).total_seconds() / 86400.0
    params = parameters or MemoryParameters()
    expected = params.predict(elapsed_days, state.stability_days, state.difficulty)
    return {
        "memory_unit_id": state.memory_unit_id,
        "stability_days": round(state.stability_days, 6),
        "difficulty": round(state.difficulty, 6),
        "effective_stability_days": round(
            params.effective_stability(state.stability_days, state.difficulty), 6
        ),
        "elapsed_days": round(elapsed_days, 6),
        "expected_retrievability": round(expected, 6),
        "target_retention": target_retention,
        "overdue": expected < target_retention,
        "uncertainty": state.uncertainty,
        "needs_calibration": state.needs_calibration,
        "observation_count": state.observation_count,
        "model_version": state.model_version,
    }


def aggregate_memory(
    states: Sequence[MemoryState],
    now: datetime | None = None,
    *,
    target_retention: float = 0.9,
    parameters: MemoryParameters | None = None,
) -> dict[str, Any]:
    """Multi-KC long-term memory summary (never a single compressed mastery)."""
    unit_count = len(states)
    if unit_count == 0:
        return {
            "unit_count": 0,
            "mean_stability_days": 0.0,
            "mean_difficulty": 0.0,
            "overdue_count": 0,
            "needs_calibration_count": 0,
            "weakest_units": [],
        }
    health = [
        memory_health(
            state, now or _latest_anchor(states), target_retention=target_retention,
            parameters=parameters,
        )
        for state in states
    ]
    overdue = [entry for entry in health if entry["overdue"]]
    weakest = sorted(health, key=lambda entry: entry["expected_retrievability"])[:3]
    return {
        "unit_count": unit_count,
        "mean_stability_days": round(
            sum(state.stability_days for state in states) / unit_count, 6
        ),
        "mean_difficulty": round(
            sum(state.difficulty for state in states) / unit_count, 6
        ),
        "overdue_count": len(overdue),
        "needs_calibration_count": sum(
            1 for state in states if state.needs_calibration
        ),
        "weakest_units": [
            {
                "memory_unit_id": entry["memory_unit_id"],
                "expected_retrievability": entry["expected_retrievability"],
                "uncertainty": entry["uncertainty"],
            }
            for entry in weakest
        ],
    }


def _latest_anchor(states: Sequence[MemoryState]) -> datetime:
    anchors = [
        state.last_observed_at or state.last_independent_success_at for state in states
    ]
    present = [anchor for anchor in anchors if anchor is not None]
    if not present:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    return max(present)


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
    "MemoryParameters",
    "retrievability",
    "interval_for_target",
    "retrieval_weight",
    "is_independent_retrieval_success",
    "update_memory",
    "update_many",
    "apply_forgetting",
    "memory_health",
    "aggregate_memory",
    "memory_snapshot",
    "FSRS_19_81",
    "FSRS_81_19",
    "BASELINE_PARAMETER_VERSION",
    "MEMORY_PARAMETER_NAMES",
    "KIND_ATTEMPT",
    "KIND_HINT_FOLLOWUP",
    "KIND_READING",
]
