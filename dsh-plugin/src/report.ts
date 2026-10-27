/**
 * Teacher / guardian aggregate report boundary (TypeScript).
 *
 * This mirrors the Step 2 Python policy in `aeh/report.py` so the dsh tool and
 * the offline Python pipeline share one data-minimisation contract:
 *
 * - the only accepted input is an *aggregate* event with fixed numeric fields;
 *   there is no field for a question, answer, image, step trace, or arbitrary
 *   payload mapping. Unknown fields are rejected, not ignored, so raw student
 *   data cannot ride along silently;
 * - every event carries an explicit `consentScope`; the report intersects the
 *   audience's default scopes with an optional caller list. A caller can only
 *   *narrow* what the audience may read, never widen it;
 * - events for another student, outside the requested window, unauthorised, or
 *   duplicated by `aggregateRef` are counted as excluded and never aggregated;
 * - `aggregateRef` is an opaque *batch* reference used for de-duplication only.
 *   It is never a raw learning-event id and is never rendered in the output.
 *   The only identity value in the report is the pseudonymous `studentRef`.
 *
 * This is a policy skeleton, not an identity/consent access-control service.
 * A real deployment still needs authenticated principals, server-side scope
 * resolution, audit logs, and retention/deletion handling.
 */

import { AehError } from './domain.ts'

export const KIND_ATTEMPT = 'attempt_aggregate'
export const KIND_REVIEW = 'review_aggregate'
export const KIND_DIAGNOSIS = 'diagnosis_aggregate'
export const KIND_INTERVENTION = 'intervention_aggregate'

export const AGGREGATE_KINDS = Object.freeze([
  KIND_ATTEMPT,
  KIND_REVIEW,
  KIND_DIAGNOSIS,
  KIND_INTERVENTION,
] as const)

export type AggregateKind = (typeof AGGREGATE_KINDS)[number]

export const AUDIENCE_TEACHER = 'teacher'
export const AUDIENCE_GUARDIAN = 'guardian'

export const AUDIENCES = Object.freeze([
  AUDIENCE_TEACHER,
  AUDIENCE_GUARDIAN,
] as const)

export type Audience = (typeof AUDIENCES)[number]

/** Scopes an audience may use by default; a caller list can only narrow them. */
export const DEFAULT_AUDIENCE_SCOPES: Readonly<Record<Audience, readonly string[]>> =
  Object.freeze({
    [AUDIENCE_TEACHER]: Object.freeze(['educational_report', 'teacher_report']),
    [AUDIENCE_GUARDIAN]: Object.freeze(['educational_report', 'guardian_report']),
  })

/** Below this independent accuracy (with enough attempts) flag for attention. */
export const ATTENTION_ACCURACY_THRESHOLD = 0.6
export const ATTENTION_MIN_ATTEMPTS = 3

/**
 * Conservative identifier/label grammar. It rejects whitespace, newlines and
 * arbitrary prose, keeping free-text raw data out of aggregate events.
 */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const ISO_OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/

export class ReportError extends AehError {}

/** One authorised, pre-aggregated learning event. */
export interface AggregateEventInput {
  /** Opaque aggregate-batch reference; used for de-dup, never rendered. */
  readonly aggregateRef: string
  readonly studentRef: string
  readonly occurredAt: string
  readonly kind: AggregateKind | string
  readonly consentScope: string
  readonly kcId: string
  readonly attempts?: number
  readonly independentCorrect?: number
  readonly hintedCorrect?: number
  readonly hintsRequested?: number
  readonly reviewsDue?: number
  readonly reviewsCompleted?: number
  readonly minutes?: number
}

/** Normalised, validated aggregate event (same field set as the Python one). */
export interface AggregateEvent {
  readonly aggregateRef: string
  readonly studentRef: string
  readonly occurredAt: string
  readonly kind: AggregateKind
  readonly consentScope: string
  readonly kcId: string
  readonly attempts: number
  readonly independentCorrect: number
  readonly hintedCorrect: number
  readonly hintsRequested: number
  readonly reviewsDue: number
  readonly reviewsCompleted: number
  readonly minutes: number
}

