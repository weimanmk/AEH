/**
 * Host-side controlled self-evolution skeleton (spec section 27).
 *
 * This module is the TypeScript mirror of `aeh/evolution.py`. It is **not**
 * registered as a model-callable tool: approval, canary control, promotion,
 * and rollback are host-side operations, and the plugin exposes no
 * `aeh_*_evolution_*` tool. A model can at most produce a declarative
 * candidate record; it can never approve, promote, or roll it back.
 *
 * Hard rules encoded here:
 * - a candidate is a versioned, declarative `config` / `policy` /
 *   `prompt_template` change record. It cannot name production files, cannot
 *   carry executable code, and cannot touch the protected invariants
 *   (curriculum/safety gate, permissions, consent, privacy, real/simulated
 *   isolation, observed-twin writes, self-approval, rollback authority, raw
 *   student data);
 * - isolated evaluation keeps simulated benefit and real transfer separate,
 *   rejects failed/insufficient evidence automatically, and never lets
 *   simulated gain be the sole promotion reward;
 * - approval is explicit (approver/time/reason), default-deny, host-side, and
 *   never the candidate's own author;
 * - the canary only changes the proportion of *synthetic* sessions, carries
 *   circuit-breaker conditions, and rolls back on a trip;
 * - rollback restores the previous stable version and appends an event;
 * - one append-only audit log records every stage and rejects raw student
 *   data keys.
 *
 * It has no filesystem, network, database, or production access.
 */

export const PRODUCTION_MUTATION_ENABLED = false
export const SANDBOX_HAS_PRODUCTION_ACCESS = false
export const SYNTHETIC_FIXTURES_ONLY = true

export const CANDIDATE_KINDS = Object.freeze([
  'config',
  'policy',
  'prompt_template',
] as const)
export type CandidateKind = (typeof CANDIDATE_KINDS)[number]

export const CANDIDATE_SOURCES = Object.freeze([
  'drift_detector',
  'error_report',
  'teacher_feedback',
  'eval_regression',
  'tool_failure',
  'cost_report',
  'content_review',
  'human_request',
] as const)

export const ALLOWED_IMPACT_SCOPES = Object.freeze([
  'teaching_policy',
  'prompt_template',
  'hint_ladder',
  'item_ordering',
  'diagnostic_probe_policy',
  'review_scheduling',
  'report_template',
  'simulation_parameters',
  'tool_timeout',
  'caching',
] as const)

/** Core invariants this pipeline may never change (spec 27.1). */
export const PROTECTED_INVARIANTS = Object.freeze([
  'curriculum_gate',
  'safety_gate',
  'content_verification',
  'permissions',
  'consent',
  'privacy',
  'observed_twin_write',
  'real_simulated_isolation',
  'self_approval',
  'rollback_authority',
  'student_raw_data',
  'database_write',
  'credentials',
  'network',
  'arbitrary_filesystem',
] as const)

export const HOST_ROLES = Object.freeze([
  'platform_operator',
  'reviewer',
  'security_reviewer',
  'teacher',
  'administrator',
] as const)
export type HostRole = (typeof HOST_ROLES)[number]

export const CANDIDATE_STATUSES = Object.freeze([
  'proposed',
  'evaluated',
  'rejected',
  'approved',
  'canary',
  'promoted',
  'rolled_back',
] as const)
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const EVOLUTION_ACTIONS = Object.freeze([
  'candidate.registered',
  'candidate.sandboxed',
  'candidate.evaluated',
  'candidate.rejected',
  'candidate.approved',
  'candidate.approval_rejected',
  'canary.started',
  'canary.observed',
  'canary.circuit_breaker',
  'candidate.promoted',
  'rollback.completed',
] as const)
export type EvolutionAction = (typeof EVOLUTION_ACTIONS)[number]

export const AUDIT_FORBIDDEN_KEYS = Object.freeze([
  'payload',
  'answer',
  'answers',
  'raw',
  'raw_student_data',
  'student_name',
  'student_email',
  'email',
  'phone',
  'address',
  'image',
  'images',
  'solution',
  'trace',
  'steps',
  'transcript',
  'free_text',
] as const)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EvolutionError extends Error {
  readonly code: string = 'AEH_EVOLUTION_ERROR'
}

export class CandidateValidationError extends EvolutionError {
  readonly code: string = 'AEH_EVOLUTION_CANDIDATE_INVALID'
}

export class ProtectedInvariantError extends CandidateValidationError {
  readonly code = 'AEH_EVOLUTION_PROTECTED_INVARIANT'
}

