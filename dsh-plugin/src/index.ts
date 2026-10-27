/**
 * AEH education plugin entry for dsh / Cordis.
 *
 * Cordis function-plugin shape:
 *   - `name`       display/diagnostic identity;
 *   - `inject`     wait for the `tools` service;
 *   - `apply`      register reversible tool effects on this context.
 *
 * The default profile exposes only compute/prepare tools. It has no raw-student
 * data access, no database write, no credentials, no filesystem/network access,
 * no observed-twin write, and no way to override the curriculum gate.
 */

import type { Context } from './dsh.ts'
import {
  assertMinimalPermissions,
  MINIMAL_PERMISSIONS,
  type PermissionRequest,
} from './permissions.ts'
import {
  AEH_CONFIG_SCHEMA,
  resolveAehConfig,
} from './config.ts'
import { AehAuditLog } from './host/audit-log.ts'
import { SessionSnapshotStore } from './host/session-state.ts'
import { SecurityGuard } from './security.ts'
import {
  createEducationService,
  type Config as ServiceConfig,
  type HostContext,
} from './service.ts'
import { createEducationTools } from './tools.ts'

export const name = 'aeh-education'

/** The tool registry is the only required Cordis service. */
export const inject = ['tools']

/** Machine-checkable minimal permission manifest for host review. */
export const permissions = MINIMAL_PERMISSIONS

/**
 * Cordis plugin `Config` (Schemastery).
 *
 * Exporting the schema makes the loader validate and default a YAML/config
 * object **before** `apply` runs, so an illegal `profile` / `targetRetention` /
 * `allowedModes` fails the load loudly instead of silently falling back to
 * defaults. `apply` re-runs the same schema through {@link resolveAehConfig} for
 * direct/embedded callers and tests, so there is one validation path.
 */
export const Config = AEH_CONFIG_SCHEMA

export interface PluginConfig extends ServiceConfig {
  /**
   * Optional request from the host. It may only narrow or restate the minimal
   * manifest; any denied capability makes plugin activation fail closed.
   */
  readonly permissions?: PermissionRequest
  /**
   * Host-owned catalog/progress resolver. A real adapter injects this from the
   * authorised session; it is not a serialisable YAML field and it defaults to
   * "resolve nothing", so tools fail closed until the host wires it in.
   */
  readonly host?: HostContext
}

/**
 * Register the AEH education tools.
 *
 * Every registration is owned by one `ctx.effect`, so unloading or hot-replacing
 * the plugin removes all tools even if a later registration throws. The
 * per-instance session snapshot store and audit log are created here: neither is
 * exported to the model, and nothing in them reaches the long-term twin.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  assertMinimalPermissions(config.permissions)
  // Fail loud on illegal config: the same Schemastery schema validates both the
  // loader-supplied object and direct/embedded calls.
  const resolved = resolveAehConfig(config)
  const service = createEducationService(resolved, config.host)
  const snapshots = new SessionSnapshotStore()
  const audit = new AehAuditLog()
  // Step 8: one guard per mount, so rate-limit state never leaks between hosts.
  const security = new SecurityGuard({
    limits: resolved.security.limits,
    rateLimits: resolved.security.rateLimits,
  })

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const detachSessionCleanup = attachSessionCleanup(ctx, snapshots, audit)
    try {
      for (const tool of createEducationTools(service, {
        audit,
        snapshots,
        security,
      })) {
        disposers.push(ctx.tools.register(tool))
      }
    } catch (error) {
      detachSessionCleanup()
      for (const dispose of disposers.reverse()) {
        dispose()
      }
      throw error
    }
    return () => {
      detachSessionCleanup()
      for (const dispose of disposers.reverse()) {
        dispose()
      }
      // The store is per-plugin and unexported; drop every snapshot on unload.
      snapshots.clear()
      security.reset()
    }
  })
}

/**
 * Best-effort bridge to dsh `session/disposed`. The plugin intentionally does
 * not hard-depend on `@deepseek-ai/dsh-session`, so the listener is attached
 * through a structural view of the Cordis context; a host without that event
 * simply gets no callback and still has TTL + per-session scope isolation.
 */
