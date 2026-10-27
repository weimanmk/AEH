"""Tests for the fail-closed curriculum gate (spec section 4.3)."""

from __future__ import annotations

import unittest

from aeh.curriculum_gate import (
    MODE_LEARN,
    MODE_PREVIEW,
    MODE_REVIEW,
    CurriculumItem,
    LearnerProgress,
    allow,
    allowed_kcs,
    filter_allowed,
)


TAUGHT = "algebra.square_formula"
IN_PROGRESS = "algebra.completing_square"
PREVIEW = "algebra.quadratic_formula"
PRIOR = "arithmetic.fractions"
UNTAUGHT = "calculus.derivative"


def make_progress(**overrides):
    values = {
        "student_id": "stu_1",
        "grade_level": 8,
        "taught_kcs": frozenset({TAUGHT}),
        "in_progress_kcs": frozenset({IN_PROGRESS}),
        "confirmed_preview_kcs": frozenset({PREVIEW}),
        "confirmed_prior_kcs": frozenset({PRIOR}),
        "progress_confidence": 0.95,
        "current_load": 0.0,
        "load_budget": 1.0,
        "extension_mode": False,
    }
    values.update(overrides)
    return LearnerProgress(**values)


def make_item(**overrides):
    values = {
        "item_id": "q_1",
        "required_kcs": (TAUGHT,),
        "grade_level": 8,
        "safety_checked": True,
        "content_verified": True,
        "annotation_confidence": 0.95,
        "future_methods": (),
        "cognitive_load": 0.2,
        "extension_approved": False,
        "seen_before": False,
    }
    values.update(overrides)
    return CurriculumItem(**values)


class AllowedKnowledgeTests(unittest.TestCase):
    def test_learn_includes_taught_in_progress_and_prior(self):
        progress = make_progress()
        result = allowed_kcs(progress, MODE_LEARN)
        self.assertIn(TAUGHT, result)
        self.assertIn(IN_PROGRESS, result)
        self.assertIn(PRIOR, result)
        self.assertNotIn(PREVIEW, result)

    def test_preview_adds_confirmed_preview_set(self):
        result = allowed_kcs(make_progress(), MODE_PREVIEW)
        self.assertIn(PREVIEW, result)
        self.assertIn(TAUGHT, result)

    def test_review_does_not_open_unconfirmed_preview(self):
        result = allowed_kcs(make_progress(), MODE_REVIEW)
        self.assertNotIn(PREVIEW, result)

    def test_low_confidence_progress_locks_in_progress_and_preview(self):
        progress = make_progress(progress_confidence=0.2)
        for mode in (MODE_PREVIEW, MODE_LEARN, MODE_REVIEW):
            result = allowed_kcs(progress, mode)
            self.assertIn(TAUGHT, result)
            self.assertIn(PRIOR, result)
            self.assertNotIn(IN_PROGRESS, result)
            self.assertNotIn(PREVIEW, result)

    def test_unknown_mode_has_no_allowed_kcs(self):
        self.assertEqual(allowed_kcs(make_progress(), "exam"), frozenset())


