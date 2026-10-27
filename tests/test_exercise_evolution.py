"""Step 10 tests: exercise evolution engine and isolated simulation lab.

All data is synthetic: a complete content-free annotation fixture, a tiny
knowledge graph, and hypothesis snapshots.  No real student data, item text,
answer, hint, or solution is used.
"""

from __future__ import annotations

import json
import math
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aeh.curriculum_gate import MODE_LEARN, LearnerProgress
from aeh.curriculum_graph import (
    GraphNode,
    ItemAnnotation,
    ItemBank,
    KnowledgeGraph,
    QMatrixEntry,
    ReviewTransitionError,
    content_hash,
)
from aeh.evaluation import EvalItem, FrozenEvalSet, RealOutcome
from aeh.exercise_evolution import (
    CONTEXT_TAGS,
    EVOLUTION_OPERATORS,
    OPERATOR_CONTEXT,
    OPERATOR_DIAGNOSTIC,
    OPERATOR_DIFFICULTY,
    OPERATOR_DISTRACTOR,
    OPERATOR_NUMERIC,
    PHASE_INTERVENTION,
    PHASE_POST_FAR,
    PHASE_POST_NEAR,
    PHASE_PRE,
    CandidatePoolError,
    EvolutionCandidatePool,
    EvolutionSandbox,
    EvolutionValidationError,
    ExerciseEvolutionEngine,
    HypothesisSnapshot,
    OperatorNotApplicableError,
    ScreeningPolicy,
    SimulationConfig,
    SimulationConfigError,
    SimulationEventLog,
    SimulationHypothesis,
    SimulationIsolationError,
    SimulationLab,
    VariantSpec,
    affected_kcs,
    fnv1a32,
    js_round,
    mulberry32,
    quantize_micros,
    round4,
)
from aeh.hypothesis import Hypothesis, HypothesisSet
from aeh.twin import Event, StudentTwin

FIXTURE = Path(__file__).parent / "fixtures" / "exercise_evolution_step10.json"

KC = "kc.quadratic.formula"
PREREQ = "kc.arith.square_root"


def make_annotation(**overrides):
    values = {
        "source": "synthetic.bank",
        "license": "synthetic-only",
        "stage": "secondary",
        "course": "synthetic.mathematics",
        "grade_level": 8,
        "curriculum_node_ids": (KC,),
        "required_kcs": (KC,),
        "q_matrix": (QMatrixEntry(KC, 0.95),),
        "difficulty": 0.5,
        "item_type": "multiple_choice",
        "estimated_minutes": 5.0,
        "verifier_type": "deterministic",
        "safety_checked": True,
        "content_verified": True,
        "correctness_verified": True,
        "annotation_confidence": 0.95,
        "cognitive_load": 0.2,
    }
    values.update(overrides)
    return ItemAnnotation(**values)


def make_graph():
    return KnowledgeGraph(
        version=1,
        nodes=[GraphNode(KC), GraphNode(PREREQ)],
        edges=[
            {
                "sourceId": KC,
                "targetId": PREREQ,
                "relation": "REQUIRES",
                "status": "approved",
                "confidence": 1.0,
                "provenance": "synthetic",
            }
        ],
    )


def taught_progress(*, taught=(KC, PREREQ), grade=8, confidence=0.95):
    return LearnerProgress(
        student_id="synthetic.student.001",
        grade_level=grade,
        taught_kcs=tuple(taught),
        progress_confidence=confidence,
    )


def make_bank(item_id="item.quad.001", **overrides):
    bank = ItemBank()
    bank.add_item(item_id, make_annotation(**overrides), review_status="approved")
    return bank, item_id


def make_snapshot(snapshot_id="snapshot.001"):
    hypothesis_set = HypothesisSet(
        [
            Hypothesis(
                "h.strategy",
                predicted_observable_behaviors={"step_correct": 0.8},
                weight=1.0,
            ),
            Hypothesis(
                "h.bug",
                predicted_observable_behaviors={"step_correct": 0.25},
                weight=1.0,
            ),
        ],
        unknown_weight=0.1,
    )
    return HypothesisSnapshot.from_hypothesis_set(
        hypothesis_set, snapshot_id=snapshot_id
    )


