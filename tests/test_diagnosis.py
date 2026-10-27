"""Tests for discriminating diagnostic probe selection (spec section 7)."""

from __future__ import annotations

import unittest

from aeh.diagnosis import (
    DiagnosisSession,
    DiagnosticCandidate,
    ProbeWeights,
    entropy,
    expected_information_gain,
    posterior_after,
    score_candidate,
    select_probe,
)


def candidate(item_id: str, predictions, **overrides) -> DiagnosticCandidate:
    values = {
        "item_id": item_id,
        "predictions": predictions,
        "time_minutes": 0.0,
        "risk": 0.0,
        "cognitive_load": 0.0,
        "teaching_value": 0.0,
        "gate_allowed": True,
    }
    values.update(overrides)
    return DiagnosticCandidate(**values)


class EntropyAndPosteriorTests(unittest.TestCase):
    def test_uniform_two_hypothesis_entropy_is_one_bit(self):
        self.assertAlmostEqual(entropy({"h1": 1.0, "h2": 1.0}), 1.0)

    def test_certain_hypothesis_has_zero_entropy(self):
        self.assertEqual(entropy({"h1": 1.0}), 0.0)

    def test_empty_distribution_has_zero_entropy(self):
        self.assertEqual(entropy({}), 0.0)

    def test_correct_answer_shifts_posterior(self):
        probe = candidate("q1", {"h1": 0.9, "h2": 0.1})
        posterior = posterior_after(probe, {"h1": 0.5, "h2": 0.5}, correct=True)
        self.assertAlmostEqual(sum(posterior.values()), 1.0)
        self.assertAlmostEqual(posterior["h1"], 0.9)
        self.assertAlmostEqual(posterior["h2"], 0.1)

    def test_incorrect_answer_shifts_posterior_the_other_way(self):
        probe = candidate("q1", {"h1": 0.9, "h2": 0.1})
        posterior = posterior_after(probe, {"h1": 0.5, "h2": 0.5}, correct=False)
        self.assertAlmostEqual(posterior["h1"], 0.1)
        self.assertAlmostEqual(posterior["h2"], 0.9)

    def test_zero_likelihood_keeps_prior_instead_of_dividing_by_zero(self):
        probe = candidate("q1", {"h1": 0.0, "h2": 0.0})
        posterior = posterior_after(probe, {"h1": 0.5, "h2": 0.5}, correct=True)
        self.assertEqual(posterior, {"h1": 0.5, "h2": 0.5})

    def test_empty_prior_stays_empty(self):
        probe = candidate("q1", {"h1": 0.9})
        self.assertEqual(posterior_after(probe, {}, correct=True), {})


class InformationGainTests(unittest.TestCase):
    def test_uninformative_probe_has_no_gain(self):
        probe = candidate("q1", {"h1": 0.5, "h2": 0.5})
        self.assertAlmostEqual(
            expected_information_gain(probe, {"h1": 0.5, "h2": 0.5}), 0.0
        )

    def test_discriminating_probe_has_positive_gain(self):
        probe = candidate("q1", {"h1": 0.95, "h2": 0.05})
        gain = expected_information_gain(probe, {"h1": 0.5, "h2": 0.5})
        self.assertGreater(gain, 0.0)
        self.assertLessEqual(gain, 1.0 + 1e-12)

    def test_more_discriminating_probe_has_more_gain(self):
        strong = candidate("strong", {"h1": 0.95, "h2": 0.05})
        weak = candidate("weak", {"h1": 0.6, "h2": 0.4})
        weights = {"h1": 0.5, "h2": 0.5}
        self.assertGreater(
            expected_information_gain(strong, weights),
            expected_information_gain(weak, weights),
        )

    def test_missing_prediction_defaults_to_chance(self):
        probe = candidate("q1", {})
        self.assertEqual(probe.probability_correct("h1"), 0.5)
        self.assertEqual(expected_information_gain(probe, {"h1": 1.0}), 0.0)


