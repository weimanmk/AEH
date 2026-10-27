/**
 * Step 18 isolated end-to-end entry (synthetic only).
 *
 * The running harness never loads this file. It exists so an **independent**
 * dsh instance (own `$DSH_HOME`, own profile, own npm install, under
 * `step18/`) can mount the AEH plugin with a host-owned resolver, because the
 * plugin's `host` (HostContext) is deliberately not a serialisable YAML field:
 * `src/index.ts` defaults to "resolve nothing" and every gate/probe/intervention
 * call then fails closed.
 *
 * This wrapper owns one synthetic session and passes
 * `MemoryHostContext#toHostBinding()` into the real plugin `apply`. It adds no
 * tool, no permission, no long-term twin write, and no network/filesystem
 * access; it is the same six tools with a fixed synthetic progress/catalog.
 */

import type { Context } from '../src/dsh.ts'
import type { CurriculumItem, LearnerProgress } from '../src/domain.ts'
import { ConsentSnapshot } from '../src/host/consent.ts'
import { MemoryHostContext } from '../src/host/host-context.ts'
import * as aeh from '../src/index.ts'

export const name = `${aeh.name}.synthetic-host`

export const inject = aeh.inject

/** Same Schemastery config as the plugin; `host` stays host-injected. */
export const Config = aeh.Config

/** Opaque synthetic student reference; no real learner data exists here. */
export const STUDENT_REF = 'synthetic.student.step18'
export const SESSION_ID = 'session.aeh.step18'
export const TENANT_ID = 'tenant.aeh.step18'

/**
 * Synthetic progress used by the acceptance session. Only the KCs named here
 * are allowed by the gate; `kc.fraction.multiply` is intentionally absent so a
 * future-method/untaught-KC candidate is refused fail-closed.
 */
export const SYNTHETIC_PROGRESS: LearnerProgress = Object.freeze({
  studentRef: STUDENT_REF,
  gradeLevel: 5,
  taughtKcs: Object.freeze(['kc.fraction.add', 'kc.fraction.equiv']),
  inProgressKcs: Object.freeze(['kc.fraction.compare']),
  confirmedPreviewKcs: Object.freeze([]),
  confirmedPriorKcs: Object.freeze(['kc.place.value']),
  progressConfidence: 0.95,
  currentLoad: 0.1,
  loadBudget: 1,
})

/**
 * Synthetic catalog: all annotations are synthetic. `item.fraction.multiply.001`
 * requires an untaught KC, so the gate rejects it and the session can prove
 * fail-closed behaviour end to end.
 */
export const SYNTHETIC_CATALOG: readonly CurriculumItem[] = Object.freeze([
  Object.freeze({
    itemId: 'item.fraction.add.001',
    requiredKcs: Object.freeze(['kc.fraction.add']),
    gradeLevel: 5,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 0.95,
    futureMethods: Object.freeze([]),
    cognitiveLoad: 0.2,
    role: 'training' as const,
    seenBefore: false,
  }),
  Object.freeze({
    itemId: 'item.fraction.equiv.001',
    requiredKcs: Object.freeze(['kc.fraction.equiv']),
    gradeLevel: 5,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 0.94,
    futureMethods: Object.freeze([]),
    cognitiveLoad: 0.25,
    role: 'diagnostic' as const,
    seenBefore: false,
  }),
  Object.freeze({
    itemId: 'item.fraction.compare.001',
    requiredKcs: Object.freeze(['kc.fraction.compare']),
    gradeLevel: 5,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 0.9,
    futureMethods: Object.freeze([]),
    cognitiveLoad: 0.3,
    role: 'diagnostic' as const,
    seenBefore: false,
  }),
  Object.freeze({
    itemId: 'item.fraction.place.001',
    requiredKcs: Object.freeze(['kc.place.value']),
    gradeLevel: 4,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 0.92,
    futureMethods: Object.freeze([]),
    cognitiveLoad: 0.15,
    role: 'transfer' as const,
    seenBefore: false,
  }),
  Object.freeze({
    itemId: 'item.fraction.multiply.001',
    requiredKcs: Object.freeze(['kc.fraction.multiply']),
    gradeLevel: 5,
    safetyChecked: true,
    contentVerified: true,
    annotationConfidence: 0.9,
    futureMethods: Object.freeze([]),
    cognitiveLoad: 0.3,
    role: 'training' as const,
    seenBefore: false,
  }),
])

/** One session-bound host; consent is the single explicit read scope. */
export function createSyntheticHost(): MemoryHostContext {
  return new MemoryHostContext({
    session: {
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      studentRef: STUDENT_REF,
    },
    consent: ConsentSnapshot.granted(['curriculum:read']),
    progress: [SYNTHETIC_PROGRESS],
    catalog: SYNTHETIC_CATALOG,
  })
}

/** Mount the real AEH plugin with the synthetic host resolver attached. */
export function apply(
  ctx: Context,
  config: aeh.PluginConfig = {},
): void {
  const host = createSyntheticHost()
  aeh.apply(ctx, { ...config, host: host.toHostBinding() })
}
