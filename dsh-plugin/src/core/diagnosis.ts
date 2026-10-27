/**
 * Active diagnosis: choose the most discriminating next probe (spec section 7).
 *
 * The score is
 *
 *   IG(q) + alpha * TeachingValue(q)
 *         - beta * Time(q) - gamma * Risk(q) - delta * CognitiveLoad(q)
 *
 * Only gate-allowed candidates participate, and the student may skip at any
 * time. The plugin recomputes the gate before selection instead of trusting a
 * model-provided `gateAllowed` flag.
 */

import {
  DiagnosisError,
  type DiagnosticCandidateInput,
  type ProbeWeightInput,
} from '../domain.ts'

export const UNKNOWN_HYPOTHESIS_ID = 'unknown'

export interface DiagnosticCandidate {
  readonly itemId: string
  readonly predictions: Readonly<Record<string, number>>
  readonly timeMinutes: number
  readonly risk: number
  readonly cognitiveLoad: number
  readonly teachingValue: number
  readonly gateAllowed: boolean
  readonly requiredKcs: readonly string[]
  readonly gateReasons?: readonly string[]
}

export interface ProbeWeights {
  readonly alpha: number
  readonly beta: number
  readonly gamma: number
  readonly delta: number
}

export const DEFAULT_PROBE_WEIGHTS: ProbeWeights = Object.freeze({
  alpha: 0.2,
  beta: 0.1,
  gamma: 0.5,
  delta: 0.1,
})

export interface ProbeSelection {
  readonly itemId: string
  readonly score: number
  readonly informationGain: number
  readonly teachingValue: number
  readonly timePenalty: number
  readonly riskPenalty: number
  readonly loadPenalty: number
  readonly reasons: readonly string[]
  readonly candidate: DiagnosticCandidate | null
}

function normalizeWeights(
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  const positive: Record<string, number> = {}
  let total = 0
  for (const [key, value] of Object.entries(weights)) {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0
    positive[key] = safe
    total += safe
  }
  const keys = Object.keys(positive)
  if (total <= 0) {
    if (keys.length === 0) return {}
    const uniform = 1 / keys.length
    return Object.fromEntries(keys.map((key) => [key, uniform]))
  }
  return Object.fromEntries(
    Object.entries(positive).map(([key, value]) => [key, value / total]),
  )
}

/** Shannon entropy (bits) of a weight distribution. */
export function entropy(
  weights: Readonly<Record<string, number>>,
): number {
  const normalized = normalizeWeights(weights)
  return -Object.values(normalized)
    .filter((weight) => weight > 0)
    .reduce((sum, weight) => sum + weight * Math.log2(weight), 0)
}

/** `P(correct | H_i)`; missing entries default to the chance level. */
export function probabilityCorrect(
  candidate: DiagnosticCandidate,
  hypothesisId: string,
): number {
  return candidate.predictions[hypothesisId] ?? 0.5
}

/** Bayesian posterior over hypotheses after observing an answer. */
export function posteriorAfter(
  candidate: DiagnosticCandidate,
  weights: Readonly<Record<string, number>>,
  correct: boolean,
): Record<string, number> {
  const prior = normalizeWeights(weights)
  if (Object.keys(prior).length === 0) return {}
  const posterior: Record<string, number> = {}
  for (const [hypothesisId, priorWeight] of Object.entries(prior)) {
    const pCorrect = probabilityCorrect(candidate, hypothesisId)
    const likelihood = correct ? pCorrect : 1 - pCorrect
    posterior[hypothesisId] = priorWeight * likelihood
  }
  if (Object.values(posterior).reduce((sum, value) => sum + value, 0) <= 0) {
    // A deterministic prediction cannot be updated: keep the prior.
    return prior
  }
  return normalizeWeights(posterior)
}

/** Expected reduction in hypothesis entropy from asking `candidate`. */
export function expectedInformationGain(
  candidate: DiagnosticCandidate,
  weights: Readonly<Record<string, number>>,
): number {
  const prior = normalizeWeights(weights)
  if (Object.keys(prior).length === 0) return 0

  const priorEntropy = entropy(prior)
  const pCorrect = Object.entries(prior).reduce(
    (sum, [hypothesisId, weight]) =>
      sum + weight * probabilityCorrect(candidate, hypothesisId),
    0,
  )
  const pIncorrect = 1 - pCorrect
  const posteriorCorrect = posteriorAfter(candidate, prior, true)
  const posteriorIncorrect = posteriorAfter(candidate, prior, false)
  const expectedPosteriorEntropy =
    pCorrect * entropy(posteriorCorrect) +
    pIncorrect * entropy(posteriorIncorrect)
  return Math.max(0, priorEntropy - expectedPosteriorEntropy)
}

