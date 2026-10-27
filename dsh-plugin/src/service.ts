/**
 * Host-facing education service compiled from the Step 1 core.
 *
 * Tools are thin adapters over these methods. Keeping the service separate
 * makes the boundary explicit: the service is deterministic and in-memory, and
 * every state-changing result is returned to the caller rather than persisted.
 */

import {
  type CurriculumItem,
  type DiagnosticCandidateInput,
  type GateDecision,
  type GateMode,
  type HypothesisRecord,
  type HypothesisState,
  type InterventionPackageInput,
  type LearnerProgress,
  type MemoryObservationInput,
  type MemoryStateInput,
  type ProbeWeightInput,
} from './domain.ts'
import {
  allow,
  type GateThresholds,
} from './core/curriculum-gate.ts'
import {
  HypothesisSet,
  type ReweightOptions,
} from './core/hypothesis.ts'
import {
  candidateFromInput,
  probeWeightsFromInput,
  selectProbe,
  type DiagnosticCandidate,
  type ProbeSelection,
  type ProbeWeights,
} from './core/diagnosis.ts'
import {
  isIndependentRetrievalSuccess,
  normalizeMemoryState,
  reviewSchedule,
  retrievalWeight,
  updateMany,
} from './core/memory.ts'
import {
  packageFromInput,
  validatePackage,
} from './core/exercise.ts'
import {
  resolveAehConfig,
  type ResolvedAehConfig,
} from './config.ts'

export interface Config {
  /** `student-facing` is the only intended deployment for model tools. */
  readonly profile?: 'student-facing' | 'host-side'
  readonly targetRetention?: number
  readonly allowedModes?: readonly GateMode[]
}

/** Resolved, frozen config (same shape as the Schemastery output). */
export type ResolvedConfig = ResolvedAehConfig

/**
 * Host-owned resolution boundary.
 *
 * The model supplies opaque ids, never curriculum annotations or progress
 * claims. A real dsh adapter resolves both from the authorised session/tenant
 * context; the default context resolves nothing, so tools fail closed until the
 * host wires this in.
 */
export interface HostContext {
  /** When set, only this student reference is readable in the current session. */
  readonly authorizedStudentRef?: string
  /** Host-issued opaque tenant reference, when the adapter exposes one. */
  readonly tenantRef?: string
  resolveProgress(studentRef: string): LearnerProgress | undefined
  resolveItem(itemId: string): CurriculumItem | undefined
}

export const NO_HOST_CONTEXT: HostContext = Object.freeze({
  resolveProgress: () => undefined,
  resolveItem: () => undefined,
})

/**
 * Validate and freeze a plugin config through the Schemastery schema.
 *
 * This is the single configuration validation path: the Cordis loader uses the
 * exported `Config` schema before `apply` runs, and direct/embedded callers
 * use this function. Illegal values throw {@link ConfigValidationError} rather
 * than silently falling back to defaults.
 */
export function normalizeConfig(config: Config = {}): ResolvedConfig {
  return resolveAehConfig(config)
}

export type HypothesisOperation =
  | { readonly kind: 'snapshot' }
  | {
      readonly kind: 'spawn'
      readonly hypothesis: HypothesisRecord
      readonly weight?: number
    }
  | {
      readonly kind: 'split'
      readonly hypothesisId: string
      readonly children: readonly HypothesisRecord[]
    }
  | {
      readonly kind: 'merge'
      readonly hypothesisIds: readonly string[]
      readonly merged: HypothesisRecord
    }
  | {
      readonly kind: 'prune'
      readonly hypothesisId: string
      readonly reason?: string
    }
  | {
      readonly kind: 'reweight'
      readonly likelihoods: Readonly<Record<string, number>>
    } & ReweightOptions

export interface HypothesisOperationResult {
  readonly state: HypothesisState
  readonly weights: Readonly<Record<string, number>>
  readonly dominantId: string | null
  readonly transitions: number
}

