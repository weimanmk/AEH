/**
 * Host-owned, in-memory twin adapter (synthetic/test only).
 *
 * `StudentTwin` already owns event sourcing and evidence binding. This adapter
 * adds the host obligations the model-facing plugin must not perform itself:
 *
 * - source authentication through an injected `verifyAttestation` verifier;
 * - consent-scoped writes (`twin:observe`, `twin:simulate`, `twin:rollback`);
 * - idempotent appends keyed by `eventId` (a replay returns the original event);
 * - an append-only audit log with no raw payloads;
 * - a hard separation between observed and simulated stores.
 *
 * `verifyAttestation` is deliberately a seam: this in-memory implementation is
 * **not** cryptography and must not be presented as production source
 * authentication. A real host verifies a signed attestation/KMS token or an
 * authenticated teacher/grader session before returning `true`.
 */

import {
  REAL_SOURCES,
  SIMULATED_SOURCES,
  StudentTwin,
  type TwinEvent,
  type TwinEventInput,
  type TwinState,
} from '../core/twin.ts'
import {
  SimulatedEventRejected,
  UnknownEventSource,
  VersionNotFoundError,
} from '../core/twin.ts'
import type { KnowledgeEstimate } from '../domain.ts'
import type { ConsentSnapshot } from './consent.ts'

export interface SourceAttestation {
  /** Host-owned verifier identity, e.g. `test.school-gateway`. */
  readonly issuer: string
  /** Must equal the event source; a teacher token cannot sign a student event. */
  readonly source: string
  /** Must equal the twin's student reference. */
  readonly subjectRef: string
  /** ISO timestamp of attestation issuance. */
  readonly issuedAt: string
  /** Opaque host token. Never logged; production verifies its signature. */
  readonly token?: string
}

export type AttestationVerifier = (
  attestation: SourceAttestation,
  event: TwinEventInput,
) => boolean

export type AuditAction =
  | 'observed.append'
  | 'observed.replay'
  | 'simulated.append'
  | 'simulated.replay'
  | 'mastery.update'
  | 'rollback'
  | 'auth.reject'
  | 'consent.reject'
  | 'idempotency.conflict'

export interface HostAuditEntry {
  readonly seq: number
  readonly at: string
  readonly action: AuditAction
  readonly outcome: 'accepted' | 'rejected'
  readonly subjectRef: string
  /** Only opaque ids, counts, versions, and reason codes; never raw answers. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
}

export interface TwinAppendResult {
  readonly event: TwinEvent
  /** True when this was an idempotent replay, not a new append. */
  readonly replayed: boolean
}

export interface TwinRollbackResult {
  readonly state: TwinState
  readonly fromVersion: number
  readonly toVersion: number
}

export interface MemoryHostTwinOptions {
  readonly verifyAttestation: AttestationVerifier
  readonly consent: ConsentSnapshot
  /** Injectable clock for deterministic audits. */
  readonly now?: () => string
}

export class IdempotencyConflictError extends Error {
  readonly code = 'AEH_IDEMPOTENCY_CONFLICT'

