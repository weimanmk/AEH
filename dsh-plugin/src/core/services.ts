/**
 * Service boundaries, storage contracts and the Harness state machine
 * (spec §12 / §13). TypeScript mirror of `aeh/services.py` (Step 16).
 *
 * Four storage-agnostic service boundaries are exposed, each with an
 * in-memory and a JSON-file implementation:
 *
 *   1. `EventStore`              append-only learning events, idempotency keys,
 *                                optimistic concurrency, observed/simulated
 *                                storage-domain isolation;
 *   2. `ProfileStore` / `BundleStore`  minimal student profile and frozen,
 *                                content-addressed version bundles;
 *   3. `ContentLibraryService`   versioned, review-gated content summaries;
 *   4. `EvaluationService`       immutable frozen evaluation sets and isolated
 *                                evaluation runs (simulation never self-proves).
 *
 * `WriteCoordinator` serialises per-stream writes and memoises idempotent
 * operations. `HarnessStateMachine` is the typed §12.2 workflow with bounded
 * rework loops and the §15.3 failure/degradation branches.
 *
 * Everything is synthetic and local; the JSON-file stores are a single-machine
 * model, not a production database (no cross-process locking, encryption or
 * retention policy). The shared fixture `tests/fixtures/services_step16.json`
 * is read by both the Python and TypeScript tests.
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type StorageDomain = 'observed' | 'simulated'
export type EventSource = 'observed' | 'simulated'
export type Scalar = string | number | boolean | null
export type Payload = Readonly<Record<string, Scalar>>

export const DOMAIN_OBSERVED: StorageDomain = 'observed'
export const DOMAIN_SIMULATED: StorageDomain = 'simulated'
export const STORAGE_DOMAINS = Object.freeze([
  DOMAIN_OBSERVED,
  DOMAIN_SIMULATED,
] as const)

export const SOURCE_OBSERVED: EventSource = 'observed'
export const SOURCE_SIMULATED: EventSource = 'simulated'
export const EVENT_SOURCES = Object.freeze([
  SOURCE_OBSERVED,
  SOURCE_SIMULATED,
] as const)

export const EVENT_SCHEMA_VERSION = 'aeh.event.v1'
export const PROVENANCE_SYNTHETIC = 'synthetic'
export const MAX_PAYLOAD_CHARS = 4096

// Event catalogue (spec §22.1).
export const EVENT_USER_QUESTION_SUBMITTED = 'USER_QUESTION_SUBMITTED'
export const EVENT_QUESTION_IMAGE_UPLOADED = 'QUESTION_IMAGE_UPLOADED'
export const EVENT_STUDENT_TRACE_SUBMITTED = 'STUDENT_TRACE_SUBMITTED'
export const EVENT_INDEPENDENT_ATTEMPT = 'INDEPENDENT_ATTEMPT'
export const EVENT_HINT_REQUESTED = 'HINT_REQUESTED'
export const EVENT_ANSWER_REVISED_AFTER_HINT = 'ANSWER_REVISED_AFTER_HINT'
export const EVENT_SCHOOL_LESSON_REPORTED = 'SCHOOL_LESSON_REPORTED'
export const EVENT_SCHOOL_PROGRESS_CONFIRMED = 'SCHOOL_PROGRESS_CONFIRMED'
export const EVENT_TEACHER_FEEDBACK_SUBMITTED = 'TEACHER_FEEDBACK_SUBMITTED'
export const EVENT_ASSESSMENT_GRADED = 'ASSESSMENT_GRADED'
export const EVENT_HYPOTHESIS_CREATED = 'HYPOTHESIS_CREATED'
export const EVENT_HYPOTHESIS_SPLIT = 'HYPOTHESIS_SPLIT'
export const EVENT_HYPOTHESIS_MERGED = 'HYPOTHESIS_MERGED'
export const EVENT_HYPOTHESIS_ARCHIVED = 'HYPOTHESIS_ARCHIVED'
export const EVENT_DIAGNOSTIC_PROBE_SELECTED = 'DIAGNOSTIC_PROBE_SELECTED'
export const EVENT_SIMULATION_STARTED = 'SIMULATION_STARTED'
export const EVENT_SIMULATION_COMPLETED = 'SIMULATION_COMPLETED'
export const EVENT_INTERVENTION_SELECTED = 'INTERVENTION_SELECTED'
export const EVENT_INTERVENTION_DELIVERED = 'INTERVENTION_DELIVERED'
export const EVENT_UNSEEN_TRANSFER_ATTEMPTED = 'UNSEEN_TRANSFER_ATTEMPTED'
export const EVENT_REVIEW_DUE = 'REVIEW_DUE'
export const EVENT_REVIEW_COMPLETED = 'REVIEW_COMPLETED'
export const EVENT_MEMORY_MODEL_REFITTED = 'MEMORY_MODEL_REFITTED'
export const EVENT_TWIN_RECALCULATED = 'TWIN_RECALCULATED'
export const EVENT_CURRICULUM_GATE_REJECTED = 'CURRICULUM_GATE_REJECTED'
export const EVENT_QUALITY_REVIEW_REQUESTED = 'QUALITY_REVIEW_REQUESTED'
export const EVENT_EDU_PLUGIN_LOADED = 'EDU_PLUGIN_LOADED'
export const EVENT_EDU_PLUGIN_UNLOADED = 'EDU_PLUGIN_UNLOADED'
export const EVENT_EDU_PLUGIN_PERMISSION_DENIED = 'EDU_PLUGIN_PERMISSION_DENIED'
export const EVENT_EDU_CAPABILITY_VERSION_CHANGED = 'EDU_CAPABILITY_VERSION_CHANGED'
export const EVENT_EVOLUTION_PROPOSAL_CREATED = 'EVOLUTION_PROPOSAL_CREATED'
export const EVENT_EVOLUTION_CANDIDATE_SANDBOXED = 'EVOLUTION_CANDIDATE_SANDBOXED'
export const EVENT_EVOLUTION_OFFLINE_EVALUATED = 'EVOLUTION_OFFLINE_EVALUATED'
export const EVENT_EVOLUTION_CANDIDATE_REJECTED = 'EVOLUTION_CANDIDATE_REJECTED'
export const EVENT_EVOLUTION_HUMAN_APPROVED = 'EVOLUTION_HUMAN_APPROVED'
export const EVENT_EVOLUTION_CANARY_STARTED = 'EVOLUTION_CANARY_STARTED'
export const EVENT_EVOLUTION_PROMOTED = 'EVOLUTION_PROMOTED'
export const EVENT_EVOLUTION_ROLLED_BACK = 'EVOLUTION_ROLLED_BACK'
export const EVENT_EVOLUTION_DRIFT_ALERTED = 'EVOLUTION_DRIFT_ALERTED'

export const SIMULATION_EVENT_TYPES = Object.freeze([
  EVENT_SIMULATION_STARTED,
  EVENT_SIMULATION_COMPLETED,
] as const)

export const EVENT_TYPES: readonly string[] = Object.freeze([
  EVENT_USER_QUESTION_SUBMITTED,
  EVENT_QUESTION_IMAGE_UPLOADED,
  EVENT_STUDENT_TRACE_SUBMITTED,
  EVENT_INDEPENDENT_ATTEMPT,
  EVENT_HINT_REQUESTED,
  EVENT_ANSWER_REVISED_AFTER_HINT,
  EVENT_SCHOOL_LESSON_REPORTED,
  EVENT_SCHOOL_PROGRESS_CONFIRMED,
  EVENT_TEACHER_FEEDBACK_SUBMITTED,
  EVENT_ASSESSMENT_GRADED,
  EVENT_HYPOTHESIS_CREATED,
  EVENT_HYPOTHESIS_SPLIT,
  EVENT_HYPOTHESIS_MERGED,
  EVENT_HYPOTHESIS_ARCHIVED,
  EVENT_DIAGNOSTIC_PROBE_SELECTED,
  EVENT_SIMULATION_STARTED,
  EVENT_SIMULATION_COMPLETED,
  EVENT_INTERVENTION_SELECTED,
  EVENT_INTERVENTION_DELIVERED,
  EVENT_UNSEEN_TRANSFER_ATTEMPTED,
  EVENT_REVIEW_DUE,
  EVENT_REVIEW_COMPLETED,
  EVENT_MEMORY_MODEL_REFITTED,
  EVENT_TWIN_RECALCULATED,
  EVENT_CURRICULUM_GATE_REJECTED,
  EVENT_QUALITY_REVIEW_REQUESTED,
  EVENT_EDU_PLUGIN_LOADED,
  EVENT_EDU_PLUGIN_UNLOADED,
  EVENT_EDU_PLUGIN_PERMISSION_DENIED,
  EVENT_EDU_CAPABILITY_VERSION_CHANGED,
  EVENT_EVOLUTION_PROPOSAL_CREATED,
  EVENT_EVOLUTION_CANDIDATE_SANDBOXED,
  EVENT_EVOLUTION_OFFLINE_EVALUATED,
  EVENT_EVOLUTION_CANDIDATE_REJECTED,
  EVENT_EVOLUTION_HUMAN_APPROVED,
  EVENT_EVOLUTION_CANARY_STARTED,
  EVENT_EVOLUTION_PROMOTED,
  EVENT_EVOLUTION_ROLLED_BACK,
  EVENT_EVOLUTION_DRIFT_ALERTED,
])

const EVENT_TYPE_SET = new Set(EVENT_TYPES)
const SIMULATION_EVENT_TYPE_SET = new Set<string>(SIMULATION_EVENT_TYPES)

export const CONTENT_DRAFT = 'draft'
export const CONTENT_APPROVED = 'approved'
export const CONTENT_RETIRED = 'retired'
export const CONTENT_REVIEW_STATES = Object.freeze([
  CONTENT_DRAFT,
  CONTENT_APPROVED,
  CONTENT_RETIRED,
] as const)
export type ContentReviewState = (typeof CONTENT_REVIEW_STATES)[number]

export const STAGES = Object.freeze([
  'primary',
  'junior_secondary',
  'senior_secondary',
  'vocational',
  'unknown',
] as const)
export type Stage = (typeof STAGES)[number]

// ---------------------------------------------------------------------------
// Harness state machine vocabulary (spec §12.2)
// ---------------------------------------------------------------------------

export const STATE_INTAKE = 'Intake'
export const STATE_EVIDENCE_PARSE = 'EvidenceParse'
export const STATE_PROGRESS_CHECK = 'ProgressCheck'
export const STATE_NEED_CLARIFICATION = 'NeedClarification'
export const STATE_STATE_LOAD = 'StateLoad'
export const STATE_DIAGNOSE = 'Diagnose'
export const STATE_HYPOTHESIS_UPDATE = 'HypothesisUpdate'
export const STATE_PROBE = 'Probe'
export const STATE_AWAIT_STUDENT = 'AwaitStudent'
export const STATE_EXERCISE_EVOLUTION = 'ExerciseEvolution'
export const STATE_RECALL_SCHEDULE = 'RecallSchedule'
export const STATE_PREVIEW_PLANNER = 'PreviewPlanner'
export const STATE_SIMULATION_LAB = 'SimulationLab'
export const STATE_CANDIDATE_RANKING = 'CandidateRanking'
export const STATE_CURRICULUM_GATE = 'CurriculumGate'
export const STATE_CONTENT_VALIDATION = 'ContentValidation'
export const STATE_DELIVER = 'Deliver'
export const STATE_ASSESS = 'Assess'
export const STATE_STATE_COMMIT = 'StateCommit'
export const STATE_REVIEW_RESCHEDULE = 'ReviewReschedule'
export const STATE_COMPLETED = 'Completed'
export const STATE_FAILED = 'Failed'
export const STATE_ABORTED = 'Aborted'

export const LEARNING_STATES: readonly string[] = Object.freeze([
  STATE_INTAKE,
  STATE_EVIDENCE_PARSE,
  STATE_PROGRESS_CHECK,
  STATE_NEED_CLARIFICATION,
  STATE_STATE_LOAD,
  STATE_DIAGNOSE,
  STATE_HYPOTHESIS_UPDATE,
  STATE_PROBE,
  STATE_AWAIT_STUDENT,
  STATE_EXERCISE_EVOLUTION,
  STATE_RECALL_SCHEDULE,
  STATE_PREVIEW_PLANNER,
  STATE_SIMULATION_LAB,
  STATE_CANDIDATE_RANKING,
  STATE_CURRICULUM_GATE,
  STATE_CONTENT_VALIDATION,
  STATE_DELIVER,
  STATE_ASSESS,
  STATE_STATE_COMMIT,
  STATE_REVIEW_RESCHEDULE,
  STATE_COMPLETED,
  STATE_FAILED,
  STATE_ABORTED,
])

const LEARNING_STATE_SET = new Set(LEARNING_STATES)

export const TERMINAL_STATES = Object.freeze([
  STATE_COMPLETED,
  STATE_FAILED,
  STATE_ABORTED,
] as const)
const TERMINAL_STATE_SET = new Set<string>(TERMINAL_STATES)

export const TRANSITIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    [STATE_INTAKE]: Object.freeze([STATE_EVIDENCE_PARSE]),
    [STATE_EVIDENCE_PARSE]: Object.freeze([STATE_PROGRESS_CHECK]),
    [STATE_PROGRESS_CHECK]: Object.freeze([
      STATE_NEED_CLARIFICATION,
      STATE_STATE_LOAD,
    ]),
    [STATE_NEED_CLARIFICATION]: Object.freeze([STATE_PROGRESS_CHECK]),
    [STATE_STATE_LOAD]: Object.freeze([
      STATE_DIAGNOSE,
      STATE_RECALL_SCHEDULE,
      STATE_PREVIEW_PLANNER,
    ]),
    [STATE_DIAGNOSE]: Object.freeze([STATE_HYPOTHESIS_UPDATE]),
    [STATE_HYPOTHESIS_UPDATE]: Object.freeze([
      STATE_PROBE,
      STATE_EXERCISE_EVOLUTION,
    ]),
    [STATE_PROBE]: Object.freeze([STATE_AWAIT_STUDENT]),
    [STATE_AWAIT_STUDENT]: Object.freeze([
      STATE_EVIDENCE_PARSE,
      STATE_ASSESS,
    ]),
    [STATE_EXERCISE_EVOLUTION]: Object.freeze([STATE_SIMULATION_LAB]),
    [STATE_RECALL_SCHEDULE]: Object.freeze([STATE_EXERCISE_EVOLUTION]),
    [STATE_PREVIEW_PLANNER]: Object.freeze([STATE_EXERCISE_EVOLUTION]),
    [STATE_SIMULATION_LAB]: Object.freeze([STATE_CANDIDATE_RANKING]),
    [STATE_CANDIDATE_RANKING]: Object.freeze([STATE_CURRICULUM_GATE]),
    [STATE_CURRICULUM_GATE]: Object.freeze([
      STATE_EXERCISE_EVOLUTION,
      STATE_CONTENT_VALIDATION,
    ]),
    [STATE_CONTENT_VALIDATION]: Object.freeze([
      STATE_EXERCISE_EVOLUTION,
      STATE_DELIVER,
    ]),
    [STATE_DELIVER]: Object.freeze([STATE_AWAIT_STUDENT]),
    [STATE_ASSESS]: Object.freeze([STATE_STATE_COMMIT]),
    [STATE_STATE_COMMIT]: Object.freeze([STATE_REVIEW_RESCHEDULE]),
    [STATE_REVIEW_RESCHEDULE]: Object.freeze([STATE_COMPLETED]),
    [STATE_COMPLETED]: Object.freeze([]),
    [STATE_FAILED]: Object.freeze([]),
    [STATE_ABORTED]: Object.freeze([]),
  })

export const BRANCH_OCR_UNCERTAIN = 'ocr_uncertain'
export const BRANCH_SYMBOL_VERIFIER_UNCERTAIN = 'symbol_verifier_uncertain'
export const BRANCH_RAG_SOURCE_MISSING = 'rag_source_missing'
export const BRANCH_SCHOOL_PROGRESS_UNCLEAR = 'school_progress_unclear'
export const BRANCH_HYPOTHESES_ALL_MISMATCHED = 'hypotheses_all_mismatched'
export const BRANCH_SIMULATION_TIMEOUT = 'simulation_timeout'
export const BRANCH_SPARSE_MEMORY_DATA = 'sparse_memory_data'
export const BRANCH_LOW_CONFIDENCE_STRATEGY = 'low_confidence_strategy'
export const BRANCH_STUDENT_REFUSES_DIAGNOSIS = 'student_refuses_diagnosis'
export const BRANCH_ABNORMAL_PRESSURE = 'abnormal_pressure'
export const BRANCH_CURRICULUM_GATE_REJECTED = 'curriculum_gate_rejected'
export const BRANCH_CONTENT_REJECTED = 'content_rejected'

export interface ExceptionBranch {
  readonly code: string
  readonly targetState: string
  readonly degradedMode: string
  readonly description: string
}

export const EXCEPTION_BRANCHES: Readonly<Record<string, ExceptionBranch>> =
  Object.freeze({
    [BRANCH_OCR_UNCERTAIN]: Object.freeze({
      code: BRANCH_OCR_UNCERTAIN,
      targetState: STATE_NEED_CLARIFICATION,
      degradedMode: 'confirm_transcript',
      description: 'OCR is unsure about a key formula; confirm the question text first',
    }),
    [BRANCH_SYMBOL_VERIFIER_UNCERTAIN]: Object.freeze({
      code: BRANCH_SYMBOL_VERIFIER_UNCERTAIN,
      targetState: STATE_NEED_CLARIFICATION,
      degradedMode: 'human_or_alternate_verification',
      description: 'symbolic verifier cannot decide; mark uncertain and re-verify',
    }),
    [BRANCH_RAG_SOURCE_MISSING]: Object.freeze({
      code: BRANCH_RAG_SOURCE_MISSING,
      targetState: '',
      degradedMode: 'unlicensed_source_flagged',
      description: 'no authorised textbook source; answer generically and flag it',
    }),
    [BRANCH_SCHOOL_PROGRESS_UNCLEAR]: Object.freeze({
      code: BRANCH_SCHOOL_PROGRESS_UNCLEAR,
      targetState: STATE_NEED_CLARIFICATION,
      degradedMode: 'ask_current_chapter',
      description: 'school progress is unclear; only use confirmed content or ask',
    }),
    [BRANCH_HYPOTHESES_ALL_MISMATCHED]: Object.freeze({
      code: BRANCH_HYPOTHESES_ALL_MISMATCHED,
      targetState: STATE_PROBE,
      degradedMode: 'no_root_cause_inference',
      description: 'all virtual students mismatch; probe instead of inferring a cause',
    }),
    [BRANCH_SIMULATION_TIMEOUT]: Object.freeze({
      code: BRANCH_SIMULATION_TIMEOUT,
      targetState: STATE_CANDIDATE_RANKING,
      degradedMode: 'rule_and_knowledge_tracing_baseline',
      description: 'simulation timed out or exceeded cost; fall back to the baseline',
    }),
    [BRANCH_SPARSE_MEMORY_DATA]: Object.freeze({
      code: BRANCH_SPARSE_MEMORY_DATA,
      targetState: STATE_RECALL_SCHEDULE,
      degradedMode: 'population_prior_conservative_review',
      description: 'memory data is sparse; use the prior and a conservative review',
    }),
    [BRANCH_LOW_CONFIDENCE_STRATEGY]: Object.freeze({
      code: BRANCH_LOW_CONFIDENCE_STRATEGY,
      targetState: '',
      degradedMode: 'low_risk_short_feedback',
      description: 'strategy confidence is low; choose a low-risk explainable action',
    }),
    [BRANCH_STUDENT_REFUSES_DIAGNOSIS]: Object.freeze({
      code: BRANCH_STUDENT_REFUSES_DIAGNOSIS,
      targetState: STATE_ABORTED,
      degradedMode: 'answer_directly',
      description: 'student declined diagnosis; honour the choice and answer directly',
    }),
    [BRANCH_ABNORMAL_PRESSURE]: Object.freeze({
      code: BRANCH_ABNORMAL_PRESSURE,
      targetState: '',
      degradedMode: 'reduce_load_suggest_break',
      description: 'abnormal answering pressure; reduce load and suggest a break',
    }),
    [BRANCH_CURRICULUM_GATE_REJECTED]: Object.freeze({
      code: BRANCH_CURRICULUM_GATE_REJECTED,
      targetState: STATE_EXERCISE_EVOLUTION,
      degradedMode: 'rework_candidate',
      description: 'curriculum gate rejected the candidate; rework it',
    }),
    [BRANCH_CONTENT_REJECTED]: Object.freeze({
      code: BRANCH_CONTENT_REJECTED,
      targetState: STATE_EXERCISE_EVOLUTION,
      degradedMode: 'rework_candidate',
      description: 'content validation rejected the item; rework it',
    }),
  })

export const DEFAULT_MAX_REJECTIONS = 3

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceError'
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class OptimisticConcurrencyError extends ConflictError {
  constructor(message: string) {
    super(message)
    this.name = 'OptimisticConcurrencyError'
  }
}

export class IdempotencyConflictError extends ConflictError {
  constructor(message: string) {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

export class IsolationViolationError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'IsolationViolationError'
  }
}

export class IntegrityError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrityError'
  }
}

export class StateMachineError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'StateMachineError'
  }
}

export class InvalidTransitionError extends StateMachineError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTransitionError'
  }
}

export class SplitIsolationError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'SplitIsolationError'
  }
}

export class SelfProofError extends ServiceError {
  constructor(message: string) {
    super(message)
    this.name = 'SelfProofError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function utcNow(): string {
  return new Date().toISOString()
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      output[key] = sortValue(record[key])
    }
    return output
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function assertIdentifier(
  value: unknown,
  field: string,
  maxLength = 128,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${field} is too long`)
  }
  if (/\s/.test(value)) {
    throw new ValidationError(`${field} must not contain whitespace`)
  }
  return value
}

const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) {
    throw new ValidationError(
      `${field} must be an ISO-8601 timestamp with a UTC offset`,
    )
  }
  return value
}

function normalizeScalar(value: unknown, field: string): Scalar {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${field} must be finite`)
    }
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 2000) {
      throw new ValidationError(`${field} string is too long`)
    }
    return value
  }
  throw new ValidationError(`${field} must be a JSON scalar`)
}

export function normalizePayload(value: unknown): Payload {
  if (value === undefined || value === null) {
    return Object.freeze({})
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('payload must be a mapping of scalars')
  }
  const output: Record<string, Scalar> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    assertIdentifier(key, 'payload key', 64)
    output[key] = normalizeScalar(
      (value as Record<string, unknown>)[key],
      `payload[${key}]`,
    )
  }
  const frozen = Object.freeze(output)
  if (canonicalJson(frozen).length > MAX_PAYLOAD_CHARS) {
    throw new ValidationError('payload exceeds the scalar size budget')
  }
  return frozen
}

function normalizeDomain(value: unknown): StorageDomain {
  if (value !== DOMAIN_OBSERVED && value !== DOMAIN_SIMULATED) {
    throw new ValidationError(`unknown storage domain ${String(value)}`)
  }
  return value as StorageDomain
}

function deriveEventId(streamId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${streamId}\u001f${idempotencyKey}`, 'utf8')
    .digest('hex')
  return `ev_${digest.slice(0, 20)}`
}

function deriveRunId(datasetId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${datasetId}\u001f${idempotencyKey}`, 'utf8')
    .digest('hex')
  return `evalrun_${digest.slice(0, 20)}`
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, JSON.stringify(sortValue(data)), 'utf8')
  renameSync(temporary, path)
}

function readJsonFile(path: string, fallback: unknown): unknown {
  if (!existsSync(path)) {
    return fallback
  }
  const text = readFileSync(path, 'utf8').trim()
  if (text.length === 0) {
    return fallback
  }
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------
// Write coordination
// ---------------------------------------------------------------------------

export class WriteCoordinator {
  private readonly memo = new Map<string, unknown>()

  recall(streamId: string, idempotencyKey: string): [boolean, unknown] {
    const key = `${streamId}\u001f${idempotencyKey}`
    if (this.memo.has(key)) {
      return [true, this.memo.get(key)]
    }
    return [false, undefined]
  }

  remember(streamId: string, idempotencyKey: string, result: unknown): void {
    this.memo.set(`${streamId}\u001f${idempotencyKey}`, result)
  }

  runOnce<T>(
    streamId: string,
    idempotencyKey: string,
    operation: () => T,
  ): [T, boolean] {
    const [found, value] = this.recall(streamId, idempotencyKey)
    if (found) {
      return [value as T, true]
    }
    const result = operation()
    this.remember(streamId, idempotencyKey, result)
    return [result, false]
  }

  stats(): Readonly<{ locks: number; memo: number }> {
    // JavaScript has no per-stream lock; the memo is the observable state.
    return Object.freeze({ locks: 0, memo: this.memo.size })
  }
}

// ---------------------------------------------------------------------------
// Event store (spec §13.1 learning_events, §22.1 envelope)
// ---------------------------------------------------------------------------

export interface EventDraftInput {
  readonly streamId: string
  readonly eventType: string
  readonly sourceType: EventSource
  readonly occurredAt: string
  readonly idempotencyKey: string
  readonly sessionId?: string
  readonly provenance?: string
  readonly payload?: unknown
  readonly eventId?: string
  readonly schemaVersion?: string
}

export class EventDraft {
  readonly streamId: string
  readonly eventType: string
  readonly sourceType: EventSource
  readonly occurredAt: string
  readonly idempotencyKey: string
  readonly sessionId: string
  readonly provenance: string
  readonly payload: Payload
  readonly eventId: string
  readonly schemaVersion: string

  constructor(input: EventDraftInput) {
    this.streamId = assertIdentifier(input.streamId, 'streamId')
    if (!EVENT_TYPE_SET.has(input.eventType)) {
      throw new ValidationError(`unknown event_type ${input.eventType}`)
    }
    this.eventType = input.eventType
    if (input.sourceType !== SOURCE_OBSERVED && input.sourceType !== SOURCE_SIMULATED) {
      throw new ValidationError(`unknown source_type ${String(input.sourceType)}`)
    }
    this.sourceType = input.sourceType
    this.occurredAt = assertTimestamp(input.occurredAt, 'occurredAt')
    this.idempotencyKey = assertIdentifier(
      input.idempotencyKey,
      'idempotencyKey',
    )
    this.sessionId = input.sessionId
      ? assertIdentifier(input.sessionId, 'sessionId')
      : ''
    this.provenance = assertIdentifier(
      input.provenance ?? PROVENANCE_SYNTHETIC,
      'provenance',
      64,
    )
    this.payload = normalizePayload(input.payload)
    this.eventId = input.eventId
      ? assertIdentifier(input.eventId, 'eventId')
      : ''
    const schemaVersion = input.schemaVersion ?? EVENT_SCHEMA_VERSION
    if (schemaVersion !== EVENT_SCHEMA_VERSION) {
      throw new ValidationError(`unsupported schema_version ${schemaVersion}`)
    }
    this.schemaVersion = schemaVersion
    Object.freeze(this)
  }
}

export interface LearningEventData {
  readonly eventId: string
  readonly streamId: string
  readonly eventType: string
  readonly sourceType: EventSource
  readonly occurredAt: string
  readonly sequence: number
  readonly idempotencyKey: string
  readonly sessionId?: string
  readonly provenance?: string
  readonly payload?: Payload
  readonly schemaVersion?: string
}

export class LearningEvent {
  readonly eventId: string
  readonly streamId: string
  readonly eventType: string
  readonly sourceType: EventSource
  readonly occurredAt: string
  readonly sequence: number
  readonly idempotencyKey: string
  readonly sessionId: string
  readonly provenance: string
  readonly payload: Payload
  readonly schemaVersion: string

  constructor(data: LearningEventData) {
    this.eventId = assertIdentifier(data.eventId, 'eventId')
    this.streamId = assertIdentifier(data.streamId, 'streamId')
    if (!EVENT_TYPE_SET.has(data.eventType)) {
      throw new ValidationError(`unknown event_type ${data.eventType}`)
    }
    this.eventType = data.eventType
    if (data.sourceType !== SOURCE_OBSERVED && data.sourceType !== SOURCE_SIMULATED) {
      throw new ValidationError(`unknown source_type ${String(data.sourceType)}`)
    }
    this.sourceType = data.sourceType
    this.occurredAt = assertTimestamp(data.occurredAt, 'occurredAt')
    if (!Number.isInteger(data.sequence) || data.sequence < 1) {
      throw new ValidationError('sequence must be an integer >= 1')
    }
    this.sequence = data.sequence
    this.idempotencyKey = assertIdentifier(
      data.idempotencyKey,
      'idempotencyKey',
    )
    this.sessionId = data.sessionId
      ? assertIdentifier(data.sessionId, 'sessionId')
      : ''
    this.provenance = assertIdentifier(
      data.provenance ?? PROVENANCE_SYNTHETIC,
      'provenance',
      64,
    )
    this.payload = data.payload ? normalizePayload(data.payload) : Object.freeze({})
    this.schemaVersion = data.schemaVersion ?? EVENT_SCHEMA_VERSION
    Object.freeze(this)
  }

  toDict(): Record<string, unknown> {
    return {
      event_id: this.eventId,
      stream_id: this.streamId,
      event_type: this.eventType,
      source_type: this.sourceType,
      occurred_at: this.occurredAt,
      sequence: this.sequence,
      idempotency_key: this.idempotencyKey,
      session_id: this.sessionId,
      provenance: this.provenance,
      payload: { ...this.payload },
      schema_version: this.schemaVersion,
    }
  }

  static fromDict(data: Record<string, unknown>): LearningEvent {
    return new LearningEvent({
      eventId: String(data.event_id),
      streamId: String(data.stream_id),
      eventType: String(data.event_type),
      sourceType: data.source_type as EventSource,
      occurredAt: String(data.occurred_at),
      sequence: Number(data.sequence),
      idempotencyKey: String(data.idempotency_key),
      sessionId: data.session_id ? String(data.session_id) : '',
      provenance: data.provenance ? String(data.provenance) : PROVENANCE_SYNTHETIC,
      payload: (data.payload as Payload | undefined) ?? {},
      schemaVersion: data.schema_version
        ? String(data.schema_version)
        : EVENT_SCHEMA_VERSION,
    })
  }
}

export interface AppendResult {
  readonly event: LearningEvent
  readonly deduplicated: boolean
  readonly streamVersion: number
}

export interface AppendOptions {
  readonly expectedVersion?: number
}

export abstract class EventStore {
  abstract readonly domain: StorageDomain
  abstract append(draft: EventDraft, options?: AppendOptions): AppendResult
  abstract get(eventId: string): LearningEvent
  abstract listEvents(
    streamId: string,
    options?: { afterSequence?: number; limit?: number },
  ): readonly LearningEvent[]
  abstract streamVersion(streamId: string): number
  abstract findByIdempotency(
    streamId: string,
    idempotencyKey: string,
  ): LearningEvent | null
}

export interface EventStoreOptions {
  readonly coordinator?: WriteCoordinator
}

abstract class BaseEventStore extends EventStore {
  readonly domain: StorageDomain
  protected readonly coordinator: WriteCoordinator
  protected readonly events = new Map<string, LearningEvent[]>()
  protected readonly byId = new Map<string, LearningEvent>()
  protected readonly idempotency = new Map<string, string>()

  protected constructor(
    domain: StorageDomain,
    options: EventStoreOptions = {},
  ) {
    super()
    this.domain = domain
    this.coordinator = options.coordinator ?? new WriteCoordinator()
  }

  /** Append one durable record; overridden by the file store. */
  protected persistEvent(_event: LearningEvent): void {}

  /** Load persisted records; overridden by the file store. */
  protected loadState(): void {}

  protected index(event: LearningEvent): void {
    const stream = this.events.get(event.streamId) ?? []
    if (event.sequence !== stream.length + 1) {
      throw new IntegrityError(
        `event ${event.eventId} has sequence ${event.sequence} but the stream expected ${stream.length + 1}`,
      )
    }
    if (this.byId.has(event.eventId)) {
      throw new IntegrityError(`duplicate event id ${event.eventId}`)
    }
    const key = `${event.streamId}\u001f${event.idempotencyKey}`
    if (this.idempotency.has(key)) {
      throw new IntegrityError(
        `duplicate idempotency key ${event.idempotencyKey} in stream`,
      )
    }
    stream.push(event)
    this.events.set(event.streamId, stream)
    this.byId.set(event.eventId, event)
    this.idempotency.set(key, event.eventId)
  }

  private assertDomain(draft: EventDraft): void {
    if (draft.sourceType !== this.domain) {
      throw new IsolationViolationError(
        `cannot write a ${draft.sourceType} event into the ${this.domain} store`,
      )
    }
    if (
      this.domain === DOMAIN_OBSERVED &&
      SIMULATION_EVENT_TYPE_SET.has(draft.eventType)
    ) {
      throw new IsolationViolationError(
        `simulation event ${draft.eventType} cannot enter the observed store`,
      )
    }
  }

  private static assertSame(existing: LearningEvent, draft: EventDraft): void {
    const left = {
      event_type: existing.eventType,
      source_type: existing.sourceType,
      occurred_at: existing.occurredAt,
      session_id: existing.sessionId,
      provenance: existing.provenance,
      payload: { ...existing.payload },
    }
    const right = {
      event_type: draft.eventType,
      source_type: draft.sourceType,
      occurred_at: draft.occurredAt,
      session_id: draft.sessionId,
      provenance: draft.provenance,
      payload: { ...draft.payload },
    }
    if (canonicalJson(left) !== canonicalJson(right)) {
      throw new IdempotencyConflictError(
        'the idempotency key was already used for a different event',
      )
    }
  }

  append(draft: EventDraft, options: AppendOptions = {}): AppendResult {
    if (!(draft instanceof EventDraft)) {
      throw new ValidationError('append requires an EventDraft')
    }
    this.assertDomain(draft)
    const stream = this.events.get(draft.streamId) ?? []
    const current = stream.length
    const existingId = this.idempotency.get(
      `${draft.streamId}\u001f${draft.idempotencyKey}`,
    )
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId) as LearningEvent
      BaseEventStore.assertSame(existing, draft)
      return Object.freeze({
        event: existing,
        deduplicated: true,
        streamVersion: current,
      })
    }
    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== current
    ) {
      throw new OptimisticConcurrencyError(
        `stream ${draft.streamId} is at version ${current}, expected ${options.expectedVersion}`,
      )
    }
    const event = new LearningEvent({
      eventId: draft.eventId || deriveEventId(draft.streamId, draft.idempotencyKey),
      streamId: draft.streamId,
      eventType: draft.eventType,
      sourceType: draft.sourceType,
      occurredAt: draft.occurredAt,
      sequence: current + 1,
      idempotencyKey: draft.idempotencyKey,
      sessionId: draft.sessionId,
      provenance: draft.provenance,
      payload: draft.payload,
      schemaVersion: draft.schemaVersion,
    })
    this.persistEvent(event)
    this.index(event)
    return Object.freeze({
      event,
      deduplicated: false,
      streamVersion: current + 1,
    })
  }

  get(eventId: string): LearningEvent {
    const event = this.byId.get(eventId)
    if (event === undefined) {
      throw new NotFoundError(`no event ${eventId}`)
    }
    return event
  }

  listEvents(
    streamId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): readonly LearningEvent[] {
    const after = options.afterSequence ?? 0
    const events = (this.events.get(streamId) ?? []).filter(
      (event) => event.sequence > after,
    )
    if (options.limit !== undefined) {
      if (options.limit < 0) {
        throw new ValidationError('limit must be >= 0')
      }
      return Object.freeze(events.slice(0, options.limit))
    }
    return Object.freeze([...events])
  }

  streamVersion(streamId: string): number {
    return (this.events.get(streamId) ?? []).length
  }

  findByIdempotency(
    streamId: string,
    idempotencyKey: string,
  ): LearningEvent | null {
    const eventId = this.idempotency.get(
      `${streamId}\u001f${idempotencyKey}`,
    )
    return eventId === undefined ? null : (this.byId.get(eventId) as LearningEvent)
  }
}

