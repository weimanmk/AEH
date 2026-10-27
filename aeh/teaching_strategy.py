"""Teaching strategy, daily coordination, cross-subject adaptation (spec §10/§17/§18).

This module is deliberately a *policy* layer, not a delivery layer.  It chooses
what the harness should do next and which learning-science method should shape
the interaction, but every actual item still has to pass
:mod:`aeh.curriculum_gate` (and, for the dsh plugin, the host approval path).
Nothing here writes a long-term twin, reads raw student data, or starts a
network process.

The three pieces of Step 15 are:

* **Strategy router** (:func:`select_strategy`) -- implements the actions of
  spec §10.1 from mode, knowledge distribution, hypothesis conflict, forgetting
  queue, school schedule, task intent and time budget.  Fail-closed guardrails
  cover unconfirmed school progress, unconfirmed preview, exam scope, time /
  load budgets, assessments, and simulated evidence used for a production
  decision.
* **Daily coordination** (:func:`plan_daily_coordination`) -- the
  preview → school learning → AI reinforcement → review rhythm of spec §10.2.
  School time is explicitly *unobserved*: the plan records teaching-contact
  metadata only, never an inferred mastery.  Time allocation is dynamic
  (spec §10.3) and always bounded by the learner's budget and break preference.
* **Cross-subject adapter** (:class:`SubjectAdapter`, ``MATH_SUBJECT``,
  ``PHYSICS_SUBJECT``) -- a subject-agnostic KC / evidence / strategy contract
  with two concrete examples.  Validators, evidence kinds, safety review and
  strategy affinities stay subject-specific (spec §17); the orchestration
  interface is shared.
* **Learning-science mapping** -- ``LEARNING_SCIENCE_METHODS`` maps every method
  in the spec §18 table to concrete harness actions and verification, with
  runnable plans for retrieval practice, spaced practice and interleaving
  (:func:`plan_retrieval_practice`, :func:`plan_spaced_review`,
  :func:`plan_interleaved_practice`).

The TypeScript counterpart is ``dsh-plugin/src/core/teaching-strategy.ts``; the
shared fixture ``tests/fixtures/teaching_strategy_step15.json`` keeps the two
implementations behaviourally aligned.  Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Iterable, Mapping, Sequence

from .curriculum_gate import (
    DEFAULT_MIN_PROGRESS_CONFIDENCE,
    MODE_LEARN,
    MODE_PREVIEW,
    MODE_REVIEW,
)
from .memory import interval_for_target, retrievability


class TeachingStrategyError(ValueError):
    """Raised when a strategy input or method plan violates its contract."""


class SubjectAdapterError(TeachingStrategyError):
    """Raised for unknown or duplicate subject adapters."""


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

#: Daily coordination phases (spec §10.2).  ``school`` is explicitly
#: unobserved; it is present in the plan so the absence of data is visible.
PHASE_PREVIEW = "preview"
PHASE_SCHOOL = "school"
PHASE_AI_REINFORCEMENT = "ai_reinforcement"
PHASE_REVIEW = "review"

DAILY_PHASES: tuple[str, ...] = (
    PHASE_PREVIEW,
    PHASE_SCHOOL,
    PHASE_AI_REINFORCEMENT,
    PHASE_REVIEW,
)

#: Teaching actions from spec §10.1 plus an internal no-op for blocked plans.
ACTION_ASK_DIAGNOSTIC_QUESTION = "ask_diagnostic_question"
ACTION_GIVE_MINIMAL_HINT = "give_minimal_hint"
ACTION_SHOW_WORKED_EXAMPLE = "show_worked_example"
ACTION_TEACH_MICRO_LESSON = "teach_micro_lesson"
ACTION_ASSIGN_TARGETED_PRACTICE = "assign_targeted_practice"
ACTION_ASSIGN_TRANSFER_TASK = "assign_transfer_task"
ACTION_SCHEDULE_SPACED_REVIEW = "schedule_spaced_review"
ACTION_REQUEST_PROGRESS_CONFIRMATION = "request_progress_confirmation"
ACTION_ANSWER_DIRECTLY = "answer_directly"
ACTION_NONE = "no_action"

STRATEGY_ACTIONS: tuple[str, ...] = (
    ACTION_ASK_DIAGNOSTIC_QUESTION,
    ACTION_GIVE_MINIMAL_HINT,
    ACTION_SHOW_WORKED_EXAMPLE,
    ACTION_TEACH_MICRO_LESSON,
    ACTION_ASSIGN_TARGETED_PRACTICE,
    ACTION_ASSIGN_TRANSFER_TASK,
    ACTION_SCHEDULE_SPACED_REVIEW,
    ACTION_REQUEST_PROGRESS_CONFIRMATION,
    ACTION_ANSWER_DIRECTLY,
)

INTENT_PRACTICE = "practice"
INTENT_REVIEW = "review"
INTENT_PREVIEW = "preview"
INTENT_DIAGNOSE = "diagnose"
INTENT_HOMEWORK_HELP = "homework_help"
INTENT_ANSWER_QUESTION = "answer_question"
INTENT_TRANSFER = "transfer"

TASK_INTENTS: tuple[str, ...] = (
    INTENT_PRACTICE,
    INTENT_REVIEW,
    INTENT_PREVIEW,
    INTENT_DIAGNOSE,
    INTENT_HOMEWORK_HELP,
    INTENT_ANSWER_QUESTION,
    INTENT_TRANSFER,
)

URGENCY_NORMAL = "normal"
URGENCY_TIME_PRESSURE = "time_pressure"
URGENCIES: tuple[str, ...] = (URGENCY_NORMAL, URGENCY_TIME_PRESSURE)

PURPOSE_PRODUCTION = "production"
PURPOSE_SIMULATION = "simulation"

SOURCE_OBSERVED = "observed"
SOURCE_TEACHER_CONFIRMED = "teacher_confirmed"
SOURCE_SCHOOL_CONFIRMED = "school_confirmed"
SOURCE_SIMULATED = "simulated"

#: Sources allowed to drive a production strategy decision.
REAL_STRATEGY_SOURCES: frozenset[str] = frozenset(
    {SOURCE_OBSERVED, SOURCE_TEACHER_CONFIRMED, SOURCE_SCHOOL_CONFIRMED}
)
ALL_STRATEGY_SOURCES: frozenset[str] = REAL_STRATEGY_SOURCES | {SOURCE_SIMULATED}

BREAK_PREFERENCES: tuple[str, ...] = ("none", "short", "balanced", "long")
BREAK_MINUTES = {"none": 0.0, "short": 3.0, "balanced": 5.0, "long": 10.0}

METHOD_RETRIEVAL_PRACTICE = "retrieval_practice"
METHOD_SPACED_PRACTICE = "spaced_practice"
METHOD_INTERLEAVING = "interleaving"
METHOD_WORKED_EXAMPLES = "worked_examples"
METHOD_FADING_SCAFFOLDS = "fading_scaffolds"
METHOD_SELF_EXPLANATION = "self_explanation"
METHOD_ELABORATIVE_INTERROGATION = "elaborative_interrogation"
METHOD_CONTRASTIVE_LEARNING = "contrastive_learning"
METHOD_PRODUCTIVE_FAILURE = "productive_failure"
METHOD_MASTERY_LEARNING = "mastery_learning"
METHOD_METACOGNITIVE_PROMPTS = "metacognitive_prompts"
METHOD_DUAL_CODING = "dual_coding"
METHOD_COGNITIVE_LOAD_CONTROL = "cognitive_load_control"
METHOD_ERROR_FOCUSED_PRACTICE = "error_focused_practice"
METHOD_NEAR_FAR_TRANSFER = "near_far_transfer"
METHOD_SELF_REGULATED_LEARNING = "self_regulated_learning"

#: The three methods with executable Step-15 planners (spec §18 table rows 1-3).
IMPLEMENTED_METHOD_IDS: tuple[str, ...] = (
    METHOD_RETRIEVAL_PRACTICE,
    METHOD_SPACED_PRACTICE,
    METHOD_INTERLEAVING,
)

DEFAULT_MASTERY_FLOOR = 0.35
DEFAULT_INTERLEAVING_MASTERY = 0.6
DEFAULT_PROCEDURAL_ERROR_THRESHOLD = 0.25
DEFAULT_REVIEW_TARGET_RETENTION = 0.9

ACTION_METHODS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        ACTION_ASK_DIAGNOSTIC_QUESTION: (METHOD_METACOGNITIVE_PROMPTS,),
        ACTION_GIVE_MINIMAL_HINT: (METHOD_FADING_SCAFFOLDS,),
        ACTION_SHOW_WORKED_EXAMPLE: (
            METHOD_WORKED_EXAMPLES,
            METHOD_COGNITIVE_LOAD_CONTROL,
        ),
        ACTION_TEACH_MICRO_LESSON: (
            METHOD_SELF_EXPLANATION,
            METHOD_CONTRASTIVE_LEARNING,
            METHOD_WORKED_EXAMPLES,
        ),
        ACTION_ASSIGN_TARGETED_PRACTICE: (
            METHOD_RETRIEVAL_PRACTICE,
            METHOD_ERROR_FOCUSED_PRACTICE,
            METHOD_FADING_SCAFFOLDS,
        ),
        ACTION_ASSIGN_TRANSFER_TASK: (
            METHOD_NEAR_FAR_TRANSFER,
            METHOD_RETRIEVAL_PRACTICE,
        ),
        ACTION_SCHEDULE_SPACED_REVIEW: (
            METHOD_SPACED_PRACTICE,
            METHOD_RETRIEVAL_PRACTICE,
            METHOD_INTERLEAVING,
        ),
        ACTION_REQUEST_PROGRESS_CONFIRMATION: (),
        ACTION_ANSWER_DIRECTLY: (),
        ACTION_NONE: (),
    }
)

ACTION_MINUTES: Mapping[str, float] = MappingProxyType(
    {
        ACTION_ASK_DIAGNOSTIC_QUESTION: 6.0,
        ACTION_GIVE_MINIMAL_HINT: 3.0,
        ACTION_SHOW_WORKED_EXAMPLE: 12.0,
        ACTION_TEACH_MICRO_LESSON: 15.0,
        ACTION_ASSIGN_TARGETED_PRACTICE: 15.0,
        ACTION_ASSIGN_TRANSFER_TASK: 18.0,
        ACTION_SCHEDULE_SPACED_REVIEW: 10.0,
        ACTION_REQUEST_PROGRESS_CONFIRMATION: 1.0,
        ACTION_ANSWER_DIRECTLY: 5.0,
        ACTION_NONE: 0.0,
    }
)


def _round1(value: float) -> float:
    return round(float(value) + 0.0, 1)


def _clamp01(value: float, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TeachingStrategyError(f"{name} must be a finite number")
    number = float(value)
    if not math.isfinite(number) or number < 0.0 or number > 1.0:
        raise TeachingStrategyError(f"{name} must be within [0, 1]")
    return number


def _dedupe(values: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return tuple(result)


# ---------------------------------------------------------------------------
# Strategy inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class KnowledgeState:
    """A per-KC state projection used by the policy layer (never written back)."""

    kc_id: str
    mastery_mean: float
    uncertainty: float = 0.0
    prerequisite_ready: bool = True
    conceptual_misconception: bool = False
    procedural_error_rate: float = 0.0
    learned: bool = True
    target_retention: float = DEFAULT_REVIEW_TARGET_RETENTION

    def __post_init__(self) -> None:
        if not isinstance(self.kc_id, str) or not self.kc_id:
            raise TeachingStrategyError("kc_id must be a non-empty string")
        _clamp01(self.mastery_mean, "mastery_mean")
        _clamp01(self.uncertainty, "uncertainty")
        _clamp01(self.procedural_error_rate, "procedural_error_rate")
        _clamp01(self.target_retention, "target_retention")
        if not 0.0 < self.target_retention < 1.0:
            raise TeachingStrategyError("target_retention must be within (0, 1)")


@dataclass(frozen=True)
class DueReview:
    """A memory unit that is due for spaced retrieval (spec §8/§18)."""

    kc_id: str
    stability_days: float
    elapsed_days: float = 0.0
    target_retention: float = DEFAULT_REVIEW_TARGET_RETENTION
    due: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.kc_id, str) or not self.kc_id:
            raise TeachingStrategyError("kc_id must be a non-empty string")
        if (
            not isinstance(self.stability_days, (int, float))
            or isinstance(self.stability_days, bool)
            or not math.isfinite(float(self.stability_days))
            or self.stability_days <= 0.0
        ):
            raise TeachingStrategyError("stability_days must be > 0")
        if (
            not isinstance(self.elapsed_days, (int, float))
            or isinstance(self.elapsed_days, bool)
            or not math.isfinite(float(self.elapsed_days))
            or self.elapsed_days < 0.0
        ):
            raise TeachingStrategyError("elapsed_days must be >= 0")
        _clamp01(self.target_retention, "target_retention")
        if not 0.0 < self.target_retention < 1.0:
            raise TeachingStrategyError("target_retention must be within (0, 1)")

    @property
    def retrievability(self) -> float:
        return retrievability(self.elapsed_days, self.stability_days)

    @property
    def interval_days(self) -> float:
        return interval_for_target(self.stability_days, self.target_retention)


@dataclass(frozen=True)
class LearnerConstraints:
    """Time, load and assessment constraints set by the learner/host."""

    available_minutes: float = 30.0
    max_block_minutes: float = 25.0
    max_items: int = 8
    break_preference: str = "balanced"
    homework_load: float = 0.0
    assessment_in_progress: bool = False
    allow_direct_answer: bool = True

    def __post_init__(self) -> None:
        if (
            not isinstance(self.available_minutes, (int, float))
            or isinstance(self.available_minutes, bool)
            or not math.isfinite(float(self.available_minutes))
            or self.available_minutes < 0.0
        ):
            raise TeachingStrategyError("available_minutes must be >= 0")
        if (
            not isinstance(self.max_block_minutes, (int, float))
            or isinstance(self.max_block_minutes, bool)
            or not math.isfinite(float(self.max_block_minutes))
            or self.max_block_minutes <= 0.0
        ):
            raise TeachingStrategyError("max_block_minutes must be > 0")
        if (
            not isinstance(self.max_items, int)
            or isinstance(self.max_items, bool)
            or self.max_items < 1
        ):
            raise TeachingStrategyError("max_items must be an integer >= 1")
        if self.break_preference not in BREAK_PREFERENCES:
            raise TeachingStrategyError(
                "break_preference must be one of " + ", ".join(BREAK_PREFERENCES)
            )
        _clamp01(self.homework_load, "homework_load")

    @property
    def break_minutes(self) -> float:
        return BREAK_MINUTES[self.break_preference]


@dataclass(frozen=True)
class SchoolContext:
    """What the school has confirmed, plus pressure signals (never inferred)."""

    next_lesson_confirmed: bool = False
    next_lesson_kcs: tuple[str, ...] = ()
    preview_allowed_kcs: tuple[str, ...] = ()
    progress_confirmed: bool = True
    progress_confidence: float = 1.0
    school_pressure: float = 0.5
    exam_upcoming: bool = False
    exam_scope_confirmed: bool = True
    exam_kcs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _clamp01(self.progress_confidence, "progress_confidence")
        _clamp01(self.school_pressure, "school_pressure")

    @property
    def progress_usable(self) -> bool:
        return (
            self.progress_confirmed
            and self.progress_confidence >= DEFAULT_MIN_PROGRESS_CONFIDENCE
        )

    @property
    def preview_kcs(self) -> tuple[str, ...]:
        allowed = set(self.preview_allowed_kcs)
        return tuple(kc for kc in _dedupe(self.next_lesson_kcs) if kc in allowed)


@dataclass(frozen=True)
class StrategyRequest:
    """Inputs of the strategy router (spec §10.1)."""

    intent: str = INTENT_PRACTICE
    mode: str = MODE_LEARN
    knowledge: tuple[KnowledgeState, ...] = ()
    due_reviews: tuple[DueReview, ...] = ()
    hypothesis_conflict: bool = False
    school: SchoolContext = field(default_factory=SchoolContext)
    constraints: LearnerConstraints = field(default_factory=LearnerConstraints)
    evidence_source: str = SOURCE_OBSERVED
    purpose: str = PURPOSE_PRODUCTION
    explicit_answer_request: bool = False
    urgency: str = URGENCY_NORMAL
    phase: str | None = None
    has_working_strategy: bool = False

    def __post_init__(self) -> None:
        if self.intent not in TASK_INTENTS:
            raise TeachingStrategyError("unknown intent: " + self.intent)
        if self.mode not in {MODE_PREVIEW, MODE_LEARN, MODE_REVIEW}:
            raise TeachingStrategyError("unknown mode: " + self.mode)
        if self.urgency not in URGENCIES:
            raise TeachingStrategyError("unknown urgency: " + self.urgency)
        if self.purpose not in {PURPOSE_PRODUCTION, PURPOSE_SIMULATION}:
            raise TeachingStrategyError("unknown purpose: " + self.purpose)
        if self.evidence_source not in ALL_STRATEGY_SOURCES:
            raise TeachingStrategyError(
                "unknown evidence_source: " + self.evidence_source
            )
        if self.phase is not None and self.phase not in DAILY_PHASES:
            raise TeachingStrategyError("unknown phase: " + self.phase)


@dataclass(frozen=True)
class StrategyDecision:
    """A policy decision; ``delivery_requires_gate`` is always true."""

    action: str
    mode: str
    phase: str
    target_kcs: tuple[str, ...]
    method_ids: tuple[str, ...]
    time_minutes: float
    reasons: tuple[str, ...]
    guardrails: tuple[str, ...]
    requires_confirmation: bool = False
    blocked: bool = False
    delivery_requires_gate: bool = True
    evidence_source: str = SOURCE_OBSERVED
    simulated_evidence_used: bool = False

    def __bool__(self) -> bool:
        return not self.blocked

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "mode": self.mode,
            "phase": self.phase,
            "targetKcs": list(self.target_kcs),
            "methodIds": list(self.method_ids),
            "timeMinutes": self.time_minutes,
            "reasons": list(self.reasons),
            "guardrails": list(self.guardrails),
            "requiresConfirmation": self.requires_confirmation,
            "blocked": self.blocked,
            "deliveryRequiresGate": self.delivery_requires_gate,
            "evidenceSource": self.evidence_source,
            "simulatedEvidenceUsed": self.simulated_evidence_used,
        }


BASE_GUARDRAILS: tuple[str, ...] = (
    "delivery_requires_curriculum_gate",
    "respect_learner_time_budget",
    "no_unbounded_practice",
)


def _decision(
    *,
    action: str,
    request: StrategyRequest,
    target_kcs: Iterable[str] = (),
    methods: Iterable[str] | None = None,
    reasons: Iterable[str] = (),
    guardrails: Iterable[str] = (),
    phase: str | None = None,
    requires_confirmation: bool = False,
    blocked: bool = False,
    time_minutes: float | None = None,
) -> StrategyDecision:
    method_ids = tuple(methods if methods is not None else ACTION_METHODS[action])
    if time_minutes is None:
        time_minutes = ACTION_MINUTES[action]
    time_minutes = max(0.0, min(_round1(time_minutes), request.constraints.available_minutes))
    if action == ACTION_NONE:
        time_minutes = 0.0
    return StrategyDecision(
        action=action,
        mode=request.mode,
        phase=phase or request.phase or PHASE_AI_REINFORCEMENT,
        target_kcs=_dedupe(target_kcs),
        method_ids=_dedupe(method_ids),
        time_minutes=time_minutes,
        reasons=tuple(reasons),
        guardrails=tuple(BASE_GUARDRAILS) + tuple(guardrails),
        requires_confirmation=requires_confirmation,
        blocked=blocked,
        evidence_source=request.evidence_source,
        simulated_evidence_used=request.evidence_source == SOURCE_SIMULATED,
    )


def _knowledge_map(
    knowledge: Sequence[KnowledgeState],
) -> dict[str, KnowledgeState]:
    return {state.kc_id: state for state in knowledge}


def _due_sorted(due_reviews: Iterable[DueReview]) -> list[DueReview]:
    due = [review for review in due_reviews if review.due]
    return sorted(due, key=lambda review: (review.retrievability, review.kc_id))


def _errors(knowledge: Sequence[KnowledgeState]) -> list[KnowledgeState]:
    errors = [
        state
        for state in knowledge
        if state.procedural_error_rate >= DEFAULT_PROCEDURAL_ERROR_THRESHOLD
    ]
    return sorted(
        errors,
        key=lambda state: (-state.procedural_error_rate, state.mastery_mean, state.kc_id),
    )


def _misconceptions(knowledge: Sequence[KnowledgeState]) -> list[KnowledgeState]:
    return sorted(
        (state for state in knowledge if state.conceptual_misconception),
        key=lambda state: (state.mastery_mean, state.kc_id),
    )


def _weak(knowledge: Sequence[KnowledgeState]) -> list[KnowledgeState]:
    weak = [
        state
        for state in knowledge
        if (not state.prerequisite_ready) or state.mastery_mean < DEFAULT_MASTERY_FLOOR
    ]
    return sorted(weak, key=lambda state: (state.mastery_mean, state.kc_id))


def _confirmation(
    request: StrategyRequest, reason: str, guardrail: str
) -> StrategyDecision:
    return _decision(
        action=ACTION_REQUEST_PROGRESS_CONFIRMATION,
        request=request,
        reasons=(reason,),
        guardrails=(guardrail,),
        requires_confirmation=True,
        phase=PHASE_AI_REINFORCEMENT,
        time_minutes=min(2.0, request.constraints.available_minutes),
    )


def select_strategy(request: StrategyRequest) -> StrategyDecision:
    """Choose the next teaching action with fail-closed guardrails.

    Rule order matters: provenance and safety boundaries run before pedagogy,
    confirmed school progress runs before any new content, and explicit-answer
    requests never force a diagnostic probe.  The returned decision only names
    a policy action; it never delivers an item.
    """
    # 1. Evidence provenance.  Simulated evidence can screen candidates inside
    #    a simulation lab, but it must never drive a real production decision.
    if request.purpose == PURPOSE_PRODUCTION:
        if request.evidence_source == SOURCE_SIMULATED:
            return _decision(
                action=ACTION_NONE,
                request=request,
                reasons=("simulated_evidence_cannot_drive_production_strategy",),
                guardrails=("simulated_evidence_isolated",),
                blocked=True,
                phase=request.phase or PHASE_AI_REINFORCEMENT,
            )
        if request.evidence_source not in REAL_STRATEGY_SOURCES:
            return _decision(
                action=ACTION_NONE,
                request=request,
                reasons=("unknown_evidence_source:" + request.evidence_source,),
                guardrails=("evidence_source_must_be_trusted",),
                blocked=True,
                phase=request.phase or PHASE_AI_REINFORCEMENT,
            )

    guardrails: list[str] = []
    if request.purpose == PURPOSE_SIMULATION:
        guardrails.append("simulation_context_only")
    if request.evidence_source == SOURCE_SIMULATED:
        guardrails.append("simulated_evidence_marked")

    # 2. Assessment integrity wins over every teaching preference.
    if request.constraints.assessment_in_progress:
        return _decision(
            action=ACTION_NONE,
            request=request,
            reasons=("assessment_in_progress",),
            guardrails=guardrails + ["no_assistance_during_assessment"],
            blocked=True,
            phase=request.phase or PHASE_AI_REINFORCEMENT,
        )

    # 3. No time budget means no assignment.  A hint or a confirmation can be
    #    zero-cost, but the router still refuses to schedule work.
    if request.constraints.available_minutes <= 0.0:
        return _decision(
            action=ACTION_NONE,
            request=request,
            reasons=("no_time_budget",),
            guardrails=guardrails + ["no_work_without_time_budget"],
            blocked=True,
            phase=request.phase or PHASE_AI_REINFORCEMENT,
        )

    # 4. Unconfirmed school progress: ask, never infer advancement.
    if not request.school.progress_usable:
        decision = _confirmation(
            request,
            "school_progress_unconfirmed",
            "school_progress_unconfirmed",
        )
        return StrategyDecision(
            **{
                **decision.__dict__,
                "guardrails": decision.guardrails + tuple(guardrails),
            }
        )

    # 5. An exam with an unconfirmed scope is a progress question, not a reason
    #    to expand coverage.
    if request.school.exam_upcoming and not request.school.exam_scope_confirmed:
        decision = _confirmation(
            request,
            "exam_scope_unconfirmed",
            "exam_scope_unconfirmed",
        )
        return StrategyDecision(
            **{
                **decision.__dict__,
                "guardrails": decision.guardrails + tuple(guardrails),
            }
        )

    # 6. Preview is only unlocked by a confirmed next lesson *and* a confirmed
    #    preview allowance.  Ability never unlocks future content.
    if request.intent == INTENT_PREVIEW or request.mode == MODE_PREVIEW:
        if not request.school.next_lesson_confirmed:
            return _confirmation(
                request,
                "preview_requires_confirmed_next_lesson",
                "preview_requires_confirmed_next_lesson",
            )
        preview_kcs = request.school.preview_kcs
        if not preview_kcs:
            return _confirmation(
                request,
                "preview_kcs_not_allowed",
                "preview_never_unlocked_by_ability",
            )
        gaps = [
            state.kc_id
            for state in _weak(request.knowledge)
            if state.kc_id in set(preview_kcs)
        ]
        action = (
            ACTION_SHOW_WORKED_EXAMPLE if gaps else ACTION_TEACH_MICRO_LESSON
        )
        return _decision(
            action=action,
            request=request,
            target_kcs=gaps or preview_kcs,
            reasons=(
                "preview_confirmed_lesson",
                "prerequisite_gap" if gaps else "concept_introduction",
            ),
            guardrails=guardrails + ["preview_within_confirmed_scope"],
            phase=PHASE_PREVIEW,
        )

    # 7. Explicit answer / time pressure: satisfy the request without forcing a
    #    diagnostic probe, unless direct answers are disabled.
    if request.explicit_answer_request or request.urgency == URGENCY_TIME_PRESSURE:
        reason = (
            "explicit_answer_request"
            if request.explicit_answer_request
            else "time_pressure"
        )
        if not request.constraints.allow_direct_answer:
            return _decision(
                action=ACTION_GIVE_MINIMAL_HINT,
                request=request,
                target_kcs=(),
                reasons=(reason, "direct_answer_disabled_by_learner"),
                guardrails=guardrails + ["direct_answer_disabled"],
            )
        return _decision(
            action=ACTION_ANSWER_DIRECTLY,
            request=request,
            target_kcs=(),
            reasons=(reason,),
            guardrails=guardrails + ["answer_with_learning_scaffold"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 8. A conflicting hypothesis is resolved with one discriminating question.
    if request.hypothesis_conflict:
        return _decision(
            action=ACTION_ASK_DIAGNOSTIC_QUESTION,
            request=request,
            target_kcs=(),
            reasons=("hypothesis_conflict_requires_probe",),
            guardrails=guardrails + ["diagnosis_is_skippable"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    if not request.knowledge and not request.due_reviews:
        return _confirmation(
            request,
            "knowledge_state_missing",
            "no_strategy_without_evidence",
        )

    weak = _weak(request.knowledge)
    misconceptions = _misconceptions(request.knowledge)
    errors = _errors(request.knowledge)
    due = _due_sorted(request.due_reviews)
    exam_targets = (
        tuple(kc for kc in _dedupe(request.school.exam_kcs) if kc)
        if request.school.exam_upcoming and request.school.exam_scope_confirmed
        else ()
    )

    # 9. Missing prerequisite / new content: lower cognitive load first.
    if weak:
        return _decision(
            action=ACTION_SHOW_WORKED_EXAMPLE,
            request=request,
            target_kcs=[state.kc_id for state in weak[:3]],
            reasons=(
                "prerequisite_gap" if any(not s.prerequisite_ready for s in weak) else "low_mastery_new_content",
            ),
            guardrails=guardrails + ["avoid_overload", "no_future_content"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 10. Conceptual misconception: contrast, self-explanation, then a worked
    #     example; transfer is deferred until understanding is established.
    if misconceptions:
        return _decision(
            action=ACTION_TEACH_MICRO_LESSON,
            request=request,
            target_kcs=[state.kc_id for state in misconceptions[:3]],
            reasons=("conceptual_misconception",),
            guardrails=guardrails + ["misconception_before_practice"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 11. Review intent or a forgetting queue: spaced retrieval beats re-teaching.
    if request.intent == INTENT_REVIEW or due:
        targets = [review.kc_id for review in due]
        if exam_targets:
            targets = [
                kc for kc in exam_targets if kc in set(targets) or not targets
            ]
        if not targets:
            targets = [state.kc_id for state in request.knowledge]
        methods = list(ACTION_METHODS[ACTION_SCHEDULE_SPACED_REVIEW])
        if len(set(targets)) < 2:
            methods = [method for method in methods if method != METHOD_INTERLEAVING]
        return _decision(
            action=ACTION_SCHEDULE_SPACED_REVIEW,
            request=request,
            target_kcs=targets[: request.constraints.max_items],
            methods=methods,
            reasons=("due_reviews_present" if due else "review_intent",),
            guardrails=guardrails + ["review_before_new_content"],
            phase=PHASE_REVIEW,
        )

    # 12. Diagnose intent without a conflict still asks one probe.
    if request.intent == INTENT_DIAGNOSE:
        return _decision(
            action=ACTION_ASK_DIAGNOSTIC_QUESTION,
            request=request,
            target_kcs=[state.kc_id for state in request.knowledge[:3]],
            reasons=("diagnostic_intent",),
            guardrails=guardrails + ["diagnosis_is_skippable"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 13. Understood but still error-prone: targeted procedural practice.
    if errors:
        methods = list(ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE])
        if len({state.kc_id for state in errors}) >= 2:
            methods.append(METHOD_INTERLEAVING)
        return _decision(
            action=ACTION_ASSIGN_TARGETED_PRACTICE,
            request=request,
            target_kcs=[state.kc_id for state in errors],
            methods=methods,
            reasons=("procedural_errors_detected",),
            guardrails=guardrails + ["independence_before_hints"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 14. Stable basics and a transfer goal: validate in a new context.
    mastered = [
        state
        for state in request.knowledge
        if state.mastery_mean >= DEFAULT_INTERLEAVING_MASTERY
    ]
    if request.intent == INTENT_TRANSFER or (
        mastered and request.intent in {INTENT_PRACTICE, INTENT_HOMEWORK_HELP}
    ):
        return _decision(
            action=ACTION_ASSIGN_TRANSFER_TASK,
            request=request,
            target_kcs=[state.kc_id for state in mastered[:3]],
            reasons=("transfer_readiness",),
            guardrails=guardrails + ["unseen_transfer_item_required"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 15. A learner with an existing strategy who only needs the next step gets
    #     the smallest hint, not a full explanation.
    if request.has_working_strategy:
        return _decision(
            action=ACTION_GIVE_MINIMAL_HINT,
            request=request,
            target_kcs=[state.kc_id for state in request.knowledge[:3]],
            reasons=("working_strategy_next_step_blocked",),
            guardrails=guardrails + ["smallest_sufficient_hint"],
            phase=PHASE_AI_REINFORCEMENT,
        )

    # 16. Default: independent targeted practice keeps retrieval active.
    methods = list(ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE])
    if len({state.kc_id for state in request.knowledge}) >= 2:
        methods.append(METHOD_INTERLEAVING)
    return _decision(
        action=ACTION_ASSIGN_TARGETED_PRACTICE,
        request=request,
        target_kcs=[state.kc_id for state in request.knowledge[: request.constraints.max_items]],
        methods=methods,
        reasons=("default_independent_practice",),
        guardrails=guardrails,
        phase=PHASE_AI_REINFORCEMENT,
    )


# ---------------------------------------------------------------------------
# Daily coordination (spec §10.2 / §10.3)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DailyCoordinationRequest:
    """Inputs for a day's preview → school → AI → review plan."""

    student_ref: str = "synthetic.learner"
    total_minutes: float = 60.0
    knowledge: tuple[KnowledgeState, ...] = ()
    due_reviews: tuple[DueReview, ...] = ()
    school: SchoolContext = field(default_factory=SchoolContext)
    constraints: LearnerConstraints = field(default_factory=LearnerConstraints)
    hypothesis_conflict: bool = False
    recent_error_kcs: tuple[str, ...] = ()
    prerequisite_gap_kcs: tuple[str, ...] = ()
    exam_pressure: float = 0.0
    review_backlog: int = 0
    evidence_source: str = SOURCE_OBSERVED
    purpose: str = PURPOSE_PRODUCTION

    def __post_init__(self) -> None:
        if not isinstance(self.student_ref, str) or not self.student_ref:
            raise TeachingStrategyError("student_ref must be a non-empty string")
        if (
            not isinstance(self.total_minutes, (int, float))
            or isinstance(self.total_minutes, bool)
            or not math.isfinite(float(self.total_minutes))
            or self.total_minutes < 0.0
        ):
            raise TeachingStrategyError("total_minutes must be >= 0")
        _clamp01(self.exam_pressure, "exam_pressure")
        if not isinstance(self.review_backlog, int) or self.review_backlog < 0:
            raise TeachingStrategyError("review_backlog must be an integer >= 0")
        if self.evidence_source not in ALL_STRATEGY_SOURCES:
            raise TeachingStrategyError(
                "unknown evidence_source: " + self.evidence_source
            )
        if self.purpose not in {PURPOSE_PRODUCTION, PURPOSE_SIMULATION}:
            raise TeachingStrategyError("unknown purpose: " + self.purpose)


