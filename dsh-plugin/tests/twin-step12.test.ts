/**
 * Step 12 tests: long-term twin lifecycle, isolation, memory, calibration, and
 * hypothesis evolution. Mirrors `tests/test_twin_step12.py`.
 *
 * All events, observations and parameters are synthetic. No filesystem,
 * network, database, or real student data is touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { StudentTwin } from '../src/core/twin.ts'
import type {
  HypothesisOperationInput,
  TwinEventInput,
} from '../src/core/twin.ts'
import { HypothesisSet, makeHypothesis } from '../src/core/hypothesis.ts'
import {
  MemoryParameters,
  createMemoryState,
  updateMemory,
} from '../src/core/memory.ts'
import type { MemoryObservationInput } from '../src/domain.ts'

const FIXED_NOW = '2026-03-01T12:00:00.000Z'

function at(day: number, hour = 12): string {
  return new Date(Date.UTC(2026, 0, day, hour, 0, 0)).toISOString()
}

function real(
  eventId: string,
  day = 1,
  overrides: Partial<TwinEventInput> = {},
): TwinEventInput {
  return {
    eventId,
    eventType: 'attempt',
    source: 'student',
    studentRef: 'stu_1',
    occurredAt: at(day),
    payload: { correct: true },
    ...overrides,
  }
}

function simulated(
  eventId = 'sim_1',
  overrides: Partial<TwinEventInput> = {},
): TwinEventInput {
  return {
    eventId,
    eventType: 'simulated_attempt',
    source: 'simulated',
    studentRef: 'stu_1',
    occurredAt: at(1),
    payload: { masteryMean: 1 },
    ...overrides,
  }
}

function observation(
  observationId = 'o1',
  day = 1,
  overrides: Partial<MemoryObservationInput> = {},
): MemoryObservationInput {
  return {
    observationId,
    success: true,
    independent: true,
    hintLevel: 0,
    kind: 'attempt',
    occurredAt: at(day),
    ...overrides,
  }
}

function newTwin(): StudentTwin {
  return new StudentTwin('stu_1', { clock: () => FIXED_NOW })
}

const CALIBRATED = {
  initial_stability_days: 2.0,
  success_growth: 0.8,
  failure_shrink: 0.3,
  initial_difficulty: 4.0,
  difficulty_success_delta: 0.1,
  difficulty_failure_delta: 0.6,
  parameter_version: 'fsrs_calibrated_synthetic_v1',
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('step12: append/version/checkpoint/rollback/replay keep evidence intact', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordObserved(real('ev_2', 2))
  twin.updateMastery('kc.a', 0.4, 0.2, ['ev_1'])
  twin.updateMastery('kc.b', 0.7, 0.1, ['ev_2'])
  assert.equal(twin.version, 2)

  const checkpoint = twin.createCheckpoint('two')
  assert.equal(checkpoint.version, 2)
  assert.equal(checkpoint.evidenceRevision, 2)
  assert.equal(checkpoint.createdAt, FIXED_NOW)

  twin.updateMastery('kc.c', 0.9, 0.05, ['ev_1', 'ev_2'])
  assert.equal(twin.version, 3)
  assert.ok(twin.knowledgeFor('kc.c'))

  const restored = twin.restoreCheckpoint(checkpoint.checkpointId)
  assert.equal(restored.version, 2)
  assert.equal(twin.knowledgeFor('kc.c'), undefined)
  assert.equal(twin.evidenceRevision, 2)
  assert.deepEqual([...twin.observedEvidenceIds].sort(), ['ev_1', 'ev_2'])
})

test('step12: replay is deterministic and matches incremental state', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordObserved(real('ev_2', 2))
  twin.updateMastery('kc.a', 0.4, 0.2, ['ev_1'])
  twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  twin.bindHypotheses(
    new HypothesisSet([makeHypothesis({ hypothesisId: 'h1', weight: 1 })]),
    { evidenceIds: ['ev_1'] },
  )
  const before = twin.snapshot()
  const replayed = twin.replay()
  assert.deepEqual(
    [...replayed.knowledge.keys()],
    [...before.knowledge.map((estimate) => estimate.kcId)],
  )
  assert.equal(replayed.hypothesisRevision, twin.state.hypothesisRevision)
  assert.equal(twin.version, 3)
})

test('step12: a correction is a new event, not a history edit', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordObserved(
    real('ev_corr', 2, { source: 'teacher', eventType: 'correction' }),
  )
  twin.updateMastery('kc.a', 0.3, 0.2, ['ev_1'])
  twin.updateMastery('kc.a', 0.6, 0.1, ['ev_corr'])
  assert.equal(twin.evidenceRevision, 2)
  assert.deepEqual(twin.knowledgeFor('kc.a')?.evidenceIds, ['ev_corr'])
})

test('step12: checkpoints minimise private payload fields', () => {
  const twin = newTwin()
  twin.recordObserved(
    real('ev_1', 1, { payload: { rawAnswer: 'SYNTHETIC_SECRET' } }),
  )
  twin.updateMastery('kc.a', 0.4, 0.2, ['ev_1'])
  const projected = twin.createCheckpoint().asDict()
  const text = JSON.stringify(projected)
  assert.equal('payload' in projected, false)
  assert.equal(text.includes('rawAnswer'), false)
  assert.equal(text.includes('SYNTHETIC_SECRET'), false)
})

test('step12: rollback and checkpoint errors are explicit', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.updateMastery('kc.a', 0.4, 0.2, ['ev_1'])
  assert.throws(() => twin.rollback(99), /unknown twin version/)
  assert.throws(() => twin.restoreCheckpoint('ckpt_missing'), /unknown checkpoint/)
})

// ---------------------------------------------------------------------------
// Observed / simulated isolation
// ---------------------------------------------------------------------------

test('step12: simulated events never enter observed or back inferred updates', () => {
  const twin = newTwin()
  assert.throws(() => twin.recordObserved(simulated()), /cannot write observed/)
  assert.equal(twin.observed().length, 0)
  assert.equal(twin.version, 0)

  twin.recordSimulated(simulated('sim_1'))
  assert.throws(
    () => twin.recordMemoryReview('kc.a', observation(), ['sim_1']),
    /non-observed evidence/,
  )
  assert.throws(
    () =>
      twin.bindHypotheses(
        new HypothesisSet([makeHypothesis({ hypothesisId: 'h1', weight: 1 })]),
        { evidenceIds: ['sim_1'] },
      ),
    /non-observed evidence/,
  )
  assert.throws(
    () =>
      twin.evolveHypotheses({
        kind: 'spawn',
        hypothesis: makeHypothesis({ hypothesisId: 'h1', weight: 1 }),
        evidenceIds: ['sim_1'],
      }),
    /non-observed evidence/,
  )
  assert.equal(twin.memoryFor('kc.a'), undefined)
  assert.equal(twin.version, 0)
})

test('step12: simulated high mastery cannot rewrite real mastery', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.updateMastery('kc.a', 0.55, 0.2, ['ev_1'])
  const before = twin.knowledgeFor('kc.a')
  twin.recordSimulated(simulated('sim_high'))
  assert.throws(
    () => twin.updateMastery('kc.a', 1, 0, ['sim_high']),
    /non-observed evidence/,
  )
  assert.deepEqual(twin.knowledgeFor('kc.a'), before)
  assert.throws(() => twin.promoteSimulated('sim_high'), /cannot be promoted/)
})

test('step12: stale simulations are rejected', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  assert.throws(() => twin.assertFreshSimulation(0), /parent revision/)
  twin.assertFreshSimulation(1)
})

// ---------------------------------------------------------------------------
// Multi-KC memory
// ---------------------------------------------------------------------------

test('step12: memory reviews integrate multiple KCs and aggregate', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordObserved(real('ev_2', 2))
  const first = twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  const second = twin.recordMemoryReview('kc.b', observation('o2', 2), ['ev_2'])
  assert.equal(first.stabilityDays, 1.6)
  assert.equal(second.stabilityDays, 1.6)
  assert.deepEqual([...twin.memoryStates().keys()].sort(), ['kc.a', 'kc.b'])
  const summary = twin.memoryAggregate(at(40))
  assert.equal(summary['unitCount'], 2)
  assert.equal(summary['overdueCount'], 2)
})

test('step12: reading never creates a memory version', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  const version = twin.version
  const state = twin.memoryFor('kc.a')
  const returned = twin.recordMemoryReview(
    'kc.a',
    observation('o2', 2, { kind: 'reading' }),
    ['ev_1'],
  )
  assert.equal(returned, state)
  assert.equal(twin.version, version)
})

test('step12: forgetting raises uncertainty but never lowers stability', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  const aged = twin.applyMemoryForgetting(at(45))
  assert.deepEqual([...aged], ['kc.a'])
  const state = twin.memoryFor('kc.a')
  assert.ok(state)
  assert.equal(state?.needsCalibration, true)
  assert.equal(state?.stabilityDays, 1.6)
})

test('step12: forgetting no-op does not bump the version', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  const version = twin.version
  assert.deepEqual([...twin.applyMemoryForgetting(at(1, 13))], [])
  assert.equal(twin.version, version)
})

test('step12: memory parameters are validated and baseline-equivalent', () => {
  const state = createMemoryState('stu_1', 'kc')
  const legacy = updateMemory(state, observation())
  const explicit = updateMemory(state, observation(), new MemoryParameters())
  assert.equal(legacy.stabilityDays, explicit.stabilityDays)
  assert.equal(legacy.difficulty, explicit.difficulty)
  assert.equal(new MemoryParameters().parameterVersion, 'fsrs_illustrative_19_81')
  assert.throws(() => new MemoryParameters({ initialStabilityDays: 0 }), /must be > 0/)
  assert.throws(
    () => MemoryParameters.fromMapping({ initial_stability_days: 1 }),
    /finite number/,
  )
})

// ---------------------------------------------------------------------------
// Calibration gate
// ---------------------------------------------------------------------------

test('step12: a pending calibration does not take effect', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  twin.proposeMemoryCalibration(CALIBRATED, { candidateId: 'cal.1' })
  assert.ok(twin.pendingCalibration)
  assert.equal(twin.activeParameterVersion, 'fsrs_illustrative_19_81')
  const updated = twin.recordMemoryReview('kc.a', observation('o2', 2), ['ev_1'])
  assert.ok(Math.abs((updated.stabilityDays - 1.6 * 1.6)) < 1e-9)
})

test('step12: activation requires an explicit approval', () => {
  const twin = newTwin()
  twin.proposeMemoryCalibration(CALIBRATED, { candidateId: 'cal.1' })
  assert.throws(
    () => twin.activateMemoryCalibration({ approvalId: '', approvedBy: 'teacher' }),
    /explicit approval/,
  )
  assert.throws(
    () => twin.activateMemoryCalibration({ approvalId: 'ap-1', approvedBy: '' }),
    /explicit approval/,
  )
  assert.equal(twin.activeParameterVersion, 'fsrs_illustrative_19_81')
})

test('step12: an approved calibration changes review dynamics', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.proposeMemoryCalibration(CALIBRATED, { candidateId: 'cal.1' })
  const activation = twin.activateMemoryCalibration({
    approvalId: 'ap-1',
    approvedBy: 'teacher',
  })
  assert.equal(activation.parameterVersion, 'fsrs_calibrated_synthetic_v1')
  assert.equal(twin.activeParameterVersion, 'fsrs_calibrated_synthetic_v1')
  const updated = twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  assert.ok(Math.abs(updated.stabilityDays - 3.6) < 1e-9)
  assert.equal(updated.modelVersion, 'fsrs_calibrated_synthetic_v1')
})

test('step12: rollback restores the pre-activation parameter version', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  const checkpoint = twin.createCheckpoint('before-calibration')
  twin.proposeMemoryCalibration(CALIBRATED, { candidateId: 'cal.1' })
  twin.activateMemoryCalibration({ approvalId: 'ap-1', approvedBy: 'teacher' })
  twin.recordMemoryReview('kc.a', observation('o1', 1), ['ev_1'])
  twin.restoreCheckpoint(checkpoint.checkpointId)
  assert.equal(twin.activeParameterVersion, 'fsrs_illustrative_19_81')
  const baseline = twin.recordMemoryReview('kc.a', observation('o2', 2), ['ev_1'])
  assert.ok(Math.abs(baseline.stabilityDays - 1.6) < 1e-9)
})

test('step12: activation and rollback are versioned; rejection is a no-op', () => {
  const twin = newTwin()
  twin.proposeMemoryCalibration(CALIBRATED, { candidateId: 'cal.1' })
  twin.activateMemoryCalibration({ approvalId: 'ap-1', approvedBy: 'teacher' })
  assert.equal(twin.version, 1)
  const rollback = twin.rollbackMemoryCalibration({
    approvalId: 'ap-2',
    approvedBy: 'teacher',
  })
  assert.equal(rollback.kind, 'rollback')
  assert.equal(twin.version, 2)
  assert.equal(twin.activeParameterVersion, 'fsrs_illustrative_19_81')

  twin.proposeMemoryCalibration(CALIBRATED, { candidateId: 'cal.2' })
  assert.ok(twin.rejectMemoryCalibration('not enough evidence'))
  assert.equal(twin.pendingCalibration, null)
})

test('step12: a Step 11 candidate can be attached without taking effect', () => {
  const candidate = {
    candidateId: 'fsrs.calibration.synthetic_v1',
    version: 'synthetic_v1',
    changes: {
      parameters: {
        initial_stability_days: 2,
        success_growth: 0.8,
        failure_shrink: 0.3,
        initial_difficulty: 4,
        difficulty_success_delta: 0.1,
        difficulty_failure_delta: 0.6,
      },
      parameter_version: 'fsrs_calibrated_synthetic_v1',
      report_fingerprint: 'fp_synthetic',
    },
  }
  const twin = newTwin()
  const pending = twin.proposeMemoryCalibrationFromCandidate(candidate, {
    proposedBy: 'host',
  })
  assert.equal(pending.candidateId, 'fsrs.calibration.synthetic_v1')
  assert.equal(pending.fingerprint, 'fp_synthetic')
  assert.equal(
    pending.parameters.parameterVersion,
    'fsrs_calibrated_synthetic_v1',
  )
})

// ---------------------------------------------------------------------------
// Hypothesis evolution
// ---------------------------------------------------------------------------

test('step12: bind and reweight track the twin version', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordObserved(real('ev_2', 2))
  const binding = twin.bindHypotheses(
    new HypothesisSet([
      makeHypothesis({ hypothesisId: 'h1', weight: 1 }),
      makeHypothesis({ hypothesisId: 'h2', weight: 1 }),
    ]),
    { evidenceIds: ['ev_1'] },
  )
  assert.equal(binding.twinVersion, 1)
  assert.equal(twin.hypotheses?.boundTwinVersion, 1)

  const updated = twin.evolveHypotheses({
    kind: 'reweight',
    likelihoods: { h1: 0.9, h2: 0.1 },
    evidenceIds: ['ev_1', 'ev_2'],
  })
  assert.equal(updated.twinVersion, 2)
  assert.equal(twin.hypotheses?.boundTwinVersion, 2)
  assert.ok((updated.weights['h1'] as number) > (updated.weights['h2'] as number))
  const total = Object.values(updated.weights).reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
})

test('step12: all five hypothesis operations keep the set normalised', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.recordObserved(real('ev_2', 2))
  const spawn = (id: string): HypothesisOperationInput => ({
    kind: 'spawn',
    hypothesis: makeHypothesis({ hypothesisId: id, weight: 1 }),
    evidenceIds: ['ev_1'],
  })
  twin.evolveHypotheses(spawn('h1'))
  twin.evolveHypotheses(spawn('h2'))
  twin.evolveHypotheses({
    kind: 'split',
    hypothesisId: 'h1',
    children: [
      makeHypothesis({ hypothesisId: 'h1a', weight: 1 }),
      makeHypothesis({ hypothesisId: 'h1b', weight: 1 }),
    ],
    evidenceIds: ['ev_2'],
  })
  twin.evolveHypotheses({
    kind: 'merge',
    hypothesisIds: ['h2', 'h1a'],
    merged: makeHypothesis({ hypothesisId: 'h2a', weight: 0 }),
    evidenceIds: ['ev_2'],
  })
  twin.evolveHypotheses({
    kind: 'prune',
    hypothesisId: 'h1b',
    reason: 'test',
    evidenceIds: ['ev_2'],
  })
  const weights = twin.hypotheses?.weights() ?? {}
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
  assert.equal(twin.hypotheses?.get('h1b')?.status, 'pruned')
})

test('step12: rollback restores the bound hypothesis revision', () => {
  const twin = newTwin()
  twin.recordObserved(real('ev_1', 1))
  twin.evolveHypotheses({
    kind: 'spawn',
    hypothesis: makeHypothesis({ hypothesisId: 'h1', weight: 1 }),
    evidenceIds: ['ev_1'],
  })
  const checkpoint = twin.createCheckpoint()
  twin.evolveHypotheses({
    kind: 'spawn',
    hypothesis: makeHypothesis({ hypothesisId: 'h2', weight: 1 }),
    evidenceIds: ['ev_1'],
  })
  twin.rollback(checkpoint.version)
  assert.equal(twin.hypotheses?.boundTwinVersion, checkpoint.version)
  assert.equal(twin.hypotheses?.get('h2'), undefined)
})

test('step12: evolving without a bound set is rejected unless spawning', () => {
  const twin = newTwin()
  assert.throws(
    () => twin.evolveHypotheses({ kind: 'prune', hypothesisId: 'h1' }),
    /requires a bound hypothesis set/,
  )
})

// ---------------------------------------------------------------------------
// Shared cross-language fixture
// ---------------------------------------------------------------------------

test('step12: checkpoint projection matches the shared fixture', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../tests/fixtures/twin_step12.json', import.meta.url),
      'utf8',
    ),
  )

  const twin = new StudentTwin(fixture.studentRef, {
    clock: () => '2026-03-01T12:00:00.000Z',
  })
  for (const spec of fixture.events) {
    twin.recordObserved({
      eventId: spec.eventId,
      eventType: spec.eventType,
      source: spec.source,
      studentRef: fixture.studentRef,
      occurredAt: spec.occurredAt,
    })
  }
  for (const spec of fixture.mastery) {
    twin.updateMastery(
      spec.kcId,
      spec.masteryMean,
      spec.uncertainty,
      spec.evidenceIds,
    )
  }
  for (const spec of fixture.memoryReviews) {
    twin.recordMemoryReview(
      spec.kcId,
      {
        observationId: spec.observationId,
        success: spec.success,
        independent: spec.independent,
        hintLevel: spec.hintLevel,
        kind: spec.kind,
        occurredAt: spec.occurredAt,
      },
      spec.evidenceIds,
    )
  }
  twin.applyMemoryForgetting(fixture.decayAt)

  const calibration = fixture.calibration
  twin.proposeMemoryCalibration(calibration.parameters, {
    candidateId: calibration.candidateId,
  })
  twin.activateMemoryCalibration({
    approvalId: calibration.approvalId,
    approvedBy: calibration.approvedBy,
  })
  const review = fixture.postCalibrationReview
  twin.recordMemoryReview(
    review.kcId,
    {
      observationId: review.observationId,
      success: review.success,
      independent: review.independent,
      hintLevel: review.hintLevel,
      kind: review.kind,
      occurredAt: review.occurredAt,
    },
    review.evidenceIds,
  )
  twin.bindHypotheses(
    new HypothesisSet(
      fixture.hypotheses.map((item: { hypothesisId: string; weight: number }) =>
        makeHypothesis(item),
      ),
    ),
    { evidenceIds: fixture.bindEvidenceIds },
  )
  twin.evolveHypotheses({
    kind: 'reweight',
    likelihoods: fixture.reweight.likelihoods,
    evidenceIds: fixture.reweight.evidenceIds,
  })
  const projected = twin.createCheckpoint(fixture.checkpointLabel).asDict()

  for (const key of [
    'version',
    'evidenceRevision',
    'knowledge',
    'memory',
    'observedEvidenceIds',
    'hypothesisRevision',
    'hypothesisWeights',
    'hypothesisBoundVersion',
    'activeParameterVersion',
  ]) {
    assert.deepEqual(projected[key], fixture.expected[key], `key ${key}`)
  }
})
