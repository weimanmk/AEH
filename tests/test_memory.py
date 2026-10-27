"""Tests for the FSRS-style memory model (spec sections 8.3, 8.4, 8.6)."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from aeh.memory import (
    FSRS_19_81,
    KIND_ATTEMPT,
    KIND_HINT_FOLLOWUP,
    KIND_READING,
    MemoryObservation,
    MemoryState,
    interval_for_target,
    is_independent_retrieval_success,
    memory_snapshot,
    retrieval_weight,
    retrievability,
    update_many,
    update_memory,
)


def observation(observation_id: str, **overrides) -> MemoryObservation:
    values = {
        "observation_id": observation_id,
        "success": True,
        "independent": True,
        "hint_level": 0,
        "kind": KIND_ATTEMPT,
        "occurred_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
    }
    values.update(overrides)
    return MemoryObservation(**values)


class RetrievabilityTests(unittest.TestCase):
    def test_retrievability_at_zero_is_one(self):
        self.assertAlmostEqual(retrievability(0.0, 5.0), 1.0)

    def test_retrievability_at_stability_is_about_ninety_percent(self):
        self.assertAlmostEqual(retrievability(8.0, 8.0), 0.9, places=12)

    def test_retrievability_decreases_with_elapsed_time(self):
        self.assertGreater(retrievability(1.0, 4.0), retrievability(10.0, 4.0))

    def test_retrievability_matches_the_spec_formula(self):
        expected = (1.0 + FSRS_19_81 * (7.0 / 5.5)) ** -0.5
        self.assertAlmostEqual(retrievability(7.0, 5.5), expected)

    def test_retrievability_rejects_invalid_inputs(self):
        with self.assertRaises(ValueError):
            retrievability(-1.0, 5.0)
        with self.assertRaises(ValueError):
            retrievability(1.0, 0.0)

    def test_interval_for_ninety_percent_equals_stability(self):
        self.assertAlmostEqual(interval_for_target(4.0, 0.9), 4.0, places=12)

    def test_interval_round_trips_through_retrievability(self):
        stability = 3.5
        target = 0.85
        interval = interval_for_target(stability, target)
        self.assertAlmostEqual(retrievability(interval, stability), target)

    def test_higher_target_retention_means_shorter_interval(self):
        self.assertLess(
            interval_for_target(5.0, 0.95), interval_for_target(5.0, 0.8)
        )

    def test_interval_rejects_invalid_targets(self):
        for target in (0.0, 1.0, -0.1, 1.5):
            with self.assertRaises(ValueError):
                interval_for_target(5.0, target)


class ObservationWeightTests(unittest.TestCase):
    def test_independent_unhinted_attempt_has_full_weight(self):
        self.assertEqual(retrieval_weight(observation("o1")), 1.0)

    def test_hinted_success_has_reduced_weight(self):
        self.assertLess(
            retrieval_weight(observation("o2", independent=False, hint_level=2)),
            retrieval_weight(observation("o1")),
        )

    def test_reading_explanation_has_zero_weight(self):
        reading = observation("o3", kind=KIND_READING)
        self.assertEqual(retrieval_weight(reading), 0.0)
        self.assertFalse(is_independent_retrieval_success(reading))

    def test_hinted_success_is_not_independent_retrieval(self):
        hinted = observation("o4", independent=False, hint_level=1)
        self.assertFalse(is_independent_retrieval_success(hinted))

    def test_hint_followup_kind_is_not_independent_retrieval(self):
        followup = observation(
            "o5", kind=KIND_HINT_FOLLOWUP, independent=False, hint_level=1
        )
        self.assertFalse(is_independent_retrieval_success(followup))
        self.assertLess(retrieval_weight(followup), 1.0)

    def test_hint_followup_kind_never_counts_as_independent(self):
        # Even if a caller leaves the optimistic default flags, the kind is
        # authoritative: a post-hint follow-up is not an independent attempt.
        followup = observation("o5b", kind=KIND_HINT_FOLLOWUP)
        self.assertLess(retrieval_weight(followup), 1.0)
        self.assertFalse(is_independent_retrieval_success(followup))

    def test_incorrect_independent_attempt_is_not_retrieval_success(self):
        wrong = observation("o6", success=False)
        self.assertFalse(is_independent_retrieval_success(wrong))


class MemoryUpdateTests(unittest.TestCase):
    def setUp(self):
        self.state = MemoryState("stu_1", "kc.square_formula")

    def test_independent_success_grows_stability_most(self):
        independent = update_memory(self.state, observation("o1"))
        hinted = update_memory(
            self.state,
            observation("o2", independent=False, hint_level=2),
        )
        self.assertGreater(independent.stability_days, hinted.stability_days)
        self.assertGreater(hinted.stability_days, self.state.stability_days)

    def test_hinted_success_does_not_count_as_independent(self):
        updated = update_memory(
            self.state,
            observation("o1", independent=False, hint_level=2, success=True),
        )
        self.assertEqual(updated.observation_count, 1)
        self.assertEqual(updated.independent_success_count, 0)
        self.assertIsNone(updated.last_independent_success_at)
        self.assertEqual(updated.uncertainty, "high")

    def test_independent_success_is_counted(self):
        stamp = datetime(2026, 2, 1, tzinfo=timezone.utc)
        updated = update_memory(
            self.state, observation("o1", occurred_at=stamp)
        )
        self.assertEqual(updated.independent_success_count, 1)
        self.assertEqual(updated.last_independent_success_at, stamp)
        self.assertEqual(updated.observation_count, 1)

    def test_reading_explanation_does_not_update_memory(self):
        reading = observation("o1", kind=KIND_READING, success=True)
        updated = update_memory(self.state, reading)
        self.assertIs(updated, self.state)
        self.assertEqual(updated.observation_count, 0)
        self.assertEqual(updated.stability_days, self.state.stability_days)

    def test_hint_assisted_correction_cannot_substitute_for_independent_success(self):
        hinted = update_memory(
            self.state,
            observation("o1", success=True, independent=False, hint_level=3),
        )
        independent = update_memory(self.state, observation("o2"))
        self.assertLess(
            hinted.stability_days - self.state.stability_days,
            independent.stability_days - self.state.stability_days,
        )
        self.assertEqual(hinted.independent_success_count, 0)
        self.assertEqual(independent.independent_success_count, 1)

    def test_failure_shrinks_stability(self):
        failed = update_memory(self.state, observation("o1", success=False))
        self.assertLess(failed.stability_days, self.state.stability_days)
        self.assertGreater(failed.difficulty, self.state.difficulty)

    def test_stability_has_a_floor(self):
        low = MemoryState("stu_1", "kc", stability_days=0.4)
        failed = update_memory(low, observation("o1", success=False))
        self.assertEqual(failed.stability_days, 0.4)

    def test_uncertainty_tracks_observation_count(self):
        state = update_memory(self.state, observation("o1"))
        state = update_memory(state, observation("o2"))
        self.assertEqual(state.uncertainty, "medium")
        for index in range(3, 6):
            state = update_memory(state, observation(f"o{index}"))
        self.assertEqual(state.uncertainty, "low")

    def test_update_many_applies_in_order(self):
        observations = [
            observation("o1"),
            observation("o2", independent=False, hint_level=1),
            observation("o3", success=False),
        ]
        updated = update_many(self.state, observations)
        self.assertEqual(updated.observation_count, 3)
        self.assertEqual(updated.independent_success_count, 1)

    def test_memory_state_validates_stability_and_difficulty(self):
        with self.assertRaises(ValueError):
            MemoryState("stu_1", "kc", stability_days=0.0)
        with self.assertRaises(ValueError):
            MemoryState("stu_1", "kc", difficulty=0.0)
        with self.assertRaises(ValueError):
            MemoryState("stu_1", "kc", difficulty=11.0)

    def test_observation_rejects_negative_hint_level(self):
        with self.assertRaises(ValueError):
            observation("o1", hint_level=-1)

    def test_next_review_interval_uses_state_stability(self):
        self.assertAlmostEqual(
            self.state.next_review_interval_days(0.9),
            self.state.stability_days,
            places=12,
        )

    def test_snapshot_is_json_friendly(self):
        snapshot = memory_snapshot(update_memory(self.state, observation("o1")))
        self.assertEqual(snapshot["learner_id"], "stu_1")
        self.assertEqual(snapshot["memory_unit_id"], "kc.square_formula")
        self.assertEqual(snapshot["observation_count"], 1)
        self.assertEqual(snapshot["independent_success_count"], 1)
        self.assertNotIn("last_independent_success_at", snapshot)


if __name__ == "__main__":
    unittest.main()
