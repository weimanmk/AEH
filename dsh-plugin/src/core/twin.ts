/**
 * Long-term student twin with event sourcing (spec section 5).
 *
 * This is the host-owned part of the plugin. It is deliberately **not** exposed
 * as a model-facing write tool in the default profile:
 *
 * - real observations are append-only and immutable; a correction is a new
 *   event, never an edit or a delete;
 * - simulated events live in a separate store and can never write observed
 *   evidence, mastery, memory, or hypotheses;
 * - every inferred update must reference observed evidence ids that exist;
 * - inferred state is versioned, checkpointed, replayable and rollbackable
 *   while evidence stays intact.
 *
 * Step 12 adds the long-term integration:
 *
 * - per-KC FSRS memory states, aged by time and refreshed by reviews;
 * - Step 11 calibration parameters attached as *pending* candidates that only
 *   take effect after an explicit approval;
 * - hypothesis-set evolution (spawn/split/reweight/merge/prune) bound to the
 *   exact twin version it was derived from.
 *
 * The dsh host is expected to persist these events in a Profile/Bundle store and
 * to attest the source (`teacher`, `trusted_grader`, ...). The in-memory class
 * here is the reference implementation used by host adapters and tests.
 */

import {
  TwinError,
  type HypothesisRecord,
  type KnowledgeEstimate,
  type MemoryObservationInput,
  type MemoryState,
  type TwinSnapshot,
} from '../domain.ts'
import {
  BASELINE_PARAMETER_VERSION,
  MemoryParameters,
  aggregateMemory,
  applyForgetting,
  normalizeMemoryState,
  updateMemory,
} from './memory.ts'
import { type Hypothesis, HypothesisSet } from './hypothesis.ts'

/** Sources that may write real (observed) evidence. */
export const REAL_SOURCES: ReadonlySet<string> = new Set([
  'student',
  'teacher',
  'trusted_grader',
  'assessment',
])

/** Sources that belong to the isolated simulation world. */
export const SIMULATED_SOURCES: ReadonlySet<string> = new Set([
  'simulated',
  'virtual_student',
  'simulation',
])

export const SCHEMA_VERSION = 'aeh-event-v1'

/** Step 12: the only hypothesis-set mutations the twin accepts. */
export const HYPOTHESIS_OPS = Object.freeze([
  'spawn',
  'split',
  'reweight',
  'merge',
  'prune',
] as const)
export type HypothesisOperationKind = (typeof HYPOTHESIS_OPS)[number]

export class SimulatedEventRejected extends TwinError {}
export class UnknownEventSource extends TwinError {}
export class MissingEvidenceError extends TwinError {}
export class StaleSimulationError extends TwinError {}
export class VersionNotFoundError extends TwinError {}
export class CheckpointNotFoundError extends TwinError {}
export class CalibrationApprovalRequired extends TwinError {}
export class HypothesisBindingError extends TwinError {}

export interface TwinEventInput {
  readonly eventId: string
  readonly eventType: string
  readonly source: string
  readonly studentRef?: string | null
  readonly occurredAt?: string | null
  readonly observedAt?: string | null
  readonly payload?: Readonly<Record<string, unknown>>
  readonly provenance?: string
  readonly modelVersions?: Readonly<Record<string, string>>
  readonly schemaVersion?: string
  readonly consentScope?: string
}

export interface TwinEvent {
  readonly eventId: string
  readonly eventType: string
  readonly source: string
  readonly studentRef: string | null
  readonly occurredAt: string | null
  readonly observedAt: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly provenance: string
  readonly modelVersions: Readonly<Record<string, string>>
  readonly schemaVersion: string
  readonly consentScope: string
}

export interface TwinState {
  readonly studentRef: string
  readonly version: number
  readonly knowledge: ReadonlyMap<string, KnowledgeEstimate>
  readonly observedEvidenceIds: ReadonlySet<string>
  readonly lastObservedAt: string | null
  readonly unresolvedHypotheses: readonly string[]
  /** Step 12: per-KC long-term memory states. */
  readonly memory: ReadonlyMap<string, MemoryState>
  /** Step 12: revision of the bound hypothesis set. */
  readonly hypothesisRevision: number
  /** Step 12: currently effective FSRS parameter version. */
  readonly activeParameterVersion: string
}

/** One replayable mastery update in the inference log. */
export interface MasteryUpdate {
  readonly kind: 'mastery'
  readonly updateId: string
  readonly kcId: string
  readonly masteryMean: number
  readonly uncertainty: number
  readonly evidenceIds: readonly string[]
  readonly exposureState: string
  readonly version: number
}

/** One evidence-backed review of a single KC's long-term memory. */
export interface MemoryUpdate {
  readonly kind: 'memory_review'
  readonly updateId: string
  readonly kcId: string
  readonly observationId: string
  readonly evidenceIds: readonly string[]
  readonly state: MemoryState
  readonly version: number
}

/** One time-based aging step covering several KC memory units. */
export interface MemoryDecayUpdate {
  readonly kind: 'memory_decay'
  readonly updateId: string
  readonly states: ReadonlyMap<string, MemoryState>
  readonly version: number
}

