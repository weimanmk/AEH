/**
 * Host-side controlled self-evolution contract tests (synthetic only).
 *
 * These exercise the Step 6 TypeScript skeleton: candidate records cannot
 * touch protected invariants or production files, evaluation auto-rejects
 * failed/insufficient evidence, approval is default-deny and host-only,
 * canaries are synthetic-only with a circuit breaker, rollback restores the
 * previous stable version, and the audit log never holds raw student data.
 *
 * No real student data, credentials, network, or filesystem is involved.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_IMPACT_SCOPES,
  ApprovalDeniedError,
  AuditError,
  CanaryDeniedError,
  CandidateRegistry,
  CandidateValidationError,
  DuplicateCandidateError,
  EvolutionAuditLog,
  EvolutionControlPlane,
  EvolutionError,
  IsolatedSandbox,
  LifecycleError,
  PRODUCTION_MUTATION_ENABLED,
  ProtectedInvariantError,
  RollbackDeniedError,
  SANDBOX_HAS_PRODUCTION_ACCESS,
  isHostActor,
  type Actor,
  type ApprovalRecord,
  type Candidate,
  type CanaryConditions,
  type FrozenEvalDataset,
} from '../src/host/evolution.ts'
import { createEducationService } from '../src/service.ts'
import { createEducationTools } from '../src/tools.ts'

const AUTHOR = 'system.evolution_agent'
const REVIEWER: Actor = { actorId: 'reviewer.001', role: 'reviewer' }
const DATASET: FrozenEvalDataset = {
  datasetId: 'aeh.test.evolution',
  version: 'v1',
  digest: 'a'.repeat(64),
}

const EVALUATED_AT = '2026-03-10T00:00:00.000Z'
const DECIDED_AT = '2026-03-11T00:00:00.000Z'

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidateId: 'cand.hint_ladder.001',
    version: 'v1',
    kind: 'policy',
    source: 'eval_regression',
    changeSummary: 'Reduce hint exposure after the first independent attempt.',
    impactScope: ['hint_ladder'],
    baselineVersion: 'pol-27',
    changes: { hint_ladder: ['nudge'] },
    createdAt: '2026-03-01T00:00:00.000Z',
    author: AUTHOR,
    ...overrides,
  }
}

function makePlane(): EvolutionControlPlane {
  return new EvolutionControlPlane(DATASET)
}

function approve(plane: EvolutionControlPlane, candidate: Candidate): void {
  const approval: ApprovalRecord = {
    candidateId: candidate.candidateId,
    candidateVersion: candidate.version,
    decision: 'approved',
    approvedBy: REVIEWER.actorId,
    decidedAt: DECIDED_AT,
    reason: 'synthetic evidence is sufficient to screen',
    role: REVIEWER.role,
  }
  plane.approve(candidate.candidateId, candidate.version, approval, REVIEWER)
}

function evaluateSimulatedOnly(
  plane: EvolutionControlPlane,
  candidate: Candidate,
): void {
  plane.evaluate(candidate.candidateId, candidate.version, REVIEWER, {
    simulated: {
      itemCount: 3,
      meanPredictedCorrect: 0.8,
      referenceAccuracy: 0.5,
    },
    evaluatedAt: EVALUATED_AT,
  })
}

test('candidate is a versioned declarative change record', () => {
  const candidate = makeCandidate()
  const registry = new CandidateRegistry(new EvolutionAuditLog())
  const registered = registry.register(candidate)
  assert.equal(registered.mutatesProduction, false)
  assert.deepEqual(registered.targetFiles, [])
  assert.ok(ALLOWED_IMPACT_SCOPES.includes('hint_ladder' as never))
  // The record is frozen.
  assert.throws(() => {
    ;(registered as { version: string }).version = 'v2'
  }, TypeError)
})

test('candidate cannot touch protected invariants or relax permissions', () => {
  const registry = new CandidateRegistry(new EvolutionAuditLog())
  assert.throws(
    () => registry.register(makeCandidate({ changes: { curriculum_gate: { enabled: false } } })),
    ProtectedInvariantError,
  )
  assert.throws(
    () => registry.register(makeCandidate({ changes: { security: { permissions: 'all' } } })),
    ProtectedInvariantError,
  )
  assert.throws(
    () => registry.register(makeCandidate({ impactScope: ['permissions'] })),
    ProtectedInvariantError,
  )
})

test('candidate cannot name production files or carry executable changes', () => {
  const registry = new CandidateRegistry(new EvolutionAuditLog())
  assert.throws(
    () => registry.register(makeCandidate({ targetFiles: ['/etc/passwd'] })),
    CandidateValidationError,
  )
  assert.throws(
    () => registry.register(makeCandidate({ mutatesProduction: true })),
    CandidateValidationError,
  )
  assert.throws(
    () =>
      registry.register(
        makeCandidate({
          changes: { apply: () => undefined } as unknown as Record<string, unknown>,
        }),
      ),
    CandidateValidationError,
  )
  assert.throws(
    () => registry.register(makeCandidate({ kind: 'code_patch' as never })),
    CandidateValidationError,
  )
})

test('registry is append-only and idempotent', () => {
  const audit = new EvolutionAuditLog()
  const registry = new CandidateRegistry(audit)
  const first = registry.register(makeCandidate())
  const second = registry.register(makeCandidate())
  assert.equal(first, second)
  assert.equal(registry.list().length, 1)
  assert.equal(audit.head, 1)
  assert.throws(
    () => registry.register(makeCandidate({ changes: { hint_ladder: ['other'] } })),
    DuplicateCandidateError,
  )
})

test('simulated-only evidence screens but cannot promote', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  const verdict = plane.record(candidate.candidateId, candidate.version).evaluation
  assert.ok(verdict)
  assert.equal(verdict?.screeningPassed, true)
  assert.equal(verdict?.promotionReady, false)
  assert.equal(verdict?.simulatedBenefit?.isCausalEvidence, false)
  assert.equal(verdict?.realTransfer, null)
  assert.ok(
    verdict?.reasons.includes('promotion_blocked:real_transfer_evidence_missing'),
  )
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'evaluated')
})

test('no evidence auto-rejects the candidate', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  plane.evaluate(candidate.candidateId, candidate.version, REVIEWER, {
    evaluatedAt: EVALUATED_AT,
  })
  const verdict = plane.record(candidate.candidateId, candidate.version).evaluation
  assert.equal(verdict?.screeningPassed, false)
  assert.equal(verdict?.evidenceSufficient, false)
  assert.ok(
    verdict?.reasons.includes('evidence_insufficient:no_simulated_or_real_evidence'),
  )
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'rejected')
})

test('simulated evidence touching the transfer split is auto-rejected', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  plane.evaluate(candidate.candidateId, candidate.version, REVIEWER, {
    simulated: {
      itemCount: 3,
      meanPredictedCorrect: 0.9,
      referenceAccuracy: 0.5,
      touchesTransferSplit: true,
    },
    evaluatedAt: EVALUATED_AT,
  })
  const verdict = plane.record(candidate.candidateId, candidate.version).evaluation
  assert.equal(verdict?.screeningPassed, false)
  assert.ok(verdict?.reasons.includes('evaluation_rejected:SplitIsolationError'))
})

test('real transfer requires trusted unseen evidence above threshold', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  plane.evaluate(candidate.candidateId, candidate.version, REVIEWER, {
    simulated: {
      itemCount: 3,
      meanPredictedCorrect: 0.9,
      referenceAccuracy: 0.5,
    },
    real: {
      itemCount: 2,
      independentCorrect: 1,
      referenceAccuracy: 0.5,
      allItemsUnseen: false,
      sources: ['trusted_grader'],
    },
    evaluatedAt: EVALUATED_AT,
  })
  const verdict = plane.record(candidate.candidateId, candidate.version).evaluation
  assert.equal(verdict?.promotionReady, false)
  assert.ok(verdict?.reasons.includes('real_transfer_failed:item_was_seen'))

  const plane2 = makePlane()
  const candidate2 = plane2.propose(makeCandidate(), REVIEWER).candidate
  plane2.evaluate(candidate2.candidateId, candidate2.version, REVIEWER, {
    real: {
      itemCount: 2,
      independentCorrect: 2,
      referenceAccuracy: 0.5,
      allItemsUnseen: true,
      sources: ['virtual_student'],
    },
    evaluatedAt: EVALUATED_AT,
  })
  const verdict2 = plane2.record(candidate2.candidateId, candidate2.version).evaluation
  assert.equal(verdict2?.promotionReady, false)
  assert.ok(verdict2?.reasons.includes('real_transfer_failed:untrusted_source'))
})

test('real transfer above threshold marks promotion ready', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  plane.evaluate(candidate.candidateId, candidate.version, REVIEWER, {
    simulated: {
      itemCount: 3,
      meanPredictedCorrect: 0.9,
      referenceAccuracy: 0.5,
    },
    real: {
      itemCount: 2,
      independentCorrect: 2,
      referenceAccuracy: 0.5,
      allItemsUnseen: true,
      sources: ['trusted_grader'],
    },
    evaluatedAt: EVALUATED_AT,
  })
  const verdict = plane.record(candidate.candidateId, candidate.version).evaluation
  assert.equal(verdict?.screeningPassed, true)
  assert.equal(verdict?.promotionReady, true)
  assert.equal(verdict?.realTransfer?.causalClaimSupported, false)
})

test('approval is default-deny and host-side only', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)

  assert.throws(
    () => plane.approve(candidate.candidateId, candidate.version, null, REVIEWER),
    ApprovalDeniedError,
  )
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'evaluated')

  const selfApproval: ApprovalRecord = {
    candidateId: candidate.candidateId,
    candidateVersion: candidate.version,
    decision: 'approved',
    approvedBy: AUTHOR,
    decidedAt: DECIDED_AT,
    reason: 'self approval',
    role: 'candidate',
  }
  assert.throws(
    () =>
      plane.approve(candidate.candidateId, candidate.version, selfApproval, {
        actorId: AUTHOR,
        role: 'candidate',
      }),
    ApprovalDeniedError,
  )
  assert.equal(isHostActor({ actorId: 'x', role: 'candidate' }), false)
})

test('approval record must match actor and candidate', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  const forged: ApprovalRecord = {
    candidateId: candidate.candidateId,
    candidateVersion: candidate.version,
    decision: 'approved',
    approvedBy: 'someone.else',
    decidedAt: DECIDED_AT,
    reason: 'forged approver',
    role: 'reviewer',
  }
  assert.throws(
    () => plane.approve(candidate.candidateId, candidate.version, forged, REVIEWER),
    ApprovalDeniedError,
  )
})

test('explicit approval records approver, time, and reason', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  approve(plane, candidate)
  const record = plane.record(candidate.candidateId, candidate.version)
  assert.equal(record.status, 'approved')
  assert.equal(record.approval?.approvedBy, REVIEWER.actorId)
  assert.equal(record.approval?.decidedAt, DECIDED_AT)
  assert.ok(record.approval?.reason)
  assert.ok(plane.audit.entries({ action: 'candidate.approved' }).length >= 1)
})

test('canary requires approval, synthetic-only, and valid fraction', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  assert.throws(
    () =>
      plane.startCanary(candidate.candidateId, candidate.version, {
        fraction: 0.1,
        actor: REVIEWER,
      }),
    CanaryDeniedError,
  )

  approve(plane, candidate)
  for (const fraction of [0, -0.1, 1.5]) {
    assert.throws(
      () =>
        plane.startCanary(candidate.candidateId, candidate.version, {
          fraction,
          actor: REVIEWER,
        }),
      CanaryDeniedError,
    )
  }
  assert.throws(
    () =>
      plane.startCanary(candidate.candidateId, candidate.version, {
        fraction: 0.1,
        actor: { actorId: AUTHOR, role: 'candidate' },
      }),
    CanaryDeniedError,
  )
  const state = plane.startCanary(candidate.candidateId, candidate.version, {
    fraction: 0.1,
    actor: REVIEWER,
  })
  assert.equal(state.syntheticOnly, true)
  assert.equal(state.fraction, 0.1)
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'canary')
})

test('circuit breaker trips and rolls back to the previous stable version', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  approve(plane, candidate)
  plane.startCanary(candidate.candidateId, candidate.version, {
    fraction: 0.2,
    actor: REVIEWER,
    conditions: {
      maxRegression: 0.05,
      maxErrorRate: 0.2,
      minSamples: 5,
      maxDurationMinutes: 60,
    },
  })
  const result = plane.observeCanary(
    candidate.candidateId,
    candidate.version,
    { regression: 0.4, errorRate: 0.5, sampleCount: 10 },
    REVIEWER,
  )
  assert.equal(result.tripped, true)
  assert.equal(result.rollback?.toVersion, 'pol-27')
  assert.equal(result.rollback?.triggeredBy, 'circuit_breaker')
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'rolled_back')
  assert.equal(plane.stableVersion(candidate.candidateId), 'pol-27')
  assert.ok(plane.audit.entries({ action: 'canary.circuit_breaker' }).length >= 1)
})

test('healthy canary observations do not trip the breaker', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  approve(plane, candidate)
  const conditions: CanaryConditions = {
    maxRegression: 0.1,
    maxErrorRate: 0.1,
    minSamples: 5,
    maxDurationMinutes: 60,
  }
  plane.startCanary(candidate.candidateId, candidate.version, {
    fraction: 0.2,
    actor: REVIEWER,
    conditions,
  })
  const result = plane.observeCanary(
    candidate.candidateId,
    candidate.version,
    { regression: 0.01, errorRate: 0.02, sampleCount: 10 },
    REVIEWER,
  )
  assert.equal(result.tripped, false)
  assert.equal(result.rollback, null)
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'canary')
})

test('promotion requires real transfer evidence', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  approve(plane, candidate)
  plane.startCanary(candidate.candidateId, candidate.version, {
    fraction: 0.1,
    actor: REVIEWER,
  })
  assert.throws(
    () => plane.promote(candidate.candidateId, candidate.version, REVIEWER),
    EvolutionError,
  )
})

test('promotion and rollback update the stable version and audit the chain', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  plane.evaluate(candidate.candidateId, candidate.version, REVIEWER, {
    simulated: { itemCount: 3, meanPredictedCorrect: 0.9, referenceAccuracy: 0.5 },
    real: {
      itemCount: 2,
      independentCorrect: 2,
      referenceAccuracy: 0.5,
      allItemsUnseen: true,
      sources: ['trusted_grader'],
    },
    evaluatedAt: EVALUATED_AT,
  })
  approve(plane, candidate)
  plane.startCanary(candidate.candidateId, candidate.version, {
    fraction: 0.1,
    actor: REVIEWER,
  })
  const promoted = plane.promote(candidate.candidateId, candidate.version, REVIEWER)
  assert.equal(promoted.status, 'promoted')
  assert.equal(promoted.previousStableVersion, 'pol-27')
  assert.equal(plane.stableVersion(candidate.candidateId), candidate.version)

  const event = plane.rollback(candidate.candidateId, candidate.version, {
    actor: REVIEWER,
    reason: 'synthetic canary regression drill',
  })
  assert.equal(event.fromVersion, candidate.version)
  assert.equal(event.toVersion, 'pol-27')
  assert.equal(plane.stableVersion(candidate.candidateId), 'pol-27')
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'rolled_back')

  const actions = new Set(plane.audit.entries().map((entry) => entry.action))
  for (const action of [
    'candidate.registered',
    'candidate.evaluated',
    'candidate.approved',
    'canary.started',
    'candidate.promoted',
    'rollback.completed',
  ]) {
    assert.ok(actions.has(action), `missing audit action ${action}`)
  }
})

test('a candidate cannot roll back the production system itself', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  evaluateSimulatedOnly(plane, candidate)
  approve(plane, candidate)
  plane.startCanary(candidate.candidateId, candidate.version, {
    fraction: 0.1,
    actor: REVIEWER,
  })
  assert.throws(
    () =>
      plane.rollback(candidate.candidateId, candidate.version, {
        actor: { actorId: AUTHOR, role: 'candidate' },
        reason: 'self rollback',
      }),
    RollbackDeniedError,
  )
  assert.equal(plane.status(candidate.candidateId, candidate.version), 'canary')
})

test('rollback requires something to roll back from', () => {
  const plane = makePlane()
  const candidate = plane.propose(makeCandidate(), REVIEWER).candidate
  assert.throws(
    () =>
      plane.rollback(candidate.candidateId, candidate.version, {
        actor: REVIEWER,
        reason: 'nothing running',
      }),
    LifecycleError,
  )
})

test('audit log is append-only and rejects raw student data keys', () => {
  const audit = new EvolutionAuditLog()
  audit.append({
    actor: 'host',
    action: 'candidate.registered',
    subject: 'c',
    outcome: 'accepted',
  })
  audit.append({
    actor: 'host',
    action: 'candidate.evaluated',
    subject: 'c',
    outcome: 'accepted',
  })
  assert.equal(audit.head, 2)
  assert.equal(audit.entries().length, 2)
  assert.equal(
    (audit as unknown as { delete?: unknown }).delete,
    undefined,
  )
  for (const key of ['answer', 'payload', 'student_name', 'trace']) {
    assert.throws(
      () =>
        audit.append({
          actor: 'host',
          action: 'candidate.registered',
          subject: 'c',
          outcome: 'accepted',
          detail: { [key]: 'synthetic raw' },
        }),
      AuditError,
    )
  }
})

test('sandbox is isolated and the pipeline declares synthetic-only', () => {
  assert.equal(PRODUCTION_MUTATION_ENABLED, false)
  assert.equal(SANDBOX_HAS_PRODUCTION_ACCESS, false)
  const sandbox = new IsolatedSandbox(DATASET)
  assert.equal(sandbox.dataset.datasetId, 'aeh.test.evolution')

  const plane = makePlane()
  plane.propose(makeCandidate(), REVIEWER)
  const snapshot = plane.pipelineSnapshot()
  assert.equal(snapshot.productionMutationEnabled, false)
  assert.equal(snapshot.sandboxHasProductionAccess, false)
  assert.equal(snapshot.syntheticFixturesOnly, true)
  assert.equal((snapshot.candidates as unknown[]).length, 1)
})

test('no model-callable self-evolution tool is registered', () => {
  const service = createEducationService({}, undefined)
  const names = createEducationTools(service).map((tool) => tool.name)
  assert.deepEqual(names.sort(), [
    'aeh_check_curriculum',
    'aeh_generate_report',
    'aeh_prepare_intervention',
    'aeh_schedule_review',
    'aeh_select_probe',
    'aeh_update_hypotheses',
  ])
  for (const name of names) {
    assert.equal(/evolution|approve|rollback|canary/.test(name), false)
  }
})
