"""Service boundaries, storage contracts and the Harness state machine.

Step 16 of ``TASKS.md`` implements spec section 13 (data model / storage and
service boundaries) and section 12 (Harness workflow state machine).  The module
is deliberately storage-agnostic: every service is first an explicit abstract
interface, and then offered with two interchangeable implementations:

* an in-memory implementation for tests and request-scoped work, and
* a JSON-file implementation for a single-machine, append-only local model.

The four service boundaries are:

1. :class:`EventStore` -- append-only ``learning_events`` with idempotency keys,
   optimistic concurrency (``expected_version``) and a hard
   ``observed`` / ``simulated`` storage-domain split (spec section 13.1 /
   22.1).  A simulated event can never enter an observed store.
2. :class:`ProfileStore` / :class:`BundleStore` -- the minimal ``students``
   profile (spec section 13.1) and a frozen, content-addressed version bundle
   (twin / school-progress / content versions) that a simulation can reference
   without being able to mutate live student state.
3. :class:`ContentLibraryService` -- a versioned, review-gated content index.
   Retrieval is fail-closed: only ``approved`` revisions are ever returned, and
   only summary metadata (opaque id, KCs, difficulty, review state) is exposed
   across the boundary.
4. :class:`EvaluationService` -- registration of immutable, content-addressed
   frozen evaluation sets and recording of evaluation runs.  It delegates the
   split-isolation rules to :mod:`aeh.evaluation` and therefore inherits the
   "simulation cannot self-prove a real effect" guard.

Cross-cutting primitives:

* :class:`WriteCoordinator` -- per-stream serialisation plus a
  ``run_once(stream, key, operation)`` idempotency memo so concurrent retries of
  the same logical write execute exactly once.
* :class:`HarnessStateMachine` -- the typed workflow of spec section 12.2,
  including the clarification loop, the diagnosis probe loop and the
  curriculum-gate / content-validation rework loops, plus the section 15.3
  degraded / failure branches.  Terminal states are fail-closed.

Only synthetic data is used by the tests; no external database, network or real
student data is involved.  The JSON-file implementations are a local model, not
a production database: there is no cross-process locking, encryption or
retention policy (spec section 13.2 recommends PostgreSQL / object storage /
Redis / a message system for production).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence

from .evaluation import (
    EvaluationProtocol,
    FrozenEvalSet,
    RealOutcome,
    SimulatedOutcome,
)

# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

Scalar = str | int | float | bool | None

#: Storage domains.  They are separate stores, never one store with a flag.
DOMAIN_OBSERVED = "observed"
DOMAIN_SIMULATED = "simulated"
STORAGE_DOMAINS: frozenset[str] = frozenset({DOMAIN_OBSERVED, DOMAIN_SIMULATED})

#: Event source types.  ``source_type`` must always match the store domain.
SOURCE_OBSERVED = "observed"
SOURCE_SIMULATED = "simulated"
EVENT_SOURCES: frozenset[str] = frozenset({SOURCE_OBSERVED, SOURCE_SIMULATED})

#: Version of the event envelope contract.
EVENT_SCHEMA_VERSION = "aeh.event.v1"

#: All events in this repository are synthetic.
PROVENANCE_SYNTHETIC = "synthetic"

#: Payloads are small scalar bags; raw media belongs in object storage.
MAX_PAYLOAD_CHARS = 4096

#: Event catalogue from spec section 22.1.
EVENT_USER_QUESTION_SUBMITTED = "USER_QUESTION_SUBMITTED"
EVENT_QUESTION_IMAGE_UPLOADED = "QUESTION_IMAGE_UPLOADED"
EVENT_STUDENT_TRACE_SUBMITTED = "STUDENT_TRACE_SUBMITTED"
EVENT_INDEPENDENT_ATTEMPT = "INDEPENDENT_ATTEMPT"
EVENT_HINT_REQUESTED = "HINT_REQUESTED"
EVENT_ANSWER_REVISED_AFTER_HINT = "ANSWER_REVISED_AFTER_HINT"
EVENT_SCHOOL_LESSON_REPORTED = "SCHOOL_LESSON_REPORTED"
EVENT_SCHOOL_PROGRESS_CONFIRMED = "SCHOOL_PROGRESS_CONFIRMED"
EVENT_TEACHER_FEEDBACK_SUBMITTED = "TEACHER_FEEDBACK_SUBMITTED"
EVENT_ASSESSMENT_GRADED = "ASSESSMENT_GRADED"
EVENT_HYPOTHESIS_CREATED = "HYPOTHESIS_CREATED"
EVENT_HYPOTHESIS_SPLIT = "HYPOTHESIS_SPLIT"
EVENT_HYPOTHESIS_MERGED = "HYPOTHESIS_MERGED"
EVENT_HYPOTHESIS_ARCHIVED = "HYPOTHESIS_ARCHIVED"
EVENT_DIAGNOSTIC_PROBE_SELECTED = "DIAGNOSTIC_PROBE_SELECTED"
EVENT_SIMULATION_STARTED = "SIMULATION_STARTED"
EVENT_SIMULATION_COMPLETED = "SIMULATION_COMPLETED"
EVENT_INTERVENTION_SELECTED = "INTERVENTION_SELECTED"
EVENT_INTERVENTION_DELIVERED = "INTERVENTION_DELIVERED"
EVENT_UNSEEN_TRANSFER_ATTEMPTED = "UNSEEN_TRANSFER_ATTEMPTED"
EVENT_REVIEW_DUE = "REVIEW_DUE"
EVENT_REVIEW_COMPLETED = "REVIEW_COMPLETED"
EVENT_MEMORY_MODEL_REFITTED = "MEMORY_MODEL_REFITTED"
EVENT_TWIN_RECALCULATED = "TWIN_RECALCULATED"
EVENT_CURRICULUM_GATE_REJECTED = "CURRICULUM_GATE_REJECTED"
EVENT_QUALITY_REVIEW_REQUESTED = "QUALITY_REVIEW_REQUESTED"
EVENT_EDU_PLUGIN_LOADED = "EDU_PLUGIN_LOADED"
EVENT_EDU_PLUGIN_UNLOADED = "EDU_PLUGIN_UNLOADED"
EVENT_EDU_PLUGIN_PERMISSION_DENIED = "EDU_PLUGIN_PERMISSION_DENIED"
EVENT_EDU_CAPABILITY_VERSION_CHANGED = "EDU_CAPABILITY_VERSION_CHANGED"
EVENT_EVOLUTION_PROPOSAL_CREATED = "EVOLUTION_PROPOSAL_CREATED"
EVENT_EVOLUTION_CANDIDATE_SANDBOXED = "EVOLUTION_CANDIDATE_SANDBOXED"
EVENT_EVOLUTION_OFFLINE_EVALUATED = "EVOLUTION_OFFLINE_EVALUATED"
EVENT_EVOLUTION_CANDIDATE_REJECTED = "EVOLUTION_CANDIDATE_REJECTED"
EVENT_EVOLUTION_HUMAN_APPROVED = "EVOLUTION_HUMAN_APPROVED"
EVENT_EVOLUTION_CANARY_STARTED = "EVOLUTION_CANARY_STARTED"
EVENT_EVOLUTION_PROMOTED = "EVOLUTION_PROMOTED"
EVENT_EVOLUTION_ROLLED_BACK = "EVOLUTION_ROLLED_BACK"
EVENT_EVOLUTION_DRIFT_ALERTED = "EVOLUTION_DRIFT_ALERTED"

#: Events that describe the isolated simulation world.  They may never be
#: written to an observed store.
SIMULATION_EVENT_TYPES: frozenset[str] = frozenset(
    {EVENT_SIMULATION_STARTED, EVENT_SIMULATION_COMPLETED}
)

EVENT_TYPES: frozenset[str] = frozenset(
    {
        EVENT_USER_QUESTION_SUBMITTED,
        EVENT_QUESTION_IMAGE_UPLOADED,
        EVENT_STUDENT_TRACE_SUBMITTED,
        EVENT_INDEPENDENT_ATTEMPT,
        EVENT_HINT_REQUESTED,
        EVENT_ANSWER_REVISED_AFTER_HINT,
        EVENT_SCHOOL_LESSON_REPORTED,
        EVENT_SCHOOL_PROGRESS_CONFIRMED,
        EVENT_TEACHER_FEEDBACK_SUBMITTED,
        EVENT_ASSESSMENT_GRADED,
        EVENT_HYPOTHESIS_CREATED,
        EVENT_HYPOTHESIS_SPLIT,
        EVENT_HYPOTHESIS_MERGED,
        EVENT_HYPOTHESIS_ARCHIVED,
        EVENT_DIAGNOSTIC_PROBE_SELECTED,
        EVENT_SIMULATION_STARTED,
        EVENT_SIMULATION_COMPLETED,
        EVENT_INTERVENTION_SELECTED,
        EVENT_INTERVENTION_DELIVERED,
        EVENT_UNSEEN_TRANSFER_ATTEMPTED,
        EVENT_REVIEW_DUE,
        EVENT_REVIEW_COMPLETED,
        EVENT_MEMORY_MODEL_REFITTED,
        EVENT_TWIN_RECALCULATED,
        EVENT_CURRICULUM_GATE_REJECTED,
        EVENT_QUALITY_REVIEW_REQUESTED,
        EVENT_EDU_PLUGIN_LOADED,
        EVENT_EDU_PLUGIN_UNLOADED,
        EVENT_EDU_PLUGIN_PERMISSION_DENIED,
        EVENT_EDU_CAPABILITY_VERSION_CHANGED,
        EVENT_EVOLUTION_PROPOSAL_CREATED,
        EVENT_EVOLUTION_CANDIDATE_SANDBOXED,
        EVENT_EVOLUTION_OFFLINE_EVALUATED,
        EVENT_EVOLUTION_CANDIDATE_REJECTED,
        EVENT_EVOLUTION_HUMAN_APPROVED,
        EVENT_EVOLUTION_CANARY_STARTED,
        EVENT_EVOLUTION_PROMOTED,
        EVENT_EVOLUTION_ROLLED_BACK,
        EVENT_EVOLUTION_DRIFT_ALERTED,
    }
)

#: Item review states for the content library.  Only ``approved`` is visible.
CONTENT_DRAFT = "draft"
CONTENT_APPROVED = "approved"
CONTENT_RETIRED = "retired"
CONTENT_REVIEW_STATES: frozenset[str] = frozenset(
    {CONTENT_DRAFT, CONTENT_APPROVED, CONTENT_RETIRED}
)

#: Student stages kept intentionally coarse (data minimisation).
STAGES: frozenset[str] = frozenset(
    {"primary", "junior_secondary", "senior_secondary", "vocational", "unknown"}
)

# ---------------------------------------------------------------------------
# Harness state machine constants (spec section 12.2)
# ---------------------------------------------------------------------------

STATE_INTAKE = "Intake"
STATE_EVIDENCE_PARSE = "EvidenceParse"
STATE_PROGRESS_CHECK = "ProgressCheck"
STATE_NEED_CLARIFICATION = "NeedClarification"
STATE_STATE_LOAD = "StateLoad"
STATE_DIAGNOSE = "Diagnose"
STATE_HYPOTHESIS_UPDATE = "HypothesisUpdate"
STATE_PROBE = "Probe"
STATE_AWAIT_STUDENT = "AwaitStudent"
STATE_EXERCISE_EVOLUTION = "ExerciseEvolution"
STATE_RECALL_SCHEDULE = "RecallSchedule"
STATE_PREVIEW_PLANNER = "PreviewPlanner"
STATE_SIMULATION_LAB = "SimulationLab"
STATE_CANDIDATE_RANKING = "CandidateRanking"
STATE_CURRICULUM_GATE = "CurriculumGate"
STATE_CONTENT_VALIDATION = "ContentValidation"
STATE_DELIVER = "Deliver"
STATE_ASSESS = "Assess"
STATE_STATE_COMMIT = "StateCommit"
STATE_REVIEW_RESCHEDULE = "ReviewReschedule"
STATE_COMPLETED = "Completed"
STATE_FAILED = "Failed"
STATE_ABORTED = "Aborted"

LEARNING_STATES: tuple[str, ...] = (
    STATE_INTAKE,
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_NEED_CLARIFICATION,
    STATE_STATE_LOAD,
    STATE_DIAGNOSE,
    STATE_HYPOTHESIS_UPDATE,
    STATE_PROBE,
    STATE_AWAIT_STUDENT,
    STATE_EXERCISE_EVOLUTION,
    STATE_RECALL_SCHEDULE,
    STATE_PREVIEW_PLANNER,
    STATE_SIMULATION_LAB,
    STATE_CANDIDATE_RANKING,
    STATE_CURRICULUM_GATE,
    STATE_CONTENT_VALIDATION,
    STATE_DELIVER,
    STATE_ASSESS,
    STATE_STATE_COMMIT,
    STATE_REVIEW_RESCHEDULE,
    STATE_COMPLETED,
    STATE_FAILED,
    STATE_ABORTED,
)

TERMINAL_STATES: frozenset[str] = frozenset(
    {STATE_COMPLETED, STATE_FAILED, STATE_ABORTED}
)

#: Normal (non-failure) transitions of the workflow diagram.  ``Failed`` and
#: ``Aborted`` are additionally reachable from every non-terminal state as
#: fail-closed exception exits.
TRANSITIONS: Mapping[str, frozenset[str]] = MappingProxyType(
    {
        STATE_INTAKE: frozenset({STATE_EVIDENCE_PARSE}),
        STATE_EVIDENCE_PARSE: frozenset({STATE_PROGRESS_CHECK}),
        STATE_PROGRESS_CHECK: frozenset(
            {STATE_NEED_CLARIFICATION, STATE_STATE_LOAD}
        ),
        STATE_NEED_CLARIFICATION: frozenset({STATE_PROGRESS_CHECK}),
        STATE_STATE_LOAD: frozenset(
            {STATE_DIAGNOSE, STATE_RECALL_SCHEDULE, STATE_PREVIEW_PLANNER}
        ),
        STATE_DIAGNOSE: frozenset({STATE_HYPOTHESIS_UPDATE}),
        STATE_HYPOTHESIS_UPDATE: frozenset(
            {STATE_PROBE, STATE_EXERCISE_EVOLUTION}
        ),
        STATE_PROBE: frozenset({STATE_AWAIT_STUDENT}),
        STATE_AWAIT_STUDENT: frozenset({STATE_EVIDENCE_PARSE, STATE_ASSESS}),
        STATE_EXERCISE_EVOLUTION: frozenset({STATE_SIMULATION_LAB}),
        STATE_RECALL_SCHEDULE: frozenset({STATE_EXERCISE_EVOLUTION}),
        STATE_PREVIEW_PLANNER: frozenset({STATE_EXERCISE_EVOLUTION}),
        STATE_SIMULATION_LAB: frozenset({STATE_CANDIDATE_RANKING}),
        STATE_CANDIDATE_RANKING: frozenset({STATE_CURRICULUM_GATE}),
        STATE_CURRICULUM_GATE: frozenset(
            {STATE_EXERCISE_EVOLUTION, STATE_CONTENT_VALIDATION}
        ),
        STATE_CONTENT_VALIDATION: frozenset(
            {STATE_EXERCISE_EVOLUTION, STATE_DELIVER}
        ),
        STATE_DELIVER: frozenset({STATE_AWAIT_STUDENT}),
        STATE_ASSESS: frozenset({STATE_STATE_COMMIT}),
        STATE_STATE_COMMIT: frozenset({STATE_REVIEW_RESCHEDULE}),
        STATE_REVIEW_RESCHEDULE: frozenset({STATE_COMPLETED}),
        STATE_COMPLETED: frozenset(),
        STATE_FAILED: frozenset(),
        STATE_ABORTED: frozenset(),
    }
)

#: Degraded / failure branch codes from spec section 15.3.
BRANCH_OCR_UNCERTAIN = "ocr_uncertain"
BRANCH_SYMBOL_VERIFIER_UNCERTAIN = "symbol_verifier_uncertain"
BRANCH_RAG_SOURCE_MISSING = "rag_source_missing"
BRANCH_SCHOOL_PROGRESS_UNCLEAR = "school_progress_unclear"
BRANCH_HYPOTHESES_ALL_MISMATCHED = "hypotheses_all_mismatched"
BRANCH_SIMULATION_TIMEOUT = "simulation_timeout"
BRANCH_SPARSE_MEMORY_DATA = "sparse_memory_data"
BRANCH_LOW_CONFIDENCE_STRATEGY = "low_confidence_strategy"
BRANCH_STUDENT_REFUSES_DIAGNOSIS = "student_refuses_diagnosis"
BRANCH_ABNORMAL_PRESSURE = "abnormal_pressure"
BRANCH_CURRICULUM_GATE_REJECTED = "curriculum_gate_rejected"
BRANCH_CONTENT_REJECTED = "content_rejected"


@dataclass(frozen=True)
class ExceptionBranch:
    """A named degraded / failure branch and where it routes."""

    code: str
    target_state: str  # empty string means "degrade in place, do not move"
    degraded_mode: str
    description: str


EXCEPTION_BRANCHES: Mapping[str, ExceptionBranch] = MappingProxyType(
    {
        BRANCH_OCR_UNCERTAIN: ExceptionBranch(
            BRANCH_OCR_UNCERTAIN,
            STATE_NEED_CLARIFICATION,
            "confirm_transcript",
            "OCR is unsure about a key formula; confirm the question text first",
        ),
        BRANCH_SYMBOL_VERIFIER_UNCERTAIN: ExceptionBranch(
            BRANCH_SYMBOL_VERIFIER_UNCERTAIN,
            STATE_NEED_CLARIFICATION,
            "human_or_alternate_verification",
            "symbolic verifier cannot decide; mark uncertain and re-verify",
        ),
        BRANCH_RAG_SOURCE_MISSING: ExceptionBranch(
            BRANCH_RAG_SOURCE_MISSING,
            "",
            "unlicensed_source_flagged",
            "no authorised textbook source; answer generically and flag it",
        ),
        BRANCH_SCHOOL_PROGRESS_UNCLEAR: ExceptionBranch(
            BRANCH_SCHOOL_PROGRESS_UNCLEAR,
            STATE_NEED_CLARIFICATION,
            "ask_current_chapter",
            "school progress is unclear; only use confirmed content or ask",
        ),
        BRANCH_HYPOTHESES_ALL_MISMATCHED: ExceptionBranch(
            BRANCH_HYPOTHESES_ALL_MISMATCHED,
            STATE_PROBE,
            "no_root_cause_inference",
            "all virtual students mismatch; probe instead of inferring a cause",
        ),
        BRANCH_SIMULATION_TIMEOUT: ExceptionBranch(
            BRANCH_SIMULATION_TIMEOUT,
            STATE_CANDIDATE_RANKING,
            "rule_and_knowledge_tracing_baseline",
            "simulation timed out or exceeded cost; fall back to the baseline",
        ),
        BRANCH_SPARSE_MEMORY_DATA: ExceptionBranch(
            BRANCH_SPARSE_MEMORY_DATA,
            STATE_RECALL_SCHEDULE,
            "population_prior_conservative_review",
            "memory data is sparse; use the prior and a conservative review",
        ),
        BRANCH_LOW_CONFIDENCE_STRATEGY: ExceptionBranch(
            BRANCH_LOW_CONFIDENCE_STRATEGY,
            "",
            "low_risk_short_feedback",
            "strategy confidence is low; choose a low-risk explainable action",
        ),
        BRANCH_STUDENT_REFUSES_DIAGNOSIS: ExceptionBranch(
            BRANCH_STUDENT_REFUSES_DIAGNOSIS,
            STATE_ABORTED,
            "answer_directly",
            "student declined diagnosis; honour the choice and answer directly",
        ),
        BRANCH_ABNORMAL_PRESSURE: ExceptionBranch(
            BRANCH_ABNORMAL_PRESSURE,
            "",
            "reduce_load_suggest_break",
            "abnormal answering pressure; reduce load and suggest a break",
        ),
        BRANCH_CURRICULUM_GATE_REJECTED: ExceptionBranch(
            BRANCH_CURRICULUM_GATE_REJECTED,
            STATE_EXERCISE_EVOLUTION,
            "rework_candidate",
            "curriculum gate rejected the candidate; rework it",
        ),
        BRANCH_CONTENT_REJECTED: ExceptionBranch(
            BRANCH_CONTENT_REJECTED,
            STATE_EXERCISE_EVOLUTION,
            "rework_candidate",
            "content validation rejected the item; rework it",
        ),
    }
)

#: Default number of gate/content rework loops before failing closed.
DEFAULT_MAX_REJECTIONS = 3


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ServiceError(Exception):
    """Base class for Step 16 service errors."""


class ValidationError(ServiceError, ValueError):
    """A value crossing a service boundary is malformed."""


class NotFoundError(ServiceError, LookupError):
    """A requested record does not exist."""


class ConflictError(ServiceError):
    """A uniqueness / immutability rule was violated."""


class OptimisticConcurrencyError(ConflictError):
    """``expected_version`` did not match the stored version."""


class IdempotencyConflictError(ConflictError):
    """An idempotency key was reused for a different payload."""


class IsolationViolationError(ServiceError, ValueError):
    """Observed / simulated worlds were crossed."""


class IntegrityError(ServiceError):
    """A persisted record failed its integrity check."""


class StateMachineError(ServiceError):
    """The harness state machine was used incorrectly."""


class InvalidTransitionError(StateMachineError):
    """A transition is not part of the workflow."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def utcnow() -> datetime:
    """Return the current timezone-aware UTC time."""

    return datetime.now(timezone.utc)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _jsonable(value[key])
            for key in sorted(value, key=lambda item: str(item))
        }
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def canonical_json(value: Any) -> str:
    """Deterministic JSON used for hashing and idempotency comparisons."""

    return json.dumps(
        _jsonable(value), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


def content_digest(value: Any) -> str:
    """SHA-256 hex digest of the canonical JSON form of ``value``."""

    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


_WS = " \t\r\n"


def _identifier(value: Any, field_name: str, *, max_length: int = 128) -> str:
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{field_name} must be a non-empty string")
    if len(value) > max_length:
        raise ValidationError(f"{field_name} is too long")
    if any(character.isspace() for character in value):
        raise ValidationError(f"{field_name} must not contain whitespace")
    return value


def _aware(value: Any, field_name: str) -> datetime:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValidationError(f"{field_name} is not an ISO-8601 timestamp") from exc
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValidationError(f"{field_name} must be timezone-aware")
    if value.utcoffset() is None:
        raise ValidationError(f"{field_name} must have a UTC offset")
    return value


def _scalar(value: Any, field_name: str) -> Scalar:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if abs(value) > 2**53:
            raise ValidationError(f"{field_name} integer is out of range")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValidationError(f"{field_name} must be finite")
        return value
    if isinstance(value, str):
        if len(value) > 2000:
            raise ValidationError(f"{field_name} string is too long")
        return value
    raise ValidationError(f"{field_name} must be a JSON scalar")


def _payload(value: Any) -> Mapping[str, Scalar]:
    if value is None:
        return MappingProxyType({})
    if not isinstance(value, Mapping):
        raise ValidationError("payload must be a mapping of scalars")
    frozen: dict[str, Scalar] = {}
    for key, item in value.items():
        _identifier(key, "payload key", max_length=64)
        frozen[key] = _scalar(item, f"payload[{key}]")
    result = MappingProxyType(frozen)
    if len(canonical_json(result)) > MAX_PAYLOAD_CHARS:
        raise ValidationError("payload exceeds the scalar size budget")
    return result


def _domain(value: Any) -> str:
    if value not in STORAGE_DOMAINS:
        raise ValidationError(
            f"unknown storage domain {value!r}; expected one of {sorted(STORAGE_DOMAINS)}"
        )
    return str(value)


def _derive_event_id(stream_id: str, idempotency_key: str) -> str:
    seed = f"{stream_id}\x1f{idempotency_key}".encode("utf-8")
    return "ev_" + hashlib.sha256(seed).hexdigest()[:20]


def _derive_run_id(dataset_id: str, idempotency_key: str) -> str:
    seed = f"{dataset_id}\x1f{idempotency_key}".encode("utf-8")
    return "evalrun_" + hashlib.sha256(seed).hexdigest()[:20]


def _atomic_write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(_jsonable(data), handle, ensure_ascii=False, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        return default
    return json.loads(text)


# ---------------------------------------------------------------------------
# Write coordination
# ---------------------------------------------------------------------------


class WriteCoordinator:
    """Serialize writes per stream and memoise idempotent operations.

    ``run_once`` is the primitive services use for keyed writes: the first
    caller executes ``operation`` inside the stream lock and records its result;
    concurrent or later callers with the same key receive the memoised result
    and a ``deduplicated=True`` flag.
    """

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}
        self._memo: dict[tuple[str, str], Any] = {}

    def _lock_for(self, stream_id: str) -> threading.RLock:
        with self._guard:
            lock = self._locks.get(stream_id)
            if lock is None:
                lock = threading.RLock()
                self._locks[stream_id] = lock
            return lock

    @contextmanager
    def write_lock(self, stream_id: str) -> Iterator[None]:
        """Serialise all writes that share a stream id."""

        lock = self._lock_for(stream_id)
        lock.acquire()
        try:
            yield
        finally:
            lock.release()

    def recall(self, stream_id: str, idempotency_key: str) -> tuple[bool, Any]:
        with self._guard:
            key = (stream_id, idempotency_key)
            if key in self._memo:
                return True, self._memo[key]
            return False, None

    def remember(self, stream_id: str, idempotency_key: str, result: Any) -> None:
        with self._guard:
            self._memo[(stream_id, idempotency_key)] = result

    def run_once(
        self, stream_id: str, idempotency_key: str, operation: Callable[[], Any]
    ) -> tuple[Any, bool]:
        """Run ``operation`` at most once per ``(stream_id, idempotency_key)``."""

        with self.write_lock(stream_id):
            found, value = self.recall(stream_id, idempotency_key)
            if found:
                return value, True
            value = operation()
            self.remember(stream_id, idempotency_key, value)
            return value, False

    def stats(self) -> Mapping[str, int]:
        with self._guard:
            return {"locks": len(self._locks), "memo": len(self._memo)}


# ---------------------------------------------------------------------------
# Event store (spec section 13.1 learning_events, 22.1 envelope)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EventDraft:
    """An event before the store assigns its sequence number."""

    stream_id: str
    event_type: str
    source_type: str
    occurred_at: datetime
    idempotency_key: str
    session_id: str = ""
    provenance: str = PROVENANCE_SYNTHETIC
    payload: Mapping[str, Scalar] = field(default_factory=dict)
    event_id: str = ""
    schema_version: str = EVENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(self, "stream_id", _identifier(self.stream_id, "stream_id"))
        if self.event_type not in EVENT_TYPES:
            raise ValidationError(f"unknown event_type {self.event_type!r}")
        if self.source_type not in EVENT_SOURCES:
            raise ValidationError(f"unknown source_type {self.source_type!r}")
        object.__setattr__(
            self, "occurred_at", _aware(self.occurred_at, "occurred_at")
        )
        object.__setattr__(
            self, "idempotency_key", _identifier(self.idempotency_key, "idempotency_key")
        )
        if self.session_id:
            object.__setattr__(
                self, "session_id", _identifier(self.session_id, "session_id")
            )
        object.__setattr__(
            self, "provenance", _identifier(self.provenance, "provenance", max_length=64)
        )
        object.__setattr__(self, "payload", _payload(self.payload))
        if self.event_id:
            object.__setattr__(self, "event_id", _identifier(self.event_id, "event_id"))
        if self.schema_version != EVENT_SCHEMA_VERSION:
            raise ValidationError(
                f"unsupported schema_version {self.schema_version!r}"
            )


@dataclass(frozen=True)
class LearningEvent:
    """An immutable, sequenced event in one storage domain."""

    event_id: str
    stream_id: str
    event_type: str
    source_type: str
    occurred_at: datetime
    sequence: int
    idempotency_key: str
    session_id: str = ""
    provenance: str = PROVENANCE_SYNTHETIC
    payload: Mapping[str, Scalar] = field(default_factory=dict)
    schema_version: str = EVENT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        object.__setattr__(self, "event_id", _identifier(self.event_id, "event_id"))
        object.__setattr__(self, "stream_id", _identifier(self.stream_id, "stream_id"))
        if self.event_type not in EVENT_TYPES:
            raise ValidationError(f"unknown event_type {self.event_type!r}")
        if self.source_type not in EVENT_SOURCES:
            raise ValidationError(f"unknown source_type {self.source_type!r}")
        object.__setattr__(
            self, "occurred_at", _aware(self.occurred_at, "occurred_at")
        )
        if not isinstance(self.sequence, int) or isinstance(self.sequence, bool):
            raise ValidationError("sequence must be an integer")
        if self.sequence < 1:
            raise ValidationError("sequence must be >= 1")
        object.__setattr__(
            self, "idempotency_key", _identifier(self.idempotency_key, "idempotency_key")
        )
        if self.session_id:
            object.__setattr__(
                self, "session_id", _identifier(self.session_id, "session_id")
            )
        object.__setattr__(
            self, "provenance", _identifier(self.provenance, "provenance", max_length=64)
        )
        object.__setattr__(self, "payload", _payload(self.payload))

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "stream_id": self.stream_id,
            "event_type": self.event_type,
            "source_type": self.source_type,
            "occurred_at": self.occurred_at.isoformat(),
            "sequence": self.sequence,
            "idempotency_key": self.idempotency_key,
            "session_id": self.session_id,
            "provenance": self.provenance,
            "payload": dict(self.payload),
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "LearningEvent":
        if not isinstance(data, Mapping):
            raise IntegrityError("event record must be a mapping")
        return cls(
            event_id=data["event_id"],
            stream_id=data["stream_id"],
            event_type=data["event_type"],
            source_type=data["source_type"],
            occurred_at=data["occurred_at"],
            sequence=data["sequence"],
            idempotency_key=data["idempotency_key"],
            session_id=data.get("session_id", ""),
            provenance=data.get("provenance", PROVENANCE_SYNTHETIC),
            payload=data.get("payload") or {},
            schema_version=data.get("schema_version", EVENT_SCHEMA_VERSION),
        )


@dataclass(frozen=True)
class AppendResult:
    """The outcome of an append, including idempotent deduplication."""

    event: LearningEvent
    deduplicated: bool
    stream_version: int


class EventStore(ABC):
    """Append-only learning-event store with a fixed storage domain."""

    domain: str

    @abstractmethod
    def append(
        self,
        draft: EventDraft,
        *,
        expected_version: int | None = None,
    ) -> AppendResult:
        """Append ``draft``; ``expected_version`` enables optimistic concurrency."""

    @abstractmethod
    def get(self, event_id: str) -> LearningEvent:
        """Return an event by id, or raise :class:`NotFoundError`."""

    @abstractmethod
    def list_events(
        self, stream_id: str, *, after_sequence: int = 0, limit: int | None = None
    ) -> tuple[LearningEvent, ...]:
        """Return a stream in sequence order."""

    @abstractmethod
    def stream_version(self, stream_id: str) -> int:
        """Return the number of events in a stream."""

    @abstractmethod
    def find_by_idempotency(
        self, stream_id: str, idempotency_key: str
    ) -> LearningEvent | None:
        """Return the event previously stored for a key, if any."""


class _EventStoreBase(EventStore):
    def __init__(self, domain: str, coordinator: WriteCoordinator | None = None) -> None:
        self.domain = _domain(domain)
        self._coordinator = coordinator or WriteCoordinator()
        self._events: dict[str, list[LearningEvent]] = {}
        self._by_id: dict[str, LearningEvent] = {}
        self._idempotency: dict[tuple[str, str], str] = {}
        self._load_state()

    # -- hooks for subclasses ---------------------------------------------

    def _load_state(self) -> None:
        """Load persisted state into the indexes."""

    def _persist(self, event: LearningEvent) -> None:
        """Durably append one event."""

    # -- index helpers -----------------------------------------------------

    def _index(self, event: LearningEvent) -> None:
        stream = self._events.setdefault(event.stream_id, [])
        if event.sequence != len(stream) + 1:
            raise IntegrityError(
                f"event {event.event_id!r} has sequence {event.sequence} but the "
                f"stream expected {len(stream) + 1}"
            )
        if event.event_id in self._by_id:
            raise IntegrityError(f"duplicate event id {event.event_id!r}")
        key = (event.stream_id, event.idempotency_key)
        if key in self._idempotency:
            raise IntegrityError(
                f"duplicate idempotency key {event.idempotency_key!r} in stream"
            )
        stream.append(event)
        self._by_id[event.event_id] = event
        self._idempotency[key] = event.event_id

    def _assert_domain(self, draft: EventDraft) -> None:
        if draft.source_type != self.domain:
            raise IsolationViolationError(
                f"cannot write a {draft.source_type!r} event into the "
                f"{self.domain!r} store"
            )
        if self.domain == DOMAIN_OBSERVED and draft.event_type in SIMULATION_EVENT_TYPES:
            raise IsolationViolationError(
                f"simulation event {draft.event_type!r} cannot enter the observed store"
            )

    @staticmethod
    def _assert_same(existing: LearningEvent, draft: EventDraft) -> None:
        left = {
            "event_type": existing.event_type,
            "source_type": existing.source_type,
            "occurred_at": existing.occurred_at.isoformat(),
            "session_id": existing.session_id,
            "provenance": existing.provenance,
            "payload": dict(existing.payload),
        }
        right = {
            "event_type": draft.event_type,
            "source_type": draft.source_type,
            "occurred_at": draft.occurred_at.isoformat(),
            "session_id": draft.session_id,
            "provenance": draft.provenance,
            "payload": dict(draft.payload),
        }
        if canonical_json(left) != canonical_json(right):
            raise IdempotencyConflictError(
                "the idempotency key was already used for a different event"
            )

    # -- interface ---------------------------------------------------------

    def append(
        self, draft: EventDraft, *, expected_version: int | None = None
    ) -> AppendResult:
        if not isinstance(draft, EventDraft):
            raise ValidationError("append requires an EventDraft")
        self._assert_domain(draft)
        with self._coordinator.write_lock(draft.stream_id):
            stream = self._events.setdefault(draft.stream_id, [])
            current = len(stream)
            existing_id = self._idempotency.get(
                (draft.stream_id, draft.idempotency_key)
            )
            if existing_id is not None:
                existing = self._by_id[existing_id]
                self._assert_same(existing, draft)
                return AppendResult(existing, True, current)
            if expected_version is not None and expected_version != current:
                raise OptimisticConcurrencyError(
                    f"stream {draft.stream_id!r} is at version {current}, "
                    f"expected {expected_version}"
                )
            event = LearningEvent(
                event_id=draft.event_id
                or _derive_event_id(draft.stream_id, draft.idempotency_key),
                stream_id=draft.stream_id,
                event_type=draft.event_type,
                source_type=draft.source_type,
                occurred_at=draft.occurred_at,
                sequence=current + 1,
                idempotency_key=draft.idempotency_key,
                session_id=draft.session_id,
                provenance=draft.provenance,
                payload=draft.payload,
                schema_version=draft.schema_version,
            )
            self._persist(event)
            self._index(event)
            return AppendResult(event, False, current + 1)

    def get(self, event_id: str) -> LearningEvent:
        try:
            return self._by_id[event_id]
        except KeyError as exc:
            raise NotFoundError(f"no event {event_id!r}") from exc

    def list_events(
        self, stream_id: str, *, after_sequence: int = 0, limit: int | None = None
    ) -> tuple[LearningEvent, ...]:
        events = [
            event
            for event in self._events.get(stream_id, [])
            if event.sequence > after_sequence
        ]
        if limit is not None:
            if limit < 0:
                raise ValidationError("limit must be >= 0")
            events = events[:limit]
        return tuple(events)

    def stream_version(self, stream_id: str) -> int:
        return len(self._events.get(stream_id, []))

    def find_by_idempotency(
        self, stream_id: str, idempotency_key: str
    ) -> LearningEvent | None:
        event_id = self._idempotency.get((stream_id, idempotency_key))
        return None if event_id is None else self._by_id[event_id]


class InMemoryEventStore(_EventStoreBase):
    """Volatile event store for tests and request-scoped work."""


class FileEventStore(_EventStoreBase):
    """Append-only JSONL event store rooted in a local synthetic directory."""

    def __init__(
        self,
        root: str,
        domain: str,
        *,
        coordinator: WriteCoordinator | None = None,
    ) -> None:
        self._root = os.path.abspath(root)
        self._path = os.path.join(self._root, f"events.{domain}.jsonl")
        super().__init__(domain, coordinator)

    def _load_state(self) -> None:
        os.makedirs(self._root, exist_ok=True)
        if not os.path.exists(self._path):
            return
        with open(self._path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                digest = record.pop("digest", None)
                if digest != content_digest(record):
                    raise IntegrityError("event log integrity check failed")
                event = LearningEvent.from_dict(record)
                if event.source_type != self.domain:
                    raise IntegrityError(
                        "event log contains a record from another storage domain"
                    )
                self._index(event)

    def _persist(self, event: LearningEvent) -> None:
        record = event.as_dict()
        record["digest"] = content_digest(event.as_dict())
        line = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with open(self._path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())


# ---------------------------------------------------------------------------
# Profile and bundle stores (spec section 13.1 students / frozen bundles)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StudentProfile:
    """Minimal identity record: no names, contacts or raw answers."""

    student_ref: str
    stage: str = "unknown"
    guardian_consent: bool = False
    settings: Mapping[str, Scalar] = field(default_factory=dict)
    version: int = 1

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "student_ref", _identifier(self.student_ref, "student_ref")
        )
        if self.stage not in STAGES:
            raise ValidationError(f"unknown stage {self.stage!r}")
        if not isinstance(self.guardian_consent, bool):
            raise ValidationError("guardian_consent must be a boolean")
        object.__setattr__(self, "settings", _payload(self.settings))
        if not isinstance(self.version, int) or isinstance(self.version, bool):
            raise ValidationError("version must be an integer")
        if self.version < 1:
            raise ValidationError("version must be >= 1")

    def as_dict(self) -> dict[str, Any]:
        return {
            "student_ref": self.student_ref,
            "stage": self.stage,
            "guardian_consent": self.guardian_consent,
            "settings": dict(self.settings),
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "StudentProfile":
        return cls(
            student_ref=data["student_ref"],
            stage=data.get("stage", "unknown"),
            guardian_consent=bool(data.get("guardian_consent", False)),
            settings=data.get("settings") or {},
            version=data.get("version", 1),
        )


class ProfileStore(ABC):
    """Versioned student profile store with optimistic concurrency."""

    @abstractmethod
    def create(self, profile: StudentProfile) -> StudentProfile:
        """Insert a new profile; a duplicate ``student_ref`` conflicts."""

    @abstractmethod
    def get(self, student_ref: str) -> StudentProfile:
        """Return the current profile or raise :class:`NotFoundError`."""

    @abstractmethod
    def update(
        self,
        student_ref: str,
        *,
        expected_version: int,
        settings: Mapping[str, Scalar] | None = None,
        guardian_consent: bool | None = None,
    ) -> StudentProfile:
        """Update a profile; the version must match ``expected_version``."""

    @abstractmethod
    def list_all(self) -> tuple[StudentProfile, ...]:
        """Return all profiles (pseudonymous refs only)."""


class _ProfileStoreBase(ProfileStore):
    def __init__(self) -> None:
        self._profiles: dict[str, StudentProfile] = {}
        self._load_state()

    def _load_state(self) -> None:
        """Load persisted profiles."""

    def _persist(self) -> None:
        """Persist all profiles."""

    def create(self, profile: StudentProfile) -> StudentProfile:
        if not isinstance(profile, StudentProfile):
            raise ValidationError("create requires a StudentProfile")
        if profile.student_ref in self._profiles:
            raise ConflictError(f"profile {profile.student_ref!r} already exists")
        self._profiles[profile.student_ref] = profile
        self._persist()
        return profile

    def get(self, student_ref: str) -> StudentProfile:
        try:
            return self._profiles[student_ref]
        except KeyError as exc:
            raise NotFoundError(f"no profile {student_ref!r}") from exc

    def update(
        self,
        student_ref: str,
        *,
        expected_version: int,
        settings: Mapping[str, Scalar] | None = None,
        guardian_consent: bool | None = None,
    ) -> StudentProfile:
        current = self.get(student_ref)
        if expected_version != current.version:
            raise OptimisticConcurrencyError(
                f"profile {student_ref!r} is at version {current.version}, "
                f"expected {expected_version}"
            )
        merged: dict[str, Scalar] = dict(current.settings)
        if settings is not None:
            merged.update(dict(_payload(settings)))
        updated = StudentProfile(
            student_ref=current.student_ref,
            stage=current.stage,
            guardian_consent=(
                current.guardian_consent if guardian_consent is None else guardian_consent
            ),
            settings=merged,
            version=current.version + 1,
        )
        self._profiles[student_ref] = updated
        self._persist()
        return updated

    def list_all(self) -> tuple[StudentProfile, ...]:
        return tuple(self._profiles[key] for key in sorted(self._profiles))


class InMemoryProfileStore(_ProfileStoreBase):
    """Volatile profile store."""


class FileProfileStore(_ProfileStoreBase):
    """JSON-file profile store."""

    def __init__(self, root: str) -> None:
        self._path = os.path.join(os.path.abspath(root), "profiles.json")
        super().__init__()

    def _load_state(self) -> None:
        data = _read_json(self._path, {})
        if not isinstance(data, Mapping):
            raise IntegrityError("profiles file must contain an object")
        for key, value in data.items():
            profile = StudentProfile.from_dict(value)
            if profile.student_ref != key:
                raise IntegrityError("profile key does not match student_ref")
            self._profiles[profile.student_ref] = profile

    def _persist(self) -> None:
        _atomic_write_json(
            self._path, {key: value.as_dict() for key, value in self._profiles.items()}
        )


@dataclass(frozen=True)
class ProfileBundle:
    """A frozen, content-addressed bundle of the versions a run depends on.

    Simulations and evaluations reference an immutable bundle so that a live
    student session cannot be silently reinterpreted under newer state.
    """

    student_ref: str
    twin_version: int
    school_progress_version: int
    content_version: int
    created_at: datetime
    bundle_id: str = ""
    digest: str = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "student_ref", _identifier(self.student_ref, "student_ref")
        )
        for name in ("twin_version", "school_progress_version", "content_version"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValidationError(f"{name} must be a non-negative integer")
        object.__setattr__(self, "created_at", _aware(self.created_at, "created_at"))
        if not self.bundle_id:
            seed = (
                f"{self.student_ref}\x1f{self.twin_version}\x1f"
                f"{self.school_progress_version}\x1f{self.content_version}\x1f"
                f"{self.created_at.isoformat()}"
            )
            object.__setattr__(
                self,
                "bundle_id",
                "bundle_" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:20],
            )
        else:
            object.__setattr__(
                self, "bundle_id", _identifier(self.bundle_id, "bundle_id")
            )
        object.__setattr__(self, "digest", content_digest(self._digest_payload()))

    def _digest_payload(self) -> dict[str, Any]:
        return {
            "student_ref": self.student_ref,
            "twin_version": self.twin_version,
            "school_progress_version": self.school_progress_version,
            "content_version": self.content_version,
            "created_at": self.created_at.isoformat(),
        }

    def as_dict(self) -> dict[str, Any]:
        data = self._digest_payload()
        data["bundle_id"] = self.bundle_id
        data["digest"] = self.digest
        return data

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ProfileBundle":
        bundle = cls(
            student_ref=data["student_ref"],
            twin_version=data["twin_version"],
            school_progress_version=data["school_progress_version"],
            content_version=data["content_version"],
            created_at=data["created_at"],
            bundle_id=data.get("bundle_id", ""),
        )
        stored = data.get("digest")
        if stored is not None and stored != bundle.digest:
            raise IntegrityError("bundle digest mismatch")
        return bundle


class BundleStore(ABC):
    """Immutable bundle store; content-addressed bundles deduplicate."""

    @abstractmethod
    def put(self, bundle: ProfileBundle) -> ProfileBundle:
        """Store a bundle, returning the stored value (idempotent by digest)."""

    @abstractmethod
    def get(self, bundle_id: str) -> ProfileBundle:
        """Return a bundle or raise :class:`NotFoundError`."""

    @abstractmethod
    def list_for_student(self, student_ref: str) -> tuple[ProfileBundle, ...]:
        """Return a student's bundles in deterministic order."""


class _BundleStoreBase(BundleStore):
    def __init__(self) -> None:
        self._bundles: dict[str, ProfileBundle] = {}
        self._load_state()

    def _load_state(self) -> None:
        """Load persisted bundles."""

    def _persist(self) -> None:
        """Persist all bundles."""

    def put(self, bundle: ProfileBundle) -> ProfileBundle:
        if not isinstance(bundle, ProfileBundle):
            raise ValidationError("put requires a ProfileBundle")
        existing = self._bundles.get(bundle.bundle_id)
        if existing is not None:
            if existing.digest != bundle.digest:
                raise ConflictError(
                    f"bundle id {bundle.bundle_id!r} already exists with a "
                    "different digest"
                )
            return existing
        self._bundles[bundle.bundle_id] = bundle
        self._persist()
        return bundle

    def get(self, bundle_id: str) -> ProfileBundle:
        try:
            return self._bundles[bundle_id]
        except KeyError as exc:
            raise NotFoundError(f"no bundle {bundle_id!r}") from exc

    def list_for_student(self, student_ref: str) -> tuple[ProfileBundle, ...]:
        matches = [
            bundle
            for bundle in self._bundles.values()
            if bundle.student_ref == student_ref
        ]
        return tuple(sorted(matches, key=lambda item: (item.created_at, item.bundle_id)))


class InMemoryBundleStore(_BundleStoreBase):
    """Volatile bundle store."""


class FileBundleStore(_BundleStoreBase):
    """JSON-file bundle store."""

    def __init__(self, root: str) -> None:
        self._path = os.path.join(os.path.abspath(root), "bundles.json")
        super().__init__()

    def _load_state(self) -> None:
        data = _read_json(self._path, {})
        if not isinstance(data, Mapping):
            raise IntegrityError("bundles file must contain an object")
        for key, value in data.items():
            bundle = ProfileBundle.from_dict(value)
            if bundle.bundle_id != key:
                raise IntegrityError("bundle key does not match bundle_id")
            self._bundles[bundle.bundle_id] = bundle

    def _persist(self) -> None:
        _atomic_write_json(
            self._path, {key: value.as_dict() for key, value in self._bundles.items()}
        )


# ---------------------------------------------------------------------------
# Content library (versioned, review-gated summaries)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContentRecord:
    """A versioned content summary; never carries solution or question text."""

    content_id: str
    version: int
    kc_ids: tuple[str, ...]
    difficulty: int
    review_state: str
    digest: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "content_id", _identifier(self.content_id, "content_id")
        )
        if not isinstance(self.version, int) or isinstance(self.version, bool):
            raise ValidationError("version must be an integer")
        if self.version < 1:
            raise ValidationError("version must be >= 1")
        object.__setattr__(self, "kc_ids", _kc_tuple(self.kc_ids))
        if not isinstance(self.difficulty, int) or isinstance(self.difficulty, bool):
            raise ValidationError("difficulty must be an integer")
        if not 1 <= self.difficulty <= 5:
            raise ValidationError("difficulty must be in 1..5")
        if self.review_state not in CONTENT_REVIEW_STATES:
            raise ValidationError(f"unknown review_state {self.review_state!r}")
        computed = content_digest(
            {
                "content_id": self.content_id,
                "version": self.version,
                "kc_ids": list(self.kc_ids),
                "difficulty": self.difficulty,
                "review_state": self.review_state,
            }
        )
        if self.digest and self.digest != computed:
            raise IntegrityError("content record digest mismatch")
        object.__setattr__(self, "digest", computed)

    def as_dict(self) -> dict[str, Any]:
        return {
            "content_id": self.content_id,
            "version": self.version,
            "kc_ids": list(self.kc_ids),
            "difficulty": self.difficulty,
            "review_state": self.review_state,
            "digest": self.digest,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ContentRecord":
        return cls(
            content_id=data["content_id"],
            version=data["version"],
            kc_ids=tuple(data.get("kc_ids") or ()),
            difficulty=data["difficulty"],
            review_state=data["review_state"],
            digest=data.get("digest", ""),
        )


def _kc_tuple(values: Iterable[str]) -> tuple[str, ...]:
    if isinstance(values, str):
        raise ValidationError("kc_ids must be a sequence, not a bare string")
    result: list[str] = []
    for value in values:
        identifier = _identifier(value, "kc_id", max_length=80)
        if identifier not in result:
            result.append(identifier)
    if not result:
        raise ValidationError("a content record needs at least one kc_id")
    return tuple(result)


class ContentLibraryService(ABC):
    """Versioned content index.  Retrieval only ever returns approved items."""

    @abstractmethod
    def put(
        self,
        content_id: str,
        *,
        kc_ids: Sequence[str],
        difficulty: int,
        review_state: str,
        expected_version: int,
    ) -> ContentRecord:
        """Write the next version of a content record."""

    @abstractmethod
    def get(self, content_id: str, *, version: int | None = None) -> ContentRecord:
        """Return one version (default: current) or raise :class:`NotFoundError`."""

    @abstractmethod
    def current_version(self, content_id: str) -> int:
        """Return the current version, or 0 when the id is unknown."""

    @abstractmethod
    def retrieve(
        self,
        kc_id: str,
        *,
        difficulty: int | None = None,
        limit: int = 10,
    ) -> tuple[ContentRecord, ...]:
        """Return approved current records for a KC, fail-closed on none."""


class _ContentLibraryBase(ContentLibraryService):
    def __init__(self) -> None:
        self._records: dict[str, list[ContentRecord]] = {}
        self._load_state()

    def _load_state(self) -> None:
        """Load persisted content."""

    def _persist(self) -> None:
        """Persist all content."""

    def put(
        self,
        content_id: str,
        *,
        kc_ids: Sequence[str],
        difficulty: int,
        review_state: str,
        expected_version: int,
    ) -> ContentRecord:
        _identifier(content_id, "content_id")
        if not isinstance(expected_version, int) or isinstance(expected_version, bool):
            raise ValidationError("expected_version must be an integer")
        if expected_version < 0:
            raise ValidationError("expected_version must be >= 0")
        versions = self._records.get(content_id, [])
        current = versions[-1] if versions else None
        current_version = current.version if current else 0

        def same_as_current() -> bool:
            return current is not None and (
                current.kc_ids == tuple(kc_ids)
                and current.difficulty == difficulty
                and current.review_state == review_state
            )

        if expected_version != current_version:
            # A replay of the write that produced the current version is a
            # no-op; anything else is a stale-writer conflict.
            if expected_version == current_version - 1 and same_as_current():
                return current  # type: ignore[return-value]
            raise OptimisticConcurrencyError(
                f"content {content_id!r} is at version {current_version}, "
                f"expected {expected_version}"
            )
        if same_as_current():
            return current  # type: ignore[return-value]
        candidate = ContentRecord(
            content_id=content_id,
            version=current_version + 1,
            kc_ids=tuple(kc_ids),
            difficulty=difficulty,
            review_state=review_state,
        )
        self._records.setdefault(content_id, []).append(candidate)
        self._persist()
        return candidate

    def get(self, content_id: str, *, version: int | None = None) -> ContentRecord:
        versions = self._records.get(content_id)
        if not versions:
            raise NotFoundError(f"no content {content_id!r}")
        if version is None:
            return versions[-1]
        for record in versions:
            if record.version == version:
                return record
        raise NotFoundError(f"content {content_id!r} has no version {version}")

    def current_version(self, content_id: str) -> int:
        versions = self._records.get(content_id)
        return versions[-1].version if versions else 0

    def retrieve(
        self,
        kc_id: str,
        *,
        difficulty: int | None = None,
        limit: int = 10,
    ) -> tuple[ContentRecord, ...]:
        _identifier(kc_id, "kc_id", max_length=80)
        if difficulty is not None and not 1 <= difficulty <= 5:
            raise ValidationError(f"difficulty {difficulty!r} is out of range")
        if limit < 0:
            raise ValidationError("limit must be >= 0")
        hits: list[ContentRecord] = []
        for versions in self._records.values():
            current = versions[-1]
            if current.review_state != CONTENT_APPROVED:
                continue
            if kc_id not in current.kc_ids:
                continue
            if difficulty is not None and current.difficulty != difficulty:
                continue
            hits.append(current)
        hits.sort(key=lambda item: (item.difficulty, item.content_id))
        return tuple(hits[:limit])


class InMemoryContentLibrary(_ContentLibraryBase):
    """Volatile content library."""


class FileContentLibrary(_ContentLibraryBase):
    """JSON-file content library."""

    def __init__(self, root: str) -> None:
        self._path = os.path.join(os.path.abspath(root), "content.json")
        super().__init__()

    def _load_state(self) -> None:
        data = _read_json(self._path, {})
        if not isinstance(data, Mapping):
            raise IntegrityError("content file must contain an object")
        for content_id, versions in data.items():
            loaded = [ContentRecord.from_dict(item) for item in versions]
            self._records[content_id] = loaded

    def _persist(self) -> None:
        _atomic_write_json(
            self._path,
            {
                content_id: [record.as_dict() for record in versions]
                for content_id, versions in self._records.items()
            },
        )


# ---------------------------------------------------------------------------
# Evaluation service (frozen sets + isolated run records)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EvaluationRun:
    """A recorded evaluation run with simulated and real channels separated."""

    run_id: str
    dataset_id: str
    dataset_version: str
    dataset_digest: str
    idempotency_key: str
    created_at: datetime
    claim: str
    self_proof_guard: tuple[str, ...] = ()
    limitations: tuple[str, ...] = ()
    simulated: Mapping[str, Any] | None = None
    real_transfer: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "run_id", _identifier(self.run_id, "run_id"))
        object.__setattr__(self, "dataset_id", _identifier(self.dataset_id, "dataset_id"))
        object.__setattr__(
            self, "dataset_version", _identifier(self.dataset_version, "dataset_version")
        )
        object.__setattr__(
            self, "idempotency_key", _identifier(self.idempotency_key, "idempotency_key")
        )
        object.__setattr__(self, "created_at", _aware(self.created_at, "created_at"))

    def as_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "dataset_id": self.dataset_id,
            "dataset_version": self.dataset_version,
            "dataset_digest": self.dataset_digest,
            "idempotency_key": self.idempotency_key,
            "created_at": self.created_at.isoformat(),
            "claim": self.claim,
            "self_proof_guard": list(self.self_proof_guard),
            "limitations": list(self.limitations),
            "simulated": _jsonable(self.simulated),
            "real_transfer": _jsonable(self.real_transfer),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EvaluationRun":
        return cls(
            run_id=data["run_id"],
            dataset_id=data["dataset_id"],
            dataset_version=data["dataset_version"],
            dataset_digest=data["dataset_digest"],
            idempotency_key=data["idempotency_key"],
            created_at=data["created_at"],
            claim=data["claim"],
            self_proof_guard=tuple(data.get("self_proof_guard") or ()),
            limitations=tuple(data.get("limitations") or ()),
            simulated=data.get("simulated"),
            real_transfer=data.get("real_transfer"),
        )


