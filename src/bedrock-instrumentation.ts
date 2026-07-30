/**
 * bedrock-instrumentation — transparently instruments an AWS SDK v3
 * `BedrockRuntimeClient` so every model invocation emits a GenAI-semconv span
 * (Requirement 3), without the agent developer changing any call site.
 *
 * ── Wrapping approach: `send`-method patching (NOT middleware) ────────────────
 * The AWS SDK v3 offers two interception points: the per-command middleware
 * stack (`client.middleware.add`) and the `client.send` method. This module
 * patches `send` in place. Rationale:
 *   1. **Operation naming is reliable.** `command.constructor.name` names the
 *      operation directly (`ConverseCommand`, `ConverseStreamCommand`, …). The
 *      middleware `context.commandName` also carries this, but middleware runs
 *      inside the serialization pipeline where distinguishing the *typed*
 *      command output (Converse `usage`, stream vs non-stream) is more awkward.
 *   2. **Streaming without consuming the agent's stream.** At the `send`
 *      boundary we receive the fully-deserialized output object and can replace
 *      its async-iterable field (`stream` for Converse, `body` for InvokeModel)
 *      with a pass-through wrapper. The agent still iterates every event; we only
 *      observe. Doing the same inside a `deserialize` middleware means teeing a
 *      lower-level event stream, which is more error-prone.
 *   3. **Telemetry can never break the agent.** All bookkeeping is guarded; a
 *      genuine Bedrock error propagates unchanged, while a bug in our own
 *      telemetry is swallowed (reported via the optional `onError` hook) and the
 *      original call still returns.
 * Idempotency is guarded with a symbol flag on the client, so instrumenting the
 * same client twice is a no-op (no double spans).
 *
 * ── Limitations (documented, not hidden) ──────────────────────────────────────
 *  - Operation detection relies on `constructor.name`; a build that renames
 *    AWS SDK command classes (aggressive minification of `node_modules`) would
 *    defeat it. This does not happen in normal Node deployments.
 *  - For streaming responses the span ends when the agent finishes consuming the
 *    stream. If the agent abandons the stream early (`for await … break`), the
 *    generator's `return()` triggers the observer's `finally`, which finalizes
 *    and ends the span exactly once (observed-so-far usage). A stream that is
 *    never iterated at all (the output is discarded without a `for await`) will
 *    not have its span ended — this is inherent to non-intrusive stream
 *    observation (there is no consumption signal to hook).
 */

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { Span, Tracer } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { applyComplianceToSpan, evaluateCompliance } from './compliance-checker.js';
import {
  CTA_USAGE_TOKENS_AVAILABLE,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  OPERATION_CHAT,
  OPERATION_TEXT_COMPLETION,
  PROVIDER_AWS_BEDROCK,
} from './constants.js';
import { applyIdentityToSpan } from './identity-context.js';
import { applySecurityToSpan, evaluateSecurity } from './security-checker.js';
import {
  extractToolUseFromStreamEvent,
  extractToolUses,
  recordToolUseSpans,
  type ObservedToolUse,
} from './tool-tracer.js';
import type { DataClassification } from './types.js';

// ─── Public API ────────────────────────────────────────────────────────────────

