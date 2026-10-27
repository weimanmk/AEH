"""Step 11 tests: FSRS parameter calibration (spec section 8).

All data is synthetic.  The tests cover the deterministic fit, the bootstrap
uncertainty intervals, the applicability statement, the reproducible shared
fixture, the parameter *candidate* boundary, and the isolated-evaluation +
explicit-approval activation gate.  No real student data is used.
"""

from __future__ import annotations

import contextlib
import io
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aeh.evolution import Actor, ApprovalRecord
from aeh.fsrs_calibration import (
    BASELINE_PARAMETER_VERSION,
    CALIBRATION_SCHEMA_VERSION,
    DEFAULT_DATA_VERSION,
    DIFFICULTY_MAX,
    DIFFICULTY_MIN,
    FSRS_19_81,
    MIN_STABILITY_DAYS,
    PARAMETER_BOUNDS,
    PARAMETER_NAMES,
    PARAMETER_PRIORS,
    PRODUCTION_MUTATION_ENABLED,
    STATUS_ACTIVATED,
    STATUS_APPROVED,
    STATUS_EVALUATED,
    STATUS_REGISTERED,
    STATUS_REJECTED,
    TRUSTED_REAL_SOURCES,
    ActivatedParameters,
    Applicability,
    CalibrationActivationGate,
    CalibrationApprovalPolicy,
    CalibrationConfig,
    CalibrationDataset,
    CalibrationDeniedError,
    CalibrationService,
    CalibrationValidationError,
    FSRSParameters,
    RealTransferEvidence,
    ReviewEvent,
    ReviewSequence,
    calibrate,
    dataset_from_dict,
    evaluate_candidate,
    generate_dataset,
    mulberry32,
    parameters_from_candidate,
    percentile,
    quantize_micros,
    round4,
)
from aeh.fsrs_calibration_cli import build_payload, main as cli_main
from aeh.memory import MemoryState
from aeh.twin import Event, StudentTwin

FIXTURE = Path(__file__).parent / "fixtures" / "fsrs_calibration_step11.json"

CREATED_AT = datetime(2026, 5, 1, 9, 0, tzinfo=timezone.utc)
DECIDED_AT = datetime(2026, 5, 1, 9, 5, tzinfo=timezone.utc)

REVIEWER = Actor(actor_id="reviewer.1", role="reviewer")


def load_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def config_from_fixture(data):
    return CalibrationConfig(
        seed=data["seed"],
        data_version=data["dataVersion"],
        parameter_version=data["parameterVersion"],
        rounds=data["rounds"],
        step_fraction=data["stepFraction"],
        bootstrap_resamples=data["bootstrapResamples"],
        ridge=data["ridge"],
        confidence=data["confidence"],
        min_sequences=data["minSequences"],
        min_observations=data["minObservations"],
    )


def dataset_from_fixture(data):
    return dataset_from_dict(data)


def make_event(**overrides):
    values = {"elapsed_days": 3.0, "success": True, "weight": 1.0}
    values.update(overrides)
    return ReviewEvent(**values)


def make_sequence(sequence_id="seq.1", events=None, scope="synthetic.math"):
    if events is None:
        events = (
            make_event(elapsed_days=2.0, success=True),
            make_event(elapsed_days=5.0, success=False),
            make_event(elapsed_days=4.0, success=True),
        )
    return ReviewSequence(sequence_id=sequence_id, scope=scope, events=tuple(events))


def make_dataset(sequences=None, dataset_id="dataset.test", data_version=None):
    if sequences is None:
        sequences = (make_sequence(),)
    return CalibrationDataset(
        dataset_id=dataset_id,
        data_version=data_version or DEFAULT_DATA_VERSION,
        generator_version="aeh.fsrs.synthetic.test",
        scope="synthetic.math",
        sequences=tuple(sequences),
    )


