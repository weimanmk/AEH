/**
 * 指标：全部由 store 的 observed 记录 + 真实 FSRS 实时算出。
 */

import { MemoryParameters } from './core'
import {
  buildStudentTwin,
  dueReviewsForTwin,
  latestProgressEntries,
} from './behavior'
import { consentFor, studentProgress, studentReviews } from './model'
import type { AppStore } from './model'

const DAY_MS = 86_400_000

export interface ConsentExclusion {
  readonly studentRef: string
  readonly grade: number
  readonly reason: string
}

export interface MetricsSummary {
  readonly studentsTotal: number
  readonly studentsIncluded: number
  readonly exclusions: readonly ConsentExclusion[]
  readonly kcCount: number
  readonly itemCount: number
  readonly kcCoverage: number
  readonly itemCoverage: number
  readonly dueCount: number
  readonly overdueCount: number
  readonly fsrsRecallMean: number | null
  readonly reviewsLast14Days: number
  readonly dailyReviewBurden: number
  readonly scheduledNext7Days: number
  readonly interventionsPrepared: number
  readonly reviewCount: number
}

export function buildMetrics(
  store: AppStore,
  now: string = new Date().toISOString(),
): MetricsSummary {
  const nowMs = Date.parse(now)
  const exclusions: ConsentExclusion[] = []
  const includedRefs: string[] = []
  for (const student of store.students) {
    const consent = consentFor(store, student.ref)
    if (consent === undefined) {
      exclusions.push({
        studentRef: student.ref,
        grade: student.grade,
        reason: '未记录同意（fail-closed 排除）',
      })
    } else if (!consent.granted) {
      exclusions.push({
        studentRef: student.ref,
        grade: student.grade,
        reason: '同意已撤销（自动排除）',
      })
    } else {
      includedRefs.push(student.ref)
    }
  }

  const coveredKcs = new Set<string>()
  for (const studentRef of includedRefs) {
    for (const entry of latestProgressEntries(studentProgress(store, studentRef))) {
      coveredKcs.add(entry.kcId)
    }
    for (const review of studentReviews(store, studentRef)) {
      coveredKcs.add(review.kcId)
    }
  }
  const itemCoverageCount = store.items.filter(
    (item) =>
      item.requiredKcs.length > 0 &&
      item.requiredKcs.every((kcId) => store.kcs.some((kc) => kc.id === kcId)),
  ).length

  let dueCount = 0
  let overdueCount = 0
  let scheduledNext7Days = 0
  let recallSum = 0
  let recallCount = 0
  let reviewsLast14Days = 0
  let reviewCount = 0
  const params = new MemoryParameters()

  for (const studentRef of includedRefs) {
    const view = buildStudentTwin(store, studentRef, now)
    for (const due of dueReviewsForTwin(view.twin, now)) {
      dueCount += 1
      if (due.overdueDays > 0) overdueCount += 1
    }
    for (const [, state] of view.twin.state.memory) {
      const anchor = state.lastObservedAt ?? state.lastIndependentSuccessAt
      if (anchor === null) continue
      const elapsed = Math.max(0, (nowMs - Date.parse(anchor)) / DAY_MS)
      recallSum += params.predict(
        elapsed,
        state.stabilityDays,
        state.difficulty,
      )
      recallCount += 1
      const dueAt =
        Date.parse(anchor) +
        params.nextIntervalDays(state.stabilityDays, state.difficulty, 0.9) *
          DAY_MS
      if (dueAt > nowMs && dueAt <= nowMs + 7 * DAY_MS) scheduledNext7Days += 1
    }
    const reviews = studentReviews(store, studentRef)
    reviewCount += reviews.length
    reviewsLast14Days += reviews.filter(
      (review) => nowMs - Date.parse(review.occurredAt) <= 14 * DAY_MS,
    ).length
  }

  return {
    studentsTotal: store.students.length,
    studentsIncluded: includedRefs.length,
    exclusions,
    kcCount: store.kcs.length,
    itemCount: store.items.length,
    kcCoverage: store.kcs.length === 0 ? 0 : coveredKcs.size / store.kcs.length,
    itemCoverage:
      store.items.length === 0 ? 0 : itemCoverageCount / store.items.length,
    dueCount,
    overdueCount,
    fsrsRecallMean: recallCount === 0 ? null : recallSum / recallCount,
    reviewsLast14Days,
    dailyReviewBurden: reviewsLast14Days / 14,
    scheduledNext7Days,
    interventionsPrepared: store.interventions.length,
    reviewCount: store.reviews.length,
  }
}