export interface ProbePlan {
  readonly selection: ProbeSelection | null
  readonly rejected: readonly {
    readonly itemId: string
    readonly reasons: readonly string[]
  }[]
  readonly skipped: boolean
  /** Set when the host could not authorise a progress snapshot. */
  readonly blockedReason?: string
}

export interface ReviewResult {
  readonly state: Readonly<Record<string, unknown>>
  readonly nextIntervalDays: number
  readonly targetRetention: number
  readonly observationsReceived: number
  readonly independentSuccesses: number
  readonly ignoredReadingObservations: number
  readonly modelVersion: string
}

export interface PreparedIntervention {
  readonly packageId: string
  readonly valid: boolean
  readonly reasons: readonly string[]
  readonly deliveryEligible: boolean
  readonly notDelivered: true
  readonly requiresHostApproval: true
  readonly itemDecisions: Readonly<Record<string, GateDecision>>
  readonly allowedKcs: readonly string[]
}

/** Diagnostic candidate that refers to a host-catalog item by opaque id. */
export interface DiagnosticCandidateRefInput {
  readonly itemId: string
  readonly predictions?: Readonly<Record<string, number>>
  readonly timeMinutes?: number
  readonly risk?: number
  readonly cognitiveLoad?: number
  readonly teachingValue?: number
}

/** Intervention package whose items are host-catalog ids, not model-authored. */
export interface InterventionPackageRefInput {
  readonly packageId: string
  readonly objectiveId: string
  readonly trainingItemIds: readonly string[]
  readonly transferItemIds?: readonly string[]
  readonly hintLadder?: readonly string[]
  readonly feedbackTemplates?: Readonly<Record<string, string>>
  readonly explanationResources?: readonly string[]
  readonly completionCriteria?: Readonly<Record<string, unknown>>
  readonly requiredKcs?: readonly string[]
  readonly independentTransfer?: boolean
  readonly schoolMode?: GateMode
}

function deniedDecision(
  itemId: string | null,
  mode: GateMode | string,
  reason: string,
): GateDecision {
  return {
    allowed: false,
    reasons: [reason],
    allowedKcs: [],
    itemId,
    mode,
  }
}

function invalidPrepared(
  packageId: string,
  reasons: readonly string[],
): PreparedIntervention {
  return Object.freeze({
    packageId,
    valid: false,
    reasons: Object.freeze([...reasons]),
    deliveryEligible: false,
    notDelivered: true as const,
    requiresHostApproval: true as const,
    itemDecisions: Object.freeze({}),
    allowedKcs: Object.freeze([]),
  })
}

export class AehEducationService {
  readonly config: ResolvedConfig
  readonly host: HostContext

  constructor(config: Config = {}, host: HostContext = NO_HOST_CONTEXT) {
    this.config = normalizeConfig(config)
    this.host = host
  }

  /** Host-issued opaque tenant reference, when the adapter exposes one. */
  get tenantRef(): string | undefined {
    const tenantRef = this.host.tenantRef
    return typeof tenantRef === 'string' && tenantRef.length > 0
      ? tenantRef
      : undefined
  }

  /** Resolve an authorised progress snapshot; null means fail closed. */
  resolveProgress(studentRef: string): LearnerProgress | null {
    if (
      this.host.authorizedStudentRef !== undefined &&
      this.host.authorizedStudentRef !== studentRef
    ) {
      return null
    }
    return this.host.resolveProgress(studentRef) ?? null
  }

  /** Resolve trusted item annotations; null means the item is unknown. */
  resolveItem(itemId: string): CurriculumItem | null {
    return this.host.resolveItem(itemId) ?? null
  }

  /**
   * Tool-facing gate lookup. Both the progress snapshot and the item
   * annotations come from the host catalog, not from model arguments.
   */
  checkCurriculumFor(
    studentRef: string,
    itemId: string,
    mode: GateMode | string,
    thresholds: GateThresholds = {},
  ): GateDecision {
    const progress = this.resolveProgress(studentRef)
    if (progress === null) {
      return deniedDecision(itemId, mode, 'progress_unavailable')
    }
    const item = this.resolveItem(itemId)
    if (item === null) {
      return deniedDecision(itemId, mode, 'item_not_found')
    }
    return this.checkCurriculum(item, progress, mode, thresholds)
  }

