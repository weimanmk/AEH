/**
 * Host-adapter contract tests (synthetic/test only).
 *
 * These exercise the Step 4 in-memory auth/session, source-attested twin, and
 * host-approval delivery adapters. Every reference is synthetic; no real
 * student data, credentials, network, or filesystem is involved.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEducationService } from '../src/service.ts'
import {
  HostAuthorizationError,
  MemoryHostContext,
} from '../src/host/host-context.ts'
import { ConsentError, ConsentSnapshot } from '../src/host/consent.ts'
import {
  IdempotencyConflictError,
  MemoryHostTwin,
  type AttestationVerifier,
  type SourceAttestation,
} from '../src/host/twin-adapter.ts'
import {
  ApprovalLedger,
  DeliveryDeniedError,
  HostDeliveryAdapter,
} from '../src/host/delivery.ts'
import {
  SimulatedEventRejected,
  UnknownEventSource,
} from '../src/core/twin.ts'
import type { CurriculumItem, LearnerProgress } from '../src/domain.ts'

const STUDENT_REF = 'synthetic.student.001'
const OTHER_STUDENT_REF = 'synthetic.student.002'
const TENANT_ID = 'tenant.synthetic.001'
const SESSION_ID = 'session.synthetic.001'

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

function allScopes(): ConsentSnapshot {
  return ConsentSnapshot.granted([
    'curriculum:read',
    'twin:observe',
    'twin:simulate',
    'twin:rollback',
    'intervention:deliver',
  ])
}

function makeHost(consent = allScopes()): MemoryHostContext {
  return new MemoryHostContext({
    session: {
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      studentRef: STUDENT_REF,
    },
    consent,
    progress: [progress, { ...progress, studentRef: OTHER_STUDENT_REF }],
    catalog: [item, transferItem],
  })
}

const verifyToken: AttestationVerifier = (attestation) =>
  attestation.token === 'synthetic-host-token'

function attestationFor(
  source: string,
  overrides: Partial<SourceAttestation> = {},
): SourceAttestation {
  return {
    issuer: 'test.school-gateway',
    source,
    subjectRef: STUDENT_REF,
    issuedAt: '2026-03-02T09:00:00.000Z',
    token: 'synthetic-host-token',
    ...overrides,
  }
}

test('memory host context resolves only the authorised session student and item catalog', () => {
  const host = makeHost()
  assert.equal(host.matchesSession(SESSION_ID), true)
  assert.equal(host.matchesSession('session.other'), false)
  assert.equal(host.authorizedStudentRef, STUDENT_REF)
  assert.equal(host.resolveProgress(STUDENT_REF)?.gradeLevel, 5)
  assert.equal(host.resolveProgress(OTHER_STUDENT_REF), undefined)
  assert.equal(host.resolveProgress('synthetic.unknown'), undefined)
  assert.equal(host.resolveItem(item.itemId)?.itemId, item.itemId)
  assert.equal(host.resolveItem('item.unknown'), undefined)
  assert.throws(
    () => host.assertSession('session.other'),
    HostAuthorizationError,
  )
  host.assertSession(SESSION_ID)
})

test('consent revocation turns every subsequent read into fail-closed denial', () => {
  const consent = allScopes()
  const host = makeHost(consent)
  assert.equal(host.resolveProgress(STUDENT_REF)?.studentRef, STUDENT_REF)

  consent.revoke('curriculum:read', '2026-03-03T00:00:00.000Z')
  assert.equal(host.authorizedStudentRef, undefined)
  assert.equal(host.resolveProgress(STUDENT_REF), undefined)
  assert.equal(host.resolveItem(item.itemId), undefined)
  assert.throws(() => host.assertSession(SESSION_ID), ConsentError)
  assert.equal(host.snapshot().authorized, false)
})

test('memory host context rejects duplicate catalog ids and blank session refs', () => {
  assert.throws(
    () =>
      new MemoryHostContext({
        session: { sessionId: SESSION_ID, tenantId: TENANT_ID, studentRef: '' },
        consent: allScopes(),
        progress: [],
        catalog: [],
      }),
    TypeError,
  )
  assert.throws(
    () =>
      new MemoryHostContext({
        session: {
          sessionId: SESSION_ID,
          tenantId: TENANT_ID,
          studentRef: STUDENT_REF,
        },
        consent: allScopes(),
        progress: [],
        catalog: [item, { ...item }],
      }),
    /duplicate catalog item id/,
  )
})

test('host twin authenticates, appends observed evidence, and audits without payloads', () => {
  const twin = new MemoryHostTwin(STUDENT_REF, {
    verifyAttestation: verifyToken,
    consent: allScopes(),
    now: () => '2026-03-02T09:00:00.000Z',
  })

  const first = twin.appendObserved(
    {
      eventId: 'ev.observed.001',
      eventType: 'attempt',
      source: 'trusted_grader',
      studentRef: STUDENT_REF,
      payload: { correct: true, answer: 'synthetic-answer' },
    },
    attestationFor('trusted_grader'),
  )
  assert.equal(first.replayed, false)
  assert.equal(first.event.eventId, 'ev.observed.001')
  assert.equal(twin.observed().length, 1)
  assert.equal(twin.evidenceRevision, 1)

  const replay = twin.appendObserved(
    {
      eventId: 'ev.observed.001',
      eventType: 'attempt',
      source: 'trusted_grader',
      studentRef: STUDENT_REF,
      payload: { correct: true, answer: 'synthetic-answer' },
    },
    attestationFor('trusted_grader'),
  )
  assert.equal(replay.replayed, true)
  assert.equal(twin.observed().length, 1)

  const audit = twin.audit()
  assert.ok(audit.some((entry) => entry.action === 'observed.append'))
  assert.ok(audit.some((entry) => entry.action === 'observed.replay'))
  for (const entry of audit) {
    assert.equal('payload' in entry.detail, false)
    assert.equal('answer' in entry.detail, false)
  }
})

test('host twin rejects simulated, unknown, and unattested sources before writing observed', () => {
  const twin = new MemoryHostTwin(STUDENT_REF, {
    verifyAttestation: verifyToken,
    consent: allScopes(),
  })

  assert.throws(
    () =>
      twin.appendObserved(
        {
          eventId: 'ev.sim.gateway',
          eventType: 'attempt',
          source: 'simulated',
          studentRef: STUDENT_REF,
        },
        attestationFor('simulated'),
      ),
    SimulatedEventRejected,
  )
  assert.throws(
    () =>
      twin.appendObserved(
        {
          eventId: 'ev.unknown.source',
          eventType: 'attempt',
          source: 'model_invented',
          studentRef: STUDENT_REF,
        },
        attestationFor('model_invented'),
      ),
    UnknownEventSource,
  )
  assert.throws(
    () =>
      twin.appendObserved(
        {
          eventId: 'ev.bad.attestation',
          eventType: 'attempt',
          source: 'teacher',
          studentRef: STUDENT_REF,
        },
        attestationFor('teacher', { token: 'wrong-token' }),
      ),
    /not verified by the host/,
  )
  assert.throws(
    () =>
      twin.appendObserved(
        {
          eventId: 'ev.wrong.subject',
          eventType: 'attempt',
          source: 'teacher',
          studentRef: STUDENT_REF,
        },
        attestationFor('teacher', { subjectRef: OTHER_STUDENT_REF }),
      ),
    /does not match/,
  )

  assert.equal(twin.observed().length, 0)
  assert.ok(
    twin.audit('auth.reject').every((entry) => entry.outcome === 'rejected'),
  )
})

test('host twin idempotency conflicts surface and authentication runs before replay', () => {
  const twin = new MemoryHostTwin(STUDENT_REF, {
    verifyAttestation: verifyToken,
    consent: allScopes(),
  })
  const input = {
    eventId: 'ev.idempotent.001',
    eventType: 'attempt',
    source: 'teacher' as const,
    studentRef: STUDENT_REF,
    payload: { correct: true },
  }
  twin.appendObserved(input, attestationFor('teacher'))

  assert.throws(
    () =>
      twin.appendObserved(
        { ...input, payload: { correct: false } },
        attestationFor('teacher'),
      ),
    IdempotencyConflictError,
  )

  // A replayed id with an invalid attestation is rejected, not silently deduped.
  assert.throws(
    () => twin.appendObserved(input, attestationFor('teacher', { token: 'bad' })),
    /not verified by the host/,
  )
  assert.ok(twin.audit('idempotency.conflict').length >= 1)
})

test('simulated events stay isolated, cannot be promoted, and never back mastery', () => {
  const twin = new MemoryHostTwin(STUDENT_REF, {
    verifyAttestation: verifyToken,
    consent: allScopes(),
  })
  twin.appendObserved(
    {
      eventId: 'ev.real.mastery',
      eventType: 'attempt',
      source: 'trusted_grader',
      studentRef: STUDENT_REF,
    },
    attestationFor('trusted_grader'),
  )
  const simulated = twin.appendSimulated({
    eventId: 'ev.sim.mastery',
    eventType: 'attempt',
    source: 'virtual_student',
    studentRef: STUDENT_REF,
  })
  assert.equal(simulated.replayed, false)
  assert.equal(twin.simulated().length, 1)

  assert.throws(
    () => twin.updateMastery('kc.fraction.add', 0.9, 0.05, ['ev.sim.mastery']),
    /non-observed evidence/,
  )
  assert.throws(() => twin.promoteSimulated('ev.sim.mastery'), SimulatedEventRejected)
  assert.throws(
    () =>
      twin.appendSimulated({
        eventId: 'ev.bad.sim',
        eventType: 'attempt',
        source: 'teacher',
        studentRef: STUDENT_REF,
      }),
    SimulatedEventRejected,
  )
  assert.equal(twin.observed().length, 1)
  assert.equal(twin.simulated().length, 1)
})

test('host twin mastery updates are versioned and rollback leaves observed evidence intact', () => {
  const twin = new MemoryHostTwin(STUDENT_REF, {
    verifyAttestation: verifyToken,
    consent: allScopes(),
  })
  twin.appendObserved(
    {
      eventId: 'ev.a',
      eventType: 'attempt',
      source: 'teacher',
      studentRef: STUDENT_REF,
    },
    attestationFor('teacher'),
  )
  twin.appendObserved(
    {
      eventId: 'ev.b',
      eventType: 'attempt',
      source: 'student',
      studentRef: STUDENT_REF,
    },
    attestationFor('student'),
  )
  twin.updateMastery('kc.fraction.add', 0.4, 0.3, ['ev.a'])
  twin.updateMastery('kc.fraction.equiv', 0.7, 0.2, ['ev.b'])
  assert.equal(twin.version, 2)

  const rolledBack = twin.rollback(1)
  assert.equal(rolledBack.toVersion, 1)
  assert.equal(rolledBack.state.knowledge.has('kc.fraction.equiv'), false)
  assert.equal(twin.observed().length, 2)
  assert.ok(twin.audit('rollback').some((entry) => entry.outcome === 'accepted'))
  assert.throws(() => twin.rollback(99), /unknown twin version/)
})

test('revoked consent blocks host twin writes and is audited as a rejection', () => {
  const consent = allScopes()
  const twin = new MemoryHostTwin(STUDENT_REF, {
    verifyAttestation: verifyToken,
    consent,
  })
  consent.revoke('twin:observe')
  assert.throws(
    () =>
      twin.appendObserved(
        {
          eventId: 'ev.after.revoke',
          eventType: 'attempt',
          source: 'teacher',
          studentRef: STUDENT_REF,
        },
        attestationFor('teacher'),
      ),
    /consent scope/,
  )
  assert.ok(twin.audit('consent.reject').length >= 1)
  assert.equal(twin.observed().length, 0)
})

test('approval ledger is idempotent and rejects conflicting reuse', () => {
  const ledger = new ApprovalLedger()
  const record = {
    approvalId: 'approval.001',
    packageId: 'pkg.001',
    studentRef: STUDENT_REF,
    approvedBy: 'synthetic.teacher.001',
    approvedAt: '2026-03-02T10:00:00.000Z',
    decision: 'approved' as const,
    scope: 'intervention:deliver' as const,
  }
  const first = ledger.append(record)
  const second = ledger.append({ ...record })
  assert.equal(first, second)
  assert.throws(
    () => ledger.append({ ...record, packageId: 'pkg.other' }),
    DeliveryDeniedError,
  )
  assert.equal(ledger.list().length, 1)
})

test('delivery requires session, consent, approval, and a re-validated package', () => {
  const consent = allScopes()
  const host = makeHost(consent)
  const service = createEducationService({}, host)
  const approvals = new ApprovalLedger()
  const delivery = new HostDeliveryAdapter({
    host,
    service,
    approvals,
    consent,
    now: () => '2026-03-02T10:00:00.000Z',
  })
  const input = {
    packageId: 'pkg.001',
    objectiveId: 'obj.fraction.add',
    trainingItemIds: [item.itemId],
    transferItemIds: [transferItem.itemId],
    hintLadder: ['nudge'],
    completionCriteria: { independentCorrect: 1 },
    requiredKcs: ['kc.fraction.add'],
    schoolMode: 'learn' as const,
  }

  assert.throws(() => delivery.deliver(input, 'approval.missing'), DeliveryDeniedError)

  approvals.append({
    approvalId: 'approval.001',
    packageId: 'pkg.001',
    studentRef: STUDENT_REF,
    approvedBy: 'synthetic.teacher.001',
    approvedAt: '2026-03-02T09:59:00.000Z',
    decision: 'approved',
    scope: 'intervention:deliver',
  })
  const receipt = delivery.deliver(input, 'approval.001')
  assert.equal(receipt.externalEffect, false)
  assert.equal(receipt.channel, 'host-memory-test')
  assert.equal(receipt.studentRef, STUDENT_REF)
  assert.deepEqual([...receipt.itemIds], [item.itemId, transferItem.itemId])
  // Repeating the same approval is an idempotent receipt, not a second delivery.
  assert.equal(delivery.deliver(input, 'approval.001'), receipt)

  // Revoking delivery consent after the fact blocks the next delivery attempt.
  consent.revoke('intervention:deliver')
  assert.throws(
    () => delivery.deliver({ ...input, packageId: 'pkg.002' }, 'approval.001'),
    ConsentError,
  )
})

test('preparation stays host-approval-gated and never delivers from the model tool path', () => {
  const host = makeHost()
  const service = createEducationService({}, host)
  const prepared = service.prepareInterventionFor(
    {
      packageId: 'pkg.001',
      objectiveId: 'obj.fraction.add',
      trainingItemIds: [item.itemId],
      transferItemIds: [transferItem.itemId],
      hintLadder: ['nudge'],
      completionCriteria: { independentCorrect: 1 },
      requiredKcs: ['kc.fraction.add'],
      schoolMode: 'learn',
    },
    STUDENT_REF,
    'learn',
  )
  assert.equal(prepared.valid, true)
  assert.equal(prepared.deliveryEligible, true)
  assert.equal(prepared.notDelivered, true)
  assert.equal(prepared.requiresHostApproval, true)
})
