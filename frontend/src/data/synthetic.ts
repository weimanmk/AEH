/**
 * AEH 演示前端 · 合成数据模块（唯一数据源）
 * ------------------------------------------------------------------
 * 本文件中的所有数值、题项、事件、报告与评测结果都是**合成 fixture**，
 * 用于演示 v1.1 规范中的结构（§5 认知孪生、§6 短期假设、§7 主动诊断、
 * §8 记忆/留存、§13 聚合报告、§19 模拟/真实分离）。
 *
 * 重要约束：
 *  - 不包含、也不代表任何真实学生数据；学生标识为伪匿名示例 `stu_syn_0001`。
 *  - 不连接后端、不调用真实接口；页面状态只存在于浏览器内存。
 *  - 概率与指标为结构示例，不是真实模型输出或真实学习效果。
 *  - 知识点命名沿用仓库既有合成示例：`kc.fraction.add` / `kc.fraction.equiv`
 *    / `kc.fraction.compare` / `kc.fraction.multiply`（见 dsh-plugin 合成 fixture）。
 */

export const DEMO_META = {
  productName: 'AEH 演示前端',
  productNameEn: 'Adaptive Cognitive Twin Education Harness',
  /** 首页产品一句话。 */
  oneLiner:
    '把学生真实的学习事件整理成可追溯的认知证据链：观测 → 假设 → 诊断 → 干预 → 真实验证。',
  stage: 'high_school',
  subject: 'mathematics',
  textbookVersion: 'synthetic_textbook_v1',
  pseudonymousStudentRef: 'stu_syn_0001',
  twinVersion: 54,
  className: '合成班级 demo-class-01',
  /** 合成数据声明（首页、页脚、各视图复用）。 */
  syntheticNotice:
    '本站所有数据均为合成 fixture（伪匿名示例），不代表任何真实学生，也未接入任何真实系统、后端或真实接口；页面状态只存在于浏览器内存。',
  phaseNotice:
    '演示阶段：脚手架 + 首页/4 视图，并已按 v1.1 规范自查补齐；不推送、不发邮件、不接后端。',
} as const

/* ------------------------------------------------------------------ */
/* 课程进度：三条彼此独立的进度轴（规范 §4.1）                          */
/* ------------------------------------------------------------------ */

export type ProgressStatus = 'taught' | 'in_progress' | 'upcoming' | 'not_taught'

export interface ProgressAxis {
  axis: 'SchoolProgress' | 'CognitiveProgress' | 'AIAugmentationProgress'
  label: string
  description: string
  items: { kcId: string; status: ProgressStatus; note: string; confidence: number }[]
}

export const progressAxes: ProgressAxis[] = [
  {
    axis: 'SchoolProgress',
    label: '学校进度（教师/学生确认）',
    description: '学校已教/正在教/即将教；仅表示“接触过”，不代表已掌握。',
    items: [
      { kcId: 'kc.place.value', status: 'taught', note: '先修，已确认', confidence: 0.95 },
      { kcId: 'kc.fraction.equiv', status: 'taught', note: '本周已教', confidence: 0.95 },
      { kcId: 'kc.fraction.add', status: 'in_progress', note: '正在学（异分母加法）', confidence: 0.9 },
      { kcId: 'kc.fraction.compare', status: 'taught', note: '上周已教', confidence: 0.85 },
      { kcId: 'kc.fraction.multiply', status: 'not_taught', note: '后续单元，课程门禁禁止自动发放', confidence: 0.99 },
    ],
  },
  {
    axis: 'CognitiveProgress',
    label: '认知进度（独立观测推断）',
    description: '不因“课堂讲完”自动判为掌握；未观测时保留未知。',
    items: [
      { kcId: 'kc.place.value', status: 'taught', note: '推断较稳，仍保留不确定性', confidence: 0.8 },
      { kcId: 'kc.fraction.equiv', status: 'in_progress', note: '部分掌握，等值变换偶有遗漏', confidence: 0.72 },
      { kcId: 'kc.fraction.add', status: 'in_progress', note: '异分母加法存在误区证据', confidence: 0.58 },
      { kcId: 'kc.fraction.compare', status: 'in_progress', note: '证据较少', confidence: 0.64 },
      { kcId: 'kc.fraction.multiply', status: 'not_taught', note: '尚无观测', confidence: 0 },
    ],
  },
  {
    axis: 'AIAugmentationProgress',
    label: 'AI 强化进度（平台内）',
    description: '预习/强化/复习/迁移练习的记录；不反向伪造学校进度。',
    items: [
      { kcId: 'kc.fraction.equiv', status: 'in_progress', note: '已完成 1 次预习 + 2 次强化', confidence: 0.8 },
      { kcId: 'kc.fraction.add', status: 'in_progress', note: '已完成 3 次强化，错题待复习', confidence: 0.85 },
      { kcId: 'kc.fraction.compare', status: 'in_progress', note: '1 次复习完成', confidence: 0.7 },
    ],
  },
]

/** 三条轴的进度来源、确认时间与置信度（规范 §4.1 要求分别保存）。 */
export interface ProgressAxisMeta {
  axis: ProgressAxis['axis']
  progressSource: string
  confirmedAt: string | null
  confidence: number
  note: string
}

export const progressAxisMeta: ProgressAxisMeta[] = [
  {
    axis: 'SchoolProgress',
    progressSource: 'student_confirmation + teacher_update',
    confirmedAt: '2026-03-05T09:00:00+08:00',
    confidence: 0.95,
    note: '仅表示接触过内容，不代表已掌握。',
  },
  {
    axis: 'CognitiveProgress',
    progressSource: 'observed_events_only',
    confirmedAt: null,
    confidence: 0.72,
    note: '无观测时保留 unknown，不因课堂讲完自动掌握。',
  },
  {
    axis: 'AIAugmentationProgress',
    progressSource: 'platform_events',
    confirmedAt: '2026-03-07T20:00:00+08:00',
    confidence: 0.85,
    note: '不反向伪造学校进度。',
  },
]

/* ------------------------------------------------------------------ */
/* 知识组件目录与先修关系（规范 §3.1）                                  */
/* ------------------------------------------------------------------ */

export interface KcCatalogEntry {
  kcId: string
  label: string
  stage: string
  nodeType: 'KnowledgeComponent' | 'Subskill'
}

export const kcCatalog: KcCatalogEntry[] = [
  { kcId: 'kc.place.value', label: '数位与位值', stage: '初中衔接', nodeType: 'KnowledgeComponent' },
  { kcId: 'kc.fraction.equiv', label: '等值分数与通分', stage: '小学高段', nodeType: 'KnowledgeComponent' },
  { kcId: 'kc.fraction.add', label: '异分母分数加法', stage: '小学高段', nodeType: 'Subskill' },
  { kcId: 'kc.fraction.compare', label: '分数大小比较', stage: '小学高段', nodeType: 'Subskill' },
  { kcId: 'kc.fraction.multiply', label: '分数乘法', stage: '后续单元', nodeType: 'Subskill' },
]

export type EdgeType = 'REQUIRES' | 'SUPPORTS' | 'CAN_FAIL_AS' | 'ASSESSES'

export interface CurriculumEdge {
  source: string
  target: string
  edgeType: EdgeType
  reviewState: 'approved' | 'proposed'
}

export const curriculumEdges: CurriculumEdge[] = [
  { source: 'kc.fraction.add', target: 'kc.fraction.equiv', edgeType: 'REQUIRES', reviewState: 'approved' },
  { source: 'kc.fraction.equiv', target: 'kc.place.value', edgeType: 'REQUIRES', reviewState: 'approved' },
  { source: 'kc.fraction.compare', target: 'kc.fraction.equiv', edgeType: 'REQUIRES', reviewState: 'approved' },
  { source: 'kc.fraction.multiply', target: 'kc.fraction.add', edgeType: 'REQUIRES', reviewState: 'approved' },
  { source: 'kc.fraction.add', target: 'bug.add_denominators', edgeType: 'CAN_FAIL_AS', reviewState: 'approved' },
  { source: 'kc.fraction.equiv', target: 'bug.equiv_missing_factor', edgeType: 'CAN_FAIL_AS', reviewState: 'approved' },
]

export function kcLabel(kcId: string): string {
  return kcCatalog.find((kc) => kc.kcId === kcId)?.label ?? kcId
}

/* ------------------------------------------------------------------ */
/* 长期认知孪生体：多层状态（规范 §5.1 / §5.2）                         */
/* ------------------------------------------------------------------ */

export type ExposureState = 'taught' | 'in_progress' | 'not_taught' | 'unknown'

export interface KnowledgeStateEntry {
  kcId: string
  exposureState: ExposureState
  /** 掌握后验：均值 + 不确定性，绝不压缩为单一“掌握率”。 */
  masteryPosterior: { mean: number; uncertainty: number }
  /** 独立检索概率（示例 horizon）。 */
  retrieveProbability: { atHorizonDays: number; p: number }
  /** 迁移估计：近迁移 / 远迁移。 */
  transferEstimate: { near: number; far: number }
  evidenceCount: number
  evidenceIds: string[]
}

export const knowledgeState: KnowledgeStateEntry[] = [
  {
    kcId: 'kc.place.value',
    exposureState: 'taught',
    masteryPosterior: { mean: 0.82, uncertainty: 0.09 },
    retrieveProbability: { atHorizonDays: 7, p: 0.9 },
    transferEstimate: { near: 0.84, far: 0.51 },
    evidenceCount: 12,
    evidenceIds: ['ev.obs.090', 'ev.obs.104'],
  },
  {
    kcId: 'kc.fraction.equiv',
    exposureState: 'taught',
    masteryPosterior: { mean: 0.71, uncertainty: 0.14 },
    retrieveProbability: { atHorizonDays: 7, p: 0.61 },
    transferEstimate: { near: 0.68, far: 0.35 },
    evidenceCount: 18,
    evidenceIds: ['ev.obs.101', 'ev.obs.108'],
  },
  {
    kcId: 'kc.fraction.add',
    exposureState: 'in_progress',
    masteryPosterior: { mean: 0.58, uncertainty: 0.17 },
    retrieveProbability: { atHorizonDays: 7, p: 0.44 },
    transferEstimate: { near: 0.56, far: 0.22 },
    evidenceCount: 22,
    evidenceIds: ['ev.obs.102', 'ev.obs.110'],
  },
  {
    kcId: 'kc.fraction.compare',
    exposureState: 'taught',
    masteryPosterior: { mean: 0.64, uncertainty: 0.19 },
    retrieveProbability: { atHorizonDays: 7, p: 0.53 },
    transferEstimate: { near: 0.6, far: 0.28 },
    evidenceCount: 9,
    evidenceIds: ['ev.obs.106'],
  },
  {
    kcId: 'kc.fraction.multiply',
    exposureState: 'not_taught',
    masteryPosterior: { mean: 0, uncertainty: 1 },
    retrieveProbability: { atHorizonDays: 7, p: 0 },
    transferEstimate: { near: 0, far: 0 },
    evidenceCount: 0,
    evidenceIds: [],
  },
]

/** 可观察策略使用，而非心理人格标签（规范 §5.3 / §6.1）。 */
export interface StrategyState {
  strategyId: string
  label: string
  observedFrequency: number
  supportLevel: 'tentative' | 'moderate' | 'strong'
  evidenceIds: string[]
}

export const strategyState: StrategyState[] = [
  {
    strategyId: 'strategy.find_common_denominator',
    label: '先求公分母再相加',
    observedFrequency: 0.52,
    supportLevel: 'moderate',
    evidenceIds: ['ev.obs.101', 'ev.obs.108'],
  },
  {
    strategyId: 'strategy.cross_multiply_check',
    label: '用交叉相乘校验等值',
    observedFrequency: 0.3,
    supportLevel: 'tentative',
    evidenceIds: ['ev.obs.106'],
  },
  {
    strategyId: 'strategy.add_numerators_denominators',
    label: '分子分母分别相加',
    observedFrequency: 0.41,
    supportLevel: 'tentative',
    evidenceIds: ['ev.obs.102'],
  },
]

export interface MisconceptionBelief {
  ruleId: string
  label: string
  description: string
  /** 后验权重：表示“存在该误区证据”的强度，不是读心结论。 */
  posteriorWeight: number
  evidenceIds: string[]
}

export const misconceptionBeliefs: MisconceptionBelief[] = [
  {
    ruleId: 'bug.add_denominators',
    label: '异分母直接相加',
    description: '把分子与分母分别相加（如 1/4 + 1/6 → 2/10），缺少先通分。',
    posteriorWeight: 0.47,
    evidenceIds: ['ev.obs.102'],
  },
  {
    ruleId: 'bug.equiv_missing_factor',
    label: '等值变换遗漏同乘因子',
    description: '分子或分母只改一侧，未保持等值。',
    posteriorWeight: 0.31,
    evidenceIds: ['ev.obs.101'],
  },
  {
    ruleId: 'bug.place_value_shift',
    label: '数位对齐混淆',
    description: '位值错误导致后续计算整体偏移；当前证据较弱。',
    posteriorWeight: 0.12,
    evidenceIds: ['ev.obs.104'],
  },
]

/* ------------------------------------------------------------------ */
/* 动态短期虚拟学生（认知假设，规范 §6.1）                              */
/* ------------------------------------------------------------------ */

export type HypothesisStatus = 'active' | 'archived' | 'unknown'

export interface Hypothesis {
  hypothesisId: string
  label: string
  parentTwinVersion: number
  subjectScope: string[]
  knowledgeAssumptions: { kcId: string; assumption: string }[]
  strategyPolicy: string[]
  bugRules: string[]
  predictedObservableBehaviors: string[]
  responseToIntervention: string[]
  posteriorWeight: number
  uncertainty: 'low' | 'medium' | 'high'
  evidenceRefs: string[]
  status: HypothesisStatus
}