def make_config(**overrides):
    values = {
        "seed": 1234,
        "parameter_version": "test.params.v1",
        "bootstrap_resamples": 8,
    }
    values.update(overrides)
    return CalibrationConfig(**values)


class DeterministicPrimitiveTests(unittest.TestCase):
    def test_mulberry32_stream_is_stable(self):
        def stream(seed):
            rng = mulberry32(seed)
            return [rng() for _ in range(4)]

        first = stream(42)
        second = stream(42)
        self.assertEqual(first, second)
        self.assertTrue(all(0.0 <= value < 1.0 for value in first))

    def test_rounding_and_micros(self):
        self.assertEqual(round4(1.23456), 1.2346)
        self.assertEqual(round4(1.00005), 1.0001)
        self.assertEqual(quantize_micros(0.5), 500000)

    def test_percentile_interpolates(self):
        expected = percentile([0.0, 10.0], 0.25)
        self.assertAlmostEqual(expected, 2.5, places=12)
        self.assertEqual(percentile([7.0], 0.9), 7.0)


class ModelTests(unittest.TestCase):
    def test_retention_uses_illustrative_formula(self):
        params = FSRSParameters.baseline()
        # Baseline difficulty is 5 so the effective stability equals S0.
        predicted = params.predict(2.0, params.initial_stability_days, 5.0)
        expected = (1.0 + FSRS_19_81 * 2.0 / params.initial_stability_days) ** -0.5
        self.assertAlmostEqual(predicted, expected, places=12)

    def test_difficulty_modulates_effective_stability(self):
        params = FSRSParameters.baseline()
        easy = params.effective_stability(2.0, 1.0)
        hard = params.effective_stability(2.0, 9.0)
        self.assertGreater(easy, hard)
        self.assertGreaterEqual(hard, MIN_STABILITY_DAYS)

    def test_success_grows_and_failure_shrinks_stability(self):
        params = FSRSParameters.baseline()
        grown, difficulty_after = params.update(2.0, 5.0, True, 1.0)
        self.assertGreater(grown, 2.0)
        self.assertLess(difficulty_after, 5.0)
        shrunk, difficulty_up = params.update(2.0, 5.0, False, 1.0)
        self.assertLess(shrunk, 2.0)
        self.assertGreater(difficulty_up, 5.0)

    def test_reading_weight_does_not_update(self):
        params = FSRSParameters.baseline()
        stability, difficulty = params.update(2.0, 5.0, True, 0.0)
        self.assertEqual(stability, 2.0)
        self.assertEqual(difficulty, 5.0)

    def test_stability_and_difficulty_bounds_are_respected(self):
        params = FSRSParameters.from_values((0.2, 2.0, 0.9, 10.0, 1.0, 2.0))
        stability, difficulty = params.update(MIN_STABILITY_DAYS, 1.0, False, 1.0)
        self.assertGreaterEqual(stability, MIN_STABILITY_DAYS)
        self.assertGreaterEqual(difficulty, DIFFICULTY_MIN)
        stability, difficulty = params.update(1.0, DIFFICULTY_MAX, True, 1.0)
        self.assertLessEqual(difficulty, DIFFICULTY_MAX)

    def test_parameters_reject_out_of_bounds(self):
        with self.assertRaises(CalibrationValidationError):
            FSRSParameters.from_values((0.0, 0.6, 0.4, 5.0, 0.2, 0.5))
        with self.assertRaises(CalibrationValidationError):
            FSRSParameters.from_values((1.0, 3.0, 0.4, 5.0, 0.2, 0.5))

    def test_baseline_is_the_illustrative_prior(self):
        baseline = FSRSParameters.baseline()
        self.assertEqual(baseline.parameter_version, BASELINE_PARAMETER_VERSION)
        for name in PARAMETER_NAMES:
            self.assertEqual(baseline.value_dict()[name], PARAMETER_PRIORS[name])


