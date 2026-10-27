"""The four non-negotiable Step 1 invariants from TASKS.md.

These tests are intentionally end-to-end and named after the invariant so a
reviewer can map the requirement to executable evidence.
"""

from __future__ import annotations

import unittest

from aeh.curriculum_gate import (
    MODE_LEARN,
    CurriculumItem,
    LearnerProgress,
    allow,
)
from aeh.hypothesis import Hypothesis, HypothesisSet
from aeh.memory import MemoryObservation, MemoryState, update_memory
from aeh.twin import (
    Event,
    MissingEvidenceError,
    SimulatedEventRejected,
    StudentTwin,
)


class InvariantTests(unittest.TestCase):
    def test_simulation_cannot_change_real_mastery(self):
        twin = StudentTwin("stu_invariant")
        twin.record_observed(
            Event(
                event_id="real_1",
                event_type="attempt",
                source="student",
                student_id="stu_invariant",
            )
        )
        twin.update_mastery("kc.algebra", 0.62, 0.2, ["real_1"])
        before = twin.knowledge_for("kc.algebra")

        twin.record_simulated(
            Event(
                event_id="sim_1",
                event_type="simulated_attempt",
                source="virtual_student",
                student_id="stu_invariant",
                payload={"mastery_mean": 0.99},
            )
        )
        with self.assertRaises(SimulatedEventRejected):
            twin.record_observed(
                Event(
                    event_id="sim_2",
                    event_type="simulated_attempt",
                    source="simulated",
                    student_id="stu_invariant",
                )
            )
        with self.assertRaises(MissingEvidenceError):
            twin.update_mastery("kc.algebra", 0.99, 0.01, ["sim_1"])

        self.assertEqual(twin.knowledge_for("kc.algebra"), before)
        self.assertEqual(before.mastery_mean, 0.62)
        self.assertNotIn("sim_1", twin.observed_evidence_ids)

    def test_future_knowledge_is_rejected_by_the_gate(self):
        progress = LearnerProgress(
            student_id="stu_invariant",
            grade_level=8,
            taught_kcs=frozenset({"algebra.square_formula"}),
            progress_confidence=0.95,
            load_budget=1.0,
        )
        future_item = CurriculumItem(
            item_id="q_future",
            required_kcs=("calculus.derivative",),
            grade_level=10,
            safety_checked=True,
            content_verified=True,
            annotation_confidence=0.95,
            cognitive_load=0.1,
        )
        decision = allow(future_item, progress, MODE_LEARN)
        self.assertFalse(decision.allowed)
        self.assertIn("kcs_not_allowed:calculus.derivative", decision.reasons)
        self.assertIn("grade_not_appropriate", decision.reasons)

    def test_hinted_success_is_not_independent_retrieval_success(self):
        state = MemoryState("stu_invariant", "kc.square_formula")
        hinted = update_memory(
            state,
            MemoryObservation(
                "obs_hinted",
                success=True,
                independent=False,
                hint_level=2,
            ),
        )
        independent = update_memory(
            state,
            MemoryObservation(
                "obs_independent",
                success=True,
                independent=True,
                hint_level=0,
            ),
        )
        self.assertEqual(hinted.independent_success_count, 0)
        self.assertEqual(independent.independent_success_count, 1)
        self.assertLess(
            hinted.stability_days, independent.stability_days
        )

    def test_hypothesis_weights_are_normalized_after_update(self):
        hypotheses = HypothesisSet(
            [Hypothesis("h_weak", weight=1.0), Hypothesis("h_strong", weight=1.0)]
        )
        weights = hypotheses.reweight(
            {"h_weak": 0.2, "h_strong": 0.9},
            evidence_id="ev_1",
            noise=0.05,
        )
        self.assertAlmostEqual(sum(weights.values()), 1.0)
        self.assertAlmostEqual(hypotheses.total_weight(), 1.0)
        self.assertGreater(weights["h_strong"], weights["h_weak"])
        self.assertGreater(weights["unknown"], 0.0)


if __name__ == "__main__":
    unittest.main()