  /**
   * Re-run the fail-closed gate. `mode` must also be enabled by plugin config;
   * a disabled mode is denied before the gate sees any item.
   */
  checkCurriculum(
    item: CurriculumItem,
    progress: LearnerProgress,
    mode: GateMode | string,
    thresholds: GateThresholds = {},
  ): GateDecision {
    if (!(this.config.allowedModes as readonly string[]).includes(mode)) {
      return {
        allowed: false,
        reasons: [`mode_not_enabled:${mode}`],
        allowedKcs: [],
        itemId: item.itemId ?? null,
        mode,
      }
    }
    return allow(item, progress, mode, thresholds)
  }

  /** Apply one session-scoped hypothesis operation to a supplied snapshot. */
  manageHypotheses(
    state: HypothesisState,
    operation: HypothesisOperation,
  ): HypothesisOperationResult {
    const set = HypothesisSet.fromState(state)
    switch (operation.kind) {
      case 'snapshot':
        break
      case 'spawn':
        set.spawn(operation.hypothesis, operation.weight)
        break
      case 'split':
        set.split(operation.hypothesisId, operation.children)
        break
      case 'merge':
        set.merge(operation.hypothesisIds, operation.merged)
        break
      case 'prune':
        set.prune(operation.hypothesisId, operation.reason)
        break
      case 'reweight':
        set.reweight(operation.likelihoods, {
          evidenceRef: operation.evidenceRef,
          noise: operation.noise,
          unknownPrior: operation.unknownPrior,
          unknownLikelihood: operation.unknownLikelihood,
        })
        break
    }
    const dominant = set.dominant()
    return {
      state: set.toState(),
      weights: set.weights(),
      dominantId: dominant?.hypothesisId ?? null,
      transitions: set.history.length,
    }
  }

  /**
   * Select a diagnostic probe after recomputing every candidate's gate status.
   * Callers cannot smuggle in a pre-approved `gateAllowed: true` flag.
   */
  planProbe(
    candidates: readonly DiagnosticCandidateInput[],
    weights: Readonly<Record<string, number>>,
    progress: LearnerProgress,
    mode: GateMode | string,
    options: {
      readonly probeWeights?: ProbeWeightInput
      readonly skipped?: boolean
      readonly minScore?: number
    } = {},
  ): ProbePlan {
    const diagnosed: DiagnosticCandidate[] = []
    const rejected: Array<{ itemId: string; reasons: readonly string[] }> = []
    for (const input of candidates) {
      const gate = this.checkCurriculum(input.item, progress, mode)
      if (!gate.allowed) {
        rejected.push({
          itemId: input.item.itemId,
          reasons: Object.freeze([...gate.reasons]),
        })
      }
      diagnosed.push(candidateFromInput(input, gate))
    }

    const probeWeights: ProbeWeights = probeWeightsFromInput(
      options.probeWeights,
    )
    const selection = selectProbe(diagnosed, weights, {
      probeWeights,
      skipped: options.skipped,
      minScore: options.minScore,
    })
    return {
      selection,
      rejected: Object.freeze(rejected),
      skipped: options.skipped === true,
    }
  }

  /**
   * Tool-facing probe plan: resolve every item id through the host catalog,
   * then re-run the gate. Unknown ids are reported as rejected candidates.
   */
  planProbeFor(
    candidates: readonly DiagnosticCandidateRefInput[],
    weights: Readonly<Record<string, number>>,
    studentRef: string,
    mode: GateMode | string,
    options: {
      readonly probeWeights?: ProbeWeightInput
      readonly skipped?: boolean
      readonly minScore?: number
    } = {},
  ): ProbePlan {
    const progress = this.resolveProgress(studentRef)
    if (progress === null) {
      return {
        selection: null,
        rejected: Object.freeze([]),
        skipped: options.skipped === true,
        blockedReason: 'progress_unavailable',
      }
    }

    const resolved: DiagnosticCandidateInput[] = []
    const rejected: Array<{ itemId: string; reasons: readonly string[] }> = []
    for (const input of candidates) {
      const item = this.resolveItem(input.itemId)
      if (item === null) {
        rejected.push({
          itemId: input.itemId,
          reasons: Object.freeze(['item_not_found']),
        })
        continue
      }
      const { itemId: _itemId, ...rest } = input
      resolved.push({ ...rest, item })
    }

    const plan = this.planProbe(resolved, weights, progress, mode, options)
    return {
      ...plan,
      rejected: Object.freeze([...rejected, ...plan.rejected]),
    }
  }

