"""Privacy, minor protection, retention/deletion propagation, audit export and
the metrics/cost dashboard (spec sections 20 and 21).

Step 17 of ``TASKS.md``.  This module is the standard-library Python reference
for five related boundaries:

1. **Consent records** (spec section 21.2).  :class:`ConsentEvent` is an
   append-only grant/revoke event; :class:`ConsentLedger` folds them into the
   effective scope set at a point in time.  Revocation never rewrites history
   and reads are fail-closed.  For a minor, guardian-required scopes need an
   active *guardian* grant, not a self-grant.
2. **Minor protection and audience restriction** (spec sections 21.2 / 20.3).
   :func:`authorized_audience_scopes` intersects the audience default with the
   subject's active consent, requires guardian consent for minors, and removes
   scopes that are never allowed for minors (for example research export).
3. **Retention and cross-store deletion propagation** (spec section 21.2).
   :class:`RetentionPolicy` gives every declared data class a retention window;
   :func:`expired_records` turns stored records into retention dues and
   :class:`DeletionCoordinator` propagates a deletion request to every
   registered store, producing a per-store receipt.  A store that fails makes
   the whole request ``partial``/``failed`` instead of a silent success, and a
   deleted subject is read-blocked afterwards.
4. **Audit export** (spec section 20.3).  :func:`export_audit` filters the
   append-only audit entries into a deterministic window, strips the
   pseudonymous dimensions unless explicitly requested, and returns a manifest
   plus a JSONL payload with a content digest.  Raw student content can never be
   represented because :class:`AuditEntry` only holds scalars and rejects the
   same forbidden key set as the TypeScript host audit log.
5. **Metrics dashboard and cost estimation** (spec sections 20.1 / 20.2).
   :class:`MetricsDashboard` aggregates learning / system / cost samples per
   channel; a simulated sample can never enter a channel where the metric is not
   explicitly cross-channel, and small student cohorts are suppressed in
   breakdowns.  :class:`CostEstimator` is an explicitly synthetic price book:
   ``BILLING_CONNECTED`` is always ``False`` and no real billing is performed.

Only synthetic data is used by the tests.  This is a policy/reference model, not
a production identity, storage or billing service: real deployments still need
an authenticated identity provider, KMS-managed secrets, tamper-evident storage
and jurisdiction-specific legal review.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping

Scalar = str | int | float | bool | None

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PrivacyError(Exception):
    """Base class for privacy / metrics errors."""


class ValidationError(PrivacyError, ValueError):
    """A value object is malformed or contains an unsafe field."""


class ConsentError(PrivacyError):
    """A consent grant is missing, revoked or inconsistent (fail-closed)."""


class AudienceRestrictionError(PrivacyError):
    """An audience asked for a scope it may not use for this subject."""


class RetentionError(PrivacyError, ValueError):
    """A retention policy is incomplete or malformed."""


class DeletionError(PrivacyError):
    """A deletion request could not be propagated as specified."""


class AuditExportError(PrivacyError, ValueError):
    """An audit export request is invalid or unsupported."""


class MetricsError(PrivacyError, ValueError):
    """A metric sample or dashboard operation is invalid."""


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------

_WS = " \t\r\n"


def _identifier(value: Any, field_name: str, *, max_length: int = 128) -> str:
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{field_name} must be a non-empty string")
    if len(value) > max_length:
        raise ValidationError(f"{field_name} is too long")
    if any(character.isspace() for character in value):
        raise ValidationError(f"{field_name} must not contain whitespace")
    return value


def _short_label(value: Any, field_name: str, *, max_length: int = 80) -> str:
    return _identifier(value, field_name, max_length=max_length)


def _aware(value: Any, field_name: str) -> datetime:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValidationError(f"{field_name} must be an ISO timestamp") from exc
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValidationError(f"{field_name} must be timezone-aware")
    if value.utcoffset() is None:
        raise ValidationError(f"{field_name} must have a UTC offset")
    return value


def _iso_utc(value: datetime) -> str:
    """Canonical UTC millisecond timestamp (matches the TypeScript mirror)."""

    _aware(value, "timestamp")
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _non_negative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError(f"{field_name} must be a non-negative integer")
    return value


def _non_negative_float(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{field_name} must be a non-negative number")
    result = float(value)
    if not math.isfinite(result) or result < 0.0:
        raise ValidationError(f"{field_name} must be finite and >= 0")
    return result


def _finite_float(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{field_name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValidationError(f"{field_name} must be finite")
    return result


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValidationError("non-finite number cannot be serialised")
        return value
    if isinstance(value, datetime):
        return _iso_utc(value)
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [_jsonable(item) for item in sorted(value, key=str)]
    raise ValidationError(f"unsupported value of type {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Deterministic JSON shared by the Python and TypeScript implementations."""

    return json.dumps(
        _jsonable(value), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


def content_digest(value: Any) -> str:
    """SHA-256 hex digest of the canonical JSON form of ``value``."""

    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _round(value: float, digits: int = 6) -> float:
    return round(value, digits)


# ---------------------------------------------------------------------------
# 1. Consent records (spec section 21.2)
# ---------------------------------------------------------------------------

SUBJECT_GUARDIAN = "guardian"
SUBJECT_STUDENT = "student"
SUBJECT_SCHOOL = "school"
CONSENT_SUBJECTS: frozenset[str] = frozenset(
    {SUBJECT_GUARDIAN, SUBJECT_STUDENT, SUBJECT_SCHOOL}
)

SCOPE_CURRICULUM_READ = "curriculum:read"
SCOPE_TWIN_OBSERVE = "twin:observe"
SCOPE_TWIN_SIMULATE = "twin:simulate"
SCOPE_TWIN_ROLLBACK = "twin:rollback"
SCOPE_INTERVENTION_DELIVER = "intervention:deliver"
SCOPE_REPORT_AGGREGATE = "report:aggregate"
SCOPE_RESEARCH_AGGREGATE = "research:aggregate"
SCOPE_AUDIT_EXPORT = "audit:export"
SCOPE_METRICS_READ = "metrics:read"

CONSENT_SCOPES: frozenset[str] = frozenset(
    {
        SCOPE_CURRICULUM_READ,
        SCOPE_TWIN_OBSERVE,
        SCOPE_TWIN_SIMULATE,
        SCOPE_TWIN_ROLLBACK,
        SCOPE_INTERVENTION_DELIVER,
        SCOPE_REPORT_AGGREGATE,
        SCOPE_RESEARCH_AGGREGATE,
        SCOPE_AUDIT_EXPORT,
        SCOPE_METRICS_READ,
    }
)

CONSENT_GRANTED = "granted"
CONSENT_REVOKED = "revoked"
CONSENT_KINDS: frozenset[str] = frozenset({CONSENT_GRANTED, CONSENT_REVOKED})

#: Scopes that need an explicit guardian grant while the subject is a minor.
GUARDIAN_REQUIRED_SCOPES: frozenset[str] = frozenset(
    {
        SCOPE_TWIN_OBSERVE,
        SCOPE_TWIN_SIMULATE,
        SCOPE_TWIN_ROLLBACK,
        SCOPE_INTERVENTION_DELIVER,
        SCOPE_REPORT_AGGREGATE,
        SCOPE_RESEARCH_AGGREGATE,
    }
)

#: Scopes that are never available for a minor, whatever an adult consents to.
MINOR_FORBIDDEN_SCOPES: frozenset[str] = frozenset({SCOPE_RESEARCH_AGGREGATE})

MINOR_AGE_THRESHOLD = 18
MAX_AGE = 120


def is_minor(age: Any) -> bool:
    """Return whether ``age`` is below :data:`MINOR_AGE_THRESHOLD`."""

    if isinstance(age, bool) or not isinstance(age, int):
        raise ValidationError("age must be an integer")
    if age < 0 or age > MAX_AGE:
        raise ValidationError(f"age must be between 0 and {MAX_AGE}")
    return age < MINOR_AGE_THRESHOLD


@dataclass(frozen=True)
class ConsentEvent:
    """One append-only grant or revocation event.

    History is never rewritten: revoking appends a new event that supersedes the
    earlier grant for the same ``(subject, scope)`` pair.
    """

    consent_id: str
    student_ref: str
    subject: str
    scope: str
    kind: str
    at: datetime
    policy_version: str
    evidence_ref: str
    expires_at: datetime | None = None

    def __post_init__(self) -> None:
        _identifier(self.consent_id, "consent_id")
        _identifier(self.student_ref, "student_ref")
        _identifier(self.policy_version, "policy_version")
        _identifier(self.evidence_ref, "evidence_ref")
        if self.subject not in CONSENT_SUBJECTS:
            raise ValidationError(f"unknown consent subject {self.subject!r}")
        if self.scope not in CONSENT_SCOPES:
            raise ValidationError(f"unknown consent scope {self.scope!r}")
        if self.kind not in CONSENT_KINDS:
            raise ValidationError(f"unknown consent kind {self.kind!r}")
        object.__setattr__(self, "at", _aware(self.at, "at"))
        if self.expires_at is not None:
            expires_at = _aware(self.expires_at, "expires_at")
            if self.kind != CONSENT_GRANTED:
                raise ValidationError("only a granted consent event may expire")
            if expires_at <= self.at:
                raise ValidationError("expires_at must be after at")
            object.__setattr__(self, "expires_at", expires_at)

    @property
    def is_grant(self) -> bool:
        return self.kind == CONSENT_GRANTED


class ConsentLedger:
    """Append-only consent event log with fail-closed effective-state folding."""

    def __init__(self) -> None:
        self._events: list[ConsentEvent] = []
        self._ids: set[str] = set()

    def append(self, event: ConsentEvent) -> ConsentEvent:
        if not isinstance(event, ConsentEvent):
            raise ValidationError("ledger accepts ConsentEvent instances")
        if event.consent_id in self._ids:
            raise ConsentError(f"duplicate consent_id {event.consent_id!r}")
        self._ids.add(event.consent_id)
        self._events.append(event)
        return event

    def grant(
        self,
        *,
        consent_id: str,
        student_ref: str,
        subject: str,
        scope: str,
        at: datetime,
        policy_version: str,
        evidence_ref: str,
        expires_at: datetime | None = None,
    ) -> ConsentEvent:
        return self.append(
            ConsentEvent(
                consent_id=consent_id,
                student_ref=student_ref,
                subject=subject,
                scope=scope,
                kind=CONSENT_GRANTED,
                at=at,
                policy_version=policy_version,
                evidence_ref=evidence_ref,
                expires_at=expires_at,
            )
        )

    def revoke(
        self,
        *,
        consent_id: str,
        student_ref: str,
        subject: str,
        scope: str,
        at: datetime,
        policy_version: str,
        evidence_ref: str,
    ) -> ConsentEvent:
        return self.append(
            ConsentEvent(
                consent_id=consent_id,
                student_ref=student_ref,
                subject=subject,
                scope=scope,
                kind=CONSENT_REVOKED,
                at=at,
                policy_version=policy_version,
                evidence_ref=evidence_ref,
            )
        )

    @property
    def events(self) -> tuple[ConsentEvent, ...]:
        return tuple(self._events)

    def history(
        self, student_ref: str | None = None, scope: str | None = None
    ) -> tuple[ConsentEvent, ...]:
        selected = [
            event
            for event in self._events
            if (student_ref is None or event.student_ref == student_ref)
            and (scope is None or event.scope == scope)
        ]
        return tuple(selected)

    def _latest(
        self, student_ref: str, at: datetime
    ) -> dict[tuple[str, str], ConsentEvent]:
        latest: dict[tuple[str, str], ConsentEvent] = {}
        latest_order: dict[tuple[str, str], tuple[datetime, int]] = {}
        for index, event in enumerate(self._events):
            if event.student_ref != student_ref or event.at > at:
                continue
            key = (event.subject, event.scope)
            order = (event.at, index)
            if key not in latest or order > latest_order[key]:
                latest[key] = event
                latest_order[key] = order
        return latest

    def active_by_subject(
        self, student_ref: str, at: datetime
    ) -> Mapping[str, frozenset[str]]:
        at = _aware(at, "at")
        latest = self._latest(student_ref, at)
        grouped: dict[str, set[str]] = {}
        for (subject, scope), event in latest.items():
            if not event.is_grant:
                continue
            if event.expires_at is not None and at >= event.expires_at:
                continue
            grouped.setdefault(subject, set()).add(scope)
        return MappingProxyType(
            {subject: frozenset(scopes) for subject, scopes in grouped.items()}
        )

    def active_scopes(
        self, student_ref: str, at: datetime, *, age: int | None = None
    ) -> frozenset[str]:
        """Effective scopes for ``student_ref`` at ``at``.

        When ``age`` is given and the subject is a minor, a scope in
        :data:`GUARDIAN_REQUIRED_SCOPES` only counts if an active grant comes
        from the guardian subject.
        """

        grouped = self.active_by_subject(student_ref, at)
        active: set[str] = set()
        for scopes in grouped.values():
            active.update(scopes)
        if age is not None and is_minor(age):
            guardian = grouped.get(SUBJECT_GUARDIAN, frozenset())
            active = {
                scope
                for scope in active
                if scope not in GUARDIAN_REQUIRED_SCOPES or scope in guardian
            }
        return frozenset(active)

    def is_granted(
        self,
        student_ref: str,
        scope: str,
        at: datetime,
        *,
        age: int | None = None,
    ) -> bool:
        return scope in self.active_scopes(student_ref, at, age=age)

    def require(
        self,
        student_ref: str,
        scope: str,
        at: datetime,
        *,
        age: int | None = None,
    ) -> None:
        if not self.is_granted(student_ref, scope, at, age=age):
            raise ConsentError(
                f"consent scope {scope!r} is not active for {student_ref!r}"
            )

    def revoke_all(
        self, student_ref: str, at: datetime, *, policy_version: str
    ) -> int:
        """Append a revocation event for every currently active grant.

        Returns the number of grants revoked.  A second call is a no-op.
        """

        at = _aware(at, "at")
        latest = self._latest(student_ref, at)
        revoked = 0
        for (subject, scope), event in sorted(latest.items()):
            if not event.is_grant:
                continue
            if event.expires_at is not None and at >= event.expires_at:
                continue
            self.append(
                ConsentEvent(
                    consent_id=f"{event.consent_id}:revoked",
                    student_ref=student_ref,
                    subject=subject,
                    scope=scope,
                    kind=CONSENT_REVOKED,
                    at=at,
                    policy_version=policy_version,
                    evidence_ref=event.evidence_ref,
                )
            )
            revoked += 1
        return revoked


# ---------------------------------------------------------------------------
# 2. Audience restriction and minor protection (spec sections 20.3 / 21.2)
# ---------------------------------------------------------------------------

AUDIENCE_STUDENT = "student"
AUDIENCE_GUARDIAN = "guardian"
AUDIENCE_TEACHER = "teacher"
AUDIENCE_ADMIN = "admin"
AUDIENCE_RESEARCH = "research"
AUDIENCES: frozenset[str] = frozenset(
    {
        AUDIENCE_STUDENT,
        AUDIENCE_GUARDIAN,
        AUDIENCE_TEACHER,
        AUDIENCE_ADMIN,
        AUDIENCE_RESEARCH,
    }
)

DEFAULT_AUDIENCE_SCOPES: Mapping[str, frozenset[str]] = MappingProxyType(
    {
        AUDIENCE_STUDENT: frozenset({SCOPE_CURRICULUM_READ, SCOPE_TWIN_OBSERVE}),
        AUDIENCE_GUARDIAN: frozenset(
            {SCOPE_CURRICULUM_READ, SCOPE_REPORT_AGGREGATE}
        ),
        AUDIENCE_TEACHER: frozenset(
            {SCOPE_CURRICULUM_READ, SCOPE_TWIN_OBSERVE, SCOPE_REPORT_AGGREGATE}
        ),
        AUDIENCE_ADMIN: frozenset(
            {SCOPE_AUDIT_EXPORT, SCOPE_REPORT_AGGREGATE, SCOPE_METRICS_READ}
        ),
        AUDIENCE_RESEARCH: frozenset(
            {SCOPE_RESEARCH_AGGREGATE, SCOPE_METRICS_READ}
        ),
    }
)


def effective_audience_scopes(
    audience: str, authorized_scopes: Iterable[str] | None = None
) -> frozenset[str]:
    """Audience default narrowed (never widened) by an explicit scope list."""

    if audience not in AUDIENCES:
        raise AudienceRestrictionError(f"unknown audience {audience!r}")
    base = DEFAULT_AUDIENCE_SCOPES[audience]
    if authorized_scopes is None:
        return base
    if isinstance(authorized_scopes, str):
        requested = frozenset({authorized_scopes})
    else:
        requested = frozenset(str(scope) for scope in authorized_scopes)
    unknown = requested - CONSENT_SCOPES
    if unknown:
        raise AudienceRestrictionError(
            f"unknown audience scope(s): {sorted(unknown)!r}"
        )
    return frozenset(base & requested)


def authorized_audience_scopes(
    audience: str,
    ledger: ConsentLedger,
    student_ref: str,
    at: datetime,
    *,
    age: int | None = None,
    authorized_scopes: Iterable[str] | None = None,
) -> frozenset[str]:
    """Audience scopes that are both permitted and actively consented.

    Guardian consent is required for a minor's guardian-required scopes, and
    :data:`MINOR_FORBIDDEN_SCOPES` is never granted to a minor.
    """

    base = effective_audience_scopes(audience, authorized_scopes)
    active = ledger.active_scopes(student_ref, at, age=age)
    result = base & active
    if age is not None and is_minor(age):
        result = result - MINOR_FORBIDDEN_SCOPES
    return frozenset(result)


def assert_audience_scope(
    audience: str,
    scope: str,
    ledger: ConsentLedger,
    student_ref: str,
    at: datetime,
    *,
    age: int | None = None,
    authorized_scopes: Iterable[str] | None = None,
) -> None:
    allowed = authorized_audience_scopes(
        audience,
        ledger,
        student_ref,
        at,
        age=age,
        authorized_scopes=authorized_scopes,
    )
    if scope not in allowed:
        raise AudienceRestrictionError(
            f"audience {audience!r} may not access {scope!r} for {student_ref!r}"
        )


# ---------------------------------------------------------------------------
# 3. Retention and cross-store deletion propagation (spec section 21.2)
# ---------------------------------------------------------------------------

DATA_CLASS_RAW_MEDIA = "raw_media"
DATA_CLASS_LEARNING_EVENTS = "learning_events"
DATA_CLASS_DERIVED_FEATURES = "derived_features"
DATA_CLASS_REPORTS = "reports"
DATA_CLASS_AUDIT_LOG = "audit_log"
DATA_CLASSES: frozenset[str] = frozenset(
    {
        DATA_CLASS_RAW_MEDIA,
        DATA_CLASS_LEARNING_EVENTS,
        DATA_CLASS_DERIVED_FEATURES,
        DATA_CLASS_REPORTS,
        DATA_CLASS_AUDIT_LOG,
    }
)

DELETION_HARD = "hard_delete"
DELETION_TOMBSTONE = "tombstone"
DELETION_ANONYMIZE = "anonymize"
DELETION_MODES: frozenset[str] = frozenset(
    {DELETION_HARD, DELETION_TOMBSTONE, DELETION_ANONYMIZE}
)

DELETION_COMPLETED = "completed"
DELETION_PARTIAL = "partial"
DELETION_FAILED = "failed"
DELETION_STATUSES: frozenset[str] = frozenset(
    {DELETION_COMPLETED, DELETION_PARTIAL, DELETION_FAILED}
)

REASON_STUDENT_REQUEST = "student_request"
REASON_GUARDIAN_REQUEST = "guardian_request"
REASON_RETENTION_EXPIRY = "retention_expiry"
REASON_POLICY = "policy"
DELETION_REASONS: frozenset[str] = frozenset(
    {
        REASON_STUDENT_REQUEST,
        REASON_GUARDIAN_REQUEST,
        REASON_RETENTION_EXPIRY,
        REASON_POLICY,
    }
)


@dataclass(frozen=True)
class RetentionRule:
    """Retention window and deletion mode for one data class."""

    data_class: str
    retain_days: int
    deletion_mode: str = DELETION_TOMBSTONE

    def __post_init__(self) -> None:
        if self.data_class not in DATA_CLASSES:
            raise RetentionError(f"unknown data class {self.data_class!r}")
        object.__setattr__(
            self, "retain_days", _non_negative_int(self.retain_days, "retain_days")
        )
        if self.deletion_mode not in DELETION_MODES:
            raise RetentionError(f"unknown deletion mode {self.deletion_mode!r}")


@dataclass(frozen=True)
class RetentionPolicy:
    """A complete data-class -> retention rule map (fail-closed if incomplete)."""

    policy_version: str
    rules: Mapping[str, RetentionRule]

    def __post_init__(self) -> None:
        _identifier(self.policy_version, "policy_version")
        rules = dict(self.rules)
        missing = DATA_CLASSES - set(rules)
        if missing:
            raise RetentionError(
                f"retention policy is missing data class(es): {sorted(missing)!r}"
            )
        unknown = set(rules) - DATA_CLASSES
        if unknown:
            raise RetentionError(f"unknown data class(es): {sorted(unknown)!r}")
        for key, rule in rules.items():
            if not isinstance(rule, RetentionRule) or rule.data_class != key:
                raise RetentionError(f"rule for {key!r} is inconsistent")
        object.__setattr__(self, "rules", MappingProxyType(rules))

    def rule(self, data_class: str) -> RetentionRule:
        if data_class not in self.rules:
            raise RetentionError(f"no retention rule for {data_class!r}")
        return self.rules[data_class]

    def expires_at(self, data_class: str, created_at: datetime) -> datetime:
        created_at = _aware(created_at, "created_at")
        return created_at + timedelta(days=self.rule(data_class).retain_days)


@dataclass(frozen=True)
class RetentionRecord:
    """A stored record's minimal retention metadata."""

    student_ref: str
    data_class: str
    created_at: datetime

    def __post_init__(self) -> None:
        _identifier(self.student_ref, "student_ref")
        if self.data_class not in DATA_CLASSES:
            raise ValidationError(f"unknown data class {self.data_class!r}")
        object.__setattr__(self, "created_at", _aware(self.created_at, "created_at"))


@dataclass(frozen=True)
class RetentionDue:
    student_ref: str
    data_class: str
    created_at: datetime
    expires_at: datetime
    deletion_mode: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "student_ref": self.student_ref,
            "data_class": self.data_class,
            "created_at": _iso_utc(self.created_at),
            "expires_at": _iso_utc(self.expires_at),
            "deletion_mode": self.deletion_mode,
        }