export const hypotheses: Hypothesis[] = [
  {
    hypothesisId: 'hyp.frac.equiv_gap',
    label: 'H1 · “通分需保持等值”的概念缺口',
    parentTwinVersion: 54,
    subjectScope: ['kc.fraction.equiv', 'kc.fraction.add'],
    knowledgeAssumptions: [
      { kcId: 'kc.fraction.equiv', assumption: '部分掌握：会把分母改成 12，但分子未同乘' },
      { kcId: 'kc.fraction.add', assumption: '薄弱：依赖模仿步骤' },
    ],
    strategyPolicy: ['尝试先找公分母', '很少回头校验等式是否等值'],
    bugRules: ['bug.equiv_missing_factor'],
    predictedObservableBehaviors: [
      '3/4 = ?/12 时只把分母改 12，填 3/12',
      '异分母加法写成分子分母分别相加',
    ],
    responseToIntervention: ['用等式两边同乘的图示讲解，预期有效'],
    posteriorWeight: 0.44,
    uncertainty: 'medium',
    evidenceRefs: ['ev.obs.101', 'ev.obs.102'],
    status: 'active',
  },
  {
    hypothesisId: 'hyp.frac.add_denominators',
    label: 'H2 · 分母直接相加的操作规则',
    parentTwinVersion: 54,
    subjectScope: ['kc.fraction.add'],
    knowledgeAssumptions: [
      { kcId: 'kc.fraction.add', assumption: '存在稳定错误规则：分子分母分别相加' },
    ],
    strategyPolicy: ['看到分数加法就分别相加', '不使用通分'],
    bugRules: ['bug.add_denominators'],
    predictedObservableBehaviors: ['1/4 + 1/6 = 2/10', '2/3 + 1/6 = 3/9'],
    responseToIntervention: ['分数条/面积模型对比，预期中等有效'],
    posteriorWeight: 0.31,
    uncertainty: 'medium',
    evidenceRefs: ['ev.obs.102'],
    status: 'active',
  },
  {
    hypothesisId: 'hyp.frac.slip',
    label: 'H3 · 本次仅为偶发计算疏漏',
    parentTwinVersion: 54,
    subjectScope: ['kc.fraction.add'],
    knowledgeAssumptions: [
      { kcId: 'kc.fraction.add', assumption: '基本掌握，本次为偶发失误' },
    ],
    strategyPolicy: ['平时会通分', '紧张或赶时间时跳步'],
    bugRules: [],
    predictedObservableBehaviors: ['重做同型题大概率正确', '提示后能自行修正'],
    responseToIntervention: ['轻量检查习惯提示即可'],
    posteriorWeight: 0.14,
    uncertainty: 'high',
    evidenceRefs: ['ev.obs.110'],
    status: 'active',
  },
  {
    hypothesisId: 'hyp.frac.place_confusion',
    label: 'H4 · 位值/数位混淆（已归档）',
    parentTwinVersion: 53,
    subjectScope: ['kc.place.value', 'kc.fraction.add'],
    knowledgeAssumptions: [
      { kcId: 'kc.place.value', assumption: '薄弱' },
    ],
    strategyPolicy: ['按位数而不是数值比较'],
    bugRules: ['bug.place_value_shift'],
    predictedObservableBehaviors: ['把 1/4 与 1/6 按分母位数比较'],
    responseToIntervention: ['位值复习'],
    posteriorWeight: 0.06,
    uncertainty: 'high',
    evidenceRefs: ['ev.obs.104'],
    status: 'archived',
  },
]

/** 未被任何候选解释的剩余概率；不强制选择（规范 §6.2 Unknown）。 */
export const unknownHypothesisWeight = 0.05

/* ------------------------------------------------------------------ */
/* 主动诊断追溯链（规范 §7.1 Observe→…→Update）                         */
/* ------------------------------------------------------------------ */

export type TraceStage =
  | 'observe'
  | 'localize'
  | 'expand'
  | 'simulate'
  | 'choose_probe'
  | 'update'

export interface DiagnosticTraceStep {
  stage: TraceStage
  title: string
  detail: string
  evidenceIds: string[]
  payload?: string
}

export const diagnosticTrace: DiagnosticTraceStep[] = [
  {
    stage: 'observe',
    title: 'Observe · 获取作答',
    detail:
      '学生提交合成题 item.fraction.add.002「1/4 + 1/6」，答案为 2/10，hint_level=0，首次尝试。',
    evidenceIds: ['ev.obs.102'],
    payload: 'item.fraction.add.002 → "2/10"',
  },
  {
    stage: 'localize',
    title: 'Localize · 定位首次偏离',
    detail:
      '步骤图 step_2 首次偏离规则：分子 1+1=2、分母 4+6=10 同时完成，缺少“先通分为 3/12 与 2/12”的等价变换步骤。',
    evidenceIds: ['ev.obs.102', 'ev.step.102b'],
    payload: 'step_1 读题 → step_2 ✗ 直接相加 → step_3 得 2/10',
  },
  {
    stage: 'expand',
    title: 'Expand · 生成上游解释',
    detail:
      '结合 CAN_FAIL_AS 错误规则图，生成三个可检验解释：H1 等值概念缺口、H2 分母直接相加规则、H3 偶发疏漏；不把任一解释当作事实。',
    evidenceIds: ['ev.obs.102', 'ev.obs.101'],
  },
  {
    stage: 'simulate',
    title: 'Simulate · 假设的区分性预测',
    detail:
      '在诊断题 item.fraction.equiv.probe.001「3/4 = ?/12」上，H1 预测填 3/12、H2 预测 9/12 但解释错误、H3 预测正确；H2 与 H1 的预测差异最大。',
    evidenceIds: ['ev.sim.201'],
    payload: 'H1 P(错|probe)=0.78 · H2 P(错|probe)=0.35 · H3 P(错|probe)=0.12',
  },
  {
    stage: 'choose_probe',
    title: 'ChooseProbe · 选择诊断题',
    detail:
      '选择 item.fraction.equiv.probe.001：预计信息增益 0.31、预计用时 1 分钟，且 kc.fraction.equiv 属于已教内容，课程门禁允许（mode=learn）。',
    evidenceIds: ['ev.policy.301'],
    payload: 'IG≈0.31 · allowed_kcs={kc.fraction.equiv, kc.fraction.add, kc.place.value}',
  },
  {
    stage: 'update',
    title: 'Update · 后验更新',
    detail:
      '学生答对探测题但无法说明为何是 9/12。H1 后验 0.44→0.52，H2 0.31→0.22，H3 0.14→0.14。系统记录“证据支持 H1”，不宣称读出了学生的内心想法。',
    evidenceIds: ['ev.obs.111'],
    payload: 'H1 0.52 · H2 0.22 · H3 0.14 · unknown 0.12',
  },
]

export interface PosteriorShift {
  hypothesisId: string
  label: string
  before: number
  after: number
}

export const posteriorShifts: PosteriorShift[] = [
  { hypothesisId: 'hyp.frac.equiv_gap', label: 'H1 等值概念缺口', before: 0.44, after: 0.52 },
  { hypothesisId: 'hyp.frac.add_denominators', label: 'H2 分母直接相加', before: 0.31, after: 0.22 },
  { hypothesisId: 'hyp.frac.slip', label: 'H3 偶发疏漏', before: 0.14, after: 0.14 },
  { hypothesisId: 'unknown', label: '未被解释的剩余概率', before: 0.11, after: 0.12 },
]

/* ------------------------------------------------------------------ */
/* 学生答题视图：3 道分数合成题（合成 fixture）                         */
/* ------------------------------------------------------------------ */

export interface StudentItem {
  itemId: string
  prompt: string
  requiredKcs: string[]
  forbiddenFutureKcs: string[]
  /** 期望值（约分前/指定分母形式见 requireDenominator）。 */
  expected: { n: number; d: number }
  /** 若给出，则作答的分母必须等于该值（等值分数题）。 */
  requireDenominator?: number
  difficulty: number
  estimatedMinutes: number
  hints: string[]
  answerExplanation: string
  source: string
  license: string
  approvalStatus: 'approved' | 'pending'
}

export const studentItems: StudentItem[] = [
  {
    itemId: 'item.fraction.add.001',
    prompt: '计算：1/4 + 1/6 = ？',
    requiredKcs: ['kc.fraction.add', 'kc.fraction.equiv'],
    forbiddenFutureKcs: ['kc.fraction.multiply'],
    expected: { n: 5, d: 12 },
    difficulty: 2,
    estimatedMinutes: 1,
    hints: [
      '先找 4 和 6 的公分母：它们的最小公倍数是 12。',
      '把 1/4 写成 3/12，把 1/6 写成 2/12，再相加。',
    ],
    answerExplanation: '1/4 = 3/12，1/6 = 2/12，3/12 + 2/12 = 5/12。',
    source: 'synthetic_fixture',
    license: 'CC0-1.0 (synthetic)',
    approvalStatus: 'approved',
  },
  {
    itemId: 'item.fraction.equiv.001',
    prompt: '把 3/4 化为分母是 12 的等值分数（写出完整分数）：3/4 = ?/12',
    requiredKcs: ['kc.fraction.equiv'],
    forbiddenFutureKcs: ['kc.fraction.multiply'],
    expected: { n: 3, d: 4 },
    requireDenominator: 12,
    difficulty: 1,
    estimatedMinutes: 1,
    hints: [
      '分母 4 变成 12，是乘了 3。',
      '分子也必须乘同一个数，才能保持等值。',
    ],
    answerExplanation: '4 × 3 = 12，所以分子 3 × 3 = 9，得到 9/12。',
    source: 'synthetic_fixture',
    license: 'CC0-1.0 (synthetic)',
    approvalStatus: 'approved',
  },
  {
    itemId: 'item.fraction.add.003',
    prompt: '计算：2/3 + 1/6 = ？',
    requiredKcs: ['kc.fraction.add', 'kc.fraction.equiv'],
    forbiddenFutureKcs: ['kc.fraction.multiply'],
    expected: { n: 5, d: 6 },
    difficulty: 2,
    estimatedMinutes: 1,
    hints: [
      '公分母取 3 和 6 的最小公倍数 6。',
      '把 2/3 写成 4/6，再加 1/6。',
    ],
    answerExplanation: '2/3 = 4/6，4/6 + 1/6 = 5/6。',
    source: 'synthetic_fixture',
    license: 'CC0-1.0 (synthetic)',
    approvalStatus: 'approved',
  },
]

/* ------------------------------------------------------------------ */
/* 记忆/留存（规范 §8.3，FSRS-4.5 风格示意式）                          */
/* ------------------------------------------------------------------ */

export interface RetentionUnit {
  kcId: string
  memoryUnitId: string
  modelFamily: 'fsrs_compatible'
  modelVersion: 'synthetic_fsrs_v1'
  stabilityDays: number
  difficultyState: number
  elapsedDays: number
  lastIndependentSuccessAt: string
  observedRetrievalQuality: 'good' | 'fair' | 'poor'
  expectedRetrievability: number
  parameterPosterior: 'cohort_regularized'
  observationCount: number
  uncertainty: 'low' | 'medium' | 'high'
  nextReviewAt: string
}

/**
 * 示意式：R(t, S) = (1 + (19/81)·(t/S))^(-1/2)。
 * 当 t = S 时 R ≈ 0.9。此处数值仅用于演示，不是个体拟合结果。
 */
export function retrievability(elapsedDays: number, stabilityDays: number): number {
  if (stabilityDays <= 0) return 0
  return Math.pow(1 + (19 / 81) * (elapsedDays / stabilityDays), -0.5)
}

export const retentionUnits: RetentionUnit[] = [
  {
    kcId: 'kc.fraction.equiv',
    memoryUnitId: 'fraction_equiv_reduce',
    modelFamily: 'fsrs_compatible',
    modelVersion: 'synthetic_fsrs_v1',
    stabilityDays: 8.2,
    difficultyState: 6.4,
    elapsedDays: 4,
    lastIndependentSuccessAt: '2026-03-06T10:00:00+08:00',
    observedRetrievalQuality: 'good',
    expectedRetrievability: 0.9473,
    parameterPosterior: 'cohort_regularized',
    observationCount: 7,
    uncertainty: 'medium',
    nextReviewAt: '2026-03-15T18:00:00+08:00',
  },
  {
    kcId: 'kc.fraction.add',
    memoryUnitId: 'fraction_add_unlike',
    modelFamily: 'fsrs_compatible',
    modelVersion: 'synthetic_fsrs_v1',
    stabilityDays: 5.5,
    difficultyState: 7.1,
    elapsedDays: 6,
    lastIndependentSuccessAt: '2026-03-04T19:30:00+08:00',
    observedRetrievalQuality: 'fair',
    expectedRetrievability: 0.8923,
    parameterPosterior: 'cohort_regularized',
    observationCount: 9,
    uncertainty: 'high',
    nextReviewAt: '2026-03-11T18:00:00+08:00',
  },
  {
    kcId: 'kc.fraction.compare',
    memoryUnitId: 'fraction_compare',
    modelFamily: 'fsrs_compatible',
    modelVersion: 'synthetic_fsrs_v1',
    stabilityDays: 11.5,
    difficultyState: 5.2,
    elapsedDays: 9,
    lastIndependentSuccessAt: '2026-03-01T16:00:00+08:00',
    observedRetrievalQuality: 'good',
    expectedRetrievability: 0.9192,
    parameterPosterior: 'cohort_regularized',
    observationCount: 4,
    uncertainty: 'high',
    nextReviewAt: '2026-03-18T18:00:00+08:00',
  },
  {
    kcId: 'kc.place.value',
    memoryUnitId: 'place_value_read',
    modelFamily: 'fsrs_compatible',
    modelVersion: 'synthetic_fsrs_v1',
    stabilityDays: 21,
    difficultyState: 3.8,
    elapsedDays: 7,
    lastIndependentSuccessAt: '2026-03-03T09:00:00+08:00',
    observedRetrievalQuality: 'good',
    expectedRetrievability: 0.963,
    parameterPosterior: 'cohort_regularized',
    observationCount: 12,
    uncertainty: 'low',
    nextReviewAt: '2026-03-24T18:00:00+08:00',
  },
]