export function attachSessionCleanup(
  ctx: Context,
  snapshots: SessionSnapshotStore,
  audit: AehAuditLog,
): () => void {
  const on = (
    ctx as unknown as {
      on?: (
        event: string,
        listener: (...args: unknown[]) => void,
      ) => (() => void) | void
    }
  ).on
  if (typeof on !== 'function') return () => {}
  const off = on.call(ctx, 'session/disposed', (...args: unknown[]) => {
    const session = args[0] as { readonly id?: unknown } | undefined
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const removed = snapshots.endSession(sessionId)
    if (removed > 0) {
      audit.append({
        kind: 'session.cleanup',
        action: 'session.disposed',
        outcome: 'accepted',
        detail: { removed },
      })
    }
  })
  return typeof off === 'function' ? off : () => {}
}

export { MINIMAL_PERMISSIONS, permissionSummary } from './permissions.ts'
export { createEducationTools } from './tools.ts'
export {
  AehEducationService,
  NO_HOST_CONTEXT,
  createEducationService,
  normalizeConfig,
  type HostContext,
  type RetrievalCandidateDecision,
  type RetrievalGatePlan,
  type RetrievalGateRejection,
} from './service.ts'
export {
  AEH_CONFIG_SCHEMA,
  ConfigValidationError,
  gateModeSchema,
  resolveAehConfig,
  resolveSecurityConfig,
  type PluginProfile,
  type ResolvedAehConfig,
  type ResolvedSecurityConfig,
} from './config.ts'
export {
  DEFAULT_RATE_LIMITS,
  DEFAULT_SECURITY_LIMITS,
  SECURITY_ERROR_CODES,
  SecurityError,
  SecurityGuard,
  extractStudentRef,
  redactMessage,
  redactThrown,
  type RateLimitPolicy,
  type SecurityCallContext,
  type SecurityErrorCode,
  type SecurityGuardOptions,
  type SecurityLimits,
} from './security.ts'
export {
  AUDIT_EVENT_KINDS,
  AehAuditLog,
  type AuditEventKind,
  type AuditMetrics,
  type AuditRecord,
  type AuditRecordInput,
} from './host/audit-log.ts'
export {
  DEFAULT_SESSION_SNAPSHOT_TTL_MS,
  SessionScopeError,
  SessionSnapshotStore,
  scopeFromExecution,
  type SessionScope,
  type SessionSnapshotInput,
  type SessionSnapshotRecord,
  type SessionSnapshotStoreOptions,
} from './host/session-state.ts'
export {
  StudentTwin,
  TwinCheckpoint,
  HYPOTHESIS_OPS,
  CheckpointNotFoundError,
  CalibrationApprovalRequired,
  HypothesisBindingError,
} from './core/twin.ts'
export { allow, allowedKcs } from './core/curriculum-gate.ts'
export {
  BASELINE_PARAMETER_VERSION,
  MEMORY_PARAMETER_NAMES,
  MemoryParameters,
  aggregateMemory,
  applyForgetting,
  intervalForTarget,
  memoryHealth,
  retrievability,
  updateMemory,
} from './core/memory.ts'
export {
  ACTIVE,
  ARCHIVED,
  MERGED,
  PRUNED,
  SPLIT,
  CHANCE_LIKELIHOOD,
  DEFAULT_UNKNOWN_PRIOR,
  DEFAULT_SNAPSHOT_TTL_MS,
  SNAPSHOT_SCHEMA_VERSION,
  SPAWN_CONFLICTING_EVIDENCE,
  SPAWN_DIVERSITY_COLLAPSE,
  SPAWN_NEW_QUESTION_TYPE,
  SPAWN_NEW_SUBJECT_SCOPE,
  SPAWN_UNEXPLAINED_STEP,
  UNKNOWN_CONTRADICTED,
  UNKNOWN_LOW_EXPLANATORY_POWER,
  UNKNOWN_MISSING_EVIDENCE,
  UNKNOWN_NO_CANDIDATE,
  UNKNOWN_NO_EXPLANATION,
  UNKNOWN_PRUNED_WEAK,
  HypothesisPersistenceError,
  HypothesisScopeError,
  HypothesisSet,
  HypothesisSnapshotStore,
  hypothesisSimilarity,
  makeHypothesis,
} from './core/hypothesis.ts'
export type {
  BehaviorObservation,
  FidelityMetrics,
  GenerateOptions,
  Hypothesis,
  HypothesisMatch,
  HypothesisScope,
  HypothesisSnapshot,
  HypothesisSnapshotStoreOptions,
  MatchStat,
  MergeIndistinguishableOptions,
} from './core/hypothesis.ts'
export {
  BackwardTraceError,
  DEFAULT_CONTRADICTION_DECAY,
  DEFAULT_DEPTH_DECAY,
  DEFAULT_MAX_TRACE_DEPTH,
  DEFAULT_PROBE_WEIGHTS,
  DEFAULT_SLIP_BOOST,
  DEFAULT_SLIP_THRESHOLD,
  DEFAULT_TRACE_UNKNOWN_PRIOR,
  DiagnosisSession,
  DiagnosisStateError,
  STATE_AWAITING_ANSWER,
  STATE_IDLE,
  STATE_TERMINATED,
  STATE_UPDATED,
  TERMINATION_BURDEN_LIMIT,
  TERMINATION_EXPLICIT,
  TERMINATION_MAX_QUESTIONS,
  TERMINATION_NO_PROBE,
  TERMINATION_RESOLVED,
  TERMINATION_STUDENT_SKIPPED,
  TRACE_MISCONCEPTION,
  TRACE_PREREQUISITE_GAP,
  TRACE_SLIP,
  candidateFromInput,
  entropy,
  expectedInformationGain,
  explanationToHypothesis,
  isIsolatedError,
  localizeFirstDeviation,
  makeTraceGraph,
  orderSteps,
  posteriorAfter,
  predictiveUncertainty,
  probeWeightsFromInput,
  scoreCandidate,
  selectProbe,
  shouldTerminate,
  traceBackward,
  traceToHypotheses,
} from './core/diagnosis.ts'
export type {
  BackwardTrace,
  BurdenBudget,
  BurdenState,
  DiagnosisSessionOptions,
  DiagnosisTransition,
  DiagnosisUpdate,
  DiagnosticCandidate,
  MisconceptionRule,
  ProbeSelection,
  ProbeWeights,
  RuleNode,
  SolutionStep,
  TerminationOptions,
  TraceExplanation,
  TraceGraph,
  TraceGraphInput,
  TraceOptions,
} from './core/diagnosis.ts'
export {
  ACTION_ANSWER_DIRECTLY,
  ACTION_ASK_DIAGNOSTIC_QUESTION,
  ACTION_ASSIGN_TARGETED_PRACTICE,
  ACTION_ASSIGN_TRANSFER_TASK,
  ACTION_GIVE_MINIMAL_HINT,
  ACTION_METHODS,
  ACTION_MINUTES,
  ACTION_NONE,
  ACTION_REQUEST_PROGRESS_CONFIRMATION,
  ACTION_SCHEDULE_SPACED_REVIEW,
  ACTION_SHOW_WORKED_EXAMPLE,
  ACTION_TEACH_MICRO_LESSON,
  ALL_STRATEGY_SOURCES,
  BASE_GUARDRAILS,
  DAILY_PHASES,
  DEFAULT_INTERLEAVING_MASTERY,
  DEFAULT_MASTERY_FLOOR,
  DEFAULT_PROCEDURAL_ERROR_THRESHOLD,
  DEFAULT_REVIEW_TARGET_RETENTION,
  DEFAULT_SUBJECT_REGISTRY,
  IMPLEMENTED_METHOD_IDS,
  LEARNING_SCIENCE_METHODS,
  MATH_SUBJECT,
  METHODS_BY_ID,
  PHYSICS_SUBJECT,
  PHASE_AI_REINFORCEMENT,
  PHASE_PREVIEW,
  PHASE_REVIEW,
  PHASE_SCHOOL,
  PURPOSE_PRODUCTION,
  PURPOSE_SIMULATION,
  REAL_STRATEGY_SOURCES,
  SOURCE_OBSERVED,
  SOURCE_SCHOOL_CONFIRMED,
  SOURCE_SIMULATED,
  SOURCE_TEACHER_CONFIRMED,
  STRATEGY_ACTIONS,
  SubjectAdapter,
  SubjectAdapterError,
  SubjectRegistry,
  TeachingStrategyError,
  crossSubjectContract,
  dueReviewIntervalDays,
  dueReviewRetrievability,
  learningScienceChecklist,
  methodById,
  methodsForAction,
  normalizeDueReview,
  normalizeKnowledgeState,
  normalizeLearnerConstraints,
  normalizePracticeUnit,
  normalizeSchoolContext,
  normalizeStrategyRequest,
  normalizeSubjectEvidence,
  planDailyCoordination,
  planInterleavedPractice,
  planRetrievalPractice,
  planSpacedReview,
  schoolPreviewKcs,
  schoolProgressUsable,
  selectStrategy,
} from './core/teaching-strategy.ts'
export type {
  BreakPreference,
  DailyCoordinationRequest,
  DailyPhase,
  DailyPhasePlan,
  DailyPlan,
  DueReview,
  DueReviewInput,
  InterleavingPlan,
  KnowledgeState,
  KnowledgeStateInput,
  LearnerConstraints,
  LearnerConstraintsInput,
  LearningScienceMethod,
  PracticeUnit,
  PracticeUnitInput,
  RetrievalPlan as TeachingRetrievalPlan,
  SchoolContext,
  SchoolContextInput,
  SpacedReviewPlan,
  SpacedReviewSlot,
  StrategyAction,
  StrategyDecision,
  StrategyPurpose,
  StrategyRequest,
  SubjectAdaptation,
  SubjectAdapterSpec,
  SubjectEvidence,
  SubjectEvidenceInput,
  TaskIntent,
  Urgency,
} from './core/teaching-strategy.ts'
export { validatePackage, deliver } from './core/exercise.ts'

