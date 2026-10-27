/**
 * FSRS parameter calibration (spec section 8).
 *
 * TypeScript mirror of `aeh/fsrs_calibration.py`.  It fits the FSRS dynamics
 * parameters from **synthetic** review sequences, reports bootstrap intervals
 * and an applicability statement, and only ever produces a parameter
 * *candidate*:
 *
 *   synthetic data -> fit -> candidate -> isolated evaluation ->
 *   explicit host approval -> activation (a frozen configuration object)
 *
 * Hard rules:
 * - no twin / mastery / memory-state write path exists in this file;
 * - a run is reproducible from (seed, dataVersion, parameterVersion) plus the
 *   frozen optimizer configuration; the bootstrap uses the shared
 *   `mulberry32` PRNG;
 * - simulated held-out benefit is `isCausalEvidence: false`; promotion to an
 *   activated set additionally needs trusted, unseen real-transfer evidence;
 * - the activation gate is host-side, default-deny, and never lets a
 *   candidate approve or activate itself.
 *
 * The numeric model keeps the spec 8.3 illustrative curve
 * `R = (1 + 19/81 * t / S_eff)^(-1/2)` with a difficulty-modulated effective
 * stability, and uses only `+ - * / sqrt` inside the fit so the Python and
 * TypeScript results match byte for byte on the shared fixture.
 *
 * All data is synthetic.  No filesystem, network, database, or real student
 * data is touched.
 */

import { contentHash } from './curriculum-graph.ts'
import { AehError } from '../domain.ts'
import {
  CandidateRegistry,
  EvolutionAuditLog,
  HOST_ROLES,
  isHostActor,
  type Actor,
  type ApprovalRecord,
  type Candidate,
} from '../host/evolution.ts'

// ---------------------------------------------------------------------------
// Versions and controlled vocabularies
// ---------------------------------------------------------------------------

export const CALIBRATION_SCHEMA_VERSION = 'aeh.fsrs.calibration.v1'
export const GENERATOR_VERSION = 'aeh.fsrs.synthetic.v1'
export const DEFAULT_DATA_VERSION = 'synthetic.fsrs.calibration.v1'
export const DEFAULT_PARAMETER_VERSION = 'fsrs_calibrated_aeh_v1'
export const BASELINE_PARAMETER_VERSION = 'fsrs_illustrative_19_81'

export const FSRS_19_81 = 19 / 81
export const FSRS_81_19 = 81 / 19
export const MIN_STABILITY_DAYS = 0.4
export const DIFFICULTY_MIN = 1
export const DIFFICULTY_MAX = 10
export const DIFFICULTY_REFERENCE = 5
export const ECE_BINS = 10
export const IDENTIFIABILITY_CI_RATIO = 0.5

/** Fixed parameter order; both implementations iterate exactly this order. */
export const PARAMETER_NAMES = Object.freeze([
  'initial_stability_days',
  'success_growth',
  'failure_shrink',
  'initial_difficulty',
  'difficulty_success_delta',
  'difficulty_failure_delta',
] as const)
export type ParameterName = (typeof PARAMETER_NAMES)[number]

const PARAMETER_BOUNDS_VALUES = Object.freeze([
  [0.2, 20.0],
  [0.05, 2.0],
  [0.05, 0.9],
  [1.0, 10.0],
  [0.0, 1.0],
  [0.0, 2.0],
])

const PARAMETER_PRIOR_VALUES = Object.freeze([1.0, 0.6, 0.4, 5.0, 0.2, 0.5])
const PARAMETER_SCALE_VALUES = Object.freeze(
  PARAMETER_BOUNDS_VALUES.map(([lower, upper]) => upper - lower),
)

/** Sources that may contribute independently observed real-transfer evidence. */
export const TRUSTED_REAL_SOURCES = Object.freeze([
  'student',
  'teacher',
  'trusted_grader',
  'assessment',
] as const)

export const STATUS_REGISTERED = 'registered'
export const STATUS_EVALUATED = 'evaluated'
export const STATUS_REJECTED = 'rejected'
export const STATUS_APPROVED = 'approved'
export const STATUS_ACTIVATED = 'activated'
export const STATUS_ROLLED_BACK = 'rolled_back'

export const ACTION_CALIBRATION_REGISTERED = 'calibration.registered'
export const ACTION_CALIBRATION_EVALUATED = 'calibration.evaluated'
export const ACTION_CALIBRATION_REJECTED = 'calibration.rejected'
export const ACTION_CALIBRATION_APPROVED = 'calibration.approved'
export const ACTION_CALIBRATION_ACTIVATED = 'calibration.activated'
export const ACTION_CALIBRATION_ROLLED_BACK = 'calibration.rolled_back'

/** This module never mutates production; activation is a recorded decision. */
export const PRODUCTION_MUTATION_ENABLED = false
export const SYNTHETIC_FIXTURES_ONLY = true

export const CALIBRATION_IMPACT_SCOPES = Object.freeze([
  'review_scheduling',
  'simulation_parameters',
] as const)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CalibrationError extends AehError {}
export class CalibrationValidationError extends CalibrationError {}
export class CalibrationDeniedError extends CalibrationError {}

// ---------------------------------------------------------------------------
// Deterministic primitives shared with the Python mirror
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** JavaScript `Math.round` semantics (ties round toward +infinity). */
export function jsRound(value: number): number {
  return Math.floor(value + 0.5)
}

/** Quantise to four decimals so Python/TS JSON stays byte-identical. */
export function round4(value: number): number {
  return jsRound(value * 10000) / 10000
}

/** Integer micro-units used inside content-addressed fingerprints. */
export function quantizeMicros(value: number): number {
  return jsRound(value * 1_000_000)
}

/** A tiny deterministic PRNG mirrored exactly in Python. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), 1 | t) >>> 0
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), 61 | t))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function finite(value: unknown, field: string): number {
  if (!isFiniteNumber(value)) {
    throw new CalibrationValidationError(`${field} must be a finite number`)
  }
  return value
}

function assertOpaque(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new CalibrationValidationError(`${field} must be a short opaque reference`)
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new CalibrationValidationError(`${field} must be a short opaque reference`)
  }
  return value
}

function assertShortText(value: unknown, field: string, maxLength = 240): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new CalibrationValidationError(`${field} must be a short single-line string`)
  }
  return value
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CalibrationValidationError(`${field} must be a positive integer`)
  }
  return value
}

function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CalibrationValidationError(`${field} must be a non-negative integer`)
  }
  return value
}

function clamp(value: number, lower: number, upper: number): number {
  if (value < lower) return lower
  if (value > upper) return upper
  return value
}

/** Linear-interpolation percentile over an already sorted array. */
export function percentile(sortedValues: readonly number[], quantile: number): number {
  const count = sortedValues.length
  if (count === 0) {
    throw new CalibrationValidationError('percentile requires at least one value')
  }
  if (count === 1) return sortedValues[0]
  const position = quantile * (count - 1)
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex]
  const fraction = position - lowerIndex
  const lowerValue = sortedValues[lowerIndex]
  const upperValue = sortedValues[upperIndex]
  return lowerValue * (1 - fraction) + upperValue * fraction
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Synthetic review data
// ---------------------------------------------------------------------------

export class ReviewEvent {
  readonly elapsedDays: number
  readonly success: boolean
  readonly weight: number

  constructor(elapsedDays: number, success: boolean, weight = 1.0) {
    this.elapsedDays = finite(elapsedDays, 'elapsedDays')
    if (this.elapsedDays < 0) {
      throw new CalibrationValidationError('elapsedDays must be >= 0')
    }
    if (typeof success !== 'boolean') {
      throw new CalibrationValidationError('success must be a boolean')
    }
    this.success = success
    this.weight = finite(weight, 'weight')
    if (this.weight < 0 || this.weight > 1) {
      throw new CalibrationValidationError('weight must be within [0, 1]')
    }
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      elapsedDays: round4(this.elapsedDays),
      success: this.success,
      weight: round4(this.weight),
    }
  }
}

export class ReviewSequence {
  readonly sequenceId: string
  readonly scope: string
  readonly events: readonly ReviewEvent[]