def phase_items():
    return {
        PHASE_PRE: ["item.pre.1", "item.pre.2"],
        PHASE_INTERVENTION: ["item.train.1"],
        PHASE_POST_NEAR: ["item.near.1", "item.near.2"],
        PHASE_POST_FAR: ["item.far.1"],
    }


def load_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def variant_from_fixture(spec):
    return VariantSpec(
        operator=spec["operator"],
        numeric_delta=spec.get("numericDelta", 0.0),
        context_tag=spec.get("contextTag"),
        distractor_count=spec.get("distractorCount"),
        difficulty_delta=spec.get("difficultyDelta", 0.0),
        target_misconception=spec.get("targetMisconception"),
        target_kcs=tuple(spec.get("targetKcs", ())),
    )


def snapshot_from_fixture(data):
    return HypothesisSnapshot(
        snapshot_id=data["snapshotId"],
        hypotheses=tuple(
            SimulationHypothesis(
                item["hypothesisId"], item["weight"], item["response"]
            )
            for item in data["hypotheses"]
        ),
        unknown_weight=data["unknownWeight"],
    )


def config_from_fixture(data):
    return SimulationConfig(
        config_version=data["configVersion"],
        scenario_id=data["scenarioId"],
        candidate_id=data["candidateId"],
        seed=data["seed"],
        phase_plan=tuple(data["phasePlan"]),
        max_steps=data["maxSteps"],
        label=data.get("label", ""),
    )


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------


class TestDeterministicHelpers(unittest.TestCase):
    def test_mulberry32_is_deterministic_and_in_range(self):
        first = mulberry32(123456789)
        second = mulberry32(123456789)
        values = [first() for _ in range(16)]
        self.assertEqual(values, [second() for _ in range(16)])
        for value in values:
            self.assertGreaterEqual(value, 0.0)
            self.assertLess(value, 1.0)

    def test_mulberry32_seed_zero_and_uint32(self):
        values = [mulberry32(0)() for _ in range(4)]
        self.assertEqual(4, len(values))
        self.assertEqual(mulberry32(0xFFFFFFFF)(), mulberry32(-1)())

    def test_fnv1a32_is_stable(self):
        self.assertEqual(fnv1a32("numeric"), fnv1a32("numeric"))
        self.assertNotEqual(fnv1a32("numeric"), fnv1a32("context"))
        self.assertGreaterEqual(fnv1a32(""), 0)

    def test_js_round_and_round4(self):
        self.assertEqual(3, js_round(2.5))
        self.assertEqual(-2, js_round(-2.5))
        self.assertEqual(0, js_round(-0.4))
        self.assertEqual(0.55, round4(0.5499999999999999))
        self.assertEqual(0.3, round4(0.1 + 0.2))

    def test_quantize_micros(self):
        self.assertEqual(500000, quantize_micros(0.5))
        self.assertEqual(0, quantize_micros(0.0))
        self.assertEqual(-250000, quantize_micros(-0.25))


# ---------------------------------------------------------------------------
# Evolution operators and provenance
# ---------------------------------------------------------------------------


