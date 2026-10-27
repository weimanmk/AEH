/**
 * Short-term virtual-student hypotheses (spec section 6).
 *
 * A hypothesis is a structured cognitive assumption set, not a personality
 * label. The set supports spawn / split / reweight / merge / prune and keeps
 * the posterior normalised over active hypotheses plus an explicit `unknown`
 * bucket. A single answer cannot make the posterior spuriously sharp because
 * every update includes a noise term.
 *
 * In the dsh plugin this is session-scoped, pure state. The tool layer accepts
 * a snapshot and returns the next snapshot; no hypothesis becomes long-term
 * observed evidence.
 */

import {
  HypothesisError,
  type HypothesisRecord,
  type HypothesisState,
} from '../domain.ts'

export const UNKNOWN_HYPOTHESIS_ID = 'unknown'

export const ACTIVE = 'active'
export const ARCHIVED = 'archived'
export const SPLIT = 'split'
export const MERGED = 'merged'
export const PRUNED = 'pruned'

/** Version of the JSON-friendly snapshot representation. */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** Generation triggers from spec 6.2. */
export const SPAWN_UNEXPLAINED_STEP = 'unexplained_step'
export const SPAWN_NEW_QUESTION_TYPE = 'new_question_type'
export const SPAWN_CONFLICTING_EVIDENCE = 'conflicting_evidence'
export const SPAWN_NEW_SUBJECT_SCOPE = 'new_subject_scope'
export const SPAWN_DIVERSITY_COLLAPSE = 'diversity_collapse'

/** Reasons the `unknown` bucket can grow (spec 6.2 "Unknown"). */
export const UNKNOWN_NO_CANDIDATE = 'no_candidate'
export const UNKNOWN_NO_EXPLANATION = 'no_explanation'
export const UNKNOWN_MISSING_EVIDENCE = 'missing_evidence'
export const UNKNOWN_PRUNED_WEAK = 'pruned_weak'
export const UNKNOWN_CONTRADICTED = 'contradicted'
export const UNKNOWN_LOW_EXPLANATORY_POWER = 'low_explanatory_power'

/** Likelihood of the chance level used by the noise term. */
export const CHANCE_LIKELIHOOD = 0.5
/** Default prior mass reserved for the "unknown" explanation during updates. */
export const DEFAULT_UNKNOWN_PRIOR = 0.05
/** Default snapshot lifetime (milliseconds) for the in-memory session store. */
export const DEFAULT_SNAPSHOT_TTL_MS = 15 * 60 * 1000

export interface Hypothesis {
  readonly hypothesisId: string
  readonly subjectScope: readonly string[]
  readonly knowledgeAssumptions: Readonly<Record<string, string>>
  readonly strategyPolicy: readonly string[]
  readonly bugRules: readonly string[]
  readonly predictedObservableBehaviors: Readonly<Record<string, number>>
  readonly responseToIntervention: readonly string[]
  readonly weight: number
  readonly evidenceRefs: readonly string[]
  readonly uncertainty: 'low' | 'medium' | 'high'
  readonly status: string
  readonly parentId: string | null
  readonly mergedFrom: readonly string[]
}

export interface HypothesisTransition {
  readonly kind: string
  readonly hypothesisIds: readonly string[]
  readonly detail: string
  readonly at: string
}

export interface ReweightOptions {
  readonly evidenceRef?: string
  readonly noise?: number
  readonly unknownPrior?: number
  readonly unknownLikelihood?: number
}

/** One (synthetic) observable behaviour used for matching/fidelity. */
export interface BehaviorObservation {
  readonly observationId: string
  readonly behavior: string
  readonly outcome: boolean
  readonly errorType?: string
  readonly step?: string
  readonly strategy?: string
}

/** Result of matching observations against the ensemble (spec 6.3). */
export interface HypothesisMatch {
  readonly likelihoods: Readonly<Record<string, number>>
  readonly weights: Readonly<Record<string, number>>
  readonly observedBehaviors: readonly string[]
  readonly coveredBehaviors: readonly string[]
  readonly unexplainedBehaviors: readonly string[]
}

/** Hypothesis-ensemble fidelity metrics (spec 19.3). */
export interface FidelityMetrics {
  readonly observationCount: number
  readonly covered: number
  readonly coverage: number
  readonly brierScore: number | null
  readonly logLoss: number | null
  readonly calibrationError: number | null
  readonly accuracy: number | null
  readonly unknownShare: number
  readonly effectiveHypotheses: number
  readonly maxWeight: number
  readonly errorTypeAgreement: number | null
  readonly stepAgreement: number | null
  readonly strategyAgreement: number | null
  readonly antiMismatch: number | null
  readonly sufficient: boolean
}

/** One per-hypothesis likelihood statistic used by contradiction pruning. */
export interface MatchStat {
  readonly count: number
  readonly mean: number
}

export interface MatchOptions {
  readonly evidenceRef?: string
  readonly noise?: number
  readonly unknownPrior?: number
  readonly unknownLikelihood?: number
  readonly smoothing?: number
}

export interface GenerateOptions {
  readonly behaviorThreshold?: number
  readonly minGain?: number
  readonly weight?: number
  readonly trigger?: string
}

export interface FidelityOptions {
  readonly minObservations?: number
  readonly bins?: number
  readonly recentEvidenceId?: string
}

export interface MergeIndistinguishableOptions {
  readonly similarityThreshold?: number
  readonly idFactory?: (ids: readonly string[]) => string
}

/** Session/agent scope for a short-term hypothesis snapshot. */
export interface HypothesisScope {
  readonly sessionId: string
  readonly agentId?: string
}

/**
 * A session-scoped, non-durable short-term hypothesis snapshot.
 *
 * `persistsToLongTermTwin` is always `false`: a snapshot is a transport/TTL
 * object, not an observed event.
 */
export interface HypothesisSnapshot {
  readonly snapshotId: string
  readonly sessionId: string
  readonly agentId: string | null
  readonly schemaVersion: number
  readonly createdAt: string
  readonly expiresAt: string
  readonly revision: number
  readonly boundTwinVersion: number | null
  readonly state: HypothesisState
  readonly unknownReasons: readonly string[]
  readonly needsRealEvidence: boolean
  readonly matchStats: Readonly<Record<string, MatchStat>>
  readonly persistsToLongTermTwin: false
}

export interface HypothesisSnapshotOptions {
  readonly snapshotId?: string
  readonly agentId?: string
  readonly ttlMs?: number
  readonly now?: number
}

export interface HypothesisSnapshotStoreOptions {
  readonly ttlMs?: number
  readonly now?: () => number
  readonly maxEntriesPerScope?: number
  readonly maxEntries?: number
  readonly idFactory?: () => string
}

export class HypothesisScopeError extends HypothesisError {}
export class HypothesisPersistenceError extends HypothesisError {}

function clampProbability(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new HypothesisError(`${name} must be a probability in [0, 1]`)
  }
  return value
}

