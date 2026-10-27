/**
 * Offline contract tests for the dsh plugin skeleton.
 *
 * These are not a substitute for dsh runtime contract tests. They pin the
 * Step 1 invariants that must survive the TypeScript mapping and use only
 * synthetic references.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply as applyPlugin,
  createEducationService,
  permissions as pluginPermissions,
} from '../src/index.ts'
import { allow, allowedKcs } from '../src/core/curriculum-gate.ts'
import {
  StudentTwin,
  SimulatedEventRejected,
  UnknownEventSource,
} from '../src/core/twin.ts'
import {
  createMemoryState,
  intervalForTarget,
  isIndependentRetrievalSuccess,
  retrievability,
  updateMemory,
} from '../src/core/memory.ts'
import { HypothesisSet } from '../src/core/hypothesis.ts'
import {
  scoreCandidate,
  selectProbe,
  type DiagnosticCandidate,
} from '../src/core/diagnosis.ts'
import {
  InterventionNotDeliverable,
  deliver,
  packageFromInput,
  validatePackage,
} from '../src/core/exercise.ts'
import {
  assertMinimalPermissions,
  PermissionDeniedError,
  permissionSummary,
} from '../src/permissions.ts'
import type { Context, ToolDefinition } from '../src/dsh.ts'
import type {
  CurriculumItem,
  LearnerProgress,
} from '../src/domain.ts'
import type { HostContext } from '../src/service.ts'

const STUDENT_REF = 'synthetic.student.001'

const progress: LearnerProgress = {
  studentRef: STUDENT_REF,
  gradeLevel: 5,
  taughtKcs: ['kc.fraction.add'],
  inProgressKcs: ['kc.fraction.equiv'],
  confirmedPreviewKcs: ['kc.fraction.compare'],
  confirmedPriorKcs: ['kc.place.value'],
  progressConfidence: 0.95,
  currentLoad: 0.1,
  loadBudget: 1,
}

const item: CurriculumItem = {
  itemId: 'item.fraction.add.001',
  requiredKcs: ['kc.fraction.add'],
  gradeLevel: 5,
  safetyChecked: true,
  contentVerified: true,
  annotationConfidence: 0.95,
  futureMethods: [],
  cognitiveLoad: 0.2,
  role: 'training',
  seenBefore: false,
}

const transferItem: CurriculumItem = {
  ...item,
  itemId: 'item.fraction.add.transfer.001',
  role: 'transfer',
}

const blockedItem: CurriculumItem = {
  ...item,
  itemId: 'item.blocked.001',
  requiredKcs: ['kc.fraction.multiply'],
}

function makeHost(): HostContext {
  const catalog = new Map<string, CurriculumItem>([
    [item.itemId, item],
    [transferItem.itemId, transferItem],
    [blockedItem.itemId, blockedItem],
  ])
  return {
    authorizedStudentRef: STUDENT_REF,
    resolveProgress(studentRef) {
      return studentRef === STUDENT_REF ? progress : undefined
    },
    resolveItem(itemId) {
      return catalog.get(itemId)
    },
  }
}

function packageInput(overrides: Record<string, unknown> = {}) {
  return packageFromInput({
    packageId: 'pkg.001',
    objectiveId: 'obj.fraction.add',
    trainingItems: [item],
    transferItems: [transferItem],
    hintLadder: ['nudge', 'worked-step'],
    feedbackTemplates: { correct: 'keep going' },
    explanationResources: ['res.001'],
    completionCriteria: { independentCorrect: 2 },
    requiredKcs: ['kc.fraction.add'],
    independentTransfer: true,
    schoolMode: 'learn',
    ...overrides,
  })
}

test('gate rejects untaught, future-method, low-confidence, and unknown-mode items', () => {
  const untaught = allow(
    { ...item, requiredKcs: ['kc.fraction.multiply'] },
    progress,
    'learn',
  )
  assert.equal(untaught.allowed, false)
  assert.ok(untaught.reasons.some((reason) => reason.startsWith('kcs_not_allowed:')))

  const future = allow(
    { ...item, futureMethods: ['cross-multiplication'] },
    progress,
    'learn',
  )
  assert.equal(future.allowed, false)
  assert.ok(future.reasons.includes('unapproved_future_method'))

  const missingConfidence = allow(
    { ...item, annotationConfidence: null },
    progress,
    'learn',
  )
  assert.equal(missingConfidence.allowed, false)
  assert.ok(missingConfidence.reasons.includes('missing_annotation_confidence'))

  const unknownMode = allow(item, progress, 'practice')
  assert.equal(unknownMode.allowed, false)
  assert.ok(unknownMode.reasons.includes('unknown_mode:practice'))
})

test('unconfirmed progress locks preview KCs and a missing budget fails closed', () => {
  const previewItem = {
    ...item,
    itemId: 'item.preview.001',
    requiredKcs: ['kc.fraction.compare'],
  }
  const locked = allow(
    previewItem,
    { ...progress, progressConfidence: 0.2 },
    'preview',
  )
  assert.equal(locked.allowed, false)
  assert.ok(locked.reasons.some((reason) => reason.includes('kc.fraction.compare')))

  const unlocked = allow(previewItem, progress, 'preview')
  assert.equal(unlocked.allowed, true)

  const noBudget = allow(item, { ...progress, loadBudget: undefined }, 'learn')
  assert.equal(noBudget.allowed, false)
  assert.ok(noBudget.reasons.includes('cognitive_load_exceeded'))

  assert.deepEqual([...allowedKcs(progress, 'preview')].sort(), [
    'kc.fraction.add',
    'kc.fraction.compare',
    'kc.fraction.equiv',
    'kc.place.value',
  ])
})

test('simulated events cannot write or back observed mastery', () => {
  const twin = new StudentTwin(STUDENT_REF)
  const real = twin.recordObserved({
    eventId: 'ev.real.001',
    eventType: 'attempt',
    source: 'trusted_grader',
    studentRef: STUDENT_REF,
    occurredAt: '2026-03-02T09:00:00Z',
  })
  assert.equal(real.eventId, 'ev.real.001')

  assert.throws(
    () =>
      twin.recordObserved({
        eventId: 'ev.sim.001',
        eventType: 'attempt',
        source: 'simulated',
        studentRef: STUDENT_REF,
      }),
    SimulatedEventRejected,
  )
  assert.throws(
    () =>
      twin.recordObserved({
        eventId: 'ev.unknown.001',
        eventType: 'attempt',
        source: 'model_invented',
        studentRef: STUDENT_REF,
      }),
    UnknownEventSource,
  )

  const simulated = twin.recordSimulated({
    eventId: 'ev.sim.002',
    eventType: 'attempt',
    source: 'virtual_student',
    studentRef: STUDENT_REF,
  })
  assert.equal(simulated.eventId, 'ev.sim.002')

  assert.throws(
    () =>
      twin.updateMastery('kc.fraction.add', 0.8, 0.1, ['ev.sim.002']),
    /non-observed evidence/,
  )
  const estimate = twin.updateMastery(
    'kc.fraction.add',
    0.8,
    0.1,
    ['ev.real.001'],
  )
  assert.equal(estimate.masteryMean, 0.8)
  assert.throws(() => twin.promoteSimulated('ev.sim.002'), SimulatedEventRejected)
  assert.equal(twin.observed().length, 1)
  assert.equal(twin.simulated().length, 1)
})

test('twin rollback restores inferred state without deleting evidence', () => {
  const twin = new StudentTwin(STUDENT_REF)
  twin.recordObserved({
    eventId: 'ev.1',
    eventType: 'attempt',
    source: 'teacher',
    studentRef: STUDENT_REF,
  })
  twin.recordObserved({
    eventId: 'ev.2',
    eventType: 'attempt',
    source: 'student',
    studentRef: STUDENT_REF,
  })
  twin.updateMastery('kc.a', 0.4, 0.3, ['ev.1'])
  twin.updateMastery('kc.b', 0.7, 0.2, ['ev.2'])

  const rolledBack = twin.rollback(1)
  assert.equal(rolledBack.version, 1)
  assert.equal(rolledBack.knowledge.has('kc.b'), false)
  assert.equal(twin.observed().length, 2)

  twin.updateMastery('kc.a', 0.5, 0.2, ['ev.1'])
  assert.equal(twin.version, 2)
})

test('reading and hints never count as independent retrieval success', () => {
  const state = createMemoryState(STUDENT_REF, 'mem.fraction.add')
  const reading = updateMemory(state, {
    observationId: 'obs.read',
    success: true,
    kind: 'reading',
  })
  assert.equal(reading, state)

  const hinted = updateMemory(state, {
    observationId: 'obs.hint',
    success: true,
    independent: false,
    hintLevel: 2,
  })
  const independent = updateMemory(state, {
    observationId: 'obs.independent',
    success: true,
    independent: true,
    hintLevel: 0,
  })
  assert.equal(isIndependentRetrievalSuccess({
    observationId: 'obs.hint',
    success: true,
    independent: false,
    hintLevel: 2,
  }), false)
  assert.equal(independent.independentSuccessCount, 1)
  assert.equal(hinted.independentSuccessCount, 0)
  assert.ok(independent.stabilityDays > hinted.stabilityDays)
})

test('FSRS interval inverse returns the target retention', () => {
  const stability = 12
  const interval = intervalForTarget(stability, 0.9)
  assert.ok(Math.abs(retrievability(interval, stability) - 0.9) < 1e-9)
  assert.throws(() => intervalForTarget(stability, 1.2), /targetRetention/)
})

test('hypothesis weights stay normalised through spawn, reweight, and prune', () => {
  const set = new HypothesisSet([], 1)
  set.spawn({ hypothesisId: 'h.bug', weight: 0.6, bugRules: ['no_compensation'] })
  set.spawn({ hypothesisId: 'h.slip', weight: 0.4 })
  assert.ok(Math.abs(set.totalWeight() - 1) < 1e-9)

  set.reweight({ 'h.bug': 0.9, 'h.slip': 0.1 }, { noise: 0.1 })
  assert.ok(Math.abs(set.totalWeight() - 1) < 1e-9)
  assert.ok(set.unknown > 0)

  const before = set.weights()['h.bug']
  set.prune('h.bug', 'contradicted')
  assert.ok(set.unknown >= (before ?? 0) - 1e-9)
  assert.ok(Math.abs(set.totalWeight() - 1) < 1e-9)

  const split = new HypothesisSet([], 0)
  split.spawn({ hypothesisId: 'parent', weight: 1 })
  const children = split.split('parent', [
    { hypothesisId: 'child.a', weight: 0.5 },
    { hypothesisId: 'child.b', weight: 0.5 },
  ])
  assert.equal(children.length, 2)
  assert.ok(Math.abs(split.totalWeight() - 1) < 1e-9)

  const merged = split.merge(['child.a', 'child.b'], { hypothesisId: 'merged' })
  assert.equal(merged.hypothesisId, 'merged')
  assert.ok(Math.abs(split.totalWeight() - 1) < 1e-9)
})

test('diagnosis ignores gate-rejected candidates and honours a student skip', () => {
  const allowedCandidate: DiagnosticCandidate = {
    itemId: item.itemId,
    predictions: { 'h.bug': 0.9, 'h.slip': 0.2 },
    timeMinutes: 1,
    risk: 0,
    cognitiveLoad: 0.1,
    teachingValue: 0.2,
    gateAllowed: true,
    requiredKcs: ['kc.fraction.add'],
  }
  const blockedCandidate: DiagnosticCandidate = {
    ...allowedCandidate,
    itemId: blockedItem.itemId,
    predictions: { 'h.bug': 1, 'h.slip': 0 },
    gateAllowed: false,
    requiredKcs: ['kc.fraction.multiply'],
  }

  const selected = selectProbe([blockedCandidate, allowedCandidate], {
    'h.bug': 0.5,
    'h.slip': 0.5,
  })
  assert.equal(selected?.itemId, item.itemId)
  assert.equal(scoreCandidate(blockedCandidate, {}).score, Number.NEGATIVE_INFINITY)
  assert.equal(
    selectProbe([allowedCandidate], {}, { skipped: true }),
    null,
  )

  const service = createEducationService()
  const plan = service.planProbe(
    [
      {
        item,
        predictions: { 'h.bug': 0.9, 'h.slip': 0.2 },
        teachingValue: 0.2,
      },
      {
        item: blockedItem,
        predictions: { 'h.bug': 1, 'h.slip': 0 },
      },
    ],
    { 'h.bug': 0.5, 'h.slip': 0.5 },
    progress,
    'learn',
  )
  assert.equal(plan.selection?.itemId, item.itemId)
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].itemId, blockedItem.itemId)
})

test('intervention validation separates training and unseen transfer', () => {
  const pkg = packageInput()
  assert.equal(validatePackage(pkg, progress, 'learn').valid, true)

  const receipt = deliver(pkg, progress, { deliveredAt: '2026-03-02T10:00:00Z' })
  assert.equal(receipt.packageId, 'pkg.001')
  assert.equal(receipt.studentRef, STUDENT_REF)
  assert.deepEqual(receipt.itemIds, [item.itemId, transferItem.itemId])

  const leaked = packageInput({
    transferItems: [{ ...transferItem, seenBefore: true }],
  })
  const leakedValidation = validatePackage(leaked, progress, 'learn')
  assert.equal(leakedValidation.valid, false)
  assert.ok(
    leakedValidation.reasons.some((reason) =>
      reason.startsWith('transfer_item_seen_before:'),
    ),
  )
  assert.throws(
    () => deliver(leaked, progress),
    InterventionNotDeliverable,
  )

  const overlap = packageInput({
    transferItems: [{ ...item, role: 'transfer' }],
  })
  assert.equal(validatePackage(overlap, progress, 'learn').valid, false)

  const prepared = createEducationService().prepareIntervention(
    {
      packageId: leaked.packageId,
      objectiveId: leaked.objectiveId,
      trainingItems: leaked.trainingItems,
      transferItems: leaked.transferItems,
      hintLadder: leaked.hintLadder,
      completionCriteria: leaked.completionCriteria,
      requiredKcs: leaked.requiredKcs,
    },
    progress,
    'learn',
  )
  assert.equal(prepared.valid, false)
  assert.equal(prepared.notDelivered, true)
  assert.equal(prepared.requiresHostApproval, true)
})

test('default permission manifest denies raw data, network, and gate overrides', () => {
  assert.deepEqual(assertMinimalPermissions(), pluginPermissions.capabilities)
  assert.throws(
    () => assertMinimalPermissions({ studentRawData: true }),
    PermissionDeniedError,
  )
  assert.throws(
    () => assertMinimalPermissions({ network: true }),
    PermissionDeniedError,
  )
  assert.throws(
    () => assertMinimalPermissions({ observedTwinWrite: true }),
    PermissionDeniedError,
  )
  assert.throws(
    () => assertMinimalPermissions({ gateOverride: true }),
    PermissionDeniedError,
  )
  assert.throws(
    () => assertMinimalPermissions({ capabilities: ['twin:raw:read'] }),
    PermissionDeniedError,
  )
  assert.throws(
    () => assertMinimalPermissions({ more: ['network'] }),
    PermissionDeniedError,
  )
  const summary = permissionSummary()
  assert.equal((summary.denied as string[]).includes('studentRawData'), true)
})

function createTestContext(): {
  ctx: Context
  tools: Map<string, ToolDefinition>
  dispose: () => void
} {
  const tools = new Map<string, ToolDefinition>()
  const disposers: Array<() => void> = []
  const ctx: Context = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {
          tools.delete(definition.name)
        }
      },
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  return {
    ctx,
    tools,
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

test('plugin registers five reversible tools and host-resolved tools work', async () => {
  const harness = createTestContext()
  applyPlugin(harness.ctx, {
    profile: 'student-facing',
    targetRetention: 0.9,
    host: makeHost(),
  })
  assert.deepEqual([...harness.tools.keys()].sort(), [
    'aeh_check_curriculum',
    'aeh_prepare_intervention',
    'aeh_schedule_review',
    'aeh_select_probe',
    'aeh_update_hypotheses',
  ])

  const gateTool = harness.tools.get('aeh_check_curriculum')
  assert.ok(gateTool)
  const allowed = (await gateTool.execute(
    { mode: 'learn', itemId: item.itemId, studentRef: STUDENT_REF },
    {},
  )) as { allowed: boolean; policy: string }
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.policy, 'aeh.curriculum_gate.v1')

  const denied = (await gateTool.execute(
    { mode: 'learn', itemId: blockedItem.itemId, studentRef: STUDENT_REF },
    {},
  )) as { allowed: boolean }
  assert.equal(denied.allowed, false)

  const unknownItem = (await gateTool.execute(
    { mode: 'learn', itemId: 'item.not.in.catalog', studentRef: STUDENT_REF },
    {},
  )) as { allowed: boolean; reasons: readonly string[] }
  assert.equal(unknownItem.allowed, false)
  assert.deepEqual(unknownItem.reasons, ['item_not_found'])

  const probeTool = harness.tools.get('aeh_select_probe')
  assert.ok(probeTool)
  const plan = (await probeTool.execute(
    {
      candidates: [
        { itemId: item.itemId, predictions: { 'h.bug': 0.9, 'h.slip': 0.2 } },
        { itemId: blockedItem.itemId, predictions: { 'h.bug': 1, 'h.slip': 0 } },
      ],
      weights: { 'h.bug': 0.5, 'h.slip': 0.5 },
      studentRef: STUDENT_REF,
      mode: 'learn',
    },
    {},
  )) as {
    selection: { itemId: string } | null
    rejected: readonly { itemId: string }[]
  }
  assert.equal(plan.selection?.itemId, item.itemId)
  assert.equal(plan.rejected[0]?.itemId, blockedItem.itemId)

  const missingPlan = (await probeTool.execute(
    {
      candidates: [{ itemId: 'item.missing.001', predictions: { 'h.bug': 1 } }],
      weights: { 'h.bug': 1 },
      studentRef: STUDENT_REF,
      mode: 'learn',
    },
    {},
  )) as { rejected: readonly { reasons: readonly string[] }[] }
  assert.deepEqual(missingPlan.rejected[0]?.reasons, ['item_not_found'])

  const interventionTool = harness.tools.get('aeh_prepare_intervention')
  assert.ok(interventionTool)
  const prepared = (await interventionTool.execute(
    {
      package: {
        packageId: 'pkg.tool.001',
        objectiveId: 'obj.fraction.add',
        trainingItemIds: [item.itemId],
        transferItemIds: [transferItem.itemId],
        hintLadder: ['nudge'],
        completionCriteria: { independentCorrect: 1 },
        requiredKcs: ['kc.fraction.add'],
      },
      studentRef: STUDENT_REF,
      mode: 'learn',
    },
    {},
  )) as {
    valid: boolean
    notDelivered: boolean
    requiresHostApproval: boolean
  }
  assert.equal(prepared.valid, true)
  assert.equal(prepared.notDelivered, true)
  assert.equal(prepared.requiresHostApproval, true)

  const missingPrepared = (await interventionTool.execute(
    {
      package: {
        packageId: 'pkg.tool.missing',
        objectiveId: 'obj.fraction.add',
        trainingItemIds: ['item.missing.001'],
        requiredKcs: ['kc.fraction.add'],
      },
      studentRef: STUDENT_REF,
      mode: 'learn',
    },
    {},
  )) as { valid: boolean; reasons: readonly string[] }
  assert.equal(missingPrepared.valid, false)
  assert.ok(missingPrepared.reasons.includes('item_not_found:item.missing.001'))

  const reviewTool = harness.tools.get('aeh_schedule_review')
  assert.ok(reviewTool)
  const review = (await reviewTool.execute(
    {
      state: {
        learnerRef: STUDENT_REF,
        memoryUnitId: 'mem.fraction.add',
        stabilityDays: 1,
      },
      observations: [
        { observationId: 'o.read', success: true, kind: 'reading' },
      ],
      targetRetention: 0.9,
    },
    {},
  )) as { observationsReceived: number; ignoredReadingObservations: number }
  assert.equal(review.observationsReceived, 1)
  assert.equal(review.ignoredReadingObservations, 1)

  harness.dispose()
  assert.equal(harness.tools.size, 0)
})

test('tools fail closed when the host authorises nothing', async () => {
  const harness = createTestContext()
  applyPlugin(harness.ctx, {})
  const gateTool = harness.tools.get('aeh_check_curriculum')
  assert.ok(gateTool)
  const decision = (await gateTool.execute(
    { mode: 'learn', itemId: item.itemId, studentRef: STUDENT_REF },
    {},
  )) as { allowed: boolean; reasons: readonly string[] }
  assert.equal(decision.allowed, false)
  assert.deepEqual(decision.reasons, ['progress_unavailable'])

  const unknown = (await gateTool.execute(
    { mode: 'learn', itemId: item.itemId, studentRef: 'another.student' },
    {},
  )) as { allowed: boolean; reasons: readonly string[] }
  assert.equal(unknown.allowed, false)
  assert.deepEqual(unknown.reasons, ['progress_unavailable'])
  harness.dispose()
})

test('plugin rejects a requested raw-data permission at activation', () => {
  const harness = createTestContext()
  assert.throws(
    () =>
      applyPlugin(harness.ctx, {
        permissions: { studentRawData: true },
      }),
    PermissionDeniedError,
  )
  assert.equal(harness.tools.size, 0)
})
