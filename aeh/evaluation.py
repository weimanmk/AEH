"""Independent, frozen evaluation protocol (spec section 19).

The evaluation system must answer two different questions with two different
kinds of evidence, and must never let one masquerade as the other:

* **Simulated benefit** (spec L3): what a virtual-student / simulated policy
  predicts on the *training* and *explanation* splits.  This is useful for
  screening candidates, but it is **not** causal evidence and is never allowed
  to prove a real learning effect.
* **Real transfer** (spec L4): what actually happened when an *observed*
  student solved *unseen transfer* items.  This is the highest standard, and it
  can only be computed from real, independently observed outcomes.

Design rules enforced here:

* the frozen evaluation set has three disjoint, immutable splits
  (``train`` / ``explanation`` / ``transfer``); transfer items are marked
  ``seen_before=False`` and cannot be reused by the other splits;
* the set is content-addressed by a SHA-256 digest so a report can name the
  exact frozen version it measured;
* simulated outcomes may only reference train/explanation items; feeding a
  simulated outcome for a transfer item is a split-isolation violation;
* real outcomes may only reference transfer items and must come from a trusted
  observed source (``student`` / ``teacher`` / ``trusted_grader``
  / ``assessment``);
* a real-transfer claim is only produced from the real channel.  With no real
  outcomes the result says "no real evidence" instead of substituting the
  simulation.

This module is standard-library only and uses synthetic fixtures in this
repository.  It is a protocol skeleton, not a randomised controlled trial:
sample sizes are tiny, there is no control group, and ``to_markdown`` lists
those limitations explicitly.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

#: Split names; order matters for stable rendering.
SPLIT_TRAIN = "train"
SPLIT_EXPLANATION = "explanation"
SPLIT_TRANSFER = "transfer"
SPLITS: tuple[str, ...] = (SPLIT_TRAIN, SPLIT_EXPLANATION, SPLIT_TRANSFER)
SPLIT_SET = frozenset(SPLITS)

#: Only trusted observed sources may feed the real-transfer channel.
REAL_SOURCES: frozenset[str] = frozenset(
    {"student", "teacher", "trusted_grader", "assessment"}
)

#: Sources that belong to the isolated simulation world and can never be real.
SIMULATED_SOURCES: frozenset[str] = frozenset(
    {"simulated", "virtual_student", "simulation"}
)

#: Pre-registered reference accuracy used for descriptive deltas.  It is not a
#: real control group; this repository has no access to one.
DEFAULT_REFERENCE_ACCURACY = 0.5

#: This repository only ever runs on synthetic fixtures.
SYNTHETIC_FIXTURES_ONLY = True


class EvaluationError(Exception):
    """Base class for evaluation errors."""


class FrozenEvalSetError(EvaluationError, ValueError):
    """The frozen evaluation set violates an isolation/freezing rule."""


class SplitIsolationError(FrozenEvalSetError):
    """An outcome referenced a split it is not allowed to touch."""


class SelfProofError(EvaluationError, ValueError):
    """Simulated data was used where only real observed data is admissible."""


def _check_identifier(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise FrozenEvalSetError(f"{field_name} must be a short non-empty id")
    if any(character.isspace() for character in value):
        raise FrozenEvalSetError(f"{field_name} must not contain whitespace")


def _aware(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise FrozenEvalSetError(f"{field_name} must be timezone-aware")
    return value


def _finite_unit(value: float, field_name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise FrozenEvalSetError(f"{field_name} must be a number in [0, 1]")
    number = float(value)
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        raise FrozenEvalSetError(f"{field_name} must be a number in [0, 1]")
    return number


def _canonical(value: Any) -> str:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


@dataclass(frozen=True)
class EvalItem:
    """One frozen evaluation item."""

    item_id: str
    kc_id: str
    split: str
    difficulty: int = 2
    seen_before: bool = False

    def __post_init__(self) -> None:
        _check_identifier(self.item_id, "item_id")
        _check_identifier(self.kc_id, "kc_id")
        if self.split not in SPLIT_SET:
            raise FrozenEvalSetError(f"unknown split {self.split!r}")
        if not isinstance(self.difficulty, int) or not 1 <= self.difficulty <= 5:
            raise FrozenEvalSetError("difficulty must be an integer in 1..5")
        if self.split == SPLIT_TRANSFER and self.seen_before:
            raise FrozenEvalSetError(
                "transfer items must be unseen (seen_before must be False)"
            )


@dataclass(frozen=True)
class FrozenEvalSet:
    """Immutable, content-addressed evaluation set with disjoint splits."""

    dataset_id: str
    version: str
    frozen_at: datetime
    items: tuple[EvalItem, ...]
    digest: str = field(init=False)

    def __post_init__(self) -> None:
        _check_identifier(self.dataset_id, "dataset_id")
        _check_identifier(self.version, "version")
        _aware(self.frozen_at, "frozen_at")
        if not self.items:
            raise FrozenEvalSetError("a frozen evaluation set cannot be empty")

        seen: dict[str, str] = {}
        for item in self.items:
            if not isinstance(item, EvalItem):
                raise FrozenEvalSetError("items must be EvalItem instances")
            if item.item_id in seen:
                raise FrozenEvalSetError(
                    f"item {item.item_id!r} appears in two splits"
                )
            seen[item.item_id] = item.split

        for required in (SPLIT_TRAIN, SPLIT_TRANSFER):
            if not any(item.split == required for item in self.items):
                raise FrozenEvalSetError(
                    f"the frozen set needs at least one {required} item"
                )

        payload = {
            "dataset_id": self.dataset_id,
            "version": self.version,
            "frozen_at": self.frozen_at.astimezone(timezone.utc).isoformat(),
            "items": [
                {
                    "item_id": item.item_id,
                    "kc_id": item.kc_id,
                    "split": item.split,
                    "difficulty": item.difficulty,
                    "seen_before": item.seen_before,
                }
                for item in self.items
            ],
        }
        digest = hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()
        object.__setattr__(self, "digest", digest)

    def split(self, name: str) -> tuple[EvalItem, ...]:
        if name not in SPLIT_SET:
            raise FrozenEvalSetError(f"unknown split {name!r}")
        return tuple(item for item in self.items if item.split == name)

    def item(self, item_id: str) -> EvalItem:
        for item in self.items:
            if item.item_id == item_id:
                return item
        raise KeyError(item_id)

    def summary(self) -> Mapping[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "version": self.version,
            "digest": self.digest,
            "frozen_at": self.frozen_at.astimezone(timezone.utc).isoformat(),
            "counts": {
                split: len(self.split(split)) for split in SPLITS
            },
        }


@dataclass(frozen=True)
class SimulatedOutcome:
    """A simulator's prediction for one train/explanation item."""

    item_id: str
    predicted_correct: float

    def __post_init__(self) -> None:
        _check_identifier(self.item_id, "item_id")
        _finite_unit(self.predicted_correct, "predicted_correct")