class GateAdmissionTests(unittest.TestCase):
    def test_taught_content_is_allowed_in_learn_mode(self):
        decision = allow(make_item(), make_progress(), MODE_LEARN)
        self.assertTrue(decision.allowed)
        self.assertTrue(bool(decision))
        self.assertEqual(decision.reasons, ())
        self.assertEqual(decision.mode, MODE_LEARN)

    def test_future_knowledge_is_rejected(self):
        decision = allow(
            make_item(required_kcs=(UNTAUGHT,)), make_progress(), MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertIn(f"kcs_not_allowed:{UNTAUGHT}", decision.reasons)

    def test_preview_only_allows_confirmed_preview_kcs(self):
        allowed = allow(
            make_item(required_kcs=(PREVIEW,)), make_progress(), MODE_PREVIEW
        )
        rejected = allow(
            make_item(required_kcs=(UNTAUGHT,)), make_progress(), MODE_PREVIEW
        )
        self.assertTrue(allowed.allowed)
        self.assertFalse(rejected.allowed)

    def test_unverified_progress_does_not_unlock_in_progress_core_kc(self):
        progress = make_progress(progress_confidence=0.1)
        decision = allow(
            make_item(required_kcs=(IN_PROGRESS,)), progress, MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertTrue(
            any("kcs_not_allowed" in reason for reason in decision.reasons)
        )

    def test_missing_annotation_confidence_fails_closed(self):
        decision = allow(
            make_item(annotation_confidence=None), make_progress(), MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertIn("missing_annotation_confidence", decision.reasons)

    def test_low_annotation_confidence_fails_closed(self):
        decision = allow(
            make_item(annotation_confidence=0.2), make_progress(), MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertIn("low_annotation_confidence", decision.reasons)

    def test_invalid_annotation_confidence_fails_closed(self):
        decision = allow(
            make_item(annotation_confidence="high"), make_progress(), MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertIn("invalid_annotation_confidence", decision.reasons)

    def test_missing_safety_or_content_verification_fails_closed(self):
        unsafe = allow(
            make_item(safety_checked=False), make_progress(), MODE_LEARN
        )
        unverified = allow(
            make_item(content_verified=False), make_progress(), MODE_LEARN
        )
        self.assertIn("safety_not_verified", unsafe.reasons)
        self.assertIn("content_not_verified", unverified.reasons)

    def test_missing_required_kcs_is_rejected(self):
        decision = allow(make_item(required_kcs=()), make_progress(), MODE_LEARN)
        self.assertFalse(decision.allowed)
        self.assertIn("missing_required_kcs", decision.reasons)

    def test_unknown_mode_is_rejected(self):
        decision = allow(make_item(), make_progress(), "cram")
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.allowed_kcs, frozenset())
        self.assertIn("unknown_mode:cram", decision.reasons)

    def test_unapproved_future_method_is_rejected(self):
        decision = allow(
            make_item(future_methods=("implicit_differentiation",)),
            make_progress(),
            MODE_LEARN,
        )
        self.assertFalse(decision.allowed)
        self.assertIn("unapproved_future_method", decision.reasons)

    def test_approved_extension_can_reach_one_grade_ahead(self):
        item = make_item(
            grade_level=9,
            extension_approved=True,
            future_methods=("next_grade_method",),
        )
        self.assertTrue(allow(item, make_progress(), MODE_LEARN).allowed)
        two_ahead = make_item(grade_level=10, extension_approved=True)
        self.assertFalse(allow(two_ahead, make_progress(), MODE_LEARN).allowed)

    def test_grade_above_learner_is_rejected_without_extension(self):
        decision = allow(
            make_item(grade_level=9), make_progress(), MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertIn("grade_not_appropriate", decision.reasons)

    def test_backward_remediation_across_grades_is_allowed(self):
        progress = make_progress(
            grade_level=10, confirmed_prior_kcs=frozenset({PRIOR})
        )
        item = make_item(required_kcs=(PRIOR,), grade_level=6)
        self.assertTrue(allow(item, progress, MODE_LEARN).allowed)

    def test_cognitive_load_budget_fails_closed(self):
        overloaded = allow(
            make_item(cognitive_load=0.3),
            make_progress(current_load=0.8),
            MODE_LEARN,
        )
        self.assertFalse(overloaded.allowed)
        self.assertIn("cognitive_load_exceeded", overloaded.reasons)

    def test_missing_load_budget_fails_closed(self):
        decision = allow(
            make_item(), make_progress(load_budget=None), MODE_LEARN
        )
        self.assertFalse(decision.allowed)
        self.assertIn("cognitive_load_exceeded", decision.reasons)

    def test_mapping_inputs_are_supported(self):
        item = {
            "item_id": "q_map",
            "required_kcs": (TAUGHT,),
            "grade_level": 8,
            "safety_checked": True,
            "content_verified": True,
            "annotation_confidence": 0.9,
            "cognitive_load": 0.1,
        }
        progress = {
            "student_id": "stu_map",
            "grade_level": 8,
            "taught_kcs": frozenset({TAUGHT}),
            "progress_confidence": 0.9,
            "load_budget": 1.0,
        }
        decision = allow(item, progress, MODE_LEARN)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.item_id, "q_map")

    def test_filter_allowed_preserves_order_and_rejects_future(self):
        items = [
            make_item(item_id="ok_1"),
            make_item(item_id="future", required_kcs=(UNTAUGHT,)),
            make_item(item_id="ok_2", required_kcs=(PRIOR,)),
        ]
        filtered = filter_allowed(items, make_progress(), MODE_LEARN)
        self.assertEqual([item.item_id for item in filtered], ["ok_1", "ok_2"])


if __name__ == "__main__":
    unittest.main()