export class InMemoryEventStore extends BaseEventStore {
  constructor(domain: StorageDomain, options: EventStoreOptions = {}) {
    super(normalizeDomain(domain), options)
  }
}

export class FileEventStore extends BaseEventStore {
  private readonly root: string
  private readonly path: string

  constructor(
    root: string,
    domain: StorageDomain,
    options: EventStoreOptions = {},
  ) {
    super(normalizeDomain(domain), options)
    this.root = resolve(root)
    this.path = join(this.root, `events.${this.domain}.jsonl`)
    mkdirSync(this.root, { recursive: true })
    this.loadState()
  }

  protected override loadState(): void {
    if (!existsSync(this.path)) {
      return
    }
    const text = readFileSync(this.path, 'utf8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line.length === 0) {
        continue
      }
      const record = JSON.parse(line) as Record<string, unknown>
      const digest = record.digest
      delete record.digest
      if (digest !== contentDigest(record)) {
        throw new IntegrityError('event log integrity check failed')
      }
      const event = LearningEvent.fromDict(record)
      if (event.sourceType !== this.domain) {
        throw new IntegrityError(
          'event log contains a record from another storage domain',
        )
      }
      this.index(event)
    }
  }

  protected override persistEvent(event: LearningEvent): void {
    const record = event.toDict()
    record.digest = contentDigest(event.toDict())
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// Profile and bundle stores (spec §13.1)
// ---------------------------------------------------------------------------

export interface StudentProfileInput {
  readonly studentRef: string
  readonly stage?: Stage
  readonly guardianConsent?: boolean
  readonly settings?: unknown
  readonly version?: number
}

export class StudentProfile {
  readonly studentRef: string
  readonly stage: Stage
  readonly guardianConsent: boolean
  readonly settings: Payload
  readonly version: number

  constructor(input: StudentProfileInput) {
    this.studentRef = assertIdentifier(input.studentRef, 'studentRef')
    const stage = input.stage ?? 'unknown'
    if (!(STAGES as readonly string[]).includes(stage)) {
      throw new ValidationError(`unknown stage ${stage}`)
    }
    this.stage = stage
    if (
      input.guardianConsent !== undefined &&
      typeof input.guardianConsent !== 'boolean'
    ) {
      throw new ValidationError('guardianConsent must be a boolean')
    }
    this.guardianConsent = input.guardianConsent ?? false
    this.settings = normalizePayload(input.settings)
    const version = input.version ?? 1
    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError('version must be an integer >= 1')
    }
    this.version = version
    Object.freeze(this)
  }

  toDict(): Record<string, unknown> {
    return {
      student_ref: this.studentRef,
      stage: this.stage,
      guardian_consent: this.guardianConsent,
      settings: { ...this.settings },
      version: this.version,
    }
  }

  static fromDict(data: Record<string, unknown>): StudentProfile {
    return new StudentProfile({
      studentRef: String(data.student_ref),
      stage: data.stage as Stage,
      guardianConsent: Boolean(data.guardian_consent),
      settings: data.settings ?? {},
      version: Number(data.version ?? 1),
    })
  }
}