class EvaluationService(ABC):
    """Register frozen sets and record isolated evaluation runs."""

    @abstractmethod
    def register_dataset(self, frozen_set: FrozenEvalSet) -> Mapping[str, Any]:
        """Register a frozen set; re-registering the same digest is idempotent."""

    @abstractmethod
    def get_dataset(self, dataset_id: str) -> FrozenEvalSet:
        """Return a registered frozen set or raise :class:`NotFoundError`."""

    @abstractmethod
    def run(
        self,
        dataset_id: str,
        *,
        idempotency_key: str,
        simulated_outcomes: Sequence[SimulatedOutcome] = (),
        real_outcomes: Sequence[RealOutcome] = (),
        generated_at: datetime | None = None,
    ) -> EvaluationRun:
        """Run the frozen protocol and record the separated channels."""

    @abstractmethod
    def get_run(self, run_id: str) -> EvaluationRun:
        """Return a recorded run or raise :class:`NotFoundError`."""


class _EvaluationServiceBase(EvaluationService):
    def __init__(self, *, reference_accuracy: float = 0.5) -> None:
        self._reference_accuracy = reference_accuracy
        self._datasets: dict[str, FrozenEvalSet] = {}
        self._runs: dict[str, EvaluationRun] = {}
        self._idempotency: dict[tuple[str, str], str] = {}
        self._inputs: dict[tuple[str, str], str] = {}
        self._load_state()

    def _load_state(self) -> None:
        """Load persisted datasets and runs."""

    def _persist_datasets(self) -> None:
        """Persist registered datasets."""

    def _persist_runs(self) -> None:
        """Persist recorded runs."""

    def register_dataset(self, frozen_set: FrozenEvalSet) -> Mapping[str, Any]:
        if not isinstance(frozen_set, FrozenEvalSet):
            raise ValidationError("register_dataset requires a FrozenEvalSet")
        existing = self._datasets.get(frozen_set.dataset_id)
        if existing is not None:
            if existing.digest != frozen_set.digest:
                raise ConflictError(
                    f"dataset {frozen_set.dataset_id!r} is already frozen at a "
                    "different digest"
                )
            return existing.summary()
        self._datasets[frozen_set.dataset_id] = frozen_set
        self._persist_datasets()
        return frozen_set.summary()

    def get_dataset(self, dataset_id: str) -> FrozenEvalSet:
        try:
            return self._datasets[dataset_id]
        except KeyError as exc:
            raise NotFoundError(f"no frozen dataset {dataset_id!r}") from exc

    def run(
        self,
        dataset_id: str,
        *,
        idempotency_key: str,
        simulated_outcomes: Sequence[SimulatedOutcome] = (),
        real_outcomes: Sequence[RealOutcome] = (),
        generated_at: datetime | None = None,
    ) -> EvaluationRun:
        _identifier(idempotency_key, "idempotency_key")
        frozen_set = self.get_dataset(dataset_id)
        payload_key = canonical_json(
            {
                "simulated": [
                    [outcome.item_id, outcome.predicted_correct]
                    for outcome in simulated_outcomes
                ],
                "real": [
                    [
                        outcome.item_id,
                        outcome.correct,
                        outcome.source,
                        outcome.occurred_at.isoformat(),
                        outcome.independent,
                    ]
                    for outcome in real_outcomes
                ],
            }
        )
        key = (dataset_id, idempotency_key)
        existing_id = self._idempotency.get(key)
        if existing_id is not None:
            if self._inputs.get(key) != payload_key:
                raise IdempotencyConflictError(
                    "the evaluation idempotency key was reused with different inputs"
                )
            return self._runs[existing_id]

        protocol = EvaluationProtocol(
            frozen_set, reference_accuracy=self._reference_accuracy
        )
        result = protocol.run(
            simulated_outcomes=tuple(simulated_outcomes),
            real_outcomes=tuple(real_outcomes),
            generated_at=generated_at,
        )
        data = dict(result.as_dict())
        run = EvaluationRun(
            run_id=_derive_run_id(dataset_id, idempotency_key),
            dataset_id=dataset_id,
            dataset_version=frozen_set.version,
            dataset_digest=frozen_set.digest,
            idempotency_key=idempotency_key,
            created_at=(
                _aware(generated_at, "generated_at") if generated_at else utcnow()
            ),
            claim=result.real_effect_claim(),
            self_proof_guard=tuple(data.get("self_proof_guard") or ()),
            limitations=tuple(data.get("limitations") or ()),
            simulated=data.get("simulated_benefit"),
            real_transfer=data.get("real_transfer"),
        )
        self._runs[run.run_id] = run
        self._idempotency[key] = run.run_id
        self._inputs[key] = payload_key
        self._persist_runs()
        return run

    def get_run(self, run_id: str) -> EvaluationRun:
        try:
            return self._runs[run_id]
        except KeyError as exc:
            raise NotFoundError(f"no evaluation run {run_id!r}") from exc

    def list_runs(self, dataset_id: str | None = None) -> tuple[EvaluationRun, ...]:
        runs = self._runs.values()
        if dataset_id is not None:
            runs = [run for run in runs if run.dataset_id == dataset_id]
        return tuple(sorted(runs, key=lambda item: item.run_id))


