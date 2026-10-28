/**
 * 聚合报告：只把 observed 复习折叠成 `report.ts` 允许的聚合事件，
 * 再走真实 `generateReport` 边界；不把题目、答案、步骤或原始作答放进报告。
 */

import { generateReport, reportToDict } from './core'
import type {
  AggregateEventInput,
  AggregateMetrics,
  LearningReport,
  ReportTopic,
} from './core'
import { consentFor, studentReviews } from './model'
import type { AppStore } from './model'

const DAY_MS = 86_400_000

export interface StudentReportEntry {
  readonly studentRef: string
  readonly grade: number
  readonly reviewCount: number
  readonly report: LearningReport
}

export interface ExcludedStudent {
  readonly studentRef: string
  readonly grade: number
  readonly reason: string
}

export interface AggregateReport {
  readonly generatedAt: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly included: readonly StudentReportEntry[]
  readonly excluded: readonly ExcludedStudent[]
  readonly totals: AggregateMetrics
  readonly topics: readonly ReportTopic[]
}

const EMPTY_METRICS: AggregateMetrics = {
  attempts: 0,
  independentCorrect: 0,
  hintedCorrect: 0,
  hintsRequested: 0,
  reviewsDue: 0,
  reviewsCompleted: 0,
  minutes: 0,
}

function addMetrics(left: AggregateMetrics, right: AggregateMetrics): AggregateMetrics {
  return {
    attempts: left.attempts + right.attempts,
    independentCorrect: left.independentCorrect + right.independentCorrect,
    hintedCorrect: left.hintedCorrect + right.hintedCorrect,
    hintsRequested: left.hintsRequested + right.hintsRequested,
    reviewsDue: left.reviewsDue + right.reviewsDue,
    reviewsCompleted: left.reviewsCompleted + right.reviewsCompleted,
    minutes: left.minutes + right.minutes,
  }
}

/** 把一次 observed 复习折叠成一条允许的聚合事件。 */
export function aggregateEventsForStudent(
  store: AppStore,
  studentRef: string,
): readonly AggregateEventInput[] {
  return studentReviews(store, studentRef).map((review) => {
    const item = store.items.find((entry) => entry.id === review.itemId)
    return {
      aggregateRef: `agg.${review.id}`,
      studentRef,
      occurredAt: review.occurredAt,
      kind: 'attempt_aggregate',
      consentScope: 'educational_report',
      kcId: review.kcId,
      attempts: 1,
      independentCorrect:
        review.success && review.independent && review.hintLevel === 0 ? 1 : 0,
      hintedCorrect:
        review.success && (!review.independent || review.hintLevel > 0) ? 1 : 0,
      hintsRequested: review.hintLevel > 0 ? 1 : 0,
      reviewsDue: 0,
      reviewsCompleted: 0,
      minutes: item?.estimatedMinutes ?? 1,
    }
  })
}

export function buildAggregateReport(
  store: AppStore,
  now: string = new Date().toISOString(),
): AggregateReport {
  const nowMs = Date.parse(now)
  const included: StudentReportEntry[] = []
  const excluded: ExcludedStudent[] = []
  const windowStart = new Date(0).toISOString()
  const windowEnd = new Date(nowMs + DAY_MS).toISOString()

  for (const student of store.students) {
    const consent = consentFor(store, student.ref)
    if (consent === undefined) {
      excluded.push({
        studentRef: student.ref,
        grade: student.grade,
        reason: '未记录同意（报告 fail-closed 排除）',
      })
      continue
    }
    if (!consent.granted) {
      excluded.push({
        studentRef: student.ref,
        grade: student.grade,
        reason: '同意已撤销（报告自动排除）',
      })
      continue
    }
    const events = aggregateEventsForStudent(store, student.ref)
    try {
      const report = generateReport(events, {
        audience: 'teacher',
        studentRef: student.ref,
        windowStart,
        windowEnd,
        generatedAt: now,
      })
      included.push({
        studentRef: student.ref,
        grade: student.grade,
        reviewCount: events.length,
        report,
      })
    } catch (error) {
      excluded.push({
        studentRef: student.ref,
        grade: student.grade,
        reason: `报告边界拒绝：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  let totals = EMPTY_METRICS
  for (const entry of included) totals = addMetrics(totals, entry.report.totals)

  const topicMap = new Map<string, ReportTopic>()
  for (const entry of included) {
    for (const topic of entry.report.topics) {
      const current = topicMap.get(topic.kcId)
      if (current === undefined) {
        topicMap.set(topic.kcId, topic)
      } else {
        const merged = addMetrics(current, topic)
        topicMap.set(topic.kcId, {
          kcId: topic.kcId,
          ...merged,
          attentionReasons: [...new Set([...current.attentionReasons, ...topic.attentionReasons])],
        })
      }
    }
  }

  return {
    generatedAt: now,
    windowStart,
    windowEnd,
    included,
    excluded,
    totals,
    topics: [...topicMap.values()].sort((left, right) =>
      left.kcId.localeCompare(right.kcId),
    ),
  }
}

/** 导出只包含聚合报告，不包含原始事件或事件 ID。 */
export function reportBundleToJson(report: AggregateReport): string {
  return JSON.stringify(
    {
      format: 'aeh.frontend.report.v1',
      generatedAt: report.generatedAt,
      windowStart: report.windowStart,
      windowEnd: report.windowEnd,
      dataMinimization: {
        aggregateOnly: true,
        rawStudentDataIncluded: false,
        eventIdsIncluded: false,
        revokedConsentExcluded: true,
      },
      includedStudents: report.included.map((entry) => ({
        studentRef: entry.studentRef,
        grade: entry.grade,
        reviewCount: entry.reviewCount,
        report: reportToDict(entry.report),
      })),
      excludedStudents: report.excluded.map((entry) => ({
        studentRef: entry.studentRef,
        grade: entry.grade,
        reason: entry.reason,
      })),
      totals: report.totals,
      topics: report.topics,
    },
    null,
    2,
  )
}

/** 供 UI/check 脚本使用的聚合口径。 */
export function reportIncludesStudent(
  report: AggregateReport,
  studentRef: string,
): boolean {
  return report.included.some((entry) => entry.studentRef === studentRef)
}