class DatasetValidationTests(unittest.TestCase):
    def test_negative_elapsed_is_rejected(self):
        with self.assertRaises(CalibrationValidationError):
            make_event(elapsed_days=-1.0)

    def test_weight_range_is_enforced(self):
        with self.assertRaises(CalibrationValidationError):
            make_event(weight=1.5)

    def test_empty_sequence_is_rejected(self):
        with self.assertRaises(CalibrationValidationError):
            ReviewSequence(sequence_id="seq.1", scope="synthetic.math", events=())

    def test_duplicate_sequence_ids_are_rejected(self):
        with self.assertRaises(CalibrationValidationError):
            make_dataset(
                sequences=(make_sequence("dup"), make_sequence("dup"))
            )

    def test_empty_dataset_is_rejected(self):
        with self.assertRaises(CalibrationValidationError):
            CalibrationDataset(
                dataset_id="dataset.empty",
                data_version="synthetic.test.v1",
                generator_version="aeh.fsrs.synthetic.test",
                scope="synthetic.math",
                sequences=(),
            )


class ConfigValidationTests(unittest.TestCase):
    def test_bad_seed_rounds_step_confidence(self):
        with self.assertRaises(CalibrationValidationError):
            CalibrationConfig(seed=-1)
        with self.assertRaises(CalibrationValidationError):
            CalibrationConfig(rounds=0)
        with self.assertRaises(CalibrationValidationError):
            CalibrationConfig(step_fraction=1.0)
        with self.assertRaises(CalibrationValidationError):
            CalibrationConfig(confidence=0.5)
        with self.assertRaises(CalibrationValidationError):
            CalibrationConfig(bootstrap_resamples=0)
        with self.assertRaises(CalibrationValidationError):
            CalibrationConfig(seed=0x1_0000_0000)

    def test_data_version_mismatch_is_rejected(self):
        dataset = make_dataset()
        with self.assertRaises(CalibrationValidationError):
            calibrate(dataset, make_config(data_version="other.v1"))


class CalibrationReportTests(unittest.TestCase):
    def setUp(self):
        self.dataset = generate_dataset(
            seed=11, sequence_count=8, events_per_sequence=4
        )
        self.report = calibrate(
            self.dataset, make_config(seed=11, bootstrap_resamples=8)
        )

    def test_reproducible_report_fingerprint(self):
        other = calibrate(
            self.dataset, make_config(seed=11, bootstrap_resamples=8)
        )
        self.assertEqual(self.report.fingerprint(), other.fingerprint())

    def test_seed_changes_bootstrap_interval_not_point_estimate(self):
        other = calibrate(
            self.dataset, make_config(seed=22, bootstrap_resamples=8)
        )
        self.assertEqual(
            self.report.parameters.values(), other.parameters.values()
        )
        self.assertNotEqual(self.report.fingerprint(), other.fingerprint())

    def test_every_parameter_has_a_bootstrap_interval(self):
        self.assertEqual(
            [estimate.name for estimate in self.report.estimates],
            list(PARAMETER_NAMES),
        )
        for estimate in self.report.estimates:
            self.assertLessEqual(estimate.ci_low, estimate.ci_high)
            lower, upper = PARAMETER_BOUNDS[estimate.name]
            self.assertGreaterEqual(estimate.ci_low, lower)
            self.assertLessEqual(estimate.ci_high, upper)

    def test_metrics_and_reliability_bins(self):
        metrics = self.report.metrics
        self.assertGreaterEqual(metrics.brier, 0.0)
        self.assertLessEqual(metrics.brier, 1.0)
        self.assertLessEqual(metrics.brier_ci_low, metrics.brier_ci_high)
        self.assertGreaterEqual(metrics.ece, 0.0)
        self.assertEqual(len(metrics.reliability_bins), 10)
        total = sum(int(entry["count"]) for entry in metrics.reliability_bins)
        self.assertEqual(total, self.dataset.observation_count())

    def test_applicability_has_scope_and_out_of_scope(self):
        applicability = self.report.applicability
        self.assertIsInstance(applicability, Applicability)
        self.assertEqual(applicability.scope, self.dataset.scope)
        self.assertTrue(applicability.conditions)
        self.assertTrue(applicability.out_of_scope)
        self.assertGreaterEqual(
            applicability.elapsed_days_max, applicability.elapsed_days_min
        )

    def test_evidence_sufficiency_thresholds(self):
        tiny = generate_dataset(
            seed=3, sequence_count=2, events_per_sequence=3,
            dataset_id="dataset.tiny",
        )
        report = calibrate(tiny, make_config(bootstrap_resamples=4, min_observations=20))
        self.assertFalse(report.evidence_sufficient)
        self.assertFalse(report.applicability.evidence_sufficient)

    def test_report_payload_is_declarative_json(self):
        payload = self.report.as_dict()
        encoded = json.dumps(payload, sort_keys=True)
        self.assertIn(CALIBRATION_SCHEMA_VERSION, encoded)
        self.assertEqual(payload["reportFingerprint"], self.report.fingerprint())


