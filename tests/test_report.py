"""Tests for authorised aggregate teacher/guardian reports."""

from __future__ import annotations

import json
import math
import unittest
from datetime import datetime, timedelta, timezone

from aeh.report import (
    KIND_ATTEMPT,
    AggregateEvent,
    InvalidAggregateEvent,
    InvalidReportRequest,
    effective_scopes,
    generate_report,
)

STUDENT = "demo.student.synthetic_001"
OTHER_STUDENT = "demo.student.synthetic_999"
KC = "algebra.completing_square"
KC_OTHER = "algebra.square_formula"
START = datetime(2026, 3, 2, 0, 0, tzinfo=timezone.utc)
END = datetime(2026, 3, 3, 0, 0, tzinfo=timezone.utc)
AT = START + timedelta(hours=8)


def make_event(**overrides) -> AggregateEvent:
    values = {
        "event_id": "evt_authorized_1",
        "student_ref": STUDENT,
        "occurred_at": AT,
        "kind": KIND_ATTEMPT,
        "consent_scope": "educational_report",
        "kc_id": KC,
        "attempts": 2,
        "independent_correct": 1,
        "hinted_correct": 0,
        "hints_requested": 1,
        "reviews_due": 0,
        "reviews_completed": 0,
        "minutes": 4.0,
    }
    values.update(overrides)
    return AggregateEvent(**values)


class AggregateEventValidationTests(unittest.TestCase):
    def test_aggregate_event_has_no_raw_free_text_field(self):
        with self.assertRaises(TypeError):
            make_event(raw_answer="x = 4")  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            make_event(payload={"image": "data:image/png;base64,..."})  # type: ignore[call-arg]

    def test_unsafe_labels_are_rejected(self):
        for label in ("answer: x=4", "line\nbreak", "学生答案 x=4", "a" * 200):
            with self.subTest(label=label):
                with self.assertRaises(InvalidAggregateEvent):
                    make_event(kc_id=label)

    def test_negative_or_inconsistent_counts_are_rejected(self):
        with self.assertRaises(InvalidAggregateEvent):
            make_event(attempts=-1)
        with self.assertRaises(InvalidAggregateEvent):
            make_event(attempts=1, independent_correct=2)
        with self.assertRaises(InvalidAggregateEvent):
            make_event(attempts=1, independent_correct=1, hinted_correct=1)
        with self.assertRaises(InvalidAggregateEvent):
            make_event(hints_requested=-1)
        with self.assertRaises(InvalidAggregateEvent):
            make_event(minutes=float("nan"))
        with self.assertRaises(InvalidAggregateEvent):
            make_event(minutes=math.inf)

    def test_naive_timestamps_and_unknown_kinds_are_rejected(self):
        with self.assertRaises(InvalidAggregateEvent):
            make_event(occurred_at=datetime(2026, 3, 2, 8, 0))
        with self.assertRaises(InvalidAggregateEvent):
            make_event(kind="raw_attempt")
        with self.assertRaises(InvalidAggregateEvent):
            make_event(consent_scope="not a scope")