  /** Apply FSRS-style observations and return a schedule; nothing is stored. */
  scheduleReview(
    state: MemoryStateInput,
    observations: readonly MemoryObservationInput[],
    targetRetention?: number,
  ): ReviewResult {
    const normalized = normalizeMemoryState(state)
    const updated = updateMany(normalized, observations)
    const schedule = reviewSchedule(
      updated,
      targetRetention ?? this.config.targetRetention,
    )
    return {
      state: schedule,
      nextIntervalDays: Number(schedule.nextIntervalDays),
      targetRetention: Number(schedule.targetRetention),
      observationsReceived: observations.length,
      independentSuccesses: observations.filter(isIndependentRetrievalSuccess)
        .length,
      ignoredReadingObservations: observations.filter(
        (observation) => retrievalWeight(observation) <= 0,
      ).length,
      modelVersion: updated.modelVersion,
    }
  }

  /**
   * Validate a candidate package without delivering it. Delivery is a host
   * action guarded by consent, approval, and its own gate re-check.
   */
  prepareIntervention(
    input: InterventionPackageInput,
    progress: LearnerProgress,
    mode?: GateMode,
  ): PreparedIntervention {
    const pkg = packageFromInput(input)
    const validation = validatePackage(pkg, progress, mode)
    return Object.freeze({
      packageId: pkg.packageId,
      valid: validation.valid,
      reasons: validation.reasons,
      deliveryEligible: validation.valid,
      notDelivered: true as const,
      requiresHostApproval: true as const,
      itemDecisions: validation.itemDecisions,
      allowedKcs: validation.allowedKcs,
    })
  }

  /**
   * Tool-facing intervention preparation: resolve all item ids from the host
   * catalog first. A missing id or an unauthorised progress snapshot is a
   * fail-closed invalid result, never a partially delivered package.
   */
  prepareInterventionFor(
    input: InterventionPackageRefInput,
    studentRef: string,
    mode?: GateMode,
  ): PreparedIntervention {
    const progress = this.resolveProgress(studentRef)
    if (progress === null) {
      return invalidPrepared(input.packageId, ['progress_unavailable'])
    }

    const resolveIds = (
      ids: readonly string[],
    ): { items: CurriculumItem[]; missing: string[] } => {
      const items: CurriculumItem[] = []
      const missing: string[] = []
      for (const id of ids) {
        const item = this.resolveItem(id)
        if (item === null) missing.push(id)
        else items.push(item)
      }
      return { items, missing }
    }

    const training = resolveIds(input.trainingItemIds)
    const transfer = resolveIds(input.transferItemIds ?? [])
    const missing = [...training.missing, ...transfer.missing]
    if (missing.length > 0) {
      return invalidPrepared(
        input.packageId,
        missing.map((id) => `item_not_found:${id}`),
      )
    }

    const {
      trainingItemIds: _trainingItemIds,
      transferItemIds: _transferItemIds,
      ...rest
    } = input
    return this.prepareIntervention(
      {
        ...rest,
        trainingItems: training.items,
        transferItems: transfer.items,
      },
      progress,
      mode,
    )
  }
}

/** Convenience factory used by the plugin entry and tests. */
export function createEducationService(
  config: Config = {},
  host: HostContext = NO_HOST_CONTEXT,
): AehEducationService {
  return new AehEducationService(config, host)
}