/* ------------------------------------------------------------------ */
/* 诊断覆盖与假设集合保真度（规范 §19.3，合成值）                       */
/* ------------------------------------------------------------------ */

export interface DiagnosticFidelity {
  observationCount: number
  covered: number
  coverage: number
  brierScore: number | null
  logLoss: number | null
  calibrationError: number | null
  accuracy: number | null
  unknownShare: number
  effectiveHypotheses: number
  maxWeight: number
  errorTypeAgreement: number | null
  stepAgreement: number | null
  strategyAgreement: number | null
  sufficient: boolean
  note: string
}

export const diagnosticFidelity: DiagnosticFidelity = {
  observationCount: 24,
  covered: 21,
  coverage: 0.875,
  brierScore: 0.18,
  logLoss: 0.54,
  calibrationError: 0.07,
  accuracy: 0.79,
  unknownShare: 0.11,
  effectiveHypotheses: 2.6,
  maxWeight: 0.44,
  errorTypeAgreement: 0.72,
  stepAgreement: 0.68,
  strategyAgreement: 0.64,
  sufficient: true,
  note: '合成假设集合的保真度指标；用于演示字段，不是真实模型校准结果。',
}

/* ------------------------------------------------------------------ */
/* 冻结评测：模拟收益与真实迁移分离（规范 §19 / docs 模板）             */
/* ------------------------------------------------------------------ */

export interface SimulatedBenefit {
  split: string
  itemCount: number
  meanPredictedCorrect: number
  referenceAccuracy: number
  simulatedGain: number
  isCausalEvidence: false
  interpretation: string
}

export interface RealTransferResult {
  itemCount: number
  independentCorrect: number
  transferAccuracy: number
  referenceAccuracy: number
  observedDelta: number
  sources: string[]
  allItemsUnseen: boolean
  causalClaimSupported: false
  interpretation: string
}

export interface EvaluationSummary {
  datasetId: string
  datasetVersion: string
  datasetDigest: string
  frozenAt: string
  generatedAt: string
  syntheticFixturesOnly: boolean
  splitCounts: { train: number; explanation: number; transfer: number }
  simulatedBenefit: SimulatedBenefit
  /** null 表示“未提供真实迁移观测”，不得用模拟数据替代。 */
  realTransfer: RealTransferResult | null
  selfProofGuard: string[]
  limitations: string[]
  claim: string
  splitIsolationCheck: string
}

export const evaluationSummary: EvaluationSummary = {
  datasetId: 'aeh.synthetic.fractions.v1',
  datasetVersion: '2026.03.01',
  datasetDigest: 'f5dea9abbae605abfa88f6c94541e5fb732e1e996f8c7179fd7e383b85646975',
  frozenAt: '2026-03-01T00:00:00+00:00',
  generatedAt: '2026-03-10T00:00:00+00:00',
  syntheticFixturesOnly: true,
  splitCounts: { train: 6, explanation: 2, transfer: 3 },
  simulatedBenefit: {
    split: 'train+explanation',
    itemCount: 8,
    meanPredictedCorrect: 0.7013,
    referenceAccuracy: 0.5,
    simulatedGain: 0.2013,
    isCausalEvidence: false,
    interpretation: '仅用于候选策略离线筛选；不是真实学习效果。',
  },
  realTransfer: null,
  selfProofGuard: [
    '模拟结果只作为 L3 模拟收益，绝不转换为真实迁移结论。',
    '真实迁移只接受可信来源（student/teacher/trusted_grader/assessment）的独立未见作答。',
    '本次未提供真实观测，因此不主张任何真实学习效果。',
  ],
  limitations: [
    '仅合成 fixture，样本量小，未随机化，无对照组。',
    '参考基线是预注册常数，不是实测对照条件。',
    '模拟预测可能过于乐观，且依赖虚拟学生保真度。',
    '未覆盖长期延迟保持、跨知识迁移与不良效果（过度提示、挫败感）的完整测量。',
  ],
  claim: 'no real transfer evidence: simulated results cannot be reported as a real learning effect',
  splitIsolationCheck:
    'rejected simulated transfer outcome: simulated outcomes must not touch the transfer split; transfer is reserved for real observed evaluation',
}

/* ------------------------------------------------------------------ */
/* 聚合报告：教师 / 家长（规范 §13.3；不含原始数据、不含事件 ID）       */
/* ------------------------------------------------------------------ */

export type AttentionReason = 'low_independent_accuracy' | 'reviews_not_completed'

export interface AggregateMetrics {
  attempts: number
  independentCorrect: number
  hintedCorrect: number
  hintsRequested: number
  reviewsDue: number
  reviewsCompleted: number
  minutes: number
}

export interface TopicSummary {
  kcId: string
  metrics: AggregateMetrics
  attentionReasons: AttentionReason[]
}

export interface DataMinimization {
  authorizedAggregateEventsOnly: true
  rawStudentDataIncluded: false
  eventIdsIncluded: false
  sourceEventsUsed: number
  sourceEventsExcluded: number
  authorizedScopes: string[]
}

export interface LearningReport {
  reportType: string
  audience: 'teacher' | 'guardian'
  audienceLabel: string
  studentRef: string
  windowStart: string
  windowEnd: string
  windowBoundary: 'start_inclusive_end_exclusive'
  generatedAt: string
  dataMinimization: DataMinimization
  totals: AggregateMetrics
  topics: TopicSummary[]
  attentionTopics: string[]
  note: string
}

export function sumMetrics(items: AggregateMetrics[]): AggregateMetrics {
  return items.reduce<AggregateMetrics>(
    (acc, m) => ({
      attempts: acc.attempts + m.attempts,
      independentCorrect: acc.independentCorrect + m.independentCorrect,
      hintedCorrect: acc.hintedCorrect + m.hintedCorrect,
      hintsRequested: acc.hintsRequested + m.hintsRequested,
      reviewsDue: acc.reviewsDue + m.reviewsDue,
      reviewsCompleted: acc.reviewsCompleted + m.reviewsCompleted,
      minutes: acc.minutes + m.minutes,
    }),
    {
      attempts: 0,
      independentCorrect: 0,
      hintedCorrect: 0,
      hintsRequested: 0,
      reviewsDue: 0,
      reviewsCompleted: 0,
      minutes: 0,
    },
  )
}

const teacherTopics: TopicSummary[] = [
  {
    kcId: 'kc.fraction.equiv',
    metrics: {
      attempts: 18,
      independentCorrect: 13,
      hintedCorrect: 3,
      hintsRequested: 6,
      reviewsDue: 8,
      reviewsCompleted: 7,
      minutes: 42.5,
    },
    attentionReasons: [],
  },
  {
    kcId: 'kc.fraction.add',
    metrics: {
      attempts: 22,
      independentCorrect: 12,
      hintedCorrect: 5,
      hintsRequested: 11,
      reviewsDue: 10,
      reviewsCompleted: 6,
      minutes: 58,
    },
    attentionReasons: ['low_independent_accuracy', 'reviews_not_completed'],
  },
  {
    kcId: 'kc.fraction.compare',
    metrics: {
      attempts: 9,
      independentCorrect: 6,
      hintedCorrect: 2,
      hintsRequested: 3,
      reviewsDue: 4,
      reviewsCompleted: 4,
      minutes: 21,
    },
    attentionReasons: [],
  },
  {
    kcId: 'kc.place.value',
    metrics: {
      attempts: 12,
      independentCorrect: 10,
      hintedCorrect: 1,
      hintsRequested: 2,
      reviewsDue: 3,
      reviewsCompleted: 3,
      minutes: 15.5,
    },
    attentionReasons: [],
  },
]

/** 家长视图授权范围更窄：只包含已授权共享的两个知识点聚合。 */
const guardianTopics: TopicSummary[] = teacherTopics.filter((topic) =>
  ['kc.fraction.add', 'kc.fraction.equiv'].includes(topic.kcId),
)

export const reports: Record<'teacher' | 'guardian', LearningReport> = {
  teacher: {
    reportType: 'teacher_learning_report',
    audience: 'teacher',
    audienceLabel: '教师',
    studentRef: DEMO_META.pseudonymousStudentRef,
    windowStart: '2026-03-01T00:00:00+08:00',
    windowEnd: '2026-03-08T00:00:00+08:00',
    windowBoundary: 'start_inclusive_end_exclusive',
    generatedAt: '2026-03-08T09:00:00+08:00',
    dataMinimization: {
      authorizedAggregateEventsOnly: true,
      rawStudentDataIncluded: false,
      eventIdsIncluded: false,
      sourceEventsUsed: 61,
      sourceEventsExcluded: 3,
      authorizedScopes: ['educational_report', 'teacher_report'],
    },
    totals: sumMetrics(teacherTopics.map((topic) => topic.metrics)),
    topics: teacherTopics,
    attentionTopics: ['kc.fraction.add'],
    note: '以上是聚合统计与不确定性提示，不是学生能力标签，也不替代教师判断。',
  },
  guardian: {
    reportType: 'guardian_learning_report',
    audience: 'guardian',
    audienceLabel: '家长/监护人',
    studentRef: DEMO_META.pseudonymousStudentRef,
    windowStart: '2026-03-01T00:00:00+08:00',
    windowEnd: '2026-03-08T00:00:00+08:00',
    windowBoundary: 'start_inclusive_end_exclusive',
    generatedAt: '2026-03-08T09:00:00+08:00',
    dataMinimization: {
      authorizedAggregateEventsOnly: true,
      rawStudentDataIncluded: false,
      eventIdsIncluded: false,
      sourceEventsUsed: 40,
      sourceEventsExcluded: 24,
      authorizedScopes: ['educational_report', 'guardian_report'],
    },
    totals: sumMetrics(guardianTopics.map((topic) => topic.metrics)),
    topics: guardianTopics,
    attentionTopics: ['kc.fraction.add'],
    note: '家长视图按授权范围只显示部分聚合知识点；同样不含原始作答、图片或事件 ID。',
  },
}

/* ------------------------------------------------------------------ */
/* 指标仪表盘：汇总口径（全部合成）                                     */
/* ------------------------------------------------------------------ */

export const metricsOverview = {
  /** 已教知识点在 7 天 horizon 的平均期望检索概率（由 retentionUnits 计算）。 */
  horizonDays: 7,
  retentionTarget: 0.9,
  diagnosticCoverageTarget: 0.8,
  realEvidenceStatus: 'absent' as const,
  realEvidenceNote: '未提供真实迁移观测；模拟收益不得替代真实学习效果。',
  simulatorVersion: 'sim_v3',
  frozenSetId: 'aeh.synthetic.fractions.v1',
} as const

/* ------------------------------------------------------------------ */
/* 首页角色入口                                                         */
/* ------------------------------------------------------------------ */

export interface RoleEntrance {
  id: 'student' | 'teacher' | 'insight'
  title: string
  tagline: string
  points: string[]
  to: string
  secondaryTo?: string
  secondaryLabel?: string
  tint: string
}

export const roleEntrances: RoleEntrance[] = [
  {
    id: 'student',
    title: '学生',
    tagline: '做 3 道分数合成题，答完即时看到系统“观测到”的对错。',
    points: ['异分母加法与等值分数', '可请求提示（会记录 hint_level）', '只记录可观察作答，不读心'],
    to: '/student',
    tint: 'lavender',
  },
  {
    id: 'teacher',
    title: '教师',
    tagline: '查看合成学生的知识状态、认知假设与诊断追溯链。',
    points: ['多层知识状态（非单一掌握率）', '假设列表与后验权重', 'Observe→Update 证据链'],
    to: '/teacher',
    tint: 'sky',
  },
  {
    id: 'insight',
    title: '报告 / 指标',
    tagline: '教师/家长聚合报告，以及留存、诊断覆盖与模拟/真实分离说明。',
    points: ['仅聚合事件，无原始学生数据', '留存与诊断覆盖（合成）', '模拟收益与真实迁移严格分节'],
    to: '/report',
    secondaryTo: '/metrics',
    secondaryLabel: '打开指标仪表盘',
    tint: 'peach',
  },
]

/* ================================================================== */
/* 第二阶段：v1.1 规范自查补齐                                          */
/* ------------------------------------------------------------------ */
/* 覆盖：§3.3 结构化题目标签、§4.3 课程门禁、§4.4 课堂外生事件、        */
/* §5 孪生生命周期与四维认知、§5.3 可观察步骤图、§6.2 假设生命周期、     */
/* §7.2 主动诊断目标、§8.4/8.6/8.7 复习事件质量与调度、§8.8 虚拟学生机制、*/
/* §9 习题演化、§10 教学策略、§11 模拟实验室、§12 状态机与 Agent 角色、 */
/* §13.3 权限域、§17 跨学科、§18 学习科学、§20 指标、§20.3 审计记录、   */
/* §21 隐私最小化。                                                     */
/* 再次声明：以下全部为合成 fixture，只用于演示结构，不是真实模型输出、  */
/* 不是真实学生数据，也不代表任何真实学习效果。                         */
/* ================================================================== */

/* ---------- §3.3 题库结构化标签 ---------- */

export interface ItemStructuredTags {
  itemId: string
  stage: string
  course: string
  curriculumNodeIds: string[]
  qMatrix: { kcId: string; weight: number; required: boolean }[]
  strategyIds: string[]
  misconceptionTargets: string[]
  solutionSteps: { stepId: string; text: string; operation: string; validity: 'valid' | 'invalid' }[]
  verifierType: string
  answerSpec: string
  hintLeakageLevel: 'none' | 'conceptual' | 'step' | 'answer'
  nearTransferIds: string[]
  farTransferIds: string[]
  exposureCount: number
  approvalStatus: 'approved' | 'pending'
}

