/**
 * FSRS-style memory model (spec sections 8.3, 8.4, 8.6).
 *
 * Mirrors `aeh/memory.py`:
 *
 *   R(t) = (1 + 19/81 * t / S)^(-1/2)
 *   dt   = 81/19 * S * (r_target^(-2) - 1)
 *
 * Reading an explanation has zero retrieval weight; a hint-assisted follow-up
 * has low weight; only a correct, unhinted, independent first attempt counts
 * as an independent retrieval success.
 */

import {
  MemoryError,
  isFiniteNumber,
  type MemoryObservationInput,
  type MemoryState,
  type MemoryStateInput,
} from '../domain.ts'

export const FSRS_19_81 = 19 / 81
export const FSRS_81_19 = 81 / 19

export const INDEPENDENT_WEIGHT = 1
export const HINTED_WEIGHT = 0.3
export const READING_WEIGHT = 0

export const SUCCESS_GROWTH = 0.6
export const FAILURE_SHRINK = 0.4
export const MIN_STABILITY_DAYS = 0.4
export const INITIAL_STABILITY_DAYS = 1
export const INITIAL_DIFFICULTY = 5

/** Step 12: FSRS dynamics parameter bounds/reference values. */
export const DIFFICULTY_MIN = 1
export const DIFFICULTY_MAX = 10
export const DIFFICULTY_REFERENCE = 5
export const DIFFICULTY_SUCCESS_DELTA = 0.2
export const DIFFICULTY_FAILURE_DELTA = 0.5

/** The spec-8.3 illustrative parameter version (baseline before calibration). */
export const BASELINE_PARAMETER_VERSION = 'fsrs_illustrative_19_81'

/** Ordered parameter names, matching `fsrs-calibration.ts` PARAMETER_NAMES. */
export const MEMORY_PARAMETER_NAMES = Object.freeze([
  'initial_stability_days',
  'success_growth',
  'failure_shrink',
  'initial_difficulty',
  'difficulty_success_delta',
  'difficulty_failure_delta',
] as const)

export type ObservationKind = 'attempt' | 'hint_followup' | 'reading'

export interface MemoryParametersInput {
  readonly initialStabilityDays?: number
  readonly successGrowth?: number
  readonly failureShrink?: number
  readonly initialDifficulty?: number
  readonly difficultySuccessDelta?: number
  readonly difficultyFailureDelta?: number
  readonly parameterVersion?: string
}

function finiteParameter(value: number, name: string): number {
  if (!isFiniteNumber(value)) {
    throw new MemoryError(`${name} must be a finite number`)
  }
  if (value < 0) {
    throw new MemoryError(`${name} must be >= 0`)
  }
  return value
}

/**
 * A validated FSRS dynamics parameter vector (Step 11 candidate shape).
 *
 * The defaults are exactly the spec-8.3 illustrative parameters, so a baseline
 * instance is numerically identical to the pre-Step-12 behaviour. A calibrated
 * candidate is attached to a twin as a *pending* candidate and only becomes
 * effective after an explicit host approval.
 */
export class MemoryParameters {
  readonly initialStabilityDays: number
  readonly successGrowth: number
  readonly failureShrink: number
  readonly initialDifficulty: number
  readonly difficultySuccessDelta: number
  readonly difficultyFailureDelta: number
  readonly parameterVersion: string

  constructor(input: MemoryParametersInput = {}) {
    this.initialStabilityDays = finiteParameter(
      input.initialStabilityDays ?? INITIAL_STABILITY_DAYS,
      'initialStabilityDays',
    )
    this.successGrowth = finiteParameter(
      input.successGrowth ?? SUCCESS_GROWTH,
      'successGrowth',
    )
    this.failureShrink = finiteParameter(
      input.failureShrink ?? FAILURE_SHRINK,
      'failureShrink',
    )
    this.initialDifficulty = finiteParameter(
      input.initialDifficulty ?? INITIAL_DIFFICULTY,
      'initialDifficulty',
    )
    this.difficultySuccessDelta = finiteParameter(
      input.difficultySuccessDelta ?? DIFFICULTY_SUCCESS_DELTA,
      'difficultySuccessDelta',
    )
    this.difficultyFailureDelta = finiteParameter(
      input.difficultyFailureDelta ?? DIFFICULTY_FAILURE_DELTA,
      'difficultyFailureDelta',
    )
    const version = input.parameterVersion ?? BASELINE_PARAMETER_VERSION
    if (typeof version !== 'string' || version.length === 0) {
      throw new MemoryError('parameterVersion must be a non-empty string')
    }
    this.parameterVersion = version
    if (this.initialStabilityDays <= 0) {
      throw new MemoryError('initialStabilityDays must be > 0')
    }
    if (this.initialDifficulty < 1 || this.initialDifficulty > 10) {
      throw new MemoryError('initialDifficulty must be within [1, 10]')
    }
    Object.freeze(this)
  }