def expired_records(
    records: Iterable[RetentionRecord],
    policy: RetentionPolicy,
    now: datetime,
) -> tuple[RetentionDue, ...]:
    """Records whose retention window has elapsed at ``now``.

    Expiry is inclusive: a record becomes due exactly when
    ``created_at + retain_days <= now``.
    """

    now = _aware(now, "now")
    dues: list[RetentionDue] = []
    for record in records:
        if not isinstance(record, RetentionRecord):
            raise ValidationError("expected RetentionRecord instances")
        expires_at = policy.expires_at(record.data_class, record.created_at)
        if expires_at <= now:
            dues.append(
                RetentionDue(
                    student_ref=record.student_ref,
                    data_class=record.data_class,
                    created_at=record.created_at,
                    expires_at=expires_at,
                    deletion_mode=policy.rule(record.data_class).deletion_mode,
                )
            )
    dues.sort(key=lambda due: (due.expires_at, due.student_ref, due.data_class))
    return tuple(dues)


def retention_requests(
    dues: Iterable[RetentionDue], *, requested_at: datetime
) -> tuple["DeletionRequest", ...]:
    """Turn retention dues into deterministic, per-(subject, class) requests."""

    requested_at = _aware(requested_at, "requested_at")
    requests: list[DeletionRequest] = []
    for due in dues:
        requests.append(
            DeletionRequest(
                request_id=(
                    f"retention:{due.student_ref}:{due.data_class}:"
                    f"{_iso_utc(due.expires_at)}"
                ),
                student_ref=due.student_ref,
                requested_at=requested_at,
                reason=REASON_RETENTION_EXPIRY,
                data_classes=frozenset({due.data_class}),
                requested_by="system",
            )
        )
    requests.sort(key=lambda request: request.request_id)
    return tuple(requests)