class TestEvolutionOperators(unittest.TestCase):
    def setUp(self):
        self.bank, self.item_id = make_bank()
        self.engine = ExerciseEvolutionEngine(self.bank, make_graph(), seed=7)

    def test_all_operators_generate_provenance(self):
        for operator in EVOLUTION_OPERATORS:
            with self.subTest(operator=operator):
                candidate = self.engine.generate(
                    self.item_id, VariantSpec(operator=operator)
                )
                provenance = candidate.provenance
                self.assertEqual(operator, provenance.operator)
                self.assertEqual(self.item_id, provenance.source_item_id)
                self.assertEqual(1, provenance.source_item_version)
                self.assertTrue(provenance.change_summary)
                self.assertTrue(provenance.changes)
                self.assertIn(KC, provenance.affected_kcs)
                self.assertEqual(7, provenance.seed)
                self.assertNotEqual("", candidate.content_hash())

    def test_numeric_operator_uses_explicit_delta(self):
        candidate = self.engine.generate(
            self.item_id, VariantSpec(OPERATOR_NUMERIC, numeric_delta=0.13)
        )
        changes = candidate.provenance.changes["numeric_parameters"]
        self.assertEqual(0.13, changes["coefficient_delta"])
        self.assertTrue(changes["grade_band_preserved"])

    def test_numeric_operator_derives_delta_from_seed(self):
        first = self.engine.generate(self.item_id, VariantSpec(OPERATOR_NUMERIC))
        second = self.engine.generate(self.item_id, VariantSpec(OPERATOR_NUMERIC))
        self.assertEqual(
            first.provenance.changes, second.provenance.changes
        )

    def test_context_operator_pins_tag_and_stays_in_vocabulary(self):
        pinned = self.engine.generate(
            self.item_id,
            VariantSpec(OPERATOR_CONTEXT, context_tag=CONTEXT_TAGS[0]),
        )
        self.assertEqual(
            CONTEXT_TAGS[0], pinned.provenance.changes["surface_context"]["context_tag"]
        )
        self.assertTrue(pinned.provenance.changes["surface_context"]["pinned"])

        derived = self.engine.generate(self.item_id, VariantSpec(OPERATOR_CONTEXT))
        self.assertIn(
            derived.provenance.changes["surface_context"]["context_tag"], CONTEXT_TAGS
        )

    def test_distractor_operator_requires_multiple_choice(self):
        bank, item_id = make_bank(item_type="short_answer")
        engine = ExerciseEvolutionEngine(bank, make_graph(), seed=1)
        with self.assertRaises(OperatorNotApplicableError):
            engine.generate(item_id, VariantSpec(OPERATOR_DISTRACTOR))

        candidate = self.engine.generate(self.item_id, VariantSpec(OPERATOR_DISTRACTOR))
        distractors = candidate.provenance.changes["distractors"]
        self.assertGreaterEqual(distractors["distractor_count"], 3)
        self.assertTrue(distractors["correct_option_unchanged"])
        self.assertGreater(candidate.annotation.cognitive_load, 0.2)

    def test_difficulty_operator_clamps_and_scales_time(self):
        candidate = self.engine.generate(
            self.item_id, VariantSpec(OPERATOR_DIFFICULTY, difficulty_delta=5.0)
        )
        self.assertEqual(1.0, candidate.annotation.difficulty)
        self.assertGreater(candidate.annotation.estimated_minutes, 5.0)

        candidate = self.engine.generate(
            self.item_id, VariantSpec(OPERATOR_DIFFICULTY, difficulty_delta=-5.0)
        )
        self.assertEqual(0.0, candidate.annotation.difficulty)
        self.assertGreaterEqual(candidate.annotation.estimated_minutes, 0.5)

    def test_diagnostic_operator_marks_item_and_target(self):
        candidate = self.engine.generate(
            self.item_id,
            VariantSpec(
                OPERATOR_DIAGNOSTIC,
                target_misconception="synthetic.misconception.square_without_compensation",
            ),
        )
        self.assertEqual("diagnostic", candidate.annotation.item_type)
        self.assertIn(
            "synthetic.misconception.square_without_compensation",
            candidate.annotation.misconception_targets,
        )
        target = candidate.provenance.changes["diagnostic_target"]
        self.assertTrue(target["discriminates_hypotheses"])

    def test_operator_does_not_grant_extension_or_bypass_annotations(self):
        candidate = self.engine.generate(self.item_id, VariantSpec(OPERATOR_NUMERIC))
        self.assertFalse(candidate.annotation.extension_approved)
        self.assertEqual((), candidate.annotation.missing_annotation_fields())

    def test_affected_kcs_unions_required_and_q_matrix(self):
        annotation = make_annotation(
            required_kcs=(KC,),
            q_matrix=(QMatrixEntry(KC, 0.9), QMatrixEntry(PREREQ, 0.4)),
        )
        self.assertEqual((PREREQ, KC), affected_kcs(annotation))


# ---------------------------------------------------------------------------
# Fail-closed validation and the isolation gate
# ---------------------------------------------------------------------------