/** Score one candidate; a gate-rejected candidate scores -Infinity. */
export function scoreCandidate(
  candidate: DiagnosticCandidate,
  weights: Readonly<Record<string, number>>,
  probeWeights: ProbeWeights = DEFAULT_PROBE_WEIGHTS,
): ProbeSelection {
  if (!candidate.gateAllowed) {
    return Object.freeze({
      itemId: candidate.itemId,
      score: Number.NEGATIVE_INFINITY,
      informationGain: 0,
      teachingValue: candidate.teachingValue,
      timePenalty: candidate.timeMinutes,
      riskPenalty: candidate.risk,
      loadPenalty: candidate.cognitiveLoad,
      reasons: Object.freeze(['curriculum_gate_rejected']),
      candidate,
    })
  }

  const infoGain = expectedInformationGain(candidate, weights)
  const score =
    infoGain +
    probeWeights.alpha * candidate.teachingValue -
    probeWeights.beta * candidate.timeMinutes -
    probeWeights.gamma * candidate.risk -
    probeWeights.delta * candidate.cognitiveLoad

  return Object.freeze({
    itemId: candidate.itemId,
    score,
    informationGain: infoGain,
    teachingValue: candidate.teachingValue,
    timePenalty: candidate.timeMinutes,
    riskPenalty: candidate.risk,
    loadPenalty: candidate.cognitiveLoad,
    reasons: Object.freeze([]),
    candidate,
  })
}

/**
 * Choose the best gate-allowed probe, honouring an explicit student skip.
 *
 * Returns null when the student skipped, no candidate is allowed, or the best
 * score is below `minScore`. Diagnosing is never forced.
 */
export function selectProbe(
  candidates: readonly DiagnosticCandidate[],
  weights: Readonly<Record<string, number>>,
  options: {
    readonly probeWeights?: ProbeWeights
    readonly skipped?: boolean
    readonly minScore?: number
  } = {},
): ProbeSelection | null {
  if (options.skipped === true) return null

  const scored = candidates
    .filter((candidate) => candidate.gateAllowed)
    .map((candidate) =>
      scoreCandidate(candidate, weights, options.probeWeights),
    )
  if (scored.length === 0) return null
  scored.sort((a, b) =>
    b.score === a.score
      ? a.itemId.localeCompare(b.itemId)
      : b.score - a.score,
  )
  const best = scored[0]
  if (options.minScore !== undefined && best.score < options.minScore) {
    return null
  }
  return best
}

/** Convert the sparse tool input into the internal candidate shape. */
export function candidateFromInput(
  input: DiagnosticCandidateInput,
  gate: { allowed: boolean; reasons: readonly string[] },
): DiagnosticCandidate {
  const predictions: Record<string, number> = {}
  for (const [hypothesisId, value] of Object.entries(input.predictions ?? {})) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new DiagnosisError(
        `prediction for ${hypothesisId} must be a probability in [0, 1]`,
      )
    }
    predictions[hypothesisId] = value
  }
  return Object.freeze({
    itemId: input.item.itemId,
    predictions: Object.freeze(predictions),
    timeMinutes: Math.max(0, input.timeMinutes ?? 0),
    risk: Math.max(0, input.risk ?? 0),
    cognitiveLoad: Math.max(0, input.cognitiveLoad ?? 0),
    teachingValue: Math.max(0, input.teachingValue ?? 0),
    gateAllowed: gate.allowed,
    requiredKcs: Object.freeze([...(input.item.requiredKcs ?? [])]),
    gateReasons: Object.freeze([...gate.reasons]),
  })
}

export function probeWeightsFromInput(
  input: ProbeWeightInput = {},
): ProbeWeights {
  return Object.freeze({
    alpha: input.alpha ?? DEFAULT_PROBE_WEIGHTS.alpha,
    beta: input.beta ?? DEFAULT_PROBE_WEIGHTS.beta,
    gamma: input.gamma ?? DEFAULT_PROBE_WEIGHTS.gamma,
    delta: input.delta ?? DEFAULT_PROBE_WEIGHTS.delta,
  })
}

/** A small stateful helper around `selectProbe` for session-scoped callers. */
export class DiagnosisSession {
  weights: Record<string, number>
  readonly probeWeights: ProbeWeights
  skipped = false
  readonly asked: string[] = []

  constructor(
    weights: Readonly<Record<string, number>>,
    probeWeights: ProbeWeights = DEFAULT_PROBE_WEIGHTS,
  ) {
    this.weights = { ...weights }
    this.probeWeights = probeWeights
  }

  skip(): void {
    this.skipped = true
  }

  select(
    candidates: readonly DiagnosticCandidate[],
  ): ProbeSelection | null {
    return selectProbe(candidates, this.weights, {
      probeWeights: this.probeWeights,
      skipped: this.skipped,
    })
  }

  observe(candidate: DiagnosticCandidate, correct: boolean): void {
    this.weights = posteriorAfter(candidate, this.weights, correct)
    this.asked.push(candidate.itemId)
  }
}
