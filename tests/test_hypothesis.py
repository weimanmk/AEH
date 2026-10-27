"""Tests for short-term hypothesis sets (spec section 6)."""

from __future__ import annotations

import unittest

from aeh.hypothesis import (
    ACTIVE,
    MERGED,
    PRUNED,
    SPLIT,
    DuplicateHypothesisError,
    Hypothesis,
    HypothesisError,
    HypothesisSet,
    UnknownHypothesisError,
)


def hyp(hypothesis_id: str, weight: float = 1.0, **overrides) -> Hypothesis:
    return Hypothesis(hypothesis_id, weight=weight, **overrides)


class NormalizationTests(unittest.TestCase):
    def test_constructor_normalizes_weights_and_unknown(self):
        hypotheses = HypothesisSet([hyp("a", 2.0), hyp("b", 1.0)], unknown_weight=1.0)
        weights = hypotheses.weights()
        self.assertAlmostEqual(sum(weights.values()), 1.0)
        self.assertAlmostEqual(weights["a"], 0.5)
        self.assertAlmostEqual(weights["b"], 0.25)
        self.assertAlmostEqual(weights["unknown"], 0.25)

    def test_empty_set_puts_all_mass_in_unknown(self):
        hypotheses = HypothesisSet()
        self.assertEqual(hypotheses.weights(), {"unknown": 1.0})
        self.assertIsNone(hypotheses.dominant())

    def test_duplicate_hypothesis_id_is_rejected(self):
        with self.assertRaises(DuplicateHypothesisError):
            HypothesisSet([hyp("a"), hyp("a")])

    def test_spawn_normalizes_and_rejects_duplicates(self):
        hypotheses = HypothesisSet()
        spawned = hypotheses.spawn(hyp("a", 1.0))
        self.assertEqual(spawned.hypothesis_id, "a")
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)
        hypotheses.spawn(hyp("b", 1.0))
        weights = hypotheses.weights()
        self.assertAlmostEqual(weights["a"], 0.5)
        self.assertAlmostEqual(weights["b"], 0.5)
        with self.assertRaises(DuplicateHypothesisError):
            hypotheses.spawn(hyp("a", 1.0))

    def test_reweight_keeps_posterior_normalized(self):
        hypotheses = HypothesisSet([hyp("a", 1.0), hyp("b", 1.0)])
        weights = hypotheses.reweight(
            {"a": 0.9, "b": 0.1}, evidence_id="ev_1"
        )
        self.assertAlmostEqual(sum(weights.values()), 1.0)
        self.assertAlmostEqual(hypotheses.total_weight(), 1.0)
        self.assertGreater(weights["a"], weights["b"])
        self.assertGreater(weights["unknown"], 0.0)

    def test_reweight_records_evidence_references(self):
        hypotheses = HypothesisSet([hyp("a", 1.0), hyp("b", 1.0)])
        hypotheses.reweight({"a": 0.8, "b": 0.2}, evidence_id="ev_42")
        self.assertIn("ev_42", hypotheses.get("a").evidence_refs)
        self.assertIn("ev_42", hypotheses.get("b").evidence_refs)

    def test_noise_prevents_a_single_answer_from_producing_certainty(self):
        sharp = HypothesisSet([hyp("a", 1.0), hyp("b", 1.0)])
        sharp_weights = sharp.reweight(
            {"a": 1.0, "b": 0.0}, noise=0.0, unknown_prior=0.0
        )
        self.assertAlmostEqual(sharp_weights["a"], 1.0)

        noisy = HypothesisSet([hyp("a", 1.0), hyp("b", 1.0)])
        noisy_weights = noisy.reweight(
            {"a": 1.0, "b": 0.0}, noise=0.05, unknown_prior=0.0
        )
        self.assertLess(noisy_weights["a"], 1.0)
        self.assertGreater(noisy_weights["b"], 0.0)
        self.assertAlmostEqual(sum(noisy_weights.values()), 1.0)

    def test_reweight_rejects_invalid_noise(self):
        hypotheses = HypothesisSet([hyp("a"), hyp("b")])
        for noise in (-0.1, 1.1):
            with self.assertRaises(ValueError):
                hypotheses.reweight({"a": 0.5, "b": 0.5}, noise=noise)

    def test_unknown_can_dominate_instead_of_forcing_a_choice(self):
        hypotheses = HypothesisSet([hyp("a", 1.0), hyp("b", 1.0)])
        weights = hypotheses.reweight(
            {"a": 0.01, "b": 0.01},
            evidence_id="ev_strange",
            unknown_prior=0.5,
            unknown_likelihood=0.99,
        )
        self.assertGreater(weights["unknown"], weights["a"])
        self.assertGreater(weights["unknown"], weights["b"])
        self.assertIsNone(hypotheses.dominant())
        self.assertAlmostEqual(sum(weights.values()), 1.0)

    def test_dominant_returns_none_when_unknown_leads(self):
        hypotheses = HypothesisSet([hyp("a", 0.6), hyp("b", 0.4)])
        self.assertEqual(hypotheses.dominant().hypothesis_id, "a")
        hypotheses.prune("a", "excluded by evidence")
        self.assertIsNone(hypotheses.dominant())


