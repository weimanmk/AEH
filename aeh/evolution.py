"""Controlled self-evolution pipeline skeleton (spec section 27).

This module is the **control plane**, not an autonomous self-modifying agent.
It implements the pipeline the specification demands:

``candidate -> isolated evaluation -> explicit approval -> canary -> promote
/ rollback``

with the following hard rules enforced in code:

* a candidate is only a **versioned change record** for ``config`` /
  ``policy`` / ``prompt_template`` content.  It has a source, a change
  summary, and an impact scope, but it cannot name production files, cannot
  carry executable code, and cannot target the protected invariants
  (curriculum/safety gate, permissions, consent, privacy, real/simulated
  isolation, observed-twin writes, self-approval, rollback authority, raw
  student data).  Changing those must go through a separate governance
  process (spec 27.1);
* every candidate is evaluated against a Step 5 ``FrozenEvalSet`` through
  ``EvaluationProtocol`` in an isolated, side-effect-free sandbox.  Simulated
  benefit and real transfer are reported **separately**; a failed or
  evidence-free evaluation auto-rejects the candidate, and simulated gain can
  never be the sole basis for promotion (spec 22.2, 27.4);
* approval is explicit (approver, timestamp, reason), default-deny, and must
  come from a host-side actor other than the candidate's author.  A candidate
  can never approve itself;
* the canary only adjusts the **proportion of synthetic sessions** that see
  the candidate.  It carries circuit-breaker conditions and one-click
  rollback; tripping the breaker rolls back immediately;
* rollback restores the previous stable version and appends a rollback event.
  Only a host-side actor can roll back, and a candidate cannot roll back the
  production system itself;
* every stage appends to one append-only audit log that rejects raw student
  data (payloads, answers, images, traces, names, contact details).

This is a standard-library skeleton.  It performs no production mutation
(``PRODUCTION_MUTATION_ENABLED is False``), opens no file, network, or
database handle, and is exercised only with synthetic fixtures in this
repository.  It is intentionally *not* exposed as a model-callable dsh tool:
approval and rollback are host-side operations.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Callable, Mapping, Sequence

from .evaluation import (
    DEFAULT_REFERENCE_ACCURACY,
    EvaluationError,
    EvaluationProtocol,
    FrozenEvalSet,
    RealOutcome,
    SimulatedOutcome,
)

# ---------------------------------------------------------------------------
# Global safety constants (documented, testable)
# ---------------------------------------------------------------------------

#: This skeleton never mutates a production system; promotion is a recorded
#: decision, not a deployment.
PRODUCTION_MUTATION_ENABLED = False

#: The isolated sandbox has no file, network, database, or production access.
SANDBOX_HAS_PRODUCTION_ACCESS = False

#: This repository only ever runs on synthetic fixtures.
SYNTHETIC_FIXTURES_ONLY = True

#: Candidate kinds are deliberately narrow: versioned configuration, teaching
#: policy, and prompt-template changes only.  Code/plugin candidates are out of
#: scope for this skeleton (spec 27.6 is a separate, human-gated flow).
CANDIDATE_KINDS: tuple[str, ...] = ("config", "policy", "prompt_template")
CANDIDATE_KIND_SET = frozenset(CANDIDATE_KINDS)

#: Where a candidate came from (spec 27.2 DETECT -> PROPOSE).
CANDIDATE_SOURCES: tuple[str, ...] = (
    "drift_detector",
    "error_report",
    "teacher_feedback",
    "eval_regression",
    "tool_failure",
    "cost_report",
    "content_review",
    "human_request",
)
CANDIDATE_SOURCE_SET = frozenset(CANDIDATE_SOURCES)

#: Non-protected surfaces a candidate may declare it affects.
ALLOWED_IMPACT_SCOPES = frozenset(
    {
        "teaching_policy",
        "prompt_template",
        "hint_ladder",
        "item_ordering",
        "diagnostic_probe_policy",
        "review_scheduling",
        "report_template",
        "simulation_parameters",
        "tool_timeout",
        "caching",
    }
)

#: Core invariants that must never be changed by this pipeline (spec 27.1).
#: Any candidate key or impact scope containing one of these tokens is
#: rejected outright; these changes need a separate safety/product process.
PROTECTED_INVARIANTS = frozenset(
    {
        "curriculum_gate",
        "safety_gate",
        "content_verification",
        "permissions",
        "consent",
        "privacy",
        "observed_twin_write",
        "real_simulated_isolation",
        "self_approval",
        "rollback_authority",
        "student_raw_data",
        "database_write",
        "credentials",
        "network",
        "arbitrary_filesystem",
    }
)

#: Host-side roles allowed to approve, start a canary, promote, or roll back.
HOST_ROLES = frozenset(
    {
        "platform_operator",
        "reviewer",
        "security_reviewer",
        "teacher",
        "administrator",
    }
)

# Candidate lifecycle states.
STATUS_PROPOSED = "proposed"
STATUS_EVALUATED = "evaluated"
STATUS_REJECTED = "rejected"
STATUS_APPROVED = "approved"
STATUS_CANARY = "canary"
STATUS_PROMOTED = "promoted"
STATUS_ROLLED_BACK = "rolled_back"

CANDIDATE_STATUSES = (
    STATUS_PROPOSED,
    STATUS_EVALUATED,
    STATUS_REJECTED,
    STATUS_APPROVED,
    STATUS_CANARY,
    STATUS_PROMOTED,
    STATUS_ROLLED_BACK,
)

# Audit actions (aligned with the spec section 22 event vocabulary).
ACTION_CANDIDATE_REGISTERED = "candidate.registered"
ACTION_CANDIDATE_SANDBOXED = "candidate.sandboxed"
ACTION_CANDIDATE_EVALUATED = "candidate.evaluated"
ACTION_CANDIDATE_REJECTED = "candidate.rejected"
ACTION_APPROVAL_RECORDED = "candidate.approved"
ACTION_APPROVAL_REJECTED = "candidate.approval_rejected"
ACTION_CANARY_STARTED = "canary.started"
ACTION_CANARY_OBSERVED = "canary.observed"
ACTION_CANARY_CIRCUIT_BREAKER = "canary.circuit_breaker"
ACTION_CANDIDATE_PROMOTED = "candidate.promoted"
ACTION_ROLLBACK_COMPLETED = "rollback.completed"

#: Recursively-denied audit detail keys; the log must never contain raw
#: student data (spec 20.3, 22.1, 27.5).
AUDIT_FORBIDDEN_KEYS = frozenset(
    {
        "payload",
        "answer",
        "answers",
        "raw",
        "raw_student_data",
        "student_name",
        "student_email",
        "email",
        "phone",
        "address",
        "image",
        "images",
        "solution",
        "trace",
        "steps",
        "transcript",
        "free_text",
    }
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class EvolutionError(Exception):
    """Base class for controlled-evolution errors."""


class CandidateValidationError(EvolutionError, ValueError):
    """A candidate violates the versioned-change-record contract."""


class ProtectedInvariantError(CandidateValidationError):
    """A candidate tries to change an invariant it may not touch."""


class DuplicateCandidateError(CandidateValidationError):
    """A candidate id/version was reused with different content."""


class LifecycleError(EvolutionError):
    """An operation was attempted from the wrong lifecycle state."""


class ApprovalDeniedError(EvolutionError):
    """Approval was missing, forged, or attempted by a non-host actor."""


class CanaryDeniedError(EvolutionError):
    """A canary was requested without approval or with an invalid fraction."""


class RollbackDeniedError(EvolutionError):
    """A rollback was attempted by a candidate or without a reason."""


class AuditError(EvolutionError, ValueError):
    """An audit entry would contain forbidden raw student data."""


# ---------------------------------------------------------------------------
# Small validation helpers
# ---------------------------------------------------------------------------


def _identifier(value: str, field_name: str, *, max_length: int = 128) -> str:
    if not isinstance(value, str) or not value:
        raise CandidateValidationError(f"{field_name} must be a non-empty string")
    if len(value) > max_length:
        raise CandidateValidationError(f"{field_name} is too long")
    if any(character.isspace() for character in value):
        raise CandidateValidationError(f"{field_name} must not contain whitespace")
    return value


def _text(value: str, field_name: str, *, max_length: int = 2000) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CandidateValidationError(f"{field_name} must be a non-empty string")
    if len(value) > max_length:
        raise CandidateValidationError(f"{field_name} is too long")
    return value


def _aware(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise CandidateValidationError(f"{field_name} must be timezone-aware")
    return value


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _assert_declarative(value: Any, path: str) -> None:
    """Reject executable or non-JSON values; candidates are data, not code."""

    if value is None or isinstance(value, (str, bool, int, float)):
        return
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _assert_declarative(item, f"{path}[{index}]")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CandidateValidationError(
                    f"{path} keys must be strings, got {type(key).__name__}"
                )
            _assert_declarative(item, f"{path}.{key}")
        return
    raise CandidateValidationError(
        f"{path} must be declarative JSON data, got {type(value).__name__}"
    )


def _protected_token(text: str) -> str | None:
    normalized = text.strip().lower()
    for invariant in PROTECTED_INVARIANTS:
        if invariant in normalized:
            return invariant
    return None


def _assert_no_protected_keys(value: Any, path: str) -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            token = _protected_token(str(key))
            if token is not None:
                raise ProtectedInvariantError(
                    f"candidate field {path}.{key} touches protected invariant "
                    f"{token!r}; that change needs a separate governance process"
                )
            _assert_no_protected_keys(item, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _assert_no_protected_keys(item, f"{path}[{index}]")


# ---------------------------------------------------------------------------
# Candidate: the only object this pipeline may generate
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """An immutable, versioned configuration/policy/prompt change record.

    ``changes`` is declarative data only.  ``target_files`` must stay empty and
    ``mutates_production`` must stay ``False``: a candidate can describe an
    intended change, it can never itself write a production file.
    """

    candidate_id: str
    version: str
    kind: str
    source: str
    change_summary: str
    impact_scope: tuple[str, ...]
    baseline_version: str
    changes: Mapping[str, Any]
    created_at: datetime
    author: str
    target_files: tuple[str, ...] = ()
    mutates_production: bool = False

    def __post_init__(self) -> None:
        _identifier(self.candidate_id, "candidate_id")
        _identifier(self.version, "version")
        if self.kind not in CANDIDATE_KIND_SET:
            raise CandidateValidationError(
                f"unknown candidate kind {self.kind!r}; "
                f"allowed kinds are {sorted(CANDIDATE_KIND_SET)}"
            )
        if self.source not in CANDIDATE_SOURCE_SET:
            raise CandidateValidationError(
                f"unknown candidate source {self.source!r}; "
                f"allowed sources are {sorted(CANDIDATE_SOURCE_SET)}"
            )
        _text(self.change_summary, "change_summary")
        _identifier(self.baseline_version, "baseline_version")
        _identifier(self.author, "author", max_length=200)
        _aware(self.created_at, "created_at")

        if not isinstance(self.impact_scope, (tuple, list)) or not self.impact_scope:
            raise CandidateValidationError("impact_scope must be a non-empty sequence")
        for scope in self.impact_scope:
            if not isinstance(scope, str) or not scope:
                raise CandidateValidationError("impact_scope entries must be strings")
            token = _protected_token(scope)
            if token is not None:
                raise ProtectedInvariantError(
                    f"impact scope {scope!r} touches protected invariant {token!r}"
                )
            if scope not in ALLOWED_IMPACT_SCOPES:
                raise CandidateValidationError(
                    f"impact scope {scope!r} is not in the allowed evolution "
                    f"surfaces {sorted(ALLOWED_IMPACT_SCOPES)}"
                )

        if self.mutates_production:
            raise CandidateValidationError(
                "a candidate cannot declare production mutation; promotion is a "
                "recorded host decision, not a candidate action"
            )
        if self.target_files:
            raise CandidateValidationError(
                "a candidate cannot name production files; it may only describe "
                "declarative changes for the sandbox"
            )

        if not isinstance(self.changes, Mapping):
            raise CandidateValidationError("changes must be a mapping")
        _assert_declarative(self.changes, "changes")
        _assert_no_protected_keys(self.changes, "changes")

    def key(self) -> tuple[str, str]:
        return (self.candidate_id, self.version)

    def fingerprint(self) -> str:
        return _canonical(
            {
                "candidate_id": self.candidate_id,
                "version": self.version,
                "kind": self.kind,
                "source": self.source,
                "change_summary": self.change_summary,
                "impact_scope": list(self.impact_scope),
                "baseline_version": self.baseline_version,
                "changes": self.changes,
                "created_at": self.created_at.astimezone(timezone.utc).isoformat(),
                "author": self.author,
            }
        )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "version": self.version,
            "kind": self.kind,
            "source": self.source,
            "change_summary": self.change_summary,
            "impact_scope": list(self.impact_scope),
            "baseline_version": self.baseline_version,
            "created_at": self.created_at.astimezone(timezone.utc).isoformat(),
            "author": self.author,
            "mutates_production": self.mutates_production,
            "target_files": [],
        }


# ---------------------------------------------------------------------------
# Append-only audit log
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AuditEntry:
    seq: int
    at: datetime
    actor: str
    action: str
    subject: str
    outcome: str
    detail: Mapping[str, Any]

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "seq": self.seq,
            "at": self.at.astimezone(timezone.utc).isoformat(),
            "actor": self.actor,
            "action": self.action,
            "subject": self.subject,
            "outcome": self.outcome,
            "detail": dict(self.detail),
        }


def _assert_audit_detail(detail: Mapping[str, Any]) -> None:
    if not isinstance(detail, Mapping):
        raise AuditError("audit detail must be a mapping")
    for key, value in detail.items():
        if not isinstance(key, str):
            raise AuditError("audit detail keys must be strings")
        if key.strip().lower() in AUDIT_FORBIDDEN_KEYS:
            raise AuditError(
                f"audit detail key {key!r} would store raw student data; audit "
                "entries may only hold opaque ids, counts, versions, and reasons"
            )
        if isinstance(value, Mapping):
            _assert_audit_detail(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, Mapping):
                    _assert_audit_detail(item)


class AuditLog:
    """Append-only in-memory audit log; there is no update or delete API."""

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        self._entries: list[AuditEntry] = []
        self._seq = 0
        self._now = now or (lambda: datetime.now(timezone.utc))

    def append(
        self,
        *,
        actor: str,
        action: str,
        subject: str,
        outcome: str,
        detail: Mapping[str, Any] | None = None,
    ) -> AuditEntry:
        payload = dict(detail or {})
        _assert_audit_detail(payload)
        self._seq += 1
        entry = AuditEntry(
            seq=self._seq,
            at=self._now(),
            actor=_identifier(actor, "actor", max_length=200),
            action=_text(action, "action", max_length=200),
            subject=_text(subject, "subject", max_length=200),
            outcome=_text(outcome, "outcome", max_length=40),
            detail=MappingProxyType(payload),
        )
        self._entries.append(entry)
        return entry

    def entries(
        self,
        *,
        action: str | None = None,
        subject: str | None = None,
    ) -> tuple[AuditEntry, ...]:
        result = self._entries
        if action is not None:
            result = [entry for entry in result if entry.action == action]
        if subject is not None:
            result = [entry for entry in result if entry.subject == subject]
        return tuple(result)

    def head(self) -> int:
        return self._seq

    def as_list(self) -> tuple[Mapping[str, Any], ...]:
        return tuple(entry.as_dict() for entry in self._entries)


# ---------------------------------------------------------------------------
# Stage 1: candidate registry
# ---------------------------------------------------------------------------


class CandidateRegistry:
    """Append-only, idempotent registry of candidate versions."""

    def __init__(self, audit: AuditLog) -> None:
        self._audit = audit
        self._candidates: dict[tuple[str, str], Candidate] = {}

    def register(self, candidate: Candidate) -> Candidate:
        if not isinstance(candidate, Candidate):
            raise CandidateValidationError("register expects a Candidate")
        key = candidate.key()
        existing = self._candidates.get(key)
        if existing is not None:
            if existing.fingerprint() != candidate.fingerprint():
                raise DuplicateCandidateError(
                    f"candidate {candidate.candidate_id}/{candidate.version} was "
                    "already registered with different content"
                )
            return existing
        self._candidates[key] = candidate
        self._audit.append(
            actor=candidate.author,
            action=ACTION_CANDIDATE_REGISTERED,
            subject=candidate.candidate_id,
            outcome="accepted",
            detail={
                "version": candidate.version,
                "kind": candidate.kind,
                "source": candidate.source,
                "impactScope": list(candidate.impact_scope),
                "baselineVersion": candidate.baseline_version,
            },
        )
        return candidate

    def get(self, candidate_id: str, version: str) -> Candidate | None:
        return self._candidates.get((candidate_id, version))

    def list(self) -> tuple[Candidate, ...]:
        return tuple(self._candidates.values())


# ---------------------------------------------------------------------------
# Stage 2: isolated evaluation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PromotionPolicy:
    """Screening and promotion thresholds.

    Screening may use simulated evidence from the frozen train/explanation
    splits.  Promotion to a stable version additionally requires *real*,
    independently observed transfer evidence: simulated gain alone is never a
    promotion reward (spec 22.2, 27.4).
    """

    min_simulated_items: int = 3
    min_simulated_gain: float = 0.0
    min_real_transfer_items: int = 2
    min_real_transfer_delta: float = 0.0

    def __post_init__(self) -> None:
        if self.min_simulated_items < 1:
            raise CandidateValidationError("min_simulated_items must be >= 1")
        if self.min_real_transfer_items < 1:
            raise CandidateValidationError("min_real_transfer_items must be >= 1")


@dataclass(frozen=True)
class EvaluationVerdict:
    """Separated simulated-benefit and real-transfer evidence for a candidate."""

    candidate_id: str
    candidate_version: str
    dataset_id: str
    dataset_version: str
    dataset_digest: str
    evaluated_at: datetime
    simulated_benefit: Mapping[str, Any] | None
    real_transfer: Mapping[str, Any] | None
    screening_passed: bool
    promotion_ready: bool
    evidence_sufficient: bool
    reasons: tuple[str, ...]
    limitations: tuple[str, ...]

    def real_effect_claim(self) -> str:
        if not self.promotion_ready:
            return (
                "no real transfer evidence supports promotion; simulated gain "
                "alone is not a promotion reward"
            )
        return (
            "real transfer evidence passed the configured threshold, but "
            "without a control group this is descriptive, not causal"
        )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "dataset": {
                "dataset_id": self.dataset_id,
                "version": self.dataset_version,
                "digest": self.dataset_digest,
            },
            "evaluated_at": self.evaluated_at.astimezone(timezone.utc).isoformat(),
            "simulated_benefit": (
                None if self.simulated_benefit is None else dict(self.simulated_benefit)
            ),
            "real_transfer": (
                None if self.real_transfer is None else dict(self.real_transfer)
            ),
            "screening_passed": self.screening_passed,
            "promotion_ready": self.promotion_ready,
            "evidence_sufficient": self.evidence_sufficient,
            "reasons": list(self.reasons),
            "limitations": list(self.limitations),
            "claim": self.real_effect_claim(),
        }


class IsolatedSandbox:
    """Evaluate one candidate against a frozen set, with no external effects.

    The sandbox wraps the Step 5 ``EvaluationProtocol``.  It never opens a
    file, network socket, or database, and it reports the simulated and real
    channels separately.  A split-isolation or self-proof violation is turned
    into a failed verdict (which the control plane auto-rejects) rather than
    escaping as an unhandled error.
    """

    def __init__(
        self,
        frozen_set: FrozenEvalSet,
        *,
        policy: PromotionPolicy | None = None,
        reference_accuracy: float = DEFAULT_REFERENCE_ACCURACY,
    ) -> None:
        if not isinstance(frozen_set, FrozenEvalSet):
            raise CandidateValidationError("sandbox requires a FrozenEvalSet")
        self.frozen_set = frozen_set
        self.policy = policy or PromotionPolicy()
        self._protocol = EvaluationProtocol(
            frozen_set, reference_accuracy=reference_accuracy
        )

    def evaluate(
        self,
        candidate: Candidate,
        *,
        simulated_outcomes: Sequence[SimulatedOutcome] = (),
        real_outcomes: Sequence[RealOutcome] = (),
        evaluated_at: datetime | None = None,
    ) -> EvaluationVerdict:
        if not isinstance(candidate, Candidate):
            raise CandidateValidationError("sandbox only evaluates Candidate records")
        stamp = evaluated_at or datetime.now(timezone.utc)
        _aware(stamp, "evaluated_at")
        frozen = self.frozen_set

        try:
            run = self._protocol.run(
                simulated_outcomes=simulated_outcomes,
                real_outcomes=real_outcomes,
                generated_at=stamp,
            )
        except EvaluationError as exc:
            return self._failed_verdict(
                candidate,
                stamp,
                f"evaluation_rejected:{type(exc).__name__}",
            )

        simulated = (
            None if run.simulated_benefit is None else run.simulated_benefit.as_dict()
        )
        transfer = None if run.real_transfer is None else run.real_transfer.as_dict()

        reasons: list[str] = []
        simulated_ok = False
        real_ok = False

        if run.simulated_benefit is not None:
            benefit = run.simulated_benefit
            if benefit.item_count < self.policy.min_simulated_items:
                reasons.append("screening_failed:too_few_simulated_items")
            elif benefit.simulated_gain < self.policy.min_simulated_gain:
                reasons.append("screening_failed:simulated_gain_below_threshold")
            else:
                simulated_ok = True
        if run.real_transfer is not None:
            real = run.real_transfer
            if real.item_count < self.policy.min_real_transfer_items:
                reasons.append("real_transfer_failed:too_few_items")
            elif real.observed_delta < self.policy.min_real_transfer_delta:
                reasons.append("real_transfer_failed:delta_below_threshold")
            else:
                real_ok = True
                if not real.all_items_unseen:
                    real_ok = False
                    reasons.append("real_transfer_failed:item_was_seen")

        if run.simulated_benefit is None and run.real_transfer is None:
            reasons.append("evidence_insufficient:no_simulated_or_real_outcomes")
        elif run.simulated_benefit is None:
            reasons.append("screening_skipped:no_simulated_evidence")

        if run.real_transfer is None:
            reasons.append("promotion_blocked:real_transfer_evidence_missing")

        evidence_sufficient = (
            run.simulated_benefit is not None
            and run.simulated_benefit.item_count >= self.policy.min_simulated_items
        ) or (
            run.real_transfer is not None
            and run.real_transfer.item_count >= self.policy.min_real_transfer_items
        )
        # A failing real-transfer signal rejects the candidate even when the
        # simulated screen looked good: simulation can never override observed
        # evidence against the candidate.
        real_failed = run.real_transfer is not None and not real_ok
        screening_passed = (simulated_ok or real_ok) and not real_failed

        return EvaluationVerdict(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            dataset_id=frozen.dataset_id,
            dataset_version=frozen.version,
            dataset_digest=frozen.digest,
            evaluated_at=stamp,
            simulated_benefit=simulated,
            real_transfer=transfer,
            screening_passed=screening_passed,
            promotion_ready=real_ok,
            evidence_sufficient=evidence_sufficient,
            reasons=tuple(reasons),
            limitations=tuple(run.limitations),
        )

    def _failed_verdict(
        self,
        candidate: Candidate,
        stamp: datetime,
        reason: str,
    ) -> EvaluationVerdict:
        frozen = self.frozen_set
        return EvaluationVerdict(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            dataset_id=frozen.dataset_id,
            dataset_version=frozen.version,
            dataset_digest=frozen.digest,
            evaluated_at=stamp,
            simulated_benefit=None,
            real_transfer=None,
            screening_passed=False,
            promotion_ready=False,
            evidence_sufficient=False,
            reasons=(reason,),
            limitations=(
                "evaluation failed before producing a separated report",
                "synthetic fixtures only; no real student data is used",
            ),
        )


# ---------------------------------------------------------------------------
# Stage 3: approval and canary
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Actor:
    """A host-side actor. A candidate's own author is never an approver."""

    actor_id: str
    role: str

    def __post_init__(self) -> None:
        _identifier(self.actor_id, "actor_id", max_length=200)
        _text(self.role, "role", max_length=60)

    def is_host_side(self) -> bool:
        return self.role in HOST_ROLES