export class DuplicateCandidateError extends CandidateValidationError {
  readonly code = 'AEH_EVOLUTION_DUPLICATE_CANDIDATE'
}

export class LifecycleError extends EvolutionError {
  readonly code = 'AEH_EVOLUTION_LIFECYCLE'
}

export class ApprovalDeniedError extends EvolutionError {
  readonly code = 'AEH_EVOLUTION_APPROVAL_DENIED'
}

export class CanaryDeniedError extends EvolutionError {
  readonly code = 'AEH_EVOLUTION_CANARY_DENIED'
}

export class RollbackDeniedError extends EvolutionError {
  readonly code = 'AEH_EVOLUTION_ROLLBACK_DENIED'
}

export class AuditError extends EvolutionError {
  readonly code = 'AEH_EVOLUTION_AUDIT_REJECTED'
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertIdentifier(value: string, field: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CandidateValidationError(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new CandidateValidationError(`${field} is too long`)
  }
  if (/\s/.test(value)) {
    throw new CandidateValidationError(`${field} must not contain whitespace`)
  }
  return value
}

function assertText(value: string, field: string, maxLength = 2000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CandidateValidationError(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new CandidateValidationError(`${field} is too long`)
  }
  return value
}

function assertTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CandidateValidationError(`${field} must be an ISO timestamp`)
  }
  return value
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

function assertDeclarative(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDeclarative(item, `${path}[${index}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertDeclarative(item, `${path}.${key}`)
    }
    return
  }
  throw new CandidateValidationError(
    `${path} must be declarative JSON data, got ${typeof value}`,
  )
}

function protectedToken(text: string): string | null {
  const normalized = text.trim().toLowerCase()
  for (const invariant of PROTECTED_INVARIANTS) {
    if (normalized.includes(invariant)) return invariant
  }
  return null
}

function assertNoProtectedKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProtectedKeys(item, `${path}[${index}]`))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    const token = protectedToken(key)
    if (token !== null) {
      throw new ProtectedInvariantError(
        `candidate field ${path}.${key} touches protected invariant ` +
          `'${token}'; that change needs a separate governance process`,
      )
    }
    assertNoProtectedKeys(item, `${path}.${key}`)
  }
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item))
  } else if (isPlainObject(value)) {
    Object.values(value).forEach((item) => deepFreeze(item))
  }
  return Object.freeze(value) as T
}

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

export interface Candidate {
  readonly candidateId: string
  readonly version: string
  readonly kind: CandidateKind
  readonly source: string
  readonly changeSummary: string
  readonly impactScope: readonly string[]
  readonly baselineVersion: string
  readonly changes: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly author: string
  /** Must stay empty: a candidate can never name production files. */
  readonly targetFiles?: readonly string[]
  /** Must stay false: promotion is a host decision, not a candidate action. */
  readonly mutatesProduction?: boolean
}

function validateCandidate(candidate: Candidate): Candidate {
  if (!isPlainObject(candidate)) {
    throw new CandidateValidationError('candidate must be an object')
  }
  assertIdentifier(candidate.candidateId, 'candidateId')
  assertIdentifier(candidate.version, 'version')
  if (!(CANDIDATE_KINDS as readonly string[]).includes(candidate.kind)) {
    throw new CandidateValidationError(
      `unknown candidate kind '${String(candidate.kind)}'`,
    )
  }
  if (!(CANDIDATE_SOURCES as readonly string[]).includes(candidate.source)) {
    throw new CandidateValidationError(
      `unknown candidate source '${String(candidate.source)}'`,
    )
  }
  assertText(candidate.changeSummary, 'changeSummary')
  assertIdentifier(candidate.baselineVersion, 'baselineVersion')
  assertIdentifier(candidate.author, 'author', 200)
  assertTimestamp(candidate.createdAt, 'createdAt')

  if (!Array.isArray(candidate.impactScope) || candidate.impactScope.length === 0) {
    throw new CandidateValidationError('impactScope must be a non-empty array')
  }
  for (const scope of candidate.impactScope) {
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new CandidateValidationError('impactScope entries must be strings')
    }
    const token = protectedToken(scope)
    if (token !== null) {
      throw new ProtectedInvariantError(
        `impact scope '${scope}' touches protected invariant '${token}'`,
      )
    }
    if (!(ALLOWED_IMPACT_SCOPES as readonly string[]).includes(scope)) {
      throw new CandidateValidationError(
        `impact scope '${scope}' is not an allowed evolution surface`,
      )
    }
  }

  if (candidate.mutatesProduction === true) {
    throw new CandidateValidationError(
      'a candidate cannot declare production mutation',
    )
  }
  if ((candidate.targetFiles ?? []).length > 0) {
    throw new CandidateValidationError(
      'a candidate cannot name production files; it may only describe ' +
        'declarative changes for the sandbox',
    )
  }
  if (!isPlainObject(candidate.changes)) {
    throw new CandidateValidationError('changes must be an object')
  }
  assertDeclarative(candidate.changes, 'changes')
  assertNoProtectedKeys(candidate.changes, 'changes')

  return deepFreeze({
    candidateId: candidate.candidateId,
    version: candidate.version,
    kind: candidate.kind,
    source: candidate.source,
    changeSummary: candidate.changeSummary,
    impactScope: [...candidate.impactScope],
    baselineVersion: candidate.baselineVersion,
    changes: { ...candidate.changes },
    createdAt: candidate.createdAt,
    author: candidate.author,
    targetFiles: [],
    mutatesProduction: false,
  })
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.candidateId}\u0000${candidate.version}`
}

function candidateFingerprint(candidate: Candidate): string {
  return canonical({
    candidateId: candidate.candidateId,
    version: candidate.version,
    kind: candidate.kind,
    source: candidate.source,
    changeSummary: candidate.changeSummary,
    impactScope: [...candidate.impactScope],
    baselineVersion: candidate.baselineVersion,
    changes: candidate.changes,
    createdAt: candidate.createdAt,
    author: candidate.author,
  })
}

// ---------------------------------------------------------------------------
// Append-only audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  readonly seq: number
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly outcome: 'accepted' | 'rejected'
  readonly detail: Readonly<Record<string, unknown>>
}

