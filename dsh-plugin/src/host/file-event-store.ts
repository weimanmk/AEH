/**
 * File-backed host event store (synthetic/test only, disabled by default).
 *
 * This is the minimal persistence model layered on top of the Step 4 in-memory
 * `MemoryHostTwin`. It is deliberately a **host-side adapter**, never a
 * model-facing tool, and it is **off unless explicitly enabled**:
 *
 * - writes require `enabled: true` and an active `twin:observe` consent scope;
 * - the directory must live under a caller-declared synthetic root and the
 *   student reference must be synthetic (`synthetic.*` / `demo.*`), so the store
 *   cannot be pointed at production data or `~/.dsh`;
 * - events are persisted append-only to `events.jsonl`; a replayed `eventId`
 *   returns the original event and appends nothing (idempotent);
 * - only opaque identifiers and counters are persisted. The host twin's opaque
 *   `payload` is intentionally **not** written, so a raw question/answer/image
 *   in a payload is never duplicated into this store;
 * - retention and consent withdrawal are modelled as append-only tombstones in
 *   `tombstones.jsonl`, so the deletion history itself stays auditable;
 * - after `twin:observe` is withdrawn, reads throw and deletion propagation
 *   tombstones every persisted event;
 * - inferred state remains versioned/rollbackable through the in-memory twin;
 *   the observed evidence log is never rewritten.
 *
 * The record checksum is an integrity check against accidental corruption; it
 * is **not** a signature or a KMS-attested source proof. A production store
 * needs encryption, real attestation, transactional writes, and cross-service
 * deletion propagation.
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  MemoryHostTwin,
  type AttestationVerifier,
  type SourceAttestation,
  type TwinAppendResult,
} from './twin-adapter.ts'
import type { ConsentScope, ConsentSnapshot } from './consent.ts'
import { REAL_SOURCES, type TwinEventInput } from '../core/twin.ts'

export class FileEventStoreDisabledError extends Error {
  readonly code = 'AEH_FILE_STORE_DISABLED'
  constructor(message: string) {
    super(message)
    this.name = 'FileEventStoreDisabledError'
  }
}

export class FileStoreConsentError extends Error {
  readonly code = 'AEH_FILE_STORE_CONSENT_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'FileStoreConsentError'
  }
}

export class FileEventStoreIntegrityError extends Error {
  readonly code = 'AEH_FILE_STORE_INTEGRITY'
  constructor(message: string) {
    super(message)
    this.name = 'FileEventStoreIntegrityError'
  }
}

export class FileEventStoreConfigError extends Error {
  readonly code = 'AEH_FILE_STORE_CONFIG'
  constructor(message: string) {
    super(message)
    this.name = 'FileEventStoreConfigError'
  }
}

/** Persisted record; contains no raw payload and no raw learning-event id. */
export interface PersistedEventRecord {
  readonly seq: number
  /** Opaque dedup key carried by the host event. */
  readonly eventRef: string
  readonly eventType: string
  readonly source: string
  readonly studentRef: string
  readonly occurredAt: string | null
  readonly observedAt: string | null
  readonly consentScope: string
  readonly schemaVersion: string
  readonly checksum: string
}

export interface DeletionTombstone {
  readonly seq: number
  readonly eventRef: string
  readonly reason: string
  readonly consentScope: string | null
  readonly at: string
}

export interface FileEventStoreOptions {
  readonly studentRef: string
  readonly directory: string
  /** Path containment root; `directory` must be inside it. */
  readonly syntheticRoot: string
  readonly consent: ConsentSnapshot
  readonly verifyAttestation: AttestationVerifier
  /** Defaults to false: the store is inert until the host opts in. */
  readonly enabled?: boolean
  /** Retention in days; defaults to 30. Non-positive means "keep". */
  readonly retentionDays?: number
  readonly now?: () => string
}

const RESTORE_ISSUER = 'aeh.file-store.restore'
const SYNTHETIC_REF_RE = /^(synthetic|demo)\./

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

function checksumFor(record: Omit<PersistedEventRecord, 'checksum'>): string {
  return createHash('sha256').update(canonical(record)).digest('hex')
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function parseIso(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return null
  }
  return value
}

/**
 * Append-only file event store with idempotency, retention tombstones, and
 * consent-withdrawal deletion propagation.
 */
export class FileEventStore {
  readonly studentRef: string
  readonly directory: string
  readonly enabled: boolean
  readonly retentionDays: number
  private readonly consent: ConsentSnapshot
  private readonly now: () => string
  private readonly twin: MemoryHostTwin
  private readonly eventsPath: string
  private readonly tombstonesPath: string
  private readonly records = new Map<string, PersistedEventRecord>()
  private readonly tombstones = new Map<string, DeletionTombstone>()
  private readonly restoreChecksums = new Map<string, string>()
  private seq = 0
  private tombstoneSeq = 0

