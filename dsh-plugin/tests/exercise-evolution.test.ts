/**
 * Step 10 tests: exercise evolution engine and isolated simulation lab.
 *
 * The shared JSON fixture is also consumed by `tests/test_exercise_evolution.py`,
 * so the deterministic RNG, candidate hashes, and simulation result
 * fingerprints are checked against the same values in both languages. Every
 * id and annotation is synthetic and content-free.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CandidatePoolError,
  CONTEXT_TAGS,
  EVOLUTION_OPERATORS,
  EvolutionCandidatePool,
  EvolutionValidationError,
  ExerciseEvolutionEngine,
  OPERATOR_CONTEXT,
  OPERATOR_DIAGNOSTIC,
  OPERATOR_DIFFICULTY,
  OPERATOR_DISTRACTOR,
  OPERATOR_NUMERIC,
  OperatorNotApplicableError,
  PHASE_INTERVENTION,
  PHASE_POST_FAR,
  PHASE_POST_NEAR,
  PHASE_PRE,
  SimulationConfigError,
  SimulationEventLog,
  SimulationIsolationError,
  SimulationLab,
  affectedKcs,
  candidateContentHash,
  fnv1a32,
  jsRound,
  makeHypothesisSnapshot,
  makeSimulationConfig,
  mulberry32,
  quantizeMicros,
  round4,
  snapshotFromHypothesisSet,
  type HypothesisSnapshot as Snapshot,
  type SimulationHypothesis,
  type VariantSpecInput,
} from '../src/core/exercise-evolution.ts'
import {
  ItemBank,
  KnowledgeGraph,
  contentHash,
  normalizeItemAnnotation,
  type ItemAnnotation as Annotation,
} from '../src/core/curriculum-graph.ts'
import { HypothesisSet, makeHypothesis } from '../src/core/hypothesis.ts'
import type { LearnerProgress } from '../src/domain.ts'

const FIXTURE = new URL(
  '../../tests/fixtures/exercise_evolution_step10.json',
  import.meta.url,
)

const KC = 'kc.quadratic.formula'
const PREREQ = 'kc.arith.square_root'

interface Fixture {
  readonly rng: { readonly seed: number; readonly micros: readonly number[] }
  readonly fnv: { readonly text: string; readonly hash: number }
  readonly operators: {
    readonly sourceItemId: string
    readonly sourceAnnotation: Record<string, unknown>
    readonly sourceAnnotationHash: string
    readonly engineSeed: number
    readonly cases: readonly {
      readonly operator: string
      readonly spec: VariantSpecInput
      readonly candidateId: string
      readonly proposedItemId: string
      readonly affectedKcs: readonly string[]
      readonly changeSummary: string
      readonly candidateHash: string
    }[]
  }
  readonly simulation: {
    readonly config: Parameters<typeof makeSimulationConfig>[0]
    readonly snapshot: {
      readonly snapshotId: string
      readonly hypotheses: readonly SimulationHypothesis[]
      readonly unknownWeight: number
    }
    readonly itemsByPhase: Readonly<Record<string, readonly string[]>>
    readonly expected: {
      readonly resultFingerprint: string
      readonly sessionId: string
      readonly preAccuracyMicros: number
      readonly postAccuracyMicros: number
      readonly gainMicros: number
      readonly stepCorrectness: readonly boolean[]
      readonly stepHypothesisIds: readonly string[]
    }
  }
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

function makeAnnotation(
  overrides: Record<string, unknown> = {},
): Annotation {
  return normalizeItemAnnotation({
    source: 'synthetic.bank',
    license: 'synthetic-only',
    stage: 'secondary',
    course: 'synthetic.mathematics',
    gradeLevel: 8,
    curriculumNodeIds: [KC],
    requiredKcs: [KC],
    qMatrix: [{ kcId: KC, confidence: 0.95 }],
    difficulty: 0.5,
    itemType: 'multiple_choice',
    estimatedMinutes: 5.0,
    verifierType: 'deterministic',
    safetyChecked: true,
    contentVerified: true,
    correctnessVerified: true,
    annotationConfidence: 0.95,
    cognitiveLoad: 0.2,
    ...overrides,
  })
}

function makeGraph(): KnowledgeGraph {
  return new KnowledgeGraph({
    version: 1,
    nodes: [
      { nodeId: KC, nodeType: 'knowledge_component' },
      { nodeId: PREREQ, nodeType: 'knowledge_component' },
    ],
    edges: [
      {
        sourceId: KC,
        targetId: PREREQ,
        relation: 'REQUIRES',
        status: 'approved',
        confidence: 1.0,
        provenance: 'synthetic',
      },
    ],
  })
}

function taughtProgress(overrides: Partial<LearnerProgress> = {}): LearnerProgress {
  return {
    studentRef: 'synthetic.student.001',
    gradeLevel: 8,
    taughtKcs: [KC, PREREQ],
    progressConfidence: 0.95,
    currentLoad: 0,
    loadBudget: 1.0,
    ...overrides,
  }
}

function makeBank(itemId = 'item.quad.001', overrides: Record<string, unknown> = {}) {
  const bank = new ItemBank()
  bank.addItem(itemId, makeAnnotation(overrides), { reviewStatus: 'approved' })
  return { bank, itemId }
}

function makeSnapshot(snapshotId = 'snapshot.001'): Snapshot {
  const set = new HypothesisSet([
    makeHypothesis({
      hypothesisId: 'h.strategy',
      predictedObservableBehaviors: { step_correct: 0.8 },
      weight: 1.0,
    }),
    makeHypothesis({
      hypothesisId: 'h.bug',
      predictedObservableBehaviors: { step_correct: 0.25 },
      weight: 1.0,
    }),
  ], 0.1)
  return snapshotFromHypothesisSet(set, { snapshotId })
}

function phaseItems() {
  return {
    [PHASE_PRE]: ['item.pre.1', 'item.pre.2'],
    [PHASE_INTERVENTION]: ['item.train.1'],
    [PHASE_POST_NEAR]: ['item.near.1', 'item.near.2'],
    [PHASE_POST_FAR]: ['item.far.1'],
  }
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

test('mulberry32 is deterministic and in range', () => {
  const first = mulberry32(123456789)
  const second = mulberry32(123456789)
  for (let index = 0; index < 16; index += 1) {
    const value = first()
    assert.equal(value, second())
    assert.ok(value >= 0 && value < 1)
  }
})

test('fnv1a32 is stable and distinguishes operators', () => {
  assert.equal(fnv1a32('numeric'), fnv1a32('numeric'))
  assert.notEqual(fnv1a32('numeric'), fnv1a32('context'))
})

test('jsRound and round4 match Python semantics', () => {
  assert.equal(jsRound(2.5), 3)
  assert.equal(jsRound(-2.5), -2)
  assert.equal(round4(0.5499999999999999), 0.55)
  assert.equal(round4(0.1 + 0.2), 0.3)
  assert.equal(quantizeMicros(-0.25), -250000)
})

// ---------------------------------------------------------------------------
// Evolution operators and provenance
// ---------------------------------------------------------------------------

test('every operator produces provenance with source, changes, affected KCs', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })
  for (const operator of EVOLUTION_OPERATORS) {
    const candidate = engine.generate(itemId, { operator })
    assert.equal(candidate.provenance.operator, operator)
    assert.equal(candidate.provenance.sourceItemId, itemId)
    assert.equal(candidate.provenance.sourceItemVersion, 1)
    assert.ok(candidate.provenance.changeSummary.length > 0)
    assert.ok(Object.keys(candidate.provenance.changes).length > 0)
    assert.ok(candidate.provenance.affectedKcs.includes(KC))
    assert.notEqual(candidateContentHash(candidate), '')
  }
})

test('operator-specific behavior mirrors Python', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })

  const numeric = engine.generate(itemId, {
    operator: OPERATOR_NUMERIC,
    numericDelta: 0.13,
  })
  const numericChanges = numeric.provenance.changes.numeric_parameters as Record<
    string,
    unknown
  >
  assert.equal(numericChanges.coefficient_delta, 0.13)

  const pinned = engine.generate(itemId, {
    operator: OPERATOR_CONTEXT,
    contextTag: CONTEXT_TAGS[0],
  })
  const context = pinned.provenance.changes.surface_context as Record<string, unknown>
  assert.equal(context.context_tag, CONTEXT_TAGS[0])
  assert.equal(context.pinned, true)

  const distractor = engine.generate(itemId, {
    operator: OPERATOR_DISTRACTOR,
    distractorCount: 4,
  })
  const distractors = distractor.provenance.changes.distractors as Record<
    string,
    unknown
  >
  assert.equal(distractors.distractor_count, 4)
  assert.ok(distractor.annotation.cognitiveLoad > 0.2)

  const harder = engine.generate(itemId, {
    operator: OPERATOR_DIFFICULTY,
    difficultyDelta: 0.2,
  })
  assert.equal(harder.annotation.difficulty, 0.7)
  assert.equal(harder.annotation.estimatedMinutes, 6)

  const diagnostic = engine.generate(itemId, {
    operator: OPERATOR_DIAGNOSTIC,
    targetMisconception: 'synthetic.misconception.square_without_compensation',
  })
  assert.equal(diagnostic.annotation.itemType, 'diagnostic')
  assert.ok(
    diagnostic.annotation.misconceptionTargets.includes(
      'synthetic.misconception.square_without_compensation',
    ),
  )
})

test('distractor operator requires a multiple_choice source', () => {
  const { bank, itemId } = makeBank('item.quad.001', { itemType: 'short_answer' })
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 1 })
  assert.throws(
    () => engine.generate(itemId, { operator: OPERATOR_DISTRACTOR }),
    OperatorNotApplicableError,
  )
})

// ---------------------------------------------------------------------------
// Fail-closed validation
// ---------------------------------------------------------------------------

test('validation fails closed on untaught KCs and missing prerequisites', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 3 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })

  const valid = engine.validate(candidate, taughtProgress())
  assert.equal(valid.valid, true)

  const untaught = engine.validate(
    candidate,
    taughtProgress({ taughtKcs: [PREREQ] }),
  )
  assert.equal(untaught.valid, false)

  const missingPrereq = engine.validate(
    candidate,
    taughtProgress({ taughtKcs: [KC] }),
  )
  assert.equal(missingPrereq.valid, false)
  assert.deepEqual(missingPrereq.missingPrerequisites, [PREREQ])
})

test('low-confidence in-progress KC stays locked', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 3 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  const validation = engine.validate(candidate, {
    studentRef: 'synthetic.student.001',
    gradeLevel: 8,
    inProgressKcs: [KC],
    progressConfidence: 0.1,
  })
  assert.equal(validation.valid, false)
})

test('missing graph and incomplete annotation fail closed', () => {
  const { bank, itemId } = makeBank('item.quad.001', { verifierType: null })
  const engine = new ExerciseEvolutionEngine(bank, null, { seed: 1 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  const validation = engine.validate(candidate, taughtProgress())
  assert.equal(validation.valid, false)
  assert.ok(validation.reasons.includes('graph_unavailable'))
  assert.ok(
    validation.reasons.some((reason) => reason.startsWith('incomplete_annotation')),
  )
})

// ---------------------------------------------------------------------------
// Sandbox, review, candidate pool
// ---------------------------------------------------------------------------

test('sandbox reports separated channels and never promotes on simulation alone', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  const verdict = engine.evaluateInSandbox(candidate, {
    snapshot: makeSnapshot(),
    itemsByPhase: phaseItems(),
  })
  assert.equal(verdict.simulatedBenefit.is_causal_evidence, false)
  assert.equal(verdict.realTransfer, null)
  assert.equal(verdict.simulation.observedWrites, 0)
  assert.equal(verdict.passedScreening, true)
  assert.equal(verdict.promotionReady, false)
  assert.ok(
    verdict.reasons.includes('promotion_blocked:real_transfer_evidence_missing'),
  )
})

test('real transfer requires a frozen set and is reported separately', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  assert.throws(
    () =>
      engine.evaluateInSandbox(candidate, {
        snapshot: makeSnapshot(),
        itemsByPhase: phaseItems(),
        realOutcomes: [
          { itemId: 'item.near.1', correct: true, source: 'student' },
        ],
      }),
    EvolutionValidationError,
  )

  const verdict = engine.evaluateInSandbox(candidate, {
    snapshot: makeSnapshot(),
    itemsByPhase: phaseItems(),
    frozenSet: {
      datasetId: 'synthetic.transfer',
      version: '1',
      transferItemIds: ['item.near.1', 'item.near.2'],
    },
    realOutcomes: [
      { itemId: 'item.near.1', correct: true, source: 'student' },
    ],
  })
  assert.notEqual(verdict.realTransfer, null)
  assert.equal(verdict.realTransfer?.causal_claim_supported, false)
  assert.equal(verdict.promotionReady, false)
  assert.ok(verdict.reasons.includes('real_transfer_failed:too_few_items'))
})

test('a simulated outcome can never be relabelled as a real source', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  assert.throws(
    () =>
      engine.evaluateInSandbox(candidate, {
        snapshot: makeSnapshot(),
        itemsByPhase: phaseItems(),
        frozenSet: {
          datasetId: 'synthetic.transfer',
          version: '1',
          transferItemIds: ['item.near.1'],
        },
        realOutcomes: [
          { itemId: 'item.near.1', correct: true, source: 'simulated' },
        ],
      }),
    /trusted observed source/,
  )
})

test('the pool only admits after sandbox screening and item-bank approval', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  const outcome = engine.screen(candidate, {
    progress: taughtProgress(),
    snapshot: makeSnapshot(),
    itemsByPhase: phaseItems(),
  })
  assert.equal(outcome.eligible, true)

  const record = engine.submitForReview(candidate, { submittedBy: 'synthetic.author' })
  assert.equal(record.reviewStatus, 'pending_review')

  const pool = new EvolutionCandidatePool()
  assert.throws(() => pool.admit(outcome, record), CandidatePoolError)

  const approved = bank.review(
    candidate.proposedItemId,
    'approve',
    'synthetic.reviewer',
  )
  const admitted = pool.admit(outcome, approved)
  assert.equal(admitted.status, 'candidate_pool')
  assert.equal(pool.list().length, 1)
  assert.equal(pool.admissionLog().length, 1)
})

test('a gate-rejected candidate never reaches the sandbox', () => {
  const { bank, itemId } = makeBank()
  const engine = new ExerciseEvolutionEngine(bank, makeGraph(), { seed: 7 })
  const candidate = engine.generate(itemId, { operator: OPERATOR_NUMERIC })
  const outcome = engine.screen(candidate, {
    progress: taughtProgress({ taughtKcs: [PREREQ] }),
    snapshot: makeSnapshot(),
    itemsByPhase: phaseItems(),
  })
  assert.equal(outcome.eligible, false)
  assert.equal(outcome.sandboxVerdict, null)
  assert.equal(outcome.status, 'rejected')
})

// ---------------------------------------------------------------------------
// Simulation isolation and reproducibility
// ---------------------------------------------------------------------------

test('simulation events are simulated-only and observedWrites stays zero', () => {
  const config = makeSimulationConfig({
    configVersion: 'synthetic.v1',
    scenarioId: 'scenario.quad.001',
    candidateId: 'cand.quad.001',
    seed: 424242,
  })
  const snapshot = makeSnapshot()
  const session = new SimulationLab().openSession(config, snapshot)
  const result = session.run(phaseItems())
  assert.equal(result.observedWrites, 0)
  assert.ok(result.steps.length > 0)
  for (const event of session.events()) assert.equal(event.source, 'simulated')

  const log = new SimulationEventLog()
  log.append({ source: 'simulated', kind: 'simulation.step', payload: {} })
  assert.throws(
    () => log.append({ source: 'student', kind: 'observed.attempt', payload: {} }),
    SimulationIsolationError,
  )
  assert.equal(log.observedWrites, 0)
})

test('the snapshot copy is independent from the source hypothesis set', () => {
  const source = new HypothesisSet([
    makeHypothesis({
      hypothesisId: 'h.a',
      predictedObservableBehaviors: { x: 0.7 },
      weight: 1.0,
    }),
  ], 0.2)
  const snapshot = snapshotFromHypothesisSet(source, {
    snapshotId: 'snapshot.independent',
  })
  const config = makeSimulationConfig({
    configVersion: 'synthetic.v1',
    scenarioId: 'scenario.quad.001',
    candidateId: 'cand.quad.001',
    seed: 1,
  })
  const session = new SimulationLab().openSession(config, snapshot)
  const before = source.weights()
  session.reweight({ 'h.a': 0.9 })
  assert.deepEqual(source.weights(), before)
  assert.notDeepEqual(session.hypothesisWeights(), before)
})

test('simulation is reproducible from config and snapshot fingerprints', () => {
  const snapshot = makeSnapshot()
  const lab = new SimulationLab()
  const first = lab.run(
    makeSimulationConfig({
      configVersion: 'v1',
      scenarioId: 'scenario.1',
      candidateId: 'cand.1',
      seed: 11,
    }),
    snapshot,
    phaseItems(),
  )
  const second = lab.run(
    makeSimulationConfig({
      configVersion: 'v1',
      scenarioId: 'scenario.1',
      candidateId: 'cand.1',
      seed: 11,
    }),
    snapshot,
    phaseItems(),
  )
  assert.equal(first.resultFingerprint, second.resultFingerprint)
  assert.equal(first.sessionId, second.sessionId)

  const different = lab.run(
    makeSimulationConfig({
      configVersion: 'v1',
      scenarioId: 'scenario.1',
      candidateId: 'cand.1',
      seed: 12,
    }),
    snapshot,
    phaseItems(),
  )
  assert.notEqual(first.resultFingerprint, different.resultFingerprint)
})

test('unknown phases and uint32 seeds are rejected', () => {
  assert.throws(
    () =>
      makeSimulationConfig({
        configVersion: 'v1',
        scenarioId: 'scenario.1',
        candidateId: 'cand.1',
        seed: 1,
        phasePlan: ['nope'],
      }),
    SimulationConfigError,
  )
  assert.throws(
    () =>
      makeSimulationConfig({
        configVersion: 'v1',
        scenarioId: 'scenario.1',
        candidateId: 'cand.1',
        seed: 2 ** 32,
      }),
    SimulationConfigError,
  )
})

// ---------------------------------------------------------------------------
// Shared Python/TypeScript fixture parity
// ---------------------------------------------------------------------------

test('shared fixture: rng, fnv, candidate hashes, simulation fingerprint', () => {
  const data = loadFixture()

  const rng = mulberry32(data.rng.seed)
  assert.deepEqual(
    data.rng.micros,
    data.rng.micros.map(() => quantizeMicros(rng())),
  )
  assert.equal(data.fnv.hash, fnv1a32(data.fnv.text))

  const { bank, itemId } = makeBankOperatorsFixture(data)
  const engine = new ExerciseEvolutionEngine(bank, null, {
    seed: data.operators.engineSeed,
  })
  for (const entry of data.operators.cases) {
    const candidate = engine.generate(data.operators.sourceItemId, entry.spec)
    assert.equal(candidate.candidateId, entry.candidateId, entry.operator)
    assert.equal(candidate.proposedItemId, entry.proposedItemId, entry.operator)
    assert.deepEqual(
      [...candidate.provenance.affectedKcs],
      entry.affectedKcs,
      entry.operator,
    )
    assert.equal(candidate.provenance.changeSummary, entry.changeSummary)
    assert.equal(candidateContentHash(candidate), entry.candidateHash)
  }
  assert.equal(data.operators.sourceItemId, itemId)

  const config = makeSimulationConfig(data.simulation.config)
  const snapshot = makeHypothesisSnapshot({
    snapshotId: data.simulation.snapshot.snapshotId,
    hypotheses: data.simulation.snapshot.hypotheses,
    unknownWeight: data.simulation.snapshot.unknownWeight,
  })
  const result = new SimulationLab().run(
    config,
    snapshot,
    data.simulation.itemsByPhase,
  )
  const expected = data.simulation.expected
  assert.equal(result.resultFingerprint, expected.resultFingerprint)
  assert.equal(result.sessionId, expected.sessionId)
  assert.equal(quantizeMicros(result.preAccuracy as number), expected.preAccuracyMicros)
  assert.equal(quantizeMicros(result.postAccuracy as number), expected.postAccuracyMicros)
  assert.equal(quantizeMicros(result.prePostGain), expected.gainMicros)
  assert.deepEqual(
    result.steps.map((step) => step.correct),
    expected.stepCorrectness,
  )
  assert.deepEqual(
    result.steps.map((step) => step.hypothesisId),
    expected.stepHypothesisIds,
  )
})

test('shared fixture: source annotation hash is stable', () => {
  const data = loadFixture()
  assert.equal(
    data.operators.sourceAnnotationHash,
    contentHash(data.operators.sourceAnnotation),
  )
})

test('shared fixture: affectedKcs unions required and q-matrix KCs', () => {
  const annotation = normalizeItemAnnotation({
    source: 'synthetic.bank',
    license: 'synthetic-only',
    stage: 'secondary',
    course: 'synthetic.mathematics',
    gradeLevel: 8,
    requiredKcs: [KC],
    qMatrix: [
      { kcId: KC, confidence: 0.9 },
      { kcId: PREREQ, confidence: 0.4 },
    ],
    difficulty: 0.5,
    itemType: 'multiple_choice',
    estimatedMinutes: 5,
    verifierType: 'deterministic',
    safetyChecked: true,
    contentVerified: true,
    correctnessVerified: true,
    annotationConfidence: 0.95,
  })
  assert.deepEqual([...affectedKcs(annotation)], [PREREQ, KC])
})

function makeBankOperatorsFixture(data: Fixture) {
  const bank = new ItemBank()
  const itemId = data.operators.sourceItemId
  bank.addItem(itemId, data.operators.sourceAnnotation, {
    reviewStatus: 'approved',
  })
  return { bank, itemId }
}
