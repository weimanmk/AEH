/**
 * Real-runtime contract tests.
 *
 * Unlike `invariants.test.ts` (offline unit doubles), this file drives a
 * completely isolated Cordis application:
 *
 *   - its own `Context`, `SystemPrompt`, dsh `ToolRuntime`, timeout policy, and
 *     `cordis-plugin-loader` `Loader`;
 *   - the plugin is mounted by the real loader from this package's entry file,
 *     not called by hand;
 *   - every call goes through `ctx.tools.execute`, so dsh owns schema
 *     compilation, argument validation, cancellation, and timeout mapping.
 *
 * No `~/.dsh` config, storage, npx install, or running harness session is
 * touched. All student references are synthetic.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Context, type Fiber } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineTool as defineDshTool,
  TOOL_ABORTED_BEFORE_DISPATCH,
} from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'

import { MemoryHostContext } from '../src/host/host-context.ts'
import { ConsentSnapshot } from '../src/host/consent.ts'
import { AEH_TOOL_TIMEOUT_MS } from '../src/tools.ts'
import type { CurriculumItem, LearnerProgress } from '../src/domain.ts'

const STUDENT_REF = 'synthetic.student.001'
const EXPECTED_TOOLS = [
  'aeh_check_curriculum',
  'aeh_prepare_intervention',
  'aeh_schedule_review',
  'aeh_select_probe',
  'aeh_update_hypotheses',
]

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

function makeConsent(): ConsentSnapshot {
  return ConsentSnapshot.granted(['curriculum:read'])
}

function makeHost(consent: ConsentSnapshot): MemoryHostContext {
  return new MemoryHostContext({
    session: {
      sessionId: 'session.contract.001',
      tenantId: 'tenant.contract.001',
      studentRef: STUDENT_REF,
    },
    consent,
    progress: [progress],
    catalog: [item],
  })
}

interface IsolatedApp {
  readonly root: Context
  readonly loaderFiber: Fiber
  readonly entryId: string
  readonly host: MemoryHostContext
  readonly consent: ConsentSnapshot
  dispose(): Promise<void>
}

/**
 * Build a fresh, isolated Cordis app and mount the AEH plugin through the real
 * loader. Nothing is read from or written to the user's dsh installation.
 */
async function buildIsolatedApp(): Promise<IsolatedApp> {
  const root = new Context()
  const systemPrompt = root.plugin(SystemPrompt)
  await systemPrompt
  const tools = root.plugin(ToolRuntime)
  await tools
  const policy = root.plugin(timeoutPolicy)
  await policy
  const loaderFiber = root.plugin(Loader, { baseUrl: import.meta.url })
  await loaderFiber

  const consent = makeConsent()
  const host = makeHost(consent)
  const entryId = await root.loader.create({
    name: new URL('../src/index.ts', import.meta.url).href,
    // The loader only carries plain data properties, so bind the adapter
    // explicitly; the closures still observe consent revocation.
    config: { host: host.toHostBinding() },
  })
  await root.loader.await()

  return {
    root,
    loaderFiber,
    entryId,
    host,
    consent,
    async dispose() {
      try {
        root.loader.remove(entryId)
      } catch {
        // Already removed by the test body; unloading is idempotent.
      }
      await root.loader.await()
      await loaderFiber.dispose()
      await policy.dispose()
      await tools.dispose()
      await systemPrompt.dispose()
    },
  }
}

function call(
  app: IsolatedApp,
  name: string,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
) {
  return app.root.tools.execute({
    callId: 'call.contract' as unknown as ToolCallId,
    name,
    arguments: args,
    signal,
  })
}

test('real Cordis loader mounts the plugin and dsh compiles the published schemas', async () => {
  const app = await buildIsolatedApp()
  try {
    const schemas = app.root.tools.schemas()
    assert.deepEqual(
      schemas.map((schema) => schema.name).sort(),
      EXPECTED_TOOLS,
    )

    const gate = schemas.find((schema) => schema.name === 'aeh_check_curriculum')
    assert.ok(gate)
    const parameters = gate.parameters as {
      type: string
      required: string[]
      properties: Record<string, { enum?: string[] }>
    }
    assert.equal(parameters.type, 'object')
    assert.deepEqual(parameters.required, ['mode', 'itemId', 'studentRef'])
    assert.deepEqual(parameters.properties.mode.enum, [
      'preview',
      'learn',
      'review',
    ])

    // The declared cooperative budget reaches the runtime definition but is not
    // leaked into the model-facing schema.
    assert.equal(
      app.root.tools.get('aeh_check_curriculum')?.timeoutMs,
      AEH_TOOL_TIMEOUT_MS,
    )
    assert.equal('timeoutMs' in gate, false)
  } finally {
    await app.dispose()
  }
})