@dataclass(frozen=True)
class ApprovalRecord:
    """Explicit, auditable approval decision; approval is default-deny."""

    candidate_id: str
    candidate_version: str
    decision: str
    approved_by: str
    decided_at: datetime
    reason: str
    role: str = "reviewer"

    def __post_init__(self) -> None:
        _identifier(self.candidate_id, "candidate_id")
        _identifier(self.candidate_version, "candidate_version")
        if self.decision not in ("approved", "rejected"):
            raise CandidateValidationError(
                "approval decision must be 'approved' or 'rejected'"
            )
        _identifier(self.approved_by, "approved_by", max_length=200)
        _aware(self.decided_at, "decided_at")
        _text(self.reason, "reason")

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "decision": self.decision,
            "approved_by": self.approved_by,
            "decided_at": self.decided_at.astimezone(timezone.utc).isoformat(),
            "reason": self.reason,
            "role": self.role,
        }


@dataclass(frozen=True)
class CanaryConditions:
    """Circuit-breaker conditions for a synthetic-session canary."""

    max_regression: float = 0.05
    max_error_rate: float = 0.2
    min_samples: int = 5
    max_duration_minutes: int = 60

    def __post_init__(self) -> None:
        for name in ("max_regression", "max_error_rate"):
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise CandidateValidationError(f"{name} must be a number")
            if value < 0:
                raise CandidateValidationError(f"{name} must be >= 0")
        if self.min_samples < 1:
            raise CandidateValidationError("min_samples must be >= 1")
        if self.max_duration_minutes < 1:
            raise CandidateValidationError("max_duration_minutes must be >= 1")