export {
  ApprovalLedger,
  DeliveryDeniedError,
  HostDeliveryAdapter,
  type HostApprovalRecord,
  type HostDeliveryReceipt,
} from './host/delivery.ts'
export {
  CONSENT_SCOPES,
  ConsentError,
  ConsentSnapshot,
  type ConsentGrant,
  type ConsentScope,
  type ConsentSnapshotView,
} from './host/consent.ts'
export {
  HostAuthorizationError,
  MemoryHostContext,
  type AuthorizedSessionSnapshot,
  type MemoryHostContextOptions,
} from './host/host-context.ts'
export {
  IdempotencyConflictError,
  MemoryHostTwin,
  type AttestationVerifier,
  type HostAuditEntry,
  type MemoryHostTwinOptions,
  type SourceAttestation,
  type TwinAppendResult,
  type TwinRollbackResult,
} from './host/twin-adapter.ts'
export {
  FileEventStore,
  FileEventStoreConfigError,
  FileEventStoreDisabledError,
  FileEventStoreIntegrityError,
  FileStoreConsentError,
  type DeletionTombstone,
  type FileEventStoreOptions,
  type PersistedEventRecord,
} from './host/file-event-store.ts'
export {
  AGGREGATE_KINDS,
  AUDIENCES,
  AUDIENCE_GUARDIAN,
  AUDIENCE_TEACHER,
  DEFAULT_AUDIENCE_SCOPES,
  ReportError,
  effectiveScopes,
  generateReport,
  reportToDict,
  reportToMarkdown,
  type AggregateEvent,
  type AggregateEventInput,
  type Audience,
  type LearningReport,
  type ReportTopic,
} from './report.ts'
export {
  ALLOWED_IMPACT_SCOPES,
  AUDIT_FORBIDDEN_KEYS,
  ApprovalDeniedError,
  AuditError,
  CANDIDATE_KINDS,
  CANDIDATE_SOURCES,
  CANDIDATE_STATUSES,
  CanaryDeniedError,
  CandidateRegistry,
  CandidateValidationError,
  DEFAULT_CANARY_CONDITIONS,
  DEFAULT_PROMOTION_POLICY,
  DuplicateCandidateError,
  EVOLUTION_ACTIONS,
  EvolutionAuditLog,
  EvolutionControlPlane,
  EvolutionError,
  HOST_ROLES,
  IsolatedSandbox,
  LifecycleError,
  PRODUCTION_MUTATION_ENABLED,
  PROTECTED_INVARIANTS,
  ProtectedInvariantError,
  REAL_SOURCES,
  RollbackDeniedError,
  SANDBOX_HAS_PRODUCTION_ACCESS,
  SYNTHETIC_FIXTURES_ONLY,
  isHostActor,
  type Actor,
  type ApprovalRecord,
  type AuditEntry,
  type AuditAppendInput,
  type Candidate,
  type CandidateKind,
  type CandidateRecord,
  type CandidateStatus,
  type CanaryConditions,
  type CanaryObservation,
  type CanaryObservationResult,
  type CanaryState,
  type EvaluationVerdict,
  type EvolutionAction,
  type FrozenEvalDataset,
  type HostRole,
  type PromotionPolicy,
  type RealTransferEvidence,
  type RealTransferSummary,
  type RollbackEvent,
  type SimulatedBenefitSummary,
  type SimulatedEvidence,
} from './host/evolution.ts'

