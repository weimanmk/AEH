/**
 * 类型声明：真实运行时模块是 `dsh-plugin/src/core/twin.ts`。
 *
 * 该插件源码没有开启 `noUnusedLocals`，其中有一个只在本文件内部未使用的
 * helper（`cloneKnowledge`），会触发前端严格的 TS6133。前端不修改插件，
 * 因此只对 twin/graph 这两个文件使用本声明做“类型投影”，Vite 运行时
 * 仍通过 alias 加载真实插件源码。声明只覆盖前端真正调用的 API。
 */

import type { HypothesisSet } from '@aeh/core/hypothesis.ts'
import type { MemoryParameters } from '@aeh/core/memory.ts'
import type {
  KnowledgeEstimate,
  MemoryObservationInput,
  MemoryState,
} from '@aeh/domain.ts'

export interface TwinEventInput {
  readonly eventId: string
  readonly eventType: string
  readonly source: string
  readonly studentRef?: string | null
  readonly occurredAt?: string | null
  readonly observedAt?: string | null
  readonly payload?: Readonly<Record<string, unknown>>
  readonly provenance?: string
  readonly modelVersions?: Readonly<Record<string, string>>
  readonly schemaVersion?: string
  readonly consentScope?: string
}

export interface TwinEvent {
  readonly eventId: string
  readonly eventType: string
  readonly source: string
  readonly studentRef: string | null
  readonly occurredAt: string | null
  readonly observedAt: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly provenance: string
  readonly modelVersions: Readonly<Record<string, string>>
  readonly schemaVersion: string
  readonly consentScope: string
}

export interface TwinState {
  readonly studentRef: string
  readonly version: number
  readonly knowledge: ReadonlyMap<string, KnowledgeEstimate>
  readonly observedEvidenceIds: ReadonlySet<string>
  readonly lastObservedAt: string | null
  readonly unresolvedHypotheses: readonly string[]
  readonly memory: ReadonlyMap<string, MemoryState>
  readonly hypothesisRevision: number
  readonly activeParameterVersion: string
}

export interface TwinSnapshot {
  readonly studentRef: string
  readonly version: number
  readonly evidenceRevision: number
  readonly knowledge: readonly KnowledgeEstimate[]
  readonly unresolvedHypotheses: readonly string[]
  readonly lastObservedAt: string | null
}

export interface HypothesisBinding {
  readonly bindingId: string
  readonly hypothesisRevision: number
  readonly twinVersion: number
  readonly weights: Readonly<Record<string, number>>
  readonly unresolved: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly boundAt: string | null
}

export interface TwinOptions {
  readonly clock?: () => string
}

export class StudentTwin {
  constructor(studentRef: string, options?: TwinOptions)
  readonly studentRef: string
  get version(): number
  get evidenceRevision(): number
  get hypotheses(): HypothesisSet | null
  get state(): TwinState
  snapshot(): TwinSnapshot
  recordObserved(input: TwinEventInput): TwinEvent
  updateMastery(
    kcId: string,
    masteryMean: number,
    uncertainty: number,
    evidenceIds: readonly string[],
    exposureState?: string,
  ): KnowledgeEstimate
  recordMemoryReview(
    kcId: string,
    observation: MemoryObservationInput,
    evidenceIds: readonly string[],
    parameters?: MemoryParameters,
  ): MemoryState
  bindHypotheses(
    hypothesisSet: HypothesisSet,
    options?: { readonly evidenceIds?: readonly string[] },
  ): HypothesisBinding
  memoryFor(kcId: string): MemoryState | undefined
  memoryStates(): ReadonlyMap<string, MemoryState>
  memoryAggregate(
    now?: string,
    options?: { readonly targetRetention?: number },
  ): Readonly<Record<string, unknown>>
}
