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

export type ObservationKind = 'attempt' | 'hint_followup' | 'reading'

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

  let stability: number
  let difficulty: number
  if (observation.success) {
    stability = state.stabilityDays * (1 + SUCCESS_GROWTH * weight)
    difficulty = Math.max(1, state.difficulty - 0.2 * weight)
  } else {
    stability = Math.max(
      MIN_STABILITY_DAYS,
      state.stabilityDays * (1 - FAILURE_SHRINK * weight),
    )
    difficulty = Math.min(10, state.difficulty + 0.5 * weight)
  }

  const independent = isIndependentRetrievalSuccess(observation)
  const count = state.observationCount + 1
  const independentCount =
    state.independentSuccessCount + (independent ? 1 : 0)
  const lastSuccess = independent
    ? (observation.occurredAt ?? null)
    : state.lastIndependentSuccessAt

  return Object.freeze({
    ...state,
    stabilityDays: stability,
    difficulty,
    observationCount: count,
    independentSuccessCount: independentCount,
    lastIndependentSuccessAt: lastSuccess,
    uncertainty: uncertaintyFor(count),
  })
}

export function updateMany(
  state: MemoryState,
  observations: readonly MemoryObservationInput[],
): MemoryState {
  return observations.reduce(updateMemory, state)
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