class DeletableStore(ABC):
    """Minimal cross-store deletion contract.

    Implementations must report, per data class, how many records they removed.
    Deletion is hard from the store's point of view; a tombstone/anonymise mode
    is a property of the retention rule and is not simulated here beyond
    recording which modes the caller requested.
    """

    store_id: str
    data_classes: frozenset[str]

    @abstractmethod
    def delete_subject(self, student_ref: str) -> Mapping[str, int]:
        """Delete every record for ``student_ref``; return per-class counts."""

    @abstractmethod
    def count_subject(self, student_ref: str) -> Mapping[str, int]:
        """Return per-class record counts for ``student_ref``."""


class SyntheticStore(DeletableStore):
    """In-memory synthetic store used by the tests (counts, no raw content)."""

    def __init__(
        self,
        store_id: str,
        data_classes: Iterable[str],
        *,
        fail_on_delete: bool = False,
    ) -> None:
        self.store_id = _identifier(store_id, "store_id")
        classes = frozenset(data_classes)
        unknown = classes - DATA_CLASSES
        if unknown:
            raise DeletionError(f"unknown data class(es): {sorted(unknown)!r}")
        self.data_classes = classes
        self._rows: dict[str, dict[str, int]] = {}
        self.fail_on_delete = bool(fail_on_delete)

    def seed(self, student_ref: str, data_class: str, count: int) -> None:
        _identifier(student_ref, "student_ref")
        if data_class not in self.data_classes:
            raise DeletionError(
                f"store {self.store_id!r} does not own {data_class!r}"
            )
        value = _non_negative_int(count, "count")
        self._rows.setdefault(student_ref, {})[data_class] = value

    def count_subject(self, student_ref: str) -> Mapping[str, int]:
        rows = self._rows.get(student_ref, {})
        return MappingProxyType(
            {data_class: rows.get(data_class, 0) for data_class in sorted(self.data_classes)}
        )

    def delete_subject(self, student_ref: str) -> Mapping[str, int]:
        if self.fail_on_delete:
            raise DeletionError("synthetic store deletion failed")
        counts = dict(self.count_subject(student_ref))
        self._rows.pop(student_ref, None)
        return MappingProxyType(counts)


