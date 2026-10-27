"""Runnable FSRS calibration demo (spec section 8).

Examples::

    python3 -m aeh.fsrs_calibration_cli
    python3 -m aeh.fsrs_calibration_cli --json

The command is offline and standard-library only.  It:

1. generates a **synthetic** review dataset (deterministic from ``--seed``);
2. fits the FSRS dynamics parameters with ``aeh.fsrs_calibration.calibrate``
   and prints the point estimates, bootstrap intervals and applicability;
3. proposes a versioned parameter *candidate* and evaluates it on a disjoint
   synthetic held-out set through the activation gate.

It deliberately supplies **no** real-transfer evidence, so ``promotionReady``
stays false: the output demonstrates the rule that a calibration is a
candidate, not a production change, and that simulated gain cannot self-prove
real learning.  It then shows the approved path in which the gate activates a
**frozen** parameter configuration object and records the decision; no mastery
or twin state is written.  Nothing here touches a running dsh instance,
``~/.dsh``, a database, or real student data.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .evolution import Actor, ApprovalRecord
from .fsrs_calibration import (
    CalibrationActivationGate,
    CalibrationConfig,
    CalibrationService,
    DEFAULT_DATA_VERSION,
    DEFAULT_PARAMETER_VERSION,
    generate_dataset,
)

#: Fixed clock so the demo output is deterministic.
CLI_CREATED_AT = datetime(2026, 5, 1, 9, 0, tzinfo=timezone.utc)
CLI_EVALUATED_AT = datetime(2026, 5, 1, 9, 5, tzinfo=timezone.utc)


def build_payload(
    *,
    seed: int = 20240607,
    sequence_count: int = 10,
    events_per_sequence: int = 5,
    bootstrap_resamples: int = 24,
) -> Mapping[str, Any]:
    dataset = generate_dataset(
        seed=seed,
        sequence_count=sequence_count,
        events_per_sequence=events_per_sequence,
        data_version=DEFAULT_DATA_VERSION,
    )
    held_out = generate_dataset(
        seed=seed + 101,
        sequence_count=max(3, sequence_count // 2),
        events_per_sequence=events_per_sequence,
        dataset_id="dataset.synthetic.fsrs.heldout",
        data_version=DEFAULT_DATA_VERSION,
    )
    config = CalibrationConfig(
        seed=seed,
        data_version=DEFAULT_DATA_VERSION,
        parameter_version=DEFAULT_PARAMETER_VERSION,
        bootstrap_resamples=bootstrap_resamples,
    )
    service = CalibrationService(dataset, config)
    report = service.calibrate()
    candidate = service.propose_candidate(
        report, author="calibration.cli", created_at=CLI_CREATED_AT
    )

    gate = CalibrationActivationGate(
        now=lambda: CLI_EVALUATED_AT
    )
    gate.register(candidate)
    reviewer = Actor(actor_id="host.reviewer.cli", role="reviewer")
    verdict = gate.evaluate(
        candidate.candidate_id, candidate.version, held_out, actor=reviewer
    )
    activation_blocked: str | None = None
    try:
        gate.activate(candidate.candidate_id, candidate.version, actor=reviewer)
    except Exception as exc:  # noqa: BLE001 - the demo reports the refusal
        activation_blocked = f"{type(exc).__name__}: {exc}"

    approved_probe: Mapping[str, Any] | None = None
    if activation_blocked is not None and verdict.screening_passed:
        approval = ApprovalRecord(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            decision="approved",
            approved_by=reviewer.actor_id,
            decided_at=CLI_EVALUATED_AT,
            reason="synthetic demo: screen passed; real transfer absent",
            role=reviewer.role,
        )
        gate.approve(candidate.candidate_id, candidate.version, approval, reviewer)
        try:
            gate.activate(candidate.candidate_id, candidate.version, actor=reviewer)
            approved_probe = {"activated": True}
        except Exception as exc:  # noqa: BLE001
            approved_probe = {
                "activated": False,
                "reason": f"{type(exc).__name__}: {exc}",
            }
    elif activation_blocked is not None:
        approved_probe = {
            "activated": False,
            "reason": "screening failed; the candidate was rejected before approval",
        }

    return {
        "dataset": dataset.summary(),
        "heldOutDataset": held_out.summary(),
        "config": config.as_dict(),
        "report": report.as_dict(),
        "candidate": candidate.as_dict(),
        "evaluation": verdict.as_dict(),
        "activationBlocked": activation_blocked,
        "approvedActivationProbe": approved_probe,
        "note": (
            "synthetic fixtures only; no real student data; a calibration is a "
            "parameter candidate, never a direct mastery change; simulated and "
            "real-transfer channels are reported separately"
        ),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m aeh.fsrs_calibration_cli",
        description=(
            "AEH FSRS 参数校准（合成数据）：拟合稳定性/难度/可提取性参数，"
            "给出不确定度与适用范围；只产生候选，须经隔离评测与显式批准。"
        ),
    )
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    parser.add_argument("--seed", type=int, default=20240607, help="合成数据种子")
    parser.add_argument(
        "--sequences", type=int, default=10, help="合成序列条数"
    )
    parser.add_argument(
        "--events", type=int, default=5, help="每条序列的复习事件数"
    )
    parser.add_argument(
        "--bootstrap", type=int, default=24, help="bootstrap 重采样次数"
    )
    args = parser.parse_args(argv)

    payload = build_payload(
        seed=args.seed,
        sequence_count=args.sequences,
        events_per_sequence=args.events,
        bootstrap_resamples=args.bootstrap,
    )
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    report = payload["report"]
    print("# AEH FSRS 参数校准报告（合成数据，非生产校准）")
    print()
    print(f"- 数据集：{payload['dataset']['datasetId']} / {payload['dataset']['dataVersion']}")
    print(f"- 数据摘要：{payload['dataset']['digest']}")
    print(f"- 报告指纹：{report['reportFingerprint']}")
    print(f"- 观测数：{report['observationCount']}；序列数：{report['sequenceCount']}")
    print()
    print("## 参数点估计与 bootstrap 区间")
    print()
    print("| 参数 | 点估计 | 95% 区间 | 是否已识别 |")
    print("|---|---|---|---|")
    for estimate in report["estimates"]:
        print(
            "| {name} | {point} | [{ciLow}, {ciHigh}] | {identified} |".format(
                **estimate
            )
        )
    metrics = report["metrics"]
    print()
    print(
        "## 校准指标：Brier={brier}（[{brierCiLow}, {brierCiHigh}]），"
        "ECE={ece}，log loss={logLoss}".format(**metrics)
    )
    print()
    print("## 适用范围")
    print()
    for condition in report["applicability"]["conditions"]:
        print(f"- {condition}")
    print()
    print("明确不适用：")
    for item in report["applicability"]["outOfScope"]:
        print(f"- {item}")
    print()
    print("## 隔离评测（模拟 / 真实分通道）")
    print()
    evaluation = payload["evaluation"]
    print(f"- 模拟通道：{evaluation['simulatedBenefit']}")
    print(f"- 真实迁移通道：{evaluation['realTransfer']}")
    print(f"- 未批准时激活被拒绝：{payload['activationBlocked']}")
    print(f"- 显式批准后探测：{payload['approvedActivationProbe']}")
    print()
    print(payload["note"])
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised by tests/CLI
    raise SystemExit(main())
