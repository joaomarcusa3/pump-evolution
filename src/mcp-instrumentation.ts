/**
 * mcp-instrumentation — governed telemetry for **MCP (Model Context Protocol)
 * servers**, so the CTA maps MCP servers in the same observability pipeline as
 * agents (the CTA quer mapear MCPs, não só agentes).
 *
 * An MCP server is a tool provider with no model of its own: its observable unit
 * is a **tool call**, not a model invocation. {@link traceMcpTool} wraps a single
 * MCP tool handler (or an MCP client's `callTool`) in a GenAI `execute_tool`
 * span carrying the SAME governance signals agents get:
 *  - identity — inherited from the active `withUser` context (the parent span);
 *  - compliance — the called tool is checked against the manifest `allowedTools`
 *    (a tool outside the allowlist is a `TOOL_NOT_ALLOWED` deviation);
 *  - security — the tool input is scanned LOCALLY for OWASP LLM signals
 *    (prompt-injection / sensitive-info) and only REDACTED findings are emitted.
 *
 * Invariants (steering, mirrored from tool-tracer / *-checker):
 *  - Telemetry NEVER breaks the tool call: if the span can't start, `fn` still
 *    runs; the original return/throw is preserved unchanged.
 *  - No fabricated data; findings never carry the raw offending value.
 *  - Observe, don't enforce: a disallowed tool is flagged, never blocked.
 */

import type { Span, Tracer } from '@opentelemetry/api';
import { SpanKind } from '@opentelemetry/api';

import { applyComplianceToSpan, evaluateCompliance } from './compliance-checker.js';
import { GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, OPERATION_EXECUTE_TOOL } from './constants.js';
import { applyIdentityToSpan } from './identity-context.js';
import { applySecurityToSpan, evaluateSecurity } from './security-checker.js';
import { runWithSpan } from './tool-tracer.js';
import type { DataClassification, McpToolInvocation } from './types.js';

// ─── Dependencies ──────────────────────────────────────────────────────────────

/** Everything the MCP tool tracer needs from the composed SDK. */
export interface McpToolTracerDeps {
  readonly tracer: Tracer;
  /** Manifest allowlist the called tool is checked against (compliance). */
  readonly allowedTools: readonly string[];
  /** Manifest data classification (drives the guardrail-gap compliance check). */
  readonly dataClassification?: DataClassification;
  /** OWASP-LLM runtime scanning of the tool input. `enabled: false` opts out. */
  readonly security: { readonly enabled: boolean };
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function readToolName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length === 0 ? 'unknown_tool' : trimmed;
}

/**
 * Applies compliance + (optional) security signals to the tool span. Fully
 * guarded — the checkers are best-effort and never throw, and this wrapper
 * swallows any residual error so telemetry never breaks the tool call.
 */