function assertAuditDetail(detail: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(detail)) {
    if ((AUDIT_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new AuditError(
        `audit detail key '${key}' would store raw student data; the audit log ` +
          'may only hold opaque ids, counts, versions, and reasons',
      )
    }
    if (isPlainObject(value)) assertAuditDetail(value)
    else if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isPlainObject(item)) assertAuditDetail(item)
      })
    }
  }
}

export interface AuditAppendInput {
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly outcome: 'accepted' | 'rejected'
  readonly detail?: Readonly<Record<string, unknown>>
}

/** Append-only in-memory log; no update or delete method exists. */
export class EvolutionAuditLog {
  private readonly entriesInternal: AuditEntry[] = []
  private readonly now: () => string
  private seq = 0

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now
  }

  append(input: AuditAppendInput): AuditEntry {
    const detail = { ...(input.detail ?? {}) }
    assertAuditDetail(detail)
    this.seq += 1
    const entry: AuditEntry = Object.freeze({
      seq: this.seq,
      at: this.now(),
      actor: assertIdentifier(input.actor, 'actor', 200),
      action: assertText(input.action, 'action', 200),
      subject: assertText(input.subject, 'subject', 200),
      outcome: input.outcome,
      detail: Object.freeze(detail),
    })
    this.entriesInternal.push(entry)
    return entry
  }

  entries(filter?: {
    readonly action?: string
    readonly subject?: string
  }): readonly AuditEntry[] {
    let result = [...this.entriesInternal]
    if (filter?.action !== undefined) {
      result = result.filter((entry) => entry.action === filter.action)
    }
    if (filter?.subject !== undefined) {
      result = result.filter((entry) => entry.subject === filter.subject)
    }
    return Object.freeze(result)
  }

  get head(): number {
    return this.seq
  }
}

// ---------------------------------------------------------------------------
// Candidate registry
// ---------------------------------------------------------------------------

export class CandidateRegistry {
  private readonly candidates = new Map<string, Candidate>()
  private readonly audit: EvolutionAuditLog

  constructor(audit: EvolutionAuditLog) {
    this.audit = audit
  }

  register(candidate: Candidate): Candidate {
    const validated = validateCandidate(candidate)
    const key = candidateKey(validated)
    const existing = this.candidates.get(key)
    if (existing !== undefined) {
      if (candidateFingerprint(existing) !== candidateFingerprint(validated)) {
        throw new DuplicateCandidateError(
          `candidate ${validated.candidateId}/${validated.version} was already ` +
            'registered with different content',
        )
      }
      return existing
    }
    this.candidates.set(key, validated)
    this.audit.append({
      actor: validated.author,
      action: 'candidate.registered',
      subject: validated.candidateId,
      outcome: 'accepted',
      detail: {
        version: validated.version,
        kind: validated.kind,
        source: validated.source,
        impactScope: [...validated.impactScope],
        baselineVersion: validated.baselineVersion,
      },
    })
    return validated
  }

  get(candidateId: string, version: string): Candidate | undefined {
    return this.candidates.get(`${candidateId}\u0000${version}`)
  }