function setJaccard(first: readonly string[], second: readonly string[]): number {
  const firstSet = new Set(first)
  const secondSet = new Set(second)
  if (firstSet.size === 0 && secondSet.size === 0) return 1
  let intersection = 0
  for (const value of firstSet) {
    if (secondSet.has(value)) intersection += 1
  }
  const union = firstSet.size + secondSet.size - intersection
  return union === 0 ? 1 : intersection / union
}

/** Similarity of two hypotheses on unseen-behaviour prediction + rules. */
export function hypothesisSimilarity(
  first: Hypothesis,
  second: Hypothesis,
): number {
  const keys = new Set([
    ...Object.keys(first.predictedObservableBehaviors),
    ...Object.keys(second.predictedObservableBehaviors),
  ])
  let behaviorSimilarity = 1
  if (keys.size > 0) {
    let difference = 0
    for (const key of keys) {
      const firstValue =
        first.predictedObservableBehaviors[key] ?? CHANCE_LIKELIHOOD
      const secondValue =
        second.predictedObservableBehaviors[key] ?? CHANCE_LIKELIHOOD
      difference += Math.abs(firstValue - secondValue)
    }
    behaviorSimilarity = 1 - difference / keys.size
  }
  return (
    0.6 * behaviorSimilarity +
    0.2 * setJaccard(first.bugRules, second.bugRules) +
    0.2 * setJaccard(first.strategyPolicy, second.strategyPolicy)
  )
}

function expectedCalibrationError(
  probabilities: readonly number[],
  outcomes: readonly number[],
  bins: number,
): number {
  const total = probabilities.length
  if (total === 0) return 0
  let error = 0
  for (let index = 0; index < bins; index += 1) {
    const low = index / bins
    const high = (index + 1) / bins
    const members: Array<readonly [number, number]> = []
    for (let i = 0; i < total; i += 1) {
      const probability = probabilities[i] as number
      const outcome = outcomes[i] as number
      if ((low <= probability && probability < high) ||
          (index === bins - 1 && probability === 1)) {
        members.push([probability, outcome])
      }
    }
    if (members.length === 0) continue
    const meanProbability =
      members.reduce((sum, [probability]) => sum + probability, 0) /
      members.length
    const meanOutcome =
      members.reduce((sum, [, outcome]) => sum + outcome, 0) / members.length
    error += (members.length / total) * Math.abs(meanProbability - meanOutcome)
  }
  return error
}

function agreement(
  dominant: Hypothesis | null,
  observations: readonly BehaviorObservation[],
  valueOf: (observation: BehaviorObservation) => string | undefined,
  rulesOf: (hypothesis: Hypothesis) => readonly string[],
): number | null {
  if (dominant === null || observations.length === 0) return null
  const rules = new Set(rulesOf(dominant))
  let agreed = 0
  for (const observation of observations) {
    const value = valueOf(observation)
    if (value !== undefined && rules.has(value)) agreed += 1
  }
  return agreed / observations.length
}

function assertScope(scope: HypothesisScope): HypothesisScope {
  const sessionId = scope?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new HypothesisScopeError(
      'sessionId is required for session-scoped state',
    )
  }
  if (sessionId.length > 200 || /[\r\n]/.test(sessionId)) {
    throw new HypothesisScopeError(
      'sessionId must be a short single-line reference',
    )
  }
  const agentId = scope.agentId
  if (agentId !== undefined) {
    if (
      typeof agentId !== 'string' ||
      agentId.length === 0 ||
      agentId.length > 200 ||
      /[\r\n]/.test(agentId)
    ) {
      throw new HypothesisScopeError(
        'agentId must be a short non-empty reference',
      )
    }
  }
  return agentId === undefined
    ? Object.freeze({ sessionId })
    : Object.freeze({ sessionId, agentId })
}

function scopeKey(scope: HypothesisScope): string {
  return `${scope.sessionId}\u0000${scope.agentId ?? ''}`
}

/** Build a complete hypothesis from the sparse wire representation. */
export function makeHypothesis(record: HypothesisRecord): Hypothesis {
  if (typeof record.hypothesisId !== 'string' || record.hypothesisId === '') {
    throw new HypothesisError('hypothesisId is required')
  }
  return Object.freeze({
    hypothesisId: record.hypothesisId,
    subjectScope: Object.freeze([...(record.subjectScope ?? [])]),
    knowledgeAssumptions: Object.freeze({ ...(record.knowledgeAssumptions ?? {}) }),
    strategyPolicy: Object.freeze([...(record.strategyPolicy ?? [])]),
    bugRules: Object.freeze([...(record.bugRules ?? [])]),
    predictedObservableBehaviors: Object.freeze({
      ...(record.predictedObservableBehaviors ?? {}),
    }),
    responseToIntervention: Object.freeze([
      ...(record.responseToIntervention ?? []),
    ]),
    weight: Math.max(0, record.weight ?? 0),
    evidenceRefs: Object.freeze([...(record.evidenceRefs ?? [])]),
    uncertainty: record.uncertainty ?? 'high',
    status: record.status ?? ACTIVE,
    parentId: record.parentId ?? null,
    mergedFrom: Object.freeze([...(record.mergedFrom ?? [])]),
  })
}

function toRecord(hypothesis: Hypothesis): HypothesisRecord {
  return {
    hypothesisId: hypothesis.hypothesisId,
    subjectScope: [...hypothesis.subjectScope],
    knowledgeAssumptions: { ...hypothesis.knowledgeAssumptions },
    strategyPolicy: [...hypothesis.strategyPolicy],
    bugRules: [...hypothesis.bugRules],
    predictedObservableBehaviors: { ...hypothesis.predictedObservableBehaviors },
    responseToIntervention: [...hypothesis.responseToIntervention],
    weight: hypothesis.weight,
    evidenceRefs: [...hypothesis.evidenceRefs],
    uncertainty: hypothesis.uncertainty,
    status: hypothesis.status,
    parentId: hypothesis.parentId,
    mergedFrom: [...hypothesis.mergedFrom],
  }
}

/** A normalised, auditable set of short-term hypotheses. */
export class HypothesisSet {
  private readonly hypotheses = new Map<string, Hypothesis>()
  private unknownWeight: number
  private readonly transitions: HypothesisTransition[] = []
  private boundTwinVersionValue: number | null = null
  private readonly unknownReasonList: string[] = []
  private needsRealEvidenceValue = false
  private readonly matchStatValues = new Map<string, number[]>()

  constructor(hypotheses: readonly Hypothesis[] = [], unknownWeight = 0) {
    for (const hypothesis of hypotheses) {
      if (this.hypotheses.has(hypothesis.hypothesisId)) {
        throw new HypothesisError(
          `duplicate hypothesis id: ${hypothesis.hypothesisId}`,
        )
      }
      this.hypotheses.set(hypothesis.hypothesisId, hypothesis)
    }
    this.unknownWeight = Math.max(0, unknownWeight)
    this.normalize()
  }