class TestEvolutionValidation(unittest.TestCase):
    def setUp(self):
        self.bank, self.item_id = make_bank()
        self.engine = ExerciseEvolutionEngine(self.bank, make_graph(), seed=3)
        self.candidate = self.engine.generate(
            self.item_id, VariantSpec(OPERATOR_NUMERIC)
        )

    def test_valid_candidate_passes(self):
        validation = self.engine.validate(
            self.candidate, taught_progress(), MODE_LEARN
        )
        self.assertTrue(validation.valid)
        self.assertEqual((), validation.reasons)

    def test_not_taught_kc_fails_closed(self):
        validation = self.engine.validate(
            self.candidate, taught_progress(taught=(PREREQ,)), MODE_LEARN
        )
        self.assertFalse(validation.valid)
        self.assertTrue(
            any("not_allowed" in reason for reason in validation.reasons),
            validation.reasons,
        )

    def test_low_progress_confidence_fails_closed(self):
        # In-progress/preview KCs require confirmed school progress; taught
        # KCs do not.  A low-confidence in-progress KC must stay locked.
        progress = LearnerProgress(
            student_id="synthetic.student.001",
            grade_level=8,
            in_progress_kcs=(KC,),
            progress_confidence=0.1,
        )
        validation = self.engine.validate(self.candidate, progress, MODE_LEARN)
        self.assertFalse(validation.valid)

    def test_missing_prerequisite_fails(self):
        validation = self.engine.validate(
            self.candidate, taught_progress(taught=(KC,)), MODE_LEARN
        )
        self.assertFalse(validation.valid)
        self.assertIn(PREREQ, validation.missing_prerequisites)
        self.assertTrue(
            any(reason.startswith("prerequisites_not_met") for reason in validation.reasons)
        )

    def test_unknown_kc_fails(self):
        bank, item_id = make_bank(
            required_kcs=("kc.not.in.graph",),
            q_matrix=(QMatrixEntry("kc.not.in.graph", 0.9),),
        )
        engine = ExerciseEvolutionEngine(bank, make_graph(), seed=1)
        candidate = engine.generate(item_id, VariantSpec(OPERATOR_CONTEXT))
        validation = engine.validate(candidate, taught_progress(taught=("kc.not.in.graph",)))
        self.assertFalse(validation.valid)
        self.assertIn("kc.not.in.graph", validation.unknown_kcs)

    def test_incomplete_annotation_fails(self):
        bank, item_id = make_bank(verifier_type=None)
        engine = ExerciseEvolutionEngine(bank, make_graph(), seed=1)
        candidate = engine.generate(item_id, VariantSpec(OPERATOR_NUMERIC))
        validation = engine.validate(candidate, taught_progress())
        self.assertFalse(validation.valid)
        self.assertFalse(validation.annotation_complete)
        self.assertTrue(
            any(reason.startswith("incomplete_annotation") for reason in validation.reasons)
        )

    def test_missing_graph_fails_closed(self):
        engine = ExerciseEvolutionEngine(self.bank, None, seed=1)
        candidate = engine.generate(self.item_id, VariantSpec(OPERATOR_NUMERIC))
        validation = engine.validate(candidate, taught_progress())
        self.assertFalse(validation.valid)
        self.assertIn("graph_unavailable", validation.reasons)


# ---------------------------------------------------------------------------
# Sandbox, screening, item-bank review, and the candidate pool
# ---------------------------------------------------------------------------


