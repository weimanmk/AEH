/**
 * 真实核心与本地 store 之间的纯逻辑适配层。
 *
 * 这里所有“掌握度/排程/诊断/门禁”结果都调用 `dsh-plugin/src` 的真实模块，
 * 不在前端重写算法；store 只负责保存用户录入的 observed 记录。
 * 本文件不依赖 React / DOM，Node 验证脚本可直接导入。
 */

import {
  ACTION_METHODS,
  DEFAULT_PROBE_WEIGHTS,
  HypothesisSet,
  LEARNING_SCIENCE_METHODS,
  MemoryParameters,
  StudentTwin,
  candidateFromInput,
  gateAllow,
  makeHypothesis,
  normalizeMemoryState,
  probeWeightsFromInput,
  retrievability,
  scoreCandidate,
  selectProbe,
  updateMemory,
} from './core'
import type {
  CurriculumItem,
  DiagnosticCandidate,
  GateDecision,
  GateMode,
  LearnerProgress,
  LearningScienceMethod,
  MemoryObservationInput,
  MemoryState,
  ProbeSelection,
  StrategyDecision,
  StrategyRequest,
} from './core'
import {
  PROGRESS_STATUS_LABEL,
  consentFor,
  studentProgress,
  studentReviews,
} from './model'
import type {
  AppStore,
  Item,
  Kc,
  ProgressEntry,
  ProgressStatus,
  ReviewRecord,
} from './model'
import { selectStrategy } from './core'

const DAY_MS = 86_400_000
const TARGET_RETENTION = 0.9

export function curriculumItemFrom(item: Item): CurriculumItem {
  return {
    itemId: item.id,
    requiredKcs: item.requiredKcs,
    gradeLevel: item.gradeLevel,
    safetyChecked: item.safetyChecked,
    contentVerified: item.contentVerified,
    annotationConfidence: item.annotationConfidence,
    annotationsComplete: true,
    futureMethods: item.futureMethods,
    cognitiveLoad: item.cognitiveLoad,
    extensionApproved: false,
    seenBefore: false,
    role: 'training',
  }
}

export function learnerProgressFor(
  store: AppStore,
  studentRef: string,
): LearnerProgress {
  const student = store.students.find((entry) => entry.ref === studentRef)
  const entries = latestProgressEntries(studentProgress(store, studentRef))
  const taught = new Set<string>()
  const inProgress = new Set<string>()
  const confirmed = new Set<string>()
  for (const entry of entries) {
    if (entry.status === 'taught') taught.add(entry.kcId)
    if (entry.status === 'in_progress') inProgress.add(entry.kcId)
    if (entry.status === 'confirmed') confirmed.add(entry.kcId)
  }
  return {
    studentRef,
    gradeLevel: student?.grade ?? null,
    taughtKcs: [...taught].sort(),
    inProgressKcs: [...inProgress].sort(),
    confirmedPriorKcs: [...confirmed].sort(),
    confirmedPreviewKcs: [],
    progressConfidence: entries.length > 0 ? 0.9 : 0.5,
    currentLoad: 0,
    loadBudget: 60,
    extensionMode: false,
  }
}

/** 同一 KC 只保留最后一次 observed 状态，避免旧记录覆盖新记录。 */
export function latestProgressEntries(
  entries: readonly ProgressEntry[],
): readonly ProgressEntry[] {
  const byKc = new Map<string, ProgressEntry>()
  for (const entry of [...entries].sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt),
  )) {
    byKc.set(entry.kcId, entry)
  }
  return [...byKc.values()]
}

export function gateForItem(
  store: AppStore,
  studentRef: string,
  itemId: string,
  mode: GateMode,
): { readonly decision: GateDecision; readonly item: Item } | null {
  const item = store.items.find((entry) => entry.id === itemId)
  if (item === undefined) return null
  return {
    item,
    decision: gateAllow(
      curriculumItemFrom(item),
      learnerProgressFor(store, studentRef),
      mode,
    ),
  }
}