  /** Rehydrate a session snapshot carrying no long-term evidence. */
  static fromState(state: HypothesisState): HypothesisSet {
    return new HypothesisSet(
      state.hypotheses.map((record) => makeHypothesis(record)),
      state.unknownWeight,
    )
  }

  /** Serialise a snapshot for the next stateless tool call. */
  toState(): HypothesisState {
    return {
      hypotheses: [...this.hypotheses.values()].map(toRecord),
      unknownWeight: this.unknownWeight,
    }
  }

  get unknown(): number {
    return this.unknownWeight
  }

  get history(): readonly HypothesisTransition[] {
    return this.transitions
  }

  /** Step 12: number of recorded transitions (a stable set revision). */
  get revision(): number {
    return this.transitions.length
  }

  /** Step 12: the twin version this set is bound to, when bound. */
  get boundTwinVersion(): number | null {
    return this.boundTwinVersionValue
  }

  /** Step 13: ordered, de-duplicated reasons the `unknown` bucket grew. */
  get unknownReasons(): readonly string[] {
    return this.unknownReasonList
  }

  /** Step 13: true when the ensemble refused to force a choice. */
  get needsRealEvidence(): boolean {
    return this.needsRealEvidenceValue
  }

  /** Step 13: per-hypothesis `{count, mean}` likelihood history. */
  get matchStats(): Readonly<Record<string, MatchStat>> {
    const result: Record<string, MatchStat> = {}
    for (const [id, values] of this.matchStatValues) {
      if (values.length === 0) continue
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      result[id] = Object.freeze({ count: values.length, mean })
    }
    return Object.freeze(result)
  }

