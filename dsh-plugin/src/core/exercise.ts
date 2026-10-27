/**
 * Intervention packages and delivery validation (spec sections 9.2 / 9.4).
 *
 * The unit of delivery is not a single question but a package: objective,
 * training items, hint ladder, feedback templates, explanation resources, an
 * independent unseen transfer item, and completion criteria. Training,
 * explanation, and transfer evaluation stay separate.
 *
 * `aeh_prepare_intervention` only prepares and validates. Actual delivery is a
 * host-side action that must independently re-check the gate and approval; this
 * module never hands an item to a student.
 */

import {
  InterventionError,
  type CurriculumItem,
  type GateDecision,
  type GateMode,
  type InterventionPackageInput,
  type LearnerProgress,
} from '../domain.ts'
import { allow } from './curriculum-gate.ts'

export interface InterventionPackage {
  readonly packageId: string
  readonly objectiveId: string
  readonly trainingItems: readonly CurriculumItem[]
  readonly transferItems: readonly CurriculumItem[]
  readonly hintLadder: readonly string[]
  readonly feedbackTemplates: Readonly<Record<string, string>>
  readonly explanationResources: readonly string[]
  readonly completionCriteria: Readonly<Record<string, unknown>>
  readonly requiredKcs: readonly string[]
  readonly independentTransfer: boolean
  readonly schoolMode: GateMode
}

export interface PackageValidation {
  readonly valid: boolean
  readonly reasons: readonly string[]
  readonly itemDecisions: Readonly<Record<string, GateDecision>>
  readonly allowedKcs: readonly string[]
}

export interface DeliveryReceipt {
  readonly packageId: string
  readonly studentRef: string
  readonly deliveredAt: string
  readonly itemIds: readonly string[]
  readonly mode: GateMode
}

export class InterventionNotDeliverable extends InterventionError {
  readonly packageId: string
  readonly reasons: readonly string[]

  constructor(packageId: string, reasons: readonly string[]) {
    super(
      `intervention ${JSON.stringify(packageId)} not deliverable: ${reasons.join(', ')}`,
    )
    this.packageId = packageId
    this.reasons = Object.freeze([...reasons])
  }
}

/** Fill defaults while preserving strict training/transfer separation. */
export function packageFromInput(
  input: InterventionPackageInput,
): InterventionPackage {
  return Object.freeze({
    packageId: input.packageId,
    objectiveId: input.objectiveId,
    trainingItems: Object.freeze([...input.trainingItems]),
    transferItems: Object.freeze([...(input.transferItems ?? [])]),
    hintLadder: Object.freeze([...(input.hintLadder ?? [])]),
    feedbackTemplates: Object.freeze({ ...(input.feedbackTemplates ?? {}) }),
    explanationResources: Object.freeze([
      ...(input.explanationResources ?? []),
    ]),
    completionCriteria: Object.freeze({ ...(input.completionCriteria ?? {}) }),
    requiredKcs: Object.freeze([...(input.requiredKcs ?? [])]),
    independentTransfer: input.independentTransfer ?? true,
    schoolMode: input.schoolMode ?? 'learn',
  })
}

export function allItems(
  pkg: InterventionPackage,
): readonly CurriculumItem[] {
  return [...pkg.trainingItems, ...pkg.transferItems]
}

/**
 * Validate structure, isolation, and curriculum boundaries (fail-closed).
 *
 * A package that fails validation can never be delivered.
 */
export function validatePackage(
  pkg: InterventionPackage,
  progress: LearnerProgress,
  mode?: GateMode,
): PackageValidation {
  const effectiveMode = mode ?? pkg.schoolMode ?? 'learn'
  const reasons: string[] = []
  const decisions: Record<string, GateDecision> = {}

  if (pkg.trainingItems.length === 0) {
    reasons.push('missing_training_items')
  }
  if (pkg.hintLadder.length === 0) {
    reasons.push('missing_hint_ladder')
  }
  if (Object.keys(pkg.completionCriteria).length === 0) {
    reasons.push('missing_completion_criteria')
  }
  if (pkg.independentTransfer && pkg.transferItems.length === 0) {
    reasons.push('missing_transfer_items')
  }
  if (pkg.requiredKcs.length === 0) {
    reasons.push('missing_required_kcs')
  }

  const trainingIds = new Set(pkg.trainingItems.map((item) => item.itemId))
  const transferIds = new Set(pkg.transferItems.map((item) => item.itemId))
  const overlap = [...trainingIds].filter((id) => transferIds.has(id)).sort()
  if (overlap.length > 0) {
    reasons.push(`training_transfer_overlap:${overlap.join(',')}`)
  }

  const allowedUnion = new Set<string>()
  for (const item of allItems(pkg)) {
    const decision = allow(item, progress, effectiveMode)
    decisions[item.itemId] = decision
    for (const kc of decision.allowedKcs) {
      allowedUnion.add(kc)
    }
    if (!decision.allowed) {
      reasons.push(`gate_rejected:${item.itemId}:${decision.reasons.join(',')}`)
    }
  }

  for (const item of pkg.transferItems) {
    if (item.seenBefore === true) {
      // Transfer evaluation must use an unseen item (spec 9.6).
      reasons.push(`transfer_item_seen_before:${item.itemId}`)
    }
  }

  const missingRequired = pkg.requiredKcs.filter(
    (kc) => !allowedUnion.has(kc),
  )
  if (missingRequired.length > 0) {
    reasons.push(`required_kcs_not_allowed:${missingRequired.join(',')}`)
  }

  return Object.freeze({
    valid: reasons.length === 0,
    reasons: Object.freeze(reasons),
    itemDecisions: Object.freeze(decisions),
    allowedKcs: Object.freeze([...allowedUnion].sort()),
  })
}

/**
 * Validate then produce a host delivery receipt.
 *
 * This is exported for the host adapter's own tests. The default tool set does
 * not expose it to the model, because delivery requires host approval.
 */
export function deliver(
  pkg: InterventionPackage,
  progress: LearnerProgress,
  options: {
    readonly mode?: GateMode
    readonly deliveredAt?: string
  } = {},
): DeliveryReceipt {
  const validation = validatePackage(pkg, progress, options.mode)
  if (!validation.valid) {
    throw new InterventionNotDeliverable(pkg.packageId, validation.reasons)
  }
  return Object.freeze({
    packageId: pkg.packageId,
    studentRef: progress.studentRef,
    deliveredAt: options.deliveredAt ?? new Date().toISOString(),
    itemIds: Object.freeze(allItems(pkg).map((item) => item.itemId)),
    mode: options.mode ?? pkg.schoolMode,
  })
}

export function packageReady(
  pkg: InterventionPackage,
  progress: LearnerProgress,
  mode?: GateMode,
): boolean {
  return validatePackage(pkg, progress, mode).valid
}
