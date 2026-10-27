/**
 * Aggregate report boundary tests (synthetic/test only).
 *
 * These pin the Step 2 `aeh/report.py` policy in the TypeScript tool path:
 * fixed aggregate fields only, audience-scope narrowing, student/window/consent
 * exclusion, de-duplication by opaque aggregate ref, and no refs or raw data in
 * the rendered report.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIENCE_GUARDIAN,
  AUDIENCE_TEACHER,
  generateReport,
  effectiveScopes,
  reportToDict,
  reportToMarkdown,
  ReportError,
  type AggregateEventInput,
} from '../src/report.ts'
import { createEducationTools } from '../src/tools.ts'
import { createEducationService } from '../src/service.ts'

const STUDENT = 'synthetic.student.001'
const OTHER_STUDENT = 'synthetic.student.999'
const KC = 'kc.fraction.add'
const KC_OTHER = 'kc.fraction.equiv'
const START = '2026-03-02T00:00:00Z'
const END = '2026-03-03T00:00:00Z'
const AT = '2026-03-02T08:00:00Z'

function makeEvent(
  overrides: Partial<AggregateEventInput> = {},
): AggregateEventInput {
  return {
    aggregateRef: 'agg.authorized.1',
    studentRef: STUDENT,
    occurredAt: AT,
    kind: 'attempt_aggregate',
    consentScope: 'educational_report',
    kcId: KC,
    attempts: 2,
    independentCorrect: 1,
    hintedCorrect: 0,
    hintsRequested: 1,
    reviewsDue: 0,
    reviewsCompleted: 0,
    minutes: 4,
    ...overrides,
  }
}

function report(events: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return generateReport(events, {
    audience: AUDIENCE_TEACHER,
    studentRef: STUDENT,
    windowStart: START,
    windowEnd: END,
    generatedAt: AT,
    ...overrides,
  })
}

test('aggregate events reject raw fields instead of ignoring them', () => {
  assert.throws(
    () => report([{ ...makeEvent(), rawAnswer: 'x = 4' }]),
    /unsupported field/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), payload: { image: 'synthetic://x' } }]),
    /unsupported field/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), aggregateRef: 'has space' }]),
    /short identifier/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), kcId: 'line\nbreak' }]),
    /curriculum label/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), occurredAt: '2026-03-02T08:00:00' }]),
    /UTC offset/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), kind: 'raw_attempt' }]),
    /unsupported aggregate kind/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), attempts: 1, independentCorrect: 2 }]),
    /cannot exceed attempts/,
  )
  assert.throws(
    () => report([{ ...makeEvent(), minutes: -1 }]),
    /finite number/,
  )
})

test('only authorised events for this student and window are aggregated', () => {
  const result = report([
    makeEvent({ aggregateRef: 'agg.auth.1' }),
    makeEvent({
      aggregateRef: 'agg.auth.2',
      consentScope: 'teacher_report',
      kcId: KC_OTHER,
      attempts: 3,
      independentCorrect: 2,
      hintsRequested: 0,
      minutes: 5,
    }),
    makeEvent({ aggregateRef: 'agg.guardian', consentScope: 'guardian_report' }),
    makeEvent({ aggregateRef: 'agg.research', consentScope: 'research_only' }),
    makeEvent({ aggregateRef: 'agg.other.student', studentRef: OTHER_STUDENT }),
    makeEvent({ aggregateRef: 'agg.outside', occurredAt: END }),
    // Same ref as agg.auth.1: de-duplicated, never double counted.
    makeEvent({ aggregateRef: 'agg.auth.1', kcId: KC_OTHER, attempts: 99 }),
  ])

  assert.equal(result.eventsUsed, 2)
  assert.equal(result.eventsExcluded, 5)
  assert.equal(result.totals.attempts, 5)
  assert.equal(result.totals.independentCorrect, 3)
  assert.deepEqual(
    result.topics.map((topic) => topic.kcId),
    [KC, KC_OTHER],
  )
  assert.equal(JSON.stringify(reportToDict(result)).includes('99'), false)
})

test('caller scopes can only narrow the audience default', () => {
  const narrowed = report(
    [
      makeEvent({ aggregateRef: 'agg.edu', consentScope: 'educational_report' }),
      makeEvent({ aggregateRef: 'agg.teacher', consentScope: 'teacher_report' }),
    ],
    { authorizedScopes: ['teacher_report'] },
  )
  assert.equal(narrowed.eventsUsed, 1)
  assert.equal(narrowed.eventsExcluded, 1)
  assert.deepEqual(narrowed.authorizedScopes, ['teacher_report'])

  // A guardian cannot be widened to a teacher-only scope.
  assert.deepEqual(effectiveScopes(AUDIENCE_GUARDIAN, ['teacher_report']), [])
})

test('attention flags and rates are aggregate only', () => {
  const result = report([
    makeEvent({
      attempts: 4,
      independentCorrect: 1,
      hintedCorrect: 1,
      hintsRequested: 3,
      reviewsDue: 2,
      reviewsCompleted: 1,
      minutes: 12,
    }),
  ])
  const dict = reportToDict(result) as {
    topics: Array<{
      independent_accuracy: number
      hints_per_attempt: number
      review_completion_rate: number
      attention_reasons: string[]
    }>
  }
  const topic = dict.topics[0]
  assert.equal(topic.independent_accuracy, 0.25)
  assert.equal(topic.hints_per_attempt, 0.75)
  assert.equal(topic.review_completion_rate, 0.5)
  assert.deepEqual(topic.attention_reasons, [
    'low_independent_accuracy',
    'reviews_not_completed',
  ])
})

test('rendered report never includes aggregate refs or raw payload text', () => {
  const result = report([makeEvent({ aggregateRef: 'agg.secret.internal.123' })])
  const json = JSON.stringify(reportToDict(result))
  const markdown = reportToMarkdown(result)
  for (const rendered of [json, markdown]) {
    assert.equal(rendered.includes('agg.secret.internal.123'), false)
    assert.equal(rendered.includes('"aggregateRef"'), false)
    assert.equal(rendered.includes('rawAnswer'), false)
  }
  const dict = reportToDict(result) as {
    data_minimization: {
      authorized_aggregate_events_only: boolean
      raw_student_data_included: boolean
      event_refs_included: boolean
    }
  }
  assert.equal(dict.data_minimization.authorized_aggregate_events_only, true)
  assert.equal(dict.data_minimization.raw_student_data_included, false)
  assert.equal(dict.data_minimization.event_refs_included, false)
})

test('invalid report requests fail closed', () => {
  assert.throws(
    () =>
      generateReport([], {
        audience: 'principal' as never,
        studentRef: STUDENT,
        windowStart: START,
        windowEnd: END,
      }),
    /unknown audience/,
  )
  assert.throws(
    () =>
      generateReport([], {
        audience: AUDIENCE_TEACHER,
        studentRef: STUDENT,
        windowStart: END,
        windowEnd: START,
      }),
    /windowStart must be before windowEnd/,
  )
  assert.throws(
    () =>
      generateReport([], {
        audience: AUDIENCE_TEACHER,
        studentRef: 'Alice Smith',
        windowStart: START,
        windowEnd: END,
      }),
    /short identifier/,
  )
  assert.throws(() => report([{ not: 'an event' }]), ReportError)
})

test('empty window returns a safe empty report', () => {
  const result = report([])
  assert.equal(result.eventsUsed, 0)
  assert.equal(result.topics.length, 0)
  assert.match(reportToMarkdown(result), /无已授权聚合事件/)
})

test('report tool body rejects a raw field even if a caller bypasses the schema', async () => {
  const tool = createEducationTools(createEducationService()).find(
    (candidate) => candidate.name === 'aeh_generate_report',
  )
  assert.ok(tool)
  // dsh-tools compiles `additionalProperties: false`, so the raw field is an
  // argument-validation rejection before the body runs. The direct
  // `generateReport` field allow-list is covered above as defence in depth.
  await assert.rejects(
    async () =>
      tool.execute(
        {
          audience: 'teacher',
          studentRef: STUDENT,
          windowStart: START,
          windowEnd: END,
          events: [{ ...makeEvent(), imageRef: 'synthetic://raw' }],
        },
        {},
      ),
    /not a declared property|unsupported field/,
  )
})