  /** Step 13: one of the `SPAWN_*` triggers recorded on the last spawn. */
  setUnknown(weight: number, reason: string = UNKNOWN_NO_CANDIDATE): number {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new HypothesisError('unknown weight must be a finite value >= 0')
    }
    this.unknownWeight = weight
    if (reason !== '' && !this.unknownReasonList.includes(reason)) {
      this.unknownReasonList.push(reason)
    }
    this.normalize()
    this.record('unknown', [], `reason=${reason}`)
    return this.unknownWeight
  }

  /** Step 13: mark that the ensemble cannot explain the evidence. */
  requestRealEvidence(reason: string = UNKNOWN_NO_EXPLANATION): void {
    if (reason !== '' && !this.unknownReasonList.includes(reason)) {
      this.unknownReasonList.push(reason)
    }
    this.needsRealEvidenceValue = true
    this.record('evidence_request', [], reason)
  }

  /** Step 13: clear the "needs real evidence" flag once evidence arrived. */
  resolveEvidenceRequest(): void {
    this.needsRealEvidenceValue = false
    this.record('evidence_resolved', [])
  }

  /** Step 13: fail closed; hypotheses are never long-term evidence. */
  persistToTwin(): never {
    throw new HypothesisPersistenceError(
      'short-term hypothesis snapshots must not be written to the long-term ' +
        'twin; only observed events may be appended',
    )
  }

  /** Step 13: how indistinguishable two hypotheses are, in [0, 1]. */
  similarity(firstId: string, secondId: string): number {
    return hypothesisSimilarity(this.require(firstId), this.require(secondId))
  }

  /** Step 12: bind the current set revision to a twin version. */
  bindTwinVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new HypothesisError('twin version must be a non-negative integer')
    }
    this.boundTwinVersionValue = version
    this.record('bind', [], String(version))
  }

  /** Step 12: union of evidence refs referenced by active hypotheses. */
  activeEvidenceRefs(): ReadonlySet<string> {
    const refs = new Set<string>()
    for (const hypothesis of this.active()) {
      for (const ref of hypothesis.evidenceRefs) {
        refs.add(ref)
      }
    }
    return refs
  }

  /**
   * Step 12: prune candidates below `threshold`, moving their mass to unknown.
   *
   * Returns the pruned hypothesis ids in ascending weight order so the caller
   * can audit what changed.
   */
  pruneWeak(
    threshold = 0.01,
    reason = UNKNOWN_PRUNED_WEAK,
  ): readonly string[] {
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new HypothesisError('threshold must be a non-negative number')
    }
    const weak = this.active()
      .filter((hypothesis) => hypothesis.weight < threshold)
      .sort((a, b) =>
        a.weight === b.weight
          ? a.hypothesisId.localeCompare(b.hypothesisId)
          : a.weight - b.weight,
      )
    const pruned: string[] = []
    for (const hypothesis of weak) {
      pruned.push(this.prune(hypothesis.hypothesisId, reason).hypothesisId)
    }
    return pruned
  }

  /**
   * Step 12: an independent copy (same hypotheses, history and binding).
   *
   * The long-term twin evolves a working copy so a rejected operation can never
   * mutate the bound set.
   */
  clone(): HypothesisSet {
    const copy = new HypothesisSet()
    copy.hypotheses.clear()
    for (const [id, hypothesis] of this.hypotheses) {
      copy.hypotheses.set(id, hypothesis)
    }
    copy.unknownWeight = this.unknownWeight
    copy.transitions.push(...this.transitions)
    copy.boundTwinVersionValue = this.boundTwinVersionValue
    copy.unknownReasonList.push(...this.unknownReasonList)
    copy.needsRealEvidenceValue = this.needsRealEvidenceValue
    for (const [id, values] of this.matchStatValues) {
      copy.matchStatValues.set(id, [...values])
    }
    return copy
  }

  active(): readonly Hypothesis[] {
    return [...this.hypotheses.values()].filter(
      (hypothesis) => hypothesis.status === ACTIVE && hypothesis.weight > 0,
    )
  }

  get(hypothesisId: string): Hypothesis | undefined {
    return this.hypotheses.get(hypothesisId)
  }

  /** Posterior weights over active hypotheses plus `unknown` (sums to 1). */
  weights(): Readonly<Record<string, number>> {
    const result: Record<string, number> = {}
    for (const hypothesis of this.active()) {
      result[hypothesis.hypothesisId] = hypothesis.weight
    }
    result[UNKNOWN_HYPOTHESIS_ID] = this.unknownWeight
    return result
  }

  totalWeight(): number {
    return Object.values(this.weights()).reduce((sum, value) => sum + value, 0)
  }

  /** Return the best active hypothesis, or null when `unknown` leads. */
  dominant(): Hypothesis | null {
    const active = [...this.active()].sort((a, b) =>
      b.weight === a.weight
        ? b.hypothesisId.localeCompare(a.hypothesisId)
        : b.weight - a.weight,
    )
    const best = active[0]
    if (best === undefined || this.unknownWeight >= best.weight) {
      return null
    }
    return best
  }

  spawn(
    input: Hypothesis | HypothesisRecord,
    weight?: number,
    options: { readonly trigger?: string } = {},
  ): Hypothesis {
    const hypothesis = makeHypothesis(input)
    if (this.hypotheses.has(hypothesis.hypothesisId)) {
      throw new HypothesisError(
        `duplicate hypothesis id: ${hypothesis.hypothesisId}`,
      )
    }
    if (this.active().length === 0) {
      // Before any candidate exists, all mass sits in `unknown`. The first
      // spawned candidate claims that placeholder mass.
      this.unknownWeight = 0
    }
    const spawned: Hypothesis = Object.freeze({
      ...hypothesis,
      weight: Math.max(0, weight ?? hypothesis.weight),
      status: ACTIVE,
    })
    this.hypotheses.set(spawned.hypothesisId, spawned)
    this.normalize()
    this.record('spawn', [spawned.hypothesisId], options.trigger ?? '')
    return this.hypotheses.get(spawned.hypothesisId) as Hypothesis
  }

  /** Replace a hypothesis with distinguishable children (spec 6.2). */
  split(
    hypothesisId: string,
    children: readonly (Hypothesis | HypothesisRecord)[],
  ): readonly Hypothesis[] {
    const parent = this.require(hypothesisId)
    if (children.length < 2) {
      throw new HypothesisError('split requires at least two children')
    }
    const childIds = new Set<string>()
    const childList = children.map((child) => {
      const hypothesis = makeHypothesis(child)
      if (childIds.has(hypothesis.hypothesisId) || this.hypotheses.has(hypothesis.hypothesisId)) {
        throw new HypothesisError(
          `duplicate hypothesis id: ${hypothesis.hypothesisId}`,
        )
      }
      childIds.add(hypothesis.hypothesisId)
      return hypothesis
    })

    const totalRelative =
      childList.reduce((sum, child) => sum + Math.max(0, child.weight), 0) || 1
    const parentWeight = parent.weight
    const newChildren = childList.map((child) =>
      Object.freeze({
        ...child,
        weight: parentWeight * (Math.max(0, child.weight) / totalRelative),
        status: ACTIVE,
        parentId: parent.hypothesisId,
      }),
    )
    this.hypotheses.set(
      parent.hypothesisId,
      Object.freeze({ ...parent, weight: 0, status: SPLIT }),
    )
    for (const child of newChildren) {
      this.hypotheses.set(child.hypothesisId, child)
    }
    this.normalize()
    this.record('split', [
      parent.hypothesisId,
      ...newChildren.map((child) => child.hypothesisId),
    ])
    return newChildren.map(
      (child) => this.hypotheses.get(child.hypothesisId) as Hypothesis,
    )
  }

  /** Merge indistinguishable hypotheses, keeping source history. */
  merge(
    hypothesisIds: readonly string[],
    newHypothesis: Hypothesis | HypothesisRecord,
  ): Hypothesis {
    if (hypothesisIds.length < 2) {
      throw new HypothesisError('merge requires at least two hypotheses')
    }
    const mergedHypothesis = makeHypothesis(newHypothesis)
    if (this.hypotheses.has(mergedHypothesis.hypothesisId)) {
      throw new HypothesisError(
        `duplicate hypothesis id: ${mergedHypothesis.hypothesisId}`,
      )
    }
    let mergedWeight = 0
    for (const hypothesisId of hypothesisIds) {
      const hypothesis = this.require(hypothesisId)
      mergedWeight += hypothesis.weight
      this.hypotheses.set(
        hypothesisId,
        Object.freeze({ ...hypothesis, weight: 0, status: MERGED }),
      )
    }
    const merged = Object.freeze({
      ...mergedHypothesis,
      weight: mergedWeight,
      status: ACTIVE,
      mergedFrom: Object.freeze([...hypothesisIds]),
    })
    this.hypotheses.set(merged.hypothesisId, merged)
    this.normalize()
    this.record('merge', [...hypothesisIds, merged.hypothesisId])
    return this.hypotheses.get(merged.hypothesisId) as Hypothesis
  }

  /** Split only when the children are separable on the new question. */
  splitDistinguishable(
    hypothesisId: string,
    children: readonly (Hypothesis | HypothesisRecord)[],
    maxSimilarity = 0.9,
  ): readonly Hypothesis[] {
    if (!Number.isFinite(maxSimilarity) || maxSimilarity < 0 || maxSimilarity > 1) {
      throw new HypothesisError('maxSimilarity must be within [0, 1]')
    }
    if (children.length < 2) {
      throw new HypothesisError('split requires at least two children')
    }
    const childList = children.map((child) => makeHypothesis(child))
    for (let index = 0; index < childList.length; index += 1) {
      for (let other = index + 1; other < childList.length; other += 1) {
        const first = childList[index] as Hypothesis
        const second = childList[other] as Hypothesis
        if (hypothesisSimilarity(first, second) > maxSimilarity) {
          throw new HypothesisError(
            `split children are not distinguishable (${first.hypothesisId}, ` +
              `${second.hypothesisId})`,
          )
        }
      }
    }
    return this.split(hypothesisId, childList)
  }

  /** Merge groups of active hypotheses that are nearly indistinguishable. */
  mergeIndistinguishable(
    options: MergeIndistinguishableOptions = {},
  ): readonly string[] {
    const threshold = options.similarityThreshold ?? 0.9
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new HypothesisError('similarityThreshold must be within [0, 1]')
    }
    const active = [...this.active()]
    const parent = new Map<string, string>()
    for (const hypothesis of active) {
      parent.set(hypothesis.hypothesisId, hypothesis.hypothesisId)
    }
    const find = (item: string): string => {
      let current = item
      while (parent.get(current) !== current) {
        parent.set(current, parent.get(parent.get(current) as string) as string)
        current = parent.get(current) as string
      }
      return current
    }
    const union = (first: string, second: string): void => {
      const rootFirst = find(first)
      const rootSecond = find(second)
      if (rootFirst === rootSecond) return
      const [lower, upper] =
        rootFirst < rootSecond ? [rootFirst, rootSecond] : [rootSecond, rootFirst]
      parent.set(upper, lower)
    }
    for (let index = 0; index < active.length; index += 1) {
      for (let other = index + 1; other < active.length; other += 1) {
        const first = active[index] as Hypothesis
        const second = active[other] as Hypothesis
        if (hypothesisSimilarity(first, second) >= threshold) {
          union(first.hypothesisId, second.hypothesisId)
        }
      }
    }
    const groups = new Map<string, string[]>()
    for (const hypothesis of active) {
      const root = find(hypothesis.hypothesisId)
      const members = groups.get(root) ?? []
      members.push(hypothesis.hypothesisId)
      groups.set(root, members)
    }
    const mergedIds: string[] = []
    for (const root of [...groups.keys()].sort()) {
      const members = [...(groups.get(root) as string[])].sort()
      if (members.length < 2) continue
      const newId = this.uniqueId(
        options.idFactory !== undefined
          ? options.idFactory(members)
          : `m_${members.join('_')}`,
      )
      this.merge(members, this.mergedHypothesis(members, newId))
      mergedIds.push(newId)
    }
    return mergedIds
  }

  /** Archive a hypothesis; its mass moves to the `unknown` bucket. */
  prune(hypothesisId: string, reason = ''): Hypothesis {
    const hypothesis = this.require(hypothesisId)
    this.unknownWeight += hypothesis.weight
    if (reason !== '' && !this.unknownReasonList.includes(reason)) {
      this.unknownReasonList.push(reason)
    }
    const pruned = Object.freeze({
      ...hypothesis,
      weight: 0,
      status: PRUNED,
    })
    this.hypotheses.set(hypothesisId, pruned)
    this.normalize()
    this.record('prune', [hypothesisId], reason)
    return this.hypotheses.get(hypothesisId) as Hypothesis
  }

  /** Eliminate hypotheses whose matched likelihood stays very low. */
  pruneContradicted(
    minMatches = 2,
    maxMeanLikelihood = 0.2,
    reason = UNKNOWN_CONTRADICTED,
  ): readonly string[] {
    if (!Number.isInteger(minMatches) || minMatches < 1) {
      throw new HypothesisError('minMatches must be an integer >= 1')
    }
    if (
      !Number.isFinite(maxMeanLikelihood) ||
      maxMeanLikelihood < 0 ||
      maxMeanLikelihood > 1
    ) {
      throw new HypothesisError('maxMeanLikelihood must be within [0, 1]')
    }
    const candidates = [...this.active()].sort((a, b) =>
      a.weight === b.weight
        ? a.hypothesisId.localeCompare(b.hypothesisId)
        : b.weight - a.weight,
    )
    const pruned: string[] = []
    for (const hypothesis of candidates) {
      const values = this.matchStatValues.get(hypothesis.hypothesisId) ?? []
      if (values.length < minMatches) continue
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      if (mean < maxMeanLikelihood) {
        this.prune(hypothesis.hypothesisId, reason)
        pruned.push(hypothesis.hypothesisId)
      }
    }
    return pruned
  }

  /** Archive candidates that add no unique explanation beyond a stronger one. */
  pruneUninformative(
    similarityThreshold = 0.95,
    reason = UNKNOWN_LOW_EXPLANATORY_POWER,
  ): readonly string[] {
    if (
      !Number.isFinite(similarityThreshold) ||
      similarityThreshold < 0 ||
      similarityThreshold > 1
    ) {
      throw new HypothesisError('similarityThreshold must be within [0, 1]')
    }
    const candidates = [...this.active()].sort((a, b) =>
      a.weight === b.weight
        ? a.hypothesisId.localeCompare(b.hypothesisId)
        : b.weight - a.weight,
    )
    const kept: Hypothesis[] = []
    const pruned: string[] = []
    for (const hypothesis of candidates) {
      const redundant = kept.some(
        (stronger) =>
          hypothesisSimilarity(hypothesis, stronger) >= similarityThreshold,
      )
      if (redundant) {
        this.prune(hypothesis.hypothesisId, reason)
        pruned.push(hypothesis.hypothesisId)
      } else {
        kept.push(hypothesis)
      }
    }
    return pruned
  }


  /**
   * Bayesian posterior update with an explicit noise term.
   *
   * `likelihoods` maps active hypothesis ids to `P(E | H_i)`. The posterior is
   * normalised over active hypotheses plus `unknown`.
   */
  reweight(
    likelihoods: Readonly<Record<string, number>>,
    options: ReweightOptions = {},
  ): Readonly<Record<string, number>> {
    const noise = options.noise ?? 0.05
    if (!Number.isFinite(noise) || noise < 0 || noise > 1) {
      throw new HypothesisError('noise must be within [0, 1]')
    }

    const prior = this.weights()
    const priorUnknown =
      options.unknownPrior ??
      Math.max(this.unknownWeight, DEFAULT_UNKNOWN_PRIOR)
    if (this.active().length === 0 && priorUnknown <= 0) {
      this.unknownWeight = 1
      return this.weights()
    }

    const posterior: Record<string, number> = {}
    for (const hypothesis of this.active()) {
      const value = clampProbability(
        likelihoods[hypothesis.hypothesisId] ?? CHANCE_LIKELIHOOD,
        `likelihood[${hypothesis.hypothesisId}]`,
      )
      const observed = (1 - noise) * value + noise * CHANCE_LIKELIHOOD
      posterior[hypothesis.hypothesisId] =
        (prior[hypothesis.hypothesisId] ?? hypothesis.weight) * observed
    }

    const unknownLikelihood = clampProbability(
      options.unknownLikelihood ?? CHANCE_LIKELIHOOD,
      'unknownLikelihood',
    )
    const pUnknown =
      (1 - noise) * unknownLikelihood + noise * CHANCE_LIKELIHOOD
    const safePriorUnknown = Math.max(0, priorUnknown)
    const total =
      Object.values(posterior).reduce((sum, value) => sum + value, 0) +
      safePriorUnknown * pUnknown

    if (total <= 0) {
      // No hypothesis (nor unknown) explains the evidence: stay unknown.
      this.unknownWeight = 1
      for (const hypothesis of this.active()) {
        this.hypotheses.set(
          hypothesis.hypothesisId,
          Object.freeze({ ...hypothesis, weight: 0 }),
        )
      }
      this.markUnknownLead()
      return this.weights()
    }

    for (const hypothesis of this.active()) {
      const evidenceRefs = options.evidenceRef === undefined ||
        hypothesis.evidenceRefs.includes(options.evidenceRef)
        ? hypothesis.evidenceRefs
        : [...hypothesis.evidenceRefs, options.evidenceRef]
      this.hypotheses.set(
        hypothesis.hypothesisId,
        Object.freeze({
          ...hypothesis,
          weight: posterior[hypothesis.hypothesisId] / total,
          evidenceRefs: Object.freeze(evidenceRefs),
        }),
      )
    }
    this.unknownWeight = (safePriorUnknown * pUnknown) / total
    this.normalize()
    this.record('reweight', Object.keys(posterior), `noise=${noise}`)
    if (this.dominant() === null) this.markUnknownLead()
    return this.weights()
  }

  /** Add evidence-constrained alternatives when diversity collapses. */
  resample(
    candidates: readonly (Hypothesis | HypothesisRecord)[],
    minDiversity = 0.15,
  ): readonly Hypothesis[] {
    const active = this.active()
    const maxWeight = active.reduce(
      (max, hypothesis) => Math.max(max, hypothesis.weight),
      0,
    )
    if (active.length > 0 && maxWeight < 1 - minDiversity) {
      return []
    }
    const spawned: Hypothesis[] = []
    for (const candidate of candidates) {
      const hypothesis = makeHypothesis(candidate)
      if (this.hypotheses.has(hypothesis.hypothesisId)) continue
      spawned.push(this.spawn(hypothesis))
    }
    return spawned
  }

  /**
   * Spawn only candidates that explain currently unexplained behaviour.
   *
   * A behaviour is "unexplained" when no active hypothesis predicts it above
   * `behaviorThreshold`. A candidate is spawned only if it beats the current
   * best explanation by at least `minGain` on at least one unexplained
   * behaviour, so new candidates are not mechanical copies of the leader.
   */
  generate(
    observations: Readonly<Record<string, number>>,
    candidates: readonly (Hypothesis | HypothesisRecord)[],
    options: GenerateOptions = {},
  ): readonly Hypothesis[] {
    const behaviorThreshold = options.behaviorThreshold ?? 0.5
    const minGain = options.minGain ?? 0.05
    const weight = options.weight ?? 1
    const trigger = options.trigger ?? SPAWN_UNEXPLAINED_STEP
    if (
      !Number.isFinite(behaviorThreshold) ||
      behaviorThreshold < 0 ||
      behaviorThreshold > 1
    ) {
      throw new HypothesisError('behaviorThreshold must be within [0, 1]')
    }
    if (!Number.isFinite(minGain) || minGain < 0 || minGain > 1) {
      throw new HypothesisError('minGain must be within [0, 1]')
    }
    const active = this.active()
    const unexplained = new Map<string, number>()
    for (const behavior of Object.keys(observations)) {
      let best = 0
      for (const hypothesis of active) {
        best = Math.max(
          best,
          hypothesis.predictedObservableBehaviors[behavior] ?? 0,
        )
      }
      if (best < behaviorThreshold) unexplained.set(behavior, best)
    }
    if (unexplained.size === 0) return []
    const spawned: Hypothesis[] = []
    for (const candidate of candidates) {
      const hypothesis = makeHypothesis(candidate)
      if (this.hypotheses.has(hypothesis.hypothesisId)) continue
      let gain = 0
      for (const [behavior, best] of unexplained) {
        gain = Math.max(
          gain,
          (hypothesis.predictedObservableBehaviors[behavior] ?? 0) - best,
        )
      }
      if (gain >= minGain) {
        spawned.push(this.spawn(hypothesis, weight, { trigger }))
      }
    }
    return spawned
  }

  /**
   * Turn observations into per-hypothesis likelihoods + posterior.
   *
   * `observations` maps a behaviour key to its observed outcome in [0, 1].
   */
  match(
    observations: Readonly<Record<string, number>>,
    options: MatchOptions = {},
  ): HypothesisMatch {
    const smoothing = options.smoothing ?? 0.02
    if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing >= 0.5) {
      throw new HypothesisError('smoothing must be within [0, 0.5)')
    }
    const observed: Record<string, number> = {}
    for (const [behavior, outcome] of Object.entries(observations)) {
      if (!Number.isFinite(outcome) || outcome < 0 || outcome > 1) {
        throw new HypothesisError(
          `observation[${behavior}] must be within [0, 1]`,
        )
      }
      observed[behavior] = outcome
    }
    const active = this.active()
    const likelihoods: Record<string, number> = {}
    const covered = new Set<string>()
    for (const hypothesis of active) {
      let logLikelihood = 0
      let used = 0
      for (const [behavior, outcome] of Object.entries(observed)) {
        const predicted =
          hypothesis.predictedObservableBehaviors[behavior]
        if (predicted === undefined) continue
        const probability =
          smoothing +
          (1 - 2 * smoothing) * Math.min(1, Math.max(0, predicted))
        logLikelihood +=
          outcome * Math.log(probability) +
          (1 - outcome) * Math.log(1 - probability)
        used += 1
        covered.add(behavior)
      }
      const likelihood = used > 0 ? Math.exp(logLikelihood) : CHANCE_LIKELIHOOD
      likelihoods[hypothesis.hypothesisId] = Math.min(
        1,
        Math.max(0, likelihood),
      )
      const values = this.matchStatValues.get(hypothesis.hypothesisId) ?? []
      values.push(likelihoods[hypothesis.hypothesisId] as number)
      this.matchStatValues.set(hypothesis.hypothesisId, values)
    }
    const weights = this.reweight(likelihoods, {
      evidenceRef: options.evidenceRef,
      noise: options.noise,
      unknownPrior: options.unknownPrior,
      unknownLikelihood: options.unknownLikelihood,
    })
    const unexplained = Object.keys(observed).filter(
      (behavior) => !covered.has(behavior),
    )
    return Object.freeze({
      likelihoods: Object.freeze(likelihoods),
      weights: Object.freeze({ ...weights }),
      observedBehaviors: Object.freeze(Object.keys(observed)),
      coveredBehaviors: Object.freeze(
        Object.keys(observed).filter((behavior) => covered.has(behavior)),
      ),
      unexplainedBehaviors: Object.freeze(unexplained),
    })
  }

  /** Compute behaviour-fidelity and calibration metrics (spec 19.3). */
  fidelity(
    observations: readonly BehaviorObservation[],
    options: FidelityOptions = {},
  ): FidelityMetrics {
    const minObservations = options.minObservations ?? 5
    const bins = options.bins ?? 5
    if (!Number.isInteger(minObservations) || minObservations < 0) {
      throw new HypothesisError('minObservations must be an integer >= 0')
    }
    if (!Number.isInteger(bins) || bins < 1) {
      throw new HypothesisError('bins must be an integer >= 1')
    }
    const active = this.active()
    const weightTotal = active.reduce(
      (sum, hypothesis) => sum + hypothesis.weight,
      0,
    )
    const probabilities: number[] = []
    let covered = 0
    for (const observation of observations) {
      let mixture = 0
      let anyPrediction = false
      for (const hypothesis of active) {
        const predicted =
          hypothesis.predictedObservableBehaviors[observation.behavior]
        if (predicted === undefined) continue
        anyPrediction = true
        mixture +=
          hypothesis.weight * Math.min(1, Math.max(0, predicted))
      }
      if (anyPrediction) covered += 1
      probabilities.push(
        (anyPrediction ? mixture : 0) + this.unknownWeight * CHANCE_LIKELIHOOD,
      )
    }
    const count = observations.length
    let brierScore: number | null = null
    let logLoss: number | null = null
    let accuracy: number | null = null
    let calibrationError: number | null = null
    if (count > 0) {
      const outcomes = observations.map((observation) =>
        observation.outcome ? 1 : 0,
      )
      brierScore =
        probabilities.reduce(
          (sum, probability, index) =>
            sum + (probability - (outcomes[index] as number)) ** 2,
          0,
        ) / count
      logLoss =
        -probabilities.reduce((sum, probability, index) => {
          const clipped = Math.min(1 - 1e-9, Math.max(1e-9, probability))
          const outcome = outcomes[index] as number
          return (
            sum +
            outcome * Math.log(clipped) +
            (1 - outcome) * Math.log(1 - clipped)
          )
        }, 0) / count
      accuracy =
        probabilities.reduce(
          (sum, probability, index) =>
            sum +
            ((probability >= 0.5 ? 1 : 0) === (outcomes[index] as number)
              ? 1
              : 0),
          0,
        ) / count
      calibrationError = expectedCalibrationError(
        probabilities,
        outcomes,
        bins,
      )
    }
    const weights = this.weights()
    const effectiveHypotheses =
      1 /
      Object.values(weights).reduce(
        (sum, value) => sum + value * value,
        0,
      )
    const maxWeight = active.reduce(
      (max, hypothesis) => Math.max(max, hypothesis.weight),
      0,
    )
    const dominant = this.dominant()
    const errorTypeObservations = observations.filter(
      (observation) => !observation.outcome && observation.errorType !== undefined,
    )
    const stepObservations = observations.filter(
      (observation) => !observation.outcome && observation.step !== undefined,
    )
    const strategyObservations = observations.filter(
      (observation) => observation.strategy !== undefined,
    )
    let antiMismatch: number | null = null
    if (options.recentEvidenceId !== undefined && weightTotal > 0) {
      let updated = 0
      for (const hypothesis of active) {
        if (hypothesis.evidenceRefs.includes(options.recentEvidenceId)) {
          updated += hypothesis.weight
        }
      }
      antiMismatch = updated / weightTotal
    }
    return Object.freeze({
      observationCount: count,
      covered,
      coverage: count > 0 ? covered / count : 0,
      brierScore,
      logLoss,
      calibrationError,
      accuracy,
      unknownShare: this.unknownWeight,
      effectiveHypotheses,
      maxWeight,
      errorTypeAgreement: agreement(
        dominant,
        errorTypeObservations,
        (observation) => observation.errorType,
        (hypothesis) => hypothesis.bugRules,
      ),
      stepAgreement: agreement(
        dominant,
        stepObservations,
        (observation) => observation.step,
        (hypothesis) => hypothesis.bugRules,
      ),
      strategyAgreement: agreement(
        dominant,
        strategyObservations,
        (observation) => observation.strategy,
        (hypothesis) => hypothesis.strategyPolicy,
      ),
      antiMismatch,
      sufficient: count >= minObservations,
    })
  }

  /** Freeze a session-scoped snapshot (never long-term evidence). */
  toSnapshot(
    sessionId: string,
    options: HypothesisSnapshotOptions = {},
  ): HypothesisSnapshot {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HypothesisScopeError('sessionId is required for a snapshot')
    }
    const ttlMs = options.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new HypothesisScopeError('ttlMs must be a finite number > 0')
    }
    const createdAtMs = options.now ?? Date.now()
    const matchStats: Record<string, MatchStat> = {}
    for (const [id, values] of this.matchStatValues) {
      if (values.length === 0) continue
      matchStats[id] = Object.freeze({
        count: values.length,
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      })
    }
    return Object.freeze({
      snapshotId: options.snapshotId ?? `hyp_${sessionId}_${this.revision}`,
      sessionId,
      agentId: options.agentId ?? null,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
      revision: this.revision,
      boundTwinVersion: this.boundTwinVersionValue,
      state: this.toState(),
      unknownReasons: Object.freeze([...this.unknownReasonList]),
      needsRealEvidence: this.needsRealEvidenceValue,
      matchStats: Object.freeze(matchStats),
      persistsToLongTermTwin: false,
    })
  }

  /** Restore a set from a snapshot; only the owning session should do so. */
  static fromSnapshot(snapshot: HypothesisSnapshot): HypothesisSet {
    if (snapshot.persistsToLongTermTwin) {
      throw new HypothesisPersistenceError(
        'refusing to restore a snapshot marked as long-term evidence',
      )
    }
    const restored = HypothesisSet.fromState(snapshot.state)
    restored.unknownReasonList.push(...snapshot.unknownReasons)
    restored.needsRealEvidenceValue = snapshot.needsRealEvidence
    restored.boundTwinVersionValue = snapshot.boundTwinVersion
    for (const [id, stats] of Object.entries(snapshot.matchStats)) {
      restored.matchStatValues.set(
        id,
        new Array<number>(stats.count).fill(stats.mean),
      )
    }
    return restored
  }

  private uniqueId(candidate: string): string {
    if (!this.hypotheses.has(candidate)) return candidate
    let suffix = 2
    while (this.hypotheses.has(`${candidate}_${suffix}`)) suffix += 1
    return `${candidate}_${suffix}`
  }

  private mergedHypothesis(
    memberIds: readonly string[],
    newId: string,
  ): Hypothesis {
    const members = memberIds.map((memberId) => this.require(memberId))
    const representative = [...members].sort((a, b) =>
      b.weight === a.weight
        ? a.hypothesisId.localeCompare(b.hypothesisId)
        : b.weight - a.weight,
    )[0] as Hypothesis
    const behaviorKeys = new Set<string>()
    for (const member of members) {
      for (const key of Object.keys(member.predictedObservableBehaviors)) {
        behaviorKeys.add(key)
      }
    }
    const predicted: Record<string, number> = {}
    for (const key of [...behaviorKeys].sort()) {
      const values = members
        .map((member) => member.predictedObservableBehaviors[key])
        .filter((value): value is number => value !== undefined)
      predicted[key] =
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : CHANCE_LIKELIHOOD
    }
    return makeHypothesis({
      hypothesisId: newId,
      subjectScope: [
        ...new Set(members.flatMap((member) => [...member.subjectScope])),
      ],
      knowledgeAssumptions: { ...representative.knowledgeAssumptions },
      strategyPolicy: [
        ...new Set(members.flatMap((member) => [...member.strategyPolicy])),
      ],
      bugRules: [...new Set(members.flatMap((member) => [...member.bugRules]))],
      predictedObservableBehaviors: predicted,
      responseToIntervention: [
        ...new Set(
          members.flatMap((member) => [...member.responseToIntervention]),
        ),
      ],
      weight: 0,
      uncertainty: 'medium',
    })
  }

  private markUnknownLead(): void {
    this.needsRealEvidenceValue = true
    if (!this.unknownReasonList.includes(UNKNOWN_NO_EXPLANATION)) {
      this.unknownReasonList.push(UNKNOWN_NO_EXPLANATION)
    }
  }

  private require(hypothesisId: string): Hypothesis {
    const hypothesis = this.hypotheses.get(hypothesisId)
    if (hypothesis === undefined) {
      throw new HypothesisError(`unknown hypothesis: ${hypothesisId}`)
    }
    return hypothesis
  }

  private normalize(): void {
    const active = [...this.hypotheses.values()].filter(
      (hypothesis) => hypothesis.status === ACTIVE,
    )
    const total =
      active.reduce((sum, hypothesis) => sum + hypothesis.weight, 0) +
      this.unknownWeight
    if (total <= 0) {
      for (const hypothesis of active) {
        this.hypotheses.set(
          hypothesis.hypothesisId,
          Object.freeze({ ...hypothesis, weight: 0 }),
        )
      }
      this.unknownWeight = 1
      return
    }
    for (const hypothesis of active) {
      this.hypotheses.set(
        hypothesis.hypothesisId,
        Object.freeze({ ...hypothesis, weight: hypothesis.weight / total }),
      )
    }
    this.unknownWeight /= total
  }

  private record(
    kind: string,
    hypothesisIds: readonly string[],
    detail = '',
  ): void {
    this.transitions.push(
      Object.freeze({
        kind,
        hypothesisIds: Object.freeze([...hypothesisIds]),
        detail,
        at: new Date().toISOString(),
      }),
    )
  }
}