export interface StudentTwinView {
  readonly twin: StudentTwin
  readonly progress: readonly ProgressEntry[]
  readonly reviews: readonly ReviewRecord[]
  readonly evidenceIds: readonly string[]
  readonly hypotheses: HypothesisSet
  readonly weakKcs: readonly Kc[]
}

function progressExposure(status: ProgressStatus): string {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'confirmed') return 'confirmed_prior'
  return 'taught'
}

/**
 * 用真实 `StudentTwin` 重放用户录入的 observed 进度与复习。
 *
 * - 进度事件 source='teacher'，只表示“接触/已教/已确认”，不伪造掌握；
 * - 复习事件 source='assessment'，经 `recordMemoryReview` 更新 FSRS；
 * - 掌握度只在有复习证据时更新，且是 observed 成功率与不确定性的简单投影。
 */
export function buildStudentTwin(
  store: AppStore,
  studentRef: string,
  now: string = new Date().toISOString(),
): StudentTwinView {
  const student = store.students.find((entry) => entry.ref === studentRef)
  if (student === undefined) {
    throw new Error(`未知学生：${studentRef}`)
  }
  const progress = [...studentProgress(store, studentRef)].sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  )
  const reviews = studentReviews(store, studentRef)
  const twin = new StudentTwin(studentRef, { clock: () => now })
  const evidenceIds: string[] = []

  for (const entry of progress) {
    const eventId = `evt.progress.${entry.id}`
    twin.recordObserved({
      eventId,
      eventType: 'PROGRESS_OBSERVED',
      source: 'teacher',
      studentRef,
      occurredAt: entry.observedAt,
      observedAt: entry.observedAt,
      payload: {
        kcId: entry.kcId,
        status: entry.status,
        observedSource: entry.source,
      },
      provenance: entry.note,
      consentScope: 'educational_report',
    })
    evidenceIds.push(eventId)
  }

  const evidenceByKc = new Map<string, string[]>()
  for (const review of reviews) {
    const eventId = `evt.review.${review.id}`
    twin.recordObserved({
      eventId,
      eventType: 'REVIEW_OBSERVED',
      source: 'assessment',
      studentRef,
      occurredAt: review.occurredAt,
      observedAt: review.occurredAt,
      payload: {
        kcId: review.kcId,
        success: review.success,
        independent: review.independent,
        hintLevel: review.hintLevel,
      },
      provenance: review.source,
      consentScope: 'educational_report',
    })
    evidenceIds.push(eventId)
    const observation: MemoryObservationInput = {
      observationId: review.id,
      success: review.success,
      independent: review.independent,
      hintLevel: review.hintLevel,
      kind: 'attempt',
      occurredAt: review.occurredAt,
    }
    twin.recordMemoryReview(review.kcId, observation, [eventId])
    const list = evidenceByKc.get(review.kcId) ?? []
    list.push(eventId)
    evidenceByKc.set(review.kcId, list)
  }

  const latest = latestProgressEntries(progress)
  for (const [kcId, ids] of evidenceByKc) {
    const kcReviews = reviews.filter((review) => review.kcId === kcId)
    const successCount = kcReviews.filter((review) => review.success).length
    const mean = successCount / kcReviews.length
    const uncertainty = Math.max(0.1, 0.8 / Math.sqrt(kcReviews.length))
    const progressEntry = latest.find((entry) => entry.kcId === kcId)
    twin.updateMastery(
      kcId,
      Number(mean.toFixed(6)),
      Number(uncertainty.toFixed(6)),
      ids,
      progressEntry ? progressExposure(progressEntry.status) : 'observed',
    )
  }

  const { set: hypotheses, weakKcs } = buildHypothesisSet(store, studentRef)
  if (evidenceIds.length > 0) {
    twin.bindHypotheses(hypotheses, { evidenceIds })
  }

  return { twin, progress, reviews, evidenceIds, hypotheses, weakKcs }
}

export interface HypothesisView {
  readonly hypothesisId: string
  readonly label: string
  readonly weight: number
  readonly kcId: string
  readonly evidenceCount: number
  readonly uncertainty: string
  readonly description: string
  readonly isUnknown: boolean
}

