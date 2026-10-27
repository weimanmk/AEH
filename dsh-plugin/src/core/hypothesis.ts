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

/** Likelihood of the chance level used by the noise term. */
export const CHANCE_LIKELIHOOD = 0.5
/** Default prior mass reserved for the "unknown" explanation during updates. */
export const DEFAULT_UNKNOWN_PRIOR = 0.05

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

function clampProbability(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new HypothesisError(`${name} must be a probability in [0, 1]`)
  }
  return value
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
    this.record('spawn', [spawned.hypothesisId])
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

  /** Archive a hypothesis; its mass moves to the `unknown` bucket. */
  prune(hypothesisId: string, reason = ''): Hypothesis {
    const hypothesis = this.require(hypothesisId)
    this.unknownWeight += hypothesis.weight
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
