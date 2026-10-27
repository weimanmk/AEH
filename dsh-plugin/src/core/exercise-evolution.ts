/**
 * Exercise evolution engine and isolated simulation lab (spec sections 9, 11).
 *
 * TypeScript mirror of `aeh/exercise_evolution.py`. The two implementations
 * share the same controlled vocabularies, the same content-addressed
 * snapshots, and the same deterministic `mulberry32` stream, so a synthetic
 * parity fixture produces identical candidate hashes and simulation result
 * fingerprints in both languages.
 *
 * Hard rules enforced here:
 * - every evolved candidate carries its source, declarative changes, affected
 *   KCs and deterministic seed; an annotation never carries item text;
 * - a candidate that fails the fail-closed curriculum gate never reaches the
 *   sandbox, and the candidate pool only admits an eligible candidate whose
 *   item-bank record is *approved*;
 * - a simulation uses an independent hypothesis snapshot and a log that
 *   accepts only simulated sources; `observedWrites` is a constant `0`;
 * - simulated benefit and real transfer are separate channels; a simulation
 *   can never produce a real-transfer claim.
 */

import {
  canonicalJson,
  contentHash,
  annotationSnapshot,
  annotationToCurriculumItem,
  missingAnnotationFields,
  prerequisiteDiagnostics,
  ItemBank,
  type ItemAnnotation,
  type ItemRecord,
  type KnowledgeGraph,
} from './curriculum-graph.ts'
import { allow } from './curriculum-gate.ts'
import {
  AehError,
  type CurriculumItem,
  type GateDecision,
  type GateMode,
  type LearnerProgress,
} from '../domain.ts'
import { HypothesisSet, makeHypothesis, type Hypothesis } from './hypothesis.ts'

// ---------------------------------------------------------------------------
// Controlled vocabularies / versions
// ---------------------------------------------------------------------------

export const OPERATOR_NUMERIC = 'numeric'
export const OPERATOR_CONTEXT = 'context'
export const OPERATOR_DISTRACTOR = 'distractor'
export const OPERATOR_DIFFICULTY = 'difficulty'
export const OPERATOR_DIAGNOSTIC = 'diagnostic'

export const EVOLUTION_OPERATORS = Object.freeze([
  OPERATOR_NUMERIC,
  OPERATOR_CONTEXT,
  OPERATOR_DISTRACTOR,
  OPERATOR_DIFFICULTY,
  OPERATOR_DIAGNOSTIC,
] as const)
export type EvolutionOperator = (typeof EVOLUTION_OPERATORS)[number]

const EVOLUTION_OPERATOR_SET: ReadonlySet<string> = new Set(EVOLUTION_OPERATORS)

export const GENERATOR_VERSION = 'aeh-exercise-evolution-v1'
export const SCREENING_POLICY_VERSION = 'aeh-evolution-screening-v1'
export const SANDBOX_ID = 'aeh-evolution-sandbox'
export const SIMULATION_LAB_ID = 'aeh-synthetic-simulation-lab'

export const STATUS_GENERATED = 'generated'
export const STATUS_SCREENED = 'screened'
export const STATUS_REJECTED = 'rejected'
export const STATUS_IN_POOL = 'candidate_pool'

export const CONTEXT_TAGS = Object.freeze([
  'synthetic.context.story',
  'synthetic.context.measurement',
  'synthetic.context.geometry',
  'synthetic.context.graph',
  'synthetic.context.table',
] as const)

export const PHASE_PRE = 'pre_test'
export const PHASE_INTERVENTION = 'intervention'
export const PHASE_POST_NEAR = 'post_test_near'
export const PHASE_POST_FAR = 'post_test_far'

export const SIMULATION_PHASES = Object.freeze([
  PHASE_PRE,
  PHASE_INTERVENTION,
  PHASE_POST_NEAR,
  PHASE_POST_FAR,
] as const)
export type SimulationPhase = (typeof SIMULATION_PHASES)[number]

const SIMULATION_PHASE_SET: ReadonlySet<string> = new Set(SIMULATION_PHASES)

/** Sources that may feed the real-transfer channel. */
export const REAL_TRANSFER_SOURCES: ReadonlySet<string> = new Set([
  'student',
  'teacher',
  'trusted_grader',
  'assessment',
])

/** Sources belonging to the isolated simulation world. */
export const SIMULATED_SOURCES: ReadonlySet<string> = new Set([
  'simulated',
  'virtual_student',
  'simulation',
])

const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const MICROS = 1_000_000

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExerciseEvolutionError extends AehError {}
export class EvolutionValidationError extends ExerciseEvolutionError {}
export class OperatorNotApplicableError extends EvolutionValidationError {}
export class CandidatePoolError extends ExerciseEvolutionError {}
export class SimulationIsolationError extends ExerciseEvolutionError {}
export class SimulationConfigError extends ExerciseEvolutionError {}
export class SelfProofError extends ExerciseEvolutionError {}

// ---------------------------------------------------------------------------
// Deterministic helpers (byte-for-byte mirror of the Python helpers)
// ---------------------------------------------------------------------------

export function opaque(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_RE.test(value)) {
    throw new EvolutionValidationError(
      `${field} must be a short opaque reference`,
    )
  }
  return value
}

function shortText(value: unknown, field: string, maxLength = 200): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /[\r\n]/.test(value)
  ) {
    throw new EvolutionValidationError(
      `${field} must be a short single-line string`,
    )
  }
  return value
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new EvolutionValidationError(
      `${field} must be a non-negative integer`,
    )
  }
  return value
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new EvolutionValidationError(`${field} must be a positive integer`)
  }
  return value
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EvolutionValidationError(`${field} must be a finite number`)
  }
  return value
}

function unitInterval(value: unknown, field: string): number {
  const number = finite(value, field)
  if (number < 0 || number > 1) {
    throw new EvolutionValidationError(`${field} must be within [0, 1]`)
  }
  return number
}

/** JavaScript `Math.round` semantics, shared with the Python `floor(x + 0.5)`. */
export function jsRound(value: number): number {
  return Math.floor(value + 0.5)
}

/** Quantise to four decimals so Python/TypeScript JSON stays identical. */
export function round4(value: number): number {
  return jsRound(value * 10000) / 10000
}

/** Integer micro-units used inside content-addressed fingerprints. */
export function quantizeMicros(value: number): number {
  return jsRound(value * MICROS)
}

/** FNV-1a 32-bit; used to derive deterministic per-operator seeds. */
export function fnv1a32(text: string): number {
  if (typeof text !== 'string') {
    throw new EvolutionValidationError('fnv1a32 input must be a string')
  }
  let digest = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    digest ^= byte
    digest = Math.imul(digest, 0x01000193) >>> 0
  }
  return digest >>> 0
}

