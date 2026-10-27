"""Teacher / guardian reports built only from authorised aggregate events.

Step 2 of ``TASKS.md`` asks for a report generator that consumes **only
authorised aggregate events** and never emits a student's raw data.  The
design therefore starts from a deliberately narrow input:

* :class:`AggregateEvent` has fixed numeric fields.  It has no free-text
  question, answer, image, step trace or arbitrary ``payload`` mapping, so raw
  student data has no field in which to enter the report pipeline.
* Every event carries a ``consent_scope``.  :func:`generate_report` intersects
  the scopes allowed for the audience with the caller's optional narrower
  scope list.  A caller cannot widen a guardian's access by passing a scope
  that is only meant for teachers.
* Events for another student, outside the requested window, unauthorised or
  duplicated are counted as excluded and never affect the totals.
* Event ids are used for de-duplication only; they are never rendered in the
  report.  The only identity value in the output is the caller-supplied
  pseudonymous ``student_ref``.

This is a report *policy* skeleton, not a complete consent or access-control
service.  The surrounding product still needs authenticated principals,
server-side scope resolution, audit logs and retention/deletion handling.

Standard library only.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping

#: Event kinds understood by the aggregate report pipeline.
KIND_ATTEMPT = "attempt_aggregate"
KIND_REVIEW = "review_aggregate"
KIND_DIAGNOSIS = "diagnosis_aggregate"
KIND_INTERVENTION = "intervention_aggregate"

AGGREGATE_KINDS: frozenset[str] = frozenset(
    {KIND_ATTEMPT, KIND_REVIEW, KIND_DIAGNOSIS, KIND_INTERVENTION}
)

AUDIENCE_TEACHER = "teacher"
AUDIENCE_GUARDIAN = "guardian"
AUDIENCES: frozenset[str] = frozenset({AUDIENCE_TEACHER, AUDIENCE_GUARDIAN})

#: Scopes an audience may use by default.  ``educational_report`` is shared;
#: the audience-specific scopes allow finer-grained consent.
DEFAULT_AUDIENCE_SCOPES: Mapping[str, frozenset[str]] = MappingProxyType(
    {
        AUDIENCE_TEACHER: frozenset(
            {"educational_report", "teacher_report"}
        ),
        AUDIENCE_GUARDIAN: frozenset(
            {"educational_report", "guardian_report"}
        ),
    }
)

#: Below this independent accuracy (with enough attempts) a topic is flagged
#: for human attention.  This is an aggregate hint, not a student label.
ATTENTION_ACCURACY_THRESHOLD = 0.6
ATTENTION_MIN_ATTEMPTS = 3

#: Conservative identifier/label grammar.  It rejects whitespace, newlines and
#: arbitrary prose, which keeps free-text raw data out of aggregate events.
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")


class ReportError(Exception):
    """Base class for report errors."""


class InvalidAggregateEvent(ReportError, ValueError):
    """An aggregate event is malformed or contains unsafe fields."""


class InvalidReportRequest(ReportError, ValueError):
    """The requested audience, window or scope set is invalid."""


def _check_identifier(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not _IDENTIFIER_RE.fullmatch(value):
        raise InvalidAggregateEvent(
            f"{field_name} must be a short identifier, got {value!r}"
        )


def _check_label(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not _LABEL_RE.fullmatch(value):
        raise InvalidAggregateEvent(
            f"{field_name} must be a short curriculum label, got {value!r}"
        )


def _check_aware(value: datetime, field_name: str) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise InvalidReportRequest(f"{field_name} must be timezone-aware")
    if value.utcoffset() is None:
        raise InvalidReportRequest(f"{field_name} must have a UTC offset")


def _non_negative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise InvalidAggregateEvent(f"{field_name} must be a non-negative integer")
    return value


def _non_negative_float(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidAggregateEvent(f"{field_name} must be a non-negative number")
    result = float(value)
    if not math.isfinite(result) or result < 0.0:
        raise InvalidAggregateEvent(f"{field_name} must be finite and >= 0")
    return result


@dataclass(frozen=True)
class AggregateEvent:
    """One authorised, pre-aggregated learning event.

    There is intentionally no raw question/answer/image field and no free-form
    metadata mapping.  A producer must aggregate before crossing this boundary.
    """

    event_id: str
    student_ref: str
    occurred_at: datetime
    kind: str
    consent_scope: str
    kc_id: str
    attempts: int = 0
    independent_correct: int = 0
    hinted_correct: int = 0
    hints_requested: int = 0
    reviews_due: int = 0
    reviews_completed: int = 0
    minutes: float = 0.0

    def __post_init__(self) -> None:
        _check_identifier(self.event_id, "event_id")
        _check_identifier(self.student_ref, "student_ref")
        _check_identifier(self.consent_scope, "consent_scope")
        _check_label(self.kc_id, "kc_id")
        if self.kind not in AGGREGATE_KINDS:
            raise InvalidAggregateEvent(f"unsupported aggregate kind {self.kind!r}")
        if not isinstance(self.occurred_at, datetime) or self.occurred_at.tzinfo is None:
            raise InvalidAggregateEvent("occurred_at must be timezone-aware")
        if self.occurred_at.utcoffset() is None:
            raise InvalidAggregateEvent("occurred_at must have a UTC offset")

        object.__setattr__(
            self, "attempts", _non_negative_int(self.attempts, "attempts")
        )
        object.__setattr__(
            self,
            "independent_correct",
            _non_negative_int(self.independent_correct, "independent_correct"),
        )
        object.__setattr__(
            self,
            "hinted_correct",
            _non_negative_int(self.hinted_correct, "hinted_correct"),
        )
        object.__setattr__(
            self,
            "hints_requested",
            _non_negative_int(self.hints_requested, "hints_requested"),
        )
        object.__setattr__(
            self, "reviews_due", _non_negative_int(self.reviews_due, "reviews_due")
        )
        object.__setattr__(
            self,
            "reviews_completed",
            _non_negative_int(self.reviews_completed, "reviews_completed"),
        )
        object.__setattr__(
            self, "minutes", _non_negative_float(self.minutes, "minutes")
        )
        if self.independent_correct + self.hinted_correct > self.attempts:
            raise InvalidAggregateEvent(
                "independent_correct + hinted_correct cannot exceed attempts"
            )


@dataclass(frozen=True)
class AggregateMetrics:
    """Additive aggregate counters plus derived rates."""

    attempts: int = 0
    independent_correct: int = 0
    hinted_correct: int = 0
    hints_requested: int = 0
    reviews_due: int = 0
    reviews_completed: int = 0
    minutes: float = 0.0

    def __post_init__(self) -> None:
        for name in (
            "attempts",
            "independent_correct",
            "hinted_correct",
            "hints_requested",
            "reviews_due",
            "reviews_completed",
        ):
            object.__setattr__(
                self, name, _non_negative_int(getattr(self, name), name)
            )
        object.__setattr__(self, "minutes", _non_negative_float(self.minutes, "minutes"))
        if self.independent_correct + self.hinted_correct > self.attempts:
            raise InvalidAggregateEvent(
                "independent_correct + hinted_correct cannot exceed attempts"
            )

    def __add__(self, other: "AggregateMetrics") -> "AggregateMetrics":
        if not isinstance(other, AggregateMetrics):
            return NotImplemented
        return AggregateMetrics(
            attempts=self.attempts + other.attempts,
            independent_correct=self.independent_correct + other.independent_correct,
            hinted_correct=self.hinted_correct + other.hinted_correct,
            hints_requested=self.hints_requested + other.hints_requested,
            reviews_due=self.reviews_due + other.reviews_due,
            reviews_completed=self.reviews_completed + other.reviews_completed,
            minutes=self.minutes + other.minutes,
        )

    @property
    def independent_accuracy(self) -> float | None:
        if self.attempts == 0:
            return None
        return self.independent_correct / self.attempts

    @property
    def hints_per_attempt(self) -> float | None:
        if self.attempts == 0:
            return None
        return self.hints_requested / self.attempts

    @property
    def review_completion_rate(self) -> float | None:
        if self.reviews_due == 0:
            return None
        return min(1.0, self.reviews_completed / self.reviews_due)

    def as_dict(self) -> dict[str, Any]:
        return {
            "attempts": self.attempts,
            "independent_correct": self.independent_correct,
            "hinted_correct": self.hinted_correct,
            "hints_requested": self.hints_requested,
            "reviews_due": self.reviews_due,
            "reviews_completed": self.reviews_completed,
            "minutes": round(self.minutes, 3),
            "independent_accuracy": _round_optional(self.independent_accuracy),
            "hints_per_attempt": _round_optional(self.hints_per_attempt),
            "review_completion_rate": _round_optional(self.review_completion_rate),
        }


def _round_optional(value: float | None) -> float | None:
    return None if value is None else round(value, 4)


def _attention_reasons(metrics: AggregateMetrics) -> tuple[str, ...]:
    reasons: list[str] = []
    accuracy = metrics.independent_accuracy
    if (
        metrics.attempts >= ATTENTION_MIN_ATTEMPTS
        and accuracy is not None
        and accuracy < ATTENTION_ACCURACY_THRESHOLD
    ):
        reasons.append("low_independent_accuracy")
    if metrics.reviews_due > metrics.reviews_completed:
        reasons.append("reviews_not_completed")
    return tuple(reasons)


@dataclass(frozen=True)
class TopicSummary:
    """Per-knowledge-component aggregate.  ``kc_id`` is a curriculum id."""

    kc_id: str
    metrics: AggregateMetrics
    attention_reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _check_label(self.kc_id, "kc_id")

    @property
    def needs_attention(self) -> bool:
        return bool(self.attention_reasons)

    def as_dict(self) -> dict[str, Any]:
        data = {"kc_id": self.kc_id}
        data.update(self.metrics.as_dict())
        data["attention_reasons"] = list(self.attention_reasons)
        return data


@dataclass(frozen=True)
class LearningReport:
    """A rendered report value object with no raw student data or event ids."""

    audience: str
    student_ref: str
    window_start: datetime
    window_end: datetime
    generated_at: datetime
    events_used: int
    events_excluded: int
    totals: AggregateMetrics
    topics: tuple[TopicSummary, ...]
    authorized_scopes: frozenset[str] = field(default_factory=frozenset)

    @property
    def attention_topics(self) -> tuple[TopicSummary, ...]:
        return tuple(topic for topic in self.topics if topic.needs_attention)

    def as_dict(self) -> dict[str, Any]:
        """JSON-friendly view; never includes event ids or raw payloads."""
        return {
            "report_type": f"{self.audience}_learning_report",
            "audience": self.audience,
            "student_ref": self.student_ref,
            "window": {
                "start": self.window_start.isoformat(),
                "end": self.window_end.isoformat(),
                "boundary": "start_inclusive_end_exclusive",
            },
            "generated_at": self.generated_at.isoformat(),
            "data_minimization": {
                "authorized_aggregate_events_only": True,
                "raw_student_data_included": False,
                "event_ids_included": False,
                "source_events_used": self.events_used,
                "source_events_excluded": self.events_excluded,
                "authorized_scopes": sorted(self.authorized_scopes),
            },
            "totals": self.totals.as_dict(),
            "topics": [topic.as_dict() for topic in self.topics],
            "attention_topics": [topic.kc_id for topic in self.attention_topics],
        }

    def to_markdown(self) -> str:
        """Render a teacher/guardian report without raw data or event ids."""
        audience_name = {
            AUDIENCE_TEACHER: "教师",
            AUDIENCE_GUARDIAN: "家长/监护人",
        }.get(self.audience, self.audience)

        def rate(value: float | None) -> str:
            return "—" if value is None else f"{value:.0%}"

        totals = self.totals
        lines = [
            f"# {audience_name}学习报告（聚合）",
            "",
            f"- 学生引用（伪匿名）：`{self.student_ref}`",
            f"- 统计窗口：{self.window_start.isoformat()} — "
            f"{self.window_end.isoformat()}（含起点，不含终点）",
            f"- 生成时间：{self.generated_at.isoformat()}",
            "- 数据最小化：仅使用已授权聚合事件；不包含原始图片、题目、"
            "作答文本或事件 ID。",
            "",
            "## 总览",
            "",
            f"- 纳入聚合事件：{self.events_used}；因未授权/越界/重复排除："
            f"{self.events_excluded}",
            f"- 学习尝试：{totals.attempts}；独立正确："
            f"{totals.independent_correct}；独立正确率："
            f"{rate(totals.independent_accuracy)}",
            f"- 提示次数：{totals.hints_requested}；提示后正确："
            f"{totals.hinted_correct}",
            f"- 复习完成：{totals.reviews_completed}/{totals.reviews_due}",
            f"- 累计学习时长（分钟）：{totals.minutes:.1f}",
            "",
            "## 知识点聚合",
            "",
            "| 知识点 | 尝试 | 独立正确率 | 每尝试提示数 | 复习完成 | 待关注 |",
            "|---|---:|---:|---:|---:|---|",
        ]
        if not self.topics:
            lines.append("| （无已授权聚合事件） | 0 | — | — | 0/0 | — |")
        for topic in self.topics:
            metrics = topic.metrics
            flag = "是" if topic.needs_attention else "否"
            hints = (
                "—"
                if metrics.hints_per_attempt is None
                else f"{metrics.hints_per_attempt:.2f}"
            )
            lines.append(
                f"| {topic.kc_id} | {metrics.attempts} | "
                f"{rate(metrics.independent_accuracy)} | {hints} | "
                f"{metrics.reviews_completed}/{metrics.reviews_due} | {flag} |"
            )
        lines += ["", "## 待关注点", ""]
        if self.attention_topics:
            for topic in self.attention_topics:
                lines.append(
                    f"- {topic.kc_id}："
                    + "、".join(topic.attention_reasons)
                )
        else:
            lines.append("- 无（仅基于当前窗口内的聚合数据）。")
        lines += [
            "",
            "> 说明：以上是聚合统计与不确定性提示，不是学生能力标签，"
            "也不替代教师判断。",
            "",
        ]
        return "\n".join(lines)


def effective_scopes(
    audience: str, authorized_scopes: Iterable[str] | None = None
) -> frozenset[str]:
    """Return the scopes usable by ``audience``.

    A caller-provided list can only *narrow* the audience default; it can never
    grant a guardian a teacher-only scope or vice versa.
    """
    if audience not in AUDIENCES:
        raise InvalidReportRequest(f"unknown audience {audience!r}")
    base = DEFAULT_AUDIENCE_SCOPES[audience]
    if authorized_scopes is None:
        return base
    if isinstance(authorized_scopes, str):
        # A bare string is a single scope, not an iterable of characters.
        requested = frozenset({authorized_scopes})
    else:
        requested = frozenset(str(scope) for scope in authorized_scopes)
    return frozenset(base & requested)


def generate_report(
    events: Iterable[AggregateEvent],
    *,
    audience: str,
    student_ref: str,
    window_start: datetime,
    window_end: datetime,
    authorized_scopes: Iterable[str] | None = None,
    generated_at: datetime | None = None,
) -> LearningReport:
    """Aggregate authorised events into a teacher/guardian report.

    Filters, in order: duplicate event id, other student, unauthorised consent
    scope, and outside the ``[window_start, window_end)`` window.  Excluded
    events are counted but their contents are never rendered.
    """
    scopes = effective_scopes(audience, authorized_scopes)
    try:
        _check_identifier(student_ref, "student_ref")
    except InvalidAggregateEvent as exc:
        raise InvalidReportRequest(str(exc)) from exc
    _check_aware(window_start, "window_start")
    _check_aware(window_end, "window_end")
    if window_start >= window_end:
        raise InvalidReportRequest("window_start must be before window_end")
    generated_at = generated_at or datetime.now(timezone.utc)
    _check_aware(generated_at, "generated_at")

    totals = AggregateMetrics()
    per_topic: dict[str, AggregateMetrics] = {}
    seen_event_ids: set[str] = set()
    used = 0
    excluded = 0

    for event in events:
        if not isinstance(event, AggregateEvent):
            raise InvalidReportRequest(
                "report events must be AggregateEvent instances"
            )
        if event.event_id in seen_event_ids:
            excluded += 1
            continue
        seen_event_ids.add(event.event_id)

        if event.student_ref != student_ref:
            excluded += 1
            continue
        if event.consent_scope not in scopes:
            excluded += 1
            continue
        if not (window_start <= event.occurred_at < window_end):
            excluded += 1
            continue

        metrics = AggregateMetrics(
            attempts=event.attempts,
            independent_correct=event.independent_correct,
            hinted_correct=event.hinted_correct,
            hints_requested=event.hints_requested,
            reviews_due=event.reviews_due,
            reviews_completed=event.reviews_completed,
            minutes=event.minutes,
        )
        totals = totals + metrics
        per_topic[event.kc_id] = per_topic.get(event.kc_id, AggregateMetrics()) + metrics
        used += 1

    topics = tuple(
        TopicSummary(
            kc_id=kc_id,
            metrics=per_topic[kc_id],
            attention_reasons=_attention_reasons(per_topic[kc_id]),
        )
        for kc_id in sorted(per_topic)
    )
    return LearningReport(
        audience=audience,
        student_ref=student_ref,
        window_start=window_start,
        window_end=window_end,
        generated_at=generated_at,
        events_used=used,
        events_excluded=excluded,
        totals=totals,
        topics=topics,
        authorized_scopes=scopes,
    )


__all__ = [
    "AggregateEvent",
    "AggregateMetrics",
    "TopicSummary",
    "LearningReport",
    "ReportError",
    "InvalidAggregateEvent",
    "InvalidReportRequest",
    "AUDIENCE_TEACHER",
    "AUDIENCE_GUARDIAN",
    "AUDIENCES",
    "AGGREGATE_KINDS",
    "KIND_ATTEMPT",
    "KIND_REVIEW",
    "KIND_DIAGNOSIS",
    "KIND_INTERVENTION",
    "DEFAULT_AUDIENCE_SCOPES",
    "effective_scopes",
    "generate_report",
]