  list(): readonly Candidate[] {
    return Object.freeze([...this.candidates.values()])
  }
}

// ---------------------------------------------------------------------------
// Isolated evaluation
// ---------------------------------------------------------------------------

export interface FrozenEvalDataset {
  readonly datasetId: string
  readonly version: string
  readonly digest: string
}

export interface PromotionPolicy {
  readonly minSimulatedItems: number
  readonly minSimulatedGain: number
  readonly minRealTransferItems: number
  readonly minRealTransferDelta: number
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = Object.freeze({
  minSimulatedItems: 3,
  minSimulatedGain: 0,
  minRealTransferItems: 2,
  minRealTransferDelta: 0,
})

export const REAL_SOURCES = Object.freeze([
  'student',
  'teacher',
  'trusted_grader',
  'assessment',
] as const)

export interface SimulatedEvidence {
  readonly itemCount: number
  readonly meanPredictedCorrect: number
  readonly referenceAccuracy: number
  /** A simulator must never touch the real transfer split. */
  readonly touchesTransferSplit?: boolean
}

export interface RealTransferEvidence {
  readonly itemCount: number
  readonly independentCorrect: number
  readonly referenceAccuracy: number
  readonly allItemsUnseen: boolean
  readonly sources: readonly string[]
}

export interface SimulatedBenefitSummary {
  readonly split: string
  readonly itemCount: number
  readonly meanPredictedCorrect: number
  readonly referenceAccuracy: number
  readonly simulatedGain: number
  readonly isCausalEvidence: false
}

export interface RealTransferSummary {
  readonly itemCount: number
  readonly independentCorrect: number
  readonly transferAccuracy: number
  readonly referenceAccuracy: number
  readonly observedDelta: number
  readonly sources: readonly string[]
  readonly allItemsUnseen: boolean
  readonly causalClaimSupported: false
}

export interface EvaluationVerdict {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly dataset: FrozenEvalDataset
  readonly evaluatedAt: string
  readonly simulatedBenefit: SimulatedBenefitSummary | null
  readonly realTransfer: RealTransferSummary | null
  readonly screeningPassed: boolean
  readonly promotionReady: boolean
  readonly evidenceSufficient: boolean
  readonly reasons: readonly string[]
  readonly claim: string
}

function unit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CandidateValidationError(`${field} must be a finite number`)
  }
  if (value < 0 || value > 1) {
    throw new CandidateValidationError(`${field} must be in [0, 1]`)
  }
  return value
}

function count(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new CandidateValidationError(`${field} must be an integer >= 1`)
  }
  return value as number
}

/** Evaluate a candidate against frozen evidence with no external effects. */
export class IsolatedSandbox {
  readonly dataset: FrozenEvalDataset
  readonly policy: PromotionPolicy

  constructor(
    dataset: FrozenEvalDataset,
    policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
  ) {
    if (!dataset || typeof dataset.datasetId !== 'string' || dataset.datasetId === '') {
      throw new CandidateValidationError('sandbox requires a frozen dataset id')
    }
    if (typeof dataset.digest !== 'string' || dataset.digest.length === 0) {
      throw new CandidateValidationError('sandbox requires a frozen dataset digest')
    }
    this.dataset = dataset
    this.policy = policy
  }