/**
 * A tiny deterministic PRNG mirrored exactly in Python. Every bitwise step is
 * kept in 32 bits with `Math.imul`, so both languages produce the same stream.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Recursively turn frozen structures into plain JSON-compatible structures. */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => plain(entry))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) result[key] = plain(entry)
    }
    return result
  }
  return value
}

// ---------------------------------------------------------------------------
// Evolution spec / provenance / candidate
// ---------------------------------------------------------------------------

export interface VariantSpecInput {
  readonly operator?: string
  readonly numericDelta?: number
  readonly contextTag?: string | null
  readonly distractorCount?: number | null
  readonly difficultyDelta?: number
  readonly targetMisconception?: string | null
  readonly targetKcs?: readonly string[]
}

export interface VariantSpec {
  readonly operator: string
  readonly numericDelta: number
  readonly contextTag: string | null
  readonly distractorCount: number | null
  readonly difficultyDelta: number
  readonly targetMisconception: string | null
  readonly targetKcs: readonly string[]
}

export function normalizeVariantSpec(input: VariantSpecInput): VariantSpec {
  const operator = input.operator ?? ''
  if (!EVOLUTION_OPERATOR_SET.has(operator)) {
    throw new EvolutionValidationError(
      `unknown evolution operator ${JSON.stringify(operator)}; allowed ` +
        `operators are ${[...EVOLUTION_OPERATOR_SET].sort().join(',')}`,
    )
  }
  const targetKcs = Object.freeze(
    (input.targetKcs ?? []).map((kc) => opaque(kc, 'target_kcs')),
  )
  return Object.freeze({
    operator,
    numericDelta: finite(input.numericDelta ?? 0, 'numeric_delta'),
    contextTag:
      input.contextTag === undefined || input.contextTag === null
        ? null
        : shortText(input.contextTag, 'context_tag', 120),
    distractorCount:
      input.distractorCount === undefined || input.distractorCount === null
        ? null
        : positiveInt(input.distractorCount, 'distractor_count'),
    difficultyDelta: finite(input.difficultyDelta ?? 0, 'difficulty_delta'),
    targetMisconception:
      input.targetMisconception === undefined ||
      input.targetMisconception === null
        ? null
        : opaque(input.targetMisconception, 'target_misconception'),
    targetKcs,
  })
}

export interface EvolutionProvenance {
  readonly sourceItemId: string
  readonly sourceItemVersion: number
  readonly operator: string
  readonly changeSummary: string
  readonly changes: Readonly<Record<string, unknown>>
  readonly affectedKcs: readonly string[]
  readonly seed: number
  readonly generatorVersion: string
}

export function provenanceAsDict(
  provenance: EvolutionProvenance,
): Readonly<Record<string, unknown>> {
  return {
    source_item_id: provenance.sourceItemId,
    source_item_version: provenance.sourceItemVersion,
    operator: provenance.operator,
    change_summary: provenance.changeSummary,
    changes: plain(provenance.changes),
    affected_kcs: [...provenance.affectedKcs],
    seed: provenance.seed,
    generator_version: provenance.generatorVersion,
  }
}

export function affectedKcs(annotation: ItemAnnotation): readonly string[] {
  const combined = new Set<string>(annotation.requiredKcs)
  for (const entry of annotation.qMatrix) combined.add(entry.kcId)
  return Object.freeze([...combined].sort())
}

export interface EvolutionCandidate {
  readonly candidateId: string
  readonly proposedItemId: string
  readonly annotation: ItemAnnotation
  readonly provenance: EvolutionProvenance
  readonly status: string
}

export function candidateAsDict(
  candidate: EvolutionCandidate,
): Readonly<Record<string, unknown>> {
  return {
    candidate_id: candidate.candidateId,
    proposed_item_id: candidate.proposedItemId,
    status: candidate.status,
    provenance: provenanceAsDict(candidate.provenance),
    annotation: annotationSnapshot(candidate.annotation),
  }
}

export function candidateContentHash(candidate: EvolutionCandidate): string {
  return contentHash(candidateAsDict(candidate))
}

export function candidateToCurriculumItem(
  candidate: EvolutionCandidate,
): CurriculumItem {
  return annotationToCurriculumItem(
    candidate.proposedItemId,
    candidate.annotation,
  )
}

interface AppliedOperator {
  readonly annotation: ItemAnnotation
  readonly changes: Readonly<Record<string, unknown>>
  readonly changeSummary: string
}

function operatorRng(operator: string, seed: number): () => number {
  return mulberry32((seed ^ fnv1a32(operator)) >>> 0)
}