export {
  EDGE_STATUSES,
  ITEM_TYPES,
  ItemBank,
  KnowledgeGraph,
  KnowledgeGraphStore,
  NODE_TYPES,
  RELATION_TYPES,
  REVIEW_DECISIONS,
  REVIEW_STATUSES,
  annotationIsComplete,
  annotationToCurriculumItem,
  canonicalJson,
  contentHash,
  missingAnnotationFields,
  normalizeItemAnnotation,
  normalizeRetrievalQuery,
  planRetrieval,
  prerequisiteDiagnostics,
  type AddItemOptions,
  type GraphDiff,
  type GraphEdge,
  type GraphEdgeInput,
  type GraphNode,
  type GraphNodeInput,
  type ItemAnnotation,
  type ItemAnnotationInput,
  type ItemRecord,
  type ItemReviewRecord,
  type ItemType,
  type ItemVersion,
  type KnowledgeGraphInput,
  type KnowledgeGraphSnapshot,
  type PrerequisiteDiagnostics,
  type QMatrixEntry,
  type RetrievalCandidate,
  type RetrievalHit,
  type RetrievalPlan,
  type RetrievalQuery,
  type RetrievalQueryInput,
  type RetrievalRejection,
  type ReviewDecision,
  type ReviewStatus,
} from './core/curriculum-graph.ts'

