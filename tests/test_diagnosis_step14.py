"""Step 14 tests for active diagnosis and backward tracing (spec section 7).

Covers Observe → Localize → Expand backward tracing, the answer-uncertainty
term of the information-gain objective, the diagnosis session state machine
with deterministic termination reasons, and the student burden cap. All data
is synthetic.

The shared fixture ``tests/fixtures/diagnosis_step14.json`` is also read by the
TypeScript test so both implementations are checked against the same numbers.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from aeh.diagnosis import (
    BackwardTraceError,
    BurdenBudget,
    BurdenState,
    DiagnosisSession,
    DiagnosisStateError,
    DiagnosticCandidate,
    MisconceptionRule,
    ProbeWeights,
    RuleNode,
    SolutionStep,
    STATE_AWAITING_ANSWER,
    STATE_IDLE,
    STATE_TERMINATED,
    STATE_UPDATED,
    TERMINATION_BURDEN_LIMIT,
    TERMINATION_EXPLICIT,
    TERMINATION_MAX_QUESTIONS,
    TERMINATION_NO_PROBE,
    TERMINATION_RESOLVED,
    TERMINATION_STUDENT_SKIPPED,
    TRACE_MISCONCEPTION,
    TRACE_PREREQUISITE_GAP,
    TRACE_SLIP,
    TraceGraph,
    entropy,
    is_isolated_error,
    localize_first_deviation,
    order_steps,
    predictive_uncertainty,
    score_candidate,
    select_probe,
    should_terminate,
    trace_backward,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "diagnosis_step14.json"


def fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def graph_from(record: dict) -> TraceGraph:
    return TraceGraph(
        rules={
            rule["ruleId"]: RuleNode(
                rule_id=rule["ruleId"],
                kc=rule["kc"],
                requires_rules=tuple(rule.get("requiresRules", [])),
                misconception_ids=tuple(rule.get("misconceptionIds", [])),
                slip_likelihood=rule.get("slipLikelihood", 0.0),
                description=rule.get("description", ""),
            )
            for rule in record["rules"]
        },
        misconceptions={
            item["misconceptionId"]: MisconceptionRule(
                misconception_id=item["misconceptionId"],
                kc=item["kc"],
                requires_kcs=tuple(item.get("requiresKcs", [])),
                base_prior=item.get("basePrior", 1.0),
                description=item.get("description", ""),
            )
            for item in record["misconceptions"]
        },
    )


def steps_from(record: list[dict]) -> list[SolutionStep]:
    return [
        SolutionStep(
            step_id=step["stepId"],
            rule_id=step["ruleId"],
            kc=step["kc"],
            correct=step["correct"],
            depends_on=tuple(step.get("dependsOn", [])),
            error_type=step.get("errorType"),
        )
        for step in record
    ]


def candidate_from(record: dict) -> DiagnosticCandidate:
    return DiagnosticCandidate(
        item_id=record["itemId"],
        predictions=record.get("predictions", {}),
        time_minutes=record.get("timeMinutes", 0.0),
        risk=record.get("risk", 0.0),
        cognitive_load=record.get("cognitiveLoad", 0.0),
        teaching_value=record.get("teachingValue", 0.0),
        gate_allowed=record.get("gateAllowed", True),
    )


def policy_from(record: dict) -> ProbeWeights:
    return ProbeWeights(
        alpha=record["alpha"],
        beta=record["beta"],
        gamma=record["gamma"],
        delta=record["delta"],
        zeta=record["zeta"],
    )


def simple_graph() -> TraceGraph:
    return graph_from(fixture()["trace"])


def simple_steps() -> list[SolutionStep]:
    return steps_from(fixture()["trace"]["steps"])


class LocalizeTests(unittest.TestCase):
    def test_order_steps_is_dependency_ordered_and_stable(self):
        first = SolutionStep("s2", "r2", "kc2", True, depends_on=("s1",))
        second = SolutionStep("s1", "r1", "kc1", True)
        third = SolutionStep("s3", "r3", "kc3", True, depends_on=("s2",))
        ordered = order_steps([first, second, third])
        self.assertEqual([step.step_id for step in ordered], ["s1", "s2", "s3"])

    def test_duplicate_step_id_is_rejected(self):
        step = SolutionStep("s1", "r1", "kc1", True)
        with self.assertRaises(BackwardTraceError):
            order_steps([step, step])

    def test_unknown_dependency_is_rejected(self):
        step = SolutionStep("s1", "r1", "kc1", True, depends_on=("missing",))
        with self.assertRaises(BackwardTraceError):
            order_steps([step])

    def test_dependency_cycle_is_rejected(self):
        first = SolutionStep("s1", "r1", "kc1", True, depends_on=("s2",))
        second = SolutionStep("s2", "r2", "kc2", True, depends_on=("s1",))
        with self.assertRaises(BackwardTraceError):
            order_steps([first, second])

    def test_first_deviation_follows_dependency_order(self):
        deviation = localize_first_deviation(simple_steps())
        self.assertIsNotNone(deviation)
        self.assertEqual(deviation.step_id, "s2")

    def test_no_deviation_returns_none(self):
        correct = [
            SolutionStep("s1", "rule.expand_square", "kc.square_formula", True),
            SolutionStep(
                "s2",
                "rule.complete_square",
                "kc.completing_square",
                True,
                depends_on=("s1",),
            ),
        ]
        self.assertIsNone(localize_first_deviation(correct))

    def test_isolated_error_detection(self):
        isolated = [
            SolutionStep("s1", "r1", "kc1", True),
            SolutionStep("s2", "r2", "kc2", False, depends_on=("s1",)),
        ]
        repeated = isolated + [SolutionStep("s3", "r3", "kc3", False)]
        self.assertTrue(is_isolated_error(isolated))
        self.assertFalse(is_isolated_error(repeated))
        self.assertFalse(is_isolated_error([SolutionStep("s1", "r1", "kc1", False)]))


class BackwardTracingTests(unittest.TestCase):
    def test_no_deviation_yields_only_unknown(self):
        trace = trace_backward([SolutionStep("s1", "r1", "kc1", True)], simple_graph())
        self.assertIsNone(trace.first_deviation_step_id)
        self.assertEqual(trace.weights, {"unknown": 1.0})
        self.assertEqual(trace.unknown_weight, 1.0)
        self.assertIn("no_deviation", trace.notes)
        self.assertEqual(trace.explanations, ())

    def test_trace_expands_misconception_prerequisite_and_slip(self):
        trace = trace_backward(simple_steps(), simple_graph())
        self.assertEqual(trace.first_deviation_step_id, "s2")
        self.assertEqual(trace.first_deviation_kc, "kc.completing_square")
        self.assertTrue(trace.isolated_error)
        kinds = {explanation.hypothesis_id: explanation.kind for explanation in trace.explanations}
        self.assertEqual(
            kinds["misconception:mc.no_compensation"], TRACE_MISCONCEPTION
        )
        self.assertEqual(kinds["prereq:kc.identity_preservation"], TRACE_PREREQUISITE_GAP)
        self.assertEqual(kinds["prereq:kc.square_formula"], TRACE_PREREQUISITE_GAP)
        self.assertEqual(kinds["slip"], TRACE_SLIP)
        self.assertAlmostEqual(sum(trace.weights.values()), 1.0)

    def test_upstream_rule_observed_correct_is_decayed(self):
        trace = trace_backward(simple_steps(), simple_graph())
        # rule.expand_square (and therefore kc.square_formula) was answered
        # correctly, so its prerequisite explanation is heavily down-weighted.
        weights = trace.weights
        self.assertLess(
            weights["prereq:kc.square_formula"],
            weights["prereq:kc.identity_preservation"],
        )

    def test_slip_prior_is_boosted_for_an_isolated_error(self):
        boosted = trace_backward(simple_steps(), simple_graph())
        repeated = trace_backward(
            simple_steps() + [SolutionStep("s3", "rule.expand_square", "kc.square_formula", False)],
            simple_graph(),
        )
        self.assertTrue(boosted.isolated_error)
        self.assertIn("isolated_error", boosted.notes)
        self.assertFalse(repeated.isolated_error)
        self.assertNotIn("isolated_error", repeated.notes)
        boosted_slip = next(e for e in boosted.explanations if e.is_slip)
        repeated_slip = next(e for e in repeated.explanations if e.is_slip)
        self.assertGreater(boosted_slip.prior, repeated_slip.prior)

    def test_explanations_are_sorted_by_plausibility(self):
        trace = trace_backward(simple_steps(), simple_graph())
        plausibilities = [e.plausibility for e in trace.explanations]
        self.assertEqual(plausibilities, sorted(plausibilities, reverse=True))
        self.assertEqual(trace.dominant().hypothesis_id, trace.explanations[0].hypothesis_id)

    def test_trace_converts_to_weighted_hypotheses(self):
        trace = trace_backward(simple_steps(), simple_graph())
        hypotheses = trace.to_hypotheses()
        self.assertEqual(len(hypotheses), len(trace.explanations))
        by_id = {hypothesis.hypothesis_id: hypothesis for hypothesis in hypotheses}
        bug = by_id["misconception:mc.no_compensation"]
        self.assertEqual(bug.bug_rules, ("mc.no_compensation",))
        self.assertAlmostEqual(bug.weight, trace.weights[bug.hypothesis_id])
        slip = by_id["slip"]
        self.assertEqual(slip.bug_rules, ())
        self.assertEqual(slip.evidence_refs, ("s2",))

    def test_unknown_prior_is_kept_inside_the_posterior(self):
        trace = trace_backward(simple_steps(), simple_graph(), unknown_prior=0.25)
        self.assertGreater(trace.unknown_weight, 0.0)
        self.assertAlmostEqual(sum(trace.weights.values()), 1.0)
        self.assertAlmostEqual(trace.weights["unknown"], trace.unknown_weight)


class InformationGainStep14Tests(unittest.TestCase):
    def setUp(self):
        self.weights = {"h1": 0.5, "h2": 0.5}

    def test_coin_flip_prediction_has_one_bit_of_uncertainty(self):
        candidate = DiagnosticCandidate("q", {"h1": 0.5, "h2": 0.5})
        self.assertAlmostEqual(predictive_uncertainty(candidate, self.weights), 1.0)

    def test_deterministic_prediction_has_zero_uncertainty(self):
        candidate = DiagnosticCandidate("q", {"h1": 1.0, "h2": 1.0})
        self.assertAlmostEqual(predictive_uncertainty(candidate, self.weights), 0.0)

    def test_empty_weights_have_zero_uncertainty(self):
        candidate = DiagnosticCandidate("q", {"h1": 0.5, "h2": 0.5})
        self.assertEqual(predictive_uncertainty(candidate, {}), 0.0)

    def test_answer_uncertainty_penalty_lowers_the_score(self):
        candidate = DiagnosticCandidate("q", {"h1": 0.5, "h2": 0.5})
        no_penalty = ProbeWeights(alpha=0.0, beta=0.0, gamma=0.0, delta=0.0, zeta=0.0)
        penalty = ProbeWeights(alpha=0.0, beta=0.0, gamma=0.0, delta=0.0, zeta=1.0)
        self.assertGreater(
            score_candidate(candidate, self.weights, no_penalty).score,
            score_candidate(candidate, self.weights, penalty).score,
        )

    def test_score_decomposition_reports_answer_uncertainty(self):
        candidate = DiagnosticCandidate("q", {"h1": 0.5, "h2": 0.5})
        selection = score_candidate(candidate, self.weights)
        self.assertAlmostEqual(selection.answer_uncertainty, 1.0)
        self.assertIn("answer_uncertainty", selection.__dataclass_fields__)

    def test_uncertain_candidate_loses_to_a_confident_one(self):
        uncertain = DiagnosticCandidate("uncertain", {"h1": 0.5, "h2": 0.5})
        confident = DiagnosticCandidate("confident", {"h1": 0.9, "h2": 0.9})
        policy = ProbeWeights(alpha=0.0, beta=0.0, gamma=0.0, delta=0.0, zeta=1.0)
        selected = select_probe([uncertain, confident], self.weights, probe_weights=policy)
        self.assertEqual(selected.item_id, "confident")


class TerminationTests(unittest.TestCase):
    def test_skip_and_explicit_win_over_budget(self):
        budget = BurdenBudget(max_questions=0)
        self.assertEqual(
            should_terminate({"h1": 1.0}, budget=budget, skipped=True),
            TERMINATION_STUDENT_SKIPPED,
        )
        self.assertEqual(
            should_terminate({"h1": 1.0}, budget=budget, explicit=True),
            TERMINATION_EXPLICIT,
        )

    def test_question_cap(self):
        budget = BurdenBudget(max_questions=2)
        self.assertEqual(
            should_terminate({"h1": 1.0}, burden=BurdenState(questions=2), budget=budget),
            TERMINATION_MAX_QUESTIONS,
        )
        self.assertIsNone(
            should_terminate({"h1": 1.0}, burden=BurdenState(questions=1), budget=budget)
        )

    def test_time_and_load_caps(self):
        minutes = BurdenBudget(max_total_minutes=3.0)
        self.assertEqual(
            should_terminate(
                {"h1": 1.0}, burden=BurdenState(total_minutes=3.0), budget=minutes
            ),
            TERMINATION_BURDEN_LIMIT,
        )
        load = BurdenBudget(max_total_load=0.5)
        self.assertEqual(
            should_terminate(
                {"h1": 1.0}, burden=BurdenState(total_load=0.5), budget=load
            ),
            TERMINATION_BURDEN_LIMIT,
        )

    def test_confidence_resolution(self):
        self.assertEqual(
            should_terminate({"h1": 0.9, "h2": 0.1}, min_confidence=0.8),
            TERMINATION_RESOLVED,
        )
        self.assertIsNone(
            should_terminate({"h1": 0.6, "h2": 0.4}, min_confidence=0.8)
        )

    def test_unknown_dominance_blocks_resolution(self):
        self.assertIsNone(
            should_terminate({"unknown": 0.9, "h1": 0.1}, min_confidence=0.8)
        )

    def test_entropy_resolution(self):
        self.assertEqual(
            should_terminate({"h1": 1.0}, entropy_threshold=0.1),
            TERMINATION_RESOLVED,
        )
        self.assertIsNone(
            should_terminate({"h1": 0.5, "h2": 0.5}, entropy_threshold=0.5)
        )


class DiagnosisSessionStateMachineTests(unittest.TestCase):
    def setUp(self):
        self.weights = {"h1": 0.5, "h2": 0.5}
        self.probe = DiagnosticCandidate(
            "q1", {"h1": 0.9, "h2": 0.1}, time_minutes=1.0, cognitive_load=0.2
        )

    def test_state_machine_asks_answers_and_updates(self):
        session = DiagnosisSession(self.weights)
        self.assertEqual(session.state, STATE_IDLE)
        selection = session.select([self.probe])
        self.assertEqual(selection.item_id, "q1")
        self.assertEqual(session.state, STATE_AWAITING_ANSWER)
        self.assertEqual(session.pending_item_id, "q1")
        update = session.observe(self.probe, correct=True)
        self.assertEqual(session.state, STATE_UPDATED)
        self.assertEqual(session.pending_item_id, None)
        self.assertGreater(update.weights["h1"], update.weights["h2"])
        self.assertGreater(session.realized_information_gain, 0.0)
        self.assertEqual(session.asked, ["q1"])

    def test_selecting_while_an_answer_is_pending_is_rejected(self):
        session = DiagnosisSession(self.weights)
        session.select([self.probe])
        with self.assertRaises(DiagnosisStateError):
            session.select([self.probe])

    def test_student_skip_terminates_and_forces_nothing(self):
        session = DiagnosisSession(self.weights)
        session.select([self.probe])
        session.skip()
        self.assertEqual(session.state, STATE_TERMINATED)
        self.assertEqual(session.termination_reason, TERMINATION_STUDENT_SKIPPED)
        self.assertIsNone(session.select([self.probe]))
        self.assertEqual(session.asked, [])

    def test_observing_after_termination_is_rejected(self):
        session = DiagnosisSession(self.weights)
        session.skip()
        with self.assertRaises(DiagnosisStateError):
            session.observe(self.probe, correct=True)

    def test_question_cap_terminates_after_the_last_answer(self):
        session = DiagnosisSession(
            self.weights, budget=BurdenBudget(max_questions=1)
        )
        session.select([self.probe])
        session.observe(self.probe, correct=True)
        self.assertEqual(session.state, STATE_TERMINATED)
        self.assertEqual(session.termination_reason, TERMINATION_MAX_QUESTIONS)
        self.assertEqual(session.burden.questions, 1)
        self.assertIsNone(session.select([self.probe]))

    def test_burden_cap_terminates_on_time_and_load(self):
        session = DiagnosisSession(
            self.weights, budget=BurdenBudget(max_total_minutes=1.0)
        )
        session.select([self.probe])
        session.observe(self.probe, correct=True)
        self.assertEqual(session.termination_reason, TERMINATION_BURDEN_LIMIT)
        self.assertAlmostEqual(session.burden.total_minutes, 1.0)

    def test_zero_question_budget_refuses_to_start(self):
        session = DiagnosisSession(self.weights, budget=BurdenBudget(max_questions=0))
        self.assertIsNone(session.select([self.probe]))
        self.assertEqual(session.termination_reason, TERMINATION_MAX_QUESTIONS)

    def test_no_allowed_probe_terminates(self):
        blocked = DiagnosticCandidate("blocked", {"h1": 0.9}, gate_allowed=False)
        session = DiagnosisSession(self.weights)
        self.assertIsNone(session.select([blocked]))
        self.assertEqual(session.termination_reason, TERMINATION_NO_PROBE)

    def test_confidence_can_terminate_the_session(self):
        session = DiagnosisSession(
            self.weights, min_confidence=0.85
        )
        session.select([self.probe])
        session.observe(self.probe, correct=True)
        self.assertEqual(session.termination_reason, TERMINATION_RESOLVED)
        self.assertAlmostEqual(session.weights["h1"], 0.9)

    def test_entropy_threshold_can_terminate_the_session(self):
        session = DiagnosisSession(
            {"h1": 0.5, "h2": 0.5}, entropy_threshold=0.2
        )
        strong = DiagnosticCandidate("q1", {"h1": 1.0, "h2": 0.0})
        session.select([strong])
        session.observe(strong, correct=True)
        self.assertLessEqual(entropy(session.weights), 0.2)
        self.assertEqual(session.termination_reason, TERMINATION_RESOLVED)

    def test_explicit_termination(self):
        session = DiagnosisSession(self.weights)
        session.terminate()
        self.assertEqual(session.termination_reason, TERMINATION_EXPLICIT)
        self.assertEqual(session.history[-1].kind, "terminated")

    def test_history_records_select_observe_and_terminate(self):
        session = DiagnosisSession(self.weights)
        session.select([self.probe])
        session.observe(self.probe, correct=False)
        session.skip()
        kinds = [transition.kind for transition in session.history]
        self.assertEqual(kinds, ["selected", "observed", "terminated"])


class SharedFixtureTests(unittest.TestCase):
    """Numbers shared with the TypeScript test through the same fixture."""

    def setUp(self):
        self.data = fixture()

    def test_trace_matches_fixture(self):
        record = self.data["trace"]
        trace = trace_backward(steps_from(record["steps"]), graph_from(record))
        expected = record["expected"]
        self.assertEqual(trace.first_deviation_step_id, expected["firstDeviationStepId"])
        self.assertEqual(trace.first_deviation_kc, expected["firstDeviationKc"])
        self.assertEqual(trace.isolated_error, expected["isolatedError"])
        self.assertEqual(list(trace.notes), expected["notes"])
        self.assertEqual(
            [explanation.hypothesis_id for explanation in trace.explanations],
            expected["explanationIds"],
        )
        self.assertEqual(trace.dominant().hypothesis_id, expected["dominantId"])
        for hypothesis_id, weight in expected["weights"].items():
            self.assertAlmostEqual(trace.weights[hypothesis_id], weight, places=9)

    def test_probe_scoring_matches_fixture(self):
        probes = self.data["probes"]
        policy = policy_from(probes["policy"])
        weights = probes["weights"]
        expected = probes["expected"]
        candidates = [candidate_from(record) for record in probes["candidates"]]
        for candidate in candidates:
            selection = score_candidate(candidate, weights, policy)
            if not candidate.gate_allowed:
                self.assertEqual(selection.score, float("-inf"))
                self.assertIn(candidate.item_id, expected["rejectedIds"])
                continue
            self.assertAlmostEqual(
                selection.information_gain,
                expected["informationGain"][candidate.item_id],
                places=9,
            )
            self.assertAlmostEqual(
                selection.answer_uncertainty,
                expected["answerUncertainty"][candidate.item_id],
                places=9,
            )
            self.assertAlmostEqual(
                selection.score, expected["score"][candidate.item_id], places=9
            )
        selected = select_probe(candidates, weights, probe_weights=policy)
        self.assertEqual(selected.item_id, expected["selectedId"])
        self.assertAlmostEqual(selected.score, expected["selectedScore"], places=9)

    def test_session_matches_fixture(self):
        record = self.data["session"]
        policy = policy_from(record["policy"])
        budget_record = record["budget"]
        budget = BurdenBudget(
            max_questions=budget_record["maxQuestions"],
            max_total_minutes=budget_record["maxTotalMinutes"],
            max_total_load=budget_record["maxTotalLoad"],
        )
        session = DiagnosisSession(
            record["weights"],
            policy,
            budget=budget,
            min_confidence=record["minConfidence"],
            entropy_threshold=record["entropyThreshold"],
        )
        candidates = [candidate_from(item) for item in self.data["probes"]["candidates"]]
        by_id = {candidate.item_id: candidate for candidate in candidates}
        states: list[str] = []
        asked: list[str] = []
        for entry in record["script"]:
            selection = session.select(candidates)
            self.assertIsNotNone(selection)
            self.assertEqual(selection.item_id, entry["itemId"])
            states.append(session.state)
            session.observe(by_id[selection.item_id], correct=entry["correct"])
            states.append(session.state)
            asked.append(selection.item_id)

        expected = record["expected"]
        self.assertEqual(states, expected["states"])
        self.assertEqual(asked, expected["asked"])
        self.assertEqual(session.termination_reason, expected["terminationReason"])
        self.assertEqual(session.burden.questions, expected["burden"]["questions"])
        self.assertAlmostEqual(
            session.burden.total_minutes, expected["burden"]["totalMinutes"], places=9
        )
        self.assertAlmostEqual(
            session.burden.total_load, expected["burden"]["totalLoad"], places=9
        )
        self.assertAlmostEqual(
            session.realized_information_gain,
            expected["realizedInformationGain"],
            places=9,
        )
        for hypothesis_id, weight in expected["finalWeights"].items():
            self.assertAlmostEqual(session.weights[hypothesis_id], weight, places=9)

    def test_fixture_entropy_matches(self):
        self.assertAlmostEqual(
            entropy(self.data["probes"]["weights"]), self.data["entropy"], places=9
        )


if __name__ == "__main__":
    unittest.main()
