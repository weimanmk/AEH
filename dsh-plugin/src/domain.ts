/**
 * Shared domain vocabulary for the AEH dsh/Cordis plugin skeleton.
 *
 * The TypeScript shapes mirror the Python core from Steps 1/2, but are
 * intentionally independent: no Python process is started, no database is
 * opened, and no student data is read by this package.
 *
 * Naming uses camelCase on the TypeScript side and maps to the snake_case
 * dataclasses in `aeh/` through the tables in `docs/dsh-integration.md`.
 */

/** Curriculum modes admitted by spec section 4.3. */
export type GateMode = 'preview' | 'learn' | 'review'

export const GATE_MODES: readonly GateMode[] = Object.freeze([
  'preview',
  'learn',
  'review',
])

/** Annotations below this confidence are treated as missing (fail-closed). */
export const DEFAULT_MIN_ANNOTATION_CONFIDENCE = 0.6
/** School progress below this confidence cannot unlock in-progress/preview KCs. */
export const DEFAULT_MIN_PROGRESS_CONFIDENCE = 0.6
/** How many grade levels an explicitly approved extension may reach forward. */
export const MAX_EXTENSION_GRADE_DELTA = 1

/** A candidate question / teaching item with its curriculum annotations. */
export interface CurriculumItem {
  readonly itemId: string
  /** Missing is treated as an empty set and rejected by the gate. */
  readonly requiredKcs?: readonly string[]
  /** Missing is never grade-appropriate (fail-closed). */
  readonly gradeLevel?: number | null
  readonly safetyChecked?: boolean
  readonly contentVerified?: boolean
  /** `null`/missing means "not annotated"; the gate rejects it. */
  readonly annotationConfidence?: number | null
  readonly futureMethods?: readonly string[]
  readonly cognitiveLoad?: number
  readonly extensionApproved?: boolean
  readonly role?: 'training' | 'transfer' | 'explanation' | 'diagnostic'
  readonly seenBefore?: boolean
  /**
   * Step 9 item-bank path. `undefined` is the legacy/manual default; the item
   * bank sets this explicitly to `false` when any required annotation is
   * missing, so an incomplete catalog record cannot pass the gate.
   */
  readonly annotationsComplete?: boolean
}

/** The three progress axes kept separate (spec section 4.1). */
export interface LearnerProgress {
  /**
   * Opaque, host-issued reference. The plugin never receives a legal name,
   * school account, photo, or other direct identifier.
   */
  readonly studentRef: string
  readonly gradeLevel?: number | null
  readonly taughtKcs?: readonly string[]
  readonly inProgressKcs?: readonly string[]
  readonly confirmedPreviewKcs?: readonly string[]
  readonly confirmedPriorKcs?: readonly string[]
  readonly progressConfidence?: number
  readonly currentLoad?: number
  /** Missing budget fails closed, matching the Python core. */
  readonly loadBudget?: number
  readonly extensionMode?: boolean
}

/** Result of the curriculum gate, including machine-readable refusal reasons. */
export interface GateDecision {
  readonly allowed: boolean
  readonly reasons: readonly string[]
  readonly allowedKcs: readonly string[]
  readonly itemId: string | null
  readonly mode: GateMode | string
}

/** Per-KC inferred state; never a single compressed "mastery rate". */
export interface KnowledgeEstimate {
  readonly kcId: string
  readonly masteryMean: number
  readonly uncertainty: number
  readonly evidenceIds: readonly string[]
  readonly exposureState: string
}

/** A sanitized, read-only projection of one learner's twin. */
export interface TwinSnapshot {
  readonly studentRef: string
  readonly version: number
  readonly evidenceRevision: number
  readonly knowledge: readonly KnowledgeEstimate[]
  readonly unresolvedHypotheses: readonly string[]
  readonly lastObservedAt: string | null
}

/** Host-provided snapshot of a hypothesis set for one session. */
export interface HypothesisState {
  readonly hypotheses: readonly HypothesisRecord[]
  readonly unknownWeight: number
}