/** Dependencies the instrumentation needs — the tracer it emits spans on. */
export interface BedrockInstrumentationDeps {
  /** Tracer to create invocation spans on (built from the manifest resource). */
  readonly tracer: Tracer;
  /**
   * Optional compliance configuration (from the manifest). When present, each
   * chat invocation's tools are checked against the allowlist and the result is
   * written to the invocation span (Requirement 6). Absent → no compliance
   * evaluation (tools are still traced).
   */
  readonly compliance?: ComplianceConfig;
  /**
   * Optional OWASP LLM runtime security scanning (Fatia 1b). When present (and
   * not `enabled: false`), each chat/text invocation's input and output TEXT is
   * scanned LOCALLY for OWASP LLM signals (prompt injection, secret/PII
   * disclosure, unbounded consumption) and only REDACTED findings are written to
   * the span (`cta.security.*`). Absent → no content is read (privacy-conservative
   * default). The raw prompt/output is NEVER emitted as telemetry.
   */
  readonly security?: SecurityConfig;
  /**
   * Optional diagnostics hook invoked when the SDK's OWN telemetry bookkeeping
   * fails (never for a genuine Bedrock error, which always propagates). Defaults
   * to a no-op so a telemetry bug stays silent and never disturbs the agent.
   * The SDK deliberately does not log to the console (steering: no console noise,
   * telemetry never breaks the agent).
   */
  readonly onError?: (error: unknown) => void;
}

/** Manifest-derived inputs used to evaluate compliance on each invocation. */
export interface ComplianceConfig {
  readonly allowedTools: readonly string[];
  readonly dataClassification?: DataClassification;
  /** Explicit opt-in evidence that a guardrail/isolation is in place. */
  readonly guardrailEvidence?: boolean;
}

/** Configuration for OWASP LLM runtime security scanning (Fatia 1b). */
export interface SecurityConfig {
  /** Master switch for content scanning. Default (when config present): on. */
  readonly enabled?: boolean;
  /** Optional per-invocation token ceiling for the LLM10 check. */
  readonly maxTotalTokens?: number;
}

/** Symbol flag marking a client as already instrumented (idempotency guard). */
const INSTRUMENTED = Symbol.for('@topaz-ia/pump-evolution.bedrock.instrumented');

/**
 * Instruments a `BedrockRuntimeClient` in place and returns the same instance.
 *
 * The client's own `BedrockRuntimeClient` should be created and configured by
 * the agent developer (region, credentials, retries). This SDK never constructs
 * or bundles an AWS SDK client of its own — it only wraps the one the agent
 * brings. Calling this twice on the same client is a no-op.
 */
export function instrumentBedrockClient(
  client: BedrockRuntimeClient,
  deps: BedrockInstrumentationDeps,
): BedrockRuntimeClient {
  if (Reflect.get(client, INSTRUMENTED) === true) return client;

  const onError = deps.onError ?? (() => {});

  // Smithy's `Client.send` is heavily overloaded (promise + two callback forms);
  // `bind` collapses those overloads and the reconstructed signature is not
  // expressible from our narrower wrapper. We only rely on the promise-returning
  // form, viewed structurally. This is an irreducible boundary cast.
  const originalSend = client.send.bind(client) as unknown as OriginalSend;

  const wrapped: OriginalSend = (command, options) =>
    sendInstrumented({
      originalSend,
      command,
      options,
      tracer: deps.tracer,
      compliance: deps.compliance,
      security: deps.security,
      onError,
    });

  // Reflect.set accepts an `unknown` value, so no cast is needed to reassign the
  // method; callers keep seeing the client's public (overloaded) `send` type.
  Reflect.set(client, 'send', wrapped);
  Reflect.set(client, INSTRUMENTED, true);

  return client;
}

// ─── Internal types ─────────────────────────────────────────────────────────────

/** Structural view of the single `send` overload the instrumentation uses. */
type OriginalSend = (command: object, options?: unknown) => Promise<unknown>;

/** Classified target operation. */
interface TargetOperation {
  /** `gen_ai.operation.name` value. */
  readonly operation: typeof OPERATION_CHAT | typeof OPERATION_TEXT_COMPLETION;
  /** Whether the response is streamed. */
  readonly streaming: boolean;
  /** The async-iterable field on the output for streaming responses. */
  readonly streamField: 'stream' | 'body';
}

interface SendInstrumentedParams {
  readonly originalSend: OriginalSend;
  readonly command: object;
  readonly options: unknown;
  readonly tracer: Tracer;
  readonly compliance: ComplianceConfig | undefined;
  readonly security: SecurityConfig | undefined;
  readonly onError: (error: unknown) => void;
}

