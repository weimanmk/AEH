/**
 * 本地教师工具的领域模型与 store 格式。
 *
 * 数据只存浏览器 localStorage；学生只用本地代号 + 年级，不收集真实身份。
 * 任何掌握度写入都必须来自 `observed_*` 录入；`simulated_*` 没有写入口。
 */

export const STORE_VERSION = 1 as const
export const STORAGE_KEY = 'aeh.frontend.v1'

export type ProgressStatus = 'taught' | 'in_progress' | 'confirmed'

export const PROGRESS_STATUS_LABEL: Readonly<Record<ProgressStatus, string>> = {
  taught: '已授',
  in_progress: '进行中',
  confirmed: '已确认',
}

export type ObservedSource =
  | 'observed_teacher'
  | 'observed_review'
  | 'observed_diagnosis'

export const OBSERVED_SOURCES: readonly ObservedSource[] = Object.freeze([
  'observed_teacher',
  'observed_review',
  'observed_diagnosis',
])

export const OBSERVED_SOURCE_LABEL: Readonly<Record<ObservedSource, string>> =
  Object.freeze({
    observed_teacher: '教师录入（observed_teacher）',
    observed_review: '复习观测（observed_review）',
    observed_diagnosis: '诊断观测（observed_diagnosis）',
  })

/** 只接受 observed_*；simulated_* / 未知值一律拒绝。 */
export function isObservedSource(value: unknown): value is ObservedSource {
  return (
    typeof value === 'string' &&
    (OBSERVED_SOURCES as readonly string[]).includes(value)
  )
}

export interface Student {
  readonly ref: string
  readonly grade: number
  readonly createdAt: string
  /** 预置合成示例；用户录入为 false。 */
  readonly synthetic: boolean
}

export interface Kc {
  readonly id: string
  readonly label: string
  readonly stage: string
  readonly nodeType: 'knowledge_component' | 'subskill'
  readonly synthetic: boolean
}

export interface Edge {
  readonly id: string
  /** 依赖方（dependant）。 */
  readonly source: string
  /** 先修方（prerequisite）。 */
  readonly target: string
  readonly relation: 'REQUIRES'
  readonly synthetic: boolean
}

export interface Item {
  readonly id: string
  readonly prompt: string
  readonly requiredKcs: readonly string[]
  readonly difficulty: number
  readonly gradeLevel: number
  readonly estimatedMinutes: number
  readonly cognitiveLoad: number
  readonly safetyChecked: boolean
  readonly contentVerified: boolean
  readonly annotationConfidence: number
  readonly futureMethods: readonly string[]
  readonly hints: readonly string[]
  readonly answerExplanation: string
  readonly synthetic: boolean
}

export interface ProgressEntry {
  readonly id: string
  readonly kcId: string
  readonly status: ProgressStatus
  readonly source: ObservedSource
  /** 来源备注：谁在什么场合观察到什么。 */
  readonly note: string
  readonly observedAt: string
  readonly synthetic: boolean
}

export interface ProgressGroup {
  readonly studentRef: string
  readonly entries: readonly ProgressEntry[]
}

export interface ReviewRecord {
  readonly id: string
  readonly studentRef: string
  readonly kcId: string
  readonly itemId: string | null
  readonly success: boolean
  readonly independent: boolean
  readonly hintLevel: number
  /** 可观察复习发生时间。 */
  readonly occurredAt: string
  /** 写入时按 FSRS 计算的下次到期时间。 */
  readonly nextDueAt: string
  readonly nextIntervalDays: number
  readonly stabilityDays: number
  readonly difficulty: number
  readonly source: 'observed_review'
  readonly synthetic: boolean
}

export interface Consent {
  readonly studentRef: string
  readonly scope: 'report_aggregate'
  readonly granted: boolean
  readonly updatedAt: string
  readonly note: string
  readonly synthetic: boolean
}

export interface PreparedIntervention {
  readonly id: string
  readonly studentRef: string
  readonly kcId: string
  readonly createdAt: string
  readonly status: 'prepared'
  readonly packageId: string
  readonly objectiveId: string
  readonly trainingItemIds: readonly string[]
  readonly transferItemIds: readonly string[]
  readonly hintLadder: readonly string[]
  readonly completionCriteria: readonly string[]
  readonly requiredKcs: readonly string[]
  readonly independentTransfer: boolean
  readonly schoolMode: 'learn' | 'preview' | 'review'
  readonly valid: boolean
  readonly validationReasons: readonly string[]
  readonly approvalNote: string
  readonly synthetic: boolean
}

export interface AppStore {
  readonly version: typeof STORE_VERSION
  readonly students: readonly Student[]
  readonly kcs: readonly Kc[]
  readonly edges: readonly Edge[]
  readonly items: readonly Item[]
  readonly progress: readonly ProgressGroup[]
  readonly reviews: readonly ReviewRecord[]
  readonly interventions: readonly PreparedIntervention[]
  readonly consents: readonly Consent[]
}

export function emptyStore(): AppStore {
  return {
    version: STORE_VERSION,
    students: [],
    kcs: [],
    edges: [],
    items: [],
    progress: [],
    reviews: [],
    interventions: [],
    consents: [],
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function uid(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString()
}

export function studentProgress(
  store: AppStore,
  studentRef: string,
): readonly ProgressEntry[] {
  return (
    store.progress.find((group) => group.studentRef === studentRef)?.entries ?? []
  )
}

export function studentReviews(
  store: AppStore,
  studentRef: string,
): readonly ReviewRecord[] {
  return store.reviews
    .filter((review) => review.studentRef === studentRef)
    .slice()
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
}

export function consentFor(
  store: AppStore,
  studentRef: string,
): Consent | undefined {
  return store.consents.find((consent) => consent.studentRef === studentRef)
}

export function kcLabelById(kcs: readonly Kc[], kcId: string): string {
  return kcs.find((kc) => kc.id === kcId)?.label ?? kcId
}