/** JSON-friendly hypothesis representation used at the tool boundary. */
export interface HypothesisRecord {
  readonly hypothesisId: string
  readonly subjectScope?: readonly string[]
  readonly knowledgeAssumptions?: Readonly<Record<string, string>>
  readonly strategyPolicy?: readonly string[]
  readonly bugRules?: readonly string[]
  readonly predictedObservableBehaviors?: Readonly<Record<string, number>>
  readonly responseToIntervention?: readonly string[]
  readonly weight?: number
  readonly evidenceRefs?: readonly string[]
  readonly uncertainty?: 'low' | 'medium' | 'high'
  readonly status?: string
  readonly parentId?: string | null
  readonly mergedFrom?: readonly string[]
}

/** A diagnostic candidate plus the item whose gate status must be recomputed. */
export interface DiagnosticCandidateInput {
  readonly item: CurriculumItem
  readonly predictions?: Readonly<Record<string, number>>
  readonly timeMinutes?: number
  readonly risk?: number
  readonly cognitiveLoad?: number
  readonly teachingValue?: number
}

/** Policy weights for the probe-selection objective. */
export interface ProbeWeightInput {
  readonly alpha?: number
  readonly beta?: number
  readonly gamma?: number
  readonly delta?: number
  /** Step 14: penalty on the predicted-answer uncertainty. */
  readonly zeta?: number
}

/** One practice/review observation with quality metadata (spec 8.4). */
export interface MemoryObservationInput {
  readonly observationId: string
  readonly success: boolean
  readonly independent?: boolean
  readonly hintLevel?: number
  readonly kind?: 'attempt' | 'hint_followup' | 'reading'
  readonly transferLevel?: 'near' | 'far'
  readonly occurredAt?: string | null
}

/** Memory state at the tool boundary; omitted fields receive explicit defaults. */
export interface MemoryStateInput {
  readonly learnerRef: string
  readonly memoryUnitId: string
  readonly stabilityDays?: number
  readonly difficulty?: number
  readonly observationCount?: number
  readonly independentSuccessCount?: number
  readonly lastIndependentSuccessAt?: string | null
  readonly uncertainty?: 'low' | 'medium' | 'high'
  readonly modelFamily?: string
  readonly modelVersion?: string
  readonly lastObservedAt?: string | null
  readonly needsCalibration?: boolean
}

/** Complete memory state after normalisation. */
export interface MemoryState {
  readonly learnerRef: string
  readonly memoryUnitId: string
  readonly stabilityDays: number
  readonly difficulty: number
  readonly observationCount: number
  readonly independentSuccessCount: number
  readonly lastIndependentSuccessAt: string | null
  readonly uncertainty: 'low' | 'medium' | 'high'
  readonly modelFamily: string
  readonly modelVersion: string
  /** Step 12: timestamp of the most recent weighted observation. */
  readonly lastObservedAt: string | null
  /** Step 12: overdue against the target retention; never lowers stability. */
  readonly needsCalibration: boolean
}

/** A candidate intervention package before validation. */
export interface InterventionPackageInput {
  readonly packageId: string
  readonly objectiveId: string
  readonly trainingItems: readonly CurriculumItem[]
  readonly transferItems?: readonly CurriculumItem[]
  readonly hintLadder?: readonly string[]
  readonly feedbackTemplates?: Readonly<Record<string, string>>
  readonly explanationResources?: readonly string[]
  readonly completionCriteria?: Readonly<Record<string, unknown>>
  readonly requiredKcs?: readonly string[]
  readonly independentTransfer?: boolean
  readonly schoolMode?: GateMode
}

/** Internal exception hierarchy; tool handlers catch these and fail closed. */
export class AehError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class CurriculumGateError extends AehError {}
export class TwinError extends AehError {}
export class MemoryError extends AehError {}
export class HypothesisError extends AehError {}
export class DiagnosisError extends AehError {}
export class InterventionError extends AehError {}

/** True for a finite number; used before trusting any model-provided value. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
