/**
 * Session/agent-scoped hypothesis snapshot store (Step 7 / P1 item 3).
 *
 * Short-term virtual-student hypotheses are *session state*, not long-term
 * evidence. This in-memory store binds every stored snapshot to the dsh
 * session (and, when the runtime supplies one, the agent identity — dsh agents
 * and sessions share one id), gives it an explicit TTL, and removes it on
 * session end, TTL expiry, or explicit delete. A read with a different
 * session/agent scope, an unknown reference, or an expired reference resolves
 * to `undefined`; it is never "adopted" by another session.
 *
 * The store is intentionally independent from `StudentTwin` /
 * `MemoryHostTwin`: nothing here is an observed event, nothing is appended to
 * an event log, and the long-term twin has no read or write path into it. A
 * test asserts a twin's version is unchanged after a snapshot round-trip.
 *
 * This is a synthetic/test implementation. A production adapter still needs a
 * durable, access-controlled session store with the same TTL/scope semantics.
 */

import { AehError, type HypothesisState } from '../domain.ts'

export interface SessionScope {
  /** Host-issued opaque session id; never rendered in tool output. */
  readonly sessionId: string
  /** Optional agent id when the runtime distinguishes agent from session. */
  readonly agentId?: string
}

export class SessionScopeError extends AehError {
  readonly code = 'AEH_SESSION_SCOPE_INVALID'
}

export interface SessionSnapshotRecord {
  readonly snapshotRef: string
  readonly sessionId: string
  /** `null` when the tool ran without an agent-scoped execution. */
  readonly agentId: string | null
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly expiresAt: string
  readonly state: HypothesisState
  readonly weights: Readonly<Record<string, number>>
  readonly dominantId: string | null
  readonly transitions: number
}

export interface SessionSnapshotInput {
  readonly state: HypothesisState
  readonly weights: Readonly<Record<string, number>>
  readonly dominantId: string | null
  readonly transitions: number
}

export interface SessionSnapshotStoreOptions {
  /** Snapshot lifetime in milliseconds. Default 15 minutes. */
  readonly ttlMs?: number
  /** Injectable monotonic clock in milliseconds. */
  readonly now?: () => number
  /** Per-scope cap; the oldest snapshot in the scope is evicted beyond it. */
  readonly maxEntriesPerScope?: number
  /** Global cap; expired entries are swept first, then the oldest. */
  readonly maxEntries?: number
  /** Injectable opaque id factory for deterministic tests. */
  readonly idFactory?: () => string
}

export const DEFAULT_SESSION_SNAPSHOT_TTL_MS = 15 * 60 * 1000

function assertScope(scope: SessionScope): SessionScope {
  const sessionId = scope?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SessionScopeError('sessionId is required for session-scoped state')
  }
  if (sessionId.length > 200 || /[\r\n]/.test(sessionId)) {
    throw new SessionScopeError('sessionId must be a short single-line reference')
  }
  const agentId = scope.agentId
  if (agentId !== undefined) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new SessionScopeError('agentId must be a non-empty string when set')
    }
    if (agentId.length > 200 || /[\r\n]/.test(agentId)) {
      throw new SessionScopeError('agentId must be a short single-line reference')
    }
  }
  return Object.freeze(agentId === undefined ? { sessionId } : { sessionId, agentId })
}

function scopeKey(scope: SessionScope): string {
  return `${scope.sessionId}\u0000${scope.agentId ?? ''}`
}

function recordScopeKey(record: SessionSnapshotRecord): string {
  return `${record.sessionId}\u0000${record.agentId ?? ''}`
}

/** Append-free, TTL'd, session/agent-isolated snapshot store. */
export class SessionSnapshotStore {
  private readonly records = new Map<string, SessionSnapshotRecord>()
  private readonly byScope = new Map<string, string[]>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly maxEntriesPerScope: number
  private readonly maxEntries: number
  private readonly idFactory: (() => string) | undefined
  private counter = 0