/** Apply one evolutionary operator to a source annotation (content-free). */
export function applyOperator(
  source: ItemAnnotation,
  input: VariantSpecInput,
  options: { readonly seed: number },
): AppliedOperator {
  if (input === null || typeof input !== 'object') {
    throw new EvolutionValidationError('spec must be a VariantSpec')
  }
  const spec = normalizeVariantSpec(input)
  const rng = operatorRng(spec.operator, options.seed)
  const common = {
    source: `synthetic.evolved.${spec.operator}`,
    exposureCount: 0,
  }

  if (spec.operator === OPERATOR_NUMERIC) {
    const coefficientDelta =
      spec.numericDelta !== 0
        ? spec.numericDelta
        : quantizeMicros(rng() * 0.4 - 0.2) / MICROS
    const constantDelta = quantizeMicros(rng() * 2.0 - 1.0) / MICROS
    return {
      annotation: Object.freeze({ ...source, ...common }),
      changes: Object.freeze({
        numeric_parameters: {
          coefficient_delta: round4(coefficientDelta),
          constant_delta: round4(constantDelta),
          grade_band_preserved: true,
        },
      }),
      changeSummary:
        'resampled numeric parameters inside the same KC and grade band ' +
        'while preserving the underlying structure',
    }
  }

  if (spec.operator === OPERATOR_CONTEXT) {
    const pinned = spec.contextTag !== null
    let contextTag = spec.contextTag as string | null
    if (!pinned) {
      const index = Math.trunc(rng() * CONTEXT_TAGS.length) % CONTEXT_TAGS.length
      contextTag = CONTEXT_TAGS[index] as string
    }
    return {
      annotation: Object.freeze({ ...source, ...common }),
      changes: Object.freeze({
        surface_context: {
          context_tag: contextTag,
          pinned,
          structure_preserved: true,
        },
      }),
      changeSummary:
        `moved the surface context to ${contextTag} without changing structure`,
    }
  }

  if (spec.operator === OPERATOR_DISTRACTOR) {
    if (source.itemType !== 'multiple_choice') {
      throw new OperatorNotApplicableError(
        'distractor variation requires a multiple_choice source item',
      )
    }
    const count =
      spec.distractorCount !== null
        ? spec.distractorCount
        : 3 + Math.trunc(rng() * 2.0)
    const cognitiveLoad = round4(source.cognitiveLoad + 0.05 * count)
    return {
      annotation: Object.freeze({
        ...source,
        cognitiveLoad,
        hintLeakageLevel: 0,
        ...common,
      }),
      changes: Object.freeze({
        distractors: {
          distractor_count: count,
          strategy: 'misconception_matched',
          correct_option_unchanged: true,
        },
      }),
      changeSummary:
        `regenerated ${count} misconception-matched distractors while ` +
        'keeping the correct option and required reasoning unchanged',
    }
  }

  if (spec.operator === OPERATOR_DIFFICULTY) {
    const before = source.difficulty === null ? 0.5 : source.difficulty
    const delta =
      spec.difficultyDelta !== 0
        ? spec.difficultyDelta
        : round4(rng() * 0.4 - 0.2)
    const after = Math.min(1, Math.max(0, round4(before + delta)))
    const beforeMinutes =
      source.estimatedMinutes === null ? 5.0 : source.estimatedMinutes
    const afterMinutes = round4(
      Math.max(0.5, beforeMinutes * (1 + (after - before))),
    )
    return {
      annotation: Object.freeze({
        ...source,
        difficulty: after,
        estimatedMinutes: afterMinutes,
        ...common,
      }),
      changes: Object.freeze({
        difficulty: {
          before: round4(before),
          after,
          delta: round4(after - before),
          estimated_minutes_before: round4(beforeMinutes),
          estimated_minutes_after: afterMinutes,
        },
      }),
      changeSummary:
        `adjusted difficulty from ${round4(before)} to ${after} and scaled ` +
        'the estimated time accordingly',
    }
  }

  if (spec.operator === OPERATOR_DIAGNOSTIC) {
    const target =
      spec.targetMisconception !== null
        ? spec.targetMisconception
        : source.misconceptionTargets.length > 0
          ? (source.misconceptionTargets[0] as string)
          : 'synthetic.misconception.generic'
    const targetKcs =
      spec.targetKcs.length > 0 ? spec.targetKcs : source.requiredKcs
    const misconceptions = Object.freeze([
      ...new Set([...source.misconceptionTargets, target]),
    ])
    return {
      annotation: Object.freeze({
        ...source,
        itemType: 'diagnostic',
        misconceptionTargets: misconceptions,
        requiredKcs: Object.freeze([...targetKcs]),
        ...common,
      }),
      changes: Object.freeze({
        diagnostic_target: {
          misconception: target,
          target_kcs: [...targetKcs],
          discriminates_hypotheses: true,
        },
      }),
      changeSummary:
        `targeted the diagnostic variant at misconception ${target} so two ` +
        'cognitive hypotheses predict different observable steps',
    }
  }

  throw new EvolutionValidationError(`unhandled operator ${spec.operator}`)
}

// ---------------------------------------------------------------------------
// Simulation lab (spec section 11)
// ---------------------------------------------------------------------------

export interface SimulationConfigInput {
  readonly configVersion?: string
  readonly config_version?: string
  readonly scenarioId?: string
  readonly scenario_id?: string
  readonly candidateId?: string
  readonly candidate_id?: string
  readonly seed: number
  readonly phasePlan?: readonly string[]
  readonly phase_plan?: readonly string[]
  readonly maxSteps?: number
  readonly max_steps?: number
  readonly label?: string
}

export interface SimulationConfig {
  readonly configVersion: string
  readonly scenarioId: string
  readonly candidateId: string
  readonly seed: number
  readonly phasePlan: readonly string[]
  readonly maxSteps: number
  readonly label: string
}

function pickString(
  input: Record<string, unknown>,
  camel: string,
  snake: string,
): string | undefined {
  const value = input[camel] ?? input[snake]
  return value === undefined || value === null ? undefined : String(value)
}

export function makeSimulationConfig(
  input: SimulationConfigInput,
): SimulationConfig {
  const raw = input as unknown as Record<string, unknown>
  const configVersion = pickString(raw, 'configVersion', 'config_version') ?? ''
  if (configVersion.length === 0) {
    throw new SimulationConfigError('configVersion must not be empty')
  }
  const scenarioId = pickString(raw, 'scenarioId', 'scenario_id')
  const candidateId = pickString(raw, 'candidateId', 'candidate_id')
  if (scenarioId === undefined || candidateId === undefined) {
    throw new SimulationConfigError('scenarioId and candidateId are required')
  }
  const phases = Object.freeze([
    ...((raw.phasePlan ??
      raw.phase_plan ??
      [PHASE_PRE, PHASE_INTERVENTION, PHASE_POST_NEAR]) as readonly string[]),
  ])
  if (phases.length === 0) {
    throw new SimulationConfigError('phasePlan must not be empty')
  }
  for (const phase of phases) {
    if (!SIMULATION_PHASE_SET.has(phase)) {
      throw new SimulationConfigError(`unknown simulation phase: ${phase}`)
    }
  }
  const seed = nonNegativeInt(input.seed, 'seed')
  if (seed > 0xffffffff) {
    throw new SimulationConfigError('seed must be within uint32')
  }
  return Object.freeze({
    configVersion: shortText(configVersion, 'config_version', 120),
    scenarioId: opaque(scenarioId, 'scenario_id'),
    candidateId: opaque(candidateId, 'candidate_id'),
    seed,
    phasePlan: phases,
    maxSteps: positiveInt(raw.maxSteps ?? raw.max_steps ?? 24, 'max_steps'),
    label: shortText(raw.label ?? '', 'label', 200),
  })
}

export function configAsDict(
  config: SimulationConfig,
): Readonly<Record<string, unknown>> {
  return {
    config_version: config.configVersion,
    scenario_id: config.scenarioId,
    candidate_id: config.candidateId,
    seed: config.seed,
    phase_plan: [...config.phasePlan],
    max_steps: config.maxSteps,
    label: config.label,
  }
}

export function configFingerprint(config: SimulationConfig): string {
  return contentHash(configAsDict(config))
}

export interface SimulationHypothesis {
  readonly hypothesisId: string
  readonly weight: number
  readonly response: number
}

function responseOf(hypothesis: Hypothesis): number {
  const values = Object.values(hypothesis.predictedObservableBehaviors)
  if (values.length === 0) return 0.5
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.min(1, Math.max(0, round4(mean)))
}

export interface HypothesisSnapshot {
  readonly snapshotId: string
  readonly hypotheses: readonly SimulationHypothesis[]
  readonly unknownWeight: number
  readonly parentTwinVersion: number
  readonly parentEvidenceRevision: number
}