  static baseline(): MemoryParameters {
    return new MemoryParameters()
  }

  /** Build parameters from a Step-11 candidate `parameters` mapping. */
  static fromMapping(
    data: Readonly<Record<string, unknown>>,
    parameterVersion?: string,
  ): MemoryParameters {
    if (data === null || typeof data !== 'object') {
      throw new MemoryError('parameters must be an object')
    }
    const read = (name: string): number => {
      const value = data[name]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new MemoryError(`parameters.${name} must be a finite number`)
      }
      return value
    }
    const version =
      parameterVersion ??
      (typeof data['parameter_version'] === 'string'
        ? (data['parameter_version'] as string)
        : BASELINE_PARAMETER_VERSION)
    return new MemoryParameters({
      initialStabilityDays: read('initial_stability_days'),
      successGrowth: read('success_growth'),
      failureShrink: read('failure_shrink'),
      initialDifficulty: read('initial_difficulty'),
      difficultySuccessDelta: read('difficulty_success_delta'),
      difficultyFailureDelta: read('difficulty_failure_delta'),
      parameterVersion: version,
    })
  }

  valueDict(): Record<string, number> {
    return {
      initial_stability_days: this.initialStabilityDays,
      success_growth: this.successGrowth,
      failure_shrink: this.failureShrink,
      initial_difficulty: this.initialDifficulty,
      difficulty_success_delta: this.difficultySuccessDelta,
      difficulty_failure_delta: this.difficultyFailureDelta,
    }
  }

  difficultyFactor(difficulty: number): number {
    return (DIFFICULTY_MAX - difficulty) / (DIFFICULTY_MAX - DIFFICULTY_REFERENCE)
  }

  effectiveStability(stabilityDays: number, difficulty: number): number {
    const effective = stabilityDays * this.difficultyFactor(difficulty)
    return effective > MIN_STABILITY_DAYS ? effective : MIN_STABILITY_DAYS
  }

  predict(
    elapsedDays: number,
    stabilityDays: number,
    difficulty: number,
  ): number {
    const effective = this.effectiveStability(stabilityDays, difficulty)
    return (1 + FSRS_19_81 * (elapsedDays / effective)) ** -0.5
  }

  nextIntervalDays(
    stabilityDays: number,
    difficulty: number,
    targetRetention = 0.9,
  ): number {
    const effective = this.effectiveStability(stabilityDays, difficulty)
    return intervalForTarget(effective, targetRetention)
  }

  update(
    stabilityDays: number,
    difficulty: number,
    success: boolean,
    weight: number,
  ): { readonly stabilityDays: number; readonly difficulty: number } {
    if (weight <= 0) {
      return { stabilityDays, difficulty }
    }
    if (success) {
      return {
        stabilityDays: stabilityDays * (1 + this.successGrowth * weight),
        difficulty: Math.max(
          DIFFICULTY_MIN,
          difficulty - this.difficultySuccessDelta * weight,
        ),
      }
    }
    return {
      stabilityDays: Math.max(
        MIN_STABILITY_DAYS,
        stabilityDays * (1 - this.failureShrink * weight),
      ),
      difficulty: Math.min(
        DIFFICULTY_MAX,
        difficulty + this.difficultyFailureDelta * weight,
      ),
    }
  }
}

function positive(value: number, name: string): number {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new MemoryError(`${name} must be a finite number > 0`)
  }
  return value
}

function uncertaintyFor(count: number): MemoryState['uncertainty'] {
  if (count >= 5) return 'low'
  if (count >= 2) return 'medium'
  return 'high'
}

/** Probability of independent retrieval after `elapsedDays`. */
export function retrievability(
  elapsedDays: number,
  stabilityDays: number,
): number {
  positive(stabilityDays, 'stabilityDays')
  if (!isFiniteNumber(elapsedDays) || elapsedDays < 0) {
    throw new MemoryError('elapsedDays must be a finite number >= 0')
  }
  return (1 + FSRS_19_81 * (elapsedDays / stabilityDays)) ** -0.5
}

/** Invert the retention formula for a target retention probability. */
export function intervalForTarget(
  stabilityDays: number,
  targetRetention = 0.9,
): number {
  positive(stabilityDays, 'stabilityDays')
  if (
    !isFiniteNumber(targetRetention) ||
    targetRetention <= 0 ||
    targetRetention >= 1
  ) {
    throw new MemoryError('targetRetention must be within (0, 1)')
  }
  return FSRS_81_19 * stabilityDays * (targetRetention ** -2 - 1)
}