@dataclass
class CanaryState:
    candidate_id: str
    candidate_version: str
    fraction: float
    started_at: datetime
    conditions: CanaryConditions
    synthetic_only: bool = True
    status: str = "running"
    samples_seen: int = 0

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "fraction": self.fraction,
            "synthetic_only": self.synthetic_only,
            "status": self.status,
            "samples_seen": self.samples_seen,
            "started_at": self.started_at.astimezone(timezone.utc).isoformat(),
            "conditions": {
                "max_regression": self.conditions.max_regression,
                "max_error_rate": self.conditions.max_error_rate,
                "min_samples": self.conditions.min_samples,
                "max_duration_minutes": self.conditions.max_duration_minutes,
            },
        }


@dataclass(frozen=True)
class CanaryObservation:
    """One circuit-breaker sample over synthetic canary sessions."""

    regression: float
    error_rate: float
    sample_count: int
    observed_at: datetime

    def __post_init__(self) -> None:
        for name in ("regression", "error_rate"):
            value = getattr(self, name)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise CandidateValidationError(f"{name} must be a number")
        if self.sample_count < 1:
            raise CandidateValidationError("sample_count must be >= 1")
        _aware(self.observed_at, "observed_at")


@dataclass(frozen=True)
class CanaryObservationResult:
    candidate_id: str
    candidate_version: str
    sample_count: int
    regression: float
    error_rate: float
    tripped: bool
    reasons: tuple[str, ...]
    rollback: "RollbackEvent | None"

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "sample_count": self.sample_count,
            "regression": self.regression,
            "error_rate": self.error_rate,
            "tripped": self.tripped,
            "reasons": list(self.reasons),
            "rollback": None if self.rollback is None else self.rollback.as_dict(),
        }