function applyGovernance(
  span: Span,
  toolName: string,
  invocation: McpToolInvocation,
  deps: McpToolTracerDeps,
): void {
  try {
    // Identity — same as agent spans: from the active `withUser` context, or the
    // explicit anonymous marker (never a fabricated user).
    applyIdentityToSpan(span);
    applyComplianceToSpan(
      span,
      evaluateCompliance({
        usedTools: [toolName],
        allowedTools: deps.allowedTools,
        ...(deps.dataClassification !== undefined
          ? { dataClassification: deps.dataClassification }
          : {}),
      }),
    );
    if (deps.security.enabled) {
      applySecurityToSpan(
        span,
        evaluateSecurity(invocation.input !== undefined ? { userInput: invocation.input } : {}),
      );
    }
  } catch {
    // Governance is telemetry — never break the MCP tool call.
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Wraps a single MCP tool call in a governed `execute_tool` span. The span nests
 * under the currently-active span (e.g. one made active via `withUser`) so it
 * correlates to the caller's identity. Records compliance + security signals,
 * then runs `fn` with the same span lifetime/error semantics as `traceTool`.
 *
 * If starting the span itself fails, `fn` still runs untraced (telemetry never
 * blocks the tool call).
 */
export function traceMcpTool<T>(
  deps: McpToolTracerDeps,
  invocation: McpToolInvocation,
  fn: () => T,
): T {
  const toolName = readToolName(invocation.name);
  let span: Span;
  try {
    span = deps.tracer.startSpan(`${OPERATION_EXECUTE_TOOL} ${toolName}`, {
      kind: SpanKind.INTERNAL,
    });
    span.setAttribute(GEN_AI_OPERATION_NAME, OPERATION_EXECUTE_TOOL);
    span.setAttribute(GEN_AI_TOOL_NAME, toolName);
  } catch {
    // Could not start a span — run the tool untraced rather than break it.
    return fn();
  }

  applyGovernance(span, toolName, invocation, deps);
  return runWithSpan(span, fn);
}

// ─── Auto-instrumentation of an MCP server ──────────────────────────────────────

/**
 * Max input length (chars) scanned for OWASP-LLM signals. Bounds the work done
 * per tool call and avoids serialising unbounded payloads into the scanner.
 */
const MAX_INPUT_SCAN_LEN = 8192;

/** Structural, framework-agnostic function type (mirrors the SDK boundary style). */
type AnyFn = (...args: unknown[]) => unknown;

/**
 * The MCP method a **low-level** `Server` dispatches every tool call through.
 * Such a server has no per-tool registration method at all — it registers ONE
 * handler for this method and fans out to the individual tools itself.
 */
const CALL_TOOL_METHOD = 'tools/call';

/**
 * Structural subset of the two server shapes `@modelcontextprotocol/sdk` ships:
 *
 *  - `McpServer` (high level) — `registerTool(name, config, handler)`, plus the
 *    older `tool(name, …, handler)`: one handler per tool;
 *  - `Server` (low level) — neither of those; tools are dispatched by a single
 *    `setRequestHandler(CallToolRequestSchema, handler)`.
 *
 * Both are instrumented. Typed structurally so the MCP SDK is NOT a dependency
 * of this package (same boundary approach as `instrumentBedrock`).
 */
interface McpServerLike {
  tool?: AnyFn;
  registerTool?: AnyFn;
  setRequestHandler?: AnyFn;
}

/** Serialises a tool-call input for local scanning; bounded, never throws. */
function serializeToolInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value.length > MAX_INPUT_SCAN_LEN ? value.slice(0, MAX_INPUT_SCAN_LEN) : value;
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return undefined;
    return json.length > MAX_INPUT_SCAN_LEN ? json.slice(0, MAX_INPUT_SCAN_LEN) : json;
  } catch {
    // Non-serialisable input (circular refs, BigInt, …) — skip the scan.
    return undefined;
  }
}

// ─── High-level `McpServer` (one handler per tool) ──────────────────────────────

/**
 * Wraps a tool-registration method (`registerTool` / `tool`) so every handler it
 * registers runs inside a governed `execute_tool` span. The tool name is the
 * first string argument; the handler is the last function argument (matches both
 * the `McpServer.tool` overloads and `registerTool`). The tool input (first arg
 * passed to the handler at call time) is scanned locally (redacted).
 */
function wrapToolRegistration(original: AnyFn, deps: McpToolTracerDeps): AnyFn {
  return (...args: unknown[]): unknown => {
    const name = typeof args[0] === 'string' ? args[0] : 'unknown_tool';
    const lastIndex = args.length - 1;
    const handler = lastIndex >= 0 ? args[lastIndex] : undefined;
    if (typeof handler !== 'function') {
      return original(...args);
    }
    const originalHandler = handler as AnyFn;
    const tracedHandler: AnyFn = (...callArgs: unknown[]): unknown => {
      const input = serializeToolInput(callArgs[0]);
      const invocation: McpToolInvocation = input !== undefined ? { name, input } : { name };
      return traceMcpTool(deps, invocation, () => originalHandler(...callArgs));
    };
    const newArgs = args.slice();
    newArgs[lastIndex] = tracedHandler;
    return original(...newArgs);
  };
}

// ─── Low-level `Server` (single `tools/call` dispatch handler) ──────────────────

/** A `tools/call` request as a low-level `Server` handler receives it. */
interface CallToolRequestLike {
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown; readonly arguments?: unknown };
}