  constructor(sequenceId: string, scope: string, events: readonly ReviewEvent[]) {
    this.sequenceId = assertOpaque(sequenceId, 'sequenceId')
    this.scope = assertShortText(scope, 'scope', 120)
    if (!Array.isArray(events) || events.length === 0) {
      throw new CalibrationValidationError('a sequence needs at least one event')
    }
    for (const event of events) {
      if (!(event instanceof ReviewEvent)) {
        throw new CalibrationValidationError('events must be ReviewEvent')
      }
    }
    this.events = Object.freeze([...events])
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      sequenceId: this.sequenceId,
      scope: this.scope,
      events: this.events.map((event) => event.asDict()),
    }
  }
}

export class CalibrationDataset {
  readonly datasetId: string
  readonly dataVersion: string
  readonly generatorVersion: string
  readonly scope: string
  readonly sequences: readonly ReviewSequence[]

  constructor(input: {
    readonly datasetId: string
    readonly dataVersion: string
    readonly generatorVersion: string
    readonly scope: string
    readonly sequences: readonly ReviewSequence[]
  }) {
    this.datasetId = assertOpaque(input.datasetId, 'datasetId')
    this.dataVersion = assertShortText(input.dataVersion, 'dataVersion', 120)
    this.generatorVersion = assertShortText(
      input.generatorVersion,
      'generatorVersion',
      120,
    )
    this.scope = assertShortText(input.scope, 'scope', 120)
    const sequences = input.sequences
    if (!Array.isArray(sequences) || sequences.length === 0) {
      throw new CalibrationValidationError('a dataset needs at least one sequence')
    }
    const seen = new Set<string>()
    for (const sequence of sequences) {
      if (!(sequence instanceof ReviewSequence)) {
        throw new CalibrationValidationError('sequences must be ReviewSequence')
      }
      if (seen.has(sequence.sequenceId)) {
        throw new CalibrationValidationError(
          `duplicate sequence id: ${sequence.sequenceId}`,
        )
      }
      seen.add(sequence.sequenceId)
    }
    this.sequences = Object.freeze([...sequences])
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      datasetId: this.datasetId,
      dataVersion: this.dataVersion,
      generatorVersion: this.generatorVersion,
      scope: this.scope,
      sequences: this.sequences.map((sequence) => sequence.asDict()),
    }
  }

  digest(): string {
    return contentHash(this.asDict())
  }

  observationCount(): number {
    return this.sequences.reduce(
      (total, sequence) => total + sequence.events.length,
      0,
    )
  }

  summary(): Record<string, unknown> {
    return {
      datasetId: this.datasetId,
      dataVersion: this.dataVersion,
      generatorVersion: this.generatorVersion,
      scope: this.scope,
      sequenceCount: this.sequences.length,
      observationCount: this.observationCount(),
      digest: this.digest(),
    }
  }
}

// ---------------------------------------------------------------------------
// Fitted parameter vector and the deterministic model
// ---------------------------------------------------------------------------

function predictSequenceValues(
  values: readonly number[],
  sequence: ReviewSequence,
): number[] {
  let stability = values[0]
  let difficulty = values[3]
  const successGrowth = values[1]
  const failureShrink = values[2]
  const difficultySuccessDelta = values[4]
  const difficultyFailureDelta = values[5]
  const predictions: number[] = []
  for (const event of sequence.events) {
    const factor =
      (DIFFICULTY_MAX - difficulty) / (DIFFICULTY_MAX - DIFFICULTY_REFERENCE)
    let effective = stability * factor
    if (effective < MIN_STABILITY_DAYS) effective = MIN_STABILITY_DAYS
    const predicted = 1 / Math.sqrt(1 + (FSRS_19_81 * event.elapsedDays) / effective)
    predictions.push(predicted)

    const weight = event.weight
    if (weight > 0) {
      if (event.success) {
        stability = stability * (1 + successGrowth * weight)
        difficulty = difficulty - difficultySuccessDelta * weight
        if (difficulty < DIFFICULTY_MIN) difficulty = DIFFICULTY_MIN
      } else {
        stability = stability * (1 - failureShrink * weight)
        if (stability < MIN_STABILITY_DAYS) stability = MIN_STABILITY_DAYS
        difficulty = difficulty + difficultyFailureDelta * weight
        if (difficulty > DIFFICULTY_MAX) difficulty = DIFFICULTY_MAX
      }
    }
  }
  return predictions
}

export class FSRSParameters {
  readonly parameterVersion: string
  private readonly v: readonly number[]

  constructor(values: readonly number[], parameterVersion = DEFAULT_PARAMETER_VERSION) {
    if (!Array.isArray(values) || values.length !== PARAMETER_NAMES.length) {
      throw new CalibrationValidationError(
        `expected ${PARAMETER_NAMES.length} parameter values`,
      )
    }
    const checked: number[] = []
    PARAMETER_NAMES.forEach((name, index) => {
      const value = finite(values[index], name)
      const [lower, upper] = PARAMETER_BOUNDS_VALUES[index]
      if (value < lower || value > upper) {
        throw new CalibrationValidationError(
          `${name} must be within [${lower}, ${upper}]`,
        )
      }
      checked.push(value)
    })
    this.parameterVersion = assertShortText(parameterVersion, 'parameterVersion', 120)
    this.v = Object.freeze(checked)
    Object.freeze(this)
  }

  static baseline(): FSRSParameters {
    return new FSRSParameters(PARAMETER_PRIOR_VALUES, BASELINE_PARAMETER_VERSION)
  }

  static fromValues(
    values: readonly number[],
    parameterVersion = DEFAULT_PARAMETER_VERSION,
  ): FSRSParameters {
    return new FSRSParameters(values, parameterVersion)
  }

  static fromDict(data: Readonly<Record<string, unknown>>): FSRSParameters {
    if (typeof data !== 'object' || data === null) {
      throw new CalibrationValidationError('parameters must be a mapping')
    }
    const values = PARAMETER_NAMES.map((name) => {
      if (!(name in data)) {
        throw new CalibrationValidationError(`parameters missing: ${name}`)
      }
      return finite(data[name], name)
    })
    const version =
      typeof data.parameter_version === 'string'
        ? data.parameter_version
        : DEFAULT_PARAMETER_VERSION
    return new FSRSParameters(values, version)
  }

  get initialStabilityDays(): number {
    return this.v[0]
  }

  get successGrowth(): number {
    return this.v[1]
  }

  get failureShrink(): number {
    return this.v[2]
  }

  get initialDifficulty(): number {
    return this.v[3]
  }

  get difficultySuccessDelta(): number {
    return this.v[4]
  }

  get difficultyFailureDelta(): number {
    return this.v[5]
  }

  values(): readonly number[] {
    return this.v
  }

  valueDict(): Record<ParameterName, number> {
    return {
      initial_stability_days: this.v[0],
      success_growth: this.v[1],
      failure_shrink: this.v[2],
      initial_difficulty: this.v[3],
      difficulty_success_delta: this.v[4],
      difficulty_failure_delta: this.v[5],
    }
  }

  quantizedDict(): Record<ParameterName, number> {
    const result = this.valueDict()
    return Object.freeze({
      initial_stability_days: round4(result.initial_stability_days),
      success_growth: round4(result.success_growth),
      failure_shrink: round4(result.failure_shrink),
      initial_difficulty: round4(result.initial_difficulty),
      difficulty_success_delta: round4(result.difficulty_success_delta),
      difficulty_failure_delta: round4(result.difficulty_failure_delta),
    })
  }

  asDict(): Record<string, unknown> {
    return { ...this.quantizedDict(), parameter_version: this.parameterVersion }
  }

  difficultyFactor(difficulty: number): number {
    return (DIFFICULTY_MAX - difficulty) / (DIFFICULTY_MAX - DIFFICULTY_REFERENCE)
  }

  effectiveStability(stability: number, difficulty: number): number {
    const effective = stability * this.difficultyFactor(difficulty)
    return effective > MIN_STABILITY_DAYS ? effective : MIN_STABILITY_DAYS
  }

  predict(elapsedDays: number, stability: number, difficulty: number): number {
    const effective = this.effectiveStability(stability, difficulty)
    return 1 / Math.sqrt(1 + (FSRS_19_81 * elapsedDays) / effective)
  }