@dataclass(frozen=True)
class DeletionRequest:
    request_id: str
    student_ref: str
    requested_at: datetime
    reason: str
    data_classes: frozenset[str]
    requested_by: str = "system"

    def __post_init__(self) -> None:
        _identifier(self.request_id, "request_id", max_length=200)
        _identifier(self.student_ref, "student_ref")
        object.__setattr__(self, "requested_at", _aware(self.requested_at, "requested_at"))
        if self.reason not in DELETION_REASONS:
            raise ValidationError(f"unknown deletion reason {self.reason!r}")
        if self.requested_by not in CONSENT_SUBJECTS and self.requested_by != "system":
            raise ValidationError(f"unknown requester {self.requested_by!r}")
        classes = frozenset(self.data_classes)
        if not classes:
            raise ValidationError("data_classes must not be empty")
        unknown = classes - DATA_CLASSES
        if unknown:
            raise ValidationError(f"unknown data class(es): {sorted(unknown)!r}")
        object.__setattr__(self, "data_classes", classes)


@dataclass(frozen=True)
class StoreDeletionResult:
    store_id: str
    status: str
    deleted: Mapping[str, int]
    error: str | None = None

    def __post_init__(self) -> None:
        _identifier(self.store_id, "store_id")
        if self.status not in DELETION_STATUSES:
            raise ValidationError(f"unknown deletion status {self.status!r}")
        object.__setattr__(self, "deleted", MappingProxyType(dict(self.deleted)))

    @property
    def total(self) -> int:
        return sum(self.deleted.values())

    def as_dict(self) -> dict[str, Any]:
        return {
            "store_id": self.store_id,
            "status": self.status,
            "deleted": {key: self.deleted[key] for key in sorted(self.deleted)},
            "deleted_total": self.total,
            "error": self.error,
        }


@dataclass(frozen=True)
class DeletionReceipt:
    request_id: str
    student_ref: str
    requested_at: datetime
    completed_at: datetime
    status: str
    results: tuple[StoreDeletionResult, ...]
    total_deleted: int
    consent_revoked: int
    access_blocked: bool
    idempotent_replay: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "student_ref": self.student_ref,
            "requested_at": _iso_utc(self.requested_at),
            "completed_at": _iso_utc(self.completed_at),
            "status": self.status,
            "stores": [result.as_dict() for result in self.results],
            "total_deleted": self.total_deleted,
            "consent_revoked": self.consent_revoked,
            "access_blocked": self.access_blocked,
            "idempotent_replay": self.idempotent_replay,
        }