@dataclass(frozen=True)
class DailyPhasePlan:
    """One phase of the daily rhythm; ``school`` always has zero AI minutes."""

    phase: str
    minutes: float
    action: str
    target_kcs: tuple[str, ...]
    method_ids: tuple[str, ...]
    rationale: tuple[str, ...]
    guardrails: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "minutes": self.minutes,
            "action": self.action,
            "targetKcs": list(self.target_kcs),
            "methodIds": list(self.method_ids),
            "rationale": list(self.rationale),
            "guardrails": list(self.guardrails),
        }


@dataclass(frozen=True)
class DailyPlan:
    """A bounded daily plan plus explicit confirmation / isolation notes."""

    student_ref: str
    total_minutes: float
    phases: tuple[DailyPhasePlan, ...]
    break_count: int
    break_minutes_total: float
    requires_confirmation: bool
    blocked: bool
    guardrails: tuple[str, ...]
    notes: tuple[str, ...]
    evidence_source: str
    simulated_evidence_used: bool = False

    def __bool__(self) -> bool:
        return not self.blocked

    def phase(self, name: str) -> DailyPhasePlan | None:
        for phase in self.phases:
            if phase.phase == name:
                return phase
        return None

    def as_dict(self) -> dict[str, Any]:
        return {
            "studentRef": self.student_ref,
            "totalMinutes": self.total_minutes,
            "phases": [phase.as_dict() for phase in self.phases],
            "breakCount": self.break_count,
            "breakMinutesTotal": self.break_minutes_total,
            "requiresConfirmation": self.requires_confirmation,
            "blocked": self.blocked,
            "guardrails": list(self.guardrails),
            "notes": list(self.notes),
            "evidenceSource": self.evidence_source,
            "simulatedEvidenceUsed": self.simulated_evidence_used,
        }


