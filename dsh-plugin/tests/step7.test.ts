/**
 * Step 7 / P1 hardening tests.
 *
 * Four concerns are covered, all with synthetic data and an isolated runtime:
 *
 *   1. Schemastery config: defaults, fail-loud rejection, and a loader that
 *      refuses an illegal config before the plugin body runs;
 *   2. closed output schemas for all six tools, including a real dsh-tools
 *      `INVALID_TOOL_OUTPUT` rejection for an out-of-bounds return;
 *   3. session/agent-scoped hypothesis snapshots with TTL, isolation, cleanup,
 *      and no long-term-twin write path;
 *   4. the append-only, pseudonymised audit log (gate refusals, tool calls,
 *      approvals, delivery receipts) that refuses raw student content.
 *
 * Nothing here reads or writes `~/.dsh/`, the reference clone, or an npx dsh
 * install; the loader instance is built in-process from this package.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import Loader from '@deepseek-ai/cordis-plugin-loader'

import {
  Config,
  attachSessionCleanup,
  apply,
} from '../src/index.ts'
import * as aehPlugin from '../src/index.ts'
import {
  AEH_CONFIG_SCHEMA,
  ConfigValidationError,
  resolveAehConfig,
} from '../src/config.ts'
import {
  AUDIT_EVENT_KINDS,
  AehAuditLog,
  AuditError,
} from '../src/host/audit-log.ts'
import {
  DEFAULT_SESSION_SNAPSHOT_TTL_MS,
  SessionScopeError,
  SessionSnapshotStore,
  scopeFromExecution,
  type SessionSnapshotInput,
} from '../src/host/session-state.ts'
import {
  TOOL_OUTPUT_SCHEMAS,
  reviewOutputSchema,
} from '../src/output-schemas.ts'
import {
  ApprovalLedger,
  HostDeliveryAdapter,
} from '../src/host/delivery.ts'
import { MemoryHostContext } from '../src/host/host-context.ts'
import { ConsentSnapshot } from '../src/host/consent.ts'
import { createEducationService } from '../src/service.ts'
import { createEducationTools } from '../src/tools.ts'
import { StudentTwin } from '../src/core/twin.ts'
import { defineTool, renderJson } from '../src/dsh.ts'
import { HypothesisError } from '../src/domain.ts'
import type { CurriculumItem, LearnerProgress } from '../src/domain.ts'

const STUDENT_REF = 'synthetic.student.001'
const TENANT_ID = 'tenant.synthetic.001'
const SESSION_ID = 'session.synthetic.001'
const EXPECTED_TOOLS = [
  'aeh_check_curriculum',
  'aeh_generate_report',
  'aeh_prepare_intervention',
  'aeh_schedule_review',
  'aeh_select_probe',
  'aeh_update_hypotheses',
].sort()

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
    progress: [progress],
    catalog: [item, transferItem],
  })
}

const snapshotInput: SessionSnapshotInput = {
  state: { hypotheses: [], unknownWeight: 1 },
  weights: { unknown: 1 },
  dominantId: null,
  transitions: 0,
}

// ---------------------------------------------------------------------------
// 1. Schemastery config
// ---------------------------------------------------------------------------

test('config schema supplies documented defaults for an empty config', () => {
  const resolved = resolveAehConfig({})
  assert.equal(resolved.profile, 'student-facing')
  assert.equal(resolved.targetRetention, 0.9)
  assert.deepEqual([...resolved.allowedModes], ['preview', 'learn', 'review'])
  assert.equal(Object.isFrozen(resolved), true)
})

test('illegal config fails loud instead of falling back to defaults', () => {
  const cases: Array<[string, unknown]> = [
    ['unknown profile', { profile: 'teacher' }],
    ['zero retention', { targetRetention: 0 }],
    ['one retention', { targetRetention: 1 }],
    ['out-of-range retention', { targetRetention: 1.5 }],
    ['non-numeric retention', { targetRetention: 'high' }],
    ['unknown gate mode', { allowedModes: ['practice'] }],
    ['non-array modes', { allowedModes: 'learn' }],
    ['non-object config', []],
  ]
  for (const [label, value] of cases) {
    assert.throws(
      () => resolveAehConfig(value),
      (error: unknown) => {
        assert.ok(error instanceof ConfigValidationError, label)
        assert.equal((error as ConfigValidationError).code, 'AEH_CONFIG_INVALID')
        return true
      },
      label,
    )
  }
  // An omitted (or explicitly `undefined`) optional field is not an illegal
  // value: it takes the documented default.
  assert.equal(resolveAehConfig({ targetRetention: undefined }).targetRetention, 0.9)
})

test('the exported plugin Config is the Schemastery schema', () => {
  assert.equal(Config, AEH_CONFIG_SCHEMA)
  // The compiler rejects a wrong enum before `apply` is ever called.
  assert.throws(
    () => AEH_CONFIG_SCHEMA({ profile: 'teacher' } as never),
    /expected|profile|value/i,
  )
})

test('the service constructor validates config as well', () => {
  assert.throws(
    () => createEducationService({ targetRetention: 2 }, makeHost()),
    ConfigValidationError,
  )
})

interface LoadedApp {
  readonly root: Context
  readonly host: MemoryHostContext
  readonly entryId: string
  dispose(): Promise<void>
}

async function mountPlugin(config: Record<string, unknown>): Promise<LoadedApp> {
  const root = new Context()
  const prompt = root.plugin(SystemPrompt)
  await prompt
  const tools = root.plugin(ToolRuntime)
  await tools
  const loaderFiber = root.plugin(Loader, { baseUrl: import.meta.url })
  await loaderFiber
  const host = makeHost()
  try {
    const entryId = await root.loader.create({
      name: new URL('../src/index.ts', import.meta.url).href,
      config: { ...config, host: host.toHostBinding() },
    })
    await root.loader.await()
    return {
      root,
      host,
      entryId,
      async dispose() {
        try {
          root.loader.remove(entryId)
        } catch {
          // Already removed.
        }
        await root.loader.await()
        await loaderFiber.dispose()
        await tools.dispose()
        await prompt.dispose()
      },
    }
  } catch (error) {
    await loaderFiber.dispose()
    await tools.dispose()
    await prompt.dispose()
    throw error
  }
}

test('an illegal config fails loud and never partially mounts the plugin', async () => {
  // Cordis validates the exported `Config` schema before `apply` runs, so a
  // direct plugin registration rejects with `ValidationError`.
  const root = new Context()
  const prompt = root.plugin(SystemPrompt)
  await prompt
  const tools = root.plugin(ToolRuntime)
  await tools
  try {
    await assert.rejects(
      async () => {
        await root.plugin(aehPlugin, { targetRetention: 3 })
      },
      (error: unknown) => {
        assert.equal((error as Error).name, 'ValidationError')
        return true
      },
    )
    assert.equal(root.tools.schemas().length, 0)
  } finally {
    await tools.dispose()
    await prompt.dispose()
  }

  // The loader path fails closed too: the entry loads no tool at all.
  const app = await mountPlugin({ targetRetention: 3 })
  try {
    assert.equal(app.root.tools.schemas().length, 0)
  } finally {
    await app.dispose()
  }
})

function callTool(
  root: Context,
  name: string,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
  agent?: { readonly id: string },
) {
  return root.tools.execute({
    callId: `call.step7.${name}` as unknown as ToolCallId,
    name,
    arguments: args,
    signal,
    ...(agent === undefined ? {} : { agent: agent as never }),
  })
}

// ---------------------------------------------------------------------------
// 2. Closed output schemas
// ---------------------------------------------------------------------------

test('every tool publishes a closed object output schema', () => {
  assert.deepEqual(Object.keys(TOOL_OUTPUT_SCHEMAS).sort(), EXPECTED_TOOLS)
  for (const [name, schema] of Object.entries(TOOL_OUTPUT_SCHEMAS)) {
    assert.equal(schema.type, 'object', name)
    assert.equal(schema.additionalProperties, false, name)
  }
})

test('all six tools return schema-valid output through the real runtime', async () => {
  const app = await mountPlugin({})
  try {
    const results: Array<[string, unknown]> = [
      [
        'aeh_check_curriculum',
        { mode: 'learn', itemId: item.itemId, studentRef: STUDENT_REF },
      ],
      [
        'aeh_update_hypotheses',
        {
          state: { hypotheses: [], unknownWeight: 1 },
          operation: 'snapshot',
        },
      ],
      [
        'aeh_select_probe',
        {
          candidates: [{ itemId: item.itemId }],
          weights: { unknown: 1 },
          studentRef: STUDENT_REF,
          mode: 'learn',
        },
      ],
      [
        'aeh_schedule_review',
        {
          state: {
            learnerRef: STUDENT_REF,
            memoryUnitId: 'kc.fraction.add',
          },
          observations: [
            { observationId: 'obs.step7.1', success: true, independent: true },
          ],
        },
      ],
      [
        'aeh_prepare_intervention',
        {
          package: {
            packageId: 'pkg.step7.1',
            objectiveId: 'obj.fraction.add',
            trainingItemIds: [item.itemId],
            transferItemIds: [transferItem.itemId],
            requiredKcs: ['kc.fraction.add'],
          },
          studentRef: STUDENT_REF,
        },
      ],
      [
        'aeh_generate_report',
        {
          audience: 'teacher',
          studentRef: STUDENT_REF,
          windowStart: '2026-03-02T00:00:00Z',
          windowEnd: '2026-03-03T00:00:00Z',
          events: [],
        },
      ],
    ]
    for (const [name, args] of results) {
      const result = await callTool(app.root, name, args)
      assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`)
    }
    // The same tool with a real agent scope mints a snapshotRef, and that
    // scoped return must also satisfy the declared output schema.
    const scoped = await callTool(
      app.root,
      'aeh_update_hypotheses',
      { state: { hypotheses: [], unknownWeight: 1 }, operation: 'snapshot' },
      new AbortController().signal,
      { id: 'session.step7.scoped' },
    )
    assert.equal(scoped.isError, false, JSON.stringify(scoped))
  } finally {
    await app.dispose()
  }
})

test('dsh rejects an out-of-bounds tool return as INVALID_TOOL_OUTPUT', async () => {
  const root = new Context()
  const prompt = root.plugin(SystemPrompt)
  await prompt
  const tools = root.plugin(ToolRuntime)
  await tools
  try {
    const badTool = defineTool({
      name: 'aeh_step7_bad_output_fixture',
      description: 'Test-only fixture that violates its declared output schema.',
      parameters: {},
      output: { schema: reviewOutputSchema, render: renderJson },
      async execute() {
        return { nextIntervalDays: 'not-a-number' }
      },
    })
    root.tools.register(badTool as never)
    const result = await callTool(root, 'aeh_step7_bad_output_fixture', {})
    assert.equal(result.isError, true)
    assert.equal(result.error?.info?.code, 'INVALID_TOOL_OUTPUT')
  } finally {
    await tools.dispose()
    await prompt.dispose()
  }
})

// ---------------------------------------------------------------------------
// 3. Session/agent-scoped hypothesis snapshots
// ---------------------------------------------------------------------------

test('snapshots round-trip only for the exact session/agent scope', () => {
  const store = new SessionSnapshotStore()
  const stored = store.put({ sessionId: 's1', agentId: 'a1' }, snapshotInput)
  assert.equal(stored.sessionId, 's1')
  assert.equal(stored.agentId, 'a1')
  assert.equal(store.ttl, DEFAULT_SESSION_SNAPSHOT_TTL_MS)
  assert.equal(store.get(stored.snapshotRef, { sessionId: 's1', agentId: 'a1' }), stored)
  // A different session, or the same session under a different agent, cannot
  // adopt the snapshot.
  assert.equal(store.get(stored.snapshotRef, { sessionId: 's2', agentId: 'a1' }), undefined)
  assert.equal(store.get(stored.snapshotRef, { sessionId: 's1', agentId: 'a2' }), undefined)
  assert.equal(store.get('unknown-ref', { sessionId: 's1', agentId: 'a1' }), undefined)
})

test('TTL expiry and sweep remove snapshots without another session reading them', () => {
  let now = 1_000
  const store = new SessionSnapshotStore({ ttlMs: 50, now: () => now })
  const stored = store.put({ sessionId: 's1' }, snapshotInput)
  assert.equal(store.get(stored.snapshotRef, { sessionId: 's1' }), stored)
  now += 50
  assert.equal(store.get(stored.snapshotRef, { sessionId: 's1' }), undefined)
  assert.equal(store.size, 0)

  const second = store.put({ sessionId: 's2' }, snapshotInput)
  assert.equal(store.sweep(), 0)
  now += 51
  assert.equal(store.cleanupExpired(), 1)
  assert.equal(store.get(second.snapshotRef, { sessionId: 's2' }), undefined)

  store.put({ sessionId: 's3' }, snapshotInput)
  assert.equal(store.clear(), 1)
  assert.equal(store.size, 0)
  assert.equal(store.scopes(), 0)
})

test('session end clears every agent scope for that session only', () => {
  const store = new SessionSnapshotStore()
  const a = store.put({ sessionId: 's1', agentId: 'a1' }, snapshotInput)
  const b = store.put({ sessionId: 's1', agentId: 'a2' }, snapshotInput)
  const other = store.put({ sessionId: 's2' }, snapshotInput)
  assert.equal(store.endSession('s1'), 2)
  assert.equal(store.get(a.snapshotRef, { sessionId: 's1', agentId: 'a1' }), undefined)
  assert.equal(store.get(b.snapshotRef, { sessionId: 's1', agentId: 'a2' }), undefined)
  assert.equal(store.get(other.snapshotRef, { sessionId: 's2' }), other)
})

test('per-scope caps evict the oldest snapshot and blank scopes are rejected', () => {
  const store = new SessionSnapshotStore({ maxEntriesPerScope: 1 })
  const first = store.put({ sessionId: 's1' }, snapshotInput)
  const second = store.put({ sessionId: 's1' }, snapshotInput)
  assert.notEqual(first.snapshotRef, second.snapshotRef)
  assert.equal(store.size, 1)
  assert.equal(store.get(second.snapshotRef, { sessionId: 's1' }), second)
  assert.throws(() => store.put({ sessionId: '' }, snapshotInput), SessionScopeError)
  assert.throws(
    () => store.put({ sessionId: 's1', agentId: '\n' }, snapshotInput),
    SessionScopeError,
  )
})

test('scopeFromExecution only trusts a real agent/session id', () => {
  assert.deepEqual(scopeFromExecution({ agent: { id: 's1' } }), { sessionId: 's1' })
  assert.equal(scopeFromExecution({}), undefined)
  assert.equal(scopeFromExecution(undefined), undefined)
  assert.equal(scopeFromExecution({ agent: { id: '' } }), undefined)
})

test('the snapshot store has no write path into the long-term twin', () => {
  const twin = new StudentTwin(STUDENT_REF)
  const versionBefore = twin.version
  const evidenceBefore = twin.evidenceRevision
  const store = new SessionSnapshotStore()
  const stored = store.put({ sessionId: 's1' }, snapshotInput)
  store.get(stored.snapshotRef, { sessionId: 's1' })
  assert.equal(twin.version, versionBefore)
  assert.equal(twin.evidenceRevision, evidenceBefore)
  assert.equal(twin.observed().length, 0)
  assert.deepEqual(store.snapshot(), {
    entries: 1,
    scopes: 1,
    expired: 0,
    sessionScoped: true,
    longTermTwinWrite: false,
  })
})

test('attachSessionCleanup drops a session snapshot and audits the cleanup', () => {
  const store = new SessionSnapshotStore()
  const audit = new AehAuditLog()
  store.put({ sessionId: 's1' }, snapshotInput)
  const listeners: Array<(...args: unknown[]) => void> = []
  let detached = false
  const fakeCtx = {
    on(_event: string, listener: (...args: unknown[]) => void) {
      listeners.push(listener)
      return () => {
        detached = true
      }
    },
  } as unknown as Context

  const detach = attachSessionCleanup(fakeCtx, store, audit)
  assert.equal(listeners.length, 1)
  assert.equal(store.size, 1)
  listeners[0]({ id: 's1' })
  assert.equal(store.size, 0)
  const cleanups = audit.entries({ kind: 'session.cleanup' })
  assert.equal(cleanups.length, 1)
  assert.equal(cleanups[0].outcome, 'accepted')
  assert.equal(cleanups[0].detail.removed, 1)
  detach()
  assert.equal(detached, true)
})

test('the hypothesis tool stores and loads snapshots only for one session', async () => {
  const host = makeHost()
  const service = createEducationService({}, host)
  const snapshots = new SessionSnapshotStore()
  const tools = createEducationTools(service, { snapshots })
  const hypothesisTool = tools.find(
    (tool) => tool.name === 'aeh_update_hypotheses',
  )
  assert.ok(hypothesisTool)

  const first = (await hypothesisTool.execute(
    { state: { hypotheses: [], unknownWeight: 1 }, operation: 'snapshot' },
    { agent: { id: 'session.a' } },
  )) as { snapshotRef?: string; snapshotScope?: unknown }
  assert.ok(typeof first.snapshotRef === 'string')

  // Same session can resume from the reference.
  const resumed = await hypothesisTool.execute(
    { snapshotRef: first.snapshotRef, operation: 'snapshot' },
    { agent: { id: 'session.a' } },
  )
  assert.ok(resumed)

  // A different session cannot read it.
  await assert.rejects(
    () =>
      hypothesisTool.execute(
        { snapshotRef: first.snapshotRef, operation: 'snapshot' },
        { agent: { id: 'session.b' } },
      ),
    HypothesisError,
  )

  // Without an execution scope the tool never mints a reference.
  const scoped = (await hypothesisTool.execute({
    state: { hypotheses: [], unknownWeight: 1 },
    operation: 'snapshot',
  })) as { snapshotRef?: string }
  assert.equal(scoped.snapshotRef, undefined)
})

// ---------------------------------------------------------------------------
// 4. Append-only, pseudonymised audit log
// ---------------------------------------------------------------------------

test('the audit log is append-only and has the documented event kinds', () => {
  const audit = new AehAuditLog()
  assert.deepEqual([...AUDIT_EVENT_KINDS], [
    'gate.decision',
    'tool.call',
    'approval.record',
    'delivery.receipt',
    'session.cleanup',
  ])
  audit.append({ kind: 'tool.call', action: 'aeh.check', outcome: 'accepted' })
  assert.equal(audit.size, 1)
  assert.equal(
    typeof (audit as unknown as { delete?: unknown }).delete,
    'undefined',
  )
  assert.equal(
    typeof (audit as unknown as { update?: unknown }).update,
    'undefined',
  )
  assert.throws(
    () => audit.append({ kind: 'nope' as never, action: 'x', outcome: 'accepted' }),
    AuditError,
  )
  assert.throws(
    () =>
      audit.append({
        kind: 'tool.call',
        action: 'x',
        outcome: 'maybe' as never,
      }),
    AuditError,
  )
})

test('the audit log refuses raw student content at any depth', () => {
  const audit = new AehAuditLog()
  assert.throws(
    () =>
      audit.append({
        kind: 'tool.call',
        action: 'aeh.check',
        outcome: 'accepted',
        detail: { rawAnswer: 'x = 4' },
      }),
    AuditError,
  )
  assert.throws(
    () =>
      audit.append({
        kind: 'tool.call',
        action: 'aeh.check',
        outcome: 'accepted',
        detail: { nested: { answer: 'x = 4' } as never },
      }),
    AuditError,
  )
  assert.throws(
    () =>
      audit.append({
        kind: 'tool.call',
        action: 'aeh.check',
        outcome: 'accepted',
        detail: { blob: { not: 'scalar' } as never },
      }),
    AuditError,
  )
})

test('gate refusals, tool calls, approvals, and delivery receipts are audited', () => {
  const audit = new AehAuditLog({ salt: 'synthetic-audit-salt' })
  const host = makeHost()
  const service = createEducationService({}, host)
  const tools = createEducationTools(service, { audit })
  const gate = tools.find((tool) => tool.name === 'aeh_check_curriculum')
  assert.ok(gate)

  audit.recordGateDecision({
    studentRef: STUDENT_REF,
    tenantRef: TENANT_ID,
    itemId: 'item.not.in.catalog',
    mode: 'learn',
    allowed: false,
    reasons: ['item_not_found'],
  })
  const refusal = audit.entries({ kind: 'gate.decision' })[0]
  assert.equal(refusal.outcome, 'rejected')
  assert.deepEqual(refusal.reasonCodes, ['item_not_found'])
  assert.deepEqual(refusal.detail, {
    itemId: 'item.not.in.catalog',
    mode: 'learn',
    refusalCount: 1,
  })

  audit.recordToolCall({
    tool: 'aeh_check_curriculum',
    outcome: 'accepted',
    studentRef: STUDENT_REF,
    tenantRef: TENANT_ID,
  })
  const toolCall = audit.entries({ kind: 'tool.call' })[0]
  assert.equal(toolCall.action, 'aeh_check_curriculum')
  assert.deepEqual(toolCall.detail, {})

  const ledger = new ApprovalLedger({ audit, tenantRef: TENANT_ID })
  const delivery = new HostDeliveryAdapter({
    host,
    service,
    approvals: ledger,
    consent: host.consent,
    now: () => '2026-03-02T10:00:00.000Z',
    audit,
  })
  ledger.append({
    approvalId: 'approval.step7.1',
    packageId: 'pkg.step7.1',
    studentRef: STUDENT_REF,
    approvedBy: 'synthetic.teacher.001',
    approvedAt: '2026-03-02T09:59:00.000Z',
    decision: 'approved',
    scope: 'intervention:deliver',
  })
  assert.equal(audit.entries({ kind: 'approval.record' }).length, 1)

  const input = {
    packageId: 'pkg.step7.1',
    objectiveId: 'obj.fraction.add',
    trainingItemIds: [item.itemId],
    transferItemIds: [transferItem.itemId],
    hintLadder: ['nudge'],
    completionCriteria: { independentCorrect: 1 },
    requiredKcs: ['kc.fraction.add'],
    schoolMode: 'learn' as const,
  }
  const receipt = delivery.deliver(input, 'approval.step7.1')
  assert.equal(receipt.externalEffect, false)
  // Replaying the same approval must not emit a second accepted receipt.
  delivery.deliver(input, 'approval.step7.1')
  const accepted = audit
    .entries({ kind: 'delivery.receipt' })
    .filter((entry) => entry.outcome === 'accepted')
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].detail.approvalId, 'approval.step7.1')
  assert.equal(accepted[0].detail.itemCount, 2)

  assert.throws(
    () => delivery.deliver(input, 'approval.missing'),
    /approval record not found/,
  )
  assert.ok(
    audit
      .entries({ kind: 'delivery.receipt' })
      .some((entry) => entry.outcome === 'rejected'),
  )
})

test('audit metrics carry only pseudonymous student/tenant keys', () => {
  const audit = new AehAuditLog({ salt: 'synthetic-audit-salt' })
  const record = audit.append({
    kind: 'tool.call',
    action: 'aeh.check_curriculum',
    outcome: 'accepted',
    studentRef: STUDENT_REF,
    tenantRef: TENANT_ID,
  })
  assert.notEqual(record.studentKey, STUDENT_REF)
  assert.notEqual(record.tenantKey, TENANT_ID)
  assert.equal(typeof record.studentKey, 'string')
  assert.equal(typeof record.tenantKey, 'string')

  const metrics = audit.metrics()
  assert.equal(metrics.total, 1)
  assert.equal(metrics.byKind['tool.call'], 1)
  assert.equal(metrics.byOutcome.accepted, 1)
  assert.deepEqual(Object.keys(metrics.byStudentKey), [record.studentKey])
  assert.deepEqual(Object.keys(metrics.byTenantKey), [record.tenantKey])
  const serialised = JSON.stringify({ records: audit.entries(), metrics })
  assert.equal(serialised.includes(STUDENT_REF), false)
  assert.equal(serialised.includes(TENANT_ID), false)
})

test('audit capacity is fail-loud and never silently drops records', () => {
  const audit = new AehAuditLog({ maxEntries: 1 })
  audit.append({ kind: 'tool.call', action: 'a', outcome: 'accepted' })
  assert.throws(
    () => audit.append({ kind: 'tool.call', action: 'b', outcome: 'accepted' }),
    /capacity exceeded/,
  )
  assert.equal(audit.size, 1)
})

test('the plugin audit wrapper records accepted and rejected tool calls', async () => {
  const audit = new AehAuditLog()
  const host = makeHost()
  const service = createEducationService({}, host)
  const tools = createEducationTools(service, { audit })
  const gate = tools.find((tool) => tool.name === 'aeh_check_curriculum')
  const hypothesis = tools.find(
    (tool) => tool.name === 'aeh_update_hypotheses',
  )
  assert.ok(gate)
  assert.ok(hypothesis)

  await gate.execute({
    mode: 'learn',
    itemId: item.itemId,
    studentRef: STUDENT_REF,
  })
  await assert.rejects(() =>
    hypothesis.execute({ operation: 'snapshot' }),
  )
  const calls = audit.entries({ kind: 'tool.call' })
  assert.deepEqual(
    calls.map((entry) => [entry.action, entry.outcome] as const),
    [
      ['aeh_check_curriculum', 'accepted'],
      ['aeh_update_hypotheses', 'rejected'],
    ],
  )
  // The audit record has no argument payload at all.
  assert.equal(JSON.stringify(calls).includes('item.fraction.add.001'), false)
})

test('apply() builds an isolated plugin context with audit and snapshots', async () => {
  // A structural Context double: no real dsh services, but the same effect and
  // registration call shape the plugin uses.
  const registered: unknown[] = []
  const effects: Array<() => void> = []
  const fakeCtx = {
    effect(fn: () => (() => void) | void) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    tools: {
      register(tool: unknown) {
        registered.push(tool)
        return () => {}
      },
    },
  } as unknown as Context

  apply(fakeCtx, { host: makeHost().toHostBinding() })
  assert.equal(registered.length, 6)
  for (const dispose of effects.reverse()) dispose()
})