export function makeHypothesisSnapshot(input: {
  readonly snapshotId: string
  readonly hypotheses: readonly SimulationHypothesis[]
  readonly unknownWeight?: number
  readonly parentTwinVersion?: number
  readonly parentEvidenceRevision?: number
}): HypothesisSnapshot {
  const seen = new Set<string>()
  const hypotheses = Object.freeze(
    input.hypotheses.map((item) => {
      if (seen.has(item.hypothesisId)) {
        throw new SimulationConfigError(
          `duplicate hypothesis id: ${item.hypothesisId}`,
        )
      }
      seen.add(item.hypothesisId)
      return Object.freeze({
        hypothesisId: opaque(item.hypothesisId, 'hypothesis_id'),
        weight: finite(item.weight, 'weight'),
        response: unitInterval(item.response, 'response'),
      })
    }),
  )
  return Object.freeze({
    snapshotId: opaque(input.snapshotId, 'snapshot_id'),
    hypotheses,
    unknownWeight: unitInterval(input.unknownWeight ?? 0, 'unknown_weight'),
    parentTwinVersion: nonNegativeInt(
      input.parentTwinVersion ?? 0,
      'parent_twin_version',
    ),
    parentEvidenceRevision: nonNegativeInt(
      input.parentEvidenceRevision ?? 0,
      'parent_evidence_revision',
    ),
  })
}

/** Build an independent snapshot from a session hypothesis set. */
export function snapshotFromHypothesisSet(
  hypothesisSet: HypothesisSet,
  options: {
    readonly snapshotId: string
    readonly parentTwinVersion?: number
    readonly parentEvidenceRevision?: number
  },
): HypothesisSnapshot {
  const hypotheses = [...hypothesisSet.active()]
    .sort((a, b) =>
      a.hypothesisId < b.hypothesisId
        ? -1
        : a.hypothesisId > b.hypothesisId
          ? 1
          : 0,
    )
    .map((hypothesis) => ({
      hypothesisId: hypothesis.hypothesisId,
      weight: round4(hypothesis.weight),
      response: responseOf(hypothesis),
    }))
  return makeHypothesisSnapshot({
    snapshotId: options.snapshotId,
    hypotheses,
    unknownWeight: round4(hypothesisSet.unknown),
    parentTwinVersion: options.parentTwinVersion ?? 0,
    parentEvidenceRevision: options.parentEvidenceRevision ?? 0,
  })
}

/** Build a private, mutable hypothesis set for one simulation session. */
export function snapshotToHypothesisSet(
  snapshot: HypothesisSnapshot,
): HypothesisSet {
  const hypotheses = snapshot.hypotheses.map((item) =>
    makeHypothesis({
      hypothesisId: item.hypothesisId,
      predictedObservableBehaviors: { response: item.response },
      weight: item.weight,
    }),
  )
  return new HypothesisSet(hypotheses, snapshot.unknownWeight)
}

export function snapshotAsDict(
  snapshot: HypothesisSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    snapshot_id: snapshot.snapshotId,
    hypotheses: snapshot.hypotheses.map((item) => ({
      hypothesis_id: item.hypothesisId,
      weight: round4(item.weight),
      response: round4(item.response),
    })),
    unknown_weight: round4(snapshot.unknownWeight),
    parent_twin_version: snapshot.parentTwinVersion,
    parent_evidence_revision: snapshot.parentEvidenceRevision,
  }
}

export function snapshotFingerprint(snapshot: HypothesisSnapshot): string {
  return contentHash(snapshotAsDict(snapshot))
}

export function snapshotResponseById(
  snapshot: HypothesisSnapshot,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const item of snapshot.hypotheses) result[item.hypothesisId] = item.response
  return Object.freeze(result)
}

export interface SimulationStep {
  readonly stepIndex: number
  readonly phase: string
  readonly itemId: string
  readonly hypothesisId: string
  readonly hypothesisDraw: number
  readonly probability: number
  readonly draw: number
  readonly correct: boolean
  readonly simulated: true
}

export interface SimulationEvent {
  readonly source: string
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** Append-only log that accepts only simulated sources. */
export class SimulationEventLog {
  private readonly entries: SimulationEvent[] = []

  append(event: {
    readonly source: string
    readonly kind: string
    readonly payload: Readonly<Record<string, unknown>>
  }): void {
    if (!SIMULATED_SOURCES.has(event.source)) {
      throw new SimulationIsolationError(
        `simulation log rejects non-simulated source ${JSON.stringify(
          event.source,
        )}; simulated events can never be written to observed state`,
      )
    }
    shortText(event.kind, 'kind', 200)
    this.entries.push(
      Object.freeze({
        source: event.source,
        kind: event.kind,
        payload: plain(event.payload) as Readonly<Record<string, unknown>>,
      }),
    )
  }

  events(): readonly SimulationEvent[] {
    return this.entries
  }

  get observedWrites(): number {
    // Constant by construction; simulations have no observed write path.
    return 0
  }
}

export interface SimulationResult {
  readonly sessionId: string
  readonly config: SimulationConfig
  readonly snapshot: HypothesisSnapshot
  readonly steps: readonly SimulationStep[]
  readonly preAccuracy: number | null
  readonly postAccuracy: number | null
  readonly prePostGain: number
  readonly gainCiLow: number
  readonly gainCiHigh: number
  readonly resultFingerprint: string
  readonly configFingerprint: string
  readonly snapshotFingerprint: string
  readonly observedWrites: number
  readonly finalHypothesisWeights: Readonly<Record<string, number>>
  /** Always `null`: a simulation cannot produce a real-transfer result. */
  readonly realTransfer: null
  readonly limitations: readonly string[]
}

function accuracyOf(steps: readonly SimulationStep[]): number | null {
  if (steps.length === 0) return null
  let correct = 0
  for (const step of steps) if (step.correct) correct += 1
  return round4(correct / steps.length)
}

export function simulationBenefit(
  result: SimulationResult,
): Readonly<Record<string, unknown>> {
  return {
    channel: 'simulated',
    item_count: result.steps.length,
    pre_accuracy: result.preAccuracy,
    post_accuracy: result.postAccuracy,
    simulated_gain: round4(result.prePostGain),
    gain_ci: [round4(result.gainCiLow), round4(result.gainCiHigh)],
    is_causal_evidence: false,
    interpretation: 'simulation only; not a real learning effect',
  }
}

export function simulationResultAsDict(
  result: SimulationResult,
): Readonly<Record<string, unknown>> {
  const weights: Record<string, number> = {}
  for (const key of Object.keys(result.finalHypothesisWeights).sort()) {
    weights[key] = round4(result.finalHypothesisWeights[key] as number)
  }
  return {
    session_id: result.sessionId,
    config: configAsDict(result.config),
    snapshot: snapshotAsDict(result.snapshot),
    config_fingerprint: result.configFingerprint,
    snapshot_fingerprint: result.snapshotFingerprint,
    result_fingerprint: result.resultFingerprint,
    steps: result.steps.map((step) => ({
      step_index: step.stepIndex,
      phase: step.phase,
      item_id: step.itemId,
      hypothesis_id: step.hypothesisId,
      probability: round4(step.probability),
      correct: step.correct,
      simulated: step.simulated,
    })),
    pre_accuracy: result.preAccuracy,
    post_accuracy: result.postAccuracy,
    simulated_gain: round4(result.prePostGain),
    observed_writes: result.observedWrites,
    real_transfer: null,
    final_hypothesis_weights: weights,
    limitations: [...result.limitations],
  }
}

const SIMULATION_LIMITATIONS = Object.freeze([
  'synthetic behavior model only; it is not a calibrated human learning model',
  'simulated gain is screening evidence, never a real learning effect',
  'no real student data, no control group, and no real delivery in this repository',
])

export class SimulationSession {
  readonly sessionId: string
  readonly config: SimulationConfig
  readonly snapshot: HypothesisSnapshot
  private readonly hypotheses: HypothesisSet
  private readonly eventLog = new SimulationEventLog()
  private readonly stepList: SimulationStep[] = []