def _allocate_minutes(
    total: float, weights: Mapping[str, float]
) -> dict[str, float]:
    """Allocate ``total`` in 0.1-minute units, summing exactly to ``total``."""
    total = _round1(total)
    positive = {key: float(value) for key, value in weights.items() if value > 0.0}
    if not positive or total <= 0.0:
        return {}
    weight_sum = sum(positive.values())
    raw = {key: total * value / weight_sum for key, value in positive.items()}
    allocated = {key: math.floor(value * 10.0 + 1e-9) / 10.0 for key, value in raw.items()}
    remainder = _round1(total - sum(allocated.values()))
    order = sorted(positive, key=lambda key: (-raw[key], key))
    index = 0
    while remainder >= 0.1 - 1e-9:
        key = order[index % len(order)]
        allocated[key] = _round1(allocated[key] + 0.1)
        remainder = _round1(remainder - 0.1)
        index += 1
    return allocated


def _daily_weights(
    request: DailyCoordinationRequest, has_preview: bool, has_review: bool
) -> dict[str, float]:
    weights = {"preview": 0.0, "ai_reinforcement": 0.65, "review": 0.0}
    if has_preview:
        weights["preview"] = 0.15
        weights["ai_reinforcement"] = 0.55
        weights["review"] = 0.30
    if has_review:
        weights["review"] = max(weights["review"], 0.30)
        weights["ai_reinforcement"] = max(0.0, 1.0 - weights["preview"] - weights["review"])
    else:
        weights["review"] = 0.0
        weights["ai_reinforcement"] = 1.0 - weights["preview"]
    if request.prerequisite_gap_kcs and has_preview:
        weights["preview"] += 0.10
        weights["ai_reinforcement"] -= 0.05
        weights["review"] -= 0.05
    if request.school.school_pressure >= 0.6:
        weights["ai_reinforcement"] += 0.10
        weights["review"] -= 0.10
    if request.school.exam_upcoming or request.exam_pressure >= 0.6:
        weights["review"] += 0.15
        weights["ai_reinforcement"] -= 0.10
        weights["preview"] -= 0.05
    if request.review_backlog >= 3:
        weights["review"] += 0.05
        weights["ai_reinforcement"] -= 0.05
    return {key: max(0.01, value) for key, value in weights.items() if value > 0.0}


