"""Runnable synthetic evaluation (spec section 19).

Examples::

    python3 -m aeh.eval_cli
    python3 -m aeh.eval_cli --json

The command is offline and standard-library only.  It builds a *synthetic*
frozen evaluation set with disjoint train/explanation/transfer splits, runs a
simulated policy on the train+explanation splits, and reports the simulated
benefit separately from the (absent) real transfer channel.  It deliberately
does **not** fabricate observed outcomes, so the report demonstrates the
non-self-proof rule: a simulation cannot be reported as a real learning effect.

No file, network, database, or real student data is touched.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .evaluation import (
    SPLIT_EXPLANATION,
    SPLIT_TRAIN,
    SPLIT_TRANSFER,
    EvalItem,
    EvaluationProtocol,
    FrozenEvalSet,
    SimulatedOutcome,
    SplitIsolationError,
)

#: Fixed clock so runs are deterministic.
EVAL_FROZEN_AT = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)
EVAL_GENERATED_AT = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc)

KC_FRACTION_ADD = "math.fraction.add"
KC_FRACTION_EQUIV = "math.fraction.equiv"
KC_FRACTION_COMPARE = "math.fraction.compare"


def synthetic_frozen_set() -> FrozenEvalSet:
    """A small, explicitly synthetic frozen evaluation set."""
    items = (
        # Training split: seen, used to fit / practise.
        EvalItem("train.add.001", KC_FRACTION_ADD, SPLIT_TRAIN, 1, True),
        EvalItem("train.add.002", KC_FRACTION_ADD, SPLIT_TRAIN, 2, True),
        EvalItem("train.add.003", KC_FRACTION_ADD, SPLIT_TRAIN, 3, True),
        EvalItem("train.equiv.001", KC_FRACTION_EQUIV, SPLIT_TRAIN, 2, True),
        EvalItem("train.equiv.002", KC_FRACTION_EQUIV, SPLIT_TRAIN, 3, True),
        EvalItem("train.compare.001", KC_FRACTION_COMPARE, SPLIT_TRAIN, 2, True),
        # Explanation split: worked examples /讲解, never counted as retrieval.
        EvalItem(
            "explain.add.001", KC_FRACTION_ADD, SPLIT_EXPLANATION, 2, True
        ),
        EvalItem(
            "explain.equiv.001", KC_FRACTION_EQUIV, SPLIT_EXPLANATION, 3, True
        ),
        # Transfer split: unseen items reserved for real, independent evaluation.
        EvalItem(
            "transfer.add.001", KC_FRACTION_ADD, SPLIT_TRANSFER, 3, False
        ),
        EvalItem(
            "transfer.add.002", KC_FRACTION_ADD, SPLIT_TRANSFER, 4, False
        ),
        EvalItem(
            "transfer.equiv.001", KC_FRACTION_EQUIV, SPLIT_TRANSFER, 3, False
        ),
    )
    return FrozenEvalSet(
        dataset_id="aeh.synthetic.fractions.v1",
        version="2026.03.01",
        frozen_at=EVAL_FROZEN_AT,
        items=items,
    )


def synthetic_simulated_outcomes(
    frozen_set: FrozenEvalSet,
) -> tuple[SimulatedOutcome, ...]:
    """Deterministic synthetic simulator predictions for non-transfer splits."""
    predictions = {
        "train.add.001": 0.92,
        "train.add.002": 0.78,
        "train.add.003": 0.61,
        "train.equiv.001": 0.70,
        "train.equiv.002": 0.55,
        "train.compare.001": 0.66,
        "explain.add.001": 0.81,
        "explain.equiv.001": 0.58,
    }
    return tuple(
        SimulatedOutcome(item.item_id, predictions[item.item_id])
        for item in frozen_set.items
        if item.split in (SPLIT_TRAIN, SPLIT_EXPLANATION)
    )


def check_split_isolation(frozen_set: FrozenEvalSet) -> str:
    """Return the boundary message when a simulated transfer outcome is tried.

    This demonstrates the non-self-proof rule at runtime: the protocol refuses
    to let simulation touch the transfer split.
    """

    protocol = EvaluationProtocol(frozen_set)
    transfer = frozen_set.split(SPLIT_TRANSFER)[0]
    try:
        protocol.run(simulated_outcomes=(SimulatedOutcome(transfer.item_id, 0.9),))
    except SplitIsolationError as exc:
        return f"rejected simulated transfer outcome: {exc}"
    return "ERROR: simulated transfer outcome was not rejected"


def build_payload() -> Mapping[str, Any]:
    frozen_set = synthetic_frozen_set()
    protocol = EvaluationProtocol(frozen_set)
    result = protocol.run(
        simulated_outcomes=synthetic_simulated_outcomes(frozen_set),
        generated_at=EVAL_GENERATED_AT,
    )
    return {
        "evaluation": result.as_dict(),
        "frozen_set": frozen_set.summary(),
        "split_isolation_check": check_split_isolation(frozen_set),
        "note": (
            "synthetic fixtures only; no real student data; simulated benefit "
            "is reported separately from real transfer and is not a learning "
            "effect claim"
        ),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m aeh.eval_cli",
        description=(
            "AEH 独立冻结评测（合成数据）：模拟收益与真实迁移分开报告，"
            "不使用模拟数据自证真实学习效果。"
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="输出机器可读 JSON（评测结果 + 冻结集摘要 + 隔离自检）",
    )
    args = parser.parse_args(argv)

    frozen_set = synthetic_frozen_set()
    protocol = EvaluationProtocol(frozen_set)
    result = protocol.run(
        simulated_outcomes=synthetic_simulated_outcomes(frozen_set),
        generated_at=EVAL_GENERATED_AT,
    )

    if args.json:
        print(json.dumps(build_payload(), ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(result.to_markdown())
        print("## 6. 分片隔离自检")
        print()
        print(f"- {check_split_isolation(frozen_set)}")
        print()
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised by tests/CLI
    raise SystemExit(main())
