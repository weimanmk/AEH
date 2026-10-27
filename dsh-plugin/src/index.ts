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
export { StudentTwin } from './core/twin.ts'
export { allow, allowedKcs } from './core/curriculum-gate.ts'
export {
  retrievability,
  intervalForTarget,
  updateMemory,
} from './core/memory.ts'
export { HypothesisSet } from './core/hypothesis.ts'
export { selectProbe } from './core/diagnosis.ts'
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
