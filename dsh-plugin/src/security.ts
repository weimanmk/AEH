/**
 * Step 8 tool-boundary security hardening.
 *
 * The model-facing tools are the only place untrusted text reaches the AEH
 * plugin, so every call is screened before a tool body runs:
 *
 *   1. prompt-injection detection — imperative text that tries to change the
 *      curriculum gate, permissions, report audience, or approval flow is
 *      rejected fail-closed and recorded in the audit log (as reason codes,
 *      never the raw text);
 *   2. payload limits — strings, arrays, object keys, nesting depth, and total
 *      serialised size are bounded by plugin config, so an outsized argument is
 *      a structured `AEH_PAYLOAD_TOO_LARGE` refusal rather than an expensive or
 *      unbounded traversal;
 *   3. per-session and per-student rate limiting — a fixed window keyed by the
 *      dsh session/agent scope and by the opaque `studentRef`, so one noisy
 *      session cannot starve another;
 *   4. error redaction — absolute paths, `file://` URLs, and secret-looking
 *      tokens are stripped from any message that leaves a tool body.
 *
 * The guard is deliberately *not* the authority for progress, annotations,
 * scopes, or `studentRef`: those still resolve only through the host
 * `HostContext`, and a forged value simply fails to resolve. The guard adds a
 * second, independent fail-closed layer.
 *
 * `SecurityError` extends the dsh `HarnessError` base class, so dsh maps it to
 * a structured `info.code` on the tool result instead of an opaque message.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

export const SECURITY_ERROR_CODES = Object.freeze({
  injection: 'AEH_INJECTION_REJECTED',
  unauthorizedArgument: 'AEH_UNAUTHORIZED_ARGUMENT',
  payloadTooLarge: 'AEH_PAYLOAD_TOO_LARGE',
  rateLimited: 'AEH_RATE_LIMITED',
} as const)

export type SecurityErrorCode =
  (typeof SECURITY_ERROR_CODES)[keyof typeof SECURITY_ERROR_CODES]

/** Bounds applied to every tool argument object before a body runs. */
export interface SecurityLimits {
  readonly maxStringLength: number
  readonly maxArrayLength: number
  readonly maxObjectKeys: number
  readonly maxDepth: number
  readonly maxSerializedBytes: number
}

export const DEFAULT_SECURITY_LIMITS: SecurityLimits = Object.freeze({
  maxStringLength: 4096,
  maxArrayLength: 256,
  maxObjectKeys: 128,
  maxDepth: 12,
  maxSerializedBytes: 131072,
})

/** Fixed-window rate-limit policy, per dsh session and per student reference. */
export interface RateLimitPolicy {
  readonly windowMs: number
  readonly maxRequestsPerSession: number
  readonly maxRequestsPerStudent: number
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = Object.freeze({
  windowMs: 60_000,
  maxRequestsPerSession: 120,
  maxRequestsPerStudent: 240,
})

export interface SecurityGuardOptions {
  readonly limits?: Partial<SecurityLimits>
  readonly rateLimits?: Partial<RateLimitPolicy>
  /** Injectable clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
}

export interface SecurityCallContext {
  /** dsh session/agent id, when the runtime supplied one. */
  readonly sessionId?: string
  /** Opaque student reference from the arguments, when present and a string. */
  readonly studentRef?: string
}

function assertPositiveLimit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SecurityError(
      SECURITY_ERROR_CODES.unauthorizedArgument,
      `invalid security limit for ${field}`,
      [`limit_invalid:${field}`],
    )
  }
  return value
}

function resolveLimits(partial: Partial<SecurityLimits> = {}): SecurityLimits {
  return Object.freeze({
    maxStringLength: assertPositiveLimit(
      partial.maxStringLength ?? DEFAULT_SECURITY_LIMITS.maxStringLength,
      'maxStringLength',
    ),
    maxArrayLength: assertPositiveLimit(
      partial.maxArrayLength ?? DEFAULT_SECURITY_LIMITS.maxArrayLength,
      'maxArrayLength',
    ),
    maxObjectKeys: assertPositiveLimit(
      partial.maxObjectKeys ?? DEFAULT_SECURITY_LIMITS.maxObjectKeys,
      'maxObjectKeys',
    ),
    maxDepth: assertPositiveLimit(
      partial.maxDepth ?? DEFAULT_SECURITY_LIMITS.maxDepth,
      'maxDepth',
    ),
    maxSerializedBytes: assertPositiveLimit(
      partial.maxSerializedBytes ?? DEFAULT_SECURITY_LIMITS.maxSerializedBytes,
      'maxSerializedBytes',
    ),
  })
}