export {
  BRANCH_ABNORMAL_PRESSURE,
  BRANCH_CONTENT_REJECTED,
  BRANCH_CURRICULUM_GATE_REJECTED,
  BRANCH_HYPOTHESES_ALL_MISMATCHED,
  BRANCH_LOW_CONFIDENCE_STRATEGY,
  BRANCH_OCR_UNCERTAIN,
  BRANCH_RAG_SOURCE_MISSING,
  BRANCH_SCHOOL_PROGRESS_UNCLEAR,
  BRANCH_SIMULATION_TIMEOUT,
  BRANCH_SPARSE_MEMORY_DATA,
  BRANCH_STUDENT_REFUSES_DIAGNOSIS,
  BundleStore,
  CONTENT_APPROVED,
  CONTENT_DRAFT,
  CONTENT_RETIRED,
  CONTENT_REVIEW_STATES,
  ContentLibraryService,
  ContentRecord,
  ConflictError,
  DEFAULT_MAX_REJECTIONS,
  DEFAULT_REFERENCE_ACCURACY,
  DOMAIN_OBSERVED,
  DOMAIN_SIMULATED,
  EVENT_ANSWER_REVISED_AFTER_HINT,
  EVENT_ASSESSMENT_GRADED,
  EVENT_CURRICULUM_GATE_REJECTED,
  EVENT_DIAGNOSTIC_PROBE_SELECTED,
  EVENT_EDU_CAPABILITY_VERSION_CHANGED,
  EVENT_EDU_PLUGIN_LOADED,
  EVENT_EDU_PLUGIN_PERMISSION_DENIED,
  EVENT_EDU_PLUGIN_UNLOADED,
  EVENT_EVOLUTION_CANARY_STARTED,
  EVENT_EVOLUTION_CANDIDATE_REJECTED,
  EVENT_EVOLUTION_CANDIDATE_SANDBOXED,
  EVENT_EVOLUTION_DRIFT_ALERTED,
  EVENT_EVOLUTION_HUMAN_APPROVED,
  EVENT_EVOLUTION_OFFLINE_EVALUATED,
  EVENT_EVOLUTION_PROMOTED,
  EVENT_EVOLUTION_PROPOSAL_CREATED,
  EVENT_EVOLUTION_ROLLED_BACK,
  EVENT_HINT_REQUESTED,
  EVENT_HYPOTHESIS_ARCHIVED,
  EVENT_HYPOTHESIS_CREATED,
  EVENT_HYPOTHESIS_MERGED,
  EVENT_HYPOTHESIS_SPLIT,
  EVENT_INDEPENDENT_ATTEMPT,
  EVENT_INTERVENTION_DELIVERED,
  EVENT_INTERVENTION_SELECTED,
  EVENT_MEMORY_MODEL_REFITTED,
  EVENT_QUALITY_REVIEW_REQUESTED,
  EVENT_QUESTION_IMAGE_UPLOADED,
  EVENT_REVIEW_COMPLETED,
  EVENT_REVIEW_DUE,
  EVENT_SCHOOL_LESSON_REPORTED,
  EVENT_SCHOOL_PROGRESS_CONFIRMED,
  EVENT_SCHEMA_VERSION,
  EVENT_SIMULATION_COMPLETED,
  EVENT_SIMULATION_STARTED,
  EVENT_SOURCES,
  EVENT_STUDENT_TRACE_SUBMITTED,
  EVENT_TEACHER_FEEDBACK_SUBMITTED,
  EVENT_TWIN_RECALCULATED,
  EVENT_TYPES,
  EVENT_UNSEEN_TRANSFER_ATTEMPTED,
  EVENT_USER_QUESTION_SUBMITTED,
  EVAL_SPLITS,
  EXCEPTION_BRANCHES,
  EvaluationService,
  EventDraft,
  EventStore,
  FileBundleStore,
  FileContentLibrary,
  FileEvaluationService,
  FileProfileStore,
  HarnessStateMachine,
  InMemoryBundleStore,
  InMemoryContentLibrary,
  InMemoryEvaluationService,
  InMemoryEventStore,
  InMemoryProfileStore,
  IntegrityError,
  InvalidTransitionError,
  IsolationViolationError,
  LEARNING_STATES,
  MAX_PAYLOAD_CHARS,
  NotFoundError,
  OptimisticConcurrencyError,
  PROVENANCE_SYNTHETIC,
  ProfileBundle,
  ProfileStore,
  STAGES,
  STORAGE_DOMAINS,
  STATE_ABORTED,
  STATE_ASSESS,
  STATE_AWAIT_STUDENT,
  STATE_CANDIDATE_RANKING,
  STATE_COMPLETED,
  STATE_CONTENT_VALIDATION,
  STATE_CURRICULUM_GATE,
  STATE_DELIVER,
  STATE_DIAGNOSE,
  STATE_EVIDENCE_PARSE,
  STATE_EXERCISE_EVOLUTION,
  STATE_FAILED,
  STATE_HYPOTHESIS_UPDATE,
  STATE_INTAKE,
  STATE_NEED_CLARIFICATION,
  STATE_PREVIEW_PLANNER,
  STATE_PROBE,
  STATE_PROGRESS_CHECK,
  STATE_RECALL_SCHEDULE,
  STATE_REVIEW_RESCHEDULE,
  STATE_SIMULATION_LAB,
  STATE_STATE_COMMIT,
  STATE_STATE_LOAD,
  SelfProofError,
  ServiceError,
  SplitIsolationError,
  StateMachineError,
  StudentProfile,
  TERMINAL_STATES,
  TRANSITIONS,
  ValidationError,
  WriteCoordinator,
  contentDigest,
  createFrozenEvalSet,
  createRealOutcome,
  exceptionBranch,
  normalizePayload,
  runEvaluationProtocol,
  utcNow,
  type AppendOptions,
  type AppendResult,
  type ContentPutOptions,
  type ContentRecordInput,
  type ContentReviewState,
  type EvalItem,
  type EvalSplit,
  type EvaluationResultView,
  type EvaluationRun,
  type EventDraftInput,
  type EventSource,
  type EventStoreOptions,
  type ExceptionBranch,
  type FrozenEvalSet,
  type LearningEventData,
  type Payload,
  type ProfileBundleInput,
  type RealOutcome,
  type RealTransferView,
  type Scalar,
  type SimulatedBenefitView,
  type SimulatedOutcome,
  type Stage,
  type StateMachineSnapshot,
  type StorageDomain,
  type StudentProfileInput,
  type TransitionRecord,
} from './core/services.ts'