class InMemoryEvaluationService(_EvaluationServiceBase):
    """Volatile evaluation service."""


class FileEvaluationService(_EvaluationServiceBase):
    """JSON-file evaluation service."""

    def __init__(self, root: str, *, reference_accuracy: float = 0.5) -> None:
        base = os.path.abspath(root)
        self._datasets_path = os.path.join(base, "eval_datasets.json")
        self._runs_path = os.path.join(base, "eval_runs.json")
        super().__init__(reference_accuracy=reference_accuracy)

    def _load_state(self) -> None:
        datasets = _read_json(self._datasets_path, {})
        if not isinstance(datasets, Mapping):
            raise IntegrityError("eval datasets file must contain an object")
        for dataset_id, value in datasets.items():
            items = tuple(
                _eval_item_from_dict(item) for item in value.get("items", ())
            )
            frozen = FrozenEvalSet(
                dataset_id=value["dataset_id"],
                version=value["version"],
                frozen_at=datetime.fromisoformat(value["frozen_at"]),
                items=items,
            )
            stored = value.get("digest")
            if stored is not None and stored != frozen.digest:
                raise IntegrityError("frozen dataset digest mismatch")
            if frozen.dataset_id != dataset_id:
                raise IntegrityError("dataset key does not match dataset_id")
            self._datasets[frozen.dataset_id] = frozen
        runs = _read_json(self._runs_path, {})
        if not isinstance(runs, Mapping):
            raise IntegrityError("eval runs file must contain an object")
        for run_id, value in runs.items():
            run = EvaluationRun.from_dict(value)
            if run.run_id != run_id:
                raise IntegrityError("run key does not match run_id")
            self._runs[run_id] = run

    def _persist_datasets(self) -> None:
        _atomic_write_json(
            self._datasets_path,
            {
                dataset_id: {
                    **frozen.summary(),
                    "frozen_at": frozen.frozen_at.isoformat(),
                    "items": [
                        {
                            "item_id": item.item_id,
                            "kc_id": item.kc_id,
                            "split": item.split,
                            "difficulty": item.difficulty,
                            "seen_before": item.seen_before,
                        }
                        for item in frozen.items
                    ],
                }
                for dataset_id, frozen in self._datasets.items()
            },
        )

    def _persist_runs(self) -> None:
        _atomic_write_json(
            self._runs_path,
            {run_id: run.as_dict() for run_id, run in self._runs.items()},
        )


