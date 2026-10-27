/**
 * Active diagnosis: backward tracing and discriminating probe selection (spec §7).
 *
 * The score is
 *
 *   IG(q) + alpha * TeachingValue(q)
 *         - beta * Time(q) - gamma * Risk(q)
 *         - delta * CognitiveLoad(q) - zeta * AnswerUncertainty(q)
 *
 * Only gate-allowed candidates participate, and the student may skip at any
 * time. The plugin recomputes the gate before selection instead of trusting a
 * model-provided `gateAllowed` flag.
 *
 * Step 14 completes the loop: `traceBackward` implements Observe → Localize →
 * Expand from the first deviating solution step to misconception / prerequisite
 * / slip explanations; `DiagnosisSession` is an explicit state machine
 * (`idle → awaiting_answer → updated → … → terminated`) with deterministic
 * termination reasons and a `BurdenBudget` cap. All data is synthetic.
 */

import {
  DiagnosisError,
  type DiagnosticCandidateInput,
  type ProbeWeightInput,
} from '../domain.ts'
import { makeHypothesis, type Hypothesis } from './hypothesis.ts'

export const UNKNOWN_HYPOTHESIS_ID = 'unknown'

/** Diagnosis-session states (spec 7.1 stage 6). */
export const STATE_IDLE = 'idle'
export const STATE_AWAITING_ANSWER = 'awaiting_answer'
export const STATE_UPDATED = 'updated'
export const STATE_TERMINATED = 'terminated'

/** Deterministic termination reasons for the diagnosis state machine. */
export const TERMINATION_STUDENT_SKIPPED = 'student_skipped'
export const TERMINATION_MAX_QUESTIONS = 'max_questions'
export const TERMINATION_BURDEN_LIMIT = 'burden_limit'
export const TERMINATION_RESOLVED = 'resolved'
export const TERMINATION_NO_PROBE = 'no_probe'
export const TERMINATION_EXPLICIT = 'explicit'

/** Backward-trace explanation kinds (spec 7.1 stage 3). */
export const TRACE_MISCONCEPTION = 'misconception'
export const TRACE_PREREQUISITE_GAP = 'prerequisite_gap'
export const TRACE_SLIP = 'slip'

export const DEFAULT_MAX_TRACE_DEPTH = 3
export const DEFAULT_SLIP_THRESHOLD = 0.6
export const DEFAULT_SLIP_BOOST = 0.35
export const DEFAULT_CONTRADICTION_DECAY = 0.25
export const DEFAULT_DEPTH_DECAY = 0.6
export const DEFAULT_TRACE_UNKNOWN_PRIOR = 0.05

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
  /** Step 14: penalty on the entropy of the predicted correctness event. */
  readonly zeta: number
}

export const DEFAULT_PROBE_WEIGHTS: ProbeWeights = Object.freeze({
  alpha: 0.2,
  beta: 0.1,
  gamma: 0.5,
  delta: 0.1,
  zeta: 0.1,
})