  constructor(
    sessionId: string,
    config: SimulationConfig,
    snapshot: HypothesisSnapshot,
  ) {
    this.sessionId = opaque(sessionId, 'session_id')
    this.config = config
    this.snapshot = snapshot
    this.hypotheses = snapshotToHypothesisSet(snapshot)
  }

  get observedWrites(): number {
    return this.eventLog.observedWrites
  }

  steps(): readonly SimulationStep[] {
    return this.stepList
  }

  hypothesisWeights(): Readonly<Record<string, number>> {
    return this.hypotheses.weights()
  }

  events(): readonly SimulationEvent[] {
    return this.eventLog.events()
  }

  /** Reweight the session-private hypothesis copy (never the source set). */
  reweight(
    likelihoods: Readonly<Record<string, number>>,
    options: { readonly evidenceRef?: string; readonly noise?: number } = {},
  ): Readonly<Record<string, number>> {
    const weights = this.hypotheses.reweight(likelihoods, {
      evidenceRef: options.evidenceRef,
      noise: options.noise ?? 0.05,
    })
    const rounded: Record<string, number> = {}
    for (const key of Object.keys(weights).sort()) {
      rounded[key] = round4(weights[key] as number)
    }
    this.eventLog.append({
      source: 'simulated',
      kind: 'simulation.hypothesis_reweighted',
      payload: {
        evidence_id: options.evidenceRef ?? null,
        noise: round4(options.noise ?? 0.05),
        weights: rounded,
      },
    })
    return weights
  }

  run(
    itemsByPhase: Readonly<Record<string, readonly string[] | undefined>>,
  ): SimulationResult {
    if (itemsByPhase === null || typeof itemsByPhase !== 'object') {
      throw new SimulationConfigError('itemsByPhase must be an object')
    }
    const responses = snapshotResponseById(this.snapshot)
    const active = [...this.hypotheses.active()].sort((a, b) =>
      a.hypothesisId < b.hypothesisId
        ? -1
        : a.hypothesisId > b.hypothesisId
          ? 1
          : 0,
    )
    const totalWeight = active.reduce((sum, item) => sum + item.weight, 0)
    const rng = mulberry32(this.config.seed)
    this.stepList.length = 0

    for (const phase of this.config.phasePlan) {
      const rawItems = itemsByPhase[phase] ?? []
      for (const rawItem of rawItems) {
        if (this.stepList.length >= this.config.maxSteps) break
        const itemId = opaque(rawItem, 'item_id')
        const hypothesisDraw = rng()
        let hypothesisId: string
        let probability: number
        if (totalWeight > 0) {
          const target = hypothesisDraw * totalWeight
          let cumulative = 0
          let chosen = active[active.length - 1] as Hypothesis
          for (const candidate of active) {
            cumulative += candidate.weight
            if (target < cumulative) {
              chosen = candidate
              break
            }
          }
          probability = responses[chosen.hypothesisId] ?? 0.5
          hypothesisId = chosen.hypothesisId
        } else {
          probability = 0.5
          hypothesisId = 'unknown'
        }
        const draw = rng()
        const correct = draw < probability
        const step: SimulationStep = Object.freeze({
          stepIndex: this.stepList.length,
          phase,
          itemId,
          hypothesisId,
          hypothesisDraw,
          probability,
          draw,
          correct,
          simulated: true,
        })
        this.stepList.push(step)
        this.eventLog.append({
          source: 'simulated',
          kind: 'simulation.step',
          payload: {
            step_index: step.stepIndex,
            phase,
            item_id: itemId,
            hypothesis_id: hypothesisId,
            correct,
          },
        })
      }
    }

    const pre = this.stepList.filter((step) => step.phase === PHASE_PRE)
    const post = this.stepList.filter(
      (step) => step.phase === PHASE_POST_NEAR || step.phase === PHASE_POST_FAR,
    )
    const preAccuracy = accuracyOf(pre)
    const postAccuracy = accuracyOf(post)
    const gain = (postAccuracy ?? 0) - (preAccuracy ?? 0)
    let se = 0
    if (preAccuracy !== null && postAccuracy !== null) {
      se = Math.sqrt(
        (preAccuracy * (1 - preAccuracy)) / pre.length +
          (postAccuracy * (1 - postAccuracy)) / post.length,
      )
    }
    const ciLow = gain - 1.96 * se
    const ciHigh = gain + 1.96 * se

    const configFp = configFingerprint(this.config)
    const snapshotFp = snapshotFingerprint(this.snapshot)
    const sessionId =
      'simsession.' +
      contentHash({ config: configFp, snapshot: snapshotFp }).slice(0, 24)
    const fingerprintPayload = {
      config_fingerprint: configFp,
      snapshot_fingerprint: snapshotFp,
      steps: this.stepList.map((step) => ({
        phase: step.phase,
        item_id: step.itemId,
        hypothesis_id: step.hypothesisId,
        probability_micros: quantizeMicros(step.probability),
        correct: step.correct,
      })),
      pre_accuracy_micros:
        preAccuracy === null ? null : quantizeMicros(preAccuracy),
      post_accuracy_micros:
        postAccuracy === null ? null : quantizeMicros(postAccuracy),
      gain_micros: quantizeMicros(gain),
      ci_low_micros: quantizeMicros(ciLow),
      ci_high_micros: quantizeMicros(ciHigh),
      observed_writes: 0,
    }
    return Object.freeze({
      sessionId,
      config: this.config,
      snapshot: this.snapshot,
      steps: Object.freeze([...this.stepList]),
      preAccuracy,
      postAccuracy,
      prePostGain: gain,
      gainCiLow: ciLow,
      gainCiHigh: ciHigh,
      resultFingerprint: contentHash(fingerprintPayload),
      configFingerprint: configFp,
      snapshotFingerprint: snapshotFp,
      observedWrites: 0,
      finalHypothesisWeights: Object.freeze({ ...this.hypotheses.weights() }),
      realTransfer: null,
      limitations: SIMULATION_LIMITATIONS,
    })
  }
}

export class SimulationLab {
  readonly labId: string

  constructor(options: { readonly labId?: string } = {}) {
    this.labId = shortText(options.labId ?? SIMULATION_LAB_ID, 'lab_id', 120)
  }

