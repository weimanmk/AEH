"""Tests for intervention packages and fail-closed delivery (spec 9.2 / 9.4)."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from aeh.curriculum_gate import (
    MODE_LEARN,
    MODE_PREVIEW,
    CurriculumItem,
    LearnerProgress,
)
from aeh.exercise import (
    InterventionNotDeliverable,
    InterventionPackage,
    deliver,
    package_ready,
    validate_package,
)


TAUGHT = "algebra.square_formula"
PREVIEW = "algebra.quadratic_formula"
UNTAUGHT = "calculus.derivative"


def make_progress(**overrides):
    values = {
        "student_id": "stu_1",
        "grade_level": 8,
        "taught_kcs": frozenset({TAUGHT}),
        "in_progress_kcs": frozenset(),
        "confirmed_preview_kcs": frozenset({PREVIEW}),
        "confirmed_prior_kcs": frozenset(),
        "progress_confidence": 0.95,
        "current_load": 0.0,
        "load_budget": 1.0,
    }
    values.update(overrides)
    return LearnerProgress(**values)


def make_item(item_id: str, required_kcs=(TAUGHT,), **overrides) -> CurriculumItem:
    values = {
        "item_id": item_id,
        "required_kcs": tuple(required_kcs),
        "grade_level": 8,
        "safety_checked": True,
        "content_verified": True,
        "annotation_confidence": 0.95,
        "cognitive_load": 0.1,
        "seen_before": False,
    }
    values.update(overrides)
    return CurriculumItem(**values)


def make_package(**overrides) -> InterventionPackage:
    values = {
        "package_id": "pkg_1",
        "objective_id": "obj.completing_square",
        "training_items": (make_item("train_1"),),
        "transfer_items": (make_item("transfer_1"),),
        "hint_ladder": ("concept_hint", "step_hint"),
        "feedback_templates": {"wrong_sign": "Check the sign of the linear term."},
        "explanation_resources": ("micro_lesson_1",),
        "completion_criteria": {"accuracy": 0.8, "max_hints": 1},
        "required_kcs": (TAUGHT,),
        "independent_transfer": True,
        "school_mode": MODE_LEARN,
    }
    values.update(overrides)
    return InterventionPackage(**values)


class PackageValidationTests(unittest.TestCase):
    def test_complete_package_is_valid(self):
        validation = validate_package(make_package(), make_progress())
        self.assertTrue(validation.valid)
        self.assertTrue(bool(validation))
        self.assertEqual(validation.reasons, ())
        self.assertEqual(
            set(validation.item_decisions), {"train_1", "transfer_1"}
        )

    def test_missing_components_are_reported(self):
        empty = InterventionPackage(
            package_id="pkg_empty",
            objective_id="obj",
            training_items=(),
            transfer_items=(),
            required_kcs=(),
        )
        validation = validate_package(empty, make_progress())
        self.assertFalse(validation.valid)
        for reason in (
            "missing_training_items",
            "missing_hint_ladder",
            "missing_completion_criteria",
            "missing_transfer_items",
            "missing_required_kcs",
        ):
            self.assertIn(reason, validation.reasons)

    def test_rejected_item_cannot_reach_delivery(self):
        package = make_package(
            training_items=(make_item("train_future", (UNTAUGHT,)),),
            required_kcs=(UNTAUGHT,),
        )
        validation = validate_package(package, make_progress())
        self.assertFalse(validation.valid)
        self.assertTrue(
            any(
                reason.startswith("gate_rejected:train_future:")
                for reason in validation.reasons
            )
        )
        with self.assertRaises(InterventionNotDeliverable) as context:
            deliver(package, make_progress())
        self.assertEqual(context.exception.package_id, "pkg_1")
        self.assertIn("train_future", str(context.exception))

    def test_low_confidence_item_is_rejected(self):
        package = make_package(
            training_items=(
                make_item("train_low_conf", annotation_confidence=0.1),
            )
        )
        validation = validate_package(package, make_progress())
        self.assertFalse(validation.valid)
        self.assertTrue(
            any("low_annotation_confidence" in reason for reason in validation.reasons)
        )

    def test_training_and_transfer_items_must_not_overlap(self):
        shared = make_item("shared")
        package = make_package(training_items=(shared,), transfer_items=(shared,))
        validation = validate_package(package, make_progress())
        self.assertFalse(validation.valid)
        self.assertIn("training_transfer_overlap:shared", validation.reasons)

    def test_transfer_item_must_be_unseen(self):
        package = make_package(
            transfer_items=(make_item("transfer_seen", seen_before=True),)
        )
        validation = validate_package(package, make_progress())
        self.assertFalse(validation.valid)
        self.assertIn("transfer_item_seen_before:transfer_seen", validation.reasons)

    def test_required_kcs_must_be_inside_allowed_set(self):
        package = make_package(required_kcs=(TAUGHT, UNTAUGHT))
        validation = validate_package(package, make_progress())
        self.assertFalse(validation.valid)
        self.assertIn(
            f"required_kcs_not_allowed:{UNTAUGHT}", validation.reasons
        )

    def test_no_transfer_needed_when_independent_transfer_is_false(self):
        package = make_package(transfer_items=(), independent_transfer=False)
        self.assertTrue(package_ready(package, make_progress()))

    def test_preview_mode_uses_confirmed_preview_set_only(self):
        preview_package = make_package(
            training_items=(make_item("train_preview", (PREVIEW,)),),
            transfer_items=(make_item("transfer_preview", (PREVIEW,)),),
            required_kcs=(PREVIEW,),
        )
        self.assertTrue(
            package_ready(preview_package, make_progress(), mode=MODE_PREVIEW)
        )
        future_package = make_package(
            training_items=(make_item("train_future", (UNTAUGHT,)),),
            transfer_items=(make_item("transfer_future", (UNTAUGHT,)),),
            required_kcs=(UNTAUGHT,),
        )
        self.assertFalse(
            package_ready(future_package, make_progress(), mode=MODE_PREVIEW)
        )

    def test_unknown_mode_rejects_the_whole_package(self):
        validation = validate_package(make_package(), make_progress(), mode="exam")
        self.assertFalse(validation.valid)
        self.assertTrue(
            any("unknown_mode:exam" in reason for reason in validation.reasons)
        )

    def test_unsafe_item_blocks_delivery(self):
        package = make_package(
            training_items=(make_item("train_unsafe", safety_checked=False),)
        )
        validation = validate_package(package, make_progress())
        self.assertFalse(validation.valid)
        self.assertTrue(
            any("safety_not_verified" in reason for reason in validation.reasons)
        )


class DeliveryTests(unittest.TestCase):
    def test_valid_package_returns_auditable_receipt(self):
        delivered_at = datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc)
        receipt = deliver(
            make_package(), make_progress(), delivered_at=delivered_at
        )
        self.assertEqual(receipt.package_id, "pkg_1")
        self.assertEqual(receipt.student_id, "stu_1")
        self.assertEqual(receipt.item_ids, ("train_1", "transfer_1"))
        self.assertEqual(receipt.mode, MODE_LEARN)
        self.assertEqual(receipt.delivered_at, delivered_at)

    def test_invalid_package_raises_instead_of_returning_a_receipt(self):
        package = make_package(required_kcs=(UNTAUGHT,))
        with self.assertRaises(InterventionNotDeliverable):
            deliver(package, make_progress())

    def test_package_ready_matches_validation(self):
        package = make_package()
        self.assertTrue(package_ready(package, make_progress()))
        self.assertFalse(
            package_ready(
                make_package(training_items=(make_item("x", (UNTAUGHT,)),)),
                make_progress(),
            )
        )


if __name__ == "__main__":
    unittest.main()