  constructor(options: FileEventStoreOptions) {
    if (typeof options.studentRef !== 'string' || !SYNTHETIC_REF_RE.test(options.studentRef)) {
      throw new FileEventStoreConfigError(
        'FileEventStore only accepts synthetic student references',
      )
    }
    if (!isInside(options.syntheticRoot, options.directory)) {
      throw new FileEventStoreConfigError(
        'FileEventStore directory must stay inside the synthetic root',
      )
    }
    this.studentRef = options.studentRef
    this.directory = resolve(options.directory)
    this.enabled = options.enabled === true
    this.retentionDays = options.retentionDays ?? 30
    this.consent = options.consent
    this.now = options.now ?? (() => new Date().toISOString())
    this.eventsPath = join(this.directory, 'events.jsonl')
    this.tombstonesPath = join(this.directory, 'tombstones.jsonl')

    const userVerify = options.verifyAttestation
    this.twin = new MemoryHostTwin(this.studentRef, {
      consent: this.consent,
      now: this.now,
      verifyAttestation: (attestation, event) => {
        if (attestation.issuer === RESTORE_ISSUER) {
          return this.restoreChecksums.get(event.eventId) === attestation.token
        }
        return userVerify(attestation, event)
      },
    })
  }

  get version(): number {
    return this.twin.version
  }

  get evidenceRevision(): number {
    return this.twin.evidenceRevision
  }

  audit() {
    return this.twin.audit()
  }

  /**
   * Append one authenticated observed event, persisting it unless it is an
   * idempotent replay.
   */
  append(input: TwinEventInput, attestation: SourceAttestation): TwinAppendResult {
    this.requireEnabled()
    this.requireReadConsent()
    const subject = input.studentRef ?? this.studentRef
    if (!SYNTHETIC_REF_RE.test(subject)) {
      throw new FileEventStoreConfigError(
        'FileEventStore refuses non-synthetic student references',
      )
    }
    if (!REAL_SOURCES.has(input.source)) {
      // The in-memory adapter rejects this too; fail before touching the file.
      throw new FileEventStoreConfigError(
        'FileEventStore only persists real (observed) sources',
      )
    }
    const result = this.twin.appendObserved(input, attestation)
    if (!result.replayed) {
      this.persistEvent(input, result.event.eventId)
    }
    return result
  }

  /**
   * Load persisted events into the in-memory twin. Requires active consent;
   * tombstoned (retained-deleted) events are skipped. Safe to call repeatedly.
   */
  load(): number {
    this.requireEnabled()
    this.requireReadConsent()
    this.readTombstonesFromDisk()
    this.ingestRecordsFromDisk()
    let loaded = 0
    for (const record of this.records.values()) {
      if (this.tombstones.has(record.eventRef)) continue
      this.twin.appendObserved(
        {
          eventId: record.eventRef,
          eventType: record.eventType,
          source: record.source,
          studentRef: record.studentRef,
          occurredAt: record.occurredAt,
          observedAt: record.observedAt,
          consentScope: record.consentScope,
          schemaVersion: record.schemaVersion,
          // Deliberately not persisted: payload stays in the host store only.
          payload: {},
        },
        {
          issuer: RESTORE_ISSUER,
          source: record.source,
          subjectRef: record.studentRef,
          issuedAt: record.observedAt ?? record.occurredAt ?? '1970-01-01T00:00:00.000Z',
          token: record.checksum,
        },
      )
      loaded += 1
    }
    return loaded
  }

  /** Active (non-tombstoned) persisted events; fails closed after withdrawal. */
  readObserved(): readonly PersistedEventRecord[] {
    this.requireEnabled()
    this.requireReadConsent()
    return Object.freeze(
      [...this.records.values()].filter(
        (record) => !this.tombstones.has(record.eventRef),
      ),
    )
  }

  /** Roll back inferred state only; the persisted evidence log is untouched. */
  rollback(version: number) {
    this.requireEnabled()
    if (!this.consent.has('twin:rollback')) {
      throw new FileStoreConsentError(
        'consent scope "twin:rollback" is not active',
      )
    }
    return this.twin.rollback(version)
  }

  /** Apply an inferred mastery update backed by persisted observed evidence. */
  updateMastery(
    kcId: string,
    masteryMean: number,
    uncertainty: number,
    evidenceIds: readonly string[],
  ) {
    this.requireEnabled()
    this.requireReadConsent()
    return this.twin.updateMastery(kcId, masteryMean, uncertainty, evidenceIds)
  }

  /**
   * Tombstone events older than the retention window. Append-only: the events
   * file is never rewritten, the deletion is recorded separately.
   */
  applyRetention(at?: string): number {
    this.requireEnabled()
    this.requireReadConsent()
    if (!(this.retentionDays > 0)) return 0
    this.readTombstonesFromDisk()
    this.ingestRecordsFromDisk()
    const reference = at ?? this.now()
    const cutoff = Date.parse(reference) - this.retentionDays * 86_400_000
    let deleted = 0
    for (const record of this.records.values()) {
      if (this.tombstones.has(record.eventRef)) continue
      const stamp = record.occurredAt ?? record.observedAt
      if (stamp === null || !Number.isFinite(Date.parse(stamp))) continue
      if (Date.parse(stamp) < cutoff) {
        this.appendTombstone(record.eventRef, 'retention_expired', record.consentScope, reference)
        deleted += 1
      }
    }
    return deleted
  }

