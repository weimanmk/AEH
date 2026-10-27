/**
 * Curriculum knowledge space: KC graph, versioned item bank, local RAG.
 *
 * TypeScript counterpart of `aeh/curriculum_graph.py` (Step 9, spec section 3).
 * Behaviour is intentionally identical:
 *
 * - immutable, versioned knowledge-component graph with `REQUIRES`,
 *   `SUPPORTS`, `PART_OF`, `ASSESSES`, ... relations;
 * - only *approved* `REQUIRES` / `PART_OF` edges are authoritative, so a
 *   `proposed` LLM edge can be stored for review but cannot unlock a KC;
 * - illegal graphs (duplicate nodes/edges, unknown endpoints, self loops,
 *   approved prerequisite cycles) are rejected;
 * - versioned items with structured annotations, review status, and an
 *   append-only review ledger;
 * - local deterministic retrieval by KC, difficulty, and item type, returning
 *   only an opaque `itemId` and an annotation summary (no text/answer/hint);
 * - gate-bound retrieval: every hit is re-resolved and must pass the
 *   curriculum gate *and* the transitive prerequisite closure check.
 *
 * All fixtures are synthetic. No files, network, database, or real student or
 * item data are used by this module.
 */

import { createHash } from 'node:crypto'

import {
  DEFAULT_MIN_ANNOTATION_CONFIDENCE,
  DEFAULT_MIN_PROGRESS_CONFIDENCE,
  type CurriculumItem,
  type GateDecision,
  type LearnerProgress,
} from '../domain.ts'
import {
  allow,
  allowedKcs,
  type GateThresholds,
} from './curriculum-gate.ts'

// ---------------------------------------------------------------------------
// Controlled vocabularies (spec section 3)
// ---------------------------------------------------------------------------

export const NODE_TYPES = Object.freeze([
  'curriculum',
  'textbook',
  'lesson',
  'course_session',
  'knowledge_component',
  'subskill',
  'definition',
  'theorem',
  'strategy',
  'problem_schema',
  'solution_step',
  'misconception',
  'exercise',
  'worked_example',
  'hint',
  'learning_object',
  'assessment_rubric',
  'learning_objective',
  'prerequisite',
  'transfer_objective',
] as const)

export const RELATION_TYPES = Object.freeze([
  'REQUIRES',
  'SUPPORTS',
  'PART_OF',
  'ASSESSES',
  'USES_STRATEGY',
  'CAN_FAIL_AS',
  'REMEDIATES',
  'TRANSFERS_TO',
  'IN_TEXTBOOK',
] as const)

export const EDGE_STATUSES = Object.freeze(['approved', 'proposed'] as const)

export const ITEM_TYPES = Object.freeze([
  'multiple_choice',
  'short_answer',
  'worked_example',
  'diagnostic',
  'transfer',
  'open_response',
] as const)

export const REVIEW_STATUSES = Object.freeze([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'changes_requested',
] as const)

export const REVIEW_DECISIONS = Object.freeze([
  'submit',
  'approve',
  'reject',
  'request_changes',
] as const)

export type NodeType = (typeof NODE_TYPES)[number]
export type RelationType = (typeof RELATION_TYPES)[number]
export type EdgeStatus = (typeof EDGE_STATUSES)[number]
export type ItemType = (typeof ITEM_TYPES)[number]
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

// ---------------------------------------------------------------------------
// Errors and shared helpers
// ---------------------------------------------------------------------------

export class CurriculumGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class GraphValidationError extends CurriculumGraphError {}

export class UnknownKnowledgeComponent extends CurriculumGraphError {}

export class ItemBankError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class ItemValidationError extends ItemBankError {}

export class ItemNotFoundError extends ItemBankError {}

export class ReviewTransitionError extends ItemBankError {}

const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${what} must be an object`)
  return value
}

function pick(
  raw: Record<string, unknown>,
  camel: string,
  snake: string,
  fallback?: unknown,
): unknown {
  if (raw[camel] !== undefined) return raw[camel]
  if (raw[snake] !== undefined) return raw[snake]
  return fallback
}

export function opaque(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`)
  }
  if (!OPAQUE_RE.test(value)) {
    throw new TypeError(`${field} must be a short opaque reference`)
  }
  return value
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`)
  }
  return value
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`)
  }
  return value
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`)
  }
  return value
}

function unitInterval(value: unknown, field: string): number {
  const number = finite(value, field)
  if (number < 0 || number > 1) {
    throw new TypeError(`${field} must be within [0, 1]`)
  }
  return number
}

function shortText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`)
  }
  if (value.length > maxLength || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be a short single-line string`)
  }
  return value
}

function timestamp(value: unknown, field = 'timestamp'): string {
  const text = shortText(value, field, 64)
  if (text.length === 0 || Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp`)
  }
  return text
}

function idArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of opaque ids`)
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    const id = opaque(entry, field)
    if (seen.has(id)) {
      throw new TypeError(`${field} contains duplicate id: ${id}`)
    }
    seen.add(id)
    result.push(id)
  }
  return Object.freeze(result)
}

function booleanValue(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`)
  }
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return shortText(value, field, 120)
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  return finite(value, field)
}

function nowIso(): string {
  return new Date().toISOString()
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry !== undefined) result[key] = canonicalize(entry)
    }
    return result
  }
  return value
}

/** Stable JSON used by both the Python and TypeScript content hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null'
}

/** SHA-256 over canonical JSON (integrity, not a signature). */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Knowledge graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  readonly nodeId: string
  readonly nodeType: NodeType | string
  readonly conceptId: string | null
}

export interface GraphNodeInput {
  readonly nodeId?: string
  readonly node_id?: string
  readonly nodeType?: NodeType | string
  readonly node_type?: NodeType | string
  readonly conceptId?: string | null
  readonly concept_id?: string | null
}

export interface GraphEdge {
  readonly sourceId: string
  readonly targetId: string
  readonly relation: RelationType | string
  readonly status: EdgeStatus | string
  readonly confidence: number
  readonly provenance: string
}

export interface GraphEdgeInput {
  readonly sourceId?: string
  readonly source_id?: string
  readonly targetId?: string
  readonly target_id?: string
  readonly relation?: RelationType | string
  readonly status?: EdgeStatus | string
  readonly confidence?: number
  readonly provenance?: string
}

export interface KnowledgeGraphInput {
  readonly version: number
  readonly nodes: readonly (GraphNode | GraphNodeInput)[]
  readonly edges?: readonly (GraphEdge | GraphEdgeInput)[]
}

export interface KnowledgeGraphSnapshot {
  readonly version: number
  readonly nodes: readonly {
    readonly node_id: string
    readonly node_type: string
    readonly concept_id: string | null
  }[]
  readonly edges: readonly {
    readonly source_id: string
    readonly target_id: string
    readonly relation: string
    readonly status: string
    readonly confidence: number
    readonly provenance: string
  }[]
}

