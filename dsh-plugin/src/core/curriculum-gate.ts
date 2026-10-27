/**
 * Fail-closed curriculum progress gate (spec section 4.3).
 *
 * `allow(item, progress, mode)` is the TypeScript counterpart of
 * `aeh/curriculum_gate.py::allow`. It is a pure decision function: no item is
 * delivered, no progress is written, and no caller-supplied "override" is
 * honoured. Missing annotations, low confidence, untaught KCs, future methods,
 * an unknown mode, and an exhausted load budget all produce a rejection.
 */

import {
  DEFAULT_MIN_ANNOTATION_CONFIDENCE,
  DEFAULT_MIN_PROGRESS_CONFIDENCE,
  GATE_MODES,
  MAX_EXTENSION_GRADE_DELTA,
  isFiniteNumber,
  type CurriculumItem,
  type GateDecision,
  type GateMode,
  type LearnerProgress,
} from '../domain.ts'

export interface GateThresholds {
  readonly minAnnotationConfidence?: number
  readonly minProgressConfidence?: number
}

function asSet(values: readonly string[] | undefined): Set<string> {
  return new Set(values ?? [])
}

function modeIsValid(mode: string): mode is GateMode {
  return (GATE_MODES as readonly string[]).includes(mode)
}

/**
 * Return the knowledge components the learner may be taught in `mode`.
 *
 * Preview  = taught + confirmed next-lesson preview.
 * Learn    = taught/in-progress + confirmed backward prerequisites.
 * Review   = taught/in-progress + confirmed previously learned content.
 *
 * Unconfirmed school progress never unlocks in-progress or future content.
 */
export function allowedKcs(
  progress: LearnerProgress,
  mode: GateMode | string,
  minProgressConfidence: number = DEFAULT_MIN_PROGRESS_CONFIDENCE,
): ReadonlySet<string> {
  if (!modeIsValid(mode)) {
    return new Set<string>()
  }

  const allowed = new Set<string>([
    ...asSet(progress.taughtKcs),
    ...asSet(progress.confirmedPriorKcs),
  ])
  const confidence = progress.progressConfidence ?? 0
  if (confidence >= minProgressConfidence) {
    for (const kc of progress.inProgressKcs ?? []) {
      allowed.add(kc)
    }
    if (mode === 'preview') {
      for (const kc of progress.confirmedPreviewKcs ?? []) {
        allowed.add(kc)
      }
    }
  }
  return allowed
}

function gradeAppropriate(
  item: CurriculumItem,
  progress: LearnerProgress,
): boolean {
  const grade = item.gradeLevel
  const learnerGrade = progress.gradeLevel
  if (
    grade === null ||
    grade === undefined ||
    learnerGrade === null ||
    learnerGrade === undefined
  ) {
    // Missing annotation -> fail closed.
    return false
  }
  if (grade <= learnerGrade) {
    // Revisiting older grades is always allowed (backward remediation).
    return true
  }
  const extension = item.extensionApproved === true || progress.extensionMode === true
  return extension && grade - learnerGrade <= MAX_EXTENSION_GRADE_DELTA
}

/** True when the item relies on methods not yet taught (spec 4.2/4.3). */
export function hasUnapprovedFutureMethod(
  item: CurriculumItem,
  progress: LearnerProgress,
): boolean {
  const future = item.futureMethods ?? []
  if (future.length === 0) {
    return false
  }
  const extension = item.extensionApproved === true || progress.extensionMode === true
  if (extension && gradeAppropriate(item, progress)) {
    return false
  }
  return true
}

/** Check the cognitive-load budget; a missing budget fails closed. */
export function cognitiveLoadWithinBudget(
  item: CurriculumItem,
  progress: LearnerProgress,
): boolean {
  const budget = progress.loadBudget
  if (budget === null || budget === undefined) {
    return false
  }
  const load = item.cognitiveLoad ?? 0
  const current = progress.currentLoad ?? 0
  return current + load <= budget + 1e-9
}

/**
 * Fail-closed curriculum gate for a candidate item, learner, and mode.
 *
 * This function is deliberately total: malformed optional fields produce
 * refusal reasons instead of a permissive default.
 */
export function allow(
  item: CurriculumItem,
  progress: LearnerProgress,
  mode: GateMode | string,
  thresholds: GateThresholds = {},
): GateDecision {
  const itemId = item.itemId ?? null
  if (!modeIsValid(mode)) {
    return {
      allowed: false,
      reasons: [`unknown_mode:${mode}`],
      allowedKcs: [],
      itemId,
      mode,
    }
  }

  const allowed = allowedKcs(
    progress,
    mode,
    thresholds.minProgressConfidence ?? DEFAULT_MIN_PROGRESS_CONFIDENCE,
  )
  const required = item.requiredKcs ?? []
  const reasons: string[] = []

  if (item.safetyChecked !== true) {
    reasons.push('safety_not_verified')
  }
  if (item.contentVerified !== true) {
    reasons.push('content_not_verified')
  }

  const rawConfidence = item.annotationConfidence
  if (rawConfidence === null || rawConfidence === undefined) {
    reasons.push('missing_annotation_confidence')
  } else if (!isFiniteNumber(rawConfidence)) {
    reasons.push('invalid_annotation_confidence')
  } else if (
    rawConfidence <
    (thresholds.minAnnotationConfidence ?? DEFAULT_MIN_ANNOTATION_CONFIDENCE)
  ) {
    reasons.push('low_annotation_confidence')
  }

  if (required.length === 0) {
    reasons.push('missing_required_kcs')
  }
  const missing = required.filter((kc) => !allowed.has(kc))
  if (missing.length > 0) {
    reasons.push(`kcs_not_allowed:${missing.join(',')}`)
  }

  if (hasUnapprovedFutureMethod(item, progress)) {
    reasons.push('unapproved_future_method')
  }
  if (!gradeAppropriate(item, progress)) {
    reasons.push('grade_not_appropriate')
  }
  if (!cognitiveLoadWithinBudget(item, progress)) {
    reasons.push('cognitive_load_exceeded')
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    allowedKcs: [...allowed].sort(),
    itemId,
    mode,
  }
}

/** Return only the items the gate admits, preserving order. */
export function filterAllowed<T extends CurriculumItem>(
  items: readonly T[],
  progress: LearnerProgress,
  mode: GateMode | string,
  thresholds: GateThresholds = {},
): readonly T[] {
  return items.filter((item) => allow(item, progress, mode, thresholds).allowed)
}

/** Convenience predicate for host tooling and tests. */
export function gateAdmits(
  item: CurriculumItem,
  progress: LearnerProgress,
  mode: GateMode | string,
  thresholds: GateThresholds = {},
): boolean {
  return allow(item, progress, mode, thresholds).allowed
}
