/**
 * Model-facing education tools.
 *
 * Six narrow tools are exposed in the default profile. Every one is
 * read/compute-only from the host's perspective: it returns a decision, a
 * schedule, a prepared package, or an aggregate report, never a database write
 * or a delivered question. The long-term twin has no model-facing write tool.
 */

import {
  defineTool,
  renderJson,
  throwIfAborted,
  type AehToolExec,
  type ToolDefinition,
} from './dsh.ts'
import {
  AUDIENCES,
  generateReport,
  reportToDict,
  type AggregateEventInput,
  type Audience,
} from './report.ts'
import {
  gateDecisionOutputSchema,
  hypothesisResultOutputSchema,
  preparedInterventionOutputSchema,
  probePlanOutputSchema,
  reportOutputSchema,
  reviewOutputSchema,
} from './output-schemas.ts'
import { HypothesisError } from './domain.ts'
import type {
  AehAuditLog,
} from './host/audit-log.ts'
import {
  scopeFromExecution,
  SessionSnapshotStore,
  type SessionSnapshotRecord,
} from './host/session-state.ts'
import {
  SecurityError,
  SecurityGuard,
  redactThrown,
} from './security.ts'
import type {
  GateMode,
  HypothesisRecord,
  HypothesisState,
  MemoryObservationInput,
  MemoryStateInput,
  ProbeWeightInput,
} from './domain.ts'
import type {
  AehEducationService,
  DiagnosticCandidateRefInput,
  InterventionPackageRefInput,
} from './service.ts'

const stringArray = { type: 'array', items: { type: 'string' } } as const
const numberRecord = { type: 'object', additionalProperties: true } as const
const jsonObject = { type: 'object', additionalProperties: true } as const

/**
 * Cooperative tool-call budget declared to the host timeout policy.
 *
 * These tools are deterministic, in-memory computations, so the budget is a
 * guardrail against a wedged host call rather than a normal latency path. Every
 * tool observes `exec.signal` at entry, which is what makes the declaration
 * honest: dsh's timeout wrapper maps its own expiry to `TOOL_TIMEOUT` only for
 * tools that promise to forward cancellation.
 */
export const AEH_TOOL_TIMEOUT_MS = 2000

const hypothesisRecordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hypothesisId: { type: 'string', required: true },
    subjectScope: stringArray,
    knowledgeAssumptions: jsonObject,
    strategyPolicy: stringArray,
    bugRules: stringArray,
    predictedObservableBehaviors: numberRecord,
    responseToIntervention: stringArray,
    weight: { type: 'number' },
    evidenceRefs: stringArray,
    uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
    status: { type: 'string' },
    parentId: { type: 'string' },
    mergedFrom: stringArray,
  },
} as const

const hypothesisStateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hypotheses: {
      type: 'array',
      items: hypothesisRecordSchema,
      required: true,
    },
    unknownWeight: { type: 'number', required: true },
  },
} as const

const diagnosticCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: {
      type: 'string',
      required: true,
      description: 'Host-catalog item id, not an inline curriculum object.',
    },
    predictions: numberRecord,
    timeMinutes: { type: 'number' },
    risk: { type: 'number' },
    cognitiveLoad: { type: 'number' },
    teachingValue: { type: 'number' },
  },
} as const

const memoryStateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    learnerRef: { type: 'string', required: true },
    memoryUnitId: { type: 'string', required: true },
    stabilityDays: { type: 'number' },
    difficulty: { type: 'number' },
    observationCount: { type: 'integer' },
    independentSuccessCount: { type: 'integer' },
    lastIndependentSuccessAt: { type: 'string' },
    uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
    modelFamily: { type: 'string' },
    modelVersion: { type: 'string' },
  },
} as const

const memoryObservationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observationId: { type: 'string', required: true },
    success: { type: 'boolean', required: true },
    independent: { type: 'boolean' },
    hintLevel: { type: 'integer' },
    kind: { type: 'string', enum: ['attempt', 'hint_followup', 'reading'] },
    transferLevel: { type: 'string', enum: ['near', 'far'] },
    occurredAt: { type: 'string' },
  },
} as const

const interventionPackageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    packageId: { type: 'string', required: true },
    objectiveId: { type: 'string', required: true },
    trainingItemIds: {
      ...stringArray,
      required: true,
      description: 'Host-catalog training item ids.',
    },
    transferItemIds: {
      ...stringArray,
      description: 'Host-catalog unseen transfer item ids.',
    },
    hintLadder: stringArray,
    feedbackTemplates: jsonObject,
    explanationResources: stringArray,
    completionCriteria: jsonObject,
    requiredKcs: stringArray,
    independentTransfer: { type: 'boolean' },
    schoolMode: { type: 'string', enum: ['preview', 'learn', 'review'] },
  },
} as const

/**
 * Aggregate report event schema.
 *
 * `additionalProperties: false` keeps raw question/answer/image/payload fields
 * out of the tool boundary at schema-compile time; `report.ts` re-checks the
 * field allow-list at runtime so the boundary does not depend on the schema
 * engine. `aggregateRef` is an opaque aggregate-batch reference used only for
 * de-duplication; it is not a raw learning-event id and is never rendered.
 */
const reportEventSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    aggregateRef: { type: 'string', required: true },
    studentRef: { type: 'string', required: true },
    occurredAt: { type: 'string', required: true },
    kind: {
      type: 'string',
      required: true,
      enum: [
        'attempt_aggregate',
        'review_aggregate',
        'diagnosis_aggregate',
        'intervention_aggregate',
      ],
    },
    consentScope: { type: 'string', required: true },
    kcId: { type: 'string', required: true },
    attempts: { type: 'integer' },
    independentCorrect: { type: 'integer' },
    hintedCorrect: { type: 'integer' },
    hintsRequested: { type: 'integer' },
    reviewsDue: { type: 'integer' },
    reviewsCompleted: { type: 'integer' },
    minutes: { type: 'number' },
  },
} as const

interface GateToolArgs {
  readonly mode: GateMode
  readonly itemId: string
  readonly studentRef: string
}

interface HypothesisToolArgs {
  /** Required unless `snapshotRef` loads the previous session snapshot. */
  readonly state?: HypothesisState
  /** Session-scoped snapshot reference returned by a previous call. */
  readonly snapshotRef?: string
  readonly operation: 'snapshot' | 'spawn' | 'split' | 'merge' | 'prune' | 'reweight'
  readonly hypothesis?: HypothesisRecord
  readonly weight?: number
  readonly hypothesisId?: string
  readonly children?: readonly HypothesisRecord[]
  readonly hypothesisIds?: readonly string[]
  readonly merged?: HypothesisRecord
  readonly likelihoods?: Readonly<Record<string, number>>
  readonly noise?: number
  readonly evidenceRef?: string
  readonly unknownPrior?: number
  readonly unknownLikelihood?: number
  readonly reason?: string
}

interface ProbeToolArgs {
  readonly candidates: readonly DiagnosticCandidateRefInput[]
  readonly weights: Readonly<Record<string, number>>
  readonly studentRef: string
  readonly mode: GateMode
  readonly probeWeights?: ProbeWeightInput
  readonly skipped?: boolean
  readonly minScore?: number
}

interface ReviewToolArgs {
  readonly state: MemoryStateInput
  readonly observations?: readonly MemoryObservationInput[]
  readonly targetRetention?: number
}

interface InterventionToolArgs {
  readonly package: InterventionPackageRefInput
  readonly studentRef: string
  readonly mode?: GateMode
}

interface ReportToolArgs {
  readonly audience: Audience
  readonly studentRef: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly events: readonly AggregateEventInput[]
  readonly authorizedScopes?: readonly string[]
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new TypeError(`${name} is required for this operation`)
  }
  return value
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return name
  }
  return 'AEH_TOOL_ERROR'
}

