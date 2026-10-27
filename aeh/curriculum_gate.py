"""Curriculum progress gate (spec section 4.3).

``allow(q, u, m)`` implements the conjunctive, fail-closed admission check:

.. code-block:: text

    allow(q,u,m) = safety_ok(q)
                 and verified_content(q)
                 and grade_appropriate(q,u)
                 and all(required_kcs(q) subset allowed_kcs(u,m))
                 and no_unapproved_future_method(q,u,m)
                 and cognitive_load_within_budget(q,u)

Missing or low-confidence annotations cause a rejection (fail-closed) rather
than a permissive default.  Unknown modes are rejected as well.

The module only uses the Python standard library so CI needs no ``pip install``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

MODE_PREVIEW = "preview"
MODE_LEARN = "learn"
MODE_REVIEW = "review"

VALID_MODES: frozenset[str] = frozenset({MODE_PREVIEW, MODE_LEARN, MODE_REVIEW})

#: Annotations below this confidence are treated as missing (fail-closed).
DEFAULT_MIN_ANNOTATION_CONFIDENCE = 0.6
#: School progress below this confidence cannot unlock in-progress/preview KCs.
DEFAULT_MIN_PROGRESS_CONFIDENCE = 0.6
#: How many grade levels an explicitly approved extension may reach forward.
MAX_EXTENSION_GRADE_DELTA = 1


def _field(obj: Any, name: str, default: Any = None) -> Any:
    """Read a field from either a mapping or a plain object."""
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


@dataclass(frozen=True)
class CurriculumItem:
    """A candidate question / teaching item with its curriculum annotations.

    ``annotation_confidence`` is the confidence of the KC/curriculum labelling.
    ``None`` means "not annotated"; the gate rejects it.
    ``future_methods`` lists methods that go beyond the learner's taught set.
    """

    item_id: str
    required_kcs: tuple[str, ...]
    grade_level: int | None = None
    safety_checked: bool = False
    content_verified: bool = False
    annotation_confidence: float | None = None
    future_methods: tuple[str, ...] = ()
    cognitive_load: float = 0.0
    extension_approved: bool = False
    role: str = "training"
    seen_before: bool = False


@dataclass(frozen=True)
class LearnerProgress:
    """The three progress axes kept separate (spec section 4.1).

    Only ``taught``/``in_progress``/``preview`` are school-progress driven.
    ``confirmed_prior_kcs`` models allowed backward remediation across grades.
    """

    student_id: str
    grade_level: int
    taught_kcs: frozenset[str] = field(default_factory=frozenset)
    in_progress_kcs: frozenset[str] = field(default_factory=frozenset)
    confirmed_preview_kcs: frozenset[str] = field(default_factory=frozenset)
    confirmed_prior_kcs: frozenset[str] = field(default_factory=frozenset)
    progress_confidence: float = 0.0
    current_load: float = 0.0
    load_budget: float = 1.0
    extension_mode: bool = False


@dataclass(frozen=True)
class GateDecision:
    """Result of :func:`allow`, including human readable rejection reasons."""

    allowed: bool
    reasons: tuple[str, ...]
    allowed_kcs: frozenset[str]
    item_id: str | None = None
    mode: str | None = None

    def __bool__(self) -> bool:  # convenient ``if allow(...):``
        return self.allowed


def allowed_kcs(
    progress: LearnerProgress | Mapping[str, Any],
    mode: str,
    *,
    min_progress_confidence: float = DEFAULT_MIN_PROGRESS_CONFIDENCE,
) -> frozenset[str]:
    """Return the knowledge components the learner may be taught in ``mode``.

    Preview  = already taught + confirmed next-lesson preview set.
    Learn    = taught/in-progress + allowed backward prerequisites.
    Review   = taught/in-progress + confirmed previously learned content.

    Unconfirmed school progress never unlocks in-progress or future content.
    """
    if mode not in VALID_MODES:
        return frozenset()

    taught = set(_field(progress, "taught_kcs", ()) or ())
    prior = set(_field(progress, "confirmed_prior_kcs", ()) or ())
    confidence = float(_field(progress, "progress_confidence", 0.0) or 0.0)
    confirmed = confidence >= min_progress_confidence

    # Backward remediation is safe even when progress is uncertain.
    allowed = taught | prior

    if confirmed:
        allowed |= set(_field(progress, "in_progress_kcs", ()) or ())
        if mode == MODE_PREVIEW:
            allowed |= set(_field(progress, "confirmed_preview_kcs", ()) or ())

    # Without confirmed progress, in-progress and preview content stays locked.
    return frozenset(allowed)


def _grade_appropriate(item: Any, progress: Any) -> bool:
    grade = _field(item, "grade_level", None)
    learner_grade = _field(progress, "grade_level", None)
    if grade is None or learner_grade is None:
        # Missing annotation -> fail closed.
        return False
    if grade <= learner_grade:
        # Revisiting older grades is always allowed (backward remediation).
        return True
    extension = bool(_field(item, "extension_approved", False)) or bool(
        _field(progress, "extension_mode", False)
    )
    if extension and (grade - learner_grade) <= MAX_EXTENSION_GRADE_DELTA:
        return True
    return False


def has_unapproved_future_method(item: Any, progress: Any, mode: str) -> bool:
    """True when the item relies on methods not yet taught (spec 4.2/4.3)."""
    future = tuple(_field(item, "future_methods", ()) or ())
    if not future:
        return False
    extension = bool(_field(item, "extension_approved", False)) or bool(
        _field(progress, "extension_mode", False)
    )
    if extension and _grade_appropriate(item, progress):
        return False
    return True


def cognitive_load_within_budget(item: Any, progress: Any) -> bool:
    """Check the cognitive-load budget; missing budget fails closed."""
    budget = _field(progress, "load_budget", None)
    if budget is None:
        return False
    load = float(_field(item, "cognitive_load", 0.0) or 0.0)
    current = float(_field(progress, "current_load", 0.0) or 0.0)
    return current + load <= float(budget) + 1e-9


def allow(
    q: Any,
    u: Any,
    m: str,
    *,
    min_annotation_confidence: float = DEFAULT_MIN_ANNOTATION_CONFIDENCE,
    min_progress_confidence: float = DEFAULT_MIN_PROGRESS_CONFIDENCE,
) -> GateDecision:
    """Fail-closed curriculum gate for candidate item ``q``, learner ``u``, mode ``m``."""
    item_id = _field(q, "item_id", None)
    if m not in VALID_MODES:
        return GateDecision(
            allowed=False,
            reasons=(f"unknown_mode:{m}",),
            allowed_kcs=frozenset(),
            item_id=item_id,
            mode=m,
        )

    allowed = allowed_kcs(
        u, m, min_progress_confidence=min_progress_confidence
    )
    required = tuple(_field(q, "required_kcs", ()) or ())
    reasons: list[str] = []

    if not bool(_field(q, "safety_checked", False)):
        reasons.append("safety_not_verified")
    if not bool(_field(q, "content_verified", False)):
        reasons.append("content_not_verified")

    confidence = _field(q, "annotation_confidence", None)
    if confidence is None:
        reasons.append("missing_annotation_confidence")
    else:
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            reasons.append("invalid_annotation_confidence")
        else:
            if confidence < min_annotation_confidence:
                reasons.append("low_annotation_confidence")

    if not required:
        reasons.append("missing_required_kcs")
    missing = tuple(kc for kc in required if kc not in allowed)
    if missing:
        reasons.append("kcs_not_allowed:" + ",".join(missing))

    if has_unapproved_future_method(q, u, m):
        reasons.append("unapproved_future_method")
    if not _grade_appropriate(q, u):
        reasons.append("grade_not_appropriate")
    if not cognitive_load_within_budget(q, u):
        reasons.append("cognitive_load_exceeded")

    return GateDecision(
        allowed=not reasons,
        reasons=tuple(reasons),
        allowed_kcs=allowed,
        item_id=item_id,
        mode=m,
    )


def filter_allowed(
    items: Iterable[Any],
    progress: LearnerProgress,
    mode: str,
    **kwargs: Any,
) -> tuple[Any, ...]:
    """Return only the items the gate admits (order preserved)."""
    return tuple(item for item in items if allow(item, progress, mode, **kwargs).allowed)
