"""Long-term student twin with event sourcing (spec section 5, Step 12).

Step 12 completes the long-term twin lifecycle:

* **append** -- real observations are appended to an immutable evidence log; a
  correction is a *new* event, never an edit or a delete of history;
* **version** -- every inferred-state transition (mastery, memory review,
  memory aging, hypothesis binding, approved calibration activation) gets a
  monotonic version and a full-state history entry;
* **snapshot / checkpoint** -- :class:`TwinCheckpoint` captures the inferred
  knowledge, multi-KC memory, hypothesis binding and parameter version with
  the evidence revision it was derived from;
* **rollback** -- restores inferred state at a version (or checkpoint) while
  the real evidence log stays intact;
* **replay** -- :meth:`StudentTwin.rebuild` / :meth:`StudentTwin.replay`
  deterministically recompute the inferred state from the observed log plus
  the inference log.

Hard isolation rules implemented here:

* simulated events live in a separate store and can never write ``observed_*``
  evidence or mastery;
* a mastery / memory / hypothesis update must reference real evidence ids that
  actually exist; simulated ids are rejected even if they were recorded;
* stale simulations can never auto-override newer state;
* a Step 11 FSRS calibration parameter set is attached only as a *pending*
  candidate and becomes effective only after an explicit host approval;
* aging a memory state raises uncertainty but never lowers stability,
  difficulty or mastery.

Standard library only.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping

from .hypothesis import Hypothesis, HypothesisSet
from .memory import (
    BASELINE_PARAMETER_VERSION,
    MemoryObservation,
    MemoryParameters,
    MemoryState,
    aggregate_memory,
    apply_forgetting,
    update_memory,
)

#: Sources that may write real (observed) evidence.
REAL_SOURCES: frozenset[str] = frozenset(
    {"student", "teacher", "trusted_grader", "assessment"}
)
#: Sources that belong to the isolated simulation world.
SIMULATED_SOURCES: frozenset[str] = frozenset(
    {"simulated", "virtual_student", "simulation"}
)

SCHEMA_VERSION = "aeh-event-v1"

#: Hypothesis operation kinds understood by :meth:`StudentTwin.evolve_hypotheses`.
HYPOTHESIS_OPS: tuple[str, ...] = ("spawn", "split", "reweight", "merge", "prune")


class TwinError(Exception):
    """Base class for twin errors."""


class SimulatedEventRejected(TwinError):
    """A simulated event tried to enter the observed (real) store."""


class UnknownEventSource(TwinError):
    """The event source is neither a trusted real source nor a simulator."""


class MissingEvidenceError(TwinError):
    """A mastery/memory/hypothesis update referenced non-real evidence."""


class StaleSimulationError(TwinError):
    """A simulation based on an older revision tried to override newer state."""


class VersionNotFoundError(TwinError):
    """Rollback target version does not exist."""


class CheckpointNotFoundError(TwinError):
    """Checkpoint id does not exist."""


class CalibrationApprovalRequired(TwinError):
    """A pending calibration candidate cannot take effect without approval."""


class HypothesisBindingError(TwinError):
    """A hypothesis set could not be bound to the twin."""


def _freeze_mapping(value: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return MappingProxyType(dict(value or {}))


@dataclass(frozen=True)
class Event:
    """An immutable observation/simulation event.

    ``source`` decides the world: :data:`REAL_SOURCES` writes observed evidence,
    :data:`SIMULATED_SOURCES` is isolated.
    """

    event_id: str
    event_type: str
    source: str
    occurred_at: datetime | None = None
    observed_at: datetime | None = None
    student_id: str | None = None
    payload: Mapping[str, Any] = field(default_factory=dict)
    provenance: str = ""
    model_versions: Mapping[str, str] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION
    consent_scope: str = "unspecified"

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", _freeze_mapping(self.payload))
        object.__setattr__(self, "model_versions", _freeze_mapping(self.model_versions))

    @property
    def is_simulated(self) -> bool:
        return self.source in SIMULATED_SOURCES

    @property
    def is_real(self) -> bool:
        return self.source in REAL_SOURCES


@dataclass(frozen=True)
class KnowledgeEstimate:
    """Per-KC inferred state; never a single compressed "mastery rate"."""

    kc_id: str
    mastery_mean: float
    uncertainty: float
    evidence_ids: tuple[str, ...] = ()
    exposure_state: str = "unknown"

    def __post_init__(self) -> None:
        if not 0.0 <= self.mastery_mean <= 1.0:
            raise ValueError("mastery_mean must be within [0, 1]")
        if self.uncertainty < 0.0:
            raise ValueError("uncertainty must be >= 0")


@dataclass(frozen=True)
class TwinState:
    """An immutable snapshot of the inferred twin state."""

    student_id: str
    version: int
    knowledge: Mapping[str, KnowledgeEstimate]
    observed_evidence_ids: frozenset[str]
    last_observed_at: datetime | None = None
    unresolved_hypotheses: tuple[str, ...] = ()
    #: Step 12: per-KC long-term memory states (never a single mastery rate).
    memory: Mapping[str, MemoryState] = field(default_factory=dict)
    #: Step 12: revision of the bound hypothesis set.
    hypothesis_revision: int = 0
    #: Step 12: currently effective FSRS parameter version.
    active_parameter_version: str = BASELINE_PARAMETER_VERSION


@dataclass(frozen=True)
class MasteryUpdate:
    """One inferred mastery update; replayable from the inference log."""

    update_id: str
    kc_id: str
    mastery_mean: float
    uncertainty: float
    evidence_ids: tuple[str, ...]
    exposure_state: str = "observed"
    version: int = 0  # version produced by this update


@dataclass(frozen=True)
class MemoryUpdate:
    """One evidence-backed review of a single KC's long-term memory."""

    update_id: str
    kc_id: str
    observation_id: str
    evidence_ids: tuple[str, ...]
    state: MemoryState
    version: int = 0