function weakKcsFor(store: AppStore, studentRef: string): readonly Kc[] {
  const entries = latestProgressEntries(studentProgress(store, studentRef))
  const reviews = studentReviews(store, studentRef)
  const weakIds = new Set<string>()
  for (const entry of entries) {
    if (entry.status === 'in_progress') weakIds.add(entry.kcId)
  }
  const latestByKc = new Map<string, ReviewRecord>()
  for (const review of reviews) latestByKc.set(review.kcId, review)
  for (const [kcId, review] of latestByKc) {
    if (!review.success) weakIds.add(kcId)
  }
  if (weakIds.size === 0) {
    // 没有缺口时，不强行编造假设；只把“未知”留足。
    return []
  }
  return store.kcs.filter((kc) => weakIds.has(kc.id))
}

export function buildHypothesisSet(
  store: AppStore,
  studentRef: string,
): { readonly set: HypothesisSet; readonly weakKcs: readonly Kc[] } {
  const weakKcs = weakKcsFor(store, studentRef)
  const set = new HypothesisSet()
  if (weakKcs.length === 0) {
    set.setUnknown(1, 'insufficient_observed_evidence')
    return { set, weakKcs }
  }
  const reviews = studentReviews(store, studentRef)
  for (const kc of weakKcs.slice(0, 2)) {
    const kcReviews = reviews.filter((review) => review.kcId === kc.id)
    const failures = kcReviews.filter((review) => !review.success).length
    const successes = kcReviews.filter((review) => review.success).length
    const failureRate = kcReviews.length === 0 ? 0.5 : failures / kcReviews.length
    const successRate = kcReviews.length === 0 ? 0.3 : successes / kcReviews.length
    const evidenceRefs = kcReviews.map((review) => `evt.review.${review.id}`)
    const gapWeight = 0.3 + 0.5 * failureRate
    const slipWeight = 0.15 + 0.35 * successRate
    set.spawn(
      makeHypothesis({
        hypothesisId: `hyp.${kc.id}.gap`,
        subjectScope: [kc.id],
        knowledgeAssumptions: {
          [kc.id]: '可能仍存在概念/程序缺口（假设，非事实）',
        },
        strategyPolicy: ['retrieval_practice', 'worked_examples'],
        bugRules: ['同型题重复出现同类错步时，才提高该假设权重'],
        predictedObservableBehaviors: {
          '同型题在无提示下再次出错': Number((0.35 + failureRate * 0.5).toFixed(3)),
          '提示后能改对但独立完成仍不稳': Number((0.25 + failureRate * 0.4).toFixed(3)),
        },
        responseToIntervention: ['对比反例', '自我解释', '最小提示梯度'],
        weight: gapWeight,
        evidenceRefs,
        uncertainty: 'high',
      }),
    )
    set.spawn(
      makeHypothesis({
        hypothesisId: `hyp.${kc.id}.slip`,
        subjectScope: [kc.id],
        knowledgeAssumptions: {
          [kc.id]: '也可能是偶发失误或状态波动（假设，非事实）',
        },
        strategyPolicy: ['spaced_practice'],
        bugRules: ['若新题独立正确，应提高该假设权重'],
        predictedObservableBehaviors: {
          '换题后独立正确': Number((0.4 + successRate * 0.5).toFixed(3)),
        },
        responseToIntervention: ['一次延迟复测，不急着加量'],
        weight: slipWeight,
        evidenceRefs,
        uncertainty: 'high',
      }),
    )
  }
  set.setUnknown(0.15, 'unexplained_residual')
  return { set, weakKcs }
}