/**
 * The complete set of fields an aggregate event may carry. Anything else is a
 * policy violation: the report pipeline must never receive raw student data.
 */
const AGGREGATE_EVENT_KEYS: ReadonlySet<string> = new Set([
  'aggregateRef',
  'studentRef',
  'occurredAt',
  'kind',
  'consentScope',
  'kcId',
  'attempts',
  'independentCorrect',
  'hintedCorrect',
  'hintsRequested',
  'reviewsDue',
  'reviewsCompleted',
  'minutes',
])

export interface AggregateMetrics {
  readonly attempts: number
  readonly independentCorrect: number
  readonly hintedCorrect: number
  readonly hintsRequested: number
  readonly reviewsDue: number
  readonly reviewsCompleted: number
  readonly minutes: number
}

export interface ReportTopic extends AggregateMetrics {
  readonly kcId: string
  readonly attentionReasons: readonly string[]
}

export interface LearningReport {
  readonly audience: Audience
  readonly studentRef: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly generatedAt: string
  readonly eventsUsed: number
  readonly eventsExcluded: number
  readonly totals: AggregateMetrics
  readonly topics: readonly ReportTopic[]
  readonly authorizedScopes: readonly string[]
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new ReportError(`${field} must be a short identifier`)
  }
  return value
}

function requireLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || !LABEL_RE.test(value)) {
    throw new ReportError(`${field} must be a short curriculum label`)
  }
  return value
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_OFFSET_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ReportError(`${field} must be an ISO timestamp with a UTC offset`)
  }
  return value
}

function requireNonNegativeInt(value: unknown, field: string, fallback = 0): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ReportError(`${field} must be a non-negative integer`)
  }
  return value
}

function requireNonNegativeNumber(value: unknown, field: string, fallback = 0): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ReportError(`${field} must be a finite number >= 0`)
  }
  return value
}

function normalizeEvent(raw: unknown): AggregateEvent {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReportError('report events must be aggregate event objects')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!AGGREGATE_EVENT_KEYS.has(key)) {
      throw new ReportError(
        `aggregate event contains unsupported field ${JSON.stringify(key)}`,
      )
    }
  }

  const kind = record.kind
  if (typeof kind !== 'string' || !(AGGREGATE_KINDS as readonly string[]).includes(kind)) {
    throw new ReportError(`unsupported aggregate kind ${JSON.stringify(kind)}`)
  }

  const event: AggregateEvent = {
    aggregateRef: requireIdentifier(record.aggregateRef, 'aggregateRef'),
    studentRef: requireIdentifier(record.studentRef, 'studentRef'),
    occurredAt: requireIso(record.occurredAt, 'occurredAt'),
    kind: kind as AggregateKind,
    consentScope: requireIdentifier(record.consentScope, 'consentScope'),
    kcId: requireLabel(record.kcId, 'kcId'),
    attempts: requireNonNegativeInt(record.attempts, 'attempts'),
    independentCorrect: requireNonNegativeInt(
      record.independentCorrect,
      'independentCorrect',
    ),
    hintedCorrect: requireNonNegativeInt(record.hintedCorrect, 'hintedCorrect'),
    hintsRequested: requireNonNegativeInt(
      record.hintsRequested,
      'hintsRequested',
    ),
    reviewsDue: requireNonNegativeInt(record.reviewsDue, 'reviewsDue'),
    reviewsCompleted: requireNonNegativeInt(
      record.reviewsCompleted,
      'reviewsCompleted',
    ),
    minutes: requireNonNegativeNumber(record.minutes, 'minutes'),
  }
  if (event.independentCorrect + event.hintedCorrect > event.attempts) {
    throw new ReportError(
      'independentCorrect + hintedCorrect cannot exceed attempts',
    )
  }
  return Object.freeze(event)
}

