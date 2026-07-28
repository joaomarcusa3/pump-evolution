/**
 * tool-tracer — captures the tools an agent invokes (Requirement 5) as GenAI
 * `execute_tool` spans, correlated to the parent model invocation.
 *
 * Two complementary paths:
 *  1. **Auto** — {@link extractToolUses} parses the `toolUse` blocks out of a
 *     Bedrock `Converse` response (or the aggregated names collected from a
 *     `ConverseStream`), and {@link recordToolUseSpans} emits one
 *     `execute_tool` span per distinct call, parented to the invocation span so
 *     the trace tree links tool ↔ invocation. These tools already ran (the model
 *     asked for them / the response reports them), so the spans are point-in-time
 *     records, not wrappers around execution.
 *  2. **Manual** — {@link traceTool} wraps an arbitrary function (framework
 *     agnostic: a LangChain tool, a raw HTTP call, anything) in an
 *     `execute_tool` span whose lifetime is the function's execution, recording
 *     errors and preserving the original return/throw.
 *
 * Invariants (steering):
 *  - Telemetry never breaks the agent: the auto path is fully guarded (a parse
 *    failure yields no spans, never throws). The manual path re-throws the
 *    wrapped function's ORIGINAL error unchanged after recording it.
 *  - No fabricated data: only real tool names read from the response/args are
 *    emitted; nothing is invented when a name is absent.
 *
 * Grounding — Bedrock `Converse` tool-use shape (AWS SDK v3
 * `@aws-sdk/client-bedrock-runtime`): a response carries
 * `output.message.content: ContentBlock[]`, where a tool request is a block
 * `{ toolUse: { toolUseId, name, input } }`. In `ConverseStream`, a tool request
 * opens with a `contentBlockStart` event
 * `{ contentBlockStart: { start: { toolUse: { toolUseId, name } } } }`.
 */

import type { Context, Span, Tracer } from '@opentelemetry/api';
import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, OPERATION_EXECUTE_TOOL } from './constants.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single tool invocation observed in a Bedrock response. */
export interface ObservedToolUse {
  /** The tool name (`gen_ai.tool.name`). Always a non-empty string. */
  readonly name: string;
  /** Provider tool-use correlation id, when present. */
  readonly toolUseId?: string;
}

// ─── Narrowing helpers (parse `unknown`, never fabricate) ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Reads a `{ name, toolUseId }` from a `toolUse` record. */
function readToolUse(toolUse: unknown): ObservedToolUse | undefined {
  if (!isRecord(toolUse)) return undefined;
  const name = readString(toolUse.name);
  if (name === undefined) return undefined;
  const toolUseId = readString(toolUse.toolUseId);
  return toolUseId !== undefined ? { name, toolUseId } : { name };
}

// ─── Auto extraction (pure) ───────────────────────────────────────────────────

/**
 * Extracts every `toolUse` block from a Bedrock `Converse` response. Reads
 * `output.message.content[].toolUse`. Returns one {@link ObservedToolUse} per
 * block in document order (duplicates preserved — the same tool used twice is
 * two calls). Blocks without a valid `name` are skipped. Pure; never throws.
 */
export function extractToolUses(converseOutput: unknown): ObservedToolUse[] {
  if (!isRecord(converseOutput)) return [];
  const output = converseOutput.output;
  if (!isRecord(output)) return [];
  const message = output.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const uses: ObservedToolUse[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const use = readToolUse(block.toolUse);
    if (use !== undefined) uses.push(use);
  }
  return uses;
}

/**
 * Extracts a `toolUse` from a single `ConverseStream` event of the form
 * `{ contentBlockStart: { start: { toolUse: { toolUseId, name } } } }`. Returns
 * `undefined` for any other event. Pure; never throws. The instrumentation
 * accumulates these across the stream.
 */
export function extractToolUseFromStreamEvent(event: unknown): ObservedToolUse | undefined {
  if (!isRecord(event)) return undefined;
  const contentBlockStart = event.contentBlockStart;
  if (!isRecord(contentBlockStart)) return undefined;
  const start = contentBlockStart.start;
  if (!isRecord(start)) return undefined;
  return readToolUse(start.toolUse);
}

