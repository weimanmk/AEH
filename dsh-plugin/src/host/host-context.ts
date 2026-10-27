/**
 * In-memory authorised host context (synthetic/test only).
 *
 * The model supplies opaque `studentRef` / `itemId` strings. This adapter owns
 * the mapping from those strings to trusted progress and curriculum
 * annotations, and binds that mapping to **one** authenticated session, tenant,
 * and consent snapshot. A request for another student, another tenant, a
 * revoked consent scope, or an unknown item resolves to `undefined`; the
 * service converts that to a fail-closed gate decision. The adapter never
 * throws on an ordinary unauthorised read, so a caller cannot distinguish
 * "denied" from "absent".
 */

import type { CurriculumItem, LearnerProgress } from '../domain.ts'
import type {
  ItemBank,
  KnowledgeGraph,
  RetrievalHit,
  RetrievalQuery,
} from '../core/curriculum-graph.ts'
import type { HostContext } from '../service.ts'
import type { ConsentSnapshot } from './consent.ts'

export class HostAuthorizationError extends Error {
  readonly code = 'AEH_HOST_UNAUTHORIZED'

  constructor(message: string) {
    super(message)
    this.name = 'HostAuthorizationError'
  }
}

export interface AuthorizedSessionSnapshot {
  /** Host-issued opaque session id; never exposed to the model. */
  readonly sessionId: string
  /** Host-issued opaque tenant id. */
  readonly tenantId: string
  /** The one student this session may read. */
  readonly studentRef: string
}

export interface MemoryHostContextOptions {
  readonly session: AuthorizedSessionSnapshot
  readonly consent: ConsentSnapshot
  /** Trusted progress snapshots for this tenant. Only `session.studentRef` is readable. */
  readonly progress: readonly LearnerProgress[]
  /** Trusted curriculum catalog for this tenant. */
  readonly catalog: readonly CurriculumItem[]
  /**
   * Step 9: optional tenant-scoped item bank. Every current version is added
   * to the readable catalog; retrieval hits are still re-resolved through it.
   */
  readonly itemBank?: ItemBank
  /** Step 9: optional tenant/session-scoped curriculum graph version. */
  readonly graph?: KnowledgeGraph
}

function assertOpaque(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} is required`)
  }
  if (value.length > 200 || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a short single-line reference`)
  }
  return value
}

function freezeProgress(progress: LearnerProgress): LearnerProgress {
  return Object.freeze({
    ...progress,
    taughtKcs: Object.freeze([...(progress.taughtKcs ?? [])]),
    inProgressKcs: Object.freeze([...(progress.inProgressKcs ?? [])]),
    confirmedPreviewKcs: Object.freeze([
      ...(progress.confirmedPreviewKcs ?? []),
    ]),
    confirmedPriorKcs: Object.freeze([...(progress.confirmedPriorKcs ?? [])]),
  })
}

function freezeItem(item: CurriculumItem): CurriculumItem {
  return Object.freeze({
    ...item,
    requiredKcs: Object.freeze([...(item.requiredKcs ?? [])]),
    futureMethods: Object.freeze([...(item.futureMethods ?? [])]),
  })
}

/** One tenant/session-bound resolver with revocable reads. */
export class MemoryHostContext implements HostContext {
  readonly session: AuthorizedSessionSnapshot
  readonly consent: ConsentSnapshot
  private readonly progressByStudent: ReadonlyMap<string, LearnerProgress>
  private readonly itemsById: ReadonlyMap<string, CurriculumItem>
  private readonly itemBank: ItemBank | undefined
  private readonly graph: KnowledgeGraph | undefined

