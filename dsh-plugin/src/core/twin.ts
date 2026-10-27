/**
 * Long-term student twin with event sourcing (spec section 5).
 *
 * This is the host-owned part of the plugin. It is deliberately **not** exposed
 * as a model-facing write tool in the default profile:
 *
 * - real observations are append-only and immutable; a correction is a new
 *   event, never an edit or a delete;
 * - simulated events live in a separate store and can never write observed
 *   evidence or mastery;
 * - every mastery update must reference observed evidence ids that exist;
 * - inferred state is versioned and rollbackable while evidence stays intact.
 *
 * The dsh host is expected to persist these events in a Profile/Bundle store and
 * to attest the source (`teacher`, `trusted_grader`, ...). The in-memory class
 * here is the reference implementation used by host adapters and tests.
 */

import {
  TwinError,
  type KnowledgeEstimate,
  type TwinSnapshot,
} from '../domain.ts'

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

export class SimulatedEventRejected extends TwinError {}
export class UnknownEventSource extends TwinError {}
export class MissingEvidenceError extends TwinError {}
export class StaleSimulationError extends TwinError {}
export class VersionNotFoundError extends TwinError {}

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
}

export interface MasteryUpdate {
  readonly updateId: string
  readonly kcId: string
  readonly masteryMean: number
  readonly uncertainty: number
  readonly evidenceIds: readonly string[]
  readonly exposureState: string
  readonly version: number
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

/** Event-sourced, versioned, rollbackable long-term student twin. */
export class StudentTwin {
  readonly studentRef: string
  private readonly observedEvents: TwinEvent[] = []
  private readonly simulatedEvents: TwinEvent[] = []
  private updates: MasteryUpdate[] = []
  private readonly evidenceCursor = new Set<string>()
  private lastObservedAt: string | null = null
  private knowledge = new Map<string, KnowledgeEstimate>()
  private history: Array<Map<string, KnowledgeEstimate>> = [new Map()]
  private unresolved: readonly string[] = []

  constructor(studentRef: string) {
    if (typeof studentRef !== 'string' || studentRef.length === 0) {
      throw new TwinError('studentRef is required')
    }
    this.studentRef = studentRef
  }

  /** Version of the inferred state (number of committed updates). */
  get version(): number {
    return this.updates.length
  }

  /** Monotonic counter of real observations (used for freshness checks). */
  get evidenceRevision(): number {
    return this.observedEvents.length
  }

  get observedEvidenceIds(): ReadonlySet<string> {
    return new Set(this.evidenceCursor)
  }

  get state(): TwinState {
    return Object.freeze({
      studentRef: this.studentRef,
      version: this.version,
      knowledge: new Map(this.knowledge),
      observedEvidenceIds: new Set(this.evidenceCursor),
      lastObservedAt: this.lastObservedAt,
      unresolvedHypotheses: Object.freeze([...this.unresolved]),
    })
  }

  /** Sanitized array projection for JSON/tool-adjacent use. */
  snapshot(): TwinSnapshot {
    return Object.freeze({
      studentRef: this.studentRef,
      version: this.version,
      evidenceRevision: this.evidenceRevision,
      knowledge: Object.freeze(
        [...this.knowledge.values()].map((estimate) =>
          Object.freeze({
            ...estimate,
            evidenceIds: Object.freeze([...estimate.evidenceIds]),
          }),
        ),
      ),
      unresolvedHypotheses: Object.freeze([...this.unresolved]),
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
    return this.knowledge.get(kcId)
  }

  /** Append a real event to the immutable evidence log. */
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

  /** Store a simulated event in the isolated simulated store. */
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

  /** Apply an inferred mastery update backed by observed evidence ids. */
  updateMastery(
    kcId: string,
    masteryMean: number,
    uncertainty: number,
    evidenceIds: readonly string[],
    exposureState = 'observed',
  ): KnowledgeEstimate {
    if (evidenceIds.length === 0) {
      throw new MissingEvidenceError(
        'mastery update needs at least one evidence id',
      )
    }
    const unknown = evidenceIds.filter(
      (evidenceId) => !this.evidenceCursor.has(evidenceId),
    )
    if (unknown.length > 0) {
      throw new MissingEvidenceError(
        `mastery update references non-observed evidence: ${unknown.join(', ')}`,
      )
    }
    const estimate = validateEstimate(
      kcId,
      masteryMean,
      uncertainty,
      evidenceIds,
      exposureState,
    )
    const update: MasteryUpdate = Object.freeze({
      updateId: `upd_${this.version + 1}`,
      kcId,
      masteryMean,
      uncertainty,
      evidenceIds: Object.freeze([...evidenceIds]),
      exposureState,
      version: this.version + 1,
    })
    this.updates.push(update)
    this.knowledge.set(kcId, estimate)
    this.history.push(cloneKnowledge(this.knowledge))
    return estimate
  }

  setUnresolvedHypotheses(hypothesisIds: readonly string[]): void {
    this.unresolved = Object.freeze([...hypothesisIds])
  }

  /** Recompute inferred state from the observed log + inference log. */
  rebuild(): TwinState {
    const knowledge = new Map<string, KnowledgeEstimate>()
    for (const update of this.updates) {
      // Evidence validity is re-checked so rebuild can never invent it.
      if (update.evidenceIds.some((id) => !this.evidenceCursor.has(id))) {
        throw new MissingEvidenceError(
          `update ${JSON.stringify(update.updateId)} references missing evidence`,
        )
      }
      knowledge.set(
        update.kcId,
        validateEstimate(
          update.kcId,
          update.masteryMean,
          update.uncertainty,
          update.evidenceIds,
          update.exposureState,
        ),
      )
    }
    this.knowledge = knowledge
    return this.state
  }

  /** Restore inferred knowledge at `version`; real evidence is untouched. */
  rollback(version: number): TwinState {
    if (!Number.isInteger(version) || version < 0 || version >= this.history.length) {
      throw new VersionNotFoundError(`unknown twin version ${version}`)
    }
    this.updates = this.updates.filter((update) => update.version <= version)
    // Discard the rolled-back branch so a later update starts a new branch.
    this.history = this.history.slice(0, version + 1)
    this.knowledge = cloneKnowledge(this.history[version])
    return this.state
  }

  exportObservedEventIds(): readonly string[] {
    return Object.freeze(this.observedEvents.map((event) => event.eventId))
  }
}
