/**
 * 预置示例：全部来自 `src/data/synthetic.ts` 的既有合成 fixture。
 *
 * 每个实体都带 `synthetic: true`；UI 会标注“合成数据示例”，并可一键删除/清空。
 * 这不是用户数据，也不代表任何真实学生。
 */

import {
  curriculumEdges,
  curriculumGateResults,
  kcCatalog,
  progressAxes,
  retentionUnits,
  studentItems,
} from '../data/synthetic'
import {
  MemoryParameters,
  normalizeMemoryState,
  updateMemory,
} from './core'
import {
  STORE_VERSION,
  type AppStore,
  type Edge,
  type Item,
  type Kc,
  type ProgressEntry,
  type ReviewRecord,
  type Student,
} from './model'


const SYNTHETIC_STUDENT_REF = 'stu_syn_0001'
const SYNTHETIC_DATE = '2026-03-05T09:00:00+08:00'

const students: Student[] = [
  {
    ref: SYNTHETIC_STUDENT_REF,
    grade: 5,
    createdAt: SYNTHETIC_DATE,
    synthetic: true,
  },
]

const kcs: Kc[] = kcCatalog.map((kc) => ({
  id: kc.kcId,
  label: kc.label,
  stage: kc.stage,
  nodeType:
    kc.nodeType === 'Subskill' ? 'subskill' : 'knowledge_component',
  synthetic: true,
}))

const edges: Edge[] = curriculumEdges
  .filter(
    (edge) =>
      kcCatalog.some((kc) => kc.kcId === edge.source) &&
      kcCatalog.some((kc) => kc.kcId === edge.target),
  )
  .map((edge) => ({
    id: `edge.${edge.source}.${edge.target}`,
    source: edge.source,
    target: edge.target,
    relation: 'REQUIRES' as const,
    synthetic: true,
  }))

const items: Item[] = studentItems.map((item) => ({
  id: item.itemId,
  prompt: item.prompt,
  requiredKcs: [...item.requiredKcs],
  difficulty: item.difficulty,
  gradeLevel: 5,
  estimatedMinutes: item.estimatedMinutes,
  cognitiveLoad: item.difficulty * 2,
  safetyChecked: true,
  contentVerified: item.approvalStatus === 'approved',
  annotationConfidence: 1,
  futureMethods: [],
  hints: [...item.hints],
  answerExplanation: item.answerExplanation,
  synthetic: true,
}))

// 复用 synthetic.ts 里已有的“未教内容候选题”，让门禁拒绝在预置数据上可直接演示；
// 它明确标注为合成候选，不属于任何真实题库。
const multiplyCandidate = curriculumGateResults.find(
  (gate) => gate.itemId === 'item.fraction.multiply.candidate',
)
if (multiplyCandidate !== undefined) {
  items.push({
    id: multiplyCandidate.itemId,
    prompt: multiplyCandidate.itemLabel,
    requiredKcs: [...multiplyCandidate.requiredKcs],
    difficulty: 3,
    gradeLevel: 5,
    estimatedMinutes: 2,
    cognitiveLoad: 8,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 1,
    futureMethods: [],
    hints: ['先回忆分数乘法的意义：分子乘分子，分母乘分母。'],
    answerExplanation: '3/4 × 2/5 = 6/20 = 3/10。该题属于后续单元，默认不发放。',
    synthetic: true,
  })
}

const schoolAxis = progressAxes.find((axis) => axis.axis === 'SchoolProgress')

const progressEntries: ProgressEntry[] = (schoolAxis?.items ?? [])
  .filter((entry) => entry.status !== 'not_taught' && entry.status !== 'upcoming')
  .map((entry, index) => ({
    id: `progress.synthetic.${index + 1}`,
    kcId: entry.kcId,
    status:
      entry.kcId === 'kc.place.value'
        ? 'confirmed'
        : entry.status === 'in_progress'
          ? 'in_progress'
          : 'taught',
    source: 'observed_teacher' as const,
    note: `${entry.note}（合成数据示例）`,
    observedAt: '2026-03-05T09:00:00+08:00',
    synthetic: true,
  }))

const parameters = new MemoryParameters()

const reviews: ReviewRecord[] = retentionUnits.map((unit, index) => {
  const base = normalizeMemoryState({
    learnerRef: SYNTHETIC_STUDENT_REF,
    memoryUnitId: unit.kcId,
    stabilityDays: 1,
    difficulty: 5,
    modelVersion: parameters.parameterVersion,
  })
  const state = updateMemory(
    base,
    {
      observationId: `review.synthetic.${index + 1}`,
      success: true,
      independent: true,
      hintLevel: 0,
      kind: 'attempt',
      occurredAt: unit.lastIndependentSuccessAt,
    },
    parameters,
  )
  const interval = parameters.nextIntervalDays(
    state.stabilityDays,
    state.difficulty,
    0.9,
  )
  return {
    id: `review.synthetic.${index + 1}`,
    studentRef: SYNTHETIC_STUDENT_REF,
    kcId: unit.kcId,
    itemId:
      items.find((item) => item.requiredKcs.includes(unit.kcId))?.id ?? null,
    success: true,
    independent: true,
    hintLevel: 0,
    occurredAt: unit.lastIndependentSuccessAt,
    nextDueAt: addDaysIso(unit.lastIndependentSuccessAt, interval),
    nextIntervalDays: Number(interval.toFixed(6)),
    stabilityDays: Number(state.stabilityDays.toFixed(6)),
    difficulty: Number(state.difficulty.toFixed(6)),
    source: 'observed_review' as const,
    synthetic: true,
  }
})

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString()
}

export function syntheticPreset(): AppStore {
  return {
    version: STORE_VERSION,
    students,
    kcs,
    edges,
    items,
    progress: [{ studentRef: SYNTHETIC_STUDENT_REF, entries: progressEntries }],
    reviews,
    interventions: [],
    consents: [
      {
        studentRef: SYNTHETIC_STUDENT_REF,
        scope: 'report_aggregate',
        granted: true,
        updatedAt: SYNTHETIC_DATE,
        note: '预置示例同意记录（合成数据示例）',
        synthetic: true,
      },
    ],
  }
}