  openSession(
    config: SimulationConfig,
    snapshot: HypothesisSnapshot,
  ): SimulationSession {
    const sessionId =
      'simsession.' +
      contentHash({
        config: configFingerprint(config),
        snapshot: snapshotFingerprint(snapshot),
      }).slice(0, 24)
    return new SimulationSession(sessionId, config, snapshot)
  }

  run(
    config: SimulationConfig,
    snapshot: HypothesisSnapshot,
    itemsByPhase: Readonly<Record<string, readonly string[] | undefined>>,
  ): SimulationResult {
    return this.openSession(config, snapshot).run(itemsByPhase)
  }
}

// ---------------------------------------------------------------------------
// Isolated evolution sandbox: gate-bound screening, separate channels
// ---------------------------------------------------------------------------

export interface ScreeningPolicy {
  readonly policyVersion: string
  readonly minSimulatedItems: number
  readonly minSimulatedGain: number
  readonly minRealTransferItems: number
  readonly minRealTransferDelta: number
}

export interface ScreeningPolicyInput {
  readonly policyVersion?: string
  readonly minSimulatedItems?: number
  readonly minSimulatedGain?: number
  readonly minRealTransferItems?: number
  readonly minRealTransferDelta?: number
}

export function makeScreeningPolicy(
  input: ScreeningPolicyInput = {},
): ScreeningPolicy {
  return Object.freeze({
    policyVersion: shortText(
      input.policyVersion ?? SCREENING_POLICY_VERSION,
      'policy_version',
      120,
    ),
    minSimulatedItems: positiveInt(
      input.minSimulatedItems ?? 3,
      'min_simulated_items',
    ),
    minSimulatedGain: finite(
      input.minSimulatedGain ?? 0,
      'min_simulated_gain',
    ),
    minRealTransferItems: positiveInt(
      input.minRealTransferItems ?? 2,
      'min_real_transfer_items',
    ),
    minRealTransferDelta: finite(
      input.minRealTransferDelta ?? 0,
      'min_real_transfer_delta',
    ),
  })
}

export interface RealTransferOutcomeInput {
  readonly itemId: string
  readonly correct: boolean
  readonly source: string
  readonly independent?: boolean
}

export interface FrozenTransferSetLike {
  readonly datasetId: string
  readonly version: string
  /** Transfer item ids; they are unseen by construction in this skeleton. */
  readonly transferItemIds: readonly string[]
}

function evaluateRealTransfer(
  realOutcomes: readonly RealTransferOutcomeInput[],
  frozenSet: FrozenTransferSetLike | undefined,
  referenceAccuracy: number,
): Readonly<Record<string, unknown>> | null {
  if (realOutcomes.length === 0) return null
  if (frozenSet === undefined) {
    throw new EvolutionValidationError(
      'real transfer outcomes require a frozen transfer set; the sandbox ' +
        'never fabricates real evidence',
    )
  }
  const transferIds = new Set(frozenSet.transferItemIds)
  let correct = 0
  const sources = new Set<string>()
  for (const outcome of realOutcomes) {
    if (typeof outcome.correct !== 'boolean') {
      throw new EvolutionValidationError('correct must be a boolean')
    }
    if (!transferIds.has(outcome.itemId)) {
      throw new SelfProofError(
        `transfer item ${outcome.itemId} is not in the frozen transfer set`,
      )
    }
    if (!REAL_TRANSFER_SOURCES.has(outcome.source)) {
      throw new SelfProofError(
        `real outcomes must come from a trusted observed source; ` +
          `${JSON.stringify(outcome.source)} is not one of ` +
          `${[...REAL_TRANSFER_SOURCES].sort().join(',')}`,
      )
    }
    if (outcome.independent === false) {
      throw new EvolutionValidationError(
        'transfer evaluation only counts independent attempts',
      )
    }
    sources.add(outcome.source)
    if (outcome.correct) correct += 1
  }
  if (sources.size !== 1) {
    throw new EvolutionValidationError(
      'a run must not mix observed sources across the real channel',
    )
  }
  const transferAccuracy = correct / realOutcomes.length
  return Object.freeze({
    item_count: realOutcomes.length,
    independent_correct: correct,
    transfer_accuracy: round4(transferAccuracy),
    reference_accuracy: referenceAccuracy,
    observed_delta: round4(transferAccuracy - referenceAccuracy),
    sources: [...sources].sort(),
    all_items_unseen: true,
    causal_claim_supported: false,
    interpretation:
      'observed transfer on unseen items; without a control group this is ' +
      'descriptive, not causal',
  })
}

export interface SandboxVerdict {
  readonly candidateId: string
  readonly sandboxId: string
  readonly simulation: SimulationResult
  readonly simulatedBenefit: Readonly<Record<string, unknown>>
  readonly realTransfer: Readonly<Record<string, unknown>> | null
  readonly passedScreening: boolean
  readonly promotionReady: boolean
  readonly reasons: readonly string[]
  readonly isolationChecks: readonly string[]
  readonly limitations: readonly string[]
}

export function verdictAsDict(
  verdict: SandboxVerdict,
): Readonly<Record<string, unknown>> {
  return {
    candidate_id: verdict.candidateId,
    sandbox_id: verdict.sandboxId,
    simulation: simulationResultAsDict(verdict.simulation),
    simulated_benefit: plain(verdict.simulatedBenefit),
    real_transfer:
      verdict.realTransfer === null ? null : plain(verdict.realTransfer),
    passed_screening: verdict.passedScreening,
    promotion_ready: verdict.promotionReady,
    reasons: [...verdict.reasons],
    isolation_checks: [...verdict.isolationChecks],
    limitations: [...verdict.limitations],
  }
}

export interface SandboxEvaluateOptions {
  readonly snapshot: HypothesisSnapshot
  readonly itemsByPhase: Readonly<Record<string, readonly string[] | undefined>>
  readonly config?: SimulationConfig
  readonly frozenSet?: FrozenTransferSetLike
  readonly realOutcomes?: readonly RealTransferOutcomeInput[]
}

export class EvolutionSandbox {
  readonly sandboxId: string
  readonly lab: SimulationLab
  readonly policy: ScreeningPolicy
  readonly referenceAccuracy: number

  constructor(
    options: {
      readonly sandboxId?: string
      readonly lab?: SimulationLab
      readonly policy?: ScreeningPolicy | ScreeningPolicyInput
      readonly referenceAccuracy?: number
    } = {},
  ) {
    this.sandboxId = shortText(options.sandboxId ?? SANDBOX_ID, 'sandbox_id', 120)
    this.lab = options.lab ?? new SimulationLab()
    this.policy =
      options.policy === undefined
        ? makeScreeningPolicy()
        : isScreeningPolicy(options.policy)
          ? options.policy
          : makeScreeningPolicy(options.policy)
    this.referenceAccuracy = unitInterval(
      options.referenceAccuracy ?? 0.5,
      'reference_accuracy',
    )
  }

