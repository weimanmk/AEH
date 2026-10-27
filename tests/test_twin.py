"""Tests for the event-sourced student twin (spec section 5 / 22.2)."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from aeh.twin import (
    Event,
    KnowledgeEstimate,
    MissingEvidenceError,
    SimulatedEventRejected,
    StaleSimulationError,
    StudentTwin,
    TwinError,
    UnknownEventSource,
    VersionNotFoundError,
)


def at(day: int) -> datetime:
    return datetime(2026, 1, day, 12, 0, tzinfo=timezone.utc)


def real_event(event_id: str, day: int = 1, **overrides) -> Event:
    values = {
        "event_id": event_id,
        "event_type": "attempt",
        "source": "student",
        "occurred_at": at(day),
        "student_id": "stu_1",
        "payload": {"correct": True},
    }
    values.update(overrides)
    return Event(**values)


def simulated_event(event_id: str = "sim_1", **overrides) -> Event:
    values = {
        "event_id": event_id,
        "event_type": "simulated_attempt",
        "source": "simulated",
        "occurred_at": at(1),
        "student_id": "stu_1",
        "payload": {"mastery_mean": 1.0},
    }
    values.update(overrides)
    return Event(**values)


class SharedIsolationTests(unittest.TestCase):
    def test_simulated_event_cannot_write_observed_evidence(self):
        twin = StudentTwin("stu_1")
        with self.assertRaises(SimulatedEventRejected):
            twin.record_observed(simulated_event())
        self.assertEqual(twin.observed_events(), ())
        self.assertEqual(twin.observed_evidence_ids, frozenset())
        self.assertEqual(twin.version, 0)

    def test_simulated_event_cannot_be_promoted(self):
        twin = StudentTwin("stu_1")
        twin.record_simulated(simulated_event())
        with self.assertRaises(SimulatedEventRejected):
            twin.promote_simulated("sim_1")
        self.assertEqual(twin.observed_events(), ())
        self.assertEqual(len(twin.simulated_events()), 1)

    def test_simulated_evidence_cannot_back_a_mastery_update(self):
        twin = StudentTwin("stu_1")
        twin.record_simulated(simulated_event())
        with self.assertRaises(MissingEvidenceError):
            twin.update_mastery("kc", 0.99, 0.01, ["sim_1"])
        self.assertEqual(twin.version, 0)
        self.assertIsNone(twin.knowledge_for("kc"))

    def test_simulation_does_not_change_existing_real_mastery(self):
        twin = StudentTwin("stu_1")
        twin.record_observed(real_event("ev_1"))
        twin.update_mastery("kc", 0.55, 0.2, ["ev_1"])
        before = twin.knowledge_for("kc")

        twin.record_simulated(simulated_event("sim_high"))
        with self.assertRaises(MissingEvidenceError):
            twin.update_mastery("kc", 1.0, 0.0, ["sim_high"])

        after = twin.knowledge_for("kc")
        self.assertEqual(before, after)
        self.assertEqual(after.mastery_mean, 0.55)
        self.assertEqual(twin.observed_evidence_ids, frozenset({"ev_1"}))

    def test_stale_simulation_cannot_override_newer_state(self):
        twin = StudentTwin("stu_1")
        twin.record_observed(real_event("ev_1"))
        with self.assertRaises(StaleSimulationError):
            twin.assert_fresh_simulation(0)
        twin.assert_fresh_simulation(1)  # current revision is acceptable

    def test_unknown_source_is_rejected(self):
        twin = StudentTwin("stu_1")
        with self.assertRaises(UnknownEventSource):
            twin.record_observed(
                real_event("ev_x", source="untrusted_model")
            )

    def test_simulated_sources_use_the_isolated_store(self):
        twin = StudentTwin("stu_1")
        for index, source in enumerate(("simulated", "virtual_student", "simulation")):
            event = simulated_event(f"sim_{index}", source=source)
            twin.record_simulated(event)
        self.assertEqual(len(twin.simulated_events()), 3)
        self.assertEqual(twin.observed_events(), ())
        self.assertEqual(twin.evidence_revision, 0)


class EvidenceLogTests(unittest.TestCase):
    def test_real_events_are_append_only(self):
        twin = StudentTwin("stu_1")
        twin.record_observed(real_event("ev_1", 1))
        twin.record_observed(real_event("ev_2", 2))
        self.assertEqual(
            [event.event_id for event in twin.observed_events()],
            ["ev_1", "ev_2"],
        )
        self.assertEqual(twin.evidence_revision, 2)

    def test_correction_is_a_new_event_not_an_edit(self):
        twin = StudentTwin("stu_1")
        original = twin.record_observed(real_event("ev_1", 1))
        correction = real_event(
            "ev_1_correction",
            2,
            event_type="correction",
            payload={"corrects": "ev_1"},
        )
        twin.record_real_correction(correction)
        self.assertEqual(twin.observed_events()[0], original)
        self.assertEqual(
            [event.event_id for event in twin.observed_events()],
            ["ev_1", "ev_1_correction"],
        )

    def test_duplicate_event_id_is_rejected(self):
        twin = StudentTwin("stu_1")
        twin.record_observed(real_event("ev_1"))
        with self.assertRaises(TwinError):
            twin.record_observed(real_event("ev_1", 2))

    def test_wrong_student_event_is_rejected(self):
        twin = StudentTwin("stu_1")
        with self.assertRaises(TwinError):
            twin.record_observed(real_event("ev_1", student_id="stu_2"))

    def test_event_payload_and_versions_are_immutable(self):
        event = real_event("ev_1", model_versions={"memory": "v1"})
        with self.assertRaises(TypeError):
            event.payload["correct"] = False
        with self.assertRaises(TypeError):
            event.model_versions["memory"] = "v2"


class MasteryUpdateTests(unittest.TestCase):
    def setUp(self):
        self.twin = StudentTwin("stu_1")
        self.twin.record_observed(real_event("ev_1", 1))
        self.twin.record_observed(real_event("ev_2", 2))

    def test_mastery_update_requires_evidence(self):
        with self.assertRaises(MissingEvidenceError):
            self.twin.update_mastery("kc", 0.5, 0.2, [])
        with self.assertRaises(MissingEvidenceError):
            self.twin.update_mastery("kc", 0.5, 0.2, ["not_observed"])

    def test_mastery_update_creates_versioned_estimate(self):
        estimate = self.twin.update_mastery("kc", 0.6, 0.2, ["ev_1"])
        self.assertEqual(estimate.evidence_ids, ("ev_1",))
        self.assertEqual(self.twin.version, 1)
        self.assertEqual(self.twin.state.version, 1)

    def test_rebuild_is_deterministic_from_logs(self):
        self.twin.update_mastery("kc_a", 0.6, 0.2, ["ev_1"])
        self.twin.update_mastery("kc_b", 0.3, 0.4, ["ev_2"])
        expected = {
            "kc_a": self.twin.knowledge_for("kc_a"),
            "kc_b": self.twin.knowledge_for("kc_b"),
        }
        rebuilt = self.twin.rebuild()
        self.assertEqual(dict(rebuilt.knowledge), expected)
        self.assertEqual(self.twin.observed_evidence_ids, {"ev_1", "ev_2"})

    def test_rollback_restores_inferred_state_but_not_evidence(self):
        self.twin.update_mastery("kc", 0.4, 0.5, ["ev_1"])
        self.twin.update_mastery("kc", 0.8, 0.1, ["ev_2"])
        state = self.twin.rollback(1)
        self.assertEqual(state.knowledge["kc"].mastery_mean, 0.4)
        self.assertEqual(self.twin.version, 1)
        self.assertEqual(self.twin.observed_evidence_ids, {"ev_1", "ev_2"})

    def test_update_after_rollback_starts_a_new_branch(self):
        self.twin.update_mastery("kc", 0.4, 0.5, ["ev_1"])
        self.twin.update_mastery("kc", 0.8, 0.1, ["ev_2"])
        self.twin.rollback(1)
        self.twin.update_mastery("kc", 0.9, 0.05, ["ev_2"])
        self.assertEqual(self.twin.version, 2)
        restored = self.twin.rollback(2)
        self.assertEqual(restored.knowledge["kc"].mastery_mean, 0.9)
        self.assertEqual(self.twin.observed_evidence_ids, {"ev_1", "ev_2"})

    def test_rollback_to_unknown_version_fails(self):
        with self.assertRaises(VersionNotFoundError):
            self.twin.rollback(-1)
        with self.assertRaises(VersionNotFoundError):
            self.twin.rollback(99)

    def test_mastery_mean_bounds_are_enforced(self):
        with self.assertRaises(ValueError):
            self.twin.update_mastery("kc", 1.5, 0.1, ["ev_1"])
        self.assertEqual(self.twin.version, 0)

    def test_knowledge_estimate_rejects_invalid_values(self):
        with self.assertRaises(ValueError):
            KnowledgeEstimate("kc", -0.1, 0.1)
        with self.assertRaises(ValueError):
            KnowledgeEstimate("kc", 0.5, -0.1)


if __name__ == "__main__":
    unittest.main()