# ---------------------------------------------------------------------------
# Stage 4: rollback
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RollbackEvent:
    candidate_id: str
    candidate_version: str
    from_version: str
    to_version: str
    actor: str
    reason: str
    triggered_by: str
    rolled_back_at: datetime

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "candidate_version": self.candidate_version,
            "from_version": self.from_version,
            "to_version": self.to_version,
            "actor": self.actor,
            "reason": self.reason,
            "triggered_by": self.triggered_by,
            "rolled_back_at": self.rolled_back_at.astimezone(timezone.utc).isoformat(),
        }


# ---------------------------------------------------------------------------
# Candidate record and control plane
# ---------------------------------------------------------------------------


@dataclass
class CandidateRecord:
    candidate: Candidate
    status: str
    registered_at: datetime
    updated_at: datetime
    evaluation: EvaluationVerdict | None = None
    approval: ApprovalRecord | None = None
    canary: CanaryState | None = None
    rollback: RollbackEvent | None = None
    previous_stable_version: str | None = None

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "candidate": self.candidate.as_dict(),
            "status": self.status,
            "registered_at": self.registered_at.astimezone(timezone.utc).isoformat(),
            "updated_at": self.updated_at.astimezone(timezone.utc).isoformat(),
            "evaluation": (
                None if self.evaluation is None else self.evaluation.as_dict()
            ),
            "approval": None if self.approval is None else self.approval.as_dict(),
            "canary": None if self.canary is None else self.canary.as_dict(),
            "rollback": None if self.rollback is None else self.rollback.as_dict(),
            "previous_stable_version": self.previous_stable_version,
        }