/** Token usage read from a response. */
interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// ─── Command classification ─────────────────────────────────────────────────────

/**
 * Classifies a command instance by its constructor name. Returns `undefined`
 * for any command that is not one of the four instrumented Bedrock operations,
 * so those pass straight through with no span.
 */
function classifyCommand(command: object): TargetOperation | undefined {
  switch (command.constructor.name) {
    case 'ConverseCommand':
      return { operation: OPERATION_CHAT, streaming: false, streamField: 'stream' };
    case 'ConverseStreamCommand':
      return { operation: OPERATION_CHAT, streaming: true, streamField: 'stream' };
    case 'InvokeModelCommand':
      return { operation: OPERATION_TEXT_COMPLETION, streaming: false, streamField: 'body' };
    case 'InvokeModelWithResponseStreamCommand':
      return { operation: OPERATION_TEXT_COMPLETION, streaming: true, streamField: 'body' };
    default:
      return undefined;
  }
}

// ─── Narrowing helpers (parse `unknown`, never fabricate) ─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads `command.input.modelId` defensively. */
function readModelId(command: object): string | undefined {
  const input = (command as { input?: unknown }).input;
  if (!isRecord(input)) return undefined;
  return readString(input.modelId);
}

/**
 * Reads a `{ inputTokens, outputTokens }` usage block from a value shaped like
 * `{ usage: { inputTokens, outputTokens } }` (the Converse response shape, and
 * the ConverseStream terminal `metadata` event). Returns `undefined` unless
 * BOTH counts are finite numbers — a partial/absent usage is treated as absent,
 * never fabricated (Requirement 3.3).
 */