export const itemStructuredTags: Record<string, ItemStructuredTags> = {
  'item.fraction.add.001': {
    itemId: 'item.fraction.add.001',
    stage: '小学高段',
    course: '分数运算',
    curriculumNodeIds: ['unit.fraction.add', 'lesson.unlike_denominators'],
    qMatrix: [
      { kcId: 'kc.fraction.add', weight: 0.7, required: true },
      { kcId: 'kc.fraction.equiv', weight: 0.3, required: true },
    ],
    strategyIds: ['strategy.find_common_denominator'],
    misconceptionTargets: ['bug.add_denominators'],
    solutionSteps: [
      { stepId: 's1', text: '4 与 6 的最小公分母是 12', operation: '求最小公分母', validity: 'valid' },
      { stepId: 's2', text: '1/4 = 3/12，1/6 = 2/12', operation: '等值变换（分子分母同乘）', validity: 'valid' },
      { stepId: 's3', text: '3/12 + 2/12 = 5/12', operation: '同分母相加', validity: 'valid' },
    ],
    verifierType: 'exact_fraction_equality',
    answerSpec: 'fraction == 5/12',
    hintLeakageLevel: 'step',
    nearTransferIds: ['item.fraction.add.003'],
    farTransferIds: [],
    exposureCount: 4,
    approvalStatus: 'approved',
  },
  'item.fraction.equiv.001': {
    itemId: 'item.fraction.equiv.001',
    stage: '小学高段',
    course: '分数运算',
    curriculumNodeIds: ['unit.fraction.equiv', 'lesson.equivalent_fractions'],
    qMatrix: [
      { kcId: 'kc.fraction.equiv', weight: 0.9, required: true },
      { kcId: 'kc.place.value', weight: 0.1, required: false },
    ],
    strategyIds: ['strategy.cross_multiply_check'],
    misconceptionTargets: ['bug.equiv_missing_factor'],
    solutionSteps: [
      { stepId: 's1', text: '分母 4 → 12，乘了 3', operation: '识别等值因子', validity: 'valid' },
      { stepId: 's2', text: '分子 3 也必须乘 3', operation: '等值变换（同乘）', validity: 'valid' },
      { stepId: 's3', text: '得到 9/12', operation: '写出等值分数', validity: 'valid' },
    ],
    verifierType: 'equivalent_fraction_with_denominator',
    answerSpec: 'denominator == 12 and fraction == 3/4',
    hintLeakageLevel: 'conceptual',
    nearTransferIds: ['item.fraction.add.001'],
    farTransferIds: ['item.fraction.compare.transfer.001'],
    exposureCount: 6,
    approvalStatus: 'approved',
  },
  'item.fraction.add.003': {
    itemId: 'item.fraction.add.003',
    stage: '小学高段',
    course: '分数运算',
    curriculumNodeIds: ['unit.fraction.add', 'lesson.unlike_denominators'],
    qMatrix: [
      { kcId: 'kc.fraction.add', weight: 0.8, required: true },
      { kcId: 'kc.fraction.equiv', weight: 0.2, required: true },
    ],
    strategyIds: ['strategy.find_common_denominator'],
    misconceptionTargets: ['bug.add_denominators'],
    solutionSteps: [
      { stepId: 's1', text: '公分母取 6', operation: '求最小公分母', validity: 'valid' },
      { stepId: 's2', text: '2/3 = 4/6', operation: '等值变换（同乘）', validity: 'valid' },
      { stepId: 's3', text: '4/6 + 1/6 = 5/6', operation: '同分母相加', validity: 'valid' },
    ],
    verifierType: 'exact_fraction_equality',
    answerSpec: 'fraction == 5/6',
    hintLeakageLevel: 'conceptual',
    nearTransferIds: ['item.fraction.add.001'],
    farTransferIds: [],
    exposureCount: 2,
    approvalStatus: 'approved',
  },
}

/* ---------- §4.3 课程门禁算法 ---------- */

export type GateMode = 'preview' | 'learn' | 'review'

export interface AllowedKcSet {
  mode: GateMode
  label: string
  allowedKcs: string[]
  /** 只允许“概念导入/低阶应用”的深度受限知识点。 */
  depthLimitedKcs: string[]
  rationale: string
}

export const allowedKcSets: AllowedKcSet[] = [
  {
    mode: 'preview',
    label: '预习（Preview）',
    allowedKcs: ['kc.place.value', 'kc.fraction.equiv'],
    depthLimitedKcs: ['kc.fraction.add'],
    rationale: '已经学过的知识 + 课程已确认的下一课/近期预习集合；高阶应用深度受限。',
  },
  {
    mode: 'learn',
    label: '课堂同步增强（Learn）',
    allowedKcs: ['kc.place.value', 'kc.fraction.equiv', 'kc.fraction.compare', 'kc.fraction.add'],
    depthLimitedKcs: [],
    rationale: '已教/正在教知识及其允许回溯的先修集合；不得跨越未教的后续章节核心方法。',
  },
  {
    mode: 'review',
    label: '复习（Review）',
    allowedKcs: ['kc.place.value', 'kc.fraction.equiv', 'kc.fraction.compare'],
    depthLimitedKcs: [],
    rationale:
      '已教内容及经确认的先前已学内容；kc.fraction.add 仍为 in_progress，默认不纳入复习集，需先请确认进度。',
  },
]

export interface GateCheck {
  key: string
  label: string
  pass: boolean
  detail: string
}

export interface CurriculumGateResult {
  itemId: string
  itemLabel: string
  mode: GateMode
  requiredKcs: string[]
  allow: boolean
  failClosed: boolean
  action: string
  checks: GateCheck[]
}

export const curriculumGateResults: CurriculumGateResult[] = [
  {
    itemId: 'item.fraction.add.001',
    itemLabel: '1/4 + 1/6',
    mode: 'learn',
    requiredKcs: ['kc.fraction.add', 'kc.fraction.equiv'],
    allow: true,
    failClosed: false,
    action: '允许发放（当前学生答题视图实际采用的模式）。',
    checks: [
      { key: 'safety_ok', label: '安全与合规', pass: true, detail: '无高风险内容；题目来源为合成 fixture。' },
      { key: 'verified_content', label: '内容已验证', pass: true, detail: 'approval_status=approved，验证器 exact_fraction_equality。' },
      { key: 'grade_appropriate', label: '学段适龄', pass: true, detail: '小学高段分数运算，符合当前学段。' },
      { key: 'required_kcs_allowed', label: '所需 KC ⊆ 允许集合', pass: true, detail: 'kc.fraction.add / equiv 均在 Learn 开放集合。' },
      { key: 'no_unapproved_future_method', label: '未使用未批准后续方法', pass: true, detail: 'forbidden_future_kcs=[kc.fraction.multiply] 未被使用。' },
      { key: 'cognitive_load_within_budget', label: '认知负荷在预算内', pass: true, detail: '预计 1 分钟 ≤ 单题预算。' },
    ],
  },
  {
    itemId: 'item.fraction.equiv.001',
    itemLabel: '3/4 = ?/12',
    mode: 'learn',
    requiredKcs: ['kc.fraction.equiv'],
    allow: true,
    failClosed: false,
    action: '允许发放。',
    checks: [
      { key: 'safety_ok', label: '安全与合规', pass: true, detail: '无高风险内容。' },
      { key: 'verified_content', label: '内容已验证', pass: true, detail: 'approval_status=approved。' },
      { key: 'grade_appropriate', label: '学段适龄', pass: true, detail: '已教内容的等值变换。' },
      { key: 'required_kcs_allowed', label: '所需 KC ⊆ 允许集合', pass: true, detail: 'kc.fraction.equiv 在 Learn 开放集合。' },
      { key: 'no_unapproved_future_method', label: '未使用未批准后续方法', pass: true, detail: '未涉及分数乘法。' },
      { key: 'cognitive_load_within_budget', label: '认知负荷在预算内', pass: true, detail: '预计 1 分钟。' },
    ],
  },
  {
    itemId: 'item.fraction.add.003',
    itemLabel: '2/3 + 1/6',
    mode: 'learn',
    requiredKcs: ['kc.fraction.add', 'kc.fraction.equiv'],
    allow: true,
    failClosed: false,
    action: '允许发放（近迁移练习）。',
    checks: [
      { key: 'safety_ok', label: '安全与合规', pass: true, detail: '无高风险内容。' },
      { key: 'verified_content', label: '内容已验证', pass: true, detail: 'approval_status=approved。' },
      { key: 'grade_appropriate', label: '学段适龄', pass: true, detail: '同单元近迁移。' },
      { key: 'required_kcs_allowed', label: '所需 KC ⊆ 允许集合', pass: true, detail: '所需 KC 均在 Learn 开放集合。' },
      { key: 'no_unapproved_future_method', label: '未使用未批准后续方法', pass: true, detail: '未涉及分数乘法。' },
      { key: 'cognitive_load_within_budget', label: '认知负荷在预算内', pass: true, detail: '预计 1 分钟。' },
    ],
  },
  {
    itemId: 'item.fraction.add.001',
    itemLabel: '1/4 + 1/6（若在预习模式下发放）',
    mode: 'preview',
    requiredKcs: ['kc.fraction.add', 'kc.fraction.equiv'],
    allow: false,
    failClosed: true,
    action: 'fail-closed：转为更安全的题（改发等值分数概念题），或请学生/教师确认预习深度。',
    checks: [
      { key: 'safety_ok', label: '安全与合规', pass: true, detail: '无高风险内容。' },
      { key: 'verified_content', label: '内容已验证', pass: true, detail: 'approval_status=approved。' },
      { key: 'grade_appropriate', label: '学段适龄', pass: true, detail: '学段本身适龄。' },
      {
        key: 'required_kcs_allowed',
        label: '所需 KC ⊆ 允许集合',
        pass: false,
        detail: 'kc.fraction.add 在 Preview 中仅允许概念导入（depth-limited），本题涉及异分母加法的完整程序。',
      },
      { key: 'no_unapproved_future_method', label: '未使用未批准后续方法', pass: true, detail: '未涉及分数乘法。' },
      { key: 'cognitive_load_within_budget', label: '认知负荷在预算内', pass: true, detail: '预计 1 分钟。' },
    ],
  },
  {
    itemId: 'item.fraction.multiply.candidate',
    itemLabel: '3/4 × 2/5（候选题）',
    mode: 'learn',
    requiredKcs: ['kc.fraction.multiply'],
    allow: false,
    failClosed: true,
    action: '不发放：禁止自动扩展到未教授内容；仅当学生/教师明确要求拓展模式并完成适龄标记后才可评估。',
    checks: [
      { key: 'safety_ok', label: '安全与合规', pass: true, detail: '无高风险内容。' },
      { key: 'verified_content', label: '内容已验证', pass: true, detail: '合成候选题。' },
      { key: 'grade_appropriate', label: '学段适龄', pass: true, detail: '学段适龄。' },
      {
        key: 'required_kcs_allowed',
        label: '所需 KC ⊆ 允许集合',
        pass: false,
        detail: 'kc.fraction.multiply 在 SchoolProgress 中为 not_taught，且不在任何默认开放集合。',
      },
      {
        key: 'no_unapproved_future_method',
        label: '未使用未批准后续方法',
        pass: false,
        detail: '本题核心方法属于后续单元，默认禁止超前开放。',
      },
      { key: 'cognitive_load_within_budget', label: '认知负荷在预算内', pass: true, detail: '预计 2 分钟。' },
    ],
  },
]

/* ---------- §4.4 课堂作为外生事件 ---------- */

export interface ExogenousEvent {
  eventType: string
  at: string
  source: string
  confirmed: boolean
  detail: string
  effectOnTwin: string
}

export const exogenousEvents: ExogenousEvent[] = [
  {
    eventType: 'SCHOOL_LESSON_REPORTED',
    at: '2026-03-05T09:00:00+08:00',
    source: 'student_confirmation',
    confirmed: true,
    detail: '教师已讲授「异分母分数加法」，但系统没有课堂内观测。',
    effectOnTwin: '标记为接触过内容；不得据此判定已掌握，也不得把 time_gap 解释为“完全没学习”。',
  },
]

/* ---------- §5.1 / §5.4 孪生生命周期与版本化状态 ---------- */

export interface TwinMeta {
  version: number
  lastObservedAt: string
  calibrationProfile: string
  memoryModelFamily: string
  reviewState: { memoryModelVersion: string; pendingReviewEventIds: string[] }
  pedagogicalPreferences: { key: string; weight: number; sampleCount: number }[]
  unresolvedHypotheses: string[]
  eventSourcing: {
    rawEventsImmutable: boolean
    inferredStateRebuildable: boolean
    lastRebuiltAt: string
    evidenceHash: string
  }
}

export const twinMeta: TwinMeta = {
  version: 54,
  lastObservedAt: '2026-03-08T08:52:00+08:00',
  calibrationProfile: 'cohort_shrinkage',
  memoryModelFamily: 'fsrs_compatible',
  reviewState: {
    memoryModelVersion: 'synthetic_fsrs_v1',
    pendingReviewEventIds: ['rv.syn.100', 'rv.syn.104'],
  },
  pedagogicalPreferences: [
    { key: 'examples_helpful', weight: 0.4, sampleCount: 5 },
    { key: 'hint_ladder_helpful', weight: 0.55, sampleCount: 8 },
  ],
  unresolvedHypotheses: ['hyp.frac.equiv_gap', 'hyp.frac.add_denominators'],
  eventSourcing: {
    rawEventsImmutable: true,
    inferredStateRebuildable: true,
    lastRebuiltAt: '2026-03-08T08:52:10+08:00',
    evidenceHash: 'sha256:synthetic-evidence-snapshot-v54',
  },
}

export interface TwinVersionRecord {
  version: number
  at: string
  kind: 'commit' | 'rebuild' | 'rollback'
  trigger: string
  summary: string
  evidenceHash: string
}