  /**
   * Revoke a consent scope. Revoking `twin:observe` propagates deletion by
   * tombstoning every persisted event and makes all subsequent reads fail.
   */
  withdrawConsent(scope: ConsentScope, at?: string): number {
    this.requireEnabled()
    const stamp = at ?? this.now()
    this.readTombstonesFromDisk()
    this.ingestRecordsFromDisk()
    this.consent.revoke(scope, stamp)
    if (scope !== 'twin:observe') return 0
    let deleted = 0
    for (const record of this.records.values()) {
      if (this.tombstones.has(record.eventRef)) continue
      this.appendTombstone(
        record.eventRef,
        'consent_withdrawn',
        record.consentScope,
        stamp,
      )
      deleted += 1
    }
    return deleted
  }

  tombstonesList(): readonly DeletionTombstone[] {
    return Object.freeze([...this.tombstones.values()])
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      studentRef: this.studentRef,
      directory: this.directory,
      enabled: this.enabled,
      retentionDays: this.retentionDays,
      persistedEvents: this.records.size,
      activeEvents: [...this.records.values()].filter(
        (record) => !this.tombstones.has(record.eventRef),
      ).length,
      tombstones: this.tombstones.size,
      version: this.twin.version,
      evidenceRevision: this.twin.evidenceRevision,
    })
  }

  private persistEvent(input: TwinEventInput, eventRef: string): void {
    const occurredAt = parseIso(input.occurredAt ?? null)
    const observedAt = parseIso(input.observedAt ?? null)
    const base: Omit<PersistedEventRecord, 'checksum'> = {
      seq: ++this.seq,
      eventRef,
      eventType: input.eventType,
      source: input.source,
      studentRef: input.studentRef ?? this.studentRef,
      occurredAt,
      observedAt,
      consentScope: input.consentScope ?? 'unspecified',
      schemaVersion: input.schemaVersion ?? 'aeh-event-v1',
    }
    const checksum = checksumFor(base)
    const persisted: PersistedEventRecord = Object.freeze({ ...base, checksum })
    this.records.set(eventRef, persisted)
    this.restoreChecksums.set(eventRef, checksum)
    this.ensureDirectory()
    appendFileSync(this.eventsPath, `${JSON.stringify(persisted)}\n`, 'utf8')
  }

  private appendTombstone(
    eventRef: string,
    reason: string,
    consentScope: string | null,
    at: string,
  ): void {
    const tombstone: DeletionTombstone = Object.freeze({
      seq: ++this.tombstoneSeq,
      eventRef,
      reason,
      consentScope,
      at,
    })
    this.tombstones.set(eventRef, tombstone)
    this.ensureDirectory()
    appendFileSync(this.tombstonesPath, `${JSON.stringify(tombstone)}\n`, 'utf8')
  }

  private readTombstonesFromDisk(): void {
    if (!existsSync(this.tombstonesPath)) return
    for (const line of this.readLines(this.tombstonesPath)) {
      const parsed = JSON.parse(line) as DeletionTombstone
      if (typeof parsed.eventRef !== 'string') {
        throw new FileEventStoreIntegrityError('tombstone is missing eventRef')
      }
      this.tombstones.set(parsed.eventRef, Object.freeze(parsed))
      this.tombstoneSeq = Math.max(this.tombstoneSeq, parsed.seq ?? 0)
    }
  }

  private ingestRecordsFromDisk(): void {
    if (!existsSync(this.eventsPath)) return
    for (const line of this.readLines(this.eventsPath)) {
      const record = this.parseRecord(line)
      if (!this.records.has(record.eventRef)) {
        this.records.set(record.eventRef, record)
        this.restoreChecksums.set(record.eventRef, record.checksum)
      }
      this.seq = Math.max(this.seq, record.seq)
    }
  }

  private parseRecord(line: string): PersistedEventRecord {
    let parsed: PersistedEventRecord
    try {
      parsed = JSON.parse(line) as PersistedEventRecord
    } catch (error) {
      throw new FileEventStoreIntegrityError(
        `persisted event is not valid JSON: ${String(error)}`,
      )
    }
    const { checksum, ...rest } = parsed
    if (typeof checksum !== 'string' || checksum.length === 0) {
      throw new FileEventStoreIntegrityError('persisted event is missing checksum')
    }
    if (checksumFor(rest) !== checksum) {
      throw new FileEventStoreIntegrityError(
        `persisted event ${JSON.stringify(parsed.eventRef)} failed its checksum`,
      )
    }
    return Object.freeze(parsed)
  }

  private readLines(path: string): string[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true })
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new FileEventStoreDisabledError(
        'file event store is disabled; pass enabled: true to opt in',
      )
    }
  }

  private requireReadConsent(): void {
    if (!this.consent.has('twin:observe')) {
      throw new FileStoreConsentError(
        'consent scope "twin:observe" is not active; reads and writes fail closed',
      )
    }
  }
}