class DeletionCoordinator:
    """Propagates one deletion request across every registered store."""

    def __init__(self) -> None:
        self._stores: dict[str, DeletableStore] = {}
        self._receipts: dict[str, DeletionReceipt] = {}
        self._blocked: set[str] = set()

    @property
    def store_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._stores))

    def register(self, store: DeletableStore) -> None:
        if not isinstance(store, DeletableStore):
            raise DeletionError("coordinator accepts DeletableStore instances")
        if store.store_id in self._stores:
            raise DeletionError(f"duplicate store_id {store.store_id!r}")
        self._stores[store.store_id] = store

    def delete(
        self,
        request: DeletionRequest,
        *,
        ledger: ConsentLedger | None = None,
        now: datetime | None = None,
    ) -> DeletionReceipt:
        if not isinstance(request, DeletionRequest):
            raise DeletionError("coordinator accepts DeletionRequest instances")
        completed_at = _aware(now or datetime.now(timezone.utc), "now")
        cached = self._receipts.get(request.request_id)
        if cached is not None:
            return DeletionReceipt(
                request_id=cached.request_id,
                student_ref=cached.student_ref,
                requested_at=cached.requested_at,
                completed_at=cached.completed_at,
                status=cached.status,
                results=cached.results,
                total_deleted=cached.total_deleted,
                consent_revoked=cached.consent_revoked,
                access_blocked=cached.access_blocked,
                idempotent_replay=True,
            )

        results: list[StoreDeletionResult] = []
        for store_id in sorted(self._stores):
            store = self._stores[store_id]
            relevant = store.data_classes & request.data_classes
            if not relevant:
                continue
            try:
                deleted = store.delete_subject(request.student_ref)
                results.append(
                    StoreDeletionResult(
                        store_id=store_id,
                        status=DELETION_COMPLETED,
                        deleted=deleted,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - fail closed, keep only type
                results.append(
                    StoreDeletionResult(
                        store_id=store_id,
                        status=DELETION_FAILED,
                        deleted={
                            data_class: 0 for data_class in sorted(relevant)
                        },
                        error=type(exc).__name__,
                    )
                )

        if not results:
            status = DELETION_COMPLETED
        elif all(result.status == DELETION_COMPLETED for result in results):
            status = DELETION_COMPLETED
        elif all(result.status == DELETION_FAILED for result in results):
            status = DELETION_FAILED
        else:
            status = DELETION_PARTIAL

        revoked = 0
        if ledger is not None:
            revoked = ledger.revoke_all(
                request.student_ref,
                completed_at,
                policy_version="privacy.deletion.v1",
            )

        self._blocked.add(request.student_ref)
        receipt = DeletionReceipt(
            request_id=request.request_id,
            student_ref=request.student_ref,
            requested_at=request.requested_at,
            completed_at=completed_at,
            status=status,
            results=tuple(results),
            total_deleted=sum(result.total for result in results),
            consent_revoked=revoked,
            access_blocked=True,
        )
        self._receipts[request.request_id] = receipt
        return receipt

    def is_blocked(self, student_ref: str) -> bool:
        return student_ref in self._blocked

    def assert_readable(self, student_ref: str) -> None:
        if self.is_blocked(student_ref):
            raise DeletionError(
                f"subject {student_ref!r} has been deleted; reads fail closed"
            )


# ---------------------------------------------------------------------------
# 4. Audit export (spec section 20.3)
# ---------------------------------------------------------------------------

AUDIT_KINDS: frozenset[str] = frozenset(
    {
        "gate.decision",
        "tool.call",
        "approval.record",
        "delivery.receipt",
        "session.cleanup",
        "consent.record",
        "deletion.propagate",
    }
)

AUDIT_ACCEPTED = "accepted"
AUDIT_REJECTED = "rejected"
AUDIT_OUTCOMES: frozenset[str] = frozenset({AUDIT_ACCEPTED, AUDIT_REJECTED})

#: The same raw-content key rejection as the TypeScript host audit log.
AUDIT_FORBIDDEN_DETAIL_KEYS: frozenset[str] = frozenset(
    {
        "answer",
        "answers",
        "studentanswer",
        "rawanswer",
        "question",
        "questiontext",
        "itemcontent",
        "prompt",
        "prompttext",
        "solution",
        "steps",
        "trace",
        "content",
        "text",
        "image",
        "imagedata",
        "photo",
        "ocr",
        "attachment",
        "attachments",
        "payload",
        "rawpayload",
        "transcript",
        "studentname",
        "studentref",
        "tenantref",
        "name",
        "email",
        "phone",
        "address",
    }
)


@dataclass(frozen=True)
class AuditEntry:
    """One append-only audit record with pseudonymous dimensions only."""

    seq: int
    at: datetime
    kind: str
    action: str
    outcome: str
    reason_codes: tuple[str, ...] = ()
    student_key: str | None = None
    tenant_key: str | None = None
    detail: Mapping[str, Scalar] = MappingProxyType({})

    def __post_init__(self) -> None:
        object.__setattr__(self, "seq", _non_negative_int(self.seq, "seq"))
        object.__setattr__(self, "at", _aware(self.at, "at"))
        if self.kind not in AUDIT_KINDS:
            raise AuditExportError(f"unknown audit kind {self.kind!r}")
        _short_label(self.action, "action", max_length=200)
        if self.outcome not in AUDIT_OUTCOMES:
            raise AuditExportError(f"unknown audit outcome {self.outcome!r}")
        codes = tuple(_short_label(code, "reason_codes[]") for code in self.reason_codes)
        object.__setattr__(self, "reason_codes", codes)
        for field_name, value in (
            ("student_key", self.student_key),
            ("tenant_key", self.tenant_key),
        ):
            if value is not None:
                _identifier(value, field_name)
        clean: dict[str, Scalar] = {}
        for key, value in dict(self.detail).items():
            if not isinstance(key, str) or key.lower() in AUDIT_FORBIDDEN_DETAIL_KEYS:
                raise AuditExportError(
                    f"audit detail key {key!r} would store raw student data"
                )
            _short_label(key, "detail key")
            if isinstance(value, (dict, list, tuple, set, frozenset)):
                raise AuditExportError("audit detail values must be scalars")
            if isinstance(value, float) and not math.isfinite(value):
                raise AuditExportError("audit detail numbers must be finite")
            if value is not None and not isinstance(value, (str, int, float, bool)):
                raise AuditExportError("audit detail values must be scalars")
            clean[key] = value
        object.__setattr__(self, "detail", MappingProxyType(clean))

    def as_dict(self, *, redact_keys: bool) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "at": _iso_utc(self.at),
            "kind": self.kind,
            "action": self.action,
            "outcome": self.outcome,
            "reason_codes": list(self.reason_codes),
            "student_key": None if redact_keys else self.student_key,
            "tenant_key": None if redact_keys else self.tenant_key,
            "detail": {key: self.detail[key] for key in sorted(self.detail)},
        }


@dataclass(frozen=True)
class AuditExportRequest:
    request_id: str
    requested_at: datetime
    audience: str
    window_start: datetime
    window_end: datetime
    kinds: frozenset[str] = frozenset()
    include_pseudonymous_keys: bool = False
    authorized_scopes: frozenset[str] | None = None

    def __post_init__(self) -> None:
        _identifier(self.request_id, "request_id", max_length=200)
        object.__setattr__(
            self, "requested_at", _aware(self.requested_at, "requested_at")
        )
        if self.audience not in AUDIENCES:
            raise AuditExportError(f"unknown audience {self.audience!r}")
        start = _aware(self.window_start, "window_start")
        end = _aware(self.window_end, "window_end")
        if start >= end:
            raise AuditExportError("window_start must be before window_end")
        object.__setattr__(self, "window_start", start)
        object.__setattr__(self, "window_end", end)
        kinds = frozenset(self.kinds)
        if kinds:
            unknown = kinds - AUDIT_KINDS
            if unknown:
                raise AuditExportError(f"unknown audit kind(s): {sorted(unknown)!r}")
        object.__setattr__(self, "kinds", kinds)
        if self.authorized_scopes is not None:
            object.__setattr__(
                self, "authorized_scopes", frozenset(self.authorized_scopes)
            )


@dataclass(frozen=True)
class AuditExportBundle:
    request_id: str
    audience: str
    window_start: datetime
    window_end: datetime
    generated_at: datetime
    entries_used: int
    entries_excluded: int
    counts_by_kind: Mapping[str, int]
    counts_by_outcome: Mapping[str, int]
    redacted_keys: bool
    digest: str
    payload: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "audience": self.audience,
            "window": {
                "start": _iso_utc(self.window_start),
                "end": _iso_utc(self.window_end),
                "boundary": "start_inclusive_end_exclusive",
            },
            "generated_at": _iso_utc(self.generated_at),
            "entries_used": self.entries_used,
            "entries_excluded": self.entries_excluded,
            "counts_by_kind": {
                key: self.counts_by_kind[key] for key in sorted(self.counts_by_kind)
            },
            "counts_by_outcome": {
                key: self.counts_by_outcome[key]
                for key in sorted(self.counts_by_outcome)
            },
            "redacted_keys": self.redacted_keys,
            "digest": self.digest,
            "payload": self.payload,
        }


def export_audit(
    entries: Iterable[AuditEntry],
    request: AuditExportRequest,
    *,
    generated_at: datetime | None = None,
) -> AuditExportBundle:
    """Filter and serialise audit entries into a deterministic export."""

    if not isinstance(request, AuditExportRequest):
        raise AuditExportError("export requires an AuditExportRequest")
    scopes = effective_audience_scopes(request.audience, request.authorized_scopes)
    if SCOPE_AUDIT_EXPORT not in scopes:
        raise AudienceRestrictionError(
            f"audience {request.audience!r} is not authorised for audit export"
        )
    generated_at = _aware(
        generated_at or datetime.now(timezone.utc), "generated_at"
    )

    selected: list[AuditEntry] = []
    excluded = 0
    for entry in entries:
        if not isinstance(entry, AuditEntry):
            raise AuditExportError("export accepts AuditEntry instances")
        if request.kinds and entry.kind not in request.kinds:
            excluded += 1
            continue
        if not (request.window_start <= entry.at < request.window_end):
            excluded += 1
            continue
        selected.append(entry)
    selected.sort(key=lambda entry: (entry.at, entry.seq))

    lines: list[str] = []
    counts_by_kind: dict[str, int] = {}
    counts_by_outcome: dict[str, int] = {}
    for entry in selected:
        record = entry.as_dict(redact_keys=not request.include_pseudonymous_keys)
        lines.append(canonical_json(record))
        counts_by_kind[entry.kind] = counts_by_kind.get(entry.kind, 0) + 1
        counts_by_outcome[entry.outcome] = counts_by_outcome.get(entry.outcome, 0) + 1
    payload = "" if not lines else "\n".join(lines) + "\n"
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    return AuditExportBundle(
        request_id=request.request_id,
        audience=request.audience,
        window_start=request.window_start,
        window_end=request.window_end,
        generated_at=generated_at,
        entries_used=len(selected),
        entries_excluded=excluded,
        counts_by_kind=MappingProxyType(counts_by_kind),
        counts_by_outcome=MappingProxyType(counts_by_outcome),
        redacted_keys=not request.include_pseudonymous_keys,
        digest=digest,
        payload=payload,
    )