@dataclass(frozen=True)
class MemoryDecayUpdate:
    """One time-based aging step covering several KC memory units."""

    update_id: str
    states: Mapping[str, MemoryState]
    version: int = 0


@dataclass(frozen=True)
class HypothesisBinding:
    """A hypothesis set bound to one twin version and its evidence refs."""

    binding_id: str
    hypothesis_revision: int
    twin_version: int
    weights: Mapping[str, float]
    unresolved: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    hypothesis_set: HypothesisSet | None = None
    bound_at: datetime | None = None

    @property
    def version(self) -> int:
        """The twin version this binding produced (step-log compatibility)."""
        return self.twin_version


@dataclass(frozen=True)
class PendingCalibration:
    """A Step 11 parameter candidate that has **not** taken effect yet."""

    candidate_id: str
    candidate_version: str
    parameters: MemoryParameters
    proposed_by: str = ""
    proposed_at: datetime | None = None
    fingerprint: str = ""


@dataclass(frozen=True)
class CalibrationActivation:
    """An approved activation or rollback of a calibration parameter set."""

    activation_id: str
    kind: str
    candidate_id: str
    candidate_version: str
    parameter_version: str
    values: Mapping[str, float]
    approval_id: str
    approved_by: str
    previous_parameter_version: str
    activated_at: datetime | None = None
    version: int = 0


@dataclass(frozen=True)
class TwinCheckpoint:
    """A full inferred-state checkpoint bound to an evidence revision."""

    checkpoint_id: str
    label: str
    version: int
    evidence_revision: int
    created_at: datetime | None
    knowledge: Mapping[str, KnowledgeEstimate]
    memory: Mapping[str, MemoryState]
    observed_evidence_ids: frozenset[str]
    last_observed_at: datetime | None
    unresolved_hypotheses: tuple[str, ...]
    hypothesis_revision: int
    hypothesis_weights: Mapping[str, float]
    hypothesis_bound_version: int | None
    active_parameter_version: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "checkpointId": self.checkpoint_id,
            "label": self.label,
            "version": self.version,
            "evidenceRevision": self.evidence_revision,
            "createdAt": None if self.created_at is None else self.created_at.isoformat(),
            "knowledge": [
                {
                    "kcId": estimate.kc_id,
                    "masteryMean": round(estimate.mastery_mean, 6),
                    "uncertainty": round(estimate.uncertainty, 6),
                    "evidenceIds": list(estimate.evidence_ids),
                    "exposureState": estimate.exposure_state,
                }
                for estimate in sorted(
                    self.knowledge.values(), key=lambda item: item.kc_id
                )
            ],
            "memory": [
                {
                    "memoryUnitId": state.memory_unit_id,
                    "stabilityDays": round(state.stability_days, 6),
                    "difficulty": round(state.difficulty, 6),
                    "observationCount": state.observation_count,
                    "independentSuccessCount": state.independent_success_count,
                    "uncertainty": state.uncertainty,
                    "modelVersion": state.model_version,
                    "needsCalibration": state.needs_calibration,
                }
                for state in sorted(
                    self.memory.values(), key=lambda item: item.memory_unit_id
                )
            ],
            "observedEvidenceIds": sorted(self.observed_evidence_ids),
            "lastObservedAt": (
                None if self.last_observed_at is None else self.last_observed_at.isoformat()
            ),
            "unresolvedHypotheses": list(self.unresolved_hypotheses),
            "hypothesisRevision": self.hypothesis_revision,
            "hypothesisWeights": {
                key: round(value, 6)
                for key, value in sorted(self.hypothesis_weights.items())
            },
            "hypothesisBoundVersion": self.hypothesis_bound_version,
            "activeParameterVersion": self.active_parameter_version,
        }