/** A hypothesis set bound to one twin version and its evidence refs. */
export interface HypothesisBinding {
  readonly kind: 'hypothesis_binding'
  readonly bindingId: string
  readonly hypothesisRevision: number
  readonly twinVersion: number
  /** Alias of `twinVersion`, for inference-log compatibility. */
  readonly version: number
  readonly weights: Readonly<Record<string, number>>
  readonly unresolved: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly hypothesisSet: HypothesisSet | null
  readonly boundAt: string | null
}

/** A Step 11 parameter candidate that has **not** taken effect yet. */
export interface PendingCalibration {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly parameters: MemoryParameters
  readonly proposedBy: string
  readonly proposedAt: string
  readonly fingerprint: string
}

/** An approved activation or rollback of a calibration parameter set. */
export interface CalibrationActivation {
  readonly kind: 'activate' | 'rollback'
  readonly activationId: string
  readonly candidateId: string
  readonly candidateVersion: string
  readonly parameterVersion: string
  readonly values: Readonly<Record<string, number>>
  readonly approvalId: string
  readonly approvedBy: string
  readonly previousParameterVersion: string
  readonly activatedAt: string
  readonly version: number
}

export type InferenceStep =
  | MasteryUpdate
  | MemoryUpdate
  | MemoryDecayUpdate
  | HypothesisBinding
  | CalibrationActivation

/** One structured hypothesis-set evolution request (spec 6.2). */
export interface HypothesisOperationInput {
  readonly kind: HypothesisOperationKind
  readonly hypothesis?: Hypothesis | HypothesisRecord
  readonly hypothesisId?: string
  readonly children?: readonly (Hypothesis | HypothesisRecord)[]
  readonly hypothesisIds?: readonly string[]
  readonly merged?: Hypothesis | HypothesisRecord
  readonly likelihoods?: Readonly<Record<string, number>>
  readonly reason?: string
  readonly noise?: number
  readonly unknownPrior?: number
  readonly unknownLikelihood?: number
  readonly evidenceIds?: readonly string[]
}

export interface CreateCheckpointOptions {
  readonly createdAt?: string
}

export interface TwinOptions {
  /** Injectable clock for deterministic checkpoints/audits. */
  readonly clock?: () => string
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

function sortedRecord(
  record: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const key of Object.keys(record).sort()) {
    result[key] = round6(record[key] as number)
  }
  return result
}

/** A full inferred-state checkpoint bound to an evidence revision. */
export class TwinCheckpoint {
  readonly checkpointId: string
  readonly label: string
  readonly version: number
  readonly evidenceRevision: number
  readonly createdAt: string
  readonly knowledge: ReadonlyMap<string, KnowledgeEstimate>
  readonly memory: ReadonlyMap<string, MemoryState>
  readonly observedEvidenceIds: ReadonlySet<string>
  readonly lastObservedAt: string | null
  readonly unresolvedHypotheses: readonly string[]
  readonly hypothesisRevision: number
  readonly hypothesisWeights: Readonly<Record<string, number>>
  readonly hypothesisBoundVersion: number | null
  readonly activeParameterVersion: string

  constructor(input: {
    readonly checkpointId: string
    readonly label: string
    readonly version: number
    readonly evidenceRevision: number
    readonly createdAt: string
    readonly knowledge: ReadonlyMap<string, KnowledgeEstimate>
    readonly memory: ReadonlyMap<string, MemoryState>
    readonly observedEvidenceIds: ReadonlySet<string>
    readonly lastObservedAt: string | null
    readonly unresolvedHypotheses: readonly string[]
    readonly hypothesisRevision: number
    readonly hypothesisWeights: Readonly<Record<string, number>>
    readonly hypothesisBoundVersion: number | null
    readonly activeParameterVersion: string
  }) {
    this.checkpointId = input.checkpointId
    this.label = input.label
    this.version = input.version
    this.evidenceRevision = input.evidenceRevision
    this.createdAt = input.createdAt
    this.knowledge = new Map(input.knowledge)
    this.memory = new Map(input.memory)
    this.observedEvidenceIds = new Set(input.observedEvidenceIds)
    this.lastObservedAt = input.lastObservedAt
    this.unresolvedHypotheses = Object.freeze([...input.unresolvedHypotheses])
    this.hypothesisRevision = input.hypothesisRevision
    this.hypothesisWeights = Object.freeze({ ...input.hypothesisWeights })
    this.hypothesisBoundVersion = input.hypothesisBoundVersion
    this.activeParameterVersion = input.activeParameterVersion
    Object.freeze(this)
  }

