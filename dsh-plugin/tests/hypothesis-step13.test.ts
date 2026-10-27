/**
 * Step 13 tests: the complete virtual-student ensemble (spec section 6) plus
 * fidelity metrics (spec 19.3), unknown-bucket management, and snapshot
 * session isolation / persistence boundary. Mirrors
 * `tests/test_hypothesis_step13.py`.
 *
 * All data is synthetic. No filesystem writes, network, database, or real
 * student data is touched; the shared fixture is read-only.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ACTIVE,
  HypothesisPersistenceError,
  HypothesisScopeError,
  HypothesisSet,
  HypothesisSnapshotStore,
  SNAPSHOT_SCHEMA_VERSION,
  SPAWN_UNEXPLAINED_STEP,
  UNKNOWN_CONTRADICTED,
  UNKNOWN_LOW_EXPLANATORY_POWER,
  UNKNOWN_MISSING_EVIDENCE,
  UNKNOWN_NO_CANDIDATE,
  hypothesisSimilarity,
  makeHypothesis,
} from '../src/core/hypothesis.ts'
import type {
  BehaviorObservation,
  FidelityMetrics,
  Hypothesis,
} from '../src/core/hypothesis.ts'
import type { HypothesisRecord } from '../src/domain.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/hypothesis_step13.json', import.meta.url),
    'utf8',
  ),
)

function hyp(
  hypothesisId: string,
  weight = 1,
  overrides: Partial<HypothesisRecord> = {},
): Hypothesis {
  return makeHypothesis({ hypothesisId, weight, ...overrides })
}

function fromRecord(record: HypothesisRecord): Hypothesis {
  return makeHypothesis(record)
}

function closeTo(actual: number, expected: number, places = 12): void {
  assert.ok(
    Math.abs(actual - expected) < 10 ** -places,
    `expected ${expected}, got ${actual}`,
  )
}

// ---------------------------------------------------------------------------
// Complete spawn / match / split / merge / prune rules
// ---------------------------------------------------------------------------

test('step13: spawn records the generation trigger', () => {
  const set = new HypothesisSet([hyp('base')])
  set.spawn(hyp('new'), undefined, { trigger: SPAWN_UNEXPLAINED_STEP })
  const last = set.history[set.history.length - 1]
  assert.equal(last?.kind, 'spawn')
  assert.equal(last?.detail, SPAWN_UNEXPLAINED_STEP)
})

test('step13: generate only spawns candidates that explain unexplained behaviour', () => {
  const set = new HypothesisSet([
    hyp('slip', 1, { predictedObservableBehaviors: { step_b1: 0.5 } }),
  ])
  const spawned = set.generate(
    { step_b1: 1 },
    [
      hyp('weak', 1, { predictedObservableBehaviors: { step_b1: 0.52 } }),
      hyp('strong', 1, { predictedObservableBehaviors: { step_b1: 0.9 } }),
    ],
    { behaviorThreshold: 0.6, minGain: 0.05 },
  )
  assert.deepEqual(
    spawned.map((item) => item.hypothesisId),
    ['strong'],
  )
  closeTo(set.weights()['strong'] as number, 0.5)
})

test('step13: generate does nothing when every behaviour is explained', () => {
  const set = new HypothesisSet([
    hyp('a', 1, { predictedObservableBehaviors: { step_b1: 0.9 } }),
  ])
  assert.deepEqual(
    set.generate(
      { step_b1: 1 },
      [hyp('b', 1, { predictedObservableBehaviors: { step_b1: 0.95 } })],
    ),
    [],
  )
})

test('step13: match builds likelihoods and a normalised posterior', () => {
  const set = new HypothesisSet([
    hyp('expand', 1, { predictedObservableBehaviors: { b: 0.85 } }),
    hyp('compress', 1, { predictedObservableBehaviors: { b: 0.15 } }),
  ])
  const match = set.match({ b: 1 }, { noise: 0, unknownPrior: 0 })
  closeTo(match.likelihoods['expand'] as number, 0.02 + 0.96 * 0.85)
  closeTo(match.likelihoods['compress'] as number, 0.02 + 0.96 * 0.15)
  closeTo(
    Object.values(match.weights).reduce((sum, value) => sum + value, 0),
    1,
  )
  assert.deepEqual(match.unexplainedBehaviors, [])
})

test('step13: match reports unexplained behaviour', () => {
  const set = new HypothesisSet([
    hyp('a', 1, { predictedObservableBehaviors: { b: 0.8 } }),
  ])
  const match = set.match({ b: 1, unmodelled: 1 })
  assert.deepEqual(match.unexplainedBehaviors, ['unmodelled'])
})

test('step13: match rejects out-of-range observations', () => {
  const set = new HypothesisSet([hyp('a')])
  assert.throws(() => set.match({ b: 2 }), /within \[0, 1\]/)
})

test('step13: identical behaviour and rules score similarity 1', () => {
  const first = hyp('a', 1, {
    predictedObservableBehaviors: { b: 0.8 },
    bugRules: ['r'],
  })
  const second = hyp('b', 1, {
    predictedObservableBehaviors: { b: 0.8 },
    bugRules: ['r'],
  })
  closeTo(hypothesisSimilarity(first, second), 1)
})

test('step13: splitDistinguishable accepts separable children', () => {
  const set = new HypothesisSet([hyp('parent')])
  const children = set.splitDistinguishable('parent', [
    hyp('c1', 1, { predictedObservableBehaviors: { b: 0.9 } }),
    hyp('c2', 1, { predictedObservableBehaviors: { b: 0.1 } }),
  ])
  assert.deepEqual(
    children.map((child) => child.hypothesisId),
    ['c1', 'c2'],
  )
  assert.equal(set.get('parent')?.status, 'split')
})

test('step13: splitDistinguishable rejects inseparable children', () => {
  const set = new HypothesisSet([hyp('parent')])
  assert.throws(
    () =>
      set.splitDistinguishable('parent', [
        hyp('c1', 1, { predictedObservableBehaviors: { b: 0.9 } }),
        hyp('c2', 1, { predictedObservableBehaviors: { b: 0.9 } }),
      ]),
    /not distinguishable/,
  )
  assert.equal(set.get('parent')?.status, ACTIVE)
})

test('step13: mergeIndistinguishable keeps source history', () => {
  const set = new HypothesisSet([
    hyp('m1', 1, { predictedObservableBehaviors: { b: 0.8 }, bugRules: ['r'] }),
    hyp('m2', 1, { predictedObservableBehaviors: { b: 0.8 }, bugRules: ['r'] }),
    hyp('m3', 1, { predictedObservableBehaviors: { b: 0.1 }, bugRules: ['z'] }),
  ])
  assert.deepEqual(set.mergeIndistinguishable(), ['m_m1_m2'])
  assert.deepEqual(set.get('m_m1_m2')?.mergedFrom, ['m1', 'm2'])
  closeTo(set.weights()['m_m1_m2'] as number, 2 / 3)
})

test('step13: pruneContradicted requires enough matches', () => {
  const set = new HypothesisSet([
    hyp('bad', 1, { predictedObservableBehaviors: { b: 0.05 } }),
    hyp('good', 1, { predictedObservableBehaviors: { b: 0.95 } }),
  ])
  set.match({ b: 1 }, { noise: 0, unknownPrior: 0 })
  assert.deepEqual(set.pruneContradicted(2), [])
  set.match({ b: 1 }, { noise: 0, unknownPrior: 0 })
  assert.deepEqual(set.pruneContradicted(2), ['bad'])
  assert.ok(set.unknownReasons.includes(UNKNOWN_CONTRADICTED))
})

test('step13: pruneUninformative drops only candidates without unique power', () => {
  const set = new HypothesisSet([
    hyp('u1', 1, { predictedObservableBehaviors: { b: 0.8 } }),
    hyp('u2', 0.5, { predictedObservableBehaviors: { b: 0.8 } }),
  ])
  assert.deepEqual(set.pruneUninformative(), ['u2'])
  assert.ok(set.unknownReasons.includes(UNKNOWN_LOW_EXPLANATORY_POWER))
  closeTo(
    Object.values(set.weights()).reduce((sum, value) => sum + value, 0),
    1,
  )
})

// ---------------------------------------------------------------------------
// Unknown bucket management
// ---------------------------------------------------------------------------

test('step13: setUnknown records the reason and stays normalised', () => {
  const set = new HypothesisSet([hyp('a')])
  set.setUnknown(1, UNKNOWN_NO_CANDIDATE)
  closeTo(set.weights()['unknown'] as number, 0.5)
  assert.deepEqual([...set.unknownReasons], [UNKNOWN_NO_CANDIDATE])
})

test('step13: request and resolve real evidence', () => {
  const set = new HypothesisSet([hyp('a')])
  assert.equal(set.needsRealEvidence, false)
  set.requestRealEvidence(UNKNOWN_MISSING_EVIDENCE)
  assert.equal(set.needsRealEvidence, true)
  assert.ok(set.unknownReasons.includes(UNKNOWN_MISSING_EVIDENCE))
  set.resolveEvidenceRequest()
  assert.equal(set.needsRealEvidence, false)
})

test('step13: unknown dominance asks for evidence', () => {
  const set = new HypothesisSet([hyp('a', 0.4), hyp('b', 0.4)])
  set.reweight(
    { a: 0.01, b: 0.01 },
    { unknownPrior: 0.5, unknownLikelihood: 0.99 },
  )
  assert.equal(set.dominant(), null)
  assert.equal(set.needsRealEvidence, true)
})

test('step13: setUnknown rejects invalid values', () => {
  const set = new HypothesisSet([hyp('a')])
  assert.throws(() => set.setUnknown(-0.1))
  assert.throws(() => set.setUnknown(Number.POSITIVE_INFINITY))
})

// ---------------------------------------------------------------------------
// Fidelity metrics
// ---------------------------------------------------------------------------

test('step13: fidelity reports null when not computable', () => {
  const set = new HypothesisSet([])
  const metrics = set.fidelity([], { minObservations: 5 })
  const typed: FidelityMetrics = metrics
  assert.equal(typed.brierScore, null)
  assert.equal(typed.sufficient, false)
})

test('step13: fidelity metrics on a synthetic sequence', () => {
  const set = new HypothesisSet([
    hyp('expand', 1, {
      predictedObservableBehaviors: { step_b1: 0.85 },
      bugRules: ['no_compensation', 'step_b1'],
    }),
    hyp('compress', 1, {
      predictedObservableBehaviors: { step_b1: 0.15 },
      bugRules: ['no_compensation', 'step_b1'],
    }),
    hyp('slip', 0.5, { predictedObservableBehaviors: { step_b1: 0.5 } }),
  ])
  const observations: readonly BehaviorObservation[] = [
    { observationId: 'o1', behavior: 'step_b1', outcome: true },
    { observationId: 'o2', behavior: 'step_b1', outcome: true },
    {
      observationId: 'o3',
      behavior: 'step_b1',
      outcome: false,
      errorType: 'no_compensation',
      step: 'step_b1',
    },
    { observationId: 'o4', behavior: 'step_b1', outcome: true },
  ]
  const metrics = set.fidelity(observations, { minObservations: 4 })
  assert.equal(metrics.observationCount, 4)
  assert.equal(metrics.coverage, 1)
  closeTo(metrics.brierScore as number, 0.25)
  closeTo(metrics.accuracy as number, 0.75)
  assert.equal(metrics.errorTypeAgreement, 1)
  assert.equal(metrics.stepAgreement, 1)
  assert.equal(metrics.sufficient, true)
})

test('step13: anti-mismatch tracks recent evidence', () => {
  const set = new HypothesisSet([
    hyp('old', 1, { predictedObservableBehaviors: { b: 0.5 } }),
    hyp('updated', 1, {
      predictedObservableBehaviors: { b: 0.5 },
      evidenceRefs: ['ev_new'],
    }),
  ])
  const metrics = set.fidelity(
    [{ observationId: 'o1', behavior: 'b', outcome: true }],
    { minObservations: 0, recentEvidenceId: 'ev_new' },
  )
  closeTo(metrics.antiMismatch as number, 0.5)
})

// ---------------------------------------------------------------------------
// Snapshot isolation and persistence boundary
// ---------------------------------------------------------------------------

test('step13: state round-trip preserves hypotheses and unknown', () => {
  const original = new HypothesisSet([hyp('a', 0.7), hyp('b', 0.3)], 0.2)
  original.bindTwinVersion(4)
  const restored = HypothesisSet.fromState(original.toState())
  assert.deepEqual(restored.weights(), original.weights())
  assert.equal(restored.revision, 0)
  assert.equal(restored.boundTwinVersion, null)
})

test('step13: snapshot round-trip preserves boundary and reasons', () => {
  const original = new HypothesisSet([hyp('a')])
  original.requestRealEvidence(UNKNOWN_MISSING_EVIDENCE)
  original.bindTwinVersion(9)
  const snapshot = original.toSnapshot('session-a', {
    snapshotId: 'snap-1',
    now: Date.UTC(2024, 0, 1),
  })
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
  assert.equal(snapshot.persistsToLongTermTwin, false)
  const restored = HypothesisSet.fromSnapshot(snapshot)
  assert.equal(restored.boundTwinVersion, 9)
  assert.deepEqual([...restored.unknownReasons], [UNKNOWN_MISSING_EVIDENCE])
  assert.equal(restored.needsRealEvidence, true)
  assert.deepEqual(restored.weights(), original.weights())
})

test('step13: cross-session reads and deletes fail', () => {
  const store = new HypothesisSnapshotStore({ ttlMs: 60_000 })
  const snapshot = store.put(new HypothesisSet([hyp('a')]), {
    sessionId: 'session-a',
  })
  assert.equal(store.get(snapshot.snapshotId, { sessionId: 'session-b' }), undefined)
  assert.equal(store.delete(snapshot.snapshotId, { sessionId: 'session-b' }), false)
  assert.notEqual(
    store.get(snapshot.snapshotId, { sessionId: 'session-a' }),
    undefined,
  )
})

test('step13: agent scope is part of the isolation key', () => {
  const store = new HypothesisSnapshotStore({ ttlMs: 60_000 })
  const snapshot = store.put(new HypothesisSet([hyp('a')]), {
    sessionId: 'session-a',
    agentId: 'agent-1',
  })
  assert.equal(
    store.get(snapshot.snapshotId, {
      sessionId: 'session-a',
      agentId: 'agent-2',
    }),
    undefined,
  )
  assert.notEqual(
    store.get(snapshot.snapshotId, {
      sessionId: 'session-a',
      agentId: 'agent-1',
    }),
    undefined,
  )
})

test('step13: expired and ended snapshots are unreadable', () => {
  const clock = { now: Date.UTC(2024, 0, 1) }
  const store = new HypothesisSnapshotStore({
    ttlMs: 30_000,
    now: () => clock.now,
  })
  const snapshot = store.put(new HypothesisSet([hyp('a')]), {
    sessionId: 'session-a',
  })
  clock.now += 31_000
  assert.equal(store.get(snapshot.snapshotId, { sessionId: 'session-a' }), undefined)

  const other = store.put(new HypothesisSet([hyp('a')]), {
    sessionId: 'session-b',
  })
  assert.equal(store.endSession('session-b'), 1)
  assert.equal(store.get(other.snapshotId, { sessionId: 'session-b' }), undefined)
})

test('step13: store counts never expose long-term writes', () => {
  const store = new HypothesisSnapshotStore({ ttlMs: 60_000 })
  store.put(new HypothesisSet([hyp('a')]), { sessionId: 'session-a' })
  const view = store.snapshot()
  assert.equal(view['sessionScoped'], true)
  assert.equal(view['longTermTwinWrite'], false)
})

test('step13: persisting hypotheses to the twin fails closed', () => {
  const set = new HypothesisSet([hyp('a')])
  assert.throws(() => set.persistToTwin(), HypothesisPersistenceError)
})

test('step13: invalid scope is rejected', () => {
  const store = new HypothesisSnapshotStore({ ttlMs: 60_000 })
  assert.throws(
    () => store.put(new HypothesisSet([hyp('a')]), { sessionId: '' }),
    HypothesisScopeError,
  )
  assert.throws(() => new HypothesisSnapshotStore({ ttlMs: 0 }))
})

// ---------------------------------------------------------------------------
// Shared Python/TypeScript fixture
// ---------------------------------------------------------------------------

test('step13: shared fixture similarity and matching', () => {
  const set = new HypothesisSet(fixture.hypotheses.map(fromRecord))
  closeTo(
    Object.values(set.weights()).reduce((sum, value) => sum + value, 0),
    1,
  )
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.initialWeights as Record<string, number>,
  )) {
    closeTo(set.weights()[hypothesisId] as number, weight)
  }
  closeTo(
    hypothesisSimilarity(
      set.get('h.expand') as Hypothesis,
      set.get('h.compress') as Hypothesis,
    ),
    fixture.expected.similarityExpandCompress,
  )
  closeTo(
    hypothesisSimilarity(
      set.get('h.expand') as Hypothesis,
      set.get('h.slip') as Hypothesis,
    ),
    fixture.expected.similarityExpandSlip,
  )
  const match = set.match({ step_b1: 1 }, { noise: 0, unknownPrior: 0 })
  for (const [hypothesisId, likelihood] of Object.entries(
    fixture.expected.matchLikelihoods as Record<string, number>,
  )) {
    closeTo(match.likelihoods[hypothesisId] as number, likelihood)
  }
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.matchWeights as Record<string, number>,
  )) {
    closeTo(match.weights[hypothesisId] as number, weight)
  }
  assert.deepEqual(
    [...match.unexplainedBehaviors],
    fixture.expected.matchUnexplained,
  )
})

test('step13: shared fixture generate/split/merge/prune', () => {
  const generator = new HypothesisSet([
    fromRecord(fixture.generateInitial),
  ])
  const spawned = generator.generate(
    { step_b1: 1 },
    [fromRecord(fixture.generateCandidate)],
    { behaviorThreshold: 0.6, minGain: 0.05 },
  )
  assert.deepEqual(
    spawned.map((item) => item.hypothesisId),
    fixture.expected.generateSpawned,
  )
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.generateWeights as Record<string, number>,
  )) {
    closeTo(generator.weights()[hypothesisId] as number, weight)
  }

  const splitter = new HypothesisSet([
    hyp('p', 1, { predictedObservableBehaviors: { b: 0.5 } }),
  ])
  const children = splitter.splitDistinguishable(
    'p',
    fixture.splitHypotheses.map(fromRecord),
  )
  for (const child of children) {
    closeTo(
      child.weight,
      fixture.expected.splitWeights[child.hypothesisId] as number,
    )
  }

  const merger = new HypothesisSet(fixture.mergeHypotheses.map(fromRecord))
  assert.deepEqual(
    [...merger.mergeIndistinguishable()],
    fixture.expected.mergeIds,
  )
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.mergeWeights as Record<string, number>,
  )) {
    closeTo(merger.weights()[hypothesisId] as number, weight)
  }

  const pruner = new HypothesisSet(fixture.pruneHypotheses.map(fromRecord))
  pruner.match({ b: 1 }, { noise: 0, unknownPrior: 0 })
  pruner.match({ b: 1 }, { noise: 0, unknownPrior: 0 })
  assert.deepEqual(
    [...pruner.pruneContradicted()],
    fixture.expected.pruneContradicted,
  )
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.pruneContradictedWeights as Record<string, number>,
  )) {
    closeTo(pruner.weights()[hypothesisId] as number, weight)
  }

  const uninformative = new HypothesisSet(
    fixture.uninformativeHypotheses.map(fromRecord),
  )
  assert.deepEqual(
    [...uninformative.pruneUninformative()],
    fixture.expected.pruneUninformative,
  )
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.pruneUninformativeWeights as Record<string, number>,
  )) {
    closeTo(uninformative.weights()[hypothesisId] as number, weight)
  }
})

test('step13: shared fixture fidelity and snapshot', () => {
  const set = new HypothesisSet(fixture.hypotheses.map(fromRecord))
  const observations: readonly BehaviorObservation[] = fixture.observations.map(
    (record: {
      observationId: string
      behavior: string
      outcome: boolean
      errorType?: string
      step?: string
      strategy?: string
    }) => ({
      observationId: record.observationId,
      behavior: record.behavior,
      outcome: record.outcome,
      ...(record.errorType !== undefined ? { errorType: record.errorType } : {}),
      ...(record.step !== undefined ? { step: record.step } : {}),
      ...(record.strategy !== undefined ? { strategy: record.strategy } : {}),
    }),
  )
  const metrics = set.fidelity(observations, {
    minObservations: observations.length,
  })
  const expected = fixture.expected.fidelity
  closeTo(metrics.coverage, expected.coverage, 9)
  closeTo(metrics.brierScore as number, expected.brierScore, 9)
  closeTo(metrics.logLoss as number, expected.logLoss, 9)
  closeTo(metrics.calibrationError as number, expected.calibrationError, 9)
  closeTo(metrics.accuracy as number, expected.accuracy, 9)
  closeTo(metrics.unknownShare, expected.unknownShare, 9)
  closeTo(metrics.effectiveHypotheses, expected.effectiveHypotheses, 9)
  closeTo(metrics.maxWeight, expected.maxWeight, 9)
  closeTo(metrics.errorTypeAgreement as number, expected.errorTypeAgreement, 9)
  closeTo(metrics.stepAgreement as number, expected.stepAgreement, 9)
  closeTo(metrics.strategyAgreement as number, expected.strategyAgreement, 9)
  assert.equal(metrics.observationCount, expected.observationCount)
  assert.equal(metrics.sufficient, expected.sufficient)

  const now = Date.parse(fixture.snapshotNow)
  const store = new HypothesisSnapshotStore({
    ttlMs: fixture.snapshotTtlSeconds * 1000,
    now: () => now,
  })
  const snapshotSet = new HypothesisSet(fixture.hypotheses.map(fromRecord))
  snapshotSet.requestRealEvidence(UNKNOWN_MISSING_EVIDENCE)
  const snapshot = store.put(snapshotSet, { sessionId: 'session-a' }, {
    snapshotId: 'hyp_fixture',
  })
  assert.equal(snapshot.snapshotId, fixture.expected.snapshot.snapshotId)
  assert.equal(
    snapshot.persistsToLongTermTwin,
    fixture.expected.snapshot.persistsToLongTermTwin,
  )
  assert.deepEqual(
    [...snapshot.unknownReasons],
    fixture.expected.snapshot.unknownReasons,
  )
  const restored = HypothesisSet.fromSnapshot(snapshot)
  for (const [hypothesisId, weight] of Object.entries(
    fixture.expected.snapshot.weights as Record<string, number>,
  )) {
    closeTo(restored.weights()[hypothesisId] as number, weight)
  }
})