class GeneratorTests(unittest.TestCase):
    def test_generator_is_deterministic(self):
        first = generate_dataset(seed=5, sequence_count=4, events_per_sequence=3)
        second = generate_dataset(seed=5, sequence_count=4, events_per_sequence=3)
        self.assertEqual(first.digest(), second.digest())

    def test_different_seed_changes_data(self):
        first = generate_dataset(seed=5, sequence_count=4, events_per_sequence=3)
        second = generate_dataset(seed=6, sequence_count=4, events_per_sequence=3)
        self.assertNotEqual(first.digest(), second.digest())

    def test_generated_shapes(self):
        dataset = generate_dataset(seed=5, sequence_count=4, events_per_sequence=3)
        self.assertEqual(len(dataset.sequences), 4)
        self.assertEqual(dataset.observation_count(), 12)
        for sequence in dataset.sequences:
            self.assertEqual(len(sequence.events), 3)
            for event in sequence.events:
                self.assertGreaterEqual(event.elapsed_days, 0.0)
                self.assertIn(event.weight, (1.0, 0.3))


class CandidateBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.dataset = generate_dataset(seed=21, sequence_count=8, events_per_sequence=4)
        self.service = CalibrationService(
            self.dataset, make_config(seed=21, bootstrap_resamples=6)
        )
        self.report = self.service.calibrate()

    def test_candidate_is_versioned_declarative_and_mutation_free(self):
        candidate = self.service.propose_candidate(
            self.report, author="calibration.bot", created_at=CREATED_AT
        )
        self.assertFalse(candidate.mutates_production)
        self.assertEqual(candidate.kind, "config")
        self.assertEqual(candidate.baseline_version, BASELINE_PARAMETER_VERSION)
        self.assertIn("review_scheduling", candidate.impact_scope)
        self.assertFalse(PRODUCTION_MUTATION_ENABLED)

    def test_candidate_round_trips_parameters(self):
        candidate = self.service.propose_candidate(
            self.report, author="calibration.bot", created_at=CREATED_AT
        )
        params = parameters_from_candidate(candidate)
        self.assertEqual(params.quantized_dict(), self.report.parameters.quantized_dict())

    def test_service_cannot_be_pointed_at_a_different_version(self):
        candidate = self.service.propose_candidate(
            self.report, author="calibration.bot", created_at=CREATED_AT
        )
        self.assertEqual(candidate.version, self.report.parameter_version)