export const twinVersionHistory: TwinVersionRecord[] = [
  {
    version: 54,
    at: '2026-03-08T08:52:00+08:00',
    kind: 'commit',
    trigger: 'INDEPENDENT_ATTEMPT',
    summary: '加入 1 次独立的等值分数作答证据；H1 后验小幅上调。',
    evidenceHash: 'sha256:synthetic-evidence-snapshot-v54',
  },
  {
    version: 53,
    at: '2026-03-06T19:10:00+08:00',
    kind: 'commit',
    trigger: 'HINT_REQUESTED',
    summary: '提示后作答只用于提示响应建模，未计为独立检索成功。',
    evidenceHash: 'sha256:synthetic-evidence-snapshot-v53',
  },
  {
    version: 52,
    at: '2026-03-05T20:30:00+08:00',
    kind: 'rollback',
    trigger: 'STUDENT_CORRECTION',
    summary: '学生纠正一次误记的作答归属；原始事件不删除，推断状态回滚重建。',
    evidenceHash: 'sha256:synthetic-evidence-snapshot-v52',
  },
]

/* ---------- §5.2 四维认知（概念/程序/策略迁移/检索） ---------- */

export interface FacetEstimate {
  mean: number
  uncertainty: number
}

export interface KnowledgeFacetEntry {
  kcId: string
  conceptual: FacetEstimate
  procedural: FacetEstimate
  strategy: FacetEstimate
  retrieval: FacetEstimate
  note: string
}

export const knowledgeFacets: KnowledgeFacetEntry[] = [
  {
    kcId: 'kc.fraction.equiv',
    conceptual: { mean: 0.62, uncertainty: 0.2 },
    procedural: { mean: 0.78, uncertainty: 0.13 },
    strategy: { mean: 0.54, uncertainty: 0.22 },
    retrieval: { mean: 0.61, uncertainty: 0.18 },
    note: '会做部分通分运算，但“必须同乘才能保持等值”的概念证据较弱。',
  },
  {
    kcId: 'kc.fraction.add',
    conceptual: { mean: 0.55, uncertainty: 0.21 },
    procedural: { mean: 0.49, uncertainty: 0.19 },
    strategy: { mean: 0.41, uncertainty: 0.24 },
    retrieval: { mean: 0.44, uncertainty: 0.2 },
    note: '异分母加法的程序与策略选择都还在建立中；四者不可合并成一个掌握率。',
  },
  {
    kcId: 'kc.place.value',
    conceptual: { mean: 0.86, uncertainty: 0.1 },
    procedural: { mean: 0.88, uncertainty: 0.08 },
    strategy: { mean: 0.7, uncertainty: 0.16 },
    retrieval: { mean: 0.9, uncertainty: 0.07 },
    note: '先修较稳，检索保持较好。',
  },
]

/* ---------- §5.3 可观察步骤图（非读心） ---------- */

export interface ObservableTraceStep {
  stepId: string
  expression: string
  operationRule: string
  dependsOn: string[]
  validity: 'valid' | 'invalid' | 'unverified'
  confidence: number
}

export interface ObservableTrace {
  attemptId: string
  itemId: string
  sourceType: 'observed'
  steps: ObservableTraceStep[]
  note: string
}

export const observableTrace: ObservableTrace = {
  attemptId: 'ev.obs.102',
  itemId: 'item.fraction.add.002',
  sourceType: 'observed',
  steps: [
    { stepId: 's1', expression: '1/4 + 1/6', operationRule: '读题', dependsOn: [], validity: 'valid', confidence: 0.99 },
    { stepId: 's2', expression: '2/10', operationRule: '分子分母分别相加', dependsOn: ['s1'], validity: 'invalid', confidence: 0.93 },
    { stepId: 's3', expression: '2/10', operationRule: '写成结果', dependsOn: ['s2'], validity: 'valid', confidence: 0.9 },
  ],
  note: '系统只记录“存在恒等补偿/通分相关误区的可观察证据”，不断言学生心中一定存在该想法。',
}

/* ---------- §6.2 假设生命周期（Spawn/Split/…/Unknown） ---------- */

export type HypothesisAction =
  | 'spawn'
  | 'split'
  | 'reweight'
  | 'merge'
  | 'prune'
  | 'resample'
  | 'unknown'

export interface HypothesisLifecycleEvent {
  at: string
  action: HypothesisAction
  hypothesisId: string
  detail: string
  evidenceRefs: string[]
  resultingStatus: 'active' | 'archived' | 'unknown'
}

export const hypothesisLifecycle: HypothesisLifecycleEvent[] = [
  {
    at: '2026-03-04T19:32:00+08:00',
    action: 'spawn',
    hypothesisId: 'hyp.frac.add_denominators',
    detail: '出现现有假设无法解释的步骤（分子分母分别相加），生成新候选。',
    evidenceRefs: ['ev.obs.102'],
    resultingStatus: 'active',
  },
  {
    at: '2026-03-05T20:05:00+08:00',
    action: 'split',
    hypothesisId: 'hyp.frac.equiv_gap',
    detail: '“通分概念缺口”与“等式补偿缺口”可用新题区分，拆分建模。',
    evidenceRefs: ['ev.obs.101', 'ev.obs.102'],
    resultingStatus: 'active',
  },
  {
    at: '2026-03-06T19:12:00+08:00',
    action: 'reweight',
    hypothesisId: 'hyp.frac.slip',
    detail: '新证据似然较低，偶发疏漏假设权重下调。',
    evidenceRefs: ['ev.obs.110'],
    resultingStatus: 'active',
  },
  {
    at: '2026-03-07T21:40:00+08:00',
    action: 'prune',
    hypothesisId: 'hyp.frac.place_confusion',
    detail: '长期与真实证据不一致且缺乏独特解释力，归档（可恢复）。',
    evidenceRefs: ['ev.obs.104'],
    resultingStatus: 'archived',
  },
  {
    at: '2026-03-08T08:52:00+08:00',
    action: 'unknown',
    hypothesisId: 'unknown',
    detail: '仍保留未被候选解释的剩余概率，不强制选择。',
    evidenceRefs: ['ev.obs.102', 'ev.obs.111'],
    resultingStatus: 'unknown',
  },
]

export const hypothesisBudget = {
  nActive: 3,
  rationale:
    '由不确定性、候选分歧、预计信息增益与成本预算共同决定；清晰已知的任务可 N_active=0，不要求每次都启动多 Agent。',
  expectedInformationGain: 0.31,
  budgetMinutes: 12,
  note: '本演示启动 3 个活跃假设，另有 1 个归档、1 个 unknown 分支。',
}

/* ---------- §6.3 观测匹配（Bayesian / Particle-style） ---------- */

export const beliefUpdate = {
  formula: 'P(H_i | E_1:t, C_1:t) ∝ P(E_t | H_i, C_t) · P(H_i | E_1:t-1, C_1:t-1)',
  requirements: [
    '对漏猜/偶发失误加入噪声项。',
    '避免多个假设共享同一错误源造成后验虚假尖锐。',
    '对概率做校准，不直接采信 LLM 输出的精确似然。',
    '在新题上评估行为预测，而不是复述已有错误。',
  ],
  note: '本演示的权重为结构示例，不是真实贝叶斯后验计算。',
}

/* ---------- §7.2 主动诊断目标与候选探测题 ---------- */

export const diagnosisObjective = {
  formula: 'q* = argmax{ IG(q) + α·TeachingValue(q) − β·Time(q) − γ·Risk(q) }',
  alpha: 0.4,
  beta: 0.15,
  gamma: 0.6,
  note: '需要“少问、问得准、随时可跳过”；教师目标明确时不无限诊断。',
}

export interface ProbeCandidate {
  itemId: string
  label: string
  infoGain: number
  teachingValue: number
  timeMinutes: number
  risk: number
  score: number
  allowed: boolean
  reason: string
}

export const probeCandidates: ProbeCandidate[] = [
  {
    itemId: 'item.fraction.equiv.probe.001',
    label: '展开/比较：3/4 = ?/12',
    infoGain: 0.31,
    teachingValue: 0.25,
    timeMinutes: 1,
    risk: 0.1,
    score: 0.31 + 0.4 * 0.25 - 0.15 * 1 - 0.6 * 0.1,
    allowed: true,
    reason: '区分 H1/H2 的预测差异最大，且属于已教内容。',
  },
  {
    itemId: 'item.fraction.add.probe.001',
    label: '另做一题不同系数的配方（1/3 + 1/4）',
    infoGain: 0.22,
    teachingValue: 0.2,
    timeMinutes: 2,
    risk: 0.15,
    score: 0.22 + 0.4 * 0.2 - 0.15 * 2 - 0.6 * 0.15,
    allowed: true,
    reason: '可检验是否稳定重复同类错步，但耗时更长。',
  },
  {
    itemId: 'item.fraction.multiply.probe.001',
    label: '分数乘法前置探测',
    infoGain: 0.12,
    teachingValue: 0.1,
    timeMinutes: 2,
    risk: 0.8,
    score: 0.12 + 0.4 * 0.1 - 0.15 * 2 - 0.6 * 0.8,
    allowed: false,
    reason: '超出已教范围，课程门禁拦截（fail-closed）。',
  },
]

/* ---------- §8.4 复习事件质量 ---------- */

export interface ReviewEventQuality {
  eventId: string
  memoryUnitId: string
  independent: boolean
  hintLevel: number
  success: boolean
  latencySec: number
  confidenceSelfReported: number | null
  transferLevel: 'original' | 'near' | 'far'
  context: string
  itemDifficulty: number
  requiredKcs: string[]
  strategyIds: string[]
  countsAsIndependentRetrieval: boolean
  note: string
}

export const reviewEventSamples: ReviewEventQuality[] = [
  {
    eventId: 'ev.rev.001',
    memoryUnitId: 'fraction_equiv_reduce',
    independent: true,
    hintLevel: 0,
    success: true,
    latencySec: 38,
    confidenceSelfReported: 0.8,
    transferLevel: 'original',
    context: '隔天',
    itemDifficulty: 1,
    requiredKcs: ['kc.fraction.equiv'],
    strategyIds: ['strategy.cross_multiply_check'],
    countsAsIndependentRetrieval: true,
    note: '独立首次作答正确：对记忆模型更新权重高。',
  },
  {
    eventId: 'ev.rev.002',
    memoryUnitId: 'fraction_add_unlike',
    independent: false,
    hintLevel: 2,
    success: true,
    latencySec: 95,
    confidenceSelfReported: 0.4,
    transferLevel: 'near',
    context: '考前',
    itemDifficulty: 2,
    requiredKcs: ['kc.fraction.add', 'kc.fraction.equiv'],
    strategyIds: ['strategy.find_common_denominator'],
    countsAsIndependentRetrieval: false,
    note: '提示后才改对：用于提示响应/学习转移建模，不等价于一次完全独立检索成功。',
  },
]

/* ---------- §8.6 下一次复习间隔（示意式反解） ---------- */

/**
 * 由目标保持概率反解下一次间隔（对应 §8.6 的示意式推导）：
 *   Δt = (81/19)·S·(r_target^(-2) − 1)
 * 生产实现应由匹配的 FSRS 优化器/调度器求间隔，不应把该式在所有任务上硬套。
 */
export function nextIntervalDays(stabilityDays: number, targetRetention: number): number {
  if (stabilityDays <= 0 || targetRetention <= 0 || targetRetention >= 1) return 0
  return (81 / 19) * stabilityDays * (Math.pow(targetRetention, -2) - 1)
}

export interface ReviewTarget {
  memoryUnitId: string
  targetRetention: number
  examHorizonDays: number | null
  curriculumImportance: number
  note: string
}

export const reviewTargets: ReviewTarget[] = [
  {
    memoryUnitId: 'fraction_equiv_reduce',
    targetRetention: 0.9,
    examHorizonDays: 14,
    curriculumImportance: 0.9,
    note: '关键先修点，要求较高保持概率；考试临近时上调。',
  },
  {
    memoryUnitId: 'fraction_add_unlike',
    targetRetention: 0.85,
    examHorizonDays: 5,
    curriculumImportance: 0.95,
    note: '当前课堂重点且考试临近，复习优先级最高。',
  },
  {
    memoryUnitId: 'fraction_compare',
    targetRetention: 0.9,
    examHorizonDays: null,
    curriculumImportance: 0.4,
    note: '近期使用较少，保持常规目标。',
  },
  {
    memoryUnitId: 'place_value_read',
    targetRetention: 0.95,
    examHorizonDays: 14,
    curriculumImportance: 0.7,
    note: '底层先修，要求高保持概率以获得更高安全边际。',
  },
]

/* ---------- §8.7 复习队列统一调度 ---------- */

export interface ReviewQueueWeights {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  note: string
}

export const reviewQueueWeights: ReviewQueueWeights = {
  a: 0.35,
  b: 0.2,
  c: 0.2,
  d: 0.15,
  e: 0.05,
  f: 0.25,
  note: '权重为政策默认值，需由真实长期学习效果校准，而不是由 LLM 随意给出。',
}

export interface ReviewQueueEntry {
  memoryUnitId: string
  kcId: string
  forgettingRisk: number
  prerequisiteCentrality: number
  upcomingUse: number
  misconceptionRisk: number
  examUrgency: number
  reviewCost: number
  priority: number
  action: string
}

function reviewPriority(e: Omit<ReviewQueueEntry, 'priority' | 'action'>): number {
  const w = reviewQueueWeights
  return (
    w.a * e.forgettingRisk +
    w.b * e.prerequisiteCentrality +
    w.c * e.upcomingUse +
    w.d * e.misconceptionRisk +
    w.e * e.examUrgency -
    w.f * e.reviewCost
  )
}