export interface ProbeSelection {
  readonly itemId: string
  readonly score: number
  readonly informationGain: number
  readonly teachingValue: number
  readonly timePenalty: number
  readonly riskPenalty: number
  readonly loadPenalty: number
  readonly answerUncertainty: number
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

/**
 * Entropy (bits) of the predicted correctness event for `candidate`.
 *
 * This is the spec §7.2 "uncertain answer" cost: a probe whose predicted
 * outcome is a coin flip costs more than one expected to be clearly right or
 * clearly wrong. Deterministic predictions have zero uncertainty.
 */
export function predictiveUncertainty(
  candidate: DiagnosticCandidate,
  weights: Readonly<Record<string, number>>,
): number {
  const prior = normalizeWeights(weights)
  const keys = Object.keys(prior)
  if (keys.length === 0) return 0
  let pCorrect = 0
  for (const [hypothesisId, weight] of Object.entries(prior)) {
    pCorrect += weight * probabilityCorrect(candidate, hypothesisId)
  }
  pCorrect = Math.min(1, Math.max(0, pCorrect))
  if (pCorrect <= 0 || pCorrect >= 1) return 0
  return -(pCorrect * Math.log2(pCorrect) + (1 - pCorrect) * Math.log2(1 - pCorrect))
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
      answerUncertainty: 0,
      reasons: Object.freeze(['curriculum_gate_rejected']),
      candidate,
    })
  }

  const infoGain = expectedInformationGain(candidate, weights)
  const uncertainty = predictiveUncertainty(candidate, weights)
  const score =
    infoGain +
    probeWeights.alpha * candidate.teachingValue -
    probeWeights.beta * candidate.timeMinutes -
    probeWeights.gamma * candidate.risk -
    probeWeights.delta * candidate.cognitiveLoad -
    probeWeights.zeta * uncertainty

  return Object.freeze({
    itemId: candidate.itemId,
    score,
    informationGain: infoGain,
    teachingValue: candidate.teachingValue,
    timePenalty: candidate.timeMinutes,
    riskPenalty: candidate.risk,
    loadPenalty: candidate.cognitiveLoad,
    answerUncertainty: uncertainty,
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
    zeta: input.zeta ?? DEFAULT_PROBE_WEIGHTS.zeta,
  })
}

// ---------------------------------------------------------------------------
// Step 14: backward tracing (spec 7.1)
// ---------------------------------------------------------------------------

export class DiagnosisStateError extends DiagnosisError {}
export class BackwardTraceError extends DiagnosisError {}

export interface RuleNode {
  readonly ruleId: string
  readonly kc: string
  readonly requiresRules?: readonly string[]
  readonly misconceptionIds?: readonly string[]
  readonly slipLikelihood?: number
  readonly description?: string
}

export interface MisconceptionRule {
  readonly misconceptionId: string
  readonly kc: string
  readonly requiresKcs?: readonly string[]
  readonly basePrior?: number
  readonly description?: string
}

export interface TraceGraphInput {
  readonly rules?: readonly RuleNode[]
  readonly misconceptions?: readonly MisconceptionRule[]
}

export interface TraceGraph {
  readonly rules: Readonly<Record<string, RuleNode>>
  readonly misconceptions: Readonly<Record<string, MisconceptionRule>>
}

/** Validate and index the error-rule graph used by backward tracing. */
export function makeTraceGraph(input: TraceGraphInput = {}): TraceGraph {
  const rules: Record<string, RuleNode> = {}
  for (const rule of input.rules ?? []) {
    const slip = rule.slipLikelihood ?? 0
    if (!Number.isFinite(slip) || slip < 0 || slip > 1) {
      throw new BackwardTraceError('slipLikelihood must be in [0, 1]')
    }
    rules[rule.ruleId] = Object.freeze({
      ...rule,
      requiresRules: Object.freeze([...(rule.requiresRules ?? [])]),
      misconceptionIds: Object.freeze([...(rule.misconceptionIds ?? [])]),
      slipLikelihood: slip,
    })
  }
  const misconceptions: Record<string, MisconceptionRule> = {}
  for (const item of input.misconceptions ?? []) {
    const prior = item.basePrior ?? 1
    if (!Number.isFinite(prior) || prior <= 0) {
      throw new BackwardTraceError('basePrior must be > 0')
    }
    misconceptions[item.misconceptionId] = Object.freeze({
      ...item,
      requiresKcs: Object.freeze([...(item.requiresKcs ?? [])]),
      basePrior: prior,
    })
  }
  return Object.freeze({
    rules: Object.freeze(rules),
    misconceptions: Object.freeze(misconceptions),
  })
}

export interface SolutionStep {
  readonly stepId: string
  readonly ruleId: string
  readonly kc: string
  readonly correct: boolean
  readonly dependsOn?: readonly string[]
  readonly errorType?: string | null
  readonly result?: string
}

export interface TraceExplanation {
  readonly hypothesisId: string
  readonly kind: string
  readonly kc: string
  readonly misconceptionId: string | null
  readonly label: string
  readonly path: readonly string[]
  readonly depth: number
  readonly isSlip: boolean
  readonly prior: number
  readonly plausibility: number
  readonly evidenceStepIds: readonly string[]
  readonly requiredKcs: readonly string[]
}