function normalizeNode(value: unknown): GraphNode {
  const raw = asRecord(value, 'graph node')
  const nodeType = pick(raw, 'nodeType', 'node_type', 'knowledge_component')
  if (
    typeof nodeType !== 'string' ||
    !(NODE_TYPES as readonly string[]).includes(nodeType)
  ) {
    throw new GraphValidationError(`unknown node_type: ${String(nodeType)}`)
  }
  const concept = pick(raw, 'conceptId', 'concept_id', null)
  return Object.freeze({
    nodeId: opaque(pick(raw, 'nodeId', 'node_id'), 'node_id'),
    nodeType,
    conceptId:
      concept === null || concept === undefined
        ? null
        : opaque(concept, 'concept_id'),
  })
}

function normalizeEdge(value: unknown): GraphEdge {
  const raw = asRecord(value, 'graph edge')
  const relation = pick(raw, 'relation', 'relation', 'REQUIRES')
  if (
    typeof relation !== 'string' ||
    !(RELATION_TYPES as readonly string[]).includes(relation)
  ) {
    throw new GraphValidationError(`unknown relation: ${String(relation)}`)
  }
  const status = pick(raw, 'status', 'status', 'approved')
  if (
    typeof status !== 'string' ||
    !(EDGE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new GraphValidationError(`unknown edge status: ${String(status)}`)
  }
  const provenance = shortText(
    pick(raw, 'provenance', 'provenance', 'synthetic'),
    'provenance',
    120,
  )
  return Object.freeze({
    sourceId: opaque(pick(raw, 'sourceId', 'source_id'), 'source_id'),
    targetId: opaque(pick(raw, 'targetId', 'target_id'), 'target_id'),
    relation,
    status,
    confidence: unitInterval(
      pick(raw, 'confidence', 'confidence', 1),
      'confidence',
    ),
    provenance,
  })
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.sourceId}\u0000${edge.targetId}\u0000${edge.relation}`
}

function graphHasCycle(adjacency: ReadonlyMap<string, readonly string[]>): boolean {
  const indegree = new Map<string, number>()
  for (const nodeId of adjacency.keys()) indegree.set(nodeId, 0)
  for (const targets of adjacency.values()) {
    for (const target of targets) {
      indegree.set(target, (indegree.get(target) ?? 0) + 1)
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
  let visited = 0
  while (ready.length > 0) {
    const nodeId = ready.pop() as string
    visited += 1
    for (const target of adjacency.get(nodeId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1
      indegree.set(target, next)
      if (next === 0) ready.push(target)
    }
  }
  return visited !== indegree.size
}

export class KnowledgeGraph {
  readonly version: number
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly contentHash: string

  private readonly nodesById: ReadonlyMap<string, GraphNode>
  private readonly requiresAdjacency: ReadonlyMap<string, readonly string[]>
  private readonly partOfAdjacency: ReadonlyMap<string, readonly string[]>

  constructor(input: KnowledgeGraphInput) {
    this.version = positiveInt(input.version, 'version')
    if (!Array.isArray(input.nodes)) {
      throw new GraphValidationError('graph nodes must be an array')
    }
    const nodesById = new Map<string, GraphNode>()
    for (const raw of input.nodes) {
      const node = normalizeNode(raw)
      if (nodesById.has(node.nodeId)) {
        throw new GraphValidationError(`duplicate node id: ${node.nodeId}`)
      }
      nodesById.set(node.nodeId, node)
    }
    if (nodesById.size === 0) {
      throw new GraphValidationError('graph must contain at least one node')
    }

    const edgesByKey = new Map<string, GraphEdge>()
    for (const raw of input.edges ?? []) {
      const edge = normalizeEdge(raw)
      if (!nodesById.has(edge.sourceId)) {
        throw new GraphValidationError(`unknown edge source: ${edge.sourceId}`)
      }
      if (!nodesById.has(edge.targetId)) {
        throw new GraphValidationError(`unknown edge target: ${edge.targetId}`)
      }
      if (edge.sourceId === edge.targetId) {
        throw new GraphValidationError(
          `self loop is not allowed: ${edge.sourceId}`,
        )
      }
      const key = edgeKey(edge)
      if (edgesByKey.has(key)) {
        throw new GraphValidationError(
          `duplicate edge: ${edge.sourceId} -${edge.relation}-> ${edge.targetId}`,
        )
      }
      edgesByKey.set(key, edge)
    }

    this.nodesById = nodesById
    this.nodes = Object.freeze(
      [...nodesById.values()].sort((a, b) =>
        a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
      ),
    )
    this.edges = Object.freeze(
      [...edgesByKey.values()].sort((a, b) => {
        const left = `${a.sourceId}\u0000${a.targetId}\u0000${a.relation}\u0000${a.status}`
        const right = `${b.sourceId}\u0000${b.targetId}\u0000${b.relation}\u0000${b.status}`
        return left < right ? -1 : left > right ? 1 : 0
      }),
    )
    this.requiresAdjacency = this.adjacency('REQUIRES', true)
    this.partOfAdjacency = this.adjacency('PART_OF', true)

    for (const [relation, adjacency, label] of [
      ['REQUIRES', this.requiresAdjacency, 'prerequisite'],
      ['PART_OF', this.partOfAdjacency, 'part-of'],
    ] as const) {
      if (graphHasCycle(adjacency)) {
        throw new GraphValidationError(
          `${label} cycle detected in approved ${relation} edges`,
        )
      }
    }

    this.contentHash = contentHash(this.snapshot())
  }

  private adjacency(
    relation: string,
    approvedOnly: boolean,
  ): ReadonlyMap<string, readonly string[]> {
    const result = new Map<string, string[]>()
    for (const nodeId of this.nodesById.keys()) result.set(nodeId, [])
    for (const edge of this.edges) {
      if (edge.relation !== relation) continue
      if (approvedOnly && edge.status !== 'approved') continue
      result.get(edge.sourceId)?.push(edge.targetId)
    }
    for (const [nodeId, targets] of result) {
      result.set(
        nodeId,
        targets.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    }
    return result
  }

  snapshot(): KnowledgeGraphSnapshot {
    return {
      version: this.version,
      nodes: this.nodes.map((node) => ({
        node_id: node.nodeId,
        node_type: node.nodeType,
        concept_id: node.conceptId,
      })),
      edges: this.edges.map((edge) => ({
        source_id: edge.sourceId,
        target_id: edge.targetId,
        relation: edge.relation,
        status: edge.status,
        confidence: edge.confidence,
        provenance: edge.provenance,
      })),
    }
  }

  hasNode(kcId: string): boolean {
    return this.nodesById.has(kcId)
  }

  prerequisitesOf(kcId: string): readonly string[] {
    if (!this.nodesById.has(kcId)) {
      throw new UnknownKnowledgeComponent(
        `unknown knowledge component: ${kcId}`,
      )
    }
    return this.requiresAdjacency.get(kcId) ?? Object.freeze([])
  }

  prerequisiteClosure(kcId: string, includeSelf = false): ReadonlySet<string> {
    if (!this.nodesById.has(kcId)) {
      throw new UnknownKnowledgeComponent(
        `unknown knowledge component: ${kcId}`,
      )
    }
    const seen = new Set<string>()
    const stack = [...(this.requiresAdjacency.get(kcId) ?? [])]
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (seen.has(current)) continue
      seen.add(current)
      stack.push(...(this.requiresAdjacency.get(current) ?? []))
    }
    if (includeSelf) seen.add(kcId)
    return seen
  }

  hasCycle(relation: string = 'REQUIRES', approvedOnly = true): boolean {
    if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
      throw new GraphValidationError(`unknown relation: ${relation}`)
    }
    const adjacency = approvedOnly
      ? relation === 'REQUIRES'
        ? this.requiresAdjacency
        : relation === 'PART_OF'
          ? this.partOfAdjacency
          : this.adjacency(relation, true)
      : this.adjacency(relation, false)
    return graphHasCycle(adjacency)
  }

  /**
   * Deterministic dependency-first order: prerequisites before dependants.
   * The graph's `REQUIRES` edge points from dependant to prerequisite.
   */
  topologicalOrder(
    relation: string = 'REQUIRES',
    approvedOnly = true,
  ): readonly string[] {
    if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
      throw new GraphValidationError(`unknown relation: ${relation}`)
    }
    const adjacency = approvedOnly
      ? relation === 'REQUIRES'
        ? this.requiresAdjacency
        : relation === 'PART_OF'
          ? this.partOfAdjacency
          : this.adjacency(relation, true)
      : this.adjacency(relation, false)
    const indegree = new Map<string, number>()
    const dependants = new Map<string, string[]>()
    for (const nodeId of this.nodesById.keys()) {
      indegree.set(nodeId, adjacency.get(nodeId)?.length ?? 0)
      dependants.set(nodeId, [])
    }
    for (const [source, targets] of adjacency) {
      for (const target of targets) dependants.get(target)?.push(source)
    }
    const ready = [...indegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([nodeId]) => nodeId)
    ready.sort()
    const order: string[] = []
    while (ready.length > 0) {
      const nodeId = ready.shift() as string
      order.push(nodeId)
      for (const dependant of dependants.get(nodeId) ?? []) {
        const next = (indegree.get(dependant) ?? 0) - 1
        indegree.set(dependant, next)
        if (next === 0) {
          ready.push(dependant)
          ready.sort()
        }
      }
    }
    if (order.length !== this.nodesById.size) {
      throw new GraphValidationError(`cycle detected in ${relation} edges`)
    }
    return Object.freeze(order)
  }
}

export interface GraphDiff {
  readonly fromVersion: number
  readonly toVersion: number
  readonly addedNodes: readonly string[]
  readonly removedNodes: readonly string[]
  readonly addedEdges: readonly string[]
  readonly removedEdges: readonly string[]
}

export class KnowledgeGraphStore {
  private readonly byVersion = new Map<number, KnowledgeGraph>()
  private readonly versionList: number[] = []

  constructor(graphs: readonly KnowledgeGraph[] = []) {
    for (const graph of graphs) this.add(graph)
  }

  add(graph: KnowledgeGraph): KnowledgeGraph {
    if (!(graph instanceof KnowledgeGraph)) {
      throw new GraphValidationError(
        'only validated KnowledgeGraph values can be stored',
      )
    }
    if (this.byVersion.has(graph.version)) {
      throw new GraphValidationError(
        `graph version already exists: ${graph.version}`,
      )
    }
    const latest = this.versionList[this.versionList.length - 1]
    if (latest !== undefined && graph.version <= latest) {
      throw new GraphValidationError(
        `graph version must increase: ${graph.version} <= ${latest}`,
      )
    }
    this.byVersion.set(graph.version, graph)
    this.versionList.push(graph.version)
    return graph
  }

  addVersion(
    nodes: KnowledgeGraphInput['nodes'],
    edges: KnowledgeGraphInput['edges'] = [],
    version?: number,
  ): KnowledgeGraph {
    const latest = this.versionList[this.versionList.length - 1]
    const nextVersion = version ?? (latest === undefined ? 1 : latest + 1)
    return this.add(new KnowledgeGraph({ version: nextVersion, nodes, edges }))
  }

  get(version: number): KnowledgeGraph {
    const graph = this.byVersion.get(version)
    if (!graph) {
      throw new GraphValidationError(`unknown graph version: ${version}`)
    }
    return graph
  }

  latest(): KnowledgeGraph {
    const latest = this.versionList[this.versionList.length - 1]
    if (latest === undefined) {
      throw new GraphValidationError('graph store is empty')
    }
    return this.get(latest)
  }

  versions(): readonly number[] {
    return Object.freeze([...this.versionList])
  }

  history(): readonly KnowledgeGraph[] {
    return Object.freeze(this.versionList.map((version) => this.get(version)))
  }

  diff(fromVersion: number, toVersion: number): GraphDiff {
    const before = this.get(fromVersion)
    const after = this.get(toVersion)
    const beforeNodes = new Set(before.nodes.map((node) => node.nodeId))
    const afterNodes = new Set(after.nodes.map((node) => node.nodeId))
    const beforeEdges = new Set(before.edges.map(edgeKeyForDiff))
    const afterEdges = new Set(after.edges.map(edgeKeyForDiff))
    const sorted = (values: Set<string>): readonly string[] =>
      Object.freeze([...values].sort())
    return Object.freeze({
      fromVersion,
      toVersion,
      addedNodes: sorted(
        new Set([...afterNodes].filter((id) => !beforeNodes.has(id))),
      ),
      removedNodes: sorted(
        new Set([...beforeNodes].filter((id) => !afterNodes.has(id))),
      ),
      addedEdges: sorted(
        new Set([...afterEdges].filter((id) => !beforeEdges.has(id))),
      ),
      removedEdges: sorted(
        new Set([...beforeEdges].filter((id) => !afterEdges.has(id))),
      ),
    })
  }
}

function edgeKeyForDiff(edge: GraphEdge): string {
  return `${edge.sourceId}|${edge.relation}|${edge.targetId}`
}

// ---------------------------------------------------------------------------
// Item annotations, versions, and review ledger
// ---------------------------------------------------------------------------

export interface QMatrixEntry {
  readonly kcId: string
  readonly confidence: number
}

export interface QMatrixEntryInput {
  readonly kcId?: string
  readonly kc_id?: string
  readonly confidence?: number
}

function normalizeQMatrixEntry(value: unknown): QMatrixEntry {
  const raw = asRecord(value, 'q_matrix entry')
  return Object.freeze({
    kcId: opaque(pick(raw, 'kcId', 'kc_id'), 'kc_id'),
    confidence: unitInterval(
      pick(raw, 'confidence', 'confidence', 1),
      'q_matrix.confidence',
    ),
  })
}

export interface ItemAnnotationInput {
  readonly source?: string
  readonly license?: string
  readonly stage?: string
  readonly course?: string
  readonly gradeLevel?: number | null
  readonly grade_level?: number | null
  readonly curriculumNodeIds?: readonly string[]
  readonly curriculum_node_ids?: readonly string[]
  readonly requiredKcs?: readonly string[]
  readonly required_kcs?: readonly string[]
  readonly forbiddenFutureKcs?: readonly string[]
  readonly forbidden_future_kcs?: readonly string[]
  readonly qMatrix?: readonly (QMatrixEntry | QMatrixEntryInput)[]
  readonly q_matrix?: readonly (QMatrixEntry | QMatrixEntryInput)[]
  readonly strategyIds?: readonly string[]
  readonly strategy_ids?: readonly string[]
  readonly misconceptionTargets?: readonly string[]
  readonly misconception_targets?: readonly string[]
  readonly difficulty?: number | null
  readonly itemType?: string | null
  readonly item_type?: string | null
  readonly estimatedMinutes?: number | null
  readonly estimated_minutes?: number | null
  readonly verifierType?: string | null
  readonly verifier_type?: string | null
  readonly hintLeakageLevel?: number
  readonly hint_leakage_level?: number
  readonly nearTransferIds?: readonly string[]
  readonly near_transfer_ids?: readonly string[]
  readonly farTransferIds?: readonly string[]
  readonly far_transfer_ids?: readonly string[]
  readonly safetyChecked?: boolean
  readonly safety_checked?: boolean
  readonly contentVerified?: boolean
  readonly content_verified?: boolean
  readonly correctnessVerified?: boolean
  readonly correctness_verified?: boolean
  readonly annotationConfidence?: number | null
  readonly annotation_confidence?: number | null
  readonly cognitiveLoad?: number
  readonly cognitive_load?: number
  readonly exposureCount?: number
  readonly exposure_count?: number
  readonly extensionApproved?: boolean
  readonly extension_approved?: boolean
}

export interface ItemAnnotation {
  readonly source: string
  readonly license: string
  readonly stage: string
  readonly course: string
  readonly gradeLevel: number | null
  readonly curriculumNodeIds: readonly string[]
  readonly requiredKcs: readonly string[]
  readonly forbiddenFutureKcs: readonly string[]
  readonly qMatrix: readonly QMatrixEntry[]
  readonly strategyIds: readonly string[]
  readonly misconceptionTargets: readonly string[]
  readonly difficulty: number | null
  readonly itemType: string | null
  readonly estimatedMinutes: number | null
  readonly verifierType: string | null
  readonly hintLeakageLevel: number
  readonly nearTransferIds: readonly string[]
  readonly farTransferIds: readonly string[]
  readonly safetyChecked: boolean
  readonly contentVerified: boolean
  readonly correctnessVerified: boolean
  readonly annotationConfidence: number | null
  readonly cognitiveLoad: number
  readonly exposureCount: number
  readonly extensionApproved: boolean
}

export const MISSING_ANNOTATION_FIELDS = Object.freeze([
  'source',
  'license',
  'stage',
  'course',
  'grade_level',
  'curriculum_node_ids',
  'required_kcs',
  'q_matrix',
  'difficulty',
  'item_type',
  'estimated_minutes',
  'verifier_type',
  'safety_checked',
  'content_verified',
  'correctness_verified',
  'annotation_confidence',
] as const)

/** Normalise a content-free annotation. Missing values stay missing. */
export function normalizeItemAnnotation(
  input: ItemAnnotationInput | Record<string, unknown> | ItemAnnotation,
): ItemAnnotation {
  const raw = asRecord(input, 'annotation')
  const gradeValue = pick(raw, 'gradeLevel', 'grade_level', null)
  const difficultyValue = pick(raw, 'difficulty', 'difficulty', null)
  const itemTypeValue = pick(raw, 'itemType', 'item_type', null)
  if (
    itemTypeValue !== null &&
    itemTypeValue !== undefined &&
    (typeof itemTypeValue !== 'string' ||
      !(ITEM_TYPES as readonly string[]).includes(itemTypeValue))
  ) {
    throw new ItemValidationError(`unknown item_type: ${String(itemTypeValue)}`)
  }
  const qMatrixRaw = pick(raw, 'qMatrix', 'q_matrix', [])
  if (!Array.isArray(qMatrixRaw)) {
    throw new ItemValidationError('q_matrix must be an array')
  }
  const qMatrix: QMatrixEntry[] = []
  const qKcs = new Set<string>()
  for (const entry of qMatrixRaw) {
    const normalized = normalizeQMatrixEntry(entry)
    if (qKcs.has(normalized.kcId)) {
      throw new ItemValidationError(
        `duplicate q_matrix kc_id: ${normalized.kcId}`,
      )
    }
    qKcs.add(normalized.kcId)
    qMatrix.push(normalized)
  }

  const estimatedValue = pick(
    raw,
    'estimatedMinutes',
    'estimated_minutes',
    null,
  )
  const estimated =
    estimatedValue === null || estimatedValue === undefined
      ? null
      : finite(estimatedValue, 'estimated_minutes')
  if (estimated !== null && estimated <= 0) {
    throw new ItemValidationError('estimated_minutes must be positive')
  }
  const hintLeakage = nonNegativeInt(
    pick(raw, 'hintLeakageLevel', 'hint_leakage_level', 0),
    'hint_leakage_level',
  )
  if (hintLeakage > 3) {
    throw new ItemValidationError('hint_leakage_level must be within [0, 3]')
  }
  const cognitiveLoad = finite(
    pick(raw, 'cognitiveLoad', 'cognitive_load', 0),
    'cognitive_load',
  )
  if (cognitiveLoad < 0) {
    throw new ItemValidationError('cognitive_load must be non-negative')
  }

  return Object.freeze({
    source: shortText(pick(raw, 'source', 'source', 'synthetic'), 'source', 120),
    license: shortText(
      pick(raw, 'license', 'license', 'synthetic-only'),
      'license',
      120,
    ),
    stage: shortText(pick(raw, 'stage', 'stage', 'secondary'), 'stage', 120),
    course: shortText(
      pick(raw, 'course', 'course', 'synthetic.course'),
      'course',
      120,
    ),
    gradeLevel:
      gradeValue === null || gradeValue === undefined
        ? null
        : positiveInt(gradeValue, 'grade_level'),
    curriculumNodeIds: idArray(
      pick(raw, 'curriculumNodeIds', 'curriculum_node_ids', []),
      'curriculum_node_ids',
    ),
    requiredKcs: idArray(
      pick(raw, 'requiredKcs', 'required_kcs', []),
      'required_kcs',
    ),
    forbiddenFutureKcs: idArray(
      pick(raw, 'forbiddenFutureKcs', 'forbidden_future_kcs', []),
      'forbidden_future_kcs',
    ),
    qMatrix: Object.freeze(qMatrix),
    strategyIds: idArray(
      pick(raw, 'strategyIds', 'strategy_ids', []),
      'strategy_ids',
    ),
    misconceptionTargets: idArray(
      pick(raw, 'misconceptionTargets', 'misconception_targets', []),
      'misconception_targets',
    ),
    difficulty:
      difficultyValue === null || difficultyValue === undefined
        ? null
        : unitInterval(difficultyValue, 'difficulty'),
    itemType:
      itemTypeValue === null || itemTypeValue === undefined
        ? null
        : itemTypeValue,
    estimatedMinutes: estimated,
    verifierType: nullableString(
      pick(raw, 'verifierType', 'verifier_type', null),
      'verifier_type',
    ),
    hintLeakageLevel: hintLeakage,
    nearTransferIds: idArray(
      pick(raw, 'nearTransferIds', 'near_transfer_ids', []),
      'near_transfer_ids',
    ),
    farTransferIds: idArray(
      pick(raw, 'farTransferIds', 'far_transfer_ids', []),
      'far_transfer_ids',
    ),
    safetyChecked: booleanValue(
      pick(raw, 'safetyChecked', 'safety_checked', false),
      'safety_checked',
    ),
    contentVerified: booleanValue(
      pick(raw, 'contentVerified', 'content_verified', false),
      'content_verified',
    ),
    correctnessVerified: booleanValue(
      pick(raw, 'correctnessVerified', 'correctness_verified', false),
      'correctness_verified',
    ),
    annotationConfidence:
      pick(raw, 'annotationConfidence', 'annotation_confidence', null) === null ||
      pick(raw, 'annotationConfidence', 'annotation_confidence', null) ===
        undefined
        ? null
        : unitInterval(
            pick(raw, 'annotationConfidence', 'annotation_confidence'),
            'annotation_confidence',
          ),
    cognitiveLoad,
    exposureCount: nonNegativeInt(
      pick(raw, 'exposureCount', 'exposure_count', 0),
      'exposure_count',
    ),
    extensionApproved: booleanValue(
      pick(raw, 'extensionApproved', 'extension_approved', false),
      'extension_approved',
    ),
  })
}

export function missingAnnotationFields(
  annotation: ItemAnnotation,
): readonly string[] {
  const missing: string[] = []
  for (const name of ['source', 'license', 'stage', 'course'] as const) {
    if (!annotation[name]) missing.push(name)
  }
  if (annotation.gradeLevel === null) missing.push('grade_level')
  if (annotation.curriculumNodeIds.length === 0) {
    missing.push('curriculum_node_ids')
  }
  if (annotation.requiredKcs.length === 0) missing.push('required_kcs')
  if (annotation.qMatrix.length === 0) missing.push('q_matrix')
  if (annotation.difficulty === null) missing.push('difficulty')
  if (annotation.itemType === null) missing.push('item_type')
  if (annotation.estimatedMinutes === null) missing.push('estimated_minutes')
  if (!annotation.verifierType) missing.push('verifier_type')
  if (!annotation.safetyChecked) missing.push('safety_checked')
  if (!annotation.contentVerified) missing.push('content_verified')
  if (!annotation.correctnessVerified) missing.push('correctness_verified')
  if (annotation.annotationConfidence === null) {
    missing.push('annotation_confidence')
  }
  return Object.freeze(missing)
}

export function annotationIsComplete(annotation: ItemAnnotation): boolean {
  return missingAnnotationFields(annotation).length === 0
}

export function annotationToCurriculumItem(
  itemId: string,
  annotation: ItemAnnotation,
): CurriculumItem {
  const missing = missingAnnotationFields(annotation)
  const role =
    annotation.itemType === 'transfer'
      ? 'transfer'
      : annotation.itemType === 'diagnostic'
        ? 'diagnostic'
        : 'training'
  return Object.freeze({
    itemId,
    requiredKcs: annotation.requiredKcs,
    gradeLevel: annotation.gradeLevel,
    safetyChecked: annotation.safetyChecked,
    contentVerified: annotation.contentVerified,
    annotationConfidence: annotation.annotationConfidence,
    futureMethods: annotation.forbiddenFutureKcs,
    cognitiveLoad: annotation.cognitiveLoad,
    extensionApproved: annotation.extensionApproved,
    role,
    annotationsComplete: missing.length === 0,
  })
}

/** Snake-case annotation snapshot used by content hashes. */
export function annotationSnapshot(
  annotation: ItemAnnotation,
): Readonly<Record<string, unknown>> {
  return {
    source: annotation.source,
    license: annotation.license,
    stage: annotation.stage,
    course: annotation.course,
    grade_level: annotation.gradeLevel,
    curriculum_node_ids: [...annotation.curriculumNodeIds],
    required_kcs: [...annotation.requiredKcs],
    forbidden_future_kcs: [...annotation.forbiddenFutureKcs],
    q_matrix: annotation.qMatrix.map((entry) => ({
      kc_id: entry.kcId,
      confidence: entry.confidence,
    })),
    strategy_ids: [...annotation.strategyIds],
    misconception_targets: [...annotation.misconceptionTargets],
    difficulty: annotation.difficulty,
    item_type: annotation.itemType,
    estimated_minutes: annotation.estimatedMinutes,
    verifier_type: annotation.verifierType,
    hint_leakage_level: annotation.hintLeakageLevel,
    near_transfer_ids: [...annotation.nearTransferIds],
    far_transfer_ids: [...annotation.farTransferIds],
    safety_checked: annotation.safetyChecked,
    content_verified: annotation.contentVerified,
    correctness_verified: annotation.correctnessVerified,
    annotation_confidence: annotation.annotationConfidence,
    cognitive_load: annotation.cognitiveLoad,
    exposure_count: annotation.exposureCount,
    extension_approved: annotation.extensionApproved,
  }
}

export interface ItemVersion {
  readonly itemId: string
  readonly version: number
  readonly annotation: ItemAnnotation
  readonly createdAt: string
  readonly contentHash: string
}

export interface ItemReviewRecord {
  readonly itemId: string
  readonly itemVersion: number
  readonly decision: ReviewDecision | string
  readonly reviewerRef: string
  readonly reviewedAt: string
  readonly note: string
}

export interface ItemRecord {
  readonly itemId: string
  readonly version: number
  readonly annotation: ItemAnnotation
  readonly reviewStatus: ReviewStatus | string
  readonly createdAt: string
  readonly contentHash: string
  readonly history: readonly ItemVersion[]
  readonly reviews: readonly ItemReviewRecord[]
}

function itemContentHash(
  itemId: string,
  version: number,
  annotation: ItemAnnotation,
): string {
  return contentHash({
    item_id: itemId,
    version,
    annotation: annotationSnapshot(annotation),
  })
}

export interface AddItemOptions {
  readonly version?: number
  readonly reviewStatus?: ReviewStatus | string
  readonly createdAt?: string
}

export interface ReviseItemOptions {
  readonly createdAt?: string
  readonly expectedVersion?: number
}

export interface ReviewOptions {
  readonly reviewedAt?: string
  readonly note?: string
  readonly expectedVersion?: number
}

export interface SubmitReviewOptions {
  readonly submittedAt?: string
  readonly note?: string
  readonly expectedVersion?: number
}

/** Versioned synthetic item bank with an append-only review ledger. */
export class ItemBank {
  private readonly versions = new Map<string, ItemVersion[]>()
  private readonly statuses = new Map<string, ReviewStatus | string>()
  private readonly reviewLedger = new Map<string, ItemReviewRecord[]>()

  addItem(
    itemId: string,
    annotation: ItemAnnotationInput | Record<string, unknown>,
    options: AddItemOptions = {},
  ): ItemRecord {
    const id = opaque(itemId, 'item_id')
    if (this.versions.has(id)) {
      throw new ItemValidationError(`item already exists: ${id}`)
    }
    const version = options.version ?? 1
    if (version !== 1) {
      throw new ItemValidationError('new items must start at version 1')
    }
    const status = options.reviewStatus ?? 'draft'
    if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
      throw new ItemValidationError(`unknown review_status: ${status}`)
    }
    const normalized = normalizeItemAnnotation(annotation)
    const createdAt = timestamp(options.createdAt ?? nowIso(), 'created_at')
    const record = Object.freeze({
      itemId: id,
      version,
      annotation: normalized,
      createdAt,
      contentHash: itemContentHash(id, version, normalized),
    })
    this.versions.set(id, [record])
    this.statuses.set(id, status)
    this.reviewLedger.set(id, [])
    return this.current(id)
  }

  reviseItem(
    itemId: string,
    annotation: ItemAnnotationInput | Record<string, unknown>,
    options: ReviseItemOptions = {},
  ): ItemRecord {
    const id = opaque(itemId, 'item_id')
    const versions = this.requireItem(id)
    const current = versions[versions.length - 1] as ItemVersion
    this.assertExpected(id, options.expectedVersion)
    const normalized = normalizeItemAnnotation(annotation)
    const version = current.version + 1
    const createdAt = timestamp(options.createdAt ?? nowIso(), 'created_at')
    versions.push(
      Object.freeze({
        itemId: id,
        version,
        annotation: normalized,
        createdAt,
        contentHash: itemContentHash(id, version, normalized),
      }),
    )
    // A content revision always resets review; old approvals do not carry.
    this.statuses.set(id, 'draft')
    return this.current(id)
  }

  submitForReview(
    itemId: string,
    submittedBy: string,
    options: SubmitReviewOptions = {},
  ): ItemRecord {
    const id = opaque(itemId, 'item_id')
    this.requireItem(id)
    this.assertExpected(id, options.expectedVersion)
    const status = this.statuses.get(id) ?? 'draft'
    if (status !== 'draft' && status !== 'changes_requested') {
      throw new ReviewTransitionError(`cannot submit ${id} from status ${status}`)
    }
    this.appendReview(id, {
      decision: 'submit',
      reviewerRef: submittedBy,
      reviewedAt: options.submittedAt ?? nowIso(),
      note: options.note ?? '',
    })
    this.statuses.set(id, 'pending_review')
    return this.current(id)
  }

  review(
    itemId: string,
    decision: 'approve' | 'reject' | 'request_changes' | string,
    reviewerRef: string,
    options: ReviewOptions = {},
  ): ItemRecord {
    const id = opaque(itemId, 'item_id')
    this.requireItem(id)
    this.assertExpected(id, options.expectedVersion)
    if (
      decision !== 'approve' &&
      decision !== 'reject' &&
      decision !== 'request_changes'
    ) {
      throw new ItemValidationError(`invalid review decision: ${decision}`)
    }
    const status = this.statuses.get(id) ?? 'draft'
    const current = this.current(id)
    if (decision === 'approve') {
      if (status !== 'pending_review') {
        throw new ReviewTransitionError(`cannot approve ${id} from status ${status}`)
      }
      const missing = missingAnnotationFields(current.annotation)
      if (missing.length > 0) {
        throw new ItemValidationError(
          `cannot approve item with missing annotations: ${missing.join(',')}`,
        )
      }
      this.statuses.set(id, 'approved')
    } else if (decision === 'reject') {
      if (status !== 'pending_review' && status !== 'approved') {
        throw new ReviewTransitionError(`cannot reject ${id} from status ${status}`)
      }
      this.statuses.set(id, 'rejected')
    } else {
      if (status !== 'pending_review' && status !== 'approved') {
        throw new ReviewTransitionError(
          `cannot request changes for ${id} from status ${status}`,
        )
      }
      this.statuses.set(id, 'changes_requested')
    }
    this.appendReview(id, {
      decision,
      reviewerRef,
      reviewedAt: options.reviewedAt ?? nowIso(),
      note: options.note ?? '',
    })
    return this.current(id)
  }

  private appendReview(
    itemId: string,
    input: {
      readonly decision: ReviewDecision | string
      readonly reviewerRef: string
      readonly reviewedAt: string
      readonly note: string
    },
  ): void {
    if (!(REVIEW_DECISIONS as readonly string[]).includes(input.decision)) {
      throw new ItemValidationError(
        `unknown review decision: ${input.decision}`,
      )
    }
    const versions = this.requireItem(itemId)
    const current = versions[versions.length - 1] as ItemVersion
    const reviewedAt = timestamp(input.reviewedAt, 'reviewed_at')
    const note = shortText(input.note, 'note', 500)
    const ledger = this.reviewLedger.get(itemId)
    if (!ledger) throw new ItemNotFoundError(`unknown item: ${itemId}`)
    ledger.push(
      Object.freeze({
        itemId,
        itemVersion: current.version,
        decision: input.decision,
        reviewerRef: opaque(input.reviewerRef, 'reviewer_ref'),
        reviewedAt,
        note,
      }),
    )
  }

  private requireItem(itemId: string): ItemVersion[] {
    const versions = this.versions.get(itemId)
    if (!versions) throw new ItemNotFoundError(`unknown item: ${itemId}`)
    return versions
  }

  private assertExpected(itemId: string, expectedVersion?: number): void {
    if (expectedVersion === undefined) return
    const versions = this.requireItem(itemId)
    const current = versions[versions.length - 1] as ItemVersion
    if (current.version !== expectedVersion) {
      throw new ReviewTransitionError(
        `version conflict for ${itemId}: expected ${expectedVersion}, current ${current.version}`,
      )
    }
  }

  current(itemId: string): ItemRecord {
    const id = opaque(itemId, 'item_id')
    const versions = this.requireItem(id)
    const current = versions[versions.length - 1] as ItemVersion
    return Object.freeze({
      itemId: id,
      version: current.version,
      annotation: current.annotation,
      reviewStatus: this.statuses.get(id) ?? 'draft',
      createdAt: current.createdAt,
      contentHash: current.contentHash,
      history: Object.freeze([...versions]),
      reviews: Object.freeze([...(this.reviewLedger.get(id) ?? [])]),
    })
  }

  getVersion(itemId: string, version: number): ItemVersion {
    const id = opaque(itemId, 'item_id')
    const versions = this.requireItem(id)
    const found = versions.find((entry) => entry.version === version)
    if (!found) {
      throw new ItemNotFoundError(`unknown item version: ${id}@${version}`)
    }
    return found
  }

  history(itemId: string): readonly ItemVersion[] {
    const id = opaque(itemId, 'item_id')
    return Object.freeze([...this.requireItem(id)])
  }

  reviews(itemId: string): readonly ItemReviewRecord[] {
    const id = opaque(itemId, 'item_id')
    this.requireItem(id)
    return Object.freeze([...(this.reviewLedger.get(id) ?? [])])
  }

  listCurrent(): readonly ItemRecord[] {
    return Object.freeze(
      [...this.versions.keys()]
        .sort()
        .map((itemId) => this.current(itemId)),
    )
  }

  toCurriculumItem(itemId: string): CurriculumItem {
    const record = this.current(itemId)
    return annotationToCurriculumItem(record.itemId, record.annotation)
  }

  /**
   * Deterministic local in-memory RAG retrieval. Only current approved items
   * are indexed, and hits contain an opaque id plus annotation summary.
   */
  search(
    query: RetrievalQueryInput | RetrievalQuery | null = null,
  ): readonly RetrievalHit[] {
    const normalized = normalizeRetrievalQuery(query)
    const queryKcs = new Set(normalized.kcIds)
    const hits: RetrievalHit[] = []
    for (const record of this.listCurrent()) {
      if (record.reviewStatus !== 'approved') continue
      const annotation = record.annotation
      const itemKcs = new Set(annotation.requiredKcs)
      const qMatrixKcs = new Set(annotation.qMatrix.map((entry) => entry.kcId))
      let score = 0
      if (normalized.kcIds.length > 0) {
        const requiredMatches = [...itemKcs].filter((kc) => queryKcs.has(kc))
          .length
        const qMatches = [...qMatrixKcs].filter((kc) => queryKcs.has(kc)).length
        if (requiredMatches === 0 && qMatches === 0) continue
        score += 400 * requiredMatches + 200 * qMatches
      }
      if (normalized.itemTypes.length > 0) {
        if (
          annotation.itemType === null ||
          !normalized.itemTypes.includes(annotation.itemType)
        ) {
          continue
        }
        score += 100
      }
      if (
        normalized.difficultyMin !== null ||
        normalized.difficultyMax !== null
      ) {
        if (annotation.difficulty === null) continue
        if (
          normalized.difficultyMin !== null &&
          annotation.difficulty < normalized.difficultyMin
        ) {
          continue
        }
        if (
          normalized.difficultyMax !== null &&
          annotation.difficulty > normalized.difficultyMax
        ) {
          continue
        }
        score += 100
      }
      if (normalized.difficultyTarget !== null) {
        if (annotation.difficulty === null) continue
        const closeness = 1 - Math.abs(
          annotation.difficulty - normalized.difficultyTarget,
        )
        score += Math.max(0, Math.trunc(closeness * 1000))
      }
      if (annotation.annotationConfidence !== null) {
        score += Math.trunc(annotation.annotationConfidence * 100)
      }
      score -= Math.min(annotation.exposureCount, 100)
      hits.push(
        Object.freeze({
          itemId: record.itemId,
          score,
          requiredKcs: annotation.requiredKcs,
          qMatrixKcs: Object.freeze([...qMatrixKcs].sort()),
          difficulty: annotation.difficulty,
          itemType: annotation.itemType,
          annotationConfidence: annotation.annotationConfidence,
          reviewStatus: record.reviewStatus,
          version: record.version,
          estimatedMinutes: annotation.estimatedMinutes,
          gradeLevel: annotation.gradeLevel,
        }),
      )
    }
    hits.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
    })
    return Object.freeze(hits.slice(0, normalized.limit))
  }
}

export interface RetrievalQuery {
  readonly kcIds: readonly string[]
  readonly difficultyMin: number | null
  readonly difficultyMax: number | null
  readonly difficultyTarget: number | null
  readonly itemTypes: readonly string[]
  readonly limit: number
}

export interface RetrievalQueryInput {
  readonly kcIds?: readonly string[]
  readonly kc_ids?: readonly string[]
  readonly difficultyMin?: number | null
  readonly difficulty_min?: number | null
  readonly difficultyMax?: number | null
  readonly difficulty_max?: number | null
  readonly difficultyTarget?: number | null
  readonly difficulty_target?: number | null
  readonly itemTypes?: readonly string[]
  readonly item_types?: readonly string[]
  readonly limit?: number
}

export function normalizeRetrievalQuery(
  query: RetrievalQueryInput | RetrievalQuery | null = null,
): RetrievalQuery {
  if (query === null || query === undefined) {
    return Object.freeze({
      kcIds: Object.freeze([]),
      difficultyMin: null,
      difficultyMax: null,
      difficultyTarget: null,
      itemTypes: Object.freeze([]),
      limit: 10,
    })
  }
  const raw = asRecord(query, 'query')
  const kcIds = idArray(pick(raw, 'kcIds', 'kc_ids', []), 'kc_ids')
  const itemTypesRaw = pick(raw, 'itemTypes', 'item_types', [])
  if (!Array.isArray(itemTypesRaw)) {
    throw new ItemValidationError('item_types must be an array')
  }
  const itemTypes: string[] = []
  for (const itemType of itemTypesRaw) {
    if (
      typeof itemType !== 'string' ||
      !(ITEM_TYPES as readonly string[]).includes(itemType)
    ) {
      throw new ItemValidationError(`unknown item_type: ${String(itemType)}`)
    }
    itemTypes.push(itemType)
  }
  const difficultyMin = optionalUnit(
    pick(raw, 'difficultyMin', 'difficulty_min', null),
    'difficulty_min',
  )
  const difficultyMax = optionalUnit(
    pick(raw, 'difficultyMax', 'difficulty_max', null),
    'difficulty_max',
  )
  const difficultyTarget = optionalUnit(
    pick(raw, 'difficultyTarget', 'difficulty_target', null),
    'difficulty_target',
  )
  if (
    difficultyMin !== null &&
    difficultyMax !== null &&
    difficultyMin > difficultyMax
  ) {
    throw new ItemValidationError('difficulty_min must be <= difficulty_max')
  }
  const limit = pick(raw, 'limit', 'limit', 10)
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new ItemValidationError('limit must be an integer')
  }
  if (limit < 1 || limit > 50) {
    throw new ItemValidationError('limit must be within [1, 50]')
  }
  return Object.freeze({
    kcIds,
    difficultyMin,
    difficultyMax,
    difficultyTarget,
    itemTypes: Object.freeze(itemTypes),
    limit,
  })
}

function optionalUnit(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return unitInterval(value, field)
}

export interface RetrievalHit {
  readonly itemId: string
  readonly score: number
  readonly requiredKcs: readonly string[]
  readonly qMatrixKcs: readonly string[]
  readonly difficulty: number | null
  readonly itemType: string | null
  readonly annotationConfidence: number | null
  readonly reviewStatus: string
  readonly version: number
  readonly estimatedMinutes: number | null
  readonly gradeLevel: number | null
}

// ---------------------------------------------------------------------------
// Gate-bound retrieval plan
// ---------------------------------------------------------------------------

export interface RetrievalCandidate {
  readonly itemId: string
  readonly item: CurriculumItem
  readonly hit: RetrievalHit
  readonly decision: GateDecision
  readonly missingPrerequisites: readonly string[]
  readonly unknownKcs: readonly string[]
}

export interface RetrievalRejection {
  readonly itemId: string
  readonly reasons: readonly string[]
}

export interface RetrievalPlan {
  readonly hits: readonly RetrievalHit[]
  readonly candidates: readonly RetrievalCandidate[]
  readonly rejected: readonly RetrievalRejection[]
  readonly allowedKcs: readonly string[]
  readonly blockedReason?: string
}

export interface PrerequisiteDiagnostics {
  readonly missingPrerequisites: readonly string[]
  readonly unknownKcs: readonly string[]
}

/**
 * Return transitive prerequisites of `requiredKcs` that are not in `allowed`.
 * Unknown KCs are reported separately so callers fail closed rather than
 * treating an unknown node as satisfied.
 */
export function prerequisiteDiagnostics(
  graph: KnowledgeGraph,
  requiredKcs: readonly string[],
  allowed: readonly string[],
): PrerequisiteDiagnostics {
  const allowedSet = new Set(allowed)
  const missing = new Set<string>()
  const unknown = new Set<string>()
  for (const kcId of requiredKcs) {
    if (!graph.hasNode(kcId)) {
      unknown.add(kcId)
      continue
    }
    for (const prerequisite of graph.prerequisiteClosure(kcId)) {
      if (!allowedSet.has(prerequisite)) missing.add(prerequisite)
    }
  }
  return Object.freeze({
    missingPrerequisites: Object.freeze([...missing].sort()),
    unknownKcs: Object.freeze([...unknown].sort()),
  })
}

/**
 * Retrieve, then re-check every hit through the fail-closed gate. A hit becomes
 * a candidate only when the gate allows it *and* every transitive prerequisite
 * is already allowed. A missing graph/unknown KC fails closed.
 */
export function planRetrieval(
  bank: ItemBank,
  graph: KnowledgeGraph | null | undefined,
  progress: LearnerProgress,
  mode: string,
  query: RetrievalQueryInput | RetrievalQuery | null = null,
  thresholds: GateThresholds = {},
): RetrievalPlan {
  const hits = bank.search(query)
  const allowed = allowedKcs(
    progress,
    mode,
    thresholds.minProgressConfidence ?? DEFAULT_MIN_PROGRESS_CONFIDENCE,
  )
  if (graph === null || graph === undefined) {
    return Object.freeze({
      hits,
      candidates: Object.freeze([]),
      rejected: Object.freeze(
        hits.map((hit) =>
          Object.freeze({
            itemId: hit.itemId,
            reasons: Object.freeze(['graph_unavailable']),
          }),
        ),
      ),
      allowedKcs: Object.freeze([...allowed].sort()),
      blockedReason: 'graph_unavailable',
    })
  }

  const candidates: RetrievalCandidate[] = []
  const rejected: RetrievalRejection[] = []
  for (const hit of hits) {
    const record = bank.current(hit.itemId)
    const item = annotationToCurriculumItem(record.itemId, record.annotation)
    const decision = allow(item, progress, mode, {
      minAnnotationConfidence:
        thresholds.minAnnotationConfidence ??
        DEFAULT_MIN_ANNOTATION_CONFIDENCE,
      minProgressConfidence:
        thresholds.minProgressConfidence ?? DEFAULT_MIN_PROGRESS_CONFIDENCE,
    })
    const diagnostics = prerequisiteDiagnostics(
      graph,
      item.requiredKcs ?? [],
      decision.allowedKcs,
    )
    const reasons = [
      ...decision.reasons,
      ...(diagnostics.unknownKcs.length > 0
        ? [`kc_not_in_graph:${diagnostics.unknownKcs.join(',')}`]
        : []),
      ...(diagnostics.missingPrerequisites.length > 0
        ? [
            `prerequisites_not_met:${diagnostics.missingPrerequisites.join(',')}`,
          ]
        : []),
    ]
    if (
      decision.allowed &&
      diagnostics.missingPrerequisites.length === 0 &&
      diagnostics.unknownKcs.length === 0
    ) {
      candidates.push(
        Object.freeze({
          itemId: hit.itemId,
          item,
          hit,
          decision,
          missingPrerequisites: diagnostics.missingPrerequisites,
          unknownKcs: diagnostics.unknownKcs,
        }),
      )
    } else {
      rejected.push(
        Object.freeze({ itemId: hit.itemId, reasons: Object.freeze(reasons) }),
      )
    }
  }
  return Object.freeze({
    hits,
    candidates: Object.freeze(candidates),
    rejected: Object.freeze(rejected),
    allowedKcs: Object.freeze([...allowed].sort()),
  })
}