@dataclass(frozen=True)
class HypothesisOperation:
    """One structured hypothesis-set evolution step (spec 6.2)."""

    kind: str
    hypothesis: Hypothesis | None = None
    hypothesis_id: str | None = None
    children: tuple[Hypothesis, ...] = ()
    hypothesis_ids: tuple[str, ...] = ()
    merged: Hypothesis | None = None
    likelihoods: Mapping[str, float] = field(default_factory=dict)
    reason: str = ""
    noise: float = 0.05
    unknown_prior: float | None = None
    unknown_likelihood: float = 0.5
    evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.kind not in HYPOTHESIS_OPS:
            raise HypothesisBindingError(
                f"unknown hypothesis operation {self.kind!r}"
            )


@dataclass
class _InferredState:
    """Mutable working copy of the inferred state (installed per version)."""

    knowledge: dict[str, KnowledgeEstimate] = field(default_factory=dict)
    memory: dict[str, MemoryState] = field(default_factory=dict)
    hypotheses: HypothesisSet | None = None
    unresolved: tuple[str, ...] = ()
    active_parameter_version: str = BASELINE_PARAMETER_VERSION
    hypothesis_revision: int = 0

    def copy(self) -> "_InferredState":
        return _InferredState(
            knowledge=dict(self.knowledge),
            memory=dict(self.memory),
            hypotheses=self.hypotheses.clone() if self.hypotheses else None,
            unresolved=self.unresolved,
            active_parameter_version=self.active_parameter_version,
            hypothesis_revision=self.hypothesis_revision,
        )


