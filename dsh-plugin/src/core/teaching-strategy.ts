/**
 * Teaching strategy, daily coordination and cross-subject adaptation
 * (spec §10 / §17 / §18).
 *
 * Mirrors `aeh/teaching_strategy.py`. This is a policy layer only: decisions
 * never deliver an item, and `deliveryRequiresGate` is always true. The daily
 * plan records school time as explicitly unobserved, so no automatic mastery is
 * inferred. Retrieval practice, spaced practice and interleaving have executable
 * planners; the remaining §18 methods are mapped to harness actions and
 * verification requirements.
 *
 * The shared fixture `tests/fixtures/teaching_strategy_step15.json` is read by
 * both the Python and TypeScript tests. All content is synthetic.
 */

import {
  DEFAULT_MIN_PROGRESS_CONFIDENCE,
  type GateMode,
} from '../domain.ts'
import { intervalForTarget, retrievability } from './memory.ts'

export class TeachingStrategyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeachingStrategyError'
  }
}

export class SubjectAdapterError extends TeachingStrategyError {
  constructor(message: string) {
    super(message)
    this.name = 'SubjectAdapterError'
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const PHASE_PREVIEW = 'preview'
export const PHASE_SCHOOL = 'school'
export const PHASE_AI_REINFORCEMENT = 'ai_reinforcement'
export const PHASE_REVIEW = 'review'

export const DAILY_PHASES = Object.freeze([
  PHASE_PREVIEW,
  PHASE_SCHOOL,
  PHASE_AI_REINFORCEMENT,
  PHASE_REVIEW,
] as const)
export type DailyPhase = (typeof DAILY_PHASES)[number]

export const ACTION_ASK_DIAGNOSTIC_QUESTION = 'ask_diagnostic_question'
export const ACTION_GIVE_MINIMAL_HINT = 'give_minimal_hint'
export const ACTION_SHOW_WORKED_EXAMPLE = 'show_worked_example'
export const ACTION_TEACH_MICRO_LESSON = 'teach_micro_lesson'
export const ACTION_ASSIGN_TARGETED_PRACTICE = 'assign_targeted_practice'
export const ACTION_ASSIGN_TRANSFER_TASK = 'assign_transfer_task'
export const ACTION_SCHEDULE_SPACED_REVIEW = 'schedule_spaced_review'
export const ACTION_REQUEST_PROGRESS_CONFIRMATION =
  'request_progress_confirmation'
export const ACTION_ANSWER_DIRECTLY = 'answer_directly'
export const ACTION_NONE = 'no_action'

export const STRATEGY_ACTIONS = Object.freeze([
  ACTION_ASK_DIAGNOSTIC_QUESTION,
  ACTION_GIVE_MINIMAL_HINT,
  ACTION_SHOW_WORKED_EXAMPLE,
  ACTION_TEACH_MICRO_LESSON,
  ACTION_ASSIGN_TARGETED_PRACTICE,
  ACTION_ASSIGN_TRANSFER_TASK,
  ACTION_SCHEDULE_SPACED_REVIEW,
  ACTION_REQUEST_PROGRESS_CONFIRMATION,
  ACTION_ANSWER_DIRECTLY,
] as const)
export type StrategyAction = (typeof STRATEGY_ACTIONS)[number] | typeof ACTION_NONE

export const INTENT_PRACTICE = 'practice'
export const INTENT_REVIEW = 'review'
export const INTENT_PREVIEW = 'preview'
export const INTENT_DIAGNOSE = 'diagnose'
export const INTENT_HOMEWORK_HELP = 'homework_help'
export const INTENT_ANSWER_QUESTION = 'answer_question'
export const INTENT_TRANSFER = 'transfer'

export const TASK_INTENTS = Object.freeze([
  INTENT_PRACTICE,
  INTENT_REVIEW,
  INTENT_PREVIEW,
  INTENT_DIAGNOSE,
  INTENT_HOMEWORK_HELP,
  INTENT_ANSWER_QUESTION,
  INTENT_TRANSFER,
] as const)
export type TaskIntent = (typeof TASK_INTENTS)[number]

export const URGENCY_NORMAL = 'normal'
export const URGENCY_TIME_PRESSURE = 'time_pressure'
export const URGENCIES = Object.freeze([
  URGENCY_NORMAL,
  URGENCY_TIME_PRESSURE,
] as const)
export type Urgency = (typeof URGENCIES)[number]

export const PURPOSE_PRODUCTION = 'production'
export const PURPOSE_SIMULATION = 'simulation'
export const PURPOSES = Object.freeze([
  PURPOSE_PRODUCTION,
  PURPOSE_SIMULATION,
] as const)
export type StrategyPurpose = (typeof PURPOSES)[number]

export const SOURCE_OBSERVED = 'observed'
export const SOURCE_TEACHER_CONFIRMED = 'teacher_confirmed'
export const SOURCE_SCHOOL_CONFIRMED = 'school_confirmed'
export const SOURCE_SIMULATED = 'simulated'

export const REAL_STRATEGY_SOURCES = Object.freeze(
  new Set([SOURCE_OBSERVED, SOURCE_TEACHER_CONFIRMED, SOURCE_SCHOOL_CONFIRMED]),
)
export const ALL_STRATEGY_SOURCES = Object.freeze(
  new Set([...REAL_STRATEGY_SOURCES, SOURCE_SIMULATED]),
)

export const BREAK_PREFERENCES = Object.freeze([
  'none',
  'short',
  'balanced',
  'long',
] as const)
export type BreakPreference = (typeof BREAK_PREFERENCES)[number]
export const BREAK_MINUTES: Readonly<Record<BreakPreference, number>> =
  Object.freeze({
    none: 0,
    short: 3,
    balanced: 5,
    long: 10,
  })

export const METHOD_RETRIEVAL_PRACTICE = 'retrieval_practice'
export const METHOD_SPACED_PRACTICE = 'spaced_practice'
export const METHOD_INTERLEAVING = 'interleaving'
export const METHOD_WORKED_EXAMPLES = 'worked_examples'
export const METHOD_FADING_SCAFFOLDS = 'fading_scaffolds'
export const METHOD_SELF_EXPLANATION = 'self_explanation'
export const METHOD_ELABORATIVE_INTERROGATION = 'elaborative_interrogation'
export const METHOD_CONTRASTIVE_LEARNING = 'contrastive_learning'
export const METHOD_PRODUCTIVE_FAILURE = 'productive_failure'
export const METHOD_MASTERY_LEARNING = 'mastery_learning'
export const METHOD_METACOGNITIVE_PROMPTS = 'metacognitive_prompts'
export const METHOD_DUAL_CODING = 'dual_coding'
export const METHOD_COGNITIVE_LOAD_CONTROL = 'cognitive_load_control'
export const METHOD_ERROR_FOCUSED_PRACTICE = 'error_focused_practice'
export const METHOD_NEAR_FAR_TRANSFER = 'near_far_transfer'
export const METHOD_SELF_REGULATED_LEARNING = 'self_regulated_learning'

export const IMPLEMENTED_METHOD_IDS = Object.freeze([
  METHOD_RETRIEVAL_PRACTICE,
  METHOD_SPACED_PRACTICE,
  METHOD_INTERLEAVING,
] as const)

export const DEFAULT_MASTERY_FLOOR = 0.35
export const DEFAULT_INTERLEAVING_MASTERY = 0.6
export const DEFAULT_PROCEDURAL_ERROR_THRESHOLD = 0.25
export const DEFAULT_REVIEW_TARGET_RETENTION = 0.9

export const ACTION_METHODS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    [ACTION_ASK_DIAGNOSTIC_QUESTION]: [METHOD_METACOGNITIVE_PROMPTS],
    [ACTION_GIVE_MINIMAL_HINT]: [METHOD_FADING_SCAFFOLDS],
    [ACTION_SHOW_WORKED_EXAMPLE]: [
      METHOD_WORKED_EXAMPLES,
      METHOD_COGNITIVE_LOAD_CONTROL,
    ],
    [ACTION_TEACH_MICRO_LESSON]: [
      METHOD_SELF_EXPLANATION,
      METHOD_CONTRASTIVE_LEARNING,
      METHOD_WORKED_EXAMPLES,
    ],
    [ACTION_ASSIGN_TARGETED_PRACTICE]: [
      METHOD_RETRIEVAL_PRACTICE,
      METHOD_ERROR_FOCUSED_PRACTICE,
      METHOD_FADING_SCAFFOLDS,
    ],
    [ACTION_ASSIGN_TRANSFER_TASK]: [
      METHOD_NEAR_FAR_TRANSFER,
      METHOD_RETRIEVAL_PRACTICE,
    ],
    [ACTION_SCHEDULE_SPACED_REVIEW]: [
      METHOD_SPACED_PRACTICE,
      METHOD_RETRIEVAL_PRACTICE,
      METHOD_INTERLEAVING,
    ],
    [ACTION_REQUEST_PROGRESS_CONFIRMATION]: [],
    [ACTION_ANSWER_DIRECTLY]: [],
    [ACTION_NONE]: [],
  })

export const ACTION_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  [ACTION_ASK_DIAGNOSTIC_QUESTION]: 6,
  [ACTION_GIVE_MINIMAL_HINT]: 3,
  [ACTION_SHOW_WORKED_EXAMPLE]: 12,
  [ACTION_TEACH_MICRO_LESSON]: 15,
  [ACTION_ASSIGN_TARGETED_PRACTICE]: 15,
  [ACTION_ASSIGN_TRANSFER_TASK]: 18,
  [ACTION_SCHEDULE_SPACED_REVIEW]: 10,
  [ACTION_REQUEST_PROGRESS_CONFIRMATION]: 1,
  [ACTION_ANSWER_DIRECTLY]: 5,
  [ACTION_NONE]: 0,
})

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10
}

function clamp01(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TeachingStrategyError(`${name} must be within [0, 1]`)
  }
  return value
}

function nonNegative(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TeachingStrategyError(`${name} must be a finite number >= 0`)
  }
  return value
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

