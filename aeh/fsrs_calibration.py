"""FSRS parameter calibration (spec section 8).

This module is the **calibration control plane** for the FSRS-style memory
model.  It fits the memory model's *dynamics parameters* (initial stability,
stability growth/shrink, initial difficulty, difficulty response) from
**synthetic** review sequences, reports an uncertainty interval and an
applicability statement for every estimate, and -- crucially -- only ever
produces a *parameter candidate*.  A calibration run never edits a real
mastery or stability value:

``synthetic data -> fit -> parameter candidate -> isolated evaluation ->
explicit host approval -> activation (a returned configuration object)``

Hard rules enforced here:

* **no direct mastery write**: the module has no reference to a twin, an
  event store, or a memory state.  ``calibrate()`` is a pure function; the
  activation gate returns a frozen parameter set and records an audit entry.
  Nothing in this file mutates ``observed`` state.
* **reproducible**: a run is fully determined by ``(seed, data_version,
  parameter_version)`` plus the frozen optimizer configuration.  Repeated runs
  produce byte-identical report fingerprints; the bootstrap resampling stream
  is the shared ``mulberry32`` PRNG.
* **uncertainty + applicability**: every parameter carries a bootstrap
  confidence interval, the report carries Brier / ECE reliability metrics,
  and an :class:`Applicability` block states the scope, the observed elapsed
  range, which parameters are weakly identified, and what is explicitly out of
  scope (real-student scheduling, extrapolation, gate weakening).
* **simulated vs real are separate**: the isolated evaluation reports a
  *simulated* held-out Brier improvement with ``is_causal_evidence=False``;
  promotion to an activated parameter set additionally needs independently
  observed, unseen real-transfer evidence from a trusted source.  Without it
  the verdict is ``promotion_blocked:real_transfer_evidence_missing``.

The numeric model keeps the spec 8.3 illustrative retention curve

.. math::

    R_{u,k}(t) = \\left(1 + \\frac{19}{81}\\frac{t}{S_{u,k}}\\right)^{-1/2}

and adds a difficulty-modulated *effective stability*.  Only the standard
library and basic IEEE-754 arithmetic (``+ - * / sqrt``) are used inside the
fit, so the Python and TypeScript implementations produce identical numeric
results on the shared fixture.

All data is synthetic.  The module never reads a file, opens a database, uses
the network, or contains real student data.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Callable, Mapping, Sequence

from .curriculum_graph import content_hash
from .evolution import (
    HOST_ROLES,
    Actor,
    ApprovalDeniedError,
    ApprovalRecord,
    AuditLog,
    Candidate,
    LifecycleError,
)

# ---------------------------------------------------------------------------
# Versions and controlled vocabularies
# ---------------------------------------------------------------------------

#: Canonical schema identifier for the calibration report payload.
CALIBRATION_SCHEMA_VERSION = "aeh.fsrs.calibration.v1"
#: Version of the synthetic data generator (kept for provenance).
GENERATOR_VERSION = "aeh.fsrs.synthetic.v1"
#: Default synthetic data version; a calibration config must name the exact
#: dataset version it was fit against.
DEFAULT_DATA_VERSION = "synthetic.fsrs.calibration.v1"
#: Fitted parameter-set version used by reports/candidates by default.
DEFAULT_PARAMETER_VERSION = "fsrs_calibrated_aeh_v1"
#: The spec 8.3 illustrative, uncalibrated baseline.
BASELINE_PARAMETER_VERSION = "fsrs_illustrative_19_81"

#: FSRS-4.5-like illustrative constants from spec 8.3.
FSRS_19_81 = 19.0 / 81.0
FSRS_81_19 = 81.0 / 19.0
MIN_STABILITY_DAYS = 0.4
DIFFICULTY_MIN = 1.0
DIFFICULTY_MAX = 10.0
DIFFICULTY_REFERENCE = 5.0
#: Reliability curve bin count for expected calibration error.
ECE_BINS = 10
#: A parameter whose bootstrap CI is wider than this fraction of its prior
#: scale is reported as weakly identified rather than individually calibrated.
IDENTIFIABILITY_CI_RATIO = 0.5

#: Fixed parameter order.  Both implementations iterate exactly this order so
#: coordinate descent and hashing agree byte for byte.
PARAMETER_NAMES: tuple[str, ...] = (
    "initial_stability_days",
    "success_growth",
    "failure_shrink",
    "initial_difficulty",
    "difficulty_success_delta",
    "difficulty_failure_delta",
)

_PARAMETER_BOUNDS: tuple[tuple[float, float], ...] = (
    (0.2, 20.0),
    (0.05, 2.0),
    (0.05, 0.9),
    (1.0, 10.0),
    (0.0, 1.0),
    (0.0, 2.0),
)

_PARAMETER_PRIORS: tuple[float, ...] = (1.0, 0.6, 0.4, 5.0, 0.2, 0.5)

PARAMETER_BOUNDS: Mapping[str, tuple[float, float]] = MappingProxyType(
    dict(zip(PARAMETER_NAMES, _PARAMETER_BOUNDS))
)
PARAMETER_PRIORS: Mapping[str, float] = MappingProxyType(
    dict(zip(PARAMETER_NAMES, _PARAMETER_PRIORS))
)
PARAMETER_SCALES: Mapping[str, float] = MappingProxyType(
    {
        name: upper - lower
        for name, (lower, upper) in zip(PARAMETER_NAMES, _PARAMETER_BOUNDS)
    }
)

#: Sources that may contribute independently observed real-transfer evidence.
TRUSTED_REAL_SOURCES: tuple[str, ...] = (
    "student",
    "teacher",
    "trusted_grader",
    "assessment",
)

# Activation-gate lifecycle states.
STATUS_REGISTERED = "registered"
STATUS_EVALUATED = "evaluated"
STATUS_REJECTED = "rejected"
STATUS_APPROVED = "approved"
STATUS_ACTIVATED = "activated"
STATUS_ROLLED_BACK = "rolled_back"

# Audit actions for the activation gate (aligned with spec section 22).
ACTION_CALIBRATION_REGISTERED = "calibration.registered"
ACTION_CALIBRATION_EVALUATED = "calibration.evaluated"
ACTION_CALIBRATION_REJECTED = "calibration.rejected"
ACTION_CALIBRATION_APPROVED = "calibration.approved"
ACTION_CALIBRATION_ACTIVATED = "calibration.activated"
ACTION_CALIBRATION_ROLLED_BACK = "calibration.rolled_back"

_OPAQUE_CHARS = set(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789._:-"
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class CalibrationError(Exception):
    """Base class for calibration errors."""


class CalibrationValidationError(CalibrationError, ValueError):
    """A dataset, parameter vector, or configuration is malformed."""


class CalibrationDeniedError(CalibrationError):
    """An activation was attempted without evaluation/approval."""


# ---------------------------------------------------------------------------
# Deterministic primitives shared with the TypeScript mirror
# ---------------------------------------------------------------------------


def js_round(value: float) -> float:
    """JavaScript ``Math.round`` semantics (ties round toward +infinity)."""
    return math.floor(value + 0.5)


def round4(value: float) -> float:
    """Quantise to four decimals so Python/TS JSON stays byte-identical."""
    return js_round(float(value) * 10000.0) / 10000.0


def quantize_micros(value: float) -> int:
    """Integer micro-units used inside content-addressed fingerprints."""
    return int(js_round(float(value) * 1_000_000))


def mulberry32(seed: int) -> Callable[[], float]:
    """A tiny deterministic PRNG mirrored exactly in TypeScript."""
    state = int(seed) & 0xFFFFFFFF

    def next_value() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (1 | t)) & 0xFFFFFFFF
        inner = ((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF
        t = (t ^ ((t + inner) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return next_value


def _finite(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CalibrationValidationError(f"{field_name} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise CalibrationValidationError(f"{field_name} must be a finite number")
    return number


def _opaque(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise CalibrationValidationError(f"{field_name} must be a non-empty string")
    if len(value) > 200 or any(character not in _OPAQUE_CHARS for character in value):
        raise CalibrationValidationError(
            f"{field_name} must be a short opaque reference"
        )
    return value


def _short_text(value: Any, field_name: str, *, max_length: int = 240) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > max_length
        or "\n" in value
        or "\r" in value
    ):
        raise CalibrationValidationError(
            f"{field_name} must be a short single-line string"
        )
    return value


def _positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise CalibrationValidationError(f"{field_name} must be a positive integer")
    return value


def _non_negative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CalibrationValidationError(
            f"{field_name} must be a non-negative integer"
        )
    return value


def _clamp(value: float, lower: float, upper: float) -> float:
    if value < lower:
        return lower
    if value > upper:
        return upper
    return value


def percentile(sorted_values: Sequence[float], quantile: float) -> float:
    """Linear-interpolation percentile over an already sorted sequence."""
    count = len(sorted_values)
    if count == 0:
        raise CalibrationValidationError("percentile requires at least one value")
    if count == 1:
        return float(sorted_values[0])
    position = quantile * (count - 1)
    lower_index = int(math.floor(position))
    upper_index = int(math.ceil(position))
    if lower_index == upper_index:
        return float(sorted_values[lower_index])
    fraction = position - lower_index
    lower_value = float(sorted_values[lower_index])
    upper_value = float(sorted_values[upper_index])
    return lower_value * (1.0 - fraction) + upper_value * fraction


# ---------------------------------------------------------------------------
# Synthetic review data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReviewEvent:
    """One review observation used for calibration (spec 8.4 quality fields)."""

    elapsed_days: float
    success: bool
    weight: float = 1.0

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "elapsed_days", _finite(self.elapsed_days, "elapsed_days")
        )
        if self.elapsed_days < 0.0:
            raise CalibrationValidationError("elapsed_days must be >= 0")
        object.__setattr__(self, "weight", _finite(self.weight, "weight"))
        if self.weight < 0.0 or self.weight > 1.0:
            raise CalibrationValidationError("weight must be within [0, 1]")
        if not isinstance(self.success, bool):
            raise CalibrationValidationError("success must be a boolean")

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "elapsedDays": round4(self.elapsed_days),
            "success": self.success,
            "weight": round4(self.weight),
        }


@dataclass(frozen=True)
class ReviewSequence:
    """One learner x one memory unit synthetic review history."""

    sequence_id: str
    scope: str
    events: tuple[ReviewEvent, ...]

    def __post_init__(self) -> None:
        _opaque(self.sequence_id, "sequence_id")
        _short_text(self.scope, "scope", max_length=120)
        events = tuple(self.events)
        if not events:
            raise CalibrationValidationError("a sequence needs at least one event")
        for event in events:
            if not isinstance(event, ReviewEvent):
                raise CalibrationValidationError("events must be ReviewEvent")
        object.__setattr__(self, "events", events)

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "sequenceId": self.sequence_id,
            "scope": self.scope,
            "events": [event.as_dict() for event in self.events],
        }


@dataclass(frozen=True)
class CalibrationDataset:
    """A frozen, synthetic dataset with an explicit data version."""

    dataset_id: str
    data_version: str
    generator_version: str
    scope: str
    sequences: tuple[ReviewSequence, ...]

    def __post_init__(self) -> None:
        _opaque(self.dataset_id, "dataset_id")
        _short_text(self.data_version, "data_version", max_length=120)
        _short_text(self.generator_version, "generator_version", max_length=120)
        _short_text(self.scope, "scope", max_length=120)
        sequences = tuple(self.sequences)
        if not sequences:
            raise CalibrationValidationError("a dataset needs at least one sequence")
        seen: set[str] = set()
        for sequence in sequences:
            if not isinstance(sequence, ReviewSequence):
                raise CalibrationValidationError("sequences must be ReviewSequence")
            if sequence.sequence_id in seen:
                raise CalibrationValidationError(
                    f"duplicate sequence id: {sequence.sequence_id}"
                )
            seen.add(sequence.sequence_id)
        object.__setattr__(self, "sequences", sequences)

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "datasetId": self.dataset_id,
            "dataVersion": self.data_version,
            "generatorVersion": self.generator_version,
            "scope": self.scope,
            "sequences": [sequence.as_dict() for sequence in self.sequences],
        }

    def digest(self) -> str:
        return content_hash(self.as_dict())

    def observation_count(self) -> int:
        return sum(len(sequence.events) for sequence in self.sequences)

    def summary(self) -> Mapping[str, Any]:
        return {
            "datasetId": self.dataset_id,
            "dataVersion": self.data_version,
            "generatorVersion": self.generator_version,
            "scope": self.scope,
            "sequenceCount": len(self.sequences),
            "observationCount": self.observation_count(),
            "digest": self.digest(),
        }


# ---------------------------------------------------------------------------
# Fitted parameter vector and the deterministic model
# ---------------------------------------------------------------------------


def _predict_sequence_values(
    values: Sequence[float], sequence: ReviewSequence
) -> tuple[float, ...]:
    """Predicted recall probabilities before each observed review.

    Uses only ``+ - * /`` and ``sqrt`` so both languages agree exactly.  The
    illustrative retention curve is evaluated directly as
    ``1 / sqrt(1 + 19/81 * t / S_eff)`` with a difficulty-modulated effective
    stability ``S_eff = max(min_S, S * (10 - D) / 5)``.
    """
    stability = values[0]
    difficulty = values[3]
    success_growth = values[1]
    failure_shrink = values[2]
    difficulty_success_delta = values[4]
    difficulty_failure_delta = values[5]
    predictions: list[float] = []
    for event in sequence.events:
        factor = (DIFFICULTY_MAX - difficulty) / (
            DIFFICULTY_MAX - DIFFICULTY_REFERENCE
        )
        effective = stability * factor
        if effective < MIN_STABILITY_DAYS:
            effective = MIN_STABILITY_DAYS
        predicted = 1.0 / math.sqrt(
            1.0 + FSRS_19_81 * event.elapsed_days / effective
        )
        predictions.append(predicted)

        weight = event.weight
        if weight > 0.0:
            if event.success:
                stability = stability * (1.0 + success_growth * weight)
                difficulty = difficulty - difficulty_success_delta * weight
                if difficulty < DIFFICULTY_MIN:
                    difficulty = DIFFICULTY_MIN
            else:
                stability = stability * (1.0 - failure_shrink * weight)
                if stability < MIN_STABILITY_DAYS:
                    stability = MIN_STABILITY_DAYS
                difficulty = difficulty + difficulty_failure_delta * weight
                if difficulty > DIFFICULTY_MAX:
                    difficulty = DIFFICULTY_MAX
    return tuple(predictions)


@dataclass(frozen=True)
class FSRSParameters:
    """A validated FSRS dynamics parameter vector."""

    initial_stability_days: float
    success_growth: float
    failure_shrink: float
    initial_difficulty: float
    difficulty_success_delta: float
    difficulty_failure_delta: float
    parameter_version: str = DEFAULT_PARAMETER_VERSION

    def __post_init__(self) -> None:
        for name in PARAMETER_NAMES:
            value = _finite(getattr(self, name), name)
            lower, upper = PARAMETER_BOUNDS[name]
            if value < lower or value > upper:
                raise CalibrationValidationError(
                    f"{name} must be within [{lower}, {upper}]"
                )
            object.__setattr__(self, name, value)
        _short_text(self.parameter_version, "parameter_version", max_length=120)

    @classmethod
    def baseline(cls) -> "FSRSParameters":
        """The spec 8.3 illustrative parameters before any calibration."""
        return cls.from_values(_PARAMETER_PRIORS, parameter_version=BASELINE_PARAMETER_VERSION)

    @classmethod
    def from_values(
        cls, values: Sequence[float], *, parameter_version: str = DEFAULT_PARAMETER_VERSION
    ) -> "FSRSParameters":
        if len(values) != len(PARAMETER_NAMES):
            raise CalibrationValidationError(
                f"expected {len(PARAMETER_NAMES)} parameter values"
            )
        return cls(
            initial_stability_days=float(values[0]),
            success_growth=float(values[1]),
            failure_shrink=float(values[2]),
            initial_difficulty=float(values[3]),
            difficulty_success_delta=float(values[4]),
            difficulty_failure_delta=float(values[5]),
            parameter_version=parameter_version,
        )

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "FSRSParameters":
        if not isinstance(data, Mapping):
            raise CalibrationValidationError("parameters must be a mapping")
        missing = [name for name in PARAMETER_NAMES if name not in data]
        if missing:
            raise CalibrationValidationError(f"parameters missing: {missing}")
        return cls(
            initial_stability_days=data["initial_stability_days"],
            success_growth=data["success_growth"],
            failure_shrink=data["failure_shrink"],
            initial_difficulty=data["initial_difficulty"],
            difficulty_success_delta=data["difficulty_success_delta"],
            difficulty_failure_delta=data["difficulty_failure_delta"],
            parameter_version=data.get("parameter_version", DEFAULT_PARAMETER_VERSION),
        )

    def values(self) -> tuple[float, ...]:
        return (
            self.initial_stability_days,
            self.success_growth,
            self.failure_shrink,
            self.initial_difficulty,
            self.difficulty_success_delta,
            self.difficulty_failure_delta,
        )

    def value_dict(self) -> dict[str, float]:
        return dict(zip(PARAMETER_NAMES, self.values()))

    def quantized_dict(self) -> dict[str, float]:
        """Four-decimal parameter values for reports and candidates."""
        return {name: round4(value) for name, value in self.value_dict().items()}

    def as_dict(self) -> Mapping[str, Any]:
        result = self.quantized_dict()
        result["parameter_version"] = self.parameter_version
        return result

    def difficulty_factor(self, difficulty: float) -> float:
        return (DIFFICULTY_MAX - difficulty) / (
            DIFFICULTY_MAX - DIFFICULTY_REFERENCE
        )

    def effective_stability(self, stability: float, difficulty: float) -> float:
        effective = stability * self.difficulty_factor(difficulty)
        return effective if effective > MIN_STABILITY_DAYS else MIN_STABILITY_DAYS

    def predict(self, elapsed_days: float, stability: float, difficulty: float) -> float:
        """Spec 8.3 retention curve with difficulty-modulated stability."""
        effective = self.effective_stability(stability, difficulty)
        return 1.0 / math.sqrt(1.0 + FSRS_19_81 * elapsed_days / effective)

    def update(
        self, stability: float, difficulty: float, success: bool, weight: float
    ) -> tuple[float, float]:
        if weight <= 0.0:
            return stability, difficulty
        if success:
            stability = stability * (1.0 + self.success_growth * weight)
            difficulty = difficulty - self.difficulty_success_delta * weight
            if difficulty < DIFFICULTY_MIN:
                difficulty = DIFFICULTY_MIN
        else:
            stability = stability * (1.0 - self.failure_shrink * weight)
            if stability < MIN_STABILITY_DAYS:
                stability = MIN_STABILITY_DAYS
            difficulty = difficulty + self.difficulty_failure_delta * weight
            if difficulty > DIFFICULTY_MAX:
                difficulty = DIFFICULTY_MAX
        return stability, difficulty

    def predict_sequence(self, sequence: ReviewSequence) -> tuple[float, ...]:
        return _predict_sequence_values(self.values(), sequence)

    def brier_score(self, sequences: Sequence[ReviewSequence]) -> float:
        return _brier_score(self.values(), sequences)


# ---------------------------------------------------------------------------
# Objective and deterministic optimizer
# ---------------------------------------------------------------------------


def _brier_score(
    values: Sequence[float], sequences: Sequence[ReviewSequence]
) -> float:
    if not sequences:
        raise CalibrationValidationError("brier score needs at least one sequence")
    total = 0.0
    count = 0
    for sequence in sequences:
        predictions = _predict_sequence_values(values, sequence)
        for index, event in enumerate(sequence.events):
            target = 1.0 if event.success else 0.0
            difference = predictions[index] - target
            total += difference * difference
            count += 1
    return total / count


def _objective(
    values: Sequence[float], sequences: Sequence[ReviewSequence], ridge: float
) -> tuple[float, float]:
    """Brier score plus a small ridge toward the spec-8.3 priors.

    Returns ``(objective, brier)``.  The ridge is a deterministic shrinkage
    term (spec 8.5) that keeps weakly identified parameters near the public
    prior instead of chasing noise in a sparse synthetic sequence.
    """
    brier = _brier_score(values, sequences)
    penalty = 0.0
    for index, name in enumerate(PARAMETER_NAMES):
        scale = PARAMETER_SCALES[name]
        z = (float(values[index]) - _PARAMETER_PRIORS[index]) / scale
        penalty += z * z
    penalty = ridge * penalty / len(PARAMETER_NAMES)
    return brier + penalty, brier


def _starting_points() -> tuple[tuple[float, ...], ...]:
    """Deterministic multi-start seeds for coordinate descent.

    The Brier surface is not convex (stability and difficulty interact), so a
    single descent from the priors can stop in a local optimum.  These four
    fixed starts make the fit reproducible *and* less start-sensitive.
    """
    prior = tuple(_PARAMETER_PRIORS)
    midpoint = tuple(
        (lower + upper) / 2.0 for lower, upper in _PARAMETER_BOUNDS
    )
    lower_quarter = tuple(
        lower + (upper - lower) * 0.25 for lower, upper in _PARAMETER_BOUNDS
    )
    upper_quarter = tuple(
        lower + (upper - lower) * 0.75 for lower, upper in _PARAMETER_BOUNDS
    )
    return (prior, midpoint, lower_quarter, upper_quarter)


def _descend(
    sequences: Sequence[ReviewSequence],
    config: "CalibrationConfig",
    start: Sequence[float],
) -> tuple[list[float], float, float]:
    values = list(start)
    steps = [
        (upper - lower) * config.step_fraction
        for lower, upper in _PARAMETER_BOUNDS
    ]
    objective, _ = _objective(values, sequences, config.ridge)
    for _ in range(config.rounds):
        for index in range(len(PARAMETER_NAMES)):
            lower, upper = _PARAMETER_BOUNDS[index]
            for direction in (-1.0, 1.0):
                trial = list(values)
                trial[index] = _clamp(
                    values[index] + direction * steps[index], lower, upper
                )
                trial_objective, _ = _objective(trial, sequences, config.ridge)
                if trial_objective < objective:
                    values = trial
                    objective = trial_objective
        steps = [step * 0.5 for step in steps]
    final_objective, final_brier = _objective(values, sequences, config.ridge)
    return values, final_objective, final_brier


def _fit_parameters(
    sequences: Sequence[ReviewSequence], config: "CalibrationConfig"
) -> tuple[list[float], float, float]:
    """Deterministic best-of multi-start coordinate descent."""
    best_values: list[float] | None = None
    best_objective = math.inf
    best_brier = math.inf
    for start in _starting_points():
        values, objective, brier = _descend(sequences, config, start)
        if objective < best_objective:
            best_values = values
            best_objective = objective
            best_brier = brier
    assert best_values is not None
    return best_values, best_objective, best_brier


@dataclass(frozen=True)
class CalibrationConfig:
    """Frozen, reproducible calibration configuration."""

    seed: int = 20240607
    data_version: str = DEFAULT_DATA_VERSION
    parameter_version: str = DEFAULT_PARAMETER_VERSION
    rounds: int = 4
    step_fraction: float = 0.25
    bootstrap_resamples: int = 32
    ridge: float = 0.002
    confidence: float = 0.95
    min_sequences: int = 3
    min_observations: int = 20

    def __post_init__(self) -> None:
        seed = _non_negative_int(self.seed, "seed")
        if seed > 0xFFFFFFFF:
            raise CalibrationValidationError("seed must be within uint32")
        object.__setattr__(self, "seed", seed)
        _short_text(self.data_version, "data_version", max_length=120)
        _short_text(self.parameter_version, "parameter_version", max_length=120)
        object.__setattr__(self, "rounds", _positive_int(self.rounds, "rounds"))
        step_fraction = _finite(self.step_fraction, "step_fraction")
        if step_fraction <= 0.0 or step_fraction >= 1.0:
            raise CalibrationValidationError("step_fraction must be within (0, 1)")
        object.__setattr__(self, "step_fraction", step_fraction)
        object.__setattr__(
            self,
            "bootstrap_resamples",
            _positive_int(self.bootstrap_resamples, "bootstrap_resamples"),
        )
        ridge = _finite(self.ridge, "ridge")
        if ridge < 0.0:
            raise CalibrationValidationError("ridge must be >= 0")
        object.__setattr__(self, "ridge", ridge)
        confidence = _finite(self.confidence, "confidence")
        if confidence <= 0.5 or confidence >= 1.0:
            raise CalibrationValidationError("confidence must be within (0.5, 1)")
        object.__setattr__(self, "confidence", confidence)
        object.__setattr__(
            self, "min_sequences", _positive_int(self.min_sequences, "min_sequences")
        )
        object.__setattr__(
            self,
            "min_observations",
            _positive_int(self.min_observations, "min_observations"),
        )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "seed": self.seed,
            "dataVersion": self.data_version,
            "parameterVersion": self.parameter_version,
            "rounds": self.rounds,
            "stepFraction": round4(self.step_fraction),
            "bootstrapResamples": self.bootstrap_resamples,
            "ridge": round4(self.ridge),
            "confidence": round4(self.confidence),
            "minSequences": self.min_sequences,
            "minObservations": self.min_observations,
        }

    def fingerprint(self) -> str:
        return content_hash(self.as_dict())


# ---------------------------------------------------------------------------
# Report structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParameterEstimate:
    """Point estimate and bootstrap interval for one parameter."""

    name: str
    point: float
    ci_low: float
    ci_high: float
    prior: float
    lower: float
    upper: float

    def __post_init__(self) -> None:
        if self.name not in PARAMETER_NAMES:
            raise CalibrationValidationError(f"unknown parameter {self.name!r}")

    def ci_width(self) -> float:
        return self.ci_high - self.ci_low

    def scale(self) -> float:
        return self.upper - self.lower

    def identified(self) -> bool:
        return self.ci_width() <= IDENTIFIABILITY_CI_RATIO * self.scale()

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "name": self.name,
            "point": round4(self.point),
            "ciLow": round4(self.ci_low),
            "ciHigh": round4(self.ci_high),
            "prior": round4(self.prior),
            "identified": self.identified(),
        }


@dataclass(frozen=True)
class CalibrationMetrics:
    """Probability-calibration metrics (spec 8.5)."""

    brier: float
    brier_ci_low: float
    brier_ci_high: float
    ece: float
    log_loss: float
    reliability_bins: tuple[Mapping[str, Any], ...]

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "brier": round4(self.brier),
            "brierCiLow": round4(self.brier_ci_low),
            "brierCiHigh": round4(self.brier_ci_high),
            "ece": round4(self.ece),
            "logLoss": round4(self.log_loss),
            "reliabilityBins": [
                {
                    "count": bin_entry["count"],
                    "meanPredicted": round4(bin_entry["meanPredicted"]),
                    "meanObserved": round4(bin_entry["meanObserved"]),
                }
                for bin_entry in self.reliability_bins
            ],
        }


@dataclass(frozen=True)
class Applicability:
    """Where the fitted parameters may (not) be applied."""

    scope: str
    sequence_count: int
    observation_count: int
    elapsed_days_min: float
    elapsed_days_max: float
    independent_observations: int
    hinted_observations: int
    evidence_sufficient: bool
    conditions: tuple[str, ...]
    out_of_scope: tuple[str, ...]

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "scope": self.scope,
            "sequenceCount": self.sequence_count,
            "observationCount": self.observation_count,
            "elapsedDaysMin": round4(self.elapsed_days_min),
            "elapsedDaysMax": round4(self.elapsed_days_max),
            "independentObservations": self.independent_observations,
            "hintedObservations": self.hinted_observations,
            "evidenceSufficient": self.evidence_sufficient,
            "conditions": list(self.conditions),
            "outOfScope": list(self.out_of_scope),
        }


@dataclass(frozen=True)
class CalibrationReport:
    """A reproducible calibration result; never a production change."""

    parameter_version: str
    data_version: str
    seed: int
    dataset_digest: str
    config_fingerprint: str
    parameters: FSRSParameters
    estimates: tuple[ParameterEstimate, ...]
    metrics: CalibrationMetrics
    applicability: Applicability
    sequence_count: int
    observation_count: int
    evidence_sufficient: bool
    limitations: tuple[str, ...] = field(default_factory=tuple)

    def estimate(self, name: str) -> ParameterEstimate:
        for estimate in self.estimates:
            if estimate.name == name:
                return estimate
        raise CalibrationValidationError(f"unknown estimate {name!r}")

    def payload(self) -> Mapping[str, Any]:
        return {
            "schema": CALIBRATION_SCHEMA_VERSION,
            "parameterVersion": self.parameter_version,
            "dataVersion": self.data_version,
            "seed": self.seed,
            "datasetDigest": self.dataset_digest,
            "configFingerprint": self.config_fingerprint,
            "parameters": self.parameters.quantized_dict(),
            "estimates": [estimate.as_dict() for estimate in self.estimates],
            "metrics": self.metrics.as_dict(),
            "applicability": self.applicability.as_dict(),
            "sequenceCount": self.sequence_count,
            "observationCount": self.observation_count,
            "evidenceSufficient": self.evidence_sufficient,
        }

    def fingerprint(self) -> str:
        return content_hash(self.payload())

    def as_dict(self) -> Mapping[str, Any]:
        result = dict(self.payload())
        result["reportFingerprint"] = self.fingerprint()
        result["limitations"] = list(self.limitations)
        return result


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _reliability_bins(
    values: Sequence[float], sequences: Sequence[ReviewSequence]
) -> tuple[tuple[Mapping[str, Any], ...], float, float]:
    counts = [0] * ECE_BINS
    sum_predicted = [0.0] * ECE_BINS
    sum_observed = [0.0] * ECE_BINS
    total = 0
    log_loss = 0.0
    epsilon = 1.0e-9
    for sequence in sequences:
        predictions = _predict_sequence_values(values, sequence)
        for index, event in enumerate(sequence.events):
            predicted = predictions[index]
            observed = 1.0 if event.success else 0.0
            bin_index = int(math.floor(predicted * ECE_BINS))
            if bin_index < 0:
                bin_index = 0
            if bin_index >= ECE_BINS:
                bin_index = ECE_BINS - 1
            counts[bin_index] += 1
            sum_predicted[bin_index] += predicted
            sum_observed[bin_index] += observed
            total += 1
            clamped = predicted if predicted > epsilon else epsilon
            if clamped > 1.0 - epsilon:
                clamped = 1.0 - epsilon
            log_loss -= observed * math.log(clamped) + (1.0 - observed) * math.log(
                1.0 - clamped
            )

    ece = 0.0
    bins: list[Mapping[str, Any]] = []
    for bin_index in range(ECE_BINS):
        count = counts[bin_index]
        if count == 0:
            bins.append(
                MappingProxyType(
                    {"count": 0, "meanPredicted": 0.0, "meanObserved": 0.0}
                )
            )
            continue
        mean_predicted = sum_predicted[bin_index] / count
        mean_observed = sum_observed[bin_index] / count
        difference = mean_predicted - mean_observed
        ece += (count / total) * (difference if difference >= 0 else -difference)
        bins.append(
            MappingProxyType(
                {
                    "count": count,
                    "meanPredicted": mean_predicted,
                    "meanObserved": mean_observed,
                }
            )
        )
    return tuple(bins), ece, log_loss / total


# ---------------------------------------------------------------------------
# Calibration entry point
# ---------------------------------------------------------------------------


def _bootstrap(
    sequences: Sequence[ReviewSequence], config: CalibrationConfig
) -> tuple[dict[str, list[float]], list[float]]:
    rng = mulberry32(config.seed)
    count = len(sequences)
    samples: dict[str, list[float]] = {name: [] for name in PARAMETER_NAMES}
    briers: list[float] = []
    for _ in range(config.bootstrap_resamples):
        picks: list[ReviewSequence] = []
        for _ in range(count):
            index = int(math.floor(rng() * count))
            picks.append(sequences[index])
        values, _, _ = _fit_parameters(picks, config)
        for index, name in enumerate(PARAMETER_NAMES):
            samples[name].append(values[index])
        briers.append(_brier_score(values, picks))
    return samples, briers


def calibrate(
    dataset: CalibrationDataset, config: CalibrationConfig | None = None
) -> CalibrationReport:
    """Fit FSRS dynamics parameters from synthetic sequences.

    Pure function: it does not mutate any memory/twin state.
    """
    if not isinstance(dataset, CalibrationDataset):
        raise CalibrationValidationError("dataset must be a CalibrationDataset")
    config = config or CalibrationConfig()
    if not isinstance(config, CalibrationConfig):
        raise CalibrationValidationError("config must be a CalibrationConfig")
    if config.data_version != dataset.data_version:
        raise CalibrationValidationError(
            "config.data_version must match the dataset's data_version"
        )

    values, _, _ = _fit_parameters(dataset.sequences, config)
    parameters = FSRSParameters.from_values(
        values, parameter_version=config.parameter_version
    )
    bins, ece, log_loss = _reliability_bins(
        parameters.values(), dataset.sequences
    )
    point_brier = _brier_score(parameters.values(), dataset.sequences)

    samples, brier_samples = _bootstrap(dataset.sequences, config)
    alpha = (1.0 - config.confidence) / 2.0
    estimates: list[ParameterEstimate] = []
    for name in PARAMETER_NAMES:
        sorted_samples = sorted(samples[name])
        lower, upper = PARAMETER_BOUNDS[name]
        estimates.append(
            ParameterEstimate(
                name=name,
                point=parameters.value_dict()[name],
                ci_low=percentile(sorted_samples, alpha),
                ci_high=percentile(sorted_samples, 1.0 - alpha),
                prior=PARAMETER_PRIORS[name],
                lower=lower,
                upper=upper,
            )
        )
    sorted_brier = sorted(brier_samples)
    metrics = CalibrationMetrics(
        brier=point_brier,
        brier_ci_low=percentile(sorted_brier, alpha),
        brier_ci_high=percentile(sorted_brier, 1.0 - alpha),
        ece=ece,
        log_loss=log_loss,
        reliability_bins=bins,
    )

    observation_count = dataset.observation_count()
    elapsed_values = [
        event.elapsed_days
        for sequence in dataset.sequences
        for event in sequence.events
    ]
    independent = sum(
        1
        for sequence in dataset.sequences
        for event in sequence.events
        if event.weight >= 1.0
    )
    hinted = sum(
        1
        for sequence in dataset.sequences
        for event in sequence.events
        if 0.0 < event.weight < 1.0
    )
    evidence_sufficient = (
        len(dataset.sequences) >= config.min_sequences
        and observation_count >= config.min_observations
    )
    elapsed_min = min(elapsed_values)
    elapsed_max = max(elapsed_values)
    conditions = (
        "synthetic-only calibration; this is not a production calibration",
        f"scope={dataset.scope}",
        f"data_version={dataset.data_version}",
        f"parameter_version={config.parameter_version}",
        f"elapsed_days within [{round4(elapsed_min)}, {round4(elapsed_max)}]",
    )
    out_of_scope = (
        "real student scheduling or mastery until prospective, independently "
        "observed validation",
        "extrapolation beyond the observed elapsed-day range",
        "knowledge components outside the declared scope",
        "any change that lowers the curriculum/safety gate or writes observed "
        "twin state",
    )
    applicability = Applicability(
        scope=dataset.scope,
        sequence_count=len(dataset.sequences),
        observation_count=observation_count,
        elapsed_days_min=elapsed_min,
        elapsed_days_max=elapsed_max,
        independent_observations=independent,
        hinted_observations=hinted,
        evidence_sufficient=evidence_sufficient,
        conditions=conditions,
        out_of_scope=out_of_scope,
    )

    weak = [
        estimate.name for estimate in estimates if not estimate.identified()
    ]
    limitations = (
        "synthetic review sequences only; no real student data is used",
        "the illustrative 19/81 retention curve and a linear difficulty term "
        "are fixed; only dynamics parameters are fit",
        "bootstrap intervals quantify resampling uncertainty, not model "
        "misspecification",
        "weakly identified parameters: " + (", ".join(weak) if weak else "none"),
    )

    return CalibrationReport(
        parameter_version=config.parameter_version,
        data_version=dataset.data_version,
        seed=config.seed,
        dataset_digest=dataset.digest(),
        config_fingerprint=config.fingerprint(),
        parameters=parameters,
        estimates=tuple(estimates),
        metrics=metrics,
        applicability=applicability,
        sequence_count=len(dataset.sequences),
        observation_count=observation_count,
        evidence_sufficient=evidence_sufficient,
        limitations=limitations,
    )


# ---------------------------------------------------------------------------
# Synthetic data generator (deterministic; used by the CLI and tests)
# ---------------------------------------------------------------------------


def generate_dataset(
    *,
    seed: int = 20240607,
    sequence_count: int = 8,
    events_per_sequence: int = 4,
    scope: str = "synthetic.mathematics.secondary",
    data_version: str = DEFAULT_DATA_VERSION,
    dataset_id: str = "dataset.synthetic.fsrs.calibration",
    independent_probability: float = 0.7,
) -> CalibrationDataset:
    """Generate synthetic sequences consistent with the model.

    The latent process uses fixed latent parameters; the calibration therefore
    has real signal to recover.  Purely deterministic from ``seed``.
    """
    _positive_int(sequence_count, "sequence_count")
    _positive_int(events_per_sequence, "events_per_sequence")
    probability = _finite(independent_probability, "independent_probability")
    if probability < 0.0 or probability > 1.0:
        raise CalibrationValidationError(
            "independent_probability must be within [0, 1]"
        )
    rng = mulberry32(seed)
    # Deliberately distinct from the public prior (spec 8.3 illustrative
    # values), so the synthetic data has recoverable signal and a fitted model
    # can beat the uncalibrated baseline on a held-out set.
    latent = FSRSParameters(
        initial_stability_days=6.0,
        success_growth=1.4,
        failure_shrink=0.15,
        initial_difficulty=8.0,
        difficulty_success_delta=0.7,
        difficulty_failure_delta=1.2,
        parameter_version="latent.synthetic.v1",
    )
    sequences: list[ReviewSequence] = []
    for sequence_index in range(sequence_count):
        # Cohort-level latent parameters with modest per-sequence jitter; the
        # calibration target is the cohort, not an individual private curve.
        stability = latent.initial_stability_days * (0.8 + 0.4 * rng())
        difficulty = latent.initial_difficulty + (rng() - 0.5) * 1.5
        if difficulty < DIFFICULTY_MIN:
            difficulty = DIFFICULTY_MIN
        if difficulty > DIFFICULTY_MAX:
            difficulty = DIFFICULTY_MAX
        events: list[ReviewEvent] = []
        for _ in range(events_per_sequence):
            elapsed = 0.5 + 14.0 * rng()
            independent = rng() < probability
            weight = 1.0 if independent else 0.3
            effective = stability * latent.difficulty_factor(difficulty)
            if effective < MIN_STABILITY_DAYS:
                effective = MIN_STABILITY_DAYS
            predicted = 1.0 / math.sqrt(
                1.0 + FSRS_19_81 * elapsed / effective
            )
            success = rng() < predicted
            events.append(
                ReviewEvent(
                    elapsed_days=round4(elapsed),
                    success=success,
                    weight=weight,
                )
            )
            stability, difficulty = latent.update(
                stability, difficulty, success, weight
            )
        sequences.append(
            ReviewSequence(
                sequence_id=f"seq.synthetic.{sequence_index:04d}",
                scope=scope,
                events=tuple(events),
            )
        )
    return CalibrationDataset(
        dataset_id=dataset_id,
        data_version=data_version,
        generator_version=GENERATOR_VERSION,
        scope=scope,
        sequences=tuple(sequences),
    )


def dataset_from_dict(data: Mapping[str, Any]) -> CalibrationDataset:
    """Build a dataset from a snake_case or camelCase mapping."""

    def pick(mapping: Mapping[str, Any], *keys: str) -> Any:
        for key in keys:
            if key in mapping:
                return mapping[key]
        raise CalibrationValidationError(f"missing key; expected one of {keys}")

    if not isinstance(data, Mapping):
        raise CalibrationValidationError("dataset must be a mapping")
    sequences: list[ReviewSequence] = []
    for raw_sequence in pick(data, "sequences"):
        events = tuple(
            ReviewEvent(
                elapsed_days=pick(raw_event, "elapsedDays", "elapsed_days"),
                success=pick(raw_event, "success"),
                weight=pick(raw_event, "weight"),
            )
            for raw_event in pick(raw_sequence, "events")
        )
        sequences.append(
            ReviewSequence(
                sequence_id=pick(raw_sequence, "sequenceId", "sequence_id"),
                scope=pick(raw_sequence, "scope"),
                events=events,
            )
        )
    return CalibrationDataset(
        dataset_id=pick(data, "datasetId", "dataset_id"),
        data_version=pick(data, "dataVersion", "data_version"),
        generator_version=pick(data, "generatorVersion", "generator_version"),
        scope=pick(data, "scope"),
        sequences=tuple(sequences),
    )


# ---------------------------------------------------------------------------
# Candidate generation (control plane: no production mutation)
# ---------------------------------------------------------------------------


#: This module never mutates production; activation is a recorded host decision.
PRODUCTION_MUTATION_ENABLED = False
#: The calibration path only ever runs on synthetic fixtures in this repo.
SYNTHETIC_FIXTURES_ONLY = True
#: Impact scopes a calibration candidate may declare (spec 27 allowed surfaces).
CALIBRATION_IMPACT_SCOPES: tuple[str, ...] = (
    "review_scheduling",
    "simulation_parameters",
)


def parameters_from_candidate(candidate: Candidate) -> FSRSParameters:
    """Extract the declared parameter vector from a calibration candidate."""
    if not isinstance(candidate, Candidate):
        raise CalibrationValidationError("expected an evolution Candidate")
    raw = candidate.changes.get("parameters")
    if not isinstance(raw, Mapping):
        raise CalibrationValidationError(
            "candidate changes must contain a 'parameters' mapping"
        )
    version = candidate.changes.get("parameter_version")
    data = dict(raw)
    if version is not None:
        data["parameter_version"] = version
    return FSRSParameters.from_dict(data)


@dataclass(frozen=True)
class CalibrationCandidateBundle:
    """A report plus the versioned declarative candidate it proposes."""

    report: CalibrationReport
    candidate: Candidate

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "report": self.report.as_dict(),
            "candidate": self.candidate.as_dict(),
            "productionMutationEnabled": PRODUCTION_MUTATION_ENABLED,
            "syntheticFixturesOnly": SYNTHETIC_FIXTURES_ONLY,
        }


class CalibrationService:
    """Fit parameters and propose a versioned candidate.  No side effects."""

    def __init__(
        self,
        dataset: CalibrationDataset,
        config: CalibrationConfig | None = None,
    ) -> None:
        if not isinstance(dataset, CalibrationDataset):
            raise CalibrationValidationError("dataset must be a CalibrationDataset")
        self.dataset = dataset
        self.config = config or CalibrationConfig()

    def calibrate(self) -> CalibrationReport:
        return calibrate(self.dataset, self.config)

    def propose_candidate(
        self,
        report: CalibrationReport,
        *,
        author: str,
        created_at: datetime,
    ) -> Candidate:
        if not isinstance(report, CalibrationReport):
            raise CalibrationValidationError("report must be a CalibrationReport")
        if report.parameter_version != self.config.parameter_version:
            raise CalibrationValidationError(
                "report parameter_version must match the service config"
            )
        candidate = Candidate(
            candidate_id="fsrs.calibration." + report.parameter_version,
            version=report.parameter_version,
            kind="config",
            source="human_request",
            change_summary=(
                "calibrated FSRS dynamics parameters from synthetic review "
                "sequences; requires isolated evaluation and explicit host approval"
            ),
            impact_scope=CALIBRATION_IMPACT_SCOPES,
            baseline_version=BASELINE_PARAMETER_VERSION,
            changes={
                "parameter_version": report.parameter_version,
                "data_version": report.data_version,
                "dataset_digest": report.dataset_digest,
                "report_fingerprint": report.fingerprint(),
                "parameters": report.parameters.quantized_dict(),
            },
            created_at=created_at,
            author=author,
        )
        return candidate


# ---------------------------------------------------------------------------
# Isolated evaluation and explicit approval gate
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CalibrationApprovalPolicy:
    """Screening thresholds; simulated gain alone never activates (spec 27.4)."""

    min_held_out_sequences: int = 2
    min_held_out_observations: int = 10
    min_brier_improvement: float = 0.0
    min_real_transfer_items: int = 2
    min_real_transfer_delta: float = 0.0

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "min_held_out_sequences",
            _positive_int(self.min_held_out_sequences, "min_held_out_sequences"),
        )
        object.__setattr__(
            self,
            "min_held_out_observations",
            _positive_int(
                self.min_held_out_observations, "min_held_out_observations"
            ),
        )
        object.__setattr__(
            self,
            "min_real_transfer_items",
            _positive_int(self.min_real_transfer_items, "min_real_transfer_items"),
        )
        for name in ("min_brier_improvement", "min_real_transfer_delta"):
            object.__setattr__(self, name, _finite(getattr(self, name), name))

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "minHeldOutSequences": self.min_held_out_sequences,
            "minHeldOutObservations": self.min_held_out_observations,
            "minBrierImprovement": round4(self.min_brier_improvement),
            "minRealTransferItems": self.min_real_transfer_items,
            "minRealTransferDelta": round4(self.min_real_transfer_delta),
        }


@dataclass(frozen=True)
class RealTransferEvidence:
    """Independently observed transfer outcomes from a trusted source."""

    source: str
    item_count: int
    observed_delta: float
    all_items_unseen: bool

    def __post_init__(self) -> None:
        if self.source not in TRUSTED_REAL_SOURCES:
            raise CalibrationValidationError(
                f"real transfer source {self.source!r} is not trusted"
            )
        object.__setattr__(
            self, "item_count", _non_negative_int(self.item_count, "item_count")
        )
        object.__setattr__(
            self,
            "observed_delta",
            _finite(self.observed_delta, "observed_delta"),
        )
        if not isinstance(self.all_items_unseen, bool):
            raise CalibrationValidationError("all_items_unseen must be a boolean")

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "source": self.source,
            "itemCount": self.item_count,
            "observedDelta": round4(self.observed_delta),
            "allItemsUnseen": self.all_items_unseen,
        }


@dataclass(frozen=True)
class CalibrationEvaluation:
    """Separated simulated-benefit and real-transfer evidence for a candidate."""

    candidate_id: str
    candidate_version: str
    held_out_digest: str
    simulated_benefit: Mapping[str, Any] | None
    real_transfer: Mapping[str, Any] | None
    screening_passed: bool
    promotion_ready: bool
    evidence_sufficient: bool
    reasons: tuple[str, ...]
    isolation_checks: tuple[str, ...]
    limitations: tuple[str, ...]
    evaluated_at: datetime

    def __post_init__(self) -> None:
        if self.simulated_benefit is not None:
            if self.simulated_benefit.get("isCausalEvidence") is not False:
                raise CalibrationValidationError(
                    "simulated benefit must never be causal evidence"
                )
        if self.real_transfer is not None:
            if self.real_transfer.get("isCausalEvidence") is not False:
                raise CalibrationValidationError(
                    "real transfer evidence is descriptive, not causal"
                )
        if self.promotion_ready and not self.screening_passed:
            raise CalibrationValidationError(
                "promotion requires a passed screening stage"
            )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidateId": self.candidate_id,
            "candidateVersion": self.candidate_version,
            "heldOutDigest": self.held_out_digest,
            "simulatedBenefit": (
                None
                if self.simulated_benefit is None
                else {key: value for key, value in self.simulated_benefit.items()}
            ),
            "realTransfer": (
                None
                if self.real_transfer is None
                else {key: value for key, value in self.real_transfer.items()}
            ),
            "screeningPassed": self.screening_passed,
            "promotionReady": self.promotion_ready,
            "evidenceSufficient": self.evidence_sufficient,
            "reasons": list(self.reasons),
            "isolationChecks": list(self.isolation_checks),
            "limitations": list(self.limitations),
            "evaluatedAt": self.evaluated_at.astimezone(timezone.utc).isoformat(),
        }


def evaluate_candidate(
    candidate: Candidate,
    held_out: CalibrationDataset,
    *,
    policy: CalibrationApprovalPolicy | None = None,
    real_evidence: RealTransferEvidence | None = None,
    evaluated_at: datetime | None = None,
) -> CalibrationEvaluation:
    """Evaluate a candidate on a held-out synthetic set, channels separate."""
    if not isinstance(held_out, CalibrationDataset):
        raise CalibrationValidationError("held_out must be a CalibrationDataset")
    policy = policy or CalibrationApprovalPolicy()
    stamp = evaluated_at or datetime.now(timezone.utc)
    parameters = parameters_from_candidate(candidate)
    baseline = FSRSParameters.baseline()
    baseline_brier = baseline.brier_score(held_out.sequences)
    candidate_brier = parameters.brier_score(held_out.sequences)
    improvement = baseline_brier - candidate_brier

    simulated_benefit: Mapping[str, Any] = MappingProxyType(
        {
            "channel": "simulated",
            "heldOutSequenceCount": len(held_out.sequences),
            "heldOutObservationCount": held_out.observation_count(),
            "baselineBrier": round4(baseline_brier),
            "candidateBrier": round4(candidate_brier),
            "brierImprovement": round4(improvement),
            "isCausalEvidence": False,
            "interpretation": "held-out synthetic fit quality; not a real "
            "learning effect",
        }
    )

    real_transfer: Mapping[str, Any] | None = None
    reasons: list[str] = []
    if real_evidence is not None:
        real_transfer = MappingProxyType(
            {
                "channel": "real",
                "source": real_evidence.source,
                "itemCount": real_evidence.item_count,
                "observedDelta": round4(real_evidence.observed_delta),
                "allItemsUnseen": real_evidence.all_items_unseen,
                "isCausalEvidence": False,
                "interpretation": "descriptive only; no control group",
            }
        )

    evidence_sufficient = (
        len(held_out.sequences) >= policy.min_held_out_sequences
        and held_out.observation_count() >= policy.min_held_out_observations
    )
    screening_passed = (
        evidence_sufficient and improvement >= policy.min_brier_improvement
    )
    if not evidence_sufficient:
        reasons.append("screening_failed:insufficient_held_out_evidence")
    if improvement < policy.min_brier_improvement:
        reasons.append("screening_failed:brier_improvement_below_threshold")

    real_ok = False
    if real_transfer is None:
        reasons.append("promotion_blocked:real_transfer_evidence_missing")
    elif real_evidence is not None:
        if real_evidence.item_count < policy.min_real_transfer_items:
            reasons.append("real_transfer_failed:too_few_items")
        elif real_evidence.observed_delta < policy.min_real_transfer_delta:
            reasons.append("real_transfer_failed:delta_below_threshold")
        elif not real_evidence.all_items_unseen:
            reasons.append("real_transfer_failed:item_was_seen")
        else:
            real_ok = True

    return CalibrationEvaluation(
        candidate_id=candidate.candidate_id,
        candidate_version=candidate.version,
        held_out_digest=held_out.digest(),
        simulated_benefit=simulated_benefit,
        real_transfer=real_transfer,
        screening_passed=screening_passed,
        promotion_ready=screening_passed and real_ok,
        evidence_sufficient=evidence_sufficient,
        reasons=tuple(reasons),
        isolation_checks=(
            "no observed twin or mastery write path exists in this module",
            "held-out evaluation uses a disjoint synthetic dataset",
            "simulated benefit is never causal evidence",
            "real transfer requires a trusted source and unseen items",
        ),
        limitations=(
            "synthetic held-out data only; a real deployment needs prospective "
            "real-student validation",
            "simulated gain alone can never activate a parameter set",
        ),
        evaluated_at=stamp,
    )


@dataclass(frozen=True)
class ActivatedParameters:
    """The result of an approved activation: a frozen parameter set."""

    candidate_id: str
    candidate_version: str
    parameter_version: str
    data_version: str
    values: Mapping[str, float]
    activated_by: str
    activated_at: datetime
    previous_stable_version: str

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidateId": self.candidate_id,
            "candidateVersion": self.candidate_version,
            "parameterVersion": self.parameter_version,
            "dataVersion": self.data_version,
            "values": {key: round4(value) for key, value in self.values.items()},
            "activatedBy": self.activated_by,
            "activatedAt": self.activated_at.astimezone(timezone.utc).isoformat(),
            "previousStableVersion": self.previous_stable_version,
        }


@dataclass
class CalibrationRecord:
    candidate: Candidate
    status: str
    registered_at: datetime
    updated_at: datetime
    evaluation: CalibrationEvaluation | None = None
    approval: ApprovalRecord | None = None
    activation: ActivatedParameters | None = None
    rolled_back: bool = False

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate": self.candidate.as_dict(),
            "status": self.status,
            "registeredAt": self.registered_at.astimezone(timezone.utc).isoformat(),
            "updatedAt": self.updated_at.astimezone(timezone.utc).isoformat(),
            "evaluation": (
                None if self.evaluation is None else self.evaluation.as_dict()
            ),
            "approval": None if self.approval is None else self.approval.as_dict(),
            "activation": (
                None if self.activation is None else self.activation.as_dict()
            ),
            "rolledBack": self.rolled_back,
        }


class CalibrationActivationGate:
    """register -> isolated evaluation -> explicit approval -> activation.

    All methods are host-side.  There is intentionally no method that lets a
    candidate approve or activate itself, and activation returns a frozen
    parameter set rather than mutating any memory or twin state.
    """

    def __init__(
        self,
        *,
        policy: CalibrationApprovalPolicy | None = None,
        audit: AuditLog | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.audit = audit or AuditLog(now=self._now)
        self.policy = policy or CalibrationApprovalPolicy()
        self._records: dict[tuple[str, str], CalibrationRecord] = {}
        self._stable_versions: dict[str, str] = {}

    # -- queries -----------------------------------------------------------

    def status(self, candidate_id: str, version: str) -> str | None:
        record = self._records.get((candidate_id, version))
        return None if record is None else record.status

    def record(self, candidate_id: str, version: str) -> CalibrationRecord:
        return self._require_record(candidate_id, version)

    def list_records(self) -> tuple[CalibrationRecord, ...]:
        return tuple(self._records.values())

    def active_parameters(self, parameter_group: str) -> str | None:
        return self._stable_versions.get(parameter_group)

    def pipeline_snapshot(self) -> Mapping[str, Any]:
        return {
            "productionMutationEnabled": PRODUCTION_MUTATION_ENABLED,
            "syntheticFixturesOnly": SYNTHETIC_FIXTURES_ONLY,
            "policy": self.policy.as_dict(),
            "records": [record.as_dict() for record in self._records.values()],
            "activeParameterVersions": dict(self._stable_versions),
            "auditHead": self.audit.head(),
        }

    # -- internals ---------------------------------------------------------

    def _require_record(self, candidate_id: str, version: str) -> CalibrationRecord:
        record = self._records.get((candidate_id, version))
        if record is None:
            raise LifecycleError(
                f"unknown calibration candidate {candidate_id}/{version}"
            )
        return record

    def _assert_host_actor(
        self, actor: Actor, record: CalibrationRecord, error: type[Exception]
    ) -> None:
        if not isinstance(actor, Actor):
            raise error("an explicit host-side actor is required")
        if actor.actor_id == record.candidate.author:
            raise error("a candidate can never approve or activate itself")
        if actor.role not in HOST_ROLES:
            raise error(f"role {actor.role!r} is not a host-side role")

    # -- stage 1: register -------------------------------------------------

    def register(self, candidate: Candidate) -> CalibrationRecord:
        if not isinstance(candidate, Candidate):
            raise CalibrationValidationError("register expects a Candidate")
        key = (candidate.candidate_id, candidate.version)
        existing = self._records.get(key)
        if existing is not None:
            return existing
        stamp = self._now()
        record = CalibrationRecord(
            candidate=candidate,
            status=STATUS_REGISTERED,
            registered_at=stamp,
            updated_at=stamp,
        )
        self._records[key] = record
        self._stable_versions.setdefault(
            candidate.candidate_id, candidate.baseline_version
        )
        self.audit.append(
            actor=candidate.author,
            action=ACTION_CALIBRATION_REGISTERED,
            subject=candidate.candidate_id,
            outcome="accepted",
            detail={
                "version": candidate.version,
                "impactScope": list(candidate.impact_scope),
                "baselineVersion": candidate.baseline_version,
            },
        )
        return record

    # -- stage 2: isolated evaluation --------------------------------------

    def evaluate(
        self,
        candidate_id: str,
        version: str,
        held_out: CalibrationDataset,
        *,
        actor: Actor,
        real_evidence: RealTransferEvidence | None = None,
    ) -> CalibrationEvaluation:
        record = self._require_record(candidate_id, version)
        if record.status not in (STATUS_REGISTERED, STATUS_EVALUATED):
            raise LifecycleError(
                f"cannot evaluate candidate in status {record.status!r}"
            )
        verdict = evaluate_candidate(
            record.candidate,
            held_out,
            policy=self.policy,
            real_evidence=real_evidence,
            evaluated_at=self._now(),
        )
        record.evaluation = verdict
        record.status = STATUS_EVALUATED if verdict.screening_passed else STATUS_REJECTED
        record.updated_at = self._now()
        self.audit.append(
            actor=actor.actor_id,
            action=(
                ACTION_CALIBRATION_EVALUATED
                if verdict.screening_passed
                else ACTION_CALIBRATION_REJECTED
            ),
            subject=candidate_id,
            outcome="accepted" if verdict.screening_passed else "rejected",
            detail={
                "version": version,
                "heldOutDigest": verdict.held_out_digest,
                "screeningPassed": verdict.screening_passed,
                "promotionReady": verdict.promotion_ready,
                "reasons": list(verdict.reasons),
            },
        )
        return verdict

    # -- stage 3: explicit approval ----------------------------------------

    def approve(
        self,
        candidate_id: str,
        version: str,
        approval: ApprovalRecord | None,
        actor: Actor,
    ) -> CalibrationRecord:
        record = self._require_record(candidate_id, version)
        if record.status != STATUS_EVALUATED:
            raise LifecycleError(
                "approval requires a candidate that passed isolated evaluation; "
                f"current status is {record.status!r}"
            )
        self._assert_host_actor(actor, record, ApprovalDeniedError)
        if approval is None:
            raise ApprovalDeniedError(
                "approval is default-deny: an explicit approval record is required"
            )
        if (
            approval.candidate_id != candidate_id
            or approval.candidate_version != version
        ):
            raise ApprovalDeniedError("approval record names a different candidate")
        if approval.approved_by != actor.actor_id:
            raise ApprovalDeniedError(
                "approval record approved_by must match the acting reviewer"
            )
        if approval.role not in HOST_ROLES:
            raise ApprovalDeniedError(
                f"approval role {approval.role!r} is not a host-side role"
            )
        record.approval = approval
        if approval.decision == "rejected":
            record.status = STATUS_REJECTED
        else:
            record.status = STATUS_APPROVED
        record.updated_at = self._now()
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CALIBRATION_APPROVED,
            subject=candidate_id,
            outcome="accepted" if approval.decision == "approved" else "rejected",
            detail={
                "version": version,
                "decision": approval.decision,
                "role": approval.role,
                "reason": approval.reason,
            },
        )
        return record

    # -- stage 4: activation (returns a config, never writes mastery) ------

    def activate(
        self,
        candidate_id: str,
        version: str,
        *,
        actor: Actor,
    ) -> ActivatedParameters:
        record = self._require_record(candidate_id, version)
        if record.status != STATUS_APPROVED:
            raise CalibrationDeniedError(
                "activation requires an explicitly approved candidate; "
                f"current status is {record.status!r}"
            )
        self._assert_host_actor(actor, record, CalibrationDeniedError)
        parameters = parameters_from_candidate(record.candidate)
        previous = self._stable_versions.get(
            candidate_id, record.candidate.baseline_version
        )
        activation = ActivatedParameters(
            candidate_id=candidate_id,
            candidate_version=version,
            parameter_version=parameters.parameter_version,
            data_version=str(record.candidate.changes.get("data_version", "")),
            values=MappingProxyType(parameters.quantized_dict()),
            activated_by=actor.actor_id,
            activated_at=self._now(),
            previous_stable_version=previous,
        )
        self._stable_versions[candidate_id] = version
        record.activation = activation
        record.status = STATUS_ACTIVATED
        record.updated_at = self._now()
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CALIBRATION_ACTIVATED,
            subject=candidate_id,
            outcome="accepted",
            detail={
                "version": version,
                "previousStableVersion": previous,
                "parameterVersion": activation.parameter_version,
            },
        )
        return activation

    # -- rollback ----------------------------------------------------------

    def rollback(
        self,
        candidate_id: str,
        version: str,
        *,
        actor: Actor,
        reason: str,
    ) -> ActivatedParameters:
        record = self._require_record(candidate_id, version)
        if record.status != STATUS_ACTIVATED:
            raise LifecycleError(
                f"nothing to roll back from status {record.status!r}"
            )
        self._assert_host_actor(actor, record, CalibrationDeniedError)
        _short_text(reason, "reason", max_length=200)
        if record.activation is None:
            raise LifecycleError("activation record is missing")
        self._stable_versions[candidate_id] = record.activation.previous_stable_version
        record.rolled_back = True
        record.status = STATUS_ROLLED_BACK
        record.updated_at = self._now()
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CALIBRATION_ROLLED_BACK,
            subject=candidate_id,
            outcome="accepted",
            detail={
                "version": version,
                "toVersion": record.activation.previous_stable_version,
                "reason": reason,
            },
        )
        return record.activation


__all__ = [
    "CALIBRATION_SCHEMA_VERSION",
    "GENERATOR_VERSION",
    "DEFAULT_DATA_VERSION",
    "DEFAULT_PARAMETER_VERSION",
    "BASELINE_PARAMETER_VERSION",
    "FSRS_19_81",
    "FSRS_81_19",
    "MIN_STABILITY_DAYS",
    "DIFFICULTY_MIN",
    "DIFFICULTY_MAX",
    "DIFFICULTY_REFERENCE",
    "PARAMETER_NAMES",
    "PARAMETER_BOUNDS",
    "PARAMETER_PRIORS",
    "PARAMETER_SCALES",
    "TRUSTED_REAL_SOURCES",
    "STATUS_REGISTERED",
    "STATUS_EVALUATED",
    "STATUS_REJECTED",
    "STATUS_APPROVED",
    "STATUS_ACTIVATED",
    "STATUS_ROLLED_BACK",
    "PRODUCTION_MUTATION_ENABLED",
    "SYNTHETIC_FIXTURES_ONLY",
    "CALIBRATION_IMPACT_SCOPES",
    "CalibrationError",
    "CalibrationValidationError",
    "CalibrationDeniedError",
    "CalibrationConfig",
    "CalibrationDataset",
    "CalibrationMetrics",
    "CalibrationReport",
    "ReviewEvent",
    "ReviewSequence",
    "FSRSParameters",
    "ParameterEstimate",
    "Applicability",
    "calibrate",
    "generate_dataset",
    "dataset_from_dict",
    "CalibrationService",
    "CalibrationCandidateBundle",
    "CalibrationApprovalPolicy",
    "RealTransferEvidence",
    "CalibrationEvaluation",
    "ActivatedParameters",
    "CalibrationRecord",
    "CalibrationActivationGate",
    "evaluate_candidate",
    "parameters_from_candidate",
    "js_round",
    "round4",
    "quantize_micros",
    "mulberry32",
    "percentile",
]