function buildReviewQueue(): ReviewQueueEntry[] {
  const rows: (Omit<ReviewQueueEntry, 'priority' | 'action'> & { action: string })[] = [
    {
      memoryUnitId: 'fraction_add_unlike',
      kcId: 'kc.fraction.add',
      forgettingRisk: 0.55,
      prerequisiteCentrality: 0.7,
      upcomingUse: 0.9,
      misconceptionRisk: 0.47,
      examUrgency: 0.5,
      reviewCost: 0.45,
      action: '间隔提取题（独立完成，不看提示）',
    },
    {
      memoryUnitId: 'fraction_equiv_reduce',
      kcId: 'kc.fraction.equiv',
      forgettingRisk: 0.35,
      prerequisiteCentrality: 0.9,
      upcomingUse: 0.8,
      misconceptionRisk: 0.31,
      examUrgency: 0.4,
      reviewCost: 0.3,
      action: '近迁移练习 + 自检步骤',
    },
    {
      memoryUnitId: 'place_value_read',
      kcId: 'kc.place.value',
      forgettingRisk: 0.15,
      prerequisiteCentrality: 1,
      upcomingUse: 0.6,
      misconceptionRisk: 0.12,
      examUrgency: 0.3,
      reviewCost: 0.15,
      action: '快速诊断题（先判断是否真的遗忘）',
    },
    {
      memoryUnitId: 'fraction_compare',
      kcId: 'kc.fraction.compare',
      forgettingRisk: 0.25,
      prerequisiteCentrality: 0.4,
      upcomingUse: 0.3,
      misconceptionRisk: 0.12,
      examUrgency: 0.2,
      reviewCost: 0.2,
      action: '交错练习（与其他方法混排）',
    },
  ]
  return rows.map((row) => ({ ...row, priority: reviewPriority(row) }))
}

export const reviewQueue: ReviewQueueEntry[] = buildReviewQueue()

/* ---------- §8.8 虚拟学生与遗忘的三种机制 ---------- */

export const virtualStudentMechanisms = [
  {
    mechanism: '学过但长时间未检索',
    description: '表现似乎退化，但记忆状态支持“可能需要重新提取”。',
    action: '重提取（间隔检索），而不是重讲整课。',
  },
  {
    mechanism: '概念从未牢固建立',
    description: '即使刚复习也会错，概念证据长期偏弱。',
    action: '重建概念：对比反例 + 具体示范 + 自我解释。',
  },
  {
    mechanism: '有概念但缺少跨题型策略迁移',
    description: '同类题会做，综合/换情境题不会主动选方法。',
    action: '策略选择 + 跨题型迁移练习。',
  },
]

/* ---------- §9 习题演化：干预包、题型生成器、教学价值、防刷分 ---------- */

export interface InterventionPackage {
  packageId: string
  objective: {
    targetKc: string
    currentMisconception: string
    desiredBehavior: string
    schoolMode: GateMode
    allowedCurriculumNodes: string[]
    assessment: string
    timeBudgetMinutes: number
  }
  trainingItems: { type: string; label: string; example: string }[]
  hintLadder: string[]
  feedbackTemplates: { forError: string; text: string }[]
  explanationResources: { label: string; source: string; license: string }[]
  independentTransferTest: {
    itemId: string
    description: string
    unseen: boolean
    transferLevel: 'near' | 'far'
  }
  completionCriteria: string[]
  progressProof: { requiredKcs: string[]; allowedKcs: string[]; gate: 'passed' | 'blocked' }
}

export const interventionPackage: InterventionPackage = {
  packageId: 'int.syn.209',
  objective: {
    targetKc: 'kc.fraction.equiv',
    currentMisconception: 'bug.equiv_missing_factor',
    desiredBehavior: '改分母时分子同乘，保持等式等值；并用展开/交叉相乘自检',
    schoolMode: 'learn',
    allowedCurriculumNodes: ['unit.fraction.equiv', 'unit.fraction.add'],
    assessment: 'unseen_near_transfer',
    timeBudgetMinutes: 12,
  },
  trainingItems: [
    { type: '错因对比题', label: '对比两个通分过程', example: '3/4 = 6/8 与 3/4 = 3/8，哪个保持等值？' },
    { type: '最小反例题', label: '用 x=0 类反例打破错误规则', example: '把 2/5 的分子分母分别加 1，等式还成立吗？' },
    { type: 'Worked Example', label: '分步示范并解释原因', example: '分母 4→12 乘 3，所以分子 3×3=9。' },
    { type: 'Faded Example', label: '逐步撤去支架', example: '给出 5/6 = ?/18 的第一步，学生补全。' },
  ],
  hintLadder: [
    '激活已有知识：分母 4 变成 12 是乘了几？',
    '指向问题：分子为什么也必须乘同一个数？',
    '局部示范：示范第一步“分母乘 3”，让学生完成分子。',
    '完整讲解：展示等值分数的守恒关系（不提前泄露答案）。',
  ],
  feedbackTemplates: [
    { forError: 'bug.equiv_missing_factor', text: '你只改了分母。分母乘了几，分子也要乘几，等式才等值。' },
    { forError: 'bug.add_denominators', text: '分数不能分子分母分别相加；要先通分成同分母再做加法。' },
  ],
  explanationResources: [
    { label: '分数条/面积模型动态图', source: 'synthetic_teaching_resource', license: 'CC0-1.0 (synthetic)' },
    { label: '等值分数微课（概念导入）', source: 'synthetic_teaching_resource', license: 'CC0-1.0 (synthetic)' },
  ],
  independentTransferTest: {
    itemId: 'item.fraction.equiv.transfer.002',
    description: '4/7 = ?/21（不同表面数字、同一结构，未见题）',
    unseen: true,
    transferLevel: 'near',
  },
  completionCriteria: [
    '独立完成且未见迁移题正确（hint_level=0）。',
    '能口头解释“为什么分子分母同乘才等值”。',
    '完成时间在 12 分钟预算内。',
  ],
  progressProof: {
    requiredKcs: ['kc.fraction.equiv', 'kc.place.value'],
    allowedKcs: ['kc.place.value', 'kc.fraction.equiv', 'kc.fraction.compare', 'kc.fraction.add'],
    gate: 'passed',
  },
}

export const itemTypeGenerators: { type: string; purpose: string; example: string; usedInDemo: boolean }[] = [
  { type: '诊断区分题', purpose: '区分多个认知假设', example: '展开/验证恒等式', usedInDemo: true },
  { type: '错因对比题', purpose: '形成概念冲突与自我纠错', example: '两个通分过程哪个保持等值', usedInDemo: true },
  { type: '最小反例题', purpose: '打破错误规则', example: '用简单数值反例验证', usedInDemo: true },
  { type: 'Worked Example', purpose: '初接触时降低无关负荷', example: '分步示范并解释原因', usedInDemo: true },
  { type: 'Faded Example', purpose: '逐步撤去支架', example: '从填空步骤到独立完成', usedInDemo: true },
  { type: '近迁移练习', purpose: '同技能换参数或表面结构', example: '4/7 = ?/21', usedInDemo: true },
  { type: '远迁移练习', purpose: '新情境中主动选方法', example: '在比较大小情境中自主通分', usedInDemo: false },
  { type: '自我解释题', purpose: '训练理由表达', example: '“为什么必须同乘？”', usedInDemo: true },
  { type: '交错练习', purpose: '区分相近方法适用条件', example: '通分/约分/比较混排', usedInDemo: false },
  { type: '间隔提取题', purpose: '测试保持并更新遗忘模型', example: '数天后独立完成类似新题', usedInDemo: true },
  { type: '错误反思题', purpose: '强化检查策略', example: '找出匿名解答中的第一次错步', usedInDemo: false },
]

export const evolutionPipeline: { stage: string; title: string; detail: string; evidenceRefs: string[] }[] = [
  { stage: 'generate', title: '生成候选干预', detail: '按认知改变目标生成多套干预包，而不是只生成一道题。', evidenceRefs: ['ev.policy.301'] },
  { stage: 'gate', title: '进度/适龄/内容门禁', detail: '先过课程门禁，未教内容 fail-closed。', evidenceRefs: ['ev.gate.401'] },
  { stage: 'validate', title: '数学与题目质量验证', detail: '独立验证器校验答案与步骤，歧义题退回。', evidenceRefs: ['ev.verify.402'] },
  { stage: 'simulate', title: '冻结快照的隔离试学', detail: '每个候选从同一学生快照起跑，训练对话不共享。', evidenceRefs: ['ev.sim.201'] },
  { stage: 'rank', title: '加权教学价值排序', detail: '按 U(a) 叠加不确定性/负荷/泄露惩罚排序；最坏情况后悔值与真实校准未计算（演示范围外）。', evidenceRefs: ['ev.policy.301'] },
  { stage: 'deliver', title: '向真实学生发放', detail: '仅发放通过门禁与验证的候选。', evidenceRefs: [] },
  { stage: 'verify', title: '真实迁移/延迟复习验证', detail: '用未见迁移题与延迟复习复核；模拟不能冒充真实验证。', evidenceRefs: [] },
]

export const teachingValueWeights = {
  lambda: 0.2,
  mu: 0.25,
  nu: 0.15,
  rho: 0.3,
  note: 'U(a) = Σ wᵢ·E[Gain(Hᵢ,a)] − λ·Time − μ·Uncertainty − ν·Load − ρ·LeakageRisk。',
}

export interface CandidateIntervention {
  id: string
  label: string
  gainMean: number
  timeCost: number
  uncertainty: number
  load: number
  leakageRisk: number
  utility: number
  rank: number
  routing: 'diagnostic' | 'instruction'
}

function interventionUtility(a: Omit<CandidateIntervention, 'utility' | 'rank'>): number {
  const w = teachingValueWeights
  return a.gainMean - w.lambda * a.timeCost - w.mu * a.uncertainty - w.nu * a.load - w.rho * a.leakageRisk
}

const candidateInterventionBase: Omit<CandidateIntervention, 'utility' | 'rank'>[] = [
  {
    id: 'cand.A',
    label: '对比反例 + 自我解释',
    gainMean: 0.32,
    timeCost: 0.4,
    uncertainty: 0.18,
    load: 0.3,
    leakageRisk: 0.05,
    routing: 'instruction',
  },
  {
    id: 'cand.C',
    label: '近迁移练习（4/7=?/21）',
    gainMean: 0.18,
    timeCost: 0.3,
    uncertainty: 0.15,
    load: 0.2,
    leakageRisk: 0.02,
    routing: 'instruction',
  },
  {
    id: 'cand.B',
    label: '分步示范例题',
    gainMean: 0.24,
    timeCost: 0.5,
    uncertainty: 0.12,
    load: 0.25,
    leakageRisk: 0.1,
    routing: 'instruction',
  },
  {
    id: 'cand.D',
    label: '诊断区分题（3/4=?/12）',
    gainMean: 0.12,
    timeCost: 0.15,
    uncertainty: 0.2,
    load: 0.1,
    leakageRisk: 0.02,
    routing: 'diagnostic',
  },
]

export const candidateInterventions: CandidateIntervention[] = candidateInterventionBase
  .map((a) => ({ ...a, utility: interventionUtility(a), rank: 0 }))
  .sort((a, b) => {
    if (a.routing !== b.routing) return a.routing === 'instruction' ? -1 : 1
    return b.utility - a.utility
  })
  .map((a, i) => ({ ...a, rank: i + 1 }))

export const rewardHackGuards = [
  '每个候选干预从同一学生状态快照起跑，实验之间不共享训练对话。',
  '训练/验证/测试题各自独立；生成器不得预见过迁移题。',
  '生成器与评估器即使共用同一底层模型，也必须配独立规则验证器 + 数据隔离 + 偶发跨模型评估。',
  '维护真实对照组：同知识点同难度普通练习、知识追踪推荐题、虚拟演化题。',
  '模拟不得擅自修改长期孪生的 observed_* 字段；随机错误或全知表现的一致性测试失败者不得参与评分。',
]

/* ---------- §10 教学策略路由器、时间预算、提示梯度 ---------- */

export type PolicyAction =
  | 'ASK_DIAGNOSTIC_QUESTION'
  | 'GIVE_MINIMAL_HINT'
  | 'SHOW_WORKED_EXAMPLE'
  | 'TEACH_MICRO_LESSON'
  | 'ASSIGN_TARGETED_PRACTICE'
  | 'ASSIGN_TRANSFER_TASK'
  | 'SCHEDULE_SPACED_REVIEW'
  | 'REQUEST_PROGRESS_CONFIRMATION'
  | 'ANSWER_DIRECTLY'

export interface PolicyActionSpec {
  action: PolicyAction
  label: string
  selectWhen: string
  chosen: boolean
}

export const policyActions: PolicyActionSpec[] = [
  { action: 'ASK_DIAGNOSTIC_QUESTION', label: '先问区分性诊断题', selectWhen: '假设冲突、需要区分', chosen: false },
  { action: 'GIVE_MINIMAL_HINT', label: '给最小提示', selectWhen: '已有策略，只卡在下一步', chosen: false },
  { action: 'SHOW_WORKED_EXAMPLE', label: '展示分步示范', selectWhen: '新知识或前置能力弱', chosen: false },
  { action: 'TEACH_MICRO_LESSON', label: '概念微课', selectWhen: '概念性误解尚未建立', chosen: true },
  { action: 'ASSIGN_TARGETED_PRACTICE', label: '定向练习', selectWhen: '已理解但需程序化练习', chosen: false },
  { action: 'ASSIGN_TRANSFER_TASK', label: '迁移任务', selectWhen: '基础正确，验证换情境迁移', chosen: false },
  { action: 'SCHEDULE_SPACED_REVIEW', label: '安排间隔复习', selectWhen: '已学且预计会忘记', chosen: false },
  { action: 'REQUEST_PROGRESS_CONFIRMATION', label: '请确认学校进度', selectWhen: '进度含糊，禁止默认超前', chosen: false },
  { action: 'ANSWER_DIRECTLY', label: '直接回答', selectWhen: '学生明确要求答案或时间紧急', chosen: false },
]

