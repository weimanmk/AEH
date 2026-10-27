/**
 * Append-only AEH audit log with non-re-identifiable student/tenant dimensions
 * (Step 7 / P1 item 4).
 *
 * Scope of what is recorded:
 *
 * - curriculum-gate refusals (with their machine-readable reason codes);
 * - model-facing tool calls (tool name + accepted/rejected, never arguments);
 * - host approvals;
 * - host delivery receipts.
 *
 * What is deliberately **not** recorded: raw questions, answers, images,
 * prompts, step traces, or any arbitrary payload. `append` recursively rejects
 * forbidden keys and refuses non-scalar detail, so a caller cannot smuggle raw
 * student data into a "detail" field.
 *
 * Student and tenant dimensions are stored as salted, tenant-scoped SHA-256
 * pseudonyms (`studentKey` / `tenantKey`), never the raw references. The salt
 * is an injected secret; by default a per-process random salt is generated so
 * entries from two runs are not linkable. This is **pseudonymisation, not
 * anonymisation**: a host that holds the salt can re-link a key, so the salt
 * must live in the same access-controlled secret store as the identity data,
 * not next to the audit log. A production adapter must add tamper-evident
 * storage and a retention policy; this class is in-memory only.
 */

import { createHash, randomBytes } from 'node:crypto'

import { AehError } from '../domain.ts'

export const AUDIT_EVENT_KINDS = Object.freeze([
  'gate.decision',
  'tool.call',
  'approval.record',
  'delivery.receipt',
  'session.cleanup',
] as const)

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number]

/**
 * Key names that would store raw student content. Checked case-insensitively
 * at every depth of `detail`; the audit log refuses the write instead of
 * redacting silently.
 */
export const AUDIT_FORBIDDEN_KEYS = Object.freeze([
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
] as const)

export class AuditError extends AehError {
  readonly code = 'AEH_AUDIT_REJECTED'
}

export type AuditScalar = string | number | boolean | null

export interface AuditRecordInput {
  readonly kind: AuditEventKind
  readonly action: string
  readonly outcome: 'accepted' | 'rejected'
  readonly reasonCodes?: readonly string[]
  readonly studentRef?: string
  readonly tenantRef?: string
  /** Scalar/array-of-scalar detail only; never raw student content. */
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface AuditRecord {
  readonly seq: number
  readonly at: string
  readonly kind: AuditEventKind
  readonly action: string
  readonly outcome: 'accepted' | 'rejected'
  readonly reasonCodes: readonly string[]
  /** Tenant-scoped pseudonym, or `null` when no student dimension was given. */
  readonly studentKey: string | null
  /** Pseudonym of the tenant dimension, or `null`. */
  readonly tenantKey: string | null
  readonly detail: Readonly<Record<string, AuditScalar | readonly AuditScalar[]>>
}

export interface AehAuditLogOptions {
  readonly now?: () => string
  /**
   * Secret salt for pseudonymisation. A random per-process salt is generated
   * when omitted; production must inject a secret-store value.
   */
  readonly salt?: string
  /** Fail-loud capacity; appends past it are rejected, never dropped. */
  readonly maxEntries?: number
}

export interface AuditMetrics {
  readonly total: number
  readonly byKind: Readonly<Record<string, number>>
  readonly byOutcome: Readonly<Record<string, number>>
  /** Counts keyed by pseudonymous student dimension. */
  readonly byStudentKey: Readonly<Record<string, number>>
  /** Counts keyed by pseudonymous tenant dimension. */
  readonly byTenantKey: Readonly<Record<string, number>>
}

function hashKey(salt: string, tenantRef: string, ref: string): string {
  return createHash('sha256')
    .update(`${salt}\u0000${tenantRef}\u0000${ref}`)
    .digest('hex')
    .slice(0, 32)
}

function scalar(value: unknown, path: string): AuditScalar | readonly AuditScalar[] {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') {
    if (type === 'number' && !Number.isFinite(value as number)) {
      throw new AuditError(`${path} must be a finite number`)
    }
    if (type === 'string' && (value as string).length > 500) {
      throw new AuditError(`${path} is too long for an audit detail`)
    }
    return value as AuditScalar
  }
  if (Array.isArray(value)) {
    const flat: AuditScalar[] = []
    value.forEach((entry, index) => {
      const item = scalar(entry, `${path}[${index}]`)
      // `Array.isArray` does not narrow a `readonly T[]` union member, so an
      // explicit object check keeps the flat-array guarantee type-safe.
      if (item !== null && typeof item === 'object') {
        throw new AuditError(`${path}[${index}] must not nest arrays`)
      }
      flat.push(item)
    })
    return Object.freeze(flat)
  }
  throw new AuditError(
    `${path} must be a scalar or an array of scalars; the audit log does not store payloads`,
  )
}