function tryCall(fn: AnyFn): unknown {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Reads the shape of a Zod object schema. The MCP SDK accepts both Zod v3
 * (`.shape`, sometimes a lazy getter) and Zod v4 (`._zod.def.shape`), so both
 * are probed structurally — Zod is not a dependency of this package.
 */
function readObjectShape(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const v4 = (schema as { _zod?: { def?: { shape?: unknown } } })._zod?.def?.shape;
  const raw = v4 ?? (schema as { shape?: unknown }).shape;
  const resolved = typeof raw === 'function' ? tryCall(raw as AnyFn) : raw;
  return typeof resolved === 'object' && resolved !== null
    ? (resolved as Record<string, unknown>)
    : undefined;
}

/** Reads the value of a Zod literal/enum schema (v3 `._def`, v4 `._zod.def`). */
function readLiteralValue(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const defs = [
    (schema as { _zod?: { def?: unknown } })._zod?.def,
    (schema as { _def?: unknown })._def,
  ];
  for (const def of defs) {
    if (typeof def !== 'object' || def === null) continue;
    const { value, values } = def as { value?: unknown; values?: unknown };
    if (value !== undefined) return value;
    if (Array.isArray(values) && values.length > 0) return values[0];
  }
  return undefined;
}

/**
 * Best-effort read of the method a request schema is registered for
 * (`CallToolRequestSchema` → `'tools/call'`). Returns `undefined` when the
 * schema is not introspectable — the caller then decides per request instead of
 * guessing.
 */
function readSchemaMethod(schema: unknown): string | undefined {
  const shape = readObjectShape(schema);
  if (shape === undefined) return undefined;
  const method = readLiteralValue(shape['method']);
  return typeof method === 'string' ? method : undefined;
}

/**
 * Wraps a low-level `tools/call` dispatch handler so each tool it fans out to
 * gets its own governed `execute_tool` span. Name and input come from the
 * request (`params.name` / `params.arguments`) — the only place a low-level
 * server carries them.
 *
 * `knownCallTool` is true when the registration schema was introspected as
 * `tools/call`. When it is false the request itself decides, so a handler
 * registered for some other method is passed straight through untouched.
 */
function wrapCallToolHandler(
  original: AnyFn,
  deps: McpToolTracerDeps,
  knownCallTool: boolean,
): AnyFn {
  return (...callArgs: unknown[]): unknown => {
    const first = callArgs[0];
    const request: CallToolRequestLike =
      typeof first === 'object' && first !== null ? (first as CallToolRequestLike) : {};
    if (!knownCallTool && request.method !== CALL_TOOL_METHOD) {
      return original(...callArgs);
    }
    const rawName = request.params?.name;
    const name = readToolName(typeof rawName === 'string' ? rawName : '');
    const input = serializeToolInput(request.params?.arguments);
    const invocation: McpToolInvocation = input !== undefined ? { name, input } : { name };
    return traceMcpTool(deps, invocation, () => original(...callArgs));
  };
}

/**
 * Wraps `setRequestHandler` so the `tools/call` handler — the single dispatch
 * point of a low-level `Server` — is instrumented. Handlers for every other
 * method are registered unchanged.
 */
function wrapRequestHandlerRegistration(original: AnyFn, deps: McpToolTracerDeps): AnyFn {
  return (...args: unknown[]): unknown => {
    const handler = args[1];
    if (typeof handler !== 'function') return original(...args);
    const method = readSchemaMethod(args[0]);
    if (method !== undefined && method !== CALL_TOOL_METHOD) return original(...args);
    const newArgs = args.slice();
    newArgs[1] = wrapCallToolHandler(handler as AnyFn, deps, method === CALL_TOOL_METHOD);
    return original(...newArgs);
  };
}

/**
 * Instruments a `tools/call` handler that was registered BEFORE this call. A
 * low-level `Server` keeps its handlers in a `_requestHandlers` map; wrapping
 * that entry in place removes the "instrumented too late" footgun, which would
 * otherwise be another silent no-op. Best-effort — any other internal shape is
 * left alone.
 */
function retrofitCallToolHandler(target: object, deps: McpToolTracerDeps): void {
  const handlers = (target as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) return;
  const existing: unknown = handlers.get(CALL_TOOL_METHOD);
  if (typeof existing !== 'function') return;
  handlers.set(CALL_TOOL_METHOD, wrapCallToolHandler(existing as AnyFn, deps, true));
}

// ─── Auto-instrumentation entry point ───────────────────────────────────────────

/**
 * Marks a server as already instrumented so a second call is a no-op instead of
 * emitting two spans per tool call. `Symbol.for` so duplicated copies of this
 * package still recognise each other's mark.
 */
const INSTRUMENTED = Symbol.for('pump-evolution.mcp.instrumented');

function isInstrumented(target: object): boolean {
  return (target as Record<symbol, unknown>)[INSTRUMENTED] === true;
}

function markInstrumented(target: object): void {
  try {
    Object.defineProperty(target, INSTRUMENTED, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Sealed server — the instrumentation itself already succeeded.
  }
}

/** Wraps the per-tool registration methods of a high-level `McpServer`. */
function instrumentToolRegistration(
  target: McpServerLike,
  server: unknown,
  deps: McpToolTracerDeps,
): boolean {
  let wrapped = false;
  for (const method of ['registerTool', 'tool'] as const) {
    const original = target[method];
    if (typeof original === 'function') {
      target[method] = wrapToolRegistration(original.bind(server) as AnyFn, deps);
      wrapped = true;
    }
  }
  return wrapped;
}

/** Wraps the `tools/call` dispatch of a low-level `Server`. */
function instrumentRequestDispatch(
  target: McpServerLike,
  server: unknown,
  deps: McpToolTracerDeps,
): boolean {
  const original = target.setRequestHandler;
  if (typeof original !== 'function') return false;
  target.setRequestHandler = wrapRequestHandlerRegistration(original.bind(server) as AnyFn, deps);
  retrofitCallToolHandler(target as object, deps);
  return true;
}

/**
 * Auto-instruments an MCP server (`@modelcontextprotocol/sdk`) so EVERY tool
 * call it serves is transparently governed — no per-handler `traceMcpTool`
 * wrapping. The server's methods are replaced in place; the same server instance
 * is returned.
 *
 * Both server classes are covered:
 *  - `McpServer` (high level) — `registerTool` / `tool` are wrapped, so each
 *    registered handler gets its own span;
 *  - `Server` (low level) — `setRequestHandler` is wrapped, and the handler
 *    registered for `tools/call` produces one span per dispatched tool. A
 *    `tools/call` handler registered before this call is retrofitted too.
 *
 * ORDERING: call this right after constructing the server. For `McpServer` only
 * tools registered AFTER instrumentation are wrapped, so call it BEFORE
 * registering tools (same spirit as initialising instrumentation at boot).
 *
 * FAIL LOUD (zero fallbacks): a server exposing none of those methods would
 * produce no span at all, ever, while the process still logs a healthy telemetry
 * boot. Rather than degrade in silence, this THROWS — wrap the handlers with
 * `traceMcpTool` explicitly if the server has a custom shape. A disabled SDK
 * never reaches here: its no-op handle returns the server untouched.
 *
 * Typed structurally (`S`) to avoid a hard dependency on the MCP SDK types at
 * this boundary.
 */
export function instrumentMcpServer<S>(deps: McpToolTracerDeps, server: S): S {
  if (typeof server !== 'object' || server === null) {
    throw new Error(
      '[pump-evolution] instrumentMcpServer expects an MCP server instance, got ' +
        `${typeof server}. No default is applied.`,
    );
  }
  const target = server as McpServerLike;
  if (isInstrumented(target)) return server;

  const instrumented =
    instrumentToolRegistration(target, server, deps) ||
    instrumentRequestDispatch(target, server, deps);

  if (!instrumented) {
    throw new Error(
      '[pump-evolution] instrumentMcpServer found no tool surface on this server: it exposes ' +
        'neither `registerTool`/`tool` (McpServer, high level) nor `setRequestHandler` ' +
        '(Server, low level). No tool span would ever be emitted, so this fails loudly ' +
        'instead of silently. Wrap each handler with `traceMcpTool({ name, input }, fn)` if ' +
        'the server has a custom shape.',
    );
  }

  markInstrumented(target);
  return server;
}