export interface TeachingPolicyDecision {
  inputs: {
    mode: string
    knowledgeFocus: string
    hypothesisSet: string
    reviewQueueHead: string
    upcomingLesson: string
    taskIntent: string
    timeBudgetMinutes: number
  }
  chosenAction: PolicyAction
  reason: string
  constraints: string[]
  timeBudget: {
    previewMinutes: number
    currentCourseMinutes: number
    reviewMinutes: number
    diagnosticMinutes: number
    transferMinutes: number
    totalMinutes: number
  }
  policyVersion: string
}

export const teachingPolicy: TeachingPolicyDecision = {
  inputs: {
    mode: 'learn（课堂同步增强）',
    knowledgeFocus: 'kc.fraction.equiv 概念证据弱、程序尚可',
    hypothesisSet: 'H1 0.52 / H2 0.22 / H3 0.14 / unknown 0.12',
    reviewQueueHead: 'fraction_add_unlike（priority 最高）',
    upcomingLesson: '异分母分数加法（已确认）',
    taskIntent: '纠正等式恒等变换误区，建立自检策略',
    timeBudgetMinutes: 20,
  },
  chosenAction: 'TEACH_MICRO_LESSON',
  reason:
    '证据支持“等值/补偿概念缺口”（H1）而非单纯程序失误，先做概念微课 + 对比反例 + 自我解释，再用未见近迁移题验证。',
  constraints: ['总时长受学生设定与学校作业负担约束', '不通过无限题海或连续追问最大化系统指标', '其后必须用新题迁移验证，提示后答对不算独立掌握'],
  timeBudget: {
    previewMinutes: 2,
    currentCourseMinutes: 10,
    reviewMinutes: 4,
    diagnosticMinutes: 2,
    transferMinutes: 2,
    totalMinutes: 20,
  },
  policyVersion: 'policy.syn.v3',
}

export const hintGradient = {
  levels: [
    { level: 0, label: '激活已有知识', description: '先问“分母 4 怎么变成 12？”' },
    { level: 1, label: '小问题提示', description: '指向关键关系，不给步骤。' },
    { level: 2, label: '指向错误步骤', description: '标出第一次偏离的位置。' },
    { level: 3, label: '对比例子', description: '给出正误两个通分过程对比。' },
    { level: 4, label: '局部步骤示范', description: '示范第一步，其余留给学生。' },
    { level: 5, label: '完整讲解', description: '完整说明，但随后必须用新题迁移验证。' },
  ],
  currentLevel: 2,
  note: '真实学生的每次提示级别进入日志；提示后同题答对不代表独立掌握。',
}

/* ---------- §11 模拟实验室（严格隔离） ---------- */

export const simulationLabComponents: { component: string; purpose: string; demoValue: string }[] = [
  { component: 'Scenario', purpose: '课程节点、当前误区、任务、题组、提示与答案', demoValue: 'unit.fraction.equiv · bug.equiv_missing_factor' },
  { component: 'Student Snapshot', purpose: '长期孪生版本与多个短期假设的状态副本', demoValue: 'twin v54 + 3 个活跃假设副本' },
  { component: 'Environment Engine', purpose: '维护虚拟学生可见题目/提示/历史，执行隔离与防泄漏', demoValue: '训练题与迁移题分离' },
  { component: 'Student Behavior Model', purpose: '按能力边界生成可观察解法、步骤与错误', demoValue: 'sim_v3（受 bug_rules 约束）' },
  { component: 'Tutor Policy Candidate', purpose: '在模拟中选择教学提示、讲解与题目顺序', demoValue: 'policy.syn.v3 的两个候选分支' },
  { component: 'Verifier', purpose: '独立判定每个步骤与迁移题结果', demoValue: 'exact_fraction_equality（与生成器隔离）' },
  { component: 'Outcome Evaluator', purpose: '比较干预前后的迁移表现、步骤改进与提示依赖', demoValue: '前测→干预→未见近迁移后测' },
]

export interface SimulationRun {
  runId: string
  sourceType: 'simulated'
  isRealStudentEvidence: false
  studentSnapshotVersion: number
  simulatorVersion: string
  interventionId: string
  heldoutSetId: string
  stages: { stage: string; label: string; detail: string }[]
  hypothesisResults: {
    hypothesisId: string
    weightBeforeRun: number
    pretestScore: number
    posttestScore: number
    gainMean: number
    uncertainty: 'low' | 'medium' | 'high'
    notes: string
  }[]
  confidenceInterval: { level: number; low: number; high: number }
  modelMismatch: { status: 'not_triggered' | 'triggered'; note: string }
  integrationRules: string[]
}

export const simulationRun: SimulationRun = {
  runId: 'simrun.syn.985',
  sourceType: 'simulated',
  isRealStudentEvidence: false,
  studentSnapshotVersion: 54,
  simulatorVersion: 'sim_v3',
  interventionId: 'int.syn.209',
  heldoutSetId: 'eval.near_transfer.syn.v2',
  stages: [
    { stage: 'pretest', label: '前测（独立）', detail: '未见等值分数题，hint_level=0。' },
    { stage: 'intervention', label: '教学干预', detail: '对比反例 + 自我解释 + 分步示范。' },
    { stage: 'posttest_near', label: '后测（未见近迁移）', detail: '4/7 = ?/21，结构相同表面不同。' },
    { stage: 'posttest_far', label: '后测（未见远迁移，可选）', detail: '比较大小情境中自主通分（本演示未运行）。' },
  ],
  hypothesisResults: [
    {
      hypothesisId: 'hyp.frac.equiv_gap',
      weightBeforeRun: 0.44,
      pretestScore: 0.2,
      posttestScore: 0.6,
      gainMean: 0.4,
      uncertainty: 'high',
      notes: 'illustrative_only',
    },
    {
      hypothesisId: 'hyp.frac.add_denominators',
      weightBeforeRun: 0.31,
      pretestScore: 0.35,
      posttestScore: 0.5,
      gainMean: 0.15,
      uncertainty: 'high',
      notes: 'illustrative_only',
    },
    {
      hypothesisId: 'hyp.frac.slip',
      weightBeforeRun: 0.14,
      pretestScore: 0.88,
      posttestScore: 0.9,
      gainMean: 0.02,
      uncertainty: 'medium',
      notes: 'illustrative_only',
    },
  ],
  confidenceInterval: { level: 0.8, low: 0.05, high: 0.52 },
  modelMismatch: {
    status: 'not_triggered',
    note: '若真实学生表现超出所有虚拟模型解释范围，触发 MODEL_MISMATCH 并更新候选集。',
  },
  integrationRules: [
    '按当前后验权重抽取短期学生，而不是只选最大概率的模型。',
    '避免多个模型只是同一 Prompt 略作改写、输出高度相关。',
    '模拟收益的置信区间进入排名，低置信度策略保守处理。',
    '仿真只用于候选策略筛选，必须在真人评测上复核。',
  ],
}

/* ---------- §12 工作流状态机与 Agent 角色 ---------- */

export const workflowNodes: { id: string; label: string; kind: 'start' | 'state' | 'end' }[] = [
  { id: 'Intake', label: '接入', kind: 'start' },
  { id: 'EvidenceParse', label: '证据解析', kind: 'state' },
  { id: 'ProgressCheck', label: '进度检查', kind: 'state' },
  { id: 'NeedClarification', label: '待确认', kind: 'state' },
  { id: 'StateLoad', label: '加载状态', kind: 'state' },
  { id: 'Diagnose', label: '诊断', kind: 'state' },
  { id: 'RecallSchedule', label: '复习调度', kind: 'state' },
  { id: 'PreviewPlanner', label: '预习规划', kind: 'state' },
  { id: 'HypothesisUpdate', label: '假设更新', kind: 'state' },
  { id: 'Probe', label: '探测', kind: 'state' },
  { id: 'AwaitStudent', label: '等待作答', kind: 'state' },
  { id: 'ExerciseEvolution', label: '习题演化', kind: 'state' },
  { id: 'SimulationLab', label: '模拟实验室', kind: 'state' },
  { id: 'CandidateRanking', label: '候选排序', kind: 'state' },
  { id: 'CurriculumGate', label: '课程门禁', kind: 'state' },
  { id: 'ContentValidation', label: '内容验证', kind: 'state' },
  { id: 'Deliver', label: '发放', kind: 'state' },
  { id: 'Assess', label: '评估', kind: 'state' },
  { id: 'StateCommit', label: '状态提交', kind: 'state' },
  { id: 'ReviewReschedule', label: '复习重排', kind: 'end' },
]

export const workflowEdges: { from: string; to: string; label?: string }[] = [
  { from: 'Intake', to: 'EvidenceParse' },
  { from: 'EvidenceParse', to: 'ProgressCheck' },
  { from: 'ProgressCheck', to: 'NeedClarification', label: '进度/题干关键歧义' },
  { from: 'NeedClarification', to: 'ProgressCheck', label: '真实用户确认' },
  { from: 'ProgressCheck', to: 'StateLoad', label: '可继续' },
  { from: 'StateLoad', to: 'Diagnose', label: '存在解题错误/困惑' },
  { from: 'StateLoad', to: 'RecallSchedule', label: '复习触发' },
  { from: 'StateLoad', to: 'PreviewPlanner', label: '已确认下一课' },
  { from: 'Diagnose', to: 'HypothesisUpdate' },
  { from: 'HypothesisUpdate', to: 'Probe', label: '假设分歧大' },
  { from: 'Probe', to: 'AwaitStudent' },
  { from: 'AwaitStudent', to: 'EvidenceParse', label: '新回答' },
  { from: 'HypothesisUpdate', to: 'ExerciseEvolution', label: '方向已足够' },
  { from: 'RecallSchedule', to: 'ExerciseEvolution' },
  { from: 'PreviewPlanner', to: 'ExerciseEvolution' },
  { from: 'ExerciseEvolution', to: 'SimulationLab' },
  { from: 'SimulationLab', to: 'CandidateRanking' },
  { from: 'CandidateRanking', to: 'CurriculumGate' },
  { from: 'CurriculumGate', to: 'ExerciseEvolution', label: '不合法/超前' },
  { from: 'CurriculumGate', to: 'ContentValidation', label: '通过' },
  { from: 'ContentValidation', to: 'ExerciseEvolution', label: '题目错误/歧义' },
  { from: 'ContentValidation', to: 'Deliver', label: '通过' },
  { from: 'Deliver', to: 'AwaitStudent' },
  { from: 'AwaitStudent', to: 'Assess', label: '训练后新作答' },
  { from: 'Assess', to: 'StateCommit' },
  { from: 'StateCommit', to: 'ReviewReschedule' },
]

export const workflowCurrentPath: string[] = [
  'Intake',
  'EvidenceParse',
  'ProgressCheck',
  'StateLoad',
  'Diagnose',
  'HypothesisUpdate',
  'Probe',
  'AwaitStudent',
]

export const workflowNote =
  '完整状态机可用，但并非每次交互都必经所有状态；例如只问定理定义可走轻量检索 + 门禁 + 讲解。异步任务可跨会话恢复，但不可谎称已完成尚未完成的模拟与学习判定。'

export const agentRoles: { role: string; input: string; output: string; forbidden: string }[] = [
  { role: 'Intake / Evidence Parser', input: '图片/文本/语音/行为', output: '结构化题干与步骤', forbidden: '捏造学生没写出的步骤' },
  { role: 'Curriculum Agent', input: '教材、进度、题目标签', output: '课程开放集合、状态建议', forbidden: '自行放行未授内容' },
  { role: 'Reasoning Trace Analyzer', input: '学生步骤、正确解法', output: '错步及策略证据', forbidden: '把猜测说成内心事实' },
  { role: 'Hypothesis Generator', input: '当前状态与错误图', output: '多种可区分认知假设', forbidden: '固定人格类型化' },
  { role: 'Hypothesis Arbiter', input: '假设、新证据与似然', output: '权重、分裂/合并/归档动作', forbidden: '直接用模拟更新真实掌握' },
  { role: 'Student Simulator', input: '假设和试学场景', output: '模拟答卷、提示反应', forbidden: '突破能力边界或泄露测试答案' },
  { role: 'Exercise Generator', input: '认知改变目标', output: '干预包/迁移题候选', forbidden: '生成未通过课程门禁的可见题' },
  { role: 'Subject Verifier', input: '题目/步骤/解答', output: '正确性、歧义、解答验证', forbidden: '未验证宣称唯一正确答案' },
  { role: 'Teaching Policy', input: '状态、课程、复习、模拟收益', output: '选教学动作与理由', forbidden: '超出学习时间预算' },
  { role: 'Memory Scheduler', input: '复习观测、模型参数', output: '记忆状态与计划', forbidden: '将阅读/提示后正确算作独立检索' },
  { role: 'Quality/Eval Agent', input: '真实与模拟评测', output: '校准、回归、风险告警', forbidden: '在训练数据上直接宣布有效' },
]

export const toolCatalogSample: string[] = [
  'check_curriculum_gate(student_id, item, mode) -> AllowOrReject',
  'trace_first_invalid_step(question, student_trace) -> ErrorLocalization',
  'propose_hypotheses(evidence_ids, student_state, graph) -> HypothesisSet',
  'score_hypotheses(observation, context, hypotheses) -> PosteriorUpdate',
  'build_intervention_package(objective, curriculum, rubric) -> CandidatePackage[]',
  'run_sandbox_simulation(snapshot, interventions, heldout_tests) -> SimulationReport',
  'rank_interventions(sim_reports, policy_constraints) -> RankedActions',
  'fit_memory_model(student_id, review_events, model_version) -> MemoryPosterior',
  'schedule_next_review(student_id, curriculum, memory_state, budget) -> ReviewPlan',
  'create_learning_report(student_id, time_window) -> EvidenceGroundedReport',
]

/* ---------- §13.3 权限域 ---------- */