function resolveRateLimits(partial: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return Object.freeze({
    windowMs: assertPositiveLimit(
      partial.windowMs ?? DEFAULT_RATE_LIMITS.windowMs,
      'windowMs',
    ),
    maxRequestsPerSession: assertPositiveLimit(
      partial.maxRequestsPerSession ?? DEFAULT_RATE_LIMITS.maxRequestsPerSession,
      'maxRequestsPerSession',
    ),
    maxRequestsPerStudent: assertPositiveLimit(
      partial.maxRequestsPerStudent ?? DEFAULT_RATE_LIMITS.maxRequestsPerStudent,
      'maxRequestsPerStudent',
    ),
  })
}

/** Structured, fail-closed tool rejection with machine-readable reason codes. */
export class SecurityError extends HarnessError {
  readonly reasonCodes: readonly string[]

  constructor(code: SecurityErrorCode, message: string, reasonCodes: readonly string[]) {
    super(message, code)
    this.name = 'SecurityError'
    this.reasonCodes = Object.freeze([...reasonCodes])
  }
}

interface InjectionPattern {
  readonly category: string
  readonly pattern: RegExp
}

/**
 * Imperative text that would try to steer a decision instead of describing
 * legitimate domain data. Patterns are deliberately anchored on a verb plus a
 * protected object, so ordinary curriculum prose ("adds numerators") and opaque
 * ids (`kc.fraction.add`) do not match.
 */