export abstract class ProfileStore {
  abstract create(profile: StudentProfile): StudentProfile
  abstract get(studentRef: string): StudentProfile
  abstract update(
    studentRef: string,
    options: {
      expectedVersion: number
      settings?: unknown
      guardianConsent?: boolean
    },
  ): StudentProfile
  abstract listAll(): readonly StudentProfile[]
}

abstract class BaseProfileStore extends ProfileStore {
  protected readonly profiles = new Map<string, StudentProfile>()

  protected persist(): void {}

  create(profile: StudentProfile): StudentProfile {
    if (!(profile instanceof StudentProfile)) {
      throw new ValidationError('create requires a StudentProfile')
    }
    if (this.profiles.has(profile.studentRef)) {
      throw new ConflictError(`profile ${profile.studentRef} already exists`)
    }
    this.profiles.set(profile.studentRef, profile)
    this.persist()
    return profile
  }

  get(studentRef: string): StudentProfile {
    const profile = this.profiles.get(studentRef)
    if (profile === undefined) {
      throw new NotFoundError(`no profile ${studentRef}`)
    }
    return profile
  }

  update(
    studentRef: string,
    options: {
      expectedVersion: number
      settings?: unknown
      guardianConsent?: boolean
    },
  ): StudentProfile {
    const current = this.get(studentRef)
    if (options.expectedVersion !== current.version) {
      throw new OptimisticConcurrencyError(
        `profile ${studentRef} is at version ${current.version}, expected ${options.expectedVersion}`,
      )
    }
    const merged: Record<string, Scalar> = { ...current.settings }
    if (options.settings !== undefined) {
      Object.assign(merged, normalizePayload(options.settings))
    }
    const updated = new StudentProfile({
      studentRef: current.studentRef,
      stage: current.stage,
      guardianConsent: options.guardianConsent ?? current.guardianConsent,
      settings: merged,
      version: current.version + 1,
    })
    this.profiles.set(studentRef, updated)
    this.persist()
    return updated
  }