def _phase_guardrails(request: DailyCoordinationRequest) -> list[str]:
    guardrails = ["school_time_is_not_observed", "respect_break_preference"]
    if not request.school.progress_usable:
        guardrails.append("school_progress_unconfirmed")
    if not request.school.next_lesson_confirmed:
        guardrails.append("preview_blocked_unconfirmed_next_lesson")
    if request.school.exam_upcoming and not request.school.exam_scope_confirmed:
        guardrails.append("exam_scope_unconfirmed")
    if request.evidence_source == SOURCE_SIMULATED:
        guardrails.append("simulated_evidence_marked")
    return guardrails


def plan_daily_coordination(request: DailyCoordinationRequest) -> DailyPlan:
    """Build the daily preview → school → AI reinforcement → review plan.

    The school phase is always present with zero AI minutes and no action: the
    harness does not monitor the classroom and must not infer automatic mastery.
    Preview is skipped unless the next lesson and its preview scope are both
    confirmed.  Breaks are recommended outside the study budget.
    """
    guardrails = _phase_guardrails(request)
    if request.purpose == PURPOSE_PRODUCTION and request.evidence_source == SOURCE_SIMULATED:
        return DailyPlan(
            student_ref=request.student_ref,
            total_minutes=0.0,
            phases=(),
            break_count=0,
            break_minutes_total=0.0,
            requires_confirmation=False,
            blocked=True,
            guardrails=tuple(guardrails) + ("simulated_evidence_isolated",),
            notes=("simulated_evidence_cannot_drive_production_strategy",),
            evidence_source=request.evidence_source,
            simulated_evidence_used=True,
        )
    if request.constraints.assessment_in_progress:
        return DailyPlan(
            student_ref=request.student_ref,
            total_minutes=0.0,
            phases=(),
            break_count=0,
            break_minutes_total=0.0,
            requires_confirmation=False,
            blocked=True,
            guardrails=tuple(guardrails) + ("no_assistance_during_assessment",),
            notes=("assessment_in_progress",),
            evidence_source=request.evidence_source,
            simulated_evidence_used=request.evidence_source == SOURCE_SIMULATED,
        )
    # The learner-declared availability is a hard ceiling even if the caller
    # passes a larger daily plan budget.
    budget = min(
        request.total_minutes, request.constraints.available_minutes
    )
    if budget <= 0.0:
        return DailyPlan(
            student_ref=request.student_ref,
            total_minutes=0.0,
            phases=(),
            break_count=0,
            break_minutes_total=0.0,
            requires_confirmation=False,
            blocked=True,
            guardrails=tuple(guardrails) + ("no_work_without_time_budget",),
            notes=("no_time_budget",),
            evidence_source=request.evidence_source,
            simulated_evidence_used=request.evidence_source == SOURCE_SIMULATED,
        )

    preview_kcs = request.school.preview_kcs
    has_preview = (
        request.school.next_lesson_confirmed
        and bool(preview_kcs)
        and request.school.progress_usable
    )
    due = _due_sorted(request.due_reviews)
    has_review = bool(due) or request.school.exam_upcoming or request.review_backlog > 0
    weights = _daily_weights(request, has_preview, has_review)
    allocations = _allocate_minutes(budget, weights)

    phases: list[DailyPhasePlan] = []
    notes: list[str] = []
    requires_confirmation = False

    if not request.school.progress_usable:
        requires_confirmation = True
        notes.append("school_progress_unconfirmed")
    if request.school.exam_upcoming and not request.school.exam_scope_confirmed:
        requires_confirmation = True
        notes.append("exam_scope_unconfirmed")

    # Preview: short prerequisite check and concept introduction only.
    preview_minutes = allocations.get("preview", 0.0)
    if preview_minutes > 0.0:
        gaps = [
            kc
            for kc in _dedupe(request.prerequisite_gap_kcs)
            if kc in set(preview_kcs)
        ]
        if gaps:
            preview_action = ACTION_SHOW_WORKED_EXAMPLE
            preview_methods = ACTION_METHODS[ACTION_SHOW_WORKED_EXAMPLE]
            preview_rationale = (
                "preview_prerequisite_gap",
                "concept_introduction_before_school",
            )
        else:
            preview_action = ACTION_TEACH_MICRO_LESSON
            preview_methods = ACTION_METHODS[ACTION_TEACH_MICRO_LESSON]
            preview_rationale = (
                "confirmed_next_lesson",
                "concept_introduction_before_school",
            )
        phases.append(
            DailyPhasePlan(
                phase=PHASE_PREVIEW,
                minutes=preview_minutes,
                action=preview_action,
                target_kcs=tuple(gaps or preview_kcs),
                method_ids=tuple(preview_methods),
                rationale=preview_rationale,
                guardrails=("preview_within_confirmed_scope",),
            )
        )
    elif request.school.next_lesson_confirmed or request.school.next_lesson_kcs:
        notes.append("preview_skipped_unconfirmed_scope")

    # School: zero AI minutes, zero action, no inferred mastery.
    phases.append(
        DailyPhasePlan(
            phase=PHASE_SCHOOL,
            minutes=0.0,
            action=ACTION_NONE,
            target_kcs=(),
            method_ids=(),
            rationale=(
                "school_time_not_monitored",
                "no_automatic_mastery_inference",
            ),
            guardrails=("school_time_is_not_observed",),
        )
    )

    # AI reinforcement: diagnosis / remediation / targeted practice.
    reinforcement_minutes = allocations.get("ai_reinforcement", 0.0)
    if reinforcement_minutes > 0.0:
        if not request.school.progress_usable:
            reinforcement_action = ACTION_REQUEST_PROGRESS_CONFIRMATION
            reinforcement_targets: tuple[str, ...] = ()
            reinforcement_methods: tuple[str, ...] = ()
            reinforcement_rationale = ("school_progress_unconfirmed",)
        elif request.hypothesis_conflict:
            reinforcement_action = ACTION_ASK_DIAGNOSTIC_QUESTION
            reinforcement_targets = _dedupe(request.recent_error_kcs)
            reinforcement_methods = ACTION_METHODS[ACTION_ASK_DIAGNOSTIC_QUESTION]
            reinforcement_rationale = ("hypothesis_conflict_requires_probe",)
        elif request.recent_error_kcs:
            reinforcement_action = ACTION_ASSIGN_TARGETED_PRACTICE
            reinforcement_targets = _dedupe(request.recent_error_kcs)
            reinforcement_methods = ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE]
            reinforcement_rationale = ("errors_exposed_after_school",)
        else:
            errors = _errors(request.knowledge)
            misconceptions = _misconceptions(request.knowledge)
            if errors:
                reinforcement_action = ACTION_ASSIGN_TARGETED_PRACTICE
                reinforcement_targets = tuple(state.kc_id for state in errors)
                reinforcement_methods = ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE]
                reinforcement_rationale = ("procedural_errors_detected",)
            elif misconceptions:
                reinforcement_action = ACTION_TEACH_MICRO_LESSON
                reinforcement_targets = tuple(
                    state.kc_id for state in misconceptions[:3]
                )
                reinforcement_methods = ACTION_METHODS[ACTION_TEACH_MICRO_LESSON]
                reinforcement_rationale = ("conceptual_misconception",)
            else:
                reinforcement_action = ACTION_ASSIGN_TARGETED_PRACTICE
                reinforcement_targets = tuple(
                    state.kc_id
                    for state in sorted(
                        request.knowledge,
                        key=lambda state: (state.mastery_mean, state.kc_id),
                    )[: request.constraints.max_items]
                )
                reinforcement_methods = ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE]
                reinforcement_rationale = ("independent_practice_after_school",)
        if len(set(reinforcement_targets)) >= 2:
            reinforcement_methods = tuple(reinforcement_methods) + (
                METHOD_INTERLEAVING,
            )
        phases.append(
            DailyPhasePlan(
                phase=PHASE_AI_REINFORCEMENT,
                minutes=reinforcement_minutes,
                action=reinforcement_action,
                target_kcs=reinforcement_targets,
                method_ids=_dedupe(reinforcement_methods),
                rationale=reinforcement_rationale,
                guardrails=("independence_before_hints",),
            )
        )

    # Review: due memory units first, exam scope only when confirmed.
    review_minutes = allocations.get("review", 0.0)
    if review_minutes > 0.0 and has_review:
        review_targets = [review.kc_id for review in due]
        if not review_targets and request.school.exam_upcoming:
            review_targets = list(request.school.exam_kcs)
        if not review_targets:
            review_targets = [
                state.kc_id
                for state in sorted(
                    request.knowledge, key=lambda state: (state.mastery_mean, state.kc_id)
                )
            ]
        methods = list(ACTION_METHODS[ACTION_SCHEDULE_SPACED_REVIEW])
        if len(set(review_targets)) < 2:
            methods = [m for m in methods if m != METHOD_INTERLEAVING]
        phases.append(
            DailyPhasePlan(
                phase=PHASE_REVIEW,
                minutes=review_minutes,
                action=ACTION_SCHEDULE_SPACED_REVIEW,
                target_kcs=tuple(review_targets[: request.constraints.max_items]),
                method_ids=_dedupe(methods),
                rationale=("due_memory_units" if due else "review_backlog",),
                guardrails=("delayed_independent_recall",),
            )
        )
    elif has_review:
        notes.append("review_budget_too_small")

    study_minutes = sum(phase.minutes for phase in phases)
    blocks = max(1, math.ceil(study_minutes / request.constraints.max_block_minutes))
    break_count = max(0, blocks - 1)
    break_total = _round1(break_count * request.constraints.break_minutes)
    if break_count:
        notes.append("breaks_scheduled")

    if budget < request.total_minutes - 0.05:
        guardrails.append("daily_budget_capped_by_availability")
        notes.append("daily_budget_capped_by_availability")
    if abs(study_minutes - budget) > 0.05:
        # Allocation skipped a phase (e.g. zero weight).  Keep the invariant
        # explicit rather than silently exceeding the learner's budget.
        guardrails.append("phase_allocation_under_budget")

    if request.purpose == PURPOSE_SIMULATION:
        notes.append("simulation_context_only")

    return DailyPlan(
        student_ref=request.student_ref,
        total_minutes=_round1(study_minutes),
        phases=tuple(phases),
        break_count=break_count,
        break_minutes_total=break_total,
        requires_confirmation=requires_confirmation,
        blocked=False,
        guardrails=tuple(_dedupe(guardrails)),
        notes=tuple(_dedupe(notes)),
        evidence_source=request.evidence_source,
        simulated_evidence_used=request.evidence_source == SOURCE_SIMULATED,
    )