  update(
    stability: number,
    difficulty: number,
    success: boolean,
    weight: number,
  ): readonly [number, number] {
    if (weight <= 0) return [stability, difficulty]
    if (success) {
      stability = stability * (1 + this.successGrowth * weight)
      difficulty = difficulty - this.difficultySuccessDelta * weight
      if (difficulty < DIFFICULTY_MIN) difficulty = DIFFICULTY_MIN
    } else {
      stability = stability * (1 - this.failureShrink * weight)
      if (stability < MIN_STABILITY_DAYS) stability = MIN_STABILITY_DAYS
      difficulty = difficulty + this.difficultyFailureDelta * weight
      if (difficulty > DIFFICULTY_MAX) difficulty = DIFFICULTY_MAX
    }
    return [stability, difficulty]
  }

  predictSequence(sequence: ReviewSequence): readonly number[] {
    return Object.freeze(predictSequenceValues(this.v, sequence))
  }

  brierScore(sequences: readonly ReviewSequence[]): number {
    return brierScore(this.v, sequences)
  }
}

// ---------------------------------------------------------------------------
// Objective and deterministic optimizer
// ---------------------------------------------------------------------------

function brierScore(
  values: readonly number[],
  sequences: readonly ReviewSequence[],
): number {
  if (sequences.length === 0) {
    throw new CalibrationValidationError('brier score needs at least one sequence')
  }
  let total = 0
  let count = 0
  for (const sequence of sequences) {
    const predictions = predictSequenceValues(values, sequence)
    sequence.events.forEach((event, index) => {
      const target = event.success ? 1 : 0
      const difference = predictions[index] - target
      total += difference * difference
      count += 1
    })
  }
  return total / count
}

function objective(
  values: readonly number[],
  sequences: readonly ReviewSequence[],
  ridge: number,
): readonly [number, number] {
  const brier = brierScore(values, sequences)
  let penalty = 0
  PARAMETER_NAMES.forEach((_name, index) => {
    const scale = PARAMETER_SCALE_VALUES[index]
    const z = (values[index] - PARAMETER_PRIOR_VALUES[index]) / scale
    penalty += z * z
  })
  penalty = (ridge * penalty) / PARAMETER_NAMES.length
  return [brier + penalty, brier]
}

function startingPoints(): readonly (readonly number[])[] {
  const prior = [...PARAMETER_PRIOR_VALUES]
  const midpoint = PARAMETER_BOUNDS_VALUES.map(([lower, upper]) => (lower + upper) / 2)
  const lowerQuarter = PARAMETER_BOUNDS_VALUES.map(
    ([lower, upper]) => lower + (upper - lower) * 0.25,
  )
  const upperQuarter = PARAMETER_BOUNDS_VALUES.map(
    ([lower, upper]) => lower + (upper - lower) * 0.75,
  )
  return [prior, midpoint, lowerQuarter, upperQuarter]
}

function descend(
  sequences: readonly ReviewSequence[],
  config: CalibrationConfig,
  start: readonly number[],
): readonly [number[], number, number] {
  let values = [...start]
  let steps = PARAMETER_BOUNDS_VALUES.map(
    ([lower, upper]) => (upper - lower) * config.stepFraction,
  )
  let currentObjective = objective(values, sequences, config.ridge)[0]
  for (let round = 0; round < config.rounds; round += 1) {
    for (let index = 0; index < PARAMETER_NAMES.length; index += 1) {
      const [lower, upper] = PARAMETER_BOUNDS_VALUES[index]
      for (const direction of [-1, 1]) {
        const trial = [...values]
        trial[index] = clamp(values[index] + direction * steps[index], lower, upper)
        const trialObjective = objective(trial, sequences, config.ridge)[0]
        if (trialObjective < currentObjective) {
          values = trial
          currentObjective = trialObjective
        }
      }
    }
    steps = steps.map((step) => step * 0.5)
  }
  const [finalObjective, finalBrier] = objective(values, sequences, config.ridge)
  return [values, finalObjective, finalBrier]
}

function fitParameters(
  sequences: readonly ReviewSequence[],
  config: CalibrationConfig,
): readonly [number[], number, number] {
  let bestValues: number[] | null = null
  let bestObjective = Number.POSITIVE_INFINITY
  let bestBrier = Number.POSITIVE_INFINITY
  for (const start of startingPoints()) {
    const [values, valueObjective, valueBrier] = descend(sequences, config, start)
    if (valueObjective < bestObjective) {
      bestValues = values
      bestObjective = valueObjective
      bestBrier = valueBrier
    }
  }
  if (bestValues === null) {
    throw new CalibrationError('fit failed to produce a parameter vector')
  }
  return [bestValues, bestObjective, bestBrier]
}

export class CalibrationConfig {
  readonly seed: number
  readonly dataVersion: string
  readonly parameterVersion: string
  readonly rounds: number
  readonly stepFraction: number
  readonly bootstrapResamples: number
  readonly ridge: number
  readonly confidence: number
  readonly minSequences: number
  readonly minObservations: number

  constructor(input: {
    readonly seed?: number
    readonly dataVersion?: string
    readonly parameterVersion?: string
    readonly rounds?: number
    readonly stepFraction?: number
    readonly bootstrapResamples?: number
    readonly ridge?: number
    readonly confidence?: number
    readonly minSequences?: number
    readonly minObservations?: number
  } = {}) {
    const seed = assertNonNegativeInt(input.seed ?? 20240607, 'seed')
    if (seed > 0xffffffff) {
      throw new CalibrationValidationError('seed must be within uint32')
    }
    this.seed = seed
    this.dataVersion = assertShortText(
      input.dataVersion ?? DEFAULT_DATA_VERSION,
      'dataVersion',
      120,
    )
    this.parameterVersion = assertShortText(
      input.parameterVersion ?? DEFAULT_PARAMETER_VERSION,
      'parameterVersion',
      120,
    )
    this.rounds = assertPositiveInt(input.rounds ?? 4, 'rounds')
    const stepFraction = finite(input.stepFraction ?? 0.25, 'stepFraction')
    if (stepFraction <= 0 || stepFraction >= 1) {
      throw new CalibrationValidationError('stepFraction must be within (0, 1)')
    }
    this.stepFraction = stepFraction
    this.bootstrapResamples = assertPositiveInt(
      input.bootstrapResamples ?? 32,
      'bootstrapResamples',
    )
    const ridge = finite(input.ridge ?? 0.002, 'ridge')
    if (ridge < 0) {
      throw new CalibrationValidationError('ridge must be >= 0')
    }
    this.ridge = ridge
    const confidence = finite(input.confidence ?? 0.95, 'confidence')
    if (confidence <= 0.5 || confidence >= 1) {
      throw new CalibrationValidationError('confidence must be within (0.5, 1)')
    }
    this.confidence = confidence
    this.minSequences = assertPositiveInt(input.minSequences ?? 3, 'minSequences')
    this.minObservations = assertPositiveInt(
      input.minObservations ?? 20,
      'minObservations',
    )
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      seed: this.seed,
      dataVersion: this.dataVersion,
      parameterVersion: this.parameterVersion,
      rounds: this.rounds,
      stepFraction: round4(this.stepFraction),
      bootstrapResamples: this.bootstrapResamples,
      ridge: round4(this.ridge),
      confidence: round4(this.confidence),
      minSequences: this.minSequences,
      minObservations: this.minObservations,
    }
  }

  fingerprint(): string {
    return contentHash(this.asDict())
  }
}

// ---------------------------------------------------------------------------
// Report structures
// ---------------------------------------------------------------------------

export class ParameterEstimate {
  readonly name: ParameterName
  readonly point: number
  readonly ciLow: number
  readonly ciHigh: number
  readonly prior: number
  readonly lower: number
  readonly upper: number

  constructor(input: {
    readonly name: ParameterName
    readonly point: number
    readonly ciLow: number
    readonly ciHigh: number
    readonly prior: number
    readonly lower: number
    readonly upper: number
  }) {
    if (!(PARAMETER_NAMES as readonly string[]).includes(input.name)) {
      throw new CalibrationValidationError(`unknown parameter ${input.name}`)
    }
    this.name = input.name
    this.point = input.point
    this.ciLow = input.ciLow
    this.ciHigh = input.ciHigh
    this.prior = input.prior
    this.lower = input.lower
    this.upper = input.upper
    Object.freeze(this)
  }