/** Fill defaults and validate a memory state supplied by a host or tool call. */
export function normalizeMemoryState(input: MemoryStateInput): MemoryState {
  const stabilityDays = input.stabilityDays ?? INITIAL_STABILITY_DAYS
  const difficulty = input.difficulty ?? INITIAL_DIFFICULTY
  positive(stabilityDays, 'stabilityDays')
  if (!isFiniteNumber(difficulty) || difficulty < 1 || difficulty > 10) {
    throw new MemoryError('difficulty must be within [1, 10]')
  }
  return Object.freeze({
    learnerRef: input.learnerRef,
    memoryUnitId: input.memoryUnitId,
    stabilityDays,
    difficulty,
    observationCount: Math.max(0, input.observationCount ?? 0),
    independentSuccessCount: Math.max(0, input.independentSuccessCount ?? 0),
    lastIndependentSuccessAt: input.lastIndependentSuccessAt ?? null,
    uncertainty: input.uncertainty ?? 'high',
    modelFamily: input.modelFamily ?? 'fsrs_compatible',
    modelVersion: input.modelVersion ?? 'fsrs_illustrative_19_81',
    lastObservedAt: input.lastObservedAt ?? null,
    needsCalibration: input.needsCalibration ?? false,
  })
}

export function createMemoryState(
  learnerRef: string,
  memoryUnitId: string,
): MemoryState {
  return normalizeMemoryState({ learnerRef, memoryUnitId })
}

/** Effective weight of an observation for the memory model. */
export function retrievalWeight(observation: MemoryObservationInput): number {
  const kind = observation.kind ?? 'attempt'
  if (kind === 'reading') {
    return READING_WEIGHT
  }
  if (kind === 'hint_followup') {
    // A post-hint follow-up is hint-assisted even if a caller forgets to set
    // `independent: false`; it never earns full independent-answer weight.
    return HINTED_WEIGHT
  }
  if ((observation.independent ?? true) && (observation.hintLevel ?? 0) === 0) {
    return INDEPENDENT_WEIGHT
  }
  return HINTED_WEIGHT
}

/** True only for a correct, unhinted, independent first attempt. */
export function isIndependentRetrievalSuccess(
  observation: MemoryObservationInput,
): boolean {
  return (
    observation.success &&
    (observation.independent ?? true) &&
    (observation.hintLevel ?? 0) === 0 &&
    (observation.kind ?? 'attempt') === 'attempt'
  )
}

/**
 * Return the updated memory state for one observation.
 *
 * Reading leaves stability and observation counts unchanged; hint-assisted
 * success grows stability less than independent success.
 */
export function updateMemory(
  state: MemoryState,
  observation: MemoryObservationInput,
  parameters?: MemoryParameters,
): MemoryState {
  const hintLevel = observation.hintLevel ?? 0
  if (!Number.isInteger(hintLevel) || hintLevel < 0) {
    throw new MemoryError('hintLevel must be a non-negative integer')
  }

  const weight = retrievalWeight(observation)
  if (weight <= 0) {
    // Reading is not an independent retrieval success: no memory update.
    return state
  }

  const params = parameters ?? new MemoryParameters()
  const next = params.update(
    state.stabilityDays,
    state.difficulty,
    observation.success,
    weight,
  )

  const independent = isIndependentRetrievalSuccess(observation)
  const count = state.observationCount + 1
  const independentCount =
    state.independentSuccessCount + (independent ? 1 : 0)
  const lastSuccess = independent
    ? (observation.occurredAt ?? null)
    : state.lastIndependentSuccessAt

  return Object.freeze({
    ...state,
    stabilityDays: next.stabilityDays,
    difficulty: next.difficulty,
    observationCount: count,
    independentSuccessCount: independentCount,
    lastIndependentSuccessAt: lastSuccess,
    lastObservedAt: observation.occurredAt ?? state.lastObservedAt ?? null,
    needsCalibration: false,
    uncertainty: uncertaintyFor(count),
    modelVersion:
      parameters === undefined ? state.modelVersion : params.parameterVersion,
  })
}

export function updateMany(
  state: MemoryState,
  observations: readonly MemoryObservationInput[],
  parameters?: MemoryParameters,
): MemoryState {
  return observations.reduce(
    (current, observation) => updateMemory(current, observation, parameters),
    state,
  )
}

/** Raise uncertainty by one band; never conclude "does not know" (spec 5). */
function bumpUncertainty(
  uncertainty: MemoryState['uncertainty'],
): MemoryState['uncertainty'] {
  if (uncertainty === 'low') return 'medium'
  return 'high'
}

function elapsedDaysBetween(anchor: string, now: string): number {
  const anchorMs = Date.parse(anchor)
  const nowMs = Date.parse(now)
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs) || nowMs <= anchorMs) {
    return 0
  }
  return (nowMs - anchorMs) / 86_400_000
}

/**
 * Age a memory state without ever lowering stability or difficulty.
 *
 * An overdue unit only raises uncertainty and flags itself for calibration; a
 * long silence is evidence of a stale estimate, not evidence of forgetting.
 */
