"""Tests for the independent frozen evaluation protocol (spec section 19)."""

from __future__ import annotations

import contextlib
import io
import json
import unittest
from datetime import datetime, timezone

from aeh.eval_cli import main as eval_main
from aeh.evaluation import (
    SPLIT_EXPLANATION,
    SPLIT_TRAIN,
    SPLIT_TRANSFER,
    EvalItem,
    EvaluationProtocol,
    FrozenEvalSet,
    FrozenEvalSetError,
    RealOutcome,
    SelfProofError,
    SimulatedOutcome,
    SplitIsolationError,
)

FROZEN_AT = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)
GENERATED_AT = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc)
OBSERVED_AT = datetime(2026, 3, 5, 0, 0, tzinfo=timezone.utc)


def make_items() -> tuple[EvalItem, ...]:
    return (
        EvalItem("train.add.001", "math.fraction.add", SPLIT_TRAIN, 1, True),
        EvalItem("train.add.002", "math.fraction.add", SPLIT_TRAIN, 2, True),
        EvalItem(
            "explain.add.001", "math.fraction.add", SPLIT_EXPLANATION, 2, True
        ),
        EvalItem(
            "transfer.add.001", "math.fraction.add", SPLIT_TRANSFER, 3, False
        ),
        EvalItem(
            "transfer.add.002", "math.fraction.add", SPLIT_TRANSFER, 4, False
        ),
    )


def make_frozen(items: tuple[EvalItem, ...] | None = None) -> FrozenEvalSet:
    return FrozenEvalSet(
        dataset_id="aeh.test.fractions",
        version="v1",
        frozen_at=FROZEN_AT,
        items=items if items is not None else make_items(),
    )


def simulated_outcomes() -> tuple[SimulatedOutcome, ...]:
    return (
        SimulatedOutcome("train.add.001", 0.9),
        SimulatedOutcome("train.add.002", 0.6),
        SimulatedOutcome("explain.add.001", 0.75),
    )


def real_outcomes(correct: bool = True) -> tuple[RealOutcome, ...]:
    return (
        RealOutcome("transfer.add.001", correct, "trusted_grader", OBSERVED_AT),
        RealOutcome("transfer.add.002", correct, "trusted_grader", OBSERVED_AT),
    )


class FrozenSetTests(unittest.TestCase):
    def test_digest_is_stable_and_content_addressed(self):
        first = make_frozen()
        second = make_frozen()
        self.assertEqual(first.digest, second.digest)
        self.assertEqual(len(first.digest), 64)

        changed = make_frozen(
            make_items()[:-1]
            + (EvalItem("transfer.add.003", "math.fraction.add", SPLIT_TRANSFER, 2, False),)
        )
        self.assertNotEqual(first.digest, changed.digest)

    def test_splits_are_disjoint_and_transfer_is_unseen(self):
        frozen = make_frozen()
        ids = [item.item_id for item in frozen.items]
        self.assertEqual(len(ids), len(set(ids)))
        for split in (SPLIT_TRAIN, SPLIT_EXPLANATION, SPLIT_TRANSFER):
            self.assertTrue(frozen.split(split))
            for item in frozen.split(split):
                self.assertEqual(item.split, split)
        for item in frozen.split(SPLIT_TRANSFER):
            self.assertFalse(item.seen_before)

    def test_transfer_seen_before_is_rejected(self):
        with self.assertRaises(FrozenEvalSetError):
            EvalItem("transfer.bad", "kc", SPLIT_TRANSFER, 2, True)

    def test_duplicate_item_id_across_splits_is_rejected(self):
        items = make_items() + (
            EvalItem("train.add.001", "math.fraction.add", SPLIT_TRANSFER, 3, False),
        )
        with self.assertRaises(FrozenEvalSetError):
            make_frozen(items)

    def test_required_splits_and_timezone_are_enforced(self):
        with self.assertRaises(FrozenEvalSetError):
            make_frozen(
                (
                    EvalItem("t.1", "kc", SPLIT_TRANSFER, 2, False),
                )
            )
        with self.assertRaises(FrozenEvalSetError):
            make_frozen(
                (
                    EvalItem("t.1", "kc", SPLIT_TRAIN, 2, True),
                )
            )
        with self.assertRaises(FrozenEvalSetError):
            FrozenEvalSet(
                dataset_id="d",
                version="v",
                frozen_at=datetime(2026, 3, 1),
                items=make_items(),
            )