class EvaluationAndGateTests(unittest.TestCase):
    def setUp(self):
        self.dataset = generate_dataset(seed=31, sequence_count=10, events_per_sequence=5)
        self.held_out = generate_dataset(
            seed=77, sequence_count=5, events_per_sequence=4,
            dataset_id="dataset.heldout",
        )
        self.service = CalibrationService(
            self.dataset, make_config(seed=31, bootstrap_resamples=6)
        )
        self.report = self.service.calibrate()
        self.candidate = self.service.propose_candidate(
            self.report, author="calibration.bot", created_at=CREATED_AT
        )
        self.assertGreater(
            self.report.parameters.success_growth, 0.0  # sanity: signal present
        )

    def test_simulated_and_real_channels_are_separate(self):
        verdict = evaluate_candidate(
            self.candidate, self.held_out, evaluated_at=CREATED_AT
        )
        self.assertIsNotNone(verdict.simulated_benefit)
        self.assertIsNone(verdict.real_transfer)
        self.assertFalse(verdict.promotion_ready)
        self.assertFalse(verdict.simulated_benefit["isCausalEvidence"])
        self.assertIn(
            "promotion_blocked:real_transfer_evidence_missing", verdict.reasons
        )

    def test_real_transfer_requires_trusted_unseen_evidence(self):
        with self.assertRaises(CalibrationValidationError):
            RealTransferEvidence("anonymous", 4, 0.1, True)
        self.assertIn("student", TRUSTED_REAL_SOURCES)

    def test_real_transfer_can_make_promotion_ready(self):
        evidence = RealTransferEvidence("teacher", 4, 0.12, True)
        verdict = evaluate_candidate(
            self.candidate,
            self.held_out,
            real_evidence=evidence,
            evaluated_at=CREATED_AT,
        )
        self.assertTrue(verdict.promotion_ready)
        self.assertIsNotNone(verdict.real_transfer)
        self.assertFalse(verdict.real_transfer["isCausalEvidence"])

    def test_seen_real_items_block_promotion(self):
        evidence = RealTransferEvidence("student", 4, 0.2, False)
        verdict = evaluate_candidate(
            self.candidate,
            self.held_out,
            real_evidence=evidence,
            evaluated_at=CREATED_AT,
        )
        self.assertFalse(verdict.promotion_ready)
        self.assertIn("real_transfer_failed:item_was_seen", verdict.reasons)

    def test_held_out_without_improvement_is_rejected(self):
        adversarial = generate_dataset(
            seed=80, sequence_count=5, events_per_sequence=4,
            dataset_id="dataset.adversarial",
        )
        verdict = evaluate_candidate(
            self.candidate, adversarial, evaluated_at=CREATED_AT
        )
        self.assertFalse(verdict.screening_passed)
        self.assertIn(
            "screening_failed:brier_improvement_below_threshold", verdict.reasons
        )

    def test_activation_requires_explicit_approval(self):
        gate = CalibrationActivationGate(now=lambda: DECIDED_AT)
        gate.register(self.candidate)
        self.assertEqual(
            gate.status(self.candidate.candidate_id, self.candidate.version),
            STATUS_REGISTERED,
        )
        gate.evaluate(
            self.candidate.candidate_id,
            self.candidate.version,
            self.held_out,
            actor=REVIEWER,
        )
        self.assertEqual(
            gate.status(self.candidate.candidate_id, self.candidate.version),
            STATUS_EVALUATED,
        )
        with self.assertRaises(CalibrationDeniedError):
            gate.activate(
                self.candidate.candidate_id,
                self.candidate.version,
                actor=REVIEWER,
            )

    def test_explicit_approval_then_activation(self):
        gate = CalibrationActivationGate(now=lambda: DECIDED_AT)
        gate.register(self.candidate)
        gate.evaluate(
            self.candidate.candidate_id,
            self.candidate.version,
            self.held_out,
            actor=REVIEWER,
        )
        approval = ApprovalRecord(
            candidate_id=self.candidate.candidate_id,
            candidate_version=self.candidate.version,
            decision="approved",
            approved_by=REVIEWER.actor_id,
            decided_at=DECIDED_AT,
            reason="synthetic calibration accepted for the demo",
            role=REVIEWER.role,
        )
        gate.approve(
            self.candidate.candidate_id, self.candidate.version, approval, REVIEWER
        )
        self.assertEqual(
            gate.status(self.candidate.candidate_id, self.candidate.version),
            STATUS_APPROVED,
        )
        activation = gate.activate(
            self.candidate.candidate_id,
            self.candidate.version,
            actor=REVIEWER,
        )
        self.assertIsInstance(activation, ActivatedParameters)
        self.assertEqual(
            gate.status(self.candidate.candidate_id, self.candidate.version),
            STATUS_ACTIVATED,
        )
        self.assertGreater(gate.audit.head(), 0)

    def test_candidate_cannot_approve_itself(self):
        gate = CalibrationActivationGate(now=lambda: DECIDED_AT)
        gate.register(self.candidate)
        gate.evaluate(
            self.candidate.candidate_id,
            self.candidate.version,
            self.held_out,
            actor=REVIEWER,
        )
        author_actor = Actor(actor_id=self.candidate.author, role="reviewer")
        approval = ApprovalRecord(
            candidate_id=self.candidate.candidate_id,
            candidate_version=self.candidate.version,
            decision="approved",
            approved_by=author_actor.actor_id,
            decided_at=DECIDED_AT,
            reason="self approval",
            role="reviewer",
        )
        with self.assertRaises(Exception):
            gate.approve(
                self.candidate.candidate_id,
                self.candidate.version,
                approval,
                author_actor,
            )

    def test_non_host_role_cannot_approve(self):
        gate = CalibrationActivationGate(now=lambda: DECIDED_AT)
        gate.register(self.candidate)
        gate.evaluate(
            self.candidate.candidate_id,
            self.candidate.version,
            self.held_out,
            actor=REVIEWER,
        )
        student_actor = Actor(actor_id="student.1", role="student")
        approval = ApprovalRecord(
            candidate_id=self.candidate.candidate_id,
            candidate_version=self.candidate.version,
            decision="approved",
            approved_by=student_actor.actor_id,
            decided_at=DECIDED_AT,
            reason="not a host role",
            role="student",
        )
        with self.assertRaises(Exception):
            gate.approve(
                self.candidate.candidate_id,
                self.candidate.version,
                approval,
                student_actor,
            )

    def test_failed_screening_rejects_candidate(self):
        gate = CalibrationActivationGate(now=lambda: DECIDED_AT)
        gate.register(self.candidate)
        # An empty-observation held-out set cannot pass screening.
        sparse = make_dataset(
            sequences=(make_sequence(events=(make_event(),)),),
            dataset_id="dataset.sparse",
            data_version="synthetic.test.v1",
        )
        verdict = evaluate_candidate(self.candidate, sparse, evaluated_at=CREATED_AT)
        self.assertFalse(verdict.screening_passed)