export function hypothesisViews(
  view: StudentTwinView,
): readonly HypothesisView[] {
  const weights = view.twin.hypotheses?.weights() ?? view.hypotheses.weights()
  const labels = new Map<string, { kcId: string; description: string }>()
  for (const kc of view.weakKcs) {
    labels.set(`hyp.${kc.id}.gap`, {
      kcId: kc.id,
      description: `${kc.label}：可能仍存在概念/程序缺口（假设，非事实）`,
    })
    labels.set(`hyp.${kc.id}.slip`, {
      kcId: kc.id,
      description: `${kc.label}：也可能是偶发失误或状态波动（假设，非事实）`,
    })
  }
  const entries: HypothesisView[] = []
  for (const [hypothesisId, weight] of Object.entries(weights)) {
    if (weight <= 0) continue
    const meta = labels.get(hypothesisId)
    entries.push({
      hypothesisId,
      label:
        hypothesisId === 'unknown'
          ? '未知 / 证据不足'
          : (meta?.description ?? hypothesisId),
      weight,
      kcId: meta?.kcId ?? 'unknown',
      evidenceCount: view.twin.hypotheses?.get(hypothesisId)?.evidenceRefs.length ?? 0,
      uncertainty:
        view.twin.hypotheses?.get(hypothesisId)?.uncertainty ?? 'high',
      description:
        meta?.description ?? '剩余概率保留给当前候选无法解释的情况。',
      isUnknown: hypothesisId === 'unknown',
    })
  }
  return entries.sort((left, right) => {
    if (left.isUnknown !== right.isUnknown) return left.isUnknown ? 1 : -1
    return right.weight - left.weight
  })
}

export interface DueReviewView {
  readonly kcId: string
  readonly dueAt: string
  readonly overdueDays: number
  readonly expectedRetrievability: number
  readonly stabilityDays: number
  readonly difficulty: number
  readonly lastObservedAt: string
}

export function dueReviewsForTwin(
  twin: StudentTwin,
  now: string = new Date().toISOString(),
): readonly DueReviewView[] {
  const params = new MemoryParameters()
  const nowMs = Date.parse(now)
  const due: DueReviewView[] = []
  for (const [kcId, state] of twin.state.memory) {
    const anchor = state.lastObservedAt ?? state.lastIndependentSuccessAt
    if (anchor === null) continue
    const interval = params.nextIntervalDays(
      state.stabilityDays,
      state.difficulty,
      TARGET_RETENTION,
    )
    const dueMs = Date.parse(anchor) + interval * DAY_MS
    if (dueMs > nowMs) continue
    const elapsed = (nowMs - Date.parse(anchor)) / DAY_MS
    due.push({
      kcId,
      dueAt: new Date(dueMs).toISOString(),
      overdueDays: Math.max(0, (nowMs - dueMs) / DAY_MS),
      expectedRetrievability: params.predict(
        elapsed,
        state.stabilityDays,
        state.difficulty,
      ),
      stabilityDays: state.stabilityDays,
      difficulty: state.difficulty,
      lastObservedAt: anchor,
    })
  }
  return due.sort((left, right) => left.dueAt.localeCompare(right.dueAt))
}

export interface ReviewOutcome {
  readonly nextDueAt: string
  readonly nextIntervalDays: number
  readonly stabilityDays: number
  readonly difficulty: number
}

export function computeReviewOutcome(
  twin: StudentTwin,
  kcId: string,
  observation: MemoryObservationInput,
  occurredAt: string,
): ReviewOutcome {
  const params = new MemoryParameters()
  const previous =
    twin.memoryFor(kcId) ??
    normalizeMemoryState({
      learnerRef: twin.studentRef,
      memoryUnitId: kcId,
      stabilityDays: params.initialStabilityDays,
      difficulty: params.initialDifficulty,
      modelVersion: params.parameterVersion,
    })
  const updated = updateMemory(previous, observation, params)
  const interval = params.nextIntervalDays(
    updated.stabilityDays,
    updated.difficulty,
    TARGET_RETENTION,
  )
  return {
    nextDueAt: new Date(Date.parse(occurredAt) + interval * DAY_MS).toISOString(),
    nextIntervalDays: Number(interval.toFixed(6)),
    stabilityDays: Number(updated.stabilityDays.toFixed(6)),
    difficulty: Number(updated.difficulty.toFixed(6)),
  }
}

export interface ProbeView {
  readonly selection: ProbeSelection
  readonly item: Item
  readonly decision: GateDecision
}

export interface DiagnosisView {
  readonly best: ProbeView | null
  readonly candidates: readonly ProbeView[]
  readonly weights: Readonly<Record<string, number>>
}