export interface BackwardTrace {
  readonly firstDeviationStepId: string | null
  readonly firstDeviationKc: string | null
  readonly isolatedError: boolean
  readonly explanations: readonly TraceExplanation[]
  readonly weights: Readonly<Record<string, number>>
  readonly unknownWeight: number
  readonly notes: readonly string[]
}

/** Order steps by their dependency graph, stable on the input order. */
export function orderSteps(
  steps: readonly SolutionStep[],
): readonly SolutionStep[] {
  const index: Record<string, number> = {}
  steps.forEach((step, position) => {
    if (step.stepId in index) {
      throw new BackwardTraceError(`duplicate step id: ${step.stepId}`)
    }
    index[step.stepId] = position
  })
  const byId: Record<string, SolutionStep> = {}
  for (const step of steps) byId[step.stepId] = step
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!(dependency in byId)) {
        throw new BackwardTraceError(
          `step ${step.stepId} depends on unknown step ${dependency}`,
        )
      }
    }
  }

  const result: SolutionStep[] = []
  const placed = new Set<string>()
  let remaining = [...steps]
  while (remaining.length > 0) {
    const ready = remaining.filter((step) =>
      (step.dependsOn ?? []).every((dependency) => placed.has(dependency)),
    )
    if (ready.length === 0) {
      throw new BackwardTraceError('solution steps contain a dependency cycle')
    }
    ready.sort((a, b) => index[a.stepId] - index[b.stepId])
    const chosen = ready[0]
    result.push(chosen)
    placed.add(chosen.stepId)
    remaining = remaining.filter((step) => step.stepId !== chosen.stepId)
  }
  return Object.freeze(result)
}

/** Return the first step (dependency order) that deviates from the rule. */
export function localizeFirstDeviation(
  steps: readonly SolutionStep[],
): SolutionStep | null {
  for (const step of orderSteps(steps)) {
    if (!step.correct) return step
  }
  return null
}

/** True when exactly one step is wrong and at least one step is correct. */
export function isIsolatedError(
  steps: readonly SolutionStep[],
  deviation: SolutionStep | null = null,
): boolean {
  const ordered = orderSteps(steps)
  const incorrect = ordered.filter((step) => !step.correct)
  if (deviation !== null) {
    if (incorrect.length !== 1 || incorrect[0].stepId !== deviation.stepId) {
      return false
    }
  }
  return incorrect.length === 1 && incorrect.length < ordered.length
}

export interface TraceOptions {
  readonly maxDepth?: number
  readonly slipThreshold?: number
  readonly slipBoost?: number
  readonly contradictionDecay?: number
  readonly depthDecay?: number
  readonly unknownPrior?: number
}

function normalizeTrace(
  priors: Map<string, { explanation: TraceExplanation; prior: number }>,
  unknownPrior: number,
): {
  explanations: readonly TraceExplanation[]
  weights: Record<string, number>
  unknownWeight: number
} {
  const total =
    [...priors.values()].reduce((sum, entry) => sum + Math.max(0, entry.prior), 0) +
    Math.max(0, unknownPrior)
  if (total <= 0) {
    return { explanations: Object.freeze([]), weights: {}, unknownWeight: 1 }
  }
  const explanations: TraceExplanation[] = []
  const weights: Record<string, number> = {}
  for (const [hypothesisId, entry] of priors) {
    const weight = Math.max(0, entry.prior) / total
    weights[hypothesisId] = weight
    explanations.push(
      Object.freeze({
        ...entry.explanation,
        prior: entry.prior,
        plausibility: weight,
      }),
    )
  }
  const unknownWeight = Math.max(0, unknownPrior) / total
  weights[UNKNOWN_HYPOTHESIS_ID] = unknownWeight
  explanations.sort((a, b) =>
    b.plausibility === a.plausibility
      ? a.hypothesisId.localeCompare(b.hypothesisId)
      : b.plausibility - a.plausibility,
  )
  return {
    explanations: Object.freeze(explanations),
    weights: Object.freeze(weights),
    unknownWeight,
  }
}