def _eval_item_from_dict(data: Mapping[str, Any]) -> Any:
    from .evaluation import EvalItem

    return EvalItem(
        item_id=data["item_id"],
        kc_id=data["kc_id"],
        split=data["split"],
        difficulty=data.get("difficulty", 2),
        seen_before=bool(data.get("seen_before", False)),
    )


# ---------------------------------------------------------------------------
# Harness state machine (spec section 12.2 / 15.3)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TransitionRecord:
    """One accepted state transition."""

    index: int
    from_state: str
    to_state: str
    reason: str
    detail: Mapping[str, Scalar] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=utcnow)

    def as_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "from_state": self.from_state,
            "to_state": self.to_state,
            "reason": self.reason,
            "detail": dict(self.detail),
            "occurred_at": self.occurred_at.isoformat(),
        }


def exception_branch(code: str) -> ExceptionBranch:
    """Return the configured branch for ``code`` or raise."""

    try:
        return EXCEPTION_BRANCHES[code]
    except KeyError as exc:
        raise ValidationError(f"unknown exception branch {code!r}") from exc


class HarnessStateMachine:
    """Typed learning-loop state machine with bounded rework loops."""

    def __init__(
        self,
        student_ref: str,
        *,
        session_id: str = "",
        initial_state: str = STATE_INTAKE,
        max_rejections: int = DEFAULT_MAX_REJECTIONS,
    ) -> None:
        self.student_ref = _identifier(student_ref, "student_ref")
        self.session_id = session_id
        if initial_state not in LEARNING_STATES:
            raise ValidationError(f"unknown state {initial_state!r}")
        if initial_state in TERMINAL_STATES:
            raise ValidationError("cannot start in a terminal state")
        if not isinstance(max_rejections, int) or max_rejections < 1:
            raise ValidationError("max_rejections must be a positive integer")
        self._state = initial_state
        self._max_rejections = max_rejections
        self._history: list[TransitionRecord] = []
        self._idempotency: dict[str, TransitionRecord] = {}
        self._rejections = 0
        self._degraded: list[Mapping[str, Scalar]] = []
        self._exceptions: dict[str, int] = {}

    # -- read-only view ----------------------------------------------------

    @property
    def state(self) -> str:
        return self._state

    @property
    def is_terminal(self) -> bool:
        return self._state in TERMINAL_STATES

    @property
    def history(self) -> tuple[TransitionRecord, ...]:
        return tuple(self._history)

    @property
    def rejections(self) -> int:
        return self._rejections

    def allowed_next(self) -> frozenset[str]:
        """Return the states reachable from the current state."""

        if self.is_terminal:
            return frozenset()
        normal = set(TRANSITIONS.get(self._state, frozenset()))
        normal.update({STATE_FAILED, STATE_ABORTED})
        return frozenset(normal)

    def can_advance(self, to_state: str) -> bool:
        return to_state in self.allowed_next()

    # -- transitions -------------------------------------------------------

    def advance(
        self,
        to_state: str,
        *,
        reason: str,
        idempotency_key: str | None = None,
        detail: Mapping[str, Scalar] | None = None,
    ) -> TransitionRecord:
        """Advance the machine along a normal workflow edge."""

        return self._transition(
            to_state,
            reason=reason,
            idempotency_key=idempotency_key,
            detail=detail,
            allow_any=False,
        )

    def _transition(
        self,
        to_state: str,
        *,
        reason: str,
        idempotency_key: str | None,
        detail: Mapping[str, Scalar] | None,
        allow_any: bool,
    ) -> TransitionRecord:
        _identifier(reason, "reason")
        if to_state not in LEARNING_STATES:
            raise ValidationError(f"unknown state {to_state!r}")
        if idempotency_key is not None:
            _identifier(idempotency_key, "idempotency_key")
            recorded = self._idempotency.get(idempotency_key)
            if recorded is not None:
                if recorded.to_state != to_state:
                    raise IdempotencyConflictError(
                        "the transition idempotency key was reused for a "
                        "different target state"
                    )
                return recorded
        if self.is_terminal:
            raise StateMachineError(
                f"state {self._state!r} is terminal and cannot transition"
            )
        if not allow_any and to_state not in self.allowed_next():
            raise InvalidTransitionError(
                f"{self._state!r} cannot transition to {to_state!r}"
            )
        record = TransitionRecord(
            index=len(self._history) + 1,
            from_state=self._state,
            to_state=to_state,
            reason=reason,
            detail=_payload(detail),
        )
        self._history.append(record)
        self._state = to_state
        if idempotency_key is not None:
            self._idempotency[idempotency_key] = record
        return record

    def register_rejection(
        self,
        *,
        code: str = BRANCH_CONTENT_REJECTED,
        reason: str = "rejected",
        detail: Mapping[str, Scalar] | None = None,
    ) -> TransitionRecord:
        """Record a gate/content rejection, failing closed past the bound."""

        self._rejections += 1
        if self._rejections > self._max_rejections:
            self._degraded.append(
                {"code": code, "mode": "rework_budget_exhausted"}
            )
            if self.is_terminal:
                raise StateMachineError("the machine already failed closed")
            return self.advance(
                STATE_FAILED,
                reason=f"{code}:budget_exhausted",
                detail=detail,
            )
        return self.advance(
            STATE_EXERCISE_EVOLUTION,
            reason=f"{code}:{reason}",
            detail=detail,
        )

    def handle_exception(
        self,
        code: str,
        *,
        detail: Mapping[str, Scalar] | None = None,
    ) -> ExceptionBranch:
        """Apply a section 15.3 degraded / failure branch."""

        branch = exception_branch(code)
        if branch.target_state and self.is_terminal:
            raise StateMachineError("cannot apply a branch from a terminal state")
        self._exceptions[code] = self._exceptions.get(code, 0) + 1
        self._degraded.append(
            {
                "code": branch.code,
                "mode": branch.degraded_mode,
                "target_state": branch.target_state,
            }
        )
        if branch.target_state:
            # Exception branches are allowed to reroute across normal edges;
            # the target is still validated against the known state set.
            self._transition(
                branch.target_state,
                reason=f"exception:{code}",
                idempotency_key=None,
                detail=detail,
                allow_any=True,
            )
        return branch

    def snapshot(self) -> Mapping[str, Any]:
        """A serialisable view for audit / debugging (no student content)."""

        return {
            "student_ref": self.student_ref,
            "session_id": self.session_id,
            "state": self._state,
            "is_terminal": self.is_terminal,
            "allowed_next": sorted(self.allowed_next()),
            "transitions": [record.as_dict() for record in self._history],
            "rejections": self._rejections,
            "degraded": [dict(item) for item in self._degraded],
            "exceptions": dict(self._exceptions),
        }