export const permissionDomains: { domain: string; scope: string; visibleTo: string; note: string }[] = [
  {
    domain: 'student_private_domain',
    scope: '真实作答、身份、课程、长期认知状态',
    visibleTo: '学生本人、经授权的最小必要服务',
    note: '原始学生答卷加密、审计访问、可导出/纠错/删除。',
  },
  {
    domain: 'simulation_isolated',
    scope: '短期模型副本与实验结果',
    visibleTo: '研发/评测',
    note: '永不混入真实观测事件；is_real_student_evidence=false。',
  },
  {
    domain: 'curriculum_public',
    scope: '合法授权教材索引、图谱和题库',
    visibleTo: '教学服务',
    note: '记录版权许可、版本、来源与有效时间。',
  },
  {
    domain: 'analytics_deidentified',
    scope: '聚合、匿名/去标识化后的评测样本',
    visibleTo: '离线评测',
    note: '禁止在跨用户检索中泄漏学生个体数据。',
  },
  {
    domain: 'teacher_guardian_scope',
    scope: '依具体授权开放的受限报告视图',
    visibleTo: '教师、监护人',
    note: '越权请求只能缩小、不能扩大可见范围。',
  },
]

/* ---------- §17 跨学科适配层（结构说明） ---------- */

export const crossSubjectAdapters: {
  subject: string
  focus: string
  diagnosis: string
  tooling: string
  demoStatus: 'in_demo' | 'out_of_scope'
}[] = [
  {
    subject: '初高中/高数',
    focus: '变形、定理使用、分类讨论、解题策略',
    diagnosis: '错步与错误规则图',
    tooling: 'CAS、步骤等价证明、函数绘图',
    demoStatus: 'in_demo',
  },
  {
    subject: '物理',
    focus: '建模、受力分析、单位、极限情形',
    diagnosis: '解释图示、分析物理模型',
    tooling: '单位检查、符号计算、仿真',
    demoStatus: 'out_of_scope',
  },
  {
    subject: '化学',
    focus: '反应机理、计量守恒、概念区分',
    diagnosis: '反应步骤和守恒逻辑',
    tooling: '方程式平衡、量纲与安全验证',
    demoStatus: 'out_of_scope',
  },
  {
    subject: '编程/计算机',
    focus: '分解问题、抽象、测试、复杂度',
    diagnosis: '代码轨迹和失败测试',
    tooling: '沙箱、单测、静态/动态分析',
    demoStatus: 'out_of_scope',
  },
  {
    subject: '英语/语文',
    focus: '阅读理解、语言表达、论证结构',
    diagnosis: 'Rubric、错误模式、修改轨迹',
    tooling: '文本对齐、多维评价、人审',
    demoStatus: 'out_of_scope',
  },
  {
    subject: '专科实践课',
    focus: '操作流程、安全规范、岗位技能',
    diagnosis: '程序步骤与标准作业流程',
    tooling: '虚拟实验、专业 Rubric、行业规范',
    demoStatus: 'out_of_scope',
  },
]

export const highRiskSafetyNote =
  '化学实验、电学、高压装置、网络攻防等高风险场景必须设置学科安全过滤与专业监管，不因个性化教学需求生成危险操作细节。（本演示仅覆盖分数知识点，不含高风险实践内容。）'

/* ---------- §18 学习科学策略工具箱 ---------- */

export const learningMethods: {
  method: string
  harnessAction: string
  condition: string
  verification: string
  activeHere: boolean
}[] = [
  { method: 'Retrieval Practice（检索练习）', harnessAction: '不先展示答案，要求独立回忆或应用', condition: '已学内容，需要保持', verification: '无提示成功率、延迟测验', activeHere: true },
  { method: 'Spaced Practice（间隔学习）', harnessAction: '结合记忆稳定性安排复习日', condition: '已经接触并有可测保持任务', verification: '一周/数周后的独立作答', activeHere: true },
  { method: 'Interleaving（交错练习）', harnessAction: '混排易混方法与旧知识', condition: '基础理解建立之后，需要辨别策略', verification: '新题策略选择正确率', activeHere: false },
  { method: 'Worked Examples（示范例题）', harnessAction: '给高质量分步示范', condition: '新内容或先修知识较弱', verification: '之后自行解题', activeHere: true },
  { method: 'Fading Scaffolds（支架渐隐）', harnessAction: '逐步去掉填空、公式提示', condition: '部分理解但依赖提示', verification: '不看提示独立完成', activeHere: true },
  { method: 'Self-explanation（自我解释）', harnessAction: '要求解释为什么这一步成立', condition: '概念理解与解题规则纠正', verification: '换题仍能解释关键原理', activeHere: true },
  { method: 'Elaborative Interrogation（精细追问）', harnessAction: '“为什么成立？反例是什么？”', condition: '需要连接前置概念', verification: '反例与迁移题', activeHere: true },
  { method: 'Contrastive Learning Tasks（对比题）', harnessAction: '对比正确/错误方法与易混概念', condition: '稳定错误规则', verification: '错误是否不再重复', activeHere: true },
  { method: 'Productive Failure（有支持的尝试）', harnessAction: '先尝试，再给结构化提示', condition: '学生具备可用先修，失败成本可控', verification: '后续理解与迁移', activeHere: false },
  { method: 'Mastery Learning（掌握学习）', harnessAction: '达到可验证标准再进入依赖性任务', condition: '有明确前置依赖', verification: '独立测试 + 间隔保持', activeHere: false },
  { method: 'Metacognitive Prompts（元认知提示）', harnessAction: '预测答案、检查步骤、事后反思', condition: '缺少自我检验策略', verification: '自主纠错率与提示依赖下降', activeHere: true },
  { method: 'Dual Coding / Visualisation（多表征）', harnessAction: '公式、图像、图示、文字互补', condition: '适合数形结合', verification: '跨表征迁移题', activeHere: true },
  { method: 'Cognitive Load Control（认知负荷管理）', harnessAction: '控制信息量、一次处理一个错误', condition: '初学、题干复杂或学生过载', verification: '完成度与错误模式变化', activeHere: true },
  { method: 'Error-focused Practice（错因专项）', harnessAction: '针对某错误规则生成变式', condition: '多次证据支持特定误区', verification: '未见题不再重复同类错步', activeHere: true },
  { method: 'Near/Far Transfer（近/远迁移）', harnessAction: '将应用情境逐步拉远', condition: '基础程序已经稳固', verification: '未见应用题/综合题', activeHere: true },
  { method: 'Self-regulated Learning（自我调节）', harnessAction: '共同设目标、反思学习计划', condition: '自主学习者/考试准备', verification: '计划完成质量和自主学习能力', activeHere: false },
]

export const methodCombinationRule = {
  situation: '概念误解严重（当前证据支持 H1 等值概念缺口）',
  methods: ['对比反例', '自我解释', '具体示范'],
  followUp: '独立迁移题',
  note: '按组合规则而非“拼盘”：先纠正概念，再验证迁移；不是对所有学生同时启用全部干预。',
}

/* ---------- §20.1 关键运行指标（分维度） ---------- */

export type MetricStatus = 'ok' | 'watch' | 'insufficient'

export interface MetricsDimension {
  dimension: string
  metrics: { name: string; value: string; status: MetricStatus }[]
}

export const metricsByDimension: MetricsDimension[] = [
  {
    dimension: '学生学习',
    metrics: [
      { name: '独立正确率', value: '0.68', status: 'watch' },
      { name: '步骤错误复发率', value: '0.22', status: 'watch' },
      { name: '近迁移 / 远迁移', value: '0.56 / 0.22', status: 'watch' },
      { name: '延迟保持', value: '0.51', status: 'watch' },
      { name: '提示依赖', value: '0.35', status: 'watch' },
      { name: '学习时间', value: '137 min', status: 'ok' },
    ],
  },
  {
    dimension: '课程同步',
    metrics: [
      { name: '学校进度置信度', value: '0.93', status: 'ok' },
      { name: '预习窗口命中率', value: '0.80', status: 'ok' },
      { name: '超前题拦截数', value: '3（合成）', status: 'ok' },
      { name: '进度冲突', value: '1', status: 'watch' },
    ],
  },
  {
    dimension: '认知拟合',
    metrics: [
      { name: 'posterior 校准', value: '0.79', status: 'ok' },
      { name: '未知原因比例', value: '0.11', status: 'watch' },
      { name: '假设分裂/合并频次', value: '2 / 1', status: 'ok' },
      { name: '诊断题信息效率', value: '0.31', status: 'ok' },
    ],
  },
  {
    dimension: '习题生成',
    metrics: [
      { name: '验证通过率', value: '0.94', status: 'ok' },
      { name: '歧义率', value: '0.03', status: 'ok' },
      { name: '重复率', value: '0.08', status: 'ok' },
      { name: '虚拟/真实增益差', value: '无法计算（无真实观测）', status: 'insufficient' },
      { name: '题目覆盖度', value: '0.72', status: 'watch' },
    ],
  },
  {
    dimension: '遗忘模型',
    metrics: [
      { name: '复习到期准确率', value: '0.88', status: 'ok' },
      { name: 'Brier（合成示意，非时间外）', value: '0.18', status: 'watch' },
      { name: '失配率', value: '0.05', status: 'ok' },
      { name: '复习负担', value: '0.42', status: 'watch' },
    ],
  },
  {
    dimension: '基础设施',
    metrics: [
      { name: '单次会话模型调用', value: '6', status: 'ok' },
      { name: '模拟 token 成本', value: '12,400（合成）', status: 'watch' },
      { name: '工具耗时 p95', value: '820 ms', status: 'ok' },
      { name: '缓存命中', value: '0.61', status: 'ok' },
      { name: '工作流失败率', value: '0.02', status: 'ok' },
    ],
  },
  {
    dimension: '公平与安全',
    metrics: [
      { name: '年龄/教材版本分组错误率', value: '0.04', status: 'watch' },
      { name: '教师争议复核率', value: '0.06', status: 'watch' },
      { name: '越界建议', value: '0', status: 'ok' },
      { name: '数据访问异常', value: '0', status: 'ok' },
    ],
  },
]

/* ---------- §20.3 每条推荐的可解释审计记录 ---------- */

export const recommendationAudit = {
  decisionId: 'policy.syn.301',
  recommendation: '现在发放「等值分数概念题 + 对比反例」微课与 1 道未见近迁移题。',
  publicExplain:
    '因为你在通分时几次漏掉“分子同乘”的补偿步骤，我先安排一个恒等变形对比题，再用一道新题检验。',
  detailedQuestions: [
    { question: '为什么现在发这道题？', answer: '证据支持等值/补偿概念缺口（H1 后验 0.52 最高）；当前为课堂同步增强时段。' },
    { question: '它属于学校哪一章？', answer: 'unit.fraction.equiv（已教）；下一课为 unit.fraction.add（已确认）。' },
    { question: '检测什么已学先修？', answer: 'kc.place.value（数位/位值）与 kc.fraction.equiv（等值分数）。' },
    { question: '当前有什么可观察证据？', answer: 'ev.obs.101、ev.obs.102；首次失步位置为 step_2（未做等值变换）。' },
    { question: '有哪些备选假设？', answer: 'H1 等值概念缺口 0.52、H2 分母直接相加 0.22、H3 偶发疏漏 0.14、unknown 0.12。' },
    { question: '为什么不是另一道题？', answer: '分数乘法候选题被课程门禁 fail-closed 拦截；纯诊断题信息增益低于当前教学需求。' },
    { question: '参考了哪些真实复习数据？', answer: 'ev.rev.001（独立成功）、ev.rev.002（提示后成功，未计独立检索）。' },
    { question: '用过哪些模拟？模拟有多不确定？', answer: 'simrun.syn.985（is_real_student_evidence=false）；80% 增益区间 [0.05, 0.52]，不确定性高。' },
    { question: '做完后用什么新题检验？', answer: 'item.fraction.equiv.transfer.002「4/7 = ?/21」，未见近迁移、要求独立完成。' },
  ],
  teacherNote: '教师/研发端可查看证据、策略、版本与评测；学生端只显示一句话解释，且不泄露其他学生数据。',
}

/* ---------- §21 隐私、最小化与数据治理 ---------- */

export const privacyMinimization = {
  principles: [
    { id: 'event_centric', title: '以学习事件为中心', statement: '不监控学生 24 小时的设备、位置或其他与学习无关的行为。', status: '演示声明' },
    { id: 'progress_confirmed', title: '进度优先由本人/教师确认', statement: '避免从无关个人信息推断学校进度。', status: '演示声明' },
    { id: 'skill_only_persona', title: '虚拟学生只含学习相关特征', statement: '仅包含学习技能、可观察错误和任务上下文；避免敏感身份变量形成刻板印象。', status: '演示声明' },
    { id: 'photo_minimization', title: '拍题照片最小化', statement: '姓名、班级、其他学生信息应尽可能遮蔽或最小化存储。', status: '演示声明' },
  ],
  governance: [
    '明确未成年用户适用的监护同意、权限与处理限制，并按目标市场法律评估。',
    '原始学生答卷加密、审计访问、设置保留期，并提供导出/纠错/删除机制。',
    '像素图片、教材片段、学习档案、向量嵌入与模型训练副本都纳入数据生命周期管理。',
    '训练个性化模拟器前必须确认真实数据来源与允许用途，避免以未成年人私有数据构建公开训练集。',
    '教育推荐不得用于未经授权的高风险学生标签、惩罚、招生淘汰或身份画像决定。',
  ],
  academicIntegrity: [
    '教师可查看 AI 的教学依据、覆盖范围与不确定性，并可覆盖错误课程标签。',
    '主观题/开放题允许申诉与人工复评。',
    '学生需要时可直接给答案，但产品提供“只给提示/逐步引导/完整讲解”模式。',
    '课程评价等高风险场景，AI 建议必须由学校/教师规定的规则复核。',
  ],
  consent: {
    guardianConsent: 'synthetic_granted',
    retentionDays: 180,
    exportSupported: true,
    correctionSupported: true,
    deletionSupported: true,
  },
  note: '本演示不含任何真实身份数据；以上为最小化与治理声明，不连接任何真实后端或数据存储。',
}
