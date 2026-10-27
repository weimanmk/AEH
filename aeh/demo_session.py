"""Synthetic end-to-end demo: photo -> grading -> diagnosis -> review.

This module is a deliberately small *demonstration* of how the Step 1 core
modules compose.  It never reads a file, a camera, a network service, a
database or a real student record.  The "photo" is an in-memory synthetic
fixture; the grader compares scripted steps against a verified reference
answer; the diagnostic answers are scripted; and the report consumes only
aggregate events.

What is real here is the wiring: curriculum gating is fail-closed, evidence is
written through :class:`aeh.twin.StudentTwin`, hypotheses use
:class:`aeh.hypothesis.HypothesisSet`, probe selection uses
:class:`aeh.diagnosis.DiagnosisSession`, memory/review scheduling uses
:class:`aeh.memory.MemoryState`, and delivery uses
:class:`aeh.exercise.InterventionPackage` plus its gate validation.

Standard library only.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from .curriculum_gate import (
    MODE_LEARN,
    MODE_REVIEW,
    CurriculumItem,
    GateDecision,
    LearnerProgress,
    allow,
)
from .diagnosis import (
    DiagnosisSession,
    DiagnosticCandidate,
    ProbeSelection,
    ProbeWeights,
)
from .exercise import (
    DeliveryReceipt,
    InterventionPackage,
    deliver,
)
from .hypothesis import Hypothesis, HypothesisSet
from .memory import (
    KIND_ATTEMPT,
    MemoryObservation,
    MemoryState,
    update_memory,
)
from .report import AggregateEvent, KIND_ATTEMPT as REPORT_KIND_ATTEMPT
from .twin import (
    Event,
    KnowledgeEstimate,
    StudentTwin,
    TwinState,
)

#: Clearly synthetic, pseudonymous demo identity.  Never use a real one.
SYNTHETIC_STUDENT_ID = "demo.student.synthetic_001"

#: Fixed clock so runs and tests are deterministic.
DEMO_BASE_TIME = datetime(2026, 3, 2, 8, 0, tzinfo=timezone.utc)
DEMO_WINDOW_START = datetime(2026, 3, 2, 0, 0, tzinfo=timezone.utc)
DEMO_WINDOW_END = datetime(2026, 3, 3, 0, 0, tzinfo=timezone.utc)

KC_SQUARE_FORMULA = "algebra.square_formula"
KC_COMPLETING_SQUARE = "algebra.completing_square"
KC_QUADRATIC_MAXMIN = "algebra.quadratic_maxmin"
KC_QUADRATIC_GRAPH = "algebra.quadratic_graph"
KC_CALCULUS_DERIVATIVE = "calculus.derivative"

MISCONCEPTION_NO_COMPENSATION = "bug.no_compensation"
MISCONCEPTION_SQUARE_SIGN = "bug.square_formula_sign"


class DemoError(Exception):
    """The synthetic demo cannot proceed safely."""


def _normalize_step(value: str) -> str:
    """Normalise a scripted step for exact demo matching (not a real grader)."""
    text = unicodedata.normalize("NFKC", str(value))
    text = text.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
    return re.sub(r"\s+", "", text)


@dataclass(frozen=True)
class SyntheticQuestion:
    """A scripted demo question with a verified reference solution."""

    question_id: str
    stem: str
    accepted_steps: tuple[tuple[str, ...], ...]
    curriculum_item: CurriculumItem
    error_signatures: tuple[tuple[str, str], ...] = ()
    reference_verified: bool = True

    def __post_init__(self) -> None:
        if not self.accepted_steps or any(not step for step in self.accepted_steps):
            raise DemoError("a synthetic question needs non-empty accepted steps")
        for signature in self.error_signatures:
            if len(signature) != 2 or not all(signature):
                raise DemoError("error signatures must be (misconception, step) pairs")


@dataclass(frozen=True)
class SyntheticPhoto:
    """An in-memory stand-in for a photographed question and handwritten trace."""

    image_ref: str
    ocr_confidence: float
    question: SyntheticQuestion
    student_steps: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.image_ref.startswith("synthetic://"):
            raise DemoError("demo photos must use synthetic:// references")
        if not 0.0 <= self.ocr_confidence <= 1.0:
            raise DemoError("ocr_confidence must be within [0, 1]")
        if not self.student_steps:
            raise DemoError("the synthetic photo needs a scripted student trace")


@dataclass(frozen=True)
class StepCheck:
    """One step comparison produced by the scripted demo grader."""

    index: int
    submitted: str
    expected: str
    ok: bool


@dataclass(frozen=True)
class GradedTrace:
    """Localised grading result; the first invalid step is the key evidence."""

    question_id: str
    correct: bool
    checks: tuple[StepCheck, ...]
    first_invalid_step: int | None
    misconception_ids: tuple[str, ...]
    hints_used: int = 0


@dataclass(frozen=True)
class SyntheticProbe:
    """A diagnostic candidate plus its gate annotations and scripted answer."""

    candidate: DiagnosticCandidate
    curriculum_item: CurriculumItem
    stem: str
    synthetic_response_correct: bool

    def __post_init__(self) -> None:
        if self.candidate.item_id != self.curriculum_item.item_id:
            raise DemoError("probe candidate and curriculum item ids must match")


def synthetic_progress() -> LearnerProgress:
    """A synthetic grade-8 learner whose school progress is clearly confirmed."""
    return LearnerProgress(
        student_id=SYNTHETIC_STUDENT_ID,
        grade_level=8,
        taught_kcs=frozenset({KC_SQUARE_FORMULA, KC_COMPLETING_SQUARE}),
        in_progress_kcs=frozenset({KC_QUADRATIC_MAXMIN}),
        confirmed_preview_kcs=frozenset({KC_QUADRATIC_GRAPH}),
        confirmed_prior_kcs=frozenset(),
        progress_confidence=0.95,
        current_load=0.1,
        load_budget=1.2,
    )


def synthetic_question() -> SyntheticQuestion:
    """The scripted completing-square question; all content is synthetic."""
    item = CurriculumItem(
        item_id="demo.q.completing_square_01",
        required_kcs=(KC_SQUARE_FORMULA, KC_COMPLETING_SQUARE),
        grade_level=8,
        safety_checked=True,
        content_verified=True,
        annotation_confidence=0.97,
        future_methods=(),
        cognitive_load=0.25,
        role="training",
        seen_before=False,
    )
    return SyntheticQuestion(
        question_id=item.item_id,
        stem="将 x^2 - 6x + 5 写成 (x - h)^2 + k 的形式。",
        accepted_steps=(
            ("x^2 - 6x + 5",),
            ("(x - 3)^2 - 4", "(x - 3)^2 - 9 + 5"),
        ),
        curriculum_item=item,
        error_signatures=(
            (MISCONCEPTION_NO_COMPENSATION, "(x - 3)^2 + 5"),
            (MISCONCEPTION_SQUARE_SIGN, "(x + 3)^2 - 4"),
        ),
        reference_verified=True,
    )


def capture_synthetic_photo() -> SyntheticPhoto:
    """Return a synthetic photo fixture without touching the filesystem."""
    question = synthetic_question()
    return SyntheticPhoto(
        image_ref="synthetic://demo/completing_square_01.png",
        ocr_confidence=0.98,
        question=question,
        student_steps=("x^2 - 6x + 5", "(x - 3)^2 + 5"),
    )


def grade_synthetic_trace(
    question: SyntheticQuestion,
    steps: Iterable[str],
    *,
    hints_used: int = 0,
) -> GradedTrace:
    """Check scripted steps against the verified reference and localise the error.

    This is intentionally *not* a general math grader.  It demonstrates the
    contract (verified reference first, first invalid step as evidence) with
    synthetic data only.
    """
    if not question.reference_verified:
        raise DemoError("question reference must be verified before grading")
    if isinstance(hints_used, bool) or not isinstance(hints_used, int) or hints_used < 0:
        raise DemoError("hints_used must be a non-negative integer")

    submitted_steps = tuple(str(step) for step in steps)
    checks: list[StepCheck] = []
    misconceptions: list[str] = []
    first_invalid: int | None = None
    total = max(len(question.accepted_steps), len(submitted_steps))

    for index in range(total):
        accepted = (
            question.accepted_steps[index]
            if index < len(question.accepted_steps)
            else ()
        )
        submitted = submitted_steps[index] if index < len(submitted_steps) else ""
        normalized_submitted = _normalize_step(submitted)
        ok = bool(accepted) and any(
            normalized_submitted == _normalize_step(variant) for variant in accepted
        )
        if not ok and first_invalid is None:
            first_invalid = index + 1
        if not ok:
            for misconception, signature in question.error_signatures:
                if normalized_submitted == _normalize_step(signature):
                    if misconception not in misconceptions:
                        misconceptions.append(misconception)
        checks.append(
            StepCheck(
                index=index + 1,
                submitted=submitted,
                expected=" | ".join(accepted),
                ok=ok,
            )
        )

    correct = (
        first_invalid is None
        and len(submitted_steps) == len(question.accepted_steps)
    )
    return GradedTrace(
        question_id=question.question_id,
        correct=correct,
        checks=tuple(checks),
        first_invalid_step=first_invalid,
        misconception_ids=tuple(misconceptions),
        hints_used=hints_used,
    )


def _probe_item(
    item_id: str,
    required_kcs: tuple[str, ...],
    *,
    cognitive_load: float,
    grade_level: int = 8,
    future_methods: tuple[str, ...] = (),
) -> CurriculumItem:
    return CurriculumItem(
        item_id=item_id,
        required_kcs=required_kcs,
        grade_level=grade_level,
        safety_checked=True,
        content_verified=True,
        annotation_confidence=0.96,
        future_methods=future_methods,
        cognitive_load=cognitive_load,
        role="diagnostic",
        seen_before=False,
    )


def synthetic_probes(
    progress: LearnerProgress | None = None,
) -> tuple[SyntheticProbe, ...]:
    """Build diagnostic probes and let the curriculum gate annotate them."""
    progress = progress or synthetic_progress()
    definitions = (
        SyntheticProbe(
            candidate=DiagnosticCandidate(
                item_id="demo.probe.expand_square",
                predictions={
                    "h.no_compensation": 0.75,
                    "h.square_formula_error": 0.15,
                    "h.occasional_slip": 0.85,
                },
                time_minutes=1.5,
                risk=0.05,
                cognitive_load=0.10,
                teaching_value=0.30,
                required_kcs=(KC_SQUARE_FORMULA,),
            ),
            curriculum_item=_probe_item(
                "demo.probe.expand_square", (KC_SQUARE_FORMULA,), cognitive_load=0.10
            ),
            stem="展开 (x - 3)^2，并说明它和原式相差多少。",
            synthetic_response_correct=True,
        ),
        SyntheticProbe(
            candidate=DiagnosticCandidate(
                item_id="demo.probe.identity_check",
                predictions={
                    "h.no_compensation": 0.25,
                    "h.square_formula_error": 0.55,
                    "h.occasional_slip": 0.80,
                },
                time_minutes=2.0,
                risk=0.05,
                cognitive_load=0.15,
                teaching_value=0.40,
                required_kcs=(KC_COMPLETING_SQUARE,),
            ),
            curriculum_item=_probe_item(
                "demo.probe.identity_check",
                (KC_COMPLETING_SQUARE,),
                cognitive_load=0.15,
            ),
            stem="取 x = 0（或比较两边），检验 (x - 3)^2 + 5 与原式是否恒等。",
            synthetic_response_correct=False,
        ),
        # This deliberately attractive probe is outside the taught set.  The
        # gate must reject it even though its predicted information gain is
        # high; the demo then proves the selector never chooses it.
        SyntheticProbe(
            candidate=DiagnosticCandidate(
                item_id="demo.probe.future_derivative",
                predictions={
                    "h.no_compensation": 0.99,
                    "h.square_formula_error": 0.01,
                    "h.occasional_slip": 0.50,
                },
                time_minutes=1.0,
                risk=0.05,
                cognitive_load=0.10,
                teaching_value=1.0,
                required_kcs=(KC_CALCULUS_DERIVATIVE,),
            ),
            curriculum_item=_probe_item(
                "demo.probe.future_derivative",
                (KC_CALCULUS_DERIVATIVE,),
                cognitive_load=0.10,
                grade_level=10,
                future_methods=("calculus.limit",),
            ),
            stem="用导数求二次函数最值。（超前知识，演示中必须拒绝）",
            synthetic_response_correct=True,
        ),
    )

    gated: list[SyntheticProbe] = []
    for probe in definitions:
        decision = allow(probe.curriculum_item, progress, MODE_LEARN)
        gated.append(
            replace(
                probe,
                candidate=replace(
                    probe.candidate, gate_allowed=decision.allowed
                ),
            )
        )
    return tuple(gated)


def _review_package() -> InterventionPackage:
    training = _probe_item(
        "demo.review.train_01", (KC_SQUARE_FORMULA,), cognitive_load=0.10
    )
    transfer = replace(
        _probe_item(
            "demo.review.transfer_01",
            (KC_COMPLETING_SQUARE, KC_SQUARE_FORMULA),
            cognitive_load=0.20,
        ),
        role="transfer",
        seen_before=False,
    )
    return InterventionPackage(
        package_id="demo.pkg.review_01",
        objective_id="obj.completing_square_compensation",
        training_items=(training,),
        transfer_items=(transfer,),
        hint_ladder=("concept_hint", "step_hint", "worked_example"),
        feedback_templates={
            "bug.no_compensation": "配方时减去平方项，必须保持等式恒等。"
        },
        explanation_resources=("demo.micro_lesson.completing_square",),
        completion_criteria={"independent_accuracy": 0.8, "max_hints": 1},
        required_kcs=(KC_SQUARE_FORMULA, KC_COMPLETING_SQUARE),
        independent_transfer=True,
        school_mode=MODE_REVIEW,
    )


@dataclass(frozen=True)
class DemoResult:
    """Everything the demo observed, with synthetic-only provenance."""

    student_ref: str
    synthetic_data_only: bool
    photo: SyntheticPhoto
    gate: GateDecision
    grade: GradedTrace
    mastery_after_grade: KnowledgeEstimate
    mastery_after_probe: KnowledgeEstimate
    initial_weights: Mapping[str, float]
    posterior_weights: Mapping[str, float]
    dominant_hypothesis_id: str | None
    probe: ProbeSelection
    probe_answered_correctly: bool
    blocked_probe_ids: tuple[str, ...]
    hinted_memory: MemoryState
    memory: MemoryState
    review_interval_days: float
    review_due_at: datetime
    review_package: InterventionPackage
    review_receipt: DeliveryReceipt
    twin_state: TwinState
    report_events: tuple[AggregateEvent, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "initial_weights", MappingProxyType(dict(self.initial_weights))
        )
        object.__setattr__(
            self, "posterior_weights", MappingProxyType(dict(self.posterior_weights))
        )

    def to_dict(self) -> dict[str, Any]:
        """JSON-friendly demo transcript (the synthetic stem may be included)."""
        return {
            "demo": {
                "synthetic_data_only": self.synthetic_data_only,
                "student_ref": self.student_ref,
                "photo_ref": self.photo.image_ref,
                "ocr_confidence": self.photo.ocr_confidence,
            },
            "photo": {
                "question_id": self.photo.question.question_id,
                "stem": self.photo.question.stem,
                "student_steps": list(self.photo.student_steps),
                "gate": {
                    "allowed": self.gate.allowed,
                    "reasons": list(self.gate.reasons),
                    "mode": self.gate.mode,
                },
            },
            "grading": {
                "correct": self.grade.correct,
                "first_invalid_step": self.grade.first_invalid_step,
                "misconception_ids": list(self.grade.misconception_ids),
                "hints_used": self.grade.hints_used,
                "checks": [
                    {
                        "index": check.index,
                        "ok": check.ok,
                        "submitted": check.submitted,
                        "expected": check.expected,
                    }
                    for check in self.grade.checks
                ],
            },
            "diagnosis": {
                "selected_probe": self.probe.item_id,
                "score": round(self.probe.score, 6),
                "information_gain": round(self.probe.information_gain, 6),
                "answered_correctly": self.probe_answered_correctly,
                "dominant_hypothesis": self.dominant_hypothesis_id,
                "initial_weights": dict(self.initial_weights),
                "posterior_weights": dict(self.posterior_weights),
                "blocked_probe_ids": list(self.blocked_probe_ids),
            },
            "review": {
                "memory_unit_id": self.memory.memory_unit_id,
                "stability_days": round(self.memory.stability_days, 6),
                "independent_success_count": self.memory.independent_success_count,
                "hinted_independent_success_count": (
                    self.hinted_memory.independent_success_count
                ),
                "uncertainty": self.memory.uncertainty,
                "interval_days": round(self.review_interval_days, 6),
                "review_due_at": self.review_due_at.isoformat(),
                "package_id": self.review_receipt.package_id,
                "delivered_item_ids": list(self.review_receipt.item_ids),
            },
            "twin": {
                "version": self.twin_state.version,
                "evidence_ids": sorted(self.twin_state.observed_evidence_ids),
                "mastery": {
                    kc_id: {
                        "mastery_mean": round(estimate.mastery_mean, 6),
                        "uncertainty": round(estimate.uncertainty, 6),
                        "evidence_ids": list(estimate.evidence_ids),
                        "exposure_state": estimate.exposure_state,
                    }
                    for kc_id, estimate in sorted(
                        self.twin_state.knowledge.items()
                    )
                },
            },
        }

    def render_text(self) -> str:
        """Human-readable Chinese transcript for the CLI demo."""
        lines = [
            "=== AEH Step 2 合成演示：拍题 → 批改 → 诊断 → 复习 ===",
            "数据声明：仅使用内置合成 fixture；不读取文件、不连接网络、"
            "不含真实学生数据。",
            "",
            f"[拍题] {self.photo.image_ref}（合成 OCR 置信度 "
            f"{self.photo.ocr_confidence:.0%}）",
            f"  题目：{self.photo.question.stem}",
            f"  课程门禁：{'允许' if self.gate.allowed else '拒绝'}"
            f"（mode={self.gate.mode}）",
            f"  学生步骤：{' → '.join(self.photo.student_steps)}",
            "",
            f"[批改] 首错步骤：第 {self.grade.first_invalid_step} 步；"
            f"识别错因：{', '.join(self.grade.misconception_ids) or '未匹配'}",
            f"  掌握度估计（证据支持）："
            f"{self.mastery_after_grade.mastery_mean:.2f} "
            f"± {self.mastery_after_grade.uncertainty:.2f}",
            f"  孪生版本：v{self.twin_state.version}；证据只追加，不修改历史。",
            "",
            f"[诊断] 初始假设权重：{_format_weights(self.initial_weights)}",
            f"  选择探针：{self.probe.item_id}"
            f"（IG={self.probe.information_gain:.3f}, score={self.probe.score:.3f}）",
            f"  合成学生作答：{'正确' if self.probe_answered_correctly else '错误'}",
            f"  后验权重：{_format_weights(self.posterior_weights)}；"
            f"主导假设：{self.dominant_hypothesis_id or 'unknown'}",
            f"  被门禁拒绝的超前探针："
            f"{', '.join(self.blocked_probe_ids) or '无'}",
            f"  掌握度更新（仅基于真实证据路径）："
            f"{self.mastery_after_probe.mastery_mean:.2f} "
            f"± {self.mastery_after_probe.uncertainty:.2f}",
            "",
            f"[复习] 提示后成功：独立成功计数 "
            f"{self.hinted_memory.independent_success_count}（不算独立检索）",
            f"  独立复习后：独立成功计数 {self.memory.independent_success_count}；"
            f"稳定性 {self.memory.stability_days:.2f} 天",
            f"  下次复习：{self.review_due_at.isoformat()}"
            f"（约 {self.review_interval_days:.2f} 天后）",
            f"  复习包已通过门禁并交付：{self.review_receipt.package_id}"
            f"（{', '.join(self.review_receipt.item_ids)}）",
            "",
            "[汇总] 报告只消费已授权聚合事件；不输出原始图片、题目、"
            "作答文本或事件 ID。",
            "",
        ]
        return "\n".join(lines)


def _format_weights(weights: Mapping[str, float]) -> str:
    return "，".join(
        f"{name}={value:.3f}" for name, value in sorted(weights.items())
    )


class DemoSession:
    """Run the synthetic closed loop against a fresh :class:`StudentTwin`."""

    def __init__(
        self,
        *,
        student_id: str = SYNTHETIC_STUDENT_ID,
        base_time: datetime = DEMO_BASE_TIME,
    ) -> None:
        if not student_id.startswith("demo."):
            raise DemoError("the demo only accepts synthetic demo.* student ids")
        if base_time.tzinfo is None:
            raise DemoError("base_time must be timezone-aware")
        self.student_id = student_id
        self.base_time = base_time
        self.progress = replace(synthetic_progress(), student_id=student_id)
        self.twin = StudentTwin(student_id)
        self._photo = capture_synthetic_photo()

    def _at(self, minutes: int) -> datetime:
        return self.base_time + timedelta(minutes=minutes)

    def run(self) -> DemoResult:
        photo = self._photo
        gate = allow(photo.question.curriculum_item, self.progress, MODE_LEARN)
        if not gate.allowed:
            raise DemoError(
                "synthetic question unexpectedly rejected: "
                + ", ".join(gate.reasons)
            )

        upload = self.twin.record_observed(
            Event(
                event_id="demo.evt.question_001",
                event_type="QUESTION_IMAGE_UPLOADED",
                source="student",
                occurred_at=self._at(0),
                observed_at=self._at(1),
                student_id=self.student_id,
                payload={
                    "synthetic": True,
                    "image_ref": photo.image_ref,
                    "question_id": photo.question.question_id,
                },
                provenance="step2_synthetic_demo",
                model_versions={"ocr": "demo-fixture-v1"},
                consent_scope="educational_assistance",
            )
        )
        trace = self.twin.record_observed(
            Event(
                event_id="demo.evt.trace_001",
                event_type="STUDENT_TRACE_SUBMITTED",
                source="student",
                occurred_at=self._at(1),
                observed_at=self._at(1),
                student_id=self.student_id,
                payload={
                    "synthetic": True,
                    "question_id": photo.question.question_id,
                    "step_count": len(photo.student_steps),
                },
                provenance="step2_synthetic_demo",
                model_versions={"ocr": "demo-fixture-v1"},
                consent_scope="educational_assistance",
            )
        )

        grade = grade_synthetic_trace(photo.question, photo.student_steps)
        grade_event = self.twin.record_observed(
            Event(
                event_id="demo.evt.grade_001",
                event_type="ASSESSMENT_GRADED",
                source="trusted_grader",
                occurred_at=self._at(2),
                observed_at=self._at(2),
                student_id=self.student_id,
                payload={
                    "synthetic": True,
                    "question_id": photo.question.question_id,
                    "correct": grade.correct,
                    "first_invalid_step": grade.first_invalid_step,
                    "misconception_ids": grade.misconception_ids,
                },
                provenance="demo-scripted-grader-v1",
                model_versions={"grader": "demo-scripted-v1", "ocr": "demo-fixture-v1"},
                consent_scope="educational_assistance",
            )
        )
        mastery_after_grade = self.twin.update_mastery(
            KC_COMPLETING_SQUARE,
            0.42,
            0.25,
            [grade_event.event_id],
            exposure_state="observed",
        )

        hypotheses = HypothesisSet(
            [
                Hypothesis(
                    hypothesis_id="h.no_compensation",
                    subject_scope=(KC_COMPLETING_SQUARE,),
                    knowledge_assumptions={
                        KC_COMPLETING_SQUARE: "missing_compensation"
                    },
                    bug_rules=(MISCONCEPTION_NO_COMPENSATION,),
                    predicted_observable_behaviors={
                        "identity_check_incorrect": 0.75
                    },
                    weight=0.40,
                ),
                Hypothesis(
                    hypothesis_id="h.square_formula_error",
                    subject_scope=(KC_SQUARE_FORMULA,),
                    knowledge_assumptions={
                        KC_SQUARE_FORMULA: "sign_or_expansion_error"
                    },
                    bug_rules=(MISCONCEPTION_SQUARE_SIGN,),
                    predicted_observable_behaviors={
                        "expand_square_incorrect": 0.85
                    },
                    weight=0.30,
                ),
                Hypothesis(
                    hypothesis_id="h.occasional_slip",
                    subject_scope=(KC_COMPLETING_SQUARE,),
                    knowledge_assumptions={KC_COMPLETING_SQUARE: "transient_slip"},
                    weight=0.20,
                ),
            ],
            unknown_weight=0.10,
        )
        initial_weights = hypotheses.reweight(
            {
                "h.no_compensation": 0.92,
                "h.square_formula_error": 0.45,
                "h.occasional_slip": 0.18,
            },
            evidence_id=grade_event.event_id,
            noise=0.05,
        )

        probes = synthetic_probes(self.progress)
        diagnosis = DiagnosisSession(
            hypotheses.weights(),
            ProbeWeights(alpha=0.2, beta=0.1, gamma=0.5, delta=0.1),
        )
        selection = diagnosis.select(probe.candidate for probe in probes)
        if selection is None:
            raise DemoError("no gate-allowed diagnostic probe was available")
        by_id = {probe.candidate.item_id: probe for probe in probes}
        selected_probe = by_id[selection.item_id]
        diagnosis.observe(
            selected_probe.candidate,
            correct=selected_probe.synthetic_response_correct,
        )

        probe_event = self.twin.record_observed(
            Event(
                event_id="demo.evt.probe_001",
                event_type="ASSESSMENT_GRADED",
                source="trusted_grader",
                occurred_at=self._at(4),
                observed_at=self._at(4),
                student_id=self.student_id,
                payload={
                    "synthetic": True,
                    "probe_id": selected_probe.candidate.item_id,
                    "correct": selected_probe.synthetic_response_correct,
                },
                provenance="demo-scripted-grader-v1",
                model_versions={"grader": "demo-scripted-v1"},
                consent_scope="educational_assistance",
            )
        )
        likelihoods = {
            hypothesis_id: (
                selected_probe.candidate.probability_correct(hypothesis_id)
                if selected_probe.synthetic_response_correct
                else 1.0
                - selected_probe.candidate.probability_correct(hypothesis_id)
            )
            for hypothesis_id in (
                "h.no_compensation",
                "h.square_formula_error",
                "h.occasional_slip",
            )
        }
        posterior = hypotheses.reweight(
            likelihoods, evidence_id=probe_event.event_id, noise=0.05
        )
        dominant = hypotheses.dominant()

        mastery_after_probe = self.twin.update_mastery(
            KC_COMPLETING_SQUARE,
            0.30,
            0.18,
            [grade_event.event_id, probe_event.event_id],
            exposure_state="observed",
        )
        self.twin.set_unresolved_hypotheses(
            hypothesis.hypothesis_id for hypothesis in hypotheses.active()
        )

        memory = MemoryState(
            learner_id=self.student_id,
            memory_unit_id=KC_SQUARE_FORMULA,
            model_family="fsrs_compatible",
            model_version="fsrs_illustrative_19_81",
        )
        hinted_memory = update_memory(
            memory,
            MemoryObservation(
                observation_id="demo.evt.memory_hinted_001",
                success=True,
                independent=False,
                hint_level=2,
                kind=KIND_ATTEMPT,
                occurred_at=self._at(5),
            ),
        )
        independent_memory = update_memory(
            hinted_memory,
            MemoryObservation(
                observation_id="demo.evt.memory_independent_001",
                success=True,
                independent=True,
                hint_level=0,
                kind=KIND_ATTEMPT,
                occurred_at=self._at(7),
            ),
        )
        interval_days = independent_memory.next_review_interval_days(0.9)
        review_due_at = (
            independent_memory.last_independent_success_at
            + timedelta(days=interval_days)
        )

        review_package = _review_package()
        review_receipt = deliver(
            review_package,
            self.progress,
            mode=MODE_REVIEW,
            delivered_at=self._at(9),
        )
        self.twin.record_observed(
            Event(
                event_id="demo.evt.review_001",
                event_type="REVIEW_COMPLETED",
                source="student",
                occurred_at=self._at(10),
                observed_at=self._at(10),
                student_id=self.student_id,
                payload={
                    "synthetic": True,
                    "memory_unit_id": independent_memory.memory_unit_id,
                    "independent_success": True,
                    "package_id": review_receipt.package_id,
                },
                provenance="step2_synthetic_demo",
                model_versions={"memory": independent_memory.model_version},
                consent_scope="educational_assistance",
            )
        )

        # These are *aggregates* for the whole demo window, including one
        # earlier synthetic practice attempt on the square-formula KC.  The
        # report never consumes the raw events above.
        report_events = (
            AggregateEvent(
                event_id="demo.report.completing.001",
                student_ref=self.student_id,
                occurred_at=self._at(10),
                kind=REPORT_KIND_ATTEMPT,
                consent_scope="educational_report",
                kc_id=KC_COMPLETING_SQUARE,
                attempts=3,
                independent_correct=0,
                hinted_correct=0,
                hints_requested=2,
                minutes=8.5,
            ),
            AggregateEvent(
                event_id="demo.report.square.001",
                student_ref=self.student_id,
                occurred_at=self._at(10),
                kind=REPORT_KIND_ATTEMPT,
                consent_scope="educational_report",
                kc_id=KC_SQUARE_FORMULA,
                attempts=2,
                independent_correct=1,
                hinted_correct=1,
                hints_requested=1,
                reviews_due=1,
                reviews_completed=1,
                minutes=3.0,
            ),
        )

        # ``upload``/``trace`` exist for audit; grading and probe evidence are
        # what back the mastery updates.  Keep the references explicit so a
        # linter or reviewer sees the full evidence chain.
        assert upload.event_id in self.twin.observed_evidence_ids
        assert trace.event_id in self.twin.observed_evidence_ids

        return DemoResult(
            student_ref=self.student_id,
            synthetic_data_only=True,
            photo=photo,
            gate=gate,
            grade=grade,
            mastery_after_grade=mastery_after_grade,
            mastery_after_probe=mastery_after_probe,
            initial_weights=initial_weights,
            posterior_weights=posterior,
            dominant_hypothesis_id=(
                dominant.hypothesis_id if dominant is not None else None
            ),
            probe=selection,
            probe_answered_correctly=selected_probe.synthetic_response_correct,
            blocked_probe_ids=tuple(
                probe.candidate.item_id
                for probe in probes
                if not probe.candidate.gate_allowed
            ),
            hinted_memory=hinted_memory,
            memory=independent_memory,
            review_interval_days=interval_days,
            review_due_at=review_due_at,
            review_package=review_package,
            review_receipt=review_receipt,
            twin_state=self.twin.state,
            report_events=report_events,
        )


def run_demo() -> DemoResult:
    """Convenience wrapper used by the CLI and tests."""
    return DemoSession().run()


__all__ = [
    "SYNTHETIC_STUDENT_ID",
    "DEMO_BASE_TIME",
    "DEMO_WINDOW_START",
    "DEMO_WINDOW_END",
    "KC_SQUARE_FORMULA",
    "KC_COMPLETING_SQUARE",
    "KC_QUADRATIC_MAXMIN",
    "KC_QUADRATIC_GRAPH",
    "KC_CALCULUS_DERIVATIVE",
    "MISCONCEPTION_NO_COMPENSATION",
    "MISCONCEPTION_SQUARE_SIGN",
    "DemoError",
    "SyntheticQuestion",
    "SyntheticPhoto",
    "SyntheticProbe",
    "StepCheck",
    "GradedTrace",
    "DemoResult",
    "DemoSession",
    "synthetic_progress",
    "synthetic_question",
    "capture_synthetic_photo",
    "grade_synthetic_trace",
    "synthetic_probes",
    "run_demo",
]
