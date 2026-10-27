/**
 * Step 17 tests: privacy, minor protection, retention/deletion propagation,
 * audit export and the metrics/cost dashboard (spec §20 / §21).
 *
 * Mirrors `tests/test_privacy_step17.py` and reads the same shared synthetic
 * fixture `tests/fixtures/privacy_step17.json`. No real student data is used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  AGG_GAUGE,
  AGG_MEAN,
  AGG_SUM,
  AUDIENCE_ADMIN,
  AUDIENCE_RESEARCH,
  AUDIENCE_STUDENT,
  AUDIENCE_TEACHER,
  AUDIT_REJECTED,
  BILLING_CONNECTED,
  DATA_CLASSES,
  DATA_CLASS_LEARNING_EVENTS,
  DATA_CLASS_RAW_MEDIA,
  DELETION_ANONYMIZE,
  DELETION_COMPLETED,
  DELETION_FAILED,
  DELETION_PARTIAL,
  DIMENSION_LEARNING,
  DIMENSION_SYSTEM,
  MINOR_AGE_THRESHOLD,
  SOURCE_OBSERVED,
  SOURCE_SIMULATED,
  SUBJECT_GUARDIAN,
  SUBJECT_STUDENT,
  AudienceRestrictionError,
  AuditEntry,
  AuditExportError,
  AuditExportRequest,
  ConsentError,
  ConsentEvent,
  ConsentLedger,
  CostEstimator,
  CostModel,
  DeletionCoordinator,
  DeletionError,
  DeletionRequest,
  METRIC_DEFINITIONS,
  METRIC_DIMENSIONS,
  MetricDefinition,
  MetricSample,
  MetricsDashboard,
  MetricsError,
  RetentionError,
  RetentionPolicy,
  RetentionRecord,
  RetentionRule,
  SyntheticStore,
  UsageRecord,
  auditExportJson,
  authorizedAudienceScopes,
  cohortViewJson,
  costEstimateJson,
  dashboardSnapshotJson,
  deletionReceiptJson,
  effectiveAudienceScopes,
  estimateCost,
  expiredRecords,
  exportAudit,
  isMinor,
  retentionRequests,
  type AuditExportRequestInput,
  type ConsentEventInput,
  type RetentionDue,
} from '../src/core/privacy.ts'

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/privacy_step17.json', import.meta.url),
    'utf8',
  ),
)

const T0 = '2026-02-01T00:00:00.000Z'

function eventFrom(record: ConsentEventInput): ConsentEvent {
  return new ConsentEvent(record)
}

function ledgerFromFixture(records: ConsentEventInput[]): ConsentLedger {
  const ledger = new ConsentLedger()
  for (const record of records) ledger.append(eventFrom(record))
  return ledger
}

function retentionPolicy(spec: {
  policyVersion: string
  rules: { dataClass: string; retainDays: number; deletionMode: string }[]
}): RetentionPolicy {
  return new RetentionPolicy(
    spec.policyVersion,
    spec.rules.map(
      (rule) =>
        new RetentionRule(rule.dataClass, rule.retainDays, rule.deletionMode),
    ),
  )
}

function buildCoordinator(
  storesSpec: {
    storeId: string
    dataClasses: string[]
    seed: Record<string, Record<string, number>>
  }[],
  extraFailing = false,
): DeletionCoordinator {
  const coordinator = new DeletionCoordinator()
  for (const spec of storesSpec) {
    const store = new SyntheticStore(spec.storeId, spec.dataClasses)
    for (const studentRef of Object.keys(spec.seed)) {
      for (const dataClass of Object.keys(spec.seed[studentRef])) {
        store.seed(studentRef, dataClass, spec.seed[studentRef][dataClass])
      }
    }
    coordinator.register(store)
  }
  if (extraFailing) {
    coordinator.register(
      new SyntheticStore('failing-store', [DATA_CLASS_RAW_MEDIA], {
        failOnDelete: true,
      }),
    )
  }
  return coordinator
}

function deletionRequest(spec: {
  requestId: string
  studentRef: string
  requestedAt: string
  reason: string
  dataClasses: string[]
  requestedBy?: string
}): DeletionRequest {
  return new DeletionRequest(spec)
}

function auditEntry(record: ConstructorParameters<typeof AuditEntry>[0]): AuditEntry {
  return new AuditEntry(record)
}

function usageRecord(
  record: Partial<ConstructorParameters<typeof UsageRecord>[0]>,
): UsageRecord {
  return new UsageRecord(record)
}

test('consent: grant and revoke are append-only', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'twin:observe', at: T0, policyVersion: 'v1', evidenceRef: 'ev1',
  })
  ledger.revoke({
    consentId: 'c2', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'twin:observe', at: '2026-02-02T00:00:00.000Z',
    policyVersion: 'v1', evidenceRef: 'ev2',
  })
  assert.equal(ledger.events.length, 2)
  assert.equal(ledger.history('stu-1')[0].kind, 'granted')
  assert.equal(ledger.history('stu-1')[1].kind, 'revoked')
  assert.equal(
    ledger.isGranted('stu-1', 'twin:observe', '2026-02-03T00:00:00.000Z'),
    false,
  )
})

test('consent: duplicate consentId rejected', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'twin:observe', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  assert.throws(() => {
    ledger.grant({
      consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
      scope: 'twin:observe', at: T0, policyVersion: 'v1', evidenceRef: 'e',
    })
  }, ConsentError)
})

test('consent: unknown scope and subject rejected', () => {
  assert.throws(
    () =>
      new ConsentEvent({
        consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
        scope: 'root:*', kind: 'granted', at: T0, policyVersion: 'v1',
        evidenceRef: 'e',
      }),
    Error,
  )
  assert.throws(
    () =>
      new ConsentEvent({
        consentId: 'c1', studentRef: 'stu-1', subject: 'robot',
        scope: 'twin:observe', kind: 'granted', at: T0, policyVersion: 'v1',
        evidenceRef: 'e',
      }),
    Error,
  )
})

test('consent: expiry must be after grant and only on grant', () => {
  assert.throws(
    () =>
      new ConsentEvent({
        consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
        scope: 'twin:observe', kind: 'granted', at: T0, policyVersion: 'v1',
        evidenceRef: 'e', expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    Error,
  )
  assert.throws(
    () =>
      new ConsentEvent({
        consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
        scope: 'twin:observe', kind: 'revoked', at: T0, policyVersion: 'v1',
        evidenceRef: 'e', expiresAt: '2026-03-01T00:00:00.000Z',
      }),
    Error,
  )
})

test('consent: expired grant is not active', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_STUDENT,
    scope: 'curriculum:read', at: T0, policyVersion: 'v1', evidenceRef: 'e',
    expiresAt: '2026-02-10T00:00:00.000Z',
  })
  assert.equal(
    ledger.isGranted('stu-1', 'curriculum:read', '2026-02-05T00:00:00.000Z'),
    true,
  )
  assert.equal(
    ledger.isGranted('stu-1', 'curriculum:read', '2026-02-10T00:00:00.000Z'),
    false,
  )
})

test('consent: require fails closed without consent', () => {
  const ledger = new ConsentLedger()
  assert.throws(() => ledger.require('stu-1', 'twin:observe', T0), ConsentError)
})

test('consent: minor needs guardian grant for guardian-required scope', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_STUDENT,
    scope: 'intervention:deliver', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  assert.equal(
    ledger.activeScopes('stu-1', T0, 13).includes('intervention:deliver'),
    false,
  )
  assert.equal(
    ledger.activeScopes('stu-1', T0, 20).includes('intervention:deliver'),
    true,
  )
  ledger.grant({
    consentId: 'c2', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'intervention:deliver', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  assert.equal(
    ledger.activeScopes('stu-1', T0, 13).includes('intervention:deliver'),
    true,
  )
})

test('consent: revokeAll is idempotent', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'twin:observe', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  ledger.grant({
    consentId: 'c2', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'report:aggregate', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  assert.equal(ledger.revokeAll('stu-1', T0, 'v2'), 2)
  assert.equal(ledger.revokeAll('stu-1', T0, 'v2'), 0)
  assert.deepEqual(ledger.activeScopes('stu-1', T0), [])
})

test('consent: isMinor bounds', () => {
  assert.equal(isMinor(MINOR_AGE_THRESHOLD - 1), true)
  assert.equal(isMinor(MINOR_AGE_THRESHOLD), false)
  assert.throws(() => isMinor(-1), Error)
  assert.throws(() => isMinor(1.5), Error)
})

test('consent: activeBySubject groups guardian grants', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'twin:observe', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  const grouped = ledger.activeBySubject('stu-1', T0)
  assert.deepEqual(grouped[SUBJECT_GUARDIAN], ['twin:observe'])
})

test('audience: effective scopes narrow but never widen', () => {
  assert.deepEqual(
    effectiveAudienceScopes(AUDIENCE_TEACHER, ['report:aggregate']),
    ['report:aggregate'],
  )
  assert.deepEqual(effectiveAudienceScopes(AUDIENCE_TEACHER, ['audit:export']), [])
})

test('audience: unknown audience and scope rejected', () => {
  assert.throws(() => effectiveAudienceScopes('principal'), AudienceRestrictionError)
  assert.throws(
    () => effectiveAudienceScopes(AUDIENCE_TEACHER, ['root:*']),
    AudienceRestrictionError,
  )
})

test('audience: minor forbidden scope removed for research audience', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_GUARDIAN,
    scope: 'research:aggregate', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  assert.equal(ledger.activeScopes('stu-1', T0, 13).includes('research:aggregate'), true)
  assert.equal(
    authorizedAudienceScopes(AUDIENCE_RESEARCH, ledger, 'stu-1', T0, { age: 13 })
      .includes('research:aggregate'),
    false,
  )
  assert.equal(
    authorizedAudienceScopes(AUDIENCE_RESEARCH, ledger, 'stu-1', T0, { age: 20 })
      .includes('research:aggregate'),
    true,
  )
})

test('audience: student audience only sees own active scopes', () => {
  const ledger = new ConsentLedger()
  ledger.grant({
    consentId: 'c1', studentRef: 'stu-1', subject: SUBJECT_STUDENT,
    scope: 'curriculum:read', at: T0, policyVersion: 'v1', evidenceRef: 'e',
  })
  assert.deepEqual(authorizedAudienceScopes(AUDIENCE_STUDENT, ledger, 'stu-1', T0), [
    'curriculum:read',
  ])
})

test('retention: policy requires every data class', () => {
  assert.throws(
    () =>
      new RetentionPolicy('v1', [
        new RetentionRule(DATA_CLASS_RAW_MEDIA, 30),
      ]),
    RetentionError,
  )
})

test('retention: rule rejects unknown class and mode', () => {
  assert.throws(() => new RetentionRule('secrets', 30), RetentionError)
  assert.throws(
    () => new RetentionRule(DATA_CLASS_RAW_MEDIA, 30, 'burn'),
    RetentionError,
  )
})

test('retention: expiresAt is created plus retain days', () => {
  const policy = new RetentionPolicy(
    'v1',
    DATA_CLASSES.map((dataClass) => new RetentionRule(dataClass, 10)),
  )
  const created = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(
    policy.expiresAt(DATA_CLASS_RAW_MEDIA, created).getTime(),
    created.getTime() + 10 * 24 * 60 * 60 * 1000,
  )
})

test('retention: expired records are inclusive and sorted', () => {
  const rules = DATA_CLASSES.map(
    (dataClass) => new RetentionRule(dataClass, 10),
  )
  const withOverrides = rules.map((rule) => {
    if (rule.dataClass === DATA_CLASS_RAW_MEDIA) {
      return new RetentionRule(DATA_CLASS_RAW_MEDIA, 30, DELETION_ANONYMIZE)
    }
    if (rule.dataClass === DATA_CLASS_LEARNING_EVENTS) {
      return new RetentionRule(DATA_CLASS_LEARNING_EVENTS, 365)
    }
    return rule
  })
  const policy = new RetentionPolicy('v1', withOverrides)
  const records = [
    new RetentionRecord('stu-1', DATA_CLASS_RAW_MEDIA, '2025-12-01T00:00:00.000Z'),
    new RetentionRecord(
      'stu-1',
      DATA_CLASS_LEARNING_EVENTS,
      '2025-02-01T00:00:00.000Z',
    ),
  ]
  const dues = expiredRecords(records, policy, T0)
  assert.deepEqual(
    dues.map((due) => due.dataClass),
    [DATA_CLASS_RAW_MEDIA, DATA_CLASS_LEARNING_EVENTS],
  )
  assert.equal(dues[0].deletionMode, DELETION_ANONYMIZE)
})

test('retention: requests are deterministic per class', () => {
  const policy = new RetentionPolicy(
    'v1',
    DATA_CLASSES.map((dataClass) => new RetentionRule(dataClass, 30)),
  )
  const records = [
    new RetentionRecord('stu-1', DATA_CLASS_RAW_MEDIA, '2025-01-01T00:00:00.000Z'),
    new RetentionRecord(
      'stu-1',
      DATA_CLASS_LEARNING_EVENTS,
      '2025-01-01T00:00:00.000Z',
    ),
  ]
  const dues = expiredRecords(records, policy, T0)
  const requests = retentionRequests(dues, T0)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].reason, 'retention_expiry')
  assert.deepEqual(
    requests.map((request) => request.dataClasses.length),
    [1, 1],
  )
})

test('deletion: propagates across all registered stores', () => {
  const deletion = FIXTURE.deletion
  const coordinator = buildCoordinator(deletion.stores)
  const ledger = ledgerFromFixture(deletion.consentGrants)
  const receipt = coordinator.delete(deletionRequest(deletion.request), {
    ledger,
    now: T0,
  })
  assert.equal(receipt.status, DELETION_COMPLETED)
  assert.equal(receipt.totalDeleted, 15)
  const byStore: Record<string, number> = {}
  for (const result of receipt.results) {
    byStore[result.storeId] = Object.values(result.deleted).reduce(
      (sum, value) => sum + value,
      0,
    )
  }
  assert.deepEqual(byStore, {
    'audit-warehouse': 7,
    'events-primary': 4,
    'media-objects': 4,
  })
  assert.equal(receipt.consentRevoked, 2)
  assert.equal(receipt.accessBlocked, true)
})

test('deletion: store failure produces partial receipt', () => {
  const deletion = FIXTURE.deletion
  const coordinator = buildCoordinator(deletion.stores, true)
  const receipt = coordinator.delete(deletionRequest(deletion.request), { now: T0 })
  assert.equal(receipt.status, DELETION_PARTIAL)
  const failing = receipt.results.find((r) => r.storeId === 'failing-store')!
  assert.equal(failing.status, DELETION_FAILED)
  assert.equal(failing.error, 'DeletionError')
})

test('deletion: all stores failing produces failed receipt', () => {
  const coordinator = new DeletionCoordinator()
  coordinator.register(
    new SyntheticStore('only-store', [DATA_CLASS_RAW_MEDIA], { failOnDelete: true }),
  )
  const request = new DeletionRequest({
    requestId: 'r-fail', studentRef: 'stu-x', requestedAt: T0,
    reason: 'policy', dataClasses: [DATA_CLASS_RAW_MEDIA],
  })
  assert.equal(coordinator.delete(request, { now: T0 }).status, DELETION_FAILED)
})

test('deletion: idempotent by request id', () => {
  const deletion = FIXTURE.deletion
  const coordinator = buildCoordinator(deletion.stores)
  const request = deletionRequest(deletion.request)
  const first = coordinator.delete(request, { now: T0 })
  const second = coordinator.delete(request, { now: T0 })
  assert.equal(first.idempotentReplay, false)
  assert.equal(second.idempotentReplay, true)
  assert.equal(first.totalDeleted, second.totalDeleted)
})

test('deletion: deleted subject reads fail closed', () => {
  const deletion = FIXTURE.deletion
  const coordinator = buildCoordinator(deletion.stores)
  coordinator.delete(deletionRequest(deletion.request), { now: T0 })
  assert.equal(coordinator.isBlocked(deletion.studentRef), true)
  assert.throws(
    () => coordinator.assertReadable(deletion.studentRef),
    DeletionError,
  )
})

test('deletion: duplicate store registration rejected', () => {
  const coordinator = new DeletionCoordinator()
  coordinator.register(new SyntheticStore('s1', [DATA_CLASS_RAW_MEDIA]))
  assert.throws(
    () => coordinator.register(new SyntheticStore('s1', [DATA_CLASS_RAW_MEDIA])),
    DeletionError,
  )
})

test('deletion: unknown reason rejected', () => {
  assert.throws(
    () =>
      new DeletionRequest({
        requestId: 'r', studentRef: 'stu', requestedAt: T0,
        reason: 'because', dataClasses: [DATA_CLASS_RAW_MEDIA],
      }),
    Error,
  )
})

test('deletion: empty data classes rejected', () => {
  assert.throws(
    () =>
      new DeletionRequest({
        requestId: 'r', studentRef: 'stu', requestedAt: T0,
        reason: 'policy', dataClasses: [],
      }),
    Error,
  )
})

test('deletion: receipt json uses snake_case and sorts stores', () => {
  const deletion = FIXTURE.deletion
  const coordinator = buildCoordinator(deletion.stores)
  const receipt = coordinator.delete(deletionRequest(deletion.request), { now: T0 })
  const json = deletionReceiptJson(receipt)
  assert.equal(json.request_id, 'del-req-001')
  assert.equal(json.total_deleted, 15)
  assert.deepEqual(
    json.stores.map((store) => store.store_id),
    ['audit-warehouse', 'events-primary', 'media-objects'],
  )
})

function entriesFromFixture(): AuditEntry[] {
  return FIXTURE.audit.entries.map(
    (record: ConstructorParameters<typeof AuditEntry>[0]) => auditEntry(record),
  )
}

test('audit: window and kind filtering', () => {
  const bundle = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.request),
    T0,
  )
  assert.equal(bundle.entriesUsed, 4)
  assert.equal(bundle.entriesExcluded, 2)
  assert.deepEqual(bundle.countsByKind, {
    'tool.call': 2,
    'approval.record': 1,
    'delivery.receipt': 1,
  })
  assert.deepEqual(bundle.countsByOutcome, { accepted: 3, rejected: 1 })
})

test('audit: end of window is exclusive', () => {
  const bundle = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.request),
    T0,
  )
  assert.equal(bundle.payload.includes('"seq":6'), false)
})

test('audit: default export redacts pseudonymous keys', () => {
  const bundle = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.request),
    T0,
  )
  assert.equal(bundle.redactedKeys, true)
  assert.equal(bundle.payload.includes('"student_key":null'), true)
  assert.equal(bundle.payload.includes('"student_key":"sk-a"'), false)
})

test('audit: optional export includes pseudonymous keys', () => {
  const bundle = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.requestWithKeys),
    T0,
  )
  assert.equal(bundle.redactedKeys, false)
  assert.equal(bundle.payload.includes('"student_key":"sk-a"'), true)
})

test('audit: digest matches fixture', () => {
  const bundle = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.request),
    T0,
  )
  assert.equal(bundle.digest, FIXTURE.audit.expectedDigest)
  const withKeys = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.requestWithKeys),
    T0,
  )
  assert.equal(withKeys.digest, FIXTURE.audit.expectedDigestWithKeys)
})

test('audit: teacher cannot export audit', () => {
  const request = FIXTURE.audit.request as AuditExportRequestInput
  assert.throws(
    () =>
      exportAudit(
        entriesFromFixture(),
        new AuditExportRequest({ ...request, audience: 'teacher' }),
        T0,
      ),
    AudienceRestrictionError,
  )
})

test('audit: forbidden detail keys rejected', () => {
  assert.throws(
    () =>
      new AuditEntry({
        seq: 1, at: T0, kind: 'tool.call', action: 't', outcome: AUDIT_REJECTED,
        detail: { answer: '42' },
      }),
    AuditExportError,
  )
})

test('audit: nested detail values rejected', () => {
  assert.throws(
    () =>
      new AuditEntry({
        seq: 1, at: T0, kind: 'tool.call', action: 't', outcome: AUDIT_REJECTED,
        detail: { steps: ['a', 'b'] },
      }),
    AuditExportError,
  )
})

test('audit: unknown kind and outcome rejected', () => {
  assert.throws(
    () => new AuditEntry({ seq: 1, at: T0, kind: 'magic', action: 't', outcome: AUDIT_REJECTED }),
    AuditExportError,
  )
  assert.throws(
    () => new AuditEntry({ seq: 1, at: T0, kind: 'tool.call', action: 't', outcome: 'maybe' }),
    AuditExportError,
  )
})

test('metrics: snapshot aggregates observed metrics', () => {
  const dashboard = new MetricsDashboard()
  for (const record of FIXTURE.metrics.samples) {
    dashboard.ingest(
      new MetricSample({
        metric: record.metric, value: record.value, at: record.at,
        source: record.source, studentKey: record.studentKey, tenantKey: record.tenantKey,
      }),
    )
  }
  const snapshot = dashboard.snapshot({ generatedAt: T0 })
  assert.equal(snapshot.totalSamples, 10)
  assert.equal(snapshot.excludedOtherChannel, 5)
  const accuracy = snapshot.cells.find((cell) => cell.metric === 'independent_accuracy')!
  assert.equal(accuracy.value, 0.65)
  assert.equal(accuracy.sampleCount, 8)
  const minutes = snapshot.cells.find((cell) => cell.metric === 'learning_minutes')!
  assert.equal(minutes.value, 75)
})

test('metrics: simulated learning sample rejected', () => {
  const dashboard = new MetricsDashboard()
  assert.throws(
    () =>
      dashboard.ingest(
        new MetricSample({
          metric: 'independent_accuracy', value: 0.9, at: T0,
          source: SOURCE_SIMULATED,
        }),
      ),
    MetricsError,
  )
})

test('metrics: simulated system sample allowed', () => {
  const dashboard = new MetricsDashboard()
  dashboard.ingest(
    new MetricSample({
      metric: 'tool_latency_ms', value: 120, at: T0, source: SOURCE_SIMULATED,
    }),
  )
  const snapshot = dashboard.snapshot({ channel: SOURCE_SIMULATED, generatedAt: T0 })
  assert.equal(
    snapshot.cells.find((cell) => cell.metric === 'tool_latency_ms')!.value,
    120,
  )
})

test('metrics: unknown metric and source rejected', () => {
  const dashboard = new MetricsDashboard()
  assert.throws(
    () =>
      dashboard.ingest(
        new MetricSample({ metric: 'vibes', value: 1, at: T0, source: SOURCE_OBSERVED }),
      ),
    MetricsError,
  )
  assert.throws(
    () =>
      new MetricSample({
        metric: 'near_transfer', value: 1, at: T0, source: 'psychic',
      }),
    MetricsError,
  )
})

test('metrics: cohort view suppresses small groups', () => {
  const dashboard = new MetricsDashboard()
  for (const record of FIXTURE.metrics.samples) {
    dashboard.ingest(
      new MetricSample({
        metric: record.metric, value: record.value, at: record.at,
        source: record.source, studentKey: record.studentKey, tenantKey: record.tenantKey,
      }),
    )
  }
  const view = dashboard.cohortView('independent_accuracy', { minCohortSize: 5 })
  assert.equal(view.suppressedCohorts, 1)
  assert.equal(view.cells.length, 1)
  assert.equal(view.cells[0].studentKey, 'stu-a')
  assert.equal(view.cells[0].value, 0.7)
})

test('metrics: snapshot student cohorts suppress small groups', () => {
  const dashboard = new MetricsDashboard()
  for (const record of FIXTURE.metrics.samples) {
    dashboard.ingest(
      new MetricSample({
        metric: record.metric, value: record.value, at: record.at,
        source: record.source, studentKey: record.studentKey, tenantKey: record.tenantKey,
      }),
    )
  }
  const data = dashboardSnapshotJson(dashboard.snapshot({ generatedAt: T0 }))
  assert.deepEqual(data.student_cohorts, { 'stu-a': 8 })
  assert.equal(data.suppressed_cohorts, 1)
})

test('metrics: aggregation modes sum mean and gauge', () => {
  const definitions: Record<string, MetricDefinition> = {
    custom_sum: new MetricDefinition({
      name: 'custom_sum', dimension: DIMENSION_SYSTEM, unit: 'n', aggregation: AGG_SUM,
    }),
    custom_mean: new MetricDefinition({
      name: 'custom_mean', dimension: DIMENSION_SYSTEM, unit: 'n', aggregation: AGG_MEAN,
    }),
    custom_gauge: new MetricDefinition({
      name: 'custom_gauge', dimension: DIMENSION_SYSTEM, unit: 'n', aggregation: AGG_GAUGE,
    }),
  }
  const dashboard = new MetricsDashboard(definitions)
  const values = [1, 2, 6]
  values.forEach((value, index) => {
    for (const metric of Object.keys(definitions)) {
      dashboard.ingest(
        new MetricSample({
          metric,
          value,
          at: new Date(Date.UTC(2026, 0, 1, index)),
          source: SOURCE_OBSERVED,
        }),
      )
    }
  })
  const snapshot = dashboard.snapshot({ generatedAt: T0 })
  const cell = (metric: string) => snapshot.cells.find((c) => c.metric === metric)!
  assert.equal(cell('custom_sum').value, 9)
  assert.equal(cell('custom_mean').value, 3)
  assert.equal(cell('custom_gauge').value, 6)
})

test('metrics: unknown channel rejected', () => {
  assert.throws(
    () => new MetricsDashboard().snapshot({ channel: 'imaginary' }),
    MetricsError,
  )
})

test('metrics: definition registry covers all dimensions', () => {
  const dimensions = new Set(
    Object.values(METRIC_DEFINITIONS).map((definition) => definition.dimension),
  )
  assert.deepEqual([...dimensions].sort(), [...METRIC_DIMENSIONS].sort())
  assert.equal(METRIC_DEFINITIONS.independent_accuracy.simulatedAllowed, false)
  assert.equal(METRIC_DEFINITIONS.virtual_real_gain_gap.simulatedAllowed, true)
  assert.equal(METRIC_DEFINITIONS.independent_accuracy.dimension, DIMENSION_LEARNING)
})

test('metrics: cohort view json shape', () => {
  const dashboard = new MetricsDashboard()
  dashboard.ingest(
    new MetricSample({
      metric: 'independent_accuracy', value: 0.5, at: T0,
      source: SOURCE_OBSERVED, studentKey: 'stu-z',
    }),
  )
  const json = cohortViewJson(
    dashboard.cohortView('independent_accuracy', { minCohortSize: 1 }),
  )
  assert.equal(json.suppressed_cohorts, 0)
  assert.deepEqual((json.cells as { student_key: string }[])[0].student_key, 'stu-z')
})

test('cost: estimate matches fixture components and total', () => {
  const spec = FIXTURE.cost.small
  const estimate = estimateCost(
    usageRecord(spec.usage),
    new CostEstimator().models[spec.modelId],
  )
  assert.equal(estimate.total, spec.expectedTotal)
  for (const key of Object.keys(spec.expectedComponents)) {
    assert.equal(estimate.components[key], spec.expectedComponents[key])
  }
})

test('cost: never connected to real billing', () => {
  const spec = FIXTURE.cost.small
  const estimate = estimateCost(
    usageRecord(spec.usage),
    new CostEstimator().models[spec.modelId],
  )
  assert.equal(BILLING_CONNECTED, false)
  assert.equal(estimate.billingConnected, false)
  assert.equal(estimate.synthetic, true)
})

test('cost: multi model total', () => {
  const spec = FIXTURE.cost.multi
  const usageByModel: Record<string, UsageRecord> = {}
  for (const modelId of Object.keys(spec.usageByModel)) {
    usageByModel[modelId] = usageRecord(spec.usageByModel[modelId])
  }
  const estimate = new CostEstimator().estimateMulti(usageByModel)
  assert.equal(estimate.total, spec.expectedTotal)
})

test('cost: budget check', () => {
  const estimator = new CostEstimator()
  const small = estimator.estimate(
    usageRecord(FIXTURE.cost.small.usage),
    FIXTURE.cost.small.modelId,
  )
  const large = estimator.estimate(
    usageRecord(FIXTURE.cost.large.usage),
    FIXTURE.cost.large.modelId,
  )
  const budget = FIXTURE.cost.budget as number
  assert.equal(CostEstimator.withinBudget(small, budget), true)
  assert.equal(CostEstimator.withinBudget(large, budget), false)
})

test('cost: negative usage rejected', () => {
  assert.throws(() => new UsageRecord({ inputTokens: -1 }), Error)
  assert.throws(() => new CostModel({ modelId: 'm', toolCallUsd: -0.1 }), Error)
})

test('cost: unknown model rejected', () => {
  assert.throws(
    () => new CostEstimator().estimate(new UsageRecord(), 'gpt-imaginary'),
    MetricsError,
  )
})

test('cost: negative budget rejected', () => {
  const estimate = estimateCost(
    new UsageRecord(),
    new CostEstimator().models['synthetic-llm-small'],
  )
  assert.throws(() => CostEstimator.withinBudget(estimate, -1), Error)
})

test('cost: estimate json shape', () => {
  const spec = FIXTURE.cost.small
  const estimate = estimateCost(
    usageRecord(spec.usage),
    new CostEstimator().models[spec.modelId],
  )
  const json = costEstimateJson(estimate)
  assert.equal(json.billing_connected, false)
  assert.equal(json.total, spec.expectedTotal)
})

// --- cross-language fixture parity -----------------------------------------

test('fixture parity: consent active scopes', () => {
  const consent = FIXTURE.consent
  const ledger = ledgerFromFixture(consent.events)
  assert.deepEqual(
    ledger.activeScopes(consent.studentRef, consent.at, 13),
    consent.expectedActiveScopesMinor,
  )
  assert.deepEqual(
    ledger.activeScopes(consent.studentRef, consent.at, 20),
    consent.expectedActiveScopesAdult,
  )
})

test('fixture parity: audience scopes', () => {
  const consent = FIXTURE.consent
  const cases: [string, string, number][] = [
    ['teacherMinor', AUDIENCE_TEACHER, 13],
    ['teacherAdult', AUDIENCE_TEACHER, 20],
    ['studentMinor', AUDIENCE_STUDENT, 13],
    ['adminMinor', AUDIENCE_ADMIN, 13],
    ['adminAdult', AUDIENCE_ADMIN, 20],
    ['researchMinor', AUDIENCE_RESEARCH, 13],
    ['researchAdult', AUDIENCE_RESEARCH, 20],
  ]
  for (const [key, audience, age] of cases) {
    const ledger = ledgerFromFixture(consent.events)
    assert.deepEqual(
      authorizedAudienceScopes(audience, ledger, consent.studentRef, consent.at, {
        age,
      }),
      consent.expectedAudienceScopes[key],
    )
  }
})

test('fixture parity: deletion receipt', () => {
  const deletion = FIXTURE.deletion
  const coordinator = buildCoordinator(deletion.stores)
  const ledger = ledgerFromFixture(deletion.consentGrants)
  const receipt = coordinator.delete(deletionRequest(deletion.request), {
    ledger,
    now: deletion.now,
  })
  assert.equal(receipt.status, deletion.expectedStatus)
  assert.equal(receipt.totalDeleted, deletion.expectedTotalDeleted)
  const byStore: Record<string, number> = {}
  for (const result of receipt.results) {
    byStore[result.storeId] = Object.values(result.deleted).reduce(
      (sum, value) => sum + value,
      0,
    )
  }
  assert.deepEqual(byStore, deletion.expectedByStore)
  assert.equal(receipt.consentRevoked, deletion.expectedConsentRevoked)
})

function dueJson(due: RetentionDue): Record<string, unknown> {
  return {
    student_ref: due.studentRef,
    data_class: due.dataClass,
    created_at: due.createdAt.toISOString(),
    expires_at: due.expiresAt.toISOString(),
    deletion_mode: due.deletionMode,
  }
}

test('fixture parity: retention dues', () => {
  const retention = FIXTURE.retention
  const policy = retentionPolicy(FIXTURE.deletion.policy)
  const records = retention.records.map(
    (record: { studentRef: string; dataClass: string; createdAt: string }) =>
      new RetentionRecord(record.studentRef, record.dataClass, record.createdAt),
  )
  const dues = expiredRecords(records, policy, retention.now)
  assert.deepEqual(dues.map(dueJson), retention.expectedDue)
})

test('fixture parity: audit export json', () => {
  const bundle = exportAudit(
    entriesFromFixture(),
    new AuditExportRequest(FIXTURE.audit.request),
    T0,
  )
  const json = auditExportJson(bundle)
  assert.equal(json.entries_used, FIXTURE.audit.expectedEntriesUsed)
  assert.equal(json.entries_excluded, FIXTURE.audit.expectedEntriesExcluded)
  assert.deepEqual(json.counts_by_kind, FIXTURE.audit.expectedCountsByKind)
  assert.deepEqual(json.counts_by_outcome, FIXTURE.audit.expectedCountsByOutcome)
  assert.equal(json.digest, FIXTURE.audit.expectedDigest)
})

test('fixture parity: metrics snapshot values', () => {
  const dashboard = new MetricsDashboard()
  for (const record of FIXTURE.metrics.samples) {
    dashboard.ingest(
      new MetricSample({
        metric: record.metric, value: record.value, at: record.at,
        source: record.source, studentKey: record.studentKey, tenantKey: record.tenantKey,
      }),
    )
  }
  const snapshot = dashboard.snapshot({ generatedAt: T0 })
  const accuracy = snapshot.cells.find((cell) => cell.metric === 'independent_accuracy')!
  assert.equal(accuracy.value, FIXTURE.metrics.expectedIndependentAccuracy)
  assert.equal(
    accuracy.sampleCount,
    FIXTURE.metrics.expectedIndependentAccuracySampleCount,
  )
  const minutes = snapshot.cells.find((cell) => cell.metric === 'learning_minutes')!
  assert.equal(minutes.value, FIXTURE.metrics.expectedLearningMinutes)
  const view = dashboard.cohortView('independent_accuracy', { minCohortSize: 5 })
  assert.deepEqual(
    view.cells.map((cell) => ({
      studentKey: cell.studentKey,
      value: cell.value,
      sampleCount: cell.sampleCount,
    })),
    FIXTURE.metrics.expectedCohortCells,
  )
  assert.equal(view.suppressedCohorts, FIXTURE.metrics.expectedSuppressedCohorts)
})

test('fixture parity: cost totals', () => {
  const estimator = new CostEstimator()
  for (const key of ['small', 'large']) {
    const spec = FIXTURE.cost[key]
    const estimate = estimator.estimate(usageRecord(spec.usage), spec.modelId)
    assert.equal(estimate.total, spec.expectedTotal)
  }
  const multi = estimator.estimateMulti({
    'synthetic-llm-small': usageRecord(FIXTURE.cost.multi.usageByModel['synthetic-llm-small']),
    'synthetic-llm-large': usageRecord(FIXTURE.cost.multi.usageByModel['synthetic-llm-large']),
  })
  assert.equal(multi.total, FIXTURE.cost.multi.expectedTotal)
})
