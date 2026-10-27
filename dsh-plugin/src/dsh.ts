/**
 * Real dsh / Cordis binding for the AEH plugin.
 *
 * Step 3 used a local structural stand-in for Cordis and dsh-tools. Step 4
 * replaces it with the published `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-tools` packages:
 *
 * - `Context` is Cordis's context class (including `ctx.effect` cleanup);
 * - `defineTool` delegates schema compilation, argument validation, output
 *   validation, registration, and execution to dsh-tools;
 * - only a thin authoring adapter remains, so the Step 3 tool bodies keep their
 *   loose `unknown` argument contract while the runtime enforces the real
 *   schema. It does not implement a second schema compiler.
 *
 * This module intentionally exposes no fake executor. Runtime contract tests
 * execute the registered tools through the real dsh-tools service.
 */

import {
  defineTool as defineDshTool,
  type ParameterSchemaSpec,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type {
  ToolDefinition as DshToolDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type { Context } from '@deepseek-ai/cordis'
export type { ContentBlock } from '@deepseek-ai/dsh-llm'
export type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * Minimal execution fields the authoring adapter forwards. A real
 * `ToolRunContext` is a superset and is always supplied by the runtime.
 */
export interface AehToolExec {
  readonly signal?: AbortSignal
  /**
   * The dsh agent on whose behalf the call runs. dsh sets this on
   * `ToolRunContext`; direct unit-test invocations may omit it, in which case
   * session-scoped features fail closed instead of inventing a scope.
   */
  readonly agent?: {
    readonly id?: string
  }
}

/**
 * Tool definition shape returned to this package. It is structurally a real
 * dsh `ToolDefinition`, but its `execute` parameter is wider so unit tests can
 * call a tool body directly without fabricating execution identity.
 */
export interface ToolDefinition
  extends Omit<DshToolDefinition, 'execute'> {
  execute(args: unknown, exec?: AehToolExec): Promise<unknown>
}

export interface AehToolOptions {
  readonly name: string
  readonly description: string
  /** Author-facing dsh schema; compiled and enforced by dsh-tools. */
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    render(args: unknown, value: unknown): readonly ContentBlock[]
  }
  readonly timeoutMs?: number
  execute(args: unknown, exec: AehToolExec): Promise<unknown>
}

/**
 * Concrete (non-generic) view of the real `defineTool`. Using a fixed
 * signature instead of instantiating `DefineToolOptions<S, O>` keeps the
 * author-facing schemas loose without pushing TypeScript into unbounded schema
 * inference; dsh-tools still compiles and validates them at runtime.
 */
type LooseDefineTool = (options: {
  readonly name: string
  readonly description: string
  readonly parameters: ParameterSchemaSpec
  readonly output: {
    readonly schema: ValueSchemaSpec
    readonly render: (args: unknown, value: JsonValue) => ContentBlock[]
  }
  readonly timeoutMs?: number
  execute(args: unknown, exec: ToolRunContext): Promise<JsonValue>
}) => DshToolDefinition

const defineLooseTool = defineDshTool as unknown as LooseDefineTool

/**
 * Thin authoring adapter over the real dsh-tools `defineTool`.
 *
 * Schema compilation and validation are **not** reimplemented here. The casts
 * exist because the Step 3 tool bodies intentionally accept `unknown` arguments
 * and return domain objects that are JSON at runtime; dsh-tools remains the
 * authority for schema correctness and result validation.
 */
export function defineTool(options: AehToolOptions): ToolDefinition {
  const definition = defineLooseTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters as unknown as ParameterSchemaSpec,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    output: {
      schema: options.output.schema as unknown as ValueSchemaSpec,
      render: (args, value) => [...options.output.render(args, value)],
    },
    async execute(args, exec) {
      return (await options.execute(args, exec)) as JsonValue
    },
  })

  // The real definition's execute accepts the required runtime context; the
  // wider adapter signature is safe for direct unit-test invocation.
  return definition as unknown as ToolDefinition
}

/** Render a JSON value as one text block, the common case for these tools. */
export function renderJson(
  _args: unknown,
  value: unknown,
): readonly ContentBlock[] {
  return [
    {
      type: 'text',
      text:
        typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ]
}

/** Throw cooperatively when the host cancelled this tool call. */
export function throwIfAborted(exec: AehToolExec | undefined): void {
  exec?.signal?.throwIfAborted?.()
}