class IsolationTests(unittest.TestCase):
    def test_calibration_never_changes_a_memory_state(self):
        memory = MemoryState(learner_id="stu.1", memory_unit_id="kc.quadratic")
        before = memory
        dataset = generate_dataset(seed=41, sequence_count=6, events_per_sequence=4)
        service = CalibrationService(
            dataset, make_config(seed=41, bootstrap_resamples=4)
        )
        report = service.calibrate()
        service.propose_candidate(
            report, author="calibration.bot", created_at=CREATED_AT
        )
        self.assertEqual(memory, before)
        self.assertEqual(memory.stability_days, before.stability_days)

    def test_calibration_never_changes_a_twin(self):
        twin = StudentTwin("stu.1")
        twin.record_observed(
            Event(
                event_id="ev.1",
                event_type="attempt",
                source="student",
                occurred_at=CREATED_AT,
                student_id="stu.1",
                payload={"correct": True},
            )
        )
        twin.update_mastery("kc.quadratic", 0.55, 0.2, ["ev.1"])
        snapshot_before = twin.snapshot()
        evidence_before = twin.evidence_revision

        dataset = generate_dataset(seed=31, sequence_count=10, events_per_sequence=5)
        held_out = generate_dataset(
            seed=77, sequence_count=5, events_per_sequence=4,
            dataset_id="dataset.heldout",
        )
        service = CalibrationService(
            dataset, make_config(seed=51, bootstrap_resamples=4)
        )
        report = service.calibrate()
        candidate = service.propose_candidate(
            report, author="calibration.bot", created_at=CREATED_AT
        )
        gate = CalibrationActivationGate(now=lambda: DECIDED_AT)
        gate.register(candidate)
        gate.evaluate(candidate.candidate_id, candidate.version, held_out, actor=REVIEWER)
        approval = ApprovalRecord(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            decision="approved",
            approved_by=REVIEWER.actor_id,
            decided_at=DECIDED_AT,
            reason="approval for isolation test",
            role=REVIEWER.role,
        )
        gate.approve(candidate.candidate_id, candidate.version, approval, REVIEWER)
        gate.activate(candidate.candidate_id, candidate.version, actor=REVIEWER)

        self.assertEqual(twin.snapshot(), snapshot_before)
        self.assertEqual(twin.evidence_revision, evidence_before)
        self.assertEqual(twin.knowledge_for("kc.quadratic").mastery_mean, 0.55)


