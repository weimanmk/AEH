/**
 * File event store tests (synthetic/test only).
 *
 * The store is disabled by default, only accepts a synthetic root/student, and
 * models append-only persistence, idempotency, version/rollback, retention
 * tombstones, and consent-withdrawal deletion propagation. All files live in a
 * throwaway OS temp directory; no `~/.dsh`, npx install, or running harness
 * state is touched.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FileEventStore,
  FileEventStoreConfigError,
  FileEventStoreDisabledError,
  FileEventStoreIntegrityError,
  FileStoreConsentError,
} from '../src/host/file-event-store.ts'
import { ConsentSnapshot } from '../src/host/consent.ts'
import type {
  AttestationVerifier,
  SourceAttestation,
} from '../src/host/twin-adapter.ts'

const STUDENT_REF = 'synthetic.student.001'
const NOW = '2026-03-10T00:00:00.000Z'
const roots: string[] = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aeh-file-store-'))
  roots.push(root)
  return root
}

function observeConsent(): ConsentSnapshot {
  return ConsentSnapshot.granted(['twin:observe', 'twin:rollback'])
}

const verifyToken: AttestationVerifier = (attestation) =>
  attestation.token === 'synthetic-file-token'

function attestationFor(
  source: string,
  overrides: Partial<SourceAttestation> = {},
): SourceAttestation {
  return {
    issuer: 'test.school-gateway',
    source,
    subjectRef: STUDENT_REF,
    issuedAt: '2026-03-02T09:00:00.000Z',
    token: 'synthetic-file-token',
    ...overrides,
  }
}

function makeStore(options: {
  root?: string
  consent?: ConsentSnapshot
  enabled?: boolean
  retentionDays?: number
} = {}): { store: FileEventStore; root: string; consent: ConsentSnapshot } {
  const root = options.root ?? makeRoot()
  const consent = options.consent ?? observeConsent()
  const store = new FileEventStore({
    studentRef: STUDENT_REF,
    directory: join(root, 'store'),
    syntheticRoot: root,
    consent,
    verifyAttestation: verifyToken,
    enabled: options.enabled ?? true,
    retentionDays: options.retentionDays,
    now: () => NOW,
  })
  return { store, root, consent }
}

function eventInput(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'ev.file.001',
    eventType: 'attempt',
    source: 'trusted_grader',
    studentRef: STUDENT_REF,
    occurredAt: '2026-03-02T09:00:00.000Z',
    observedAt: '2026-03-02T09:00:01.000Z',
    consentScope: 'educational_assistance',
    payload: { correct: true, answer: 'synthetic-answer' },
    ...overrides,
  }
}

test('file store is disabled by default and inert until enabled', () => {
  const { store } = makeStore({ enabled: false })
  assert.equal(store.enabled, false)
  assert.throws(
    () => store.append(eventInput(), attestationFor('trusted_grader')),
    FileEventStoreDisabledError,
  )
  assert.throws(() => store.readObserved(), FileEventStoreDisabledError)
  assert.throws(() => store.applyRetention(NOW), FileEventStoreDisabledError)
})

test('file store refuses a non-synthetic root or student reference', () => {
  const root = makeRoot()
  assert.throws(
    () =>
      new FileEventStore({
        studentRef: STUDENT_REF,
        directory: join(root, '..', 'outside'),
        syntheticRoot: root,
        consent: observeConsent(),
        verifyAttestation: verifyToken,
        enabled: true,
      }),
    FileEventStoreConfigError,
  )
  assert.throws(
    () =>
      new FileEventStore({
        studentRef: 'real.student.001',
        directory: join(root, 'store'),
        syntheticRoot: root,
        consent: observeConsent(),
        verifyAttestation: verifyToken,
        enabled: true,
      }),
    FileEventStoreConfigError,
  )
})

test('append persists an opaque, payload-free record and replay is idempotent', () => {
  const { store, root } = makeStore()
  const first = store.append(eventInput(), attestationFor('trusted_grader'))
  assert.equal(first.replayed, false)
  assert.equal(store.readObserved().length, 1)

  const replay = store.append(eventInput(), attestationFor('trusted_grader'))
  assert.equal(replay.replayed, true)
  assert.equal(store.readObserved().length, 1)

  const raw = readFileSync(join(root, 'store', 'events.jsonl'), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(raw.includes('synthetic-answer'), false)
  assert.equal(raw.includes('"payload"'), false)
  const record = JSON.parse(lines[0]) as Record<string, unknown>
  assert.equal(record.eventRef, 'ev.file.001')
  assert.equal(record.consentScope, 'educational_assistance')
  assert.equal(typeof record.checksum, 'string')
})

test('file store only persists real observed sources', () => {
  const { store } = makeStore()
  assert.throws(
    () =>
      store.append(
        eventInput({ eventId: 'ev.sim.file', source: 'virtual_student' }),
        attestationFor('virtual_student'),
      ),
    FileEventStoreConfigError,
  )
  assert.equal(store.readObserved().length, 0)
})

test('a fresh store loads persisted evidence and detects tampering', () => {
  const { store, root } = makeStore()
  store.append(eventInput(), attestationFor('trusted_grader'))

  const { store: reopened } = makeStore({ root })
  assert.equal(reopened.load(), 1)
  assert.equal(reopened.readObserved().length, 1)
  assert.equal(reopened.readObserved()[0]?.eventRef, 'ev.file.001')
  assert.equal(reopened.evidenceRevision, 1)

  const eventsPath = join(root, 'store', 'events.jsonl')
  const tampered = readFileSync(eventsPath, 'utf8').replace(
    '"eventType":"attempt"',
    '"eventType":"tampered"',
  )
  writeFileSync(eventsPath, tampered, 'utf8')
  const { store: corrupt } = makeStore({ root })
  assert.throws(() => corrupt.load(), FileEventStoreIntegrityError)
})

test('versioned mastery updates can be rolled back without deleting evidence', () => {
  const { store } = makeStore()
  store.append(eventInput(), attestationFor('trusted_grader'))
  store.append(
    eventInput({ eventId: 'ev.file.002', source: 'teacher' }),
    attestationFor('teacher'),
  )
  store.updateMastery('kc.fraction.add', 0.4, 0.3, ['ev.file.001'])
  store.updateMastery('kc.fraction.equiv', 0.7, 0.2, ['ev.file.002'])
  assert.equal(store.version, 2)

  const rolledBack = store.rollback(1)
  assert.equal(rolledBack.toVersion, 1)
  assert.equal(rolledBack.state.knowledge.has('kc.fraction.equiv'), false)
  assert.equal(store.readObserved().length, 2)
})

test('retention tombstones expired events without rewriting the append-only log', () => {
  const { store, root } = makeStore({ retentionDays: 30 })
  store.append(
    eventInput({
      eventId: 'ev.old',
      occurredAt: '2026-01-01T09:00:00.000Z',
      observedAt: '2026-01-01T09:00:01.000Z',
    }),
    attestationFor('trusted_grader'),
  )
  store.append(
    eventInput({
      eventId: 'ev.recent',
      occurredAt: '2026-03-09T09:00:00.000Z',
      observedAt: '2026-03-09T09:00:01.000Z',
    }),
    attestationFor('trusted_grader'),
  )
  const before = readFileSync(join(root, 'store', 'events.jsonl'), 'utf8')

  assert.equal(store.applyRetention(NOW), 1)
  assert.deepEqual(
    store.readObserved().map((record) => record.eventRef),
    ['ev.recent'],
  )
  assert.equal(store.tombstonesList()[0]?.reason, 'retention_expired')
  // The event log itself is append-only and byte-for-byte unchanged.
  assert.equal(readFileSync(join(root, 'store', 'events.jsonl'), 'utf8'), before)
})

test('withdrawing observe consent propagates deletion and fails reads closed', () => {
  const { store, root, consent } = makeStore()
  store.append(eventInput(), attestationFor('trusted_grader'))
  store.append(
    eventInput({ eventId: 'ev.file.002', source: 'teacher' }),
    attestationFor('teacher'),
  )
  assert.equal(store.readObserved().length, 2)

  assert.equal(
    store.withdrawConsent('twin:observe', '2026-03-10T00:00:01.000Z'),
    2,
  )
  assert.equal(consent.has('twin:observe'), false)
  assert.equal(store.tombstonesList().length, 2)
  assert.ok(
    store.tombstonesList().every((entry) => entry.reason === 'consent_withdrawn'),
  )
  assert.throws(() => store.readObserved(), FileStoreConsentError)
  assert.throws(
    () => store.append(eventInput({ eventId: 'ev.after' }), attestationFor('trusted_grader')),
    FileStoreConsentError,
  )
  assert.throws(() => store.load(), FileStoreConsentError)

  // A reopened store with the same (now revoked) consent snapshot stays denied.
  const { store: reopened } = makeStore({ root, consent })
  assert.throws(() => reopened.readObserved(), FileStoreConsentError)
})