class SplitIsolationTests(unittest.TestCase):
    def test_simulated_outcomes_must_not_touch_transfer(self):
        protocol = EvaluationProtocol(make_frozen())
        with self.assertRaises(SplitIsolationError):
            protocol.run(
                simulated_outcomes=(
                    SimulatedOutcome("transfer.add.001", 0.9),
                )
            )

    def test_simulated_channel_only_accepts_simulated_outcomes(self):
        protocol = EvaluationProtocol(make_frozen())
        with self.assertRaises(SelfProofError):
            protocol.run(
                simulated_outcomes=(
                    RealOutcome(
                        "train.add.001", True, "trusted_grader", OBSERVED_AT
                    ),
                )
            )

    def test_real_outcomes_must_reference_unseen_transfer_items(self):
        protocol = EvaluationProtocol(make_frozen())
        with self.assertRaises(SplitIsolationError):
            protocol.run(
                real_outcomes=(
                    RealOutcome(
                        "train.add.001", True, "trusted_grader", OBSERVED_AT
                    ),
                )
            )

    def test_real_outcome_rejects_simulated_source(self):
        with self.assertRaises(SelfProofError):
            RealOutcome("transfer.add.001", True, "virtual_student", OBSERVED_AT)
        with self.assertRaises(SelfProofError):
            RealOutcome("transfer.add.001", True, "simulation", OBSERVED_AT)

    def test_simulated_data_cannot_be_relabelled_as_real_evidence(self):
        protocol = EvaluationProtocol(make_frozen())
        with self.assertRaises(SelfProofError):
            protocol.run(
                real_outcomes=(
                    SimulatedOutcome("transfer.add.001", 0.95),
                )
            )


class ReportingTests(unittest.TestCase):
    def test_simulated_run_reports_no_real_transfer_evidence(self):
        protocol = EvaluationProtocol(make_frozen())
        result = protocol.run(
            simulated_outcomes=simulated_outcomes(), generated_at=GENERATED_AT
        )
        self.assertIsNotNone(result.simulated_benefit)
        self.assertIsNone(result.real_transfer)
        self.assertFalse(result.simulated_benefit.is_causal_evidence)
        self.assertTrue(
            any("no real observed transfer" in guard for guard in result.self_proof_guard)
        )
        self.assertIn("no real transfer evidence", result.real_effect_claim())

    def test_real_transfer_is_computed_only_from_the_observed_channel(self):
        protocol = EvaluationProtocol(make_frozen())
        result = protocol.run(
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            generated_at=GENERATED_AT,
        )
        self.assertIsNotNone(result.simulated_benefit)
        self.assertIsNotNone(result.real_transfer)
        assert result.real_transfer is not None
        self.assertEqual(result.real_transfer.item_count, 2)
        self.assertEqual(result.real_transfer.independent_correct, 2)
        self.assertEqual(result.real_transfer.transfer_accuracy, 1.0)
        self.assertTrue(result.real_transfer.all_items_unseen)
        self.assertFalse(result.real_transfer.causal_claim_supported)
        # The simulated aggregate is unaffected by the real channel.
        self.assertEqual(result.simulated_benefit.item_count, 3)  # type: ignore[union-attr]

    def test_report_separates_simulated_benefit_and_real_transfer(self):
        protocol = EvaluationProtocol(make_frozen())
        result = protocol.run(
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=False),
            generated_at=GENERATED_AT,
        )
        markdown = result.to_markdown()
        self.assertIn("模拟收益（L3，非因果证据）", markdown)
        self.assertIn("真实迁移（L4，独立观测）", markdown)
        self.assertIn("不能证明真实学习效果", markdown)
        self.assertIn(result.dataset_digest, markdown)
        self.assertNotIn("x = 4", markdown)

        payload = json.loads(json.dumps(result.as_dict(), ensure_ascii=False))
        self.assertEqual(payload["real_transfer"]["transfer_accuracy"], 0.0)
        self.assertEqual(payload["simulated_benefit"]["is_causal_evidence"], False)
        self.assertEqual(payload["claim"].startswith("observed transfer"), True)

    def test_mixed_observed_sources_are_rejected(self):
        protocol = EvaluationProtocol(make_frozen())
        outcomes = (
            RealOutcome("transfer.add.001", True, "trusted_grader", OBSERVED_AT),
            RealOutcome("transfer.add.002", True, "teacher", OBSERVED_AT),
        )
        with self.assertRaises(FrozenEvalSetError):
            protocol.run(real_outcomes=outcomes)

    def test_unknown_item_reference_is_rejected(self):
        protocol = EvaluationProtocol(make_frozen())
        with self.assertRaises(FrozenEvalSetError):
            protocol.run(
                simulated_outcomes=(SimulatedOutcome("train.missing", 0.5),)
            )


class CliTests(unittest.TestCase):
    def test_cli_renders_a_report(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = eval_main([])
        self.assertEqual(code, 0)
        output = buffer.getvalue()
        self.assertIn("AEH 独立冻结评测报告", output)
        self.assertIn("分片隔离自检", output)
        self.assertIn("rejected simulated transfer outcome", output)

    def test_cli_json_output_is_machine_readable(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = eval_main(["--json"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload["evaluation"]["real_transfer"], None)
        self.assertEqual(
            payload["evaluation"]["simulated_benefit"]["is_causal_evidence"], False
        )
        self.assertIn("digest", payload["frozen_set"])
        self.assertIn("rejected", payload["split_isolation_check"])


if __name__ == "__main__":
    unittest.main()
