/**
 * Privacy, minor protection, retention/deletion propagation, audit export and
 * the metrics/cost dashboard (spec §20 / §21). TypeScript mirror of
 * `aeh/privacy.py` (Step 17).
 *
 * Five boundaries:
 *
 *   1. consent records            append-only grant/revoke events folded into
 *                                 effective scopes; revocation never rewrites
 *                                 history; guardian consent required for a
 *                                 minor's guardian-required scopes;
 *   2. audience restriction        audience default ∩ active consent, with the
 *                                 scopes that are never allowed for minors;
 *   3. retention + cross-store     per-data-class retention windows and a
 *      deletion propagation        deletion coordinator that propagates to every
 *                                 registered store and reports per-store
 *                                 success/failure (no silent success);
 *   4. audit export                deterministic window export that strips the
 *                                 pseudonymous dimensions by default;
 *   5. metrics + cost              channel-aware learning/system/cost samples
 *                                 with small-cohort suppression and an
 *                                 explicitly synthetic cost estimator
 *                                 (`BILLING_CONNECTED` is always `false`).
 *
 * Everything is synthetic and local; this is a policy/reference model, not a
 * production identity, storage or billing service. The shared fixture
 * `tests/fixtures/privacy_step17.json` is read by both the Python and
 * TypeScript tests.
 */

import { createHash } from 'node:crypto'

export type Scalar = string | number | boolean | null

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PrivacyError extends Error {
  readonly code = 'AEH_PRIVACY_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'PrivacyError'
  }
}

export class ValidationError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class ConsentError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'ConsentError'
  }
}

export class AudienceRestrictionError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'AudienceRestrictionError'
  }
}

export class RetentionError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'RetentionError'
  }
}

export class DeletionError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'DeletionError'
  }
}

export class AuditExportError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'AuditExportError'
  }
}

export class MetricsError extends PrivacyError {
  constructor(message: string) {
    super(message)
    this.name = 'MetricsError'
  }
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function assertIdentifier(value: unknown, field: string, maxLength = 128): string {
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

function assertShortLabel(value: unknown, field: string, maxLength = 80): string {
  return assertIdentifier(value, field, maxLength)
}

function toDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError(`${field} must be a valid timestamp`)
    }
    return value
  }
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) {
    throw new ValidationError(
      `${field} must be an ISO-8601 timestamp with a UTC offset`,
    )
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} must be a valid timestamp`)
  }
  return date
}

function isoUtc(value: Date): string {
  return value.toISOString()
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return value
}

function nonNegativeFloat(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be finite and >= 0`)
  }
  return value
}

