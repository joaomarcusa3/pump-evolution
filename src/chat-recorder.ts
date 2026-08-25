/**
 * `recordChat` — records a model call the SDK does not instrument on its own.
 *
 * `instrumentBedrock()` covers Bedrock. For any other provider — OpenAI,
 * Anthropic direct, SAI, LangChain — the integrator had to build the span by
 * hand: open a tracer, set five attributes, propagate identity, close the
 * status. That is ~30 lines copied from a guide, and forgetting ONE attribute
 * makes the CTA receiver answer `202` with `accepted: 0` — request accepted,
 * span silently discarded. Everything looks fine and nothing arrives.
 *
 * This function exists so that path is a single call:
 *
 * ```ts
 * import { recordChat } from '@topaz-ia/pump-evolution';
 *
 * const answer = await llm.invoke(messages);
 * recordChat({
 *   model: 'gpt-4o',
 *   inputTokens: answer.usage?.input_tokens,
 *   outputTokens: answer.usage?.output_tokens,
 *   provider: 'openai',
 * });
 * ```
 *
 * What it guarantees, so the integrator does not have to remember:
 *
 * - `gen_ai.operation.name = "chat"` — without it the CTA discards the span
 * - a span name the receiver recognises
 * - the current user's identity propagated (enduser.id, department, cost center)
 * - token usage flagged as available, for cost attribution
 * - status OK, or ERROR when the model call failed
 *
 * Never throws: telemetry does not take the agent down. Any failure here
 * returns `false` and the caller carries on.
 *
 * Mirrors `record_chat` in the Python package (1:1 parity).
 */
import { SpanKind, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  CTA_USAGE_TOKENS_AVAILABLE,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from './constants.js';
import { applyIdentityToSpan } from './identity-context.js';

/** The single operation name the CTA receiver accepts for model calls. */
export const CHAT_OPERATION = 'chat' as const;

export interface RecordChatInput {
  /**
   * Model actually used in this call. Goes to `gen_ai.request.model` and is
   * what shows up per invocation in the portal — unlike the manifest's
   * `modelId`, which is a static declaration.
   */
  readonly model: string;
  /** Input tokens, when the provider's response reports them. */
  readonly inputTokens?: number | undefined;
  /** Output tokens, likewise. */
  readonly outputTokens?: number | undefined;
  /** Provider name (`openai`, `anthropic`, ...). Optional. */
  readonly provider?: string | undefined;
  /**
   * If the model call failed, pass the error — the span is emitted with ERROR
   * status instead of disappearing. A recorded failure beats silence.
   */
  readonly error?: unknown;
  /** Alternate tracer. Defaults to the global one configured by `init()`. */
  readonly tracer?: Tracer | undefined;
}

/**
 * Emits a chat span in the shape the CTA receiver accepts.
 *
 * @returns `true` if the span was emitted, `false` if anything prevented it.
 *          Never throws.
 */
export function recordChat(input: RecordChatInput): boolean {
  try {
    const tracer = input.tracer ?? trace.getTracer('pump-evolution');
    const name = input.model ? `${CHAT_OPERATION} ${input.model}` : CHAT_OPERATION;
    const span = tracer.startSpan(name, { kind: SpanKind.CLIENT });
    try {
      // This attribute is the difference between the span being counted and
      // being dropped with accepted: 0. It is not optional.
      span.setAttribute(GEN_AI_OPERATION_NAME, CHAT_OPERATION);
      if (input.model) span.setAttribute(GEN_AI_REQUEST_MODEL, String(input.model));
      if (input.provider) span.setAttribute(GEN_AI_PROVIDER_NAME, String(input.provider));

      const inTokens = Number.isFinite(input.inputTokens) ? Number(input.inputTokens) : 0;
      const outTokens = Number.isFinite(input.outputTokens) ? Number(input.outputTokens) : 0;
      if (inTokens || outTokens) {
        span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, inTokens);
        span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, outTokens);
        span.setAttribute(CTA_USAGE_TOKENS_AVAILABLE, true);
      }

      applyIdentityToSpan(span);

      if (input.error !== undefined) {
        if (input.error instanceof Error) span.recordException(input.error);
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
    } finally {
      span.end();
    }
    return true;
  } catch {
    // Telemetry never takes the agent down (same contract as the rest of the SDK).
    return false;
  }
}