class TestSandboxAndCandidatePool(unittest.TestCase):
    def setUp(self):
        self.bank, self.item_id = make_bank()
        self.graph = make_graph()
        self.engine = ExerciseEvolutionEngine(self.bank, self.graph, seed=7)
        self.candidate = self.engine.generate(
            self.item_id, VariantSpec(OPERATOR_NUMERIC)
        )
        self.snapshot = make_snapshot()
        self.items = phase_items()
        self.progress = taught_progress()

    def test_sandbox_reports_separated_channels(self):
        verdict = self.engine.evaluate_in_sandbox(
            self.candidate, snapshot=self.snapshot, items_by_phase=self.items
        )
        self.assertFalse(verdict.simulated_benefit["is_causal_evidence"])
        self.assertIsNone(verdict.real_transfer)
        self.assertEqual(0, verdict.simulation.observed_writes)
        self.assertIn("simulated benefit and real transfer are reported separately", verdict.isolation_checks)
        # Simulated gain alone can never promote.
        self.assertFalse(verdict.promotion_ready)
        self.assertIn("promotion_blocked:real_transfer_evidence_missing", verdict.reasons)

    def test_sandbox_can_pass_screening_with_simulated_evidence(self):
        verdict = self.engine.evaluate_in_sandbox(
            self.candidate, snapshot=self.snapshot, items_by_phase=self.items
        )
        self.assertTrue(verdict.passed_screening)

    def test_missing_simulated_items_fail_screening(self):
        verdict = self.engine.evaluate_in_sandbox(
            self.candidate,
            snapshot=self.snapshot,
            items_by_phase={PHASE_PRE: ["item.pre.1"], PHASE_POST_NEAR: []},
        )
        self.assertFalse(verdict.passed_screening)
        self.assertIn("screening_failed:too_few_simulated_items", verdict.reasons)

    def test_real_transfer_requires_frozen_set(self):
        frozen = FrozenEvalSet(
            dataset_id="synthetic.transfer",
            version="1",
            frozen_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
            items=(
                EvalItem("item.train.1", KC, "train", seen_before=True),
                EvalItem("item.near.1", KC, "transfer", seen_before=False),
            ),
        )
        outcome = RealOutcome(
            item_id="item.near.1",
            correct=True,
            source="student",
            occurred_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
        )
        verdict = self.engine.evaluate_in_sandbox(
            self.candidate,
            snapshot=self.snapshot,
            items_by_phase=self.items,
            frozen_set=frozen,
            real_outcomes=[outcome],
        )
        self.assertIsNotNone(verdict.real_transfer)
        self.assertFalse(verdict.real_transfer["causal_claim_supported"])
        # A tiny one-item real sample is below the promotion threshold.
        self.assertFalse(verdict.promotion_ready)
        self.assertIn("real_transfer_failed:too_few_items", verdict.reasons)

    def test_real_outcomes_without_frozen_set_fail_closed(self):
        outcome = RealOutcome(
            item_id="item.near.1",
            correct=True,
            source="student",
            occurred_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
        )
        with self.assertRaises(EvolutionValidationError):
            self.engine.evaluate_in_sandbox(
                self.candidate,
                snapshot=self.snapshot,
                items_by_phase=self.items,
                real_outcomes=[outcome],
            )

    def test_screen_skips_sandbox_when_gate_rejects(self):
        outcome = self.engine.screen(
            self.candidate,
            progress=taught_progress(taught=(PREREQ,)),
            snapshot=self.snapshot,
            items_by_phase=self.items,
        )
        self.assertFalse(outcome.eligible)
        self.assertIsNone(outcome.sandbox_verdict)
        self.assertEqual("rejected", outcome.status)

    def test_pool_rejects_unapproved_item(self):
        outcome = self.engine.screen(
            self.candidate,
            progress=self.progress,
            snapshot=self.snapshot,
            items_by_phase=self.items,
        )
        self.assertTrue(outcome.eligible)
        record = self.engine.submit_for_review(self.candidate, submitted_by="synthetic.author")
        self.assertEqual("pending_review", record.review_status)
        pool = EvolutionCandidatePool()
        with self.assertRaises(CandidatePoolError):
            pool.admit(outcome, record)

    def test_pool_admits_only_after_sandbox_and_review(self):
        outcome = self.engine.screen(
            self.candidate,
            progress=self.progress,
            snapshot=self.snapshot,
            items_by_phase=self.items,
        )
        record = self.engine.submit_for_review(self.candidate, submitted_by="synthetic.author")
        approved = self.bank.review(
            self.candidate.proposed_item_id, "approve", "synthetic.reviewer"
        )
        self.assertEqual("approved", approved.review_status)
        pool = EvolutionCandidatePool()
        admitted = pool.admit(outcome, approved)
        self.assertEqual("candidate_pool", admitted.status)
        self.assertEqual(1, len(pool.list()))
        self.assertEqual(1, len(pool.admission_log()))
        self.assertTrue(pool.admission_log()[0]["passed_screening"])

    def test_pool_rejects_ineligible_outcome(self):
        outcome = self.engine.screen(
            self.candidate,
            progress=taught_progress(taught=(PREREQ,)),
            snapshot=self.snapshot,
            items_by_phase=self.items,
        )
        pool = EvolutionCandidatePool()
        with self.assertRaises(CandidatePoolError):
            pool.admit(outcome, None)

    def test_submit_for_review_is_idempotent(self):
        first = self.engine.submit_for_review(self.candidate, submitted_by="a")
        second = self.engine.submit_for_review(self.candidate, submitted_by="a")
        self.assertEqual(first.review_status, second.review_status)
        self.assertEqual(1, len(self.bank.reviews(self.candidate.proposed_item_id)))

    def test_screening_policy_thresholds(self):
        strict = EvolutionSandbox(policy=ScreeningPolicy(min_simulated_gain=0.99))
        verdict = strict.evaluate(
            self.candidate, snapshot=self.snapshot, items_by_phase=self.items
        )
        self.assertFalse(verdict.passed_screening)
        self.assertIn("screening_failed:simulated_gain_below_threshold", verdict.reasons)