function auditStudentRef(args: unknown): string | undefined {
  const studentRef = (args as { studentRef?: unknown } | undefined)?.studentRef
  return typeof studentRef === 'string' && studentRef.length > 0
    ? studentRef
    : undefined
}

/**
 * Wrap one definition so every tool call is screened and audited.
 *
 * Order matters: the cooperative abort check runs first, then the Step 8
 * security guard (rate limit, payload bounds, injection/privilege screen), and
 * only then the tool body. A rejected call is recorded in the append-only audit
 * log with reason codes and never with the raw argument text; a non-security
 * error keeps its class and gets a redacted message before it propagates.
 */
function withSecurityAndAudit(
  tool: ToolDefinition,
  audit: AehAuditLog | undefined,
  tenantRef: string | undefined,
  security: SecurityGuard | undefined,
): ToolDefinition {
  const inner = tool.execute
  return {
    ...tool,
    async execute(args: unknown, exec?: AehToolExec) {
      const studentRef = auditStudentRef(args)
      try {
        throwIfAborted(exec)
        security?.guard(tool.name, args, {
          sessionId: scopeFromExecution(exec)?.sessionId,
          studentRef,
        })
        const value = await inner(args, exec)
        audit?.recordToolCall({
          tool: tool.name,
          outcome: 'accepted',
          studentRef,
          tenantRef,
        })
        return value
      } catch (error) {
        redactThrown(error)
        if (error instanceof SecurityError) {
          audit?.recordToolCall({
            tool: tool.name,
            outcome: 'rejected',
            reasonCodes: [error.code, ...error.reasonCodes],
            detail: { rejectedBy: 'security' },
            studentRef,
            tenantRef,
          })
        } else {
          audit?.recordToolCall({
            tool: tool.name,
            outcome: 'rejected',
            reasonCode: errorCode(error),
            studentRef,
            tenantRef,
          })
        }
        throw error
      }
    },
  }
}

function applyHypothesisOperation(
  service: AehEducationService,
  state: HypothesisState,
  args: HypothesisToolArgs,
) {
  switch (args.operation) {
    case 'snapshot':
      return service.manageHypotheses(state, { kind: 'snapshot' })
    case 'spawn':
      return service.manageHypotheses(state, {
        kind: 'spawn',
        hypothesis: requireValue(args.hypothesis, 'hypothesis'),
        weight: args.weight,
      })
    case 'split':
      return service.manageHypotheses(state, {
        kind: 'split',
        hypothesisId: requireValue(args.hypothesisId, 'hypothesisId'),
        children: requireValue(args.children, 'children'),
      })
    case 'merge':
      return service.manageHypotheses(state, {
        kind: 'merge',
        hypothesisIds: requireValue(args.hypothesisIds, 'hypothesisIds'),
        merged: requireValue(args.merged, 'merged'),
      })
    case 'prune':
      return service.manageHypotheses(state, {
        kind: 'prune',
        hypothesisId: requireValue(args.hypothesisId, 'hypothesisId'),
        reason: args.reason,
      })
    case 'reweight':
      return service.manageHypotheses(state, {
        kind: 'reweight',
        likelihoods: requireValue(args.likelihoods, 'likelihoods'),
        noise: args.noise,
        evidenceRef: args.evidenceRef,
        unknownPrior: args.unknownPrior,
        unknownLikelihood: args.unknownLikelihood,
      })
  }
}

export interface EducationToolOptions {
  /** Optional append-only audit sink for tool calls and gate decisions. */
  readonly audit?: AehAuditLog
  /** Optional session/agent-scoped short-term hypothesis snapshot store. */
  readonly snapshots?: SessionSnapshotStore
  /** Step 8: per-mount argument/rate guard. */
  readonly security?: SecurityGuard
}