  ciWidth(): number {
    return this.ciHigh - this.ciLow
  }

  scale(): number {
    return this.upper - this.lower
  }

  identified(): boolean {
    return this.ciWidth() <= IDENTIFIABILITY_CI_RATIO * this.scale()
  }

  asDict(): Record<string, unknown> {
    return {
      name: this.name,
      point: round4(this.point),
      ciLow: round4(this.ciLow),
      ciHigh: round4(this.ciHigh),
      prior: round4(this.prior),
      identified: this.identified(),
    }
  }
}

export class CalibrationMetrics {
  readonly brier: number
  readonly brierCiLow: number
  readonly brierCiHigh: number
  readonly ece: number
  readonly logLoss: number
  readonly reliabilityBins: readonly Readonly<{
    count: number
    meanPredicted: number
    meanObserved: number
  }>[]

  constructor(input: {
    readonly brier: number
    readonly brierCiLow: number
    readonly brierCiHigh: number
    readonly ece: number
    readonly logLoss: number
    readonly reliabilityBins: readonly Readonly<{
      count: number
      meanPredicted: number
      meanObserved: number
    }>[]
  }) {
    this.brier = input.brier
    this.brierCiLow = input.brierCiLow
    this.brierCiHigh = input.brierCiHigh
    this.ece = input.ece
    this.logLoss = input.logLoss
    this.reliabilityBins = input.reliabilityBins
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      brier: round4(this.brier),
      brierCiLow: round4(this.brierCiLow),
      brierCiHigh: round4(this.brierCiHigh),
      ece: round4(this.ece),
      logLoss: round4(this.logLoss),
      reliabilityBins: this.reliabilityBins.map((entry) => ({
        count: entry.count,
        meanPredicted: round4(entry.meanPredicted),
        meanObserved: round4(entry.meanObserved),
      })),
    }
  }
}

export class Applicability {
  readonly scope: string
  readonly sequenceCount: number
  readonly observationCount: number
  readonly elapsedDaysMin: number
  readonly elapsedDaysMax: number
  readonly independentObservations: number
  readonly hintedObservations: number
  readonly evidenceSufficient: boolean
  readonly conditions: readonly string[]
  readonly outOfScope: readonly string[]

  constructor(input: {
    readonly scope: string
    readonly sequenceCount: number
    readonly observationCount: number
    readonly elapsedDaysMin: number
    readonly elapsedDaysMax: number
    readonly independentObservations: number
    readonly hintedObservations: number
    readonly evidenceSufficient: boolean
    readonly conditions: readonly string[]
    readonly outOfScope: readonly string[]
  }) {
    this.scope = input.scope
    this.sequenceCount = input.sequenceCount
    this.observationCount = input.observationCount
    this.elapsedDaysMin = input.elapsedDaysMin
    this.elapsedDaysMax = input.elapsedDaysMax
    this.independentObservations = input.independentObservations
    this.hintedObservations = input.hintedObservations
    this.evidenceSufficient = input.evidenceSufficient
    this.conditions = Object.freeze([...input.conditions])
    this.outOfScope = Object.freeze([...input.outOfScope])
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      scope: this.scope,
      sequenceCount: this.sequenceCount,
      observationCount: this.observationCount,
      elapsedDaysMin: round4(this.elapsedDaysMin),
      elapsedDaysMax: round4(this.elapsedDaysMax),
      independentObservations: this.independentObservations,
      hintedObservations: this.hintedObservations,
      evidenceSufficient: this.evidenceSufficient,
      conditions: [...this.conditions],
      outOfScope: [...this.outOfScope],
    }
  }
}

export class CalibrationReport {
  readonly parameterVersion: string
  readonly dataVersion: string
  readonly seed: number
  readonly datasetDigest: string
  readonly configFingerprint: string
  readonly parameters: FSRSParameters
  readonly estimates: readonly ParameterEstimate[]
  readonly metrics: CalibrationMetrics
  readonly applicability: Applicability
  readonly sequenceCount: number
  readonly observationCount: number
  readonly evidenceSufficient: boolean
  readonly limitations: readonly string[]

  constructor(input: {
    readonly parameterVersion: string
    readonly dataVersion: string
    readonly seed: number
    readonly datasetDigest: string
    readonly configFingerprint: string
    readonly parameters: FSRSParameters
    readonly estimates: readonly ParameterEstimate[]
    readonly metrics: CalibrationMetrics
    readonly applicability: Applicability
    readonly sequenceCount: number
    readonly observationCount: number
    readonly evidenceSufficient: boolean
    readonly limitations?: readonly string[]
  }) {
    this.parameterVersion = input.parameterVersion
    this.dataVersion = input.dataVersion
    this.seed = input.seed
    this.datasetDigest = input.datasetDigest
    this.configFingerprint = input.configFingerprint
    this.parameters = input.parameters
    this.estimates = Object.freeze([...input.estimates])
    this.metrics = input.metrics
    this.applicability = input.applicability
    this.sequenceCount = input.sequenceCount
    this.observationCount = input.observationCount
    this.evidenceSufficient = input.evidenceSufficient
    this.limitations = Object.freeze([...(input.limitations ?? [])])
    Object.freeze(this)
  }

  estimate(name: ParameterName): ParameterEstimate {
    for (const estimate of this.estimates) {
      if (estimate.name === name) return estimate
    }
    throw new CalibrationValidationError(`unknown estimate ${name}`)
  }

  payload(): Record<string, unknown> {
    return {
      schema: CALIBRATION_SCHEMA_VERSION,
      parameterVersion: this.parameterVersion,
      dataVersion: this.dataVersion,
      seed: this.seed,
      datasetDigest: this.datasetDigest,
      configFingerprint: this.configFingerprint,
      parameters: this.parameters.quantizedDict(),
      estimates: this.estimates.map((estimate) => estimate.asDict()),
      metrics: this.metrics.asDict(),
      applicability: this.applicability.asDict(),
      sequenceCount: this.sequenceCount,
      observationCount: this.observationCount,
      evidenceSufficient: this.evidenceSufficient,
    }
  }

  fingerprint(): string {
    return contentHash(this.payload())
  }