function normalizeSource(source: string): string {
  if (!ALL_STRATEGY_SOURCES.has(source)) {
    throw new TeachingStrategyError(`unknown evidence_source: ${source}`)
  }
  return source
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface KnowledgeStateInput {
  readonly kcId: string
  readonly masteryMean: number
  readonly uncertainty?: number
  readonly prerequisiteReady?: boolean
  readonly conceptualMisconception?: boolean
  readonly proceduralErrorRate?: number
  readonly learned?: boolean
  readonly targetRetention?: number
}

export interface KnowledgeState {
  readonly kcId: string
  readonly masteryMean: number
  readonly uncertainty: number
  readonly prerequisiteReady: boolean
  readonly conceptualMisconception: boolean
  readonly proceduralErrorRate: number
  readonly learned: boolean
  readonly targetRetention: number
}

export function normalizeKnowledgeState(
  input: KnowledgeStateInput,
): KnowledgeState {
  if (typeof input.kcId !== 'string' || input.kcId.length === 0) {
    throw new TeachingStrategyError('kcId must be a non-empty string')
  }
  const targetRetention = input.targetRetention ?? DEFAULT_REVIEW_TARGET_RETENTION
  if (targetRetention <= 0 || targetRetention >= 1) {
    throw new TeachingStrategyError('targetRetention must be within (0, 1)')
  }
  return Object.freeze({
    kcId: input.kcId,
    masteryMean: clamp01(input.masteryMean, 'masteryMean'),
    uncertainty: clamp01(input.uncertainty ?? 0, 'uncertainty'),
    prerequisiteReady: input.prerequisiteReady ?? true,
    conceptualMisconception: input.conceptualMisconception ?? false,
    proceduralErrorRate: clamp01(
      input.proceduralErrorRate ?? 0,
      'proceduralErrorRate',
    ),
    learned: input.learned ?? true,
    targetRetention,
  })
}

export interface DueReviewInput {
  readonly kcId: string
  readonly stabilityDays: number
  readonly elapsedDays?: number
  readonly targetRetention?: number
  readonly due?: boolean
}

export interface DueReview {
  readonly kcId: string
  readonly stabilityDays: number
  readonly elapsedDays: number
  readonly targetRetention: number
  readonly due: boolean
}

export function normalizeDueReview(input: DueReviewInput): DueReview {
  if (typeof input.kcId !== 'string' || input.kcId.length === 0) {
    throw new TeachingStrategyError('kcId must be a non-empty string')
  }
  const stabilityDays = input.stabilityDays
  if (
    typeof stabilityDays !== 'number' ||
    !Number.isFinite(stabilityDays) ||
    stabilityDays <= 0
  ) {
    throw new TeachingStrategyError('stabilityDays must be > 0')
  }
  const elapsedDays = input.elapsedDays ?? 0
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0) {
    throw new TeachingStrategyError('elapsedDays must be >= 0')
  }
  const targetRetention = input.targetRetention ?? DEFAULT_REVIEW_TARGET_RETENTION
  if (targetRetention <= 0 || targetRetention >= 1) {
    throw new TeachingStrategyError('targetRetention must be within (0, 1)')
  }
  return Object.freeze({
    kcId: input.kcId,
    stabilityDays,
    elapsedDays,
    targetRetention,
    due: input.due ?? true,
  })
}

export function dueReviewRetrievability(review: DueReview): number {
  return retrievability(review.elapsedDays, review.stabilityDays)
}

export function dueReviewIntervalDays(review: DueReview): number {
  return intervalForTarget(review.stabilityDays, review.targetRetention)
}

export interface LearnerConstraintsInput {
  readonly availableMinutes?: number
  readonly maxBlockMinutes?: number
  readonly maxItems?: number
  readonly breakPreference?: BreakPreference
  readonly homeworkLoad?: number
  readonly assessmentInProgress?: boolean
  readonly allowDirectAnswer?: boolean
}

export interface LearnerConstraints {
  readonly availableMinutes: number
  readonly maxBlockMinutes: number
  readonly maxItems: number
  readonly breakPreference: BreakPreference
  readonly homeworkLoad: number
  readonly assessmentInProgress: boolean
  readonly allowDirectAnswer: boolean
}

export function normalizeLearnerConstraints(
  input: LearnerConstraintsInput = {},
): LearnerConstraints {
  const availableMinutes = nonNegative(
    input.availableMinutes ?? 30,
    'availableMinutes',
  )
  const maxBlockMinutes = input.maxBlockMinutes ?? 25
  if (!Number.isFinite(maxBlockMinutes) || maxBlockMinutes <= 0) {
    throw new TeachingStrategyError('maxBlockMinutes must be > 0')
  }
  const maxItems = input.maxItems ?? 8
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new TeachingStrategyError('maxItems must be an integer >= 1')
  }
  const breakPreference = input.breakPreference ?? 'balanced'
  if (!(BREAK_PREFERENCES as readonly string[]).includes(breakPreference)) {
    throw new TeachingStrategyError(
      `breakPreference must be one of ${BREAK_PREFERENCES.join(', ')}`,
    )
  }
  return Object.freeze({
    availableMinutes,
    maxBlockMinutes,
    maxItems,
    breakPreference,
    homeworkLoad: clamp01(input.homeworkLoad ?? 0, 'homeworkLoad'),
    assessmentInProgress: input.assessmentInProgress ?? false,
    allowDirectAnswer: input.allowDirectAnswer ?? true,
  })
}

export interface SchoolContextInput {
  readonly nextLessonConfirmed?: boolean
  readonly nextLessonKcs?: readonly string[]
  readonly previewAllowedKcs?: readonly string[]
  readonly progressConfirmed?: boolean
  readonly progressConfidence?: number
  readonly schoolPressure?: number
  readonly examUpcoming?: boolean
  readonly examScopeConfirmed?: boolean
  readonly examKcs?: readonly string[]
}

export interface SchoolContext {
  readonly nextLessonConfirmed: boolean
  readonly nextLessonKcs: readonly string[]
  readonly previewAllowedKcs: readonly string[]
  readonly progressConfirmed: boolean
  readonly progressConfidence: number
  readonly schoolPressure: number
  readonly examUpcoming: boolean
  readonly examScopeConfirmed: boolean
  readonly examKcs: readonly string[]
}

export function normalizeSchoolContext(
  input: SchoolContextInput = {},
): SchoolContext {
  return Object.freeze({
    nextLessonConfirmed: input.nextLessonConfirmed ?? false,
    nextLessonKcs: Object.freeze([...(input.nextLessonKcs ?? [])]),
    previewAllowedKcs: Object.freeze([...(input.previewAllowedKcs ?? [])]),
    progressConfirmed: input.progressConfirmed ?? true,
    progressConfidence: clamp01(
      input.progressConfidence ?? 1,
      'progressConfidence',
    ),
    schoolPressure: clamp01(input.schoolPressure ?? 0.5, 'schoolPressure'),
    examUpcoming: input.examUpcoming ?? false,
    examScopeConfirmed: input.examScopeConfirmed ?? true,
    examKcs: Object.freeze([...(input.examKcs ?? [])]),
  })
}

export function schoolProgressUsable(school: SchoolContext): boolean {
  return (
    school.progressConfirmed &&
    school.progressConfidence >= DEFAULT_MIN_PROGRESS_CONFIDENCE
  )
}

export function schoolPreviewKcs(school: SchoolContext): readonly string[] {
  const allowed = new Set(school.previewAllowedKcs)
  return Object.freeze(
    dedupe(school.nextLessonKcs).filter((kc) => allowed.has(kc)),
  )
}

export interface StrategyRequest {
  readonly intent?: TaskIntent
  readonly mode?: GateMode
  readonly knowledge?: readonly KnowledgeStateInput[]
  readonly dueReviews?: readonly DueReviewInput[]
  readonly hypothesisConflict?: boolean
  readonly school?: SchoolContextInput
  readonly constraints?: LearnerConstraintsInput
  readonly evidenceSource?: string
  readonly purpose?: StrategyPurpose
  readonly explicitAnswerRequest?: boolean
  readonly urgency?: Urgency
  readonly phase?: DailyPhase
  readonly hasWorkingStrategy?: boolean
}

interface NormalizedStrategyRequest {
  readonly intent: TaskIntent
  readonly mode: GateMode
  readonly knowledge: readonly KnowledgeState[]
  readonly dueReviews: readonly DueReview[]
  readonly hypothesisConflict: boolean
  readonly school: SchoolContext
  readonly constraints: LearnerConstraints
  readonly evidenceSource: string
  readonly purpose: StrategyPurpose
  readonly explicitAnswerRequest: boolean
  readonly urgency: Urgency
  readonly phase: DailyPhase | null
  readonly hasWorkingStrategy: boolean
}

export function normalizeStrategyRequest(
  input: StrategyRequest = {},
): NormalizedStrategyRequest {
  const intent = input.intent ?? INTENT_PRACTICE
  if (!(TASK_INTENTS as readonly string[]).includes(intent)) {
    throw new TeachingStrategyError(`unknown intent: ${intent}`)
  }
  const mode = input.mode ?? 'learn'
  if (!['preview', 'learn', 'review'].includes(mode)) {
    throw new TeachingStrategyError(`unknown mode: ${mode}`)
  }
  const urgency = input.urgency ?? URGENCY_NORMAL
  if (!(URGENCIES as readonly string[]).includes(urgency)) {
    throw new TeachingStrategyError(`unknown urgency: ${urgency}`)
  }
  const purpose = input.purpose ?? PURPOSE_PRODUCTION
  if (!(PURPOSES as readonly string[]).includes(purpose)) {
    throw new TeachingStrategyError(`unknown purpose: ${purpose}`)
  }
  const phase = input.phase ?? null
  if (phase !== null && !(DAILY_PHASES as readonly string[]).includes(phase)) {
    throw new TeachingStrategyError(`unknown phase: ${phase}`)
  }
  const source = normalizeSource(input.evidenceSource ?? SOURCE_OBSERVED)
  return {
    intent,
    mode,
    knowledge: Object.freeze(
      (input.knowledge ?? []).map(normalizeKnowledgeState),
    ),
    dueReviews: Object.freeze((input.dueReviews ?? []).map(normalizeDueReview)),
    hypothesisConflict: input.hypothesisConflict ?? false,
    school: normalizeSchoolContext(input.school),
    constraints: normalizeLearnerConstraints(input.constraints),
    evidenceSource: source,
    purpose,
    explicitAnswerRequest: input.explicitAnswerRequest ?? false,
    urgency,
    phase,
    hasWorkingStrategy: input.hasWorkingStrategy ?? false,
  }
}

// ---------------------------------------------------------------------------
// Strategy router
// ---------------------------------------------------------------------------

export interface StrategyDecision {
  readonly action: StrategyAction
  readonly mode: GateMode
  readonly phase: DailyPhase
  readonly targetKcs: readonly string[]
  readonly methodIds: readonly string[]
  readonly timeMinutes: number
  readonly reasons: readonly string[]
  readonly guardrails: readonly string[]
  readonly requiresConfirmation: boolean
  readonly blocked: boolean
  readonly deliveryRequiresGate: true
  readonly evidenceSource: string
  readonly simulatedEvidenceUsed: boolean
}