__all__ = [
    "DOMAIN_OBSERVED",
    "DOMAIN_SIMULATED",
    "STORAGE_DOMAINS",
    "SOURCE_OBSERVED",
    "SOURCE_SIMULATED",
    "EVENT_SOURCES",
    "EVENT_SCHEMA_VERSION",
    "PROVENANCE_SYNTHETIC",
    "EVENT_TYPES",
    "SIMULATION_EVENT_TYPES",
    "CONTENT_DRAFT",
    "CONTENT_APPROVED",
    "CONTENT_RETIRED",
    "CONTENT_REVIEW_STATES",
    "STAGES",
    "STATE_INTAKE",
    "STATE_EVIDENCE_PARSE",
    "STATE_PROGRESS_CHECK",
    "STATE_NEED_CLARIFICATION",
    "STATE_STATE_LOAD",
    "STATE_DIAGNOSE",
    "STATE_HYPOTHESIS_UPDATE",
    "STATE_PROBE",
    "STATE_AWAIT_STUDENT",
    "STATE_EXERCISE_EVOLUTION",
    "STATE_RECALL_SCHEDULE",
    "STATE_PREVIEW_PLANNER",
    "STATE_SIMULATION_LAB",
    "STATE_CANDIDATE_RANKING",
    "STATE_CURRICULUM_GATE",
    "STATE_CONTENT_VALIDATION",
    "STATE_DELIVER",
    "STATE_ASSESS",
    "STATE_STATE_COMMIT",
    "STATE_REVIEW_RESCHEDULE",
    "STATE_COMPLETED",
    "STATE_FAILED",
    "STATE_ABORTED",
    "LEARNING_STATES",
    "TERMINAL_STATES",
    "TRANSITIONS",
    "DEFAULT_MAX_REJECTIONS",
    "BRANCH_OCR_UNCERTAIN",
    "BRANCH_SYMBOL_VERIFIER_UNCERTAIN",
    "BRANCH_RAG_SOURCE_MISSING",
    "BRANCH_SCHOOL_PROGRESS_UNCLEAR",
    "BRANCH_HYPOTHESES_ALL_MISMATCHED",
    "BRANCH_SIMULATION_TIMEOUT",
    "BRANCH_SPARSE_MEMORY_DATA",
    "BRANCH_LOW_CONFIDENCE_STRATEGY",
    "BRANCH_STUDENT_REFUSES_DIAGNOSIS",
    "BRANCH_ABNORMAL_PRESSURE",
    "BRANCH_CURRICULUM_GATE_REJECTED",
    "BRANCH_CONTENT_REJECTED",
    "ExceptionBranch",
    "EXCEPTION_BRANCHES",
    "ServiceError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
    "OptimisticConcurrencyError",
    "IdempotencyConflictError",
    "IsolationViolationError",
    "IntegrityError",
    "StateMachineError",
    "InvalidTransitionError",
    "utcnow",
    "canonical_json",
    "content_digest",
    "WriteCoordinator",
    "EventDraft",
    "LearningEvent",
    "AppendResult",
    "EventStore",
    "InMemoryEventStore",
    "FileEventStore",
    "StudentProfile",
    "ProfileStore",
    "InMemoryProfileStore",
    "FileProfileStore",
    "ProfileBundle",
    "BundleStore",
    "InMemoryBundleStore",
    "FileBundleStore",
    "ContentRecord",
    "ContentLibraryService",
    "InMemoryContentLibrary",
    "FileContentLibrary",
    "EvaluationRun",
    "EvaluationService",
    "InMemoryEvaluationService",
    "FileEvaluationService",
    "TransitionRecord",
    "exception_branch",
    "HarnessStateMachine",
]