  /** JSON-friendly projection matching `aeh.twin.TwinCheckpoint.as_dict()`. */
  asDict(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      checkpointId: this.checkpointId,
      label: this.label,
      version: this.version,
      evidenceRevision: this.evidenceRevision,
      createdAt: this.createdAt,
      knowledge: [...this.knowledge.values()]
        .sort((left, right) => left.kcId.localeCompare(right.kcId))
        .map((estimate) =>
          Object.freeze({
            kcId: estimate.kcId,
            masteryMean: round6(estimate.masteryMean),
            uncertainty: round6(estimate.uncertainty),
            evidenceIds: Object.freeze([...estimate.evidenceIds]),
            exposureState: estimate.exposureState,
          }),
        ),
      memory: [...this.memory.values()]
        .sort((left, right) =>
          left.memoryUnitId.localeCompare(right.memoryUnitId),
        )
        .map((state) =>
          Object.freeze({
            memoryUnitId: state.memoryUnitId,
            stabilityDays: round6(state.stabilityDays),
            difficulty: round6(state.difficulty),
            observationCount: state.observationCount,
            independentSuccessCount: state.independentSuccessCount,
            uncertainty: state.uncertainty,
            modelVersion: state.modelVersion,
            needsCalibration: state.needsCalibration,
          }),
        ),
      observedEvidenceIds: [...this.observedEvidenceIds].sort(),
      lastObservedAt: this.lastObservedAt,
      unresolvedHypotheses: [...this.unresolvedHypotheses],
      hypothesisRevision: this.hypothesisRevision,
      hypothesisWeights: sortedRecord(this.hypothesisWeights),
      hypothesisBoundVersion: this.hypothesisBoundVersion,
      activeParameterVersion: this.activeParameterVersion,
    })
  }
}

function freezeEvent(input: TwinEventInput): TwinEvent {
  return Object.freeze({
    eventId: input.eventId,
    eventType: input.eventType,
    source: input.source,
    studentRef: input.studentRef ?? null,
    occurredAt: input.occurredAt ?? null,
    observedAt: input.observedAt ?? null,
    payload: Object.freeze({ ...(input.payload ?? {}) }),
    provenance: input.provenance ?? '',
    modelVersions: Object.freeze({ ...(input.modelVersions ?? {}) }),
    schemaVersion: input.schemaVersion ?? SCHEMA_VERSION,
    consentScope: input.consentScope ?? 'unspecified',
  })
}

function validateEstimate(
  kcId: string,
  masteryMean: number,
  uncertainty: number,
  evidenceIds: readonly string[],
  exposureState: string,
): KnowledgeEstimate {
  if (!Number.isFinite(masteryMean) || masteryMean < 0 || masteryMean > 1) {
    throw new RangeError('masteryMean must be within [0, 1]')
  }
  if (!Number.isFinite(uncertainty) || uncertainty < 0) {
    throw new RangeError('uncertainty must be a finite number >= 0')
  }
  return Object.freeze({
    kcId,
    masteryMean,
    uncertainty,
    evidenceIds: Object.freeze([...evidenceIds]),
    exposureState,
  })
}

function cloneKnowledge(
  knowledge: ReadonlyMap<string, KnowledgeEstimate>,
): Map<string, KnowledgeEstimate> {
  return new Map(knowledge)
}

interface InferredState {
  knowledge: Map<string, KnowledgeEstimate>
  memory: Map<string, MemoryState>
  hypotheses: HypothesisSet | null
  unresolved: readonly string[]
  activeParameterVersion: string
  hypothesisRevision: number
}

function emptyInferredState(): InferredState {
  return {
    knowledge: new Map(),
    memory: new Map(),
    hypotheses: null,
    unresolved: Object.freeze([]),
    activeParameterVersion: BASELINE_PARAMETER_VERSION,
    hypothesisRevision: 0,
  }
}

function copyInferredState(state: InferredState): InferredState {
  return {
    knowledge: new Map(state.knowledge),
    memory: new Map(state.memory),
    hypotheses:
      state.hypotheses === null ? null : state.hypotheses.clone(),
    unresolved: Object.freeze([...state.unresolved]),
    activeParameterVersion: state.activeParameterVersion,
    hypothesisRevision: state.hypothesisRevision,
  }
}

/** Event-sourced, versioned, rollbackable long-term student twin. */
export class StudentTwin {
  readonly studentRef: string
  private readonly clock: () => string
  private readonly observedEvents: TwinEvent[] = []
  private readonly simulatedEvents: TwinEvent[] = []
  private readonly evidenceCursor = new Set<string>()
  private lastObservedAt: string | null = null
  private steps: InferenceStep[] = []
  private history: InferredState[] = [emptyInferredState()]
  private inferred: InferredState = emptyInferredState()
  private readonly checkpointsList: TwinCheckpoint[] = []
  private hypothesisBindingsList: HypothesisBinding[] = []
  private pending: PendingCalibration | null = null
  private active: CalibrationActivation | null = null

  constructor(studentRef: string, options: TwinOptions = {}) {
    if (typeof studentRef !== 'string' || studentRef.length === 0) {
      throw new TwinError('studentRef is required')
    }
    this.studentRef = studentRef
    this.clock =
      options.clock ?? (() => new Date().toISOString())
  }

  /** Version of the inferred state (number of committed steps). */
  get version(): number {
    return this.steps.length
  }

  /** Monotonic counter of real observations (used for freshness checks). */
  get evidenceRevision(): number {
    return this.observedEvents.length
  }

  get observedEvidenceIds(): ReadonlySet<string> {
    return new Set(this.evidenceCursor)
  }

  get activeParameterVersion(): string {
    return this.inferred.activeParameterVersion
  }

  get pendingCalibration(): PendingCalibration | null {
    return this.pending
  }

  get activeCalibration(): CalibrationActivation | null {
    return this.active
  }

  get hypotheses(): HypothesisSet | null {
    return this.inferred.hypotheses
  }

  get hypothesisBindings(): readonly HypothesisBinding[] {
    return Object.freeze([...this.hypothesisBindingsList])
  }