  constructor(options: MemoryHostContextOptions) {
    const session = Object.freeze({
      sessionId: assertOpaque(options.session.sessionId, 'sessionId'),
      tenantId: assertOpaque(options.session.tenantId, 'tenantId'),
      studentRef: assertOpaque(options.session.studentRef, 'studentRef'),
    })
    this.session = session
    this.consent = options.consent

    const progress = new Map<string, LearnerProgress>()
    for (const snapshot of options.progress) {
      if (snapshot.studentRef !== session.studentRef) continue
      progress.set(snapshot.studentRef, freezeProgress(snapshot))
    }
    this.progressByStudent = progress

    const items = new Map<string, CurriculumItem>()
    for (const item of options.catalog) {
      const itemId = assertOpaque(item.itemId, 'itemId')
      if (items.has(itemId)) {
        throw new TypeError(`duplicate catalog item id: ${itemId}`)
      }
      items.set(itemId, freezeItem(item))
    }
    if (options.itemBank !== undefined) {
      for (const record of options.itemBank.listCurrent()) {
        const item = options.itemBank.toCurriculumItem(record.itemId)
        const itemId = assertOpaque(item.itemId, 'itemId')
        if (items.has(itemId)) {
          throw new TypeError(`duplicate catalog item id: ${itemId}`)
        }
        items.set(itemId, freezeItem(item))
      }
    }
    this.itemsById = items
    this.itemBank = options.itemBank
    this.graph = options.graph
  }

  /**
   * The student this session may read, or `undefined` after consent
   * revocation. The service's own check and `resolveProgress` are independent
   * fail-closed layers.
   */
  get authorizedStudentRef(): string | undefined {
    return this.consent.has('curriculum:read')
      ? this.session.studentRef
      : undefined
  }

  /** Host-issued opaque tenant reference for non-re-identifiable audit metrics. */
  get tenantRef(): string {
    return this.session.tenantId
  }

  /** True only for the exact session this adapter was constructed for. */
  matchesSession(sessionId: string): boolean {
    return sessionId === this.session.sessionId
  }

  /** Throw on a session mismatch; used by host-side delivery, never by tools. */
  assertSession(sessionId: string): void {
    if (!this.matchesSession(sessionId)) {
      throw new HostAuthorizationError('session does not own this host context')
    }
    this.consent.require('curriculum:read')
  }

  resolveProgress(studentRef: string): LearnerProgress | undefined {
    if (!this.readAllowed()) return undefined
    if (studentRef !== this.session.studentRef) return undefined
    return this.progressByStudent.get(studentRef)
  }

  resolveItem(itemId: string): CurriculumItem | undefined {
    if (!this.readAllowed()) return undefined
    return this.itemsById.get(itemId)
  }

  /** Step 9: the current tenant/session graph, or `undefined` when revoked. */
  resolveGraph(): KnowledgeGraph | undefined {
    if (!this.readAllowed()) return undefined
    return this.graph
  }

  /**
   * Step 9: local retrieval over this session's item bank. A revoked consent
   * scope or missing bank returns no hits; callers must still re-run the gate.
   */
  retrieveItems(query: RetrievalQuery): readonly RetrievalHit[] {
    if (!this.readAllowed() || this.itemBank === undefined) {
      return Object.freeze([] as RetrievalHit[])
    }
    return this.itemBank.search(query)
  }

  /** Host-side inspection for audit/tests; contains only synthetic refs. */
  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      sessionId: this.session.sessionId,
      tenantId: this.session.tenantId,
      studentRef: this.session.studentRef,
      consent: this.consent.snapshot(),
      authorized: this.readAllowed(),
      readableStudentRef: this.authorizedStudentRef ?? null,
      itemCount: this.itemsById.size,
      graphVersion: this.graph?.version ?? null,
      retrievalIndexed: this.itemBank !== undefined,
    })
  }

  /**
   * Plain own-property `HostContext` binding for config transports that only
   * copy data properties (e.g. the Cordis loader turns a class instance into a
   * plain object). The returned functions are closed over this adapter, so
   * consent revocation still takes effect even though the wrapper is a copy.
   */
  toHostBinding(): HostContext {
    const host = this
    return Object.freeze({
      get authorizedStudentRef(): string | undefined {
        return host.authorizedStudentRef
      },
      get tenantRef(): string | undefined {
        return host.tenantRef
      },
      resolveProgress(studentRef: string): LearnerProgress | undefined {
        return host.resolveProgress(studentRef)
      },
      resolveItem(itemId: string): CurriculumItem | undefined {
        return host.resolveItem(itemId)
      },
      resolveGraph(): KnowledgeGraph | undefined {
        return host.resolveGraph()
      },
      retrieveItems(query: RetrievalQuery): readonly RetrievalHit[] {
        return host.retrieveItems(query)
      },
    })
  }

  private readAllowed(): boolean {
    return this.consent.has('curriculum:read')
  }
}
