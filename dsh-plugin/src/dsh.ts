/**
 * Minimal structural adapter for the subset of Cordis / dsh-tools used here.
 *
 * The plugin entry keeps Cordis's function-plugin shape (`name`, `inject`,
 * `apply(ctx)`) and registers tools through `ctx.tools.register(...)`, exactly
 * like a real dsh plugin. This file exists so the skeleton can be tested offline
 * with Node's built-in TypeScript support, without installing the harness
 * packages or copying their source.
 *
 * Production switch:
 *   import type { Context } from '@deepseek-ai/cordis'
 *   import { defineTool } from '@deepseek-ai/dsh-tools'
 *
 * The local `defineTool` compiles the author-facing parameter spec into the
 * JSON-Schema-shaped `parameters` object a dsh tool registry expects, so the
 * adapter is intentionally narrow rather than a second framework.
 */

export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** The subset of dsh's ToolRunContext this skeleton observes. */
export interface ToolRunContext {
  readonly callId?: string
  /** Real dsh passes an AbortSignal; only cooperative cancellation is used. */
  readonly signal?: {
    readonly aborted?: boolean
    throwIfAborted?: () => void
  }
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** Compiled JSON Schema, not the author-facing shorthand. */
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    render(
      args: unknown,
      value: unknown,
    ): readonly ContentBlock[]
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/**
 * Structural subset of a Cordis Context. A real Cordis context satisfies it.
 * `effect` owns registration cleanup on unload/hot-reload.
 */
export interface Context {
  readonly tools: ToolsService
  effect(setup: () => (() => void) | void): void
}

type SchemaRecord = Record<string, unknown>

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Compile one author node, stripping the per-property `required` marker. */
function compileNode(node: SchemaRecord): SchemaRecord {
  const { required: _required, ...rest } = node

  if (rest.type === 'json') {
    // dsh's `type: 'json'` author shorthand projects to an unconstrained node.
    return {}
  }
  if (rest.type === 'object' && isRecord(rest.properties)) {
    return compileObject(rest.properties, rest)
  }
  if (rest.type === 'array' && isRecord(rest.items)) {
    return { ...rest, items: compileNode(rest.items) }
  }
  if (Array.isArray(rest.oneOf)) {
    return {
      ...rest,
      oneOf: rest.oneOf.map((branch) =>
        isRecord(branch) ? compileNode(branch) : branch,
      ),
    }
  }
  return rest
}

function compileObject(
  properties: SchemaRecord,
  rest: SchemaRecord = {},
): SchemaRecord {
  const compiled: SchemaRecord = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue
    const { required: isRequired, ...node } = value
    compiled[key] = compileNode(node)
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    ...rest,
    properties: compiled,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Compile the implicit parameter root used by dsh's `defineTool`. */
export function compileParameters(
  parameters: SchemaRecord,
): SchemaRecord {
  return compileObject(parameters)
}

export interface ToolOptions {
  readonly name: string
  readonly description: string
  readonly parameters: SchemaRecord
  readonly output: {
    readonly schema: SchemaRecord
    render(args: unknown, value: unknown): readonly ContentBlock[]
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/**
 * Local stand-in for `@deepseek-ai/dsh-tools`'s `defineTool`.
 *
 * It validates the authoring shape and compiles schemas; it does not implement
 * dsh's argument validator, policy pipeline, or presentation layer. Those are
 * supplied by the real runtime after the adapter swap.
 */
export function defineTool(options: ToolOptions): ToolDefinition {
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new TypeError('defineTool: name is required')
  }
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new TypeError(`defineTool(${options.name}): description is required`)
  }
  if (typeof options.output?.render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output.render is required`)
  }
  return Object.freeze({
    name: options.name,
    description: options.description,
    parameters: Object.freeze(compileParameters(options.parameters)),
    output: Object.freeze({
      schema: Object.freeze(compileNode(options.output.schema)),
      render: options.output.render,
    }),
    execute: options.execute,
  })
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
export function throwIfAborted(exec: ToolRunContext): void {
  exec.signal?.throwIfAborted?.()
}
