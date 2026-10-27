/**
 * Schemastery-validated plugin configuration (Step 7 / P1 item 1).
 *
 * Before Step 7 the plugin hand-rolled `normalizeConfig` checks (profile enum,
 * numeric retention bounds, gate-mode allow-list). This module replaces those
 * checks with one declarative Schemastery schema so the plugin can:
 *
 * - export the schema as the Cordis `Config`, which makes the loader validate
 *   and default the YAML/config object **before** the plugin body runs, and
 *   fail loudly with a `ValidationError` on an illegal value;
 * - reuse the same schema for direct `apply(ctx, config)` calls (unit tests and
 *   embedded hosts) through {@link resolveAehConfig}, so there is exactly one
 *   validation path.
 *
 * The schema deliberately accepts two opaque, non-serialisable fields:
 * `host` (a host-owned resolver bound to an authorised session snapshot) and
 * `permissions` (validated separately by `permissions.ts`). They are `any()`
 * here so a host can inject live objects without the schema compiler rejecting
 * them; they are never read from a YAML file by this package.
 */

import Schema from '@deepseek-ai/schemastery'

import { GATE_MODES, type GateMode } from './domain.ts'

export type PluginProfile = 'student-facing' | 'host-side'

const profileSchema = Schema.union([
  Schema.const('student-facing' as const),
  Schema.const('host-side' as const),
])

export const gateModeSchema = Schema.union([
  Schema.const('preview' as const),
  Schema.const('learn' as const),
  Schema.const('review' as const),
])

/**
 * The Cordis plugin `Config`. Every field is optional so an empty config uses
 * the student-facing, 0.9-retention, all-modes defaults.
 */
export const AEH_CONFIG_SCHEMA = Schema.object({
  profile: profileSchema.default('student-facing'),
  targetRetention: Schema.number().min(0).max(1).default(0.9),
  allowedModes: Schema.array(gateModeSchema).default([...GATE_MODES]),
  /** Host-owned resolver object; opaque and non-serialisable by design. */
  host: Schema.any(),
  /** Permission request object; validated by `permissions.ts`, not here. */
  permissions: Schema.any(),
}).description(
  'AEH education plugin config: profile, target retention in (0, 1), and the enabled gate modes.',
)

export interface ResolvedAehConfig {
  readonly profile: PluginProfile
  readonly targetRetention: number
  readonly allowedModes: readonly GateMode[]
}

export class ConfigValidationError extends TypeError {
  readonly code = 'AEH_CONFIG_INVALID'
  readonly violations: readonly string[]

  constructor(message: string, violations: readonly string[] = [message]) {
    super(message)
    this.name = 'ConfigValidationError'
    this.violations = Object.freeze([...violations])
  }
}

function failure(error: unknown): ConfigValidationError {
  if (error instanceof ConfigValidationError) return error
  const message =
    error instanceof Error ? error.message : String(error)
  return new ConfigValidationError(`invalid AEH plugin config: ${message}`, [
    message,
  ])
}

/**
 * Validate and normalise a plugin config with the Schemastery schema.
 *
 * The schemastery `min(0).max(1)` bounds are inclusive, so the open
 * `(0, 1)` retention interval is re-asserted here after schema resolution.
 * Every failure throws {@link ConfigValidationError}; there is no silent
 * fallback to defaults for an explicitly supplied illegal value.
 */
export function resolveAehConfig(input: unknown = {}): ResolvedAehConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError(
      'invalid AEH plugin config: expected a config object',
      ['expected a config object'],
    )
  }

  let parsed: {
    profile?: unknown
    targetRetention?: unknown
    allowedModes?: unknown
  }
  try {
    parsed = AEH_CONFIG_SCHEMA(input as never) as typeof parsed
  } catch (error) {
    throw failure(error)
  }

  if (parsed.profile !== 'student-facing' && parsed.profile !== 'host-side') {
    throw new ConfigValidationError(
      `invalid AEH plugin config: unknown profile ${JSON.stringify(parsed.profile)}`,
      [`profile must be student-facing or host-side`],
    )
  }

  const targetRetention = parsed.targetRetention
  if (
    typeof targetRetention !== 'number' ||
    !Number.isFinite(targetRetention) ||
    targetRetention <= 0 ||
    targetRetention >= 1
  ) {
    throw new ConfigValidationError(
      'invalid AEH plugin config: targetRetention must be within (0, 1)',
      ['targetRetention must be within (0, 1)'],
    )
  }

  if (!Array.isArray(parsed.allowedModes)) {
    throw new ConfigValidationError(
      'invalid AEH plugin config: allowedModes must be an array',
      ['allowedModes must be an array'],
    )
  }
  const allowedModes: GateMode[] = []
  for (const mode of parsed.allowedModes) {
    if (!(GATE_MODES as readonly unknown[]).includes(mode)) {
      throw new ConfigValidationError(
        `invalid AEH plugin config: unknown gate mode ${JSON.stringify(mode)}`,
        [`unknown gate mode: ${String(mode)}`],
      )
    }
    allowedModes.push(mode as GateMode)
  }

  return Object.freeze({
    profile: parsed.profile,
    targetRetention,
    allowedModes: Object.freeze(allowedModes),
  })
}