export const BASE_GUARDRAILS = Object.freeze([
  'delivery_requires_curriculum_gate',
  'respect_learner_time_budget',
  'no_unbounded_practice',
] as const)

function decision(
  request: NormalizedStrategyRequest,
  action: StrategyAction,
  options: {
    readonly targetKcs?: readonly string[]
    readonly methods?: readonly string[]
    readonly reasons?: readonly string[]
    readonly guardrails?: readonly string[]
    readonly phase?: DailyPhase
    readonly requiresConfirmation?: boolean
    readonly blocked?: boolean
    readonly timeMinutes?: number
  } = {},
): StrategyDecision {
  const configured = ACTION_MINUTES[action] ?? 0
  let minutes = options.timeMinutes ?? configured
  minutes = Math.max(
    0,
    Math.min(round1(minutes), request.constraints.availableMinutes),
  )
  if (action === ACTION_NONE) minutes = 0
  return Object.freeze({
    action,
    mode: request.mode,
    phase: options.phase ?? request.phase ?? PHASE_AI_REINFORCEMENT,
    targetKcs: Object.freeze([...dedupe(options.targetKcs ?? [])]),
    methodIds: Object.freeze([
      ...dedupe(options.methods ?? ACTION_METHODS[action] ?? []),
    ]),
    timeMinutes: minutes,
    reasons: Object.freeze([...(options.reasons ?? [])]),
    guardrails: Object.freeze([
      ...BASE_GUARDRAILS,
      ...(options.guardrails ?? []),
    ]),
    requiresConfirmation: options.requiresConfirmation ?? false,
    blocked: options.blocked ?? false,
    deliveryRequiresGate: true,
    evidenceSource: request.evidenceSource,
    simulatedEvidenceUsed: request.evidenceSource === SOURCE_SIMULATED,
  })
}

function withGuardrails(
  base: StrategyDecision,
  guardrails: readonly string[],
): StrategyDecision {
  return Object.freeze({
    ...base,
    guardrails: Object.freeze([...base.guardrails, ...guardrails]),
  })
}

function confirmation(
  request: NormalizedStrategyRequest,
  reason: string,
  guardrail: string,
): StrategyDecision {
  return decision(request, ACTION_REQUEST_PROGRESS_CONFIRMATION, {
    reasons: [reason],
    guardrails: [guardrail],
    requiresConfirmation: true,
    phase: PHASE_AI_REINFORCEMENT,
    timeMinutes: Math.min(2, request.constraints.availableMinutes),
  })
}

function knowledgeMap(
  knowledge: readonly KnowledgeState[],
): Map<string, KnowledgeState> {
  return new Map(knowledge.map((state) => [state.kcId, state]))
}

function dueSorted(dueReviews: readonly DueReview[]): readonly DueReview[] {
  return [...dueReviews]
    .filter((review) => review.due)
    .sort(
      (left, right) =>
        dueReviewRetrievability(left) - dueReviewRetrievability(right) ||
        compareStrings(left.kcId, right.kcId),
    )
}

function errorsOf(knowledge: readonly KnowledgeState[]): readonly KnowledgeState[] {
  return knowledge
    .filter(
      (state) =>
        state.proceduralErrorRate >= DEFAULT_PROCEDURAL_ERROR_THRESHOLD,
    )
    .sort(
      (left, right) =>
        right.proceduralErrorRate - left.proceduralErrorRate ||
        left.masteryMean - right.masteryMean ||
        compareStrings(left.kcId, right.kcId),
    )
}

function misconceptionsOf(
  knowledge: readonly KnowledgeState[],
): readonly KnowledgeState[] {
  return knowledge
    .filter((state) => state.conceptualMisconception)
    .sort(
      (left, right) =>
        left.masteryMean - right.masteryMean ||
        compareStrings(left.kcId, right.kcId),
    )
}

function weakOf(knowledge: readonly KnowledgeState[]): readonly KnowledgeState[] {
  return knowledge
    .filter(
      (state) =>
        !state.prerequisiteReady || state.masteryMean < DEFAULT_MASTERY_FLOOR,
    )
    .sort(
      (left, right) =>
        left.masteryMean - right.masteryMean ||
        compareStrings(left.kcId, right.kcId),
    )
}