function emptyMetrics(): AggregateMetrics {
  return Object.freeze({
    attempts: 0,
    independentCorrect: 0,
    hintedCorrect: 0,
    hintsRequested: 0,
    reviewsDue: 0,
    reviewsCompleted: 0,
    minutes: 0,
  })
}

function addMetrics(
  left: AggregateMetrics,
  right: {
    readonly attempts: number
    readonly independentCorrect: number
    readonly hintedCorrect: number
    readonly hintsRequested: number
    readonly reviewsDue: number
    readonly reviewsCompleted: number
    readonly minutes: number
  },
): AggregateMetrics {
  return Object.freeze({
    attempts: left.attempts + right.attempts,
    independentCorrect: left.independentCorrect + right.independentCorrect,
    hintedCorrect: left.hintedCorrect + right.hintedCorrect,
    hintsRequested: left.hintsRequested + right.hintsRequested,
    reviewsDue: left.reviewsDue + right.reviewsDue,
    reviewsCompleted: left.reviewsCompleted + right.reviewsCompleted,
    minutes: left.minutes + right.minutes,
  })
}

function metricsFromEvent(event: AggregateEvent): AggregateMetrics {
  return Object.freeze({
    attempts: event.attempts,
    independentCorrect: event.independentCorrect,
    hintedCorrect: event.hintedCorrect,
    hintsRequested: event.hintsRequested,
    reviewsDue: event.reviewsDue,
    reviewsCompleted: event.reviewsCompleted,
    minutes: event.minutes,
  })
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000
}

function accuracy(metrics: AggregateMetrics): number | null {
  return metrics.attempts === 0 ? null : metrics.independentCorrect / metrics.attempts
}

function hintsPerAttempt(metrics: AggregateMetrics): number | null {
  return metrics.attempts === 0 ? null : metrics.hintsRequested / metrics.attempts
}

function reviewCompletionRate(metrics: AggregateMetrics): number | null {
  return metrics.reviewsDue === 0
    ? null
    : Math.min(1, metrics.reviewsCompleted / metrics.reviewsDue)
}

function attentionReasons(metrics: AggregateMetrics): readonly string[] {
  const reasons: string[] = []
  const independentAccuracy = accuracy(metrics)
  if (
    metrics.attempts >= ATTENTION_MIN_ATTEMPTS &&
    independentAccuracy !== null &&
    independentAccuracy < ATTENTION_ACCURACY_THRESHOLD
  ) {
    reasons.push('low_independent_accuracy')
  }
  if (metrics.reviewsDue > metrics.reviewsCompleted) {
    reasons.push('reviews_not_completed')
  }
  return Object.freeze(reasons)
}

export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value)
}

/** Return the scopes usable by `audience`; caller input only narrows. */
export function effectiveScopes(
  audience: Audience,
  authorizedScopes?: readonly string[],
): readonly string[] {
  if (!isAudience(audience)) {
    throw new ReportError(`unknown audience ${JSON.stringify(audience)}`)
  }
  const base = DEFAULT_AUDIENCE_SCOPES[audience]
  if (authorizedScopes === undefined) return base
  const requested = new Set(authorizedScopes.map((scope) => String(scope)))
  return Object.freeze(base.filter((scope) => requested.has(scope)))
}

export interface GenerateReportOptions {
  readonly audience: Audience
  readonly studentRef: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly authorizedScopes?: readonly string[]
  readonly generatedAt?: string
}

/**
 * Aggregate authorised events into a minimised teacher/guardian report.
 *
 * Filter order matches the Python boundary: duplicate aggregate ref, other
 * student, unauthorised consent scope, then outside `[windowStart, windowEnd)`.
 */