  listAll(): readonly StudentProfile[] {
    return Object.freeze(
      [...this.profiles.keys()]
        .sort()
        .map((key) => this.profiles.get(key) as StudentProfile),
    )
  }
}

export class InMemoryProfileStore extends BaseProfileStore {}

export class FileProfileStore extends BaseProfileStore {
  private readonly path: string

  constructor(root: string) {
    super()
    this.path = join(resolve(root), 'profiles.json')
    this.loadState()
  }

  private loadState(): void {
    const data = readJsonFile(this.path, {}) as Record<string, unknown>
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new IntegrityError('profiles file must contain an object')
    }
    for (const key of Object.keys(data)) {
      const profile = StudentProfile.fromDict(
        data[key] as Record<string, unknown>,
      )
      if (profile.studentRef !== key) {
        throw new IntegrityError('profile key does not match studentRef')
      }
      this.profiles.set(profile.studentRef, profile)
    }
  }

  protected override persist(): void {
    const output: Record<string, unknown> = {}
    for (const [key, value] of this.profiles) {
      output[key] = value.toDict()
    }
    atomicWriteJson(this.path, output)
  }
}

export interface ProfileBundleInput {
  readonly studentRef: string
  readonly twinVersion: number
  readonly schoolProgressVersion: number
  readonly contentVersion: number
  readonly createdAt: string
  readonly bundleId?: string
}