  asDict(): Record<string, unknown> {
    return {
      ...this.payload(),
      reportFingerprint: this.fingerprint(),
      limitations: [...this.limitations],
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function reliabilityBins(
  values: readonly number[],
  sequences: readonly ReviewSequence[],
): readonly [
  readonly Readonly<{ count: number; meanPredicted: number; meanObserved: number }>[],
  number,
  number,
] {
  const counts = new Array<number>(ECE_BINS).fill(0)
  const sumPredicted = new Array<number>(ECE_BINS).fill(0)
  const sumObserved = new Array<number>(ECE_BINS).fill(0)
  let total = 0
  let logLoss = 0
  const epsilon = 1e-9
  for (const sequence of sequences) {
    const predictions = predictSequenceValues(values, sequence)
    sequence.events.forEach((event, index) => {
      const predicted = predictions[index]
      const observed = event.success ? 1 : 0
      let binIndex = Math.floor(predicted * ECE_BINS)
      if (binIndex < 0) binIndex = 0
      if (binIndex >= ECE_BINS) binIndex = ECE_BINS - 1
      counts[binIndex] += 1
      sumPredicted[binIndex] += predicted
      sumObserved[binIndex] += observed
      total += 1
      let clamped = predicted > epsilon ? predicted : epsilon
      if (clamped > 1 - epsilon) clamped = 1 - epsilon
      logLoss -= observed * Math.log(clamped) + (1 - observed) * Math.log(1 - clamped)
    })
  }

  let ece = 0
  const bins: Readonly<{
    count: number
    meanPredicted: number
    meanObserved: number
  }>[] = []
  for (let binIndex = 0; binIndex < ECE_BINS; binIndex += 1) {
    const count = counts[binIndex]
    if (count === 0) {
      bins.push(Object.freeze({ count: 0, meanPredicted: 0, meanObserved: 0 }))
      continue
    }
    const meanPredicted = sumPredicted[binIndex] / count
    const meanObserved = sumObserved[binIndex] / count
    const difference = meanPredicted - meanObserved
    ece += (count / total) * (difference >= 0 ? difference : -difference)
    bins.push(
      Object.freeze({ count, meanPredicted, meanObserved }),
    )
  }
  return [Object.freeze(bins), ece, logLoss / total]
}

// ---------------------------------------------------------------------------
// Calibration entry point
// ---------------------------------------------------------------------------

function bootstrap(
  sequences: readonly ReviewSequence[],
  config: CalibrationConfig,
): readonly [Record<ParameterName, number[]>, number[]] {
  const rng = mulberry32(config.seed)
  const count = sequences.length
  const samples: Record<ParameterName, number[]> = {
    initial_stability_days: [],
    success_growth: [],
    failure_shrink: [],
    initial_difficulty: [],
    difficulty_success_delta: [],
    difficulty_failure_delta: [],
  }
  const briers: number[] = []
  for (let iteration = 0; iteration < config.bootstrapResamples; iteration += 1) {
    const picks: ReviewSequence[] = []
    for (let index = 0; index < count; index += 1) {
      picks.push(sequences[Math.floor(rng() * count)])
    }
    const [values] = fitParameters(picks, config)
    PARAMETER_NAMES.forEach((name, index) => {
      samples[name].push(values[index])
    })
    briers.push(brierScore(values, picks))
  }
  return [samples, briers]
}

export function calibrate(
  dataset: CalibrationDataset,
  config?: CalibrationConfig,
): CalibrationReport {
  if (!(dataset instanceof CalibrationDataset)) {
    throw new CalibrationValidationError('dataset must be a CalibrationDataset')
  }
  const resolved = config ?? new CalibrationConfig()
  if (!(resolved instanceof CalibrationConfig)) {
    throw new CalibrationValidationError('config must be a CalibrationConfig')
  }
  if (resolved.dataVersion !== dataset.dataVersion) {
    throw new CalibrationValidationError(
      "config.dataVersion must match the dataset's dataVersion",
    )
  }

  const [values] = fitParameters(dataset.sequences, resolved)
  const parameters = FSRSParameters.fromValues(values, resolved.parameterVersion)
  const [bins, ece, logLoss] = reliabilityBins(
    parameters.values(),
    dataset.sequences,
  )
  const pointBrier = brierScore(parameters.values(), dataset.sequences)

  const [samples, brierSamples] = bootstrap(dataset.sequences, resolved)
  const alpha = (1 - resolved.confidence) / 2
  const estimates: ParameterEstimate[] = PARAMETER_NAMES.map((name, index) => {
    const sorted = sortedNumbers(samples[name])
    const [lower, upper] = PARAMETER_BOUNDS_VALUES[index]
    return new ParameterEstimate({
      name,
      point: parameters.valueDict()[name],
      ciLow: percentile(sorted, alpha),
      ciHigh: percentile(sorted, 1 - alpha),
      prior: PARAMETER_PRIOR_VALUES[index],
      lower,
      upper,
    })
  })
  const sortedBrier = sortedNumbers(brierSamples)
  const metrics = new CalibrationMetrics({
    brier: pointBrier,
    brierCiLow: percentile(sortedBrier, alpha),
    brierCiHigh: percentile(sortedBrier, 1 - alpha),
    ece,
    logLoss,
    reliabilityBins: bins,
  })

  const observationCount = dataset.observationCount()
  const elapsedValues = dataset.sequences.flatMap((sequence) =>
    sequence.events.map((event) => event.elapsedDays),
  )
  let independent = 0
  let hinted = 0
  for (const sequence of dataset.sequences) {
    for (const event of sequence.events) {
      if (event.weight >= 1) independent += 1
      else if (event.weight > 0) hinted += 1
    }
  }
  const evidenceSufficient =
    dataset.sequences.length >= resolved.minSequences &&
    observationCount >= resolved.minObservations
  const elapsedMin = Math.min(...elapsedValues)
  const elapsedMax = Math.max(...elapsedValues)
  const conditions = [
    'synthetic-only calibration; this is not a production calibration',
    `scope=${dataset.scope}`,
    `data_version=${dataset.dataVersion}`,
    `parameter_version=${resolved.parameterVersion}`,
    `elapsed_days within [${round4(elapsedMin)}, ${round4(elapsedMax)}]`,
  ]
  const outOfScope = [
    'real student scheduling or mastery until prospective, independently observed validation',
    'extrapolation beyond the observed elapsed-day range',
    'knowledge components outside the declared scope',
    'any change that lowers the curriculum/safety gate or writes observed twin state',
  ]
  const applicability = new Applicability({
    scope: dataset.scope,
    sequenceCount: dataset.sequences.length,
    observationCount,
    elapsedDaysMin: elapsedMin,
    elapsedDaysMax: elapsedMax,
    independentObservations: independent,
    hintedObservations: hinted,
    evidenceSufficient,
    conditions,
    outOfScope,
  })

  const weak = estimates.filter((estimate) => !estimate.identified()).map((e) => e.name)
  const limitations = [
    'synthetic review sequences only; no real student data is used',
    'the illustrative 19/81 retention curve and a linear difficulty term are fixed; only dynamics parameters are fit',
    'bootstrap intervals quantify resampling uncertainty, not model misspecification',
    `weakly identified parameters: ${weak.length > 0 ? weak.join(', ') : 'none'}`,
  ]

  return new CalibrationReport({
    parameterVersion: resolved.parameterVersion,
    dataVersion: dataset.dataVersion,
    seed: resolved.seed,
    datasetDigest: dataset.digest(),
    configFingerprint: resolved.fingerprint(),
    parameters,
    estimates,
    metrics,
    applicability,
    sequenceCount: dataset.sequences.length,
    observationCount,
    evidenceSufficient,
    limitations,
  })
}

// ---------------------------------------------------------------------------
// Synthetic data generator (deterministic; used by tests)
// ---------------------------------------------------------------------------

export function generateDataset(input: {
  readonly seed?: number
  readonly sequenceCount?: number
  readonly eventsPerSequence?: number
  readonly scope?: string
  readonly dataVersion?: string
  readonly datasetId?: string
  readonly independentProbability?: number
} = {}): CalibrationDataset {
  const seed = input.seed ?? 20240607
  const sequenceCount = assertPositiveInt(
    input.sequenceCount ?? 8,
    'sequenceCount',
  )
  const eventsPerSequence = assertPositiveInt(
    input.eventsPerSequence ?? 4,
    'eventsPerSequence',
  )
  const probability = finite(
    input.independentProbability ?? 0.7,
    'independentProbability',
  )
  if (probability < 0 || probability > 1) {
    throw new CalibrationValidationError(
      'independentProbability must be within [0, 1]',
    )
  }
  const scope = input.scope ?? 'synthetic.mathematics.secondary'
  const dataVersion = input.dataVersion ?? DEFAULT_DATA_VERSION
  const datasetId = input.datasetId ?? 'dataset.synthetic.fsrs.calibration'

  const rng = mulberry32(seed)
  const latent = new FSRSParameters(
    [6.0, 1.4, 0.15, 8.0, 0.7, 1.2],
    'latent.synthetic.v1',
  )
  const sequences: ReviewSequence[] = []
  for (let sequenceIndex = 0; sequenceIndex < sequenceCount; sequenceIndex += 1) {
    let stability = latent.initialStabilityDays * (0.8 + 0.4 * rng())
    let difficulty = latent.initialDifficulty + (rng() - 0.5) * 1.5
    if (difficulty < DIFFICULTY_MIN) difficulty = DIFFICULTY_MIN
    if (difficulty > DIFFICULTY_MAX) difficulty = DIFFICULTY_MAX
    const events: ReviewEvent[] = []
    for (let eventIndex = 0; eventIndex < eventsPerSequence; eventIndex += 1) {
      const elapsed = 0.5 + 14 * rng()
      const independent = rng() < probability
      const weight = independent ? 1 : 0.3
      let effective = stability * latent.difficultyFactor(difficulty)
      if (effective < MIN_STABILITY_DAYS) effective = MIN_STABILITY_DAYS
      const predicted = 1 / Math.sqrt(1 + (FSRS_19_81 * elapsed) / effective)
      const success = rng() < predicted
      events.push(new ReviewEvent(round4(elapsed), success, weight))
      const [nextStability, nextDifficulty] = latent.update(
        stability,
        difficulty,
        success,
        weight,
      )
      stability = nextStability
      difficulty = nextDifficulty
    }
    sequences.push(
      new ReviewSequence(
        `seq.synthetic.${String(sequenceIndex).padStart(4, '0')}`,
        scope,
        events,
      ),
    )
  }
  return new CalibrationDataset({
    datasetId,
    dataVersion,
    generatorVersion: GENERATOR_VERSION,
    scope,
    sequences,
  })
}

function pick(mapping: Readonly<Record<string, unknown>>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in mapping) return mapping[key]
  }
  throw new CalibrationValidationError(`missing key; expected one of ${keys.join(', ')}`)
}

export function datasetFromDict(
  data: Readonly<Record<string, unknown>>,
): CalibrationDataset {
  const rawSequences = pick(data, 'sequences')
  if (!Array.isArray(rawSequences)) {
    throw new CalibrationValidationError('sequences must be an array')
  }
  const sequences = rawSequences.map((rawSequence) => {
    const mapping = rawSequence as Readonly<Record<string, unknown>>
    const rawEvents = pick(mapping, 'events')
    if (!Array.isArray(rawEvents)) {
      throw new CalibrationValidationError('events must be an array')
    }
    const events = rawEvents.map((rawEvent) => {
      const event = rawEvent as Readonly<Record<string, unknown>>
      return new ReviewEvent(
        finite(pick(event, 'elapsedDays', 'elapsed_days'), 'elapsedDays'),
        pick(event, 'success') as boolean,
        finite(pick(event, 'weight'), 'weight'),
      )
    })
    return new ReviewSequence(
      String(pick(mapping, 'sequenceId', 'sequence_id')),
      String(pick(mapping, 'scope')),
      events,
    )
  })
  return new CalibrationDataset({
    datasetId: String(pick(data, 'datasetId', 'dataset_id')),
    dataVersion: String(pick(data, 'dataVersion', 'data_version')),
    generatorVersion: String(pick(data, 'generatorVersion', 'generator_version')),
    scope: String(pick(data, 'scope')),
    sequences,
  })
}

// ---------------------------------------------------------------------------
// Candidate generation (control plane: no production mutation)
// ---------------------------------------------------------------------------

export function parametersFromCandidate(candidate: Candidate): FSRSParameters {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new CalibrationValidationError('expected an evolution Candidate')
  }
  const raw = candidate.changes.parameters
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CalibrationValidationError(
      "candidate changes must contain a 'parameters' mapping",
    )
  }
  const data: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  const version = candidate.changes.parameter_version
  if (typeof version === 'string') data.parameter_version = version
  return FSRSParameters.fromDict(data)
}