export function generateReport(
  events: readonly unknown[],
  options: GenerateReportOptions,
): LearningReport {
  if (!isAudience(options.audience)) {
    throw new ReportError(`unknown audience ${JSON.stringify(options.audience)}`)
  }
  const scopes = effectiveScopes(options.audience, options.authorizedScopes)
  const scopeSet = new Set(scopes)
  const studentRef = requireIdentifier(options.studentRef, 'studentRef')
  const windowStart = requireIso(options.windowStart, 'windowStart')
  const windowEnd = requireIso(options.windowEnd, 'windowEnd')
  if (Date.parse(windowStart) >= Date.parse(windowEnd)) {
    throw new ReportError('windowStart must be before windowEnd')
  }
  const generatedAt =
    options.generatedAt === undefined
      ? new Date().toISOString()
      : requireIso(options.generatedAt, 'generatedAt')

  let totals = emptyMetrics()
  const perTopic = new Map<
    string,
    {
      attempts: number
      independentCorrect: number
      hintedCorrect: number
      hintsRequested: number
      reviewsDue: number
      reviewsCompleted: number
      minutes: number
    }
  >()
  const seen = new Set<string>()
  let used = 0
  let excluded = 0

  for (const raw of events) {
    const event = normalizeEvent(raw)
    if (seen.has(event.aggregateRef)) {
      excluded += 1
      continue
    }
    seen.add(event.aggregateRef)

    if (event.studentRef !== studentRef) {
      excluded += 1
      continue
    }
    if (!scopeSet.has(event.consentScope)) {
      excluded += 1
      continue
    }
    const at = Date.parse(event.occurredAt)
    if (at < Date.parse(windowStart) || at >= Date.parse(windowEnd)) {
      excluded += 1
      continue
    }

    const metrics = metricsFromEvent(event)
    totals = addMetrics(totals, metrics)
    const current = perTopic.get(event.kcId) ?? {
      attempts: 0,
      independentCorrect: 0,
      hintedCorrect: 0,
      hintsRequested: 0,
      reviewsDue: 0,
      reviewsCompleted: 0,
      minutes: 0,
    }
    perTopic.set(event.kcId, {
      attempts: current.attempts + metrics.attempts,
      independentCorrect: current.independentCorrect + metrics.independentCorrect,
      hintedCorrect: current.hintedCorrect + metrics.hintedCorrect,
      hintsRequested: current.hintsRequested + metrics.hintsRequested,
      reviewsDue: current.reviewsDue + metrics.reviewsDue,
      reviewsCompleted: current.reviewsCompleted + metrics.reviewsCompleted,
      minutes: current.minutes + metrics.minutes,
    })
    used += 1
  }

  const topics: ReportTopic[] = [...perTopic.keys()]
    .sort()
    .map((kcId) => {
      const metrics = perTopic.get(kcId)
      if (metrics === undefined) {
        throw new ReportError('internal topic index error')
      }
      return Object.freeze({
        kcId,
        ...metrics,
        attentionReasons: attentionReasons(metrics),
      })
    })

  return Object.freeze({
    audience: options.audience,
    studentRef,
    windowStart,
    windowEnd,
    generatedAt,
    eventsUsed: used,
    eventsExcluded: excluded,
    totals,
    topics: Object.freeze(topics),
    authorizedScopes: scopes,
  })
}

/**
 * JSON-friendly report view. It never contains aggregate refs, raw payloads,
 * questions, answers, or images.
 */
