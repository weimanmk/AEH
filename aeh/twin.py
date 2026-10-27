"""Long-term student twin with event sourcing (spec section 5).

Design constraints implemented here:

* Real observations are append-only and immutable.  A correction is a *new*
  event, never an edit or a delete of history.
* Inferred state (knowledge estimates) is derived from an ordered inference
  log plus the real evidence log, so it can be rebuilt deterministically.
* Inferred state is versioned and can be rolled back without touching the
  immutable real evidence.
* Simulated events live in a separate store and can never write ``observed_*``
  evidence or mastery.  Stale simulations can never auto-override newer state.
* Every mastery update must reference real evidence ids that actually exist.

Standard library only.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping

#: Sources that may write real (observed) evidence.
REAL_SOURCES: frozenset[str] = frozenset(
    {"student", "teacher", "trusted_grader", "assessment"}
)
#: Sources that belong to the isolated simulation world.
SIMULATED_SOURCES: frozenset[str] = frozenset(
    {"simulated", "virtual_student", "simulation"}
)

SCHEMA_VERSION = "aeh-event-v1"


class TwinError(Exception):
    """Base class for twin errors."""


class SimulatedEventRejected(TwinError):
    """A simulated event tried to enter the observed (real) store."""


class UnknownEventSource(TwinError):
    """The event source is neither a trusted real source nor a simulator."""


class MissingEvidenceError(TwinError):
    """A mastery update referenced evidence that does not exist as real data."""


class StaleSimulationError(TwinError):
    """A simulation based on an older revision tried to override newer state."""


class VersionNotFoundError(TwinError):
    """Rollback target version does not exist."""


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


class StudentTwin:
    """Event-sourced, versioned, rollbackable long-term student twin."""

    def __init__(self, student_id: str) -> None:
        self.student_id = student_id
        self._observed_events: list[Event] = []
        self._simulated_events: list[Event] = []
        self._updates: list[MasteryUpdate] = []
        self._evidence_cursor: set[str] = set()
        self._last_observed_at: datetime | None = None
        self._knowledge: dict[str, KnowledgeEstimate] = {}
        self._history: list[Mapping[str, KnowledgeEstimate]] = [
            MappingProxyType({})
        ]
        self._unresolved: tuple[str, ...] = ()

    # ------------------------------------------------------------------
    # Read-only views
    # ------------------------------------------------------------------
    @property
    def version(self) -> int:
        """Version of the inferred state (number of committed updates)."""
        return len(self._updates)

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
        )

    def observed_events(self) -> tuple[Event, ...]:
        return tuple(self._observed_events)

    def simulated_events(self) -> tuple[Event, ...]:
        return tuple(self._simulated_events)

    def knowledge_for(self, kc_id: str) -> KnowledgeEstimate | None:
        return self._knowledge.get(kc_id)

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
        evidence = tuple(evidence_ids)
        if not evidence:
            raise MissingEvidenceError("mastery update needs at least one evidence id")
        unknown = [e for e in evidence if e not in self._evidence_cursor]
        if unknown:
            raise MissingEvidenceError(
                "mastery update references non-observed evidence: "
                + ", ".join(unknown)
            )
        update = MasteryUpdate(
            update_id=f"upd_{self.version + 1}",
            kc_id=kc_id,
            mastery_mean=float(mastery_mean),
            uncertainty=float(uncertainty),
            evidence_ids=evidence,
            exposure_state=exposure_state,
            version=self.version + 1,
        )
        estimate = KnowledgeEstimate(
            kc_id=kc_id,
            mastery_mean=update.mastery_mean,
            uncertainty=update.uncertainty,
            evidence_ids=evidence,
            exposure_state=exposure_state,
        )
        self._updates.append(update)
        self._knowledge[kc_id] = estimate
        self._history.append(MappingProxyType(dict(self._knowledge)))
        return estimate

    def set_unresolved_hypotheses(self, hypothesis_ids: Iterable[str]) -> None:
        self._unresolved = tuple(hypothesis_ids)

    def rebuild(self) -> TwinState:
        """Recompute inferred state from the observed log + inference log."""
        knowledge: dict[str, KnowledgeEstimate] = {}
        for update in self._updates:
            # Evidence validity is re-checked so rebuild can never invent it.
            if any(e not in self._evidence_cursor for e in update.evidence_ids):
                raise MissingEvidenceError(
                    f"update {update.update_id!r} references missing evidence"
                )
            knowledge[update.kc_id] = KnowledgeEstimate(
                kc_id=update.kc_id,
                mastery_mean=update.mastery_mean,
                uncertainty=update.uncertainty,
                evidence_ids=update.evidence_ids,
                exposure_state=update.exposure_state,
            )
        self._knowledge = knowledge
        return self.state

    def rollback(self, version: int) -> TwinState:
        """Restore inferred knowledge at ``version``; real evidence is untouched."""
        if version < 0 or version >= len(self._history):
            raise VersionNotFoundError(f"unknown twin version {version}")
        self._updates = [u for u in self._updates if u.version <= version]
        # Discard the rolled-back branch of the inference log so that a later
        # update starts a new branch at the next version and can itself be
        # rolled back.  Real evidence is never touched by this.
        self._history = self._history[: version + 1]
        self._knowledge = dict(self._history[version])
        return self.state

    def snapshot(self) -> TwinState:
        return self.state

    # ------------------------------------------------------------------
    # Serialization helpers (still no external dependencies)
    # ------------------------------------------------------------------
    def export_observed_event_ids(self) -> tuple[str, ...]:
        return tuple(e.event_id for e in self._observed_events)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


__all__ = [
    "Event",
    "KnowledgeEstimate",
    "TwinState",
    "MasteryUpdate",
    "StudentTwin",
    "TwinError",
    "SimulatedEventRejected",
    "UnknownEventSource",
    "MissingEvidenceError",
    "StaleSimulationError",
    "VersionNotFoundError",
    "REAL_SOURCES",
    "SIMULATED_SOURCES",
    "utcnow",
]