export interface CalibrationCandidateBundle {
  readonly report: CalibrationReport
  readonly candidate: Candidate
}

export class CalibrationService {
  readonly dataset: CalibrationDataset
  readonly config: CalibrationConfig

  constructor(dataset: CalibrationDataset, config?: CalibrationConfig) {
    if (!(dataset instanceof CalibrationDataset)) {
      throw new CalibrationValidationError('dataset must be a CalibrationDataset')
    }
    this.dataset = dataset
    this.config = config ?? new CalibrationConfig()
    Object.freeze(this)
  }

  calibrate(): CalibrationReport {
    return calibrate(this.dataset, this.config)
  }

  proposeCandidate(input: {
    readonly report: CalibrationReport
    readonly author: string
    readonly createdAt: string
  }): Candidate {
    const { report, author, createdAt } = input
    if (!(report instanceof CalibrationReport)) {
      throw new CalibrationValidationError('report must be a CalibrationReport')
    }
    if (report.parameterVersion !== this.config.parameterVersion) {
      throw new CalibrationValidationError(
        'report parameterVersion must match the service config',
      )
    }
    return {
      candidateId: `fsrs.calibration.${report.parameterVersion}`,
      version: report.parameterVersion,
      kind: 'config',
      source: 'human_request',
      changeSummary:
        'calibrated FSRS dynamics parameters from synthetic review sequences; ' +
        'requires isolated evaluation and explicit host approval',
      impactScope: [...CALIBRATION_IMPACT_SCOPES],
      baselineVersion: BASELINE_PARAMETER_VERSION,
      changes: {
        parameter_version: report.parameterVersion,
        data_version: report.dataVersion,
        dataset_digest: report.datasetDigest,
        report_fingerprint: report.fingerprint(),
        parameters: report.parameters.quantizedDict(),
      },
      createdAt,
      author,
    }
  }
}

// ---------------------------------------------------------------------------
// Isolated evaluation and explicit approval gate
// ---------------------------------------------------------------------------

export class CalibrationApprovalPolicy {
  readonly minHeldOutSequences: number
  readonly minHeldOutObservations: number
  readonly minBrierImprovement: number
  readonly minRealTransferItems: number
  readonly minRealTransferDelta: number

  constructor(input: {
    readonly minHeldOutSequences?: number
    readonly minHeldOutObservations?: number
    readonly minBrierImprovement?: number
    readonly minRealTransferItems?: number
    readonly minRealTransferDelta?: number
  } = {}) {
    this.minHeldOutSequences = assertPositiveInt(
      input.minHeldOutSequences ?? 2,
      'minHeldOutSequences',
    )
    this.minHeldOutObservations = assertPositiveInt(
      input.minHeldOutObservations ?? 10,
      'minHeldOutObservations',
    )
    this.minBrierImprovement = finite(
      input.minBrierImprovement ?? 0,
      'minBrierImprovement',
    )
    this.minRealTransferItems = assertPositiveInt(
      input.minRealTransferItems ?? 2,
      'minRealTransferItems',
    )
    this.minRealTransferDelta = finite(
      input.minRealTransferDelta ?? 0,
      'minRealTransferDelta',
    )
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      minHeldOutSequences: this.minHeldOutSequences,
      minHeldOutObservations: this.minHeldOutObservations,
      minBrierImprovement: round4(this.minBrierImprovement),
      minRealTransferItems: this.minRealTransferItems,
      minRealTransferDelta: round4(this.minRealTransferDelta),
    }
  }
}

export class RealTransferEvidence {
  readonly source: string
  readonly itemCount: number
  readonly observedDelta: number
  readonly allItemsUnseen: boolean

  constructor(input: {
    readonly source: string
    readonly itemCount: number
    readonly observedDelta: number
    readonly allItemsUnseen: boolean
  }) {
    if (!(TRUSTED_REAL_SOURCES as readonly string[]).includes(input.source)) {
      throw new CalibrationValidationError(
        `real transfer source ${input.source} is not trusted`,
      )
    }
    this.source = input.source
    this.itemCount = assertNonNegativeInt(input.itemCount, 'itemCount')
    this.observedDelta = finite(input.observedDelta, 'observedDelta')
    if (typeof input.allItemsUnseen !== 'boolean') {
      throw new CalibrationValidationError('allItemsUnseen must be a boolean')
    }
    this.allItemsUnseen = input.allItemsUnseen
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      source: this.source,
      itemCount: this.itemCount,
      observedDelta: round4(this.observedDelta),
      allItemsUnseen: this.allItemsUnseen,
    }
  }
}

export class CalibrationEvaluation {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly heldOutDigest: string
  readonly simulatedBenefit: Readonly<Record<string, unknown>> | null
  readonly realTransfer: Readonly<Record<string, unknown>> | null
  readonly screeningPassed: boolean
  readonly promotionReady: boolean
  readonly evidenceSufficient: boolean
  readonly reasons: readonly string[]
  readonly isolationChecks: readonly string[]
  readonly limitations: readonly string[]
  readonly evaluatedAt: string