class EvolutionControlPlane:
    """The controlled candidate -> evaluation -> approval -> canary pipeline.

    All methods are host-side.  There is intentionally no method that lets a
    candidate approve itself, roll itself back, or apply itself to production.
    """

    def __init__(
        self,
        frozen_set: FrozenEvalSet,
        *,
        policy: PromotionPolicy | None = None,
        reference_accuracy: float = DEFAULT_REFERENCE_ACCURACY,
        audit: AuditLog | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.audit = audit or AuditLog(now=self._now)
        self.registry = CandidateRegistry(self.audit)
        self.sandbox = IsolatedSandbox(
            frozen_set,
            policy=policy,
            reference_accuracy=reference_accuracy,
        )
        self.policy = self.sandbox.policy
        self._records: dict[tuple[str, str], CandidateRecord] = {}
        self._stable_versions: dict[str, str] = {}

    # -- queries -----------------------------------------------------------

    def status(self, candidate_id: str, version: str) -> str | None:
        record = self._records.get((candidate_id, version))
        return None if record is None else record.status

    def record(self, candidate_id: str, version: str) -> CandidateRecord:
        return self._require_record(candidate_id, version)

    def stable_version(self, candidate_id: str) -> str | None:
        return self._stable_versions.get(candidate_id)

    def list_records(self) -> tuple[CandidateRecord, ...]:
        return tuple(self._records.values())

    def pipeline_snapshot(self) -> Mapping[str, Any]:
        return {
            "production_mutation_enabled": PRODUCTION_MUTATION_ENABLED,
            "sandbox_has_production_access": SANDBOX_HAS_PRODUCTION_ACCESS,
            "synthetic_fixtures_only": SYNTHETIC_FIXTURES_ONLY,
            "dataset": self.sandbox.frozen_set.summary(),
            "candidates": [record.as_dict() for record in self._records.values()],
            "stable_versions": dict(self._stable_versions),
            "audit_head": self.audit.head(),
        }

    # -- stage 1: propose/register ----------------------------------------

    def propose(self, candidate: Candidate, actor: Actor) -> CandidateRecord:
        registered = self.registry.register(candidate)
        stamp = self._now()
        key = registered.key()
        existing = self._records.get(key)
        if existing is not None:
            return existing
        record = CandidateRecord(
            candidate=registered,
            status=STATUS_PROPOSED,
            registered_at=stamp,
            updated_at=stamp,
        )
        self._records[key] = record
        self._stable_versions.setdefault(
            registered.candidate_id, registered.baseline_version
        )
        self._touch(record)
        return record

    # -- stage 2: isolated evaluation -------------------------------------

    def evaluate(
        self,
        candidate_id: str,
        version: str,
        *,
        actor: Actor,
        simulated_outcomes: Sequence[SimulatedOutcome] = (),
        real_outcomes: Sequence[RealOutcome] = (),
        evaluated_at: datetime | None = None,
    ) -> EvaluationVerdict:
        record = self._require_record(candidate_id, version)
        if record.status not in (STATUS_PROPOSED, STATUS_EVALUATED):
            raise LifecycleError(
                f"cannot evaluate candidate in status {record.status!r}"
            )
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CANDIDATE_SANDBOXED,
            subject=candidate_id,
            outcome="accepted",
            detail={"version": version},
        )
        verdict = self.sandbox.evaluate(
            record.candidate,
            simulated_outcomes=simulated_outcomes,
            real_outcomes=real_outcomes,
            evaluated_at=evaluated_at or self._now(),
        )
        record.evaluation = verdict
        if verdict.screening_passed:
            record.status = STATUS_EVALUATED
        else:
            record.status = STATUS_REJECTED
        self._touch(record)
        self.audit.append(
            actor=actor.actor_id,
            action=(
                ACTION_CANDIDATE_EVALUATED
                if verdict.screening_passed
                else ACTION_CANDIDATE_REJECTED
            ),
            subject=candidate_id,
            outcome="accepted" if verdict.screening_passed else "rejected",
            detail={
                "version": version,
                "datasetDigest": verdict.dataset_digest,
                "screeningPassed": verdict.screening_passed,
                "promotionReady": verdict.promotion_ready,
                "evidenceSufficient": verdict.evidence_sufficient,
                "reasons": list(verdict.reasons),
            },
        )
        return verdict

    # -- stage 3: approval -------------------------------------------------

    def approve(
        self,
        candidate_id: str,
        version: str,
        approval: ApprovalRecord | None,
        actor: Actor,
    ) -> CandidateRecord:
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
        if approval.decision == "rejected":
            record.approval = approval
            record.status = STATUS_REJECTED
            self._touch(record)
            self.audit.append(
                actor=actor.actor_id,
                action=ACTION_APPROVAL_REJECTED,
                subject=candidate_id,
                outcome="rejected",
                detail={"version": version, "reason": approval.reason},
            )
            return record
        if approval.approved_by != actor.actor_id:
            raise ApprovalDeniedError(
                "approval record approved_by must match the acting reviewer"
            )
        if approval.role not in HOST_ROLES:
            raise ApprovalDeniedError(
                f"approval role {approval.role!r} is not a host-side role"
            )
        record.approval = approval
        record.status = STATUS_APPROVED
        self._touch(record)
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_APPROVAL_RECORDED,
            subject=candidate_id,
            outcome="accepted",
            detail={
                "version": version,
                "decision": approval.decision,
                "role": approval.role,
                "reason": approval.reason,
                "decidedAt": approval.decided_at.astimezone(
                    timezone.utc
                ).isoformat(),
            },
        )
        return record

    # -- stage 3b: canary --------------------------------------------------

    def start_canary(
        self,
        candidate_id: str,
        version: str,
        *,
        fraction: float,
        actor: Actor,
        conditions: CanaryConditions | None = None,
    ) -> CanaryState:
        record = self._require_record(candidate_id, version)
        if record.status != STATUS_APPROVED:
            raise CanaryDeniedError(
                "canary requires an explicitly approved candidate; "
                f"current status is {record.status!r}"
            )
        self._assert_host_actor(actor, record, CanaryDeniedError)
        if (
            not isinstance(fraction, (int, float))
            or isinstance(fraction, bool)
            or not 0.0 < float(fraction) <= 1.0
        ):
            raise CanaryDeniedError("canary fraction must be in (0, 1]")
        state = CanaryState(
            candidate_id=candidate_id,
            candidate_version=version,
            fraction=float(fraction),
            started_at=self._now(),
            conditions=conditions or CanaryConditions(),
            synthetic_only=True,
        )
        record.canary = state
        record.status = STATUS_CANARY
        self._touch(record)
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CANARY_STARTED,
            subject=candidate_id,
            outcome="accepted",
            detail={
                "version": version,
                "fraction": state.fraction,
                "syntheticOnly": True,
                "conditions": state.as_dict()["conditions"],
            },
        )
        return state

    def observe_canary(
        self,
        candidate_id: str,
        version: str,
        observation: CanaryObservation,
        actor: Actor,
    ) -> CanaryObservationResult:
        record = self._require_record(candidate_id, version)
        if record.status != STATUS_CANARY or record.canary is None:
            raise LifecycleError("canary observations require a running canary")
        self._assert_host_actor(actor, record, CanaryDeniedError)
        state = record.canary
        state.samples_seen += observation.sample_count

        reasons: list[str] = []
        tripped = False
        if observation.sample_count >= state.conditions.min_samples:
            if observation.regression > state.conditions.max_regression:
                tripped = True
                reasons.append("circuit_breaker:regression_exceeded")
            if observation.error_rate > state.conditions.max_error_rate:
                tripped = True
                reasons.append("circuit_breaker:error_rate_exceeded")

        rollback_event: RollbackEvent | None = None
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CANARY_OBSERVED,
            subject=candidate_id,
            outcome="rejected" if tripped else "accepted",
            detail={
                "version": version,
                "sampleCount": observation.sample_count,
                "regression": observation.regression,
                "errorRate": observation.error_rate,
                "tripped": tripped,
            },
        )
        if tripped:
            state.status = "circuit_breaker"
            self.audit.append(
                actor=actor.actor_id,
                action=ACTION_CANARY_CIRCUIT_BREAKER,
                subject=candidate_id,
                outcome="rejected",
                detail={"version": version, "reasons": list(reasons)},
            )
            rollback_event = self.rollback(
                candidate_id,
                version,
                actor=actor,
                reason="circuit breaker: " + ", ".join(reasons),
                triggered_by="circuit_breaker",
            )
        return CanaryObservationResult(
            candidate_id=candidate_id,
            candidate_version=version,
            sample_count=observation.sample_count,
            regression=observation.regression,
            error_rate=observation.error_rate,
            tripped=tripped,
            reasons=tuple(reasons),
            rollback=rollback_event,
        )

    # -- stage 3c: promote -------------------------------------------------

    def promote(
        self,
        candidate_id: str,
        version: str,
        *,
        actor: Actor,
    ) -> CandidateRecord:
        record = self._require_record(candidate_id, version)
        if record.status != STATUS_CANARY:
            raise LifecycleError("promotion requires a running canary")
        self._assert_host_actor(actor, record, ApprovalDeniedError)
        verdict = record.evaluation
        if verdict is None or not verdict.promotion_ready:
            raise EvolutionError(
                "promotion requires real, independent transfer evidence above "
                "threshold; simulated gain alone is not a promotion reward"
            )
        record.previous_stable_version = self._stable_versions.get(
            candidate_id, record.candidate.baseline_version
        )
        self._stable_versions[candidate_id] = version
        record.status = STATUS_PROMOTED
        if record.canary is not None:
            record.canary.status = "promoted"
        self._touch(record)
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_CANDIDATE_PROMOTED,
            subject=candidate_id,
            outcome="accepted",
            detail={
                "version": version,
                "previousStableVersion": record.previous_stable_version,
                "realTransferDelta": verdict.real_transfer.get("observed_delta")
                if verdict.real_transfer is not None
                else None,
            },
        )
        return record

    # -- stage 4: rollback -------------------------------------------------

    def rollback(
        self,
        candidate_id: str,
        version: str,
        *,
        actor: Actor,
        reason: str,
        triggered_by: str = "human",
    ) -> RollbackEvent:
        record = self._require_record(candidate_id, version)
        self._assert_host_actor(actor, record, RollbackDeniedError)
        _text(reason, "reason")
        if triggered_by not in ("human", "circuit_breaker"):
            raise RollbackDeniedError(
                "triggered_by must be 'human' or 'circuit_breaker'"
            )
        if record.status not in (STATUS_CANARY, STATUS_PROMOTED):
            raise LifecycleError(
                f"nothing to roll back from status {record.status!r}"
            )
        current_stable = self._stable_versions.get(candidate_id)
        target = (
            record.previous_stable_version
            or record.candidate.baseline_version
        )
        if current_stable == target and record.status != STATUS_CANARY:
            # A promoted version is never equal to its baseline; guard anyway.
            target = record.candidate.baseline_version
        self._stable_versions[candidate_id] = target
        record.status = STATUS_ROLLED_BACK
        if record.canary is not None:
            record.canary.status = "rolled_back"
        event = RollbackEvent(
            candidate_id=candidate_id,
            candidate_version=version,
            from_version=current_stable or version,
            to_version=target,
            actor=actor.actor_id,
            reason=reason,
            triggered_by=triggered_by,
            rolled_back_at=self._now(),
        )
        record.rollback = event
        self._touch(record)
        self.audit.append(
            actor=actor.actor_id,
            action=ACTION_ROLLBACK_COMPLETED,
            subject=candidate_id,
            outcome="accepted",
            detail={
                "version": version,
                "fromVersion": event.from_version,
                "toVersion": event.to_version,
                "triggeredBy": triggered_by,
                "reason": reason,
            },
        )
        return event

    # -- internal ----------------------------------------------------------

    def _require_record(self, candidate_id: str, version: str) -> CandidateRecord:
        record = self._records.get((candidate_id, version))
        if record is None:
            raise LifecycleError(
                f"unknown candidate {candidate_id!r} version {version!r}"
            )
        return record

    def _assert_host_actor(
        self,
        actor: Actor,
        record: CandidateRecord,
        error_type: type[EvolutionError],
    ) -> None:
        if not actor.is_host_side():
            raise error_type(
                f"role {actor.role!r} is not a host-side role; candidates cannot "
                "approve, run canaries, promote, or roll back themselves"
            )
        if actor.actor_id == record.candidate.author or (
            actor.actor_id == record.candidate.candidate_id
        ):
            raise error_type(
                "a candidate cannot approve, promote, or roll back itself"
            )

    def _touch(self, record: CandidateRecord) -> None:
        record.updated_at = self._now()