export class ProfileBundle {
  readonly studentRef: string
  readonly twinVersion: number
  readonly schoolProgressVersion: number
  readonly contentVersion: number
  readonly createdAt: string
  readonly bundleId: string
  readonly digest: string

  constructor(input: ProfileBundleInput) {
    this.studentRef = assertIdentifier(input.studentRef, 'studentRef')
    for (const [field, value] of [
      ['twinVersion', input.twinVersion],
      ['schoolProgressVersion', input.schoolProgressVersion],
      ['contentVersion', input.contentVersion],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new ValidationError(`${field} must be a non-negative integer`)
      }
    }
    this.twinVersion = input.twinVersion
    this.schoolProgressVersion = input.schoolProgressVersion
    this.contentVersion = input.contentVersion
    this.createdAt = assertTimestamp(input.createdAt, 'createdAt')
    this.bundleId = input.bundleId
      ? assertIdentifier(input.bundleId, 'bundleId')
      : `bundle_${createHash('sha256')
          .update(
            `${this.studentRef}\u001f${this.twinVersion}\u001f${this.schoolProgressVersion}\u001f${this.contentVersion}\u001f${this.createdAt}`,
            'utf8',
          )
          .digest('hex')
          .slice(0, 20)}`
    this.digest = contentDigest(this.digestPayload())
    Object.freeze(this)
  }

  private digestPayload(): Record<string, unknown> {
    return {
      student_ref: this.studentRef,
      twin_version: this.twinVersion,
      school_progress_version: this.schoolProgressVersion,
      content_version: this.contentVersion,
      created_at: this.createdAt,
    }
  }

  toDict(): Record<string, unknown> {
    return {
      ...this.digestPayload(),
      bundle_id: this.bundleId,
      digest: this.digest,
    }
  }

  static fromDict(data: Record<string, unknown>): ProfileBundle {
    const bundle = new ProfileBundle({
      studentRef: String(data.student_ref),
      twinVersion: Number(data.twin_version),
      schoolProgressVersion: Number(data.school_progress_version),
      contentVersion: Number(data.content_version),
      createdAt: String(data.created_at),
      bundleId: data.bundle_id ? String(data.bundle_id) : undefined,
    })
    if (data.digest !== undefined && data.digest !== bundle.digest) {
      throw new IntegrityError('bundle digest mismatch')
    }
    return bundle
  }
}

export abstract class BundleStore {
  abstract put(bundle: ProfileBundle): ProfileBundle
  abstract get(bundleId: string): ProfileBundle
  abstract listForStudent(studentRef: string): readonly ProfileBundle[]
}

abstract class BaseBundleStore extends BundleStore {
  protected readonly bundles = new Map<string, ProfileBundle>()

  protected persist(): void {}

  put(bundle: ProfileBundle): ProfileBundle {
    if (!(bundle instanceof ProfileBundle)) {
      throw new ValidationError('put requires a ProfileBundle')
    }
    const existing = this.bundles.get(bundle.bundleId)
    if (existing !== undefined) {
      if (existing.digest !== bundle.digest) {
        throw new ConflictError(
          `bundle id ${bundle.bundleId} already exists with a different digest`,
        )
      }
      return existing
    }
    this.bundles.set(bundle.bundleId, bundle)
    this.persist()
    return bundle
  }

  get(bundleId: string): ProfileBundle {
    const bundle = this.bundles.get(bundleId)
    if (bundle === undefined) {
      throw new NotFoundError(`no bundle ${bundleId}`)
    }
    return bundle
  }

  listForStudent(studentRef: string): readonly ProfileBundle[] {
    const matches = [...this.bundles.values()].filter(
      (bundle) => bundle.studentRef === studentRef,
    )
    matches.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1
      }
      return left.bundleId < right.bundleId ? -1 : 1
    })
    return Object.freeze(matches)
  }
}

export class InMemoryBundleStore extends BaseBundleStore {}

export class FileBundleStore extends BaseBundleStore {
  private readonly path: string

  constructor(root: string) {
    super()
    this.path = join(resolve(root), 'bundles.json')
    this.loadState()
  }

  private loadState(): void {
    const data = readJsonFile(this.path, {}) as Record<string, unknown>
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new IntegrityError('bundles file must contain an object')
    }
    for (const key of Object.keys(data)) {
      const bundle = ProfileBundle.fromDict(data[key] as Record<string, unknown>)
      if (bundle.bundleId !== key) {
        throw new IntegrityError('bundle key does not match bundleId')
      }
      this.bundles.set(bundle.bundleId, bundle)
    }
  }

  protected override persist(): void {
    const output: Record<string, unknown> = {}
    for (const [key, value] of this.bundles) {
      output[key] = value.toDict()
    }
    atomicWriteJson(this.path, output)
  }
}

// ---------------------------------------------------------------------------
// Content library
// ---------------------------------------------------------------------------

export interface ContentRecordInput {
  readonly contentId: string
  readonly version: number
  readonly kcIds: readonly string[]
  readonly difficulty: number
  readonly reviewState: ContentReviewState
  readonly digest?: string
}

export class ContentRecord {
  readonly contentId: string
  readonly version: number
  readonly kcIds: readonly string[]
  readonly difficulty: number
  readonly reviewState: ContentReviewState
  readonly digest: string

  constructor(input: ContentRecordInput) {
    this.contentId = assertIdentifier(input.contentId, 'contentId')
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new ValidationError('version must be an integer >= 1')
    }
    this.version = input.version
    if (!Array.isArray(input.kcIds) || input.kcIds.length === 0) {
      throw new ValidationError('a content record needs at least one kcId')
    }
    const kcIds: string[] = []
    for (const kcId of input.kcIds) {
      const identifier = assertIdentifier(kcId, 'kcId', 80)
      if (!kcIds.includes(identifier)) {
        kcIds.push(identifier)
      }
    }
    this.kcIds = Object.freeze(kcIds)
    if (!Number.isInteger(input.difficulty) || input.difficulty < 1 || input.difficulty > 5) {
      throw new ValidationError('difficulty must be in 1..5')
    }
    this.difficulty = input.difficulty
    if (!(CONTENT_REVIEW_STATES as readonly string[]).includes(input.reviewState)) {
      throw new ValidationError(`unknown reviewState ${input.reviewState}`)
    }
    this.reviewState = input.reviewState
    const computed = contentDigest({
      content_id: this.contentId,
      version: this.version,
      kc_ids: [...this.kcIds],
      difficulty: this.difficulty,
      review_state: this.reviewState,
    })
    if (input.digest !== undefined && input.digest !== computed) {
      throw new IntegrityError('content record digest mismatch')
    }
    this.digest = computed
    Object.freeze(this)
  }

  toDict(): Record<string, unknown> {
    return {
      content_id: this.contentId,
      version: this.version,
      kc_ids: [...this.kcIds],
      difficulty: this.difficulty,
      review_state: this.reviewState,
      digest: this.digest,
    }
  }

  static fromDict(data: Record<string, unknown>): ContentRecord {
    return new ContentRecord({
      contentId: String(data.content_id),
      version: Number(data.version),
      kcIds: (data.kc_ids as string[]) ?? [],
      difficulty: Number(data.difficulty),
      reviewState: data.review_state as ContentReviewState,
      digest: data.digest ? String(data.digest) : undefined,
    })
  }
}