  constructor(options: SessionSnapshotStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_SNAPSHOT_TTL_MS
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError('ttlMs must be a finite number > 0')
    }
    const maxEntriesPerScope = options.maxEntriesPerScope ?? 16
    const maxEntries = options.maxEntries ?? 512
    if (!Number.isInteger(maxEntriesPerScope) || maxEntriesPerScope <= 0) {
      throw new RangeError('maxEntriesPerScope must be a positive integer')
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer')
    }
    this.ttlMs = ttlMs
    this.now = options.now ?? (() => Date.now())
    this.maxEntriesPerScope = maxEntriesPerScope
    this.maxEntries = maxEntries
    this.idFactory = options.idFactory
  }

  get ttl(): number {
    return this.ttlMs
  }

  /**
   * Store one snapshot for the exact session/agent scope and return the frozen
   * record (including its `snapshotRef`). Expired entries are swept first so a
   * scope cannot grow past its cap.
   */
  put(scope: SessionScope, input: SessionSnapshotInput): SessionSnapshotRecord {
    const safeScope = assertScope(scope)
    this.sweep()
    const nowMs = this.now()
    const snapshotRef = this.nextRef()
    const record: SessionSnapshotRecord = Object.freeze({
      snapshotRef,
      sessionId: safeScope.sessionId,
      agentId: safeScope.agentId ?? null,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      state: input.state,
      weights: Object.freeze({ ...input.weights }),
      dominantId: input.dominantId,
      transitions: input.transitions,
    })
    this.records.set(snapshotRef, record)
    const key = scopeKey(safeScope)
    const refs = this.byScope.get(key) ?? []
    refs.push(snapshotRef)
    this.byScope.set(key, refs)
    this.enforceCaps()
    return record
  }

  /**
   * Read a snapshot for the exact session/agent scope. Returns `undefined` for
   * an unknown, expired, or foreign-scope reference; an expired entry is also
   * removed as a side effect.
   */
  get(snapshotRef: string, scope: SessionScope): SessionSnapshotRecord | undefined {
    const safeScope = assertScope(scope)
    const record = this.records.get(snapshotRef)
    if (record === undefined) return undefined
    if (this.isExpired(record)) {
      this.remove(snapshotRef)
      return undefined
    }
    if (recordScopeKey(record) !== scopeKey(safeScope)) return undefined
    return record
  }

  /** Delete one snapshot; scope must match to avoid cross-session deletion. */
  delete(snapshotRef: string, scope: SessionScope): boolean {
    const safeScope = assertScope(scope)
    const record = this.records.get(snapshotRef)
    if (
      record === undefined ||
      recordScopeKey(record) !== scopeKey(safeScope)
    ) {
      return false
    }
    this.remove(snapshotRef)
    return true
  }

  /**
   * Remove every snapshot for one session, across every agent scope. Called on
   * dsh `session/disposed` (or host session end); afterwards no other session
   * can read those references because they no longer exist.
   */
  endSession(sessionId: string): number {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    let removed = 0
    for (const [ref, record] of [...this.records]) {
      if (record.sessionId === sessionId) {
        this.remove(ref)
        removed += 1
      }
    }
    return removed
  }

  /** Remove every expired snapshot. Returns the number removed. */
  sweep(): number {
    let removed = 0
    for (const [ref, record] of [...this.records]) {
      if (this.isExpired(record)) {
        this.remove(ref)
        removed += 1
      }
    }
    return removed
  }

  /** Alias used by hosts that schedule periodic cleanup. */
  cleanupExpired(): number {
    return this.sweep()
  }

  /**
   * Drop every snapshot regardless of TTL. Used on plugin unload; returns the
   * number removed.
   */
  clear(): number {
    const removed = this.records.size
    this.records.clear()
    this.byScope.clear()
    return removed
  }

  get size(): number {
    return this.records.size
  }

  /** Scope count without exposing session ids or state. */
  scopes(): number {
    return this.byScope.size
  }

  /** Audit/inspection view: counts only, never state or raw scope ids. */
  snapshot(): Readonly<Record<string, number | boolean>> {
    let expired = 0
    for (const record of this.records.values()) {
      if (this.isExpired(record)) expired += 1
    }
    return Object.freeze({
      entries: this.records.size,
      scopes: this.byScope.size,
      expired,
      sessionScoped: true,
      longTermTwinWrite: false,
    })
  }

  private nextRef(): string {
    if (this.idFactory !== undefined) {
      const custom = this.idFactory()
      if (typeof custom !== 'string' || custom.length === 0) {
        throw new SessionScopeError('idFactory must return a non-empty string')
      }
      return custom
    }
    this.counter += 1
    return `hyp_${this.counter.toString(36)}`
  }

  private isExpired(record: SessionSnapshotRecord): boolean {
    return this.now() >= record.expiresAtMs
  }

  private remove(snapshotRef: string): void {
    const record = this.records.get(snapshotRef)
    if (record === undefined) return
    this.records.delete(snapshotRef)
    const key = recordScopeKey(record)
    const refs = this.byScope.get(key)
    if (refs !== undefined) {
      const next = refs.filter((ref) => ref !== snapshotRef)
      if (next.length === 0) this.byScope.delete(key)
      else this.byScope.set(key, next)
    }
  }

  private enforceCaps(): void {
    for (const [, refs] of this.byScope) {
      while (refs.length > this.maxEntriesPerScope) {
        const oldest = refs.shift()
        if (oldest !== undefined) this.remove(oldest)
      }
    }
    if (this.records.size <= this.maxEntries) return
    const ordered = [...this.records.values()].sort(
      (a, b) => a.createdAtMs - b.createdAtMs,
    )
    const excess = this.records.size - this.maxEntries
    for (let index = 0; index < excess; index += 1) {
      const victim = ordered[index]
      if (victim !== undefined) this.remove(victim.snapshotRef)
    }
  }
}

/** Extract a session/agent scope from a dsh tool execution context. */
export function scopeFromExecution(
  exec: { readonly agent?: { readonly id?: string } } | undefined,
): SessionScope | undefined {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  return Object.freeze({ sessionId })
}
