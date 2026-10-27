/**
 * Step 16 tests: service boundaries, storage implementations, write
 * coordination and the Harness state machine (spec §12 / §13).
 *
 * Mirrors `tests/test_services_step16.py` and reads the same shared synthetic
 * fixture `tests/fixtures/services_step16.json`. No real student data is used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BRANCH_ABNORMAL_PRESSURE,
  BRANCH_CURRICULUM_GATE_REJECTED,
  BRANCH_HYPOTHESES_ALL_MISMATCHED,
  BRANCH_LOW_CONFIDENCE_STRATEGY,
  BRANCH_OCR_UNCERTAIN,
  BRANCH_RAG_SOURCE_MISSING,
  BRANCH_SCHOOL_PROGRESS_UNCLEAR,
  BRANCH_SIMULATION_TIMEOUT,
  BRANCH_SPARSE_MEMORY_DATA,
  BRANCH_STUDENT_REFUSES_DIAGNOSIS,
  CONTENT_APPROVED,
  CONTENT_DRAFT,
  DEFAULT_MAX_REJECTIONS,
  DOMAIN_OBSERVED,
  DOMAIN_SIMULATED,
  EVENT_INDEPENDENT_ATTEMPT,
  EVENT_REVIEW_COMPLETED,
  EVENT_SIMULATION_STARTED,
  EVENT_TYPES,
  EXCEPTION_BRANCHES,
  EventDraft,
  STATE_ABORTED,
  STATE_ASSESS,
  STATE_AWAIT_STUDENT,
  STATE_CANDIDATE_RANKING,
  STATE_COMPLETED,
  STATE_CONTENT_VALIDATION,
  STATE_CURRICULUM_GATE,
  STATE_DELIVER,
  STATE_DIAGNOSE,
  STATE_EVIDENCE_PARSE,
  STATE_EXERCISE_EVOLUTION,
  STATE_FAILED,
  STATE_HYPOTHESIS_UPDATE,
  STATE_INTAKE,
  STATE_NEED_CLARIFICATION,
  STATE_PREVIEW_PLANNER,
  STATE_PROBE,
  STATE_PROGRESS_CHECK,
  STATE_RECALL_SCHEDULE,
  STATE_REVIEW_RESCHEDULE,
  STATE_SIMULATION_LAB,
  STATE_STATE_COMMIT,
  STATE_STATE_LOAD,
  SOURCE_OBSERVED,
  SOURCE_SIMULATED,
  TRANSITIONS,
  ConflictError,
  ContentRecord,
  FileBundleStore,
  FileContentLibrary,
  FileEvaluationService,
  FileEventStore,
  FileProfileStore,
  HarnessStateMachine,
  IdempotencyConflictError,
  InMemoryBundleStore,
  InMemoryContentLibrary,
  InMemoryEvaluationService,
  InMemoryEventStore,
  InMemoryProfileStore,
  IntegrityError,
  InvalidTransitionError,
  IsolationViolationError,
  NotFoundError,
  OptimisticConcurrencyError,
  ProfileBundle,
  SelfProofError,
  ServiceError,
  SplitIsolationError,
  StateMachineError,
  StudentProfile,
  ValidationError,
  WriteCoordinator,
  canonicalJson,
  contentDigest,
  createFrozenEvalSet,
  createRealOutcome,
  exceptionBranch,
  utcNow,
  type AppendResult,
  type EventDraftInput,
  type EvalItem,
  type RealOutcome,
} from '../src/core/services.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/services_step16.json', import.meta.url),
    'utf8',
  ),
)

function draftFrom(record: any, streamId: string): EventDraftInput {
  return {
    streamId,
    eventType: record.eventType,
    sourceType: record.sourceType,
    occurredAt: record.occurredAt,
    idempotencyKey: record.idempotencyKey,
    sessionId: record.sessionId ?? '',
    payload: record.payload ?? {},
  }
}

function draftInput(overrides: Partial<EventDraftInput> = {}): EventDraftInput {
  return {
    streamId: 'student.a',
    eventType: EVENT_INDEPENDENT_ATTEMPT,
    sourceType: SOURCE_OBSERVED,
    occurredAt: '2026-10-26T20:15:00+08:00',
    idempotencyKey: 'k1',
    payload: { item_id: 'item_1' },
    ...overrides,
  }
}

function item(record: any): EvalItem {
  return {
    itemId: record.itemId,
    kcId: record.kcId,
    split: record.split,
    difficulty: record.difficulty ?? 2,
    seenBefore: record.seenBefore ?? false,
  }
}

function runScript(machine: HarnessStateMachine, script: readonly string[]) {
  for (const target of script) {
    if (
      machine.state === STATE_CURRICULUM_GATE &&
      target === STATE_EXERCISE_EVOLUTION
    ) {
      machine.registerRejection({
        code: BRANCH_CURRICULUM_GATE_REJECTED,
        reason: 'fixture_rework',
      })
    } else {
      machine.advance(target, { reason: 'fixture' })
    }
  }
}

function machineAt(steps: readonly string[]): HarnessStateMachine {
  const machine = new HarnessStateMachine('student.demo.1')
  for (const step of steps) {
    machine.advance(step, { reason: 'setup' })
  }
  return machine
}

function withTempDir<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'aeh-services-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

test('step16 fixture is synthetic', () => {
  assert.equal(fixture.meta.synthetic, true)
})

test('step16 fixture: event store appends and dedupes', () => {
  const block = fixture.eventStore
  const store = new InMemoryEventStore(block.domain)
  const results: AppendResult[] = block.appends.map((record: any) =>
    store.append(
      new EventDraft(draftFrom(record, block.streamId)),
      { expectedVersion: record.expectedVersion },
    ),
  )
  assert.deepEqual(
    results.map((result) => result.deduplicated),
    block.expectedDeduplicated,
  )
  assert.deepEqual(
    results.map((result) => result.event.sequence),
    block.expectedSequences,
  )
  assert.equal(store.streamVersion(block.streamId), block.expectedVersion)
})

test('step16 fixture: profile create and update', () => {
  const block = fixture.profile
  const store = new InMemoryProfileStore()
  const profile = store.create(
    new StudentProfile({
      studentRef: block.studentRef,
      stage: block.stage,
      guardianConsent: block.guardianConsent,
      settings: block.settings,
    }),
  )
  assert.equal(profile.version, block.expectedCreateVersion)
  const updated = store.update(block.studentRef, {
    expectedVersion: block.expectedCreateVersion,
    settings: block.patch,
  })
  assert.equal(updated.version, block.expectedUpdatedVersion)
  assert.equal(
    updated.settings.preferred_session_minutes,
    block.patch.preferred_session_minutes,
  )
})

test('step16 fixture: bundle is content-addressed', () => {
  const block = fixture.bundle
  const store = new InMemoryBundleStore()
  const bundle = new ProfileBundle({
    studentRef: block.studentRef,
    twinVersion: block.twinVersion,
    schoolProgressVersion: block.schoolProgressVersion,
    contentVersion: block.contentVersion,
    createdAt: block.createdAt,
  })
  assert.equal(store.put(bundle).digest, bundle.digest)
  assert.equal(store.put(bundle).digest, bundle.digest)
})

test('step16 fixture: content retrieve returns approved only', () => {
  const block = fixture.content
  const library = new InMemoryContentLibrary()
  for (const record of block.records) {
    library.put(record.contentId, {
      kcIds: record.kcIds,
      difficulty: record.difficulty,
      reviewState: record.reviewState,
      expectedVersion: 0,
    })
  }
  const hits = library.retrieve(block.retrieveKc)
  assert.deepEqual(
    hits.map((record) => record.contentId),
    block.retrieveExpectedIds,
  )
})

test('step16 fixture: evaluation split channels', () => {
  const block = fixture.evaluation
  const service = new InMemoryEvaluationService()
  const frozen = createFrozenEvalSet({
    datasetId: block.datasetId,
    version: block.version,
    frozenAt: block.frozenAt,
    items: block.items.map(item),
  })
  service.registerDataset(frozen)
  const run = service.run(block.datasetId, {
    idempotencyKey: block.idempotencyKey,
    simulatedOutcomes: block.simulated.map((entry: any) => ({
      itemId: entry.itemId,
      predictedCorrect: entry.predictedCorrect,
    })),
    realOutcomes: block.real.map((entry: any) =>
      createRealOutcome({
        itemId: entry.itemId,
        correct: entry.correct,
        source: entry.source,
        occurredAt: entry.occurredAt,
        independent: entry.independent ?? true,
      }),
    ),
  })
  assert.ok(run.simulated)
  assert.ok(Math.abs(run.simulated!.meanPredictedCorrect - block.expectedSimulatedMean) < 1e-9)
  assert.ok(Math.abs(run.simulated!.simulatedGain - block.expectedSimulatedGain) < 1e-9)
  assert.ok(run.realTransfer)
  assert.ok(Math.abs(run.realTransfer!.transferAccuracy - block.expectedRealAccuracy) < 1e-9)
  assert.deepEqual(run.realTransfer!.sources, block.expectedRealSources)
  assert.ok(run.claim.includes(block.expectedClaimContains))
})

test('step16 fixture: state machine full loop', () => {
  const block = fixture.stateMachine
  const machine = new HarnessStateMachine(block.studentRef)
  runScript(machine, block.script)
  assert.equal(machine.state, block.expectedFinalState)
  assert.equal(machine.history.length, block.expectedTransitions)
  assert.equal(machine.rejections, 0)
})

test('step16 fixture: probe and rework script', () => {
  const block = fixture.stateMachine
  const machine = new HarnessStateMachine(block.studentRef)
  runScript(machine, block.probeScript)
  assert.equal(machine.state, block.expectedProbeFinalState)
  assert.equal(machine.rejections, block.expectedProbeRejections)
})

test('step16 fixture: exception branch targets', () => {
  for (const [code, target] of Object.entries(
    fixture.stateMachine.exceptions,
  )) {
    assert.equal(exceptionBranch(code).targetState, target)
  }
})

test('step16 fixture: write coordinator runOnce', () => {
  const block = fixture.writeCoordinator
  const coordinator = new WriteCoordinator()
  let calls = 0
  const first = coordinator.runOnce(block.streamId, block.idempotencyKey, () => {
    calls += 1
    return calls
  })
  const second = coordinator.runOnce(block.streamId, block.idempotencyKey, () => {
    calls += 1
    return calls
  })
  assert.equal(first[0], second[0])
  assert.equal(first[1], false)
  assert.equal(second[1], true)
  assert.equal(calls, block.expectedRunOnce)
})

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

test('step16: append assigns sequence and version', () => {
  const store = new InMemoryEventStore(DOMAIN_OBSERVED)
  const result = store.append(new EventDraft(draftInput()))
  assert.equal(result.event.sequence, 1)
  assert.equal(result.streamVersion, 1)
  assert.equal(result.deduplicated, false)
})

test('step16: idempotent replay returns same event', () => {
  const store = new InMemoryEventStore(DOMAIN_OBSERVED)
  const first = store.append(new EventDraft(draftInput()))
  const second = store.append(new EventDraft(draftInput()))
  assert.equal(first.event.eventId, second.event.eventId)
  assert.equal(second.deduplicated, true)
  assert.equal(store.streamVersion('student.a'), 1)
})

test('step16: idempotency conflict on different payload', () => {
  const store = new InMemoryEventStore(DOMAIN_OBSERVED)
  store.append(new EventDraft(draftInput()))
  assert.throws(
    () => store.append(new EventDraft(draftInput({ payload: { item_id: 'item_2' } }))),
    IdempotencyConflictError,
  )
})

test('step16: optimistic concurrency conflict and success', () => {
  const store = new InMemoryEventStore(DOMAIN_OBSERVED)
  store.append(new EventDraft(draftInput()), { expectedVersion: 0 })
  assert.throws(
    () => store.append(new EventDraft(draftInput({ idempotencyKey: 'k2' })), { expectedVersion: 0 }),
    OptimisticConcurrencyError,
  )
  const result = store.append(
    new EventDraft(draftInput({ idempotencyKey: 'k2' })),
    { expectedVersion: 1 },
  )
  assert.equal(result.event.sequence, 2)
})

test('step16: get, list and lookup', () => {
  const store = new InMemoryEventStore(DOMAIN_OBSERVED)
  const result = store.append(new EventDraft(draftInput()))
  assert.equal(store.get(result.event.eventId).eventId, result.event.eventId)
  assert.equal(store.findByIdempotency('student.a', 'k1')?.eventId, result.event.eventId)
  assert.equal(store.findByIdempotency('student.a', 'missing'), null)
  assert.equal(store.listEvents('student.a', { limit: 1 }).length, 1)
  assert.throws(() => store.get('ev_missing'), NotFoundError)
})

test('step16: observed store rejects simulated source and simulation events', () => {
  const observed = new InMemoryEventStore(DOMAIN_OBSERVED)
  assert.throws(
    () => observed.append(new EventDraft(draftInput({ sourceType: SOURCE_SIMULATED }))),
    IsolationViolationError,
  )
  assert.throws(
    () =>
      observed.append(
        new EventDraft(draftInput({ eventType: EVENT_SIMULATION_STARTED })),
      ),
    IsolationViolationError,
  )
})

test('step16: simulated store rejects observed source', () => {
  const simulated = new InMemoryEventStore(DOMAIN_SIMULATED)
  assert.throws(
    () => simulated.append(new EventDraft(draftInput())),
    IsolationViolationError,
  )
  const result = simulated.append(
    new EventDraft(
      draftInput({ sourceType: SOURCE_SIMULATED, eventType: EVENT_SIMULATION_STARTED }),
    ),
  )
  assert.equal(result.event.sourceType, SOURCE_SIMULATED)
})

test('step16: unknown event and source are rejected', () => {
  assert.throws(() => new EventDraft(draftInput({ eventType: 'NOT_AN_EVENT' })), ValidationError)
  assert.throws(
    () => new EventDraft(draftInput({ sourceType: 'guess' as any })),
    ValidationError,
  )
})

test('step16: payload must be small scalars', () => {
  assert.throws(
    () => new EventDraft(draftInput({ payload: { nested: { a: 1 } } })),
    ValidationError,
  )
  assert.throws(
    () => new EventDraft(draftInput({ payload: { blob: 'x'.repeat(5000) } })),
    ValidationError,
  )
})

test('step16: schema version is pinned', () => {
  assert.throws(
    () => new EventDraft(draftInput({ schemaVersion: 'aeh.event.v0' })),
    ValidationError,
  )
})

test('step16: repeated concurrent idempotent appends are single-flight', async () => {
  const store = new InMemoryEventStore(DOMAIN_OBSERVED)
  const results = await Promise.all(
    Array.from({ length: 8 }, async () =>
      store.append(new EventDraft(draftInput())),
    ),
  )
  assert.equal(store.streamVersion('student.a'), 1)
  assert.equal(results.filter((result) => !result.deduplicated).length, 1)
})

test('step16: file event store persists and reloads', () => {
  withTempDir((root) => {
      const store = new FileEventStore(root, DOMAIN_OBSERVED)
    const result = store.append(new EventDraft(draftInput()))
    const reopened = new FileEventStore(root, DOMAIN_OBSERVED)
    assert.equal(reopened.streamVersion('student.a'), 1)
    assert.equal(
      reopened.get(result.event.eventId).payload.item_id,
      'item_1',
    )
  })
})

test('step16: file event store detects tampering', () => {
  withTempDir((root) => {
      const store = new FileEventStore(root, DOMAIN_OBSERVED)
    store.append(new EventDraft(draftInput()))
    const path = join(root, 'events.observed.jsonl')
    const record = JSON.parse(readFileSync(path, 'utf8').trim())
    record.payload.item_id = 'tampered'
    writeFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
    assert.throws(() => new FileEventStore(root, DOMAIN_OBSERVED), IntegrityError)
  })
})

test('step16: file event store rejects a foreign domain record', () => {
  withTempDir((root) => {
    const record: Record<string, unknown> = {
      event_id: 'ev_x',
      stream_id: 's',
      event_type: EVENT_INDEPENDENT_ATTEMPT,
      source_type: SOURCE_SIMULATED,
      occurred_at: '2026-10-26T20:15:00+08:00',
      sequence: 1,
      idempotency_key: 'k',
      session_id: '',
      provenance: 'synthetic',
      payload: {},
      schema_version: 'aeh.event.v1',
    }
    record.digest = contentDigest(record)
    writeFileSync(
      join(root, 'events.observed.jsonl'),
      `${JSON.stringify(record)}\n`,
      'utf8',
    )
    assert.throws(() => new FileEventStore(root, DOMAIN_OBSERVED), IntegrityError)
  })
})

// ---------------------------------------------------------------------------
// Write coordinator
// ---------------------------------------------------------------------------

test('step16: coordinator memoises runOnce', () => {
  const coordinator = new WriteCoordinator()
  let calls = 0
  const first = coordinator.runOnce('s', 'k', () => {
    calls += 1
    return 1
  })
  const second = coordinator.runOnce('s', 'k', () => {
    calls += 1
    return 2
  })
  assert.equal(first[0], 1)
  assert.equal(second[0], 1)
  assert.equal(second[1], true)
  assert.equal(calls, 1)
})

test('step16: distinct coordinator keys run independently', () => {
  const coordinator = new WriteCoordinator()
  assert.equal(coordinator.runOnce('s', 'k1', () => 'a')[0], 'a')
  assert.equal(coordinator.runOnce('s', 'k2', () => 'b')[0], 'b')
  assert.equal(coordinator.stats().memo, 2)
})

test('step16: coordinator runOnce executes once under async fan-out', async () => {
  const coordinator = new WriteCoordinator()
  let calls = 0
  const results = await Promise.all(
    Array.from({ length: 8 }, async () =>
      coordinator.runOnce('stream', 'key', () => {
        calls += 1
        return 'value'
      }),
    ),
  )
  assert.equal(calls, 1)
  assert.equal(results.filter((entry) => !entry[1]).length, 1)
  assert.ok(results.every((entry) => entry[0] === 'value'))
})

// ---------------------------------------------------------------------------
// Profile and bundles
// ---------------------------------------------------------------------------

test('step16: profile create duplicate conflicts', () => {
  const store = new InMemoryProfileStore()
  store.create(new StudentProfile({ studentRef: 'student.a', stage: 'senior_secondary' }))
  assert.throws(
    () => store.create(new StudentProfile({ studentRef: 'student.a' })),
    ConflictError,
  )
  assert.equal(store.listAll().length, 1)
})

test('step16: profile update is optimistic', () => {
  const store = new InMemoryProfileStore()
  store.create(new StudentProfile({ studentRef: 'student.a' }))
  const updated = store.update('student.a', {
    expectedVersion: 1,
    guardianConsent: true,
  })
  assert.equal(updated.version, 2)
  assert.equal(updated.guardianConsent, true)
  assert.throws(
    () => store.update('student.a', { expectedVersion: 1 }),
    OptimisticConcurrencyError,
  )
})

test('step16: missing profile raises', () => {
  const store = new InMemoryProfileStore()
  assert.throws(() => store.get('student.missing'), NotFoundError)
})

test('step16: profile stage validation', () => {
  assert.throws(
    () => new StudentProfile({ studentRef: 'student.a', stage: 'kindergarten' as any }),
    ValidationError,
  )
})

test('step16: file profile store persists', () => {
  withTempDir((root) => {
    const store = new FileProfileStore(root)
    store.create(
      new StudentProfile({
        studentRef: 'student.a',
        stage: 'senior_secondary',
        settings: { locale: 'zh-CN' },
      }),
    )
    const reopened = new FileProfileStore(root)
    assert.equal(reopened.get('student.a').settings.locale, 'zh-CN')
  })
})

test('step16: bundle store is idempotent', () => {
  const store = new InMemoryBundleStore()
  const bundle = new ProfileBundle({
    studentRef: 'student.a',
    twinVersion: 54,
    schoolProgressVersion: 15,
    contentVersion: 7,
    createdAt: utcNow(),
  })
  assert.equal(store.put(bundle).digest, bundle.digest)
  assert.equal(store.listForStudent('student.a').length, 1)
  assert.equal(store.listForStudent('student.b').length, 0)
})

test('step16: bundle digest binds versions', () => {
  const first = new ProfileBundle({
    studentRef: 'student.a',
    twinVersion: 54,
    schoolProgressVersion: 15,
    contentVersion: 7,
    createdAt: '2026-10-27T09:00:00+08:00',
  })
  const second = new ProfileBundle({
    studentRef: 'student.a',
    twinVersion: 55,
    schoolProgressVersion: 15,
    contentVersion: 7,
    createdAt: '2026-10-27T09:00:00+08:00',
  })
  assert.notEqual(first.digest, second.digest)
})

test('step16: file bundle store persists', () => {
  withTempDir((root) => {
    const store = new FileBundleStore(root)
    const bundle = new ProfileBundle({
      studentRef: 'student.a',
      twinVersion: 1,
      schoolProgressVersion: 2,
      contentVersion: 3,
      createdAt: '2026-10-27T09:00:00+08:00',
    })
    store.put(bundle)
    const reopened = new FileBundleStore(root)
    assert.equal(reopened.get(bundle.bundleId).digest, bundle.digest)
  })
})

// ---------------------------------------------------------------------------
// Content library
// ---------------------------------------------------------------------------

function seedContent(library: InMemoryContentLibrary): void {
  library.put('item_1', {
    kcIds: ['algebra.square_compensation'],
    difficulty: 3,
    reviewState: CONTENT_APPROVED,
    expectedVersion: 0,
  })
  library.put('item_2', {
    kcIds: ['algebra.square_compensation'],
    difficulty: 2,
    reviewState: CONTENT_DRAFT,
    expectedVersion: 0,
  })
  library.put('item_3', {
    kcIds: ['algebra.other'],
    difficulty: 2,
    reviewState: CONTENT_DRAFT,
    expectedVersion: 0,
  })
}

test('step16: content retrieve returns only approved', () => {
  const library = new InMemoryContentLibrary()
  seedContent(library)
  assert.deepEqual(
    library.retrieve('algebra.square_compensation').map((record) => record.contentId),
    ['item_1'],
  )
})

test('step16: content retrieve is fail-closed without approved', () => {
  const library = new InMemoryContentLibrary()
  seedContent(library)
  assert.deepEqual(library.retrieve('algebra.other'), [])
})

test('step16: content sorts and filters by difficulty', () => {
  const library = new InMemoryContentLibrary()
  library.put('item_a', {
    kcIds: ['kc.x'],
    difficulty: 4,
    reviewState: CONTENT_APPROVED,
    expectedVersion: 0,
  })
  library.put('item_b', {
    kcIds: ['kc.x'],
    difficulty: 1,
    reviewState: CONTENT_APPROVED,
    expectedVersion: 0,
  })
  assert.deepEqual(
    library.retrieve('kc.x').map((record) => record.contentId),
    ['item_b', 'item_a'],
  )
  assert.deepEqual(
    library.retrieve('kc.x', { difficulty: 4 }).map((record) => record.contentId),
    ['item_a'],
  )
})

test('step16: content version bump and stale write', () => {
  const library = new InMemoryContentLibrary()
  library.put('item_1', {
    kcIds: ['kc.x'],
    difficulty: 2,
    reviewState: CONTENT_DRAFT,
    expectedVersion: 0,
  })
  const updated = library.put('item_1', {
    kcIds: ['kc.x'],
    difficulty: 2,
    reviewState: CONTENT_APPROVED,
    expectedVersion: 1,
  })
  assert.equal(updated.version, 2)
  assert.equal(library.currentVersion('item_1'), 2)
  assert.throws(
    () =>
      library.put('item_1', {
        kcIds: ['kc.x'],
        difficulty: 5,
        reviewState: CONTENT_DRAFT,
        expectedVersion: 1,
      }),
    OptimisticConcurrencyError,
  )
})

test('step16: identical content write is idempotent', () => {
  const library = new InMemoryContentLibrary()
  const first = library.put('item_1', {
    kcIds: ['kc.x'],
    difficulty: 2,
    reviewState: CONTENT_DRAFT,
    expectedVersion: 0,
  })
  const second = library.put('item_1', {
    kcIds: ['kc.x'],
    difficulty: 2,
    reviewState: CONTENT_DRAFT,
    expectedVersion: 0,
  })
  assert.equal(first.version, second.version)
})

test('step16: content get and missing versions', () => {
  const library = new InMemoryContentLibrary()
  seedContent(library)
  assert.equal(library.get('item_1').version, 1)
  assert.throws(() => library.get('item_missing'), NotFoundError)
  assert.throws(() => library.get('item_1', 9), NotFoundError)
})

test('step16: content record validation', () => {
  assert.throws(
    () =>
      new ContentRecord({
        contentId: 'item_1',
        version: 1,
        kcIds: [],
        difficulty: 2,
        reviewState: CONTENT_DRAFT,
      }),
    ValidationError,
  )
  assert.throws(
    () =>
      new ContentRecord({
        contentId: 'item_1',
        version: 1,
        kcIds: ['kc.x'],
        difficulty: 9,
        reviewState: CONTENT_DRAFT,
      }),
    ValidationError,
  )
})

test('step16: file content library persists', () => {
  withTempDir((root) => {
    const library = new FileContentLibrary(root)
    seedContent(library)
    const reopened = new FileContentLibrary(root)
    assert.equal(reopened.currentVersion('item_1'), 1)
    assert.equal(reopened.retrieve('algebra.square_compensation').length, 1)
  })
})

// ---------------------------------------------------------------------------
// Evaluation service
// ---------------------------------------------------------------------------

function frozenSet(version = 'v1') {
  return createFrozenEvalSet({
    datasetId: 'eval_demo',
    version,
    frozenAt: '2026-10-27T00:00:00+00:00',
    items: [
      { itemId: 'train_1', kcId: 'kc.x', split: 'train', difficulty: 2, seenBefore: false },
      { itemId: 'explain_1', kcId: 'kc.x', split: 'explanation', difficulty: 2, seenBefore: false },
      { itemId: 'transfer_1', kcId: 'kc.x', split: 'transfer', difficulty: 3, seenBefore: false },
    ],
  })
}

test('step16: register dataset is idempotent and conflict aware', () => {
  const service = new InMemoryEvaluationService()
  const summary = service.registerDataset(frozenSet())
  assert.equal(summary.dataset_id, 'eval_demo')
  assert.equal(
    (service.registerDataset(frozenSet()) as any).digest,
    (summary as any).digest,
  )
  const altered = createFrozenEvalSet({
    datasetId: 'eval_demo',
    version: 'v2',
    frozenAt: '2026-10-28T00:00:00+00:00',
    items: [
      { itemId: 'train_1', kcId: 'kc.x', split: 'train', difficulty: 2, seenBefore: false },
      { itemId: 'transfer_1', kcId: 'kc.x', split: 'transfer', difficulty: 3, seenBefore: false },
    ],
  })
  assert.throws(() => service.registerDataset(altered), ConflictError)
})

test('step16: run records separated channels and dedupes', () => {
  const service = new InMemoryEvaluationService()
  service.registerDataset(frozenSet())
  const simulated = [{ itemId: 'train_1', predictedCorrect: 0.8 }]
  const real = [
    createRealOutcome({
      itemId: 'transfer_1',
      correct: true,
      source: 'trusted_grader',
      occurredAt: '2026-10-27T10:00:00+00:00',
      independent: true,
    }),
  ]
  const first = service.run('eval_demo', {
    idempotencyKey: 'run-1',
    simulatedOutcomes: simulated,
    realOutcomes: real,
  })
  const second = service.run('eval_demo', {
    idempotencyKey: 'run-1',
    simulatedOutcomes: simulated,
    realOutcomes: real,
  })
  assert.equal(first.runId, second.runId)
  assert.ok(Math.abs(first.simulated!.meanPredictedCorrect - 0.8) < 1e-9)
  assert.ok(Math.abs(first.realTransfer!.transferAccuracy - 1.0) < 1e-9)
  assert.equal(service.getRun(first.runId).datasetId, 'eval_demo')
})

test('step16: run idempotency conflict on different inputs', () => {
  const service = new InMemoryEvaluationService()
  service.registerDataset(frozenSet())
  service.run('eval_demo', {
    idempotencyKey: 'run-1',
    simulatedOutcomes: [{ itemId: 'train_1', predictedCorrect: 0.8 }],
  })
  assert.throws(
    () =>
      service.run('eval_demo', {
        idempotencyKey: 'run-1',
        simulatedOutcomes: [{ itemId: 'train_1', predictedCorrect: 0.1 }],
      }),
    IdempotencyConflictError,
  )
})

test('step16: simulated outcome cannot touch transfer', () => {
  const service = new InMemoryEvaluationService()
  service.registerDataset(frozenSet())
  assert.throws(
    () =>
      service.run('eval_demo', {
        idempotencyKey: 'run-bad',
        simulatedOutcomes: [{ itemId: 'transfer_1', predictedCorrect: 0.9 }],
      }),
    SplitIsolationError,
  )
})

test('step16: simulated source cannot feed the real channel', () => {
  assert.throws(
    () =>
      createRealOutcome({
        itemId: 'transfer_1',
        correct: true,
        source: 'simulated',
        occurredAt: '2026-10-27T10:00:00+00:00',
        independent: true,
      }),
    SelfProofError,
  )
})

test('step16: absent real evidence is reported as absent', () => {
  const service = new InMemoryEvaluationService()
  service.registerDataset(frozenSet())
  const run = service.run('eval_demo', {
    idempotencyKey: 'run-sim-only',
    simulatedOutcomes: [{ itemId: 'train_1', predictedCorrect: 0.9 }],
  })
  assert.equal(run.realTransfer, null)
  assert.ok(run.claim.includes('no real transfer evidence'))
})

test('step16: file evaluation service persists', () => {
  withTempDir((root) => {
    const service = new FileEvaluationService(root)
    service.registerDataset(frozenSet())
    const run = service.run('eval_demo', {
      idempotencyKey: 'run-file',
      simulatedOutcomes: [{ itemId: 'train_1', predictedCorrect: 0.6 }],
    })
    const reopened = new FileEvaluationService(root)
    assert.equal(reopened.getDataset('eval_demo').digest, frozenSet().digest)
    assert.equal(reopened.getRun(run.runId).runId, run.runId)
  })
})

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('step16: normal transitions match spec', () => {
  assert.deepEqual(
    [...TRANSITIONS[STATE_PROGRESS_CHECK]].sort(),
    [STATE_NEED_CLARIFICATION, STATE_STATE_LOAD].sort(),
  )
  assert.deepEqual(
    [...TRANSITIONS[STATE_STATE_LOAD]].sort(),
    [STATE_DIAGNOSE, STATE_RECALL_SCHEDULE, STATE_PREVIEW_PLANNER].sort(),
  )
  assert.deepEqual(
    [...TRANSITIONS[STATE_CURRICULUM_GATE]].sort(),
    [STATE_EXERCISE_EVOLUTION, STATE_CONTENT_VALIDATION].sort(),
  )
  assert.deepEqual(TRANSITIONS[STATE_COMPLETED], [])
})

test('step16: illegal transition is rejected', () => {
  const machine = new HarnessStateMachine('student.a')
  assert.throws(
    () => machine.advance(STATE_DELIVER, { reason: 'skip' }),
    InvalidTransitionError,
  )
  assert.equal(machine.state, STATE_INTAKE)
})

test('step16: terminal state is fail-closed', () => {
  const machine = machineAt([
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
    STATE_RECALL_SCHEDULE,
    STATE_EXERCISE_EVOLUTION,
    STATE_SIMULATION_LAB,
    STATE_CANDIDATE_RANKING,
    STATE_CURRICULUM_GATE,
    STATE_CONTENT_VALIDATION,
    STATE_DELIVER,
    STATE_AWAIT_STUDENT,
    STATE_ASSESS,
    STATE_STATE_COMMIT,
    STATE_REVIEW_RESCHEDULE,
    STATE_COMPLETED,
  ])
  assert.equal(machine.isTerminal, true)
  assert.deepEqual(machine.allowedNext(), [])
  assert.throws(
    () => machine.advance(STATE_FAILED, { reason: 'late' }),
    StateMachineError,
  )
})

test('step16: idempotent advance', () => {
  const machine = new HarnessStateMachine('student.a')
  const first = machine.advance(STATE_EVIDENCE_PARSE, {
    reason: 'intake',
    idempotencyKey: 't1',
  })
  const second = machine.advance(STATE_EVIDENCE_PARSE, {
    reason: 'retry',
    idempotencyKey: 't1',
  })
  assert.deepEqual(first, second)
  assert.equal(machine.history.length, 1)
  assert.throws(
    () =>
      machine.advance(STATE_PROGRESS_CHECK, {
        reason: 'retry',
        idempotencyKey: 't1',
      }),
    IdempotencyConflictError,
  )
})

test('step16: snapshot has no student content', () => {
  const machine = new HarnessStateMachine('student.a', { sessionId: 'sess-1' })
  machine.advance(STATE_EVIDENCE_PARSE, { reason: 'intake' })
  const snapshot = machine.snapshot()
  assert.equal(snapshot.state, STATE_EVIDENCE_PARSE)
  assert.equal(snapshot.transitions[0].reason, 'intake')
  assert.ok(!JSON.stringify(snapshot).includes('answer'))
})

test('step16: rejection bound fails closed', () => {
  const machine = new HarnessStateMachine('student.a', { maxRejections: 3 })
  for (const step of [
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
    STATE_RECALL_SCHEDULE,
    STATE_EXERCISE_EVOLUTION,
    STATE_SIMULATION_LAB,
    STATE_CANDIDATE_RANKING,
    STATE_CURRICULUM_GATE,
  ]) {
    machine.advance(step, { reason: 'setup' })
  }
  for (let index = 0; index < 3; index += 1) {
    machine.registerRejection({
      code: BRANCH_CURRICULUM_GATE_REJECTED,
      reason: 'rework',
    })
    machine.advance(STATE_SIMULATION_LAB, { reason: 'rework' })
    machine.advance(STATE_CANDIDATE_RANKING, { reason: 'rework' })
    machine.advance(STATE_CURRICULUM_GATE, { reason: 'rework' })
  }
  const record = machine.registerRejection({
    code: BRANCH_CURRICULUM_GATE_REJECTED,
    reason: 'rework',
  })
  assert.equal(machine.rejections, 4)
  assert.equal(machine.state, STATE_FAILED)
  assert.equal(record.toState, STATE_FAILED)
})

test('step16: default rejection bound', () => {
  assert.equal(DEFAULT_MAX_REJECTIONS, 3)
  const machine = new HarnessStateMachine('student.a', { maxRejections: 1 })
  for (const step of [
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
    STATE_RECALL_SCHEDULE,
    STATE_EXERCISE_EVOLUTION,
    STATE_SIMULATION_LAB,
    STATE_CANDIDATE_RANKING,
    STATE_CURRICULUM_GATE,
  ]) {
    machine.advance(step, { reason: 'setup' })
  }
  machine.registerRejection()
  machine.advance(STATE_SIMULATION_LAB, { reason: 'rework' })
  machine.advance(STATE_CANDIDATE_RANKING, { reason: 'rework' })
  machine.advance(STATE_CURRICULUM_GATE, { reason: 'rework' })
  machine.registerRejection()
  assert.equal(machine.state, STATE_FAILED)
})

test('step16: exception branches reroute', () => {
  const ocr = machineAt([STATE_EVIDENCE_PARSE])
  ocr.handleException(BRANCH_OCR_UNCERTAIN)
  assert.equal(ocr.state, STATE_NEED_CLARIFICATION)

  const progress = machineAt([STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK])
  progress.handleException(BRANCH_SCHOOL_PROGRESS_UNCLEAR)
  assert.equal(progress.state, STATE_NEED_CLARIFICATION)

  const probe = machineAt([
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
    STATE_DIAGNOSE,
    STATE_HYPOTHESIS_UPDATE,
  ])
  probe.handleException(BRANCH_HYPOTHESES_ALL_MISMATCHED)
  assert.equal(probe.state, STATE_PROBE)

  const lab = machineAt([
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
    STATE_RECALL_SCHEDULE,
    STATE_EXERCISE_EVOLUTION,
    STATE_SIMULATION_LAB,
  ])
  lab.handleException(BRANCH_SIMULATION_TIMEOUT)
  assert.equal(lab.state, STATE_CANDIDATE_RANKING)

  const load = machineAt([
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
  ])
  load.handleException(BRANCH_SPARSE_MEMORY_DATA)
  assert.equal(load.state, STATE_RECALL_SCHEDULE)

  const refusal = machineAt([
    STATE_EVIDENCE_PARSE,
    STATE_PROGRESS_CHECK,
    STATE_STATE_LOAD,
    STATE_DIAGNOSE,
  ])
  refusal.handleException(BRANCH_STUDENT_REFUSES_DIAGNOSIS)
  assert.equal(refusal.state, STATE_ABORTED)
})

test('step16: degrade-in-place branches do not move', () => {
  const machine = machineAt([STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK])
  for (const code of [
    BRANCH_RAG_SOURCE_MISSING,
    BRANCH_LOW_CONFIDENCE_STRATEGY,
    BRANCH_ABNORMAL_PRESSURE,
  ]) {
    const branch = machine.handleException(code)
    assert.equal(branch.targetState, '')
    assert.equal(machine.state, STATE_PROGRESS_CHECK)
  }
  assert.equal(machine.snapshot().degraded.length, 3)
})

test('step16: unknown exception branch is rejected', () => {
  const machine = new HarnessStateMachine('student.a')
  assert.throws(() => machine.handleException('not_a_branch'), ValidationError)
})

test('step16: every exception branch is described', () => {
  for (const branch of Object.values(EXCEPTION_BRANCHES)) {
    assert.ok(branch.degradedMode.length > 0)
    assert.ok(branch.description.length > 0)
    assert.ok(branch.targetState === '' || branch.targetState in TRANSITIONS)
  }
})

test('step16: all spec states are known', () => {
  const expected = new Set([
    'Intake',
    'EvidenceParse',
    'ProgressCheck',
    'NeedClarification',
    'StateLoad',
    'Diagnose',
    'HypothesisUpdate',
    'Probe',
    'AwaitStudent',
    'ExerciseEvolution',
    'RecallSchedule',
    'PreviewPlanner',
    'SimulationLab',
    'CandidateRanking',
    'CurriculumGate',
    'ContentValidation',
    'Deliver',
    'Assess',
    'StateCommit',
    'ReviewReschedule',
    'Completed',
    'Failed',
    'Aborted',
  ])
  assert.deepEqual(new Set(Object.keys(TRANSITIONS)), expected)
})

test('step16: event catalogue contains section 22 events', () => {
  assert.ok(EVENT_TYPES.includes(EVENT_INDEPENDENT_ATTEMPT))
  assert.ok(EVENT_TYPES.includes(EVENT_REVIEW_COMPLETED))
  assert.ok(EVENT_TYPES.includes(EVENT_SIMULATION_STARTED))
  assert.equal(EVENT_TYPES.length, 39)
})

test('step16: service error hierarchy', () => {
  assert.ok(new OptimisticConcurrencyError('x') instanceof ConflictError)
  assert.ok(new IdempotencyConflictError('x') instanceof ConflictError)
  assert.ok(new InvalidTransitionError('x') instanceof StateMachineError)
  assert.ok(new ServiceError('x') instanceof Error)
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
})