function readUsage(source: unknown): TokenUsage | undefined {
  if (!isRecord(source)) return undefined;
  const usage = source.usage;
  if (!isRecord(usage)) return undefined;
  const inputTokens = readFiniteNumber(usage.inputTokens);
  const outputTokens = readFiniteNumber(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

/** Reads a `stopReason` from a value shaped like `{ stopReason }`. */
function readStopReason(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  return readString(source.stopReason);
}

/**
 * Decodes an `InvokeModel` response `body` (a `Uint8Array` of model-native JSON,
 * or a string) into a record. Reading a `Uint8Array` is NON-destructive — unlike
 * a stream, the buffer stays intact, so the agent still receives the untouched
 * `output.body`. Returns `undefined` for any non-JSON / non-object body. Never
 * throws.
 */
function decodeBodyJson(body: unknown): Record<string, unknown> | undefined {
  let text: string | undefined;
  if (body instanceof Uint8Array) {
    try {
      text = new TextDecoder().decode(body);
    } catch {
      return undefined;
    }
  } else if (typeof body === 'string') {
    text = body;
  }
  if (text === undefined || text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads token usage from an `InvokeModel` response body. Unlike Converse, the
 * `InvokeModel` output has no top-level `usage`; the counts live in the
 * model-native body. Understands the two common Bedrock shapes:
 *   - Anthropic:  `{ usage: { input_tokens, output_tokens } }`
 *   - camelCase:  `{ usage: { inputTokens, outputTokens } }`
 * These are REAL values read from the response, not estimates. Returns
 * `undefined` unless BOTH counts are finite numbers (partial usage is treated as
 * absent, never fabricated — Requirement 3.3).
 */
function readUsageFromBody(output: unknown): TokenUsage | undefined {
  if (!isRecord(output)) return undefined;
  const body = decodeBodyJson(output.body);
  if (body === undefined || !isRecord(body.usage)) return undefined;
  const usage = body.usage;
  const inputTokens = readFiniteNumber(usage.inputTokens) ?? readFiniteNumber(usage.input_tokens);
  const outputTokens =
    readFiniteNumber(usage.outputTokens) ?? readFiniteNumber(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

/** Reads a stopReason from an `InvokeModel` model-native body (`stop_reason`/`stopReason`). */
function readStopReasonFromBody(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  const body = decodeBodyJson(output.body);
  if (body === undefined) return undefined;
  return readString(body.stopReason) ?? readString(body.stop_reason);
}

/** Reads the async-iterable stream field off an output object, if present. */
function readStream(output: unknown, field: 'stream' | 'body'): AsyncIterable<unknown> | undefined {
  if (!isRecord(output)) return undefined;
  const candidate = output[field];
  if (candidate !== null && typeof candidate === 'object' && Symbol.asyncIterator in candidate) {
    return candidate as AsyncIterable<unknown>;
  }
  return undefined;
}

// ─── Span attribute application ───────────────────────────────────────────────

/**
 * Writes usage to the span. When usage is known, sets both `gen_ai.usage.*`
 * attributes and marks tokens available. When usage is absent, marks tokens
 * UNavailable and OMITS the `gen_ai.usage.*` attributes — never a fabricated `0`
 * (Requirement 3.3).
 */
function applyUsage(span: Span, usage: TokenUsage | undefined): void {
  if (usage === undefined) {
    span.setAttribute(CTA_USAGE_TOKENS_AVAILABLE, false);
    return;
  }
  span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
  span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
  span.setAttribute(CTA_USAGE_TOKENS_AVAILABLE, true);
}

function applyFinishReason(span: Span, stopReason: string | undefined): void {
  if (stopReason !== undefined) {
    span.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, [stopReason]);
  }
}

/** Starts the invocation span with provider/operation/model + identity. */
function startInvocationSpan(tracer: Tracer, op: TargetOperation, command: object): Span {
  const modelId = readModelId(command);
  const name = modelId !== undefined ? `${op.operation} ${modelId}` : op.operation;
  const span = tracer.startSpan(name, { kind: SpanKind.CLIENT });
  span.setAttribute(GEN_AI_PROVIDER_NAME, PROVIDER_AWS_BEDROCK);
  span.setAttribute(GEN_AI_OPERATION_NAME, op.operation);
  if (modelId !== undefined) span.setAttribute(GEN_AI_REQUEST_MODEL, modelId);
  // Attribute the invocation to the current withUser identity (or explicit anon).
  applyIdentityToSpan(span);
  return span;
}

// ─── Core send interception ─────────────────────────────────────────────────────

/**
 * The instrumented `send`. Distinguishes three concerns:
 *  - A non-target command → pass through, no span.
 *  - Telemetry setup failure → pass through, no span (agent unaffected).
 *  - A genuine Bedrock error → recorded on the span, then re-thrown UNCHANGED.
 */
async function sendInstrumented(p: SendInstrumentedParams): Promise<unknown> {
  // Callback-style invocation (`send(command, cb)`) — bypass instrumentation and
  // preserve the exact original behaviour.
  if (typeof p.options === 'function') return p.originalSend(p.command, p.options);

  const op = classifyCommand(p.command);
  if (op === undefined) return p.originalSend(p.command, p.options);

  const span = trySetupSpan(p.tracer, op, p.command, p.onError);
  if (span === undefined) return p.originalSend(p.command, p.options);

  try {
    const output = await p.originalSend(p.command, p.options);
    return op.streaming
      ? handleStreamingOutput(
          p.tracer,
          output,
          op,
          span,
          p.compliance,
          p.security,
          p.command,
          p.onError,
        )
      : finalizeNonStreaming(
          p.tracer,
          output,
          op,
          span,
          p.compliance,
          p.security,
          p.command,
          p.onError,
        );
  } catch (error) {
    recordError(span, error, p.onError);
    endSpanSafely(span, p.onError);
    throw error; // original Bedrock error, unchanged instance (Requirement 3.4)
  }
}

/** Builds the invocation span, returning `undefined` if telemetry setup throws. */
function trySetupSpan(
  tracer: Tracer,
  op: TargetOperation,
  command: object,
  onError: (error: unknown) => void,
): Span | undefined {
  try {
    return startInvocationSpan(tracer, op, command);
  } catch (error) {
    onError(error);
    return undefined;
  }
}

/** Finalizes a non-streaming success: usage + finish reason + tools + OK status. */
function finalizeNonStreaming(
  tracer: Tracer,
  output: unknown,
  op: TargetOperation,
  span: Span,
  compliance: ComplianceConfig | undefined,
  security: SecurityConfig | undefined,
  command: object,
  onError: (error: unknown) => void,
): unknown {
  try {
    // Converse exposes usage/stopReason at the top level; InvokeModel carries
    // them inside the model-native body. Try both — top-level first (Converse),
    // then the decoded body (InvokeModel). Absent in both → recorded as absent.
    const usage = readUsage(output) ?? readUsageFromBody(output);
    applyUsage(span, usage);
    applyFinishReason(span, readStopReason(output) ?? readStopReasonFromBody(output));
    // Auto tool capture (Requirement 5.1) — only the normalized Converse shape
    // carries `output.message.content[].toolUse`; InvokeModel is model-native.
    if (op.operation === OPERATION_CHAT) {
      const uses = extractToolUses(output);
      recordToolUseSpans(tracer, uses, span);
      applyComplianceForTools(span, uses, compliance);
    }
    // OWASP LLM runtime scan (Fatia 1b) — reads input/output text LOCALLY,
    // emits only redacted findings.
    applySecurityScan(span, security, {
      userInput: extractInputText(command, op),
      modelOutput: extractOutputTextNonStreaming(output, op),
      usage,
    });
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    onError(error);
  }
  endSpanSafely(span, onError);
  return output;
}

/**
 * Replaces the output's async-iterable stream with an observing pass-through so
 * the agent still receives every event while the span captures the terminal
 * usage/stopReason and ends when the stream completes. If telemetry wrapping
 * fails, returns the untouched output (agent unaffected).
 */
function handleStreamingOutput(
  tracer: Tracer,
  output: unknown,
  op: TargetOperation,
  span: Span,
  compliance: ComplianceConfig | undefined,
  security: SecurityConfig | undefined,
  command: object,
  onError: (error: unknown) => void,
): unknown {
  try {
    const source = readStream(output, op.streamField);
    if (source === undefined || !isRecord(output)) {
      // No observable stream → tokens absent, end the span now.
      applyUsage(span, undefined);
      span.setStatus({ code: SpanStatusCode.OK });
      endSpanSafely(span, onError);
      return output;
    }
    output[op.streamField] = observeStream(
      tracer,
      source,
      op,
      span,
      compliance,
      security,
      command,
      onError,
    );
    return output;
  } catch (error) {
    onError(error);
    endSpanSafely(span, onError);
    return output;
  }
}

/**
 * Async-generator pass-through: yields every event to the agent unchanged while
 * observing terminal usage/stopReason. Ends the span on completion or error.
 * A genuine stream error is re-thrown UNCHANGED after being recorded.
 */
async function* observeStream(
  tracer: Tracer,
  source: AsyncIterable<unknown>,
  op: TargetOperation,
  span: Span,
  compliance: ComplianceConfig | undefined,
  security: SecurityConfig | undefined,
  command: object,
  onError: (error: unknown) => void,
): AsyncGenerator<unknown> {
  let usage: TokenUsage | undefined;
  let stopReason: string | undefined;
  const toolUses: ObservedToolUse[] = [];
  const outputParts: string[] = [];
  let outputChars = 0;

  // Finalization guards: `end()` runs EXACTLY ONCE, even if the consumer
  // abandons the stream early (`for await … break` → the generator's `return()`
  // triggers the `finally` below). Without this, an early break would leak the
  // span (it would never be ended). `finalizeOk` applies the observed-so-far
  // usage/tools + OK status once; the error path marks it done first so a
  // genuine stream error is not overwritten with OK.
  let finalized = false;
  let ended = false;
  const finalizeOk = (): void => {
    if (finalized) return;
    finalized = true;
    try {
      applyUsage(span, usage);
      applyFinishReason(span, stopReason);
      if (op.operation === OPERATION_CHAT) {
        if (toolUses.length > 0) recordToolUseSpans(tracer, toolUses, span);
        applyComplianceForTools(span, toolUses, compliance);
      }
      // OWASP LLM runtime scan (Fatia 1b) over the accumulated output text.
      applySecurityScan(span, security, {
        userInput: extractInputText(command, op),
        modelOutput: outputParts.length > 0 ? outputParts.join('') : undefined,
        usage,
      });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      onError(error);
    }
  };
  const endOnce = (): void => {
    if (ended) return;
    ended = true;
    endSpanSafely(span, onError);
  };

  try {
    for await (const event of source) {
      try {
        usage = readUsageFromEvent(event) ?? usage;
        stopReason = readStopReasonFromEvent(event) ?? stopReason;
        // Auto tool capture for streaming Converse (Requirement 5.1): tool
        // requests arrive as `contentBlockStart` events.
        if (op.operation === OPERATION_CHAT) {
          const use = extractToolUseFromStreamEvent(event);
          if (use !== undefined) toolUses.push(use);
          // Accumulate output text (bounded) for the security scan only.
          if (security !== undefined && outputChars < MAX_SCAN_CHARS) {
            const delta = readStreamDeltaText(event);
            if (delta !== undefined) {
              outputParts.push(delta);
              outputChars += delta.length;
            }
          }
        }
      } catch (error) {
        onError(error);
      }
      yield event;
    }
    finalizeOk();
  } catch (error) {
    // Genuine stream error: mark finalized so the `finally` does not overwrite
    // the ERROR status with OK, record it, and re-throw the ORIGINAL error.
    finalized = true;
    recordError(span, error, onError);
    throw error; // original stream error, unchanged
  } finally {
    // Runs on normal completion, error, AND early consumer break (generator
    // return()): guarantees the span is finalized and ended exactly once.
    finalizeOk();
    endOnce();
  }
}

/**
 * Evaluates compliance for the observed tools against the manifest allowlist and
 * writes the result to the invocation span (Requirement 6). No-op when no
 * compliance config is present (tools are still traced independently).
 */
function applyComplianceForTools(
  span: Span,
  uses: readonly ObservedToolUse[],
  compliance: ComplianceConfig | undefined,
): void {
  if (compliance === undefined) return;
  const summary = evaluateCompliance({
    usedTools: uses.map((u) => u.name),
    allowedTools: compliance.allowedTools,
    ...(compliance.dataClassification !== undefined
      ? { dataClassification: compliance.dataClassification }
      : {}),
    ...(compliance.guardrailEvidence !== undefined
      ? { guardrailEvidence: compliance.guardrailEvidence }
      : {}),
  });
  applyComplianceToSpan(span, summary);
}

// ─── Security scan (OWASP LLM runtime, Fatia 1b) ──────────────────────────────

/**
 * Upper bound on how much input/output text is scanned per invocation. Detection
 * is bounded, linear regex work; capping protects against pathological sizes
 * while covering the overwhelming majority of real prompts/responses.
 */
const MAX_SCAN_CHARS = 100_000;

function capText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_SCAN_CHARS ? value.slice(0, MAX_SCAN_CHARS) : value;
}

/** Joins the `text` blocks of a Converse `content[]` array. */
function joinConverseText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block)) {
      const text = readString(block.text);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Joins the text of all Converse `input.messages[].content[]` blocks. */
function extractConverseMessagesText(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.messages)) return undefined;
  const parts: string[] = [];
  for (const message of input.messages) {
    if (isRecord(message)) {
      const text = joinConverseText(message.content);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Extracts the invocation INPUT text to scan. Converse → the joined message
 * text; InvokeModel → the decoded model-native body serialized to JSON (so
 * secret patterns still match inside a model-native prompt). Bounded. Local
 * only — never emitted.
 */
function extractInputText(command: object, op: TargetOperation): string | undefined {
  const input = (command as { input?: unknown }).input;
  if (!isRecord(input)) return undefined;
  if (op.operation === OPERATION_CHAT) return capText(extractConverseMessagesText(input));
  const body = decodeBodyJson(input.body);
  return body !== undefined ? capText(JSON.stringify(body)) : undefined;
}

/**
 * Extracts the invocation OUTPUT text (non-streaming). Converse → the response
 * message text; InvokeModel → the decoded body serialized to JSON. Bounded.
 */
function extractOutputTextNonStreaming(output: unknown, op: TargetOperation): string | undefined {
  if (!isRecord(output)) return undefined;
  if (op.operation === OPERATION_CHAT) {
    // Converse nests the reply under `output.output.message.content[]` (same
    // level `extractToolUses` reads from) — NOT `output.message`.
    const inner = output.output;
    if (!isRecord(inner)) return undefined;
    const message = inner.message;
    return isRecord(message) ? capText(joinConverseText(message.content)) : undefined;
  }
  const body = decodeBodyJson(output.body);
  return body !== undefined ? capText(JSON.stringify(body)) : undefined;
}

/** Reads incremental output text from a ConverseStream `contentBlockDelta` event. */
function readStreamDeltaText(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const contentBlockDelta = event.contentBlockDelta;
  if (!isRecord(contentBlockDelta)) return undefined;
  const delta = contentBlockDelta.delta;
  if (!isRecord(delta)) return undefined;
  return readString(delta.text);
}

/**
 * Runs the OWASP LLM runtime scan and writes REDACTED findings to the span. No-op
 * when security is not configured or explicitly disabled. `evaluateSecurity` and
 * `applySecurityToSpan` are internally guarded — this never throws.
 */
function applySecurityScan(
  span: Span,
  security: SecurityConfig | undefined,
  args: { userInput?: string; modelOutput?: string; usage?: TokenUsage },
): void {
  if (security === undefined || security.enabled === false) return;
  const summary = evaluateSecurity({
    ...(args.userInput !== undefined ? { userInput: args.userInput } : {}),
    ...(args.modelOutput !== undefined ? { modelOutput: args.modelOutput } : {}),
    ...(args.usage !== undefined ? { usage: args.usage } : {}),
    ...(security.maxTotalTokens !== undefined ? { maxTotalTokens: security.maxTotalTokens } : {}),
  });
  applySecurityToSpan(span, summary);
}

/** Extracts usage from a ConverseStream `metadata` event (or a bare usage event). */
function readUsageFromEvent(event: unknown): TokenUsage | undefined {
  if (!isRecord(event)) return undefined;
  // Converse stream: `{ metadata: { usage: {...} } }`.
  const fromMetadata = readUsage(event.metadata);
  if (fromMetadata !== undefined) return fromMetadata;
  // Tolerate a flatter `{ usage: {...} }` event shape too.
  return readUsage(event);
}

/** Extracts a stopReason from a ConverseStream `messageStop` event. */
function readStopReasonFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const fromMessageStop = readStopReason(event.messageStop);
  if (fromMessageStop !== undefined) return fromMessageStop;
  return readStopReason(event);
}

// ─── Error / lifecycle helpers ────────────────────────────────────────────────

function recordError(span: Span, error: unknown, onError: (error: unknown) => void): void {
  try {
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
  } catch (bookkeepingError) {
    onError(bookkeepingError);
  }
}

function endSpanSafely(span: Span, onError: (error: unknown) => void): void {
  try {
    span.end();
  } catch (error) {
    onError(error);
  }
}