class SharedFixtureParityTests(unittest.TestCase):
    def setUp(self):
        self.data = load_fixture()
        self.dataset = dataset_from_fixture(self.data["dataset"])
        self.config = config_from_fixture(self.data["config"])
        self.report = calibrate(self.dataset, self.config)
        self.expected = self.data["expected"]

    def test_dataset_and_config_fingerprints(self):
        self.assertEqual(self.expected["datasetDigest"], self.dataset.digest())
        self.assertEqual(
            self.expected["configFingerprint"], self.config.fingerprint()
        )

    def test_report_fingerprint_and_parameters(self):
        self.assertEqual(self.expected["reportFingerprint"], self.report.fingerprint())
        self.assertEqual(
            self.expected["parameters"], self.report.parameters.quantized_dict()
        )

    def test_estimates_match(self):
        expected_by_name = {
            entry["name"]: entry for entry in self.expected["estimates"]
        }
        for estimate in self.report.estimates:
            entry = expected_by_name[estimate.name]
            self.assertEqual(entry["point"], round4(estimate.point))
            self.assertEqual(entry["ciLow"], round4(estimate.ci_low))
            self.assertEqual(entry["ciHigh"], round4(estimate.ci_high))
            self.assertEqual(entry["identified"], estimate.identified())

    def test_metrics_match(self):
        metrics = self.report.metrics.as_dict()
        self.assertEqual(self.expected["metrics"], metrics)

    def test_counts_and_applicability_match(self):
        self.assertEqual(self.expected["sequenceCount"], self.report.sequence_count)
        self.assertEqual(
            self.expected["observationCount"], self.report.observation_count
        )
        self.assertEqual(
            self.expected["evidenceSufficient"], self.report.evidence_sufficient
        )
        self.assertEqual(
            self.expected["applicability"], self.report.applicability.as_dict()
        )

    def test_fixture_is_canonical_json_stable(self):
        encoded = json.dumps(self.data["dataset"], sort_keys=True)
        self.assertIn("seq.synthetic.0000", encoded)


class CliTests(unittest.TestCase):
    def test_build_payload_is_reproducible(self):
        first = build_payload(seed=9, sequence_count=6, events_per_sequence=4, bootstrap_resamples=4)
        second = build_payload(seed=9, sequence_count=6, events_per_sequence=4, bootstrap_resamples=4)
        self.assertEqual(
            first["report"]["reportFingerprint"],
            second["report"]["reportFingerprint"],
        )
        self.assertIsNone(first["evaluation"]["realTransfer"])
        self.assertIn("activationBlocked", first)

    def test_cli_json_runs(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = cli_main(["--json", "--bootstrap", "4"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertIn("report", payload)
        self.assertIn("evaluation", payload)


if __name__ == "__main__":
    unittest.main()