  constructor(message: string) {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

function eventFingerprint(event: TwinEventInput): string {
  return canonical({
    eventId: event.eventId,
    eventType: event.eventType,
    source: event.source,
    studentRef: event.studentRef ?? null,
    occurredAt: event.occurredAt ?? null,
    observedAt: event.observedAt ?? null,
    payload: event.payload ?? {},
    provenance: event.provenance ?? '',
    modelVersions: event.modelVersions ?? {},
    schemaVersion: event.schemaVersion ?? 'aeh-event-v1',
    consentScope: event.consentScope ?? 'unspecified',
  })
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} is required`)
  }
  return value
}

/** Event-sourced host twin with authentication, idempotency, and audit. */
export class MemoryHostTwin {
  readonly studentRef: string
  private readonly twin: StudentTwin
  private readonly verifyAttestation: AttestationVerifier
  private readonly consent: ConsentSnapshot
  private readonly now: () => string
  private readonly observedFingerprints = new Map<string, string>()
  private readonly simulatedFingerprints = new Map<string, string>()
  private readonly auditEntries: HostAuditEntry[] = []
  private auditSeq = 0

  constructor(studentRef: string, options: MemoryHostTwinOptions) {
    this.studentRef = nonEmpty(studentRef, 'studentRef')
    this.twin = new StudentTwin(this.studentRef)
    this.verifyAttestation = options.verifyAttestation
    this.consent = options.consent
    this.now = options.now ?? (() => new Date().toISOString())
  }

  get version(): number {
    return this.twin.version
  }

  get evidenceRevision(): number {
    return this.twin.evidenceRevision
  }

  observed(): readonly TwinEvent[] {
    return this.twin.observed()
  }

  simulated(): readonly TwinEvent[] {
    return this.twin.simulated()
  }

  audit(action?: AuditAction): readonly HostAuditEntry[] {
    const entries =
      action === undefined
        ? this.auditEntries
        : this.auditEntries.filter((entry) => entry.action === action)
    return Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          ...entry,
          detail: Object.freeze({ ...entry.detail }),
        }),
      ),
    )
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      studentRef: this.studentRef,
      version: this.twin.version,
      evidenceRevision: this.twin.evidenceRevision,
      observedEventIds: Object.freeze(this.twin.exportObservedEventIds()),
      simulatedEventIds: Object.freeze(
        this.twin.simulated().map((event) => event.eventId),
      ),
      knowledge: this.twin.snapshot().knowledge,
      auditHead: this.auditEntries.length,
    })
  }

  /**
   * Authenticate then append one real observation.
   *
   * Authentication runs before idempotency: replaying a known id with an
   * invalid attestation is rejected, not treated as a harmless duplicate.
   */
  appendObserved(
    input: TwinEventInput,
    attestation: SourceAttestation,
  ): TwinAppendResult {
    this.requireConsent('twin:observe', input, 'observed.append')
    if (SIMULATED_SOURCES.has(input.source)) {
      this.record('auth.reject', 'rejected', input, {
        reason: 'simulated_source',
      })
      throw new SimulatedEventRejected(
        `simulated event ${JSON.stringify(input.eventId)} cannot write observed evidence`,
      )
    }
    if (!REAL_SOURCES.has(input.source)) {
      this.record('auth.reject', 'rejected', input, {
        reason: 'unknown_source',
      })
      throw new UnknownEventSource(
        `unknown source ${JSON.stringify(input.source)} for event ${JSON.stringify(input.eventId)}`,
      )
    }
    if (
      attestation.source !== input.source ||
      attestation.subjectRef !== this.studentRef ||
      nonEmpty(attestation.issuer, 'attestation.issuer').length === 0 ||
      !Number.isFinite(Date.parse(attestation.issuedAt))
    ) {
      this.record('auth.reject', 'rejected', input, {
        reason: 'attestation_mismatch',
      })
      throw new Error('source attestation does not match the event subject/source')
    }
    if (!this.verifyAttestation(attestation, input)) {
      this.record('auth.reject', 'rejected', input, {
        reason: 'attestation_unverified',
      })
      throw new Error('source attestation was not verified by the host')
    }

    const fingerprint = eventFingerprint(input)
    const existing = this.observedFingerprints.get(input.eventId)
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        this.record('idempotency.conflict', 'rejected', input, {
          reason: 'observed_event_id_reused',
        })
        throw new IdempotencyConflictError(
          `observed event id ${JSON.stringify(input.eventId)} was reused with different content`,
        )
      }
      const event = this.twin
        .observed()
        .find((candidate) => candidate.eventId === input.eventId)
      if (event === undefined) {
        throw new Error('idempotency index references a missing event')
      }
      this.record('observed.replay', 'accepted', input, {
        eventId: event.eventId,
        evidenceRevision: this.twin.evidenceRevision,
      })
      return Object.freeze({ event, replayed: true })
    }

    const event = this.twin.recordObserved(input)
    this.observedFingerprints.set(event.eventId, fingerprint)
    this.record('observed.append', 'accepted', input, {
      eventId: event.eventId,
      source: event.source,
      evidenceRevision: this.twin.evidenceRevision,
    })
    return Object.freeze({ event, replayed: false })
  }

  /** Append to the isolated simulation store; this can never touch observed state. */
  appendSimulated(input: TwinEventInput): TwinAppendResult {
    this.requireConsent('twin:simulate', input, 'simulated.append')
    if (!SIMULATED_SOURCES.has(input.source)) {
      this.record('auth.reject', 'rejected', input, {
        reason: 'not_a_simulated_source',
      })
      throw new SimulatedEventRejected(
        'simulated append requires a simulated source',
      )
    }

    const fingerprint = eventFingerprint(input)
    const existing = this.simulatedFingerprints.get(input.eventId)
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        this.record('idempotency.conflict', 'rejected', input, {
          reason: 'simulated_event_id_reused',
        })
        throw new IdempotencyConflictError(
          `simulated event id ${JSON.stringify(input.eventId)} was reused with different content`,
        )
      }
      const event = this.twin
        .simulated()
        .find((candidate) => candidate.eventId === input.eventId)
      if (event === undefined) {
        throw new Error('idempotency index references a missing event')
      }
      this.record('simulated.replay', 'accepted', input, {
        eventId: event.eventId,
      })
      return Object.freeze({ event, replayed: true })
    }

    const event = this.twin.recordSimulated(input)
    this.simulatedFingerprints.set(event.eventId, fingerprint)
    this.record('simulated.append', 'accepted', input, {
      eventId: event.eventId,
      source: event.source,
    })
    return Object.freeze({ event, replayed: false })
  }

  /** Apply an inferred update; observed evidence ids are checked by StudentTwin. */
  updateMastery(
    kcId: string,
    masteryMean: number,
    uncertainty: number,
    evidenceIds: readonly string[],
  ): KnowledgeEstimate {
    this.requireConsent('twin:observe', undefined, 'mastery.update')
    try {
      const estimate = this.twin.updateMastery(
        kcId,
        masteryMean,
        uncertainty,
        evidenceIds,
      )
      this.record('mastery.update', 'accepted', undefined, {
        kcId,
        version: this.twin.version,
        evidenceCount: evidenceIds.length,
      })
      return estimate
    } catch (error) {
      this.record('mastery.update', 'rejected', undefined, {
        kcId,
        reason: error instanceof Error ? error.name : 'unknown_error',
      })
      throw error
    }
  }

  /** Restore inferred knowledge at a version; the observed log is untouched. */
  rollback(version: number): TwinRollbackResult {
    this.requireConsent('twin:rollback', undefined, 'rollback')
    const fromVersion = this.twin.version
    try {
      const state = this.twin.rollback(version)
      this.record('rollback', 'accepted', undefined, {
        fromVersion,
        toVersion: version,
        evidenceRevision: this.twin.evidenceRevision,
      })
      return Object.freeze({ state, fromVersion, toVersion: version })
    } catch (error) {
      this.record('rollback', 'rejected', undefined, {
        fromVersion,
        toVersion: version,
        reason:
          error instanceof VersionNotFoundError
            ? 'version_not_found'
            : error instanceof Error
              ? error.name
              : 'unknown_error',
      })
      throw error
    }
  }

  /** Simulated results can never be promoted into observed state. */
  promoteSimulated(eventId: string): never {
    this.record('auth.reject', 'rejected', undefined, {
      eventId,
      reason: 'promotion_forbidden',
    })
    return this.twin.promoteSimulated(eventId)
  }

  private requireConsent(
    scope: 'twin:observe' | 'twin:simulate' | 'twin:rollback',
    input: TwinEventInput | undefined,
    action: AuditAction,
  ): void {
    if (!this.consent.has(scope)) {
      this.record('consent.reject', 'rejected', input, {
        scope,
        requestedAction: action,
      })
      throw new Error(`consent scope ${JSON.stringify(scope)} is not active`)
    }
  }

  private record(
    action: AuditAction,
    outcome: HostAuditEntry['outcome'],
    input: TwinEventInput | undefined,
    detail: HostAuditEntry['detail'],
  ): void {
    this.auditEntries.push(
      Object.freeze({
        seq: ++this.auditSeq,
        at: this.now(),
        action,
        outcome,
        subjectRef: this.studentRef,
        detail: Object.freeze({ ...detail }),
      }),
    )
  }
}