# ---------------------------------------------------------------------------
# Learning-science methods (spec §18)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LearningScienceMethod:
    """One row of the spec §18 toolbox mapped to harness actions."""

    method_id: str
    display_name: str
    harness_actions: tuple[str, ...]
    conditions: tuple[str, ...]
    implementation: tuple[str, ...]
    verification: tuple[str, ...]
    guardrails: tuple[str, ...]
    status: str = "mapped"

    def as_dict(self) -> dict[str, Any]:
        return {
            "methodId": self.method_id,
            "displayName": self.display_name,
            "harnessActions": list(self.harness_actions),
            "conditions": list(self.conditions),
            "implementation": list(self.implementation),
            "verification": list(self.verification),
            "guardrails": list(self.guardrails),
            "status": self.status,
        }


LEARNING_SCIENCE_METHODS: tuple[LearningScienceMethod, ...] = (
    LearningScienceMethod(
        METHOD_RETRIEVAL_PRACTICE,
        "检索练习 / Retrieval Practice",
        (ACTION_ASSIGN_TARGETED_PRACTICE, ACTION_SCHEDULE_SPACED_REVIEW),
        ("learned_content", "independent_first_attempt"),
        (
            "plan_retrieval_practice: no answer or explanation before the attempt",
            "hint-assisted corrections are logged as hint_followup, not retrieval success",
            "reading an explanation has zero retrieval weight",
        ),
        ("unhinted_success_rate", "delayed_unseen_retrieval"),
        (
            "no_answer_before_attempt",
            "reading_is_not_retrieval",
            "hint_assisted_correct_is_not_independent",
        ),
        status="implemented",
    ),
    LearningScienceMethod(
        METHOD_SPACED_PRACTICE,
        "间隔学习 / Spaced Practice",
        (ACTION_SCHEDULE_SPACED_REVIEW,),
        ("seen_before", "measurable_retention_task", "memory_stability_available"),
        (
            "plan_spaced_review: due units ordered by current retrievability",
            "interval_for_target derives the next review date from stability",
            "overdue units raise uncertainty instead of lowering mastery",
        ),
        ("delayed_independent_recall", "one_week_or_longer_retention"),
        (
            "do_not_reteach_whole_course",
            "spacing_uses_memory_stability",
        ),
        status="implemented",
    ),
    LearningScienceMethod(
        METHOD_INTERLEAVING,
        "交错练习 / Interleaving",
        (ACTION_ASSIGN_TARGETED_PRACTICE, ACTION_SCHEDULE_SPACED_REVIEW),
        ("basic_understanding_established", "confusable_methods_or_old_kcs"),
        (
            "plan_interleaved_practice: no adjacent same-KC block when avoidable",
            "mix confusable methods only after the mastery floor",
            "sequence and block boundaries are deterministic",
        ),
        ("strategy_selection_accuracy_on_new_items", "reduced_same_error_repetition"),
        (
            "do_not_interleave_before_basics",
            "mix_confusable_methods_not_random_noise",
        ),
        status="implemented",
    ),
    LearningScienceMethod(
        METHOD_WORKED_EXAMPLES,
        "示范例题 / Worked Examples",
        (ACTION_SHOW_WORKED_EXAMPLE,),
        ("new_content", "weak_prerequisite"),
        ("full worked steps with labelled sub-goals", "fade steps after understanding"),
        ("subsequent_independent_solving",),
        ("avoid_worked_example_during_assessment",),
    ),
    LearningScienceMethod(
        METHOD_FADING_SCAFFOLDS,
        "支架渐隐 / Fading Scaffolds",
        (ACTION_GIVE_MINIMAL_HINT, ACTION_ASSIGN_TARGETED_PRACTICE),
        ("partial_understanding", "prompt_dependence"),
        ("hint ladder with explicit levels", "remove fill-in/formula prompts step by step"),
        ("independent_completion_without_hints",),
        ("log_each_hint_level",),
    ),
    LearningScienceMethod(
        METHOD_SELF_EXPLANATION,
        "自我解释 / Self-explanation",
        (ACTION_TEACH_MICRO_LESSON,),
        ("conceptual_understanding", "rule_correction"),
        ("ask why this step is valid", "require an explanation before transfer"),
        ("explains_key_principle_on_a_new_item",),
        ("do_not_accept_keyword_only_explanation",),
    ),
    LearningScienceMethod(
        METHOD_ELABORATIVE_INTERROGATION,
        "精细追问 / Elaborative Interrogation",
        (ACTION_TEACH_MICRO_LESSON,),
        ("needs_prerequisite_connection",),
        ("why is it true? what is a counterexample?",),
        ("counterexample_and_transfer_item",),
        ("keep_questions_within_confirmed_scope",),
    ),
    LearningScienceMethod(
        METHOD_CONTRASTIVE_LEARNING,
        "对比题 / Contrastive Learning",
        (ACTION_TEACH_MICRO_LESSON,),
        ("stable_error_rule",),
        ("compare correct vs incorrect method on the same surface features",),
        ("error_does_not_repeat_on_unseen_items",),
        ("one_error_at_a_time",),
    ),
    LearningScienceMethod(
        METHOD_PRODUCTIVE_FAILURE,
        "有支持的尝试 / Productive Failure",
        (ACTION_ASSIGN_TARGETED_PRACTICE,),
        ("available_prerequisites", "failure_cost_bounded"),
        ("attempt first, then structured hints",),
        ("later_understanding_and_transfer",),
        ("stop_before_frustration_budget",),
    ),
    LearningScienceMethod(
        METHOD_MASTERY_LEARNING,
        "掌握学习 / Mastery Learning",
        (ACTION_ASSIGN_TARGETED_PRACTICE, ACTION_ASSIGN_TRANSFER_TASK),
        ("explicit_prerequisite_dependency",),
        ("require a verifiable standard before dependent tasks",),
        ("independent_test_and_spaced_retention",),
        ("mastery_not_self_declared",),
    ),
    LearningScienceMethod(
        METHOD_METACOGNITIVE_PROMPTS,
        "元认知提示 / Metacognitive Prompts",
        (ACTION_ASK_DIAGNOSTIC_QUESTION,),
        ("missing_self_check_strategy",),
        ("predict, check steps, reflect after answering",),
        ("self_correction_rate_and_hint_dependence",),
        ("prompts_are_skippable",),
    ),
    LearningScienceMethod(
        METHOD_DUAL_CODING,
        "多表征 / Dual Coding",
        (ACTION_SHOW_WORKED_EXAMPLE, ACTION_TEACH_MICRO_LESSON),
        ("diagram_or_visual_mapping_helps",),
        ("pair formula, diagram, graph and text",),
        ("cross_representation_transfer",),
        ("one_representation_at_a_time_for_novices",),
    ),
    LearningScienceMethod(
        METHOD_COGNITIVE_LOAD_CONTROL,
        "认知负荷管理 / Cognitive Load Control",
        (ACTION_SHOW_WORKED_EXAMPLE, ACTION_GIVE_MINIMAL_HINT),
        ("novice", "complex_stem", "overload_signal"),
        ("limit information, handle one error at a time",),
        ("completion_and_error_pattern_change",),
        ("respect_time_and_break_budget",),
    ),
    LearningScienceMethod(
        METHOD_ERROR_FOCUSED_PRACTICE,
        "错因专项 / Error-focused Practice",
        (ACTION_ASSIGN_TARGETED_PRACTICE,),
        ("multiple_evidence_for_a_specific_error_rule",),
        ("generate variants targeting that error rule",),
        ("no_repeat_of_the_same_error_on_unseen_items",),
        ("error_hypothesis_must_be_evidence_backed",),
    ),
    LearningScienceMethod(
        METHOD_NEAR_FAR_TRANSFER,
        "近/远迁移 / Near/Far Transfer",
        (ACTION_ASSIGN_TRANSFER_TASK,),
        ("basic_procedure_stable",),
        ("move application context gradually farther",),
        ("unseen_application_and_synthesis_items",),
        ("transfer_item_must_be_unseen",),
    ),
    LearningScienceMethod(
        METHOD_SELF_REGULATED_LEARNING,
        "自我调节 / Self-regulated Learning",
        (ACTION_REQUEST_PROGRESS_CONFIRMATION,),
        ("self_directed_or_exam_preparation",),
        ("co-set goals and reflect on the plan",),
        ("plan_completion_quality",),
        ("learner_can_shorten_or_end_the_session",),
    ),
)