  constructor(input: {
    readonly candidateId: string
    readonly candidateVersion: string
    readonly heldOutDigest: string
    readonly simulatedBenefit: Readonly<Record<string, unknown>> | null
    readonly realTransfer: Readonly<Record<string, unknown>> | null
    readonly screeningPassed: boolean
    readonly promotionReady: boolean
    readonly evidenceSufficient: boolean
    readonly reasons: readonly string[]
    readonly isolationChecks: readonly string[]
    readonly limitations: readonly string[]
    readonly evaluatedAt: string
  }) {
    if (
      input.simulatedBenefit !== null &&
      input.simulatedBenefit.isCausalEvidence !== false
    ) {
      throw new CalibrationValidationError(
        'simulated benefit must never be causal evidence',
      )
    }
    if (input.realTransfer !== null && input.realTransfer.isCausalEvidence !== false) {
      throw new CalibrationValidationError(
        'real transfer evidence is descriptive, not causal',
      )
    }
    if (input.promotionReady && !input.screeningPassed) {
      throw new CalibrationValidationError(
        'promotion requires a passed screening stage',
      )
    }
    this.candidateId = input.candidateId
    this.candidateVersion = input.candidateVersion
    this.heldOutDigest = input.heldOutDigest
    this.simulatedBenefit = input.simulatedBenefit
    this.realTransfer = input.realTransfer
    this.screeningPassed = input.screeningPassed
    this.promotionReady = input.promotionReady
    this.evidenceSufficient = input.evidenceSufficient
    this.reasons = Object.freeze([...input.reasons])
    this.isolationChecks = Object.freeze([...input.isolationChecks])
    this.limitations = Object.freeze([...input.limitations])
    this.evaluatedAt = input.evaluatedAt
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      candidateId: this.candidateId,
      candidateVersion: this.candidateVersion,
      heldOutDigest: this.heldOutDigest,
      simulatedBenefit: this.simulatedBenefit,
      realTransfer: this.realTransfer,
      screeningPassed: this.screeningPassed,
      promotionReady: this.promotionReady,
      evidenceSufficient: this.evidenceSufficient,
      reasons: [...this.reasons],
      isolationChecks: [...this.isolationChecks],
      limitations: [...this.limitations],
      evaluatedAt: this.evaluatedAt,
    }
  }
}

export function evaluateCandidate(input: {
  readonly candidate: Candidate
  readonly heldOut: CalibrationDataset
  readonly policy?: CalibrationApprovalPolicy
  readonly realEvidence?: RealTransferEvidence
  readonly evaluatedAt?: string
}): CalibrationEvaluation {
  const { candidate, heldOut } = input
  if (!(heldOut instanceof CalibrationDataset)) {
    throw new CalibrationValidationError('heldOut must be a CalibrationDataset')
  }
  const policy = input.policy ?? new CalibrationApprovalPolicy()
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString()
  const parameters = parametersFromCandidate(candidate)
  const baseline = FSRSParameters.baseline()
  const baselineBrier = baseline.brierScore(heldOut.sequences)
  const candidateBrier = parameters.brierScore(heldOut.sequences)
  const improvement = baselineBrier - candidateBrier

  const simulatedBenefit = Object.freeze({
    channel: 'simulated',
    heldOutSequenceCount: heldOut.sequences.length,
    heldOutObservationCount: heldOut.observationCount(),
    baselineBrier: round4(baselineBrier),
    candidateBrier: round4(candidateBrier),
    brierImprovement: round4(improvement),
    isCausalEvidence: false,
    interpretation: 'held-out synthetic fit quality; not a real learning effect',
  })

  const reasons: string[] = []
  let realTransfer: Readonly<Record<string, unknown>> | null = null
  if (input.realEvidence !== undefined) {
    realTransfer = Object.freeze({
      channel: 'real',
      source: input.realEvidence.source,
      itemCount: input.realEvidence.itemCount,
      observedDelta: round4(input.realEvidence.observedDelta),
      allItemsUnseen: input.realEvidence.allItemsUnseen,
      isCausalEvidence: false,
      interpretation: 'descriptive only; no control group',
    })
  }

  const evidenceSufficient =
    heldOut.sequences.length >= policy.minHeldOutSequences &&
    heldOut.observationCount() >= policy.minHeldOutObservations
  const screeningPassed =
    evidenceSufficient && improvement >= policy.minBrierImprovement
  if (!evidenceSufficient) {
    reasons.push('screening_failed:insufficient_held_out_evidence')
  }
  if (improvement < policy.minBrierImprovement) {
    reasons.push('screening_failed:brier_improvement_below_threshold')
  }

  let realOk = false
  if (realTransfer === null) {
    reasons.push('promotion_blocked:real_transfer_evidence_missing')
  } else if (input.realEvidence !== undefined) {
    if (input.realEvidence.itemCount < policy.minRealTransferItems) {
      reasons.push('real_transfer_failed:too_few_items')
    } else if (input.realEvidence.observedDelta < policy.minRealTransferDelta) {
      reasons.push('real_transfer_failed:delta_below_threshold')
    } else if (!input.realEvidence.allItemsUnseen) {
      reasons.push('real_transfer_failed:item_was_seen')
    } else {
      realOk = true
    }
  }

  return new CalibrationEvaluation({
    candidateId: candidate.candidateId,
    candidateVersion: candidate.version,
    heldOutDigest: heldOut.digest(),
    simulatedBenefit,
    realTransfer,
    screeningPassed,
    promotionReady: screeningPassed && realOk,
    evidenceSufficient,
    reasons,
    isolationChecks: [
      'no observed twin or mastery write path exists in this module',
      'held-out evaluation uses a disjoint synthetic dataset',
      'simulated benefit is never causal evidence',
      'real transfer requires a trusted source and unseen items',
    ],
    limitations: [
      'synthetic held-out data only; a real deployment needs prospective real-student validation',
      'simulated gain alone can never activate a parameter set',
    ],
    evaluatedAt,
  })
}

// ---------------------------------------------------------------------------
// Activation gate
// ---------------------------------------------------------------------------

export class ActivatedParameters {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly parameterVersion: string
  readonly dataVersion: string
  readonly values: Readonly<Record<string, number>>
  readonly activatedBy: string
  readonly activatedAt: string
  readonly previousStableVersion: string

  constructor(input: {
    readonly candidateId: string
    readonly candidateVersion: string
    readonly parameterVersion: string
    readonly dataVersion: string
    readonly values: Readonly<Record<string, number>>
    readonly activatedBy: string
    readonly activatedAt: string
    readonly previousStableVersion: string
  }) {
    this.candidateId = input.candidateId
    this.candidateVersion = input.candidateVersion
    this.parameterVersion = input.parameterVersion
    this.dataVersion = input.dataVersion
    this.values = Object.freeze({ ...input.values })
    this.activatedBy = input.activatedBy
    this.activatedAt = input.activatedAt
    this.previousStableVersion = input.previousStableVersion
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      candidateId: this.candidateId,
      candidateVersion: this.candidateVersion,
      parameterVersion: this.parameterVersion,
      dataVersion: this.dataVersion,
      values: Object.fromEntries(
        Object.entries(this.values).map(([key, value]) => [key, round4(value)]),
      ),
      activatedBy: this.activatedBy,
      activatedAt: this.activatedAt,
      previousStableVersion: this.previousStableVersion,
    }
  }
}

export class CalibrationRecord {
  readonly candidate: Candidate
  status: string
  readonly registeredAt: string
  updatedAt: string
  evaluation: CalibrationEvaluation | null = null
  approval: ApprovalRecord | null = null
  activation: ActivatedParameters | null = null
  rolledBack = false

  constructor(input: {
    readonly candidate: Candidate
    readonly status: string
    readonly registeredAt: string
    readonly updatedAt: string
  }) {
    this.candidate = input.candidate
    this.status = input.status
    this.registeredAt = input.registeredAt
    this.updatedAt = input.updatedAt
  }

  asDict(): Record<string, unknown> {
    return {
      candidate: this.candidate,
      status: this.status,
      registeredAt: this.registeredAt,
      updatedAt: this.updatedAt,
      evaluation: this.evaluation === null ? null : this.evaluation.asDict(),
      approval: this.approval,
      activation: this.activation === null ? null : this.activation.asDict(),
      rolledBack: this.rolledBack,
    }
  }
}

export class CalibrationActivationGate {
  readonly audit: EvolutionAuditLog
  readonly policy: CalibrationApprovalPolicy
  private readonly registry: CandidateRegistry
  private readonly now: () => string
  private readonly records = new Map<string, CalibrationRecord>()
  private readonly stableVersions = new Map<string, string>()