class CandidateScoringTests(unittest.TestCase):
    def test_gate_rejected_candidate_scores_negative_infinity(self):
        probe = candidate("q1", {"h1": 0.9, "h2": 0.1}, gate_allowed=False)
        selection = score_candidate(probe, {"h1": 0.5, "h2": 0.5})
        self.assertEqual(selection.score, float("-inf"))
        self.assertIn("curriculum_gate_rejected", selection.reasons)

    def test_time_risk_and_load_reduce_the_score(self):
        probe = candidate(
            "q1",
            {"h1": 0.9, "h2": 0.1},
            time_minutes=5.0,
            risk=0.4,
            cognitive_load=0.3,
        )
        no_cost = ProbeWeights(alpha=0.0, beta=0.0, gamma=0.0, delta=0.0)
        full_cost = ProbeWeights(alpha=0.0, beta=0.2, gamma=1.0, delta=1.0)
        weights = {"h1": 0.5, "h2": 0.5}
        self.assertGreater(
            score_candidate(probe, weights, no_cost).score,
            score_candidate(probe, weights, full_cost).score,
        )

    def test_teaching_value_raises_the_score(self):
        low = candidate("q1", {"h1": 0.9, "h2": 0.1}, teaching_value=0.0)
        high = candidate("q2", {"h1": 0.9, "h2": 0.1}, teaching_value=0.5)
        policy = ProbeWeights(alpha=0.2, beta=0.0, gamma=0.0, delta=0.0)
        weights = {"h1": 0.5, "h2": 0.5}
        self.assertGreater(
            score_candidate(high, weights, policy).score,
            score_candidate(low, weights, policy).score,
        )


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.weights = {"h1": 0.5, "h2": 0.5}

    def test_selects_highest_scoring_gate_allowed_probe(self):
        weak = candidate("weak", {"h1": 0.6, "h2": 0.4})
        strong = candidate("strong", {"h1": 0.95, "h2": 0.05})
        selection = select_probe([weak, strong], self.weights)
        self.assertIsNotNone(selection)
        self.assertEqual(selection.item_id, "strong")

    def test_gate_rejected_candidates_are_never_selected(self):
        rejected = candidate(
            "future",
            {"h1": 0.99, "h2": 0.01},
            gate_allowed=False,
        )
        allowed = candidate("allowed", {"h1": 0.6, "h2": 0.4})
        selection = select_probe([rejected, allowed], self.weights)
        self.assertEqual(selection.item_id, "allowed")

    def test_no_allowed_candidate_returns_none(self):
        rejected = candidate("future", {"h1": 0.9}, gate_allowed=False)
        self.assertIsNone(select_probe([rejected], self.weights))

    def test_student_can_skip_diagnosis(self):
        allowed = candidate("q1", {"h1": 0.9, "h2": 0.1})
        self.assertIsNone(select_probe([allowed], self.weights, skipped=True))

    def test_min_score_can_decline_low_value_probe(self):
        allowed = candidate("q1", {"h1": 0.5, "h2": 0.5})
        self.assertIsNone(select_probe([allowed], self.weights, min_score=0.1))

    def test_ties_are_broken_by_item_id(self):
        first = candidate("a", {"h1": 0.9, "h2": 0.1})
        second = candidate("b", {"h1": 0.9, "h2": 0.1})
        selection = select_probe([second, first], self.weights)
        self.assertEqual(selection.item_id, "a")

    def test_session_updates_posterior_and_records_asked_items(self):
        session = DiagnosisSession(self.weights)
        probe = candidate("q1", {"h1": 0.9, "h2": 0.1})
        self.assertEqual(session.select([probe]).item_id, "q1")
        session.observe(probe, correct=True)
        self.assertEqual(session.asked, ["q1"])
        self.assertGreater(session.weights["h1"], session.weights["h2"])
        self.assertAlmostEqual(sum(session.weights.values()), 1.0)

    def test_session_skip_prevents_further_questions(self):
        session = DiagnosisSession(self.weights)
        session.skip()
        probe = candidate("q1", {"h1": 0.9, "h2": 0.1})
        self.assertIsNone(session.select([probe]))
        self.assertEqual(session.asked, [])

    def test_predictions_must_be_probabilities(self):
        with self.assertRaises(ValueError):
            candidate("q1", {"h1": 1.1})
        with self.assertRaises(ValueError):
            candidate("q2", {"h1": -0.1})


if __name__ == "__main__":
    unittest.main()