test('dsh runtime rejects malformed arguments before the tool body runs', async () => {
  const app = await buildIsolatedApp()
  try {
    const badEnum = await call(app, 'aeh_check_curriculum', {
      mode: 'practice',
      itemId: item.itemId,
      studentRef: STUDENT_REF,
    })
    assert.equal(badEnum.isError, true)
    assert.equal(badEnum.error?.info?.code, 'INVALID_ARGS')

    const missingField = await call(app, 'aeh_check_curriculum', {
      mode: 'learn',
      itemId: item.itemId,
    })
    assert.equal(missingField.isError, true)
    assert.equal(missingField.error?.info?.code, 'INVALID_ARGS')

    // The parameter object is open, so extra fields are accepted — but the
    // tool body reads only (mode, itemId, studentRef), and the host catalog
    // still decides. Inline annotations cannot unlock an unknown item.
    const smuggled = await call(app, 'aeh_check_curriculum', {
      mode: 'learn',
      itemId: 'item.not.in.catalog',
      studentRef: STUDENT_REF,
      safetyChecked: true,
      contentVerified: true,
      annotationConfidence: 0.99,
      taughtKcs: ['kc.fraction.add'],
    })
    assert.equal(smuggled.isError, false)
    assert.deepEqual(
      (smuggled.value as { reasons: string[] }).reasons,
      ['item_not_found'],
    )
  } finally {
    await app.dispose()
  }
})

test('authorised host resolution allows the gate; another student and revoked consent fail closed', async () => {
  const app = await buildIsolatedApp()
  try {
    const allowed = await call(app, 'aeh_check_curriculum', {
      mode: 'learn',
      itemId: item.itemId,
      studentRef: STUDENT_REF,
    })
    assert.equal(allowed.isError, false)
    assert.equal((allowed.value as { allowed: boolean }).allowed, true)

    const otherStudent = await call(app, 'aeh_check_curriculum', {
      mode: 'learn',
      itemId: item.itemId,
      studentRef: 'synthetic.student.999',
    })
    assert.equal(otherStudent.isError, false)
    assert.deepEqual(
      (otherStudent.value as { reasons: string[] }).reasons,
      ['progress_unavailable'],
    )

    app.consent.revoke('curriculum:read')
    const revoked = await call(app, 'aeh_check_curriculum', {
      mode: 'learn',
      itemId: item.itemId,
      studentRef: STUDENT_REF,
    })
    assert.equal(revoked.isError, false)
    assert.deepEqual(
      (revoked.value as { reasons: string[] }).reasons,
      ['progress_unavailable'],
    )
  } finally {
    await app.dispose()
  }
})

test('caller cancellation is forwarded to the tool as ABORTED_BEFORE_DISPATCH', async () => {
  const app = await buildIsolatedApp()
  try {
    const controller = new AbortController()
    controller.abort()
    const result = await call(
      app,
      'aeh_check_curriculum',
      { mode: 'learn', itemId: item.itemId, studentRef: STUDENT_REF },
      controller.signal,
    )
    assert.equal(result.isError, true)
    assert.equal(result.error?.info?.code, TOOL_ABORTED_BEFORE_DISPATCH)
  } finally {
    await app.dispose()
  }
})

test('declared cooperative timeout is enforced by the dsh timeout policy', async () => {
  const app = await buildIsolatedApp()
  try {
    const slow = defineDshTool({
      name: 'aeh_contract_slow_fixture',
      description: 'Test-only fixture that exceeds its declared budget.',
      timeoutMs: 20,
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return { done: true }
      },
    })
    app.root.tools.register(slow)

    const timedOut = await call(app, 'aeh_contract_slow_fixture', {})
    assert.equal(timedOut.isError, true)
    assert.equal(timedOut.error?.info?.code, 'TOOL_TIMEOUT')

    // The AEH tools declare the same cooperative budget.
    assert.equal(
      app.root.tools.get('aeh_schedule_review')?.timeoutMs,
      AEH_TOOL_TIMEOUT_MS,
    )
  } finally {
    await app.dispose()
  }
})

test('loader unload removes every registered tool', async () => {
  const app = await buildIsolatedApp()
  try {
    assert.equal(app.root.tools.schemas().length, EXPECTED_TOOLS.length)
    app.root.loader.remove(app.entryId)
    await app.root.loader.await()
    assert.equal(app.root.tools.schemas().length, 0)
    assert.equal(app.root.tools.get('aeh_check_curriculum'), undefined)
  } finally {
    await app.dispose()
  }
})