// ─── Span emission ─────────────────────────────────────────────────────────────

/** Builds the trace context that parents child spans under `parent`. */
function contextForParent(parent: Span | undefined): Context {
  const active = otelContext.active();
  return parent !== undefined ? trace.setSpan(active, parent) : active;
}

/**
 * Emits one `execute_tool` span per observed tool use, parented (via trace
 * context) to `parent` so the tool spans nest under the invocation span. Each
 * span carries `gen_ai.operation.name=execute_tool` and `gen_ai.tool.name`.
 *
 * These represent tool calls that already happened, so the spans open and close
 * immediately. Fully guarded: a span-emission failure is swallowed (telemetry
 * never breaks the agent). Returns the number of spans emitted (useful for
 * tests / compliance wiring).
 */
export function recordToolUseSpans(
  tracer: Tracer,
  toolUses: readonly ObservedToolUse[],
  parent?: Span,
): number {
  let emitted = 0;
  const ctx = contextForParent(parent);
  for (const use of toolUses) {
    try {
      const span = tracer.startSpan(
        `${OPERATION_EXECUTE_TOOL} ${use.name}`,
        { kind: SpanKind.INTERNAL },
        ctx,
      );
      span.setAttribute(GEN_AI_OPERATION_NAME, OPERATION_EXECUTE_TOOL);
      span.setAttribute(GEN_AI_TOOL_NAME, use.name);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      emitted += 1;
    } catch {
      // Telemetry never breaks the agent flow (Requirement 5 / steering).
    }
  }
  return emitted;
}

// ─── Manual tracing (framework-agnostic) ───────────────────────────────────────

/**
 * Wraps `fn` in an `execute_tool` span (Requirement 5.2) so developers can
 * instrument tools that do not go through Bedrock (a LangChain tool, an HTTP
 * call, a local function). The span nests under the currently-active span (e.g.
 * an invocation span made active with `withUser`/`startActiveSpan`) so it
 * correlates to the parent flow.
 *
 * The span's lifetime is the function's execution. For a function returning a
 * `Promise`, the span ends when the promise settles. Errors are recorded on the
 * span and the ORIGINAL error is re-thrown unchanged — `traceTool` is
 * transparent to both success and failure.
 *
 * If starting the span itself fails, `fn` still runs (telemetry never blocks the
 * agent).
 */
export function traceTool<T>(tracer: Tracer, name: string, fn: () => T): T {
  const toolName = readString(name) ?? 'unknown_tool';
  let span: Span;
  try {
    span = tracer.startSpan(`${OPERATION_EXECUTE_TOOL} ${toolName}`, { kind: SpanKind.INTERNAL });
    span.setAttribute(GEN_AI_OPERATION_NAME, OPERATION_EXECUTE_TOOL);
    span.setAttribute(GEN_AI_TOOL_NAME, toolName);
  } catch {
    // Could not start a span — run the tool untraced rather than break it.
    return fn();
  }

  return runWithSpan(span, fn);
}

/** Runs `fn`, ending `span` on completion; handles sync and async `fn`. */
function runWithSpan<T>(span: Span, fn: () => T): T {
  try {
    const result = fn();
    if (isPromise(result)) {
      // Defer span end until the promise settles; preserve the original result.
      return result.then(
        (value: unknown) => {
          finishSpanOk(span);
          return value;
        },
        (error: unknown) => {
          finishSpanError(span, error);
          throw error; // original error, unchanged
        },
      ) as T;
    }
    finishSpanOk(span);
    return result;
  } catch (error) {
    finishSpanError(span, error);
    throw error; // original error, unchanged
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

function finishSpanOk(span: Span): void {
  try {
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch {
    /* never break the agent */
  }
}

function finishSpanError(span: Span, error: unknown): void {
  try {
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  } catch {
    /* never break the agent */
  }
}