# ---------------------------------------------------------------------------
# Simulation isolation and reproducibility
# ---------------------------------------------------------------------------


class TestSimulationIsolation(unittest.TestCase):
    def setUp(self):
        self.snapshot = make_snapshot()
        self.lab = SimulationLab()
        self.config = SimulationConfig(
            config_version="synthetic.v1",
            scenario_id="scenario.quad.001",
            candidate_id="cand.quad.001",
            seed=424242,
        )

    def test_events_are_simulated_only_and_never_observed(self):
        session = self.lab.open_session(self.config, self.snapshot)
        result = session.run(phase_items())
        self.assertEqual(0, result.observed_writes)
        self.assertEqual(0, session.observed_writes)
        self.assertTrue(result.steps)
        for event in session.events():
            self.assertEqual("simulated", event["source"])
        self.assertEqual(result.result_fingerprint, self.lab.run(self.config, self.snapshot, phase_items()).result_fingerprint)

    def test_event_log_rejects_real_sources(self):
        log = SimulationEventLog()
        log.append(source="simulated", kind="simulation.step", payload={})
        with self.assertRaises(SimulationIsolationError):
            log.append(source="student", kind="observed.attempt", payload={})
        with self.assertRaises(SimulationIsolationError):
            log.append(source="trusted_grader", kind="observed.score", payload={})
        self.assertEqual(0, log.observed_writes)

    def test_snapshot_is_an_independent_copy(self):
        source = HypothesisSet(
            [Hypothesis("h.a", predicted_observable_behaviors={"x": 0.7}, weight=1.0)],
            unknown_weight=0.2,
        )
        snapshot = HypothesisSnapshot.from_hypothesis_set(
            source, snapshot_id="snapshot.independent"
        )
        session = self.lab.open_session(self.config, snapshot)
        before = source.weights()
        session.reweight({"h.a": 0.9})
        self.assertEqual(before, source.weights())
        # The session's own copy did change.
        self.assertNotEqual(before, session.hypothesis_weights())

    def test_simulation_never_touches_a_real_twin(self):
        twin = StudentTwin("synthetic.student.001")
        twin.record_observed(
            Event(
                event_id="evt.real.1",
                event_type="attempt",
                source="student",
                occurred_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
                student_id="synthetic.student.001",
            )
        )
        twin.update_mastery(KC, 0.4, 0.2, ["evt.real.1"])
        version_before = twin.version
        observed_before = tuple(event.event_id for event in twin.observed_events())
        simulated_before = len(twin.simulated_events())

        self.lab.run(self.config, self.snapshot, phase_items())

        self.assertEqual(version_before, twin.version)
        self.assertEqual(observed_before, tuple(e.event_id for e in twin.observed_events()))
        self.assertEqual(simulated_before, len(twin.simulated_events()))

    def test_simulation_result_has_no_real_transfer_channel(self):
        result = self.lab.run(self.config, self.snapshot, phase_items())
        self.assertIsNone(result.real_transfer)
        self.assertFalse(result.simulated_benefit()["is_causal_evidence"])


class TestReproducibility(unittest.TestCase):
    def setUp(self):
        self.snapshot = make_snapshot()
        self.lab = SimulationLab()

    def test_same_seed_same_fingerprint(self):
        config = SimulationConfig("v1", "scenario.1", "cand.1", seed=11)
        first = self.lab.run(config, self.snapshot, phase_items())
        second = self.lab.run(config, self.snapshot, phase_items())
        self.assertEqual(first.result_fingerprint, second.result_fingerprint)
        self.assertEqual(first.session_id, second.session_id)
        self.assertEqual(
            [step.correct for step in first.steps],
            [step.correct for step in second.steps],
        )

    def test_different_seed_changes_fingerprint(self):
        first = self.lab.run(
            SimulationConfig("v1", "scenario.1", "cand.1", seed=1),
            self.snapshot,
            phase_items(),
        )
        second = self.lab.run(
            SimulationConfig("v1", "scenario.1", "cand.1", seed=2),
            self.snapshot,
            phase_items(),
        )
        self.assertNotEqual(first.result_fingerprint, second.result_fingerprint)

    def test_config_fingerprint_is_stable_and_content_addressed(self):
        config = SimulationConfig("v1", "scenario.1", "cand.1", seed=11)
        other = SimulationConfig("v1", "scenario.1", "cand.1", seed=11)
        self.assertEqual(config.fingerprint(), other.fingerprint())
        different = SimulationConfig("v1", "scenario.1", "cand.1", seed=12)
        self.assertNotEqual(config.fingerprint(), different.fingerprint())

    def test_snapshot_fingerprint_changes_with_weights(self):
        other = HypothesisSnapshot(
            snapshot_id="snapshot.alt",
            hypotheses=(SimulationHypothesis("h.a", 1.0, 0.5),),
        )
        self.assertNotEqual(self.snapshot.fingerprint(), other.fingerprint())

    def test_max_steps_is_enforced(self):
        config = SimulationConfig("v1", "scenario.1", "cand.1", seed=3, max_steps=2)
        result = self.lab.run(config, self.snapshot, phase_items())
        self.assertEqual(2, len(result.steps))


