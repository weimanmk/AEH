/**
 * Explicit, closed output schemas for the six model-facing tools (Step 7 / P1
 * item 2).
 *
 * Before Step 7 every tool declared `output: { schema: { type: 'json' } }`, so
 * the runtime accepted any JSON value and only the (loose) TypeScript return
 * types documented the shape. `dsh-tools` validates every tool result against
 * its declared output schema before rendering it, so declaring a real object
 * schema makes an out-of-bounds return an `INVALID_TOOL_OUTPUT` failure instead
 * of silently reaching the model.
 *
 * The schemas below are author-facing `ValueSchemaSpec` objects compiled by
 * dsh-tools (`valueSchemaSpecToJsonSchema`): `additionalProperties` is
 * mandatory on every object, and `required: true` is a per-property
 * annotation. Nested *maps* whose keys are dynamic (weights, predictions,
 * `itemDecisions`) use `additionalProperties: true` because the enforced JSON
 * Schema subset does not support typed `additionalProperties`; every declared
 * object still closes its own field set.
 */

const nullString = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
} as const

const stringArray = { type: 'array', items: { type: 'string' } } as const

const numberMap = { type: 'object', additionalProperties: true } as const

const reasonList = { type: 'array', items: { type: 'string' } } as const

/** One closed gate decision plus the policy tag. */
export const gateDecisionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    allowed: { type: 'boolean', required: true },
    reasons: { ...reasonList, required: true },
    allowedKcs: { ...stringArray, required: true },
    itemId: { ...nullString, required: true },
    mode: { type: 'string', required: true },
    policy: { type: 'string', required: true },
  },
} as const

/** One hypothesis record as returned by `HypothesisSet.toState()`. */
export const hypothesisRecordOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hypothesisId: { type: 'string', required: true },
    subjectScope: { ...stringArray, required: true },
    knowledgeAssumptions: { ...numberMap, required: true },
    strategyPolicy: { ...stringArray, required: true },
    bugRules: { ...stringArray, required: true },
    predictedObservableBehaviors: { ...numberMap, required: true },
    responseToIntervention: { ...stringArray, required: true },
    weight: { type: 'number', required: true },
    evidenceRefs: { ...stringArray, required: true },
    uncertainty: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      required: true,
    },
    status: { type: 'string', required: true },
    parentId: { ...nullString, required: true },
    mergedFrom: { ...stringArray, required: true },
  },
} as const

export const hypothesisStateOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hypotheses: {
      type: 'array',
      items: hypothesisRecordOutputSchema,
      required: true,
    },
    unknownWeight: { type: 'number', required: true },
  },
} as const

export const hypothesisResultOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { ...hypothesisStateOutputSchema, required: true },
    weights: { ...numberMap, required: true },
    dominantId: { ...nullString, required: true },
    transitions: { type: 'integer', required: true },
    snapshotRef: { type: 'string' },
    snapshotExpiresAt: { type: 'string' },
    snapshotTtlMs: { type: 'integer' },
    snapshotScope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionScoped: { type: 'boolean', required: true },
        agentScoped: { type: 'boolean', required: true },
      },
    },
  },
} as const

const diagnosticCandidateOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: { type: 'string', required: true },
    predictions: { ...numberMap, required: true },
    timeMinutes: { type: 'number', required: true },
    risk: { type: 'number', required: true },
    cognitiveLoad: { type: 'number', required: true },
    teachingValue: { type: 'number', required: true },
    gateAllowed: { type: 'boolean', required: true },
    requiredKcs: { ...stringArray, required: true },
    gateReasons: { ...reasonList },
  },
} as const

const probeSelectionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: { type: 'string', required: true },
    score: { type: 'number', required: true },
    informationGain: { type: 'number', required: true },
    teachingValue: { type: 'number', required: true },
    timePenalty: { type: 'number', required: true },
    riskPenalty: { type: 'number', required: true },
    loadPenalty: { type: 'number', required: true },
    answerUncertainty: { type: 'number', required: true },
    reasons: { ...reasonList, required: true },
    candidate: {
      oneOf: [diagnosticCandidateOutputSchema, { type: 'null' }],
      required: true,
    },
  },
} as const

export const probePlanOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    selection: {
      oneOf: [probeSelectionOutputSchema, { type: 'null' }],
      required: true,
    },
    rejected: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: { type: 'string', required: true },
          reasons: { ...reasonList, required: true },
        },
      },
    },
    skipped: { type: 'boolean', required: true },
    blockedReason: { type: 'string' },
  },
} as const