export function applyForgetting(
  state: MemoryState,
  now: string,
  options: {
    readonly targetRetention?: number
    readonly parameters?: MemoryParameters
  } = {},
): MemoryState {
  const anchor = state.lastObservedAt ?? state.lastIndependentSuccessAt
  if (anchor === null) {
    return state
  }
  const elapsed = elapsedDaysBetween(anchor, now)
  if (elapsed <= 0) {
    return state
  }
  const params = options.parameters ?? new MemoryParameters()
  const target = options.targetRetention ?? 0.9
  const expected = params.predict(elapsed, state.stabilityDays, state.difficulty)
  if (expected >= target) {
    return state
  }
  return Object.freeze({
    ...state,
    uncertainty: bumpUncertainty(state.uncertainty),
    needsCalibration: true,
  })
}

/** A JSON-friendly health view for one memory unit. */
export function memoryHealth(
  state: MemoryState,
  now: string,
  options: {
    readonly targetRetention?: number
    readonly parameters?: MemoryParameters
  } = {},
): Readonly<Record<string, unknown>> {
  const anchor = state.lastObservedAt ?? state.lastIndependentSuccessAt
  const elapsed = anchor === null ? 0 : elapsedDaysBetween(anchor, now)
  const params = options.parameters ?? new MemoryParameters()
  const target = options.targetRetention ?? 0.9
  const expected = params.predict(elapsed, state.stabilityDays, state.difficulty)
  return Object.freeze({
    memoryUnitId: state.memoryUnitId,
    stabilityDays: Number(state.stabilityDays.toFixed(6)),
    difficulty: Number(state.difficulty.toFixed(6)),
    observationCount: state.observationCount,
    uncertainty: state.uncertainty,
    elapsedDays: Number(elapsed.toFixed(6)),
    expectedRetrievability: Number(expected.toFixed(6)),
    targetRetention: target,
    overdue: expected < target,
    needsCalibration: state.needsCalibration,
  })
}

/** Aggregate long-term memory across knowledge components. */
export function aggregateMemory(
  states: readonly MemoryState[],
  now: string,
  options: {
    readonly targetRetention?: number
    readonly parameters?: MemoryParameters
  } = {},
): Readonly<Record<string, unknown>> {
  const health = states.map((state) => memoryHealth(state, now, options))
  const unitCount = health.length
  const overdue = health.filter((entry) => entry['overdue'] === true)
  const mean = (key: string): number => {
    if (unitCount === 0) return 0
    const total = health.reduce(
      (sum, entry) => sum + (entry[key] as number),
      0,
    )
    return Number((total / unitCount).toFixed(6))
  }
  const weakest = [...health]
    .sort((left, right) => {
      const diff =
        (left['expectedRetrievability'] as number) -
        (right['expectedRetrievability'] as number)
      return diff !== 0
        ? diff
        : String(left['memoryUnitId']).localeCompare(String(right['memoryUnitId']))
    })
    .slice(0, 5)
    .map((entry) =>
      Object.freeze({
        memoryUnitId: entry['memoryUnitId'],
        expectedRetrievability: entry['expectedRetrievability'],
        uncertainty: entry['uncertainty'],
      }),
    )
  return Object.freeze({
    unitCount,
    overdueCount: overdue.length,
    needsCalibrationCount: health.filter(
      (entry) => entry['needsCalibration'] === true,
    ).length,
    meanStabilityDays: mean('stabilityDays'),
    meanDifficulty: mean('difficulty'),
    weakestUnits: Object.freeze(weakest),
  })
}

/** A minimal, JSON-friendly diagnosis view of a memory state. */
export function memorySnapshot(state: MemoryState): Readonly<Record<string, unknown>> {
  return Object.freeze({
    learnerRef: state.learnerRef,
    memoryUnitId: state.memoryUnitId,
    modelFamily: state.modelFamily,
    modelVersion: state.modelVersion,
    stabilityDays: Number(state.stabilityDays.toFixed(6)),
    difficultyState: Number(state.difficulty.toFixed(6)),
    observationCount: state.observationCount,
    independentSuccessCount: state.independentSuccessCount,
    uncertainty: state.uncertainty,
  })
}

/** Schedule the next review, returning plain JSON values for the tool layer. */
export function reviewSchedule(
  state: MemoryState,
  targetRetention = 0.9,
): Readonly<Record<string, unknown>> {
  const intervalDays = intervalForTarget(state.stabilityDays, targetRetention)
  return Object.freeze({
    ...memorySnapshot(state),
    targetRetention,
    nextIntervalDays: Number(intervalDays.toFixed(6)),
    expectedRetrievabilityAtNextReview: Number(
      retrievability(intervalDays, state.stabilityDays).toFixed(6),
    ),
  })
}