/**
 * Observe → Localize → Expand an attempt into upstream explanations.
 *
 * The deviation is located in dependency order; the deviating rule's error
 * rules and `REQUIRES` edges are expanded (bounded by `maxDepth`) into
 * misconception, prerequisite-gap and transient-slip explanations, normalised
 * over an explicit `unknown` bucket.
 */
export function traceBackward(
  steps: readonly SolutionStep[],
  graph: TraceGraph,
  options: TraceOptions = {},
): BackwardTrace {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_TRACE_DEPTH
  const slipThreshold = options.slipThreshold ?? DEFAULT_SLIP_THRESHOLD
  const slipBoost = options.slipBoost ?? DEFAULT_SLIP_BOOST
  const contradictionDecay =
    options.contradictionDecay ?? DEFAULT_CONTRADICTION_DECAY
  const depthDecay = options.depthDecay ?? DEFAULT_DEPTH_DECAY
  const unknownPrior = options.unknownPrior ?? DEFAULT_TRACE_UNKNOWN_PRIOR

  const ordered = orderSteps(steps)
  const deviation = localizeFirstDeviation(ordered)
  if (deviation === null) {
    return Object.freeze({
      firstDeviationStepId: null,
      firstDeviationKc: null,
      isolatedError: false,
      explanations: Object.freeze([]),
      weights: Object.freeze({ [UNKNOWN_HYPOTHESIS_ID]: 1 }),
      unknownWeight: 1,
      notes: Object.freeze(['no_deviation']),
    })
  }

  const isolated = isIsolatedError(ordered, deviation)
  const rule = graph.rules[deviation.ruleId]
  const observedRuleCorrect = new Set(
    ordered.filter((step) => step.correct).map((step) => step.ruleId),
  )
  const observedRuleIncorrect = new Set(
    ordered.filter((step) => !step.correct).map((step) => step.ruleId),
  )
  const observedKcCorrect = new Set(
    ordered.filter((step) => step.correct).map((step) => step.kc),
  )
  const observedKcIncorrect = new Set(
    ordered.filter((step) => !step.correct).map((step) => step.kc),
  )

  const priors = new Map<
    string,
    { explanation: TraceExplanation; prior: number }
  >()
  const add = (explanation: TraceExplanation, prior: number): void => {
    if (prior <= 0) return
    const existing = priors.get(explanation.hypothesisId)
    if (existing === undefined) {
      priors.set(explanation.hypothesisId, { explanation, prior })
    } else {
      priors.set(explanation.hypothesisId, {
        explanation: existing.explanation,
        prior: existing.prior + prior,
      })
    }
  }

  // Expand 1: misconceptions attached to the deviating rule.
  const misconceptionIds = rule?.misconceptionIds ?? []
  for (const misconceptionId of misconceptionIds) {
    const misconception = graph.misconceptions[misconceptionId]
    const basePrior = misconception?.basePrior ?? 1
    const kc = misconception?.kc ?? deviation.kc
    const label = misconception?.description || misconceptionId
    add(
      Object.freeze({
        hypothesisId: `misconception:${misconceptionId}`,
        kind: TRACE_MISCONCEPTION,
        kc,
        misconceptionId,
        label,
        path: Object.freeze([deviation.ruleId, misconceptionId]),
        depth: 1,
        isSlip: false,
        prior: basePrior,
        plausibility: 0,
        evidenceStepIds: Object.freeze([deviation.stepId]),
        requiredKcs: Object.freeze([...(misconception?.requiresKcs ?? [])]),
      }),
      basePrior,
    )
  }

  // Expand 2: prerequisite rules reachable through REQUIRES (bounded depth).
  if (rule !== undefined) {
    const frontier: Array<{ ruleId: string; depth: number }> = (
      rule.requiresRules ?? []
    ).map((ruleId) => ({ ruleId, depth: 1 }))
    const seen = new Set<string>()
    while (frontier.length > 0) {
      const { ruleId, depth } = frontier.shift() as {
        ruleId: string
        depth: number
      }
      if (seen.has(ruleId) || depth > maxDepth) continue
      seen.add(ruleId)
      const upstream = graph.rules[ruleId]
      if (upstream === undefined) continue
      let factor = depthDecay ** (depth - 1)
      if (observedRuleCorrect.has(ruleId)) factor *= contradictionDecay
      else if (observedRuleIncorrect.has(ruleId)) factor *= 1.5
      const basePrior = 0.5 * factor
      add(
        Object.freeze({
          hypothesisId: `prereq:${upstream.kc}`,
          kind: TRACE_PREREQUISITE_GAP,
          kc: upstream.kc,
          misconceptionId: null,
          label: `missing prerequisite ${upstream.kc}`,
          path: Object.freeze([ruleId, deviation.ruleId]),
          depth,
          isSlip: false,
          prior: basePrior,
          plausibility: 0,
          evidenceStepIds: Object.freeze(
            ordered
              .filter((step) => step.ruleId === ruleId || step.ruleId === deviation.ruleId)
              .map((step) => step.stepId),
          ),
          requiredKcs: Object.freeze([upstream.kc]),
        }),
        basePrior,
      )
      for (const nextRuleId of upstream.requiresRules ?? []) {
        frontier.push({ ruleId: nextRuleId, depth: depth + 1 })
      }
    }
  }

  // Expand 3: prerequisite KCs named by the misconceptions.
  for (const misconceptionId of misconceptionIds) {
    const misconception = graph.misconceptions[misconceptionId]
    if (misconception === undefined) continue
    for (const kc of misconception.requiresKcs ?? []) {
      let factor = depthDecay
      if (observedKcCorrect.has(kc)) factor *= contradictionDecay
      else if (observedKcIncorrect.has(kc)) factor *= 1.5
      const prior = 0.5 * factor
      add(
        Object.freeze({
          hypothesisId: `prereq:${kc}`,
          kind: TRACE_PREREQUISITE_GAP,
          kc,
          misconceptionId: null,
          label: `missing prerequisite ${kc}`,
          path: Object.freeze([deviation.ruleId, misconceptionId, kc]),
          depth: 2,
          isSlip: false,
          prior,
          plausibility: 0,
          evidenceStepIds: Object.freeze([deviation.stepId]),
          requiredKcs: Object.freeze([kc]),
        }),
        prior,
      )
    }
  }

  // Expand 4: the transient operation-slip explanation.
  let slipPrior = rule?.slipLikelihood ?? 0
  if (isolated) slipPrior = Math.min(1, slipPrior + slipBoost)
  if (slipPrior > 0 || (rule !== undefined && (rule.slipLikelihood ?? 0) > 0)) {
    if (!isolated && slipPrior < slipThreshold) slipPrior *= 0.5
    add(
      Object.freeze({
        hypothesisId: 'slip',
        kind: TRACE_SLIP,
        kc: deviation.kc,
        misconceptionId: null,
        label: 'transient operation slip',
        path: Object.freeze([deviation.ruleId]),
        depth: 1,
        isSlip: true,
        prior: slipPrior,
        plausibility: 0,
        evidenceStepIds: Object.freeze([deviation.stepId]),
        requiredKcs: Object.freeze([]),
      }),
      slipPrior,
    )
  }

  const normalized = normalizeTrace(priors, unknownPrior)
  const notes: string[] = []
  if (isolated) notes.push('isolated_error')
  if (normalized.explanations.length === 0) {
    notes.push('no_systematic_explanation')
  }
  return Object.freeze({
    firstDeviationStepId: deviation.stepId,
    firstDeviationKc: deviation.kc,
    isolatedError: isolated,
    explanations: normalized.explanations,
    weights: normalized.weights,
    unknownWeight: normalized.unknownWeight,
    notes: Object.freeze(notes),
  })
}