/** `MemoryHostContext`-style state snapshot embedded in a review result. */
export const memoryScheduleOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    learnerRef: { type: 'string', required: true },
    memoryUnitId: { type: 'string', required: true },
    modelFamily: { type: 'string', required: true },
    modelVersion: { type: 'string', required: true },
    stabilityDays: { type: 'number', required: true },
    difficultyState: { type: 'number', required: true },
    observationCount: { type: 'integer', required: true },
    independentSuccessCount: { type: 'integer', required: true },
    uncertainty: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      required: true,
    },
    targetRetention: { type: 'number', required: true },
    nextIntervalDays: { type: 'number', required: true },
    expectedRetrievabilityAtNextReview: { type: 'number', required: true },
  },
} as const

export const reviewOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { ...memoryScheduleOutputSchema, required: true },
    nextIntervalDays: { type: 'number', required: true },
    targetRetention: { type: 'number', required: true },
    observationsReceived: { type: 'integer', required: true },
    independentSuccesses: { type: 'integer', required: true },
    ignoredReadingObservations: { type: 'integer', required: true },
    modelVersion: { type: 'string', required: true },
  },
} as const

export const preparedInterventionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    packageId: { type: 'string', required: true },
    valid: { type: 'boolean', required: true },
    reasons: { ...reasonList, required: true },
    deliveryEligible: { type: 'boolean', required: true },
    notDelivered: { type: 'boolean', const: true, required: true },
    requiresHostApproval: { type: 'boolean', const: true, required: true },
    /** Map of item id -> closed gate decision; keys are catalog ids. */
    itemDecisions: { type: 'object', additionalProperties: true, required: true },
    allowedKcs: { ...stringArray, required: true },
  },
} as const

const nullableNumber = {
  oneOf: [{ type: 'number' }, { type: 'null' }],
} as const

const reportMetricsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attempts: { type: 'integer', required: true },
    independent_correct: { type: 'integer', required: true },
    hinted_correct: { type: 'integer', required: true },
    hints_requested: { type: 'integer', required: true },
    reviews_due: { type: 'integer', required: true },
    reviews_completed: { type: 'integer', required: true },
    minutes: { type: 'number', required: true },
    independent_accuracy: { ...nullableNumber, required: true },
    hints_per_attempt: { ...nullableNumber, required: true },
    review_completion_rate: { ...nullableNumber, required: true },
  },
} as const

const reportTopicSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kc_id: { type: 'string', required: true },
    attempts: { type: 'integer', required: true },
    independent_correct: { type: 'integer', required: true },
    hinted_correct: { type: 'integer', required: true },
    hints_requested: { type: 'integer', required: true },
    reviews_due: { type: 'integer', required: true },
    reviews_completed: { type: 'integer', required: true },
    minutes: { type: 'number', required: true },
    independent_accuracy: { ...nullableNumber, required: true },
    hints_per_attempt: { ...nullableNumber, required: true },
    review_completion_rate: { ...nullableNumber, required: true },
    attention_reasons: { ...reasonList, required: true },
  },
} as const

export const reportOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    report_type: { type: 'string', required: true },
    audience: { type: 'string', enum: ['teacher', 'guardian'], required: true },
    student_ref: { type: 'string', required: true },
    window: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        start: { type: 'string', required: true },
        end: { type: 'string', required: true },
        boundary: {
          type: 'string',
          const: 'start_inclusive_end_exclusive',
          required: true,
        },
      },
    },
    generated_at: { type: 'string', required: true },
    data_minimization: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        authorized_aggregate_events_only: {
          type: 'boolean',
          const: true,
          required: true,
        },
        raw_student_data_included: {
          type: 'boolean',
          const: false,
          required: true,
        },
        event_refs_included: {
          type: 'boolean',
          const: false,
          required: true,
        },
        source_events_used: { type: 'integer', required: true },
        source_events_excluded: { type: 'integer', required: true },
        authorized_scopes: { ...stringArray, required: true },
      },
    },
    totals: { ...reportMetricsSchema, required: true },
    topics: {
      type: 'array',
      items: reportTopicSchema,
      required: true,
    },
    attention_topics: { ...stringArray, required: true },
  },
} as const

/** Lookup used by tests to assert every tool ships a closed object schema. */
export const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  aeh_check_curriculum: gateDecisionOutputSchema,
  aeh_update_hypotheses: hypothesisResultOutputSchema,
  aeh_select_probe: probePlanOutputSchema,
  aeh_schedule_review: reviewOutputSchema,
  aeh_prepare_intervention: preparedInterventionOutputSchema,
  aeh_generate_report: reportOutputSchema,
})