  get checkpoints(): readonly TwinCheckpoint[] {
    return Object.freeze([...this.checkpointsList])
  }

  get state(): TwinState {
    return Object.freeze({
      studentRef: this.studentRef,
      version: this.version,
      knowledge: new Map(this.inferred.knowledge),
      observedEvidenceIds: new Set(this.evidenceCursor),
      lastObservedAt: this.lastObservedAt,
      unresolvedHypotheses: Object.freeze([...this.inferred.unresolved]),
      memory: new Map(this.inferred.memory),
      hypothesisRevision: this.inferred.hypothesisRevision,
      activeParameterVersion: this.inferred.activeParameterVersion,
    })
  }

  /** Sanitized array projection for JSON/tool-adjacent use (unchanged shape). */
  snapshot(): TwinSnapshot {
    return Object.freeze({
      studentRef: this.studentRef,
      version: this.version,
      evidenceRevision: this.evidenceRevision,
      knowledge: Object.freeze(
        [...this.inferred.knowledge.values()].map((estimate) =>
          Object.freeze({
            ...estimate,
            evidenceIds: Object.freeze([...estimate.evidenceIds]),
          }),
        ),
      ),
      unresolvedHypotheses: Object.freeze([...this.inferred.unresolved]),
      lastObservedAt: this.lastObservedAt,
    })
  }

  observed(): readonly TwinEvent[] {
    return Object.freeze([...this.observedEvents])
  }

  simulated(): readonly TwinEvent[] {
    return Object.freeze([...this.simulatedEvents])
  }

  knowledgeFor(kcId: string): KnowledgeEstimate | undefined {
    return this.inferred.knowledge.get(kcId)
  }

  memoryFor(kcId: string): MemoryState | undefined {
    return this.inferred.memory.get(kcId)
  }

  memoryStates(): ReadonlyMap<string, MemoryState> {
    return new Map(this.inferred.memory)
  }

  /** Multi-KC long-term memory summary (Step 12). */
  memoryAggregate(
    now: string = this.clock(),
    options: { readonly targetRetention?: number } = {},
  ): Readonly<Record<string, unknown>> {
    return aggregateMemory([...this.inferred.memory.values()], now, {
      targetRetention: options.targetRetention,
      parameters: this.activeMemoryParameters(),
    })
  }

  // ------------------------------------------------------------------
  // Real evidence (append-only, immutable)
  // ------------------------------------------------------------------
  recordObserved(input: TwinEventInput): TwinEvent {
    const event = freezeEvent(input)
    if (SIMULATED_SOURCES.has(event.source)) {
      throw new SimulatedEventRejected(
        `simulated event ${JSON.stringify(event.eventId)} cannot write observed evidence`,
      )
    }
    if (!REAL_SOURCES.has(event.source)) {
      throw new UnknownEventSource(
        `unknown source ${JSON.stringify(event.source)} for event ${JSON.stringify(event.eventId)}`,
      )
    }
    if (event.studentRef !== null && event.studentRef !== this.studentRef) {
      throw new TwinError('event studentRef does not match twin studentRef')
    }
    if (this.observedEvents.some((existing) => existing.eventId === event.eventId)) {
      throw new TwinError(`duplicate event_id ${JSON.stringify(event.eventId)}`)
    }

    this.observedEvents.push(event)
    this.evidenceCursor.add(event.eventId)
    const stamp = event.observedAt ?? event.occurredAt
    if (
      stamp !== null &&
      (this.lastObservedAt === null || stamp > this.lastObservedAt)
    ) {
      this.lastObservedAt = stamp
    }
    return event
  }

  /** A student/teacher correction is a new event, not a history edit. */
  recordRealCorrection(input: TwinEventInput): TwinEvent {
    return this.recordObserved(input)
  }

  // ------------------------------------------------------------------
  // Simulated world (isolated)
  // ------------------------------------------------------------------
  recordSimulated(input: TwinEventInput): TwinEvent {
    const event = freezeEvent(input)
    if (!SIMULATED_SOURCES.has(event.source)) {
      throw new TwinError('recordSimulated requires a simulated source')
    }
    if (event.studentRef !== null && event.studentRef !== this.studentRef) {
      throw new TwinError('event studentRef does not match twin studentRef')
    }
    if (this.simulatedEvents.some((existing) => existing.eventId === event.eventId)) {
      throw new TwinError(
        `duplicate simulated event_id ${JSON.stringify(event.eventId)}`,
      )
    }
    this.simulatedEvents.push(event)
    return event
  }

  /** Raise if a simulation is based on an older revision than current state. */
  assertFreshSimulation(parentEvidenceRevision: number): void {
    if (parentEvidenceRevision < this.evidenceRevision) {
      throw new StaleSimulationError(
        `simulation parent revision ${parentEvidenceRevision} < current ${this.evidenceRevision}`,
      )
    }
  }

  /** Promotion is never automatic; simulated results cannot rewrite observed. */
  promoteSimulated(eventId: string): never {
    throw new SimulatedEventRejected(
      `simulated event ${JSON.stringify(eventId)} cannot be promoted into observed state`,
    )
  }