export function diagnosisForStudent(
  store: AppStore,
  studentRef: string,
  twinView: StudentTwinView,
): DiagnosisView {
  const progress = learnerProgressFor(store, studentRef)
  const hypotheses = twinView.twin.hypotheses ?? twinView.hypotheses
  const weights = hypotheses.weights()
  const candidates: DiagnosticCandidate[] = []
  const byId = new Map<string, { item: Item; decision: GateDecision }>()
  for (const item of store.items) {
    const decision = gateAllow(curriculumItemFrom(item), progress, 'learn')
    const known = item.requiredKcs
      .map((kcId) => twinView.twin.memoryFor(kcId))
      .filter((state): state is MemoryState => state !== undefined)
    const meanRetrievability =
      known.length === 0
        ? 0.5
        : known.reduce((sum, state) => {
            const anchor = state.lastObservedAt ?? state.lastIndependentSuccessAt
            const elapsed =
              anchor === null
                ? 0
                : Math.max(0, (Date.now() - Date.parse(anchor)) / DAY_MS)
            return sum + retrievability(elapsed, state.stabilityDays)
          }, 0) / known.length
    const gapPrediction = 0.1 + 0.35 * meanRetrievability
    const slipPrediction = 0.65 + 0.3 * meanRetrievability
    const candidate = candidateFromInput(
      {
        item: curriculumItemFrom(item),
        predictions: {
          'hyp.gap': Number(gapPrediction.toFixed(6)),
          'hyp.slip': Number(slipPrediction.toFixed(6)),
        },
        timeMinutes: item.estimatedMinutes,
        risk: decision.allowed ? 0.1 : 0.8,
        cognitiveLoad: item.cognitiveLoad,
        teachingValue: decision.allowed ? 0.3 : 0,
      },
      decision,
    )
    candidates.push(candidate)
    byId.set(item.id, { item, decision })
  }
  const probeWeights = probeWeightsFromInput({})
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, weights, probeWeights))
    .map((selection) => {
      const found = byId.get(selection.itemId)
      return found ? { selection, item: found.item, decision: found.decision } : null
    })
    .filter((entry): entry is ProbeView => entry !== null)
  const bestSelection = selectProbe(candidates, weights, { probeWeights })
  const best =
    bestSelection === null
      ? null
      : (scored.find((entry) => entry.selection.itemId === bestSelection.itemId) ??
        null)
  return { best, candidates: scored, weights }
}

export function strategyForKc(
  kc: Kc,
  options: {
    readonly mode?: GateMode
    readonly intent?: StrategyRequest['intent']
    readonly masteryMean?: number
    readonly uncertainty?: number
    readonly inProgress?: boolean
  } = {},
): { readonly decision: StrategyDecision; readonly methods: readonly LearningScienceMethod[] } {
  const request: StrategyRequest = {
    intent: options.intent ?? (options.inProgress ? 'diagnose' : 'practice'),
    mode: options.mode ?? 'learn',
    knowledge: [
      {
        kcId: kc.id,
        masteryMean: options.masteryMean ?? 0.5,
        uncertainty: options.uncertainty ?? 0.3,
        learned: true,
      },
    ],
    evidenceSource: 'observed',
    purpose: 'production',
  }
  const decision = selectStrategy(request)
  const methodIds = new Set<string>(decision.methodIds)
  for (const action of [decision.action, 'assign_targeted_practice']) {
    try {
      for (const method of methodsForActionSafe(action)) methodIds.add(method)
    } catch {
      // 未知动作不扩展；决策本身已来自核心。
    }
  }
  const methods = [...methodIds]
    .map((id) => LEARNING_SCIENCE_METHODS.find((entry) => entry.methodId === id))
    .filter((entry): entry is LearningScienceMethod => entry !== undefined)
  return { decision, methods }
}

function methodsForActionSafe(action: string): readonly string[] {
  const mapping = ACTION_METHODS as Readonly<Record<string, readonly string[]>>
  return mapping[action] ?? []
}

export { DEFAULT_PROBE_WEIGHTS }
export { PROGRESS_STATUS_LABEL }
export { consentFor }
