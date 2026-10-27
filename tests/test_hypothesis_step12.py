"""Step 12 tests for hypothesis-set evolution and twin-version binding."""

from __future__ import annotations

import unittest

from aeh.hypothesis import (
    ACTIVE,
    Hypothesis,
    HypothesisSet,
)


def hyp(hypothesis_id: str, weight: float = 1.0, **overrides) -> Hypothesis:
    return Hypothesis(hypothesis_id, weight=weight, **overrides)


class RevisionAndBindingTests(unittest.TestCase):
    def test_revision_counts_transitions(self):
        hypotheses = HypothesisSet()
        self.assertEqual(hypotheses.revision, 0)
        hypotheses.spawn(hyp("a", 1.0))
        self.assertEqual(hypotheses.revision, 1)
        hypotheses.prune("a", "test")
        self.assertEqual(hypotheses.revision, 2)

    def test_bind_twin_version_records_a_transition(self):
        hypotheses = HypothesisSet([hyp("a", 1.0)])
        self.assertIsNone(hypotheses.bound_twin_version)
        hypotheses.bind_twin_version(7)
        self.assertEqual(hypotheses.bound_twin_version, 7)
        self.assertEqual(hypotheses.history[-1].kind, "bind")
        self.assertIn("7", hypotheses.history[-1].detail)

    def test_bind_twin_version_rejects_invalid_versions(self):
        hypotheses = HypothesisSet([hyp("a", 1.0)])
        for bad in (-1, 1.5, True):
            with self.assertRaises(ValueError):
                hypotheses.bind_twin_version(bad)

    def test_active_evidence_refs_is_the_union(self):
        hypotheses = HypothesisSet(
            [
                hyp("a", 1.0, evidence_refs=("ev_1", "ev_2")),
                hyp("b", 1.0, evidence_refs=("ev_2", "ev_3")),
            ]
        )
        self.assertEqual(
            hypotheses.active_evidence_refs(), frozenset({"ev_1", "ev_2", "ev_3"})
        )

    def test_clone_is_independent_and_preserves_binding(self):
        original = HypothesisSet([hyp("a", 1.0), hyp("b", 1.0)])
        original.bind_twin_version(3)
        clone = original.clone()
        self.assertEqual(clone.bound_twin_version, 3)
        self.assertEqual(clone.revision, original.revision)
        clone.prune("a", "clone-only")
        self.assertEqual(original.get("a").status, ACTIVE)
        self.assertAlmostEqual(original.weights()["a"], 0.5)
        self.assertEqual(clone.get("a").status, "pruned")
        self.assertAlmostEqual(clone.weights()["unknown"], 0.5)
        self.assertAlmostEqual(sum(clone.weights().values()), 1.0)


class PruneWeakTests(unittest.TestCase):
    def test_prune_weak_moves_mass_to_unknown_and_keeps_normalisation(self):
        hypotheses = HypothesisSet(
            [hyp("strong", 0.98), hyp("weak", 0.02)]
        )
        pruned = hypotheses.prune_weak(threshold=0.05)
        self.assertEqual(pruned, ("weak",))
        self.assertEqual(hypotheses.get("weak").status, "pruned")
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)
        self.assertAlmostEqual(hypotheses.weights()["unknown"], 0.02, places=9)

    def test_prune_weak_leaves_strong_candidates_alone(self):
        hypotheses = HypothesisSet([hyp("a", 0.6), hyp("b", 0.4)])
        self.assertEqual(hypotheses.prune_weak(0.01), ())

    def test_prune_weak_rejects_negative_threshold(self):
        hypotheses = HypothesisSet([hyp("a", 1.0)])
        with self.assertRaises(ValueError):
            hypotheses.prune_weak(-0.1)


if __name__ == "__main__":
    unittest.main()