const INJECTION_PATTERNS: readonly InjectionPattern[] = Object.freeze([
  {
    category: 'prompt_override',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,32}\b(?:previous|prior|above|earlier|all)\b[\s\S]{0,16}\b(?:instructions?|rules?|prompts?|constraints?|directives?)\b/i,
  },
  {
    category: 'prompt_override',
    pattern: /\b(?:new|updated|revised)\s+(?:instructions?|rules?|system\s+prompt)\b/i,
  },
  {
    category: 'role_impersonation',
    pattern:
      /\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on|developer\s+mode|jailbreak|dan\s+mode)\b/i,
  },
  {
    category: 'role_impersonation',
    pattern: /(?:^|[\r\n])\s*(?:system|assistant|developer|tool)\s*:/i,
  },
  {
    category: 'role_impersonation',
    pattern: /(?:<\s*\/?\s*(?:system|assistant)\s*>|\[\s*(?:system|assistant)\s*\]|#{2,}\s*(?:system|instruction))/i,
  },
  {
    category: 'gate_override',
    pattern:
      /\b(?:override|bypass|disable|skip|circumvent|turn\s+off|ignore)\b[\s\S]{0,24}\b(?:gate|gating|curriculum|safety|check|policy|rules?|annotation|verification|guard)\b/i,
  },
  {
    category: 'gate_override',
    pattern:
      /\b(?:mark|set|treat|return|force|make)\b[\s\S]{0,20}\b(?:allowed|approved|safe|verified|passing|eligible)\b[\s\S]{0,12}\b(?:true|yes|pass)\b/i,
  },
  {
    category: 'permission_escalation',
    pattern:
      /\b(?:grant|elevate|escalate|expand|request|add)\b[\s\S]{0,24}\b(?:permissions?|privileges?|capabilit(?:y|ies)|scopes?|access|admin)\b/i,
  },
  {
    category: 'permission_escalation',
    pattern:
      /\b(?:studentRawData|databaseWrite|credentials|arbitraryFilesystem|observedTwinWrite|gateOverride|selfApprove)\b/,
  },
  {
    category: 'audience_change',
    pattern:
      /\b(?:change|switch|set|override|widen|bypass)\b[\s\S]{0,24}\b(?:audience|report\s+audience|recipients?|guardian|teacher)\b/i,
  },
  {
    category: 'approval_override',
    pattern:
      /\b(?:approve|authorize|authorise|deliver|release)\b[\s\S]{0,24}\b(?:interventions?|packages?|deliver(?:y|ies)?|approvals?|without\s+approval)\b/i,
  },
  {
    category: 'approval_override',
    pattern: /\bskip\s+(?:the\s+)?(?:host\s+)?approval\b/i,
  },
  {
    category: 'secret_exfiltration',
    pattern:
      /\b(?:reveal|show|print|dump|leak|expose|repeat|output)\b[\s\S]{0,24}\b(?:system\s+prompt|instructions?|config(?:uration)?s?|secrets?|credentials?|api\s*keys?|tokens?|passwords?)\b/i,
  },
  // Chinese patterns. The object lists are specific so ordinary feedback text
  // such as "忽略之前的提示" (a hint, not an instruction) does not match.
  {
    category: 'prompt_override',
    pattern:
      /(?:忽略|无视|忘掉|覆盖|绕过)(?:之前|以上|先前|前面|所有|全部)?(?:的)?(?:指令|指示|规则|约束|系统提示|提示词|要求)/,
  },
  {
    category: 'role_impersonation',
    pattern: /(?:你现在是|从现在起|假装你是|扮演(?:一个)?|进入.{0,4}模式|开发者模式)/,
  },
  {
    category: 'gate_override',
    pattern:
      /(?:绕过|跳过|关闭|取消|无视|覆盖|修改|更改|降低|解除).{0,6}(?:门禁|门控|课程门禁|安全门禁|校验|检查|审核|策略|规则|标注|置信度)/,
  },
  {
    category: 'gate_override',
    pattern:
      /(?:把|将|设为|设置|标记为|判定为|返回).{0,6}(?:允许|放行|通过|安全|已审核|已标注)/,
  },
  {
    category: 'permission_escalation',
    pattern: /(?:授予|提升|扩大|增加|申请|给我).{0,6}(?:权限|特权|能力|访问权限|管理员)/,
  },
  {
    category: 'audience_change',
    pattern: /(?:修改|更改|切换|设置|扩大|改变).{0,6}(?:受众|报告受众|收件人|家长|教师)/,
  },
  {
    category: 'approval_override',
    pattern: /(?:无需|跳过|绕过|免).{0,4}(?:审批|批准|同意|交付)/,
  },
  {
    category: 'secret_exfiltration',
    pattern: /(?:泄露|显示|打印|输出|告诉我|重复).{0,6}(?:系统提示|指令|配置|密钥|凭据|密码|令牌)/,
  },
])

/**
 * Argument keys that would try to impersonate a host-owned decision object.
 * They are not declared parameters anywhere in the plugin, so their presence is
 * a fail-closed rejection rather than a silently ignored extra field. Note that
 * scalar annotation *fields* (for example `safetyChecked`) are intentionally not
 * in this list: they are inert extra data that the host resolver ignores.
 */
const PRIVILEGED_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'gateoverride',
  'overridegate',
  'bypassgate',
  'forceallowed',
  'forceallow',
  'allowedoverride',
  'permissions',
  'permissiongrant',
  'grantpermissions',
  'studentrawdata',
  'databasewrite',
  'credentials',
  'arbitraryfilesystem',
  'observedtwinwrite',
  'selfapprove',
  'scopeoverride',
  'audienceoverride',
  'approvaloverride',
  'approvalid',
  'hostcontext',
  'resolveprogress',
  'resolveitem',
  'itemannotations',
])

const ABSOLUTE_PATH_RE =
  /(?:[A-Za-z]:\\[^\s'"]+|\/(?:home|Users|root|usr|opt|var|tmp|etc|srv)\/[^\s'"]*|file:\/\/[^\s'"]*)/g
const SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g

/** Strip paths and secret-looking tokens from a message, and flatten it. */
export function redactMessage(message: string): string {
  const flattened =
    typeof message === 'string' ? message : String(message ?? '')
  let safe = flattened
    .replace(/[\r\n\t]+/g, ' ')
    .replace(ABSOLUTE_PATH_RE, '[redacted-path]')
    .replace(SECRET_RE, '[redacted-secret]')
  if (safe.length > 300) safe = `${safe.slice(0, 297)}...`
  return safe
}

