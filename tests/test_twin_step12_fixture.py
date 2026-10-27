"""Step 12 cross-language parity fixture.

The same synthetic scenario is executed by
``dsh-plugin/tests/twin-step12.test.ts``; both implementations must produce the
same checkpoint projection (timestamps excluded because each runtime carries
its own ISO spelling).
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aeh.hypothesis import Hypothesis, HypothesisSet
from aeh.memory import MemoryObservation
from aeh.twin import Event, HypothesisOperation, StudentTwin

FIXTURE = Path(__file__).with_name("fixtures") / "twin_step12.json"

COMPARED_KEYS = (
    "version",
    "evidenceRevision",
    "knowledge",
    "memory",
    "observedEvidenceIds",
    "hypothesisRevision",
    "hypothesisWeights",
    "hypothesisBoundVersion",
    "activeParameterVersion",
)


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class TwinStep12FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def _event(self, spec):
        return Event(
            event_id=spec["eventId"],
            event_type=spec["eventType"],
            source=spec["source"],
            student_id=self.fixture["studentRef"],
            occurred_at=parse_timestamp(spec["occurredAt"]),
        )

    def _observation(self, spec):
        return MemoryObservation(
            observation_id=spec["observationId"],
            success=spec["success"],
            independent=spec.get("independent", True),
            hint_level=spec.get("hintLevel", 0),
            kind=spec.get("kind", "attempt"),
            occurred_at=parse_timestamp(spec["occurredAt"]),
        )

    def test_checkpoint_projection_matches_the_shared_fixture(self):
        fixture = self.fixture
        clock = parse_timestamp(fixture["clock"])
        twin = StudentTwin(fixture["studentRef"], clock=lambda: clock)
        for spec in fixture["events"]:
            twin.record_observed(self._event(spec))
        for spec in fixture["mastery"]:
            twin.update_mastery(
                spec["kcId"],
                spec["masteryMean"],
                spec["uncertainty"],
                spec["evidenceIds"],
            )
        for spec in fixture["memoryReviews"]:
            twin.record_memory_review(
                spec["kcId"], self._observation(spec), spec["evidenceIds"]
            )
        twin.apply_memory_forgetting(parse_timestamp(fixture["decayAt"]))

        calibration = fixture["calibration"]
        twin.propose_memory_calibration(
            calibration["parameters"],
            candidate_id=calibration["candidateId"],
        )
        twin.activate_memory_calibration(
            approval_id=calibration["approvalId"],
            approved_by=calibration["approvedBy"],
        )
        review = fixture["postCalibrationReview"]
        twin.record_memory_review(
            review["kcId"], self._observation(review), review["evidenceIds"]
        )
        twin.bind_hypotheses(
            HypothesisSet(
                [
                    Hypothesis(item["hypothesisId"], weight=item["weight"])
                    for item in fixture["hypotheses"]
                ]
            ),
            evidence_ids=fixture["bindEvidenceIds"],
        )
        twin.evolve_hypotheses(
            HypothesisOperation(
                kind="reweight",
                likelihoods=fixture["reweight"]["likelihoods"],
                evidence_ids=tuple(fixture["reweight"]["evidenceIds"]),
            )
        )
        checkpoint = twin.create_checkpoint(fixture["checkpointLabel"])
        projected = checkpoint.as_dict()

        expected = fixture["expected"]
        for key in COMPARED_KEYS:
            self.assertEqual(projected[key], expected[key], msg=f"key {key}")

    def test_replay_reproduces_the_checkpoint_projection(self):
        fixture = self.fixture
        clock = parse_timestamp(fixture["clock"])
        twin = StudentTwin(fixture["studentRef"], clock=lambda: clock)
        twin.record_observed(self._event(fixture["events"][0]))
        twin.update_mastery("kc.a", 0.4, 0.2, ["ev_1"])
        before = twin.create_checkpoint().as_dict()
        replayed = twin.replay()
        self.assertEqual(replayed.knowledge["kc.a"].mastery_mean, 0.4)
        after = twin.create_checkpoint().as_dict()
        self.assertEqual(after["knowledge"], before["knowledge"])
        self.assertEqual(after["version"], before["version"])


if __name__ == "__main__":
    unittest.main()