# ---------------------------------------------------------------------------
# 5. Metrics dashboard and cost estimation (spec sections 20.1 / 20.2)
# ---------------------------------------------------------------------------

DIMENSION_LEARNING = "learning"
DIMENSION_SYSTEM = "system"
DIMENSION_COST = "cost"
METRIC_DIMENSIONS: frozenset[str] = frozenset(
    {DIMENSION_LEARNING, DIMENSION_SYSTEM, DIMENSION_COST}
)

AGG_SUM = "sum"
AGG_MEAN = "mean"
AGG_GAUGE = "gauge"
AGG_RATIO = "ratio"
AGGREGATIONS: frozenset[str] = frozenset({AGG_SUM, AGG_MEAN, AGG_GAUGE, AGG_RATIO})

SOURCE_OBSERVED = "observed"
SOURCE_SIMULATED = "simulated"
METRIC_SOURCES: frozenset[str] = frozenset({SOURCE_OBSERVED, SOURCE_SIMULATED})

MIN_COHORT_SIZE = 5


@dataclass(frozen=True)
class MetricDefinition:
    name: str
    dimension: str
    unit: str
    aggregation: str
    description: str = ""
    simulated_allowed: bool = False

    def __post_init__(self) -> None:
        _identifier(self.name, "name", max_length=80)
        if self.dimension not in METRIC_DIMENSIONS:
            raise MetricsError(f"unknown metric dimension {self.dimension!r}")
        _short_label(self.unit, "unit", max_length=40)
        if self.aggregation not in AGGREGATIONS:
            raise MetricsError(f"unknown aggregation {self.aggregation!r}")


#: Registry of the spec section 20.1 dashboard metrics (synthetic definitions).
_METRIC_SPECS: tuple[tuple[str, str, str, str, bool], ...] = (
    # learning (simulation may not enter these channels)
    ("independent_accuracy", DIMENSION_LEARNING, "ratio", AGG_RATIO, False),
    ("step_error_recurrence", DIMENSION_LEARNING, "per_step", AGG_MEAN, False),
    ("near_transfer", DIMENSION_LEARNING, "ratio", AGG_RATIO, False),
    ("far_transfer", DIMENSION_LEARNING, "ratio", AGG_RATIO, False),
    ("delayed_retention", DIMENSION_LEARNING, "ratio", AGG_RATIO, False),
    ("hint_dependency", DIMENSION_LEARNING, "ratio", AGG_RATIO, False),
    ("learning_minutes", DIMENSION_LEARNING, "minutes", AGG_SUM, False),
    # explicit cross-channel comparison only
    ("virtual_real_gain_gap", DIMENSION_LEARNING, "ratio", AGG_MEAN, True),
    # system
    ("model_calls_per_session", DIMENSION_SYSTEM, "calls", AGG_MEAN, True),
    ("tool_latency_ms", DIMENSION_SYSTEM, "ms", AGG_MEAN, True),
    ("cache_hit_rate", DIMENSION_SYSTEM, "ratio", AGG_RATIO, True),
    ("workflow_failure_rate", DIMENSION_SYSTEM, "ratio", AGG_RATIO, True),
    ("simulated_tokens", DIMENSION_SYSTEM, "tokens", AGG_SUM, True),
    # cost
    ("simulated_token_cost_usd", DIMENSION_COST, "usd", AGG_SUM, True),
    ("tool_invocation_cost_usd", DIMENSION_COST, "usd", AGG_SUM, True),
    ("session_cost_usd", DIMENSION_COST, "usd", AGG_SUM, True),
)

METRIC_DEFINITIONS: Mapping[str, MetricDefinition] = MappingProxyType(
    {
        name: MetricDefinition(
            name=name,
            dimension=dimension,
            unit=unit,
            aggregation=aggregation,
            simulated_allowed=simulated_allowed,
        )
        for name, dimension, unit, aggregation, simulated_allowed in _METRIC_SPECS
    }
)


@dataclass(frozen=True)
class MetricSample:
    metric: str
    value: float
    at: datetime
    source: str
    student_key: str | None = None
    tenant_key: str | None = None
    labels: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        _identifier(self.metric, "metric", max_length=80)
        object.__setattr__(self, "value", _finite_float(self.value, "value"))
        object.__setattr__(self, "at", _aware(self.at, "at"))
        if self.source not in METRIC_SOURCES:
            raise MetricsError(f"unknown metric source {self.source!r}")
        for field_name, value in (
            ("student_key", self.student_key),
            ("tenant_key", self.tenant_key),
        ):
            if value is not None:
                _identifier(value, field_name)
        clean_labels: list[tuple[str, str]] = []
        for key, value in tuple(self.labels):
            clean_labels.append(
                (
                    _short_label(key, "label key", max_length=40),
                    _short_label(value, "label value", max_length=60),
                )
            )
        clean_labels.sort()
        object.__setattr__(self, "labels", tuple(clean_labels))

    @property
    def label_dict(self) -> Mapping[str, str]:
        return MappingProxyType(dict(self.labels))

    def as_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "value": _round(self.value),
            "at": _iso_utc(self.at),
            "source": self.source,
            "student_key": self.student_key,
            "tenant_key": self.tenant_key,
            "labels": dict(self.labels),
        }


def _aggregate(values: list[float], aggregation: str) -> float | None:
    if not values:
        return None
    if aggregation == AGG_SUM:
        return _round(sum(values))
    if aggregation == AGG_GAUGE:
        return _round(values[-1])
    return _round(sum(values) / len(values))


@dataclass(frozen=True)
class MetricCell:
    metric: str
    dimension: str
    unit: str
    aggregation: str
    value: float | None
    sample_count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "dimension": self.dimension,
            "unit": self.unit,
            "aggregation": self.aggregation,
            "value": self.value,
            "sample_count": self.sample_count,
        }


@dataclass(frozen=True)
class CohortCell:
    student_key: str
    value: float | None
    sample_count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "student_key": self.student_key,
            "value": self.value,
            "sample_count": self.sample_count,
        }


@dataclass(frozen=True)
class CohortView:
    metric: str
    channel: str
    min_cohort_size: int
    cells: tuple[CohortCell, ...]
    suppressed_cohorts: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "channel": self.channel,
            "min_cohort_size": self.min_cohort_size,
            "cells": [cell.as_dict() for cell in self.cells],
            "suppressed_cohorts": self.suppressed_cohorts,
        }