  // ------------------------------------------------------------------
  // Inferred state (versioned, checkpointed, replayable, rollbackable)
  // ------------------------------------------------------------------
  updateMastery(
    kcId: string,
    masteryMean: number,
    uncertainty: number,
    evidenceIds: readonly string[],
    exposureState = 'observed',
  ): KnowledgeEstimate {
    const evidence = this.requireObservedEvidence(evidenceIds)
    const estimate = validateEstimate(
      kcId,
      masteryMean,
      uncertainty,
      evidence,
      exposureState,
    )
    const newVersion = this.version + 1
    const update: MasteryUpdate = Object.freeze({
      kind: 'mastery',
      updateId: `upd_${newVersion}`,
      kcId,
      masteryMean,
      uncertainty,
      evidenceIds: Object.freeze([...evidence]),
      exposureState,
      version: newVersion,
    })
    const next = copyInferredState(this.inferred)
    next.knowledge.set(kcId, estimate)
    this.commit(update, next)
    return estimate
  }

  setUnresolvedHypotheses(hypothesisIds: readonly string[]): void {
    this.inferred.unresolved = Object.freeze([...hypothesisIds])
  }

  /** Apply one evidence-backed review to a KC's long-term memory. */
  recordMemoryReview(
    kcId: string,
    observation: MemoryObservationInput,
    evidenceIds: readonly string[],
    parameters?: MemoryParameters,
  ): MemoryState {
    const evidence = this.requireObservedEvidence(evidenceIds)
    const params = parameters ?? this.activeMemoryParameters()
    const previous =
      this.inferred.memory.get(kcId) ??
      normalizeMemoryState({
        learnerRef: this.studentRef,
        memoryUnitId: kcId,
        stabilityDays: params.initialStabilityDays,
        difficulty: params.initialDifficulty,
        modelVersion: params.parameterVersion,
      })
    const updated = updateMemory(previous, observation, params)
    if (updated === previous) {
      // Reading is not a retrieval event; no version and no state change.
      return previous
    }
    const newVersion = this.version + 1
    const step: MemoryUpdate = Object.freeze({
      kind: 'memory_review',
      updateId: `mem_${newVersion}`,
      kcId,
      observationId: observation.observationId,
      evidenceIds: Object.freeze([...evidence]),
      state: updated,
      version: newVersion,
    })
    const next = copyInferredState(this.inferred)
    next.memory.set(kcId, updated)
    this.commit(step, next)
    return updated
  }

  /**
   * Age every KC memory unit; never lowers stability or difficulty.
   *
   * Returns the sorted ids of the units that changed. A no-op does not bump the
   * twin version.
   */
  applyMemoryForgetting(
    now: string,
    options: { readonly targetRetention?: number } = {},
  ): readonly string[] {
    const params = this.activeMemoryParameters()
    const changed = new Map<string, MemoryState>()
    for (const [kcId, state] of this.inferred.memory) {
      const aged = applyForgetting(state, now, {
        targetRetention: options.targetRetention,
        parameters: params,
      })
      if (aged !== state) {
        changed.set(kcId, aged)
      }
    }
    if (changed.size === 0) {
      return Object.freeze([])
    }
    const newVersion = this.version + 1
    const step: MemoryDecayUpdate = Object.freeze({
      kind: 'memory_decay',
      updateId: `decay_${newVersion}`,
      states: changed,
      version: newVersion,
    })
    const next = copyInferredState(this.inferred)
    for (const [kcId, state] of changed) {
      next.memory.set(kcId, state)
    }
    this.commit(step, next)
    return Object.freeze([...changed.keys()].sort())
  }

  /** Bind an (already evolved) hypothesis set to a new twin version. */
  bindHypotheses(
    hypothesisSet: HypothesisSet,
    options: { readonly evidenceIds?: readonly string[] } = {},
  ): HypothesisBinding {
    if (!(hypothesisSet instanceof HypothesisSet)) {
      throw new HypothesisBindingError('bindHypotheses expects a HypothesisSet')
    }
    const evidence =
      options.evidenceIds !== undefined && options.evidenceIds.length > 0
        ? [...options.evidenceIds]
        : [...hypothesisSet.activeEvidenceRefs()].sort()
    if (evidence.length > 0) {
      this.requireObservedEvidence(evidence)
    }
    const working = hypothesisSet.clone()
    const newVersion = this.version + 1
    working.bindTwinVersion(newVersion)
    const binding = this.freezeBinding(working, evidence, newVersion)
    const next = copyInferredState(this.inferred)
    next.hypotheses = working
    next.unresolved = binding.unresolved
    next.hypothesisRevision = working.revision
    this.hypothesisBindingsList.push(binding)
    this.commit(binding, next)
    return binding
  }