METHODS_BY_ID: Mapping[str, LearningScienceMethod] = MappingProxyType(
    {method.method_id: method for method in LEARNING_SCIENCE_METHODS}
)


def method_by_id(method_id: str) -> LearningScienceMethod:
    try:
        return METHODS_BY_ID[method_id]
    except KeyError as error:
        raise TeachingStrategyError("unknown method: " + method_id) from error


def learning_science_checklist() -> tuple[LearningScienceMethod, ...]:
    """Return the §18 mapping, with executable status for the three planners."""
    return LEARNING_SCIENCE_METHODS


def methods_for_action(action: str) -> tuple[str, ...]:
    """Return the method ids attached to a policy action."""
    if action not in ACTION_METHODS:
        raise TeachingStrategyError("unknown action: " + action)
    return ACTION_METHODS[action]


# ---------------------------------------------------------------------------
# Executable learning-science plans
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RetrievalPlan:
    """A retrieval block that never shows the answer before the attempt."""

    kc_ids: tuple[str, ...]
    sequence: tuple[str, ...]
    minutes: float
    max_items: int
    item_ids: tuple[str, ...] = ()
    show_answer_first: bool = False
    independent: bool = True
    method_id: str = METHOD_RETRIEVAL_PRACTICE
    verification: tuple[str, ...] = (
        "unhinted_success_rate",
        "delayed_unseen_retrieval",
    )
    guardrails: tuple[str, ...] = (
        "no_answer_before_attempt",
        "reading_is_not_retrieval",
        "hint_assisted_correct_is_not_independent",
    )

    def as_dict(self) -> dict[str, Any]:
        return {
            "methodId": self.method_id,
            "kcIds": list(self.kc_ids),
            "sequence": list(self.sequence),
            "minutes": self.minutes,
            "maxItems": self.max_items,
            "itemIds": list(self.item_ids),
            "showAnswerFirst": self.show_answer_first,
            "independent": self.independent,
            "verification": list(self.verification),
            "guardrails": list(self.guardrails),
        }


def plan_retrieval_practice(
    kc_ids: Sequence[str],
    *,
    knowledge: Sequence[KnowledgeState] = (),
    available_minutes: float = 10.0,
    max_items: int = 6,
    item_ids: Sequence[str] = (),
) -> RetrievalPlan:
    """Plan independent retrieval over learned KCs, with no answer preview."""
    if available_minutes <= 0.0:
        raise TeachingStrategyError("available_minutes must be > 0")
    if max_items < 1:
        raise TeachingStrategyError("max_items must be >= 1")
    unique = _dedupe(kc_ids)
    if not unique:
        raise TeachingStrategyError("retrieval practice requires at least one KC")
    states = _knowledge_map(knowledge)
    unlearned = [kc for kc in unique if kc in states and not states[kc].learned]
    if unlearned:
        raise TeachingStrategyError(
            "retrieval_requires_learned_kc:" + ",".join(unlearned)
        )
    items = _dedupe(item_ids)
    if items and len(items) != len(unique):
        raise TeachingStrategyError(
            "item_ids must have one entry per kc_id when provided"
        )
    scheduled = items[:max_items] if items else unique[:max_items]
    minutes = _round1(min(available_minutes, max(1.0, len(scheduled) * 2.5)))
    return RetrievalPlan(
        kc_ids=unique[:max_items],
        sequence=scheduled,
        minutes=minutes,
        max_items=max_items,
        item_ids=items[:max_items],
    )