  evaluate(
    candidate: Candidate,
    evidence: {
      readonly simulated?: SimulatedEvidence
      readonly real?: RealTransferEvidence
      readonly evaluatedAt?: string
    } = {},
  ): EvaluationVerdict {
    const evaluatedAt = evidence.evaluatedAt ?? new Date().toISOString()
    assertTimestamp(evaluatedAt, 'evaluatedAt')

    if (evidence.simulated?.touchesTransferSplit === true) {
      return this.failed(candidate, evaluatedAt, 'evaluation_rejected:SplitIsolationError')
    }

    const reasons: string[] = []
    let simulated: SimulatedBenefitSummary | null = null
    let real: RealTransferSummary | null = null
    let simulatedOk = false
    let realOk = false

    if (evidence.simulated !== undefined) {
      const sim = evidence.simulated
      const itemCount = count(sim.itemCount, 'simulated.itemCount')
      const mean = unit(sim.meanPredictedCorrect, 'simulated.meanPredictedCorrect')
      const reference = unit(sim.referenceAccuracy, 'simulated.referenceAccuracy')
      simulated = Object.freeze({
        split: 'train+explanation',
        itemCount,
        meanPredictedCorrect: mean,
        referenceAccuracy: reference,
        simulatedGain: mean - reference,
        isCausalEvidence: false,
      })
      if (itemCount < this.policy.minSimulatedItems) {
        reasons.push('screening_failed:too_few_simulated_items')
      } else if (simulated.simulatedGain < this.policy.minSimulatedGain) {
        reasons.push('screening_failed:simulated_gain_below_threshold')
      } else {
        simulatedOk = true
      }
    }

    if (evidence.real !== undefined) {
      const raw = evidence.real
      const itemCount = count(raw.itemCount, 'real.itemCount')
      if (
        !Number.isInteger(raw.independentCorrect) ||
        raw.independentCorrect < 0 ||
        raw.independentCorrect > itemCount
      ) {
        throw new CandidateValidationError(
          'real.independentCorrect must be an integer in [0, itemCount]',
        )
      }
      const reference = unit(raw.referenceAccuracy, 'real.referenceAccuracy')
      const sources = [...raw.sources]
      const untrusted = sources.filter(
        (source) => !(REAL_SOURCES as readonly string[]).includes(source),
      )
      real = Object.freeze({
        itemCount,
        independentCorrect: raw.independentCorrect,
        transferAccuracy: raw.independentCorrect / itemCount,
        referenceAccuracy: reference,
        observedDelta: raw.independentCorrect / itemCount - reference,
        sources: Object.freeze(sources),
        allItemsUnseen: raw.allItemsUnseen,
        causalClaimSupported: false,
      })
      if (untrusted.length > 0) {
        reasons.push('real_transfer_failed:untrusted_source')
      } else if (!raw.allItemsUnseen) {
        reasons.push('real_transfer_failed:item_was_seen')
      } else if (itemCount < this.policy.minRealTransferItems) {
        reasons.push('real_transfer_failed:too_few_items')
      } else if (real.observedDelta < this.policy.minRealTransferDelta) {
        reasons.push('real_transfer_failed:delta_below_threshold')
      } else {
        realOk = true
      }
    }

    if (simulated === null && real === null) {
      reasons.push('evidence_insufficient:no_simulated_or_real_evidence')
    } else if (simulated === null) {
      reasons.push('screening_skipped:no_simulated_evidence')
    }
    if (real === null) {
      reasons.push('promotion_blocked:real_transfer_evidence_missing')
    }

    const evidenceSufficient =
      (simulated !== null && simulated.itemCount >= this.policy.minSimulatedItems) ||
      (real !== null && real.itemCount >= this.policy.minRealTransferItems)
    const realFailed = real !== null && !realOk
    const screeningPassed = (simulatedOk || realOk) && !realFailed
    const promotionReady = realOk

    return Object.freeze({
      candidateId: candidate.candidateId,
      candidateVersion: candidate.version,
      dataset: Object.freeze({ ...this.dataset }),
      evaluatedAt,
      simulatedBenefit: simulated,
      realTransfer: real,
      screeningPassed,
      promotionReady,
      evidenceSufficient,
      reasons: Object.freeze(reasons),
      claim: promotionReady
        ? 'real transfer evidence passed the configured threshold; without a ' +
          'control group this is descriptive, not causal'
        : 'no real transfer evidence supports promotion; simulated gain alone ' +
          'is not a promotion reward',
    })
  }

  private failed(
    candidate: Candidate,
    evaluatedAt: string,
    reason: string,
  ): EvaluationVerdict {
    return Object.freeze({
      candidateId: candidate.candidateId,
      candidateVersion: candidate.version,
      dataset: Object.freeze({ ...this.dataset }),
      evaluatedAt,
      simulatedBenefit: null,
      realTransfer: null,
      screeningPassed: false,
      promotionReady: false,
      evidenceSufficient: false,
      reasons: Object.freeze([reason]),
      claim: 'evaluation failed before producing a separated report',
    })
  }
}

// ---------------------------------------------------------------------------
// Approval and canary
// ---------------------------------------------------------------------------

export interface Actor {
  readonly actorId: string
  readonly role: string
}

export function isHostActor(actor: Actor): boolean {
  return (HOST_ROLES as readonly string[]).includes(actor.role)
}

export interface ApprovalRecord {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly decision: 'approved' | 'rejected'
  readonly approvedBy: string
  readonly decidedAt: string
  readonly reason: string
  readonly role: string
}

export interface CanaryConditions {
  readonly maxRegression: number
  readonly maxErrorRate: number
  readonly minSamples: number
  readonly maxDurationMinutes: number
}

export const DEFAULT_CANARY_CONDITIONS: CanaryConditions = Object.freeze({
  maxRegression: 0.05,
  maxErrorRate: 0.2,
  minSamples: 5,
  maxDurationMinutes: 60,
})

