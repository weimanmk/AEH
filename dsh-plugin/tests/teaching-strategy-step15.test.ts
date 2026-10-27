/**
 * Step 15 tests: teaching strategy, daily coordination, learning science and
 * cross-subject adaptation (spec §10 / §17 / §18).
 *
 * Mirrors `tests/test_teaching_strategy.py` and reads the same synthetic
 * fixture. No real student data is used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ACTION_ANSWER_DIRECTLY,
  ACTION_ASK_DIAGNOSTIC_QUESTION,
  ACTION_ASSIGN_TARGETED_PRACTICE,
  ACTION_ASSIGN_TRANSFER_TASK,
  ACTION_GIVE_MINIMAL_HINT,
  ACTION_METHODS,
  ACTION_NONE,
  ACTION_REQUEST_PROGRESS_CONFIRMATION,
  ACTION_SCHEDULE_SPACED_REVIEW,
  ACTION_SHOW_WORKED_EXAMPLE,
  ACTION_TEACH_MICRO_LESSON,
  DAILY_PHASES,
  DEFAULT_INTERLEAVING_MASTERY,
  DEFAULT_PROCEDURAL_ERROR_THRESHOLD,
  IMPLEMENTED_METHOD_IDS,
  LEARNING_SCIENCE_METHODS,
  MATH_SUBJECT,
  METHOD_INTERLEAVING,
  METHOD_RETRIEVAL_PRACTICE,
  METHOD_SPACED_PRACTICE,
  PHASE_AI_REINFORCEMENT,
  PHASE_PREVIEW,
  PHASE_REVIEW,
  PHASE_SCHOOL,
  PHYSICS_SUBJECT,
  PURPOSE_PRODUCTION,
  PURPOSE_SIMULATION,
  SOURCE_OBSERVED,
  SOURCE_SIMULATED,
  SubjectAdapterError,
  SubjectRegistry,
  TeachingStrategyError,
  crossSubjectContract,
  learningScienceChecklist,
  methodById,
  methodsForAction,
  normalizeDueReview,
  normalizeKnowledgeState,
  normalizeLearnerConstraints,
  normalizeSchoolContext,
  planDailyCoordination,
  planInterleavedPractice,
  planRetrievalPractice,
  planSpacedReview,
  schoolPreviewKcs,
  selectStrategy,
  type DailyCoordinationRequest,
  type StrategyDecision,
  type StrategyRequest,
} from '../src/core/teaching-strategy.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/teaching_strategy_step15.json', import.meta.url),
    'utf8',
  ),
)

function knowledgeFrom(record: any) {
  return normalizeKnowledgeState({
    kcId: record.kcId,
    masteryMean: record.masteryMean,
    uncertainty: record.uncertainty ?? 0,
    prerequisiteReady: record.prerequisiteReady ?? true,
    conceptualMisconception: record.conceptualMisconception ?? false,
    proceduralErrorRate: record.proceduralErrorRate ?? 0,
    learned: record.learned ?? true,
    targetRetention: record.targetRetention ?? 0.9,
  })
}

function dueFrom(record: any) {
  return normalizeDueReview({
    kcId: record.kcId,
    stabilityDays: record.stabilityDays,
    elapsedDays: record.elapsedDays ?? 0,
    targetRetention: record.targetRetention ?? 0.9,
    due: record.due ?? true,
  })
}

function schoolFrom(record: any) {
  return normalizeSchoolContext({
    nextLessonConfirmed: record.nextLessonConfirmed ?? false,
    nextLessonKcs: record.nextLessonKcs ?? [],
    previewAllowedKcs: record.previewAllowedKcs ?? [],
    progressConfirmed: record.progressConfirmed ?? true,
    progressConfidence: record.progressConfidence ?? 1,
    schoolPressure: record.schoolPressure ?? 0.5,
    examUpcoming: record.examUpcoming ?? false,
    examScopeConfirmed: record.examScopeConfirmed ?? true,
    examKcs: record.examKcs ?? [],
  })
}

function constraintsFrom(record: any) {
  return normalizeLearnerConstraints({
    availableMinutes: record.availableMinutes ?? 30,
    maxBlockMinutes: record.maxBlockMinutes ?? 25,
    maxItems: record.maxItems ?? 8,
    breakPreference: record.breakPreference ?? 'balanced',
    homeworkLoad: record.homeworkLoad ?? 0,
    assessmentInProgress: record.assessmentInProgress ?? false,
    allowDirectAnswer: record.allowDirectAnswer ?? true,
  })
}

function strategyRequestFrom(record: any): StrategyRequest {
  return {
    intent: record.intent ?? 'practice',
    mode: record.mode ?? 'learn',
    knowledge: (record.knowledge ?? []).map(knowledgeFrom),
    dueReviews: (record.dueReviews ?? []).map(dueFrom),
    hypothesisConflict: record.hypothesisConflict ?? false,
    school: schoolFrom(record.school ?? {}),
    constraints: constraintsFrom(record.constraints ?? {}),
    evidenceSource: record.evidenceSource ?? SOURCE_OBSERVED,
    purpose: record.purpose ?? PURPOSE_PRODUCTION,
    explicitAnswerRequest: record.explicitAnswerRequest ?? false,
    urgency: record.urgency ?? 'normal',
    phase: record.phase,
    hasWorkingStrategy: record.hasWorkingStrategy ?? false,
  } as StrategyRequest
}

function dailyRequestFrom(record: any): DailyCoordinationRequest {
  return {
    studentRef: record.studentRef ?? 'synthetic.learner',
    totalMinutes: record.totalMinutes ?? 60,
    knowledge: (record.knowledge ?? []).map(knowledgeFrom),
    dueReviews: (record.dueReviews ?? []).map(dueFrom),
    school: schoolFrom(record.school ?? {}),
    constraints: constraintsFrom(record.constraints ?? {}),
    hypothesisConflict: record.hypothesisConflict ?? false,
    recentErrorKcs: record.recentErrorKcs ?? [],
    prerequisiteGapKcs: record.prerequisiteGapKcs ?? [],
    examPressure: record.examPressure ?? 0,
    reviewBacklog: record.reviewBacklog ?? 0,
    evidenceSource: record.evidenceSource ?? SOURCE_OBSERVED,
    purpose: record.purpose ?? PURPOSE_PRODUCTION,
  }
}

function assertExpectedStrategy(
  actual: StrategyDecision,
  expected: any,
): void {
  assert.equal(actual.action, expected.action)
  if ('mode' in expected) assert.equal(actual.mode, expected.mode)
  if ('phase' in expected) assert.equal(actual.phase, expected.phase)
  if ('targetKcs' in expected) {
    assert.deepEqual([...actual.targetKcs], expected.targetKcs)
  }
  if ('methodIds' in expected) {
    assert.deepEqual([...actual.methodIds], expected.methodIds)
  }
  if ('timeMinutes' in expected) {
    assert.equal(actual.timeMinutes, expected.timeMinutes)
  }
  if ('blocked' in expected) assert.equal(actual.blocked, expected.blocked)
  if ('requiresConfirmation' in expected) {
    assert.equal(actual.requiresConfirmation, expected.requiresConfirmation)
  }
  if ('reasons' in expected) {
    assert.deepEqual([...actual.reasons], expected.reasons)
  }
  for (const guardrail of expected.guardrailsContain ?? []) {
    assert.ok(actual.guardrails.includes(guardrail))
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test('step15: the nine spec actions and four phases are present', () => {
  const actions = [
    ACTION_ASK_DIAGNOSTIC_QUESTION,
    ACTION_GIVE_MINIMAL_HINT,
    ACTION_SHOW_WORKED_EXAMPLE,
    ACTION_TEACH_MICRO_LESSON,
    ACTION_ASSIGN_TARGETED_PRACTICE,
    ACTION_ASSIGN_TRANSFER_TASK,
    ACTION_SCHEDULE_SPACED_REVIEW,
    ACTION_REQUEST_PROGRESS_CONFIRMATION,
    ACTION_ANSWER_DIRECTLY,
  ]
  for (const action of actions) assert.ok(action in ACTION_METHODS)
  assert.ok(!(ACTION_NONE in actions))
  assert.deepEqual([...DAILY_PHASES], [
    PHASE_PREVIEW,
    PHASE_SCHOOL,
    PHASE_AI_REINFORCEMENT,
    PHASE_REVIEW,
  ])
})

test('step15: all 16 learning-science methods have mappings and checks', () => {
  assert.equal(LEARNING_SCIENCE_METHODS.length, 16)
  for (const method of LEARNING_SCIENCE_METHODS) {
    assert.ok(method.harnessActions.length > 0, method.methodId)
    assert.ok(method.conditions.length > 0, method.methodId)
    assert.ok(method.implementation.length > 0, method.methodId)
    assert.ok(method.verification.length > 0, method.methodId)
    assert.ok(method.guardrails.length > 0, method.methodId)
    assert.equal(methodById(method.methodId), method)
  }
})

test('step15: retrieval, spacing and interleaving are executable', () => {
  const implemented = learningScienceChecklist()
    .filter((method) => method.status === 'implemented')
    .map((method) => method.methodId)
    .sort()
  assert.deepEqual(implemented, [...IMPLEMENTED_METHOD_IDS].sort())
  assert.deepEqual(
    [...methodsForAction(ACTION_SCHEDULE_SPACED_REVIEW)].sort(),
    [METHOD_SPACED_PRACTICE, METHOD_RETRIEVAL_PRACTICE, METHOD_INTERLEAVING].sort(),
  )
  for (const methodId of IMPLEMENTED_METHOD_IDS) {
    assert.equal(methodById(methodId).status, 'implemented')
  }
})

test('step15: unknown method/action fail closed', () => {
  assert.throws(() => methodById('not_a_method'), TeachingStrategyError)
  assert.throws(() => methodsForAction('not_an_action'), TeachingStrategyError)
})

// ---------------------------------------------------------------------------
// Strategy router
// ---------------------------------------------------------------------------

test('step15: shared strategy fixture', () => {
  const item = fixture.strategy
  const decision = selectStrategy(strategyRequestFrom(item.request))
  assertExpectedStrategy(decision, item.expected)
  assert.equal(decision.deliveryRequiresGate, true)
})

test('step15: simulated evidence cannot drive a production strategy', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    evidenceSource: SOURCE_SIMULATED,
    purpose: PURPOSE_PRODUCTION,
  })
  assert.equal(decision.blocked, true)
  assert.equal(decision.action, ACTION_NONE)
  assert.ok(
    decision.reasons.includes(
      'simulated_evidence_cannot_drive_production_strategy',
    ),
  )
  assert.equal(decision.simulatedEvidenceUsed, true)
})

test('step15: simulated evidence is allowed inside a simulation', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    evidenceSource: SOURCE_SIMULATED,
    purpose: PURPOSE_SIMULATION,
  })
  assert.equal(decision.blocked, false)
  assert.ok(decision.guardrails.includes('simulation_context_only'))
  assert.ok(decision.guardrails.includes('simulated_evidence_marked'))
})

test('step15: unknown provenance is rejected', () => {
  assert.throws(
    () =>
      selectStrategy({
        knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
        evidenceSource: 'unsourced',
      }),
    /unknown evidence_source: unsourced/,
  )
})

test('step15: assessment integrity blocks assistance', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    explicitAnswerRequest: true,
    constraints: { assessmentInProgress: true },
  })
  assert.equal(decision.blocked, true)
  assert.equal(decision.action, ACTION_NONE)
  assert.ok(decision.guardrails.includes('no_assistance_during_assessment'))
})

test('step15: zero time budget blocks assignment', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    constraints: { availableMinutes: 0 },
  })
  assert.equal(decision.blocked, true)
  assert.ok(decision.guardrails.includes('no_work_without_time_budget'))
})

test('step15: unconfirmed school progress requests confirmation', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    school: { progressConfirmed: false },
  })
  assert.equal(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
  assert.equal(decision.requiresConfirmation, true)
  assert.deepEqual([...decision.reasons], ['school_progress_unconfirmed'])
})

test('step15: low-confidence progress requests confirmation', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    school: { progressConfirmed: true, progressConfidence: 0.4 },
  })
  assert.equal(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
})

test('step15: confirmed preview fixture', () => {
  const item = fixture.preview
  const decision = selectStrategy(strategyRequestFrom(item.request))
  assertExpectedStrategy(decision, item.expected)
})

test('step15: unconfirmed preview never unlocks future content', () => {
  const item = fixture.unconfirmed_preview
  const decision = selectStrategy(strategyRequestFrom(item.request))
  assertExpectedStrategy(decision, item.expected)
})

test('step15: preview without allowed scope is blocked', () => {
  const decision = selectStrategy({
    intent: 'preview',
    mode: 'preview',
    knowledge: [{ kcId: 'kc.math.quadratic', masteryMean: 0.4 }],
    school: {
      nextLessonConfirmed: true,
      nextLessonKcs: ['kc.math.quadratic'],
      previewAllowedKcs: [],
    },
  })
  assert.equal(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
  assert.ok(decision.guardrails.includes('preview_never_unlocked_by_ability'))
})

test('step15: explicit answer request does not force diagnosis', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    hypothesisConflict: true,
    explicitAnswerRequest: true,
  })
  assert.equal(decision.action, ACTION_ANSWER_DIRECTLY)
  assert.deepEqual([...decision.reasons], ['explicit_answer_request'])
})

test('step15: time pressure answers directly', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    urgency: 'time_pressure',
  })
  assert.equal(decision.action, ACTION_ANSWER_DIRECTLY)
})

test('step15: direct answer can be disabled by the learner', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    explicitAnswerRequest: true,
    constraints: { allowDirectAnswer: false },
  })
  assert.equal(decision.action, ACTION_GIVE_MINIMAL_HINT)
  assert.ok(decision.guardrails.includes('direct_answer_disabled'))
})

test('step15: hypothesis conflict asks one skippable probe', () => {
  const item = fixture.conflict
  const decision = selectStrategy(strategyRequestFrom(item.request))
  assertExpectedStrategy(decision, item.expected)
  assert.ok(decision.guardrails.includes('diagnosis_is_skippable'))
})

test('step15: prerequisite gap uses a worked example', () => {
  const decision = selectStrategy({
    knowledge: [
      {
        kcId: 'kc.math.linear',
        masteryMean: 0.7,
        prerequisiteReady: false,
      },
    ],
  })
  assert.equal(decision.action, ACTION_SHOW_WORKED_EXAMPLE)
  assert.ok(decision.guardrails.includes('avoid_overload'))
})

test('step15: conceptual misconception uses a micro lesson', () => {
  const decision = selectStrategy({
    knowledge: [
      {
        kcId: 'kc.math.linear',
        masteryMean: 0.6,
        conceptualMisconception: true,
      },
    ],
  })
  assert.equal(decision.action, ACTION_TEACH_MICRO_LESSON)
  assert.ok(!decision.methodIds.includes(METHOD_INTERLEAVING))
})

test('step15: procedural errors use targeted practice', () => {
  const decision = selectStrategy({
    knowledge: [
      {
        kcId: 'kc.math.linear',
        masteryMean: 0.7,
        proceduralErrorRate: DEFAULT_PROCEDURAL_ERROR_THRESHOLD,
      },
    ],
  })
  assert.equal(decision.action, ACTION_ASSIGN_TARGETED_PRACTICE)
  assert.ok(decision.reasons.includes('procedural_errors_detected'))
  assert.ok(decision.guardrails.includes('independence_before_hints'))
})

test('step15: transfer intent uses an unseen transfer task', () => {
  const decision = selectStrategy({
    intent: 'transfer',
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.9 }],
  })
  assert.equal(decision.action, ACTION_ASSIGN_TRANSFER_TASK)
  assert.ok(decision.guardrails.includes('unseen_transfer_item_required'))
})

test('step15: due reviews use spaced review', () => {
  const item = fixture.forgetting
  const decision = selectStrategy(strategyRequestFrom(item.request))
  assertExpectedStrategy(decision, item.expected)
})

test('step15: time budget clamps the action', () => {
  const decision = selectStrategy({
    knowledge: [
      {
        kcId: 'kc.math.linear',
        masteryMean: 0.6,
        conceptualMisconception: true,
      },
    ],
    constraints: { availableMinutes: 4 },
  })
  assert.equal(decision.timeMinutes, 4)
})

test('step15: unconfirmed exam scope requests confirmation', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.6 }],
    school: { examUpcoming: true, examScopeConfirmed: false },
  })
  assert.equal(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
  assert.ok(decision.guardrails.includes('exam_scope_unconfirmed'))
})

test('step15: missing knowledge state requests confirmation', () => {
  const decision = selectStrategy({})
  assert.equal(decision.action, ACTION_REQUEST_PROGRESS_CONFIRMATION)
  assert.ok(decision.guardrails.includes('no_strategy_without_evidence'))
})

test('step15: an existing strategy gets the smallest hint', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.5 }],
    hasWorkingStrategy: true,
  })
  assert.equal(decision.action, ACTION_GIVE_MINIMAL_HINT)
})

// ---------------------------------------------------------------------------
// Daily coordination
// ---------------------------------------------------------------------------

test('step15: shared daily plan fixture', () => {
  const item = fixture.daily
  const plan = planDailyCoordination(dailyRequestFrom(item.request))
  const expected = item.expected
  assert.equal(plan.totalMinutes, expected.totalMinutes)
  assert.equal(plan.breakCount, expected.breakCount)
  assert.equal(plan.breakMinutesTotal, expected.breakMinutesTotal)
  assert.equal(plan.requiresConfirmation, expected.requiresConfirmation)
  assert.equal(plan.blocked, expected.blocked)
  assert.equal(plan.phases.length, expected.phases.length)
  for (let index = 0; index < plan.phases.length; index += 1) {
    const actual = plan.phases[index]
    const wanted = expected.phases[index]
    assert.equal(actual.phase, wanted.phase)
    assert.equal(actual.minutes, wanted.minutes)
    assert.equal(actual.action, wanted.action)
    assert.deepEqual([...actual.targetKcs], wanted.targetKcs)
    assert.deepEqual([...actual.methodIds], wanted.methodIds)
  }
  for (const guardrail of expected.guardrailsContain) {
    assert.ok(plan.guardrails.includes(guardrail))
  }
  for (const note of expected.notesContain) {
    assert.ok(plan.notes.includes(note))
  }
})

test('step15: daily plan stays within budget', () => {
  const item = fixture.daily
  const plan = planDailyCoordination(dailyRequestFrom(item.request))
  const total = plan.phases.reduce((sum, phase) => sum + phase.minutes, 0)
  assert.ok(Math.abs(total - 60) < 0.05)
  assert.ok(plan.breakMinutesTotal <= 60)
})

test('step15: school phase is zero and explicitly unobserved', () => {
  const item = fixture.daily
  const plan = planDailyCoordination(dailyRequestFrom(item.request))
  const school = plan.phases.find((phase) => phase.phase === PHASE_SCHOOL)
  assert.ok(school !== undefined)
  assert.equal(school.minutes, 0)
  assert.equal(school.action, ACTION_NONE)
  assert.deepEqual([...school.targetKcs], [])
  assert.ok(school.guardrails.includes('school_time_is_not_observed'))
})

test('step15: preview is skipped without confirmation', () => {
  const plan = planDailyCoordination({
    totalMinutes: 40,
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.6 }],
    school: {
      nextLessonConfirmed: false,
      nextLessonKcs: ['kc.math.quadratic'],
      previewAllowedKcs: ['kc.math.quadratic'],
    },
    constraints: { availableMinutes: 40 },
  })
  assert.equal(
    plan.phases.some((phase) => phase.phase === PHASE_PREVIEW),
    false,
  )
  assert.equal(plan.requiresConfirmation, false)
  assert.ok(plan.guardrails.includes('preview_blocked_unconfirmed_next_lesson'))
})

test('step15: exam and backlog can prioritise review', () => {
  const plan = planDailyCoordination({
    totalMinutes: 60,
    knowledge: [
      { kcId: 'kc.math.linear', masteryMean: 0.6 },
      { kcId: 'kc.math.quadratic', masteryMean: 0.7 },
    ],
    dueReviews: [
      { kcId: 'kc.math.linear', stabilityDays: 5, elapsedDays: 10 },
      { kcId: 'kc.math.quadratic', stabilityDays: 4, elapsedDays: 9 },
    ],
    school: {
      nextLessonConfirmed: true,
      nextLessonKcs: ['kc.math.quadratic'],
      previewAllowedKcs: ['kc.math.quadratic'],
      examUpcoming: true,
      examKcs: ['kc.math.linear', 'kc.math.quadratic'],
    },
    examPressure: 0.9,
    reviewBacklog: 3,
  })
  const review = plan.phases.find((phase) => phase.phase === PHASE_REVIEW)
  const reinforcement = plan.phases.find(
    (phase) => phase.phase === PHASE_AI_REINFORCEMENT,
  )
  assert.ok(review !== undefined && reinforcement !== undefined)
  assert.ok(review.minutes > reinforcement.minutes)
})

test('step15: daily simulated production is blocked', () => {
  const plan = planDailyCoordination({
    totalMinutes: 30,
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.6 }],
    evidenceSource: SOURCE_SIMULATED,
  })
  assert.equal(plan.blocked, true)
  assert.equal(plan.phases.length, 0)
  assert.ok(plan.guardrails.includes('simulated_evidence_isolated'))
})

test('step15: daily assessment is blocked', () => {
  const plan = planDailyCoordination({
    totalMinutes: 30,
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.6 }],
    constraints: { assessmentInProgress: true },
  })
  assert.equal(plan.blocked, true)
  assert.ok(plan.guardrails.includes('no_assistance_during_assessment'))
})

test('step15: daily budget is capped by learner availability', () => {
  const plan = planDailyCoordination({
    totalMinutes: 120,
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.6 }],
    constraints: { availableMinutes: 30 },
  })
  assert.ok(plan.totalMinutes <= 30)
  assert.ok(plan.guardrails.includes('daily_budget_capped_by_availability'))
  assert.ok(plan.notes.includes('daily_budget_capped_by_availability'))
})

test('step15: daily breaks follow the learner preference', () => {
  const plan = planDailyCoordination({
    totalMinutes: 60,
    knowledge: [{ kcId: 'kc.math.linear', masteryMean: 0.6 }],
    constraints: {
      availableMinutes: 60,
      maxBlockMinutes: 20,
      breakPreference: 'short',
    },
  })
  assert.equal(plan.breakCount, 2)
  assert.equal(plan.breakMinutesTotal, 6)
})

test('step15: schoolPreviewKcs is an intersection, not a guess', () => {
  const school = normalizeSchoolContext({
    nextLessonConfirmed: true,
    nextLessonKcs: ['kc.math.a', 'kc.math.b'],
    previewAllowedKcs: ['kc.math.b'],
  })
  assert.deepEqual([...schoolPreviewKcs(school)], ['kc.math.b'])
})

// ---------------------------------------------------------------------------
// Learning-science planners
// ---------------------------------------------------------------------------

test('step15: retrieval plan fixture', () => {
  const item = fixture.retrieval
  const plan = planRetrievalPractice(item.kcIds, {
    knowledge: item.knowledge.map(knowledgeFrom),
    availableMinutes: item.availableMinutes,
    maxItems: item.maxItems,
    itemIds: item.itemIds,
  })
  assert.deepEqual([...plan.sequence], item.expected.sequence)
  assert.equal(plan.minutes, item.expected.minutes)
  assert.equal(plan.showAnswerFirst, item.expected.showAnswerFirst)
  assert.equal(plan.independent, item.expected.independent)
  assert.ok(plan.guardrails.includes('no_answer_before_attempt'))
  assert.ok(plan.guardrails.includes('reading_is_not_retrieval'))
})

test('step15: retrieval rejects unlearned KCs', () => {
  assert.throws(
    () =>
      planRetrievalPractice(['kc.math.linear'], {
        knowledge: [
          normalizeKnowledgeState({
            kcId: 'kc.math.linear',
            masteryMean: 0.2,
            learned: false,
          }),
        ],
      }),
    /retrieval_requires_learned_kc/,
  )
})

test('step15: retrieval caps items and requires KCs', () => {
  assert.throws(() => planRetrievalPractice([]), TeachingStrategyError)
  const plan = planRetrievalPractice(
    ['kc.math.linear', 'kc.math.quadratic'],
    { maxItems: 1 },
  )
  assert.equal(plan.sequence.length, 1)
  assert.equal(plan.maxItems, 1)
})

test('step15: spaced review fixture', () => {
  const item = fixture.spaced
  const plan = planSpacedReview(item.dueReviews, {
    availableMinutes: item.availableMinutes,
  })
  assert.deepEqual(
    plan.slots.map((slot) => slot.kcId),
    item.expected.order,
  )
  plan.slots.forEach((slot, index) => {
    assert.ok(
      Math.abs(slot.intervalDays - item.expected.intervalDays[index]) < 1e-9,
    )
  })
  assert.equal(plan.minutes, item.expected.minutes)
  assert.equal(plan.targetRetention, item.expected.targetRetention)
  assert.ok(
    plan.guardrails.includes('overdue_raises_uncertainty_not_lower_mastery'),
  )
})

test('step15: spaced review requires due units', () => {
  assert.throws(() => planSpacedReview([]), TeachingStrategyError)
})

test('step15: spaced review minutes are capped', () => {
  const plan = planSpacedReview(
    [
      { kcId: 'kc.math.linear', stabilityDays: 5, elapsedDays: 10 },
      { kcId: 'kc.math.quadratic', stabilityDays: 3, elapsedDays: 6 },
    ],
    { availableMinutes: 1 },
  )
  assert.ok(plan.minutes <= 1)
})

test('step15: interleaving fixture', () => {
  const item = fixture.interleaving
  const plan = planInterleavedPractice(item.units, {
    masteryByKc: item.masteryByKc,
    availableMinutes: item.availableMinutes,
    blockSize: item.blockSize,
  })
  assert.deepEqual(
    plan.sequence.map((unit) => unit.unitId),
    item.expected.sequence,
  )
  assert.deepEqual(
    plan.blocks.map((block) => [...block]),
    item.expected.blocks,
  )
  assert.equal(plan.minutes, item.expected.minutes)
  assert.equal(plan.distinctKcs, item.expected.distinctKcs)
})

test('step15: interleaving avoids adjacent same KC when avoidable', () => {
  const plan = planInterleavedPractice(
    [
      { unitId: 'a1', kcId: 'kc.math.a' },
      { unitId: 'a2', kcId: 'kc.math.a' },
      { unitId: 'a3', kcId: 'kc.math.a' },
      { unitId: 'b1', kcId: 'kc.math.b' },
      { unitId: 'b2', kcId: 'kc.math.b' },
    ],
    { maxItems: 5 },
  )
  const kcs = plan.sequence.map((unit) => unit.kcId)
  for (let index = 1; index < kcs.length; index += 1) {
    assert.notEqual(kcs[index], kcs[index - 1])
  }
})

test('step15: interleaving requires multiple KCs', () => {
  assert.throws(
    () =>
      planInterleavedPractice([
        { unitId: 'a1', kcId: 'kc.math.a' },
        { unitId: 'a2', kcId: 'kc.math.a' },
      ]),
    /interleaving_requires_multiple_kcs/,
  )
})

test('step15: interleaving requires basic understanding', () => {
  assert.throws(
    () =>
      planInterleavedPractice(
        [
          { unitId: 'a1', kcId: 'kc.math.a' },
          { unitId: 'b1', kcId: 'kc.math.b' },
        ],
        {
          masteryByKc: {
            'kc.math.a': DEFAULT_INTERLEAVING_MASTERY - 0.1,
            'kc.math.b': 0.9,
          },
        },
      ),
    /interleaving_requires_basic_understanding/,
  )
})

// ---------------------------------------------------------------------------
// Cross-subject adaptation
// ---------------------------------------------------------------------------

test('step15: math adapter', () => {
  const item = fixture.subjects.mathDecision
  const decision = selectStrategy(strategyRequestFrom(item.request))
  const adaptation = MATH_SUBJECT.adapt(decision)
  assert.equal(adaptation.subjectId, item.expected.subjectId)
  assert.equal(adaptation.accepted, item.expected.accepted)
  assert.equal(adaptation.safetyRequired, item.expected.safetyRequired)
  for (const validator of item.expected.validatorsContain) {
    assert.ok(adaptation.validators.includes(validator))
  }
  for (const kind of item.expected.evidenceKindsContain) {
    assert.ok(MATH_SUBJECT.evidenceKinds.has(kind))
  }
})

test('step15: physics adapter carries unit checks and safety review', () => {
  const item = fixture.subjects.physicsDecision
  const decision = selectStrategy(strategyRequestFrom(item.request))
  const adaptation = PHYSICS_SUBJECT.adapt(decision)
  assert.equal(adaptation.subjectId, item.expected.subjectId)
  assert.equal(adaptation.accepted, true)
  assert.equal(adaptation.safetyRequired, item.expected.safetyRequired)
  for (const validator of item.expected.validatorsContain) {
    assert.ok(adaptation.validators.includes(validator))
  }
  for (const kind of item.expected.evidenceKindsContain) {
    assert.ok(PHYSICS_SUBJECT.evidenceKinds.has(kind))
  }
})

test('step15: subject evidence validation', () => {
  const cases = fixture.subjects
  assert.deepEqual(
    [
      ...MATH_SUBJECT.validateEvidence(cases.mathEvidence.evidence),
    ],
    cases.mathEvidence.expectedReasons,
  )
  assert.deepEqual(
    [
      ...PHYSICS_SUBJECT.validateEvidence(
        cases.physicsBadEvidence.evidence,
      ),
    ],
    cases.physicsBadEvidence.expectedReasons,
  )
})

test('step15: unsupported KC is rejected by the adapter', () => {
  const decision = selectStrategy({
    knowledge: [{ kcId: 'kc.chemistry.bonding', masteryMean: 0.6 }],
  })
  const adaptation = MATH_SUBJECT.adapt(decision)
  assert.equal(adaptation.accepted, false)
  assert.ok(
    adaptation.reasons.includes('unsupported_kc:kc.chemistry.bonding'),
  )
})

test('step15: subject registry is fail-closed', () => {
  const registry = new SubjectRegistry([MATH_SUBJECT])
  assert.equal(registry.size, 1)
  assert.throws(() => registry.register(MATH_SUBJECT), SubjectAdapterError)
  assert.throws(() => registry.get('chemistry'), SubjectAdapterError)
})

test('step15: cross-subject contract has two examples', () => {
  const contract = crossSubjectContract()
  assert.ok((contract.shared as string[]).includes('kc_id'))
  assert.ok((contract.shared as string[]).includes('strategy_decision'))
  assert.deepEqual(
    Object.keys(contract.subjects as Record<string, unknown>).sort(),
    ['math', 'physics'],
  )
})
