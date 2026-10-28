/**
 * 前端核心行为验证（Node 24 可直接跑）：
 *
 *   node scripts/check-core-behaviors.mjs
 *
 * 直接加载与 UI 相同的 TS 模块（frontend/src/lib + dsh-plugin/src），
 * 不 mock 核心算法。断言四件事：
 *   1. 门禁拒绝含未授 KC 的题目，并给出原因；
 *   2. 一次复习后 FSRS 重算的下次间隔确实变化；
 *   3. 有缺口的学生至少能得到一个通过门禁的 probe；
 *   4. 撤销同意后，聚合报告自动排除该学生。
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./ts-resolve-hooks.mjs', import.meta.url), import.meta.url)

const core = await import('../src/lib/core.ts')
const behavior = await import('../src/lib/behavior.ts')
const storeModule = await import('../src/lib/store.ts')
const reporting = await import('../src/lib/reporting.ts')

const pass = (message, detail = '') => {
  console.log(`PASS ${message}${detail === '' ? '' : ` — ${detail}`}`)
}

const now = new Date().toISOString()

// ---------------------------------------------------------------------------
// 1. 门禁拒绝未授 KC（含原因）
// ---------------------------------------------------------------------------
storeModule.resetToSynthetic()
let store = storeModule.getStore()
const studentRef = store.students[0]?.ref
assert.ok(studentRef, '预置示例应至少有一名学生')
const untaughtItem = store.items.find(
  (item) => item.requiredKcs.includes('kc.fraction.multiply'),
)
assert.ok(untaughtItem, '预置示例应包含含未授 KC 的候选题')
const gate = behavior.gateForItem(
  store,
  studentRef,
  untaughtItem.id,
  'learn',
)
assert.ok(gate, '门禁应能对候选题作出判断')
assert.equal(gate.decision.allowed, false, '未授 KC 的题必须被拒绝')
assert.ok(
  gate.decision.reasons.some((reason) =>
    reason.includes('kc.fraction.multiply'),
  ),
  `拒绝原因必须点名未授 KC，实际：${gate.decision.reasons.join(',')}`,
)
pass(
  '门禁拒绝未授 KC',
  `${untaughtItem.id} → ${gate.decision.reasons.join(', ')}`,
)

// ---------------------------------------------------------------------------
// 2. 一次复习后 FSRS 下次时间变化
// ---------------------------------------------------------------------------
const kcId = 'kc.fraction.equiv'
const beforeView = behavior.buildStudentTwin(store, studentRef, now)
const beforeState = beforeView.twin.memoryFor(kcId)
assert.ok(beforeState, '预置学生应有该 KC 的记忆状态')
const params = new core.MemoryParameters()
const priorInterval = params.nextIntervalDays(
  beforeState.stabilityDays,
  beforeState.difficulty,
  0.9,
)
const review = storeModule.recordReview({
  studentRef,
  kcId,
  itemId:
    store.items.find((item) => item.requiredKcs.includes(kcId))?.id ?? null,
  success: true,
  independent: true,
  hintLevel: 0,
  occurredAt: now,
})
assert.equal(review.ok, true, `记录复习应成功：${review.ok ? '' : review.error}`)
if (!review.ok) process.exit(1)
assert.ok(
  review.value.nextIntervalDays > priorInterval,
  `独立成功后的间隔应大于复习前（${review.value.nextIntervalDays} vs ${priorInterval}）`,
)
assert.ok(
  Date.parse(review.value.nextDueAt) > Date.parse(now),
  '下次到期时间必须在本次复习之后',
)
store = storeModule.getStore()
const afterView = behavior.buildStudentTwin(store, studentRef, now)
const dueAfter = behavior.dueReviewsForTwin(afterView.twin, now)
assert.equal(
  dueAfter.some((entry) => entry.kcId === kcId),
  false,
  '刚复习的 KC 不应仍在到期队列中',
)
pass(
  '复习后 FSRS 下次时间变化',
  `${priorInterval.toFixed(3)} 天 → ${review.value.nextIntervalDays.toFixed(3)} 天（${review.value.nextDueAt}）`,
)

// ---------------------------------------------------------------------------
// 3. 有缺口的学生至少有一个 probe
// ---------------------------------------------------------------------------
const gapView = behavior.buildStudentTwin(store, studentRef, now)
assert.ok(
  gapView.weakKcs.length > 0,
  '预置学生应有进行中/失败证据形成的缺口',
)
const diagnosis = behavior.diagnosisForStudent(store, studentRef, gapView)
assert.ok(diagnosis.best, '有缺口的学生应至少得到一个通过门禁的 probe')
assert.equal(
  diagnosis.best.decision.allowed,
  true,
  '被选中的 probe 必须通过门禁',
)
pass(
  '诊断产生 probe',
  `best=${diagnosis.best.item.id}，候选 ${diagnosis.candidates.length}，通过门禁 ${
    diagnosis.candidates.filter((entry) => entry.decision.allowed).length
  }`,
)

// ---------------------------------------------------------------------------
// 4. 撤销同意后聚合报告排除该学生
// ---------------------------------------------------------------------------
const consentStudent = 'stu_consent_case'
const added = storeModule.addStudent(consentStudent, 5)
assert.equal(added.ok, true, `新增学生应成功：${added.ok ? '' : added.error}`)
storeModule.setConsent(consentStudent, true, '测试同意')
const consentReview = storeModule.recordReview({
  studentRef: consentStudent,
  kcId,
  itemId:
    store.items.find((item) => item.requiredKcs.includes(kcId))?.id ?? null,
  success: true,
  independent: true,
  hintLevel: 0,
  occurredAt: now,
})
assert.equal(
  consentReview.ok,
  true,
  `撤销同意前应能记录复习：${consentReview.ok ? '' : consentReview.error}`,
)

store = storeModule.getStore()
const reportBefore = reporting.buildAggregateReport(store, now)
assert.equal(
  reporting.reportIncludesStudent(reportBefore, consentStudent),
  true,
  '撤销同意前该学生应进入报告',
)
assert.ok(
  reportBefore.included.some((entry) => entry.studentRef === studentRef),
  '预置学生应进入报告',
)

storeModule.setConsent(consentStudent, false, '验证撤销同意')
store = storeModule.getStore()
const reportAfter = reporting.buildAggregateReport(store, now)
assert.equal(
  reporting.reportIncludesStudent(reportAfter, consentStudent),
  false,
  '撤销同意后该学生必须被报告排除',
)
assert.ok(
  reportAfter.excluded.some(
    (entry) =>
      entry.studentRef === consentStudent &&
      entry.reason.includes('撤销'),
  ),
  '排除原因应说明同意已撤销',
)
assert.equal(
  reportAfter.totals.attempts,
  reportBefore.totals.attempts - 1,
  '撤销同意后该学生的聚合尝试不应计入总数',
)
pass(
  '聚合报告排除撤销同意的学生',
  `${consentStudent} 已排除；attempts ${reportBefore.totals.attempts} → ${reportAfter.totals.attempts}`,
)

console.log('ALL_CORE_BEHAVIORS_PASS')