export interface ContentPutOptions {
  readonly kcIds: readonly string[]
  readonly difficulty: number
  readonly reviewState: ContentReviewState
  readonly expectedVersion: number
}

export abstract class ContentLibraryService {
  abstract put(contentId: string, options: ContentPutOptions): ContentRecord
  abstract get(contentId: string, version?: number): ContentRecord
  abstract currentVersion(contentId: string): number
  abstract retrieve(
    kcId: string,
    options?: { difficulty?: number; limit?: number },
  ): readonly ContentRecord[]
}

abstract class BaseContentLibrary extends ContentLibraryService {
  protected readonly records = new Map<string, ContentRecord[]>()

  protected persist(): void {}

  put(contentId: string, options: ContentPutOptions): ContentRecord {
    assertIdentifier(contentId, 'contentId')
    if (!Number.isInteger(options.expectedVersion) || options.expectedVersion < 0) {
      throw new ValidationError('expectedVersion must be an integer >= 0')
    }
    const versions = this.records.get(contentId) ?? []
    const current = versions.length > 0 ? versions[versions.length - 1] : undefined
    const currentVersion = current ? current.version : 0
    const sameAsCurrent = (): boolean =>
      current !== undefined &&
      current.kcIds.length === options.kcIds.length &&
      current.kcIds.every((value, index) => value === options.kcIds[index]) &&
      current.difficulty === options.difficulty &&
      current.reviewState === options.reviewState

    if (options.expectedVersion !== currentVersion) {
      if (
        options.expectedVersion === currentVersion - 1 &&
        sameAsCurrent()
      ) {
        return current as ContentRecord
      }
      throw new OptimisticConcurrencyError(
        `content ${contentId} is at version ${currentVersion}, expected ${options.expectedVersion}`,
      )
    }
    if (sameAsCurrent()) {
      return current as ContentRecord
    }
    const candidate = new ContentRecord({
      contentId,
      version: currentVersion + 1,
      kcIds: options.kcIds,
      difficulty: options.difficulty,
      reviewState: options.reviewState,
    })
    versions.push(candidate)
    this.records.set(contentId, versions)
    this.persist()
    return candidate
  }

  get(contentId: string, version?: number): ContentRecord {
    const versions = this.records.get(contentId)
    if (versions === undefined || versions.length === 0) {
      throw new NotFoundError(`no content ${contentId}`)
    }
    if (version === undefined) {
      return versions[versions.length - 1]
    }
    const match = versions.find((record) => record.version === version)
    if (match === undefined) {
      throw new NotFoundError(`content ${contentId} has no version ${version}`)
    }
    return match
  }

  currentVersion(contentId: string): number {
    const versions = this.records.get(contentId)
    return versions === undefined || versions.length === 0
      ? 0
      : versions[versions.length - 1].version
  }

  retrieve(
    kcId: string,
    options: { difficulty?: number; limit?: number } = {},
  ): readonly ContentRecord[] {
    assertIdentifier(kcId, 'kcId', 80)
    if (
      options.difficulty !== undefined &&
      (options.difficulty < 1 || options.difficulty > 5)
    ) {
      throw new ValidationError(`difficulty ${options.difficulty} is out of range`)
    }
    const limit = options.limit ?? 10
    if (limit < 0) {
      throw new ValidationError('limit must be >= 0')
    }
    const hits: ContentRecord[] = []
    for (const versions of this.records.values()) {
      const current = versions[versions.length - 1]
      if (current.reviewState !== CONTENT_APPROVED) {
        continue
      }
      if (!current.kcIds.includes(kcId)) {
        continue
      }
      if (options.difficulty !== undefined && current.difficulty !== options.difficulty) {
        continue
      }
      hits.push(current)
    }
    hits.sort((left, right) => {
      if (left.difficulty !== right.difficulty) {
        return left.difficulty - right.difficulty
      }
      return left.contentId < right.contentId ? -1 : 1
    })
    return Object.freeze(hits.slice(0, limit))
  }
}

export class InMemoryContentLibrary extends BaseContentLibrary {}

export class FileContentLibrary extends BaseContentLibrary {
  private readonly path: string

  constructor(root: string) {
    super()
    this.path = join(resolve(root), 'content.json')
    this.loadState()
  }

  private loadState(): void {
    const data = readJsonFile(this.path, {}) as Record<string, unknown>
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new IntegrityError('content file must contain an object')
    }
    for (const key of Object.keys(data)) {
      const versions = (data[key] as Record<string, unknown>[]).map((entry) =>
        ContentRecord.fromDict(entry),
      )
      this.records.set(key, versions)
    }
  }

  protected override persist(): void {
    const output: Record<string, unknown> = {}
    for (const [key, versions] of this.records) {
      output[key] = versions.map((record) => record.toDict())
    }
    atomicWriteJson(this.path, output)
  }
}

// ---------------------------------------------------------------------------
// Evaluation primitives (minimal TypeScript mirror of aeh/evaluation.py)
// ---------------------------------------------------------------------------

export type EvalSplit = 'train' | 'explanation' | 'transfer'
export const EVAL_SPLITS = Object.freeze([
  'train',
  'explanation',
  'transfer',
] as const)
export const REAL_SOURCES = Object.freeze([
  'student',
  'teacher',
  'trusted_grader',
  'assessment',
] as const)
export const DEFAULT_REFERENCE_ACCURACY = 0.5

export interface EvalItem {
  readonly itemId: string
  readonly kcId: string
  readonly split: EvalSplit
  readonly difficulty: number
  readonly seenBefore: boolean
}

export interface FrozenEvalSet {
  readonly datasetId: string
  readonly version: string
  readonly frozenAt: string
  readonly items: readonly EvalItem[]
  readonly digest: string
}

export interface SimulatedOutcome {
  readonly itemId: string
  readonly predictedCorrect: number
}

export interface RealOutcome {
  readonly itemId: string
  readonly correct: boolean
  readonly source: string
  readonly occurredAt: string
  readonly independent: boolean
}

export interface SimulatedBenefitView {
  readonly split: string
  readonly itemCount: number
  readonly meanPredictedCorrect: number
  readonly referenceAccuracy: number
  readonly simulatedGain: number
  readonly isCausalEvidence: boolean
  readonly interpretation: string
}

export interface RealTransferView {
  readonly itemCount: number
  readonly independentCorrect: number
  readonly transferAccuracy: number
  readonly referenceAccuracy: number
  readonly observedDelta: number
  readonly sources: readonly string[]
  readonly allItemsUnseen: boolean
  readonly causalClaimSupported: boolean
  readonly interpretation: string
}

export interface EvaluationResultView {
  readonly simulatedBenefit: SimulatedBenefitView | null
  readonly realTransfer: RealTransferView | null
  readonly selfProofGuard: readonly string[]
  readonly limitations: readonly string[]
  readonly claim: string
}

const EVAL_SPLIT_SET = new Set<string>(EVAL_SPLITS)
const REAL_SOURCE_SET = new Set<string>(REAL_SOURCES)

export function createFrozenEvalSet(input: {
  readonly datasetId: string
  readonly version: string
  readonly frozenAt: string
  readonly items: readonly EvalItem[]
  readonly digest?: string
}): FrozenEvalSet {
  const datasetId = assertIdentifier(input.datasetId, 'datasetId')
  const version = assertIdentifier(input.version, 'version')
  const frozenAt = assertTimestamp(input.frozenAt, 'frozenAt')
  if (input.items.length === 0) {
    throw new SplitIsolationError('a frozen evaluation set cannot be empty')
  }
  const seen = new Set<string>()
  const items: EvalItem[] = []
  for (const item of input.items) {
    const itemId = assertIdentifier(item.itemId, 'itemId')
    const kcId = assertIdentifier(item.kcId, 'kcId')
    if (!EVAL_SPLIT_SET.has(item.split)) {
      throw new SplitIsolationError(`unknown split ${item.split}`)
    }
    if (!Number.isInteger(item.difficulty) || item.difficulty < 1 || item.difficulty > 5) {
      throw new SplitIsolationError('difficulty must be an integer in 1..5')
    }
    if (item.split === 'transfer' && item.seenBefore) {
      throw new SplitIsolationError(
        'transfer items must be unseen (seenBefore must be false)',
      )
    }
    if (seen.has(itemId)) {
      throw new SplitIsolationError(`item ${itemId} appears in two splits`)
    }
    seen.add(itemId)
    items.push(
      Object.freeze({
        itemId,
        kcId,
        split: item.split,
        difficulty: item.difficulty,
        seenBefore: item.seenBefore,
      }),
    )
  }
  for (const required of ['train', 'transfer'] as const) {
    if (!items.some((item) => item.split === required)) {
      throw new SplitIsolationError(
        `the frozen set needs at least one ${required} item`,
      )
    }
  }
  const digest = contentDigest({
    dataset_id: datasetId,
    version,
    frozen_at: frozenAt,
    items: items.map((item) => ({
      item_id: item.itemId,
      kc_id: item.kcId,
      split: item.split,
      difficulty: item.difficulty,
      seen_before: item.seenBefore,
    })),
  })
  if (input.digest !== undefined && input.digest !== digest) {
    throw new IntegrityError('frozen dataset digest mismatch')
  }
  return Object.freeze({
    datasetId,
    version,
    frozenAt,
    items: Object.freeze(items),
    digest,
  })
}

export function createRealOutcome(input: RealOutcome): RealOutcome {
  const itemId = assertIdentifier(input.itemId, 'itemId')
  if (typeof input.correct !== 'boolean') {
    throw new ValidationError('correct must be a boolean')
  }
  if (!REAL_SOURCE_SET.has(input.source)) {
    throw new SelfProofError(
      `real outcomes must come from a trusted observed source; ${input.source} is not one of [${[...REAL_SOURCES].sort().join(', ')}]`,
    )
  }
  const occurredAt = assertTimestamp(input.occurredAt, 'occurredAt')
  if (input.independent !== true) {
    throw new ValidationError('transfer evaluation only counts independent attempts')
  }
  return Object.freeze({
    itemId,
    correct: input.correct,
    source: input.source,
    occurredAt,
    independent: true,
  })
}