  constructor(input: {
    readonly policy?: CalibrationApprovalPolicy
    readonly audit?: EvolutionAuditLog
    readonly now?: () => string
  } = {}) {
    this.now = input.now ?? (() => new Date().toISOString())
    this.audit = input.audit ?? new EvolutionAuditLog(this.now)
    this.policy = input.policy ?? new CalibrationApprovalPolicy()
    this.registry = new CandidateRegistry(this.audit)
    Object.freeze(this)
  }

  private key(candidateId: string, version: string): string {
    return `${candidateId}\u0000${version}`
  }

  private requireRecord(candidateId: string, version: string): CalibrationRecord {
    const record = this.records.get(this.key(candidateId, version))
    if (record === undefined) {
      throw new CalibrationError(
        `unknown calibration candidate ${candidateId}/${version}`,
      )
    }
    return record
  }

  private assertHostActor(
    actor: Actor,
    record: CalibrationRecord,
    error: new (message: string) => Error,
  ): void {
    if (
      actor === undefined ||
      typeof actor.actorId !== 'string' ||
      typeof actor.role !== 'string'
    ) {
      throw new error('an explicit host-side actor is required')
    }
    if (actor.actorId === record.candidate.author) {
      throw new error('a candidate can never approve or activate itself')
    }
    if (!isHostActor(actor)) {
      throw new error(`role ${actor.role} is not a host-side role`)
    }
  }

  status(candidateId: string, version: string): string | null {
    const record = this.records.get(this.key(candidateId, version))
    return record === undefined ? null : record.status
  }

  record(candidateId: string, version: string): CalibrationRecord {
    return this.requireRecord(candidateId, version)
  }

  listRecords(): readonly CalibrationRecord[] {
    return Object.freeze([...this.records.values()])
  }

  activeParameters(parameterGroup: string): string | null {
    return this.stableVersions.get(parameterGroup) ?? null
  }

  pipelineSnapshot(): Record<string, unknown> {
    return {
      productionMutationEnabled: PRODUCTION_MUTATION_ENABLED,
      syntheticFixturesOnly: SYNTHETIC_FIXTURES_ONLY,
      policy: this.policy.asDict(),
      records: this.listRecords().map((record) => record.asDict()),
      activeParameterVersions: Object.fromEntries(this.stableVersions),
      auditHead: this.audit.head,
    }
  }

  register(candidate: Candidate): CalibrationRecord {
    const validated = this.registry.register(candidate)
    const key = this.key(validated.candidateId, validated.version)
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    const stamp = this.now()
    const record = new CalibrationRecord({
      candidate: validated,
      status: STATUS_REGISTERED,
      registeredAt: stamp,
      updatedAt: stamp,
    })
    this.records.set(key, record)
    if (!this.stableVersions.has(validated.candidateId)) {
      this.stableVersions.set(validated.candidateId, validated.baselineVersion)
    }
    return record
  }

  evaluate(
    candidateId: string,
    version: string,
    heldOut: CalibrationDataset,
    options: { readonly actor: Actor; readonly realEvidence?: RealTransferEvidence },
  ): CalibrationEvaluation {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== STATUS_REGISTERED && record.status !== STATUS_EVALUATED) {
      throw new CalibrationError(
        `cannot evaluate candidate in status ${record.status}`,
      )
    }
    const verdict = evaluateCandidate({
      candidate: record.candidate,
      heldOut,
      policy: this.policy,
      realEvidence: options.realEvidence,
      evaluatedAt: this.now(),
    })
    record.evaluation = verdict
    record.status = verdict.screeningPassed ? STATUS_EVALUATED : STATUS_REJECTED
    record.updatedAt = this.now()
    this.audit.append({
      actor: options.actor.actorId,
      action: verdict.screeningPassed
        ? ACTION_CALIBRATION_EVALUATED
        : ACTION_CALIBRATION_REJECTED,
      subject: candidateId,
      outcome: verdict.screeningPassed ? 'accepted' : 'rejected',
      detail: {
        version,
        heldOutDigest: verdict.heldOutDigest,
        screeningPassed: verdict.screeningPassed,
        promotionReady: verdict.promotionReady,
        reasons: [...verdict.reasons],
      },
    })
    return verdict
  }

  approve(
    candidateId: string,
    version: string,
    approval: ApprovalRecord | null,
    actor: Actor,
  ): CalibrationRecord {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== STATUS_EVALUATED) {
      throw new CalibrationError(
        'approval requires a candidate that passed isolated evaluation; ' +
          `current status is ${record.status}`,
      )
    }
    this.assertHostActor(actor, record, CalibrationDeniedError)
    if (approval === null) {
      throw new CalibrationDeniedError(
        'approval is default-deny: an explicit approval record is required',
      )
    }
    if (
      approval.candidateId !== candidateId ||
      approval.candidateVersion !== version
    ) {
      throw new CalibrationDeniedError('approval record names a different candidate')
    }
    if (approval.approvedBy !== actor.actorId) {
      throw new CalibrationDeniedError(
        'approval record approvedBy must match the acting reviewer',
      )
    }
    if (!(HOST_ROLES as readonly string[]).includes(approval.role)) {
      throw new CalibrationDeniedError(
        `approval role ${approval.role} is not a host-side role`,
      )
    }
    record.approval = approval
    record.status = approval.decision === 'rejected' ? STATUS_REJECTED : STATUS_APPROVED
    record.updatedAt = this.now()
    this.audit.append({
      actor: actor.actorId,
      action: ACTION_CALIBRATION_APPROVED,
      subject: candidateId,
      outcome: approval.decision === 'approved' ? 'accepted' : 'rejected',
      detail: {
        version,
        decision: approval.decision,
        role: approval.role,
        reason: approval.reason,
      },
    })
    return record
  }

  activate(
    candidateId: string,
    version: string,
    options: { readonly actor: Actor },
  ): ActivatedParameters {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== STATUS_APPROVED) {
      throw new CalibrationDeniedError(
        'activation requires an explicitly approved candidate; ' +
          `current status is ${record.status}`,
      )
    }
    this.assertHostActor(options.actor, record, CalibrationDeniedError)
    const parameters = parametersFromCandidate(record.candidate)
    const previous =
      this.stableVersions.get(candidateId) ?? record.candidate.baselineVersion
    const activation = new ActivatedParameters({
      candidateId,
      candidateVersion: version,
      parameterVersion: parameters.parameterVersion,
      dataVersion:
        typeof record.candidate.changes.data_version === 'string'
          ? record.candidate.changes.data_version
          : '',
      values: parameters.quantizedDict(),
      activatedBy: options.actor.actorId,
      activatedAt: this.now(),
      previousStableVersion: previous,
    })
    this.stableVersions.set(candidateId, version)
    record.activation = activation
    record.status = STATUS_ACTIVATED
    record.updatedAt = this.now()
    this.audit.append({
      actor: options.actor.actorId,
      action: ACTION_CALIBRATION_ACTIVATED,
      subject: candidateId,
      outcome: 'accepted',
      detail: {
        version,
        previousStableVersion: previous,
        parameterVersion: activation.parameterVersion,
      },
    })
    return activation
  }

  rollback(
    candidateId: string,
    version: string,
    options: { readonly actor: Actor; readonly reason: string },
  ): ActivatedParameters {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== STATUS_ACTIVATED) {
      throw new CalibrationError(
        `nothing to roll back from status ${record.status}`,
      )
    }
    this.assertHostActor(options.actor, record, CalibrationDeniedError)
    assertShortText(options.reason, 'reason', 200)
    if (record.activation === null) {
      throw new CalibrationError('activation record is missing')
    }
    this.stableVersions.set(
      candidateId,
      record.activation.previousStableVersion,
    )
    record.rolledBack = true
    record.status = STATUS_ROLLED_BACK
    record.updatedAt = this.now()
    this.audit.append({
      actor: options.actor.actorId,
      action: ACTION_CALIBRATION_ROLLED_BACK,
      subject: candidateId,
      outcome: 'accepted',
      detail: {
        version,
        toVersion: record.activation.previousStableVersion,
        reason: options.reason,
      },
    })
    return record.activation
  }
}