  evaluate(
    candidate: EvolutionCandidate,
    options: SandboxEvaluateOptions,
  ): SandboxVerdict {
    const config =
      options.config ??
      makeSimulationConfig({
        configVersion: SCREENING_POLICY_VERSION,
        scenarioId: `scenario.${candidate.candidateId}`,
        candidateId: candidate.candidateId,
        seed: candidate.provenance.seed,
      })
    if (config.candidateId !== candidate.candidateId) {
      throw new EvolutionValidationError(
        'simulation config candidateId must match the evaluated candidate',
      )
    }

    const simulation = this.lab.run(
      config,
      options.snapshot,
      options.itemsByPhase,
    )
    const benefit = simulationBenefit(simulation)

    const reasons: string[] = []
    const simulatedItems = simulation.steps.length
    if (simulatedItems < this.policy.minSimulatedItems) {
      reasons.push('screening_failed:too_few_simulated_items')
    }
    if (simulation.prePostGain < this.policy.minSimulatedGain) {
      reasons.push('screening_failed:simulated_gain_below_threshold')
    }
    const passedScreening =
      simulation.observedWrites === 0 &&
      simulatedItems >= this.policy.minSimulatedItems &&
      simulation.prePostGain >= this.policy.minSimulatedGain

    const realTransfer = evaluateRealTransfer(
      options.realOutcomes ?? [],
      options.frozenSet,
      this.referenceAccuracy,
    )
    let realOk = false
    if (realTransfer !== null) {
      const itemCount = realTransfer.item_count as number
      const delta = realTransfer.observed_delta as number
      if (itemCount < this.policy.minRealTransferItems) {
        reasons.push('real_transfer_failed:too_few_items')
      } else if (delta < this.policy.minRealTransferDelta) {
        reasons.push('real_transfer_failed:delta_below_threshold')
      } else if (realTransfer.all_items_unseen !== true) {
        reasons.push('real_transfer_failed:item_was_seen')
      } else {
        realOk = true
      }
    } else {
      reasons.push('promotion_blocked:real_transfer_evidence_missing')
    }

    return Object.freeze({
      candidateId: candidate.candidateId,
      sandboxId: this.sandboxId,
      simulation,
      simulatedBenefit: benefit,
      realTransfer,
      passedScreening,
      promotionReady: realOk,
      reasons: Object.freeze(reasons),
      isolationChecks: Object.freeze([
        'all simulation events use simulated sources',
        'observed_writes == 0',
        'hypothesis state is an independent snapshot copy',
        'config and result are content-addressed and replayable',
        'simulated benefit and real transfer are reported separately',
      ]),
      limitations: simulation.limitations,
    })
  }
}

function isScreeningPolicy(value: unknown): value is ScreeningPolicy {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ScreeningPolicy).policyVersion === 'string'
  )
}

// ---------------------------------------------------------------------------
// Engine + candidate pool
// ---------------------------------------------------------------------------

export interface EvolutionValidation {
  readonly candidateId: string
  readonly valid: boolean
  readonly annotationComplete: boolean
  readonly gateDecision: GateDecision | null
  readonly missingPrerequisites: readonly string[]
  readonly unknownKcs: readonly string[]
  readonly reasons: readonly string[]
  readonly allowedKcs: readonly string[]
}

export function validationAsDict(
  validation: EvolutionValidation,
): Readonly<Record<string, unknown>> {
  return {
    candidate_id: validation.candidateId,
    valid: validation.valid,
    annotation_complete: validation.annotationComplete,
    gate_allowed:
      validation.gateDecision === null ? null : validation.gateDecision.allowed,
    missing_prerequisites: [...validation.missingPrerequisites],
    unknown_kcs: [...validation.unknownKcs],
    reasons: [...validation.reasons],
    allowed_kcs: [...validation.allowedKcs].sort(),
  }
}

export interface ScreenOutcome {
  readonly candidate: EvolutionCandidate
  readonly validation: EvolutionValidation
  readonly sandboxVerdict: SandboxVerdict | null
  readonly status: string
  readonly eligible: boolean
  readonly reasons: readonly string[]
}

export function screenOutcomeAsDict(
  outcome: ScreenOutcome,
): Readonly<Record<string, unknown>> {
  return {
    candidate: candidateAsDict(outcome.candidate),
    validation: validationAsDict(outcome.validation),
    sandbox:
      outcome.sandboxVerdict === null
        ? null
        : verdictAsDict(outcome.sandboxVerdict),
    status: outcome.status,
    eligible: outcome.eligible,
    reasons: [...outcome.reasons],
  }
}

export class ExerciseEvolutionEngine {
  readonly bank: ItemBank
  readonly graph: KnowledgeGraph | null
  readonly seed: number
  readonly sandbox: EvolutionSandbox
  readonly generatorVersion: string

  constructor(
    bank: ItemBank,
    graph: KnowledgeGraph | null,
    options: {
      readonly seed?: number
      readonly sandbox?: EvolutionSandbox
      readonly generatorVersion?: string
    } = {},
  ) {
    this.bank = bank
    this.graph = graph
    this.seed = nonNegativeInt(options.seed ?? 0, 'seed')
    this.sandbox = options.sandbox ?? new EvolutionSandbox()
    this.generatorVersion = shortText(
      options.generatorVersion ?? GENERATOR_VERSION,
      'generator_version',
      120,
    )
  }

  generate(
    sourceItemId: string,
    spec: VariantSpecInput,
    options: { readonly candidateId?: string } = {},
  ): EvolutionCandidate {
    const sourceId = opaque(sourceItemId, 'source_item_id')
    const record = this.bank.current(sourceId)
    const applied = applyOperator(record.annotation, spec, { seed: this.seed })
    const affected = affectedKcs(applied.annotation)
    if (affected.length === 0) {
      throw new EvolutionValidationError(
        'evolved item must affect at least one knowledge component',
      )
    }
    const operator = normalizeVariantSpec(spec).operator
    const identifier =
      options.candidateId ?? `cand.${sourceId}.${operator}.${this.seed}`
    const proposedItemId = `evo.${sourceId}.${operator}.${this.seed}`
    return Object.freeze({
      candidateId: opaque(identifier, 'candidate_id'),
      proposedItemId: opaque(proposedItemId, 'proposed_item_id'),
      annotation: applied.annotation,
      provenance: Object.freeze({
        sourceItemId: sourceId,
        sourceItemVersion: record.version,
        operator,
        changeSummary: applied.changeSummary,
        changes: applied.changes,
        affectedKcs: affected,
        seed: this.seed,
        generatorVersion: this.generatorVersion,
      }),
      status: STATUS_GENERATED,
    })
  }