class ReportFilteringTests(unittest.TestCase):
    def test_only_authorised_events_for_this_student_and_window_are_used(self):
        events = [
            make_event(event_id="evt_auth_1"),
            make_event(
                event_id="evt_auth_2",
                consent_scope="teacher_report",
                kc_id=KC_OTHER,
                attempts=3,
                independent_correct=2,
                hints_requested=0,
                minutes=5.0,
            ),
            make_event(event_id="evt_guardian_only", consent_scope="guardian_report"),
            make_event(event_id="evt_research_only", consent_scope="research_only"),
            make_event(event_id="evt_other_student", student_ref=OTHER_STUDENT),
            make_event(event_id="evt_outside_window", occurred_at=END),
            # Same event id as evt_auth_1: de-duplicated, never double counted.
            make_event(event_id="evt_auth_1", kc_id=KC_OTHER, attempts=99),
        ]
        report = generate_report(
            events,
            audience="teacher",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
            generated_at=AT,
        )
        self.assertEqual(report.events_used, 2)
        self.assertEqual(report.events_excluded, 5)
        self.assertEqual(report.totals.attempts, 5)
        self.assertEqual(report.totals.independent_correct, 3)
        self.assertEqual(report.totals.hints_requested, 1)
        self.assertEqual(report.totals.minutes, 9.0)
        self.assertEqual(
            [topic.kc_id for topic in report.topics], [KC, KC_OTHER]
        )
        self.assertNotIn("99", json.dumps(report.as_dict()))

    def test_guardian_cannot_read_teacher_only_scope(self):
        report = generate_report(
            [make_event(consent_scope="teacher_report")],
            audience="guardian",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
        )
        self.assertEqual(report.events_used, 0)
        self.assertEqual(report.events_excluded, 1)
        self.assertEqual(report.totals.attempts, 0)
        self.assertEqual(effective_scopes("guardian", ["teacher_report"]), frozenset())

    def test_single_scope_string_is_not_split_into_characters(self):
        self.assertEqual(
            effective_scopes("teacher", "teacher_report"),
            frozenset({"teacher_report"}),
        )

    def test_caller_scope_can_only_narrow_audience_defaults(self):
        report = generate_report(
            [
                make_event(event_id="evt_edu", consent_scope="educational_report"),
                make_event(event_id="evt_teacher", consent_scope="teacher_report"),
            ],
            audience="teacher",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
            authorized_scopes=("teacher_report",),
        )
        self.assertEqual(report.events_used, 1)
        self.assertEqual(report.events_excluded, 1)
        self.assertEqual(report.authorized_scopes, frozenset({"teacher_report"}))

    def test_shared_educational_scope_reaches_both_audiences(self):
        event = make_event(consent_scope="educational_report")
        for audience in ("teacher", "guardian"):
            with self.subTest(audience=audience):
                report = generate_report(
                    [event],
                    audience=audience,
                    student_ref=STUDENT,
                    window_start=START,
                    window_end=END,
                )
                self.assertEqual(report.events_used, 1)
                self.assertEqual(report.totals.attempts, 2)

    def test_empty_window_returns_safe_empty_report(self):
        report = generate_report(
            [],
            audience="teacher",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
        )
        self.assertEqual(report.events_used, 0)
        self.assertEqual(report.topics, ())
        self.assertIn("无已授权聚合事件", report.to_markdown())

    def test_invalid_requests_fail_closed(self):
        with self.assertRaises(InvalidReportRequest):
            generate_report(
                [], audience="principal", student_ref=STUDENT,
                window_start=START, window_end=END,
            )
        with self.assertRaises(InvalidReportRequest):
            generate_report(
                [], audience="teacher", student_ref=STUDENT,
                window_start=END, window_end=START,
            )
        with self.assertRaises(InvalidReportRequest):
            generate_report(
                [], audience="teacher", student_ref="Alice Smith",
                window_start=START, window_end=END,
            )
        with self.assertRaises(InvalidReportRequest):
            generate_report(
                [], audience="teacher", student_ref=STUDENT,
                window_start=datetime(2026, 3, 2), window_end=END,
            )
        with self.assertRaises(InvalidReportRequest):
            generate_report(
                [object()], audience="teacher", student_ref=STUDENT,  # type: ignore[list-item]
                window_start=START, window_end=END,
            )


class ReportContentTests(unittest.TestCase):
    def test_rates_and_attention_flags_are_aggregate_only(self):
        report = generate_report(
            [
                make_event(
                    attempts=4,
                    independent_correct=1,
                    hinted_correct=1,
                    hints_requested=3,
                    reviews_due=2,
                    reviews_completed=1,
                    minutes=12.0,
                )
            ],
            audience="teacher",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
        )
        topic = report.topics[0]
        self.assertAlmostEqual(topic.metrics.independent_accuracy or 0, 0.25)
        self.assertAlmostEqual(topic.metrics.hints_per_attempt or 0, 0.75)
        self.assertAlmostEqual(topic.metrics.review_completion_rate or 0, 0.5)
        self.assertIn("low_independent_accuracy", topic.attention_reasons)
        self.assertIn("reviews_not_completed", topic.attention_reasons)
        self.assertTrue(topic.needs_attention)
        self.assertEqual(report.attention_topics, (topic,))

    def test_report_never_renders_event_ids_or_raw_payload(self):
        event = make_event(event_id="evt_secret_internal_123")
        report = generate_report(
            [event],
            audience="teacher",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
        )
        payload = json.dumps(report.as_dict(), ensure_ascii=False)
        markdown = report.to_markdown()
        for rendered in (payload, markdown):
            self.assertNotIn("evt_secret_internal_123", rendered)
            self.assertNotIn('"event_id"', rendered)
            self.assertNotIn("(x - 3)^2 + 5", rendered)
        self.assertTrue(
            report.as_dict()["data_minimization"]["authorized_aggregate_events_only"]
        )
        self.assertFalse(
            report.as_dict()["data_minimization"]["raw_student_data_included"]
        )

    def test_markdown_uses_only_curriculum_ids(self):
        report = generate_report(
            [make_event()],
            audience="guardian",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
        )
        markdown = report.to_markdown()
        self.assertIn(KC, markdown)
        self.assertNotIn("学生答案", markdown)

    def test_report_is_json_serializable(self):
        report = generate_report(
            [make_event()],
            audience="guardian",
            student_ref=STUDENT,
            window_start=START,
            window_end=END,
            generated_at=AT,
        )
        encoded = json.dumps(report.as_dict(), ensure_ascii=False)
        self.assertIn("guardian_learning_report", encoded)
        self.assertIn(STUDENT, encoded)


if __name__ == "__main__":
    unittest.main()
