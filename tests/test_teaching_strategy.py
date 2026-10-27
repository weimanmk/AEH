"""Step 15 tests: teaching strategy, daily coordination, learning science and
cross-subject adaptation (spec §10 / §17 / §18).

All learners, KCs, items and evidence are synthetic.  The shared fixture
``tests/fixtures/teaching_strategy_step15.json`` is also read by the TypeScript
test so the Python and TypeScript implementations are checked against the same
inputs and outputs.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from aeh.teaching_strategy import (
    ACTION_ANSWER_DIRECTLY,
    ACTION_ASK_DIAGNOSTIC_QUESTION,
    ACTION_ASSIGN_TARGETED_PRACTICE,
    ACTION_ASSIGN_TRANSFER_TASK,
    ACTION_GIVE_MINIMAL_HINT,
    ACTION_NONE,
    ACTION_REQUEST_PROGRESS_CONFIRMATION,
    ACTION_SCHEDULE_SPACED_REVIEW,
    ACTION_SHOW_WORKED_EXAMPLE,
    ACTION_TEACH_MICRO_LESSON,
    ACTION_METHODS,
    ALL_STRATEGY_SOURCES,
    DAILY_PHASES,
    DEFAULT_INTERLEAVING_MASTERY,
    DEFAULT_PROCEDURAL_ERROR_THRESHOLD,
    DailyCoordinationRequest,
    DueReview,
    IMPLEMENTED_METHOD_IDS,
    KnowledgeState,
    LearnerConstraints,
    LEARNING_SCIENCE_METHODS,
    METHOD_INTERLEAVING,
    METHOD_RETRIEVAL_PRACTICE,
    METHOD_SPACED_PRACTICE,
    MATH_SUBJECT,
    PHYSICS_SUBJECT,
    PracticeUnit,
    PURPOSE_PRODUCTION,
    PURPOSE_SIMULATION,
    PHASE_AI_REINFORCEMENT,
    PHASE_PREVIEW,
    PHASE_REVIEW,
    PHASE_SCHOOL,
    REAL_STRATEGY_SOURCES,
    SOURCE_OBSERVED,
    SOURCE_SIMULATED,
    SchoolContext,
    StrategyRequest,
    SubjectAdapterError,
    SubjectEvidence,
    SubjectRegistry,
    TeachingStrategyError,
    cross_subject_contract,
    learning_science_checklist,
    method_by_id,
    methods_for_action,
    plan_daily_coordination,
    plan_interleaved_practice,
    plan_retrieval_practice,
    plan_spaced_review,
    select_strategy,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "teaching_strategy_step15.json"


def fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def knowledge_from(record: dict) -> KnowledgeState:
    return KnowledgeState(
        kc_id=record["kcId"],
        mastery_mean=record["masteryMean"],
        uncertainty=record.get("uncertainty", 0.0),
        prerequisite_ready=record.get("prerequisiteReady", True),
        conceptual_misconception=record.get("conceptualMisconception", False),
        procedural_error_rate=record.get("proceduralErrorRate", 0.0),
        learned=record.get("learned", True),
        target_retention=record.get("targetRetention", 0.9),
    )


def due_from(record: dict) -> DueReview:
    return DueReview(
        kc_id=record["kcId"],
        stability_days=record["stabilityDays"],
        elapsed_days=record.get("elapsedDays", 0.0),
        target_retention=record.get("targetRetention", 0.9),
        due=record.get("due", True),
    )


def school_from(record: dict) -> SchoolContext:
    return SchoolContext(
        next_lesson_confirmed=record.get("nextLessonConfirmed", False),
        next_lesson_kcs=tuple(record.get("nextLessonKcs", [])),
        preview_allowed_kcs=tuple(record.get("previewAllowedKcs", [])),
        progress_confirmed=record.get("progressConfirmed", True),
        progress_confidence=record.get("progressConfidence", 1.0),
        school_pressure=record.get("schoolPressure", 0.5),
        exam_upcoming=record.get("examUpcoming", False),
        exam_scope_confirmed=record.get("examScopeConfirmed", True),
        exam_kcs=tuple(record.get("examKcs", [])),
    )


def constraints_from(record: dict) -> LearnerConstraints:
    return LearnerConstraints(
        available_minutes=record.get("availableMinutes", 30.0),
        max_block_minutes=record.get("maxBlockMinutes", 25.0),
        max_items=record.get("maxItems", 8),
        break_preference=record.get("breakPreference", "balanced"),
        homework_load=record.get("homeworkLoad", 0.0),
        assessment_in_progress=record.get("assessmentInProgress", False),
        allow_direct_answer=record.get("allowDirectAnswer", True),
    )


def request_from(record: dict) -> StrategyRequest:
    return StrategyRequest(
        intent=record.get("intent", "practice"),
        mode=record.get("mode", "learn"),
        knowledge=tuple(knowledge_from(item) for item in record.get("knowledge", [])),
        due_reviews=tuple(due_from(item) for item in record.get("dueReviews", [])),
        hypothesis_conflict=record.get("hypothesisConflict", False),
        school=school_from(record.get("school", {})),
        constraints=constraints_from(record.get("constraints", {})),
        evidence_source=record.get("evidenceSource", SOURCE_OBSERVED),
        purpose=record.get("purpose", PURPOSE_PRODUCTION),
        explicit_answer_request=record.get("explicitAnswerRequest", False),
        urgency=record.get("urgency", "normal"),
        phase=record.get("phase"),
        has_working_strategy=record.get("hasWorkingStrategy", False),
    )


def daily_request_from(record: dict) -> DailyCoordinationRequest:
    return DailyCoordinationRequest(
        student_ref=record.get("studentRef", "synthetic.learner"),
        total_minutes=record.get("totalMinutes", 60.0),
        knowledge=tuple(knowledge_from(item) for item in record.get("knowledge", [])),
        due_reviews=tuple(due_from(item) for item in record.get("dueReviews", [])),
        school=school_from(record.get("school", {})),
        constraints=constraints_from(record.get("constraints", {})),
        hypothesis_conflict=record.get("hypothesisConflict", False),
        recent_error_kcs=tuple(record.get("recentErrorKcs", [])),
        prerequisite_gap_kcs=tuple(record.get("prerequisiteGapKcs", [])),
        exam_pressure=record.get("examPressure", 0.0),
        review_backlog=record.get("reviewBacklog", 0),
        evidence_source=record.get("evidenceSource", SOURCE_OBSERVED),
        purpose=record.get("purpose", PURPOSE_PRODUCTION),
    )


def assert_expected_strategy(case: unittest.TestCase, decision, expected: dict) -> None:
    case.assertEqual(decision.action, expected["action"])
    if "mode" in expected:
        case.assertEqual(decision.mode, expected["mode"])
    if "phase" in expected:
        case.assertEqual(decision.phase, expected["phase"])
    if "targetKcs" in expected:
        case.assertEqual(list(decision.target_kcs), expected["targetKcs"])
    if "methodIds" in expected:
        case.assertEqual(list(decision.method_ids), expected["methodIds"])
    if "timeMinutes" in expected:
        case.assertEqual(decision.time_minutes, expected["timeMinutes"])
    if "blocked" in expected:
        case.assertEqual(decision.blocked, expected["blocked"])
    if "requiresConfirmation" in expected:
        case.assertEqual(
            decision.requires_confirmation, expected["requiresConfirmation"]
        )
    if "reasons" in expected:
        case.assertEqual(list(decision.reasons), expected["reasons"])
    for guardrail in expected.get("guardrailsContain", []):
        case.assertIn(guardrail, decision.guardrails)


class VocabularyTests(unittest.TestCase):
    def test_spec_actions_are_present(self) -> None:
        expected = {
            ACTION_ASK_DIAGNOSTIC_QUESTION,
            ACTION_GIVE_MINIMAL_HINT,
            ACTION_SHOW_WORKED_EXAMPLE,
            ACTION_TEACH_MICRO_LESSON,
            ACTION_ASSIGN_TARGETED_PRACTICE,
            ACTION_ASSIGN_TRANSFER_TASK,
            ACTION_SCHEDULE_SPACED_REVIEW,
            ACTION_REQUEST_PROGRESS_CONFIRMATION,
            ACTION_ANSWER_DIRECTLY,
        }
        self.assertTrue(expected.issubset(ACTION_METHODS))
        self.assertNotIn(ACTION_NONE, expected)
        self.assertEqual(
            set(DAILY_PHASES),
            {PHASE_PREVIEW, PHASE_SCHOOL, PHASE_AI_REINFORCEMENT, PHASE_REVIEW},
        )

    def test_all_spec_methods_have_mapping_and_verification(self) -> None:
        self.assertEqual(len(LEARNING_SCIENCE_METHODS), 16)
        for method in LEARNING_SCIENCE_METHODS:
            self.assertTrue(method.harness_actions, method.method_id)
            self.assertTrue(method.conditions, method.method_id)
            self.assertTrue(method.implementation, method.method_id)
            self.assertTrue(method.verification, method.method_id)
            self.assertTrue(method.guardrails, method.method_id)
            self.assertIs(method_by_id(method.method_id), method)

    def test_retrieval_spacing_interleaving_are_executable(self) -> None:
        implemented = {
            method.method_id
            for method in learning_science_checklist()
            if method.status == "implemented"
        }
        self.assertEqual(implemented, set(IMPLEMENTED_METHOD_IDS))
        self.assertEqual(
            set(methods_for_action(ACTION_SCHEDULE_SPACED_REVIEW)),
            {
                METHOD_SPACED_PRACTICE,
                METHOD_RETRIEVAL_PRACTICE,
                METHOD_INTERLEAVING,
            },
        )
        for method_id in IMPLEMENTED_METHOD_IDS:
            self.assertEqual(method_by_id(method_id).status, "implemented")

    def test_unknown_method_and_action_fail_closed(self) -> None:
        with self.assertRaises(TeachingStrategyError):
            method_by_id("not_a_method")
        with self.assertRaises(TeachingStrategyError):
            methods_for_action("not_an_action")

    def test_sources_are_explicit(self) -> None:
        self.assertIn(SOURCE_SIMULATED, ALL_STRATEGY_SOURCES)
        self.assertNotIn(SOURCE_SIMULATED, REAL_STRATEGY_SOURCES)


class StrategyRouterTests(unittest.TestCase):
    def test_shared_fixture_strategy(self) -> None:
        case = fixture()["strategy"]
        decision = select_strategy(request_from(case["request"]))
        assert_expected_strategy(self, decision, case["expected"])
        self.assertTrue(decision.delivery_requires_gate)

    def test_simulated_evidence_cannot_drive_production(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                evidence_source=SOURCE_SIMULATED,
                purpose=PURPOSE_PRODUCTION,
            )
        )
        self.assertTrue(decision.blocked)
        self.assertEqual(decision.action, ACTION_NONE)
        self.assertIn(
            "simulated_evidence_cannot_drive_production_strategy",
            decision.reasons,
        )
        self.assertTrue(decision.simulated_evidence_used)

    def test_simulated_evidence_is_allowed_in_a_simulation(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                evidence_source=SOURCE_SIMULATED,
                purpose=PURPOSE_SIMULATION,
            )
        )
        self.assertFalse(decision.blocked)
        self.assertIn("simulation_context_only", decision.guardrails)
        self.assertIn("simulated_evidence_marked", decision.guardrails)

    def test_unknown_provenance_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            TeachingStrategyError, "unknown evidence_source: unsourced"
        ):
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                evidence_source="unsourced",
            )

    def test_assessment_blocks_assistance(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                explicit_answer_request=True,
                constraints=LearnerConstraints(assessment_in_progress=True),
            )
        )
        self.assertTrue(decision.blocked)
        self.assertEqual(decision.action, ACTION_NONE)
        self.assertIn("no_assistance_during_assessment", decision.guardrails)

    def test_zero_budget_blocks_assignment(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                constraints=LearnerConstraints(available_minutes=0),
            )
        )
        self.assertTrue(decision.blocked)
        self.assertIn("no_work_without_time_budget", decision.guardrails)

    def test_unconfirmed_progress_requests_confirmation(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                school=SchoolContext(progress_confirmed=False),
            )
        )
        self.assertEqual(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
        self.assertTrue(decision.requires_confirmation)
        self.assertEqual(decision.reasons, ("school_progress_unconfirmed",))

    def test_low_confidence_progress_requests_confirmation(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                school=SchoolContext(progress_confirmed=True, progress_confidence=0.4),
            )
        )
        self.assertEqual(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)

    def test_preview_fixture(self) -> None:
        case = fixture()["preview"]
        decision = select_strategy(request_from(case["request"]))
        assert_expected_strategy(self, decision, case["expected"])

    def test_unconfirmed_preview_does_not_unlock(self) -> None:
        case = fixture()["unconfirmed_preview"]
        decision = select_strategy(request_from(case["request"]))
        assert_expected_strategy(self, decision, case["expected"])
        self.assertEqual(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)

    def test_preview_without_allowed_scope_is_blocked(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                intent="preview",
                mode="preview",
                knowledge=(KnowledgeState("kc.math.quadratic", 0.4),),
                school=SchoolContext(
                    next_lesson_confirmed=True,
                    next_lesson_kcs=("kc.math.quadratic",),
                    preview_allowed_kcs=(),
                ),
            )
        )
        self.assertEqual(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
        self.assertIn("preview_never_unlocked_by_ability", decision.guardrails)

    def test_explicit_answer_does_not_force_diagnosis(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                hypothesis_conflict=True,
                explicit_answer_request=True,
            )
        )
        self.assertEqual(decision.action, ACTION_ANSWER_DIRECTLY)
        self.assertEqual(decision.reasons, ("explicit_answer_request",))

    def test_time_pressure_answers_directly(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                urgency="time_pressure",
            )
        )
        self.assertEqual(decision.action, ACTION_ANSWER_DIRECTLY)

    def test_direct_answer_can_be_disabled(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                explicit_answer_request=True,
                constraints=LearnerConstraints(allow_direct_answer=False),
            )
        )
        self.assertEqual(decision.action, ACTION_GIVE_MINIMAL_HINT)
        self.assertIn("direct_answer_disabled", decision.guardrails)

    def test_hypothesis_conflict_asks_one_probe(self) -> None:
        case = fixture()["conflict"]
        decision = select_strategy(request_from(case["request"]))
        assert_expected_strategy(self, decision, case["expected"])
        self.assertIn("diagnosis_is_skippable", decision.guardrails)

    def test_prerequisite_gap_uses_worked_example(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(
                    KnowledgeState(
                        "kc.math.linear", 0.7, prerequisite_ready=False
                    ),
                )
            )
        )
        self.assertEqual(decision.action, ACTION_SHOW_WORKED_EXAMPLE)
        self.assertIn("avoid_overload", decision.guardrails)

    def test_conceptual_misconception_uses_micro_lesson(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(
                    KnowledgeState(
                        "kc.math.linear",
                        0.6,
                        conceptual_misconception=True,
                    ),
                )
            )
        )
        self.assertEqual(decision.action, ACTION_TEACH_MICRO_LESSON)
        self.assertNotIn(METHOD_INTERLEAVING, decision.method_ids)

    def test_procedural_errors_use_targeted_practice(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(
                    KnowledgeState(
                        "kc.math.linear",
                        0.7,
                        procedural_error_rate=DEFAULT_PROCEDURAL_ERROR_THRESHOLD,
                    ),
                )
            )
        )
        self.assertEqual(decision.action, ACTION_ASSIGN_TARGETED_PRACTICE)
        self.assertIn("procedural_errors_detected", decision.reasons)
        self.assertIn("independence_before_hints", decision.guardrails)

    def test_transfer_intent_uses_transfer_task(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                intent="transfer",
                knowledge=(KnowledgeState("kc.math.linear", 0.9),),
            )
        )
        self.assertEqual(decision.action, ACTION_ASSIGN_TRANSFER_TASK)
        self.assertIn("unseen_transfer_item_required", decision.guardrails)

    def test_due_review_uses_spaced_review(self) -> None:
        case = fixture()["forgetting"]
        decision = select_strategy(request_from(case["request"]))
        assert_expected_strategy(self, decision, case["expected"])

    def test_time_budget_clamps_action(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(
                    KnowledgeState(
                        "kc.math.linear", 0.6, conceptual_misconception=True
                    ),
                ),
                constraints=LearnerConstraints(available_minutes=4),
            )
        )
        self.assertEqual(decision.time_minutes, 4.0)
        self.assertLessEqual(decision.time_minutes, 4.0)

    def test_exam_scope_requires_confirmation(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.6),),
                school=SchoolContext(
                    exam_upcoming=True, exam_scope_confirmed=False
                ),
            )
        )
        self.assertEqual(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
        self.assertIn("exam_scope_unconfirmed", decision.guardrails)

    def test_missing_knowledge_requests_confirmation(self) -> None:
        decision = select_strategy(StrategyRequest())
        self.assertEqual(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
        self.assertIn("no_strategy_without_evidence", decision.guardrails)

    def test_working_strategy_gets_minimal_hint(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.math.linear", 0.5),),
                has_working_strategy=True,
            )
        )
        self.assertEqual(decision.action, ACTION_GIVE_MINIMAL_HINT)


class DailyCoordinationTests(unittest.TestCase):
    def test_shared_fixture_daily_plan(self) -> None:
        case = fixture()["daily"]
        plan = plan_daily_coordination(daily_request_from(case["request"]))
        expected = case["expected"]
        self.assertEqual(plan.total_minutes, expected["totalMinutes"])
        self.assertEqual(plan.break_count, expected["breakCount"])
        self.assertEqual(plan.break_minutes_total, expected["breakMinutesTotal"])
        self.assertEqual(plan.requires_confirmation, expected["requiresConfirmation"])
        self.assertEqual(plan.blocked, expected["blocked"])
        self.assertEqual(len(plan.phases), len(expected["phases"]))
        for actual, wanted in zip(plan.phases, expected["phases"]):
            self.assertEqual(actual.phase, wanted["phase"])
            self.assertEqual(actual.minutes, wanted["minutes"])
            self.assertEqual(actual.action, wanted["action"])
            self.assertEqual(list(actual.target_kcs), wanted["targetKcs"])
            self.assertEqual(list(actual.method_ids), wanted["methodIds"])
        for guardrail in expected["guardrailsContain"]:
            self.assertIn(guardrail, plan.guardrails)
        for note in expected["notesContain"]:
            self.assertIn(note, plan.notes)

    def test_daily_plan_stays_within_budget(self) -> None:
        case = fixture()["daily"]
        plan = plan_daily_coordination(daily_request_from(case["request"]))
        self.assertAlmostEqual(
            sum(phase.minutes for phase in plan.phases), 60.0, places=1
        )
        self.assertLessEqual(plan.break_minutes_total, 60.0)

    def test_school_phase_is_zero_and_unobserved(self) -> None:
        case = fixture()["daily"]
        plan = plan_daily_coordination(daily_request_from(case["request"]))
        school = plan.phase(PHASE_SCHOOL)
        self.assertIsNotNone(school)
        assert school is not None
        self.assertEqual(school.minutes, 0.0)
        self.assertEqual(school.action, ACTION_NONE)
        self.assertEqual(school.target_kcs, ())
        self.assertIn("school_time_is_not_observed", school.guardrails)

    def test_preview_is_skipped_without_confirmation(self) -> None:
        plan = plan_daily_coordination(
            DailyCoordinationRequest(
                total_minutes=40,
                knowledge=(KnowledgeState("kc.math.linear", 0.6),),
                school=SchoolContext(
                    next_lesson_confirmed=False,
                    next_lesson_kcs=("kc.math.quadratic",),
                    preview_allowed_kcs=("kc.math.quadratic",),
                ),
                constraints=LearnerConstraints(available_minutes=40),
            )
        )
        self.assertIsNone(plan.phase(PHASE_PREVIEW))
        self.assertFalse(plan.requires_confirmation)
        self.assertIn("preview_blocked_unconfirmed_next_lesson", plan.guardrails)

    def test_exam_and_backlog_can_prioritise_review(self) -> None:
        plan = plan_daily_coordination(
            DailyCoordinationRequest(
                total_minutes=60,
                knowledge=(
                    KnowledgeState("kc.math.linear", 0.6),
                    KnowledgeState("kc.math.quadratic", 0.7),
                ),
                due_reviews=(
                    DueReview("kc.math.linear", 5, 10),
                    DueReview("kc.math.quadratic", 4, 9),
                ),
                school=SchoolContext(
                    next_lesson_confirmed=True,
                    next_lesson_kcs=("kc.math.quadratic",),
                    preview_allowed_kcs=("kc.math.quadratic",),
                    exam_upcoming=True,
                    exam_kcs=("kc.math.linear", "kc.math.quadratic"),
                ),
                exam_pressure=0.9,
                review_backlog=3,
            )
        )
        review = plan.phase(PHASE_REVIEW)
        reinforcement = plan.phase(PHASE_AI_REINFORCEMENT)
        self.assertIsNotNone(review)
        self.assertIsNotNone(reinforcement)
        assert review is not None and reinforcement is not None
        self.assertGreater(review.minutes, reinforcement.minutes)

    def test_daily_simulated_production_is_blocked(self) -> None:
        plan = plan_daily_coordination(
            DailyCoordinationRequest(
                total_minutes=30,
                knowledge=(KnowledgeState("kc.math.linear", 0.6),),
                evidence_source=SOURCE_SIMULATED,
            )
        )
        self.assertTrue(plan.blocked)
        self.assertEqual(plan.phases, ())
        self.assertIn(
            "simulated_evidence_isolated", plan.guardrails
        )

    def test_daily_assessment_is_blocked(self) -> None:
        plan = plan_daily_coordination(
            DailyCoordinationRequest(
                total_minutes=30,
                knowledge=(KnowledgeState("kc.math.linear", 0.6),),
                constraints=LearnerConstraints(assessment_in_progress=True),
            )
        )
        self.assertTrue(plan.blocked)
        self.assertIn("no_assistance_during_assessment", plan.guardrails)

    def test_daily_budget_is_capped_by_learner_availability(self) -> None:
        plan = plan_daily_coordination(
            DailyCoordinationRequest(
                total_minutes=120,
                knowledge=(KnowledgeState("kc.math.linear", 0.6),),
                constraints=LearnerConstraints(available_minutes=30),
            )
        )
        self.assertLessEqual(plan.total_minutes, 30.0)
        self.assertIn("daily_budget_capped_by_availability", plan.guardrails)
        self.assertIn("daily_budget_capped_by_availability", plan.notes)

    def test_daily_breaks_follow_preference(self) -> None:
        plan = plan_daily_coordination(
            DailyCoordinationRequest(
                total_minutes=60,
                knowledge=(KnowledgeState("kc.math.linear", 0.6),),
                constraints=LearnerConstraints(
                    available_minutes=60,
                    max_block_minutes=20,
                    break_preference="short",
                ),
            )
        )
        self.assertEqual(plan.break_count, 2)
        self.assertEqual(plan.break_minutes_total, 6.0)


class LearningSciencePlannerTests(unittest.TestCase):
    def test_retrieval_fixture(self) -> None:
        case = fixture()["retrieval"]
        plan = plan_retrieval_practice(
            case["kcIds"],
            knowledge=tuple(knowledge_from(item) for item in case["knowledge"]),
            available_minutes=case["availableMinutes"],
            max_items=case["maxItems"],
            item_ids=case["itemIds"],
        )
        expected = case["expected"]
        self.assertEqual(list(plan.sequence), expected["sequence"])
        self.assertEqual(plan.minutes, expected["minutes"])
        self.assertEqual(plan.show_answer_first, expected["showAnswerFirst"])
        self.assertEqual(plan.independent, expected["independent"])
        self.assertIn("no_answer_before_attempt", plan.guardrails)
        self.assertIn("reading_is_not_retrieval", plan.guardrails)

    def test_retrieval_rejects_unlearned_kc(self) -> None:
        with self.assertRaisesRegex(
            TeachingStrategyError, "retrieval_requires_learned_kc"
        ):
            plan_retrieval_practice(
                ["kc.math.linear"],
                knowledge=(KnowledgeState("kc.math.linear", 0.2, learned=False),),
            )

    def test_retrieval_caps_items_and_requires_kcs(self) -> None:
        with self.assertRaises(TeachingStrategyError):
            plan_retrieval_practice([])
        plan = plan_retrieval_practice(
            ["kc.math.linear", "kc.math.quadratic"], max_items=1
        )
        self.assertEqual(len(plan.sequence), 1)
        self.assertEqual(plan.max_items, 1)

    def test_spaced_fixture(self) -> None:
        case = fixture()["spaced"]
        plan = plan_spaced_review(
            tuple(due_from(item) for item in case["dueReviews"]),
            available_minutes=case["availableMinutes"],
        )
        expected = case["expected"]
        self.assertEqual([slot.kc_id for slot in plan.slots], expected["order"])
        for slot, interval in zip(plan.slots, expected["intervalDays"]):
            self.assertAlmostEqual(slot.interval_days, interval, places=9)
        self.assertEqual(plan.minutes, expected["minutes"])
        self.assertEqual(plan.target_retention, expected["targetRetention"])
        self.assertIn("overdue_raises_uncertainty_not_lower_mastery", plan.guardrails)

    def test_spaced_requires_due_units(self) -> None:
        with self.assertRaises(TeachingStrategyError):
            plan_spaced_review([])

    def test_spaced_minutes_are_capped(self) -> None:
        plan = plan_spaced_review(
            (
                DueReview("kc.math.linear", 5, 10),
                DueReview("kc.math.quadratic", 3, 6),
            ),
            available_minutes=1,
        )
        self.assertLessEqual(plan.minutes, 1.0)

    def test_interleaving_fixture(self) -> None:
        case = fixture()["interleaving"]
        plan = plan_interleaved_practice(
            tuple(
                PracticeUnit(
                    unit_id=item["unitId"],
                    kc_id=item["kcId"],
                    difficulty=item.get("difficulty", 0.5),
                )
                for item in case["units"]
            ),
            mastery_by_kc=case["masteryByKc"],
            available_minutes=case["availableMinutes"],
            block_size=case["blockSize"],
        )
        expected = case["expected"]
        self.assertEqual(
            [unit.unit_id for unit in plan.sequence], expected["sequence"]
        )
        self.assertEqual(
            [list(block) for block in plan.blocks], expected["blocks"]
        )
        self.assertEqual(plan.minutes, expected["minutes"])
        self.assertEqual(plan.distinct_kcs, expected["distinctKcs"])

    def test_interleaving_avoids_adjacent_same_kc(self) -> None:
        plan = plan_interleaved_practice(
            (
                PracticeUnit("a1", "kc.math.a"),
                PracticeUnit("a2", "kc.math.a"),
                PracticeUnit("a3", "kc.math.a"),
                PracticeUnit("b1", "kc.math.b"),
                PracticeUnit("b2", "kc.math.b"),
            ),
            max_items=5,
        )
        kcs = [unit.kc_id for unit in plan.sequence]
        self.assertEqual(len(kcs), 5)
        self.assertTrue(
            all(left != right for left, right in zip(kcs, kcs[1:]))
        )

    def test_interleaving_requires_multiple_kcs(self) -> None:
        with self.assertRaisesRegex(
            TeachingStrategyError, "interleaving_requires_multiple_kcs"
        ):
            plan_interleaved_practice(
                (
                    PracticeUnit("a1", "kc.math.a"),
                    PracticeUnit("a2", "kc.math.a"),
                )
            )

    def test_interleaving_requires_basic_understanding(self) -> None:
        with self.assertRaisesRegex(
            TeachingStrategyError, "interleaving_requires_basic_understanding"
        ):
            plan_interleaved_practice(
                (
                    PracticeUnit("a1", "kc.math.a"),
                    PracticeUnit("b1", "kc.math.b"),
                ),
                mastery_by_kc={
                    "kc.math.a": DEFAULT_INTERLEAVING_MASTERY - 0.1,
                    "kc.math.b": 0.9,
                },
            )


class CrossSubjectTests(unittest.TestCase):
    def test_math_adapter(self) -> None:
        case = fixture()["subjects"]["mathDecision"]
        decision = select_strategy(request_from(case["request"]))
        adaptation = MATH_SUBJECT.adapt(decision)
        expected = case["expected"]
        self.assertEqual(adaptation.subject_id, expected["subjectId"])
        self.assertEqual(adaptation.accepted, expected["accepted"])
        self.assertEqual(adaptation.safety_required, expected["safetyRequired"])
        for validator in expected["validatorsContain"]:
            self.assertIn(validator, adaptation.validators)
        self.assertTrue(
            set(expected["evidenceKindsContain"]).issubset(MATH_SUBJECT.evidence_kinds)
        )

    def test_physics_adapter_and_safety_review(self) -> None:
        case = fixture()["subjects"]["physicsDecision"]
        decision = select_strategy(request_from(case["request"]))
        adaptation = PHYSICS_SUBJECT.adapt(decision)
        expected = case["expected"]
        self.assertEqual(adaptation.subject_id, expected["subjectId"])
        self.assertTrue(adaptation.accepted)
        self.assertEqual(adaptation.safety_required, expected["safetyRequired"])
        for validator in expected["validatorsContain"]:
            self.assertIn(validator, adaptation.validators)
        self.assertTrue(
            set(expected["evidenceKindsContain"]).issubset(
                PHYSICS_SUBJECT.evidence_kinds
            )
        )

    def test_evidence_validation(self) -> None:
        cases = fixture()["subjects"]
        accepted = SubjectEvidence(
            evidence_id=cases["mathEvidence"]["evidence"]["evidenceId"],
            kc_id=cases["mathEvidence"]["evidence"]["kcId"],
            kind=cases["mathEvidence"]["evidence"]["kind"],
            independent=True,
            verified_by=cases["mathEvidence"]["evidence"]["verifiedBy"],
        )
        self.assertEqual(MATH_SUBJECT.validate_evidence(accepted), ())
        rejected = SubjectEvidence(
            evidence_id=cases["physicsBadEvidence"]["evidence"]["evidenceId"],
            kc_id=cases["physicsBadEvidence"]["evidence"]["kcId"],
            kind=cases["physicsBadEvidence"]["evidence"]["kind"],
            independent=True,
            verified_by=cases["physicsBadEvidence"]["evidence"]["verifiedBy"],
        )
        self.assertEqual(
            list(PHYSICS_SUBJECT.validate_evidence(rejected)),
            cases["physicsBadEvidence"]["expectedReasons"],
        )

    def test_unsupported_kc_is_rejected(self) -> None:
        decision = select_strategy(
            StrategyRequest(
                knowledge=(KnowledgeState("kc.chemistry.bonding", 0.6),)
            )
        )
        adaptation = MATH_SUBJECT.adapt(decision)
        self.assertFalse(adaptation.accepted)
        self.assertIn("unsupported_kc:kc.chemistry.bonding", adaptation.reasons)

    def test_registry_is_fail_closed(self) -> None:
        registry = SubjectRegistry((MATH_SUBJECT,))
        self.assertEqual(len(registry), 1)
        with self.assertRaises(SubjectAdapterError):
            registry.register(MATH_SUBJECT)
        with self.assertRaises(SubjectAdapterError):
            registry.get("chemistry")

    def test_cross_subject_contract_has_two_examples(self) -> None:
        contract = cross_subject_contract()
        self.assertIn("kc_id", contract["shared"])
        self.assertIn("strategy_decision", contract["shared"])
        self.assertEqual(set(contract["subjects"]), {"math", "physics"})
        self.assertEqual(
            contract["subjects"]["physics"]["subjectId"], "physics"
        )


if __name__ == "__main__":
    unittest.main()
