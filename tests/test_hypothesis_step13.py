"""Step 13 tests for the complete virtual-student ensemble (spec section 6).

Covers the full spawn/match/split/merge/prune rules, hypothesis-fidelity
metrics (spec 19.3), the explicit ``unknown`` bucket, and snapshot session
isolation / persistence boundary. All data is synthetic.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aeh.hypothesis import (
    SNAPSHOT_SCHEMA_VERSION,
    SPAWN_UNEXPLAINED_STEP,
    SPLIT,
    UNKNOWN_CONTRADICTED,
    UNKNOWN_LOW_EXPLANATORY_POWER,
    UNKNOWN_MISSING_EVIDENCE,
    UNKNOWN_NO_CANDIDATE,
    BehaviorObservation,
    FidelityMetrics,
    Hypothesis,
    HypothesisError,
    HypothesisPersistenceError,
    HypothesisSet,
    HypothesisSnapshotStore,
    SnapshotScopeError,
    hypothesis_similarity,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "hypothesis_step13.json"


def hyp(hypothesis_id: str, weight: float = 1.0, **overrides) -> Hypothesis:
    return Hypothesis(hypothesis_id, weight=weight, **overrides)


def from_record(record: dict) -> Hypothesis:
    return Hypothesis(
        hypothesis_id=record["hypothesisId"],
        weight=record.get("weight", 1.0),
        predicted_observable_behaviors=record.get("predictedObservableBehaviors", {}),
        bug_rules=tuple(record.get("bugRules", [])),
        strategy_policy=tuple(record.get("strategyPolicy", [])),
        knowledge_assumptions=record.get("knowledgeAssumptions", {}),
        evidence_refs=tuple(record.get("evidenceRefs", [])),
    )


class RuleTests(unittest.TestCase):
    def test_spawn_records_the_generation_trigger(self):
        hypotheses = HypothesisSet([hyp("base")])
        hypotheses.spawn(hyp("new"), trigger=SPAWN_UNEXPLAINED_STEP)
        self.assertEqual(hypotheses.history[-1].kind, "spawn")
        self.assertEqual(hypotheses.history[-1].detail, SPAWN_UNEXPLAINED_STEP)

    def test_generate_only_spawns_candidates_that_explain_unexplained_behaviour(self):
        hypotheses = HypothesisSet(
            [hyp("slip", predicted_observable_behaviors={"step_b1": 0.5})]
        )
        spawned = hypotheses.generate(
            {"step_b1": 1.0},
            [
                # Does not beat the current best explanation enough.
                hyp("weak", predicted_observable_behaviors={"step_b1": 0.52}),
                # Explains the currently unexplained step.
                hyp("strong", predicted_observable_behaviors={"step_b1": 0.9}),
            ],
            behavior_threshold=0.6,
            min_gain=0.05,
        )
        self.assertEqual([h.hypothesis_id for h in spawned], ["strong"])
        self.assertAlmostEqual(hypotheses.weights()["strong"], 0.5)

    def test_generate_does_nothing_when_every_behaviour_is_explained(self):
        hypotheses = HypothesisSet(
            [hyp("a", predicted_observable_behaviors={"step_b1": 0.9})]
        )
        self.assertEqual(
            hypotheses.generate(
                {"step_b1": 1.0},
                [hyp("b", predicted_observable_behaviors={"step_b1": 0.95})],
            ),
            (),
        )

    def test_match_builds_likelihoods_and_posterior_without_spurious_certainty(self):
        hypotheses = HypothesisSet(
            [
                hyp("expand", predicted_observable_behaviors={"b": 0.85}),
                hyp("compress", predicted_observable_behaviors={"b": 0.15}),
            ]
        )
        match = hypotheses.match({"b": 1.0}, noise=0.0, unknown_prior=0.0)
        self.assertAlmostEqual(match.likelihoods["expand"], 0.02 + 0.96 * 0.85)
        self.assertAlmostEqual(match.likelihoods["compress"], 0.02 + 0.96 * 0.15)
        self.assertAlmostEqual(sum(match.weights.values()), 1.0)
        self.assertEqual(match.unexplained_behaviors, ())

    def test_match_reports_unexplained_behaviour(self):
        hypotheses = HypothesisSet([hyp("a", predicted_observable_behaviors={"b": 0.8})])
        match = hypotheses.match({"b": 1.0, "unmodelled": 1.0})
        self.assertEqual(match.unexplained_behaviors, ("unmodelled",))

    def test_match_rejects_out_of_range_observations(self):
        hypotheses = HypothesisSet([hyp("a")])
        with self.assertRaises(ValueError):
            hypotheses.match({"b": 2.0})

    def test_similarity_is_one_for_identical_behaviour_and_rules(self):
        first = hyp(
            "a",
            predicted_observable_behaviors={"b": 0.8},
            bug_rules=("r",),
        )
        second = hyp(
            "b",
            predicted_observable_behaviors={"b": 0.8},
            bug_rules=("r",),
        )
        self.assertAlmostEqual(hypothesis_similarity(first, second), 1.0)

    def test_split_distinguishable_accepts_separable_children(self):
        hypotheses = HypothesisSet([hyp("parent")])
        children = hypotheses.split_distinguishable(
            "parent",
            [
                hyp("c1", predicted_observable_behaviors={"b": 0.9}),
                hyp("c2", predicted_observable_behaviors={"b": 0.1}),
            ],
        )
        self.assertEqual([c.hypothesis_id for c in children], ["c1", "c2"])
        self.assertEqual(hypotheses.get("parent").status, SPLIT)

    def test_split_distinguishable_rejects_inseparable_children(self):
        hypotheses = HypothesisSet([hyp("parent")])
        with self.assertRaises(HypothesisError):
            hypotheses.split_distinguishable(
                "parent",
                [
                    hyp("c1", predicted_observable_behaviors={"b": 0.9}),
                    hyp("c2", predicted_observable_behaviors={"b": 0.9}),
                ],
            )
        self.assertEqual(hypotheses.get("parent").status, "active")

    def test_merge_indistinguishable_merges_and_keeps_source_history(self):
        hypotheses = HypothesisSet(
            [
                hyp("m1", predicted_observable_behaviors={"b": 0.8}, bug_rules=("r",)),
                hyp("m2", predicted_observable_behaviors={"b": 0.8}, bug_rules=("r",)),
                hyp("m3", predicted_observable_behaviors={"b": 0.1}, bug_rules=("z",)),
            ]
        )
        merged_ids = hypotheses.merge_indistinguishable()
        self.assertEqual(merged_ids, ("m_m1_m2",))
        merged = hypotheses.get("m_m1_m2")
        self.assertEqual(merged.merged_from, ("m1", "m2"))
        self.assertAlmostEqual(hypotheses.weights()["m_m1_m2"], 2.0 / 3.0)

    def test_prune_contradicted_requires_enough_matches(self):
        hypotheses = HypothesisSet(
            [
                hyp("bad", predicted_observable_behaviors={"b": 0.05}),
                hyp("good", predicted_observable_behaviors={"b": 0.95}),
            ]
        )
        hypotheses.match({"b": 1.0}, noise=0.0, unknown_prior=0.0)
        # A single match is not enough to archive a candidate.
        self.assertEqual(hypotheses.prune_contradicted(min_matches=2), ())
        hypotheses.match({"b": 1.0}, noise=0.0, unknown_prior=0.0)
        self.assertEqual(hypotheses.prune_contradicted(min_matches=2), ("bad",))
        self.assertIn(UNKNOWN_CONTRADICTED, hypotheses.unknown_reasons)

    def test_prune_uninformative_only_drops_candidates_without_unique_power(self):
        hypotheses = HypothesisSet(
            [
                hyp("u1", predicted_observable_behaviors={"b": 0.8}),
                hyp("u2", weight=0.5, predicted_observable_behaviors={"b": 0.8}),
            ]
        )
        self.assertEqual(hypotheses.prune_uninformative(), ("u2",))
        self.assertIn(UNKNOWN_LOW_EXPLANATORY_POWER, hypotheses.unknown_reasons)
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)


class UnknownBucketTests(unittest.TestCase):
    def test_set_unknown_records_the_reason_and_keeps_normalisation(self):
        hypotheses = HypothesisSet([hyp("a")])
        hypotheses.set_unknown(1.0, UNKNOWN_NO_CANDIDATE)
        self.assertAlmostEqual(hypotheses.weights()["unknown"], 0.5)
        self.assertEqual(hypotheses.unknown_reasons, (UNKNOWN_NO_CANDIDATE,))

    def test_request_and_resolve_real_evidence(self):
        hypotheses = HypothesisSet([hyp("a")])
        self.assertFalse(hypotheses.needs_real_evidence)
        hypotheses.request_real_evidence(UNKNOWN_MISSING_EVIDENCE)
        self.assertTrue(hypotheses.needs_real_evidence)
        self.assertIn(UNKNOWN_MISSING_EVIDENCE, hypotheses.unknown_reasons)
        hypotheses.resolve_evidence_request()
        self.assertFalse(hypotheses.needs_real_evidence)

    def test_unknown_dominance_asks_for_evidence(self):
        hypotheses = HypothesisSet([hyp("a", 0.4), hyp("b", 0.4)])
        hypotheses.reweight(
            {"a": 0.01, "b": 0.01},
            unknown_prior=0.5,
            unknown_likelihood=0.99,
        )
        self.assertIsNone(hypotheses.dominant())
        self.assertTrue(hypotheses.needs_real_evidence)

    def test_set_unknown_rejects_invalid_values(self):
        hypotheses = HypothesisSet([hyp("a")])
        for bad in (-0.1, float("inf")):
            with self.assertRaises(ValueError):
                hypotheses.set_unknown(bad)


class FidelityTests(unittest.TestCase):
    def test_fidelity_reports_none_when_not_computable(self):
        hypotheses = HypothesisSet()
        metrics = hypotheses.fidelity([], min_observations=5)
        self.assertIsInstance(metrics, FidelityMetrics)
        self.assertIsNone(metrics.brier_score)
        self.assertFalse(metrics.sufficient)

    def test_fidelity_metrics_on_a_synthetic_sequence(self):
        hypotheses = HypothesisSet(
            [
                hyp(
                    "expand",
                    predicted_observable_behaviors={"step_b1": 0.85},
                    bug_rules=("no_compensation", "step_b1"),
                ),
                hyp(
                    "compress",
                    predicted_observable_behaviors={"step_b1": 0.15},
                    bug_rules=("no_compensation", "step_b1"),
                ),
                hyp(
                    "slip",
                    weight=0.5,
                    predicted_observable_behaviors={"step_b1": 0.5},
                ),
            ]
        )
        observations = [
            BehaviorObservation("o1", "step_b1", True),
            BehaviorObservation("o2", "step_b1", True),
            BehaviorObservation(
                "o3",
                "step_b1",
                False,
                error_type="no_compensation",
                step="step_b1",
            ),
            BehaviorObservation("o4", "step_b1", True),
        ]
        metrics = hypotheses.fidelity(observations, min_observations=4)
        self.assertEqual(metrics.observation_count, 4)
        self.assertEqual(metrics.coverage, 1.0)
        self.assertAlmostEqual(metrics.brier_score, 0.25)
        self.assertAlmostEqual(metrics.accuracy, 0.75)
        self.assertEqual(metrics.error_type_agreement, 1.0)
        self.assertEqual(metrics.step_agreement, 1.0)
        self.assertTrue(metrics.sufficient)

    def test_anti_mismatch_tracks_recent_evidence(self):
        hypotheses = HypothesisSet(
            [
                hyp("old", predicted_observable_behaviors={"b": 0.5}),
                hyp(
                    "updated",
                    predicted_observable_behaviors={"b": 0.5},
                    evidence_refs=("ev_new",),
                ),
            ]
        )
        metrics = hypotheses.fidelity(
            [BehaviorObservation("o1", "b", True)],
            min_observations=0,
            recent_evidence_id="ev_new",
        )
        self.assertAlmostEqual(metrics.anti_mismatch, 0.5)


class SnapshotBoundaryTests(unittest.TestCase):
    def test_state_round_trip_preserves_hypotheses_and_unknown(self):
        original = HypothesisSet([hyp("a", 0.7), hyp("b", 0.3)], unknown_weight=0.2)
        original.bind_twin_version(4)
        restored = HypothesisSet.from_state(original.to_state())
        self.assertEqual(restored.weights(), original.weights())
        self.assertEqual(restored.revision, 0)
        self.assertIsNone(restored.bound_twin_version)

    def test_snapshot_round_trip_preserves_boundary_and_reasons(self):
        original = HypothesisSet([hyp("a")])
        original.request_real_evidence(UNKNOWN_MISSING_EVIDENCE)
        original.bind_twin_version(9)
        snapshot = original.to_snapshot(
            "session-a",
            snapshot_id="snap-1",
            now=datetime(2024, 1, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(snapshot.schema_version, SNAPSHOT_SCHEMA_VERSION)
        self.assertFalse(snapshot.persists_to_long_term_twin)
        restored = HypothesisSet.from_snapshot(snapshot)
        self.assertEqual(restored.bound_twin_version, 9)
        self.assertEqual(restored.unknown_reasons, (UNKNOWN_MISSING_EVIDENCE,))
        self.assertTrue(restored.needs_real_evidence)
        self.assertEqual(restored.weights(), original.weights())

    def test_cross_session_reads_and_deletes_fail(self):
        store = HypothesisSnapshotStore(ttl_seconds=60)
        snapshot = store.put(HypothesisSet([hyp("a")]), session_id="session-a")
        self.assertIsNone(store.get(snapshot.snapshot_id, session_id="session-b"))
        self.assertFalse(
            store.delete(snapshot.snapshot_id, session_id="session-b")
        )
        self.assertIsNotNone(store.get(snapshot.snapshot_id, session_id="session-a"))

    def test_agent_scope_is_part_of_the_isolation_key(self):
        store = HypothesisSnapshotStore(ttl_seconds=60)
        snapshot = store.put(
            HypothesisSet([hyp("a")]), session_id="session-a", agent_id="agent-1"
        )
        self.assertIsNone(
            store.get(snapshot.snapshot_id, session_id="session-a", agent_id="agent-2")
        )
        self.assertIsNotNone(
            store.get(snapshot.snapshot_id, session_id="session-a", agent_id="agent-1")
        )

    def test_expired_and_ended_snapshots_are_unreadable(self):
        clock = {"now": datetime(2024, 1, 1, tzinfo=timezone.utc)}
        store = HypothesisSnapshotStore(
            ttl_seconds=30, now=lambda: clock["now"]
        )
        snapshot = store.put(HypothesisSet([hyp("a")]), session_id="session-a")
        clock["now"] += timedelta(seconds=31)
        self.assertIsNone(store.get(snapshot.snapshot_id, session_id="session-a"))

        other = store.put(HypothesisSet([hyp("a")]), session_id="session-b")
        self.assertEqual(store.end_session("session-b"), 1)
        self.assertIsNone(store.get(other.snapshot_id, session_id="session-b"))

    def test_store_counts_never_expose_long_term_writes(self):
        store = HypothesisSnapshotStore(ttl_seconds=60)
        store.put(HypothesisSet([hyp("a")]), session_id="session-a")
        view = store.snapshot()
        self.assertTrue(view["sessionScoped"])
        self.assertFalse(view["longTermTwinWrite"])

    def test_persisting_a_hypothesis_set_to_the_twin_fails_closed(self):
        hypotheses = HypothesisSet([hyp("a")])
        with self.assertRaises(HypothesisPersistenceError):
            hypotheses.persist_to_twin()

    def test_invalid_scope_is_rejected(self):
        store = HypothesisSnapshotStore(ttl_seconds=60)
        with self.assertRaises(SnapshotScopeError):
            store.put(HypothesisSet([hyp("a")]), session_id="")
        with self.assertRaises(ValueError):
            HypothesisSnapshotStore(ttl_seconds=0)


class SharedFixtureTests(unittest.TestCase):
    """Python/TypeScript parity on the same synthetic Step 13 scenario."""

    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text())
        cls.expected = cls.fixture["expected"]

    def _hypotheses(self, records):
        return HypothesisSet([from_record(record) for record in records])

    def test_similarity_and_matching(self):
        hypotheses = self._hypotheses(self.fixture["hypotheses"])
        self.assertAlmostEqual(
            sum(hypotheses.weights().values()), 1.0, places=12
        )
        for hypothesis_id, weight in self.expected["initialWeights"].items():
            self.assertAlmostEqual(
                hypotheses.weights()[hypothesis_id], weight, places=12
            )
        self.assertAlmostEqual(
            hypothesis_similarity(
                hypotheses.get("h.expand"), hypotheses.get("h.compress")
            ),
            self.expected["similarityExpandCompress"],
            places=12,
        )
        self.assertAlmostEqual(
            hypothesis_similarity(
                hypotheses.get("h.expand"), hypotheses.get("h.slip")
            ),
            self.expected["similarityExpandSlip"],
            places=12,
        )
        match = hypotheses.match({"step_b1": 1.0}, noise=0.0, unknown_prior=0.0)
        for hypothesis_id, likelihood in self.expected["matchLikelihoods"].items():
            self.assertAlmostEqual(
                match.likelihoods[hypothesis_id], likelihood, places=12
            )
        for hypothesis_id, weight in self.expected["matchWeights"].items():
            self.assertAlmostEqual(
                match.weights[hypothesis_id], weight, places=12
            )
        self.assertEqual(
            list(match.unexplained_behaviors), self.expected["matchUnexplained"]
        )

    def test_generate_split_merge_prune(self):
        generator = HypothesisSet([from_record(self.fixture["generateInitial"])])
        spawned = generator.generate(
            {"step_b1": 1.0},
            [from_record(self.fixture["generateCandidate"])],
            behavior_threshold=0.6,
            min_gain=0.05,
        )
        self.assertEqual(
            [h.hypothesis_id for h in spawned], self.expected["generateSpawned"]
        )
        for hypothesis_id, weight in self.expected["generateWeights"].items():
            self.assertAlmostEqual(
                generator.weights()[hypothesis_id], weight, places=12
            )

        splitter = HypothesisSet([hyp("p", predicted_observable_behaviors={"b": 0.5})])
        children = splitter.split_distinguishable(
            "p", [from_record(record) for record in self.fixture["splitHypotheses"]]
        )
        for child in children:
            self.assertAlmostEqual(
                child.weight, self.expected["splitWeights"][child.hypothesis_id],
                places=12,
            )

        merger = self._hypotheses(self.fixture["mergeHypotheses"])
        self.assertEqual(
            list(merger.merge_indistinguishable()), self.expected["mergeIds"]
        )
        for hypothesis_id, weight in self.expected["mergeWeights"].items():
            self.assertAlmostEqual(
                merger.weights()[hypothesis_id], weight, places=12
            )

        pruner = self._hypotheses(self.fixture["pruneHypotheses"])
        pruner.match({"b": 1.0}, noise=0.0, unknown_prior=0.0)
        pruner.match({"b": 1.0}, noise=0.0, unknown_prior=0.0)
        self.assertEqual(
            list(pruner.prune_contradicted()), self.expected["pruneContradicted"]
        )
        for hypothesis_id, weight in self.expected["pruneContradictedWeights"].items():
            self.assertAlmostEqual(
                pruner.weights()[hypothesis_id], weight, places=12
            )

        uninformative = self._hypotheses(self.fixture["uninformativeHypotheses"])
        self.assertEqual(
            list(uninformative.prune_uninformative()),
            self.expected["pruneUninformative"],
        )
        for hypothesis_id, weight in self.expected[
            "pruneUninformativeWeights"
        ].items():
            self.assertAlmostEqual(
                uninformative.weights()[hypothesis_id], weight, places=12
            )

    def test_fidelity_and_snapshot(self):
        hypotheses = self._hypotheses(self.fixture["hypotheses"])
        observations = [
            BehaviorObservation(
                record["observationId"],
                record["behavior"],
                record["outcome"],
                record.get("errorType"),
                record.get("step"),
                record.get("strategy"),
            )
            for record in self.fixture["observations"]
        ]
        metrics = hypotheses.fidelity(
            observations, min_observations=len(observations)
        )
        expected_fidelity = self.expected["fidelity"]
        for attribute in (
            "coverage",
            "brierScore",
            "logLoss",
            "calibrationError",
            "accuracy",
            "unknownShare",
            "effectiveHypotheses",
            "maxWeight",
            "errorTypeAgreement",
            "stepAgreement",
            "strategyAgreement",
        ):
            field = {
                "brierScore": "brier_score",
                "logLoss": "log_loss",
                "calibrationError": "calibration_error",
                "effectiveHypotheses": "effective_hypotheses",
                "maxWeight": "max_weight",
                "errorTypeAgreement": "error_type_agreement",
                "stepAgreement": "step_agreement",
                "strategyAgreement": "strategy_agreement",
                "unknownShare": "unknown_share",
                "coverage": "coverage",
                "accuracy": "accuracy",
            }[attribute]
            self.assertAlmostEqual(
                getattr(metrics, field), expected_fidelity[attribute], places=9
            )
        self.assertEqual(
            metrics.observation_count, expected_fidelity["observationCount"]
        )
        self.assertEqual(metrics.sufficient, expected_fidelity["sufficient"])

        now = datetime.fromisoformat(self.fixture["snapshotNow"])
        store = HypothesisSnapshotStore(
            ttl_seconds=self.fixture["snapshotTtlSeconds"], now=lambda: now
        )
        snapshot_set = self._hypotheses(self.fixture["hypotheses"])
        snapshot_set.request_real_evidence(UNKNOWN_MISSING_EVIDENCE)
        snapshot = store.put(
            snapshot_set, session_id="session-a", snapshot_id="hyp_fixture"
        )
        expected_snapshot = self.expected["snapshot"]
        self.assertEqual(snapshot.snapshot_id, expected_snapshot["snapshotId"])
        self.assertEqual(snapshot.schema_version, expected_snapshot["schemaVersion"])
        self.assertEqual(
            snapshot.persists_to_long_term_twin,
            expected_snapshot["persistsToLongTermTwin"],
        )
        self.assertEqual(
            list(snapshot.unknown_reasons), expected_snapshot["unknownReasons"]
        )
        restored = HypothesisSet.from_snapshot(snapshot)
        for hypothesis_id, weight in expected_snapshot["weights"].items():
            self.assertAlmostEqual(
                restored.weights()[hypothesis_id], weight, places=12
            )


if __name__ == "__main__":
    unittest.main()