/** Convert a trace explanation into a short-term hypothesis (spec section 6). */
export function explanationToHypothesis(
  explanation: TraceExplanation,
  weight?: number,
): Hypothesis {
  const resolved = weight ?? explanation.plausibility
  return makeHypothesis({
    hypothesisId: explanation.hypothesisId,
    knowledgeAssumptions: { [explanation.kc]: explanation.label },
    bugRules: explanation.misconceptionId === null ? [] : [explanation.misconceptionId],
    weight: resolved,
    uncertainty: 'high',
    evidenceRefs: [...explanation.evidenceStepIds],
  })
}

export function traceToHypotheses(trace: BackwardTrace): Hypothesis[] {
  return trace.explanations.map((explanation) =>
    explanationToHypothesis(explanation, trace.weights[explanation.hypothesisId] ?? 0),
  )
}

// ---------------------------------------------------------------------------
// Step 14: diagnosis session state machine and burden budget (spec 7.2)
// ---------------------------------------------------------------------------

export interface BurdenBudget {
  readonly maxQuestions?: number
  readonly maxTotalMinutes?: number
  readonly maxTotalLoad?: number
}

export interface BurdenState {
  readonly questions: number
  readonly totalMinutes: number
  readonly totalLoad: number
}

export const EMPTY_BURDEN: BurdenState = Object.freeze({
  questions: 0,
  totalMinutes: 0,
  totalLoad: 0,
})