@dataclass(frozen=True)
class SpacedReviewSlot:
    """One due memory unit in a spaced-review block."""

    kc_id: str
    elapsed_days: float
    stability_days: float
    retrievability: float
    interval_days: float
    priority: float
    minutes: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "kcId": self.kc_id,
            "elapsedDays": self.elapsed_days,
            "stabilityDays": self.stability_days,
            "retrievability": round(self.retrievability, 6),
            "intervalDays": round(self.interval_days, 6),
            "priority": round(self.priority, 6),
            "minutes": self.minutes,
        }


@dataclass(frozen=True)
class SpacedReviewPlan:
    """A deterministic, memory-stability-driven review block."""

    slots: tuple[SpacedReviewSlot, ...]
    minutes: float
    target_retention: float
    method_id: str = METHOD_SPACED_PRACTICE
    verification: tuple[str, ...] = (
        "delayed_independent_recall",
        "one_week_or_longer_retention",
    )
    guardrails: tuple[str, ...] = (
        "do_not_reteach_whole_course",
        "spacing_uses_memory_stability",
        "overdue_raises_uncertainty_not_lower_mastery",
    )

    def as_dict(self) -> dict[str, Any]:
        return {
            "methodId": self.method_id,
            "slots": [slot.as_dict() for slot in self.slots],
            "minutes": self.minutes,
            "targetRetention": self.target_retention,
            "verification": list(self.verification),
            "guardrails": list(self.guardrails),
        }


def plan_spaced_review(
    due_reviews: Sequence[DueReview],
    *,
    available_minutes: float = 10.0,
    max_items: int = 6,
    target_retention: float = DEFAULT_REVIEW_TARGET_RETENTION,
) -> SpacedReviewPlan:
    """Order due units by retrievability and derive their next interval."""
    if available_minutes <= 0.0:
        raise TeachingStrategyError("available_minutes must be > 0")
    if max_items < 1:
        raise TeachingStrategyError("max_items must be >= 1")
    _clamp01(target_retention, "target_retention")
    if not 0.0 < target_retention < 1.0:
        raise TeachingStrategyError("target_retention must be within (0, 1)")
    due = _due_sorted(due_reviews)
    if not due:
        raise TeachingStrategyError("spaced review requires at least one due unit")
    selected = due[:max_items]
    per_slot = _round1(min(2.5, available_minutes / len(selected)))
    slots = tuple(
        SpacedReviewSlot(
            kc_id=review.kc_id,
            elapsed_days=float(review.elapsed_days),
            stability_days=float(review.stability_days),
            retrievability=review.retrievability,
            interval_days=interval_for_target(
                review.stability_days, target_retention
            ),
            priority=_round1(max(0.0, 1.0 - review.retrievability)),
            minutes=per_slot,
        )
        for review in selected
    )
    return SpacedReviewPlan(
        slots=slots,
        minutes=_round1(min(available_minutes, per_slot * len(slots))),
        target_retention=target_retention,
    )


@dataclass(frozen=True)
class PracticeUnit:
    """One candidate item/KC in an interleaved practice sequence."""

    unit_id: str
    kc_id: str
    difficulty: float = 0.5
    confusable_group: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.unit_id, str) or not self.unit_id:
            raise TeachingStrategyError("unit_id must be a non-empty string")
        if not isinstance(self.kc_id, str) or not self.kc_id:
            raise TeachingStrategyError("kc_id must be a non-empty string")
        _clamp01(self.difficulty, "difficulty")

    def as_dict(self) -> dict[str, Any]:
        return {
            "unitId": self.unit_id,
            "kcId": self.kc_id,
            "difficulty": self.difficulty,
            "confusableGroup": self.confusable_group,
        }


@dataclass(frozen=True)
class InterleavingPlan:
    """A deterministic interleaved sequence with no avoidable KC repetition."""

    sequence: tuple[PracticeUnit, ...]
    blocks: tuple[tuple[str, ...], ...]
    minutes: float
    distinct_kcs: int
    method_id: str = METHOD_INTERLEAVING
    verification: tuple[str, ...] = (
        "strategy_selection_accuracy_on_new_items",
        "reduced_same_error_repetition",
    )
    guardrails: tuple[str, ...] = (
        "do_not_interleave_before_basics",
        "mix_confusable_methods_not_random_noise",
    )

    def as_dict(self) -> dict[str, Any]:
        return {
            "methodId": self.method_id,
            "sequence": [unit.as_dict() for unit in self.sequence],
            "blocks": [list(block) for block in self.blocks],
            "minutes": self.minutes,
            "distinctKcs": self.distinct_kcs,
            "verification": list(self.verification),
            "guardrails": list(self.guardrails),
        }


def _interleave(units: Sequence[PracticeUnit], max_items: int) -> list[PracticeUnit]:
    """Pick the KC with the most remaining units, never the previous KC."""
    queues: dict[str, list[PracticeUnit]] = {}
    for unit in units:
        queues.setdefault(unit.kc_id, []).append(unit)
    remaining = {kc: len(queue) for kc, queue in queues.items()}
    sequence: list[PracticeUnit] = []
    previous: str | None = None
    while len(sequence) < max_items:
        candidates = [
            (kc, count)
            for kc, count in remaining.items()
            if count > 0 and kc != previous
        ]
        if not candidates:
            candidates = [
                (kc, count) for kc, count in remaining.items() if count > 0
            ]
        if not candidates:
            break
        kc = max(candidates, key=lambda item: (item[1], item[0]))[0]
        sequence.append(queues[kc].pop(0))
        remaining[kc] -= 1
        previous = kc
    return sequence


def plan_interleaved_practice(
    units: Sequence[PracticeUnit],
    *,
    mastery_by_kc: Mapping[str, float] | None = None,
    min_mastery: float = DEFAULT_INTERLEAVING_MASTERY,
    available_minutes: float = 15.0,
    max_items: int = 12,
    block_size: int = 4,
) -> InterleavingPlan:
    """Interleave confusable KCs only after basic understanding is established."""
    if available_minutes <= 0.0:
        raise TeachingStrategyError("available_minutes must be > 0")
    if max_items < 2:
        raise TeachingStrategyError("max_items must be >= 2")
    if block_size < 1:
        raise TeachingStrategyError("block_size must be >= 1")
    if not units:
        raise TeachingStrategyError("interleaving requires practice units")
    distinct = {unit.kc_id for unit in units}
    if len(distinct) < 2:
        raise TeachingStrategyError(
            "interleaving_requires_multiple_kcs"
        )
    mastery = {
        kc: float(value) for kc, value in (mastery_by_kc or {}).items()
    }
    weak = [
        kc
        for kc in sorted(distinct)
        if kc in mastery and mastery[kc] < min_mastery
    ]
    if weak:
        raise TeachingStrategyError(
            "interleaving_requires_basic_understanding:" + ",".join(weak)
        )
    sequence = _interleave(units, max_items)
    blocks = tuple(
        tuple(unit.unit_id for unit in sequence[index : index + block_size])
        for index in range(0, len(sequence), block_size)
    )
    minutes = _round1(min(available_minutes, max(2.0, len(sequence) * 2.0)))
    return InterleavingPlan(
        sequence=tuple(sequence),
        blocks=blocks,
        minutes=minutes,
        distinct_kcs=len(distinct),
    )


# ---------------------------------------------------------------------------
# Cross-subject adaptation (spec §17)
# ---------------------------------------------------------------------------

SUBJECT_MATH = "math"
SUBJECT_PHYSICS = "physics"


@dataclass(frozen=True)
class SubjectEvidence:
    """Subject-specific evidence about one KC, still opaque to other subjects."""

    evidence_id: str
    kc_id: str
    kind: str
    independent: bool = True
    verified_by: str | None = None

    def __post_init__(self) -> None:
        for name in ("evidence_id", "kc_id", "kind"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value:
                raise TeachingStrategyError(f"{name} must be a non-empty string")

    def as_dict(self) -> dict[str, Any]:
        return {
            "evidenceId": self.evidence_id,
            "kcId": self.kc_id,
            "kind": self.kind,
            "independent": self.independent,
            "verifiedBy": self.verified_by,
        }


@dataclass(frozen=True)
class SubjectAdaptation:
    """Result of adapting a shared strategy decision to one subject."""

    subject_id: str
    accepted: bool
    reasons: tuple[str, ...]
    validators: tuple[str, ...]
    evidence_requirements: tuple[str, ...]
    safety_required: bool
    strategy_modifiers: Mapping[str, float]

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "strategy_modifiers", MappingProxyType(dict(self.strategy_modifiers))
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "subjectId": self.subject_id,
            "accepted": self.accepted,
            "reasons": list(self.reasons),
            "validators": list(self.validators),
            "evidenceRequirements": list(self.evidence_requirements),
            "safetyRequired": self.safety_required,
            "strategyModifiers": dict(self.strategy_modifiers),
        }


