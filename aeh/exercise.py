"""Intervention packages and delivery validation (spec section 9.2 / 9.4).

The unit of delivery is not a single question but an ``InterventionPackage``:
learning objective, training item group, hint ladder, feedback templates,
explanation resources, an independent unseen transfer test and completion
criteria.

Every item is re-checked with the curriculum gate before delivery.  A package
that fails validation can never be delivered: :func:`validate_package` reports
the reasons and :func:`deliver` raises instead of handing anything to a student.

Standard library only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from .curriculum_gate import (
    MODE_LEARN,
    CurriculumItem,
    GateDecision,
    LearnerProgress,
    allow,
)


class InterventionError(Exception):
    """Base class for intervention-package errors."""


class InterventionNotDeliverable(InterventionError):
    """Raised when a candidate package did not pass validation."""

    def __init__(self, package_id: str, reasons: Iterable[str]) -> None:
        self.package_id = package_id
        self.reasons = tuple(reasons)
        super().__init__(
            f"intervention {package_id!r} not deliverable: {', '.join(self.reasons)}"
        )


@dataclass(frozen=True)
class InterventionPackage:
    """A complete candidate intervention (spec 9.2).

    ``training_items`` and ``transfer_items`` are kept strictly separate so
    training, explanation and transfer evaluation do not leak into each other.
    """

    package_id: str
    objective_id: str
    training_items: tuple[CurriculumItem, ...]
    transfer_items: tuple[CurriculumItem, ...] = ()
    hint_ladder: tuple[str, ...] = ()
    feedback_templates: Mapping[str, str] = field(default_factory=dict)
    explanation_resources: tuple[str, ...] = ()
    completion_criteria: Mapping[str, Any] = field(default_factory=dict)
    required_kcs: tuple[str, ...] = ()
    independent_transfer: bool = True
    school_mode: str = MODE_LEARN

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "feedback_templates", MappingProxyType(dict(self.feedback_templates))
        )
        object.__setattr__(
            self, "completion_criteria", MappingProxyType(dict(self.completion_criteria))
        )

    def all_items(self) -> tuple[CurriculumItem, ...]:
        return tuple(self.training_items) + tuple(self.transfer_items)


@dataclass(frozen=True)
class PackageValidation:
    """Validation outcome with per-item gate decisions for auditing."""

    valid: bool
    reasons: tuple[str, ...]
    item_decisions: Mapping[str, GateDecision]
    allowed_kcs: frozenset[str]

    def __bool__(self) -> bool:
        return self.valid


@dataclass(frozen=True)
class DeliveryReceipt:
    """Proof that an intervention passed the gate and reached the student."""

    package_id: str
    student_id: str
    delivered_at: datetime
    item_ids: tuple[str, ...]
    mode: str


def _gate_item(
    item: CurriculumItem,
    progress: LearnerProgress,
    mode: str,
) -> GateDecision:
    # Exercise delivery always uses the requested mode; the gate remains
    # fail-closed on missing annotations.
    return allow(item, progress, mode)


def validate_package(
    package: InterventionPackage,
    progress: LearnerProgress,
    *,
    mode: str | None = None,
) -> PackageValidation:
    """Validate structure, isolation and curriculum boundaries (fail-closed)."""
    mode = mode or package.school_mode or MODE_LEARN
    reasons: list[str] = []
    decisions: dict[str, GateDecision] = {}

    if not package.training_items:
        reasons.append("missing_training_items")
    if not package.hint_ladder:
        reasons.append("missing_hint_ladder")
    if not package.completion_criteria:
        reasons.append("missing_completion_criteria")
    if package.independent_transfer and not package.transfer_items:
        reasons.append("missing_transfer_items")
    if not package.required_kcs:
        reasons.append("missing_required_kcs")

    training_ids = {item.item_id for item in package.training_items}
    transfer_ids = {item.item_id for item in package.transfer_items}
    overlap = training_ids & transfer_ids
    if overlap:
        reasons.append("training_transfer_overlap:" + ",".join(sorted(overlap)))

    allowed_union: set[str] = set()
    for item in package.all_items():
        decision = _gate_item(item, progress, mode)
        decisions[item.item_id] = decision
        allowed_union |= set(decision.allowed_kcs)
        if not decision.allowed:
            reasons.append(f"gate_rejected:{item.item_id}:" + ",".join(decision.reasons))

    for item in package.transfer_items:
        if item.seen_before:
            # Transfer evaluation must use an unseen item (spec 9.6).
            reasons.append(f"transfer_item_seen_before:{item.item_id}")

    missing_required = [kc for kc in package.required_kcs if kc not in allowed_union]
    if missing_required:
        reasons.append("required_kcs_not_allowed:" + ",".join(missing_required))

    return PackageValidation(
        valid=not reasons,
        reasons=tuple(reasons),
        item_decisions=MappingProxyType(decisions),
        allowed_kcs=frozenset(allowed_union),
    )


def deliver(
    package: InterventionPackage,
    progress: LearnerProgress,
    *,
    mode: str | None = None,
    delivered_at: datetime | None = None,
) -> DeliveryReceipt:
    """Validate then deliver; rejected candidates never reach the student."""
    validation = validate_package(package, progress, mode=mode)
    if not validation.valid:
        raise InterventionNotDeliverable(package.package_id, validation.reasons)
    return DeliveryReceipt(
        package_id=package.package_id,
        student_id=progress.student_id,
        delivered_at=delivered_at or datetime.now(timezone.utc),
        item_ids=tuple(item.item_id for item in package.all_items()),
        mode=mode or package.school_mode,
    )


def package_ready(
    package: InterventionPackage, progress: LearnerProgress, *, mode: str | None = None
) -> bool:
    """Convenience predicate; equivalent to ``validate_package(...).valid``."""
    return validate_package(package, progress, mode=mode).valid


__all__ = [
    "InterventionPackage",
    "PackageValidation",
    "DeliveryReceipt",
    "InterventionError",
    "InterventionNotDeliverable",
    "validate_package",
    "deliver",
    "package_ready",
]