export function reportToDict(report: LearningReport): Record<string, unknown> {
  return {
    report_type: `${report.audience}_learning_report`,
    audience: report.audience,
    student_ref: report.studentRef,
    window: {
      start: report.windowStart,
      end: report.windowEnd,
      boundary: 'start_inclusive_end_exclusive',
    },
    generated_at: report.generatedAt,
    data_minimization: {
      authorized_aggregate_events_only: true,
      raw_student_data_included: false,
      event_refs_included: false,
      source_events_used: report.eventsUsed,
      source_events_excluded: report.eventsExcluded,
      authorized_scopes: [...report.authorizedScopes].sort(),
    },
    totals: {
      attempts: report.totals.attempts,
      independent_correct: report.totals.independentCorrect,
      hinted_correct: report.totals.hintedCorrect,
      hints_requested: report.totals.hintsRequested,
      reviews_due: report.totals.reviewsDue,
      reviews_completed: report.totals.reviewsCompleted,
      minutes: Math.round(report.totals.minutes * 1000) / 1000,
      independent_accuracy: round(accuracy(report.totals)),
      hints_per_attempt: round(hintsPerAttempt(report.totals)),
      review_completion_rate: round(reviewCompletionRate(report.totals)),
    },
    topics: report.topics.map((topic) => ({
      kc_id: topic.kcId,
      attempts: topic.attempts,
      independent_correct: topic.independentCorrect,
      hinted_correct: topic.hintedCorrect,
      hints_requested: topic.hintsRequested,
      reviews_due: topic.reviewsDue,
      reviews_completed: topic.reviewsCompleted,
      minutes: Math.round(topic.minutes * 1000) / 1000,
      independent_accuracy: round(accuracy(topic)),
      hints_per_attempt: round(hintsPerAttempt(topic)),
      review_completion_rate: round(reviewCompletionRate(topic)),
      attention_reasons: [...topic.attentionReasons],
    })),
    attention_topics: report.topics
      .filter((topic) => topic.attentionReasons.length > 0)
      .map((topic) => topic.kcId),
  }
}

export function reportToMarkdown(report: LearningReport): string {
  const audienceName =
    report.audience === AUDIENCE_TEACHER ? '教师' : '家长/监护人'
  const rate = (value: number | null): string =>
    value === null ? '—' : `${Math.round(value * 100)}%`
  const lines = [
    `# ${audienceName}学习报告（聚合）`,
    '',
    `- 学生引用（伪匿名）：\`${report.studentRef}\``,
    `- 统计窗口：${report.windowStart} — ${report.windowEnd}（含起点，不含终点）`,
    `- 生成时间：${report.generatedAt}`,
    '- 数据最小化：仅使用已授权聚合事件；不包含原始图片、题目、作答文本或事件引用。',
    '',
    '## 总览',
    '',
    `- 纳入聚合事件：${report.eventsUsed}；因未授权/越界/重复排除：${report.eventsExcluded}`,
    `- 学习尝试：${report.totals.attempts}；独立正确：${report.totals.independentCorrect}；独立正确率：${rate(accuracy(report.totals))}`,
    `- 提示次数：${report.totals.hintsRequested}；提示后正确：${report.totals.hintedCorrect}`,
    `- 复习完成：${report.totals.reviewsCompleted}/${report.totals.reviewsDue}`,
    `- 累计学习时长（分钟）：${report.totals.minutes.toFixed(1)}`,
    '',
    '## 知识点聚合',
    '',
    '| 知识点 | 尝试 | 独立正确率 | 每尝试提示数 | 复习完成 | 待关注 |',
    '|---|---:|---:|---:|---:|---|',
  ]
  if (report.topics.length === 0) {
    lines.push('| （无已授权聚合事件） | 0 | — | — | 0/0 | — |')
  }
  for (const topic of report.topics) {
    const hints = hintsPerAttempt(topic)
    lines.push(
      `| ${topic.kcId} | ${topic.attempts} | ${rate(accuracy(topic))} | ${
        hints === null ? '—' : hints.toFixed(2)
      } | ${topic.reviewsCompleted}/${topic.reviewsDue} | ${
        topic.attentionReasons.length > 0 ? '是' : '否'
      } |`,
    )
  }
  lines.push('', '## 待关注点', '')
  const attention = report.topics.filter(
    (topic) => topic.attentionReasons.length > 0,
  )
  if (attention.length === 0) {
    lines.push('- 无（仅基于当前窗口内的聚合数据）。')
  } else {
    for (const topic of attention) {
      lines.push(`- ${topic.kcId}：${topic.attentionReasons.join('、')}`)
    }
  }
  lines.push(
    '',
    '> 说明：以上是聚合统计与不确定性提示，不是学生能力标签，也不替代教师判断。',
    '',
  )
  return lines.join('\n')
}