function sanitizeDetail(
  detail: Readonly<Record<string, unknown>>,
): Readonly<Record<string, AuditScalar | readonly AuditScalar[]>> {
  const clean: Record<string, AuditScalar | readonly AuditScalar[]> = {}
  for (const [key, value] of Object.entries(detail)) {
    if ((AUDIT_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new AuditError(
        `audit detail key '${key}' would store raw student data; the audit log ` +
          'only holds opaque ids, counts, versions, and reason codes',
      )
    }
    clean[key] = scalar(value, `detail.${key}`)
  }
  return Object.freeze(clean)
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new AuditError(`${field} must be a non-empty string`)
  }
  if (/[\r\n]/.test(value)) {
    throw new AuditError(`${field} must be a single-line string`)
  }
  return value
}

/** Append-only in-memory audit log; it has no update or delete method. */
export class AehAuditLog {
  private readonly records: AuditRecord[] = []
  private readonly now: () => string
  private readonly salt: string
  private readonly maxEntries: number
  private seq = 0

  constructor(options: AehAuditLogOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    const salt = options.salt ?? randomBytes(16).toString('hex')
    if (typeof salt !== 'string' || salt.length === 0) {
      throw new AuditError('audit salt must be a non-empty secret string')
    }
    this.salt = salt
    const maxEntries = options.maxEntries ?? 10000
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new AuditError('maxEntries must be a positive integer')
    }
    this.maxEntries = maxEntries
  }

  append(input: AuditRecordInput): AuditRecord {
    if (!(AUDIT_EVENT_KINDS as readonly string[]).includes(input.kind)) {
      throw new AuditError(`unknown audit event kind: ${String(input.kind)}`)
    }
    if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
      throw new AuditError('audit outcome must be accepted or rejected')
    }
    if (this.records.length >= this.maxEntries) {
      throw new AuditError('audit log capacity exceeded; refusing to drop records')
    }

    const action = requireText(input.action, 'action')
    const tenantRef =
      typeof input.tenantRef === 'string' && input.tenantRef.length > 0
        ? input.tenantRef
        : null
    const studentRef =
      typeof input.studentRef === 'string' && input.studentRef.length > 0
        ? input.studentRef
        : null
    const reasonCodes = (input.reasonCodes ?? []).map((code) =>
      requireText(code, 'reasonCodes[]'),
    )

    this.seq += 1
    const record: AuditRecord = Object.freeze({
      seq: this.seq,
      at: this.now(),
      kind: input.kind,
      action,
      outcome: input.outcome,
      reasonCodes: Object.freeze(reasonCodes),
      studentKey:
        studentRef === null
          ? null
          : hashKey(this.salt, tenantRef ?? '', studentRef),
      tenantKey:
        tenantRef === null ? null : hashKey(this.salt, '', tenantRef),
      detail: sanitizeDetail(input.detail ?? {}),
    })
    this.records.push(record)
    return record
  }

  /** Record a curriculum-gate decision, with refusal reason codes. */
  recordGateDecision(input: {
    readonly studentRef?: string
    readonly tenantRef?: string
    readonly itemId: string | null
    readonly mode: string
    readonly allowed: boolean
    readonly reasons: readonly string[]
  }): AuditRecord {
    return this.append({
      kind: 'gate.decision',
      action: 'aeh.curriculum_gate',
      outcome: input.allowed ? 'accepted' : 'rejected',
      reasonCodes: input.allowed ? [] : input.reasons,
      studentRef: input.studentRef,
      tenantRef: input.tenantRef,
      detail: {
        itemId: input.itemId,
        mode: input.mode,
        refusalCount: input.reasons.length,
      },
    })
  }

  /** Record one model-facing tool call; arguments are never recorded. */
  recordToolCall(input: {
    readonly tool: string
    readonly outcome: 'accepted' | 'rejected'
    readonly studentRef?: string
    readonly tenantRef?: string
    readonly reasonCode?: string
  }): AuditRecord {
    return this.append({
      kind: 'tool.call',
      action: input.tool,
      outcome: input.outcome,
      reasonCodes: input.reasonCode === undefined ? [] : [input.reasonCode],
      studentRef: input.studentRef,
      tenantRef: input.tenantRef,
    })
  }

  /** Record a host approval decision (no free-text rationale stored). */
  recordApproval(input: {
    readonly approvalId: string
    readonly packageId: string
    readonly decision: 'approved' | 'rejected'
    readonly studentRef?: string
    readonly tenantRef?: string
  }): AuditRecord {
    return this.append({
      kind: 'approval.record',
      action: 'host.approval',
      outcome: input.decision === 'approved' ? 'accepted' : 'rejected',
      studentRef: input.studentRef,
      tenantRef: input.tenantRef,
      detail: {
        approvalId: input.approvalId,
        packageId: input.packageId,
        decision: input.decision,
      },
    })
  }

  /** Record a host delivery receipt or a denied delivery attempt. */
  recordDeliveryReceipt(input: {
    readonly deliveryId: string
    readonly approvalId: string
    readonly packageId: string
    readonly outcome: 'accepted' | 'rejected'
    readonly itemCount?: number
    readonly channel?: string
    readonly reasonCode?: string
    readonly studentRef?: string
    readonly tenantRef?: string
  }): AuditRecord {
    return this.append({
      kind: 'delivery.receipt',
      action: 'host.delivery',
      outcome: input.outcome,
      reasonCodes: input.reasonCode === undefined ? [] : [input.reasonCode],
      studentRef: input.studentRef,
      tenantRef: input.tenantRef,
      detail: {
        deliveryId: input.deliveryId,
        approvalId: input.approvalId,
        packageId: input.packageId,
        itemCount: input.itemCount ?? 0,
        channel: input.channel ?? null,
      },
    })
  }

  entries(
    filter?: { readonly kind?: AuditEventKind; readonly action?: string },
  ): readonly AuditRecord[] {
    let result = [...this.records]
    if (filter?.kind !== undefined) {
      result = result.filter((record) => record.kind === filter.kind)
    }
    if (filter?.action !== undefined) {
      result = result.filter((record) => record.action === filter.action)
    }
    return Object.freeze(result)
  }

  get size(): number {
    return this.records.length
  }

  get head(): number {
    return this.seq
  }

  /**
   * Aggregate metrics with the pseudonymous student/tenant dimensions. The
   * returned keys are hashes, so the metric view is safe to ship to a
   * monitoring pipeline that must not receive raw student references.
   */
  metrics(): AuditMetrics {
    const byKind: Record<string, number> = {}
    const byOutcome: Record<string, number> = {}
    const byStudentKey: Record<string, number> = {}
    const byTenantKey: Record<string, number> = {}
    for (const record of this.records) {
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
      byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1
      if (record.studentKey !== null) {
        byStudentKey[record.studentKey] =
          (byStudentKey[record.studentKey] ?? 0) + 1
      }
      if (record.tenantKey !== null) {
        byTenantKey[record.tenantKey] = (byTenantKey[record.tenantKey] ?? 0) + 1
      }
    }
    return Object.freeze({
      total: this.records.length,
      byKind: Object.freeze(byKind),
      byOutcome: Object.freeze(byOutcome),
      byStudentKey: Object.freeze(byStudentKey),
      byTenantKey: Object.freeze(byTenantKey),
    })
  }
}