@dataclass(frozen=True)
class RealOutcome:
    """One real, independently observed transfer result."""

    item_id: str
    correct: bool
    source: str
    occurred_at: datetime
    independent: bool = True

    def __post_init__(self) -> None:
        _check_identifier(self.item_id, "item_id")
        if not isinstance(self.correct, bool):
            raise FrozenEvalSetError("correct must be a boolean")
        if self.source not in REAL_SOURCES:
            raise SelfProofError(
                "real outcomes must come from a trusted observed source; "
                f"{self.source!r} is not one of {sorted(REAL_SOURCES)}"
            )
        _aware(self.occurred_at, "occurred_at")
        if not self.independent:
            raise FrozenEvalSetError(
                "transfer evaluation only counts independent attempts"
            )


@dataclass(frozen=True)
class SimulatedBenefit:
    """Aggregate simulated prediction quality (never causal evidence)."""

    split: str
    item_count: int
    mean_predicted_correct: float
    reference_accuracy: float
    simulated_gain: float
    is_causal_evidence: bool = False

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "split": self.split,
            "item_count": self.item_count,
            "mean_predicted_correct": round(self.mean_predicted_correct, 4),
            "reference_accuracy": self.reference_accuracy,
            "simulated_gain": round(self.simulated_gain, 4),
            "is_causal_evidence": self.is_causal_evidence,
            "interpretation": "simulation only; not a real learning effect",
        }