@dataclass(frozen=True)
class DashboardSnapshot:
    channel: str
    generated_at: datetime
    cells: tuple[MetricCell, ...]
    total_samples: int
    excluded_other_channel: int
    student_counts: Mapping[str, int]
    min_cohort_size: int

    def cell(self, metric: str) -> MetricCell | None:
        for candidate in self.cells:
            if candidate.metric == metric:
                return candidate
        return None

    def as_dict(self) -> dict[str, Any]:
        sections: dict[str, list[dict[str, Any]]] = {
            dimension: [] for dimension in sorted(METRIC_DIMENSIONS)
        }
        for cell in self.cells:
            sections[cell.dimension].append(cell.as_dict())
        cohorts = {
            key: self.student_counts[key]
            for key in sorted(self.student_counts)
            if self.student_counts[key] >= self.min_cohort_size
        }
        suppressed = sum(
            1
            for count in self.student_counts.values()
            if count < self.min_cohort_size
        )
        return {
            "channel": self.channel,
            "generated_at": _iso_utc(self.generated_at),
            "sections": sections,
            "total_samples": self.total_samples,
            "excluded_other_channel": self.excluded_other_channel,
            "student_cohorts": cohorts,
            "suppressed_cohorts": suppressed,
            "min_cohort_size": self.min_cohort_size,
        }


class MetricsDashboard:
    """Channel-aware metric sample store for the spec section 20.1 dashboard."""

    def __init__(
        self,
        definitions: Mapping[str, MetricDefinition] | None = None,
        *,
        min_cohort_size: int = MIN_COHORT_SIZE,
    ) -> None:
        self._definitions = dict(definitions or METRIC_DEFINITIONS)
        for name, definition in self._definitions.items():
            if not isinstance(definition, MetricDefinition) or definition.name != name:
                raise MetricsError(f"metric definition {name!r} is inconsistent")
        self.min_cohort_size = _non_negative_int(min_cohort_size, "min_cohort_size")
        if self.min_cohort_size < 1:
            raise MetricsError("min_cohort_size must be >= 1")
        self._samples: list[MetricSample] = []

    @property
    def definitions(self) -> Mapping[str, MetricDefinition]:
        return MappingProxyType(self._definitions)

    @property
    def samples(self) -> tuple[MetricSample, ...]:
        return tuple(self._samples)

    def ingest(self, sample: MetricSample) -> MetricSample:
        if not isinstance(sample, MetricSample):
            raise MetricsError("dashboard accepts MetricSample instances")
        definition = self._definitions.get(sample.metric)
        if definition is None:
            raise MetricsError(f"unknown metric {sample.metric!r}")
        if sample.source == SOURCE_SIMULATED and not definition.simulated_allowed:
            raise MetricsError(
                f"simulated samples may not enter learning metric "
                f"{sample.metric!r}"
            )
        self._samples.append(sample)
        return sample

    def _channel(self, channel: str) -> list[MetricSample]:
        if channel not in METRIC_SOURCES:
            raise MetricsError(f"unknown channel {channel!r}")
        return [sample for sample in self._samples if sample.source == channel]

    def snapshot(
        self, *, channel: str = SOURCE_OBSERVED, generated_at: datetime | None = None
    ) -> DashboardSnapshot:
        selected = self._channel(channel)
        other = len(self._samples) - len(selected)
        grouped: dict[str, list[float]] = {}
        for sample in selected:
            grouped.setdefault(sample.metric, []).append(sample.value)
        cells: list[MetricCell] = []
        for name in sorted(grouped):
            definition = self._definitions[name]
            cells.append(
                MetricCell(
                    metric=name,
                    dimension=definition.dimension,
                    unit=definition.unit,
                    aggregation=definition.aggregation,
                    value=_aggregate(grouped[name], definition.aggregation),
                    sample_count=len(grouped[name]),
                )
            )
        student_counts: dict[str, int] = {}
        for sample in selected:
            if sample.student_key is not None:
                student_counts[sample.student_key] = (
                    student_counts.get(sample.student_key, 0) + 1
                )
        return DashboardSnapshot(
            channel=channel,
            generated_at=_aware(
                generated_at or datetime.now(timezone.utc), "generated_at"
            ),
            cells=tuple(cells),
            total_samples=len(selected),
            excluded_other_channel=other,
            student_counts=MappingProxyType(student_counts),
            min_cohort_size=self.min_cohort_size,
        )

    def cohort_view(
        self,
        metric: str,
        *,
        channel: str = SOURCE_OBSERVED,
        min_cohort_size: int | None = None,
    ) -> CohortView:
        definition = self._definitions.get(metric)
        if definition is None:
            raise MetricsError(f"unknown metric {metric!r}")
        threshold = (
            self.min_cohort_size
            if min_cohort_size is None
            else _non_negative_int(min_cohort_size, "min_cohort_size")
        )
        if threshold < 1:
            raise MetricsError("min_cohort_size must be >= 1")
        selected = [
            sample
            for sample in self._channel(channel)
            if sample.metric == metric and sample.student_key is not None
        ]
        grouped: dict[str, list[float]] = {}
        for sample in selected:
            grouped.setdefault(sample.student_key, []).append(sample.value)
        cells: list[CohortCell] = []
        suppressed = 0
        for key in sorted(grouped):
            values = grouped[key]
            if len(values) < threshold:
                suppressed += 1
                continue
            cells.append(
                CohortCell(
                    student_key=key,
                    value=_aggregate(values, definition.aggregation),
                    sample_count=len(values),
                )
            )
        return CohortView(
            metric=metric,
            channel=channel,
            min_cohort_size=threshold,
            cells=tuple(cells),
            suppressed_cohorts=suppressed,
        )


# --- Cost estimation (explicitly synthetic; never connected to real billing) ---

#: Hard guarantee: this module never talks to a billing provider.
BILLING_CONNECTED = False


@dataclass(frozen=True)
class CostModel:
    model_id: str
    input_usd_per_1k_tokens: float = 0.0
    output_usd_per_1k_tokens: float = 0.0
    tool_call_usd: float = 0.0
    simulation_minute_usd: float = 0.0
    currency: str = "USD"
    synthetic: bool = True

    def __post_init__(self) -> None:
        _identifier(self.model_id, "model_id", max_length=80)
        _short_label(self.currency, "currency", max_length=8)
        object.__setattr__(
            self,
            "input_usd_per_1k_tokens",
            _non_negative_float(self.input_usd_per_1k_tokens, "input rate"),
        )
        object.__setattr__(
            self,
            "output_usd_per_1k_tokens",
            _non_negative_float(self.output_usd_per_1k_tokens, "output rate"),
        )
        object.__setattr__(
            self, "tool_call_usd", _non_negative_float(self.tool_call_usd, "tool rate")
        )
        object.__setattr__(
            self,
            "simulation_minute_usd",
            _non_negative_float(self.simulation_minute_usd, "simulation rate"),
        )


#: Synthetic, illustrative price book.  These numbers are not a quote and are
#: never sent to a billing provider.
DEFAULT_COST_MODELS: Mapping[str, CostModel] = MappingProxyType(
    {
        "synthetic-llm-small": CostModel(
            model_id="synthetic-llm-small",
            input_usd_per_1k_tokens=0.0015,
            output_usd_per_1k_tokens=0.006,
            tool_call_usd=0.0002,
            simulation_minute_usd=0.01,
        ),
        "synthetic-llm-large": CostModel(
            model_id="synthetic-llm-large",
            input_usd_per_1k_tokens=0.01,
            output_usd_per_1k_tokens=0.03,
            tool_call_usd=0.0005,
            simulation_minute_usd=0.05,
        ),
    }
)


@dataclass(frozen=True)
class UsageRecord:
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    simulation_minutes: float = 0.0
    cache_hits: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "input_tokens", _non_negative_int(self.input_tokens, "input_tokens")
        )
        object.__setattr__(
            self, "output_tokens", _non_negative_int(self.output_tokens, "output_tokens")
        )
        object.__setattr__(
            self, "tool_calls", _non_negative_int(self.tool_calls, "tool_calls")
        )
        object.__setattr__(
            self, "cache_hits", _non_negative_int(self.cache_hits, "cache_hits")
        )
        object.__setattr__(
            self,
            "simulation_minutes",
            _non_negative_float(self.simulation_minutes, "simulation_minutes"),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "tool_calls": self.tool_calls,
            "simulation_minutes": _round(self.simulation_minutes),
            "cache_hits": self.cache_hits,
        }


