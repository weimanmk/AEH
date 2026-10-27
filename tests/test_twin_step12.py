"""Step 12 tests: the long-term twin lifecycle, isolation and integration.

Covers the TASKS.md Step 12 acceptance points:

* event-sourcing lifecycle: append / version / checkpoint / rollback / replay;
* strict observed vs simulated isolation (simulated never mutates real
  mastery, memory or hypotheses);
* multi-KC long-term memory integration with FSRS aging and review updates;
* Step 11 calibration parameters attached as a candidate and effective only
  after an explicit approval;
* hypothesis-set evolution (spawn/split/reweight/merge/prune) bound to the
  twin version.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone

from aeh.hypothesis import Hypothesis, HypothesisSet
from aeh.memory import MemoryObservation, MemoryParameters
from aeh.twin import (
    CalibrationApprovalRequired,
    CheckpointNotFoundError,
    Event,
    HypothesisBindingError,
    HypothesisOperation,
    MissingEvidenceError,
    SimulatedEventRejected,
    StudentTwin,
    StaleSimulationError,
    TwinError,
    UnknownEventSource,
    VersionNotFoundError,
)

FIXED_NOW = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)


def at(day: int, hour: int = 12) -> datetime:
    """A timestamp ``day - 1`` days after 2026-01-01 12:00 UTC."""
    return datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc) + timedelta(
        days=day - 1, hours=hour - 12
    )


def clock() -> datetime:
    return FIXED_NOW


def real(event_id: str, day: int = 1, **overrides) -> Event:
    values = {
        "event_id": event_id,
        "event_type": "attempt",
        "source": "student",
        "student_id": "stu_1",
        "occurred_at": at(day),
        "payload": {"correct": True},
    }
    values.update(overrides)
    return Event(**values)


def simulated(event_id: str = "sim_1", **overrides) -> Event:
    values = {
        "event_id": event_id,
        "event_type": "simulated_attempt",
        "source": "simulated",
        "student_id": "stu_1",
        "occurred_at": at(1),
        "payload": {"mastery_mean": 1.0},
    }
    values.update(overrides)
    return Event(**values)


def review(observation_id: str = "o1", day: int = 1, **overrides) -> MemoryObservation:
    values = {
        "observation_id": observation_id,
        "success": True,
        "independent": True,
        "hint_level": 0,
        "kind": "attempt",
        "occurred_at": at(day),
    }
    values.update(overrides)
    return MemoryObservation(**values)


def new_twin() -> StudentTwin:
    return StudentTwin("stu_1", clock=clock)


class LifecycleTests(unittest.TestCase):
    def test_append_version_checkpoint_rollback_and_replay(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_observed(real("ev_2", 2))
        twin.update_mastery("kc.a", 0.4, 0.2, ["ev_1"])
        twin.update_mastery("kc.b", 0.7, 0.1, ["ev_2"])
        self.assertEqual(twin.version, 2)

        checkpoint = twin.create_checkpoint("two")
        self.assertEqual(checkpoint.version, 2)
        self.assertEqual(checkpoint.evidence_revision, 2)
        self.assertEqual(checkpoint.created_at, FIXED_NOW)

        twin.update_mastery("kc.c", 0.9, 0.05, ["ev_1", "ev_2"])
        self.assertEqual(twin.version, 3)
        self.assertIsNotNone(twin.knowledge_for("kc.c"))

        restored = twin.restore_checkpoint(checkpoint.checkpoint_id)
        self.assertEqual(restored.version, 2)
        self.assertIsNone(twin.knowledge_for("kc.c"))
        # Real evidence survives every rollback.
        self.assertEqual(twin.evidence_revision, 2)
        self.assertEqual(twin.observed_evidence_ids, frozenset({"ev_1", "ev_2"}))

    def test_replay_is_deterministic_and_matches_incremental_state(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_observed(real("ev_2", 2))
        twin.update_mastery("kc.a", 0.4, 0.2, ["ev_1"])
        twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        twin.bind_hypotheses(
            HypothesisSet([Hypothesis("h1", weight=1.0)]), evidence_ids=["ev_1"]
        )
        before = twin.snapshot()
        replayed = twin.replay()
        self.assertEqual(replayed.knowledge, before.knowledge)
        self.assertEqual(dict(replayed.memory), dict(before.memory))
        self.assertEqual(replayed.hypothesis_revision, before.hypothesis_revision)
        self.assertEqual(
            replayed.active_parameter_version, before.active_parameter_version
        )
        self.assertEqual(twin.version, 3)

    def test_correction_is_a_new_event_not_a_history_edit(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_observed(real("ev_corr", 2, source="teacher", event_type="correction"))
        twin.update_mastery("kc.a", 0.3, 0.2, ["ev_1"])
        twin.update_mastery("kc.a", 0.6, 0.1, ["ev_corr"])
        self.assertEqual(twin.evidence_revision, 2)
        self.assertEqual(
            twin.knowledge_for("kc.a").evidence_ids, ("ev_corr",)
        )

    def test_rollback_and_checkpoint_errors(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.update_mastery("kc.a", 0.4, 0.2, ["ev_1"])
        with self.assertRaises(VersionNotFoundError):
            twin.rollback(99)
        with self.assertRaises(CheckpointNotFoundError):
            twin.restore_checkpoint("ckpt_missing")

    def test_checkpoint_minimises_private_payload_fields(self):
        twin = new_twin()
        twin.record_observed(
            real("ev_1", 1, payload={"raw_answer": "SYNTHETIC_SECRET"})
        )
        twin.update_mastery("kc.a", 0.4, 0.2, ["ev_1"])
        projected = twin.create_checkpoint().as_dict()
        self.assertNotIn("payload", projected)
        self.assertNotIn("raw_answer", json.dumps(projected))
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(projected))

    def test_inference_log_is_opaque_and_ordered(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.update_mastery("kc.a", 0.4, 0.2, ["ev_1"])
        twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        kinds = [step["kind"] for step in twin.export_inference_steps()]
        self.assertEqual(kinds, ["mastery", "memory_review"])
        self.assertNotIn("masteryMean", twin.export_inference_steps()[0])


class IsolationTests(unittest.TestCase):
    def test_simulated_event_cannot_enter_observed(self):
        twin = new_twin()
        with self.assertRaises(SimulatedEventRejected):
            twin.record_observed(simulated())
        self.assertEqual(twin.observed_events(), ())
        self.assertEqual(twin.version, 0)

    def test_unknown_source_is_rejected(self):
        twin = new_twin()
        with self.assertRaises(UnknownEventSource):
            twin.record_observed(real("ev_x", source="model_invented"))
        self.assertEqual(twin.evidence_revision, 0)

    def test_simulated_evidence_cannot_back_memory_or_hypotheses(self):
        twin = new_twin()
        twin.record_simulated(simulated("sim_1"))
        with self.assertRaises(MissingEvidenceError):
            twin.record_memory_review("kc.a", review(), ["sim_1"])
        with self.assertRaises(MissingEvidenceError):
            twin.bind_hypotheses(
                HypothesisSet([Hypothesis("h1", weight=1.0)]),
                evidence_ids=["sim_1"],
            )
        with self.assertRaises(MissingEvidenceError):
            twin.evolve_hypotheses(
                HypothesisOperation(
                    kind="spawn",
                    hypothesis=Hypothesis("h1", weight=1.0),
                    evidence_ids=("sim_1",),
                )
            )
        self.assertEqual(twin.version, 0)
        self.assertIsNone(twin.memory_for("kc.a"))

    def test_simulated_high_mastery_never_changes_real_mastery(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.update_mastery("kc.a", 0.55, 0.2, ["ev_1"])
        before = twin.knowledge_for("kc.a")
        twin.record_simulated(simulated("sim_high"))
        with self.assertRaises(MissingEvidenceError):
            twin.update_mastery("kc.a", 1.0, 0.0, ["sim_high"])
        self.assertEqual(twin.knowledge_for("kc.a"), before)

    def test_promotion_and_staleness_are_blocked(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_simulated(simulated("sim_1"))
        with self.assertRaises(SimulatedEventRejected):
            twin.promote_simulated("sim_1")
        with self.assertRaises(StaleSimulationError):
            twin.assert_fresh_simulation(0)
        twin.assert_fresh_simulation(1)


class MultiKCMemoryTests(unittest.TestCase):
    def test_reviews_integrate_multiple_kcs(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_observed(real("ev_2", 2))
        first = twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        second = twin.record_memory_review("kc.b", review("o2", 2), ["ev_2"])
        self.assertEqual(first.stability_days, 1.6)
        self.assertEqual(second.stability_days, 1.6)
        self.assertEqual(set(twin.memory_states()), {"kc.a", "kc.b"})
        summary = twin.memory_aggregate(at(40))
        self.assertEqual(summary["unit_count"], 2)
        self.assertEqual(summary["overdue_count"], 2)

    def test_reading_never_creates_a_memory_version(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        before_version = twin.version
        before_state = twin.memory_for("kc.a")
        twin.record_memory_review(
            "kc.a", review("o2", 2, kind="reading"), ["ev_1"]
        )
        self.assertEqual(twin.version, before_version)
        self.assertEqual(twin.memory_for("kc.a"), before_state)

    def test_forgetting_ages_state_without_lowering_stability(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        aged = twin.apply_memory_forgetting(at(45))
        self.assertEqual(aged, ("kc.a",))
        state = twin.memory_for("kc.a")
        self.assertTrue(state.needs_calibration)
        self.assertEqual(state.stability_days, 1.6)

    def test_forgetting_noop_does_not_bump_version(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        before = twin.version
        self.assertEqual(twin.apply_memory_forgetting(at(1, hour=13)), ())
        self.assertEqual(twin.version, before)


class CalibrationGateTests(unittest.TestCase):
    CALIBRATED = {
        "initial_stability_days": 2.0,
        "success_growth": 0.8,
        "failure_shrink": 0.3,
        "initial_difficulty": 4.0,
        "difficulty_success_delta": 0.1,
        "difficulty_failure_delta": 0.6,
        "parameter_version": "fsrs_calibrated_synthetic_v1",
    }

    def test_pending_candidate_does_not_take_effect(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        twin.propose_memory_calibration(self.CALIBRATED, candidate_id="cal.1")
        self.assertIsNotNone(twin.pending_calibration)
        self.assertEqual(twin.active_parameter_version, "fsrs_illustrative_19_81")
        updated = twin.record_memory_review("kc.a", review("o2", 2), ["ev_1"])
        # Baseline dynamics still apply while the candidate is pending.
        self.assertAlmostEqual(updated.stability_days, 1.6 * 1.6)

    def test_activation_requires_an_explicit_approval(self):
        twin = new_twin()
        twin.propose_memory_calibration(self.CALIBRATED, candidate_id="cal.1")
        with self.assertRaises(CalibrationApprovalRequired):
            twin.activate_memory_calibration(approval_id="", approved_by="teacher")
        with self.assertRaises(CalibrationApprovalRequired):
            twin.activate_memory_calibration(approval_id="ap-1", approved_by="")
        self.assertEqual(twin.active_parameter_version, "fsrs_illustrative_19_81")

    def test_approved_calibration_changes_review_dynamics(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.propose_memory_calibration(self.CALIBRATED, candidate_id="cal.1")
        activation = twin.activate_memory_calibration(
            approval_id="ap-1", approved_by="teacher"
        )
        self.assertEqual(activation.parameter_version, "fsrs_calibrated_synthetic_v1")
        self.assertEqual(
            twin.active_parameter_version, "fsrs_calibrated_synthetic_v1"
        )
        updated = twin.record_memory_review(
            "kc.a", review("o1", 1), ["ev_1"]
        )
        # calibrated initial stability 2.0 and success growth 0.8
        self.assertAlmostEqual(updated.stability_days, 3.6)
        self.assertEqual(updated.model_version, "fsrs_calibrated_synthetic_v1")

    def test_rollback_restores_pre_activation_parameters(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        checkpoint = twin.create_checkpoint("before-calibration")
        twin.propose_memory_calibration(self.CALIBRATED, candidate_id="cal.1")
        twin.activate_memory_calibration(approval_id="ap-1", approved_by="teacher")
        calibrated = twin.record_memory_review("kc.a", review("o1", 1), ["ev_1"])
        self.assertAlmostEqual(calibrated.stability_days, 3.6)
        twin.restore_checkpoint(checkpoint.checkpoint_id)
        self.assertEqual(twin.active_parameter_version, "fsrs_illustrative_19_81")
        baseline = twin.record_memory_review("kc.a", review("o2", 2), ["ev_1"])
        self.assertAlmostEqual(baseline.stability_days, 1.6)

    def test_activation_and_rollback_are_versioned(self):
        twin = new_twin()
        twin.propose_memory_calibration(self.CALIBRATED, candidate_id="cal.1")
        twin.activate_memory_calibration(approval_id="ap-1", approved_by="teacher")
        self.assertEqual(twin.version, 1)
        rollback = twin.rollback_memory_calibration(
            approval_id="ap-2", approved_by="teacher"
        )
        self.assertEqual(rollback.kind, "rollback")
        self.assertEqual(twin.version, 2)
        self.assertEqual(twin.active_parameter_version, "fsrs_illustrative_19_81")

    def test_propose_from_a_step11_style_candidate(self):
        class FakeCandidate:
            candidate_id = "fsrs.calibration.synthetic_v1"
            version = "synthetic_v1"
            changes = {
                "parameters": {
                    "initial_stability_days": 2.0,
                    "success_growth": 0.8,
                    "failure_shrink": 0.3,
                    "initial_difficulty": 4.0,
                    "difficulty_success_delta": 0.1,
                    "difficulty_failure_delta": 0.6,
                },
                "parameter_version": "fsrs_calibrated_synthetic_v1",
                "report_fingerprint": "fp_synthetic",
            }

        twin = new_twin()
        pending = twin.propose_memory_calibration_from_candidate(
            FakeCandidate(), proposed_by="host"
        )
        self.assertEqual(pending.candidate_id, "fsrs.calibration.synthetic_v1")
        self.assertEqual(pending.fingerprint, "fp_synthetic")
        self.assertEqual(
            pending.parameters.parameter_version, "fsrs_calibrated_synthetic_v1"
        )

    def test_rejecting_a_candidate_leaves_baseline_active(self):
        twin = new_twin()
        twin.propose_memory_calibration(self.CALIBRATED, candidate_id="cal.1")
        rejected = twin.reject_memory_calibration("not enough evidence")
        self.assertIsNotNone(rejected)
        self.assertIsNone(twin.pending_calibration)
        self.assertEqual(twin.active_parameter_version, "fsrs_illustrative_19_81")


class HypothesisEvolutionTests(unittest.TestCase):
    def test_bind_and_reweight_track_the_twin_version(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_observed(real("ev_2", 2))
        binding = twin.bind_hypotheses(
            HypothesisSet([Hypothesis("h1", weight=1.0), Hypothesis("h2", weight=1.0)]),
            evidence_ids=["ev_1"],
        )
        self.assertEqual(binding.twin_version, 1)
        self.assertEqual(twin.hypotheses.bound_twin_version, 1)

        updated = twin.evolve_hypotheses(
            HypothesisOperation(
                kind="reweight",
                likelihoods={"h1": 0.9, "h2": 0.1},
                evidence_ids=("ev_1", "ev_2"),
            )
        )
        self.assertEqual(updated.twin_version, 2)
        self.assertEqual(twin.hypotheses.bound_twin_version, 2)
        self.assertGreater(updated.weights["h1"], updated.weights["h2"])
        self.assertAlmostEqual(sum(updated.weights.values()), 1.0)

    def test_all_operations_keep_the_set_normalised(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.record_observed(real("ev_2", 2))
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="spawn",
                hypothesis=Hypothesis("h1", weight=1.0),
                evidence_ids=("ev_1",),
            )
        )
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="spawn",
                hypothesis=Hypothesis("h2", weight=1.0),
                evidence_ids=("ev_1",),
            )
        )
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="split",
                hypothesis_id="h1",
                children=(
                    Hypothesis("h1a", weight=1.0),
                    Hypothesis("h1b", weight=1.0),
                ),
                evidence_ids=("ev_2",),
            )
        )
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="merge",
                hypothesis_ids=("h2", "h1a"),
                merged=Hypothesis("h2a", weight=0.0),
                evidence_ids=("ev_2",),
            )
        )
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="prune",
                hypothesis_id="h1b",
                reason="test",
                evidence_ids=("ev_2",),
            )
        )
        self.assertAlmostEqual(sum(twin.hypotheses.weights().values()), 1.0)
        self.assertEqual(twin.hypotheses.get("h1b").status, "pruned")

    def test_rollback_restores_the_bound_hypothesis_revision(self):
        twin = new_twin()
        twin.record_observed(real("ev_1", 1))
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="spawn",
                hypothesis=Hypothesis("h1", weight=1.0),
                evidence_ids=("ev_1",),
            )
        )
        checkpoint = twin.create_checkpoint()
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="spawn",
                hypothesis=Hypothesis("h2", weight=1.0),
                evidence_ids=("ev_1",),
            )
        )
        twin.rollback(checkpoint.version)
        self.assertEqual(twin.hypotheses.bound_twin_version, checkpoint.version)
        self.assertIsNone(twin.hypotheses.get("h2"))

    def test_operation_without_a_bound_set_is_rejected(self):
        twin = new_twin()
        with self.assertRaises(HypothesisBindingError):
            twin.evolve_hypotheses(
                HypothesisOperation(kind="prune", hypothesis_id="h1")
            )


if __name__ == "__main__":
    unittest.main()