export function runEvaluationProtocol(
  frozen: FrozenEvalSet,
  options: {
    readonly simulatedOutcomes?: readonly SimulatedOutcome[]
    readonly realOutcomes?: readonly RealOutcome[]
    readonly referenceAccuracy?: number
  } = {},
): EvaluationResultView {
  const referenceAccuracy =
    options.referenceAccuracy ?? DEFAULT_REFERENCE_ACCURACY
  if (
    typeof referenceAccuracy !== 'number' ||
    !Number.isFinite(referenceAccuracy) ||
    referenceAccuracy < 0 ||
    referenceAccuracy > 1
  ) {
    throw new ValidationError('referenceAccuracy must be a number in [0, 1]')
  }
  const itemById = new Map(frozen.items.map((item) => [item.itemId, item]))
  const simulatedOutcomes = options.simulatedOutcomes ?? []
  const realOutcomes = options.realOutcomes ?? []

  let simulatedBenefit: SimulatedBenefitView | null = null
  if (simulatedOutcomes.length > 0) {
    let total = 0
    for (const outcome of simulatedOutcomes) {
      const item = itemById.get(outcome.itemId)
      if (item === undefined) {
        throw new SplitIsolationError(
          `outcome references item ${outcome.itemId} which is not in the frozen evaluation set`,
        )
      }
      if (item.split === 'transfer') {
        throw new SplitIsolationError(
          'simulated outcomes must not touch the transfer split; transfer is reserved for real observed evaluation',
        )
      }
      if (
        typeof outcome.predictedCorrect !== 'number' ||
        !Number.isFinite(outcome.predictedCorrect) ||
        outcome.predictedCorrect < 0 ||
        outcome.predictedCorrect > 1
      ) {
        throw new ValidationError('predictedCorrect must be a number in [0, 1]')
      }
      total += outcome.predictedCorrect
    }
    const mean = total / simulatedOutcomes.length
    simulatedBenefit = Object.freeze({
      split: 'train+explanation',
      itemCount: simulatedOutcomes.length,
      meanPredictedCorrect: mean,
      referenceAccuracy,
      simulatedGain: mean - referenceAccuracy,
      isCausalEvidence: false,
      interpretation: 'simulation only; not a real learning effect',
    })
  }

  let realTransfer: RealTransferView | null = null
  if (realOutcomes.length > 0) {
    let correct = 0
    const sources = new Set<string>()
    for (const outcome of realOutcomes) {
      const item = itemById.get(outcome.itemId)
      if (item === undefined) {
        throw new SplitIsolationError(
          `outcome references item ${outcome.itemId} which is not in the frozen evaluation set`,
        )
      }
      if (!REAL_SOURCE_SET.has(outcome.source)) {
        throw new SelfProofError(
          'simulated data cannot be relabelled as real evidence',
        )
      }
      if (item.split !== 'transfer') {
        throw new SplitIsolationError(
          'real transfer may only reference transfer-split items',
        )
      }
      if (item.seenBefore) {
        throw new SplitIsolationError(
          'transfer items must be unseen for a transfer claim',
        )
      }
      sources.add(outcome.source)
      if (outcome.correct) {
        correct += 1
      }
    }
    if (sources.size !== 1) {
      throw new SplitIsolationError(
        'a run must not mix observed sources across the real channel',
      )
    }
    const accuracy = correct / realOutcomes.length
    realTransfer = Object.freeze({
      itemCount: realOutcomes.length,
      independentCorrect: correct,
      transferAccuracy: accuracy,
      referenceAccuracy,
      observedDelta: accuracy - referenceAccuracy,
      sources: Object.freeze([...sources].sort()),
      allItemsUnseen: true,
      causalClaimSupported: false,
      interpretation:
        'observed transfer on unseen items; without a control group this is descriptive, not causal',
    })
  }

  const selfProofGuard: string[] = [
    'simulated outcomes are recorded as L3 simulation benefit only and are never converted into a real-transfer claim',
    'real transfer is computed exclusively from the observed channel (trusted sources, unseen transfer items, independent attempts)',
  ]
  if (realTransfer === null) {
    selfProofGuard.push(
      'no real observed transfer outcomes were supplied, so no real learning effect is claimed',
    )
  } else {
    selfProofGuard.push(
      'a control group was not part of this run, so the observed delta is descriptive only',
    )
  }
  const claim =
    realTransfer === null
      ? 'no real transfer evidence: simulated results cannot be reported as a real learning effect'
      : 'observed transfer evidence is available but, without a control group, only a descriptive comparison is supported'
  return Object.freeze({
    simulatedBenefit,
    realTransfer,
    selfProofGuard: Object.freeze(selfProofGuard),
    limitations: Object.freeze([
      'synthetic fixtures only; no real student data is used',
      'small sample sizes and no randomisation or control group',
      'reference accuracy is a pre-registered constant, not a measured control condition',
      'simulated predictions are model output and can be over-optimistic',
    ]),
    claim,
  })
}

export interface EvaluationRun {
  readonly runId: string
  readonly datasetId: string
  readonly datasetVersion: string
  readonly datasetDigest: string
  readonly idempotencyKey: string
  readonly createdAt: string
  readonly claim: string
  readonly selfProofGuard: readonly string[]
  readonly limitations: readonly string[]
  readonly simulated: SimulatedBenefitView | null
  readonly realTransfer: RealTransferView | null
}

export abstract class EvaluationService {
  abstract registerDataset(frozen: FrozenEvalSet): Record<string, unknown>
  abstract getDataset(datasetId: string): FrozenEvalSet
  abstract run(
    datasetId: string,
    options: {
      idempotencyKey: string
      simulatedOutcomes?: readonly SimulatedOutcome[]
      realOutcomes?: readonly RealOutcome[]
      generatedAt?: string
      referenceAccuracy?: number
    },
  ): EvaluationRun
  abstract getRun(runId: string): EvaluationRun
}

abstract class BaseEvaluationService extends EvaluationService {
  protected readonly datasets = new Map<string, FrozenEvalSet>()
  protected readonly runs = new Map<string, EvaluationRun>()
  protected readonly idempotency = new Map<string, string>()
  protected readonly inputs = new Map<string, string>()

  protected persistDatasets(): void {}
  protected persistRuns(): void {}

  registerDataset(frozen: FrozenEvalSet): Record<string, unknown> {
    if (frozen === null || typeof frozen !== 'object') {
      throw new ValidationError('registerDataset requires a FrozenEvalSet')
    }
    const existing = this.datasets.get(frozen.datasetId)
    if (existing !== undefined) {
      if (existing.digest !== frozen.digest) {
        throw new ConflictError(
          `dataset ${frozen.datasetId} is already frozen at a different digest`,
        )
      }
      return this.datasetSummary(existing)
    }
    this.datasets.set(frozen.datasetId, frozen)
    this.persistDatasets()
    return this.datasetSummary(frozen)
  }

  private datasetSummary(frozen: FrozenEvalSet): Record<string, unknown> {
    const counts: Record<string, number> = {}
    for (const split of EVAL_SPLITS) {
      counts[split] = frozen.items.filter((item) => item.split === split).length
    }
    return {
      dataset_id: frozen.datasetId,
      version: frozen.version,
      digest: frozen.digest,
      frozen_at: frozen.frozenAt,
      counts,
    }
  }

  getDataset(datasetId: string): FrozenEvalSet {
    const frozen = this.datasets.get(datasetId)
    if (frozen === undefined) {
      throw new NotFoundError(`no frozen dataset ${datasetId}`)
    }
    return frozen
  }

  run(
    datasetId: string,
    options: {
      idempotencyKey: string
      simulatedOutcomes?: readonly SimulatedOutcome[]
      realOutcomes?: readonly RealOutcome[]
      generatedAt?: string
      referenceAccuracy?: number
    },
  ): EvaluationRun {
    const idempotencyKey = assertIdentifier(
      options.idempotencyKey,
      'idempotencyKey',
    )
    const frozen = this.getDataset(datasetId)
    const simulatedOutcomes = options.simulatedOutcomes ?? []
    const realOutcomes = options.realOutcomes ?? []
    const inputKey = canonicalJson({
      simulated: simulatedOutcomes.map((outcome) => [
        outcome.itemId,
        outcome.predictedCorrect,
      ]),
      real: realOutcomes.map((outcome) => [
        outcome.itemId,
        outcome.correct,
        outcome.source,
        outcome.occurredAt,
        outcome.independent,
      ]),
    })
    const key = `${datasetId}\u001f${idempotencyKey}`
    const existingId = this.idempotency.get(key)
    if (existingId !== undefined) {
      if (this.inputs.get(key) !== inputKey) {
        throw new IdempotencyConflictError(
          'the evaluation idempotency key was reused with different inputs',
        )
      }
      return this.runs.get(existingId) as EvaluationRun
    }
    const result = runEvaluationProtocol(frozen, {
      simulatedOutcomes,
      realOutcomes,
      referenceAccuracy: options.referenceAccuracy,
    })
    const run: EvaluationRun = Object.freeze({
      runId: deriveRunId(datasetId, idempotencyKey),
      datasetId,
      datasetVersion: frozen.version,
      datasetDigest: frozen.digest,
      idempotencyKey,
      createdAt: options.generatedAt ?? utcNow(),
      claim: result.claim,
      selfProofGuard: result.selfProofGuard,
      limitations: result.limitations,
      simulated: result.simulatedBenefit,
      realTransfer: result.realTransfer,
    })
    this.runs.set(run.runId, run)
    this.idempotency.set(key, run.runId)
    this.inputs.set(key, inputKey)
    this.persistRuns()
    return run
  }