/** Choose the next teaching action with fail-closed guardrails. */
export function selectStrategy(input: StrategyRequest = {}): StrategyDecision {
  const request = normalizeStrategyRequest(input)

  // 1. Simulated evidence can screen candidates in a lab, never drive a real
  //    production decision.
  if (request.purpose === PURPOSE_PRODUCTION) {
    if (request.evidenceSource === SOURCE_SIMULATED) {
      return decision(request, ACTION_NONE, {
        reasons: ['simulated_evidence_cannot_drive_production_strategy'],
        guardrails: ['simulated_evidence_isolated'],
        blocked: true,
        phase: request.phase ?? PHASE_AI_REINFORCEMENT,
      })
    }
    if (!REAL_STRATEGY_SOURCES.has(request.evidenceSource)) {
      return decision(request, ACTION_NONE, {
        reasons: [`unknown_evidence_source:${request.evidenceSource}`],
        guardrails: ['evidence_source_must_be_trusted'],
        blocked: true,
        phase: request.phase ?? PHASE_AI_REINFORCEMENT,
      })
    }
  }

  const contextGuardrails: string[] = []
  if (request.purpose === PURPOSE_SIMULATION) {
    contextGuardrails.push('simulation_context_only')
  }
  if (request.evidenceSource === SOURCE_SIMULATED) {
    contextGuardrails.push('simulated_evidence_marked')
  }

  // 2. Assessment integrity wins over every teaching preference.
  if (request.constraints.assessmentInProgress) {
    return decision(request, ACTION_NONE, {
      reasons: ['assessment_in_progress'],
      guardrails: [...contextGuardrails, 'no_assistance_during_assessment'],
      blocked: true,
      phase: request.phase ?? PHASE_AI_REINFORCEMENT,
    })
  }

  // 3. No time budget means no assignment.
  if (request.constraints.availableMinutes <= 0) {
    return decision(request, ACTION_NONE, {
      reasons: ['no_time_budget'],
      guardrails: [...contextGuardrails, 'no_work_without_time_budget'],
      blocked: true,
      phase: request.phase ?? PHASE_AI_REINFORCEMENT,
    })
  }

  // 4. Unconfirmed school progress: ask, never infer advancement.
  if (!schoolProgressUsable(request.school)) {
    return withGuardrails(
      confirmation(
        request,
        'school_progress_unconfirmed',
        'school_progress_unconfirmed',
      ),
      contextGuardrails,
    )
  }

  // 5. An unconfirmed exam scope is a progress question.
  if (
    request.school.examUpcoming &&
    !request.school.examScopeConfirmed
  ) {
    return withGuardrails(
      confirmation(request, 'exam_scope_unconfirmed', 'exam_scope_unconfirmed'),
      contextGuardrails,
    )
  }

  // 6. Preview requires a confirmed next lesson and a confirmed preview scope.
  if (request.intent === INTENT_PREVIEW || request.mode === 'preview') {
    if (!request.school.nextLessonConfirmed) {
      return confirmation(
        request,
        'preview_requires_confirmed_next_lesson',
        'preview_requires_confirmed_next_lesson',
      )
    }
    const previewKcs = schoolPreviewKcs(request.school)
    if (previewKcs.length === 0) {
      return confirmation(
        request,
        'preview_kcs_not_allowed',
        'preview_never_unlocked_by_ability',
      )
    }
    const previewSet = new Set(previewKcs)
    const gaps = weakOf(request.knowledge)
      .map((state) => state.kcId)
      .filter((kc) => previewSet.has(kc))
    return decision(
      request,
      gaps.length > 0
        ? ACTION_SHOW_WORKED_EXAMPLE
        : ACTION_TEACH_MICRO_LESSON,
      {
        targetKcs: gaps.length > 0 ? gaps : previewKcs,
        reasons: [
          'preview_confirmed_lesson',
          gaps.length > 0 ? 'prerequisite_gap' : 'concept_introduction',
        ],
        guardrails: [...contextGuardrails, 'preview_within_confirmed_scope'],
        phase: PHASE_PREVIEW,
      },
    )
  }

  // 7. Explicit answer / time pressure, unless direct answers are disabled.
  if (request.explicitAnswerRequest || request.urgency === URGENCY_TIME_PRESSURE) {
    const reason = request.explicitAnswerRequest
      ? 'explicit_answer_request'
      : 'time_pressure'
    if (!request.constraints.allowDirectAnswer) {
      return decision(request, ACTION_GIVE_MINIMAL_HINT, {
        reasons: [reason, 'direct_answer_disabled_by_learner'],
        guardrails: [...contextGuardrails, 'direct_answer_disabled'],
      })
    }
    return decision(request, ACTION_ANSWER_DIRECTLY, {
      reasons: [reason],
      guardrails: [...contextGuardrails, 'answer_with_learning_scaffold'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 8. Hypothesis conflict: one discriminating question, skippable.
  if (request.hypothesisConflict) {
    return decision(request, ACTION_ASK_DIAGNOSTIC_QUESTION, {
      reasons: ['hypothesis_conflict_requires_probe'],
      guardrails: [...contextGuardrails, 'diagnosis_is_skippable'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  if (request.knowledge.length === 0 && request.dueReviews.length === 0) {
    return confirmation(
      request,
      'knowledge_state_missing',
      'no_strategy_without_evidence',
    )
  }

  const weak = weakOf(request.knowledge)
  const misconceptions = misconceptionsOf(request.knowledge)
  const errors = errorsOf(request.knowledge)
  const due = dueSorted(request.dueReviews)
  const examTargets =
    request.school.examUpcoming && request.school.examScopeConfirmed
      ? dedupe(request.school.examKcs).filter((kc) => kc.length > 0)
      : []

  // 9. Missing prerequisite / new content: lower cognitive load first.
  if (weak.length > 0) {
    return decision(request, ACTION_SHOW_WORKED_EXAMPLE, {
      targetKcs: weak.slice(0, 3).map((state) => state.kcId),
      reasons: [
        weak.some((state) => !state.prerequisiteReady)
          ? 'prerequisite_gap'
          : 'low_mastery_new_content',
      ],
      guardrails: [...contextGuardrails, 'avoid_overload', 'no_future_content'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 10. Conceptual misconception: contrast, self-explanation, worked example.
  if (misconceptions.length > 0) {
    return decision(request, ACTION_TEACH_MICRO_LESSON, {
      targetKcs: misconceptions.slice(0, 3).map((state) => state.kcId),
      reasons: ['conceptual_misconception'],
      guardrails: [...contextGuardrails, 'misconception_before_practice'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 11. Review intent or forgetting queue: spaced retrieval beats re-teaching.
  if (request.intent === INTENT_REVIEW || due.length > 0) {
    let targets = due.map((review) => review.kcId)
    if (examTargets.length > 0) {
      targets =
        targets.length === 0
          ? [...examTargets]
          : examTargets.filter((kc) => targets.includes(kc))
    }
    if (targets.length === 0) {
      targets = request.knowledge.map((state) => state.kcId)
    }
    let methods = [...(ACTION_METHODS[ACTION_SCHEDULE_SPACED_REVIEW] ?? [])]
    if (new Set(targets).size < 2) {
      methods = methods.filter((method) => method !== METHOD_INTERLEAVING)
    }
    return decision(request, ACTION_SCHEDULE_SPACED_REVIEW, {
      targetKcs: targets.slice(0, request.constraints.maxItems),
      methods,
      reasons: [due.length > 0 ? 'due_reviews_present' : 'review_intent'],
      guardrails: [...contextGuardrails, 'review_before_new_content'],
      phase: PHASE_REVIEW,
    })
  }

  // 12. Diagnose intent without a conflict still asks one probe.
  if (request.intent === INTENT_DIAGNOSE) {
    return decision(request, ACTION_ASK_DIAGNOSTIC_QUESTION, {
      targetKcs: request.knowledge.slice(0, 3).map((state) => state.kcId),
      reasons: ['diagnostic_intent'],
      guardrails: [...contextGuardrails, 'diagnosis_is_skippable'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 13. Understood but still error-prone: targeted procedural practice.
  if (errors.length > 0) {
    const methods = [
      ...(ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE] ?? []),
    ]
    if (new Set(errors.map((state) => state.kcId)).size >= 2) {
      methods.push(METHOD_INTERLEAVING)
    }
    return decision(request, ACTION_ASSIGN_TARGETED_PRACTICE, {
      targetKcs: errors.map((state) => state.kcId),
      methods,
      reasons: ['procedural_errors_detected'],
      guardrails: [...contextGuardrails, 'independence_before_hints'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 14. Stable basics and a transfer goal: validate in a new context.
  const mastered = request.knowledge.filter(
    (state) => state.masteryMean >= DEFAULT_INTERLEAVING_MASTERY,
  )
  if (
    request.intent === INTENT_TRANSFER ||
    (mastered.length > 0 &&
      (request.intent === INTENT_PRACTICE ||
        request.intent === INTENT_HOMEWORK_HELP))
  ) {
    return decision(request, ACTION_ASSIGN_TRANSFER_TASK, {
      targetKcs: mastered.slice(0, 3).map((state) => state.kcId),
      reasons: ['transfer_readiness'],
      guardrails: [...contextGuardrails, 'unseen_transfer_item_required'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 15. Smallest sufficient hint when the learner already has a strategy.
  if (request.hasWorkingStrategy) {
    return decision(request, ACTION_GIVE_MINIMAL_HINT, {
      targetKcs: request.knowledge.slice(0, 3).map((state) => state.kcId),
      reasons: ['working_strategy_next_step_blocked'],
      guardrails: [...contextGuardrails, 'smallest_sufficient_hint'],
      phase: PHASE_AI_REINFORCEMENT,
    })
  }

  // 16. Default: independent targeted practice keeps retrieval active.
  const methods = [...(ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE] ?? [])]
  if (new Set(request.knowledge.map((state) => state.kcId)).size >= 2) {
    methods.push(METHOD_INTERLEAVING)
  }
  return decision(request, ACTION_ASSIGN_TARGETED_PRACTICE, {
    targetKcs: request.knowledge
      .slice(0, request.constraints.maxItems)
      .map((state) => state.kcId),
    methods,
    reasons: ['default_independent_practice'],
    guardrails: contextGuardrails,
    phase: PHASE_AI_REINFORCEMENT,
  })
}

// ---------------------------------------------------------------------------
// Daily coordination
// ---------------------------------------------------------------------------

export interface DailyCoordinationRequest {
  readonly studentRef?: string
  readonly totalMinutes?: number
  readonly knowledge?: readonly KnowledgeStateInput[]
  readonly dueReviews?: readonly DueReviewInput[]
  readonly school?: SchoolContextInput
  readonly constraints?: LearnerConstraintsInput
  readonly hypothesisConflict?: boolean
  readonly recentErrorKcs?: readonly string[]
  readonly prerequisiteGapKcs?: readonly string[]
  readonly examPressure?: number
  readonly reviewBacklog?: number
  readonly evidenceSource?: string
  readonly purpose?: StrategyPurpose
}

interface NormalizedDailyRequest {
  readonly studentRef: string
  readonly totalMinutes: number
  readonly knowledge: readonly KnowledgeState[]
  readonly dueReviews: readonly DueReview[]
  readonly school: SchoolContext
  readonly constraints: LearnerConstraints
  readonly hypothesisConflict: boolean
  readonly recentErrorKcs: readonly string[]
  readonly prerequisiteGapKcs: readonly string[]
  readonly examPressure: number
  readonly reviewBacklog: number
  readonly evidenceSource: string
  readonly purpose: StrategyPurpose
}

function normalizeDailyRequest(
  input: DailyCoordinationRequest = {},
): NormalizedDailyRequest {
  const studentRef = input.studentRef ?? 'synthetic.learner'
  if (typeof studentRef !== 'string' || studentRef.length === 0) {
    throw new TeachingStrategyError('studentRef must be a non-empty string')
  }
  const totalMinutes = nonNegative(input.totalMinutes ?? 60, 'totalMinutes')
  const reviewBacklog = input.reviewBacklog ?? 0
  if (!Number.isInteger(reviewBacklog) || reviewBacklog < 0) {
    throw new TeachingStrategyError('reviewBacklog must be an integer >= 0')
  }
  const purpose = input.purpose ?? PURPOSE_PRODUCTION
  if (!(PURPOSES as readonly string[]).includes(purpose)) {
    throw new TeachingStrategyError(`unknown purpose: ${purpose}`)
  }
  return {
    studentRef,
    totalMinutes,
    knowledge: Object.freeze(
      (input.knowledge ?? []).map(normalizeKnowledgeState),
    ),
    dueReviews: Object.freeze((input.dueReviews ?? []).map(normalizeDueReview)),
    school: normalizeSchoolContext(input.school),
    constraints: normalizeLearnerConstraints(input.constraints),
    hypothesisConflict: input.hypothesisConflict ?? false,
    recentErrorKcs: Object.freeze([...(input.recentErrorKcs ?? [])]),
    prerequisiteGapKcs: Object.freeze([...(input.prerequisiteGapKcs ?? [])]),
    examPressure: clamp01(input.examPressure ?? 0, 'examPressure'),
    reviewBacklog,
    evidenceSource: normalizeSource(input.evidenceSource ?? SOURCE_OBSERVED),
    purpose,
  }
}

export interface DailyPhasePlan {
  readonly phase: DailyPhase
  readonly minutes: number
  readonly action: StrategyAction
  readonly targetKcs: readonly string[]
  readonly methodIds: readonly string[]
  readonly rationale: readonly string[]
  readonly guardrails: readonly string[]
}

export interface DailyPlan {
  readonly studentRef: string
  readonly totalMinutes: number
  readonly phases: readonly DailyPhasePlan[]
  readonly breakCount: number
  readonly breakMinutesTotal: number
  readonly requiresConfirmation: boolean
  readonly blocked: boolean
  readonly guardrails: readonly string[]
  readonly notes: readonly string[]
  readonly evidenceSource: string
  readonly simulatedEvidenceUsed: boolean
}

function allocateMinutes(
  total: number,
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  const roundedTotal = round1(total)
  const positive: Record<string, number> = {}
  for (const [key, value] of Object.entries(weights)) {
    if (value > 0) positive[key] = value
  }
  const keys = Object.keys(positive)
  if (keys.length === 0 || roundedTotal <= 0) return {}
  const weightSum = keys.reduce((sum, key) => sum + positive[key], 0)
  const raw: Record<string, number> = {}
  const allocated: Record<string, number> = {}
  for (const key of keys) {
    raw[key] = roundedTotal * positive[key] / weightSum
    allocated[key] = Math.floor(raw[key] * 10 + 1e-9) / 10
  }
  let remainder = round1(
    roundedTotal - Object.values(allocated).reduce((sum, value) => sum + value, 0),
  )
  const order = [...keys].sort(
    (left, right) => raw[right] - raw[left] || compareStrings(left, right),
  )
  let index = 0
  while (remainder >= 0.1 - 1e-9) {
    const key = order[index % order.length]
    allocated[key] = round1(allocated[key] + 0.1)
    remainder = round1(remainder - 0.1)
    index += 1
  }
  return allocated
}

function dailyWeights(
  request: NormalizedDailyRequest,
  hasPreview: boolean,
  hasReview: boolean,
): Record<string, number> {
  const weights: Record<string, number> = {
    preview: 0,
    ai_reinforcement: 0.65,
    review: 0,
  }
  if (hasPreview) {
    weights.preview = 0.15
    weights.ai_reinforcement = 0.55
    weights.review = 0.3
  }
  if (hasReview) {
    weights.review = Math.max(weights.review, 0.3)
    weights.ai_reinforcement = Math.max(
      0,
      1 - weights.preview - weights.review,
    )
  } else {
    weights.review = 0
    weights.ai_reinforcement = 1 - weights.preview
  }
  if (request.prerequisiteGapKcs.length > 0 && hasPreview) {
    weights.preview += 0.1
    weights.ai_reinforcement -= 0.05
    weights.review -= 0.05
  }
  if (request.school.schoolPressure >= 0.6) {
    weights.ai_reinforcement += 0.1
    weights.review -= 0.1
  }
  if (request.school.examUpcoming || request.examPressure >= 0.6) {
    weights.review += 0.15
    weights.ai_reinforcement -= 0.1
    weights.preview -= 0.05
  }
  if (request.reviewBacklog >= 3) {
    weights.review += 0.05
    weights.ai_reinforcement -= 0.05
  }
  const positive: Record<string, number> = {}
  for (const [key, value] of Object.entries(weights)) {
    if (value > 0) positive[key] = Math.max(0.01, value)
  }
  return positive
}

function phaseGuardrails(request: NormalizedDailyRequest): readonly string[] {
  const guardrails = [
    'school_time_is_not_observed',
    'respect_break_preference',
  ]
  if (!schoolProgressUsable(request.school)) {
    guardrails.push('school_progress_unconfirmed')
  }
  if (!request.school.nextLessonConfirmed) {
    guardrails.push('preview_blocked_unconfirmed_next_lesson')
  }
  if (request.school.examUpcoming && !request.school.examScopeConfirmed) {
    guardrails.push('exam_scope_unconfirmed')
  }
  if (request.evidenceSource === SOURCE_SIMULATED) {
    guardrails.push('simulated_evidence_marked')
  }
  return guardrails
}

function blockedDailyPlan(
  request: NormalizedDailyRequest,
  notes: readonly string[],
  extraGuardrails: readonly string[],
): DailyPlan {
  return Object.freeze({
    studentRef: request.studentRef,
    totalMinutes: 0,
    phases: Object.freeze([]),
    breakCount: 0,
    breakMinutesTotal: 0,
    requiresConfirmation: false,
    blocked: true,
    guardrails: Object.freeze([
      ...phaseGuardrails(request),
      ...extraGuardrails,
    ]),
    notes: Object.freeze([...notes]),
    evidenceSource: request.evidenceSource,
    simulatedEvidenceUsed: request.evidenceSource === SOURCE_SIMULATED,
  })
}

/** Build the daily preview → school → AI reinforcement → review plan. */
export function planDailyCoordination(
  input: DailyCoordinationRequest = {},
): DailyPlan {
  const request = normalizeDailyRequest(input)
  if (
    request.purpose === PURPOSE_PRODUCTION &&
    request.evidenceSource === SOURCE_SIMULATED
  ) {
    return blockedDailyPlan(
      request,
      ['simulated_evidence_cannot_drive_production_strategy'],
      ['simulated_evidence_isolated'],
    )
  }
  if (request.constraints.assessmentInProgress) {
    return blockedDailyPlan(
      request,
      ['assessment_in_progress'],
      ['no_assistance_during_assessment'],
    )
  }
  // Learner availability is a hard ceiling even when the caller asks for a
  // larger daily plan budget.
  const budget = Math.min(
    request.totalMinutes,
    request.constraints.availableMinutes,
  )
  if (budget <= 0) {
    return blockedDailyPlan(
      request,
      ['no_time_budget'],
      ['no_work_without_time_budget'],
    )
  }

  const previewKcs = schoolPreviewKcs(request.school)
  const hasPreview =
    request.school.nextLessonConfirmed &&
    previewKcs.length > 0 &&
    schoolProgressUsable(request.school)
  const due = dueSorted(request.dueReviews)
  const hasReview =
    due.length > 0 ||
    request.school.examUpcoming ||
    request.reviewBacklog > 0
  const allocations = allocateMinutes(
    budget,
    dailyWeights(request, hasPreview, hasReview),
  )

  const phases: DailyPhasePlan[] = []
  const notes: string[] = []
  let requiresConfirmation = false
  if (!schoolProgressUsable(request.school)) {
    requiresConfirmation = true
    notes.push('school_progress_unconfirmed')
  }
  if (request.school.examUpcoming && !request.school.examScopeConfirmed) {
    requiresConfirmation = true
    notes.push('exam_scope_unconfirmed')
  }

  const previewMinutes = allocations.preview ?? 0
  if (previewMinutes > 0) {
    const previewSet = new Set(previewKcs)
    const gaps = dedupe(request.prerequisiteGapKcs).filter((kc) =>
      previewSet.has(kc),
    )
    const previewAction =
      gaps.length > 0
        ? ACTION_SHOW_WORKED_EXAMPLE
        : ACTION_TEACH_MICRO_LESSON
    phases.push(
      Object.freeze({
        phase: PHASE_PREVIEW,
        minutes: previewMinutes,
        action: previewAction,
        targetKcs: Object.freeze([...(gaps.length > 0 ? gaps : previewKcs)]),
        methodIds: Object.freeze([
          ...(ACTION_METHODS[previewAction] ?? []),
        ]),
        rationale: Object.freeze(
          gaps.length > 0
            ? [
                'preview_prerequisite_gap',
                'concept_introduction_before_school',
              ]
            : ['confirmed_next_lesson', 'concept_introduction_before_school'],
        ),
        guardrails: Object.freeze(['preview_within_confirmed_scope']),
      }),
    )
  } else if (
    request.school.nextLessonConfirmed ||
    request.school.nextLessonKcs.length > 0
  ) {
    notes.push('preview_skipped_unconfirmed_scope')
  }

  phases.push(
    Object.freeze({
      phase: PHASE_SCHOOL,
      minutes: 0,
      action: ACTION_NONE,
      targetKcs: Object.freeze([]),
      methodIds: Object.freeze([]),
      rationale: Object.freeze([
        'school_time_not_monitored',
        'no_automatic_mastery_inference',
      ]),
      guardrails: Object.freeze(['school_time_is_not_observed']),
    }),
  )

  const reinforcementMinutes = allocations.ai_reinforcement ?? 0
  if (reinforcementMinutes > 0) {
    let reinforcementAction: StrategyAction
    let reinforcementTargets: readonly string[]
    let reinforcementMethods: readonly string[]
    let reinforcementRationale: readonly string[]
    if (!schoolProgressUsable(request.school)) {
      reinforcementAction = ACTION_REQUEST_PROGRESS_CONFIRMATION
      reinforcementTargets = []
      reinforcementMethods = []
      reinforcementRationale = ['school_progress_unconfirmed']
    } else if (request.hypothesisConflict) {
      reinforcementAction = ACTION_ASK_DIAGNOSTIC_QUESTION
      reinforcementTargets = dedupe(request.recentErrorKcs)
      reinforcementMethods =
        ACTION_METHODS[ACTION_ASK_DIAGNOSTIC_QUESTION] ?? []
      reinforcementRationale = ['hypothesis_conflict_requires_probe']
    } else if (request.recentErrorKcs.length > 0) {
      reinforcementAction = ACTION_ASSIGN_TARGETED_PRACTICE
      reinforcementTargets = dedupe(request.recentErrorKcs)
      reinforcementMethods =
        ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE] ?? []
      reinforcementRationale = ['errors_exposed_after_school']
    } else {
      const errors = errorsOf(request.knowledge)
      const misconceptions = misconceptionsOf(request.knowledge)
      if (errors.length > 0) {
        reinforcementAction = ACTION_ASSIGN_TARGETED_PRACTICE
        reinforcementTargets = errors.map((state) => state.kcId)
        reinforcementMethods =
          ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE] ?? []
        reinforcementRationale = ['procedural_errors_detected']
      } else if (misconceptions.length > 0) {
        reinforcementAction = ACTION_TEACH_MICRO_LESSON
        reinforcementTargets = misconceptions
          .slice(0, 3)
          .map((state) => state.kcId)
        reinforcementMethods =
          ACTION_METHODS[ACTION_TEACH_MICRO_LESSON] ?? []
        reinforcementRationale = ['conceptual_misconception']
      } else {
        reinforcementAction = ACTION_ASSIGN_TARGETED_PRACTICE
        reinforcementTargets = [...request.knowledge]
          .sort(
            (left, right) =>
              left.masteryMean - right.masteryMean ||
              compareStrings(left.kcId, right.kcId),
          )
          .slice(0, request.constraints.maxItems)
          .map((state) => state.kcId)
        reinforcementMethods =
          ACTION_METHODS[ACTION_ASSIGN_TARGETED_PRACTICE] ?? []
        reinforcementRationale = ['independent_practice_after_school']
      }
    }
    if (new Set(reinforcementTargets).size >= 2) {
      reinforcementMethods = [
        ...reinforcementMethods,
        METHOD_INTERLEAVING,
      ]
    }
    phases.push(
      Object.freeze({
        phase: PHASE_AI_REINFORCEMENT,
        minutes: reinforcementMinutes,
        action: reinforcementAction,
        targetKcs: Object.freeze([...reinforcementTargets]),
        methodIds: Object.freeze([...dedupe(reinforcementMethods)]),
        rationale: Object.freeze([...reinforcementRationale]),
        guardrails: Object.freeze(['independence_before_hints']),
      }),
    )
  }

  const reviewMinutes = allocations.review ?? 0
  if (reviewMinutes > 0 && hasReview) {
    let reviewTargets = due.map((review) => review.kcId)
    if (reviewTargets.length === 0 && request.school.examUpcoming) {
      reviewTargets = [...request.school.examKcs]
    }
    if (reviewTargets.length === 0) {
      reviewTargets = [...request.knowledge]
        .sort(
          (left, right) =>
            left.masteryMean - right.masteryMean ||
            compareStrings(left.kcId, right.kcId),
        )
        .map((state) => state.kcId)
    }
    let methods = [
      ...(ACTION_METHODS[ACTION_SCHEDULE_SPACED_REVIEW] ?? []),
    ]
    if (new Set(reviewTargets).size < 2) {
      methods = methods.filter((method) => method !== METHOD_INTERLEAVING)
    }
    phases.push(
      Object.freeze({
        phase: PHASE_REVIEW,
        minutes: reviewMinutes,
        action: ACTION_SCHEDULE_SPACED_REVIEW,
        targetKcs: Object.freeze(
          reviewTargets.slice(0, request.constraints.maxItems),
        ),
        methodIds: Object.freeze([...dedupe(methods)]),
        rationale: Object.freeze([
          due.length > 0 ? 'due_memory_units' : 'review_backlog',
        ]),
        guardrails: Object.freeze(['delayed_independent_recall']),
      }),
    )
  } else if (hasReview) {
    notes.push('review_budget_too_small')
  }

  const studyMinutes = phases.reduce((sum, phase) => sum + phase.minutes, 0)
  const blocks = Math.max(
    1,
    Math.ceil(studyMinutes / request.constraints.maxBlockMinutes),
  )
  const breakCount = Math.max(0, blocks - 1)
  const breakTotal = round1(
    breakCount * BREAK_MINUTES[request.constraints.breakPreference],
  )
  if (breakCount > 0) notes.push('breaks_scheduled')

  const guardrails = [...phaseGuardrails(request)]
  if (budget < request.totalMinutes - 0.05) {
    guardrails.push('daily_budget_capped_by_availability')
    notes.push('daily_budget_capped_by_availability')
  }
  if (Math.abs(studyMinutes - budget) > 0.05) {
    guardrails.push('phase_allocation_under_budget')
  }
  if (request.purpose === PURPOSE_SIMULATION) {
    notes.push('simulation_context_only')
  }

  return Object.freeze({
    studentRef: request.studentRef,
    totalMinutes: round1(studyMinutes),
    phases: Object.freeze(phases),
    breakCount,
    breakMinutesTotal: breakTotal,
    requiresConfirmation,
    blocked: false,
    guardrails: Object.freeze([...dedupe(guardrails)]),
    notes: Object.freeze([...dedupe(notes)]),
    evidenceSource: request.evidenceSource,
    simulatedEvidenceUsed: request.evidenceSource === SOURCE_SIMULATED,
  })
}

// ---------------------------------------------------------------------------
// Learning-science mapping (spec §18)
// ---------------------------------------------------------------------------

export interface LearningScienceMethod {
  readonly methodId: string
  readonly displayName: string
  readonly harnessActions: readonly string[]
  readonly conditions: readonly string[]
  readonly implementation: readonly string[]
  readonly verification: readonly string[]
  readonly guardrails: readonly string[]
  readonly status: 'implemented' | 'mapped'
}

export const LEARNING_SCIENCE_METHODS: readonly LearningScienceMethod[] =
  Object.freeze([
    Object.freeze({
      methodId: METHOD_RETRIEVAL_PRACTICE,
      displayName: '检索练习 / Retrieval Practice',
      harnessActions: Object.freeze([
        ACTION_ASSIGN_TARGETED_PRACTICE,
        ACTION_SCHEDULE_SPACED_REVIEW,
      ]),
      conditions: Object.freeze([
        'learned_content',
        'independent_first_attempt',
      ]),
      implementation: Object.freeze([
        'planRetrievalPractice: no answer or explanation before the attempt',
        'hint-assisted corrections are logged as hint_followup, not retrieval success',
        'reading an explanation has zero retrieval weight',
      ]),
      verification: Object.freeze([
        'unhinted_success_rate',
        'delayed_unseen_retrieval',
      ]),
      guardrails: Object.freeze([
        'no_answer_before_attempt',
        'reading_is_not_retrieval',
        'hint_assisted_correct_is_not_independent',
      ]),
      status: 'implemented',
    }),
    Object.freeze({
      methodId: METHOD_SPACED_PRACTICE,
      displayName: '间隔学习 / Spaced Practice',
      harnessActions: Object.freeze([ACTION_SCHEDULE_SPACED_REVIEW]),
      conditions: Object.freeze([
        'seen_before',
        'measurable_retention_task',
        'memory_stability_available',
      ]),
      implementation: Object.freeze([
        'planSpacedReview: due units ordered by current retrievability',
        'intervalForTarget derives the next review date from stability',
        'overdue units raise uncertainty instead of lowering mastery',
      ]),
      verification: Object.freeze([
        'delayed_independent_recall',
        'one_week_or_longer_retention',
      ]),
      guardrails: Object.freeze([
        'do_not_reteach_whole_course',
        'spacing_uses_memory_stability',
      ]),
      status: 'implemented',
    }),
    Object.freeze({
      methodId: METHOD_INTERLEAVING,
      displayName: '交错练习 / Interleaving',
      harnessActions: Object.freeze([
        ACTION_ASSIGN_TARGETED_PRACTICE,
        ACTION_SCHEDULE_SPACED_REVIEW,
      ]),
      conditions: Object.freeze([
        'basic_understanding_established',
        'confusable_methods_or_old_kcs',
      ]),
      implementation: Object.freeze([
        'planInterleavedPractice: no adjacent same-KC block when avoidable',
        'mix confusable methods only after the mastery floor',
        'sequence and block boundaries are deterministic',
      ]),
      verification: Object.freeze([
        'strategy_selection_accuracy_on_new_items',
        'reduced_same_error_repetition',
      ]),
      guardrails: Object.freeze([
        'do_not_interleave_before_basics',
        'mix_confusable_methods_not_random_noise',
      ]),
      status: 'implemented',
    }),
    Object.freeze({
      methodId: METHOD_WORKED_EXAMPLES,
      displayName: '示范例题 / Worked Examples',
      harnessActions: Object.freeze([ACTION_SHOW_WORKED_EXAMPLE]),
      conditions: Object.freeze(['new_content', 'weak_prerequisite']),
      implementation: Object.freeze([
        'full worked steps with labelled sub-goals',
        'fade steps after understanding',
      ]),
      verification: Object.freeze(['subsequent_independent_solving']),
      guardrails: Object.freeze([
        'avoid_worked_example_during_assessment',
      ]),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_FADING_SCAFFOLDS,
      displayName: '支架渐隐 / Fading Scaffolds',
      harnessActions: Object.freeze([
        ACTION_GIVE_MINIMAL_HINT,
        ACTION_ASSIGN_TARGETED_PRACTICE,
      ]),
      conditions: Object.freeze([
        'partial_understanding',
        'prompt_dependence',
      ]),
      implementation: Object.freeze([
        'hint ladder with explicit levels',
        'remove fill-in/formula prompts step by step',
      ]),
      verification: Object.freeze(['independent_completion_without_hints']),
      guardrails: Object.freeze(['log_each_hint_level']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_SELF_EXPLANATION,
      displayName: '自我解释 / Self-explanation',
      harnessActions: Object.freeze([ACTION_TEACH_MICRO_LESSON]),
      conditions: Object.freeze([
        'conceptual_understanding',
        'rule_correction',
      ]),
      implementation: Object.freeze([
        'ask why this step is valid',
        'require an explanation before transfer',
      ]),
      verification: Object.freeze([
        'explains_key_principle_on_a_new_item',
      ]),
      guardrails: Object.freeze([
        'do_not_accept_keyword_only_explanation',
      ]),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_ELABORATIVE_INTERROGATION,
      displayName: '精细追问 / Elaborative Interrogation',
      harnessActions: Object.freeze([ACTION_TEACH_MICRO_LESSON]),
      conditions: Object.freeze(['needs_prerequisite_connection']),
      implementation: Object.freeze([
        'why is it true? what is a counterexample?',
      ]),
      verification: Object.freeze(['counterexample_and_transfer_item']),
      guardrails: Object.freeze([
        'keep_questions_within_confirmed_scope',
      ]),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_CONTRASTIVE_LEARNING,
      displayName: '对比题 / Contrastive Learning',
      harnessActions: Object.freeze([ACTION_TEACH_MICRO_LESSON]),
      conditions: Object.freeze(['stable_error_rule']),
      implementation: Object.freeze([
        'compare correct vs incorrect method on the same surface features',
      ]),
      verification: Object.freeze(['error_does_not_repeat_on_unseen_items']),
      guardrails: Object.freeze(['one_error_at_a_time']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_PRODUCTIVE_FAILURE,
      displayName: '有支持的尝试 / Productive Failure',
      harnessActions: Object.freeze([ACTION_ASSIGN_TARGETED_PRACTICE]),
      conditions: Object.freeze([
        'available_prerequisites',
        'failure_cost_bounded',
      ]),
      implementation: Object.freeze([
        'attempt first, then structured hints',
      ]),
      verification: Object.freeze(['later_understanding_and_transfer']),
      guardrails: Object.freeze(['stop_before_frustration_budget']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_MASTERY_LEARNING,
      displayName: '掌握学习 / Mastery Learning',
      harnessActions: Object.freeze([
        ACTION_ASSIGN_TARGETED_PRACTICE,
        ACTION_ASSIGN_TRANSFER_TASK,
      ]),
      conditions: Object.freeze(['explicit_prerequisite_dependency']),
      implementation: Object.freeze([
        'require a verifiable standard before dependent tasks',
      ]),
      verification: Object.freeze([
        'independent_test_and_spaced_retention',
      ]),
      guardrails: Object.freeze(['mastery_not_self_declared']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_METACOGNITIVE_PROMPTS,
      displayName: '元认知提示 / Metacognitive Prompts',
      harnessActions: Object.freeze([ACTION_ASK_DIAGNOSTIC_QUESTION]),
      conditions: Object.freeze(['missing_self_check_strategy']),
      implementation: Object.freeze([
        'predict, check steps, reflect after answering',
      ]),
      verification: Object.freeze([
        'self_correction_rate_and_hint_dependence',
      ]),
      guardrails: Object.freeze(['prompts_are_skippable']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_DUAL_CODING,
      displayName: '多表征 / Dual Coding',
      harnessActions: Object.freeze([
        ACTION_SHOW_WORKED_EXAMPLE,
        ACTION_TEACH_MICRO_LESSON,
      ]),
      conditions: Object.freeze(['diagram_or_visual_mapping_helps']),
      implementation: Object.freeze([
        'pair formula, diagram, graph and text',
      ]),
      verification: Object.freeze(['cross_representation_transfer']),
      guardrails: Object.freeze([
        'one_representation_at_a_time_for_novices',
      ]),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_COGNITIVE_LOAD_CONTROL,
      displayName: '认知负荷管理 / Cognitive Load Control',
      harnessActions: Object.freeze([
        ACTION_SHOW_WORKED_EXAMPLE,
        ACTION_GIVE_MINIMAL_HINT,
      ]),
      conditions: Object.freeze([
        'novice',
        'complex_stem',
        'overload_signal',
      ]),
      implementation: Object.freeze([
        'limit information, handle one error at a time',
      ]),
      verification: Object.freeze([
        'completion_and_error_pattern_change',
      ]),
      guardrails: Object.freeze(['respect_time_and_break_budget']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_ERROR_FOCUSED_PRACTICE,
      displayName: '错因专项 / Error-focused Practice',
      harnessActions: Object.freeze([ACTION_ASSIGN_TARGETED_PRACTICE]),
      conditions: Object.freeze([
        'multiple_evidence_for_a_specific_error_rule',
      ]),
      implementation: Object.freeze([
        'generate variants targeting that error rule',
      ]),
      verification: Object.freeze([
        'no_repeat_of_the_same_error_on_unseen_items',
      ]),
      guardrails: Object.freeze([
        'error_hypothesis_must_be_evidence_backed',
      ]),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_NEAR_FAR_TRANSFER,
      displayName: '近/远迁移 / Near/Far Transfer',
      harnessActions: Object.freeze([ACTION_ASSIGN_TRANSFER_TASK]),
      conditions: Object.freeze(['basic_procedure_stable']),
      implementation: Object.freeze([
        'move application context gradually farther',
      ]),
      verification: Object.freeze([
        'unseen_application_and_synthesis_items',
      ]),
      guardrails: Object.freeze(['transfer_item_must_be_unseen']),
      status: 'mapped',
    }),
    Object.freeze({
      methodId: METHOD_SELF_REGULATED_LEARNING,
      displayName: '自我调节 / Self-regulated Learning',
      harnessActions: Object.freeze([
        ACTION_REQUEST_PROGRESS_CONFIRMATION,
      ]),
      conditions: Object.freeze([
        'self_directed_or_exam_preparation',
      ]),
      implementation: Object.freeze([
        'co-set goals and reflect on the plan',
      ]),
      verification: Object.freeze(['plan_completion_quality']),
      guardrails: Object.freeze([
        'learner_can_shorten_or_end_the_session',
      ]),
      status: 'mapped',
    }),
  ])

export const METHODS_BY_ID: ReadonlyMap<string, LearningScienceMethod> = new Map(
  LEARNING_SCIENCE_METHODS.map((method) => [method.methodId, method]),
)

export function methodById(methodId: string): LearningScienceMethod {
  const method = METHODS_BY_ID.get(methodId)
  if (method === undefined) {
    throw new TeachingStrategyError(`unknown method: ${methodId}`)
  }
  return method
}

export function learningScienceChecklist(): readonly LearningScienceMethod[] {
  return LEARNING_SCIENCE_METHODS
}

export function methodsForAction(action: string): readonly string[] {
  const methods = ACTION_METHODS[action]
  if (methods === undefined) {
    throw new TeachingStrategyError(`unknown action: ${action}`)
  }
  return methods
}

// ---------------------------------------------------------------------------
// Executable learning-science plans
// ---------------------------------------------------------------------------

export interface RetrievalPlan {
  readonly methodId: string
  readonly kcIds: readonly string[]
  readonly sequence: readonly string[]
  readonly minutes: number
  readonly maxItems: number
  readonly itemIds: readonly string[]
  readonly showAnswerFirst: boolean
  readonly independent: boolean
  readonly verification: readonly string[]
  readonly guardrails: readonly string[]
}

export function planRetrievalPractice(
  kcIds: readonly string[],
  options: {
    readonly knowledge?: readonly KnowledgeStateInput[]
    readonly availableMinutes?: number
    readonly maxItems?: number
    readonly itemIds?: readonly string[]
  } = {},
): RetrievalPlan {
  const availableMinutes = options.availableMinutes ?? 10
  if (availableMinutes <= 0) {
    throw new TeachingStrategyError('availableMinutes must be > 0')
  }
  const maxItems = options.maxItems ?? 6
  if (maxItems < 1) {
    throw new TeachingStrategyError('maxItems must be >= 1')
  }
  const unique = dedupe(kcIds)
  if (unique.length === 0) {
    throw new TeachingStrategyError(
      'retrieval practice requires at least one KC',
    )
  }
  const states = knowledgeMap(
    (options.knowledge ?? []).map(normalizeKnowledgeState),
  )
  const unlearned = unique.filter((kc) => {
    const state = states.get(kc)
    return state !== undefined && !state.learned
  })
  if (unlearned.length > 0) {
    throw new TeachingStrategyError(
      `retrieval_requires_learned_kc:${unlearned.join(',')}`,
    )
  }
  const items = dedupe(options.itemIds ?? [])
  if (items.length > 0 && items.length !== unique.length) {
    throw new TeachingStrategyError(
      'itemIds must have one entry per kcId when provided',
    )
  }
  const scheduled =
    items.length > 0 ? items.slice(0, maxItems) : unique.slice(0, maxItems)
  return Object.freeze({
    methodId: METHOD_RETRIEVAL_PRACTICE,
    kcIds: Object.freeze([...unique.slice(0, maxItems)]),
    sequence: Object.freeze([...scheduled]),
    minutes: round1(
      Math.min(availableMinutes, Math.max(1, scheduled.length * 2.5)),
    ),
    maxItems,
    itemIds: Object.freeze([...items.slice(0, maxItems)]),
    showAnswerFirst: false,
    independent: true,
    verification: Object.freeze([
      'unhinted_success_rate',
      'delayed_unseen_retrieval',
    ]),
    guardrails: Object.freeze([
      'no_answer_before_attempt',
      'reading_is_not_retrieval',
      'hint_assisted_correct_is_not_independent',
    ]),
  })
}

export interface SpacedReviewSlot {
  readonly kcId: string
  readonly elapsedDays: number
  readonly stabilityDays: number
  readonly retrievability: number
  readonly intervalDays: number
  readonly priority: number
  readonly minutes: number
}

export interface SpacedReviewPlan {
  readonly methodId: string
  readonly slots: readonly SpacedReviewSlot[]
  readonly minutes: number
  readonly targetRetention: number
  readonly verification: readonly string[]
  readonly guardrails: readonly string[]
}

export function planSpacedReview(
  dueReviews: readonly DueReviewInput[],
  options: {
    readonly availableMinutes?: number
    readonly maxItems?: number
    readonly targetRetention?: number
  } = {},
): SpacedReviewPlan {
  const availableMinutes = options.availableMinutes ?? 10
  if (availableMinutes <= 0) {
    throw new TeachingStrategyError('availableMinutes must be > 0')
  }
  const maxItems = options.maxItems ?? 6
  if (maxItems < 1) {
    throw new TeachingStrategyError('maxItems must be >= 1')
  }
  const targetRetention =
    options.targetRetention ?? DEFAULT_REVIEW_TARGET_RETENTION
  if (targetRetention <= 0 || targetRetention >= 1) {
    throw new TeachingStrategyError('targetRetention must be within (0, 1)')
  }
  const due = dueSorted(dueReviews.map(normalizeDueReview))
  if (due.length === 0) {
    throw new TeachingStrategyError(
      'spaced review requires at least one due unit',
    )
  }
  const selected = due.slice(0, maxItems)
  const perSlot = round1(Math.min(2.5, availableMinutes / selected.length))
  const slots = selected.map((review) =>
    Object.freeze({
      kcId: review.kcId,
      elapsedDays: review.elapsedDays,
      stabilityDays: review.stabilityDays,
      retrievability: dueReviewRetrievability(review),
      intervalDays: intervalForTarget(
        review.stabilityDays,
        targetRetention,
      ),
      priority: round1(Math.max(0, 1 - dueReviewRetrievability(review))),
      minutes: perSlot,
    }),
  )
  return Object.freeze({
    methodId: METHOD_SPACED_PRACTICE,
    slots: Object.freeze(slots),
    minutes: round1(
      Math.min(availableMinutes, perSlot * selected.length),
    ),
    targetRetention,
    verification: Object.freeze([
      'delayed_independent_recall',
      'one_week_or_longer_retention',
    ]),
    guardrails: Object.freeze([
      'do_not_reteach_whole_course',
      'spacing_uses_memory_stability',
      'overdue_raises_uncertainty_not_lower_mastery',
    ]),
  })
}

export interface PracticeUnitInput {
  readonly unitId: string
  readonly kcId: string
  readonly difficulty?: number
  readonly confusableGroup?: string | null
}

export interface PracticeUnit {
  readonly unitId: string
  readonly kcId: string
  readonly difficulty: number
  readonly confusableGroup: string | null
}

export function normalizePracticeUnit(input: PracticeUnitInput): PracticeUnit {
  if (typeof input.unitId !== 'string' || input.unitId.length === 0) {
    throw new TeachingStrategyError('unitId must be a non-empty string')
  }
  if (typeof input.kcId !== 'string' || input.kcId.length === 0) {
    throw new TeachingStrategyError('kcId must be a non-empty string')
  }
  return Object.freeze({
    unitId: input.unitId,
    kcId: input.kcId,
    difficulty: clamp01(input.difficulty ?? 0.5, 'difficulty'),
    confusableGroup: input.confusableGroup ?? null,
  })
}

export interface InterleavingPlan {
  readonly methodId: string
  readonly sequence: readonly PracticeUnit[]
  readonly blocks: readonly (readonly string[])[]
  readonly minutes: number
  readonly distinctKcs: number
  readonly verification: readonly string[]
  readonly guardrails: readonly string[]
}

function interleave(
  units: readonly PracticeUnit[],
  maxItems: number,
): PracticeUnit[] {
  const queues = new Map<string, PracticeUnit[]>()
  for (const unit of units) {
    const queue = queues.get(unit.kcId) ?? []
    queue.push(unit)
    queues.set(unit.kcId, queue)
  }
  const remaining = new Map<string, number>()
  for (const [kc, queue] of queues) remaining.set(kc, queue.length)
  const sequence: PracticeUnit[] = []
  let previous: string | null = null
  while (sequence.length < maxItems) {
    let candidates = [...remaining.entries()].filter(
      ([kc, count]) => count > 0 && kc !== previous,
    )
    if (candidates.length === 0) {
      candidates = [...remaining.entries()].filter(([, count]) => count > 0)
    }
    if (candidates.length === 0) break
    candidates.sort(
      (left, right) =>
        right[1] - left[1] || compareStrings(right[0], left[0]),
    )
    const kc = candidates[0][0]
    const queue = queues.get(kc)
    if (queue === undefined || queue.length === 0) break
    const unit = queue.shift()
    if (unit === undefined) break
    sequence.push(unit)
    remaining.set(kc, (remaining.get(kc) ?? 1) - 1)
    previous = kc
  }
  return sequence
}

export function planInterleavedPractice(
  units: readonly PracticeUnitInput[],
  options: {
    readonly masteryByKc?: Readonly<Record<string, number>>
    readonly minMastery?: number
    readonly availableMinutes?: number
    readonly maxItems?: number
    readonly blockSize?: number
  } = {},
): InterleavingPlan {
  const availableMinutes = options.availableMinutes ?? 15
  if (availableMinutes <= 0) {
    throw new TeachingStrategyError('availableMinutes must be > 0')
  }
  const maxItems = options.maxItems ?? 12
  if (maxItems < 2) {
    throw new TeachingStrategyError('maxItems must be >= 2')
  }
  const blockSize = options.blockSize ?? 4
  if (blockSize < 1) {
    throw new TeachingStrategyError('blockSize must be >= 1')
  }
  if (units.length === 0) {
    throw new TeachingStrategyError('interleaving requires practice units')
  }
  const normalized = units.map(normalizePracticeUnit)
  const distinct = new Set(normalized.map((unit) => unit.kcId))
  if (distinct.size < 2) {
    throw new TeachingStrategyError('interleaving_requires_multiple_kcs')
  }
  const minMastery = options.minMastery ?? DEFAULT_INTERLEAVING_MASTERY
  const mastery = options.masteryByKc ?? {}
  const weak = [...distinct]
    .sort(compareStrings)
    .filter(
      (kc) => Object.hasOwn(mastery, kc) && mastery[kc] < minMastery,
    )
  if (weak.length > 0) {
    throw new TeachingStrategyError(
      `interleaving_requires_basic_understanding:${weak.join(',')}`,
    )
  }
  const sequence = interleave(normalized, maxItems)
  const blocks: string[][] = []
  for (let index = 0; index < sequence.length; index += blockSize) {
    blocks.push(
      sequence.slice(index, index + blockSize).map((unit) => unit.unitId),
    )
  }
  return Object.freeze({
    methodId: METHOD_INTERLEAVING,
    sequence: Object.freeze(sequence),
    blocks: Object.freeze(blocks.map((block) => Object.freeze(block))),
    minutes: round1(
      Math.min(availableMinutes, Math.max(2, sequence.length * 2)),
    ),
    distinctKcs: distinct.size,
    verification: Object.freeze([
      'strategy_selection_accuracy_on_new_items',
      'reduced_same_error_repetition',
    ]),
    guardrails: Object.freeze([
      'do_not_interleave_before_basics',
      'mix_confusable_methods_not_random_noise',
    ]),
  })
}

// ---------------------------------------------------------------------------
// Cross-subject adaptation (spec §17)
// ---------------------------------------------------------------------------

export const SUBJECT_MATH = 'math'
export const SUBJECT_PHYSICS = 'physics'

export interface SubjectEvidenceInput {
  readonly evidenceId: string
  readonly kcId: string
  readonly kind: string
  readonly independent?: boolean
  readonly verifiedBy?: string | null
}

export interface SubjectEvidence {
  readonly evidenceId: string
  readonly kcId: string
  readonly kind: string
  readonly independent: boolean
  readonly verifiedBy: string | null
}

export function normalizeSubjectEvidence(
  input: SubjectEvidenceInput,
): SubjectEvidence {
  for (const [name, value] of [
    ['evidenceId', input.evidenceId],
    ['kcId', input.kcId],
    ['kind', input.kind],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TeachingStrategyError(`${name} must be a non-empty string`)
    }
  }
  return Object.freeze({
    evidenceId: input.evidenceId,
    kcId: input.kcId,
    kind: input.kind,
    independent: input.independent ?? true,
    verifiedBy: input.verifiedBy ?? null,
  })
}

export interface SubjectAdaptation {
  readonly subjectId: string
  readonly accepted: boolean
  readonly reasons: readonly string[]
  readonly validators: readonly string[]
  readonly evidenceRequirements: readonly string[]
  readonly safetyRequired: boolean
  readonly strategyModifiers: Readonly<Record<string, number>>
}

export interface SubjectAdapterSpec {
  readonly subjectId: string
  readonly displayName: string
  readonly kcPrefix: string
  readonly kcTypes: readonly string[]
  readonly evidenceKinds: readonly string[]
  readonly validators: readonly string[]
  readonly strategyModifiers: Readonly<Record<string, number>>
  readonly requiredEvidence?: readonly string[]
  readonly highRiskKcPrefixes?: readonly string[]
  readonly safetyNote?: string
}

export class SubjectAdapter {
  readonly subjectId: string
  readonly displayName: string
  readonly kcPrefix: string
  readonly kcTypes: readonly string[]
  readonly evidenceKinds: ReadonlySet<string>
  readonly validators: readonly string[]
  readonly strategyModifiers: Readonly<Record<string, number>>
  readonly requiredEvidence: readonly string[]
  readonly highRiskKcPrefixes: readonly string[]
  readonly safetyNote: string

  constructor(spec: SubjectAdapterSpec) {
    for (const [name, value] of [
      ['subjectId', spec.subjectId],
      ['displayName', spec.displayName],
      ['kcPrefix', spec.kcPrefix],
    ] as const) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new TeachingStrategyError(`${name} must be a non-empty string`)
      }
    }
    this.subjectId = spec.subjectId
    this.displayName = spec.displayName
    this.kcPrefix = spec.kcPrefix
    this.kcTypes = Object.freeze([...spec.kcTypes])
    this.evidenceKinds = new Set(spec.evidenceKinds)
    this.validators = Object.freeze([...spec.validators])
    this.strategyModifiers = Object.freeze({ ...spec.strategyModifiers })
    this.requiredEvidence = Object.freeze([
      ...(spec.requiredEvidence ?? ['independent_attempt']),
    ])
    this.highRiskKcPrefixes = Object.freeze([
      ...(spec.highRiskKcPrefixes ?? []),
    ])
    this.safetyNote = spec.safetyNote ?? ''
  }

  supportsKc(kcId: string): boolean {
    return typeof kcId === 'string' && kcId.startsWith(this.kcPrefix)
  }

  highRisk(kcIds: readonly string[]): boolean {
    return kcIds.some((kc) =>
      this.highRiskKcPrefixes.some((prefix) => kc.startsWith(prefix)),
    )
  }

  validateEvidence(input: SubjectEvidenceInput): readonly string[] {
    const evidence = normalizeSubjectEvidence(input)
    const reasons: string[] = []
    if (!this.supportsKc(evidence.kcId)) {
      reasons.push(`unsupported_kc:${evidence.kcId}`)
    }
    if (!this.evidenceKinds.has(evidence.kind)) {
      reasons.push(`unsupported_evidence_kind:${evidence.kind}`)
    }
    if (!evidence.independent) reasons.push('evidence_not_independent')
    if (evidence.verifiedBy === null) {
      reasons.push('evidence_not_verified')
    } else if (!this.validators.includes(evidence.verifiedBy)) {
      reasons.push(`unverified_evidence:${evidence.verifiedBy}`)
    }
    return Object.freeze(reasons)
  }

  adapt(decision: StrategyDecision): SubjectAdaptation {
    const reasons: string[] = []
    if (decision.blocked || decision.action === ACTION_NONE) {
      reasons.push('strategy_blocked')
    }
    const unsupported = decision.targetKcs.filter(
      (kc) => !this.supportsKc(kc),
    )
    if (unsupported.length > 0) {
      reasons.push(`unsupported_kc:${unsupported.join(',')}`)
    }
    return Object.freeze({
      subjectId: this.subjectId,
      accepted: reasons.length === 0,
      reasons: Object.freeze(reasons),
      validators: this.validators,
      evidenceRequirements: this.requiredEvidence,
      safetyRequired: this.highRisk(decision.targetKcs),
      strategyModifiers: this.strategyModifiers,
    })
  }

  toJSON(): Record<string, unknown> {
    return {
      subjectId: this.subjectId,
      displayName: this.displayName,
      kcPrefix: this.kcPrefix,
      kcTypes: [...this.kcTypes],
      evidenceKinds: [...this.evidenceKinds].sort(compareStrings),
      validators: [...this.validators],
      requiredEvidence: [...this.requiredEvidence],
      highRiskKcPrefixes: [...this.highRiskKcPrefixes],
      safetyNote: this.safetyNote,
      strategyModifiers: { ...this.strategyModifiers },
    }
  }
}

export class MathSubjectAdapter extends SubjectAdapter {
  constructor() {
    super({
      subjectId: SUBJECT_MATH,
      displayName: 'Mathematics',
      kcPrefix: 'kc.math.',
      kcTypes: ['procedure', 'concept', 'representation', 'strategy'],
      evidenceKinds: [
        'numeric_answer',
        'symbolic_equivalence',
        'step_equivalence',
        'transfer_probe',
      ],
      validators: [
        'answer_key',
        'cas_step_equivalence',
        'symbolic_equivalence',
      ],
      strategyModifiers: {
        [ACTION_SHOW_WORKED_EXAMPLE]: 0.1,
        [ACTION_ASSIGN_TARGETED_PRACTICE]: 0.1,
        [ACTION_ASSIGN_TRANSFER_TASK]: 0.15,
      },
      highRiskKcPrefixes: [],
    })
  }
}

export class PhysicsSubjectAdapter extends SubjectAdapter {
  constructor() {
    super({
      subjectId: SUBJECT_PHYSICS,
      displayName: 'Physics',
      kcPrefix: 'kc.physics.',
      kcTypes: ['model', 'procedure', 'concept', 'representation'],
      evidenceKinds: [
        'numeric_answer',
        'free_body_diagram',
        'unit_check',
        'model_explanation',
        'transfer_probe',
      ],
      validators: [
        'answer_key',
        'unit_check',
        'dimensional_analysis',
        'symbolic_check',
      ],
      strategyModifiers: {
        [ACTION_SHOW_WORKED_EXAMPLE]: 0.15,
        [ACTION_ASSIGN_TARGETED_PRACTICE]: 0.05,
        [ACTION_ASSIGN_TRANSFER_TASK]: 0.1,
      },
      highRiskKcPrefixes: ['kc.physics.electricity.'],
      safetyNote:
        'Electrical/high-voltage practical guidance requires host safety ' +
        'review; this adapter never generates dangerous operation details.',
    })
  }
}

export const MATH_SUBJECT = new MathSubjectAdapter()
export const PHYSICS_SUBJECT = new PhysicsSubjectAdapter()

export class SubjectRegistry {
  private readonly adapters = new Map<string, SubjectAdapter>()

  constructor(adapters: readonly SubjectAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: SubjectAdapter): SubjectAdapter {
    if (this.adapters.has(adapter.subjectId)) {
      throw new SubjectAdapterError(
        `duplicate subject adapter: ${adapter.subjectId}`,
      )
    }
    this.adapters.set(adapter.subjectId, adapter)
    return adapter
  }

  get(subjectId: string): SubjectAdapter {
    const adapter = this.adapters.get(subjectId)
    if (adapter === undefined) {
      throw new SubjectAdapterError(`unknown subject adapter: ${subjectId}`)
    }
    return adapter
  }

  adapt(subjectId: string, decision: StrategyDecision): SubjectAdaptation {
    return this.get(subjectId).adapt(decision)
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const subjectId of [...this.adapters.keys()].sort(compareStrings)) {
      result[subjectId] = this.adapters.get(subjectId)?.toJSON()
    }
    return result
  }

  get size(): number {
    return this.adapters.size
  }

  [Symbol.iterator](): Iterator<SubjectAdapter> {
    return this.adapters.values()
  }
}

export const DEFAULT_SUBJECT_REGISTRY = new SubjectRegistry([
  MATH_SUBJECT,
  PHYSICS_SUBJECT,
])

/** Describe the shared interface and the two concrete examples. */
export function crossSubjectContract(): Record<string, unknown> {
  return {
    shared: [
      'kc_id',
      'evidence',
      'strategy_decision',
      'validators',
      'safety',
    ],
    subjects: DEFAULT_SUBJECT_REGISTRY.toJSON(),
  }
}