function finiteFloat(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`)
  }
  return value
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
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

// ---------------------------------------------------------------------------
// 1. Consent records (spec §21.2)
// ---------------------------------------------------------------------------

export const SUBJECT_GUARDIAN = 'guardian'
export const SUBJECT_STUDENT = 'student'
export const SUBJECT_SCHOOL = 'school'
export const CONSENT_SUBJECTS = Object.freeze([
  SUBJECT_GUARDIAN,
  SUBJECT_STUDENT,
  SUBJECT_SCHOOL,
] as const)
export type ConsentSubject = (typeof CONSENT_SUBJECTS)[number]

export const SCOPE_CURRICULUM_READ = 'curriculum:read'
export const SCOPE_TWIN_OBSERVE = 'twin:observe'
export const SCOPE_TWIN_SIMULATE = 'twin:simulate'
export const SCOPE_TWIN_ROLLBACK = 'twin:rollback'
export const SCOPE_INTERVENTION_DELIVER = 'intervention:deliver'
export const SCOPE_REPORT_AGGREGATE = 'report:aggregate'
export const SCOPE_RESEARCH_AGGREGATE = 'research:aggregate'
export const SCOPE_AUDIT_EXPORT = 'audit:export'
export const SCOPE_METRICS_READ = 'metrics:read'

export const CONSENT_SCOPES: readonly string[] = Object.freeze([
  SCOPE_CURRICULUM_READ,
  SCOPE_TWIN_OBSERVE,
  SCOPE_TWIN_SIMULATE,
  SCOPE_TWIN_ROLLBACK,
  SCOPE_INTERVENTION_DELIVER,
  SCOPE_REPORT_AGGREGATE,
  SCOPE_RESEARCH_AGGREGATE,
  SCOPE_AUDIT_EXPORT,
  SCOPE_METRICS_READ,
])

export const CONSENT_GRANTED = 'granted'
export const CONSENT_REVOKED = 'revoked'
export const CONSENT_KINDS: readonly string[] = Object.freeze([
  CONSENT_GRANTED,
  CONSENT_REVOKED,
])

export const GUARDIAN_REQUIRED_SCOPES: readonly string[] = Object.freeze([
  SCOPE_TWIN_OBSERVE,
  SCOPE_TWIN_SIMULATE,
  SCOPE_TWIN_ROLLBACK,
  SCOPE_INTERVENTION_DELIVER,
  SCOPE_REPORT_AGGREGATE,
  SCOPE_RESEARCH_AGGREGATE,
])

export const MINOR_FORBIDDEN_SCOPES: readonly string[] = Object.freeze([
  SCOPE_RESEARCH_AGGREGATE,
])

export const MINOR_AGE_THRESHOLD = 18
export const MAX_AGE = 120

export function isMinor(age: unknown): boolean {
  if (typeof age !== 'number' || !Number.isInteger(age)) {
    throw new ValidationError('age must be an integer')
  }
  if (age < 0 || age > MAX_AGE) {
    throw new ValidationError(`age must be between 0 and ${MAX_AGE}`)
  }
  return age < MINOR_AGE_THRESHOLD
}

export interface ConsentEventInput {
  readonly consentId: string
  readonly studentRef: string
  readonly subject: string
  readonly scope: string
  readonly kind: string
  readonly at: string | Date
  readonly policyVersion: string
  readonly evidenceRef: string
  readonly expiresAt?: string | Date | null
}

export class ConsentEvent {
  readonly consentId: string
  readonly studentRef: string
  readonly subject: string
  readonly scope: string
  readonly kind: string
  readonly at: Date
  readonly policyVersion: string
  readonly evidenceRef: string
  readonly expiresAt: Date | null

  constructor(input: ConsentEventInput) {
    this.consentId = assertIdentifier(input.consentId, 'consentId')
    this.studentRef = assertIdentifier(input.studentRef, 'studentRef')
    this.policyVersion = assertIdentifier(input.policyVersion, 'policyVersion')
    this.evidenceRef = assertIdentifier(input.evidenceRef, 'evidenceRef')
    if (!(CONSENT_SUBJECTS as readonly string[]).includes(input.subject)) {
      throw new ValidationError(`unknown consent subject ${String(input.subject)}`)
    }
    if (!CONSENT_SCOPES.includes(input.scope)) {
      throw new ValidationError(`unknown consent scope ${String(input.scope)}`)
    }
    if (!CONSENT_KINDS.includes(input.kind)) {
      throw new ValidationError(`unknown consent kind ${String(input.kind)}`)
    }
    this.subject = input.subject
    this.scope = input.scope
    this.kind = input.kind
    this.at = toDate(input.at, 'at')
    if (input.expiresAt === undefined || input.expiresAt === null) {
      this.expiresAt = null
    } else {
      const expiresAt = toDate(input.expiresAt, 'expiresAt')
      if (this.kind !== CONSENT_GRANTED) {
        throw new ValidationError('only a granted consent event may expire')
      }
      if (expiresAt.getTime() <= this.at.getTime()) {
        throw new ValidationError('expiresAt must be after at')
      }
      this.expiresAt = expiresAt
    }
    Object.freeze(this)
  }

  get isGrant(): boolean {
    return this.kind === CONSENT_GRANTED
  }
}

export interface ConsentLedgerGrantInput {
  readonly consentId: string
  readonly studentRef: string
  readonly subject: string
  readonly scope: string
  readonly at: string | Date
  readonly policyVersion: string
  readonly evidenceRef: string
  readonly expiresAt?: string | Date | null
}

export class ConsentLedger {
  private readonly eventList: ConsentEvent[] = []
  private readonly ids = new Set<string>()

  append(event: ConsentEvent): ConsentEvent {
    if (!(event instanceof ConsentEvent)) {
      throw new ValidationError('ledger accepts ConsentEvent instances')
    }
    if (this.ids.has(event.consentId)) {
      throw new ConsentError(`duplicate consentId ${event.consentId}`)
    }
    this.ids.add(event.consentId)
    this.eventList.push(event)
    return event
  }

  grant(input: ConsentLedgerGrantInput): ConsentEvent {
    return this.append(
      new ConsentEvent({
        consentId: input.consentId,
        studentRef: input.studentRef,
        subject: input.subject,
        scope: input.scope,
        kind: CONSENT_GRANTED,
        at: input.at,
        policyVersion: input.policyVersion,
        evidenceRef: input.evidenceRef,
        expiresAt: input.expiresAt ?? null,
      }),
    )
  }

  revoke(input: ConsentLedgerGrantInput): ConsentEvent {
    return this.append(
      new ConsentEvent({
        consentId: input.consentId,
        studentRef: input.studentRef,
        subject: input.subject,
        scope: input.scope,
        kind: CONSENT_REVOKED,
        at: input.at,
        policyVersion: input.policyVersion,
        evidenceRef: input.evidenceRef,
      }),
    )
  }

  get events(): readonly ConsentEvent[] {
    return Object.freeze([...this.eventList])
  }

  history(studentRef?: string, scope?: string): readonly ConsentEvent[] {
    return Object.freeze(
      this.eventList.filter(
        (event) =>
          (studentRef === undefined || event.studentRef === studentRef) &&
          (scope === undefined || event.scope === scope),
      ),
    )
  }

  private latest(
    studentRef: string,
    at: Date,
  ): Map<string, { event: ConsentEvent; order: number }> {
    const result = new Map<string, { event: ConsentEvent; order: number }>()
    this.eventList.forEach((event, index) => {
      if (event.studentRef !== studentRef || event.at.getTime() > at.getTime()) {
        return
      }
      const key = `${event.subject}\u0000${event.scope}`
      const existing = result.get(key)
      if (existing === undefined || index > existing.order) {
        result.set(key, { event, order: index })
      }
    })
    return result
  }

  activeBySubject(studentRef: string, at: string | Date): Readonly<Record<string, readonly string[]>> {
    const stamp = toDate(at, 'at')
    const grouped: Record<string, Set<string>> = {}
    for (const { event } of this.latest(studentRef, stamp).values()) {
      if (!event.isGrant) continue
      if (event.expiresAt !== null && stamp.getTime() >= event.expiresAt.getTime()) {
        continue
      }
      ;(grouped[event.subject] ??= new Set<string>()).add(event.scope)
    }
    const output: Record<string, readonly string[]> = {}
    for (const subject of Object.keys(grouped).sort()) {
      output[subject] = Object.freeze([...grouped[subject]].sort())
    }
    return Object.freeze(output)
  }

  activeScopes(studentRef: string, at: string | Date, age?: number): readonly string[] {
    const grouped = this.activeBySubject(studentRef, at)
    const active = new Set<string>()
    for (const scopes of Object.values(grouped)) {
      for (const scope of scopes) active.add(scope)
    }
    if (age !== undefined && isMinor(age)) {
      const guardian = new Set(grouped[SUBJECT_GUARDIAN] ?? [])
      for (const scope of [...active]) {
        if (GUARDIAN_REQUIRED_SCOPES.includes(scope) && !guardian.has(scope)) {
          active.delete(scope)
        }
      }
    }
    return Object.freeze([...active].sort())
  }

  isGranted(
    studentRef: string,
    scope: string,
    at: string | Date,
    age?: number,
  ): boolean {
    return this.activeScopes(studentRef, at, age).includes(scope)
  }

  require(studentRef: string, scope: string, at: string | Date, age?: number): void {
    if (!this.isGranted(studentRef, scope, at, age)) {
      throw new ConsentError(`consent scope '${scope}' is not active for '${studentRef}'`)
    }
  }

  revokeAll(studentRef: string, at: string | Date, policyVersion: string): number {
    const stamp = toDate(at, 'at')
    const latest = this.latest(studentRef, stamp)
    const keys = [...latest.keys()].sort()
    let revoked = 0
    for (const key of keys) {
      const { event } = latest.get(key)!
      if (!event.isGrant) continue
      if (event.expiresAt !== null && stamp.getTime() >= event.expiresAt.getTime()) {
        continue
      }
      this.append(
        new ConsentEvent({
          consentId: `${event.consentId}:revoked`,
          studentRef,
          subject: event.subject,
          scope: event.scope,
          kind: CONSENT_REVOKED,
          at: stamp,
          policyVersion,
          evidenceRef: event.evidenceRef,
        }),
      )
      revoked += 1
    }
    return revoked
  }
}

// ---------------------------------------------------------------------------
// 2. Audience restriction and minor protection (spec §20.3 / §21.2)
// ---------------------------------------------------------------------------

export const AUDIENCE_STUDENT = 'student'
export const AUDIENCE_GUARDIAN = 'guardian'
export const AUDIENCE_TEACHER = 'teacher'
export const AUDIENCE_ADMIN = 'admin'
export const AUDIENCE_RESEARCH = 'research'
export const AUDIENCES: readonly string[] = Object.freeze([
  AUDIENCE_STUDENT,
  AUDIENCE_GUARDIAN,
  AUDIENCE_TEACHER,
  AUDIENCE_ADMIN,
  AUDIENCE_RESEARCH,
])

export const DEFAULT_AUDIENCE_SCOPES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    [AUDIENCE_STUDENT]: Object.freeze([SCOPE_CURRICULUM_READ, SCOPE_TWIN_OBSERVE]),
    [AUDIENCE_GUARDIAN]: Object.freeze([SCOPE_CURRICULUM_READ, SCOPE_REPORT_AGGREGATE]),
    [AUDIENCE_TEACHER]: Object.freeze([
      SCOPE_CURRICULUM_READ,
      SCOPE_TWIN_OBSERVE,
      SCOPE_REPORT_AGGREGATE,
    ]),
    [AUDIENCE_ADMIN]: Object.freeze([
      SCOPE_AUDIT_EXPORT,
      SCOPE_REPORT_AGGREGATE,
      SCOPE_METRICS_READ,
    ]),
    [AUDIENCE_RESEARCH]: Object.freeze([
      SCOPE_RESEARCH_AGGREGATE,
      SCOPE_METRICS_READ,
    ]),
  })

export function effectiveAudienceScopes(
  audience: string,
  authorizedScopes?: readonly string[] | string,
): readonly string[] {
  if (!AUDIENCES.includes(audience)) {
    throw new AudienceRestrictionError(`unknown audience '${audience}'`)
  }
  const base = new Set(DEFAULT_AUDIENCE_SCOPES[audience])
  if (authorizedScopes === undefined) {
    return Object.freeze([...base].sort())
  }
  const requested =
    typeof authorizedScopes === 'string' ? [authorizedScopes] : authorizedScopes
  const unknown = requested.filter((scope) => !CONSENT_SCOPES.includes(scope))
  if (unknown.length > 0) {
    throw new AudienceRestrictionError(
      `unknown audience scope(s): ${JSON.stringify([...unknown].sort())}`,
    )
  }
  const narrowed = new Set(requested.filter((scope) => base.has(scope)))
  return Object.freeze([...narrowed].sort())
}

export function authorizedAudienceScopes(
  audience: string,
  ledger: ConsentLedger,
  studentRef: string,
  at: string | Date,
  options: { age?: number; authorizedScopes?: readonly string[] | string } = {},
): readonly string[] {
  const base = new Set(effectiveAudienceScopes(audience, options.authorizedScopes))
  const active = new Set(ledger.activeScopes(studentRef, at, options.age))
  const result = new Set([...base].filter((scope) => active.has(scope)))
  if (options.age !== undefined && isMinor(options.age)) {
    for (const scope of MINOR_FORBIDDEN_SCOPES) result.delete(scope)
  }
  return Object.freeze([...result].sort())
}

export function assertAudienceScope(
  audience: string,
  scope: string,
  ledger: ConsentLedger,
  studentRef: string,
  at: string | Date,
  options: { age?: number; authorizedScopes?: readonly string[] | string } = {},
): void {
  const allowed = authorizedAudienceScopes(
    audience,
    ledger,
    studentRef,
    at,
    options,
  )
  if (!allowed.includes(scope)) {
    throw new AudienceRestrictionError(
      `audience '${audience}' may not access '${scope}' for '${studentRef}'`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Retention and cross-store deletion propagation (spec §21.2)
// ---------------------------------------------------------------------------

export const DATA_CLASS_RAW_MEDIA = 'raw_media'
export const DATA_CLASS_LEARNING_EVENTS = 'learning_events'
export const DATA_CLASS_DERIVED_FEATURES = 'derived_features'
export const DATA_CLASS_REPORTS = 'reports'
export const DATA_CLASS_AUDIT_LOG = 'audit_log'
export const DATA_CLASSES: readonly string[] = Object.freeze([
  DATA_CLASS_RAW_MEDIA,
  DATA_CLASS_LEARNING_EVENTS,
  DATA_CLASS_DERIVED_FEATURES,
  DATA_CLASS_REPORTS,
  DATA_CLASS_AUDIT_LOG,
])

export const DELETION_HARD = 'hard_delete'
export const DELETION_TOMBSTONE = 'tombstone'
export const DELETION_ANONYMIZE = 'anonymize'
export const DELETION_MODES: readonly string[] = Object.freeze([
  DELETION_HARD,
  DELETION_TOMBSTONE,
  DELETION_ANONYMIZE,
])

export const DELETION_COMPLETED = 'completed'
export const DELETION_PARTIAL = 'partial'
export const DELETION_FAILED = 'failed'
export const DELETION_STATUSES: readonly string[] = Object.freeze([
  DELETION_COMPLETED,
  DELETION_PARTIAL,
  DELETION_FAILED,
])

export const REASON_STUDENT_REQUEST = 'student_request'
export const REASON_GUARDIAN_REQUEST = 'guardian_request'
export const REASON_RETENTION_EXPIRY = 'retention_expiry'
export const REASON_POLICY = 'policy'
export const DELETION_REASONS: readonly string[] = Object.freeze([
  REASON_STUDENT_REQUEST,
  REASON_GUARDIAN_REQUEST,
  REASON_RETENTION_EXPIRY,
  REASON_POLICY,
])

export class RetentionRule {
  readonly dataClass: string
  readonly retainDays: number
  readonly deletionMode: string

  constructor(dataClass: string, retainDays: unknown, deletionMode = DELETION_TOMBSTONE) {
    if (!DATA_CLASSES.includes(dataClass)) {
      throw new RetentionError(`unknown data class '${dataClass}'`)
    }
    this.dataClass = dataClass
    this.retainDays = nonNegativeInt(retainDays, 'retainDays')
    if (!DELETION_MODES.includes(deletionMode)) {
      throw new RetentionError(`unknown deletion mode '${deletionMode}'`)
    }
    this.deletionMode = deletionMode
    Object.freeze(this)
  }
}

export class RetentionPolicy {
  readonly policyVersion: string
  private readonly ruleMap: ReadonlyMap<string, RetentionRule>

  constructor(policyVersion: string, rules: readonly RetentionRule[]) {
    this.policyVersion = assertIdentifier(policyVersion, 'policyVersion')
    const map = new Map<string, RetentionRule>()
    for (const rule of rules) {
      if (!(rule instanceof RetentionRule)) {
        throw new RetentionError('retention rules must be RetentionRule instances')
      }
      if (map.has(rule.dataClass)) {
        throw new RetentionError(`duplicate retention rule for '${rule.dataClass}'`)
      }
      map.set(rule.dataClass, rule)
    }
    for (const dataClass of DATA_CLASSES) {
      if (!map.has(dataClass)) {
        throw new RetentionError(
          `retention policy is missing data class '${dataClass}'`,
        )
      }
    }
    this.ruleMap = map
  }

  rule(dataClass: string): RetentionRule {
    const rule = this.ruleMap.get(dataClass)
    if (rule === undefined) {
      throw new RetentionError(`no retention rule for '${dataClass}'`)
    }
    return rule
  }

  expiresAt(dataClass: string, createdAt: string | Date): Date {
    const created = toDate(createdAt, 'createdAt')
    return new Date(
      created.getTime() + this.rule(dataClass).retainDays * 24 * 60 * 60 * 1000,
    )
  }
}

export class RetentionRecord {
  readonly studentRef: string
  readonly dataClass: string
  readonly createdAt: Date

  constructor(studentRef: string, dataClass: string, createdAt: string | Date) {
    this.studentRef = assertIdentifier(studentRef, 'studentRef')
    if (!DATA_CLASSES.includes(dataClass)) {
      throw new ValidationError(`unknown data class '${dataClass}'`)
    }
    this.dataClass = dataClass
    this.createdAt = toDate(createdAt, 'createdAt')
    Object.freeze(this)
  }
}

export interface RetentionDue {
  readonly studentRef: string
  readonly dataClass: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly deletionMode: string
}

export function expiredRecords(
  records: readonly RetentionRecord[],
  policy: RetentionPolicy,
  now: string | Date,
): readonly RetentionDue[] {
  const stamp = toDate(now, 'now')
  const dues: RetentionDue[] = []
  for (const record of records) {
    const expiresAt = policy.expiresAt(record.dataClass, record.createdAt)
    if (expiresAt.getTime() <= stamp.getTime()) {
      dues.push(
        Object.freeze({
          studentRef: record.studentRef,
          dataClass: record.dataClass,
          createdAt: record.createdAt,
          expiresAt,
          deletionMode: policy.rule(record.dataClass).deletionMode,
        }),
      )
    }
  }
  dues.sort((left, right) => {
    const byExpiry = left.expiresAt.getTime() - right.expiresAt.getTime()
    if (byExpiry !== 0) return byExpiry
    const byStudent = left.studentRef < right.studentRef ? -1 : left.studentRef > right.studentRef ? 1 : 0
    if (byStudent !== 0) return byStudent
    return left.dataClass < right.dataClass ? -1 : left.dataClass > right.dataClass ? 1 : 0
  })
  return Object.freeze(dues)
}

export function retentionRequests(
  dues: readonly RetentionDue[],
  requestedAt: string | Date,
): readonly DeletionRequest[] {
  const stamp = toDate(requestedAt, 'requestedAt')
  const requests = dues.map(
    (due) =>
      new DeletionRequest({
        requestId: `retention:${due.studentRef}:${due.dataClass}:${isoUtc(due.expiresAt)}`,
        studentRef: due.studentRef,
        requestedAt: stamp,
        reason: REASON_RETENTION_EXPIRY,
        dataClasses: [due.dataClass],
        requestedBy: 'system',
      }),
  )
  requests.sort((left, right) =>
    left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0,
  )
  return Object.freeze(requests)
}

export interface DeletableStore {
  readonly storeId: string
  readonly dataClasses: readonly string[]
  deleteSubject(studentRef: string): Readonly<Record<string, number>>
  countSubject(studentRef: string): Readonly<Record<string, number>>
}

export class SyntheticStore implements DeletableStore {
  readonly storeId: string
  readonly dataClasses: readonly string[]
  private readonly rows = new Map<string, Map<string, number>>()
  private readonly failOnDelete: boolean

  constructor(
    storeId: string,
    dataClasses: readonly string[],
    options: { failOnDelete?: boolean } = {},
  ) {
    this.storeId = assertIdentifier(storeId, 'storeId')
    const classes = new Set(dataClasses)
    for (const dataClass of classes) {
      if (!DATA_CLASSES.includes(dataClass)) {
        throw new DeletionError(`unknown data class '${dataClass}'`)
      }
    }
    this.dataClasses = Object.freeze([...classes].sort())
    this.failOnDelete = options.failOnDelete === true
  }

  seed(studentRef: string, dataClass: string, count: number): void {
    assertIdentifier(studentRef, 'studentRef')
    if (!this.dataClasses.includes(dataClass)) {
      throw new DeletionError(`store '${this.storeId}' does not own '${dataClass}'`)
    }
    const value = nonNegativeInt(count, 'count')
    if (!this.rows.has(studentRef)) this.rows.set(studentRef, new Map())
    this.rows.get(studentRef)!.set(dataClass, value)
  }

  countSubject(studentRef: string): Readonly<Record<string, number>> {
    const row = this.rows.get(studentRef)
    const output: Record<string, number> = {}
    for (const dataClass of this.dataClasses) {
      output[dataClass] = row?.get(dataClass) ?? 0
    }
    return Object.freeze(output)
  }

  deleteSubject(studentRef: string): Readonly<Record<string, number>> {
    if (this.failOnDelete) {
      throw new DeletionError('synthetic store deletion failed')
    }
    const counts = this.countSubject(studentRef)
    this.rows.delete(studentRef)
    return counts
  }
}

export interface DeletionRequestInput {
  readonly requestId: string
  readonly studentRef: string
  readonly requestedAt: string | Date
  readonly reason: string
  readonly dataClasses: readonly string[]
  readonly requestedBy?: string
}

export class DeletionRequest {
  readonly requestId: string
  readonly studentRef: string
  readonly requestedAt: Date
  readonly reason: string
  readonly dataClasses: readonly string[]
  readonly requestedBy: string

  constructor(input: DeletionRequestInput) {
    this.requestId = assertIdentifier(input.requestId, 'requestId', 200)
    this.studentRef = assertIdentifier(input.studentRef, 'studentRef')
    this.requestedAt = toDate(input.requestedAt, 'requestedAt')
    if (!DELETION_REASONS.includes(input.reason)) {
      throw new ValidationError(`unknown deletion reason '${input.reason}'`)
    }
    this.reason = input.reason
    const requestedBy = input.requestedBy ?? 'system'
    if (
      requestedBy !== 'system' &&
      !(CONSENT_SUBJECTS as readonly string[]).includes(requestedBy)
    ) {
      throw new ValidationError(`unknown requester '${requestedBy}'`)
    }
    this.requestedBy = requestedBy
    const classes = [...new Set(input.dataClasses)].sort()
    if (classes.length === 0) {
      throw new ValidationError('dataClasses must not be empty')
    }
    for (const dataClass of classes) {
      if (!DATA_CLASSES.includes(dataClass)) {
        throw new ValidationError(`unknown data class '${dataClass}'`)
      }
    }
    this.dataClasses = Object.freeze(classes)
    Object.freeze(this)
  }
}

export interface StoreDeletionResult {
  readonly storeId: string
  readonly status: string
  readonly deleted: Readonly<Record<string, number>>
  readonly error: string | null
}

function storeDeletionResult(
  storeId: string,
  status: string,
  deleted: Readonly<Record<string, number>>,
  error: string | null = null,
): StoreDeletionResult {
  if (!DELETION_STATUSES.includes(status)) {
    throw new ValidationError(`unknown deletion status '${status}'`)
  }
  return Object.freeze({
    storeId,
    status,
    deleted: Object.freeze({ ...deleted }),
    error,
  })
}

function storeDeletionTotal(result: StoreDeletionResult): number {
  return Object.values(result.deleted).reduce((sum, value) => sum + value, 0)
}

export interface DeletionReceipt {
  readonly requestId: string
  readonly studentRef: string
  readonly requestedAt: Date
  readonly completedAt: Date
  readonly status: string
  readonly results: readonly StoreDeletionResult[]
  readonly totalDeleted: number
  readonly consentRevoked: number
  readonly accessBlocked: boolean
  readonly idempotentReplay: boolean
}

export interface DeletionReceiptJson {
  readonly request_id: string
  readonly student_ref: string
  readonly requested_at: string
  readonly completed_at: string
  readonly status: string
  readonly stores: readonly {
    readonly store_id: string
    readonly status: string
    readonly deleted: Readonly<Record<string, number>>
    readonly deleted_total: number
    readonly error: string | null
  }[]
  readonly total_deleted: number
  readonly consent_revoked: number
  readonly access_blocked: boolean
  readonly idempotent_replay: boolean
}

export function deletionReceiptJson(receipt: DeletionReceipt): DeletionReceiptJson {
  return {
    request_id: receipt.requestId,
    student_ref: receipt.studentRef,
    requested_at: isoUtc(receipt.requestedAt),
    completed_at: isoUtc(receipt.completedAt),
    status: receipt.status,
    stores: receipt.results.map((result) => ({
      store_id: result.storeId,
      status: result.status,
      deleted: Object.freeze(
        Object.fromEntries(
          Object.keys(result.deleted)
            .sort()
            .map((key) => [key, result.deleted[key]]),
        ),
      ),
      deleted_total: storeDeletionTotal(result),
      error: result.error,
    })),
    total_deleted: receipt.totalDeleted,
    consent_revoked: receipt.consentRevoked,
    access_blocked: receipt.accessBlocked,
    idempotent_replay: receipt.idempotentReplay,
  }
}

export class DeletionCoordinator {
  private readonly stores = new Map<string, DeletableStore>()
  private readonly receipts = new Map<string, DeletionReceipt>()
  private readonly blocked = new Set<string>()

  get storeIds(): readonly string[] {
    return Object.freeze([...this.stores.keys()].sort())
  }

  register(store: DeletableStore): void {
    if (
      store === null ||
      typeof store !== 'object' ||
      typeof store.storeId !== 'string' ||
      typeof store.deleteSubject !== 'function'
    ) {
      throw new DeletionError('coordinator accepts DeletableStore instances')
    }
    if (this.stores.has(store.storeId)) {
      throw new DeletionError(`duplicate storeId '${store.storeId}'`)
    }
    this.stores.set(store.storeId, store)
  }

  delete(
    request: DeletionRequest,
    options: { ledger?: ConsentLedger; now?: string | Date } = {},
  ): DeletionReceipt {
    if (!(request instanceof DeletionRequest)) {
      throw new DeletionError('coordinator accepts DeletionRequest instances')
    }
    const completedAt = toDate(options.now ?? new Date(), 'now')
    const cached = this.receipts.get(request.requestId)
    if (cached !== undefined) {
      return Object.freeze({ ...cached, idempotentReplay: true })
    }

    const results: StoreDeletionResult[] = []
    for (const storeId of this.storeIds) {
      const store = this.stores.get(storeId)!
      const relevant = store.dataClasses.filter((dataClass) =>
        request.dataClasses.includes(dataClass),
      )
      if (relevant.length === 0) continue
      try {
        const deleted = store.deleteSubject(request.studentRef)
        results.push(storeDeletionResult(storeId, DELETION_COMPLETED, deleted))
      } catch (error) {
        const deleted: Record<string, number> = {}
        for (const dataClass of [...relevant].sort()) deleted[dataClass] = 0
        results.push(
          storeDeletionResult(
            storeId,
            DELETION_FAILED,
            deleted,
            error instanceof Error ? error.constructor.name : 'Error',
          ),
        )
      }
    }

    let status: string
    if (results.length === 0 || results.every((r) => r.status === DELETION_COMPLETED)) {
      status = DELETION_COMPLETED
    } else if (results.every((r) => r.status === DELETION_FAILED)) {
      status = DELETION_FAILED
    } else {
      status = DELETION_PARTIAL
    }

    let revoked = 0
    if (options.ledger !== undefined) {
      revoked = options.ledger.revokeAll(
        request.studentRef,
        completedAt,
        'privacy.deletion.v1',
      )
    }

    this.blocked.add(request.studentRef)
    const receipt: DeletionReceipt = Object.freeze({
      requestId: request.requestId,
      studentRef: request.studentRef,
      requestedAt: request.requestedAt,
      completedAt,
      status,
      results: Object.freeze(results),
      totalDeleted: results.reduce(
        (sum, result) => sum + storeDeletionTotal(result),
        0,
      ),
      consentRevoked: revoked,
      accessBlocked: true,
      idempotentReplay: false,
    })
    this.receipts.set(request.requestId, receipt)
    return receipt
  }

  isBlocked(studentRef: string): boolean {
    return this.blocked.has(studentRef)
  }

  assertReadable(studentRef: string): void {
    if (this.isBlocked(studentRef)) {
      throw new DeletionError(
        `subject '${studentRef}' has been deleted; reads fail closed`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Audit export (spec §20.3)
// ---------------------------------------------------------------------------

export const AUDIT_KINDS: readonly string[] = Object.freeze([
  'gate.decision',
  'tool.call',
  'approval.record',
  'delivery.receipt',
  'session.cleanup',
  'consent.record',
  'deletion.propagate',
])

export const AUDIT_ACCEPTED = 'accepted'
export const AUDIT_REJECTED = 'rejected'
export const AUDIT_OUTCOMES: readonly string[] = Object.freeze([
  AUDIT_ACCEPTED,
  AUDIT_REJECTED,
])

export const AUDIT_FORBIDDEN_DETAIL_KEYS: readonly string[] = Object.freeze([
  'answer',
  'answers',
  'studentanswer',
  'rawanswer',
  'question',
  'questiontext',
  'itemcontent',
  'prompt',
  'prompttext',
  'solution',
  'steps',
  'trace',
  'content',
  'text',
  'image',
  'imagedata',
  'photo',
  'ocr',
  'attachment',
  'attachments',
  'payload',
  'rawpayload',
  'transcript',
  'studentname',
  'studentref',
  'tenantref',
  'name',
  'email',
  'phone',
  'address',
])

export interface AuditEntryInput {
  readonly seq: number
  readonly at: string | Date
  readonly kind: string
  readonly action: string
  readonly outcome: string
  readonly reasonCodes?: readonly string[]
  readonly studentKey?: string | null
  readonly tenantKey?: string | null
  readonly detail?: Readonly<Record<string, unknown>>
}

export class AuditEntry {
  readonly seq: number
  readonly at: Date
  readonly kind: string
  readonly action: string
  readonly outcome: string
  readonly reasonCodes: readonly string[]
  readonly studentKey: string | null
  readonly tenantKey: string | null
  readonly detail: Readonly<Record<string, Scalar>>

  constructor(input: AuditEntryInput) {
    this.seq = nonNegativeInt(input.seq, 'seq')
    this.at = toDate(input.at, 'at')
    if (!AUDIT_KINDS.includes(input.kind)) {
      throw new AuditExportError(`unknown audit kind '${input.kind}'`)
    }
    this.kind = input.kind
    this.action = assertShortLabel(input.action, 'action', 200)
    if (!AUDIT_OUTCOMES.includes(input.outcome)) {
      throw new AuditExportError(`unknown audit outcome '${input.outcome}'`)
    }
    this.outcome = input.outcome
    this.reasonCodes = Object.freeze(
      (input.reasonCodes ?? []).map((code) =>
        assertShortLabel(code, 'reasonCodes[]'),
      ),
    )
    this.studentKey =
      input.studentKey === undefined || input.studentKey === null
        ? null
        : assertIdentifier(input.studentKey, 'studentKey')
    this.tenantKey =
      input.tenantKey === undefined || input.tenantKey === null
        ? null
        : assertIdentifier(input.tenantKey, 'tenantKey')
    const clean: Record<string, Scalar> = {}
    for (const [key, value] of Object.entries(input.detail ?? {})) {
      if (AUDIT_FORBIDDEN_DETAIL_KEYS.includes(key.toLowerCase())) {
        throw new AuditExportError(
          `audit detail key '${key}' would store raw student data`,
        )
      }
      assertShortLabel(key, 'detail key')
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new AuditExportError('audit detail values must be scalars')
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new AuditExportError('audit detail numbers must be finite')
      }
      clean[key] = value as Scalar
    }
    this.detail = Object.freeze(clean)
    Object.freeze(this)
  }

  asDict(redactKeys: boolean): Record<string, unknown> {
    const detail: Record<string, Scalar> = {}
    for (const key of Object.keys(this.detail).sort()) {
      detail[key] = this.detail[key]
    }
    return {
      seq: this.seq,
      at: isoUtc(this.at),
      kind: this.kind,
      action: this.action,
      outcome: this.outcome,
      reason_codes: [...this.reasonCodes],
      student_key: redactKeys ? null : this.studentKey,
      tenant_key: redactKeys ? null : this.tenantKey,
      detail,
    }
  }
}

export interface AuditExportRequestInput {
  readonly requestId: string
  readonly requestedAt: string | Date
  readonly audience: string
  readonly windowStart: string | Date
  readonly windowEnd: string | Date
  readonly kinds?: readonly string[]
  readonly includePseudonymousKeys?: boolean
  readonly authorizedScopes?: readonly string[]
}

export class AuditExportRequest {
  readonly requestId: string
  readonly requestedAt: Date
  readonly audience: string
  readonly windowStart: Date
  readonly windowEnd: Date
  readonly kinds: readonly string[]
  readonly includePseudonymousKeys: boolean
  readonly authorizedScopes: readonly string[] | undefined

  constructor(input: AuditExportRequestInput) {
    this.requestId = assertIdentifier(input.requestId, 'requestId', 200)
    this.requestedAt = toDate(input.requestedAt, 'requestedAt')
    if (!AUDIENCES.includes(input.audience)) {
      throw new AuditExportError(`unknown audience '${input.audience}'`)
    }
    this.audience = input.audience
    this.windowStart = toDate(input.windowStart, 'windowStart')
    this.windowEnd = toDate(input.windowEnd, 'windowEnd')
    if (this.windowStart.getTime() >= this.windowEnd.getTime()) {
      throw new AuditExportError('windowStart must be before windowEnd')
    }
    const kinds = [...new Set(input.kinds ?? [])].sort()
    for (const kind of kinds) {
      if (!AUDIT_KINDS.includes(kind)) {
        throw new AuditExportError(`unknown audit kind '${kind}'`)
      }
    }
    this.kinds = Object.freeze(kinds)
    this.includePseudonymousKeys = input.includePseudonymousKeys === true
    this.authorizedScopes =
      input.authorizedScopes === undefined
        ? undefined
        : Object.freeze([...input.authorizedScopes])
    Object.freeze(this)
  }
}

export interface AuditExportBundle {
  readonly requestId: string
  readonly audience: string
  readonly windowStart: Date
  readonly windowEnd: Date
  readonly generatedAt: Date
  readonly entriesUsed: number
  readonly entriesExcluded: number
  readonly countsByKind: Readonly<Record<string, number>>
  readonly countsByOutcome: Readonly<Record<string, number>>
  readonly redactedKeys: boolean
  readonly digest: string
  readonly payload: string
}

export function auditExportJson(
  bundle: AuditExportBundle,
): Record<string, unknown> {
  const sortedRecord = (input: Readonly<Record<string, number>>): Record<string, number> => {
    const output: Record<string, number> = {}
    for (const key of Object.keys(input).sort()) output[key] = input[key]
    return output
  }
  return {
    request_id: bundle.requestId,
    audience: bundle.audience,
    window: {
      start: isoUtc(bundle.windowStart),
      end: isoUtc(bundle.windowEnd),
      boundary: 'start_inclusive_end_exclusive',
    },
    generated_at: isoUtc(bundle.generatedAt),
    entries_used: bundle.entriesUsed,
    entries_excluded: bundle.entriesExcluded,
    counts_by_kind: sortedRecord(bundle.countsByKind),
    counts_by_outcome: sortedRecord(bundle.countsByOutcome),
    redacted_keys: bundle.redactedKeys,
    digest: bundle.digest,
    payload: bundle.payload,
  }
}

export function exportAudit(
  entries: readonly AuditEntry[],
  request: AuditExportRequest,
  generatedAt?: string | Date,
): AuditExportBundle {
  if (!(request instanceof AuditExportRequest)) {
    throw new AuditExportError('export requires an AuditExportRequest')
  }
  const scopes = effectiveAudienceScopes(request.audience, request.authorizedScopes)
  if (!scopes.includes(SCOPE_AUDIT_EXPORT)) {
    throw new AudienceRestrictionError(
      `audience '${request.audience}' is not authorised for audit export`,
    )
  }
  const stamp = toDate(generatedAt ?? new Date(), 'generatedAt')

  const selected: AuditEntry[] = []
  let excluded = 0
  for (const entry of entries) {
    if (!(entry instanceof AuditEntry)) {
      throw new AuditExportError('export accepts AuditEntry instances')
    }
    if (request.kinds.length > 0 && !request.kinds.includes(entry.kind)) {
      excluded += 1
      continue
    }
    if (
      entry.at.getTime() < request.windowStart.getTime() ||
      entry.at.getTime() >= request.windowEnd.getTime()
    ) {
      excluded += 1
      continue
    }
    selected.push(entry)
  }
  selected.sort((left, right) => {
    const byTime = left.at.getTime() - right.at.getTime()
    return byTime !== 0 ? byTime : left.seq - right.seq
  })

  const lines: string[] = []
  const countsByKind: Record<string, number> = {}
  const countsByOutcome: Record<string, number> = {}
  for (const entry of selected) {
    lines.push(canonicalJson(entry.asDict(!request.includePseudonymousKeys)))
    countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1
    countsByOutcome[entry.outcome] = (countsByOutcome[entry.outcome] ?? 0) + 1
  }
  const payload = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex')

  return Object.freeze({
    requestId: request.requestId,
    audience: request.audience,
    windowStart: request.windowStart,
    windowEnd: request.windowEnd,
    generatedAt: stamp,
    entriesUsed: selected.length,
    entriesExcluded: excluded,
    countsByKind: Object.freeze(countsByKind),
    countsByOutcome: Object.freeze(countsByOutcome),
    redactedKeys: !request.includePseudonymousKeys,
    digest,
    payload,
  })
}

// ---------------------------------------------------------------------------
// 5. Metrics dashboard and cost estimation (spec §20.1 / §20.2)
// ---------------------------------------------------------------------------

export const DIMENSION_LEARNING = 'learning'
export const DIMENSION_SYSTEM = 'system'
export const DIMENSION_COST = 'cost'
export const METRIC_DIMENSIONS: readonly string[] = Object.freeze([
  DIMENSION_LEARNING,
  DIMENSION_SYSTEM,
  DIMENSION_COST,
])

export const AGG_SUM = 'sum'
export const AGG_MEAN = 'mean'
export const AGG_GAUGE = 'gauge'
export const AGG_RATIO = 'ratio'
export const AGGREGATIONS: readonly string[] = Object.freeze([
  AGG_SUM,
  AGG_MEAN,
  AGG_GAUGE,
  AGG_RATIO,
])

export const SOURCE_OBSERVED = 'observed'
export const SOURCE_SIMULATED = 'simulated'
export const METRIC_SOURCES: readonly string[] = Object.freeze([
  SOURCE_OBSERVED,
  SOURCE_SIMULATED,
])

export const MIN_COHORT_SIZE = 5

export class MetricDefinition {
  readonly name: string
  readonly dimension: string
  readonly unit: string
  readonly aggregation: string
  readonly description: string
  readonly simulatedAllowed: boolean

  constructor(input: {
    name: string
    dimension: string
    unit: string
    aggregation: string
    description?: string
    simulatedAllowed?: boolean
  }) {
    this.name = assertIdentifier(input.name, 'name', 80)
    if (!METRIC_DIMENSIONS.includes(input.dimension)) {
      throw new MetricsError(`unknown metric dimension '${input.dimension}'`)
    }
    this.dimension = input.dimension
    this.unit = assertShortLabel(input.unit, 'unit', 40)
    if (!AGGREGATIONS.includes(input.aggregation)) {
      throw new MetricsError(`unknown aggregation '${input.aggregation}'`)
    }
    this.aggregation = input.aggregation
    this.description = input.description ?? ''
    this.simulatedAllowed = input.simulatedAllowed === true
    Object.freeze(this)
  }
}

const METRIC_SPECS: readonly (readonly [string, string, string, string, boolean])[] =
  Object.freeze([
    ['independent_accuracy', DIMENSION_LEARNING, 'ratio', AGG_RATIO, false],
    ['step_error_recurrence', DIMENSION_LEARNING, 'per_step', AGG_MEAN, false],
    ['near_transfer', DIMENSION_LEARNING, 'ratio', AGG_RATIO, false],
    ['far_transfer', DIMENSION_LEARNING, 'ratio', AGG_RATIO, false],
    ['delayed_retention', DIMENSION_LEARNING, 'ratio', AGG_RATIO, false],
    ['hint_dependency', DIMENSION_LEARNING, 'ratio', AGG_RATIO, false],
    ['learning_minutes', DIMENSION_LEARNING, 'minutes', AGG_SUM, false],
    ['virtual_real_gain_gap', DIMENSION_LEARNING, 'ratio', AGG_MEAN, true],
    ['model_calls_per_session', DIMENSION_SYSTEM, 'calls', AGG_MEAN, true],
    ['tool_latency_ms', DIMENSION_SYSTEM, 'ms', AGG_MEAN, true],
    ['cache_hit_rate', DIMENSION_SYSTEM, 'ratio', AGG_RATIO, true],
    ['workflow_failure_rate', DIMENSION_SYSTEM, 'ratio', AGG_RATIO, true],
    ['simulated_tokens', DIMENSION_SYSTEM, 'tokens', AGG_SUM, true],
    ['simulated_token_cost_usd', DIMENSION_COST, 'usd', AGG_SUM, true],
    ['tool_invocation_cost_usd', DIMENSION_COST, 'usd', AGG_SUM, true],
    ['session_cost_usd', DIMENSION_COST, 'usd', AGG_SUM, true],
  ])

export const METRIC_DEFINITIONS: Readonly<Record<string, MetricDefinition>> =
  Object.freeze(
    Object.fromEntries(
      METRIC_SPECS.map(([name, dimension, unit, aggregation, simulatedAllowed]) => [
        name,
        new MetricDefinition({
          name,
          dimension,
          unit,
          aggregation,
          simulatedAllowed,
        }),
      ]),
    ),
  )

export interface MetricSampleInput {
  readonly metric: string
  readonly value: number
  readonly at: string | Date
  readonly source: string
  readonly studentKey?: string | null
  readonly tenantKey?: string | null
  readonly labels?:
    | Readonly<Record<string, string>>
    | readonly (readonly [string, string])[]
}

export class MetricSample {
  readonly metric: string
  readonly value: number
  readonly at: Date
  readonly source: string
  readonly studentKey: string | null
  readonly tenantKey: string | null
  readonly labels: readonly (readonly [string, string])[]

  constructor(input: MetricSampleInput) {
    this.metric = assertIdentifier(input.metric, 'metric', 80)
    this.value = finiteFloat(input.value, 'value')
    this.at = toDate(input.at, 'at')
    if (!METRIC_SOURCES.includes(input.source)) {
      throw new MetricsError(`unknown metric source '${input.source}'`)
    }
    this.source = input.source
    this.studentKey =
      input.studentKey === undefined || input.studentKey === null
        ? null
        : assertIdentifier(input.studentKey, 'studentKey')
    this.tenantKey =
      input.tenantKey === undefined || input.tenantKey === null
        ? null
        : assertIdentifier(input.tenantKey, 'tenantKey')
    const entries: [string, string][] = []
    if (input.labels !== undefined) {
      if (Array.isArray(input.labels)) {
        for (const [key, value] of input.labels) {
          entries.push([
            assertShortLabel(key, 'label key', 40),
            assertShortLabel(value, 'label value', 60),
          ])
        }
      } else {
        for (const key of Object.keys(input.labels as Readonly<Record<string, string>>)) {
          entries.push([
            assertShortLabel(key, 'label key', 40),
            assertShortLabel(
              (input.labels as Readonly<Record<string, string>>)[key],
              'label value',
              60,
            ),
          ])
        }
      }
    }
    entries.sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0,
    )
    this.labels = Object.freeze(entries.map((entry) => Object.freeze(entry)))
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    const labels: Record<string, string> = {}
    for (const [key, value] of this.labels) labels[key] = value
    return {
      metric: this.metric,
      value: round(this.value),
      at: isoUtc(this.at),
      source: this.source,
      student_key: this.studentKey,
      tenant_key: this.tenantKey,
      labels,
    }
  }
}

function aggregate(values: readonly number[], aggregation: string): number | null {
  if (values.length === 0) return null
  if (aggregation === AGG_SUM) {
    return round(values.reduce((sum, value) => sum + value, 0))
  }
  if (aggregation === AGG_GAUGE) {
    return round(values[values.length - 1])
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

export interface MetricCell {
  readonly metric: string
  readonly dimension: string
  readonly unit: string
  readonly aggregation: string
  readonly value: number | null
  readonly sampleCount: number
}

export interface CohortCell {
  readonly studentKey: string
  readonly value: number | null
  readonly sampleCount: number
}

export interface DashboardSnapshot {
  readonly channel: string
  readonly generatedAt: Date
  readonly cells: readonly MetricCell[]
  readonly totalSamples: number
  readonly excludedOtherChannel: number
  readonly studentCounts: Readonly<Record<string, number>>
  readonly minCohortSize: number
}

export function dashboardSnapshotJson(
  snapshot: DashboardSnapshot,
): Record<string, unknown> {
  const sections: Record<string, unknown[]> = {}
  for (const dimension of [...METRIC_DIMENSIONS].sort()) sections[dimension] = []
  for (const cell of snapshot.cells) {
    sections[cell.dimension].push({
      metric: cell.metric,
      dimension: cell.dimension,
      unit: cell.unit,
      aggregation: cell.aggregation,
      value: cell.value,
      sample_count: cell.sampleCount,
    })
  }
  const cohorts: Record<string, number> = {}
  let suppressed = 0
  for (const key of Object.keys(snapshot.studentCounts).sort()) {
    const count = snapshot.studentCounts[key]
    if (count >= snapshot.minCohortSize) cohorts[key] = count
    else suppressed += 1
  }
  return {
    channel: snapshot.channel,
    generated_at: isoUtc(snapshot.generatedAt),
    sections,
    total_samples: snapshot.totalSamples,
    excluded_other_channel: snapshot.excludedOtherChannel,
    student_cohorts: cohorts,
    suppressed_cohorts: suppressed,
    min_cohort_size: snapshot.minCohortSize,
  }
}

export interface CohortView {
  readonly metric: string
  readonly channel: string
  readonly minCohortSize: number
  readonly cells: readonly CohortCell[]
  readonly suppressedCohorts: number
}

export function cohortViewJson(view: CohortView): Record<string, unknown> {
  return {
    metric: view.metric,
    channel: view.channel,
    min_cohort_size: view.minCohortSize,
    cells: view.cells.map((cell) => ({
      student_key: cell.studentKey,
      value: cell.value,
      sample_count: cell.sampleCount,
    })),
    suppressed_cohorts: view.suppressedCohorts,
  }
}

export class MetricsDashboard {
  private readonly definitions: Readonly<Record<string, MetricDefinition>>
  readonly minCohortSize: number
  private readonly sampleList: MetricSample[] = []

  constructor(
    definitions?: Readonly<Record<string, MetricDefinition>>,
    options: { minCohortSize?: number } = {},
  ) {
    this.definitions = definitions ?? METRIC_DEFINITIONS
    for (const [name, definition] of Object.entries(this.definitions)) {
      if (!(definition instanceof MetricDefinition) || definition.name !== name) {
        throw new MetricsError(`metric definition '${name}' is inconsistent`)
      }
    }
    this.minCohortSize = nonNegativeInt(options.minCohortSize ?? MIN_COHORT_SIZE, 'minCohortSize')
    if (this.minCohortSize < 1) {
      throw new MetricsError('minCohortSize must be >= 1')
    }
  }

  get samples(): readonly MetricSample[] {
    return Object.freeze([...this.sampleList])
  }

  ingest(sample: MetricSample): MetricSample {
    if (!(sample instanceof MetricSample)) {
      throw new MetricsError('dashboard accepts MetricSample instances')
    }
    const definition = this.definitions[sample.metric]
    if (definition === undefined) {
      throw new MetricsError(`unknown metric '${sample.metric}'`)
    }
    if (sample.source === SOURCE_SIMULATED && !definition.simulatedAllowed) {
      throw new MetricsError(
        `simulated samples may not enter learning metric '${sample.metric}'`,
      )
    }
    this.sampleList.push(sample)
    return sample
  }

  private channel(channel: string): MetricSample[] {
    if (!METRIC_SOURCES.includes(channel)) {
      throw new MetricsError(`unknown channel '${channel}'`)
    }
    return this.sampleList.filter((sample) => sample.source === channel)
  }

  snapshot(options: { channel?: string; generatedAt?: string | Date } = {}): DashboardSnapshot {
    const channel = options.channel ?? SOURCE_OBSERVED
    const selected = this.channel(channel)
    const grouped: Record<string, number[]> = {}
    for (const sample of selected) {
      ;(grouped[sample.metric] ??= []).push(sample.value)
    }
    const cells: MetricCell[] = []
    for (const name of Object.keys(grouped).sort()) {
      const definition = this.definitions[name]
      cells.push(
        Object.freeze({
          metric: name,
          dimension: definition.dimension,
          unit: definition.unit,
          aggregation: definition.aggregation,
          value: aggregate(grouped[name], definition.aggregation),
          sampleCount: grouped[name].length,
        }),
      )
    }
    const studentCounts: Record<string, number> = {}
    for (const sample of selected) {
      if (sample.studentKey !== null) {
        studentCounts[sample.studentKey] = (studentCounts[sample.studentKey] ?? 0) + 1
      }
    }
    return Object.freeze({
      channel,
      generatedAt: toDate(options.generatedAt ?? new Date(), 'generatedAt'),
      cells: Object.freeze(cells),
      totalSamples: selected.length,
      excludedOtherChannel: this.sampleList.length - selected.length,
      studentCounts: Object.freeze(studentCounts),
      minCohortSize: this.minCohortSize,
    })
  }

  cohortView(
    metric: string,
    options: { channel?: string; minCohortSize?: number } = {},
  ): CohortView {
    const definition = this.definitions[metric]
    if (definition === undefined) {
      throw new MetricsError(`unknown metric '${metric}'`)
    }
    const channel = options.channel ?? SOURCE_OBSERVED
    const threshold = nonNegativeInt(
      options.minCohortSize ?? this.minCohortSize,
      'minCohortSize',
    )
    if (threshold < 1) {
      throw new MetricsError('minCohortSize must be >= 1')
    }
    const selected = this.channel(channel).filter(
      (sample) => sample.metric === metric && sample.studentKey !== null,
    )
    const grouped: Record<string, number[]> = {}
    for (const sample of selected) {
      ;(grouped[sample.studentKey as string] ??= []).push(sample.value)
    }
    const cells: CohortCell[] = []
    let suppressed = 0
    for (const key of Object.keys(grouped).sort()) {
      const values = grouped[key]
      if (values.length < threshold) {
        suppressed += 1
        continue
      }
      cells.push(
        Object.freeze({
          studentKey: key,
          value: aggregate(values, definition.aggregation),
          sampleCount: values.length,
        }),
      )
    }
    return Object.freeze({
      metric,
      channel,
      minCohortSize: threshold,
      cells: Object.freeze(cells),
      suppressedCohorts: suppressed,
    })
  }
}

// --- Cost estimation (explicitly synthetic; never connected to real billing) ---

export const BILLING_CONNECTED = false

export interface CostModelInput {
  readonly modelId: string
  readonly inputUsdPer1kTokens?: number
  readonly outputUsdPer1kTokens?: number
  readonly toolCallUsd?: number
  readonly simulationMinuteUsd?: number
  readonly currency?: string
  readonly synthetic?: boolean
}

export class CostModel {
  readonly modelId: string
  readonly inputUsdPer1kTokens: number
  readonly outputUsdPer1kTokens: number
  readonly toolCallUsd: number
  readonly simulationMinuteUsd: number
  readonly currency: string
  readonly synthetic: boolean

  constructor(input: CostModelInput) {
    this.modelId = assertIdentifier(input.modelId, 'modelId', 80)
    this.currency = assertShortLabel(input.currency ?? 'USD', 'currency', 8)
    this.inputUsdPer1kTokens = nonNegativeFloat(
      input.inputUsdPer1kTokens ?? 0,
      'inputUsdPer1kTokens',
    )
    this.outputUsdPer1kTokens = nonNegativeFloat(
      input.outputUsdPer1kTokens ?? 0,
      'outputUsdPer1kTokens',
    )
    this.toolCallUsd = nonNegativeFloat(input.toolCallUsd ?? 0, 'toolCallUsd')
    this.simulationMinuteUsd = nonNegativeFloat(
      input.simulationMinuteUsd ?? 0,
      'simulationMinuteUsd',
    )
    this.synthetic = input.synthetic !== false
    Object.freeze(this)
  }
}

export const DEFAULT_COST_MODELS: Readonly<Record<string, CostModel>> = Object.freeze({
  'synthetic-llm-small': new CostModel({
    modelId: 'synthetic-llm-small',
    inputUsdPer1kTokens: 0.0015,
    outputUsdPer1kTokens: 0.006,
    toolCallUsd: 0.0002,
    simulationMinuteUsd: 0.01,
  }),
  'synthetic-llm-large': new CostModel({
    modelId: 'synthetic-llm-large',
    inputUsdPer1kTokens: 0.01,
    outputUsdPer1kTokens: 0.03,
    toolCallUsd: 0.0005,
    simulationMinuteUsd: 0.05,
  }),
})

export interface UsageRecordInput {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolCalls?: number
  readonly simulationMinutes?: number
  readonly cacheHits?: number
}

export class UsageRecord {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCalls: number
  readonly simulationMinutes: number
  readonly cacheHits: number

  constructor(input: UsageRecordInput = {}) {
    this.inputTokens = nonNegativeInt(input.inputTokens ?? 0, 'inputTokens')
    this.outputTokens = nonNegativeInt(input.outputTokens ?? 0, 'outputTokens')
    this.toolCalls = nonNegativeInt(input.toolCalls ?? 0, 'toolCalls')
    this.simulationMinutes = nonNegativeFloat(
      input.simulationMinutes ?? 0,
      'simulationMinutes',
    )
    this.cacheHits = nonNegativeInt(input.cacheHits ?? 0, 'cacheHits')
    Object.freeze(this)
  }

  asDict(): Record<string, unknown> {
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      tool_calls: this.toolCalls,
      simulation_minutes: round(this.simulationMinutes),
      cache_hits: this.cacheHits,
    }
  }
}

export interface CostEstimate {
  readonly modelId: string
  readonly currency: string
  readonly components: Readonly<Record<string, number>>
  readonly total: number
  readonly usage: UsageRecord
  readonly synthetic: boolean
  readonly billingConnected: boolean
}

export function costEstimateJson(estimate: CostEstimate): Record<string, unknown> {
  const components: Record<string, number> = {}
  for (const key of Object.keys(estimate.components).sort()) {
    components[key] = round(estimate.components[key])
  }
  return {
    model_id: estimate.modelId,
    currency: estimate.currency,
    components,
    total: round(estimate.total),
    usage: estimate.usage.asDict(),
    synthetic: estimate.synthetic,
    billing_connected: estimate.billingConnected,
  }
}

export function estimateCost(usage: UsageRecord, model: CostModel): CostEstimate {
  if (!(usage instanceof UsageRecord)) {
    throw new MetricsError('usage must be a UsageRecord')
  }
  if (!(model instanceof CostModel)) {
    throw new MetricsError('model must be a CostModel')
  }
  const components: Record<string, number> = {
    model_input_usd: round(
      (usage.inputTokens / 1000) * model.inputUsdPer1kTokens,
    ),
    model_output_usd: round(
      (usage.outputTokens / 1000) * model.outputUsdPer1kTokens,
    ),
    tool_call_usd: round(usage.toolCalls * model.toolCallUsd),
    simulation_usd: round(usage.simulationMinutes * model.simulationMinuteUsd),
  }
  const total = round(
    Object.values(components).reduce((sum, value) => sum + value, 0),
  )
  return Object.freeze({
    modelId: model.modelId,
    currency: model.currency,
    components: Object.freeze(components),
    total,
    usage,
    synthetic: model.synthetic,
    billingConnected: BILLING_CONNECTED,
  })
}

export class CostEstimator {
  private readonly modelMap: Readonly<Record<string, CostModel>>

  constructor(models?: Readonly<Record<string, CostModel>>) {
    this.modelMap = models ?? DEFAULT_COST_MODELS
    for (const [name, model] of Object.entries(this.modelMap)) {
      if (!(model instanceof CostModel) || model.modelId !== name) {
        throw new MetricsError(`cost model '${name}' is inconsistent`)
      }
    }
    if (Object.keys(this.modelMap).length === 0) {
      throw new MetricsError('cost estimator needs at least one model')
    }
  }

  get models(): Readonly<Record<string, CostModel>> {
    return this.modelMap
  }

  estimate(usage: UsageRecord, modelId: string): CostEstimate {
    const model = this.modelMap[modelId]
    if (model === undefined) {
      throw new MetricsError(`unknown cost model '${modelId}'`)
    }
    return estimateCost(usage, model)
  }

  estimateMulti(
    usageByModel: Readonly<Record<string, UsageRecord>>,
  ): CostEstimate {
    const modelIds = Object.keys(usageByModel).sort()
    if (modelIds.length === 0) {
      throw new MetricsError('usageByModel must not be empty')
    }
    const components: Record<string, number> = {}
    let total = 0
    let currency = 'USD'
    let synthetic = true
    for (const modelId of modelIds) {
      const estimate = this.estimate(usageByModel[modelId], modelId)
      currency = estimate.currency
      synthetic = synthetic && estimate.synthetic
      for (const [key, value] of Object.entries(estimate.components)) {
        components[`${modelId}.${key}`] = value
      }
      total += estimate.total
    }
    total = round(total)
    const usages = modelIds.map((modelId) => usageByModel[modelId])
    const combinedUsage = new UsageRecord({
      inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
      toolCalls: usages.reduce((sum, usage) => sum + usage.toolCalls, 0),
      simulationMinutes: usages.reduce(
        (sum, usage) => sum + usage.simulationMinutes,
        0,
      ),
      cacheHits: usages.reduce((sum, usage) => sum + usage.cacheHits, 0),
    })
    return Object.freeze({
      modelId: 'combined',
      currency,
      components: Object.freeze(components),
      total,
      usage: combinedUsage,
      synthetic,
      billingConnected: BILLING_CONNECTED,
    })
  }

  static withinBudget(estimate: CostEstimate, budgetUsd: number): boolean {
    if (estimate === null || typeof estimate !== 'object') {
      throw new MetricsError('estimate must be a CostEstimate')
    }
    const budget = nonNegativeFloat(budgetUsd, 'budgetUsd')
    return round(estimate.total) <= round(budget)
  }
}