  getRun(runId: string): EvaluationRun {
    const run = this.runs.get(runId)
    if (run === undefined) {
      throw new NotFoundError(`no evaluation run ${runId}`)
    }
    return run
  }

  listRuns(datasetId?: string): readonly EvaluationRun[] {
    const runs = [...this.runs.values()].filter(
      (run) => datasetId === undefined || run.datasetId === datasetId,
    )
    runs.sort((left, right) => (left.runId < right.runId ? -1 : 1))
    return Object.freeze(runs)
  }
}

export class InMemoryEvaluationService extends BaseEvaluationService {}

export class FileEvaluationService extends BaseEvaluationService {
  private readonly datasetsPath: string
  private readonly runsPath: string

  constructor(root: string) {
    super()
    const base = resolve(root)
    this.datasetsPath = join(base, 'eval_datasets.json')
    this.runsPath = join(base, 'eval_runs.json')
    this.loadState()
  }

  private loadState(): void {
    const datasets = readJsonFile(this.datasetsPath, {}) as Record<string, unknown>
    if (datasets === null || typeof datasets !== 'object' || Array.isArray(datasets)) {
      throw new IntegrityError('eval datasets file must contain an object')
    }
    for (const key of Object.keys(datasets)) {
      const record = datasets[key] as Record<string, unknown>
      const items = ((record.items as Record<string, unknown>[]) ?? []).map(
        (item) => ({
          itemId: String(item.item_id),
          kcId: String(item.kc_id),
          split: item.split as EvalSplit,
          difficulty: Number(item.difficulty ?? 2),
          seenBefore: Boolean(item.seen_before),
        }),
      )
      const frozen = createFrozenEvalSet({
        datasetId: String(record.dataset_id),
        version: String(record.version),
        frozenAt: String(record.frozen_at),
        items,
        digest: record.digest ? String(record.digest) : undefined,
      })
      if (frozen.datasetId !== key) {
        throw new IntegrityError('dataset key does not match datasetId')
      }
      this.datasets.set(frozen.datasetId, frozen)
    }
    const runs = readJsonFile(this.runsPath, {}) as Record<string, unknown>
    if (runs === null || typeof runs !== 'object' || Array.isArray(runs)) {
      throw new IntegrityError('eval runs file must contain an object')
    }
    for (const key of Object.keys(runs)) {
      const run = runs[key] as EvaluationRun
      if (run.runId !== key) {
        throw new IntegrityError('run key does not match runId')
      }
      this.runs.set(run.runId, run)
    }
  }

  protected override persistDatasets(): void {
    const output: Record<string, unknown> = {}
    for (const [datasetId, frozen] of this.datasets) {
      output[datasetId] = {
        ...this.datasetSummaryFor(frozen),
        frozen_at: frozen.frozenAt,
        items: frozen.items.map((item) => ({
          item_id: item.itemId,
          kc_id: item.kcId,
          split: item.split,
          difficulty: item.difficulty,
          seen_before: item.seenBefore,
        })),
      }
    }
    atomicWriteJson(this.datasetsPath, output)
  }

  private datasetSummaryFor(frozen: FrozenEvalSet): Record<string, unknown> {
    return {
      dataset_id: frozen.datasetId,
      version: frozen.version,
      digest: frozen.digest,
    }
  }

  protected override persistRuns(): void {
    const output: Record<string, unknown> = {}
    for (const [runId, run] of this.runs) {
      output[runId] = run
    }
    atomicWriteJson(this.runsPath, output)
  }
}

// ---------------------------------------------------------------------------
// Harness state machine (spec §12.2 / §15.3)
// ---------------------------------------------------------------------------

export interface TransitionRecord {
  readonly index: number
  readonly fromState: string
  readonly toState: string
  readonly reason: string
  readonly detail: Payload
  readonly occurredAt: string
}

export interface StateMachineSnapshot {
  readonly studentRef: string
  readonly sessionId: string
  readonly state: string
  readonly isTerminal: boolean
  readonly allowedNext: readonly string[]
  readonly transitions: readonly TransitionRecord[]
  readonly rejections: number
  readonly degraded: readonly Payload[]
  readonly exceptions: Readonly<Record<string, number>>
}

export function exceptionBranch(code: string): ExceptionBranch {
  const branch = EXCEPTION_BRANCHES[code]
  if (branch === undefined) {
    throw new ValidationError(`unknown exception branch ${code}`)
  }
  return branch
}

export class HarnessStateMachine {
  readonly studentRef: string
  readonly sessionId: string
  private readonly maxRejections: number
  private currentState: string
  private readonly transitionHistory: TransitionRecord[] = []
  private readonly idempotency = new Map<string, TransitionRecord>()
  private rejectionCount = 0
  private readonly degradedRecords: Payload[] = []
  private readonly exceptionCounts: Record<string, number> = {}

  constructor(
    studentRef: string,
    options: {
      sessionId?: string
      initialState?: string
      maxRejections?: number
    } = {},
  ) {
    this.studentRef = assertIdentifier(studentRef, 'studentRef')
    this.sessionId = options.sessionId ?? ''
    const initial = options.initialState ?? STATE_INTAKE
    if (!LEARNING_STATE_SET.has(initial)) {
      throw new ValidationError(`unknown state ${initial}`)
    }
    if (TERMINAL_STATE_SET.has(initial)) {
      throw new ValidationError('cannot start in a terminal state')
    }
    this.currentState = initial
    const maxRejections = options.maxRejections ?? DEFAULT_MAX_REJECTIONS
    if (!Number.isInteger(maxRejections) || maxRejections < 1) {
      throw new ValidationError('maxRejections must be a positive integer')
    }
    this.maxRejections = maxRejections
  }

  get state(): string {
    return this.currentState
  }

  get isTerminal(): boolean {
    return TERMINAL_STATE_SET.has(this.currentState)
  }

  get history(): readonly TransitionRecord[] {
    return Object.freeze([...this.transitionHistory])
  }

  get rejections(): number {
    return this.rejectionCount
  }

  allowedNext(): readonly string[] {
    if (this.isTerminal) {
      return Object.freeze([])
    }
    const normal = new Set(TRANSITIONS[this.currentState] ?? [])
    normal.add(STATE_FAILED)
    normal.add(STATE_ABORTED)
    return Object.freeze([...normal])
  }

  canAdvance(toState: string): boolean {
    return this.allowedNext().includes(toState)
  }

  advance(
    toState: string,
    options: {
      reason: string
      idempotencyKey?: string
      detail?: unknown
    },
  ): TransitionRecord {
    return this.transition(toState, { ...options, allowAny: false })
  }

  private transition(
    toState: string,
    options: {
      reason: string
      idempotencyKey?: string
      detail?: unknown
      allowAny: boolean
    },
  ): TransitionRecord {
    assertIdentifier(options.reason, 'reason')
    if (!LEARNING_STATE_SET.has(toState)) {
      throw new ValidationError(`unknown state ${toState}`)
    }
    const idempotencyKey = options.idempotencyKey
    if (idempotencyKey !== undefined) {
      assertIdentifier(idempotencyKey, 'idempotencyKey')
      const recorded = this.idempotency.get(idempotencyKey)
      if (recorded !== undefined) {
        if (recorded.toState !== toState) {
          throw new IdempotencyConflictError(
            'the transition idempotency key was reused for a different target state',
          )
        }
        return recorded
      }
    }
    if (this.isTerminal) {
      throw new StateMachineError(
        `state ${this.currentState} is terminal and cannot transition`,
      )
    }
    if (!options.allowAny && !this.canAdvance(toState)) {
      throw new InvalidTransitionError(
        `${this.currentState} cannot transition to ${toState}`,
      )
    }
    const record: TransitionRecord = Object.freeze({
      index: this.transitionHistory.length + 1,
      fromState: this.currentState,
      toState,
      reason: options.reason,
      detail: normalizePayload(options.detail),
      occurredAt: utcNow(),
    })
    this.transitionHistory.push(record)
    this.currentState = toState
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, record)
    }
    return record
  }

  registerRejection(
    options: {
      code?: string
      reason?: string
      detail?: unknown
    } = {},
  ): TransitionRecord {
    const code = options.code ?? BRANCH_CONTENT_REJECTED
    const reason = options.reason ?? 'rejected'
    this.rejectionCount += 1
    if (this.rejectionCount > this.maxRejections) {
      this.degradedRecords.push(
        Object.freeze({ code, mode: 'rework_budget_exhausted' }),
      )
      if (this.isTerminal) {
        throw new StateMachineError('the machine already failed closed')
      }
      return this.advance(STATE_FAILED, {
        reason: `${code}:budget_exhausted`,
        detail: options.detail,
      })
    }
    return this.advance(STATE_EXERCISE_EVOLUTION, {
      reason: `${code}:${reason}`,
      detail: options.detail,
    })
  }

  handleException(code: string, options: { detail?: unknown } = {}): ExceptionBranch {
    const branch = exceptionBranch(code)
    if (branch.targetState !== '' && this.isTerminal) {
      throw new StateMachineError(
        'cannot apply a branch from a terminal state',
      )
    }
    this.exceptionCounts[code] = (this.exceptionCounts[code] ?? 0) + 1
    this.degradedRecords.push(
      Object.freeze({
        code: branch.code,
        mode: branch.degradedMode,
        target_state: branch.targetState,
      }),
    )
    if (branch.targetState !== '') {
      this.transition(branch.targetState, {
        reason: `exception:${code}`,
        detail: options.detail,
        allowAny: true,
      })
    }
    return branch
  }

  snapshot(): StateMachineSnapshot {
    return Object.freeze({
      studentRef: this.studentRef,
      sessionId: this.sessionId,
      state: this.currentState,
      isTerminal: this.isTerminal,
      allowedNext: Object.freeze([...this.allowedNext()].sort()),
      transitions: Object.freeze([...this.transitionHistory]),
      rejections: this.rejectionCount,
      degraded: Object.freeze([...this.degradedRecords]),
      exceptions: Object.freeze({ ...this.exceptionCounts }),
    })
  }
}