/**
 * In-memory, session-scoped, TTL-bounded hypothesis snapshot store (Step 13).
 *
 * Mirrors `aeh/hypothesis.py::HypothesisSnapshotStore`. A snapshot is only
 * readable by the exact session/agent scope that wrote it, expires after
 * `ttlMs`, and is dropped on session end / clear. It exposes counts only and
 * can never write to the long-term twin. This is a synthetic/test adapter; a
 * production host needs a durable, access-controlled session store with the
 * same semantics.
 */
export class HypothesisSnapshotStore {
  private readonly records = new Map<
    string,
    { readonly snapshot: HypothesisSnapshot; readonly expiresAtMs: number }
  >()
  private readonly byScope = new Map<string, string[]>()
  private readonly ttlMsValue: number
  private readonly nowValue: () => number
  private readonly maxEntriesPerScope: number
  private readonly maxEntries: number
  private readonly idFactory: (() => string) | undefined
  private counter = 0

  constructor(options: HypothesisSnapshotStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new HypothesisScopeError('ttlMs must be a finite number > 0')
    }
    const maxEntriesPerScope = options.maxEntriesPerScope ?? 16
    const maxEntries = options.maxEntries ?? 512
    if (!Number.isInteger(maxEntriesPerScope) || maxEntriesPerScope <= 0) {
      throw new HypothesisScopeError(
        'maxEntriesPerScope must be a positive integer',
      )
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new HypothesisScopeError('maxEntries must be a positive integer')
    }
    this.ttlMsValue = ttlMs
    this.nowValue = options.now ?? (() => Date.now())
    this.maxEntriesPerScope = maxEntriesPerScope
    this.maxEntries = maxEntries
    this.idFactory = options.idFactory
  }

  get ttlMs(): number {
    return this.ttlMsValue
  }

  put(
    hypothesisSet: HypothesisSet,
    scope: HypothesisScope,
    options: { readonly snapshotId?: string } = {},
  ): HypothesisSnapshot {
    const safeScope = assertScope(scope)
    this.sweep()
    const snapshotId = options.snapshotId ?? this.nextRef()
    const snapshot = hypothesisSet.toSnapshot(safeScope.sessionId, {
      snapshotId,
      agentId: safeScope.agentId,
      ttlMs: this.ttlMsValue,
      now: this.nowValue(),
    })
    this.records.set(snapshotId, {
      snapshot,
      expiresAtMs: this.nowValue() + this.ttlMsValue,
    })
    const key = scopeKey(safeScope)
    const refs = this.byScope.get(key) ?? []
    refs.push(snapshotId)
    this.byScope.set(key, refs)
    this.enforceCaps()
    return snapshot
  }

  get(
    snapshotId: string,
    scope: HypothesisScope,
  ): HypothesisSnapshot | undefined {
    const safeScope = assertScope(scope)
    const stored = this.records.get(snapshotId)
    if (stored === undefined) return undefined
    if (this.nowValue() >= stored.expiresAtMs) {
      this.remove(snapshotId)
      return undefined
    }
    if (scopeKey(safeScope) !== recordedScopeKey(stored.snapshot)) {
      return undefined
    }
    return stored.snapshot
  }

  delete(snapshotId: string, scope: HypothesisScope): boolean {
    const safeScope = assertScope(scope)
    const stored = this.records.get(snapshotId)
    if (
      stored === undefined ||
      scopeKey(safeScope) !== recordedScopeKey(stored.snapshot)
    ) {
      return false
    }
    this.remove(snapshotId)
    return true
  }

  endSession(sessionId: string): number {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    let removed = 0
    for (const [snapshotId, stored] of [...this.records]) {
      if (stored.snapshot.sessionId === sessionId) {
        this.remove(snapshotId)
        removed += 1
      }
    }
    return removed
  }

  sweep(): number {
    let removed = 0
    for (const [snapshotId, stored] of [...this.records]) {
      if (this.nowValue() >= stored.expiresAtMs) {
        this.remove(snapshotId)
        removed += 1
      }
    }
    return removed
  }

  clear(): number {
    const removed = this.records.size
    this.records.clear()
    this.byScope.clear()
    return removed
  }

  get size(): number {
    return this.records.size
  }

  scopes(): number {
    return this.byScope.size
  }

  snapshot(): Readonly<Record<string, number | boolean>> {
    let expired = 0
    for (const stored of this.records.values()) {
      if (this.nowValue() >= stored.expiresAtMs) expired += 1
    }
    return Object.freeze({
      entries: this.records.size,
      scopes: this.byScope.size,
      expired,
      sessionScoped: true,
      longTermTwinWrite: false,
    })
  }

  private nextRef(): string {
    if (this.idFactory !== undefined) {
      const custom = this.idFactory()
      if (typeof custom !== 'string' || custom.length === 0) {
        throw new HypothesisScopeError('idFactory must return a non-empty string')
      }
      return custom
    }
    this.counter += 1
    return `hyp_${this.counter.toString(16)}`
  }

  private remove(snapshotId: string): void {
    const stored = this.records.get(snapshotId)
    if (stored === undefined) return
    this.records.delete(snapshotId)
    const key = recordedScopeKey(stored.snapshot)
    const refs = this.byScope.get(key)
    if (refs === undefined) return
    const next = refs.filter((ref) => ref !== snapshotId)
    if (next.length === 0) this.byScope.delete(key)
    else this.byScope.set(key, next)
  }

  private enforceCaps(): void {
    for (const refs of this.byScope.values()) {
      while (refs.length > this.maxEntriesPerScope) {
        const oldest = refs.shift()
        if (oldest !== undefined) this.records.delete(oldest)
      }
    }
    if (this.records.size <= this.maxEntries) return
    const ordered = [...this.records.values()].sort(
      (a, b) => Date.parse(a.snapshot.createdAt) - Date.parse(b.snapshot.createdAt),
    )
    const excess = this.records.size - this.maxEntries
    for (let index = 0; index < excess; index += 1) {
      const victim = ordered[index]
      if (victim !== undefined) this.remove(victim.snapshot.snapshotId)
    }
  }
}

function recordedScopeKey(snapshot: HypothesisSnapshot): string {
  return `${snapshot.sessionId}\u0000${snapshot.agentId ?? ''}`
}