/**
 * Redact an already-thrown error in place, preserving its class so callers can
 * still branch on `instanceof`. A frozen error is left untouched rather than
 * failing the redaction attempt.
 */
export function redactThrown(error: unknown): unknown {
  if (error instanceof Error && typeof error.message === 'string') {
    const safe = redactMessage(error.message)
    if (safe !== error.message) {
      try {
        error.message = safe
      } catch {
        // Frozen or non-writable message: the original text is not worse than
        // crashing the tool path, and the guard never puts secrets in messages.
      }
    }
  }
  return error
}

/** Opaque `studentRef` from arguments, when it is a usable string. */
export function extractStudentRef(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as { studentRef?: unknown }).studentRef
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.\[\]]/g, '#').slice(0, 80)
}

interface WindowBucket {
  windowStart: number
  count: number
}

/**
 * In-memory fixed-window limiter. Keys are the raw session/student references
 * and are never logged or rendered; the map is process-local and bounded by
 * periodic pruning of expired windows.
 */
class FixedWindowLimiter {
  private readonly buckets = new Map<string, WindowBucket>()
  private readonly windowMs: number
  private readonly now: () => number
  private operations = 0

  constructor(windowMs: number, now: () => number) {
    this.windowMs = windowMs
    this.now = now
  }

  /** Count one request for `key`; returns false when the limit is exceeded. */
  hit(key: string, limit: number): boolean {
    const nowMs = this.now()
    this.operations += 1
    if (this.operations % 256 === 0) this.prune(nowMs)
    const bucket = this.buckets.get(key)
    if (bucket === undefined || nowMs - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: nowMs, count: 1 })
      return true
    }
    if (bucket.count >= limit) return false
    bucket.count += 1
    return true
  }

  reset(): void {
    this.buckets.clear()
  }

  private prune(nowMs: number): void {
    for (const [key, bucket] of [...this.buckets]) {
      if (nowMs - bucket.windowStart >= this.windowMs) this.buckets.delete(key)
    }
  }

  get size(): number {
    return this.buckets.size
  }
}

/**
 * The per-plugin security guard. One instance is created per plugin mount, so
 * rate-limit state is scoped to that mount and never shared across hosts.
 */
export class SecurityGuard {
  readonly limits: SecurityLimits
  readonly rateLimits: RateLimitPolicy
  private readonly sessionLimiter: FixedWindowLimiter
  private readonly studentLimiter: FixedWindowLimiter

  constructor(options: SecurityGuardOptions = {}) {
    this.limits = resolveLimits(options.limits)
    this.rateLimits = resolveRateLimits(options.rateLimits)
    const now = options.now ?? (() => Date.now())
    this.sessionLimiter = new FixedWindowLimiter(this.rateLimits.windowMs, now)
    this.studentLimiter = new FixedWindowLimiter(this.rateLimits.windowMs, now)
  }

  /** Rate-limit and screen one tool call before its body runs. */
  guard(tool: string, args: unknown, context: SecurityCallContext = {}): void {
    this.checkRate(tool, context)
    this.assertArgumentSafety(tool, args)
  }

  /**
   * Apply the per-session and per-student windows. Exceeding one window refuses
   * only the current call; other sessions/students keep their own windows.
   */
  checkRate(tool: string, context: SecurityCallContext = {}): void {
    if (context.sessionId !== undefined) {
      if (
        !this.sessionLimiter.hit(
          context.sessionId,
          this.rateLimits.maxRequestsPerSession,
        )
      ) {
        throw new SecurityError(
          SECURITY_ERROR_CODES.rateLimited,
          `rate limit exceeded for this session while calling ${tool}`,
          ['rate_limited:session'],
        )
      }
    }
    if (context.studentRef !== undefined) {
      if (
        !this.studentLimiter.hit(
          context.studentRef,
          this.rateLimits.maxRequestsPerStudent,
        )
      ) {
        throw new SecurityError(
          SECURITY_ERROR_CODES.rateLimited,
          `rate limit exceeded for this student while calling ${tool}`,
          ['rate_limited:student'],
        )
      }
    }
  }