class MutationTests(unittest.TestCase):
    def test_split_preserves_total_mass(self):
        hypotheses = HypothesisSet([hyp("parent", 0.6), hyp("other", 0.4)])
        children = hypotheses.split(
            "parent", [hyp("child_a", 1.0), hyp("child_b", 3.0)]
        )
        self.assertEqual(len(children), 2)
        self.assertAlmostEqual(
            children[0].weight + children[1].weight, 0.6
        )
        self.assertAlmostEqual(children[0].weight, 0.15)
        self.assertAlmostEqual(children[1].weight, 0.45)
        self.assertEqual(hypotheses.get("parent").status, SPLIT)
        self.assertEqual(hypotheses.get("parent").weight, 0.0)
        self.assertEqual(children[0].parent_id, "parent")
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)

    def test_split_requires_at_least_two_children(self):
        hypotheses = HypothesisSet([hyp("parent")])
        with self.assertRaises(HypothesisError):
            hypotheses.split("parent", [hyp("only_child")])

    def test_split_rejects_existing_child_id(self):
        hypotheses = HypothesisSet([hyp("parent"), hyp("taken")])
        with self.assertRaises(DuplicateHypothesisError):
            hypotheses.split("parent", [hyp("taken"), hyp("new")])

    def test_merge_combines_mass_and_keeps_source_history(self):
        hypotheses = HypothesisSet([hyp("a", 0.6), hyp("b", 0.4)])
        merged = hypotheses.merge(("a", "b"), hyp("ab", 0.0))
        self.assertEqual(merged.hypothesis_id, "ab")
        self.assertEqual(merged.status, ACTIVE)
        self.assertEqual(merged.merged_from, ("a", "b"))
        self.assertAlmostEqual(merged.weight, 1.0)
        self.assertEqual(hypotheses.get("a").status, MERGED)
        self.assertEqual(hypotheses.get("b").status, MERGED)
        self.assertEqual(hypotheses.get("a").weight, 0.0)
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)

    def test_merge_requires_two_hypotheses(self):
        hypotheses = HypothesisSet([hyp("a")])
        with self.assertRaises(HypothesisError):
            hypotheses.merge(("a",), hyp("ab"))

    def test_prune_moves_mass_to_unknown(self):
        hypotheses = HypothesisSet([hyp("a", 0.6), hyp("b", 0.4)])
        pruned = hypotheses.prune("a", "contradicted")
        self.assertEqual(pruned.status, PRUNED)
        self.assertEqual(pruned.weight, 0.0)
        weights = hypotheses.weights()
        self.assertAlmostEqual(weights["unknown"], 0.6)
        self.assertAlmostEqual(weights["b"], 0.4)
        self.assertAlmostEqual(sum(weights.values()), 1.0)

    def test_unknown_hypothesis_operations_fail(self):
        hypotheses = HypothesisSet([hyp("a")])
        with self.assertRaises(UnknownHypothesisError):
            hypotheses.prune("missing")
        with self.assertRaises(UnknownHypothesisError):
            hypotheses.split("missing", [hyp("x"), hyp("y")])
        with self.assertRaises(UnknownHypothesisError):
            hypotheses.merge(("missing", "a"), hyp("merged"))

    def test_resample_adds_alternatives_only_when_posterior_collapses(self):
        hypotheses = HypothesisSet([hyp("a", 1.0)])
        spawned = hypotheses.resample([hyp("b", 0.5)])
        self.assertEqual([h.hypothesis_id for h in spawned], ["b"])
        self.assertAlmostEqual(hypotheses.get("a").weight, 2.0 / 3.0)
        self.assertAlmostEqual(hypotheses.get("b").weight, 1.0 / 3.0)
        # The leading hypothesis is no longer dominant enough to need resampling.
        self.assertEqual(hypotheses.resample([hyp("c", 0.5)]), ())

    def test_history_records_transitions(self):
        hypotheses = HypothesisSet()
        hypotheses.spawn(hyp("a", 1.0))
        hypotheses.prune("a", "test")
        kinds = [entry.kind for entry in hypotheses.history]
        self.assertEqual(kinds, ["spawn", "prune"])

    def test_all_mutations_keep_weights_summing_to_one(self):
        hypotheses = HypothesisSet(
            [hyp("a", 0.5), hyp("b", 0.3), hyp("c", 0.2)]
        )
        hypotheses.reweight({"a": 0.9, "b": 0.1, "c": 0.3})
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)
        hypotheses.split("a", [hyp("a1", 1.0), hyp("a2", 1.0)])
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)
        hypotheses.merge(("b", "a1"), hyp("b1", 0.0))
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)
        hypotheses.prune("c")
        self.assertAlmostEqual(sum(hypotheses.weights().values()), 1.0)


if __name__ == "__main__":
    unittest.main()