class StudentTwin:
    """Event-sourced, versioned, rollbackable long-term student twin."""

    def __init__(
        self, student_id: str, *, clock: "Callable[[], datetime] | None" = None
    ) -> None:
        if not isinstance(student_id, str) or not student_id:
            raise TwinError("student_id is required")
        self.student_id = student_id
        self._clock = clock or utcnow
        self._observed_events: list[Event] = []
        self._simulated_events: list[Event] = []
        self._evidence_cursor: set[str] = set()
        self._last_observed_at: datetime | None = None
        self._steps: list[Any] = []
        self._history: list[_InferredState] = [_InferredState()]
        self._checkpoints: list[TwinCheckpoint] = []
        self._hypothesis_bindings: list[HypothesisBinding] = []
        self._pending_calibration: PendingCalibration | None = None
        self._active_calibration: CalibrationActivation | None = None
        self._state = _InferredState()
        self._install(self._state.copy())

    # ------------------------------------------------------------------
    # Read-only views
    # ------------------------------------------------------------------
    @property
    def version(self) -> int:
        """Version of the inferred state (number of committed steps)."""
        return len(self._steps)

    @property
    def evidence_revision(self) -> int:
        """Monotonic counter of real observations (used for freshness checks)."""
        return len(self._observed_events)

    @property
    def observed_evidence_ids(self) -> frozenset[str]:
        return frozenset(self._evidence_cursor)

    @property
    def state(self) -> TwinState:
        return TwinState(
            student_id=self.student_id,
            version=self.version,
            knowledge=MappingProxyType(dict(self._knowledge)),
            observed_evidence_ids=self.observed_evidence_ids,
            last_observed_at=self._last_observed_at,
            unresolved_hypotheses=self._unresolved,
            memory=MappingProxyType(dict(self._memory)),
            hypothesis_revision=self._hypothesis_revision,
            active_parameter_version=self._active_parameter_version,
        )

    @property
    def active_parameter_version(self) -> str:
        return self._active_parameter_version

    @property
    def pending_calibration(self) -> PendingCalibration | None:
        return self._pending_calibration

    @property
    def active_calibration(self) -> CalibrationActivation | None:
        return self._active_calibration

    @property
    def hypotheses(self) -> HypothesisSet | None:
        return self._hypotheses

    @property
    def hypothesis_bindings(self) -> tuple[HypothesisBinding, ...]:
        return tuple(self._hypothesis_bindings)

    @property
    def checkpoints(self) -> tuple[TwinCheckpoint, ...]:
        return tuple(self._checkpoints)

    def observed_events(self) -> tuple[Event, ...]:
        return tuple(self._observed_events)

    def simulated_events(self) -> tuple[Event, ...]:
        return tuple(self._simulated_events)

    def knowledge_for(self, kc_id: str) -> KnowledgeEstimate | None:
        return self._knowledge.get(kc_id)

    def memory_for(self, kc_id: str) -> MemoryState | None:
        return self._memory.get(kc_id)

    def memory_states(self) -> Mapping[str, MemoryState]:
        return MappingProxyType(dict(self._memory))

    def memory_aggregate(
        self, now: datetime | None = None, *, target_retention: float = 0.9
    ) -> dict[str, Any]:
        """Multi-KC long-term memory summary (Step 12)."""
        return aggregate_memory(
            list(self._memory.values()),
            now,
            target_retention=target_retention,
            parameters=self._active_memory_parameters(),
        )

    # ------------------------------------------------------------------
    # Real evidence (append-only, immutable)
    # ------------------------------------------------------------------
    def record_observed(self, event: Event) -> Event:
        """Append a real event to the immutable evidence log.

        Simulated events are rejected outright (invariant 1 / spec 22.2).
        """
        if event.is_simulated:
            raise SimulatedEventRejected(
                f"simulated event {event.event_id!r} cannot write observed evidence"
            )
        if not event.is_real:
            raise UnknownEventSource(
                f"unknown source {event.source!r} for event {event.event_id!r}"
            )
        if event.student_id not in (None, self.student_id):
            raise TwinError("event student_id does not match twin student_id")
        if any(e.event_id == event.event_id for e in self._observed_events):
            raise TwinError(f"duplicate event_id {event.event_id!r}")

        self._observed_events.append(event)
        self._evidence_cursor.add(event.event_id)
        stamp = event.observed_at or event.occurred_at
        if stamp is not None:
            if self._last_observed_at is None or stamp > self._last_observed_at:
                self._last_observed_at = stamp
        return event

    def record_real_correction(self, event: Event) -> Event:
        """A student/teacher correction is a new event, not a history edit."""
        return self.record_observed(event)

    # ------------------------------------------------------------------
    # Simulated world (isolated)
    # ------------------------------------------------------------------
    def record_simulated(self, event: Event) -> Event:
        """Store a simulated event in the isolated simulated store."""
        if not event.is_simulated:
            raise TwinError("record_simulated requires a simulated source")
        if event.student_id not in (None, self.student_id):
            raise TwinError("event student_id does not match twin student_id")
        if any(e.event_id == event.event_id for e in self._simulated_events):
            raise TwinError(f"duplicate simulated event_id {event.event_id!r}")
        self._simulated_events.append(event)
        return event

    def assert_fresh_simulation(self, parent_evidence_revision: int) -> None:
        """Raise if a simulation is based on an older revision than current state."""
        if parent_evidence_revision < self.evidence_revision:
            raise StaleSimulationError(
                "simulation parent revision "
                f"{parent_evidence_revision} < current {self.evidence_revision}"
            )

    def promote_simulated(self, event_id: str) -> None:
        """Promotion is never automatic; simulated results cannot rewrite observed."""
        raise SimulatedEventRejected(
            f"simulated event {event_id!r} cannot be promoted into observed state"
        )

    # ------------------------------------------------------------------
    # Inferred state (versioned, rebuildable, rollbackable)
    # ------------------------------------------------------------------
    def update_mastery(
        self,
        kc_id: str,
        mastery_mean: float,
        uncertainty: float,
        evidence_ids: Iterable[str],
        *,
        exposure_state: str = "observed",
    ) -> KnowledgeEstimate:
        """Apply an inferred mastery update backed by real evidence ids."""
        evidence = self._require_observed_evidence(evidence_ids)
        # KnowledgeEstimate validates the value ranges and raises ValueError.
        estimate = KnowledgeEstimate(
            kc_id=kc_id,
            mastery_mean=float(mastery_mean),
            uncertainty=float(uncertainty),
            evidence_ids=evidence,
            exposure_state=exposure_state,
        )
        new_version = self.version + 1
        update = MasteryUpdate(
            update_id=f"upd_{new_version}",
            kc_id=kc_id,
            mastery_mean=float(mastery_mean),
            uncertainty=float(uncertainty),
            evidence_ids=evidence,
            exposure_state=exposure_state,
            version=new_version,
        )
        next_state = self._state.copy()
        next_state.knowledge[kc_id] = estimate
        self._commit(update, next_state)
        return estimate

    def set_unresolved_hypotheses(self, hypothesis_ids: Iterable[str]) -> None:
        self._unresolved = tuple(hypothesis_ids)
        self._state.unresolved = self._unresolved

    # -- long-term memory integration ----------------------------------
    def record_memory_review(
        self,
        kc_id: str,
        observation: MemoryObservation,
        evidence_ids: Iterable[str],
        *,
        parameters: MemoryParameters | None = None,
    ) -> MemoryState:
        """Apply one evidence-backed review to a KC's long-term memory.

        The observation must be backed by real evidence: simulated ids cannot
        appear in the observed cursor, so they are rejected here as well.
        Reading an explanation produces no state change and no new version.
        """
        evidence = self._require_observed_evidence(evidence_ids)
        params = parameters or self._active_memory_parameters()
        previous = self._memory.get(kc_id) or MemoryState(
            learner_id=self.student_id,
            memory_unit_id=kc_id,
            stability_days=params.initial_stability_days,
            difficulty=params.initial_difficulty,
            model_version=params.parameter_version,
        )
        updated = update_memory(previous, observation, parameters=params)
        if updated is previous:
            # Reading is not a retrieval event; no version and no state change.
            return previous
        new_version = self.version + 1
        step = MemoryUpdate(
            update_id=f"mem_{new_version}",
            kc_id=kc_id,
            observation_id=observation.observation_id,
            evidence_ids=evidence,
            state=updated,
            version=new_version,
        )
        next_state = self._state.copy()
        next_state.memory[kc_id] = updated
        self._commit(step, next_state)
        return updated

    def apply_memory_forgetting(
        self, now: datetime, *, target_retention: float = 0.9
    ) -> tuple[str, ...]:
        """Age every KC memory unit; never lowers stability or difficulty."""
        params = self._active_memory_parameters()
        changed: dict[str, MemoryState] = {}
        for kc_id, state in self._memory.items():
            aged = apply_forgetting(
                state,
                now,
                target_retention=target_retention,
                parameters=params,
            )
            if aged is not state:
                changed[kc_id] = aged
        if not changed:
            return ()
        new_version = self.version + 1
        step = MemoryDecayUpdate(
            update_id=f"decay_{new_version}",
            states=MappingProxyType(dict(changed)),
            version=new_version,
        )
        next_state = self._state.copy()
        next_state.memory.update(changed)
        self._commit(step, next_state)
        return tuple(sorted(changed))

    # -- hypothesis evolution bound to the twin version ----------------
    def bind_hypotheses(
        self, hypothesis_set: HypothesisSet, *, evidence_ids: Iterable[str] = ()
    ) -> HypothesisBinding:
        """Bind an (already evolved) hypothesis set to a new twin version."""
        if not isinstance(hypothesis_set, HypothesisSet):
            raise HypothesisBindingError("bind_hypotheses expects a HypothesisSet")
        evidence = (
            tuple(evidence_ids)
            if evidence_ids
            else tuple(sorted(hypothesis_set.active_evidence_refs()))
        )
        if evidence:
            self._require_observed_evidence(evidence)
        working = hypothesis_set.clone()
        new_version = self.version + 1
        working.bind_twin_version(new_version)
        binding = HypothesisBinding(
            binding_id=f"hyp_{new_version}",
            hypothesis_revision=working.revision,
            twin_version=new_version,
            weights=MappingProxyType(dict(working.weights())),
            unresolved=tuple(sorted(h.hypothesis_id for h in working.active())),
            evidence_ids=evidence,
            hypothesis_set=working,
            bound_at=self._clock(),
        )
        next_state = self._state.copy()
        next_state.hypotheses = working
        next_state.unresolved = binding.unresolved
        next_state.hypothesis_revision = working.revision
        self._hypothesis_bindings.append(binding)
        self._commit(binding, next_state)
        return binding

    def evolve_hypotheses(self, operation: HypothesisOperation) -> HypothesisBinding:
        """Apply one spawn/split/reweight/merge/prune and bind the result.

        The operation must cite real evidence ids; the evolved set is cloned
        and bound to the new twin version, so a checkpoint/rollback restores
        the exact hypothesis revision it was created from.
        """
        evidence = tuple(operation.evidence_ids)
        if evidence:
            self._require_observed_evidence(evidence)
        if self._hypotheses is None and operation.kind != "spawn":
            raise HypothesisBindingError(
                f"hypothesis operation {operation.kind!r} requires a bound "
                "hypothesis set (spawn one or bind a set first)"
            )
        working = self._hypotheses.clone() if self._hypotheses else HypothesisSet()
        self._apply_hypothesis_operation(working, operation, evidence)
        new_version = self.version + 1
        working.bind_twin_version(new_version)
        binding = HypothesisBinding(
            binding_id=f"hyp_{new_version}",
            hypothesis_revision=working.revision,
            twin_version=new_version,
            weights=MappingProxyType(dict(working.weights())),
            unresolved=tuple(sorted(h.hypothesis_id for h in working.active())),
            evidence_ids=evidence,
            hypothesis_set=working,
            bound_at=self._clock(),
        )
        next_state = self._state.copy()
        next_state.hypotheses = working
        next_state.unresolved = binding.unresolved
        next_state.hypothesis_revision = working.revision
        self._hypothesis_bindings.append(binding)
        self._commit(binding, next_state)
        return binding

    def _apply_hypothesis_operation(
        self,
        working: HypothesisSet,
        operation: HypothesisOperation,
        evidence: tuple[str, ...],
    ) -> None:
        if operation.kind == "spawn":
            if operation.hypothesis is None:
                raise HypothesisBindingError("spawn requires a hypothesis")
            working.spawn(operation.hypothesis)
        elif operation.kind == "split":
            if operation.hypothesis_id is None:
                raise HypothesisBindingError("split requires hypothesis_id")
            working.split(operation.hypothesis_id, operation.children)
        elif operation.kind == "reweight":
            working.reweight(
                operation.likelihoods,
                evidence_id=evidence[0] if evidence else None,
                noise=operation.noise,
                unknown_prior=operation.unknown_prior,
                unknown_likelihood=operation.unknown_likelihood,
            )
        elif operation.kind == "merge":
            if operation.merged is None:
                raise HypothesisBindingError("merge requires the merged hypothesis")
            working.merge(operation.hypothesis_ids, operation.merged)
        elif operation.kind == "prune":
            if operation.hypothesis_id is None:
                raise HypothesisBindingError("prune requires hypothesis_id")
            working.prune(operation.hypothesis_id, operation.reason)
        else:  # pragma: no cover - HypothesisOperation validates the kind
            raise HypothesisBindingError(
                f"unknown hypothesis operation {operation.kind!r}"
            )

    # -- Step 11 calibration candidate (pending until approved) --------
    def propose_memory_calibration(
        self,
        parameters: MemoryParameters | Mapping[str, Any],
        *,
        candidate_id: str = "",
        candidate_version: str = "",
        proposed_by: str = "",
        fingerprint: str = "",
    ) -> PendingCalibration:
        """Attach a Step 11 parameter candidate **without** applying it."""
        if isinstance(parameters, MemoryParameters):
            resolved = parameters
        elif isinstance(parameters, Mapping):
            resolved = MemoryParameters.from_mapping(parameters)
        else:
            raise TwinError(
                "calibration parameters must be MemoryParameters or a mapping"
            )
        pending = PendingCalibration(
            candidate_id=candidate_id or f"calibration.{self.student_id}",
            candidate_version=candidate_version or resolved.parameter_version,
            parameters=resolved,
            proposed_by=proposed_by,
            proposed_at=self._clock(),
            fingerprint=fingerprint,
        )
        self._pending_calibration = pending
        return pending

    def propose_memory_calibration_from_candidate(
        self, candidate: Any, *, proposed_by: str = ""
    ) -> PendingCalibration:
        """Attach the parameter vector declared by a Step 11 ``Candidate``.

        The candidate is duck-typed (``changes.parameters`` /
        ``changes.parameter_version``) so the twin does not depend on the
        evolution/calibration modules.  It still does not take effect until
        :meth:`activate_memory_calibration` records an explicit approval.
        """
        changes = getattr(candidate, "changes", None)
        if not isinstance(changes, Mapping):
            raise TwinError("candidate must expose a changes mapping")
        raw = changes.get("parameters")
        if not isinstance(raw, Mapping):
            raise TwinError("candidate changes must contain a 'parameters' mapping")
        version = changes.get("parameter_version")
        parameters = MemoryParameters.from_mapping(
            raw, parameter_version=None if version is None else str(version)
        )
        return self.propose_memory_calibration(
            parameters,
            candidate_id=str(getattr(candidate, "candidate_id", "")),
            candidate_version=str(getattr(candidate, "version", "")),
            proposed_by=proposed_by,
            fingerprint=str(changes.get("report_fingerprint", "")),
        )

    def activate_memory_calibration(
        self,
        *,
        approval_id: str,
        approved_by: str,
        activated_at: datetime | None = None,
    ) -> CalibrationActivation:
        """Activate the pending candidate; requires an explicit host approval."""
        if self._pending_calibration is None:
            raise TwinError("no pending calibration candidate to activate")
        if not approval_id or not approved_by:
            raise CalibrationApprovalRequired(
                "calibration activation requires an explicit approval id and actor"
            )
        pending = self._pending_calibration
        parameters = pending.parameters
        new_version = self.version + 1
        previous = self._active_parameter_version
        activation = CalibrationActivation(
            activation_id=f"cal_{new_version}",
            kind="activate",
            candidate_id=pending.candidate_id,
            candidate_version=pending.candidate_version,
            parameter_version=parameters.parameter_version,
            values=MappingProxyType(parameters.value_dict()),
            approval_id=approval_id,
            approved_by=approved_by,
            previous_parameter_version=previous,
            activated_at=activated_at or self._clock(),
            version=new_version,
        )
        next_state = self._state.copy()
        next_state.active_parameter_version = parameters.parameter_version
        self._active_calibration = activation
        self._pending_calibration = None
        self._commit(activation, next_state)
        return activation

    def reject_memory_calibration(self, reason: str = "") -> PendingCalibration | None:
        pending = self._pending_calibration
        self._pending_calibration = None
        return pending

    def rollback_memory_calibration(
        self,
        *,
        approval_id: str,
        approved_by: str,
        reason: str = "",
        rolled_back_at: datetime | None = None,
    ) -> CalibrationActivation:
        """Restore the previous stable parameter version (explicit approval)."""
        active = self._active_calibration
        if active is None:
            raise TwinError("no active calibration to roll back")
        if not approval_id or not approved_by:
            raise CalibrationApprovalRequired(
                "calibration rollback requires an explicit approval id and actor"
            )
        new_version = self.version + 1
        rollback = CalibrationActivation(
            activation_id=f"cal_{new_version}",
            kind="rollback",
            candidate_id=active.candidate_id,
            candidate_version=active.candidate_version,
            parameter_version=active.previous_parameter_version,
            values=MappingProxyType({}),
            approval_id=approval_id,
            approved_by=approved_by,
            previous_parameter_version=active.parameter_version,
            activated_at=rolled_back_at or self._clock(),
            version=new_version,
        )
        next_state = self._state.copy()
        next_state.active_parameter_version = active.previous_parameter_version
        self._active_calibration = None
        self._commit(rollback, next_state)
        return rollback

    # ------------------------------------------------------------------
    # Replay / rebuild / checkpoints / rollback
    # ------------------------------------------------------------------
    def rebuild(self) -> TwinState:
        """Recompute inferred state from the observed log + inference log."""
        state = _InferredState()
        for step in self._steps:
            state = self._apply_step(state, step, replay=True)
        self._install(state)
        self._recompute_active_calibration()
        return self.state

    def replay(self) -> TwinState:
        """Alias for :meth:`rebuild`: deterministic event-sourcing replay."""
        return self.rebuild()

    def create_checkpoint(
        self, label: str = "", *, created_at: datetime | None = None
    ) -> TwinCheckpoint:
        """Capture a full inferred-state checkpoint at the current version."""
        checkpoint = TwinCheckpoint(
            checkpoint_id=f"ckpt_{len(self._checkpoints) + 1}",
            label=label,
            version=self.version,
            evidence_revision=self.evidence_revision,
            created_at=created_at or self._clock(),
            knowledge=MappingProxyType(dict(self._knowledge)),
            memory=MappingProxyType(dict(self._memory)),
            observed_evidence_ids=self.observed_evidence_ids,
            last_observed_at=self._last_observed_at,
            unresolved_hypotheses=self._unresolved,
            hypothesis_revision=self._hypothesis_revision,
            hypothesis_weights=MappingProxyType(
                dict(self._hypotheses.weights()) if self._hypotheses else {}
            ),
            hypothesis_bound_version=(
                self._hypotheses.bound_twin_version if self._hypotheses else None
            ),
            active_parameter_version=self._active_parameter_version,
        )
        self._checkpoints.append(checkpoint)
        return checkpoint

    def restore_checkpoint(self, checkpoint_id: str) -> TwinState:
        """Restore a checkpoint; the real evidence log is never touched."""
        checkpoint = next(
            (
                item
                for item in self._checkpoints
                if item.checkpoint_id == checkpoint_id
            ),
            None,
        )
        if checkpoint is None:
            raise CheckpointNotFoundError(f"unknown checkpoint {checkpoint_id!r}")
        return self.rollback(checkpoint.version)

    def rollback(self, version: int) -> TwinState:
        """Restore inferred state at ``version``; real evidence is untouched."""
        if isinstance(version, bool) or not isinstance(version, int):
            raise VersionNotFoundError(f"unknown twin version {version}")
        if version < 0 or version > self.version:
            raise VersionNotFoundError(f"unknown twin version {version}")
        self._steps = [step for step in self._steps if step.version <= version]
        self._history = self._history[: version + 1]
        self._hypothesis_bindings = [
            binding
            for binding in self._hypothesis_bindings
            if binding.twin_version <= version
        ]
        self._install(self._history[version].copy())
        self._recompute_active_calibration()
        return self.state

    def snapshot(self) -> TwinState:
        """The current inferred state (backwards-compatible read projection)."""
        return self.state

    def checkpoint_dicts(self) -> tuple[dict[str, Any], ...]:
        return tuple(checkpoint.as_dict() for checkpoint in self._checkpoints)

    # ------------------------------------------------------------------
    # Serialization helpers (still no external dependencies)
    # ------------------------------------------------------------------
    def export_observed_event_ids(self) -> tuple[str, ...]:
        return tuple(e.event_id for e in self._observed_events)

    def export_inference_steps(self) -> tuple[Mapping[str, Any], ...]:
        """A JSON-friendly projection of the inference log (opaque ids only)."""
        exported: list[Mapping[str, Any]] = []
        for step in self._steps:
            if isinstance(step, MasteryUpdate):
                exported.append(
                    MappingProxyType(
                        {
                            "kind": "mastery",
                            "version": step.version,
                            "kcId": step.kc_id,
                            "evidenceIds": list(step.evidence_ids),
                        }
                    )
                )
            elif isinstance(step, MemoryUpdate):
                exported.append(
                    MappingProxyType(
                        {
                            "kind": "memory_review",
                            "version": step.version,
                            "kcId": step.kc_id,
                            "evidenceIds": list(step.evidence_ids),
                        }
                    )
                )
            elif isinstance(step, MemoryDecayUpdate):
                exported.append(
                    MappingProxyType(
                        {
                            "kind": "memory_decay",
                            "version": step.version,
                            "kcIds": sorted(step.states),
                        }
                    )
                )
            elif isinstance(step, CalibrationActivation):
                exported.append(
                    MappingProxyType(
                        {
                            "kind": "calibration_" + step.kind,
                            "version": step.version,
                            "parameterVersion": step.parameter_version,
                        }
                    )
                )
            elif isinstance(step, HypothesisBinding):
                exported.append(
                    MappingProxyType(
                        {
                            "kind": "hypothesis_binding",
                            "version": step.version,
                            "hypothesisRevision": step.hypothesis_revision,
                        }
                    )
                )
        return tuple(exported)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _require_observed_evidence(
        self, evidence_ids: Iterable[str]
    ) -> tuple[str, ...]:
        evidence = tuple(evidence_ids)
        if not evidence:
            raise MissingEvidenceError(
                "an inferred update needs at least one observed evidence id"
            )
        unknown = [e for e in evidence if e not in self._evidence_cursor]
        if unknown:
            raise MissingEvidenceError(
                "update references non-observed evidence: " + ", ".join(unknown)
            )
        return evidence

    def _active_memory_parameters(self) -> MemoryParameters:
        active = self._active_calibration
        if active is None or not active.values:
            return MemoryParameters()
        return MemoryParameters.from_mapping(
            active.values, parameter_version=active.parameter_version
        )

    def _recompute_active_calibration(self) -> None:
        """Derive the active calibration from the (possibly truncated) step log."""
        active: CalibrationActivation | None = None
        for step in self._steps:
            if isinstance(step, CalibrationActivation):
                active = step if step.kind == "activate" else None
        self._active_calibration = active

    def _commit(self, step: Any, next_state: _InferredState) -> None:
        self._steps.append(step)
        self._history.append(next_state.copy())
        self._install(next_state)

    def _install(self, state: _InferredState) -> None:
        self._state = state
        self._knowledge = state.knowledge
        self._memory = state.memory
        self._hypotheses = state.hypotheses
        self._unresolved = state.unresolved
        self._hypothesis_revision = state.hypothesis_revision
        self._active_parameter_version = state.active_parameter_version

    def _apply_step(
        self, state: _InferredState, step: Any, *, replay: bool
    ) -> _InferredState:
        if isinstance(step, MasteryUpdate):
            if replay:
                for evidence_id in step.evidence_ids:
                    if evidence_id not in self._evidence_cursor:
                        raise MissingEvidenceError(
                            f"update {step.update_id!r} references missing evidence"
                        )
            state.knowledge[step.kc_id] = KnowledgeEstimate(
                kc_id=step.kc_id,
                mastery_mean=step.mastery_mean,
                uncertainty=step.uncertainty,
                evidence_ids=step.evidence_ids,
                exposure_state=step.exposure_state,
            )
        elif isinstance(step, MemoryUpdate):
            if replay:
                for evidence_id in step.evidence_ids:
                    if evidence_id not in self._evidence_cursor:
                        raise MissingEvidenceError(
                            f"memory update {step.update_id!r} references "
                            "missing evidence"
                        )
            state.memory[step.kc_id] = step.state
        elif isinstance(step, MemoryDecayUpdate):
            for kc_id, memory_state in step.states.items():
                state.memory[kc_id] = memory_state
        elif isinstance(step, CalibrationActivation):
            state.active_parameter_version = step.parameter_version
        elif isinstance(step, HypothesisBinding):
            hypotheses = (
                step.hypothesis_set.clone() if step.hypothesis_set is not None else None
            )
            state.hypotheses = hypotheses
            state.unresolved = step.unresolved
            state.hypothesis_revision = step.hypothesis_revision
        else:  # pragma: no cover - defensive
            raise TwinError(f"unknown inference step {step!r}")
        return state


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


__all__ = [
    "Event",
    "KnowledgeEstimate",
    "TwinState",
    "MasteryUpdate",
    "MemoryUpdate",
    "MemoryDecayUpdate",
    "HypothesisBinding",
    "PendingCalibration",
    "CalibrationActivation",
    "TwinCheckpoint",
    "HypothesisOperation",
    "StudentTwin",
    "TwinError",
    "SimulatedEventRejected",
    "UnknownEventSource",
    "MissingEvidenceError",
    "StaleSimulationError",
    "VersionNotFoundError",
    "CheckpointNotFoundError",
    "CalibrationApprovalRequired",
    "HypothesisBindingError",
    "REAL_SOURCES",
    "SIMULATED_SOURCES",
    "HYPOTHESIS_OPS",
    "utcnow",
]
