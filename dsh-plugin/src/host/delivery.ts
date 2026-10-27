/**
 * Host-side delivery gate (synthetic/test only).
 *
 * The model-facing `aeh_prepare_intervention` tool stops at "prepared". This
 * module lives outside the tool registry and models the host obligations that
 * must happen **before** an actual LMS/UI delivery:
 *
 * 1. the exact session/tenant still owns the host context;
 * 2. the intervention-delivery consent scope is active;
 * 3. a separate approval record names this package and student;
 * 4. the package is re-resolved and re-validated through the host catalog and
 *    curriculum gate at delivery time.
 *
 * It returns an in-memory receipt; it has no network, database, or student UI
 * channel. It is therefore not a production delivery adapter and must not be
 * described as one.
 */

import type { GateMode } from '../domain.ts'
import type {
  AehEducationService,
  InterventionPackageRefInput,
} from '../service.ts'
import type { ConsentSnapshot } from './consent.ts'
import type { MemoryHostContext } from './host-context.ts'

export interface HostApprovalRecord {
  readonly approvalId: string
  readonly packageId: string
  readonly studentRef: string
  readonly approvedBy: string
  readonly approvedAt: string
  readonly decision: 'approved' | 'rejected'
  readonly scope: 'intervention:deliver'
  readonly expiresAt?: string | null
}

export interface HostDeliveryReceipt {
  readonly deliveryId: string
  readonly approvalId: string
  readonly packageId: string
  readonly studentRef: string
  readonly deliveredAt: string
  readonly itemIds: readonly string[]
  readonly mode: GateMode | string
  readonly channel: 'host-memory-test'
  readonly externalEffect: false
}

export class DeliveryDeniedError extends Error {
  readonly code = 'AEH_DELIVERY_DENIED'

  constructor(message: string) {
    super(message)
    this.name = 'DeliveryDeniedError'
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty single-line string`)
  }
  return value
}

function requireTimestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`)
  }
  return value
}

function freezeApproval(record: HostApprovalRecord): HostApprovalRecord {
  if (record.scope !== 'intervention:deliver') {
    throw new DeliveryDeniedError('approval must use intervention:deliver scope')
  }
  if (record.decision !== 'approved' && record.decision !== 'rejected') {
    throw new DeliveryDeniedError('approval decision must be approved or rejected')
  }
  return Object.freeze({
    approvalId: requireText(record.approvalId, 'approvalId'),
    packageId: requireText(record.packageId, 'packageId'),
    studentRef: requireText(record.studentRef, 'studentRef'),
    approvedBy: requireText(record.approvedBy, 'approvedBy'),
    approvedAt: requireTimestamp(record.approvedAt, 'approvedAt'),
    decision: record.decision,
    scope: 'intervention:deliver',
    expiresAt:
      record.expiresAt === undefined || record.expiresAt === null
        ? null
        : requireTimestamp(record.expiresAt, 'expiresAt'),
  })
}

/** Append-only, idempotent approval ledger. */
export class ApprovalLedger {
  private readonly records = new Map<string, HostApprovalRecord>()

  append(record: HostApprovalRecord): HostApprovalRecord {
    const frozen = freezeApproval(record)
    const existing = this.records.get(frozen.approvalId)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(frozen)) {
        throw new DeliveryDeniedError(
          `approval id ${JSON.stringify(frozen.approvalId)} was reused with different content`,
        )
      }
      return existing
    }
    this.records.set(frozen.approvalId, frozen)
    return frozen
  }

  get(approvalId: string): HostApprovalRecord | undefined {
    return this.records.get(approvalId)
  }

  list(): readonly HostApprovalRecord[] {
    return Object.freeze([...this.records.values()])
  }
}

export interface HostDeliveryAdapterOptions {
  readonly host: MemoryHostContext
  readonly service: AehEducationService
  readonly approvals: ApprovalLedger
  readonly consent: ConsentSnapshot
  readonly now?: () => string
}

/** Re-check session, consent, approval, and gate before returning a receipt. */
export class HostDeliveryAdapter {
  private readonly host: MemoryHostContext
  private readonly service: AehEducationService
  private readonly approvals: ApprovalLedger
  private readonly consent: ConsentSnapshot
  private readonly now: () => string
  private readonly receipts = new Map<string, HostDeliveryReceipt>()

  constructor(options: HostDeliveryAdapterOptions) {
    this.host = options.host
    this.service = options.service
    this.approvals = options.approvals
    this.consent = options.consent
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /**
   * Revalidate and return an idempotent in-memory receipt.
   *
   * This method never contacts a student device, LMS, database, or network.
   * Repeating the same approval id returns the same receipt.
   */
  deliver(
    input: InterventionPackageRefInput,
    approvalId: string,
  ): HostDeliveryReceipt {
    this.host.assertSession(this.host.session.sessionId)
    this.consent.require('intervention:deliver')

    const existing = this.receipts.get(approvalId)
    if (existing !== undefined) {
      if (existing.packageId !== input.packageId) {
        throw new DeliveryDeniedError('approval was already used for another package')
      }
      return existing
    }

    const approval = this.approvals.get(approvalId)
    if (approval === undefined) {
      throw new DeliveryDeniedError('approval record not found')
    }
    if (approval.decision !== 'approved') {
      throw new DeliveryDeniedError('approval record is not approved')
    }
    if (approval.packageId !== input.packageId) {
      throw new DeliveryDeniedError('approval does not name this package')
    }
    if (approval.studentRef !== this.host.session.studentRef) {
      throw new DeliveryDeniedError('approval does not name this student')
    }
    const now = this.now()
    if (approval.expiresAt !== null && approval.expiresAt !== undefined) {
      if (Date.parse(approval.expiresAt) <= Date.parse(now)) {
        throw new DeliveryDeniedError('approval has expired')
      }
    }

    const prepared = this.service.prepareInterventionFor(
      input,
      this.host.session.studentRef,
      input.schoolMode,
    )
    if (!prepared.valid) {
      throw new DeliveryDeniedError(
        `package failed delivery-time gate: ${prepared.reasons.join(', ')}`,
      )
    }

    const ids = [...input.trainingItemIds, ...(input.transferItemIds ?? [])]
    const receipt: HostDeliveryReceipt = Object.freeze({
      deliveryId: `delivery_${approvalId}`,
      approvalId,
      packageId: input.packageId,
      studentRef: this.host.session.studentRef,
      deliveredAt: now,
      itemIds: Object.freeze(ids),
      mode: input.schoolMode ?? 'learn',
      channel: 'host-memory-test',
      externalEffect: false,
    })
    this.receipts.set(approvalId, receipt)
    return receipt
  }

  receiptsFor(): readonly HostDeliveryReceipt[] {
    return Object.freeze([...this.receipts.values()])
  }
}