/** Build the six tool definitions for one plugin instance. */
export function createEducationTools(
  service: AehEducationService,
  options: EducationToolOptions = {},
): readonly ToolDefinition[] {
  const { audit, snapshots, security } = options
  const definitions: ToolDefinition[] = [
    defineTool({
      name: 'aeh_check_curriculum',
      timeoutMs: AEH_TOOL_TIMEOUT_MS,
      description:
        'Fail-closed curriculum gate for one host-catalog item id, authorised student reference, and mode (preview/learn/review). Returns allowed plus machine-readable refusal reasons. It never delivers the item; missing annotations, low confidence, untaught KCs, future methods, an unknown mode, or an exhausted load budget reject the candidate. The model cannot override the gate.',
      parameters: {
        mode: {
          type: 'string',
          required: true,
          enum: ['preview', 'learn', 'review'],
          description: 'Curriculum mode for this candidate.',
        },
        itemId: {
          type: 'string',
          required: true,
          description:
            'Host-catalog item id; annotations resolve from the host, not the model.',
        },
        studentRef: {
          type: 'string',
          required: true,
          description: 'Opaque authorised student reference for this session.',
        },
      },
      output: { schema: gateDecisionOutputSchema, render: renderJson },
      async execute(raw, exec) {
        throwIfAborted(exec)
        const args = raw as GateToolArgs
        const decision = service.checkCurriculumFor(
          args.studentRef,
          args.itemId,
          args.mode,
        )
        audit?.recordGateDecision({
          studentRef: args.studentRef,
          tenantRef: service.tenantRef,
          itemId: decision.itemId,
          mode: decision.mode,
          allowed: decision.allowed,
          reasons: decision.reasons,
        })
        return {
          ...decision,
          policy: 'aeh.curriculum_gate.v1',
        }
      },
    }),

    defineTool({
      name: 'aeh_update_hypotheses',
      timeoutMs: AEH_TOOL_TIMEOUT_MS,
      description:
        'Apply one session-scoped virtual-student hypothesis operation (snapshot, spawn, split, merge, prune, or Bayesian reweight with noise) to a supplied snapshot and return the normalised next snapshot plus weights. Pure state: it writes no long-term evidence, no database, and no observed twin state. The unknown bucket is always represented.',
      parameters: {
        state: {
          ...hypothesisStateSchema,
          description:
            'Current session hypothesis snapshot; omit when snapshotRef is supplied.',
        },
        snapshotRef: {
          type: 'string',
          description:
            'Session/agent-scoped snapshot reference from a previous call. Loaded only for the same dsh session; an unknown, foreign, or expired reference fails closed.',
        },
        operation: {
          type: 'string',
          required: true,
          enum: ['snapshot', 'spawn', 'split', 'merge', 'prune', 'reweight'],
          description: 'Operation to apply.',
        },
        hypothesis: {
          ...hypothesisRecordSchema,
          description: 'For spawn: the new hypothesis.',
        },
        weight: { type: 'number', description: 'For spawn: optional initial weight.' },
        hypothesisId: {
          type: 'string',
          description: 'For split/prune: the target hypothesis id.',
        },
        children: {
          type: 'array',
          items: hypothesisRecordSchema,
          description: 'For split: at least two distinguishable children.',
        },
        hypothesisIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'For merge: at least two source hypothesis ids.',
        },
        merged: {
          ...hypothesisRecordSchema,
          description: 'For merge: the merged hypothesis.',
        },
        likelihoods: {
          type: 'object',
          additionalProperties: true,
          description: 'For reweight: P(E | H_i) for active hypotheses.',
        },
        noise: { type: 'number', description: 'For reweight: noise in [0, 1].' },
        evidenceRef: {
          type: 'string',
          description: 'For reweight: opaque session evidence reference.',
        },
        unknownPrior: { type: 'number', description: 'For reweight: unknown prior mass.' },
        unknownLikelihood: {
          type: 'number',
          description: 'For reweight: P(E | unknown).',
        },
        reason: { type: 'string', description: 'For prune: audit reason.' },
      },
      output: { schema: hypothesisResultOutputSchema, render: renderJson },
      async execute(raw, exec) {
        throwIfAborted(exec)
        const args = raw as HypothesisToolArgs
        const scope = scopeFromExecution(exec)

        let state = args.state
        if (args.snapshotRef !== undefined) {
          if (args.state !== undefined) {
            throw new HypothesisError(
              'provide either a state snapshot or a snapshotRef, not both',
            )
          }
          if (scope === undefined || snapshots === undefined) {
            throw new HypothesisError(
              'snapshot_ref_requires_session_scope',
            )
          }
          const loaded: SessionSnapshotRecord | undefined = snapshots.get(
            args.snapshotRef,
            scope,
          )
          if (loaded === undefined) {
            throw new HypothesisError('snapshot_not_found_or_expired')
          }
          state = loaded.state
        }
        if (state === undefined) {
          throw new HypothesisError(
            'a state snapshot or snapshotRef is required',
          )
        }

        const result = applyHypothesisOperation(service, state, args)
        if (scope === undefined || snapshots === undefined) return result

        const stored = snapshots.put(scope, {
          state: result.state,
          weights: result.weights,
          dominantId: result.dominantId,
          transitions: result.transitions,
        })
        return {
          ...result,
          snapshotRef: stored.snapshotRef,
          snapshotExpiresAt: stored.expiresAt,
          snapshotTtlMs: snapshots.ttl,
          snapshotScope: { sessionScoped: true, agentScoped: true },
        }
      },
    }),

    defineTool({
      name: 'aeh_select_probe',
      timeoutMs: AEH_TOOL_TIMEOUT_MS,
      description:
        'Choose the best diagnostic probe for a session. Every candidate carries only a host-catalog item id; the tool resolves trusted annotations and re-runs the fail-closed gate, so a model-supplied item annotation or "allowed" flag is not accepted. Score = information gain + teaching value - time/risk/cognitive-load penalties. Returns null when the student skips or no candidate is allowed. Nothing is asked or persisted.',
      parameters: {
        candidates: {
          type: 'array',
          items: diagnosticCandidateSchema,
          required: true,
          description:
            'Candidate host item ids with predicted correctness per hypothesis.',
        },
        weights: {
          type: 'object',
          additionalProperties: true,
          required: true,
          description: 'Hypothesis posterior weights, including unknown.',
        },
        studentRef: {
          type: 'string',
          required: true,
          description: 'Opaque authorised student reference for this session.',
        },
        mode: {
          type: 'string',
          required: true,
          enum: ['preview', 'learn', 'review'],
          description: 'Curriculum mode used to re-check every candidate.',
        },
        probeWeights: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional alpha/beta/gamma/delta policy weights.',
          properties: {
            alpha: { type: 'number' },
            beta: { type: 'number' },
            gamma: { type: 'number' },
            delta: { type: 'number' },
            zeta: { type: 'number' },
          },
        },
        skipped: {
          type: 'boolean',
          description: 'True when the student explicitly declines diagnosis.',
        },
        minScore: { type: 'number', description: 'Optional minimum score.' },
      },
      output: { schema: probePlanOutputSchema, render: renderJson },
      async execute(raw, exec) {
        throwIfAborted(exec)
        const args = raw as ProbeToolArgs
        return service.planProbeFor(
          args.candidates,
          args.weights,
          args.studentRef,
          args.mode,
          {
            probeWeights: args.probeWeights,
            skipped: args.skipped,
            minScore: args.minScore,
          },
        )
      },
    }),

    defineTool({
      name: 'aeh_schedule_review',
      timeoutMs: AEH_TOOL_TIMEOUT_MS,
      description:
        'Apply FSRS-style observations to a supplied memory state and return the updated stability/difficulty, next review interval for the target retention, and counts. Reading an explanation has zero retrieval weight; hint-assisted success is weaker than an independent unhinted first attempt. Pure computation: no database or twin write.',
      parameters: {
        state: {
          ...memoryStateSchema,
          required: true,
          description: 'Current memory state for one learner x memory unit.',
        },
        observations: {
          type: 'array',
          items: memoryObservationSchema,
          description: 'Observations to apply in order.',
        },
        targetRetention: {
          type: 'number',
          description: 'Target retention in (0, 1); defaults to plugin config.',
        },
      },
      output: { schema: reviewOutputSchema, render: renderJson },
      async execute(raw, exec) {
        throwIfAborted(exec)
        const args = raw as ReviewToolArgs
        return service.scheduleReview(
          args.state,
          args.observations ?? [],
          args.targetRetention,
        )
      },
    }),

    defineTool({
      name: 'aeh_prepare_intervention',
      timeoutMs: AEH_TOOL_TIMEOUT_MS,
      description:
        'Validate and prepare an intervention package: training items, hint ladder, feedback templates, explanation resources, independent unseen transfer items, completion criteria, and required KCs. Resolves every training/transfer id from the host catalog, then checks structure, training/transfer isolation, gate admission for every item, and seen-before transfer leakage. Returns deliveryEligible but never delivers; a host must obtain approval and re-check consent before delivery.',
      parameters: {
        package: {
          ...interventionPackageSchema,
          required: true,
          description: 'Candidate intervention package.',
        },
        studentRef: {
          type: 'string',
          required: true,
          description: 'Opaque authorised student reference for this session.',
        },
        mode: {
          type: 'string',
          enum: ['preview', 'learn', 'review'],
          description: 'Optional delivery mode override.',
        },
      },
      output: { schema: preparedInterventionOutputSchema, render: renderJson },
      async execute(raw, exec) {
        throwIfAborted(exec)
        const args = raw as InterventionToolArgs
        return service.prepareInterventionFor(
          args.package,
          args.studentRef,
          args.mode,
        )
      },
    }),

    defineTool({
      name: 'aeh_generate_report',
      timeoutMs: AEH_TOOL_TIMEOUT_MS,
      description:
        'Aggregate already-authorised aggregate events into a minimised teacher/guardian report. The input is fixed to aggregate counters (attempts, correct counts, hint/review counts, minutes) plus an opaque consent scope; there is no field for a question, answer, image, step trace, arbitrary payload, or raw learning-event id. Events for another student, outside the window, unauthorised for the audience, or duplicated are excluded and only counted. The output contains aggregate totals and topic ids, never source references. This is a reporting boundary, not an identity/consent service.',
      parameters: {
        audience: {
          type: 'string',
          required: true,
          enum: [...AUDIENCES],
          description: 'Report audience whose scope set applies.',
        },
        studentRef: {
          type: 'string',
          required: true,
          description: 'Opaque pseudonymous student reference in the report.',
        },
        windowStart: {
          type: 'string',
          required: true,
          description: 'Inclusive ISO start of the reporting window.',
        },
        windowEnd: {
          type: 'string',
          required: true,
          description: 'Exclusive ISO end of the reporting window.',
        },
        events: {
          type: 'array',
          items: reportEventSchema,
          required: true,
          description:
            'Authorised aggregate events; each carries its own consent scope.',
        },
        authorizedScopes: {
          ...stringArray,
          description:
            'Optional caller scope list; it can only narrow the audience defaults.',
        },
      },
      output: { schema: reportOutputSchema, render: renderJson },
      async execute(raw, exec) {
        throwIfAborted(exec)
        const args = raw as ReportToolArgs
        const report = generateReport(args.events ?? [], {
          audience: args.audience,
          studentRef: args.studentRef,
          windowStart: args.windowStart,
          windowEnd: args.windowEnd,
          authorizedScopes: args.authorizedScopes,
        })
        return reportToDict(report)
      },
    }),
  ]

  return definitions.map((tool) =>
    audit === undefined && security === undefined
      ? tool
      : withSecurityAndAudit(tool, audit, service.tenantRef, security),
  )
}