@dataclass(frozen=True)
class CostEstimate:
    model_id: str
    currency: str
    components: Mapping[str, float]
    total: float
    usage: UsageRecord
    synthetic: bool = True

    @property
    def billing_connected(self) -> bool:
        return BILLING_CONNECTED

    def as_dict(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "currency": self.currency,
            "components": {
                key: _round(self.components[key]) for key in sorted(self.components)
            },
            "total": _round(self.total),
            "usage": self.usage.as_dict(),
            "synthetic": self.synthetic,
            "billing_connected": self.billing_connected,
        }


def estimate_cost(usage: UsageRecord, model: CostModel) -> CostEstimate:
    if not isinstance(usage, UsageRecord):
        raise MetricsError("usage must be a UsageRecord")
    if not isinstance(model, CostModel):
        raise MetricsError("model must be a CostModel")
    components = {
        "model_input_usd": _round(
            usage.input_tokens / 1000.0 * model.input_usd_per_1k_tokens
        ),
        "model_output_usd": _round(
            usage.output_tokens / 1000.0 * model.output_usd_per_1k_tokens
        ),
        "tool_call_usd": _round(usage.tool_calls * model.tool_call_usd),
        "simulation_usd": _round(
            usage.simulation_minutes * model.simulation_minute_usd
        ),
    }
    total = _round(sum(components.values()))
    return CostEstimate(
        model_id=model.model_id,
        currency=model.currency,
        components=MappingProxyType(components),
        total=total,
        usage=usage,
        synthetic=model.synthetic,
    )


class CostEstimator:
    """Synthetic cost estimator over an explicit model price book."""

    def __init__(self, models: Mapping[str, CostModel] | None = None) -> None:
        self._models = dict(models or DEFAULT_COST_MODELS)
        for name, model in self._models.items():
            if not isinstance(model, CostModel) or model.model_id != name:
                raise MetricsError(f"cost model {name!r} is inconsistent")
        if not self._models:
            raise MetricsError("cost estimator needs at least one model")

    @property
    def models(self) -> Mapping[str, CostModel]:
        return MappingProxyType(self._models)

    def estimate(self, usage: UsageRecord, model_id: str) -> CostEstimate:
        model = self._models.get(model_id)
        if model is None:
            raise MetricsError(f"unknown cost model {model_id!r}")
        return estimate_cost(usage, model)

    def estimate_multi(
        self, usage_by_model: Mapping[str, UsageRecord]
    ) -> CostEstimate:
        if not usage_by_model:
            raise MetricsError("usage_by_model must not be empty")
        components: dict[str, float] = {}
        total = 0.0
        currency = "USD"
        synthetic = True
        for model_id in sorted(usage_by_model):
            estimate = self.estimate(usage_by_model[model_id], model_id)
            currency = estimate.currency
            synthetic = synthetic and estimate.synthetic
            for key, value in estimate.components.items():
                components[f"{model_id}.{key}"] = value
            total += estimate.total
        total = _round(total)
        combined_usage = UsageRecord(
            input_tokens=sum(u.input_tokens for u in usage_by_model.values()),
            output_tokens=sum(u.output_tokens for u in usage_by_model.values()),
            tool_calls=sum(u.tool_calls for u in usage_by_model.values()),
            simulation_minutes=sum(
                u.simulation_minutes for u in usage_by_model.values()
            ),
            cache_hits=sum(u.cache_hits for u in usage_by_model.values()),
        )
        return CostEstimate(
            model_id="combined",
            currency=currency,
            components=MappingProxyType(components),
            total=total,
            usage=combined_usage,
            synthetic=synthetic,
        )

    @staticmethod
    def within_budget(estimate: CostEstimate, budget_usd: float) -> bool:
        if not isinstance(estimate, CostEstimate):
            raise MetricsError("estimate must be a CostEstimate")
        budget = _non_negative_float(budget_usd, "budget_usd")
        return _round(estimate.total) <= _round(budget)


__all__ = [
    "PrivacyError",
    "ValidationError",
    "ConsentError",
    "AudienceRestrictionError",
    "RetentionError",
    "DeletionError",
    "AuditExportError",
    "MetricsError",
    "canonical_json",
    "content_digest",
    # consent
    "SUBJECT_GUARDIAN",
    "SUBJECT_STUDENT",
    "SUBJECT_SCHOOL",
    "CONSENT_SUBJECTS",
    "SCOPE_CURRICULUM_READ",
    "SCOPE_TWIN_OBSERVE",
    "SCOPE_TWIN_SIMULATE",
    "SCOPE_TWIN_ROLLBACK",
    "SCOPE_INTERVENTION_DELIVER",
    "SCOPE_REPORT_AGGREGATE",
    "SCOPE_RESEARCH_AGGREGATE",
    "SCOPE_AUDIT_EXPORT",
    "SCOPE_METRICS_READ",
    "CONSENT_SCOPES",
    "CONSENT_GRANTED",
    "CONSENT_REVOKED",
    "CONSENT_KINDS",
    "GUARDIAN_REQUIRED_SCOPES",
    "MINOR_FORBIDDEN_SCOPES",
    "MINOR_AGE_THRESHOLD",
    "MAX_AGE",
    "is_minor",
    "ConsentEvent",
    "ConsentLedger",
    # audience
    "AUDIENCE_STUDENT",
    "AUDIENCE_GUARDIAN",
    "AUDIENCE_TEACHER",
    "AUDIENCE_ADMIN",
    "AUDIENCE_RESEARCH",
    "AUDIENCES",
    "DEFAULT_AUDIENCE_SCOPES",
    "effective_audience_scopes",
    "authorized_audience_scopes",
    "assert_audience_scope",
    # retention / deletion
    "DATA_CLASS_RAW_MEDIA",
    "DATA_CLASS_LEARNING_EVENTS",
    "DATA_CLASS_DERIVED_FEATURES",
    "DATA_CLASS_REPORTS",
    "DATA_CLASS_AUDIT_LOG",
    "DATA_CLASSES",
    "DELETION_HARD",
    "DELETION_TOMBSTONE",
    "DELETION_ANONYMIZE",
    "DELETION_MODES",
    "DELETION_COMPLETED",
    "DELETION_PARTIAL",
    "DELETION_FAILED",
    "DELETION_STATUSES",
    "REASON_STUDENT_REQUEST",
    "REASON_GUARDIAN_REQUEST",
    "REASON_RETENTION_EXPIRY",
    "REASON_POLICY",
    "DELETION_REASONS",
    "RetentionRule",
    "RetentionPolicy",
    "RetentionRecord",
    "RetentionDue",
    "expired_records",
    "retention_requests",
    "DeletableStore",
    "SyntheticStore",
    "DeletionRequest",
    "StoreDeletionResult",
    "DeletionReceipt",
    "DeletionCoordinator",
    # audit export
    "AUDIT_KINDS",
    "AUDIT_ACCEPTED",
    "AUDIT_REJECTED",
    "AUDIT_OUTCOMES",
    "AUDIT_FORBIDDEN_DETAIL_KEYS",
    "AuditEntry",
    "AuditExportRequest",
    "AuditExportBundle",
    "export_audit",
    # metrics
    "DIMENSION_LEARNING",
    "DIMENSION_SYSTEM",
    "DIMENSION_COST",
    "METRIC_DIMENSIONS",
    "AGG_SUM",
    "AGG_MEAN",
    "AGG_GAUGE",
    "AGG_RATIO",
    "AGGREGATIONS",
    "SOURCE_OBSERVED",
    "SOURCE_SIMULATED",
    "METRIC_SOURCES",
    "MIN_COHORT_SIZE",
    "MetricDefinition",
    "METRIC_DEFINITIONS",
    "MetricSample",
    "MetricCell",
    "CohortCell",
    "CohortView",
    "DashboardSnapshot",
    "MetricsDashboard",
    # cost
    "BILLING_CONNECTED",
    "CostModel",
    "DEFAULT_COST_MODELS",
    "UsageRecord",
    "CostEstimate",
    "estimate_cost",
    "CostEstimator",
]