export interface CanaryState {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly fraction: number
  readonly startedAt: string
  readonly conditions: CanaryConditions
  readonly syntheticOnly: true
  status: 'running' | 'circuit_breaker' | 'rolled_back' | 'promoted'
  samplesSeen: number
}

export interface CanaryObservation {
  readonly regression: number
  readonly errorRate: number
  readonly sampleCount: number
  readonly observedAt?: string
}

export interface CanaryObservationResult {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly sampleCount: number
  readonly regression: number
  readonly errorRate: number
  readonly tripped: boolean
  readonly reasons: readonly string[]
  readonly rollback: RollbackEvent | null
}

export interface RollbackEvent {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly fromVersion: string
  readonly toVersion: string
  readonly actor: string
  readonly reason: string
  readonly triggeredBy: 'human' | 'circuit_breaker'
  readonly rolledBackAt: string
}

export interface CandidateRecord {
  readonly candidate: Candidate
  status: CandidateStatus
  registeredAt: string
  updatedAt: string
  evaluation: EvaluationVerdict | null
  approval: ApprovalRecord | null
  canary: CanaryState | null
  rollback: RollbackEvent | null
  previousStableVersion: string | null
}

function assertHostActor(
  actor: Actor,
  record: CandidateRecord,
  errorType: new (message: string) => EvolutionError,
): void {
  if (!isHostActor(actor)) {
    throw new errorType(
      `role '${actor.role}' is not a host-side role; candidates cannot approve, ` +
        'run canaries, promote, or roll back themselves',
    )
  }
  if (
    actor.actorId === record.candidate.author ||
    actor.actorId === record.candidate.candidateId
  ) {
    throw new errorType('a candidate cannot approve, promote, or roll back itself')
  }
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

/**
 * The host-side pipeline. There is intentionally no method that lets a
 * candidate approve itself, roll itself back, or apply itself to production.
 */
export class EvolutionControlPlane {
  readonly audit: EvolutionAuditLog
  readonly registry: CandidateRegistry
  readonly sandbox: IsolatedSandbox
  private readonly records = new Map<string, CandidateRecord>()
  private readonly stableVersions = new Map<string, string>()

  constructor(
    dataset: FrozenEvalDataset,
    options: {
      readonly policy?: PromotionPolicy
      readonly now?: () => string
      readonly audit?: EvolutionAuditLog
    } = {},
  ) {
    this.audit = options.audit ?? new EvolutionAuditLog(options.now)
    this.registry = new CandidateRegistry(this.audit)
    this.sandbox = new IsolatedSandbox(dataset, options.policy)
  }

  private stamp(): string {
    return new Date().toISOString()
  }

  private requireRecord(candidateId: string, version: string): CandidateRecord {
    const record = this.records.get(`${candidateId}\u0000${version}`)
    if (record === undefined) {
      throw new LifecycleError(
        `unknown candidate '${candidateId}' version '${version}'`,
      )
    }
    return record
  }

  status(candidateId: string, version: string): CandidateStatus | null {
    return this.records.get(`${candidateId}\u0000${version}`)?.status ?? null
  }

  record(candidateId: string, version: string): CandidateRecord {
    return this.requireRecord(candidateId, version)
  }

  stableVersion(candidateId: string): string | undefined {
    return this.stableVersions.get(candidateId)
  }

  listRecords(): readonly CandidateRecord[] {
    return Object.freeze([...this.records.values()])
  }

  propose(candidate: Candidate, _actor: Actor): CandidateRecord {
    const registered = this.registry.register(candidate)
    const key = candidateKey(registered)
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    const now = this.stamp()
    const record: CandidateRecord = {
      candidate: registered,
      status: 'proposed',
      registeredAt: now,
      updatedAt: now,
      evaluation: null,
      approval: null,
      canary: null,
      rollback: null,
      previousStableVersion: null,
    }
    this.records.set(key, record)
    if (!this.stableVersions.has(registered.candidateId)) {
      this.stableVersions.set(registered.candidateId, registered.baselineVersion)
    }
    return record
  }

  evaluate(
    candidateId: string,
    version: string,
    actor: Actor,
    evidence: {
      readonly simulated?: SimulatedEvidence
      readonly real?: RealTransferEvidence
      readonly evaluatedAt?: string
    } = {},
  ): EvaluationVerdict {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== 'proposed' && record.status !== 'evaluated') {
      throw new LifecycleError(`cannot evaluate candidate in status '${record.status}'`)
    }
    this.audit.append({
      actor: actor.actorId,
      action: 'candidate.sandboxed',
      subject: candidateId,
      outcome: 'accepted',
      detail: { version },
    })
    const verdict = this.sandbox.evaluate(record.candidate, evidence)
    record.evaluation = verdict
    record.status = verdict.screeningPassed ? 'evaluated' : 'rejected'
    record.updatedAt = this.stamp()
    this.audit.append({
      actor: actor.actorId,
      action: verdict.screeningPassed ? 'candidate.evaluated' : 'candidate.rejected',
      subject: candidateId,
      outcome: verdict.screeningPassed ? 'accepted' : 'rejected',
      detail: {
        version,
        datasetDigest: verdict.dataset.digest,
        screeningPassed: verdict.screeningPassed,
        promotionReady: verdict.promotionReady,
        evidenceSufficient: verdict.evidenceSufficient,
        reasons: [...verdict.reasons],
      },
    })
    return verdict
  }

  approve(
    candidateId: string,
    version: string,
    approval: ApprovalRecord | null,
    actor: Actor,
  ): CandidateRecord {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== 'evaluated') {
      throw new LifecycleError(
        'approval requires a candidate that passed isolated evaluation; ' +
          `current status is '${record.status}'`,
      )
    }
    assertHostActor(actor, record, ApprovalDeniedError)
    if (approval === null) {
      throw new ApprovalDeniedError(
        'approval is default-deny: an explicit approval record is required',
      )
    }
    if (
      approval.candidateId !== candidateId ||
      approval.candidateVersion !== version
    ) {
      throw new ApprovalDeniedError('approval record names a different candidate')
    }
    if (approval.decision === 'rejected') {
      record.approval = Object.freeze({ ...approval })
      record.status = 'rejected'
      record.updatedAt = this.stamp()
      this.audit.append({
        actor: actor.actorId,
        action: 'candidate.approval_rejected',
        subject: candidateId,
        outcome: 'rejected',
        detail: { version, reason: approval.reason },
      })
      return record
    }
    if (approval.approvedBy !== actor.actorId) {
      throw new ApprovalDeniedError(
        'approval record approvedBy must match the acting reviewer',
      )
    }
    if (!(HOST_ROLES as readonly string[]).includes(approval.role)) {
      throw new ApprovalDeniedError(
        `approval role '${approval.role}' is not a host-side role`,
      )
    }
    record.approval = Object.freeze({ ...approval })
    record.status = 'approved'
    record.updatedAt = this.stamp()
    this.audit.append({
      actor: actor.actorId,
      action: 'candidate.approved',
      subject: candidateId,
      outcome: 'accepted',
      detail: {
        version,
        decision: approval.decision,
        role: approval.role,
        reason: approval.reason,
        decidedAt: approval.decidedAt,
      },
    })
    return record
  }

  startCanary(
    candidateId: string,
    version: string,
    options: {
      readonly fraction: number
      readonly actor: Actor
      readonly conditions?: CanaryConditions
    },
  ): CanaryState {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== 'approved') {
      throw new CanaryDeniedError(
        'canary requires an explicitly approved candidate; ' +
          `current status is '${record.status}'`,
      )
    }
    assertHostActor(options.actor, record, CanaryDeniedError)
    if (
      typeof options.fraction !== 'number' ||
      !Number.isFinite(options.fraction) ||
      options.fraction <= 0 ||
      options.fraction > 1
    ) {
      throw new CanaryDeniedError('canary fraction must be in (0, 1]')
    }
    const conditions = Object.freeze({
      ...(options.conditions ?? DEFAULT_CANARY_CONDITIONS),
    })
    const state: CanaryState = {
      candidateId,
      candidateVersion: version,
      fraction: options.fraction,
      startedAt: this.stamp(),
      conditions,
      syntheticOnly: true,
      status: 'running',
      samplesSeen: 0,
    }
    record.canary = state
    record.status = 'canary'
    record.updatedAt = this.stamp()
    this.audit.append({
      actor: options.actor.actorId,
      action: 'canary.started',
      subject: candidateId,
      outcome: 'accepted',
      detail: {
        version,
        fraction: state.fraction,
        syntheticOnly: true,
        conditions,
      },
    })
    return state
  }

  observeCanary(
    candidateId: string,
    version: string,
    observation: CanaryObservation,
    actor: Actor,
  ): CanaryObservationResult {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== 'canary' || record.canary === null) {
      throw new LifecycleError('canary observations require a running canary')
    }
    assertHostActor(actor, record, CanaryDeniedError)
    const state = record.canary
    state.samplesSeen += observation.sampleCount

    const reasons: string[] = []
    let tripped = false
    if (observation.sampleCount >= state.conditions.minSamples) {
      if (observation.regression > state.conditions.maxRegression) {
        tripped = true
        reasons.push('circuit_breaker:regression_exceeded')
      }
      if (observation.errorRate > state.conditions.maxErrorRate) {
        tripped = true
        reasons.push('circuit_breaker:error_rate_exceeded')
      }
    }
    this.audit.append({
      actor: actor.actorId,
      action: 'canary.observed',
      subject: candidateId,
      outcome: tripped ? 'rejected' : 'accepted',
      detail: {
        version,
        sampleCount: observation.sampleCount,
        regression: observation.regression,
        errorRate: observation.errorRate,
        tripped,
      },
    })
    let rollback: RollbackEvent | null = null
    if (tripped) {
      state.status = 'circuit_breaker'
      this.audit.append({
        actor: actor.actorId,
        action: 'canary.circuit_breaker',
        subject: candidateId,
        outcome: 'rejected',
        detail: { version, reasons: [...reasons] },
      })
      rollback = this.rollback(candidateId, version, {
        actor,
        reason: `circuit breaker: ${reasons.join(', ')}`,
        triggeredBy: 'circuit_breaker',
      })
    }
    return Object.freeze({
      candidateId,
      candidateVersion: version,
      sampleCount: observation.sampleCount,
      regression: observation.regression,
      errorRate: observation.errorRate,
      tripped,
      reasons: Object.freeze(reasons),
      rollback,
    })
  }

  promote(candidateId: string, version: string, actor: Actor): CandidateRecord {
    const record = this.requireRecord(candidateId, version)
    if (record.status !== 'canary') {
      throw new LifecycleError('promotion requires a running canary')
    }
    assertHostActor(actor, record, ApprovalDeniedError)
    const verdict = record.evaluation
    if (verdict === null || !verdict.promotionReady) {
      throw new EvolutionError(
        'promotion requires real, independent transfer evidence above ' +
          'threshold; simulated gain alone is not a promotion reward',
      )
    }
    record.previousStableVersion =
      this.stableVersions.get(candidateId) ?? record.candidate.baselineVersion
    this.stableVersions.set(candidateId, version)
    record.status = 'promoted'
    if (record.canary !== null) record.canary.status = 'promoted'
    record.updatedAt = this.stamp()
    this.audit.append({
      actor: actor.actorId,
      action: 'candidate.promoted',
      subject: candidateId,
      outcome: 'accepted',
      detail: {
        version,
        previousStableVersion: record.previousStableVersion,
        realTransferDelta: verdict.realTransfer?.observedDelta ?? null,
      },
    })
    return record
  }

  rollback(
    candidateId: string,
    version: string,
    options: {
      readonly actor: Actor
      readonly reason: string
      readonly triggeredBy?: 'human' | 'circuit_breaker'
    },
  ): RollbackEvent {
    const record = this.requireRecord(candidateId, version)
    assertHostActor(options.actor, record, RollbackDeniedError)
    assertText(options.reason, 'reason')
    const triggeredBy = options.triggeredBy ?? 'human'
    if (record.status !== 'canary' && record.status !== 'promoted') {
      throw new LifecycleError(`nothing to roll back from status '${record.status}'`)
    }
    const currentStable = this.stableVersions.get(candidateId)
    const target =
      record.previousStableVersion ?? record.candidate.baselineVersion
    this.stableVersions.set(candidateId, target)
    record.status = 'rolled_back'
    if (record.canary !== null) record.canary.status = 'rolled_back'
    const event: RollbackEvent = Object.freeze({
      candidateId,
      candidateVersion: version,
      fromVersion: currentStable ?? version,
      toVersion: target,
      actor: options.actor.actorId,
      reason: options.reason,
      triggeredBy,
      rolledBackAt: this.stamp(),
    })
    record.rollback = event
    record.updatedAt = this.stamp()
    this.audit.append({
      actor: options.actor.actorId,
      action: 'rollback.completed',
      subject: candidateId,
      outcome: 'accepted',
      detail: {
        version,
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
        triggeredBy,
        reason: options.reason,
      },
    })
    return event
  }

  pipelineSnapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      productionMutationEnabled: PRODUCTION_MUTATION_ENABLED,
      sandboxHasProductionAccess: SANDBOX_HAS_PRODUCTION_ACCESS,
      syntheticFixturesOnly: SYNTHETIC_FIXTURES_ONLY,
      dataset: Object.freeze({ ...this.sandbox.dataset }),
      candidates: this.listRecords(),
      stableVersions: Object.freeze(Object.fromEntries(this.stableVersions)),
      auditHead: this.audit.head,
    })
  }
}