__all__ = [
    "PRODUCTION_MUTATION_ENABLED",
    "SANDBOX_HAS_PRODUCTION_ACCESS",
    "SYNTHETIC_FIXTURES_ONLY",
    "CANDIDATE_KINDS",
    "CANDIDATE_SOURCES",
    "ALLOWED_IMPACT_SCOPES",
    "PROTECTED_INVARIANTS",
    "HOST_ROLES",
    "STATUS_PROPOSED",
    "STATUS_EVALUATED",
    "STATUS_REJECTED",
    "STATUS_APPROVED",
    "STATUS_CANARY",
    "STATUS_PROMOTED",
    "STATUS_ROLLED_BACK",
    "EvolutionError",
    "CandidateValidationError",
    "ProtectedInvariantError",
    "DuplicateCandidateError",
    "LifecycleError",
    "ApprovalDeniedError",
    "CanaryDeniedError",
    "RollbackDeniedError",
    "AuditError",
    "Candidate",
    "AuditEntry",
    "AuditLog",
    "CandidateRegistry",
    "PromotionPolicy",
    "EvaluationVerdict",
    "IsolatedSandbox",
    "Actor",
    "ApprovalRecord",
    "CanaryConditions",
    "CanaryState",
    "CanaryObservation",
    "CanaryObservationResult",
    "RollbackEvent",
    "CandidateRecord",
    "EvolutionControlPlane",
]
