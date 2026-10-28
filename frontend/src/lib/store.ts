/**
 * 本地 store：唯一持久化位置是浏览器 localStorage（键 `aeh.frontend.v1`）。
 *
 * 不联网、不读文件、不写文件系统。导出/导入由 UI 用 Blob 与 <input type=file>
 * 完成；本模块只做 JSON 序列化和严格校验。
 */

import {
  KnowledgeGraph,
  packageFromInput,
  validatePackage,
} from './core'
import type { GateMode } from './core'
import {
  buildStudentTwin,
  computeReviewOutcome,
  curriculumItemFrom,
  learnerProgressFor,
} from './behavior'
import {
  OBSERVED_SOURCES,
  STORAGE_KEY,
  STORE_VERSION,
  emptyStore,
  isObservedSource,
  nowIso,
  uid,
} from './model'
import type {
  AppStore,
  Consent,
  Edge,
  Item,
  Kc,
  PreparedIntervention,
  ProgressEntry,
  ProgressGroup,
  ReviewRecord,
  Student,
} from './model'
import { syntheticPreset } from './preset'

type Listener = () => void

let current: AppStore = loadInitialStore()
const listeners = new Set<Listener>()

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

function persist(store: AppStore): void {
  const target = storage()
  if (target === null) return
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 配额/隐私模式下静默失败；导出 JSON 仍可保住数据。
  }
}

function loadInitialStore(): AppStore {
  const target = storage()
  if (target === null) return syntheticPreset()
  try {
    const raw = target.getItem(STORAGE_KEY)
    if (raw === null) return syntheticPreset()
    const parsed = validateStoreData(JSON.parse(raw))
    if (parsed.ok) return parsed.store
  } catch {
    // 损坏的本地数据不阻塞启动；保留原字符串直到用户清空/重新导入。
  }
  return syntheticPreset()
}

function commit(next: AppStore): void {
  current = next
  persist(next)
  for (const listener of listeners) listener()
}