class SubjectAdapter:
    """Shared KC/evidence/strategy contract with subject-specific validators.

    A subject supplies its KC prefix, evidence kinds, validators, high-risk KC
    prefixes and strategy affinities.  The shared orchestration never assumes
    that a math step-equivalence validator can judge a physics free-body
    diagram; it asks the adapter instead.
    """

    def __init__(
        self,
        *,
        subject_id: str,
        display_name: str,
        kc_prefix: str,
        kc_types: Sequence[str],
        evidence_kinds: Sequence[str],
        validators: Sequence[str],
        strategy_modifiers: Mapping[str, float],
        required_evidence: Sequence[str] = ("independent_attempt",),
        high_risk_kc_prefixes: Sequence[str] = (),
        safety_note: str = "",
    ) -> None:
        for name, value in (
            ("subject_id", subject_id),
            ("display_name", display_name),
            ("kc_prefix", kc_prefix),
        ):
            if not isinstance(value, str) or not value:
                raise TeachingStrategyError(f"{name} must be a non-empty string")
        self.subject_id = subject_id
        self.display_name = display_name
        self.kc_prefix = kc_prefix
        self.kc_types = tuple(kc_types)
        self.evidence_kinds = frozenset(evidence_kinds)
        self.validators = tuple(validators)
        self.strategy_modifiers = MappingProxyType(dict(strategy_modifiers))
        self.required_evidence = tuple(required_evidence)
        self.high_risk_kc_prefixes = tuple(high_risk_kc_prefixes)
        self.safety_note = safety_note

    def supports_kc(self, kc_id: str) -> bool:
        return isinstance(kc_id, str) and kc_id.startswith(self.kc_prefix)

    def high_risk(self, kc_ids: Iterable[str]) -> bool:
        return any(
            kc.startswith(prefix)
            for kc in kc_ids
            for prefix in self.high_risk_kc_prefixes
        )

    def validate_evidence(self, evidence: SubjectEvidence) -> tuple[str, ...]:
        reasons: list[str] = []
        if not self.supports_kc(evidence.kc_id):
            reasons.append("unsupported_kc:" + evidence.kc_id)
        if evidence.kind not in self.evidence_kinds:
            reasons.append("unsupported_evidence_kind:" + evidence.kind)
        if not evidence.independent:
            reasons.append("evidence_not_independent")
        if evidence.verified_by is None:
            reasons.append("evidence_not_verified")
        elif evidence.verified_by not in self.validators:
            reasons.append("unverified_evidence:" + evidence.verified_by)
        return tuple(reasons)

    def adapt(self, decision: StrategyDecision) -> SubjectAdaptation:
        reasons: list[str] = []
        if decision.blocked or decision.action == ACTION_NONE:
            reasons.append("strategy_blocked")
        unsupported = [
            kc for kc in decision.target_kcs if not self.supports_kc(kc)
        ]
        if unsupported:
            reasons.append("unsupported_kc:" + ",".join(unsupported))
        safety_required = self.high_risk(decision.target_kcs)
        return SubjectAdaptation(
            subject_id=self.subject_id,
            accepted=not reasons,
            reasons=tuple(reasons),
            validators=self.validators,
            evidence_requirements=self.required_evidence,
            safety_required=safety_required,
            strategy_modifiers=self.strategy_modifiers,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "subjectId": self.subject_id,
            "displayName": self.display_name,
            "kcPrefix": self.kc_prefix,
            "kcTypes": list(self.kc_types),
            "evidenceKinds": sorted(self.evidence_kinds),
            "validators": list(self.validators),
            "requiredEvidence": list(self.required_evidence),
            "highRiskKcPrefixes": list(self.high_risk_kc_prefixes),
            "safetyNote": self.safety_note,
            "strategyModifiers": dict(self.strategy_modifiers),
        }


class MathSubjectAdapter(SubjectAdapter):
    """Example 1: math uses step equivalence / symbolic verification."""

    def __init__(self) -> None:
        super().__init__(
            subject_id=SUBJECT_MATH,
            display_name="Mathematics",
            kc_prefix="kc.math.",
            kc_types=("procedure", "concept", "representation", "strategy"),
            evidence_kinds=(
                "numeric_answer",
                "symbolic_equivalence",
                "step_equivalence",
                "transfer_probe",
            ),
            validators=(
                "answer_key",
                "cas_step_equivalence",
                "symbolic_equivalence",
            ),
            strategy_modifiers={
                ACTION_SHOW_WORKED_EXAMPLE: 0.10,
                ACTION_ASSIGN_TARGETED_PRACTICE: 0.10,
                ACTION_ASSIGN_TRANSFER_TASK: 0.15,
            },
            high_risk_kc_prefixes=(),
        )


class PhysicsSubjectAdapter(SubjectAdapter):
    """Example 2: physics adds modelling, unit and high-risk lab checks."""

    def __init__(self) -> None:
        super().__init__(
            subject_id=SUBJECT_PHYSICS,
            display_name="Physics",
            kc_prefix="kc.physics.",
            kc_types=("model", "procedure", "concept", "representation"),
            evidence_kinds=(
                "numeric_answer",
                "free_body_diagram",
                "unit_check",
                "model_explanation",
                "transfer_probe",
            ),
            validators=(
                "answer_key",
                "unit_check",
                "dimensional_analysis",
                "symbolic_check",
            ),
            strategy_modifiers={
                ACTION_SHOW_WORKED_EXAMPLE: 0.15,
                ACTION_ASSIGN_TARGETED_PRACTICE: 0.05,
                ACTION_ASSIGN_TRANSFER_TASK: 0.10,
            },
            high_risk_kc_prefixes=("kc.physics.electricity.",),
            safety_note=(
                "Electrical/high-voltage practical guidance requires host safety "
                "review; this adapter never generates dangerous operation details."
            ),
        )


MATH_SUBJECT = MathSubjectAdapter()
PHYSICS_SUBJECT = PhysicsSubjectAdapter()


class SubjectRegistry:
    """Registry of subject adapters keyed by subject id (fail-closed lookup)."""

    def __init__(self, adapters: Iterable[SubjectAdapter] = ()) -> None:
        self._adapters: dict[str, SubjectAdapter] = {}
        for adapter in adapters:
            self.register(adapter)

    def register(self, adapter: SubjectAdapter) -> SubjectAdapter:
        if adapter.subject_id in self._adapters:
            raise SubjectAdapterError(
                "duplicate subject adapter: " + adapter.subject_id
            )
        self._adapters[adapter.subject_id] = adapter
        return adapter

    def get(self, subject_id: str) -> SubjectAdapter:
        try:
            return self._adapters[subject_id]
        except KeyError as error:
            raise SubjectAdapterError(
                "unknown subject adapter: " + subject_id
            ) from error

    def adapt(
        self, subject_id: str, decision: StrategyDecision
    ) -> SubjectAdaptation:
        return self.get(subject_id).adapt(decision)

    def to_dict(self) -> dict[str, Any]:
        return {
            subject_id: adapter.to_dict()
            for subject_id, adapter in sorted(self._adapters.items())
        }

    def __iter__(self):
        return iter(self._adapters.values())

    def __len__(self) -> int:
        return len(self._adapters)


DEFAULT_SUBJECT_REGISTRY = SubjectRegistry((MATH_SUBJECT, PHYSICS_SUBJECT))


def cross_subject_contract() -> dict[str, Any]:
    """Describe the shared interface and the two concrete examples."""
    return {
        "shared": (
            "kc_id",
            "evidence",
            "strategy_decision",
            "validators",
            "safety",
        ),
        "subjects": DEFAULT_SUBJECT_REGISTRY.to_dict(),
    }


__all__ = [
    "PHASE_PREVIEW",
    "PHASE_SCHOOL",
    "PHASE_AI_REINFORCEMENT",
    "PHASE_REVIEW",
    "DAILY_PHASES",
    "ACTION_ASK_DIAGNOSTIC_QUESTION",
    "ACTION_GIVE_MINIMAL_HINT",
    "ACTION_SHOW_WORKED_EXAMPLE",
    "ACTION_TEACH_MICRO_LESSON",
    "ACTION_ASSIGN_TARGETED_PRACTICE",
    "ACTION_ASSIGN_TRANSFER_TASK",
    "ACTION_SCHEDULE_SPACED_REVIEW",
    "ACTION_REQUEST_PROGRESS_CONFIRMATION",
    "ACTION_ANSWER_DIRECTLY",
    "ACTION_NONE",
    "STRATEGY_ACTIONS",
    "INTENT_PRACTICE",
    "INTENT_REVIEW",
    "INTENT_PREVIEW",
    "INTENT_DIAGNOSE",
    "INTENT_HOMEWORK_HELP",
    "INTENT_ANSWER_QUESTION",
    "INTENT_TRANSFER",
    "TASK_INTENTS",
    "URGENCY_NORMAL",
    "URGENCY_TIME_PRESSURE",
    "PURPOSE_PRODUCTION",
    "PURPOSE_SIMULATION",
    "SOURCE_OBSERVED",
    "SOURCE_TEACHER_CONFIRMED",
    "SOURCE_SCHOOL_CONFIRMED",
    "SOURCE_SIMULATED",
    "REAL_STRATEGY_SOURCES",
    "ALL_STRATEGY_SOURCES",
    "BREAK_PREFERENCES",
    "METHOD_RETRIEVAL_PRACTICE",
    "METHOD_SPACED_PRACTICE",
    "METHOD_INTERLEAVING",
    "METHOD_WORKED_EXAMPLES",
    "METHOD_FADING_SCAFFOLDS",
    "METHOD_SELF_EXPLANATION",
    "METHOD_ELABORATIVE_INTERROGATION",
    "METHOD_CONTRASTIVE_LEARNING",
    "METHOD_PRODUCTIVE_FAILURE",
    "METHOD_MASTERY_LEARNING",
    "METHOD_METACOGNITIVE_PROMPTS",
    "METHOD_DUAL_CODING",
    "METHOD_COGNITIVE_LOAD_CONTROL",
    "METHOD_ERROR_FOCUSED_PRACTICE",
    "METHOD_NEAR_FAR_TRANSFER",
    "METHOD_SELF_REGULATED_LEARNING",
    "IMPLEMENTED_METHOD_IDS",
    "ACTION_METHODS",
    "ACTION_MINUTES",
    "KnowledgeState",
    "DueReview",
    "LearnerConstraints",
    "SchoolContext",
    "StrategyRequest",
    "StrategyDecision",
    "select_strategy",
    "DailyCoordinationRequest",
    "DailyPhasePlan",
    "DailyPlan",
    "plan_daily_coordination",
    "LearningScienceMethod",
    "LEARNING_SCIENCE_METHODS",
    "METHODS_BY_ID",
    "method_by_id",
    "learning_science_checklist",
    "methods_for_action",
    "RetrievalPlan",
    "plan_retrieval_practice",
    "SpacedReviewSlot",
    "SpacedReviewPlan",
    "plan_spaced_review",
    "PracticeUnit",
    "InterleavingPlan",
    "plan_interleaved_practice",
    "SubjectEvidence",
    "SubjectAdaptation",
    "SubjectAdapter",
    "MathSubjectAdapter",
    "PhysicsSubjectAdapter",
    "SubjectRegistry",
    "DEFAULT_SUBJECT_REGISTRY",
    "MATH_SUBJECT",
    "PHYSICS_SUBJECT",
    "SUBJECT_MATH",
    "SUBJECT_PHYSICS",
    "cross_subject_contract",
    "TeachingStrategyError",
    "SubjectAdapterError",
]
