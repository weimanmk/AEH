/**
 * Default-deny permission policy for the AEH education plugin.
 *
 * The plugin is useful with only an authorised curriculum snapshot, ephemeral
 * session hypotheses, and pure review/intervention computation. It never needs
 * raw student data, a database write, credentials, arbitrary filesystem access,
 * or network access. Observed-twin writes and gate overrides stay host-owned and
 * cannot be requested by this plugin.
 */

import { AehError } from './domain.ts'

export const ALLOWED_CAPABILITIES = Object.freeze([
  'curriculum:read',
  'session:hypothesis:write',
  'review:schedule:compute',
  'intervention:prepare',
] as const)

export type AehCapability = (typeof ALLOWED_CAPABILITIES)[number]

/** The only permission set the default plugin profile may use. */
export const MINIMAL_PERMISSIONS = Object.freeze({
  capabilities: ALLOWED_CAPABILITIES,
  studentRawData: false as const,
  databaseWrite: false as const,
  credentials: false as const,
  arbitraryFilesystem: false as const,
  network: false as const,
  observedTwinWrite: false as const,
  gateOverride: false as const,
  selfApprove: false as const,
})

export interface PermissionRequest {
  readonly capabilities?: readonly string[]
  readonly studentRawData?: boolean
  readonly databaseWrite?: boolean
  readonly credentials?: boolean
  readonly arbitraryFilesystem?: boolean
  readonly network?: boolean
  readonly observedTwinWrite?: boolean
  readonly gateOverride?: boolean
  readonly selfApprove?: boolean
  /** Host-only extension request. This plugin always rejects it. */
  readonly more?: readonly string[]
}

export class PermissionDeniedError extends AehError {
  readonly code = 'AEH_PERMISSION_DENIED'
}

/**
 * Reject any request outside the minimal manifest. There is intentionally no
 * "grant" path in this package: a host that wants a broader capability must
 * implement and review a separate adapter, not widen this plugin.
 */
export function assertMinimalPermissions(
  request: PermissionRequest = {},
): readonly AehCapability[] {
  const requested = request.capabilities ?? []
  const granted: AehCapability[] = []
  for (const capability of requested) {
    if (!(ALLOWED_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new PermissionDeniedError(
        `capability ${JSON.stringify(capability)} is not granted to the AEH plugin`,
      )
    }
    granted.push(capability as AehCapability)
  }

  const denied: Array<keyof PermissionRequest> = [
    'studentRawData',
    'databaseWrite',
    'credentials',
    'arbitraryFilesystem',
    'network',
    'observedTwinWrite',
    'gateOverride',
    'selfApprove',
  ]
  for (const key of denied) {
    if (request[key] === true) {
      throw new PermissionDeniedError(
        `permission ${String(key)} is permanently denied to the AEH plugin`,
      )
    }
  }
  if ((request.more ?? []).length > 0) {
    throw new PermissionDeniedError(
      'the AEH plugin does not accept extension permissions',
    )
  }

  return requested.length === 0
    ? ALLOWED_CAPABILITIES
    : Object.freeze(granted)
}

/** Human-readable manifest for review UIs and documentation tests. */
export function permissionSummary(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    capabilities: [...MINIMAL_PERMISSIONS.capabilities],
    denied: [
      'studentRawData',
      'databaseWrite',
      'credentials',
      'arbitraryFilesystem',
      'network',
      'observedTwinWrite',
      'gateOverride',
      'selfApprove',
    ],
    note: 'default-deny; host-owned capabilities are not exposed as tools',
  })
}
