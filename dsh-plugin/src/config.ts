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
import {
  DEFAULT_RATE_LIMITS,
  DEFAULT_SECURITY_LIMITS,
  type RateLimitPolicy,
  type SecurityLimits,
} from './security.ts'

export type PluginProfile = 'student-facing' | 'host-side'

/**
 * Step 8 tool-boundary bounds. The Schemastery schema rejects a non-positive or
 * non-numeric value before `apply`, and {@link resolveAehConfig} re-asserts the
 * integer bounds so a direct/embedded caller gets the same fail-loud result.
 */
const securityLimitsSchema = Schema.object({
  maxStringLength: Schema.number()
    .min(1)
    .default(DEFAULT_SECURITY_LIMITS.maxStringLength),
  maxArrayLength: Schema.number()
    .min(1)
    .default(DEFAULT_SECURITY_LIMITS.maxArrayLength),
  maxObjectKeys: Schema.number()
    .min(1)
    .default(DEFAULT_SECURITY_LIMITS.maxObjectKeys),
  maxDepth: Schema.number().min(1).default(DEFAULT_SECURITY_LIMITS.maxDepth),
  maxSerializedBytes: Schema.number()
    .min(1)
    .default(DEFAULT_SECURITY_LIMITS.maxSerializedBytes),
})

const rateLimitSchema = Schema.object({
  windowMs: Schema.number().min(1).default(DEFAULT_RATE_LIMITS.windowMs),
  maxRequestsPerSession: Schema.number()
    .min(1)
    .default(DEFAULT_RATE_LIMITS.maxRequestsPerSession),
  maxRequestsPerStudent: Schema.number()
    .min(1)
    .default(DEFAULT_RATE_LIMITS.maxRequestsPerStudent),
})

const securityConfigSchema = Schema.object({
  limits: securityLimitsSchema.default({}),
  rateLimits: rateLimitSchema.default({}),
}).default({})

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
  /** Step 8: argument bounds and per-session/student rate limits. */
  security: securityConfigSchema,
  /** Host-owned resolver object; opaque and non-serialisable by design. */
  host: Schema.any(),
  /** Permission request object; validated by `permissions.ts`, not here. */
  permissions: Schema.any(),
}).description(
  'AEH education plugin config: profile, target retention in (0, 1), the enabled gate modes, and the Step 8 security limits.',
)

export interface ResolvedSecurityConfig {
  readonly limits: SecurityLimits
  readonly rateLimits: RateLimitPolicy
}

export interface ResolvedAehConfig {
  readonly profile: PluginProfile
  readonly targetRetention: number
  readonly allowedModes: readonly GateMode[]
  readonly security: ResolvedSecurityConfig
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

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(
      `invalid AEH plugin config: security.${field} must be a positive integer`,
      [`security.${field} must be a positive integer`],
    )
  }
  return value
}

/**
 * Resolve the Step 8 security block. The Schemastery schema already rejects an
 * out-of-range value before `apply`; this re-asserts integer positivity for
 * direct/embedded callers so there is one fail-loud contract, not two.
 */
export function resolveSecurityConfig(raw: unknown): ResolvedSecurityConfig {
  const block =
    raw === null || typeof raw !== 'object' ? {} : (raw as Record<string, unknown>)
  const limitsRaw =
    block.limits === null || typeof block.limits !== 'object'
      ? {}
      : (block.limits as Record<string, unknown>)
  const rateRaw =
    block.rateLimits === null || typeof block.rateLimits !== 'object'
      ? {}
      : (block.rateLimits as Record<string, unknown>)
  return Object.freeze({
    limits: Object.freeze({
      maxStringLength: positiveInteger(
        limitsRaw.maxStringLength,
        'limits.maxStringLength',
        DEFAULT_SECURITY_LIMITS.maxStringLength,
      ),
      maxArrayLength: positiveInteger(
        limitsRaw.maxArrayLength,
        'limits.maxArrayLength',
        DEFAULT_SECURITY_LIMITS.maxArrayLength,
      ),
      maxObjectKeys: positiveInteger(
        limitsRaw.maxObjectKeys,
        'limits.maxObjectKeys',
        DEFAULT_SECURITY_LIMITS.maxObjectKeys,
      ),
      maxDepth: positiveInteger(
        limitsRaw.maxDepth,
        'limits.maxDepth',
        DEFAULT_SECURITY_LIMITS.maxDepth,
      ),
      maxSerializedBytes: positiveInteger(
        limitsRaw.maxSerializedBytes,
        'limits.maxSerializedBytes',
        DEFAULT_SECURITY_LIMITS.maxSerializedBytes,
      ),
    }),
    rateLimits: Object.freeze({
      windowMs: positiveInteger(
        rateRaw.windowMs,
        'rateLimits.windowMs',
        DEFAULT_RATE_LIMITS.windowMs,
      ),
      maxRequestsPerSession: positiveInteger(
        rateRaw.maxRequestsPerSession,
        'rateLimits.maxRequestsPerSession',
        DEFAULT_RATE_LIMITS.maxRequestsPerSession,
      ),
      maxRequestsPerStudent: positiveInteger(
        rateRaw.maxRequestsPerStudent,
        'rateLimits.maxRequestsPerStudent',
        DEFAULT_RATE_LIMITS.maxRequestsPerStudent,
      ),
    }),
  })
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
    security?: unknown
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
    security: resolveSecurityConfig(parsed.security),
  })
}