  /** Reject injection-style text, privileged override keys, and oversized values. */
  assertArgumentSafety(tool: string, args: unknown): void {
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      this.assertNoPrivilegedOverride(tool, args as Record<string, unknown>)
    }
    this.walk(args, '$', 0, new WeakSet<object>(), { bytes: 0 })
  }

  /** Clear rate-limit windows; used on plugin unload and by tests. */
  reset(): void {
    this.sessionLimiter.reset()
    this.studentLimiter.reset()
  }

  get rateLimitBuckets(): number {
    return this.sessionLimiter.size + this.studentLimiter.size
  }

  private assertNoPrivilegedOverride(
    tool: string,
    record: Record<string, unknown>,
  ): void {
    for (const key of Object.keys(record)) {
      if (PRIVILEGED_OVERRIDE_KEYS.has(key.toLowerCase())) {
        throw new SecurityError(
          SECURITY_ERROR_CODES.unauthorizedArgument,
          `argument ${JSON.stringify(redactMessage(key))} is not a model-supplied field for ${tool}`,
          [`privileged_argument:${safePath(key)}`],
        )
      }
    }
  }

  private walk(
    value: unknown,
    path: string,
    depth: number,
    seen: WeakSet<object>,
    budget: { bytes: number },
  ): void {
    if (depth > this.limits.maxDepth) {
      throw new SecurityError(
        SECURITY_ERROR_CODES.payloadTooLarge,
        'tool arguments exceed the configured nesting depth',
        ['payload_too_large:depth'],
      )
    }
    if (value === null) {
      budget.bytes += 4
      return
    }
    switch (typeof value) {
      case 'string': {
        if (value.length > this.limits.maxStringLength) {
          throw new SecurityError(
            SECURITY_ERROR_CODES.payloadTooLarge,
            `string argument at ${safePath(path)} exceeds the configured length limit`,
            ['payload_too_large:string'],
          )
        }
        this.scanText(value, path)
        budget.bytes += value.length + 2
        break
      }
      case 'number':
      case 'boolean':
        budget.bytes += 8
        break
      case 'undefined':
        // Absent optional fields are not JSON, but direct callers may pass them.
        break
      case 'object': {
        const object = value as object
        if (seen.has(object)) {
          throw new SecurityError(
            SECURITY_ERROR_CODES.payloadTooLarge,
            'tool arguments must be acyclic JSON',
            ['payload_too_large:cyclic'],
          )
        }
        seen.add(object)
        if (Array.isArray(value)) {
          if (value.length > this.limits.maxArrayLength) {
            throw new SecurityError(
              SECURITY_ERROR_CODES.payloadTooLarge,
              `array argument at ${safePath(path)} exceeds the configured length limit`,
              ['payload_too_large:array'],
            )
          }
          budget.bytes += 2 + value.length
          value.forEach((entry, index) => {
            this.walk(entry, `${path}[${index}]`, depth + 1, seen, budget)
          })
        } else {
          const keys = Object.keys(value)
          if (keys.length > this.limits.maxObjectKeys) {
            throw new SecurityError(
              SECURITY_ERROR_CODES.payloadTooLarge,
              `object argument at ${safePath(path)} exceeds the configured key limit`,
              ['payload_too_large:object'],
            )
          }
          budget.bytes += 2 + keys.length
          for (const key of keys) {
            this.scanText(key, `${path}.${key}`)
            this.walk(
              (value as Record<string, unknown>)[key],
              `${path}.${key}`,
              depth + 1,
              seen,
              budget,
            )
          }
        }
        seen.delete(object)
        break
      }
      default:
        throw new SecurityError(
          SECURITY_ERROR_CODES.unauthorizedArgument,
          `argument at ${safePath(path)} is not JSON-serialisable`,
          ['non_json_argument'],
        )
    }
    if (budget.bytes > this.limits.maxSerializedBytes) {
      throw new SecurityError(
        SECURITY_ERROR_CODES.payloadTooLarge,
        'tool arguments exceed the configured serialised size limit',
        ['payload_too_large:serialized_bytes'],
      )
    }
  }

  private scanText(value: string, path: string): void {
    for (const { category, pattern } of INJECTION_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(value)) {
        throw new SecurityError(
          SECURITY_ERROR_CODES.injection,
          'tool arguments contain instruction-like text that cannot change host decisions',
          [`instruction_pattern:${category}`, `path:${safePath(path)}`],
        )
      }
    }
  }
}