class TestSimulationConfigValidation(unittest.TestCase):
    def test_unknown_phase_rejected(self):
        with self.assertRaises(SimulationConfigError):
            SimulationConfig("v1", "scenario.1", "cand.1", seed=1, phase_plan=("nope",))

    def test_uint32_seed_required(self):
        with self.assertRaises(SimulationConfigError):
            SimulationConfig("v1", "scenario.1", "cand.1", seed=2**32)


# ---------------------------------------------------------------------------
# Shared Python/TypeScript fixture parity
# ---------------------------------------------------------------------------


class TestSharedFixtureParity(unittest.TestCase):
    def test_rng_and_hash_expectations(self):
        data = load_fixture()
        rng = mulberry32(data["rng"]["seed"])
        self.assertEqual(
            data["rng"]["micros"], [quantize_micros(rng()) for _ in range(len(data["rng"]["micros"]))]
        )
        self.assertEqual(data["fnv"]["hash"], fnv1a32(data["fnv"]["text"]))

    def test_operator_candidate_hashes(self):
        data = load_fixture()
        source = data["operators"]["sourceAnnotation"]
        annotation = ItemAnnotation.from_value(source)
        bank = ItemBank()
        bank.add_item(
            data["operators"]["sourceItemId"], annotation, review_status="approved"
        )
        engine = ExerciseEvolutionEngine(bank, None, seed=data["operators"]["engineSeed"])
        for case in data["operators"]["cases"]:
            with self.subTest(operator=case["operator"]):
                candidate = engine.generate(
                    data["operators"]["sourceItemId"],
                    variant_from_fixture(case["spec"]),
                )
                self.assertEqual(case["candidateId"], candidate.candidate_id)
                self.assertEqual(case["proposedItemId"], candidate.proposed_item_id)
                self.assertEqual(case["affectedKcs"], list(candidate.provenance.affected_kcs))
                self.assertEqual(case["changeSummary"], candidate.provenance.change_summary)
                self.assertEqual(case["candidateHash"], candidate.content_hash())

    def test_simulation_fingerprint_expectation(self):
        data = load_fixture()
        sim = data["simulation"]
        config = config_from_fixture(sim["config"])
        snapshot = snapshot_from_fixture(sim["snapshot"])
        result = SimulationLab().run(config, snapshot, sim["itemsByPhase"])
        expected = sim["expected"]
        self.assertEqual(expected["resultFingerprint"], result.result_fingerprint)
        self.assertEqual(expected["sessionId"], result.session_id)
        self.assertEqual(expected["preAccuracyMicros"], quantize_micros(result.pre_accuracy))
        self.assertEqual(expected["postAccuracyMicros"], quantize_micros(result.post_accuracy))
        self.assertEqual(expected["gainMicros"], quantize_micros(result.pre_post_gain))
        self.assertEqual(
            expected["stepCorrectness"], [step.correct for step in result.steps]
        )
        self.assertEqual(
            expected["stepHypothesisIds"], [step.hypothesis_id for step in result.steps]
        )

    def test_fixture_is_content_hash_stable(self):
        data = load_fixture()
        self.assertEqual(
            data["operators"]["sourceAnnotationHash"],
            content_hash(data["operators"]["sourceAnnotation"]),
        )


if __name__ == "__main__":
    unittest.main()
