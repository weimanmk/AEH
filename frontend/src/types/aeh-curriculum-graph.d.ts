/**
 * 类型声明：真实运行时模块是 `dsh-plugin/src/core/curriculum-graph.ts`。
 *
 * 原因与 `aeh-twin.d.ts` 相同：该插件源码在严格 `noUnusedLocals` 下存在
 * 内部未使用 helper，而前端不修改插件。Vite alias 在运行时加载真实源码；
 * 这里只投影前端用到的图 API（构图、环检测、内容摘要）。
 */

export interface GraphNodeInput {
  readonly nodeId?: string
  readonly node_id?: string
  readonly nodeType?: string
  readonly node_type?: string
  readonly conceptId?: string | null
  readonly concept_id?: string | null
}

export interface GraphEdgeInput {
  readonly sourceId?: string
  readonly source_id?: string
  readonly targetId?: string
  readonly target_id?: string
  readonly relation?: string
  readonly status?: string
  readonly confidence?: number
  readonly provenance?: string
}

export interface KnowledgeGraphInput {
  readonly version: number
  readonly nodes: readonly GraphNodeInput[]
  readonly edges?: readonly GraphEdgeInput[]
}

export interface GraphNode {
  readonly nodeId: string
  readonly nodeType: string
  readonly conceptId: string | null
}

export interface GraphEdge {
  readonly sourceId: string
  readonly targetId: string
  readonly relation: string
  readonly status: string
  readonly confidence: number
  readonly provenance: string
}

export class GraphValidationError extends Error {}

export class KnowledgeGraph {
  constructor(input: KnowledgeGraphInput)
  readonly version: number
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly contentHash: string
  hasNode(kcId: string): boolean
  prerequisitesOf(kcId: string): readonly string[]
  prerequisiteClosure(kcId: string, includeSelf?: boolean): ReadonlySet<string>
  hasCycle(relation?: string, approvedOnly?: boolean): boolean
  topologicalOrder(relation?: string, approvedOnly?: boolean): readonly string[]
}

export function contentHash(value: unknown): string
