/**
 * 前端对 `dsh-plugin/src` 真实 TypeScript 核心的唯一桥接层。
 *
 * 这里不做任何业务实现，只把浏览器可安全导入的纯核心模块重新导出：
 * 课程门禁、图谱、FSRS 记忆模型、诊断、干预包、假设、孪生、教学策略、报告。
 *
 * 刻意不导入：
 * - `core/services.ts`（node:fs / node:path 文件存储）；
 * - `core/privacy.ts`（本前端按 brief 使用本地同意账本；隐私边界在 UI 中说明）；
 * - `core/fsrs-calibration.ts` / `core/exercise-evolution.ts`（前端不需要，
 *   且会带入更多仅 Node 侧使用的依赖）。
 *
 * `curriculum-graph.ts` 唯一使用 `node:crypto` 的地方由
 * `src/lib/shims/sha256.ts` 通过 Vite alias 提供；Node 侧仍使用内置 crypto。
 */

export {
  DEFAULT_MIN_ANNOTATION_CONFIDENCE,
  DEFAULT_MIN_PROGRESS_CONFIDENCE,
  GATE_MODES,
  MAX_EXTENSION_GRADE_DELTA,
} from '@aeh/domain.ts'
export type {
  CurriculumItem,
  GateDecision,
  GateMode,
  LearnerProgress,
  MemoryObservationInput,
  MemoryState,
  MemoryStateInput,
} from '@aeh/domain.ts'

export {
  allow as gateAllow,
  allowedKcs,
  filterAllowed,
  gateAdmits,
  hasUnapprovedFutureMethod,
} from '@aeh/core/curriculum-gate.ts'
export type { GateThresholds } from '@aeh/core/curriculum-gate.ts'

export {
  KnowledgeGraph,
  GraphValidationError,
  contentHash,
} from '@aeh/core/curriculum-graph.ts'

export {
  INITIAL_DIFFICULTY,
  INITIAL_STABILITY_DAYS,
  MIN_STABILITY_DAYS,
  MemoryParameters,
  aggregateMemory,
  applyForgetting,
  createMemoryState,
  intervalForTarget,
  isIndependentRetrievalSuccess,
  memoryHealth,
  normalizeMemoryState,
  retrievalWeight,
  retrievability,
  reviewSchedule,
  updateMany,
  updateMemory,
} from '@aeh/core/memory.ts'

export {
  DEFAULT_PROBE_WEIGHTS,
  candidateFromInput,
  probeWeightsFromInput,
  scoreCandidate,
  selectProbe,
} from '@aeh/core/diagnosis.ts'
export type {
  DiagnosticCandidate,
  ProbeSelection,
  ProbeWeights,
} from '@aeh/core/diagnosis.ts'

export {
  allItems,
  packageFromInput,
  packageReady,
  validatePackage,
} from '@aeh/core/exercise.ts'
export type {
  InterventionPackage,
  PackageValidation,
} from '@aeh/core/exercise.ts'

export {
  ACTIVE,
  HypothesisSet,
  makeHypothesis,
  UNKNOWN_HYPOTHESIS_ID,
} from '@aeh/core/hypothesis.ts'
export type { Hypothesis } from '@aeh/core/hypothesis.ts'

export { StudentTwin } from '@aeh/core/twin.ts'
export type {
  TwinEvent,
  TwinEventInput,
  TwinSnapshot,
  TwinState,
} from '@aeh/core/twin.ts'

export {
  ACTION_METHODS,
  LEARNING_SCIENCE_METHODS,
  METHODS_BY_ID,
  learningScienceChecklist,
  methodById,
  methodsForAction,
  selectStrategy,
} from '@aeh/core/teaching-strategy.ts'
export type {
  LearningScienceMethod,
  StrategyDecision,
  StrategyRequest,
} from '@aeh/core/teaching-strategy.ts'

export {
  AUDIENCE_GUARDIAN,
  AUDIENCE_TEACHER,
  DEFAULT_AUDIENCE_SCOPES,
  effectiveScopes,
  generateReport,
  reportToDict,
  reportToMarkdown,
} from '@aeh/report.ts'
export type {
  AggregateEventInput,
  AggregateMetrics,
  Audience,
  LearningReport,
  ReportTopic,
} from '@aeh/report.ts'
