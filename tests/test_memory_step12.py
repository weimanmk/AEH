"""Step 12 tests for the long-term memory integration (spec section 5/8)."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aeh.memory import (
    BASELINE_PARAMETER_VERSION,
    DIFFICULTY_FAILURE_DELTA,
    DIFFICULTY_SUCCESS_DELTA,
    FAILURE_SHRINK,
    INITIAL_DIFFICULTY,
    INITIAL_STABILITY_DAYS,
    MEMORY_PARAMETER_NAMES,
    SUCCESS_GROWTH,
    MemoryObservation,
    MemoryParameters,
    MemoryState,
    aggregate_memory,
    apply_forgetting,
    memory_health,
    retrievability,
    update_memory,
)


def at(day: int, hour: int = 12) -> datetime:
    """A timestamp ``day - 1`` days after 2026-01-01 12:00 UTC."""
    return datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc) + timedelta(
        days=day - 1, hours=hour - 12
    )


def observation(observation_id: str = "o1", **overrides) -> MemoryObservation:
    values = {
        "observation_id": observation_id,
        "success": True,
        "independent": True,
        "hint_level": 0,
        "kind": "attempt",
        "occurred_at": at(1),
    }
    values.update(overrides)
    return MemoryObservation(**values)


class MemoryParametersTests(unittest.TestCase):
    def test_baseline_matches_the_illustrative_constants(self):
        params = MemoryParameters.baseline()
        self.assertEqual(params.initial_stability_days, INITIAL_STABILITY_DAYS)
        self.assertEqual(params.success_growth, SUCCESS_GROWTH)
        self.assertEqual(params.failure_shrink, FAILURE_SHRINK)
        self.assertEqual(params.initial_difficulty, INITIAL_DIFFICULTY)
        self.assertEqual(params.difficulty_success_delta, DIFFICULTY_SUCCESS_DELTA)
        self.assertEqual(params.difficulty_failure_delta, DIFFICULTY_FAILURE_DELTA)
        self.assertEqual(params.parameter_version, BASELINE_PARAMETER_VERSION)

    def test_from_mapping_reads_all_six_parameters_and_version(self):
        mapping = {
            "initial_stability_days": 2.0,
            "success_growth": 0.8,
            "failure_shrink": 0.3,
            "initial_difficulty": 4.0,
            "difficulty_success_delta": 0.1,
            "difficulty_failure_delta": 0.6,
            "parameter_version": "fsrs_calibrated_synthetic_v1",
        }
        params = MemoryParameters.from_mapping(mapping)
        self.assertEqual(set(params.value_dict()), set(MEMORY_PARAMETER_NAMES))
        self.assertEqual(params.parameter_version, "fsrs_calibrated_synthetic_v1")

    def test_from_mapping_rejects_incomplete_or_bad_input(self):
        with self.assertRaises(ValueError):
            MemoryParameters.from_mapping({"initial_stability_days": 1.0})
        with self.assertRaises(ValueError):
            MemoryParameters(initial_stability_days=-1.0)
        with self.assertRaises(ValueError):
            MemoryParameters(difficulty_success_delta=float("nan"))
        with self.assertRaises(ValueError):
            MemoryParameters(initial_difficulty=0.5)

    def test_baseline_parameters_reproduce_the_legacy_update(self):
        state = MemoryState("stu_1", "kc")
        legacy = update_memory(state, observation())
        explicit = update_memory(state, observation(), parameters=MemoryParameters())
        self.assertEqual(legacy.stability_days, explicit.stability_days)
        self.assertEqual(legacy.difficulty, explicit.difficulty)
        self.assertEqual(legacy.observation_count, explicit.observation_count)

    def test_calibrated_parameters_change_dynamics_and_version(self):
        state = MemoryState("stu_1", "kc")
        calibrated = MemoryParameters(
            success_growth=0.9,
            difficulty_success_delta=0.05,
            parameter_version="fsrs_calibrated_synthetic_v1",
        )
        updated = update_memory(state, observation(), parameters=calibrated)
        self.assertGreater(updated.stability_days, 1.6)
        self.assertEqual(updated.model_version, "fsrs_calibrated_synthetic_v1")

    def test_effective_stability_uses_the_difficulty_factor(self):
        params = MemoryParameters()
        self.assertAlmostEqual(params.effective_stability(2.0, 5.0), 2.0)
        self.assertAlmostEqual(params.effective_stability(2.0, 10.0), 0.4)
        self.assertAlmostEqual(params.effective_stability(0.1, 5.0), 0.4)

    def test_predict_matches_the_plain_retrievability_for_reference_difficulty(self):
        params = MemoryParameters()
        self.assertAlmostEqual(params.predict(7.0, 5.0, 5.0), retrievability(7.0, 5.0))


class ForgettingTests(unittest.TestCase):
    def setUp(self):
        self.state = update_memory(
            MemoryState("stu_1", "kc"), observation(occurred_at=at(1))
        )

    def test_overdue_state_raises_uncertainty_without_lowering_stability(self):
        aged = apply_forgetting(self.state, at(40))
        self.assertIsNot(aged, self.state)
        self.assertTrue(aged.needs_calibration)
        self.assertGreaterEqual(aged.uncertainty, self.state.uncertainty)
        self.assertEqual(aged.stability_days, self.state.stability_days)
        self.assertEqual(aged.difficulty, self.state.difficulty)

    def test_recent_state_is_unchanged(self):
        aged = apply_forgetting(self.state, at(1, hour=13))
        self.assertIs(aged, self.state)
        self.assertFalse(aged.needs_calibration)

    def test_state_without_anchor_is_unchanged(self):
        never = MemoryState("stu_1", "kc.fresh")
        self.assertIs(apply_forgetting(never, at(40)), never)

    def test_review_clears_needs_calibration(self):
        aged = apply_forgetting(self.state, at(40))
        refreshed = update_memory(
            aged, observation("o2", occurred_at=at(40))
        )
        self.assertFalse(refreshed.needs_calibration)

    def test_memory_health_reports_retrievability_and_overdue(self):
        health = memory_health(self.state, at(40))
        self.assertTrue(health["overdue"])
        self.assertLess(health["expected_retrievability"], health["target_retention"])
        self.assertEqual(health["memory_unit_id"], "kc")
        self.assertEqual(health["observation_count"], 1)


class MultiKCAggregateTests(unittest.TestCase):
    def test_aggregate_summarises_units_and_weakest_kcs(self):
        strong = update_memory(
            MemoryState("stu_1", "kc.strong"),
            observation("o1", occurred_at=at(1)),
        )
        strong = update_memory(strong, observation("o2", occurred_at=at(2)))
        weak = MemoryState(
            "stu_1",
            "kc.weak",
            stability_days=0.5,
            difficulty=8.0,
            last_observed_at=at(1),
        )
        summary = aggregate_memory([strong, weak], at(60))
        self.assertEqual(summary["unit_count"], 2)
        self.assertEqual(len(summary["weakest_units"]), 2)
        self.assertEqual(summary["weakest_units"][0]["memory_unit_id"], "kc.weak")
        self.assertGreaterEqual(summary["overdue_count"], 1)

    def test_empty_aggregate_is_all_zero(self):
        summary = aggregate_memory([], at(1))
        self.assertEqual(summary["unit_count"], 0)
        self.assertEqual(summary["weakest_units"], [])

    def test_aggregate_does_not_mutate_input_states(self):
        state = update_memory(
            MemoryState("stu_1", "kc"), observation(occurred_at=at(1))
        )
        before = (state.stability_days, state.difficulty, state.uncertainty)
        aggregate_memory([state], at(60))
        self.assertEqual(
            (state.stability_days, state.difficulty, state.uncertainty), before
        )


if __name__ == "__main__":
    unittest.main()