  /** Apply one spawn/split/reweight/merge/prune and bind the result. */
  evolveHypotheses(operation: HypothesisOperationInput): HypothesisBinding {
    if (!(HYPOTHESIS_OPS as readonly string[]).includes(operation.kind)) {
      throw new HypothesisBindingError(
        `unknown hypothesis operation ${JSON.stringify(operation.kind)}`,
      )
    }
    const evidence = [...(operation.evidenceIds ?? [])]
    if (evidence.length > 0) {
      this.requireObservedEvidence(evidence)
    }
    if (this.inferred.hypotheses === null && operation.kind !== 'spawn') {
      throw new HypothesisBindingError(
        `hypothesis operation ${JSON.stringify(operation.kind)} requires a ` +
          'bound hypothesis set (spawn one or bind a set first)',
      )
    }
    const working =
      this.inferred.hypotheses === null
        ? new HypothesisSet()
        : this.inferred.hypotheses.clone()
    this.applyHypothesisOperation(working, operation, evidence)
    const newVersion = this.version + 1
    working.bindTwinVersion(newVersion)
    const binding = this.freezeBinding(working, evidence, newVersion)
    const next = copyInferredState(this.inferred)
    next.hypotheses = working
    next.unresolved = binding.unresolved
    next.hypothesisRevision = working.revision
    this.hypothesisBindingsList.push(binding)
    this.commit(binding, next)
    return binding
  }

  private freezeBinding(
    working: HypothesisSet,
    evidence: readonly string[],
    version: number,
  ): HypothesisBinding {
    return Object.freeze({
      kind: 'hypothesis_binding',
      bindingId: `hyp_${version}`,
      hypothesisRevision: working.revision,
      twinVersion: version,
      version,
      weights: Object.freeze({ ...working.weights() }),
      unresolved: Object.freeze(
        working
          .active()
          .map((hypothesis) => hypothesis.hypothesisId)
          .sort(),
      ),
      evidenceIds: Object.freeze([...evidence]),
      hypothesisSet: working,
      boundAt: this.clock(),
    })
  }

  private applyHypothesisOperation(
    working: HypothesisSet,
    operation: HypothesisOperationInput,
    evidence: readonly string[],
  ): void {
    switch (operation.kind) {
      case 'spawn':
        if (operation.hypothesis === undefined) {
          throw new HypothesisBindingError('spawn requires a hypothesis')
        }
        working.spawn(operation.hypothesis)
        return
      case 'split':
        if (operation.hypothesisId === undefined) {
          throw new HypothesisBindingError('split requires hypothesisId')
        }
        working.split(operation.hypothesisId, operation.children ?? [])
        return
      case 'reweight':
        working.reweight(operation.likelihoods ?? {}, {
          evidenceRef: evidence[0],
          noise: operation.noise,
          unknownPrior: operation.unknownPrior,
          unknownLikelihood: operation.unknownLikelihood,
        })
        return
      case 'merge':
        if (operation.merged === undefined) {
          throw new HypothesisBindingError('merge requires the merged hypothesis')
        }
        working.merge(operation.hypothesisIds ?? [], operation.merged)
        return
      case 'prune':
        if (operation.hypothesisId === undefined) {
          throw new HypothesisBindingError('prune requires hypothesisId')
        }
        working.prune(operation.hypothesisId, operation.reason ?? '')
        return
      default:
        throw new HypothesisBindingError(
          `unknown hypothesis operation ${JSON.stringify(operation.kind)}`,
        )
    }
  }

  // ------------------------------------------------------------------
  // Step 11 calibration candidate (pending until approved)
  // ------------------------------------------------------------------
  proposeMemoryCalibration(
    parameters: MemoryParameters | Readonly<Record<string, unknown>>,
    options: {
      readonly candidateId?: string
      readonly candidateVersion?: string
      readonly proposedBy?: string
      readonly fingerprint?: string
    } = {},
  ): PendingCalibration {
    let resolved: MemoryParameters
    if (parameters instanceof MemoryParameters) {
      resolved = parameters
    } else if (
      parameters !== null &&
      typeof parameters === 'object' &&
      !Array.isArray(parameters)
    ) {
      resolved = MemoryParameters.fromMapping(parameters)
    } else {
      throw new TwinError(
        'calibration parameters must be MemoryParameters or a mapping',
      )
    }
    const pending = Object.freeze({
      candidateId:
        options.candidateId !== undefined && options.candidateId.length > 0
          ? options.candidateId
          : `calibration.${this.studentRef}`,
      candidateVersion:
        options.candidateVersion !== undefined &&
        options.candidateVersion.length > 0
          ? options.candidateVersion
          : resolved.parameterVersion,
      parameters: resolved,
      proposedBy: options.proposedBy ?? '',
      proposedAt: this.clock(),
      fingerprint: options.fingerprint ?? '',
    })
    this.pending = pending
    return pending
  }

