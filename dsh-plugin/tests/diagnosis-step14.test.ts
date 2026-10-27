/**
 * Step 14 tests: active diagnosis and backward tracing (spec section 7).
 *
 * Mirrors `tests/test_diagnosis_step14.py`: Observe → Localize → Expand tracing,
 * the answer-uncertainty term, the diagnosis session state machine with
 * deterministic termination reasons, and the burden cap. All data is
 * synthetic; the shared fixture is read-only.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BackwardTraceError,
  DEFAULT_PROBE_WEIGHTS,
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
  entropy,
  expectedInformationGain,
  explanationToHypothesis,
  isIsolatedError,
  localizeFirstDeviation,
  makeTraceGraph,
  orderSteps,
  predictiveUncertainty,
  scoreCandidate,
  selectProbe,
  shouldTerminate,
  traceBackward,
  traceToHypotheses,
} from '../src/core/diagnosis.ts'
import type {
  BurdenState,
  DiagnosticCandidate,
  ProbeWeights,
  SolutionStep,
  TraceGraphInput,
} from '../src/core/diagnosis.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/diagnosis_step14.json', import.meta.url),
    'utf8',
  ),
)

function closeTo(actual: number, expected: number, places = 9): void {
  assert.ok(
    Math.abs(actual - expected) < 10 ** -places,
    `expected ${expected}, got ${actual}`,
  )
}

function graphFrom(record: TraceGraphInput) {
  return makeTraceGraph(record)
}

function stepsFrom(record: readonly Record<string, any>[]): SolutionStep[] {
  return record.map((step) => ({
    stepId: step.stepId,
    ruleId: step.ruleId,
    kc: step.kc,
    correct: step.correct,
    dependsOn: step.dependsOn ?? [],
    errorType: step.errorType ?? null,
  }))
}

function candidateFrom(record: Record<string, any>): DiagnosticCandidate {
  return {
    itemId: record.itemId,
    predictions: record.predictions ?? {},
    timeMinutes: record.timeMinutes ?? 0,
    risk: record.risk ?? 0,
    cognitiveLoad: record.cognitiveLoad ?? 0,
    teachingValue: record.teachingValue ?? 0,
    gateAllowed: record.gateAllowed ?? true,
    requiredKcs: [],
  }
}

function policyFrom(record: Record<string, number>): ProbeWeights {
  return {
    alpha: record.alpha,
    beta: record.beta,
    gamma: record.gamma,
    delta: record.delta,
    zeta: record.zeta,
  }
}

const simpleGraph = graphFrom(fixture.trace)
const simpleSteps = stepsFrom(fixture.trace.steps)

// ---------------------------------------------------------------------------
// Localize
// ---------------------------------------------------------------------------

test('step14: orderSteps is dependency ordered and stable', () => {
  const first: SolutionStep = {
    stepId: 's2',
    ruleId: 'r2',
    kc: 'kc2',
    correct: true,
    dependsOn: ['s1'],
  }
  const second: SolutionStep = {
    stepId: 's1',
    ruleId: 'r1',
    kc: 'kc1',
    correct: true,
  }
  const third: SolutionStep = {
    stepId: 's3',
    ruleId: 'r3',
    kc: 'kc3',
    correct: true,
    dependsOn: ['s2'],
  }
  const ordered = orderSteps([first, second, third])
  assert.deepEqual(
    ordered.map((step) => step.stepId),
    ['s1', 's2', 's3'],
  )
})

test('step14: malformed step graphs are rejected', () => {
  const duplicated: SolutionStep = {
    stepId: 's1',
    ruleId: 'r1',
    kc: 'kc1',
    correct: true,
  }
  assert.throws(
    () => orderSteps([duplicated, duplicated]),
    BackwardTraceError,
  )
  assert.throws(
    () =>
      orderSteps([
        {
          stepId: 's1',
          ruleId: 'r1',
          kc: 'kc1',
          correct: true,
          dependsOn: ['missing'],
        },
      ]),
    BackwardTraceError,
  )
  assert.throws(
    () =>
      orderSteps([
        { stepId: 's1', ruleId: 'r1', kc: 'kc1', correct: true, dependsOn: ['s2'] },
        { stepId: 's2', ruleId: 'r2', kc: 'kc2', correct: true, dependsOn: ['s1'] },
      ]),
    BackwardTraceError,
  )
})

test('step14: first deviation follows dependency order', () => {
  const deviation = localizeFirstDeviation(simpleSteps)
  assert.equal(deviation?.stepId, 's2')
})

test('step14: no deviation returns null', () => {
  const correct: SolutionStep[] = [
    { stepId: 's1', ruleId: 'rule.expand_square', kc: 'kc.square_formula', correct: true },
    {
      stepId: 's2',
      ruleId: 'rule.complete_square',
      kc: 'kc.completing_square',
      correct: true,
      dependsOn: ['s1'],
    },
  ]
  assert.equal(localizeFirstDeviation(correct), null)
})

test('step14: isolated versus repeated errors', () => {
  const isolated: SolutionStep[] = [
    { stepId: 's1', ruleId: 'r1', kc: 'kc1', correct: true },
    { stepId: 's2', ruleId: 'r2', kc: 'kc2', correct: false, dependsOn: ['s1'] },
  ]
  const repeated: SolutionStep[] = [
    ...isolated,
    { stepId: 's3', ruleId: 'r3', kc: 'kc3', correct: false },
  ]
  assert.equal(isIsolatedError(isolated), true)
  assert.equal(isIsolatedError(repeated), false)
  assert.equal(
    isIsolatedError([{ stepId: 's1', ruleId: 'r1', kc: 'kc1', correct: false }]),
    false,
  )
})

// ---------------------------------------------------------------------------
// Backward tracing
// ---------------------------------------------------------------------------

test('step14: no deviation yields only unknown', () => {
  const trace = traceBackward(
    [{ stepId: 's1', ruleId: 'r1', kc: 'kc1', correct: true }],
    simpleGraph,
  )
  assert.equal(trace.firstDeviationStepId, null)
  assert.deepEqual(trace.weights, { unknown: 1 })
  assert.equal(trace.unknownWeight, 1)
  assert.deepEqual([...trace.notes], ['no_deviation'])
  assert.equal(trace.explanations.length, 0)
})

test('step14: trace expands misconception, prerequisite and slip', () => {
  const trace = traceBackward(simpleSteps, simpleGraph)
  assert.equal(trace.firstDeviationStepId, 's2')
  assert.equal(trace.firstDeviationKc, 'kc.completing_square')
  assert.equal(trace.isolatedError, true)
  const kinds = Object.fromEntries(
    trace.explanations.map((explanation) => [explanation.hypothesisId, explanation.kind]),
  )
  assert.equal(kinds['misconception:mc.no_compensation'], TRACE_MISCONCEPTION)
  assert.equal(kinds['prereq:kc.identity_preservation'], TRACE_PREREQUISITE_GAP)
  assert.equal(kinds['prereq:kc.square_formula'], TRACE_PREREQUISITE_GAP)
  assert.equal(kinds['slip'], TRACE_SLIP)
  const total = Object.values(trace.weights).reduce((sum, value) => sum + value, 0)
  closeTo(total, 1)
})

test('step14: an upstream rule observed correct is decayed', () => {
  const trace = traceBackward(simpleSteps, simpleGraph)
  assert.ok(
    trace.weights['prereq:kc.square_formula'] <
      trace.weights['prereq:kc.identity_preservation'],
  )
})

test('step14: an isolated error boosts the slip prior', () => {
  const boosted = traceBackward(simpleSteps, simpleGraph)
  const repeated = traceBackward(
    [
      ...simpleSteps,
      { stepId: 's3', ruleId: 'rule.expand_square', kc: 'kc.square_formula', correct: false },
    ],
    simpleGraph,
  )
  assert.equal(boosted.isolatedError, true)
  assert.ok(boosted.notes.includes('isolated_error'))
  assert.equal(repeated.isolatedError, false)
  assert.ok(!repeated.notes.includes('isolated_error'))
  const boostedSlip = boosted.explanations.find((explanation) => explanation.isSlip)
  const repeatedSlip = repeated.explanations.find((explanation) => explanation.isSlip)
  assert.ok(boostedSlip !== undefined && repeatedSlip !== undefined)
  assert.ok(boostedSlip.prior > repeatedSlip.prior)
})

test('step14: explanations are sorted by plausibility', () => {
  const trace = traceBackward(simpleSteps, simpleGraph)
  const plausibilities = trace.explanations.map((explanation) => explanation.plausibility)
  assert.deepEqual(plausibilities, [...plausibilities].sort((a, b) => b - a))
  assert.equal(
    trace.explanations[0].hypothesisId,
    trace.explanations.reduce((best, current) =>
      current.plausibility > best.plausibility ? current : best,
    ).hypothesisId,
  )
})

test('step14: trace converts to weighted hypotheses', () => {
  const trace = traceBackward(simpleSteps, simpleGraph)
  const hypotheses = traceToHypotheses(trace)
  assert.equal(hypotheses.length, trace.explanations.length)
  const bug = hypotheses.find(
    (hypothesis) => hypothesis.hypothesisId === 'misconception:mc.no_compensation',
  )
  assert.ok(bug !== undefined)
  assert.deepEqual([...bug.bugRules], ['mc.no_compensation'])
  closeTo(bug.weight, trace.weights[bug.hypothesisId])
  const slip = hypotheses.find((hypothesis) => hypothesis.hypothesisId === 'slip')
  assert.ok(slip !== undefined)
  assert.deepEqual([...slip.bugRules], [])
  assert.deepEqual([...slip.evidenceRefs], ['s2'])

  const direct = explanationToHypothesis(trace.explanations[0])
  closeTo(direct.weight, trace.explanations[0].plausibility)
})

test('step14: unknown prior stays inside the posterior', () => {
  const trace = traceBackward(simpleSteps, simpleGraph, { unknownPrior: 0.25 })
  assert.ok(trace.unknownWeight > 0)
  const total = Object.values(trace.weights).reduce((sum, value) => sum + value, 0)
  closeTo(total, 1)
  closeTo(trace.weights.unknown, trace.unknownWeight)
})

// ---------------------------------------------------------------------------
// Information gain / uncertainty
// ---------------------------------------------------------------------------

test('step14: predictive uncertainty is one bit for a coin flip', () => {
  const candidate = candidateFrom({ itemId: 'q', predictions: { h1: 0.5, h2: 0.5 } })
  closeTo(predictiveUncertainty(candidate, { h1: 0.5, h2: 0.5 }), 1)
})

test('step14: deterministic predictions have zero uncertainty', () => {
  const candidate = candidateFrom({ itemId: 'q', predictions: { h1: 1, h2: 1 } })
  closeTo(predictiveUncertainty(candidate, { h1: 0.5, h2: 0.5 }), 0)
  closeTo(predictiveUncertainty(candidate, {}), 0)
})

test('step14: the answer-uncertainty penalty lowers the score', () => {
  const candidate = candidateFrom({ itemId: 'q', predictions: { h1: 0.5, h2: 0.5 } })
  const weights = { h1: 0.5, h2: 0.5 }
  const noPenalty: ProbeWeights = { alpha: 0, beta: 0, gamma: 0, delta: 0, zeta: 0 }
  const penalty: ProbeWeights = { alpha: 0, beta: 0, gamma: 0, delta: 0, zeta: 1 }
  assert.ok(
    scoreCandidate(candidate, weights, noPenalty).score >
      scoreCandidate(candidate, weights, penalty).score,
  )
  closeTo(scoreCandidate(candidate, weights).answerUncertainty, 1)
})

test('step14: an uncertain candidate loses to a confident one', () => {
  const uncertain = candidateFrom({ itemId: 'uncertain', predictions: { h1: 0.5, h2: 0.5 } })
  const confident = candidateFrom({ itemId: 'confident', predictions: { h1: 0.9, h2: 0.9 } })
  const policy: ProbeWeights = { alpha: 0, beta: 0, gamma: 0, delta: 0, zeta: 1 }
  const selected = selectProbe([uncertain, confident], { h1: 0.5, h2: 0.5 }, {
    probeWeights: policy,
  })
  assert.equal(selected?.itemId, 'confident')
})

test('step14: expected information gain still rewards discrimination', () => {
  const strong = candidateFrom({ itemId: 'strong', predictions: { h1: 0.95, h2: 0.05 } })
  const weak = candidateFrom({ itemId: 'weak', predictions: { h1: 0.6, h2: 0.4 } })
  assert.ok(
    expectedInformationGain(strong, { h1: 0.5, h2: 0.5 }) >
      expectedInformationGain(weak, { h1: 0.5, h2: 0.5 }),
  )
})

// ---------------------------------------------------------------------------
// Termination + state machine
// ---------------------------------------------------------------------------

const emptyBurden: BurdenState = { questions: 0, totalMinutes: 0, totalLoad: 0 }

test('step14: skip and explicit win over the budget', () => {
  const budget = { maxQuestions: 0 }
  assert.equal(
    shouldTerminate({ h1: 1 }, { budget, skipped: true }),
    TERMINATION_STUDENT_SKIPPED,
  )
  assert.equal(
    shouldTerminate({ h1: 1 }, { budget, explicit: true }),
    TERMINATION_EXPLICIT,
  )
})

test('step14: question, time and load caps terminate', () => {
  assert.equal(
    shouldTerminate({ h1: 1 }, { burden: { ...emptyBurden, questions: 2 }, budget: { maxQuestions: 2 } }),
    TERMINATION_MAX_QUESTIONS,
  )
  assert.equal(
    shouldTerminate(
      { h1: 1 },
      { burden: { ...emptyBurden, totalMinutes: 3 }, budget: { maxTotalMinutes: 3 } },
    ),
    TERMINATION_BURDEN_LIMIT,
  )
  assert.equal(
    shouldTerminate(
      { h1: 1 },
      { burden: { ...emptyBurden, totalLoad: 0.5 }, budget: { maxTotalLoad: 0.5 } },
    ),
    TERMINATION_BURDEN_LIMIT,
  )
  assert.equal(
    shouldTerminate({ h1: 1 }, { burden: { ...emptyBurden, questions: 1 }, budget: { maxQuestions: 2 } }),
    null,
  )
})

test('step14: confidence resolves but unknown dominance blocks it', () => {
  assert.equal(
    shouldTerminate({ h1: 0.9, h2: 0.1 }, { minConfidence: 0.8 }),
    TERMINATION_RESOLVED,
  )
  assert.equal(shouldTerminate({ h1: 0.6, h2: 0.4 }, { minConfidence: 0.8 }), null)
  assert.equal(shouldTerminate({ unknown: 0.9, h1: 0.1 }, { minConfidence: 0.8 }), null)
  assert.equal(shouldTerminate({ h1: 1 }, { entropyThreshold: 0.1 }), TERMINATION_RESOLVED)
  assert.equal(shouldTerminate({ h1: 0.5, h2: 0.5 }, { entropyThreshold: 0.5 }), null)
})

test('step14: state machine asks, answers and updates', () => {
  const probe = candidateFrom({
    itemId: 'q1',
    predictions: { h1: 0.9, h2: 0.1 },
    timeMinutes: 1,
    cognitiveLoad: 0.2,
  })
  const session = new DiagnosisSession({ h1: 0.5, h2: 0.5 })
  assert.equal(session.state, STATE_IDLE)
  const selection = session.select([probe])
  assert.equal(selection?.itemId, 'q1')
  assert.equal(session.state, STATE_AWAITING_ANSWER)
  assert.equal(session.pendingItemId, 'q1')
  const update = session.observe(probe, true)
  assert.equal(session.state, STATE_UPDATED)
  assert.equal(session.pendingItemId, null)
  assert.ok(update.weights.h1 > update.weights.h2)
  assert.ok(session.realizedInformationGain > 0)
  assert.deepEqual(session.asked, ['q1'])
})

test('step14: illegal transitions are rejected', () => {
  const probe = candidateFrom({ itemId: 'q1', predictions: { h1: 0.9, h2: 0.1 } })
  const session = new DiagnosisSession({ h1: 0.5, h2: 0.5 })
  session.select([probe])
  assert.throws(() => session.select([probe]), DiagnosisStateError)
  session.skip()
  assert.throws(() => session.observe(probe, true), DiagnosisStateError)
})

test('step14: student skip terminates without asking', () => {
  const probe = candidateFrom({ itemId: 'q1', predictions: { h1: 0.9, h2: 0.1 } })
  const session = new DiagnosisSession({ h1: 0.5, h2: 0.5 })
  session.select([probe])
  session.skip()
  assert.equal(session.state, STATE_TERMINATED)
  assert.equal(session.terminationReason, TERMINATION_STUDENT_SKIPPED)
  assert.equal(session.select([probe]), null)
  assert.deepEqual(session.asked, [])
})

test('step14: caps terminate the session', () => {
  const probe = candidateFrom({
    itemId: 'q1',
    predictions: { h1: 0.9, h2: 0.1 },
    timeMinutes: 1,
    cognitiveLoad: 0.2,
  })
  const byQuestions = new DiagnosisSession(
    { h1: 0.5, h2: 0.5 },
    DEFAULT_PROBE_WEIGHTS,
    { budget: { maxQuestions: 1 } },
  )
  byQuestions.select([probe])
  byQuestions.observe(probe, true)
  assert.equal(byQuestions.terminationReason, TERMINATION_MAX_QUESTIONS)
  assert.equal(byQuestions.burden.questions, 1)

  const byTime = new DiagnosisSession(
    { h1: 0.5, h2: 0.5 },
    DEFAULT_PROBE_WEIGHTS,
    { budget: { maxTotalMinutes: 1 } },
  )
  byTime.select([probe])
  byTime.observe(probe, true)
  assert.equal(byTime.terminationReason, TERMINATION_BURDEN_LIMIT)
  closeTo(byTime.burden.totalMinutes, 1)
})

test('step14: zero budget refuses to start and blocked probes terminate', () => {
  const probe = candidateFrom({ itemId: 'q1', predictions: { h1: 0.9 } })
  const zero = new DiagnosisSession(
    { h1: 0.5, h2: 0.5 },
    DEFAULT_PROBE_WEIGHTS,
    { budget: { maxQuestions: 0 } },
  )
  assert.equal(zero.select([probe]), null)
  assert.equal(zero.terminationReason, TERMINATION_MAX_QUESTIONS)

  const blocked = candidateFrom({
    itemId: 'blocked',
    predictions: { h1: 0.9 },
    gateAllowed: false,
  })
  const session = new DiagnosisSession({ h1: 0.5, h2: 0.5 })
  assert.equal(session.select([blocked]), null)
  assert.equal(session.terminationReason, TERMINATION_NO_PROBE)
})

test('step14: confidence and entropy can terminate the session', () => {
  const probe = candidateFrom({ itemId: 'q1', predictions: { h1: 0.9, h2: 0.1 } })
  const confident = new DiagnosisSession({ h1: 0.5, h2: 0.5 }, DEFAULT_PROBE_WEIGHTS, {
    minConfidence: 0.85,
  })
  confident.select([probe])
  confident.observe(probe, true)
  assert.equal(confident.terminationReason, TERMINATION_RESOLVED)
  closeTo(confident.weights.h1, 0.9)

  const strong = candidateFrom({ itemId: 'q1', predictions: { h1: 1, h2: 0 } })
  const lowEntropy = new DiagnosisSession({ h1: 0.5, h2: 0.5 }, DEFAULT_PROBE_WEIGHTS, {
    entropyThreshold: 0.2,
  })
  lowEntropy.select([strong])
  lowEntropy.observe(strong, true)
  assert.ok(entropy(lowEntropy.weights) <= 0.2)
  assert.equal(lowEntropy.terminationReason, TERMINATION_RESOLVED)
})

test('step14: explicit termination and transition history', () => {
  const probe = candidateFrom({ itemId: 'q1', predictions: { h1: 0.9, h2: 0.1 } })
  const session = new DiagnosisSession({ h1: 0.5, h2: 0.5 })
  session.select([probe])
  session.observe(probe, false)
  session.terminate()
  assert.equal(session.terminationReason, TERMINATION_EXPLICIT)
  assert.deepEqual(
    session.history.map((transition) => transition.kind),
    ['selected', 'observed', 'terminated'],
  )
})

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

test('step14: trace matches the shared fixture', () => {
  const record = fixture.trace
  const trace = traceBackward(stepsFrom(record.steps), graphFrom(record))
  const expected = record.expected
  assert.equal(trace.firstDeviationStepId, expected.firstDeviationStepId)
  assert.equal(trace.firstDeviationKc, expected.firstDeviationKc)
  assert.equal(trace.isolatedError, expected.isolatedError)
  assert.deepEqual([...trace.notes], expected.notes)
  assert.deepEqual(
    trace.explanations.map((explanation) => explanation.hypothesisId),
    expected.explanationIds,
  )
  assert.equal(trace.explanations[0].hypothesisId, expected.dominantId)
  for (const [hypothesisId, weight] of Object.entries(expected.weights)) {
    closeTo(trace.weights[hypothesisId], weight as number)
  }
})

test('step14: probe scoring matches the shared fixture', () => {
  const probes = fixture.probes
  const policy = policyFrom(probes.policy)
  const weights = probes.weights
  const expected = probes.expected
  const candidates = probes.candidates.map(candidateFrom)
  for (const candidate of candidates) {
    const selection = scoreCandidate(candidate, weights, policy)
    if (!candidate.gateAllowed) {
      assert.equal(selection.score, Number.NEGATIVE_INFINITY)
      assert.ok(expected.rejectedIds.includes(candidate.itemId))
      continue
    }
    closeTo(selection.informationGain, expected.informationGain[candidate.itemId])
    closeTo(selection.answerUncertainty, expected.answerUncertainty[candidate.itemId])
    closeTo(selection.score, expected.score[candidate.itemId])
  }
  const selected = selectProbe(candidates, weights, { probeWeights: policy })
  assert.equal(selected?.itemId, expected.selectedId)
  closeTo(selected?.score ?? Number.NaN, expected.selectedScore)
})

test('step14: session matches the shared fixture', () => {
  const record = fixture.session
  const policy = policyFrom(record.policy)
  const budget = record.budget
  const session = new DiagnosisSession(record.weights, policy, {
    budget: {
      maxQuestions: budget.maxQuestions ?? undefined,
      maxTotalMinutes: budget.maxTotalMinutes ?? undefined,
      maxTotalLoad: budget.maxTotalLoad ?? undefined,
    },
    minConfidence: record.minConfidence ?? undefined,
    entropyThreshold: record.entropyThreshold ?? undefined,
  })
  const candidates: DiagnosticCandidate[] = fixture.probes.candidates.map(candidateFrom)
  const byId = new Map<string, DiagnosticCandidate>(
    candidates.map((candidate) => [candidate.itemId, candidate]),
  )
  const states: string[] = []
  const asked: string[] = []
  for (const entry of record.script) {
    const selection = session.select(candidates)
    assert.ok(selection !== null)
    assert.equal(selection.itemId, entry.itemId)
    states.push(session.state)
    session.observe(byId.get(selection.itemId) as DiagnosticCandidate, entry.correct)
    states.push(session.state)
    asked.push(selection.itemId)
  }

  const expected = record.expected
  assert.deepEqual(states, expected.states)
  assert.deepEqual(asked, expected.asked)
  assert.equal(session.terminationReason, expected.terminationReason)
  assert.equal(session.burden.questions, expected.burden.questions)
  closeTo(session.burden.totalMinutes, expected.burden.totalMinutes)
  closeTo(session.burden.totalLoad, expected.burden.totalLoad)
  closeTo(session.realizedInformationGain, expected.realizedInformationGain)
  for (const [hypothesisId, weight] of Object.entries(expected.finalWeights)) {
    closeTo(session.weights[hypothesisId], weight as number)
  }
})

test('step14: fixture entropy matches', () => {
  closeTo(entropy(fixture.probes.weights), fixture.entropy)
})