export interface DiagnosisTransition {
  readonly kind: string
  readonly itemId: string | null
  readonly detail: string
}

export interface DiagnosisUpdate {
  readonly itemId: string
  readonly correct: boolean
  readonly informationGain: number
  readonly weights: Readonly<Record<string, number>>
  readonly burden: BurdenState
  readonly terminationReason: string | null
}

export interface TerminationOptions {
  readonly burden?: BurdenState
  readonly budget?: BurdenBudget
  readonly skipped?: boolean
  readonly explicit?: boolean
  readonly minConfidence?: number
  readonly entropyThreshold?: number
}

/**
 * Return the deterministic termination reason, or null to continue.
 *
 * Priority: explicit stop / student skip, hard budget caps, then resolution.
 * A leading `unknown` bucket blocks a "resolved" verdict.
 */
export function shouldTerminate(
  weights: Readonly<Record<string, number>>,
  options: TerminationOptions = {},
): string | null {
  if (options.skipped === true) return TERMINATION_STUDENT_SKIPPED
  if (options.explicit === true) return TERMINATION_EXPLICIT

  const state = options.burden ?? EMPTY_BURDEN
  const limits = options.budget ?? {}
  if (
    limits.maxQuestions !== undefined &&
    state.questions >= limits.maxQuestions
  ) {
    return TERMINATION_MAX_QUESTIONS
  }
  if (
    limits.maxTotalMinutes !== undefined &&
    state.totalMinutes >= limits.maxTotalMinutes - 1e-9
  ) {
    return TERMINATION_BURDEN_LIMIT
  }
  if (
    limits.maxTotalLoad !== undefined &&
    state.totalLoad >= limits.maxTotalLoad - 1e-9
  ) {
    return TERMINATION_BURDEN_LIMIT
  }

  const normalized = normalizeWeights(weights)
  const keys = Object.keys(normalized)
  if (keys.length === 0) return null
  if (options.minConfidence !== undefined) {
    let best = 0
    for (const [key, value] of Object.entries(normalized)) {
      if (key !== UNKNOWN_HYPOTHESIS_ID && value > best) best = value
    }
    const unknown = normalized[UNKNOWN_HYPOTHESIS_ID] ?? 0
    if (
      best >= options.minConfidence &&
      unknown <= 1 - options.minConfidence + 1e-9
    ) {
      return TERMINATION_RESOLVED
    }
  }
  if (
    options.entropyThreshold !== undefined &&
    entropy(normalized) <= options.entropyThreshold + 1e-12
  ) {
    return TERMINATION_RESOLVED
  }
  return null
}

export interface DiagnosisSessionOptions {
  readonly budget?: BurdenBudget
  readonly minConfidence?: number
  readonly entropyThreshold?: number
}

/**
 * A diagnosis state machine around `selectProbe`.
 *
 * States: idle → awaiting_answer → updated (back to awaiting_answer on the
 * next selection) → terminated. Every termination carries a deterministic
 * reason and the student may skip at any point.
 */
