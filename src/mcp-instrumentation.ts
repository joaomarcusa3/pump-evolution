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
 * Structural subset of `@modelcontextprotocol/sdk`'s server. Both the newer
 * `registerTool(name, config, handler)` and the older `tool(name, …, handler)`
 * are supported; whichever exists is wrapped. Typed structurally so the SDK is
 * NOT a dependency of this package (same boundary approach as `instrumentBedrock`).
 */
interface McpServerLike {
  tool?: AnyFn;
  registerTool?: AnyFn;
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

/**
 * Auto-instruments an MCP server (`@modelcontextprotocol/sdk`) so EVERY tool it
 * registers is transparently governed — no per-handler `traceMcpTool` wrapping.
 * The server's tool-registration method(s) are replaced in place; the same
 * server instance is returned.
 *
 * ORDERING: call this right after constructing the server and BEFORE registering
 * tools — only tools registered AFTER instrumentation are wrapped (same spirit as
 * initialising instrumentation at boot). When the SDK is disabled the handle
 * returns the server untouched.
 *
 * Typed structurally (`S`) to avoid a hard dependency on the MCP SDK types at
 * this boundary — the implementation only needs a `registerTool`/`tool` method.
 */
export function instrumentMcpServer<S>(deps: McpToolTracerDeps, server: S): S {
  const target = server as McpServerLike;
  for (const method of ['registerTool', 'tool'] as const) {
    const original = target[method];
    if (typeof original === 'function') {
      target[method] = wrapToolRegistration(original.bind(server) as AnyFn, deps);
    }
  }
  return server;
}