@dataclass(frozen=True)
class RealTransferResult:
    """Observed transfer performance; descriptive, not a causal claim."""

    item_count: int
    independent_correct: int
    transfer_accuracy: float
    reference_accuracy: float
    observed_delta: float
    sources: tuple[str, ...]
    all_items_unseen: bool
    causal_claim_supported: bool = False

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "item_count": self.item_count,
            "independent_correct": self.independent_correct,
            "transfer_accuracy": round(self.transfer_accuracy, 4),
            "reference_accuracy": self.reference_accuracy,
            "observed_delta": round(self.observed_delta, 4),
            "sources": list(self.sources),
            "all_items_unseen": self.all_items_unseen,
            "causal_claim_supported": self.causal_claim_supported,
            "interpretation": (
                "observed transfer on unseen items; without a control group "
                "this is descriptive, not causal"
            ),
        }


@dataclass(frozen=True)
class EvaluationResult:
    """A single evaluation run over one frozen set."""

    dataset_id: str
    dataset_version: str
    dataset_digest: str
    frozen_at: datetime
    generated_at: datetime
    simulated_benefit: SimulatedBenefit | None
    real_transfer: RealTransferResult | None
    self_proof_guard: tuple[str, ...]
    limitations: tuple[str, ...]

    def real_effect_claim(self) -> str:
        """Return the strongest claim the evidence supports."""
        if self.real_transfer is None:
            return (
                "no real transfer evidence: simulated results cannot be "
                "reported as a real learning effect"
            )
        return (
            "observed transfer evidence is available but, without a control "
            "group, only a descriptive comparison is supported"
        )

    def as_dict(self) -> Mapping[str, Any]:
        return {
            "evaluation_type": "aeh_frozen_evaluation",
            "dataset": {
                "dataset_id": self.dataset_id,
                "version": self.dataset_version,
                "digest": self.dataset_digest,
                "frozen_at": self.frozen_at.astimezone(timezone.utc).isoformat(),
            },
            "generated_at": self.generated_at.astimezone(timezone.utc).isoformat(),
            "simulated_benefit": (
                None if self.simulated_benefit is None
                else self.simulated_benefit.as_dict()
            ),
            "real_transfer": (
                None if self.real_transfer is None
                else self.real_transfer.as_dict()
            ),
            "self_proof_guard": list(self.self_proof_guard),
            "limitations": list(self.limitations),
            "claim": self.real_effect_claim(),
        }

    def to_markdown(self) -> str:
        lines = [
            "# AEH 独立冻结评测报告",
            "",
            f"- 数据集：`{self.dataset_id}` 版本 `{self.dataset_version}`",
            f"- 数据集摘要（SHA-256）：`{self.dataset_digest}`",
            f"- 冻结时间：{self.frozen_at.astimezone(timezone.utc).isoformat()}",
            f"- 生成时间：{self.generated_at.astimezone(timezone.utc).isoformat()}",
            "- 数据来源：本仓库仅使用合成 fixture，未接入任何真实学生数据。",
            "",
            "## 1. 模拟收益（L3，非因果证据）",
            "",
        ]
        if self.simulated_benefit is None:
            lines.append("- 未提供模拟评测结果。")
        else:
            benefit = self.simulated_benefit
            lines.extend(
                [
                    f"- 评测分片：{benefit.split}（{benefit.item_count} 题）",
                    f"- 模拟平均预测正确率：{benefit.mean_predicted_correct:.4f}",
                    f"- 参考基线：{benefit.reference_accuracy:.4f}",
                    f"- 模拟收益：{benefit.simulated_gain:+.4f}",
                    "- 是否因果证据：**否**（模拟收益不能证明真实学习效果）。",
                ]
            )
        lines.extend(["", "## 2. 真实迁移（L4，独立观测）", ""])
        if self.real_transfer is None:
            lines.append(
                "- 未提供真实迁移观测；**不得**用上节模拟数据替代或推断真实效果。"
            )
        else:
            transfer = self.real_transfer
            lines.extend(
                [
                    f"- 未见迁移题：{transfer.item_count} 题，全部 unseen：{transfer.all_items_unseen}",
                    f"- 独立正确：{transfer.independent_correct}",
                    f"- 迁移正确率：{transfer.transfer_accuracy:.4f}",
                    f"- 参考基线：{transfer.reference_accuracy:.4f}",
                    f"- 观测差值（描述性）：{transfer.observed_delta:+.4f}",
                    f"- 观测来源：{', '.join(transfer.sources)}",
                    f"- 是否支持因果结论：{transfer.causal_claim_supported}（无对照组）。",
                ]
            )
        lines.extend(
            [
                "",
                "## 3. 防自证约束",
                "",
            ]
        )
        for guard in self.self_proof_guard:
            lines.append(f"- {guard}")
        lines.extend(["", "## 4. 已知限制", ""])
        for limitation in self.limitations:
            lines.append(f"- {limitation}")
        lines.extend(
            [
                "",
                "## 5. 结论",
                "",
                f"{self.real_effect_claim()}",
                "",
                "> 模拟收益与真实迁移必须分开报告；二者都只使用本仓库的合成数据。",
                "",
            ]
        )
        return "\n".join(lines)