export class DiagnosisSession {
  weights: Record<string, number>
  readonly probeWeights: ProbeWeights
  readonly budget: BurdenBudget
  readonly minConfidence?: number
  readonly entropyThreshold?: number
  skipped = false
  readonly asked: string[] = []
  state: string = STATE_IDLE
  terminationReason: string | null = null
  burden: BurdenState = EMPTY_BURDEN
  readonly history: DiagnosisTransition[] = []
  pending: ProbeSelection | null = null
  realizedInformationGain = 0

  constructor(
    weights: Readonly<Record<string, number>>,
    probeWeights: ProbeWeights = DEFAULT_PROBE_WEIGHTS,
    options: DiagnosisSessionOptions = {},
  ) {
    this.weights = { ...weights }
    this.probeWeights = probeWeights
    this.budget = options.budget ?? {}
    this.minConfidence = options.minConfidence
    this.entropyThreshold = options.entropyThreshold
  }

  get terminated(): boolean {
    return this.state === STATE_TERMINATED
  }

  get pendingItemId(): string | null {
    return this.pending?.itemId ?? null
  }

  private record(kind: string, itemId: string | null = null, detail = ''): void {
    this.history.push(Object.freeze({ kind, itemId, detail }))
  }

  private terminateWith(reason: string): void {
    this.state = STATE_TERMINATED
    this.terminationReason = reason
    this.record('terminated', null, reason)
  }

  skip(): void {
    this.skipped = true
    if (!this.terminated) this.terminateWith(TERMINATION_STUDENT_SKIPPED)
  }

  terminate(reason: string = TERMINATION_EXPLICIT): void {
    if (!this.terminated) this.terminateWith(reason)
  }

  private terminationCheck(): string | null {
    return shouldTerminate(this.weights, {
      burden: this.burden,
      budget: this.budget,
      skipped: this.skipped,
      minConfidence: this.minConfidence,
      entropyThreshold: this.entropyThreshold,
    })
  }

  select(candidates: readonly DiagnosticCandidate[]): ProbeSelection | null {
    if (this.terminated) return null
    if (this.state === STATE_AWAITING_ANSWER) {
      throw new DiagnosisStateError('an answer is still pending')
    }
    const reason = this.terminationCheck()
    if (reason !== null) {
      this.terminate(reason)
      return null
    }
    const selection = selectProbe(candidates, this.weights, {
      probeWeights: this.probeWeights,
      skipped: this.skipped,
    })
    if (selection === null) {
      this.terminate(
        this.skipped ? TERMINATION_STUDENT_SKIPPED : TERMINATION_NO_PROBE,
      )
      return null
    }
    this.pending = selection
    this.state = STATE_AWAITING_ANSWER
    this.record('selected', selection.itemId)
    return selection
  }

  observe(candidate: DiagnosticCandidate, correct: boolean): DiagnosisUpdate {
    if (this.terminated) {
      throw new DiagnosisStateError('the diagnosis session is already terminated')
    }
    const priorEntropy = entropy(this.weights)
    this.weights = posteriorAfter(candidate, this.weights, correct)
    this.asked.push(candidate.itemId)
    const gain = Math.max(0, priorEntropy - entropy(this.weights))
    this.realizedInformationGain += gain
    this.burden = Object.freeze({
      questions: this.burden.questions + 1,
      totalMinutes: this.burden.totalMinutes + Math.max(0, candidate.timeMinutes),
      totalLoad: this.burden.totalLoad + Math.max(0, candidate.cognitiveLoad),
    })
    this.state = STATE_UPDATED
    this.pending = null
    this.record('observed', candidate.itemId, `correct=${correct}`)
    const reason = this.terminationCheck()
    if (reason !== null) this.terminate(reason)
    return Object.freeze({
      itemId: candidate.itemId,
      correct,
      informationGain: gain,
      weights: Object.freeze({ ...this.weights }),
      burden: this.burden,
      terminationReason: this.terminationReason,
    })
  }
}
