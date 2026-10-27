"""Tests for the synthetic Step 2 demo session (offline, no real data)."""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from dataclasses import replace

from aeh.curriculum_gate import MODE_LEARN, MODE_REVIEW
from aeh.demo import build_demo_report, main
from aeh.demo_session import (
    MISCONCEPTION_NO_COMPENSATION,
    SYNTHETIC_STUDENT_ID,
    DemoError,
    DemoSession,
    SyntheticPhoto,
    capture_synthetic_photo,
    grade_synthetic_trace,
    run_demo,
    synthetic_probes,
    synthetic_question,
)
from aeh.twin import (
    Event,
    MissingEvidenceError,
    SimulatedEventRejected,
    StudentTwin,
)


class SyntheticFixtureTests(unittest.TestCase):
    def test_capture_is_synthetic_and_does_not_touch_files(self):
        photo = capture_synthetic_photo()
        self.assertIsInstance(photo, SyntheticPhoto)
        self.assertTrue(photo.image_ref.startswith("synthetic://"))
        self.assertEqual(photo.student_steps[1], "(x - 3)^2 + 5")

    def test_non_synthetic_photo_reference_is_rejected(self):
        photo = capture_synthetic_photo()
        with self.assertRaises(DemoError):
            SyntheticPhoto(
                image_ref="/home/student/homework.jpg",
                ocr_confidence=0.9,
                question=photo.question,
                student_steps=photo.student_steps,
            )

    def test_grader_localizes_first_invalid_step(self):
        grade = grade_synthetic_trace(
            synthetic_question(), ("x^2 - 6x + 5", "(x - 3)^2 + 5")
        )
        self.assertFalse(grade.correct)
        self.assertEqual(grade.first_invalid_step, 2)
        self.assertIn(MISCONCEPTION_NO_COMPENSATION, grade.misconception_ids)

    def test_grader_accepts_equivalent_reference_step(self):
        grade = grade_synthetic_trace(
            synthetic_question(), ("x^2 - 6x + 5", "(x - 3)^2 - 9 + 5")
        )
        self.assertTrue(grade.correct)
        self.assertIsNone(grade.first_invalid_step)
        self.assertEqual(grade.misconception_ids, ())

    def test_grader_refuses_unverified_reference(self):
        question = replace(synthetic_question(), reference_verified=False)
        with self.assertRaises(DemoError):
            grade_synthetic_trace(question, ("x^2 - 6x + 5",))

    def test_demo_rejects_real_looking_student_ids(self):
        with self.assertRaises(DemoError):
            DemoSession(student_id="real.student.alice")

    def test_probe_fixtures_are_gated_before_selection(self):
        probes = {probe.candidate.item_id: probe for probe in synthetic_probes()}
        self.assertTrue(probes["demo.probe.expand_square"].candidate.gate_allowed)
        self.assertTrue(probes["demo.probe.identity_check"].candidate.gate_allowed)
        self.assertFalse(
            probes["demo.probe.future_derivative"].candidate.gate_allowed
        )


class DemoSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run_demo()

    def test_demo_uses_only_synthetic_data(self):
        result = self.result
        self.assertTrue(result.synthetic_data_only)
        self.assertEqual(result.student_ref, SYNTHETIC_STUDENT_ID)
        self.assertTrue(result.photo.image_ref.startswith("synthetic://"))
        self.assertEqual(result.twin_state.student_id, SYNTHETIC_STUDENT_ID)
        self.assertEqual(result.twin_state.version, 2)

    def test_question_passes_gate_and_grading_updates_twin_with_evidence(self):
        result = self.result
        self.assertTrue(result.gate.allowed)
        self.assertEqual(result.gate.mode, MODE_LEARN)
        self.assertFalse(result.grade.correct)
        self.assertEqual(result.grade.first_invalid_step, 2)
        self.assertIn(MISCONCEPTION_NO_COMPENSATION, result.grade.misconception_ids)
        self.assertAlmostEqual(result.mastery_after_grade.mastery_mean, 0.42)
        self.assertIn(
            "demo.evt.grade_001", result.mastery_after_grade.evidence_ids
        )
        self.assertIn("demo.evt.grade_001", result.twin_state.observed_evidence_ids)

    def test_future_probe_is_rejected_and_never_selected(self):
        result = self.result
        self.assertIn("demo.probe.future_derivative", result.blocked_probe_ids)
        self.assertNotEqual(result.probe.item_id, "demo.probe.future_derivative")
        self.assertTrue(result.probe.candidate.gate_allowed)
        self.assertIn(
            result.probe.item_id,
            {"demo.probe.expand_square", "demo.probe.identity_check"},
        )

    def test_diagnosis_posterior_is_normalized_and_evidence_backed(self):
        result = self.result
        self.assertAlmostEqual(sum(result.posterior_weights.values()), 1.0)
        self.assertAlmostEqual(sum(result.initial_weights.values()), 1.0)
        self.assertEqual(result.dominant_hypothesis_id, "h.no_compensation")
        self.assertGreater(
            result.posterior_weights["h.no_compensation"],
            result.posterior_weights["h.square_formula_error"],
        )
        self.assertIn("demo.evt.probe_001", result.twin_state.observed_evidence_ids)

    def test_review_distinguishes_hint_assistance_and_schedules(self):
        result = self.result
        self.assertEqual(result.hinted_memory.independent_success_count, 0)
        self.assertEqual(result.memory.independent_success_count, 1)
        self.assertGreater(result.memory.stability_days, result.hinted_memory.stability_days)
        self.assertGreater(result.review_interval_days, 0.0)
        self.assertIsNone(result.hinted_memory.last_independent_success_at)
        self.assertIsNotNone(result.memory.last_independent_success_at)
        self.assertGreater(
            result.review_due_at, result.memory.last_independent_success_at
        )
        self.assertEqual(result.review_receipt.mode, MODE_REVIEW)
        self.assertEqual(
            result.review_receipt.item_ids,
            ("demo.review.train_01", "demo.review.transfer_01"),
        )

    def test_every_mastery_estimate_references_observed_evidence(self):
        result = self.result
        observed = result.twin_state.observed_evidence_ids
        for estimate in result.twin_state.knowledge.values():
            self.assertTrue(estimate.evidence_ids)
            self.assertTrue(set(estimate.evidence_ids) <= observed)

    def test_simulated_event_cannot_change_demo_mastery(self):
        twin = StudentTwin(SYNTHETIC_STUDENT_ID)
        twin.record_observed(
            Event(
                event_id="demo.evt.real_1",
                event_type="attempt",
                source="student",
                student_id=SYNTHETIC_STUDENT_ID,
            )
        )
        twin.update_mastery("kc.demo", 0.5, 0.2, ["demo.evt.real_1"])
        before = twin.knowledge_for("kc.demo")

        with self.assertRaises(SimulatedEventRejected):
            twin.record_observed(
                Event(
                    event_id="demo.evt.sim_1",
                    event_type="simulated_attempt",
                    source="virtual_student",
                    student_id=SYNTHETIC_STUDENT_ID,
                )
            )
        with self.assertRaises(MissingEvidenceError):
            twin.update_mastery("kc.demo", 0.99, 0.01, ["demo.evt.sim_1"])
        self.assertEqual(twin.knowledge_for("kc.demo"), before)

    def test_demo_result_is_json_friendly(self):
        payload = self.result.to_dict()
        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertIn("synthetic_data_only", encoded)
        self.assertEqual(payload["demo"]["student_ref"], SYNTHETIC_STUDENT_ID)
        self.assertEqual(payload["diagnosis"]["selected_probe"], self.result.probe.item_id)


class DemoReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run_demo()

    def test_teacher_report_uses_only_aggregate_fields(self):
        report = build_demo_report(self.result, audience="teacher")
        payload = report.as_dict()
        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertTrue(payload["data_minimization"]["authorized_aggregate_events_only"])
        self.assertFalse(payload["data_minimization"]["raw_student_data_included"])
        self.assertFalse(payload["data_minimization"]["event_ids_included"])
        self.assertEqual(payload["totals"]["attempts"], 5)
        self.assertNotIn("demo.report.completing.001", encoded)
        self.assertNotIn(self.result.photo.question.stem, encoded)
        self.assertNotIn("(x - 3)^2 + 5", encoded)

    def test_guardian_report_has_same_privacy_boundary(self):
        report = build_demo_report(self.result, audience="guardian")
        markdown = report.to_markdown()
        self.assertIn("家长/监护人学习报告", markdown)
        self.assertIn("不包含原始图片、题目", markdown)
        self.assertNotIn("demo.report.", markdown)
        self.assertEqual(report.as_dict()["audience"], "guardian")

    def test_teacher_report_flags_low_accuracy_topic(self):
        report = build_demo_report(self.result, audience="teacher")
        attention = {topic.kc_id for topic in report.attention_topics}
        self.assertIn("algebra.completing_square", attention)
        self.assertNotIn("algebra.square_formula", attention)

    def test_cli_json_is_machine_readable(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(["--json", "--audience", "guardian"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertIn("demo", payload)
        self.assertIn("report", payload)
        self.assertEqual(payload["report"]["audience"], "guardian")
        self.assertNotIn(
            "demo.report.completing.001",
            json.dumps(payload["report"], ensure_ascii=False),
        )

    def test_cli_human_output_covers_closed_loop_and_report(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main([])
        self.assertEqual(code, 0)
        output = buffer.getvalue()
        for marker in ("[拍题]", "[批改]", "[诊断]", "[复习]", "学习报告"):
            self.assertIn(marker, output)


if __name__ == "__main__":
    unittest.main()