class EvaluationProtocol:
    """Run simulated and real channels over one frozen evaluation set."""

    def __init__(
        self,
        frozen_set: FrozenEvalSet,
        *,
        reference_accuracy: float = DEFAULT_REFERENCE_ACCURACY,
    ) -> None:
        if not isinstance(frozen_set, FrozenEvalSet):
            raise EvaluationError("frozen_set must be a FrozenEvalSet")
        self.frozen_set = frozen_set
        self.reference_accuracy = _finite_unit(
            reference_accuracy, "reference_accuracy"
        )

    def run(
        self,
        *,
        simulated_outcomes: Sequence[SimulatedOutcome] = (),
        real_outcomes: Sequence[RealOutcome] = (),
        generated_at: datetime | None = None,
    ) -> EvaluationResult:
        frozen = self.frozen_set
        generated = generated_at or datetime.now(timezone.utc)
        _aware(generated, "generated_at")

        simulated = self._simulated_benefit(simulated_outcomes)
        transfer = self._real_transfer(real_outcomes)

        guards: list[str] = [
            "simulated outcomes are recorded as L3 simulation benefit only and "
            "are never converted into a real-transfer claim",
            "real transfer is computed exclusively from the observed channel "
            "(trusted sources, unseen transfer items, independent attempts)",
        ]
        if transfer is None:
            guards.append(
                "no real observed transfer outcomes were supplied, so no real "
                "learning effect is claimed"
            )
        else:
            guards.append(
                "a control group was not part of this run, so the observed "
                "delta is descriptive only"
            )

        limitations = [
            "synthetic fixtures only; no real student data is used",
            "small sample sizes and no randomisation or control group",
            "reference accuracy is a pre-registered constant, not a measured "
            "control condition",
            "simulated predictions are model output and can be over-optimistic",
        ]
        return EvaluationResult(
            dataset_id=frozen.dataset_id,
            dataset_version=frozen.version,
            dataset_digest=frozen.digest,
            frozen_at=frozen.frozen_at,
            generated_at=generated,
            simulated_benefit=simulated,
            real_transfer=transfer,
            self_proof_guard=tuple(guards),
            limitations=tuple(limitations),
        )

    # -- internal channels -------------------------------------------------

    def _simulated_benefit(
        self, outcomes: Sequence[SimulatedOutcome]
    ) -> SimulatedBenefit | None:
        prepared = self._prepare_simulated(outcomes)
        if not prepared:
            return None
        mean_predicted = sum(value for _, value in prepared) / len(prepared)
        return SimulatedBenefit(
            split=f"{SPLIT_TRAIN}+{SPLIT_EXPLANATION}",
            item_count=len(prepared),
            mean_predicted_correct=mean_predicted,
            reference_accuracy=self.reference_accuracy,
            simulated_gain=mean_predicted - self.reference_accuracy,
        )

    def _prepare_simulated(
        self, outcomes: Sequence[SimulatedOutcome]
    ) -> list[tuple[EvalItem, float]]:
        prepared: list[tuple[EvalItem, float]] = []
        for outcome in outcomes:
            if not isinstance(outcome, SimulatedOutcome):
                raise SelfProofError(
                    "simulated channel only accepts SimulatedOutcome values"
                )
            item = self._resolve(outcome.item_id)
            if item.split == SPLIT_TRANSFER:
                raise SplitIsolationError(
                    "simulated outcomes must not touch the transfer split; "
                    "transfer is reserved for real observed evaluation"
                )
            prepared.append((item, outcome.predicted_correct))
        return prepared

    def _real_transfer(
        self, outcomes: Sequence[RealOutcome]
    ) -> RealTransferResult | None:
        if not outcomes:
            return None
        correct = 0
        sources: set[str] = set()
        all_unseen = True
        for outcome in outcomes:
            if not isinstance(outcome, RealOutcome):
                # Defensive: a SimulatedOutcome here must never be accepted.
                raise SelfProofError(
                    "real-transfer channel only accepts RealOutcome values; "
                    "simulated data cannot be relabelled as real evidence"
                )
            item = self._resolve(outcome.item_id)
            if item.split != SPLIT_TRANSFER:
                raise SplitIsolationError(
                    "real transfer may only reference transfer-split items"
                )
            if item.seen_before:
                raise SplitIsolationError(
                    "transfer items must be unseen for a transfer claim"
                )
            sources.add(outcome.source)
            if outcome.correct:
                correct += 1
        accuracy = correct / len(outcomes)
        if len(sources) != 1:
            raise FrozenEvalSetError(
                "a run must not mix observed sources across the real channel"
            )
        return RealTransferResult(
            item_count=len(outcomes),
            independent_correct=correct,
            transfer_accuracy=accuracy,
            reference_accuracy=self.reference_accuracy,
            observed_delta=accuracy - self.reference_accuracy,
            sources=tuple(sorted(sources)),
            all_items_unseen=all_unseen,
        )

    def _resolve(self, item_id: str) -> EvalItem:
        try:
            return self.frozen_set.item(item_id)
        except KeyError as exc:
            raise FrozenEvalSetError(
                f"outcome references item {item_id!r} which is not in the "
                "frozen evaluation set"
            ) from exc


__all__ = [
    "SPLIT_TRAIN",
    "SPLIT_EXPLANATION",
    "SPLIT_TRANSFER",
    "SPLITS",
    "REAL_SOURCES",
    "SIMULATED_SOURCES",
    "DEFAULT_REFERENCE_ACCURACY",
    "EvaluationError",
    "FrozenEvalSetError",
    "SplitIsolationError",
    "SelfProofError",
    "EvalItem",
    "FrozenEvalSet",
    "SimulatedOutcome",
    "RealOutcome",
    "SimulatedBenefit",
    "RealTransferResult",
    "EvaluationResult",
    "EvaluationProtocol",
]
