/**
 * Step 11 tests: FSRS parameter calibration (spec section 8).
 *
 * The shared JSON fixture is also consumed by `tests/test_fsrs_calibration.py`,
 * so the deterministic fit, bootstrap intervals, metrics, and the report
 * fingerprint are checked against the same values in both languages.  Every
 * dataset is synthetic and content-free.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { canonicalJson } from '../src/core/curriculum-graph.ts'
import { StudentTwin } from '../src/core/twin.ts'
import type { Actor, ApprovalRecord, Candidate } from '../src/host/evolution.ts'
import {
  ACTION_CALIBRATION_ACTIVATED,
  Applicability,
  BASELINE_PARAMETER_VERSION,
  CALIBRATION_SCHEMA_VERSION,
  CalibrationActivationGate,
  CalibrationApprovalPolicy,
  CalibrationConfig,
  CalibrationDataset,
  CalibrationDeniedError,
  CalibrationError,
  CalibrationEvaluation,
  CalibrationReport,
  CalibrationService,
  CalibrationValidationError,
  DEFAULT_DATA_VERSION,
  DIFFICULTY_MAX,
  DIFFICULTY_MIN,
  FSRS_19_81,
  FSRSParameters,
  MIN_STABILITY_DAYS,
  PARAMETER_NAMES,
  PRODUCTION_MUTATION_ENABLED,
  RealTransferEvidence,
  ReviewEvent,
  ReviewSequence,
  STATUS_ACTIVATED,
  STATUS_APPROVED,
  STATUS_EVALUATED,
  STATUS_REGISTERED,
  TRUSTED_REAL_SOURCES,
  calibrate,
  datasetFromDict,
  evaluateCandidate,
  generateDataset,
  mulberry32,
  parametersFromCandidate,
  percentile,
  quantizeMicros,
  round4,
} from '../src/core/fsrs-calibration.ts'

const FIXTURE = new URL(
  '../../tests/fixtures/fsrs_calibration_step11.json',
  import.meta.url,
)

const CREATED_AT = '2026-05-01T09:00:00.000Z'
const DECIDED_AT = '2026-05-01T09:05:00.000Z'
const REVIEWER: Actor = Object.freeze({ actorId: 'reviewer.1', role: 'reviewer' })

interface FixtureShape {
  readonly config: Record<string, unknown>
  readonly dataset: Record<string, unknown>
  readonly expected: Record<string, unknown>
}

function loadFixture(): FixtureShape {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as FixtureShape
}

function configFromFixture(data: Record<string, unknown>): CalibrationConfig {
  return new CalibrationConfig({
    seed: data.seed as number,
    dataVersion: data.dataVersion as string,
    parameterVersion: data.parameterVersion as string,
    rounds: data.rounds as number,
    stepFraction: data.stepFraction as number,
    bootstrapResamples: data.bootstrapResamples as number,
    ridge: data.ridge as number,
    confidence: data.confidence as number,
    minSequences: data.minSequences as number,
    minObservations: data.minObservations as number,
  })
}

function makeConfig(overrides: Record<string, unknown> = {}): CalibrationConfig {
  return new CalibrationConfig({
    seed: 1234,
    parameterVersion: 'test.params.v1',
    bootstrapResamples: 8,
    ...overrides,
  })
}

function makeEvent(overrides: Partial<{
  elapsedDays: number
  success: boolean
  weight: number
}> = {}): ReviewEvent {
  return new ReviewEvent(
    overrides.elapsedDays ?? 3.0,
    overrides.success ?? true,
    overrides.weight ?? 1.0,
  )
}

function makeSequence(sequenceId = 'seq.1', events?: readonly ReviewEvent[]): ReviewSequence {
  return new ReviewSequence(
    sequenceId,
    'synthetic.math',
    events ?? [
      makeEvent({ elapsedDays: 2.0, success: true }),
      makeEvent({ elapsedDays: 5.0, success: false }),
      makeEvent({ elapsedDays: 4.0, success: true }),
    ],
  )
}

function makeDataset(input: {
  readonly sequences?: readonly ReviewSequence[]
  readonly datasetId?: string
  readonly dataVersion?: string
} = {}): CalibrationDataset {
  return new CalibrationDataset({
    datasetId: input.datasetId ?? 'dataset.test',
    dataVersion: input.dataVersion ?? DEFAULT_DATA_VERSION,
    generatorVersion: 'aeh.fsrs.synthetic.test',
    scope: 'synthetic.math',
    sequences: input.sequences ?? [makeSequence()],
  })
}

test('mulberry32 stream is stable and in range', () => {
  const stream = (seed: number): number[] => {
    const rng = mulberry32(seed)
    return [rng(), rng(), rng(), rng()]
  }
  assert.deepEqual(stream(42), stream(42))
  for (const value of stream(7)) {
    assert.ok(value >= 0 && value < 1)
  }
})

test('rounding and micros are deterministic', () => {
  assert.equal(round4(1.23456), 1.2346)
  assert.equal(round4(1.00005), 1.0001)
  assert.equal(quantizeMicros(0.5), 500000)
})

test('percentile interpolates linearly', () => {
  assert.equal(percentile([0.0, 10.0], 0.25), 2.5)
  assert.equal(percentile([7.0], 0.9), 7.0)
  assert.throws(() => percentile([], 0.5), CalibrationValidationError)
})

test('retention follows the illustrative 19/81 curve', () => {
  const params = FSRSParameters.baseline()
  const predicted = params.predict(2.0, params.initialStabilityDays, 5.0)
  const expected = (1 + (FSRS_19_81 * 2.0) / params.initialStabilityDays) ** -0.5
  assert.ok(Math.abs(predicted - expected) < 1e-12)
})

test('difficulty modulates effective stability', () => {
  const params = FSRSParameters.baseline()
  assert.ok(params.effectiveStability(2.0, 1.0) > params.effectiveStability(2.0, 9.0))
  assert.ok(params.effectiveStability(2.0, 9.0) >= MIN_STABILITY_DAYS)
})

test('success grows and failure shrinks stability', () => {
  const params = FSRSParameters.baseline()
  const [grown, difficultyAfter] = params.update(2.0, 5.0, true, 1.0)
  assert.ok(grown > 2.0)
  assert.ok(difficultyAfter < 5.0)
  const [shrunk, difficultyUp] = params.update(2.0, 5.0, false, 1.0)
  assert.ok(shrunk < 2.0)
  assert.ok(difficultyUp > 5.0)
})

test('zero weight reading events do not update memory', () => {
  const params = FSRSParameters.baseline()
  const [stability, difficulty] = params.update(2.0, 5.0, true, 0.0)
  assert.equal(stability, 2.0)
  assert.equal(difficulty, 5.0)
})

test('stability and difficulty bounds are respected', () => {
  const params = FSRSParameters.fromValues([0.2, 2.0, 0.9, 10.0, 1.0, 2.0])
  const [stability, difficulty] = params.update(MIN_STABILITY_DAYS, 1.0, false, 1.0)
  assert.ok(stability >= MIN_STABILITY_DAYS)
  assert.ok(difficulty >= DIFFICULTY_MIN)
  const [, difficultyDown] = params.update(1.0, DIFFICULTY_MAX, true, 1.0)
  assert.ok(difficultyDown <= DIFFICULTY_MAX)
})

test('parameters reject out-of-bounds values', () => {
  assert.throws(
    () => FSRSParameters.fromValues([0.0, 0.6, 0.4, 5.0, 0.2, 0.5]),
    CalibrationValidationError,
  )
  assert.throws(
    () => FSRSParameters.fromValues([1.0, 3.0, 0.4, 5.0, 0.2, 0.5]),
    CalibrationValidationError,
  )
  assert.throws(
    () => FSRSParameters.fromValues([1.0, 0.6, 0.4]),
    CalibrationValidationError,
  )
})

test('baseline is the illustrative prior', () => {
  const baseline = FSRSParameters.baseline()
  assert.equal(baseline.parameterVersion, BASELINE_PARAMETER_VERSION)
  assert.deepEqual(baseline.quantizedDict(), {
    initial_stability_days: 1,
    success_growth: 0.6,
    failure_shrink: 0.4,
    initial_difficulty: 5,
    difficulty_success_delta: 0.2,
    difficulty_failure_delta: 0.5,
  })
})

test('dataset validation rejects malformed input', () => {
  assert.throws(() => makeEvent({ elapsedDays: -1.0 }), CalibrationValidationError)
  assert.throws(() => makeEvent({ weight: 1.5 }), CalibrationValidationError)
  assert.throws(
    () => new ReviewSequence('seq.1', 'synthetic.math', []),
    CalibrationValidationError,
  )
  assert.throws(
    () => makeDataset({ sequences: [makeSequence('dup'), makeSequence('dup')] }),
    CalibrationValidationError,
  )
  assert.throws(
    () =>
      new CalibrationDataset({
        datasetId: 'dataset.empty',
        dataVersion: DEFAULT_DATA_VERSION,
        generatorVersion: 'aeh.fsrs.synthetic.test',
        scope: 'synthetic.math',
        sequences: [],
      }),
    CalibrationValidationError,
  )
})

test('config validation rejects malformed input', () => {
  assert.throws(() => new CalibrationConfig({ seed: -1 }), CalibrationValidationError)
  assert.throws(() => new CalibrationConfig({ rounds: 0 }), CalibrationValidationError)
  assert.throws(
    () => new CalibrationConfig({ stepFraction: 1.0 }),
    CalibrationValidationError,
  )
  assert.throws(
    () => new CalibrationConfig({ confidence: 0.5 }),
    CalibrationValidationError,
  )
  assert.throws(
    () => new CalibrationConfig({ bootstrapResamples: 0 }),
    CalibrationValidationError,
  )
  assert.throws(
    () => new CalibrationConfig({ seed: 0x1_0000_0000 }),
    CalibrationValidationError,
  )
})

test('calibrate refuses a data version mismatch', () => {
  const dataset = makeDataset()
  assert.throws(
    () => calibrate(dataset, makeConfig({ dataVersion: 'other.v1' })),
    CalibrationValidationError,
  )
})

test('report fingerprint is reproducible', () => {
  const dataset = generateDataset({ seed: 11, sequenceCount: 8, eventsPerSequence: 4 })
  const first = calibrate(dataset, makeConfig({ seed: 11 }))
  const second = calibrate(dataset, makeConfig({ seed: 11 }))
  assert.equal(first.fingerprint(), second.fingerprint())
})

test('seed changes the bootstrap interval but not the point estimate', () => {
  const dataset = generateDataset({ seed: 11, sequenceCount: 8, eventsPerSequence: 4 })
  const first = calibrate(dataset, makeConfig({ seed: 11 }))
  const second = calibrate(dataset, makeConfig({ seed: 22 }))
  assert.deepEqual(first.parameters.values(), second.parameters.values())
  assert.notEqual(first.fingerprint(), second.fingerprint())
})

test('every parameter has a bounded bootstrap interval', () => {
  const dataset = generateDataset({ seed: 11, sequenceCount: 8, eventsPerSequence: 4 })
  const report = calibrate(dataset, makeConfig({ seed: 11 }))
  assert.deepEqual(
    report.estimates.map((estimate) => estimate.name),
    [...PARAMETER_NAMES],
  )
  for (const estimate of report.estimates) {
    assert.ok(estimate.ciLow <= estimate.ciHigh)
    assert.ok(estimate.ciLow >= estimate.lower)
    assert.ok(estimate.ciHigh <= estimate.upper)
    assert.equal(typeof estimate.identified(), 'boolean')
  }
})

test('metrics include ten reliability bins covering every observation', () => {
  const dataset = generateDataset({ seed: 11, sequenceCount: 8, eventsPerSequence: 4 })
  const report = calibrate(dataset, makeConfig({ seed: 11 }))
  const metrics = report.metrics
  assert.ok(metrics.brier >= 0 && metrics.brier <= 1)
  assert.ok(metrics.brierCiLow <= metrics.brierCiHigh)
  assert.ok(metrics.ece >= 0)
  assert.equal(metrics.reliabilityBins.length, 10)
  const total = metrics.reliabilityBins.reduce((sum, entry) => sum + entry.count, 0)
  assert.equal(total, dataset.observationCount())
})

test('applicability declares scope, conditions, and out-of-scope limits', () => {
  const dataset = generateDataset({ seed: 11, sequenceCount: 8, eventsPerSequence: 4 })
  const report = calibrate(dataset, makeConfig({ seed: 11 }))
  assert.ok(report.applicability instanceof Applicability)
  assert.equal(report.applicability.scope, dataset.scope)
  assert.ok(report.applicability.conditions.length > 0)
  assert.ok(report.applicability.outOfScope.length > 0)
  assert.ok(
    report.applicability.elapsedDaysMax >= report.applicability.elapsedDaysMin,
  )
})

test('evidence sufficiency follows the configured thresholds', () => {
  const tiny = generateDataset({
    seed: 3,
    sequenceCount: 2,
    eventsPerSequence: 3,
    datasetId: 'dataset.tiny',
  })
  const report = calibrate(
    tiny,
    makeConfig({ bootstrapResamples: 4, minObservations: 20 }),
  )
  assert.equal(report.evidenceSufficient, false)
  assert.equal(report.applicability.evidenceSufficient, false)
})

test('report payload is declarative JSON', () => {
  const dataset = generateDataset({ seed: 11, sequenceCount: 8, eventsPerSequence: 4 })
  const report = calibrate(dataset, makeConfig({ seed: 11 }))
  const payload = report.asDict()
  assert.equal(payload.schema, CALIBRATION_SCHEMA_VERSION)
  assert.equal(payload.reportFingerprint, report.fingerprint())
  assert.ok(Array.isArray(payload.limitations))
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)) as unknown)
})

test('generator is deterministic', () => {
  const first = generateDataset({ seed: 5, sequenceCount: 4, eventsPerSequence: 3 })
  const second = generateDataset({ seed: 5, sequenceCount: 4, eventsPerSequence: 3 })
  assert.equal(first.digest(), second.digest())
  const other = generateDataset({ seed: 6, sequenceCount: 4, eventsPerSequence: 3 })
  assert.notEqual(first.digest(), other.digest())
})

test('generated shapes are well formed', () => {
  const dataset = generateDataset({ seed: 5, sequenceCount: 4, eventsPerSequence: 3 })
  assert.equal(dataset.sequences.length, 4)
  assert.equal(dataset.observationCount(), 12)
  for (const sequence of dataset.sequences) {
    assert.equal(sequence.events.length, 3)
    for (const event of sequence.events) {
      assert.ok(event.elapsedDays >= 0)
      assert.ok(event.weight === 1 || event.weight === 0.3)
    }
  }
})

test('candidate is versioned, declarative, and mutation free', () => {
  const dataset = generateDataset({ seed: 21, sequenceCount: 8, eventsPerSequence: 4 })
  const service = new CalibrationService(dataset, makeConfig({ seed: 21, bootstrapResamples: 6 }))
  const report = service.calibrate()
  const candidate = service.proposeCandidate({
    report,
    author: 'calibration.bot',
    createdAt: CREATED_AT,
  })
  assert.equal(candidate.kind, 'config')
  assert.equal(candidate.mutatesProduction, undefined)
  assert.equal(candidate.baselineVersion, BASELINE_PARAMETER_VERSION)
  assert.ok(candidate.impactScope.includes('review_scheduling'))
  assert.equal(PRODUCTION_MUTATION_ENABLED, false)
})

test('candidate round-trips the calibrated parameters', () => {
  const dataset = generateDataset({ seed: 21, sequenceCount: 8, eventsPerSequence: 4 })
  const service = new CalibrationService(dataset, makeConfig({ seed: 21, bootstrapResamples: 6 }))
  const report = service.calibrate()
  const candidate = service.proposeCandidate({
    report,
    author: 'calibration.bot',
    createdAt: CREATED_AT,
  })
  const params = parametersFromCandidate(candidate)
  assert.deepEqual(params.quantizedDict(), report.parameters.quantizedDict())
})

test('a mismatched report version is refused', () => {
  const dataset = generateDataset({ seed: 21, sequenceCount: 8, eventsPerSequence: 4 })
  const service = new CalibrationService(dataset, makeConfig({ seed: 21, bootstrapResamples: 6 }))
  const report = service.calibrate()
  const otherService = new CalibrationService(
    dataset,
    makeConfig({ seed: 21, bootstrapResamples: 6, parameterVersion: 'other.params.v1' }),
  )
  assert.throws(
    () =>
      otherService.proposeCandidate({
        report,
        author: 'calibration.bot',
        createdAt: CREATED_AT,
      }),
    CalibrationValidationError,
  )
})

test('simulated and real channels stay separate', () => {
  const dataset = generateDataset({ seed: 31, sequenceCount: 10, eventsPerSequence: 5 })
  const heldOut = generateDataset({
    seed: 77,
    sequenceCount: 5,
    eventsPerSequence: 4,
    datasetId: 'dataset.heldout',
  })
  const service = new CalibrationService(dataset, makeConfig({ seed: 31, bootstrapResamples: 6 }))
  const candidate = service.proposeCandidate({
    report: service.calibrate(),
    author: 'calibration.bot',
    createdAt: CREATED_AT,
  })
  const verdict = evaluateCandidate({ candidate, heldOut, evaluatedAt: CREATED_AT })
  assert.ok(verdict.simulatedBenefit !== null)
  assert.equal(verdict.simulatedBenefit.isCausalEvidence, false)
  assert.equal(verdict.realTransfer, null)
  assert.equal(verdict.promotionReady, false)
  assert.ok(verdict.reasons.includes('promotion_blocked:real_transfer_evidence_missing'))
})

test('RealTransferEvidence only accepts trusted sources', () => {
  assert.throws(
    () =>
      new RealTransferEvidence({
        source: 'anonymous',
        itemCount: 4,
        observedDelta: 0.1,
        allItemsUnseen: true,
      }),
    CalibrationValidationError,
  )
  assert.ok((TRUSTED_REAL_SOURCES as readonly string[]).includes('student'))
})

test('trusted unseen real transfer can make promotion ready', () => {
  const dataset = generateDataset({ seed: 31, sequenceCount: 10, eventsPerSequence: 5 })
  const heldOut = generateDataset({
    seed: 77,
    sequenceCount: 5,
    eventsPerSequence: 4,
    datasetId: 'dataset.heldout',
  })
  const service = new CalibrationService(dataset, makeConfig({ seed: 31, bootstrapResamples: 6 }))
  const candidate = service.proposeCandidate({
    report: service.calibrate(),
    author: 'calibration.bot',
    createdAt: CREATED_AT,
  })
  const evidence = new RealTransferEvidence({
    source: 'teacher',
    itemCount: 4,
    observedDelta: 0.12,
    allItemsUnseen: true,
  })
  const verdict = evaluateCandidate({
    candidate,
    heldOut,
    realEvidence: evidence,
    evaluatedAt: CREATED_AT,
  })
  assert.equal(verdict.promotionReady, true)
  assert.ok(verdict.realTransfer !== null)
  assert.equal(verdict.realTransfer.isCausalEvidence, false)
})

test('seen real items block promotion', () => {
  const dataset = generateDataset({ seed: 31, sequenceCount: 10, eventsPerSequence: 5 })
  const heldOut = generateDataset({
    seed: 77,
    sequenceCount: 5,
    eventsPerSequence: 4,
    datasetId: 'dataset.heldout',
  })
  const service = new CalibrationService(dataset, makeConfig({ seed: 31, bootstrapResamples: 6 }))
  const candidate = service.proposeCandidate({
    report: service.calibrate(),
    author: 'calibration.bot',
    createdAt: CREATED_AT,
  })
  const evidence = new RealTransferEvidence({
    source: 'student',
    itemCount: 4,
    observedDelta: 0.2,
    allItemsUnseen: false,
  })
  const verdict = evaluateCandidate({
    candidate,
    heldOut,
    realEvidence: evidence,
    evaluatedAt: CREATED_AT,
  })
  assert.equal(verdict.promotionReady, false)
  assert.ok(verdict.reasons.includes('real_transfer_failed:item_was_seen'))
})

function makePositiveFlow(): {
  gate: CalibrationActivationGate
  candidate: Candidate
  heldOut: CalibrationDataset
} {
  const dataset = generateDataset({ seed: 31, sequenceCount: 10, eventsPerSequence: 5 })
  const heldOut = generateDataset({
    seed: 77,
    sequenceCount: 5,
    eventsPerSequence: 4,
    datasetId: 'dataset.heldout',
  })
  const service = new CalibrationService(dataset, makeConfig({ seed: 31, bootstrapResamples: 6 }))
  const candidate = service.proposeCandidate({
    report: service.calibrate(),
    author: 'calibration.bot',
    createdAt: CREATED_AT,
  })
  const gate = new CalibrationActivationGate({ now: () => DECIDED_AT })
  return { gate, candidate, heldOut }
}

function approvalFor(candidate: Candidate, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    candidateId: candidate.candidateId,
    candidateVersion: candidate.version,
    decision: 'approved',
    approvedBy: REVIEWER.actorId,
    decidedAt: DECIDED_AT,
    reason: 'synthetic calibration accepted for the demo',
    role: REVIEWER.role,
    ...overrides,
  }
}

test('evaluation status reflects screening, and activation needs approval', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  assert.equal(gate.status(candidate.candidateId, candidate.version), STATUS_REGISTERED)
  const verdict = gate.evaluate(candidate.candidateId, candidate.version, heldOut, {
    actor: REVIEWER,
  })
  assert.equal(verdict.screeningPassed, true)
  assert.equal(gate.status(candidate.candidateId, candidate.version), STATUS_EVALUATED)
  assert.throws(
    () =>
      gate.activate(candidate.candidateId, candidate.version, { actor: REVIEWER }),
    CalibrationDeniedError,
  )
})

test('held-out evidence without improvement is rejected', () => {
  const { gate, candidate } = makePositiveFlow()
  const adversarial = generateDataset({
    seed: 80,
    sequenceCount: 5,
    eventsPerSequence: 4,
    datasetId: 'dataset.adversarial',
  })
  gate.register(candidate)
  const verdict = gate.evaluate(candidate.candidateId, candidate.version, adversarial, {
    actor: REVIEWER,
  })
  assert.equal(verdict.screeningPassed, false)
  assert.equal(gate.status(candidate.candidateId, candidate.version), 'rejected')
  assert.ok(
    verdict.reasons.includes('screening_failed:brier_improvement_below_threshold'),
  )
})

test('explicit approval then activation succeeds', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  gate.approve(
    candidate.candidateId,
    candidate.version,
    approvalFor(candidate),
    REVIEWER,
  )
  assert.equal(gate.status(candidate.candidateId, candidate.version), STATUS_APPROVED)
  const activation = gate.activate(candidate.candidateId, candidate.version, {
    actor: REVIEWER,
  })
  assert.equal(activation.parameterVersion, candidate.version)
  assert.equal(gate.status(candidate.candidateId, candidate.version), STATUS_ACTIVATED)
  assert.ok(gate.audit.head > 0)
  assert.equal(
    gate.audit.entries({ action: ACTION_CALIBRATION_ACTIVATED }).length,
    1,
  )
})

test('activation is default deny without an approval record', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  assert.throws(
    () => gate.approve(candidate.candidateId, candidate.version, null, REVIEWER),
    CalibrationDeniedError,
  )
})

test('a candidate can never approve itself', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  const authorActor: Actor = { actorId: candidate.author, role: 'reviewer' }
  assert.throws(
    () =>
      gate.approve(
        candidate.candidateId,
        candidate.version,
        approvalFor(candidate, { approvedBy: authorActor.actorId }),
        authorActor,
      ),
    CalibrationDeniedError,
  )
})

test('a non-host role cannot approve', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  const studentActor: Actor = { actorId: 'student.1', role: 'student' }
  assert.throws(
    () =>
      gate.approve(
        candidate.candidateId,
        candidate.version,
        approvalFor(candidate, { approvedBy: studentActor.actorId, role: 'student' }),
        studentActor,
      ),
    CalibrationDeniedError,
  )
})

test('an approval naming a different candidate is refused', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  assert.throws(
    () =>
      gate.approve(
        candidate.candidateId,
        candidate.version,
        approvalFor(candidate, { candidateVersion: 'other.version' }),
        REVIEWER,
      ),
    CalibrationDeniedError,
  )
})

test('rollback returns to the previous stable version', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  gate.approve(candidate.candidateId, candidate.version, approvalFor(candidate), REVIEWER)
  const activation = gate.activate(candidate.candidateId, candidate.version, {
    actor: REVIEWER,
  })
  const rolledBack = gate.rollback(candidate.candidateId, candidate.version, {
    actor: REVIEWER,
    reason: 'synthetic rollback',
  })
  assert.equal(rolledBack.previousStableVersion, activation.previousStableVersion)
  assert.equal(
    gate.activeParameters(candidate.candidateId),
    activation.previousStableVersion,
  )
})

test('unknown candidates are refused by the gate', () => {
  const gate = new CalibrationActivationGate({ now: () => DECIDED_AT })
  assert.throws(() => gate.record('missing', 'v1'), CalibrationError)
  assert.equal(gate.status('missing', 'v1'), null)
})

test('calibration never changes a memory state or a twin', () => {
  const twin = new StudentTwin('stu.1')
  twin.recordObserved({
    eventId: 'ev.1',
    eventType: 'attempt',
    source: 'student',
    payload: { correct: true },
  })
  twin.updateMastery('kc.quadratic', 0.55, 0.2, ['ev.1'])
  const before = twin.snapshot()
  const beforeRevision = twin.evidenceRevision

  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  gate.approve(candidate.candidateId, candidate.version, approvalFor(candidate), REVIEWER)
  gate.activate(candidate.candidateId, candidate.version, { actor: REVIEWER })

  assert.deepEqual(twin.snapshot(), before)
  assert.equal(twin.evidenceRevision, beforeRevision)
  assert.equal(twin.knowledgeFor('kc.quadratic')?.masteryMean, 0.55)
})

test('activation is a frozen config object, not a production write', () => {
  const { gate, candidate, heldOut } = makePositiveFlow()
  gate.register(candidate)
  gate.evaluate(candidate.candidateId, candidate.version, heldOut, { actor: REVIEWER })
  gate.approve(candidate.candidateId, candidate.version, approvalFor(candidate), REVIEWER)
  const activation = gate.activate(candidate.candidateId, candidate.version, {
    actor: REVIEWER,
  })
  const snapshot = gate.pipelineSnapshot()
  assert.equal(snapshot.productionMutationEnabled, false)
  assert.equal(snapshot.syntheticFixturesOnly, true)
  assert.throws(
    () => {
      ;(activation.values as Record<string, number>).initial_stability_days = 1
    },
    TypeError,
  )
})

test('evaluation refuses non-causal simulated benefit', () => {
  assert.throws(
    () =>
      new CalibrationEvaluation({
        candidateId: 'c',
        candidateVersion: 'v',
        heldOutDigest: 'd',
        simulatedBenefit: {
          channel: 'simulated',
          isCausalEvidence: true,
        },
        realTransfer: null,
        screeningPassed: true,
        promotionReady: false,
        evidenceSufficient: true,
        reasons: [],
        isolationChecks: [],
        limitations: [],
        evaluatedAt: DECIDED_AT,
      }),
    CalibrationValidationError,
  )
})

test('approval policy is declarative', () => {
  const policy = new CalibrationApprovalPolicy()
  const payload = policy.asDict()
  assert.equal(payload.minHeldOutSequences, 2)
  assert.equal(payload.minBrierImprovement, 0)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)) as unknown)
})

// ---------------------------------------------------------------------------
// Shared fixture parity with aeh/fsrs_calibration.py
// ---------------------------------------------------------------------------

test('fixture: dataset and config fingerprints match Python', () => {
  const fixture = loadFixture()
  const dataset = datasetFromDict(fixture.dataset)
  const config = configFromFixture(fixture.config)
  assert.equal(dataset.digest(), fixture.expected.datasetDigest)
  assert.equal(config.fingerprint(), fixture.expected.configFingerprint)
})

test('fixture: report fingerprint, parameters, and estimates match Python', () => {
  const fixture = loadFixture()
  const dataset = datasetFromDict(fixture.dataset)
  const config = configFromFixture(fixture.config)
  const report = calibrate(dataset, config)
  assert.equal(report.fingerprint(), fixture.expected.reportFingerprint)
  assert.equal(
    canonicalJson(report.parameters.quantizedDict()),
    canonicalJson(fixture.expected.parameters),
  )
  assert.equal(
    canonicalJson(report.estimates.map((estimate) => estimate.asDict())),
    canonicalJson(fixture.expected.estimates),
  )
})

test('fixture: metrics, applicability, and the whole report match Python', () => {
  const fixture = loadFixture()
  const dataset = datasetFromDict(fixture.dataset)
  const config = configFromFixture(fixture.config)
  const report = calibrate(dataset, config)
  assert.equal(
    canonicalJson(report.metrics.asDict()),
    canonicalJson(fixture.expected.metrics),
  )
  assert.equal(
    canonicalJson(report.applicability.asDict()),
    canonicalJson(fixture.expected.applicability),
  )
  assert.equal(
    canonicalJson(report.asDict()),
    canonicalJson(fixture.expected),
  )
  assert.equal(report.sequenceCount, fixture.expected.sequenceCount)
  assert.equal(report.observationCount, fixture.expected.observationCount)
  assert.equal(report.evidenceSufficient, fixture.expected.evidenceSufficient)
})

test('fixture dataset is canonical and synthetic', () => {
  const fixture = loadFixture()
  const encoded = canonicalJson(fixture.dataset)
  assert.ok(encoded.includes('seq.synthetic.0000'))
  assert.ok(!encoded.includes('@'))
})
