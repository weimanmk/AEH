"""Exercise evolution engine and isolated simulation lab (spec sections 9, 11).

This module implements the Step 10 subset with the Python standard library only:

**Exercise evolution (spec 9.1-9.6)**

* :data:`EVOLUTION_OPERATORS` -- the five permitted operators: numeric
  variation, surface-context variation, distractor variation, difficulty
  adjustment and diagnostic-targeted variation.  The module manipulates
  *content-free structured annotations* and declarative change records; it
  never stores item text, answers, hints, or solutions.
* :class:`EvolutionProvenance` -- every evolved candidate is stamped with its
  source item/version, the applied operator, a declarative change record, the
  affected knowledge components and the deterministic seed.  A candidate
  without a non-empty affected-KC set is rejected.
* :class:`ExerciseEvolutionEngine` -- generate, validate (fail-closed
  curriculum gate + transitive prerequisite closure + annotation completeness),
  run in the isolated sandbox, and submit to the item bank for review.  A
  candidate that fails validation never reaches the sandbox.
* :class:`EvolutionCandidatePool` -- the only path into the candidate pool.
  Admission requires *both* a passing isolated sandbox verdict *and* an item
  bank record in the ``approved`` review state.  Evolution therefore cannot
  bypass the curriculum gate or the item-bank review flow.

**Simulation lab (spec 11)**

* :class:`SimulationLab` / :class:`SimulationSession` -- a simulation runs
  against an independent copy of a hypothesis snapshot, using a deterministic
  ``mulberry32`` stream so a run is reproducible from ``(config fingerprint,
  snapshot fingerprint, seed)``.
* :class:`SimulationEventLog` -- accepts only simulated sources; a real source
  raises :class:`SimulationIsolationError`, and ``observed_writes`` is always
  ``0``.  Simulated events can never be written into the observed world.
* :class:`SimulationResult` -- records the config fingerprint, snapshot
  fingerprint, per-step draws and a content-addressed result fingerprint so an
  experiment can be replayed exactly.  Simulated gain and real transfer are
  reported separately; the simulation never produces a real-transfer claim.

All examples and tests in this repository are synthetic.  The module does not
read files, open a database, use the network, or contain real student/item
data.  It intentionally does not auto-approve or auto-deliver anything: review
approval and real delivery remain host-side actions.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping, Sequence

from .curriculum_gate import (
    MODE_LEARN,
    CurriculumItem,
    GateDecision,
    LearnerProgress,
    allow,
)
from .curriculum_graph import (
    ItemAnnotation,
    ItemBank,
    ItemNotFoundError,
    ItemRecord,
    KnowledgeGraph,
    content_hash,
    prerequisite_diagnostics,
)
from .evaluation import (
    DEFAULT_REFERENCE_ACCURACY,
    EvaluationProtocol,
    FrozenEvalSet,
    RealOutcome,
)
from .hypothesis import Hypothesis, HypothesisSet
from .twin import SIMULATED_SOURCES

# ---------------------------------------------------------------------------
# Controlled vocabularies / versions
# ---------------------------------------------------------------------------

OPERATOR_NUMERIC = "numeric"
OPERATOR_CONTEXT = "context"
OPERATOR_DISTRACTOR = "distractor"
OPERATOR_DIFFICULTY = "difficulty"
OPERATOR_DIAGNOSTIC = "diagnostic"

#: The five permitted evolution operators (spec 9.3).
EVOLUTION_OPERATORS: tuple[str, ...] = (
    OPERATOR_NUMERIC,
    OPERATOR_CONTEXT,
    OPERATOR_DISTRACTOR,
    OPERATOR_DIFFICULTY,
    OPERATOR_DIAGNOSTIC,
)
EVOLUTION_OPERATOR_SET = frozenset(EVOLUTION_OPERATORS)

GENERATOR_VERSION = "aeh-exercise-evolution-v1"
SCREENING_POLICY_VERSION = "aeh-evolution-screening-v1"
SANDBOX_ID = "aeh-evolution-sandbox"
SIMULATION_LAB_ID = "aeh-synthetic-simulation-lab"

STATUS_GENERATED = "generated"
STATUS_SCREENED = "screened"
STATUS_REJECTED = "rejected"
STATUS_IN_POOL = "candidate_pool"

#: Fixed surface-context tags used by the context operator.  They are opaque
#: curriculum references, not item text.
CONTEXT_TAGS: tuple[str, ...] = (
    "synthetic.context.story",
    "synthetic.context.measurement",
    "synthetic.context.geometry",
    "synthetic.context.graph",
    "synthetic.context.table",
)

# Simulation phases (spec 11.2): independent pre-test, intervention, unseen
# near-transfer post-test, optional unseen far-transfer post-test.
PHASE_PRE = "pre_test"
PHASE_INTERVENTION = "intervention"
PHASE_POST_NEAR = "post_test_near"
PHASE_POST_FAR = "post_test_far"
SIMULATION_PHASES: tuple[str, ...] = (
    PHASE_PRE,
    PHASE_INTERVENTION,
    PHASE_POST_NEAR,
    PHASE_POST_FAR,
)
SIMULATION_PHASE_SET = frozenset(SIMULATION_PHASES)

#: Phases that contribute to the simulated pre/post gain.
GAIN_PHASES: frozenset[str] = frozenset({PHASE_PRE, PHASE_POST_NEAR, PHASE_POST_FAR})

_OPAQUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
_MICROS = 1_000_000


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ExerciseEvolutionError(Exception):
    """Base class for exercise-evolution errors."""


class EvolutionValidationError(ExerciseEvolutionError, ValueError):
    """An evolution candidate, spec or config is malformed."""


class OperatorNotApplicableError(EvolutionValidationError):
    """An operator cannot be applied to the given source item."""


class CandidatePoolError(ExerciseEvolutionError):
    """Admission to the candidate pool was attempted without the full gate."""


class SimulationIsolationError(ExerciseEvolutionError):
    """A simulation tried to touch the observed world or a non-simulated source."""


class SimulationConfigError(ExerciseEvolutionError, ValueError):
    """A simulation config/snapshot is malformed."""


# ---------------------------------------------------------------------------
# Small deterministic helpers (shared with the TypeScript module)
# ---------------------------------------------------------------------------


def _opaque(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not _OPAQUE_RE.match(value):
        raise EvolutionValidationError(
            f"{field_name} must be a short opaque reference"
        )
    return value


def _short_text(value: Any, field_name: str, *, max_length: int = 200) -> str:
    if not isinstance(value, str) or len(value) > max_length or "\r" in value or "\n" in value:
        raise EvolutionValidationError(
            f"{field_name} must be a short single-line string"
        )
    return value


def _non_negative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EvolutionValidationError(f"{field_name} must be a non-negative integer")
    return value


def _positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise EvolutionValidationError(f"{field_name} must be a positive integer")
    return value


def _finite(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvolutionValidationError(f"{field_name} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise EvolutionValidationError(f"{field_name} must be a finite number")
    return number


def _unit_interval(value: Any, field_name: str) -> float:
    number = _finite(value, field_name)
    if number < 0.0 or number > 1.0:
        raise EvolutionValidationError(f"{field_name} must be within [0, 1]")
    return number


def js_round(value: float) -> float:
    """JavaScript ``Math.round`` semantics (ties round toward +infinity).

    Python's built-in :func:`round` is banker's rounding, which would make the
    Python and TypeScript implementations disagree on half values.
    """
    return math.floor(value + 0.5)


def round4(value: float) -> float:
    """Quantise to four decimals so Python/TS JSON stays byte-identical."""
    return js_round(float(value) * 10000.0) / 10000.0


def quantize_micros(value: float) -> int:
    """Integer micro-units used inside content-addressed fingerprints."""
    return int(js_round(float(value) * _MICROS))


def fnv1a32(text: str) -> int:
    """FNV-1a 32-bit; used to derive deterministic per-operator seeds."""
    if not isinstance(text, str):
        raise EvolutionValidationError("fnv1a32 input must be a string")
    digest = 0x811C9DC5
    for byte in text.encode("utf-8"):
        digest ^= byte
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return digest


def mulberry32(seed: int) -> Callable[[], float]:
    """A tiny deterministic PRNG mirrored exactly in TypeScript.

    ``Math.imul`` is emulated as an unsigned 32-bit multiply and every bitwise
    step is masked to 32 bits, so both languages produce the same stream.
    """
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


def _canonical(value: Any) -> str:
    # curriculum_graph.content_hash already implements the shared canonical
    # JSON; use it so Python and TS hashes agree.
    return content_hash(value)


# ---------------------------------------------------------------------------
# Evolution spec / provenance / candidate
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VariantSpec:
    """Declarative request for one evolution operator.

    Operators only describe *how* to vary an item; they never carry item text.
    ``numeric_delta``, ``difficulty_delta`` and ``distractor_count`` are
    optional explicit values.  When omitted the operator derives a value from
    the deterministic seed.
    """

    operator: str
    numeric_delta: float = 0.0
    context_tag: str | None = None
    distractor_count: int | None = None
    difficulty_delta: float = 0.0
    target_misconception: str | None = None
    target_kcs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.operator not in EVOLUTION_OPERATOR_SET:
            raise EvolutionValidationError(
                f"unknown evolution operator {self.operator!r}; "
                f"allowed operators are {sorted(EVOLUTION_OPERATOR_SET)}"
            )
        object.__setattr__(
            self, "numeric_delta", _finite(self.numeric_delta, "numeric_delta")
        )
        object.__setattr__(
            self,
            "difficulty_delta",
            _finite(self.difficulty_delta, "difficulty_delta"),
        )
        if self.context_tag is not None:
            object.__setattr__(
                self,
                "context_tag",
                _short_text(self.context_tag, "context_tag", max_length=120),
            )
        if self.distractor_count is not None:
            object.__setattr__(
                self,
                "distractor_count",
                _positive_int(self.distractor_count, "distractor_count"),
            )
        if self.target_misconception is not None:
            object.__setattr__(
                self,
                "target_misconception",
                _opaque(self.target_misconception, "target_misconception"),
            )
        target_kcs = tuple(self.target_kcs)
        for kc_id in target_kcs:
            _opaque(kc_id, "target_kcs")
        object.__setattr__(self, "target_kcs", target_kcs)


@dataclass(frozen=True)
class EvolutionProvenance:
    """Source, change record and affected KCs for one evolved candidate."""

    source_item_id: str
    source_item_version: int
    operator: str
    change_summary: str
    changes: Mapping[str, Any]
    affected_kcs: tuple[str, ...]
    seed: int
    generator_version: str = GENERATOR_VERSION

    def __post_init__(self) -> None:
        _opaque(self.source_item_id, "source_item_id")
        object.__setattr__(
            self,
            "source_item_version",
            _positive_int(self.source_item_version, "source_item_version"),
        )
        if self.operator not in EVOLUTION_OPERATOR_SET:
            raise EvolutionValidationError(f"unknown operator {self.operator!r}")
        _short_text(self.change_summary, "change_summary", max_length=500)
        if not self.change_summary:
            raise EvolutionValidationError("change_summary must not be empty")
        if not isinstance(self.changes, Mapping) or not self.changes:
            raise EvolutionValidationError("changes must be a non-empty mapping")
        affected = tuple(self.affected_kcs)
        if not affected:
            raise EvolutionValidationError(
                "an evolution candidate must declare at least one affected KC"
            )
        for kc_id in affected:
            _opaque(kc_id, "affected_kcs")
        if len(set(affected)) != len(affected):
            raise EvolutionValidationError("affected_kcs contains duplicates")
        object.__setattr__(self, "affected_kcs", affected)
        object.__setattr__(self, "seed", _non_negative_int(self.seed, "seed"))
        object.__setattr__(
            self,
            "generator_version",
            _short_text(self.generator_version, "generator_version", max_length=120),
        )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "source_item_id": self.source_item_id,
            "source_item_version": self.source_item_version,
            "operator": self.operator,
            "change_summary": self.change_summary,
            "changes": _plain(self.changes),
            "affected_kcs": list(self.affected_kcs),
            "seed": self.seed,
            "generator_version": self.generator_version,
        }


def _plain(value: Any) -> Any:
    """Recursively turn MappingProxyType/tuples into plain JSON structures."""
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def affected_kcs(annotation: ItemAnnotation) -> tuple[str, ...]:
    """Affected KCs = required KCs plus Q-matrix KCs, sorted and de-duplicated."""
    combined = set(annotation.required_kcs)
    combined.update(entry.kc_id for entry in annotation.q_matrix)
    return tuple(sorted(combined))


@dataclass(frozen=True)
class EvolutionCandidate:
    """A generated variant with provenance; no item text is stored."""

    candidate_id: str
    proposed_item_id: str
    annotation: ItemAnnotation
    provenance: EvolutionProvenance
    status: str = STATUS_GENERATED

    def __post_init__(self) -> None:
        _opaque(self.candidate_id, "candidate_id")
        _opaque(self.proposed_item_id, "proposed_item_id")
        if not isinstance(self.annotation, ItemAnnotation):
            raise EvolutionValidationError("annotation must be an ItemAnnotation")
        if not isinstance(self.provenance, EvolutionProvenance):
            raise EvolutionValidationError("provenance must be an EvolutionProvenance")
        _short_text(self.status, "status", max_length=60)

    def to_curriculum_item(self) -> CurriculumItem:
        """Gate item for the evolved variant (marks incomplete annotations)."""
        return self.annotation.to_curriculum_item(self.proposed_item_id)

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "proposed_item_id": self.proposed_item_id,
            "status": self.status,
            "provenance": self.provenance.as_dict(),
            "annotation": self.annotation.snapshot(),
        }

    def content_hash(self) -> str:
        return content_hash(self.as_dict())


@dataclass(frozen=True)
class EvolutionValidation:
    """Fail-closed gate + prerequisite + completeness result for a candidate."""

    candidate_id: str
    valid: bool
    annotation_complete: bool
    gate_decision: GateDecision | None
    missing_prerequisites: tuple[str, ...]
    unknown_kcs: tuple[str, ...]
    reasons: tuple[str, ...]
    allowed_kcs: frozenset[str]

    def __bool__(self) -> bool:
        return self.valid

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "valid": self.valid,
            "annotation_complete": self.annotation_complete,
            "gate_allowed": None if self.gate_decision is None else self.gate_decision.allowed,
            "missing_prerequisites": list(self.missing_prerequisites),
            "unknown_kcs": list(self.unknown_kcs),
            "reasons": list(self.reasons),
            "allowed_kcs": sorted(self.allowed_kcs),
        }


# ---------------------------------------------------------------------------
# Evolution operators
# ---------------------------------------------------------------------------


def _operator_rng(operator: str, seed: int) -> Callable[[], float]:
    return mulberry32((int(seed) ^ fnv1a32(operator)) & 0xFFFFFFFF)


def apply_operator(
    source: ItemAnnotation, spec: VariantSpec, *, seed: int
) -> tuple[ItemAnnotation, Mapping[str, Any], str]:
    """Apply one evolutionary operator to a source annotation.

    Returns ``(evolved_annotation, changes, change_summary)``.  Only
    content-free annotation fields and declarative numeric records change.
    """
    if not isinstance(source, ItemAnnotation):
        raise EvolutionValidationError("source must be an ItemAnnotation")
    if not isinstance(spec, VariantSpec):
        raise EvolutionValidationError("spec must be a VariantSpec")
    rng = _operator_rng(spec.operator, seed)
    operator = spec.operator

    common = {
        "source": f"synthetic.evolved.{operator}",
        "exposure_count": 0,
    }

    if operator == OPERATOR_NUMERIC:
        if spec.numeric_delta != 0.0:
            coefficient_delta = spec.numeric_delta
        else:
            coefficient_delta = quantize_micros(rng() * 0.4 - 0.2) / _MICROS
        constant_delta = quantize_micros(rng() * 2.0 - 1.0) / _MICROS
        changes = {
            "numeric_parameters": {
                "coefficient_delta": round4(coefficient_delta),
                "constant_delta": round4(constant_delta),
                "grade_band_preserved": True,
            }
        }
        summary = (
            "resampled numeric parameters inside the same KC and grade band "
            "while preserving the underlying structure"
        )
        evolved = replace(source, **common)
        return evolved, MappingProxyType(changes), summary

    if operator == OPERATOR_CONTEXT:
        if spec.context_tag is not None:
            context_tag = spec.context_tag
            pinned = True
        else:
            index = int(rng() * len(CONTEXT_TAGS)) % len(CONTEXT_TAGS)
            context_tag = CONTEXT_TAGS[index]
            pinned = False
        changes = {
            "surface_context": {
                "context_tag": context_tag,
                "pinned": pinned,
                "structure_preserved": True,
            }
        }
        summary = f"moved the surface context to {context_tag} without changing structure"
        evolved = replace(source, **common)
        return evolved, MappingProxyType(changes), summary

    if operator == OPERATOR_DISTRACTOR:
        if source.item_type != "multiple_choice":
            raise OperatorNotApplicableError(
                "distractor variation requires a multiple_choice source item"
            )
        if spec.distractor_count is not None:
            count = spec.distractor_count
        else:
            count = 3 + int(rng() * 2.0)
        cognitive_load = round4(source.cognitive_load + 0.05 * count)
        changes = {
            "distractors": {
                "distractor_count": count,
                "strategy": "misconception_matched",
                "correct_option_unchanged": True,
            }
        }
        summary = (
            f"regenerated {count} misconception-matched distractors while "
            "keeping the correct option and required reasoning unchanged"
        )
        evolved = replace(
            source, cognitive_load=cognitive_load, hint_leakage_level=0, **common
        )
        return evolved, MappingProxyType(changes), summary

    if operator == OPERATOR_DIFFICULTY:
        before = source.difficulty if source.difficulty is not None else 0.5
        if spec.difficulty_delta != 0.0:
            delta = spec.difficulty_delta
        else:
            delta = round4(rng() * 0.4 - 0.2)
        after = min(1.0, max(0.0, round4(before + delta)))
        before_minutes = source.estimated_minutes or 5.0
        factor = 1.0 + (after - before)
        after_minutes = round4(max(0.5, before_minutes * factor))
        changes = {
            "difficulty": {
                "before": round4(before),
                "after": after,
                "delta": round4(after - before),
                "estimated_minutes_before": round4(before_minutes),
                "estimated_minutes_after": after_minutes,
            }
        }
        summary = (
            f"adjusted difficulty from {round4(before)} to {after} and scaled "
            "the estimated time accordingly"
        )
        evolved = replace(
            source,
            difficulty=after,
            estimated_minutes=after_minutes,
            **common,
        )
        return evolved, MappingProxyType(changes), summary

    if operator == OPERATOR_DIAGNOSTIC:
        if spec.target_misconception is not None:
            target = spec.target_misconception
        elif source.misconception_targets:
            target = source.misconception_targets[0]
        else:
            target = "synthetic.misconception.generic"
        target_kcs = spec.target_kcs or source.required_kcs
        misconceptions = tuple(dict.fromkeys(source.misconception_targets + (target,)))
        changes = {
            "diagnostic_target": {
                "misconception": target,
                "target_kcs": list(target_kcs),
                "discriminates_hypotheses": True,
            }
        }
        summary = (
            f"targeted the diagnostic variant at misconception {target} so two "
            "cognitive hypotheses predict different observable steps"
        )
        evolved = replace(
            source,
            item_type="diagnostic",
            misconception_targets=misconceptions,
            required_kcs=target_kcs,
            **common,
        )
        return evolved, MappingProxyType(changes), summary

    raise EvolutionValidationError(f"unhandled operator {operator!r}")


# ---------------------------------------------------------------------------
# Simulation lab (spec section 11)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SimulationConfig:
    """Reproducible experiment configuration (seed + version + scenario)."""

    config_version: str
    scenario_id: str
    candidate_id: str
    seed: int
    phase_plan: tuple[str, ...] = (PHASE_PRE, PHASE_INTERVENTION, PHASE_POST_NEAR)
    max_steps: int = 24
    label: str = ""

    def __post_init__(self) -> None:
        _short_text(self.config_version, "config_version", max_length=120)
        if not self.config_version:
            raise SimulationConfigError("config_version must not be empty")
        _opaque(self.scenario_id, "scenario_id")
        _opaque(self.candidate_id, "candidate_id")
        object.__setattr__(self, "seed", _non_negative_int(self.seed, "seed"))
        if self.seed > 0xFFFFFFFF:
            raise SimulationConfigError("seed must be within uint32")
        phases = tuple(self.phase_plan)
        if not phases:
            raise SimulationConfigError("phase_plan must not be empty")
        for phase in phases:
            if phase not in SIMULATION_PHASE_SET:
                raise SimulationConfigError(f"unknown simulation phase: {phase}")
        object.__setattr__(self, "phase_plan", phases)
        object.__setattr__(self, "max_steps", _positive_int(self.max_steps, "max_steps"))
        _short_text(self.label, "label", max_length=200)

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "config_version": self.config_version,
            "scenario_id": self.scenario_id,
            "candidate_id": self.candidate_id,
            "seed": self.seed,
            "phase_plan": list(self.phase_plan),
            "max_steps": self.max_steps,
            "label": self.label,
        }

    def fingerprint(self) -> str:
        return content_hash(self.as_dict())


@dataclass(frozen=True)
class SimulationHypothesis:
    """One sampled hypothesis archetype used by the synthetic behavior model."""

    hypothesis_id: str
    weight: float
    response: float

    def __post_init__(self) -> None:
        _opaque(self.hypothesis_id, "hypothesis_id")
        object.__setattr__(self, "weight", _finite(self.weight, "weight"))
        if self.weight < 0.0:
            raise SimulationConfigError("hypothesis weight must be >= 0")
        object.__setattr__(self, "response", _unit_interval(self.response, "response"))

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "hypothesis_id": self.hypothesis_id,
            "weight": round4(self.weight),
            "response": round4(self.response),
        }


def _response_of(hypothesis: Hypothesis) -> float:
    values = list(hypothesis.predicted_observable_behaviors.values())
    if not values:
        return 0.5
    mean = sum(float(value) for value in values) / len(values)
    return min(1.0, max(0.0, round4(mean)))


@dataclass(frozen=True)
class HypothesisSnapshot:
    """An independent, content-addressed copy of session hypothesis state."""

    snapshot_id: str
    hypotheses: tuple[SimulationHypothesis, ...]
    unknown_weight: float = 0.0
    parent_twin_version: int = 0
    parent_evidence_revision: int = 0

    def __post_init__(self) -> None:
        _opaque(self.snapshot_id, "snapshot_id")
        seen: set[str] = set()
        for hypothesis in self.hypotheses:
            if not isinstance(hypothesis, SimulationHypothesis):
                raise SimulationConfigError("hypotheses must be SimulationHypothesis")
            if hypothesis.hypothesis_id in seen:
                raise SimulationConfigError(
                    f"duplicate hypothesis id: {hypothesis.hypothesis_id}"
                )
            seen.add(hypothesis.hypothesis_id)
        object.__setattr__(self, "unknown_weight", _unit_interval(self.unknown_weight, "unknown_weight"))
        object.__setattr__(
            self,
            "parent_twin_version",
            _non_negative_int(self.parent_twin_version, "parent_twin_version"),
        )
        object.__setattr__(
            self,
            "parent_evidence_revision",
            _non_negative_int(self.parent_evidence_revision, "parent_evidence_revision"),
        )

    @classmethod
    def from_hypothesis_set(
        cls,
        hypothesis_set: HypothesisSet,
        *,
        snapshot_id: str,
        parent_twin_version: int = 0,
        parent_evidence_revision: int = 0,
    ) -> "HypothesisSnapshot":
        if not isinstance(hypothesis_set, HypothesisSet):
            raise SimulationConfigError("snapshot source must be a HypothesisSet")
        hypotheses = tuple(
            SimulationHypothesis(
                hypothesis_id=hypothesis.hypothesis_id,
                weight=round4(hypothesis.weight),
                response=_response_of(hypothesis),
            )
            for hypothesis in sorted(
                hypothesis_set.active(), key=lambda item: item.hypothesis_id
            )
        )
        return cls(
            snapshot_id=snapshot_id,
            hypotheses=hypotheses,
            unknown_weight=round4(hypothesis_set.unknown_weight),
            parent_twin_version=parent_twin_version,
            parent_evidence_revision=parent_evidence_revision,
        )

    def to_hypothesis_set(self) -> HypothesisSet:
        """Build a private, mutable copy for one simulation session."""
        hypotheses = [
            Hypothesis(
                hypothesis_id=item.hypothesis_id,
                predicted_observable_behaviors=MappingProxyType(
                    {"response": item.response}
                ),
                weight=item.weight,
            )
            for item in self.hypotheses
        ]
        return HypothesisSet(hypotheses, unknown_weight=self.unknown_weight)

    def response_by_id(self) -> dict[str, float]:
        return {item.hypothesis_id: item.response for item in self.hypotheses}

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "snapshot_id": self.snapshot_id,
            "hypotheses": [item.as_dict() for item in self.hypotheses],
            "unknown_weight": round4(self.unknown_weight),
            "parent_twin_version": self.parent_twin_version,
            "parent_evidence_revision": self.parent_evidence_revision,
        }

    def fingerprint(self) -> str:
        return content_hash(self.as_dict())


@dataclass(frozen=True)
class SimulationStep:
    """One deterministic simulation step with its draws for replay."""

    step_index: int
    phase: str
    item_id: str
    hypothesis_id: str
    hypothesis_draw: float
    probability: float
    draw: float
    correct: bool
    simulated: bool = True

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "step_index": self.step_index,
            "phase": self.phase,
            "item_id": self.item_id,
            "hypothesis_id": self.hypothesis_id,
            "probability": round4(self.probability),
            "correct": self.correct,
            "simulated": self.simulated,
        }


class SimulationEventLog:
    """Append-only log that only accepts simulated events.

    Appending any source outside :data:`aeh.twin.SIMULATED_SOURCES` -- in
    particular a real source such as ``student`` -- raises
    :class:`SimulationIsolationError`.  The observed-world write counter is a
    constant ``0`` with no setter.
    """

    def __init__(self) -> None:
        self._events: list[Mapping[str, Any]] = []

    def append(self, *, source: str, kind: str, payload: Mapping[str, Any]) -> None:
        if source not in SIMULATED_SOURCES:
            raise SimulationIsolationError(
                f"simulation log rejects non-simulated source {source!r}; "
                "simulated events can never be written to observed state"
            )
        _short_text(kind, "kind", max_length=200)
        self._events.append(
            MappingProxyType(
                {"source": source, "kind": kind, "payload": _plain(payload)}
            )
        )

    def events(self) -> tuple[Mapping[str, Any], ...]:
        return tuple(self._events)

    @property
    def observed_writes(self) -> int:
        # Constant by construction; simulations have no observed write path.
        return 0


@dataclass(frozen=True)
class SimulationResult:
    """A reproducible experiment record; simulated and real are separate."""

    session_id: str
    config: SimulationConfig
    snapshot: HypothesisSnapshot
    steps: tuple[SimulationStep, ...]
    pre_accuracy: float | None
    post_accuracy: float | None
    pre_post_gain: float
    gain_ci_low: float
    gain_ci_high: float
    result_fingerprint: str
    config_fingerprint: str
    snapshot_fingerprint: str
    observed_writes: int
    final_hypothesis_weights: Mapping[str, float]
    #: Always ``None``: a simulation cannot produce a real-transfer result.
    real_transfer: None = None
    limitations: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if self.observed_writes != 0:
            raise SimulationIsolationError(
                "a simulation result must report zero observed writes"
            )
        if self.real_transfer is not None:
            raise SimulationIsolationError(
                "a simulation cannot carry real-transfer evidence"
            )

    def simulated_benefit(self) -> Mapping[str, Any]:
        return {
            "channel": "simulated",
            "item_count": len(self.steps),
            "pre_accuracy": self.pre_accuracy,
            "post_accuracy": self.post_accuracy,
            "simulated_gain": round4(self.pre_post_gain),
            "gain_ci": [round4(self.gain_ci_low), round4(self.gain_ci_high)],
            "is_causal_evidence": False,
            "interpretation": "simulation only; not a real learning effect",
        }

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "session_id": self.session_id,
            "config": self.config.as_dict(),
            "snapshot": self.snapshot.as_dict(),
            "config_fingerprint": self.config_fingerprint,
            "snapshot_fingerprint": self.snapshot_fingerprint,
            "result_fingerprint": self.result_fingerprint,
            "steps": [step.as_dict() for step in self.steps],
            "pre_accuracy": self.pre_accuracy,
            "post_accuracy": self.post_accuracy,
            "simulated_gain": round4(self.pre_post_gain),
            "observed_writes": self.observed_writes,
            "real_transfer": None,
            "final_hypothesis_weights": {
                key: round4(value)
                for key, value in sorted(self.final_hypothesis_weights.items())
            },
            "limitations": list(self.limitations),
        }


class SimulationSession:
    """One isolated simulation run with its own hypothesis copy and log."""

    def __init__(
        self,
        session_id: str,
        config: SimulationConfig,
        snapshot: HypothesisSnapshot,
    ) -> None:
        self.session_id = _opaque(session_id, "session_id")
        self.config = config
        self.snapshot = snapshot
        self._hypotheses = snapshot.to_hypothesis_set()
        self._events = SimulationEventLog()
        self._steps: list[SimulationStep] = []

    @property
    def observed_writes(self) -> int:
        return self._events.observed_writes

    def steps(self) -> tuple[SimulationStep, ...]:
        return tuple(self._steps)

    def hypothesis_weights(self) -> dict[str, float]:
        return dict(self._hypotheses.weights())

    def events(self) -> tuple[Mapping[str, Any], ...]:
        return self._events.events()

    def reweight(
        self,
        likelihoods: Mapping[str, float],
        *,
        evidence_id: str | None = None,
        noise: float = 0.05,
    ) -> dict[str, float]:
        """Reweight the session-private hypothesis set (never the source set)."""
        weights = self._hypotheses.reweight(
            likelihoods, evidence_id=evidence_id, noise=noise
        )
        self._events.append(
            source="simulated",
            kind="simulation.hypothesis_reweighted",
            payload={
                "evidence_id": evidence_id,
                "noise": round4(noise),
                "weights": {key: round4(value) for key, value in sorted(weights.items())},
            },
        )
        return weights

    def run(self, items_by_phase: Mapping[str, Sequence[str]]) -> SimulationResult:
        if not isinstance(items_by_phase, Mapping):
            raise SimulationConfigError("items_by_phase must be a mapping")
        responses = self.snapshot.response_by_id()
        active = sorted(self._hypotheses.active(), key=lambda item: item.hypothesis_id)
        total_weight = sum(item.weight for item in active)
        rng = mulberry32(self.config.seed)
        steps: list[SimulationStep] = []

        for phase in self.config.phase_plan:
            raw_items = items_by_phase.get(phase, ())
            if raw_items is None:
                raw_items = ()
            if isinstance(raw_items, (str, bytes)) or not isinstance(raw_items, Iterable):
                raise SimulationConfigError(f"items for phase {phase!r} must be iterable")
            for raw_item in raw_items:
                if len(steps) >= self.config.max_steps:
                    break
                item_id = _opaque(raw_item, "item_id")
                hypothesis_draw = rng()
                if total_weight > 0.0:
                    target = hypothesis_draw * total_weight
                    cumulative = 0.0
                    chosen = active[-1]
                    for candidate in active:
                        cumulative += candidate.weight
                        if target < cumulative:
                            chosen = candidate
                            break
                    probability = responses.get(chosen.hypothesis_id, 0.5)
                    hypothesis_id = chosen.hypothesis_id
                else:
                    probability = 0.5
                    hypothesis_id = "unknown"
                draw = rng()
                correct = draw < probability
                step = SimulationStep(
                    step_index=len(steps),
                    phase=phase,
                    item_id=item_id,
                    hypothesis_id=hypothesis_id,
                    hypothesis_draw=hypothesis_draw,
                    probability=probability,
                    draw=draw,
                    correct=correct,
                )
                steps.append(step)
                self._events.append(
                    source="simulated",
                    kind="simulation.step",
                    payload={
                        "step_index": step.step_index,
                        "phase": phase,
                        "item_id": item_id,
                        "hypothesis_id": hypothesis_id,
                        "correct": correct,
                    },
                )

        pre = [step for step in steps if step.phase == PHASE_PRE]
        post = [step for step in steps if step.phase in {PHASE_POST_NEAR, PHASE_POST_FAR}]
        pre_accuracy = _accuracy(pre)
        post_accuracy = _accuracy(post)
        gain = (post_accuracy or 0.0) - (pre_accuracy or 0.0)
        if pre_accuracy is not None and post_accuracy is not None:
            se = math.sqrt(
                pre_accuracy * (1.0 - pre_accuracy) / len(pre)
                + post_accuracy * (1.0 - post_accuracy) / len(post)
            )
        else:
            se = 0.0
        ci_low = gain - 1.96 * se
        ci_high = gain + 1.96 * se

        config_fingerprint = self.config.fingerprint()
        snapshot_fingerprint = self.snapshot.fingerprint()
        session_id = "simsession." + content_hash(
            {"config": config_fingerprint, "snapshot": snapshot_fingerprint}
        )[:24]
        fingerprint_payload = {
            "config_fingerprint": config_fingerprint,
            "snapshot_fingerprint": snapshot_fingerprint,
            "steps": [
                {
                    "phase": step.phase,
                    "item_id": step.item_id,
                    "hypothesis_id": step.hypothesis_id,
                    "probability_micros": quantize_micros(step.probability),
                    "correct": step.correct,
                }
                for step in steps
            ],
            "pre_accuracy_micros": (
                None if pre_accuracy is None else quantize_micros(pre_accuracy)
            ),
            "post_accuracy_micros": (
                None if post_accuracy is None else quantize_micros(post_accuracy)
            ),
            "gain_micros": quantize_micros(gain),
            "ci_low_micros": quantize_micros(ci_low),
            "ci_high_micros": quantize_micros(ci_high),
            "observed_writes": 0,
        }
        result_fingerprint = content_hash(fingerprint_payload)
        return SimulationResult(
            session_id=session_id,
            config=self.config,
            snapshot=self.snapshot,
            steps=tuple(steps),
            pre_accuracy=pre_accuracy,
            post_accuracy=post_accuracy,
            pre_post_gain=gain,
            gain_ci_low=ci_low,
            gain_ci_high=ci_high,
            result_fingerprint=result_fingerprint,
            config_fingerprint=config_fingerprint,
            snapshot_fingerprint=snapshot_fingerprint,
            observed_writes=0,
            final_hypothesis_weights=MappingProxyType(self._hypotheses.weights()),
            limitations=(
                "synthetic behavior model only; it is not a calibrated human learning model",
                "simulated gain is screening evidence, never a real learning effect",
                "no real student data, no control group, and no real delivery in this repository",
            ),
        )


def _accuracy(steps: Sequence[SimulationStep]) -> float | None:
    if not steps:
        return None
    correct = sum(1 for step in steps if step.correct)
    return round4(correct / len(steps))


class SimulationLab:
    """Factory for isolated, reproducible simulation sessions."""

    def __init__(self, *, lab_id: str = SIMULATION_LAB_ID) -> None:
        self.lab_id = _short_text(lab_id, "lab_id", max_length=120)

    def open_session(
        self, config: SimulationConfig, snapshot: HypothesisSnapshot
    ) -> SimulationSession:
        if not isinstance(config, SimulationConfig):
            raise SimulationConfigError("config must be a SimulationConfig")
        if not isinstance(snapshot, HypothesisSnapshot):
            raise SimulationConfigError("snapshot must be a HypothesisSnapshot")
        session_id = "simsession." + content_hash(
            {"config": config.fingerprint(), "snapshot": snapshot.fingerprint()}
        )[:24]
        return SimulationSession(session_id, config, snapshot)

    def run(
        self,
        config: SimulationConfig,
        snapshot: HypothesisSnapshot,
        items_by_phase: Mapping[str, Sequence[str]],
    ) -> SimulationResult:
        return self.open_session(config, snapshot).run(items_by_phase)


# ---------------------------------------------------------------------------
# Isolated evolution sandbox: gate-bound screening, separate channels
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScreeningPolicy:
    """Screening thresholds; simulated gain alone never promotes (spec 9.6)."""

    policy_version: str = SCREENING_POLICY_VERSION
    min_simulated_items: int = 3
    min_simulated_gain: float = 0.0
    min_real_transfer_items: int = 2
    min_real_transfer_delta: float = 0.0

    def __post_init__(self) -> None:
        _short_text(self.policy_version, "policy_version", max_length=120)
        object.__setattr__(
            self,
            "min_simulated_items",
            _positive_int(self.min_simulated_items, "min_simulated_items"),
        )
        object.__setattr__(
            self,
            "min_real_transfer_items",
            _positive_int(self.min_real_transfer_items, "min_real_transfer_items"),
        )
        object.__setattr__(
            self,
            "min_simulated_gain",
            _finite(self.min_simulated_gain, "min_simulated_gain"),
        )
        object.__setattr__(
            self,
            "min_real_transfer_delta",
            _finite(self.min_real_transfer_delta, "min_real_transfer_delta"),
        )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "policy_version": self.policy_version,
            "min_simulated_items": self.min_simulated_items,
            "min_simulated_gain": self.min_simulated_gain,
            "min_real_transfer_items": self.min_real_transfer_items,
            "min_real_transfer_delta": self.min_real_transfer_delta,
        }


@dataclass(frozen=True)
class SandboxVerdict:
    """Separated simulated-benefit and real-transfer evidence for a candidate."""

    candidate_id: str
    sandbox_id: str
    simulation: SimulationResult
    simulated_benefit: Mapping[str, Any]
    real_transfer: Mapping[str, Any] | None
    passed_screening: bool
    promotion_ready: bool
    reasons: tuple[str, ...]
    isolation_checks: tuple[str, ...]
    limitations: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.simulation.observed_writes != 0:
            raise SimulationIsolationError("sandbox simulation wrote observed state")
        if self.simulated_benefit.get("is_causal_evidence") is not False:
            raise SimulationIsolationError(
                "simulated benefit must never be marked as causal evidence"
            )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "sandbox_id": self.sandbox_id,
            "simulation": self.simulation.as_dict(),
            "simulated_benefit": _plain(self.simulated_benefit),
            "real_transfer": _plain(self.real_transfer) if self.real_transfer is not None else None,
            "passed_screening": self.passed_screening,
            "promotion_ready": self.promotion_ready,
            "reasons": list(self.reasons),
            "isolation_checks": list(self.isolation_checks),
            "limitations": list(self.limitations),
        }


class EvolutionSandbox:
    """A deterministic, side-effect-free screening sandbox (spec 9.4).

    The sandbox has no file, network, database, or production access.  It runs
    the :class:`SimulationLab` against an independent hypothesis snapshot and
    reports simulated benefit and real transfer on separate channels.  Real
    transfer can only come from the independent Step 5
    :class:`~aeh.evaluation.EvaluationProtocol`; it is never derived from the
    simulation.
    """

    def __init__(
        self,
        *,
        sandbox_id: str = SANDBOX_ID,
        lab: SimulationLab | None = None,
        policy: ScreeningPolicy | None = None,
        reference_accuracy: float = DEFAULT_REFERENCE_ACCURACY,
    ) -> None:
        self.sandbox_id = _short_text(sandbox_id, "sandbox_id", max_length=120)
        self.lab = lab or SimulationLab()
        self.policy = policy or ScreeningPolicy()
        self.reference_accuracy = _unit_interval(reference_accuracy, "reference_accuracy")

    def evaluate(
        self,
        candidate: EvolutionCandidate,
        *,
        snapshot: HypothesisSnapshot,
        items_by_phase: Mapping[str, Sequence[str]],
        config: SimulationConfig | None = None,
        frozen_set: FrozenEvalSet | None = None,
        real_outcomes: Sequence[RealOutcome] = (),
    ) -> SandboxVerdict:
        if not isinstance(candidate, EvolutionCandidate):
            raise EvolutionValidationError("sandbox only evaluates EvolutionCandidate")
        if not isinstance(snapshot, HypothesisSnapshot):
            raise EvolutionValidationError("sandbox requires a HypothesisSnapshot")
        if config is None:
            config = SimulationConfig(
                config_version=SCREENING_POLICY_VERSION,
                scenario_id=f"scenario.{candidate.candidate_id}",
                candidate_id=candidate.candidate_id,
                seed=candidate.provenance.seed,
            )
        if config.candidate_id != candidate.candidate_id:
            raise EvolutionValidationError(
                "simulation config candidate_id must match the evaluated candidate"
            )

        simulation = self.lab.run(config, snapshot, items_by_phase)
        benefit = simulation.simulated_benefit()

        reasons: list[str] = []
        simulated_items = int(benefit["item_count"])
        if simulated_items < self.policy.min_simulated_items:
            reasons.append("screening_failed:too_few_simulated_items")
        if simulation.pre_post_gain < self.policy.min_simulated_gain:
            reasons.append("screening_failed:simulated_gain_below_threshold")
        passed_screening = (
            simulation.observed_writes == 0
            and simulated_items >= self.policy.min_simulated_items
            and simulation.pre_post_gain >= self.policy.min_simulated_gain
        )

        real_transfer: Mapping[str, Any] | None = None
        real_ok = False
        if real_outcomes:
            if frozen_set is None:
                raise EvolutionValidationError(
                    "real transfer outcomes require a FrozenEvalSet; the sandbox "
                    "never fabricates real evidence"
                )
            protocol = EvaluationProtocol(
                frozen_set, reference_accuracy=self.reference_accuracy
            )
            run = protocol.run(real_outcomes=real_outcomes)
            if run.real_transfer is not None:
                real_transfer = run.real_transfer.as_dict()
        if real_transfer is not None:
            if real_transfer["item_count"] < self.policy.min_real_transfer_items:
                reasons.append("real_transfer_failed:too_few_items")
            elif real_transfer["observed_delta"] < self.policy.min_real_transfer_delta:
                reasons.append("real_transfer_failed:delta_below_threshold")
            elif not real_transfer["all_items_unseen"]:
                reasons.append("real_transfer_failed:item_was_seen")
            else:
                real_ok = True
        else:
            reasons.append("promotion_blocked:real_transfer_evidence_missing")

        return SandboxVerdict(
            candidate_id=candidate.candidate_id,
            sandbox_id=self.sandbox_id,
            simulation=simulation,
            simulated_benefit=benefit,
            real_transfer=real_transfer,
            passed_screening=passed_screening,
            promotion_ready=real_ok,
            reasons=tuple(reasons),
            isolation_checks=(
                "all simulation events use simulated sources",
                "observed_writes == 0",
                "hypothesis state is an independent snapshot copy",
                "config and result are content-addressed and replayable",
                "simulated benefit and real transfer are reported separately",
            ),
            limitations=simulation.limitations,
        )


@dataclass(frozen=True)
class ScreenOutcome:
    """The only object admissible to the candidate pool."""

    candidate: EvolutionCandidate
    validation: EvolutionValidation
    sandbox_verdict: SandboxVerdict
    status: str
    eligible: bool
    reasons: tuple[str, ...]

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate": self.candidate.as_dict(),
            "validation": self.validation.as_dict(),
            "sandbox": (
                None if self.sandbox_verdict is None else self.sandbox_verdict.as_dict()
            ),
            "status": self.status,
            "eligible": self.eligible,
            "reasons": list(self.reasons),
        }


# ---------------------------------------------------------------------------
# Engine + candidate pool
# ---------------------------------------------------------------------------


class ExerciseEvolutionEngine:
    """Generate -> gate -> sandbox -> review for evolved exercise candidates."""

    def __init__(
        self,
        bank: ItemBank,
        graph: KnowledgeGraph | None,
        *,
        seed: int = 0,
        sandbox: EvolutionSandbox | None = None,
        generator_version: str = GENERATOR_VERSION,
    ) -> None:
        if not isinstance(bank, ItemBank):
            raise EvolutionValidationError("engine requires an ItemBank")
        if graph is not None and not isinstance(graph, KnowledgeGraph):
            raise EvolutionValidationError("graph must be a KnowledgeGraph or None")
        self.bank = bank
        self.graph = graph
        self.seed = _non_negative_int(seed, "seed")
        self.sandbox = sandbox or EvolutionSandbox()
        self.generator_version = _short_text(
            generator_version, "generator_version", max_length=120
        )

    # -- stage 1: generate -------------------------------------------------
    def generate(
        self,
        source_item_id: str,
        spec: VariantSpec,
        *,
        candidate_id: str | None = None,
    ) -> EvolutionCandidate:
        source_item_id = _opaque(source_item_id, "source_item_id")
        if not isinstance(spec, VariantSpec):
            raise EvolutionValidationError("spec must be a VariantSpec")
        record = self.bank.current(source_item_id)
        annotation, changes, summary = apply_operator(
            record.annotation, spec, seed=self.seed
        )
        affected = affected_kcs(annotation)
        if not affected:
            raise EvolutionValidationError(
                "evolved item must affect at least one knowledge component"
            )
        identifier = candidate_id or (
            f"cand.{source_item_id}.{spec.operator}.{self.seed}"
        )
        proposed_item_id = f"evo.{source_item_id}.{spec.operator}.{self.seed}"
        provenance = EvolutionProvenance(
            source_item_id=source_item_id,
            source_item_version=record.version,
            operator=spec.operator,
            change_summary=summary,
            changes=changes,
            affected_kcs=affected,
            seed=self.seed,
            generator_version=self.generator_version,
        )
        return EvolutionCandidate(
            candidate_id=_opaque(identifier, "candidate_id"),
            proposed_item_id=_opaque(proposed_item_id, "proposed_item_id"),
            annotation=annotation,
            provenance=provenance,
            status=STATUS_GENERATED,
        )

    # -- stage 2: fail-closed validation ----------------------------------
    def validate(
        self,
        candidate: EvolutionCandidate,
        progress: LearnerProgress,
        mode: str = MODE_LEARN,
    ) -> EvolutionValidation:
        if not isinstance(candidate, EvolutionCandidate):
            raise EvolutionValidationError("validate expects an EvolutionCandidate")
        item = candidate.to_curriculum_item()
        missing = candidate.annotation.missing_annotation_fields()
        decision = allow(item, progress, mode)
        reasons = list(decision.reasons)
        if missing:
            reasons.append("incomplete_annotation:" + ",".join(missing))
        if self.graph is None:
            reasons.append("graph_unavailable")
            return EvolutionValidation(
                candidate_id=candidate.candidate_id,
                valid=False,
                annotation_complete=not missing,
                gate_decision=decision,
                missing_prerequisites=(),
                unknown_kcs=(),
                reasons=tuple(reasons),
                allowed_kcs=frozenset(decision.allowed_kcs),
            )
        missing_prereq, unknown = prerequisite_diagnostics(
            self.graph, item.required_kcs, decision.allowed_kcs
        )
        if unknown:
            reasons.append("kc_not_in_graph:" + ",".join(unknown))
        if missing_prereq:
            reasons.append("prerequisites_not_met:" + ",".join(missing_prereq))
        return EvolutionValidation(
            candidate_id=candidate.candidate_id,
            valid=not reasons,
            annotation_complete=not missing,
            gate_decision=decision,
            missing_prerequisites=missing_prereq,
            unknown_kcs=unknown,
            reasons=tuple(reasons),
            allowed_kcs=frozenset(decision.allowed_kcs),
        )

    # -- stage 3: isolated sandbox ----------------------------------------
    def evaluate_in_sandbox(
        self,
        candidate: EvolutionCandidate,
        *,
        snapshot: HypothesisSnapshot,
        items_by_phase: Mapping[str, Sequence[str]],
        config: SimulationConfig | None = None,
        frozen_set: FrozenEvalSet | None = None,
        real_outcomes: Sequence[RealOutcome] = (),
    ) -> SandboxVerdict:
        return self.sandbox.evaluate(
            candidate,
            snapshot=snapshot,
            items_by_phase=items_by_phase,
            config=config,
            frozen_set=frozen_set,
            real_outcomes=real_outcomes,
        )

    # -- stage 4: submit to the item bank review flow ---------------------
    def submit_for_review(
        self, candidate: EvolutionCandidate, *, submitted_by: str
    ) -> ItemRecord:
        if not isinstance(candidate, EvolutionCandidate):
            raise EvolutionValidationError("submit_for_review expects a candidate")
        try:
            existing = self.bank.current(candidate.proposed_item_id)
        except ItemNotFoundError:
            existing = None
        if existing is None:
            record = self.bank.add_item(
                candidate.proposed_item_id,
                candidate.annotation,
                review_status="draft",
            )
        else:
            if existing.annotation.snapshot() != candidate.annotation.snapshot():
                raise EvolutionValidationError(
                    f"item {candidate.proposed_item_id} already exists with "
                    "different content"
                )
            record = existing
        if record.review_status in {"draft", "changes_requested"}:
            record = self.bank.submit_for_review(
                candidate.proposed_item_id, submitted_by
            )
        return record

    # -- orchestration -----------------------------------------------------
    def screen(
        self,
        candidate: EvolutionCandidate,
        *,
        progress: LearnerProgress,
        mode: str = MODE_LEARN,
        snapshot: HypothesisSnapshot,
        items_by_phase: Mapping[str, Sequence[str]],
        config: SimulationConfig | None = None,
        frozen_set: FrozenEvalSet | None = None,
        real_outcomes: Sequence[RealOutcome] = (),
    ) -> ScreenOutcome:
        validation = self.validate(candidate, progress, mode)
        reasons = list(validation.reasons)
        verdict: SandboxVerdict | None = None
        if validation.valid:
            # The sandbox only runs after the fail-closed gate accepts the
            # candidate; an invalid candidate can never reach the candidate pool.
            verdict = self.evaluate_in_sandbox(
                candidate,
                snapshot=snapshot,
                items_by_phase=items_by_phase,
                config=config,
                frozen_set=frozen_set,
                real_outcomes=real_outcomes,
            )
            reasons.extend(verdict.reasons)
        eligible = validation.valid and verdict is not None and verdict.passed_screening
        status = STATUS_SCREENED if eligible else STATUS_REJECTED
        return ScreenOutcome(
            candidate=replace(candidate, status=status),
            validation=validation,
            sandbox_verdict=verdict,
            status=status,
            eligible=eligible,
            reasons=tuple(reasons),
        )


class EvolutionCandidatePool:
    """Admission requires a passing sandbox *and* an approved item-bank record."""

    def __init__(self) -> None:
        self._by_candidate: dict[str, EvolutionCandidate] = {}
        self._admission_log: list[Mapping[str, Any]] = []

    def admit(
        self, outcome: ScreenOutcome, item_record: ItemRecord
    ) -> EvolutionCandidate:
        if not isinstance(outcome, ScreenOutcome):
            raise CandidatePoolError("admission requires a ScreenOutcome")
        if not outcome.eligible:
            raise CandidatePoolError(
                "candidate is not eligible: "
                + (", ".join(outcome.reasons) or "unknown reason")
            )
        if not isinstance(item_record, ItemRecord):
            raise CandidatePoolError("admission requires a bank ItemRecord")
        if item_record.item_id != outcome.candidate.proposed_item_id:
            raise CandidatePoolError(
                "item record does not match the candidate's proposed item"
            )
        if item_record.review_status != "approved":
            raise CandidatePoolError(
                "candidate cannot bypass item-bank review; "
                f"current status is {item_record.review_status!r}"
            )
        if outcome.sandbox_verdict is None or not outcome.sandbox_verdict.passed_screening:
            raise CandidatePoolError(
                "candidate cannot bypass the isolated sandbox evaluation"
            )
        if outcome.sandbox_verdict.simulation.observed_writes != 0:
            raise CandidatePoolError("sandbox reported observed writes")

        candidate = replace(outcome.candidate, status=STATUS_IN_POOL)
        existing = self._by_candidate.get(candidate.candidate_id)
        if existing is not None:
            if existing.content_hash() != candidate.content_hash():
                raise CandidatePoolError(
                    f"candidate {candidate.candidate_id} already admitted with "
                    "different content"
                )
            return existing
        self._by_candidate[candidate.candidate_id] = candidate
        self._admission_log.append(
            MappingProxyType(
                {
                    "candidate_id": candidate.candidate_id,
                    "proposed_item_id": candidate.proposed_item_id,
                    "item_version": item_record.version,
                    "sandbox_result_fingerprint": (
                        outcome.sandbox_verdict.simulation.result_fingerprint
                        if outcome.sandbox_verdict
                        else None
                    ),
                    "passed_screening": (
                        outcome.sandbox_verdict.passed_screening
                        if outcome.sandbox_verdict
                        else False
                    ),
                    "promotion_ready": (
                        outcome.sandbox_verdict.promotion_ready
                        if outcome.sandbox_verdict
                        else False
                    ),
                }
            )
        )
        return candidate

    def get(self, candidate_id: str) -> EvolutionCandidate | None:
        return self._by_candidate.get(candidate_id)

    def list(self) -> tuple[EvolutionCandidate, ...]:
        return tuple(self._by_candidate.values())

    def admission_log(self) -> tuple[Mapping[str, Any], ...]:
        return tuple(self._admission_log)

    def snapshot(self) -> Mapping[str, Any]:
        return {
            "size": len(self._by_candidate),
            "candidates": [
                candidate.as_dict()
                for candidate in sorted(
                    self._by_candidate.values(), key=lambda item: item.candidate_id
                )
            ],
            "admissions": [_plain(entry) for entry in self._admission_log],
        }


__all__ = [
    "OPERATOR_NUMERIC",
    "OPERATOR_CONTEXT",
    "OPERATOR_DISTRACTOR",
    "OPERATOR_DIFFICULTY",
    "OPERATOR_DIAGNOSTIC",
    "EVOLUTION_OPERATORS",
    "GENERATOR_VERSION",
    "SCREENING_POLICY_VERSION",
    "SANDBOX_ID",
    "SIMULATION_LAB_ID",
    "STATUS_GENERATED",
    "STATUS_SCREENED",
    "STATUS_REJECTED",
    "STATUS_IN_POOL",
    "CONTEXT_TAGS",
    "PHASE_PRE",
    "PHASE_INTERVENTION",
    "PHASE_POST_NEAR",
    "PHASE_POST_FAR",
    "SIMULATION_PHASES",
    "ExerciseEvolutionError",
    "EvolutionValidationError",
    "OperatorNotApplicableError",
    "CandidatePoolError",
    "SimulationIsolationError",
    "SimulationConfigError",
    "VariantSpec",
    "EvolutionProvenance",
    "EvolutionCandidate",
    "EvolutionValidation",
    "apply_operator",
    "affected_kcs",
    "SimulationConfig",
    "SimulationHypothesis",
    "HypothesisSnapshot",
    "SimulationStep",
    "SimulationEventLog",
    "SimulationResult",
    "SimulationSession",
    "SimulationLab",
    "ScreeningPolicy",
    "SandboxVerdict",
    "EvolutionSandbox",
    "ScreenOutcome",
    "ExerciseEvolutionEngine",
    "EvolutionCandidatePool",
    "mulberry32",
    "fnv1a32",
    "round4",
    "quantize_micros",
    "js_round",
]
