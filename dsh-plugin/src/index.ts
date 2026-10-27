/**
 * AEH education plugin entry for dsh / Cordis.
 *
 * Cordis function-plugin shape:
 *   - `name`       display/diagnostic identity;
 *   - `inject`     wait for the `tools` service;
 *   - `apply`      register reversible tool effects on this context.
 *
 * The default profile exposes only compute/prepare tools. It has no raw-student
 * data access, no database write, no credentials, no filesystem/network access,
 * no observed-twin write, and no way to override the curriculum gate.
 */

import type { Context } from './dsh.ts'
import {
  assertMinimalPermissions,
  MINIMAL_PERMISSIONS,
  type PermissionRequest,
} from './permissions.ts'
import {
  createEducationService,
  normalizeConfig,
  type Config,
  type HostContext,
} from './service.ts'
import { createEducationTools } from './tools.ts'

export const name = 'aeh-education'

/** The tool registry is the only required Cordis service. */
export const inject = ['tools']

/** Machine-checkable minimal permission manifest for host review. */
export const permissions = MINIMAL_PERMISSIONS

export interface PluginConfig extends Config {
  /**
   * Optional request from the host. It may only narrow or restate the minimal
   * manifest; any denied capability makes plugin activation fail closed.
   */
  readonly permissions?: PermissionRequest
  /**
   * Host-owned catalog/progress resolver. A real adapter injects this from the
   * authorised session; it is not a serialisable YAML field and it defaults to
   * "resolve nothing", so tools fail closed until the host wires it in.
   */
  readonly host?: HostContext
}

/**
 * Register the AEH education tools.
 *
 * Every registration is owned by one `ctx.effect`, so unloading or hot-replacing
 * the plugin removes all tools even if a later registration throws.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  assertMinimalPermissions(config.permissions)
  const resolved = normalizeConfig({
    profile: config.profile,
    targetRetention: config.targetRetention,
    allowedModes: config.allowedModes,
  })
  const service = createEducationService(resolved, config.host)

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const tool of createEducationTools(service)) {
        disposers.push(ctx.tools.register(tool))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        dispose()
      }
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        dispose()
      }
    }
  })
}

export { MINIMAL_PERMISSIONS, permissionSummary } from './permissions.ts'
export { createEducationTools } from './tools.ts'
export {
  AehEducationService,
  NO_HOST_CONTEXT,
  createEducationService,
  normalizeConfig,
  type HostContext,
} from './service.ts'
export { StudentTwin } from './core/twin.ts'
export { allow, allowedKcs } from './core/curriculum-gate.ts'
export {
  retrievability,
  intervalForTarget,
  updateMemory,
} from './core/memory.ts'
export { HypothesisSet } from './core/hypothesis.ts'
export { selectProbe } from './core/diagnosis.ts'
export { validatePackage, deliver } from './core/exercise.ts'

export {
  ApprovalLedger,
  DeliveryDeniedError,
  HostDeliveryAdapter,
  type HostApprovalRecord,
  type HostDeliveryReceipt,
} from './host/delivery.ts'
export {
  CONSENT_SCOPES,
  ConsentError,
  ConsentSnapshot,
  type ConsentGrant,
  type ConsentScope,
  type ConsentSnapshotView,
} from './host/consent.ts'
export {
  HostAuthorizationError,
  MemoryHostContext,
  type AuthorizedSessionSnapshot,
  type MemoryHostContextOptions,
} from './host/host-context.ts'
export {
  IdempotencyConflictError,
  MemoryHostTwin,
  type AttestationVerifier,
  type HostAuditEntry,
  type MemoryHostTwinOptions,
  type SourceAttestation,
  type TwinAppendResult,
  type TwinRollbackResult,
} from './host/twin-adapter.ts'