  /** Attach the parameter vector declared by a Step 11 `Candidate`. */
  proposeMemoryCalibrationFromCandidate(
    candidate: {
      readonly candidateId?: string
      readonly version?: string
      readonly changes?: Readonly<Record<string, unknown>>
    },
    options: { readonly proposedBy?: string } = {},
  ): PendingCalibration {
    const changes = candidate.changes
    if (changes === null || typeof changes !== 'object') {
      throw new TwinError('candidate must expose a changes mapping')
    }
    const raw = changes['parameters']
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TwinError("candidate changes must contain a 'parameters' mapping")
    }
    const version = changes['parameter_version']
    const parameters = MemoryParameters.fromMapping(
      raw as Readonly<Record<string, unknown>>,
      version === undefined || version === null ? undefined : String(version),
    )
    return this.proposeMemoryCalibration(parameters, {
      candidateId: candidate.candidateId ?? '',
      candidateVersion: candidate.version ?? '',
      proposedBy: options.proposedBy ?? '',
      fingerprint:
        typeof changes['report_fingerprint'] === 'string'
          ? (changes['report_fingerprint'] as string)
          : '',
    })
  }

  activateMemoryCalibration(input: {
    readonly approvalId: string
    readonly approvedBy: string
    readonly activatedAt?: string
  }): CalibrationActivation {
    if (this.pending === null) {
      throw new TwinError('no pending calibration candidate to activate')
    }
    if (!input.approvalId || !input.approvedBy) {
      throw new CalibrationApprovalRequired(
        'calibration activation requires an explicit approval id and actor',
      )
    }
    const pending = this.pending
    const parameters = pending.parameters
    const newVersion = this.version + 1
    const activation: CalibrationActivation = Object.freeze({
      kind: 'activate',
      activationId: `cal_${newVersion}`,
      candidateId: pending.candidateId,
      candidateVersion: pending.candidateVersion,
      parameterVersion: parameters.parameterVersion,
      values: Object.freeze(parameters.valueDict()),
      approvalId: input.approvalId,
      approvedBy: input.approvedBy,
      previousParameterVersion: this.inferred.activeParameterVersion,
      activatedAt: input.activatedAt ?? this.clock(),
      version: newVersion,
    })
    const next = copyInferredState(this.inferred)
    next.activeParameterVersion = parameters.parameterVersion
    this.active = activation
    this.pending = null
    this.commit(activation, next)
    return activation
  }

  rejectMemoryCalibration(reason = ''): PendingCalibration | null {
    const pending = this.pending
    this.pending = null
    void reason
    return pending
  }

  /** Restore the previous stable parameter version (explicit approval). */
  rollbackMemoryCalibration(input: {
    readonly approvalId: string
    readonly approvedBy: string
    readonly reason?: string
    readonly rolledBackAt?: string
  }): CalibrationActivation {
    const active = this.active
    if (active === null) {
      throw new TwinError('no active calibration to roll back')
    }
    if (!input.approvalId || !input.approvedBy) {
      throw new CalibrationApprovalRequired(
        'calibration rollback requires an explicit approval id and actor',
      )
    }
    const newVersion = this.version + 1
    const rollback: CalibrationActivation = Object.freeze({
      kind: 'rollback',
      activationId: `cal_${newVersion}`,
      candidateId: active.candidateId,
      candidateVersion: active.candidateVersion,
      parameterVersion: active.previousParameterVersion,
      values: Object.freeze({}),
      approvalId: input.approvalId,
      approvedBy: input.approvedBy,
      previousParameterVersion: active.parameterVersion,
      activatedAt: input.rolledBackAt ?? this.clock(),
      version: newVersion,
    })
    const next = copyInferredState(this.inferred)
    next.activeParameterVersion = active.previousParameterVersion
    this.active = null
    this.commit(rollback, next)
    return rollback
  }

  // ------------------------------------------------------------------
  // Replay / rebuild / checkpoints / rollback
  // ------------------------------------------------------------------
  rebuild(): TwinState {
    let state = emptyInferredState()
    for (const step of this.steps) {
      state = this.applyStep(state, step, true)
    }
    this.install(state)
    this.recomputeActiveCalibration()
    return this.state
  }

  /** Alias for `rebuild`: deterministic event-sourcing replay. */
  replay(): TwinState {
    return this.rebuild()
  }

  createCheckpoint(
    label = '',
    options: CreateCheckpointOptions = {},
  ): TwinCheckpoint {
    const checkpoint = new TwinCheckpoint({
      checkpointId: `ckpt_${this.checkpointsList.length + 1}`,
      label,
      version: this.version,
      evidenceRevision: this.evidenceRevision,
      createdAt: options.createdAt ?? this.clock(),
      knowledge: new Map(this.inferred.knowledge),
      memory: new Map(this.inferred.memory),
      observedEvidenceIds: new Set(this.evidenceCursor),
      lastObservedAt: this.lastObservedAt,
      unresolvedHypotheses: this.inferred.unresolved,
      hypothesisRevision: this.inferred.hypothesisRevision,
      hypothesisWeights:
        this.inferred.hypotheses === null
          ? {}
          : { ...this.inferred.hypotheses.weights() },
      hypothesisBoundVersion:
        this.inferred.hypotheses === null
          ? null
          : this.inferred.hypotheses.boundTwinVersion,
      activeParameterVersion: this.inferred.activeParameterVersion,
    })
    this.checkpointsList.push(checkpoint)
    return checkpoint
  }

  restoreCheckpoint(checkpointId: string): TwinState {
    const checkpoint = this.checkpointsList.find(
      (item) => item.checkpointId === checkpointId,
    )
    if (checkpoint === undefined) {
      throw new CheckpointNotFoundError(
        `unknown checkpoint ${JSON.stringify(checkpointId)}`,
      )
    }
    return this.rollback(checkpoint.version)
  }

  rollback(version: number): TwinState {
    if (
      !Number.isInteger(version) ||
      version < 0 ||
      version > this.version
    ) {
      throw new VersionNotFoundError(`unknown twin version ${version}`)
    }
    this.steps = this.steps.filter((step) => step.version <= version)
    this.history = this.history.slice(0, version + 1)
    this.hypothesisBindingsList = this.hypothesisBindingsList.filter(
      (binding) => binding.twinVersion <= version,
    )
    const target = this.history[version] as InferredState
    this.install(copyInferredState(target))
    this.recomputeActiveCalibration()
    return this.state
  }

  /** The current inferred state (backwards-compatible read projection). */
  snapshotState(): TwinState {
    return this.state
  }

  checkpointDicts(): readonly Readonly<Record<string, unknown>>[] {
    return Object.freeze(
      this.checkpointsList.map((checkpoint) => checkpoint.asDict()),
    )
  }

  // ------------------------------------------------------------------
  // Serialization helpers (still no external dependencies)
  // ------------------------------------------------------------------
  exportObservedEventIds(): readonly string[] {
    return Object.freeze(this.observedEvents.map((event) => event.eventId))
  }

  /** A JSON-friendly projection of the inference log (opaque ids only). */
  exportInferenceSteps(): readonly Readonly<Record<string, unknown>>[] {
    const exported: Readonly<Record<string, unknown>>[] = []
    for (const step of this.steps) {
      switch (step.kind) {
        case 'mastery':
          exported.push(
            Object.freeze({
              kind: 'mastery',
              version: step.version,
              kcId: step.kcId,
              evidenceIds: Object.freeze([...step.evidenceIds]),
            }),
          )
          break
        case 'memory_review':
          exported.push(
            Object.freeze({
              kind: 'memory_review',
              version: step.version,
              kcId: step.kcId,
              evidenceIds: Object.freeze([...step.evidenceIds]),
            }),
          )
          break
        case 'memory_decay':
          exported.push(
            Object.freeze({
              kind: 'memory_decay',
              version: step.version,
              kcIds: Object.freeze([...step.states.keys()].sort()),
            }),
          )
          break
        case 'activate':
        case 'rollback':
          exported.push(
            Object.freeze({
              kind: `calibration_${step.kind}`,
              version: step.version,
              parameterVersion: step.parameterVersion,
            }),
          )
          break
        case 'hypothesis_binding':
          exported.push(
            Object.freeze({
              kind: 'hypothesis_binding',
              version: step.version,
              hypothesisRevision: step.hypothesisRevision,
            }),
          )
          break
        default:
          throw new TwinError('unknown inference step')
      }
    }
    return Object.freeze(exported)
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------
  private requireObservedEvidence(
    evidenceIds: readonly string[],
  ): readonly string[] {
    if (evidenceIds.length === 0) {
      throw new MissingEvidenceError(
        'an inferred update needs at least one observed evidence id',
      )
    }
    const unknown = evidenceIds.filter(
      (evidenceId) => !this.evidenceCursor.has(evidenceId),
    )
    if (unknown.length > 0) {
      throw new MissingEvidenceError(
        `update references non-observed evidence: ${unknown.join(', ')}`,
      )
    }
    return Object.freeze([...evidenceIds])
  }

  private activeMemoryParameters(): MemoryParameters {
    const active = this.active
    if (active === null || Object.keys(active.values).length === 0) {
      return MemoryParameters.baseline()
    }
    return MemoryParameters.fromMapping(active.values, active.parameterVersion)
  }

  private recomputeActiveCalibration(): void {
    let active: CalibrationActivation | null = null
    for (const step of this.steps) {
      if (step.kind === 'activate' || step.kind === 'rollback') {
        active = step.kind === 'activate' ? step : null
      }
    }
    this.active = active
  }

  private commit(step: InferenceStep, nextState: InferredState): void {
    this.steps.push(step)
    this.history.push(copyInferredState(nextState))
    this.install(nextState)
  }

  private install(state: InferredState): void {
    this.inferred = state
  }

  private applyStep(
    state: InferredState,
    step: InferenceStep,
    replay: boolean,
  ): InferredState {
    switch (step.kind) {
      case 'mastery':
        if (replay) {
          for (const evidenceId of step.evidenceIds) {
            if (!this.evidenceCursor.has(evidenceId)) {
              throw new MissingEvidenceError(
                `update ${JSON.stringify(step.updateId)} references missing evidence`,
              )
            }
          }
        }
        state.knowledge.set(
          step.kcId,
          validateEstimate(
            step.kcId,
            step.masteryMean,
            step.uncertainty,
            step.evidenceIds,
            step.exposureState,
          ),
        )
        break
      case 'memory_review':
        if (replay) {
          for (const evidenceId of step.evidenceIds) {
            if (!this.evidenceCursor.has(evidenceId)) {
              throw new MissingEvidenceError(
                `memory update ${JSON.stringify(step.updateId)} references missing evidence`,
              )
            }
          }
        }
        state.memory.set(step.kcId, step.state)
        break
      case 'memory_decay':
        for (const [kcId, memoryState] of step.states) {
          state.memory.set(kcId, memoryState)
        }
        break
      case 'activate':
      case 'rollback':
        state.activeParameterVersion = step.parameterVersion
        break
      case 'hypothesis_binding':
        state.hypotheses =
          step.hypothesisSet === null ? null : step.hypothesisSet.clone()
        state.unresolved = Object.freeze([...step.unresolved])
        state.hypothesisRevision = step.hypothesisRevision
        break
      default:
        throw new TwinError('unknown inference step')
    }
    return state
  }
}