export function getStore(): AppStore {
  return current
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type MutationResult<T = undefined> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

function ok<T>(value: T): MutationResult<T> {
  return { ok: true, value }
}

function fail(error: string): MutationResult<never> {
  return { ok: false, error }
}

type MutableStore = {
  version: typeof STORE_VERSION
  students: Student[]
  kcs: Kc[]
  edges: Edge[]
  items: Item[]
  progress: ProgressGroup[]
  reviews: ReviewRecord[]
  interventions: PreparedIntervention[]
  consents: Consent[]
}

function cloneStore(store: AppStore): MutableStore {
  return {
    ...store,
    students: [...store.students],
    kcs: [...store.kcs],
    edges: [...store.edges],
    items: [...store.items],
    progress: [...store.progress],
    reviews: [...store.reviews],
    interventions: [...store.interventions],
    consents: [...store.consents],
  }
}

export function addStudent(ref: string, grade: number): MutationResult<Student> {
  const trimmed = ref.trim()
  if (trimmed.length === 0) return fail('学生代号不能为空')
  if (trimmed.length > 40) return fail('学生代号最多 40 个字符')
  if (!Number.isInteger(grade) || grade < 1 || grade > 13) {
    return fail('年级必须是 1–13 的整数')
  }
  if (current.students.some((student) => student.ref === trimmed)) {
    return fail(`学生代号已存在：${trimmed}`)
  }
  const student: Student = {
    ref: trimmed,
    grade,
    createdAt: nowIso(),
    synthetic: false,
  }
  const next = cloneStore(current)
  next.students.push(student)
  next.consents.push({
    studentRef: trimmed,
    scope: 'report_aggregate',
    granted: true,
    updatedAt: nowIso(),
    note: '新建学生时默认记录本地聚合报告同意；可随时撤销',
    synthetic: false,
  })
  next.progress.push({ studentRef: trimmed, entries: [] })
  commit(next)
  return ok(student)
}

export function updateStudent(
  oldRef: string,
  newRef: string,
  grade: number,
): MutationResult<Student> {
  const trimmed = newRef.trim()
  if (trimmed.length === 0) return fail('学生代号不能为空')
  if (trimmed.length > 40) return fail('学生代号最多 40 个字符')
  if (!Number.isInteger(grade) || grade < 1 || grade > 13) {
    return fail('年级必须是 1–13 的整数')
  }
  const existing = current.students.find((student) => student.ref === oldRef)
  if (existing === undefined) return fail(`找不到学生：${oldRef}`)
  if (
    trimmed !== oldRef &&
    current.students.some((student) => student.ref === trimmed)
  ) {
    return fail(`学生代号已存在：${trimmed}`)
  }
  const updated: Student = { ...existing, ref: trimmed, grade }
  const next = cloneStore(current)
  next.students = next.students.map((student) =>
    student.ref === oldRef ? updated : student,
  )
  next.progress = next.progress.map((group) =>
    group.studentRef === oldRef
      ? { ...group, studentRef: trimmed }
      : group,
  )
  next.reviews = next.reviews.map((review) =>
    review.studentRef === oldRef ? { ...review, studentRef: trimmed } : review,
  )
  next.interventions = next.interventions.map((intervention) =>
    intervention.studentRef === oldRef
      ? { ...intervention, studentRef: trimmed }
      : intervention,
  )
  next.consents = next.consents.map((consent) =>
    consent.studentRef === oldRef
      ? { ...consent, studentRef: trimmed }
      : consent,
  )
  commit(next)
  return ok(updated)
}

export function deleteStudent(ref: string): MutationResult {
  if (!current.students.some((student) => student.ref === ref)) {
    return fail(`找不到学生：${ref}`)
  }
  const next = cloneStore(current)
  next.students = next.students.filter((student) => student.ref !== ref)
  next.progress = next.progress.filter((group) => group.studentRef !== ref)
  next.reviews = next.reviews.filter((review) => review.studentRef !== ref)
  next.interventions = next.interventions.filter(
    (intervention) => intervention.studentRef !== ref,
  )
  next.consents = next.consents.filter((consent) => consent.studentRef !== ref)
  commit(next)
  return ok(undefined)
}

const KC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function addKc(input: {
  readonly id: string
  readonly label: string
  readonly stage: string
  readonly nodeType: Kc['nodeType']
}): MutationResult<Kc> {
  const id = input.id.trim()
  const label = input.label.trim()
  if (!KC_ID_RE.test(id)) {
    return fail('知识点 ID 只能用字母/数字开头，允许 . _ : -，最长 128')
  }
  if (label.length === 0) return fail('知识点名称不能为空')
  if (current.kcs.some((kc) => kc.id === id)) return fail(`知识点已存在：${id}`)
  const kc: Kc = {
    id,
    label,
    stage: input.stage.trim() || '未标注',
    nodeType: input.nodeType,
    synthetic: false,
  }
  const next = cloneStore(current)
  next.kcs.push(kc)
  commit(next)
  return ok(kc)
}

export function deleteKc(id: string): MutationResult {
  const referenced: string[] = []
  if (current.edges.some((edge) => edge.source === id || edge.target === id)) {
    referenced.push('先修边')
  }
  if (current.items.some((item) => item.requiredKcs.includes(id))) {
    referenced.push('题目')
  }
  if (current.progress.some((group) => group.entries.some((entry) => entry.kcId === id))) {
    referenced.push('进度记录')
  }
  if (current.reviews.some((review) => review.kcId === id)) {
    referenced.push('复习记录')
  }
  if (current.interventions.some((intervention) => intervention.kcId === id)) {
    referenced.push('已准备干预')
  }
  if (referenced.length > 0) {
    return fail(`知识点仍被引用（${referenced.join('、')}），请先处理引用`)
  }
  const next = cloneStore(current)
  next.kcs = next.kcs.filter((kc) => kc.id !== id)
  commit(next)
  return ok(undefined)
}

function graphFor(kcs: readonly Kc[], edges: readonly Edge[]): KnowledgeGraph {
  return new KnowledgeGraph({
    version: 1,
    nodes: kcs.map((kc) => ({
      nodeId: kc.id,
      nodeType: kc.nodeType,
      conceptId: null,
    })),
    edges: edges.map((edge) => ({
      sourceId: edge.source,
      targetId: edge.target,
      relation: 'REQUIRES',
      status: 'approved',
      confidence: 1,
      provenance: 'frontend.local_teacher',
    })),
  })
}

export function validateGraph(
  kcs: readonly Kc[],
  edges: readonly Edge[],
): { readonly ok: boolean; readonly error?: string } {
  try {
    graphFor(kcs, edges)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function addEdge(source: string, target: string): MutationResult<Edge> {
  if (source === target) return fail('自环不是有效先修关系')
  if (!current.kcs.some((kc) => kc.id === source)) {
    return fail(`依赖方知识点不存在：${source}`)
  }
  if (!current.kcs.some((kc) => kc.id === target)) {
    return fail(`先修方知识点不存在：${target}`)
  }
  if (
    current.edges.some(
      (edge) => edge.source === source && edge.target === target,
    )
  ) {
    return fail('这条先修边已存在')
  }
  const edge: Edge = {
    id: uid('edge'),
    source,
    target,
    relation: 'REQUIRES',
    synthetic: false,
  }
  const graphCheck = validateGraph(current.kcs, [...current.edges, edge])
  if (!graphCheck.ok) {
    return fail(`课程图谱拒绝：${graphCheck.error ?? '成环'}`)
  }
  const next = cloneStore(current)
  next.edges.push(edge)
  commit(next)
  return ok(edge)
}

export function deleteEdge(id: string): MutationResult {
  if (!current.edges.some((edge) => edge.id === id)) {
    return fail('找不到这条边')
  }
  const next = cloneStore(current)
  next.edges = next.edges.filter((edge) => edge.id !== id)
  commit(next)
  return ok(undefined)
}

export interface ItemInput {
  readonly prompt: string
  readonly requiredKcs: readonly string[]
  readonly difficulty: number
  readonly gradeLevel: number
  readonly estimatedMinutes: number
  readonly cognitiveLoad: number
  readonly hints: readonly string[]
  readonly answerExplanation: string
}

function itemFromInput(input: ItemInput, id: string, synthetic: boolean): Item | string {
  const prompt = input.prompt.trim()
  if (prompt.length === 0) return '题目内容不能为空'
  if (input.requiredKcs.length === 0) return '题目至少要标注一个必需 KC'
  if (input.requiredKcs.some((kcId) => !current.kcs.some((kc) => kc.id === kcId))) {
    return '题目必需 KC 中存在未知知识点'
  }
  if (!Number.isInteger(input.difficulty) || input.difficulty < 1 || input.difficulty > 5) {
    return '难度必须是 1–5 的整数'
  }
  if (!Number.isInteger(input.gradeLevel) || input.gradeLevel < 1 || input.gradeLevel > 13) {
    return '年级必须是 1–13 的整数'
  }
  if (!Number.isFinite(input.estimatedMinutes) || input.estimatedMinutes <= 0) {
    return '预计分钟数必须大于 0'
  }
  if (!Number.isFinite(input.cognitiveLoad) || input.cognitiveLoad < 0) {
    return '认知负荷必须 >= 0'
  }
  return {
    id,
    prompt,
    requiredKcs: [...new Set(input.requiredKcs)],
    difficulty: input.difficulty,
    gradeLevel: input.gradeLevel,
    estimatedMinutes: input.estimatedMinutes,
    cognitiveLoad: input.cognitiveLoad,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 1,
    futureMethods: [],
    hints: input.hints.filter((hint) => hint.trim().length > 0),
    answerExplanation: input.answerExplanation.trim(),
    synthetic,
  }
}

export function addItem(input: ItemInput): MutationResult<Item> {
  const id = uid('item')
  const item = itemFromInput(input, id, false)
  if (typeof item === 'string') return fail(item)
  const next = cloneStore(current)
  next.items.push(item)
  commit(next)
  return ok(item)
}

export function updateItem(id: string, input: ItemInput): MutationResult<Item> {
  const existing = current.items.find((item) => item.id === id)
  if (existing === undefined) return fail(`找不到题目：${id}`)
  const item = itemFromInput(input, id, existing.synthetic)
  if (typeof item === 'string') return fail(item)
  const next = cloneStore(current)
  next.items = next.items.map((entry) => (entry.id === id ? item : entry))
  commit(next)
  return ok(item)
}

export function deleteItem(id: string): MutationResult {
  if (!current.items.some((item) => item.id === id)) {
    return fail(`找不到题目：${id}`)
  }
  const next = cloneStore(current)
  next.items = next.items.filter((item) => item.id !== id)
  commit(next)
  return ok(undefined)
}

export function addProgress(
  studentRef: string,
  input: {
    readonly kcId: string
    readonly status: ProgressEntry['status']
    readonly source: string
    readonly note: string
  },
): MutationResult<ProgressEntry> {
  if (!isObservedSource(input.source)) {
    return fail('进度写入只接受 observed_*；simulated_* 永不写真实掌握度')
  }
  if (!current.students.some((student) => student.ref === studentRef)) {
    return fail(`找不到学生：${studentRef}`)
  }
  if (!current.kcs.some((kc) => kc.id === input.kcId)) {
    return fail(`找不到知识点：${input.kcId}`)
  }
  const note = input.note.trim()
  if (note.length === 0) return fail('请填写来源备注（观察场合/依据）')
  const entry: ProgressEntry = {
    id: uid('progress'),
    kcId: input.kcId,
    status: input.status,
    source: input.source,
    note,
    observedAt: nowIso(),
    synthetic: false,
  }
  const next = cloneStore(current)
  const group = next.progress.find((item) => item.studentRef === studentRef)
  if (group === undefined) {
    next.progress.push({ studentRef, entries: [entry] })
  } else {
    next.progress = next.progress.map((item) =>
      item.studentRef === studentRef
        ? { ...item, entries: [...item.entries, entry] }
        : item,
    )
  }
  commit(next)
  return ok(entry)
}

export function deleteProgress(
  studentRef: string,
  entryId: string,
): MutationResult {
  const group = current.progress.find((item) => item.studentRef === studentRef)
  if (group === undefined || !group.entries.some((entry) => entry.id === entryId)) {
    return fail('找不到这条进度记录')
  }
  const next = cloneStore(current)
  next.progress = next.progress.map((item) =>
    item.studentRef === studentRef
      ? {
          ...item,
          entries: item.entries.filter((entry) => entry.id !== entryId),
        }
      : item,
  )
  commit(next)
  return ok(undefined)
}

export function recordReview(input: {
  readonly studentRef: string
  readonly kcId: string
  readonly itemId: string | null
  readonly success: boolean
  readonly independent: boolean
  readonly hintLevel: number
  readonly occurredAt?: string
}): MutationResult<ReviewRecord> {
  if (!current.students.some((student) => student.ref === input.studentRef)) {
    return fail(`找不到学生：${input.studentRef}`)
  }
  if (!current.kcs.some((kc) => kc.id === input.kcId)) {
    return fail(`找不到知识点：${input.kcId}`)
  }
  if (
    !Number.isInteger(input.hintLevel) ||
    input.hintLevel < 0 ||
    input.hintLevel > 3
  ) {
    return fail('提示等级必须是 0–3 的整数')
  }
  const occurredAt = input.occurredAt ?? nowIso()
  const view = buildStudentTwin(current, input.studentRef, occurredAt)
  const outcome = computeReviewOutcome(
    view.twin,
    input.kcId,
    {
      observationId: uid('observation'),
      success: input.success,
      independent: input.independent,
      hintLevel: input.hintLevel,
      kind: 'attempt',
      occurredAt,
    },
    occurredAt,
  )
  const review: ReviewRecord = {
    id: uid('review'),
    studentRef: input.studentRef,
    kcId: input.kcId,
    itemId: input.itemId,
    success: input.success,
    independent: input.independent,
    hintLevel: input.hintLevel,
    occurredAt,
    nextDueAt: outcome.nextDueAt,
    nextIntervalDays: outcome.nextIntervalDays,
    stabilityDays: outcome.stabilityDays,
    difficulty: outcome.difficulty,
    source: 'observed_review',
    synthetic: false,
  }
  const next = cloneStore(current)
  next.reviews.push(review)
  commit(next)
  return ok(review)
}

export function setConsent(
  studentRef: string,
  granted: boolean,
  note = '',
): MutationResult<Consent> {
  if (!current.students.some((student) => student.ref === studentRef)) {
    return fail(`找不到学生：${studentRef}`)
  }
  const consent: Consent = {
    studentRef,
    scope: 'report_aggregate',
    granted,
    updatedAt: nowIso(),
    note: note.trim() || (granted ? '本地聚合报告同意' : '本地聚合报告同意已撤销'),
    synthetic: current.students.find((student) => student.ref === studentRef)?.synthetic ?? false,
  }
  const next = cloneStore(current)
  next.consents = next.consents.some((entry) => entry.studentRef === studentRef)
    ? next.consents.map((entry) =>
        entry.studentRef === studentRef ? consent : entry,
      )
    : [...next.consents, consent]
  commit(next)
  return ok(consent)
}

export function prepareIntervention(
  studentRef: string,
  kcId: string,
): MutationResult<PreparedIntervention> {
  const student = current.students.find((entry) => entry.ref === studentRef)
  if (student === undefined) return fail('请先选择学生')
  const kc = current.kcs.find((entry) => entry.id === kcId)
  if (kc === undefined) return fail('请先选择知识点')
  const trainingCandidates = current.items.filter((item) =>
    item.requiredKcs.includes(kcId),
  )
  if (trainingCandidates.length === 0) {
    return fail(`题库里没有覆盖 ${kc.label} 的题目，无法准备干预包`)
  }
  // 至少给迁移留一道未见过的题：训练与迁移不得重叠。
  const trainingCount =
    trainingCandidates.length > 1
      ? Math.min(2, trainingCandidates.length - 1)
      : 1
  const trainingSource = trainingCandidates.slice(0, trainingCount)
  const trainingIds = new Set(trainingSource.map((item) => item.id))
  const trainingItems = trainingSource.map(curriculumItemFrom)
  const transferSource = trainingCandidates.find(
    (item) => !trainingIds.has(item.id),
  )
  const transferItems = transferSource
    ? [{ ...curriculumItemFrom(transferSource), role: 'transfer' as const, seenBefore: false }]
    : []
  const hints = trainingCandidates.flatMap((item) => item.hints)
  const pkg = packageFromInput({
    packageId: uid('pkg'),
    objectiveId: `objective.${kcId}`,
    trainingItems,
    transferItems,
    hintLadder: hints.length > 0 ? hints : ['最小提示：先说出第一步', '概念提示：回到定义', '示范：完整做一遍'],
    feedbackTemplates: {
      correct: '独立做对：保持间隔，不额外加量。',
      incorrect: '记录可观察错步，按最小提示梯度重试；不贴能力标签。',
    },
    explanationResources: trainingCandidates
      .map((item) => item.answerExplanation)
      .filter((text) => text.length > 0),
    completionCriteria: { independentCorrect: 2, maxHintLevel: 1 },
    requiredKcs: [kcId],
    independentTransfer: true,
    schoolMode: 'learn',
  })
  const validation = validatePackage(
    pkg,
    learnerProgressFor(current, studentRef),
    'learn',
  )
  const intervention: PreparedIntervention = {
    id: uid('intervention'),
    studentRef,
    kcId,
    createdAt: nowIso(),
    status: 'prepared',
    packageId: pkg.packageId,
    objectiveId: pkg.objectiveId,
    trainingItemIds: pkg.trainingItems.map((item) => item.itemId),
    transferItemIds: pkg.transferItems.map((item) => item.itemId),
    hintLadder: [...pkg.hintLadder],
    completionCriteria: Object.entries(pkg.completionCriteria).map(
      ([key, value]) => `${key}=${String(value)}`,
    ),
    requiredKcs: [...pkg.requiredKcs],
    independentTransfer: pkg.independentTransfer,
    schoolMode: pkg.schoolMode,
    valid: validation.valid,
    validationReasons: [...validation.reasons],
    approvalNote:
      '仅“已准备”，未交付。交付必须由 dsh 插件侧 host approval 独立复核门禁后执行；本前端没有交付动作。',
    synthetic: student.synthetic,
  }
  const next = cloneStore(current)
  next.interventions.push(intervention)
  commit(next)
  return ok(intervention)
}


export function exportStoreJson(): string {
  return JSON.stringify(current, null, 2)
}

export function importStoreJson(text: string): MutationResult<AppStore> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return fail(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = validateStoreData(raw)
  if (!parsed.ok) {
    return fail(parsed.errors.join('；'))
  }
  commit(parsed.store)
  return ok(parsed.store)
}

export function resetToSynthetic(): AppStore {
  const preset = syntheticPreset()
  commit(preset)
  return preset
}

export function clearAll(): AppStore {
  const empty = emptyStore()
  commit(empty)
  return empty
}

// ---------------------------------------------------------------------------
// 严格导入校验：格式不对时返回错误，绝不覆盖现有数据。
// ---------------------------------------------------------------------------

type ValidationResult =
  | { readonly ok: true; readonly store: AppStore }
  | { readonly ok: false; readonly errors: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function validateStoreData(raw: unknown): ValidationResult {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ['顶层必须是 JSON 对象'] }
  if (raw.version !== STORE_VERSION) {
    return {
      ok: false,
      errors: [`不支持的数据版本：${String(raw.version)}（期望 ${STORE_VERSION}）`],
    }
  }
  for (const key of [
    'students',
    'kcs',
    'edges',
    'items',
    'progress',
    'reviews',
    'interventions',
    'consents',
  ]) {
    if (!Array.isArray(raw[key])) errors.push(`${key} 必须是数组`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const students: Student[] = []
  for (const [index, value] of (raw.students as unknown[]).entries()) {
    if (!isRecord(value) || typeof value.ref !== 'string' || value.ref.trim() === '') {
      errors.push(`students[${index}].ref 非法`)
      continue
    }
    if (!Number.isInteger(value.grade) || (value.grade as number) < 1 || (value.grade as number) > 13) {
      errors.push(`students[${index}].grade 非法`)
      continue
    }
    students.push({
      ref: value.ref,
      grade: value.grade as number,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      synthetic: value.synthetic === true,
    })
  }
  const studentRefs = new Set(students.map((student) => student.ref))
  if (studentRefs.size !== students.length) errors.push('学生代号重复')

  const kcs: Kc[] = []
  for (const [index, value] of (raw.kcs as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      !KC_ID_RE.test(value.id) ||
      typeof value.label !== 'string' ||
      value.label.trim() === ''
    ) {
      errors.push(`kcs[${index}] 非法`)
      continue
    }
    kcs.push({
      id: value.id,
      label: value.label,
      stage: typeof value.stage === 'string' ? value.stage : '未标注',
      nodeType:
        value.nodeType === 'subskill' ? 'subskill' : 'knowledge_component',
      synthetic: value.synthetic === true,
    })
  }
  const kcIds = new Set(kcs.map((kc) => kc.id))
  if (kcIds.size !== kcs.length) errors.push('知识点 ID 重复')

  const edges: Edge[] = []
  for (const [index, value] of (raw.edges as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      typeof value.source !== 'string' ||
      typeof value.target !== 'string' ||
      !kcIds.has(value.source) ||
      !kcIds.has(value.target)
    ) {
      errors.push(`edges[${index}] 非法或引用了未知知识点`)
      continue
    }
    edges.push({
      id: value.id,
      source: value.source,
      target: value.target,
      relation: 'REQUIRES',
      synthetic: value.synthetic === true,
    })
  }

  const items: Item[] = []
  for (const [index, value] of (raw.items as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      typeof value.prompt !== 'string' ||
      !isStringArray(value.requiredKcs) ||
      value.requiredKcs.length === 0 ||
      value.requiredKcs.some((kcId) => !kcIds.has(kcId))
    ) {
      errors.push(`items[${index}] 非法或引用了未知知识点`)
      continue
    }
    if (
      !isFiniteNumber(value.difficulty) ||
      !isFiniteNumber(value.gradeLevel) ||
      !isFiniteNumber(value.estimatedMinutes) ||
      !isFiniteNumber(value.cognitiveLoad)
    ) {
      errors.push(`items[${index}] 数值字段非法`)
      continue
    }
    items.push({
      id: value.id,
      prompt: value.prompt,
      requiredKcs: [...value.requiredKcs],
      difficulty: value.difficulty,
      gradeLevel: value.gradeLevel,
      estimatedMinutes: value.estimatedMinutes,
      cognitiveLoad: value.cognitiveLoad,
      safetyChecked: value.safetyChecked !== false,
      contentVerified: value.contentVerified !== false,
      annotationConfidence: isFiniteNumber(value.annotationConfidence)
        ? value.annotationConfidence
        : 1,
      futureMethods: isStringArray(value.futureMethods) ? [...value.futureMethods] : [],
      hints: isStringArray(value.hints) ? [...value.hints] : [],
      answerExplanation:
        typeof value.answerExplanation === 'string' ? value.answerExplanation : '',
      synthetic: value.synthetic === true,
    })
  }

  const progress: { studentRef: string; entries: ProgressEntry[] }[] = []
  for (const [index, value] of (raw.progress as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.studentRef !== 'string' ||
      !studentRefs.has(value.studentRef) ||
      !Array.isArray(value.entries)
    ) {
      errors.push(`progress[${index}] 非法`)
      continue
    }
    const entries: ProgressEntry[] = []
    for (const [entryIndex, entry] of value.entries.entries()) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== 'string' ||
        typeof entry.kcId !== 'string' ||
        !kcIds.has(entry.kcId) ||
        !['taught', 'in_progress', 'confirmed'].includes(String(entry.status)) ||
        !OBSERVED_SOURCES.includes(entry.source as (typeof OBSERVED_SOURCES)[number]) ||
        typeof entry.note !== 'string' ||
        entry.note.trim() === ''
      ) {
        errors.push(`progress[${index}].entries[${entryIndex}] 非法`)
        continue
      }
      entries.push({
        id: entry.id,
        kcId: entry.kcId,
        status: entry.status as ProgressEntry['status'],
        source: entry.source as ProgressEntry['source'],
        note: entry.note,
        observedAt:
          typeof entry.observedAt === 'string' ? entry.observedAt : nowIso(),
        synthetic: entry.synthetic === true,
      })
    }
    progress.push({ studentRef: value.studentRef, entries })
  }

  const reviews: ReviewRecord[] = []
  for (const [index, value] of (raw.reviews as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      typeof value.studentRef !== 'string' ||
      !studentRefs.has(value.studentRef) ||
      typeof value.kcId !== 'string' ||
      !kcIds.has(value.kcId) ||
      !isBool(value.success) ||
      !isBool(value.independent) ||
      !Number.isInteger(value.hintLevel) ||
      (value.hintLevel as number) < 0 ||
      (value.hintLevel as number) > 3 ||
      typeof value.occurredAt !== 'string'
    ) {
      errors.push(`reviews[${index}] 非法`)
      continue
    }
    reviews.push({
      id: value.id,
      studentRef: value.studentRef,
      kcId: value.kcId,
      itemId: typeof value.itemId === 'string' ? value.itemId : null,
      success: value.success,
      independent: value.independent,
      hintLevel: value.hintLevel as number,
      occurredAt: value.occurredAt,
      nextDueAt:
        typeof value.nextDueAt === 'string' ? value.nextDueAt : value.occurredAt,
      nextIntervalDays: isFiniteNumber(value.nextIntervalDays)
        ? value.nextIntervalDays
        : 1,
      stabilityDays: isFiniteNumber(value.stabilityDays)
        ? value.stabilityDays
        : 1,
      difficulty: isFiniteNumber(value.difficulty) ? value.difficulty : 5,
      source: 'observed_review',
      synthetic: value.synthetic === true,
    })
  }

  const interventions: PreparedIntervention[] = []
  for (const [index, value] of (raw.interventions as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      typeof value.studentRef !== 'string' ||
      !studentRefs.has(value.studentRef) ||
      typeof value.kcId !== 'string' ||
      !kcIds.has(value.kcId) ||
      typeof value.packageId !== 'string'
    ) {
      errors.push(`interventions[${index}] 非法`)
      continue
    }
    interventions.push({
      id: value.id,
      studentRef: value.studentRef,
      kcId: value.kcId,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
      status: 'prepared',
      packageId: value.packageId,
      objectiveId:
        typeof value.objectiveId === 'string'
          ? value.objectiveId
          : `objective.${value.kcId}`,
      trainingItemIds: isStringArray(value.trainingItemIds)
        ? [...value.trainingItemIds]
        : [],
      transferItemIds: isStringArray(value.transferItemIds)
        ? [...value.transferItemIds]
        : [],
      hintLadder: isStringArray(value.hintLadder) ? [...value.hintLadder] : [],
      completionCriteria: isStringArray(value.completionCriteria)
        ? [...value.completionCriteria]
        : [],
      requiredKcs: isStringArray(value.requiredKcs) ? [...value.requiredKcs] : [],
      independentTransfer: value.independentTransfer !== false,
      schoolMode: (['learn', 'preview', 'review'] as const).includes(
        value.schoolMode as GateMode,
      )
        ? (value.schoolMode as GateMode)
        : 'learn',
      valid: value.valid === true,
      validationReasons: isStringArray(value.validationReasons)
        ? [...value.validationReasons]
        : [],
      approvalNote:
        typeof value.approvalNote === 'string' ? value.approvalNote : '',
      synthetic: value.synthetic === true,
    })
  }

  const consents: Consent[] = []
  for (const [index, value] of (raw.consents as unknown[]).entries()) {
    if (
      !isRecord(value) ||
      typeof value.studentRef !== 'string' ||
      !studentRefs.has(value.studentRef) ||
      value.scope !== 'report_aggregate' ||
      !isBool(value.granted)
    ) {
      errors.push(`consents[${index}] 非法`)
      continue
    }
    consents.push({
      studentRef: value.studentRef,
      scope: 'report_aggregate',
      granted: value.granted,
      updatedAt:
        typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
      note: typeof value.note === 'string' ? value.note : '',
      synthetic: value.synthetic === true,
    })
  }
  if (consents.length !== new Set(consents.map((consent) => consent.studentRef)).size) {
    errors.push('同一学生有多条同意记录')
  }

  if (errors.length > 0) return { ok: false, errors }
  const store: AppStore = {
    version: STORE_VERSION,
    students,
    kcs,
    edges,
    items,
    progress,
    reviews,
    interventions,
    consents,
  }
  const graph = validateGraph(kcs, edges)
  if (!graph.ok) errors.push(`先修图非法：${graph.error ?? '成环'}`)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, store }
}

