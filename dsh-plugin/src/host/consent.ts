/**
 * Minimal, in-memory consent snapshot for host adapters.
 *
 * This is a **model**, not an identity provider. A real deployment must derive
 * these scopes from a verified guardian/school/student consent record and must
 * authenticate the subject before constructing the snapshot. Here every scope
 * is explicit, revocable, and fail-closed: a missing or revoked scope denies
 * the corresponding host operation.
 */

export const CONSENT_SCOPES = Object.freeze([
  'curriculum:read',
  'twin:observe',
  'twin:simulate',
  'twin:rollback',
  'intervention:deliver',
] as const)

export type ConsentScope = (typeof CONSENT_SCOPES)[number]

export interface ConsentGrant {
  /** One of the explicit scopes above; no wildcard scope exists. */
  readonly scope: ConsentScope
  readonly grantedAt: string
  /** Set when the grant was withdrawn; reads/writes must then fail closed. */
  readonly revokedAt?: string | null
}

export interface ConsentSnapshotView {
  readonly activeScopes: readonly ConsentScope[]
  readonly grants: readonly ConsentGrant[]
  readonly revokedScopes: readonly ConsentScope[]
}

export class ConsentError extends Error {
  readonly code = 'AEH_CONSENT_DENIED'

  constructor(message: string) {
    super(message)
    this.name = 'ConsentError'
  }
}

function validIso(value: string, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`)
  }
  return value
}

/**
 * Mutable revocation state over an immutable grant list.
 *
 * `has()` is the single decision point used by the host context, twin adapter,
 * and delivery adapter. Revocation is append-like: the grant keeps its original
 * `grantedAt` and gains `revokedAt`; history is never rewritten.
 */
export class ConsentSnapshot {
  private grants: ConsentGrant[]

  constructor(grants: readonly ConsentGrant[]) {
    const seen = new Set<ConsentScope>()
    this.grants = grants.map((grant) => {
      if (!(CONSENT_SCOPES as readonly string[]).includes(grant.scope)) {
        throw new ConsentError(`unknown consent scope: ${String(grant.scope)}`)
      }
      if (seen.has(grant.scope)) {
        throw new ConsentError(`duplicate consent scope: ${grant.scope}`)
      }
      seen.add(grant.scope)
      return Object.freeze({
        scope: grant.scope,
        grantedAt: validIso(grant.grantedAt, 'grantedAt'),
        revokedAt:
          grant.revokedAt === undefined || grant.revokedAt === null
            ? null
            : validIso(grant.revokedAt, 'revokedAt'),
      })
    })
  }

  /** Convenience constructor for the synthetic test profile. */
  static granted(
    scopes: readonly ConsentScope[],
    grantedAt = '2026-01-01T00:00:00.000Z',
  ): ConsentSnapshot {
    return new ConsentSnapshot(
      scopes.map((scope) => ({ scope, grantedAt })),
    )
  }

  has(scope: ConsentScope): boolean {
    const grant = this.grants.find((candidate) => candidate.scope === scope)
    return grant !== undefined && grant.revokedAt === null
  }

  require(scope: ConsentScope): void {
    if (!this.has(scope)) {
      throw new ConsentError(`consent scope ${JSON.stringify(scope)} is not active`)
    }
  }

  /** Revoke exactly one scope; unknown scopes are ignored (fail closed). */
  revoke(scope: ConsentScope, at = new Date().toISOString()): void {
    const stamp = validIso(at, 'revokedAt')
    this.grants = this.grants.map((grant) =>
      grant.scope === scope && grant.revokedAt === null
        ? Object.freeze({ ...grant, revokedAt: stamp })
        : grant,
    )
  }

  revokeAll(at = new Date().toISOString()): void {
    for (const scope of CONSENT_SCOPES) this.revoke(scope, at)
  }

  snapshot(): ConsentSnapshotView {
    const activeScopes = this.grants
      .filter((grant) => grant.revokedAt === null)
      .map((grant) => grant.scope)
    return Object.freeze({
      activeScopes: Object.freeze([...activeScopes]),
      grants: Object.freeze(
        this.grants.map((grant) => Object.freeze({ ...grant })),
      ),
      revokedScopes: Object.freeze(
        this.grants
          .filter((grant) => grant.revokedAt !== null)
          .map((grant) => grant.scope),
      ),
    })
  }
}