  validate(
    candidate: EvolutionCandidate,
    progress: LearnerProgress,
    mode: GateMode = 'learn',
  ): EvolutionValidation {
    const item = candidateToCurriculumItem(candidate)
    const missing = missingAnnotationFields(candidate.annotation)
    const decision = allow(item, progress, mode)
    const reasons = [...decision.reasons]
    if (missing.length > 0) {
      reasons.push(`incomplete_annotation:${missing.join(',')}`)
    }
    if (this.graph === null || this.graph === undefined) {
      reasons.push('graph_unavailable')
      return Object.freeze({
        candidateId: candidate.candidateId,
        valid: false,
        annotationComplete: missing.length === 0,
        gateDecision: decision,
        missingPrerequisites: Object.freeze([]),
        unknownKcs: Object.freeze([]),
        reasons: Object.freeze(reasons),
        allowedKcs: Object.freeze([...decision.allowedKcs].sort()),
      })
    }
    const diagnostics = prerequisiteDiagnostics(
      this.graph,
      item.requiredKcs ?? [],
      decision.allowedKcs,
    )
    if (diagnostics.unknownKcs.length > 0) {
      reasons.push(`kc_not_in_graph:${diagnostics.unknownKcs.join(',')}`)
    }
    if (diagnostics.missingPrerequisites.length > 0) {
      reasons.push(
        `prerequisites_not_met:${diagnostics.missingPrerequisites.join(',')}`,
      )
    }
    return Object.freeze({
      candidateId: candidate.candidateId,
      valid: reasons.length === 0,
      annotationComplete: missing.length === 0,
      gateDecision: decision,
      missingPrerequisites: diagnostics.missingPrerequisites,
      unknownKcs: diagnostics.unknownKcs,
      reasons: Object.freeze(reasons),
      allowedKcs: Object.freeze([...decision.allowedKcs].sort()),
    })
  }

  evaluateInSandbox(
    candidate: EvolutionCandidate,
    options: SandboxEvaluateOptions,
  ): SandboxVerdict {
    return this.sandbox.evaluate(candidate, options)
  }

  submitForReview(
    candidate: EvolutionCandidate,
    options: { readonly submittedBy: string },
  ): ItemRecord {
    let existing: ItemRecord | undefined
    try {
      existing = this.bank.current(candidate.proposedItemId)
    } catch {
      existing = undefined
    }
    let record: ItemRecord
    if (existing === undefined) {
      record = this.bank.addItem(
        candidate.proposedItemId,
        candidate.annotation,
        { reviewStatus: 'draft' },
      )
    } else {
      if (
        canonicalJson(annotationSnapshot(existing.annotation)) !==
        canonicalJson(annotationSnapshot(candidate.annotation))
      ) {
        throw new EvolutionValidationError(
          `item ${candidate.proposedItemId} already exists with different content`,
        )
      }
      record = existing
    }
    if (record.reviewStatus === 'draft' || record.reviewStatus === 'changes_requested') {
      record = this.bank.submitForReview(
        candidate.proposedItemId,
        options.submittedBy,
      )
    }
    return record
  }

  screen(
    candidate: EvolutionCandidate,
    options: SandboxEvaluateOptions & {
      readonly progress: LearnerProgress
      readonly mode?: GateMode
    },
  ): ScreenOutcome {
    const validation = this.validate(
      candidate,
      options.progress,
      options.mode ?? 'learn',
    )
    const reasons = [...validation.reasons]
    let verdict: SandboxVerdict | null = null
    if (validation.valid) {
      // The sandbox only runs after the fail-closed gate accepts the candidate.
      verdict = this.evaluateInSandbox(candidate, options)
      reasons.push(...verdict.reasons)
    }
    const eligible =
      validation.valid && verdict !== null && verdict.passedScreening
    const status = eligible ? STATUS_SCREENED : STATUS_REJECTED
    return Object.freeze({
      candidate: Object.freeze({ ...candidate, status }),
      validation,
      sandboxVerdict: verdict,
      status,
      eligible,
      reasons: Object.freeze(reasons),
    })
  }
}

export class EvolutionCandidatePool {
  private readonly byCandidate = new Map<string, EvolutionCandidate>()
  private readonly admissions: Record<string, unknown>[] = []

  admit(outcome: ScreenOutcome, itemRecord: ItemRecord): EvolutionCandidate {
    if (!outcome.eligible) {
      throw new CandidatePoolError(
        'candidate is not eligible: ' +
          (outcome.reasons.length > 0
            ? outcome.reasons.join(', ')
            : 'unknown reason'),
      )
    }
    if (itemRecord.itemId !== outcome.candidate.proposedItemId) {
      throw new CandidatePoolError(
        "item record does not match the candidate's proposed item",
      )
    }
    if (itemRecord.reviewStatus !== 'approved') {
      throw new CandidatePoolError(
        'candidate cannot bypass item-bank review; current status is ' +
          `${JSON.stringify(itemRecord.reviewStatus)}`,
      )
    }
    if (
      outcome.sandboxVerdict === null ||
      !outcome.sandboxVerdict.passedScreening
    ) {
      throw new CandidatePoolError(
        'candidate cannot bypass the isolated sandbox evaluation',
      )
    }
    if (outcome.sandboxVerdict.simulation.observedWrites !== 0) {
      throw new CandidatePoolError('sandbox reported observed writes')
    }

    const candidate: EvolutionCandidate = Object.freeze({
      ...outcome.candidate,
      status: STATUS_IN_POOL,
    })
    const existing = this.byCandidate.get(candidate.candidateId)
    if (existing !== undefined) {
      if (candidateContentHash(existing) !== candidateContentHash(candidate)) {
        throw new CandidatePoolError(
          `candidate ${candidate.candidateId} already admitted with different content`,
        )
      }
      return existing
    }
    this.byCandidate.set(candidate.candidateId, candidate)
    this.admissions.push(
      Object.freeze({
        candidate_id: candidate.candidateId,
        proposed_item_id: candidate.proposedItemId,
        item_version: itemRecord.version,
        sandbox_result_fingerprint:
          outcome.sandboxVerdict.simulation.resultFingerprint,
        passed_screening: outcome.sandboxVerdict.passedScreening,
        promotion_ready: outcome.sandboxVerdict.promotionReady,
      }),
    )
    return candidate
  }

  get(candidateId: string): EvolutionCandidate | undefined {
    return this.byCandidate.get(candidateId)
  }

  list(): readonly EvolutionCandidate[] {
    return [...this.byCandidate.values()]
  }

  admissionLog(): readonly Readonly<Record<string, unknown>>[] {
    return this.admissions
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return {
      size: this.byCandidate.size,
      candidates: [...this.byCandidate.values()]
        .sort((a, b) =>
          a.candidateId < b.candidateId
            ? -1
            : a.candidateId > b.candidateId
              ? 1
              : 0,
        )
        .map((candidate) => candidateAsDict(candidate)),
      admissions: this.admissions.map((entry) => plain(entry)),
    }
  }
}
