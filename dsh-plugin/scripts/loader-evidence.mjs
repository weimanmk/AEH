/**
 * Step 4 loader evidence (isolated, synthetic only).
 *
 * Builds a private Cordis application, mounts this plugin through the real
 * `@deepseek-ai/cordis-plugin-loader` Loader, and drives tool calls through the
 * dsh `ToolRuntime` so schema validation, cancellation, timeout, and unload are
 * exercised by the runtime rather than by hand.
 *
 * It never reads `~/.dsh`, the npx dsh install, or the running harness session,
 * and it never writes to them. Run it with:
 *
 *   npm run evidence:loader
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineTool,
  TOOL_ABORTED_BEFORE_DISPATCH,
} from '@deepseek-ai/dsh-tools'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'

import { MemoryHostContext } from '../src/host/host-context.ts'
import { ConsentSnapshot } from '../src/host/consent.ts'

const require = createRequire(import.meta.url)
const packageVersion = (name) =>
  require(`@deepseek-ai/${name}/package.json`).version

const STUDENT_REF = 'synthetic.student.001'
const ITEM_ID = 'item.fraction.add.001'

const progress = {
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

const item = {
  itemId: ITEM_ID,
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

const consent = ConsentSnapshot.granted(['curriculum:read'])
const host = new MemoryHostContext({
  session: {
    sessionId: 'session.evidence.001',
    tenantId: 'tenant.evidence.001',
    studentRef: STUDENT_REF,
  },
  consent,
  progress: [progress],
  catalog: [item],
})

const log = (label, value) => console.log(`- ${label}: ${value}`)

console.log('AEH Step 4+5 isolated Cordis/dsh loader evidence')
log('node', process.version)
log('@deepseek-ai/cordis', packageVersion('cordis'))
log('@deepseek-ai/dsh-tools', packageVersion('dsh-tools'))
log('@deepseek-ai/cordis-plugin-loader', packageVersion('cordis-plugin-loader'))

const root = new Context()
const systemPrompt = root.plugin(SystemPrompt)
await systemPrompt
const tools = root.plugin(ToolRuntime)
await tools
const policy = root.plugin(timeoutPolicy)
await policy
const loaderFiber = root.plugin(Loader, { baseUrl: import.meta.url })
await loaderFiber

const entryId = await root.loader.create({
  name: new URL('../src/index.ts', import.meta.url).href,
  config: { host: host.toHostBinding() },
})
await root.loader.await()
log('loader entry', entryId)

const schemaNames = root.tools
  .schemas()
  .map((schema) => schema.name)
  .sort()
log('mounted tools', schemaNames.join(', '))
assert.deepEqual(schemaNames, [
  'aeh_check_curriculum',
  'aeh_generate_report',
  'aeh_prepare_intervention',
  'aeh_schedule_review',
  'aeh_select_probe',
  'aeh_update_hypotheses',
])

const invoke = (name, args, signal = new AbortController().signal) =>
  root.tools.execute({ callId: 'evidence.call', name, arguments: args, signal })

const allowed = await invoke('aeh_check_curriculum', {
  mode: 'learn',
  itemId: ITEM_ID,
  studentRef: STUDENT_REF,
})
assert.equal(allowed.isError, false)
log('authorised gate decision', JSON.stringify(allowed.value))
assert.equal(allowed.value.allowed, true)

const report = await invoke('aeh_generate_report', {
  audience: 'teacher',
  studentRef: STUDENT_REF,
  windowStart: '2026-03-02T00:00:00Z',
  windowEnd: '2026-03-03T00:00:00Z',
  events: [
    {
      aggregateRef: 'agg.evidence.001',
      studentRef: STUDENT_REF,
      occurredAt: '2026-03-02T09:00:00Z',
      kind: 'attempt_aggregate',
      consentScope: 'educational_report',
      kcId: 'kc.fraction.add',
      attempts: 2,
      independentCorrect: 1,
      hintsRequested: 1,
      minutes: 4,
    },
  ],
})
assert.equal(report.isError, false)
log('report data-minimization', JSON.stringify(report.value.data_minimization))
assert.equal(report.value.data_minimization.event_refs_included, false)

const badArgs = await invoke('aeh_check_curriculum', {
  mode: 'practice',
  itemId: ITEM_ID,
  studentRef: STUDENT_REF,
})
assert.equal(badArgs.isError, true)
log('invalid-argument code', badArgs.error.info.code)

const controller = new AbortController()
controller.abort()
const aborted = await invoke(
  'aeh_check_curriculum',
  { mode: 'learn', itemId: ITEM_ID, studentRef: STUDENT_REF },
  controller.signal,
)
assert.equal(aborted.isError, true)
log('cancellation code', aborted.error.info.code)
assert.equal(aborted.error.info.code, TOOL_ABORTED_BEFORE_DISPATCH)

const slow = defineTool({
  name: 'aeh_evidence_slow_fixture',
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
const disposeSlow = root.tools.register(slow)
const timedOut = await invoke('aeh_evidence_slow_fixture', {})
assert.equal(timedOut.isError, true)
log('timeout code', timedOut.error.info.code)
assert.equal(timedOut.error.info.code, 'TOOL_TIMEOUT')

// Remove the test-only fixture so the unload check measures loader cleanup only.
disposeSlow()
root.loader.remove(entryId)
await root.loader.await()
const remaining = root.tools.schemas().length
log('tools after unload', remaining)
assert.equal(remaining, 0)
assert.equal(root.tools.get('aeh_check_curriculum'), undefined)

await loaderFiber.dispose()
await policy.dispose()
await tools.dispose()
await systemPrompt.dispose()
console.log('OK: loader mount, dsh schema validation, cancellation, timeout, and unload verified in isolation.')
