/**
 * Step 9 tests: KC graph, versioned item bank, local RAG, and gate-bound
 * retrieval through `HostContext`.
 *
 * Every id, annotation, and learner is synthetic. The shared JSON fixture is
 * also consumed by `tests/test_curriculum_graph.py`, so the Python and
 * TypeScript implementations are checked against the same hash, closure,
 * ordering, scores, candidates, and rejection reasons.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  GraphValidationError,
  ItemBank,
  ItemNotFoundError,
  ItemValidationError,
  KnowledgeGraph,
  KnowledgeGraphStore,
  ReviewTransitionError,
  UnknownKnowledgeComponent,
  contentHash,
  missingAnnotationFields,
  normalizeRetrievalQuery,
  planRetrieval,
  prerequisiteDiagnostics,
  type ItemAnnotationInput,
  type KnowledgeGraphInput,
  type RetrievalHit,
  type RetrievalQueryInput,
} from '../src/core/curriculum-graph.ts'
import {
  createEducationService,
  type HostContext,
} from '../src/service.ts'
import { allow } from '../src/core/curriculum-gate.ts'
import { MemoryHostContext } from '../src/host/host-context.ts'
import { ConsentSnapshot } from '../src/host/consent.ts'
import type { LearnerProgress } from '../src/domain.ts'

const FIXTURE = new URL(
  '../../tests/fixtures/curriculum_step9.json',
  import.meta.url,
)

interface Fixture {
  readonly graph: KnowledgeGraphInput
  readonly items: readonly {
    readonly itemId: string
    readonly reviewStatus: string
    readonly annotation: ItemAnnotationInput
  }[]
  readonly progress: {
    readonly studentId: string
    readonly gradeLevel: number
    readonly taughtKcs: readonly string[]
    readonly inProgressKcs: readonly string[]
    readonly confirmedPreviewKcs: readonly string[]
    readonly confirmedPriorKcs: readonly string[]
    readonly progressConfidence: number
    readonly currentLoad: number
    readonly loadBudget: number
    readonly extensionMode: boolean
  }
  readonly mode: string
  readonly query: RetrievalQueryInput
  readonly expected: {
    readonly graphHash: string
    readonly prerequisiteClosure: Readonly<Record<string, readonly string[]>>
    readonly topologicalOrder: readonly string[]
    readonly hasCycle: boolean
    readonly hitOrder: readonly string[]
    readonly hitScores: Readonly<Record<string, number>>
    readonly candidates: readonly string[]
    readonly rejected: Readonly<Record<string, readonly string[]>>
  }
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

function completeAnnotation(
  overrides: ItemAnnotationInput = {},
): ItemAnnotationInput {
  return {
    source: 'synthetic.bank',
    license: 'synthetic-only',
    stage: 'secondary',
    course: 'synthetic.mathematics',
    gradeLevel: 8,
    curriculumNodeIds: ['kc.quadratic.formula'],
    requiredKcs: ['kc.quadratic.formula'],
    qMatrix: [{ kcId: 'kc.quadratic.formula', confidence: 0.95 }],
    difficulty: 0.5,
    itemType: 'short_answer',
    estimatedMinutes: 5,
    verifierType: 'deterministic',
    safetyChecked: true,
    contentVerified: true,
    correctnessVerified: true,
    annotationConfidence: 0.95,
    cognitiveLoad: 0.2,
    ...overrides,
  }
}

function makeProgress(
  overrides: Partial<LearnerProgress> = {},
): LearnerProgress {
  return {
    studentRef: 'synthetic.student.step9',
    gradeLevel: 8,
    taughtKcs: [
      'kc.quadratic.formula',
      'kc.algebra.square_root',
      'kc.arith.square_root',
      'kc.advanced.quadratic',
    ],
    progressConfidence: 0.95,
    currentLoad: 0,
    loadBudget: 1,
    ...overrides,
  }
}

function makeGraph(): KnowledgeGraph {
  return new KnowledgeGraph({
    version: 1,
    nodes: [
      { nodeId: 'kc.arith.square_root' },
      { nodeId: 'kc.algebra.square_root' },
      { nodeId: 'kc.quadratic.formula' },
      { nodeId: 'kc.advanced.quadratic' },
      { nodeId: 'kc.calculus.derivative' },
    ],
    edges: [
      {
        sourceId: 'kc.algebra.square_root',
        targetId: 'kc.arith.square_root',
      },
      {
        sourceId: 'kc.quadratic.formula',
        targetId: 'kc.algebra.square_root',
      },
      {
        sourceId: 'kc.calculus.derivative',
        targetId: 'kc.quadratic.formula',
      },
      {
        sourceId: 'kc.advanced.quadratic',
        targetId: 'kc.calculus.derivative',
      },
    ],
  })
}

function approve(
  bank: ItemBank,
  itemId: string,
  annotation: ItemAnnotationInput,
): void {
  bank.addItem(itemId, annotation)
  bank.submitForReview(itemId, 'reviewer.synthetic.1', {
    submittedAt: '2026-03-01T00:00:00.000Z',
  })
  bank.review(itemId, 'approve', 'reviewer.synthetic.1', {
    reviewedAt: '2026-03-01T00:00:01.000Z',
  })
}

function bankFromFixture(data: Fixture): ItemBank {
  const bank = new ItemBank()
  for (const entry of data.items) {
    const approved = entry.reviewStatus === 'approved'
    bank.addItem(entry.itemId, entry.annotation, {
      reviewStatus: approved ? 'draft' : entry.reviewStatus,
    })
    if (approved) {
      bank.submitForReview(entry.itemId, 'reviewer.synthetic.1', {
        submittedAt: '2026-03-01T00:00:00.000Z',
      })
      bank.review(entry.itemId, 'approve', 'reviewer.synthetic.1', {
        reviewedAt: '2026-03-01T00:00:01.000Z',
      })
    }
  }
  return bank
}

function progressFromFixture(data: Fixture): LearnerProgress {
  const p = data.progress
  return {
    studentRef: p.studentId,
    gradeLevel: p.gradeLevel,
    taughtKcs: p.taughtKcs,
    inProgressKcs: p.inProgressKcs,
    confirmedPreviewKcs: p.confirmedPreviewKcs,
    confirmedPriorKcs: p.confirmedPriorKcs,
    progressConfidence: p.progressConfidence,
    currentLoad: p.currentLoad,
    loadBudget: p.loadBudget,
    extensionMode: p.extensionMode,
  }
}

test('graph prerequisite closure is transitive and unknown KCs fail closed', () => {
  const graph = makeGraph()
  assert.deepEqual(
    [...graph.prerequisiteClosure('kc.advanced.quadratic')].sort(),
    [
      'kc.algebra.square_root',
      'kc.arith.square_root',
      'kc.calculus.derivative',
      'kc.quadratic.formula',
    ],
  )
  assert.deepEqual(
    graph.prerequisitesOf('kc.quadratic.formula'),
    ['kc.algebra.square_root'],
  )
  assert.throws(
    () => graph.prerequisiteClosure('kc.not.in.graph'),
    UnknownKnowledgeComponent,
  )
})

test('topological order puts prerequisites before dependants', () => {
  const order = makeGraph().topologicalOrder()
  assert.ok(
    order.indexOf('kc.arith.square_root') <
      order.indexOf('kc.algebra.square_root'),
  )
  assert.ok(
    order.indexOf('kc.algebra.square_root') <
      order.indexOf('kc.quadratic.formula'),
  )
  assert.ok(
    order.indexOf('kc.quadratic.formula') <
      order.indexOf('kc.calculus.derivative'),
  )
})

test('cycles, self loops, unknown endpoints, duplicates and bad relations are rejected', () => {
  assert.throws(
    () =>
      new KnowledgeGraph({
        version: 1,
        nodes: [{ nodeId: 'kc.a' }, { nodeId: 'kc.b' }],
        edges: [
          { sourceId: 'kc.a', targetId: 'kc.b' },
          { sourceId: 'kc.b', targetId: 'kc.a' },
        ],
      }),
    GraphValidationError,
  )
  assert.throws(
    () =>
      new KnowledgeGraph({
        version: 1,
        nodes: [{ nodeId: 'kc.a' }],
        edges: [{ sourceId: 'kc.a', targetId: 'kc.a' }],
      }),
    GraphValidationError,
  )
  assert.throws(
    () =>
      new KnowledgeGraph({
        version: 1,
        nodes: [{ nodeId: 'kc.a' }],
        edges: [{ sourceId: 'kc.a', targetId: 'kc.missing' }],
      }),
    GraphValidationError,
  )
  assert.throws(
    () =>
      new KnowledgeGraph({
        version: 1,
        nodes: [{ nodeId: 'kc.a' }, { nodeId: 'kc.a' }],
      }),
    GraphValidationError,
  )
  assert.throws(
    () =>
      new KnowledgeGraph({
        version: 1,
        nodes: [{ nodeId: 'kc.a' }, { nodeId: 'kc.b' }],
        edges: [
          { sourceId: 'kc.a', targetId: 'kc.b' },
          { sourceId: 'kc.a', targetId: 'kc.b' },
        ],
      }),
    GraphValidationError,
  )
  assert.throws(
    () =>
      new KnowledgeGraph({
        version: 1,
        nodes: [{ nodeId: 'kc.a' }, { nodeId: 'kc.b' }],
        edges: [
          {
            sourceId: 'kc.a',
            targetId: 'kc.b',
            relation: 'UNKNOWN' as never,
          },
        ],
      }),
    GraphValidationError,
  )
})

test('proposed edges are retained but never authoritative prerequisites', () => {
  const graph = new KnowledgeGraph({
    version: 1,
    nodes: [{ nodeId: 'kc.a' }, { nodeId: 'kc.b' }],
    edges: [
      {
        sourceId: 'kc.a',
        targetId: 'kc.b',
        relation: 'REQUIRES',
        status: 'proposed',
        confidence: 0.4,
      },
    ],
  })
  assert.deepEqual([...graph.prerequisiteClosure('kc.a')], [])
  assert.equal(graph.hasCycle(), false)

  const proposedCycle = new KnowledgeGraph({
    version: 1,
    nodes: [{ nodeId: 'kc.a' }, { nodeId: 'kc.b' }],
    edges: [
      { sourceId: 'kc.a', targetId: 'kc.b', status: 'proposed' },
      { sourceId: 'kc.b', targetId: 'kc.a', status: 'proposed' },
    ],
  })
  assert.equal(proposedCycle.hasCycle(), false)
  assert.equal(proposedCycle.hasCycle('REQUIRES', false), true)
})

test('graph versions are append-only, hashed, and diffable', () => {
  const first = makeGraph()
  const store = new KnowledgeGraphStore([first])
  const second = store.addVersion(
    [...first.nodes, { nodeId: 'kc.quadratic.graph' }],
    [
      ...first.edges,
      {
        sourceId: 'kc.quadratic.graph',
        targetId: 'kc.quadratic.formula',
      },
    ],
  )
  assert.deepEqual(store.versions(), [1, 2])
  assert.equal(store.latest().version, 2)
  assert.notEqual(first.contentHash, second.contentHash)
  assert.deepEqual(store.diff(1, 2).addedNodes, ['kc.quadratic.graph'])
  assert.deepEqual(store.diff(1, 2).addedEdges, [
    'kc.quadratic.graph|REQUIRES|kc.quadratic.formula',
  ])
  assert.throws(() => store.add(first), GraphValidationError)
  assert.throws(
    () =>
      store.add(
        new KnowledgeGraph({ version: 1, nodes: [{ nodeId: 'kc.other' }] }),
      ),
    GraphValidationError,
  )
})

test('content hash is deterministic and canonical', () => {
  assert.equal(makeGraph().contentHash, makeGraph().contentHash)
  assert.equal(
    contentHash({ b: 1, a: [1, 2] }),
    contentHash({ a: [1, 2], b: 1 }),
  )
})

test('item revisions keep history and reset review', () => {
  const bank = new ItemBank()
  approve(bank, 'item.001', completeAnnotation())
  assert.equal(bank.current('item.001').reviewStatus, 'approved')
  const revised = bank.reviseItem(
    'item.001',
    completeAnnotation({ difficulty: 0.6, annotationConfidence: 0.9 }),
    { createdAt: '2026-03-02T00:00:00.000Z', expectedVersion: 1 },
  )
  assert.equal(revised.version, 2)
  assert.equal(revised.reviewStatus, 'draft')
  assert.deepEqual(
    revised.history.map((entry) => entry.version),
    [1, 2],
  )
  assert.notEqual(
    revised.history[0]?.contentHash,
    revised.history[1]?.contentHash,
  )
  assert.deepEqual(
    revised.reviews.map((record) => record.decision),
    ['submit', 'approve'],
  )
  assert.throws(
    () =>
      bank.reviseItem('item.001', completeAnnotation(), {
        expectedVersion: 1,
      }),
    ReviewTransitionError,
  )
})

test('review transitions and review ledger are enforced', () => {
  const bank = new ItemBank()
  bank.addItem('item.001', completeAnnotation())
  assert.throws(
    () => bank.review('item.001', 'approve', 'reviewer.synthetic.1'),
    ReviewTransitionError,
  )
  bank.submitForReview('item.001', 'reviewer.synthetic.1')
  const approved = bank.review(
    'item.001',
    'approve',
    'reviewer.synthetic.1',
  )
  assert.equal(approved.reviewStatus, 'approved')
  assert.equal(approved.reviews.at(-1)?.decision, 'approve')
  assert.throws(
    () => bank.review('item.001', 'approve', 'reviewer.synthetic.1'),
    ReviewTransitionError,
  )
})

test('approval rejects missing annotations; missing/low confidence fail the gate', () => {
  const bank = new ItemBank()
  bank.addItem('item.incomplete', {
    source: '',
    license: '',
    requiredKcs: ['kc.quadratic.formula'],
  })
  const incomplete = bank.toCurriculumItem('item.incomplete')
  assert.equal(incomplete.annotationsComplete, false)
  assert.deepEqual(
    missingAnnotationFields(bank.current('item.incomplete').annotation),
    [
      'source',
      'license',
      'grade_level',
      'curriculum_node_ids',
      'q_matrix',
      'difficulty',
      'item_type',
      'estimated_minutes',
      'verifier_type',
      'safety_checked',
      'content_verified',
      'correctness_verified',
      'annotation_confidence',
    ],
  )
  const incompleteDecision = allow(incomplete, makeProgress(), 'learn')
  assert.equal(incompleteDecision.allowed, false)
  assert.ok(incompleteDecision.reasons.includes('incomplete_annotations'))
  bank.submitForReview('item.incomplete', 'reviewer.synthetic.1')
  assert.throws(
    () => bank.review('item.incomplete', 'approve', 'reviewer.synthetic.1'),
    ItemValidationError,
  )

  approve(
    bank,
    'item.low',
    completeAnnotation({ annotationConfidence: 0.2 }),
  )
  const low = bank.toCurriculumItem('item.low')
  assert.equal(low.annotationConfidence, 0.2)
  const lowDecision = allow(low, makeProgress(), 'learn')
  assert.equal(lowDecision.allowed, false)
  assert.ok(lowDecision.reasons.includes('low_annotation_confidence'))
})

test('retrieval filters by KC, difficulty and item type and returns summaries only', () => {
  const bank = new ItemBank()
  approve(bank, 'item.formula', completeAnnotation())
  approve(
    bank,
    'item.algebra',
    completeAnnotation({
      requiredKcs: ['kc.algebra.square_root'],
      curriculumNodeIds: ['kc.algebra.square_root'],
      qMatrix: [{ kcId: 'kc.algebra.square_root', confidence: 0.9 }],
      difficulty: 0.35,
    }),
  )
  approve(
    bank,
    'item.multiple',
    completeAnnotation({ itemType: 'multiple_choice', difficulty: 0.8 }),
  )
  approve(
    bank,
    'item.low',
    completeAnnotation({ annotationConfidence: 0.2 }),
  )
  bank.addItem('item.draft', completeAnnotation(), { reviewStatus: 'draft' })

  const hits = bank.search({
    kcIds: ['kc.quadratic.formula'],
    difficultyMin: 0.4,
    difficultyMax: 0.6,
    itemTypes: ['short_answer'],
    limit: 10,
  })
  assert.deepEqual(
    hits.map((hit) => hit.itemId),
    ['item.formula', 'item.low'],
  )
  for (const hit of hits) {
    assert.equal('stem' in hit, false)
    assert.equal('answer' in hit, false)
    assert.equal('hints' in hit, false)
    assert.equal('solution' in hit, false)
  }

  assert.deepEqual(
    bank
      .search({ kcIds: ['kc.quadratic.formula'], limit: 50 })
      .map((hit) => hit.itemId),
    ['item.formula', 'item.multiple', 'item.low'],
  )
})

test('invalid retrieval queries fail closed', () => {
  assert.throws(() => normalizeRetrievalQuery({ limit: 0 }), ItemValidationError)
  assert.throws(
    () =>
      normalizeRetrievalQuery({ difficultyMin: 0.8, difficultyMax: 0.2 }),
    ItemValidationError,
  )
  assert.throws(
    () => normalizeRetrievalQuery({ itemTypes: ['essay'] }),
    ItemValidationError,
  )
})

test('retrieval plan requires the gate and transitive prerequisite closure', () => {
  const graph = makeGraph()
  const bank = new ItemBank()
  approve(bank, 'item.formula', completeAnnotation())
  approve(
    bank,
    'item.low',
    completeAnnotation({ annotationConfidence: 0.2 }),
  )
  approve(
    bank,
    'item.advanced',
    completeAnnotation({
      requiredKcs: ['kc.advanced.quadratic'],
      curriculumNodeIds: ['kc.advanced.quadratic'],
      qMatrix: [{ kcId: 'kc.advanced.quadratic', confidence: 0.9 }],
    }),
  )
  const plan = planRetrieval(
    bank,
    graph,
    makeProgress(),
    'learn',
    {
      kcIds: ['kc.quadratic.formula', 'kc.advanced.quadratic'],
      itemTypes: ['short_answer'],
      limit: 10,
    },
  )
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.itemId),
    ['item.formula'],
  )
  assert.deepEqual(
    plan.rejected.find((item) => item.itemId === 'item.low')?.reasons,
    ['low_annotation_confidence'],
  )
  assert.deepEqual(
    plan.rejected.find((item) => item.itemId === 'item.advanced')?.reasons,
    ['prerequisites_not_met:kc.calculus.derivative'],
  )
})

test('unknown KC and missing graph fail closed', () => {
  const bank = new ItemBank()
  approve(
    bank,
    'item.unknown.kc',
    completeAnnotation({
      requiredKcs: ['kc.not.in.graph'],
      curriculumNodeIds: ['kc.not.in.graph'],
      qMatrix: [{ kcId: 'kc.not.in.graph', confidence: 0.9 }],
    }),
  )
  const plan = planRetrieval(
    bank,
    makeGraph(),
    makeProgress({ taughtKcs: ['kc.not.in.graph'] }),
    'learn',
    { kcIds: ['kc.not.in.graph'] },
  )
  assert.deepEqual(plan.candidates, [])
  assert.ok(
    plan.rejected[0]?.reasons.includes('kc_not_in_graph:kc.not.in.graph'),
  )

  const blocked = planRetrieval(
    bank,
    null,
    makeProgress({ taughtKcs: ['kc.not.in.graph'] }),
    'learn',
    { kcIds: ['kc.not.in.graph'] },
  )
  assert.equal(blocked.blockedReason, 'graph_unavailable')
  assert.deepEqual(blocked.candidates, [])
})

test('prerequisite diagnostics reports missing and unknown KCs', () => {
  const diagnostics = prerequisiteDiagnostics(
    makeGraph(),
    ['kc.advanced.quadratic', 'kc.not.in.graph'],
    ['kc.quadratic.formula', 'kc.algebra.square_root', 'kc.arith.square_root'],
  )
  assert.deepEqual(diagnostics.missingPrerequisites, [
    'kc.calculus.derivative',
  ])
  assert.deepEqual(diagnostics.unknownKcs, ['kc.not.in.graph'])
})

test('shared fixture matches graph hash, closure, order, scores and plan', () => {
  const data = loadFixture()
  const graph = new KnowledgeGraph(data.graph)
  const expected = data.expected
  assert.equal(graph.contentHash, expected.graphHash)
  for (const [kc, closure] of Object.entries(expected.prerequisiteClosure)) {
    assert.deepEqual([...graph.prerequisiteClosure(kc)].sort(), closure)
  }
  assert.deepEqual([...graph.topologicalOrder()], expected.topologicalOrder)
  assert.equal(graph.hasCycle(), expected.hasCycle)

  const bank = bankFromFixture(data)
  const plan = planRetrieval(
    bank,
    graph,
    progressFromFixture(data),
    data.mode,
    data.query,
  )
  assert.deepEqual(
    plan.hits.map((hit) => hit.itemId),
    expected.hitOrder,
  )
  assert.deepEqual(
    Object.fromEntries(plan.hits.map((hit) => [hit.itemId, hit.score])),
    expected.hitScores,
  )
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.itemId),
    expected.candidates,
  )
  assert.deepEqual(
    Object.fromEntries(
      plan.rejected.map((item) => [item.itemId, [...item.reasons]]),
    ),
    expected.rejected,
  )
})

test('MemoryHostContext resolves the tenant graph/bank and service gates hits', () => {
  const data = loadFixture()
  const graph = new KnowledgeGraph(data.graph)
  const bank = bankFromFixture(data)
  const progress = progressFromFixture(data)
  const host = new MemoryHostContext({
    session: {
      sessionId: 'session.synthetic.step9',
      tenantId: 'tenant.synthetic.step9',
      studentRef: progress.studentRef,
    },
    consent: ConsentSnapshot.granted(['curriculum:read']),
    progress: [progress],
    catalog: [],
    itemBank: bank,
    graph,
  })
  assert.equal(host.resolveGraph()?.version, 3)
  assert.equal(host.retrieveItems(normalizeRetrievalQuery(data.query)).length, 3)
  assert.equal(host.resolveItem('item.quadratic.formula.001')?.itemId, 'item.quadratic.formula.001')

  const service = createEducationService({}, host)
  const plan = service.retrieveCandidatesFor(
    progress.studentRef,
    data.query,
    'learn',
  )
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.itemId),
    ['item.quadratic.formula.001'],
  )
  assert.deepEqual(
    Object.fromEntries(
      plan.rejected.map((item) => [item.itemId, [...item.reasons]]),
    ),
    {
      'item.advanced.quadratic.001': [
        'prerequisites_not_met:kc.calculus.derivative',
      ],
      'item.low.confidence.001': ['low_annotation_confidence'],
    },
  )

  // The loader copies plain data properties; the explicit binding must keep
  // graph/retrieval closures working (consent revocation included).
  const bound = createEducationService({}, host.toHostBinding())
  assert.deepEqual(
    bound
      .retrieveCandidatesFor(progress.studentRef, data.query, 'learn')
      .candidates.map((candidate) => candidate.itemId),
    ['item.quadratic.formula.001'],
  )
})

test('service fails closed without a graph or after consent revocation', () => {
  const data = loadFixture()
  const bank = bankFromFixture(data)
  const progress = progressFromFixture(data)
  const noGraph = new MemoryHostContext({
    session: {
      sessionId: 'session.synthetic.no-graph',
      tenantId: 'tenant.synthetic.step9',
      studentRef: progress.studentRef,
    },
    consent: ConsentSnapshot.granted(['curriculum:read']),
    progress: [progress],
    catalog: [],
    itemBank: bank,
  })
  const blocked = createEducationService({}, noGraph).retrieveCandidatesFor(
    progress.studentRef,
    data.query,
    'learn',
  )
  assert.equal(blocked.blockedReason, 'graph_unavailable')
  assert.deepEqual(blocked.candidates, [])

  const consent = ConsentSnapshot.granted(['curriculum:read'])
  const host = new MemoryHostContext({
    session: {
      sessionId: 'session.synthetic.revoke',
      tenantId: 'tenant.synthetic.step9',
      studentRef: progress.studentRef,
    },
    consent,
    progress: [progress],
    catalog: [],
    itemBank: bank,
    graph: new KnowledgeGraph(data.graph),
  })
  consent.revoke('curriculum:read', '2026-03-03T00:00:00.000Z')
  assert.equal(host.resolveGraph(), undefined)
  assert.deepEqual(host.retrieveItems(normalizeRetrievalQuery(data.query)), [])
  assert.equal(host.resolveItem('item.quadratic.formula.001'), undefined)
  assert.equal(
    createEducationService({}, host).retrieveCandidatesFor(
      progress.studentRef,
      data.query,
      'learn',
    ).blockedReason,
    'progress_unavailable',
  )
})

test('unknown item ids in a retrieval hit are rejected rather than delivered', () => {
  const data = loadFixture()
  const graph = new KnowledgeGraph(data.graph)
  const progress = progressFromFixture(data)
  const hit: RetrievalHit = {
    itemId: 'item.hit.without.catalog.entry',
    score: 1,
    requiredKcs: ['kc.quadratic.formula'],
    qMatrixKcs: ['kc.quadratic.formula'],
    difficulty: 0.5,
    itemType: 'short_answer',
    annotationConfidence: 0.95,
    reviewStatus: 'approved',
    version: 1,
    estimatedMinutes: 5,
    gradeLevel: 8,
  }
  const host: HostContext = {
    authorizedStudentRef: progress.studentRef,
    resolveProgress: () => progress,
    resolveItem: () => undefined,
    resolveGraph: () => graph,
    retrieveItems: () => [hit],
  }
  const service = createEducationService({}, host)
  // A host adapter that returns an id with no catalog entry cannot cause a
  // candidate: the service re-resolves every hit.
  const plan = service.retrieveCandidatesFor(
    progress.studentRef,
    data.query,
    'learn',
  )
  assert.deepEqual(plan.hits, [hit])
  assert.deepEqual(plan.candidates, [])
  assert.deepEqual(plan.rejected, [
    { itemId: hit.itemId, reasons: ['item_not_found'] },
  ])
})

test('item bank unknown ids raise instead of returning an empty item', () => {
  const bank = new ItemBank()
  assert.throws(() => bank.current('item.unknown'), ItemNotFoundError)
  approve(bank, 'item.001', completeAnnotation())
  assert.throws(() => bank.getVersion('item.001', 9), ItemNotFoundError)
})
