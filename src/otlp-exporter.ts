/**
 * otlp-exporter — the authenticated, resilient OTLP span exporter (Requirement
 * 7). It composes:
 *   - a **bearer-authenticated** OTLP/HTTP delegate (the service-account token
 *     from {@link ServiceAccountTokenProvider} is injected as
 *     `Authorization: Bearer …` and refreshed transparently);
 *   - **retry with backoff** on transient failures (5xx/timeout) — {@link withRetry};
 *   - a **per-instance circuit breaker** — {@link CircuitBreaker} (never a
 *     module-global, per `anti-patterns.md` §12);
 *   - **silent degradation**: a persistent export failure is reported to an
 *     injectable logger and the batch is dropped — the exporter NEVER throws
 *     into the agent, and the `BatchSpanProcessor` runs off the hot path anyway
 *     (Requirement 7.4).
 *
 * The delegate is created through an injectable factory so tests can substitute
 * a fake transport; in production it is a real `OTLPTraceExporter`. Because the
 * OTLP/HTTP exporter fixes its `headers` at construction, the delegate is
 * (re)created whenever the bearer token changes — token refreshes are infrequent
 * (hourly), so this is cheap.
 *
 * Version note: `@opentelemetry/exporter-trace-otlp-http` is pinned to the 2.x
 * line (`0.2xx`) so it shares `@opentelemetry/core`/`sdk-trace` 2.x with this
 * package — no version skew, no boundary cast. (The 0.57 line targets SDK 1.x
 * and breaks at runtime against core 2.x — `parseKeyPairsIntoRecord` undefined.)
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";

import { CircuitBreaker } from "./resilience.js";
import { withRetry, type RetryOptions } from "./resilience.js";
import type { TelemetryLogger } from "./types.js";

/**
 * Sent as `User-Agent` on every OTLP/HTTP export. Node's `http`/`https` client
 * (which the OTLP exporter uses under the hood) does not set a default
 * `User-Agent`, and AWS Managed Rules' `NoUserAgent_HEADER` (part of
 * `AWSManagedRulesCommonRuleSet`, run by both the CTA API WAF and the portal
 * CloudFront WAF) blocks any request missing it — the batch would otherwise be
 * dropped silently at the edge, never reaching the receiver.
 */
const SDK_USER_AGENT = "@topaz-ia/pump-evolution/0.0.6";

// ─── Logging hook (SDK never uses console) ─────────────────────────────────────

/**
 * The SDK's public diagnostic contract. Defined once in `types.ts` and
 * re-exported here so existing imports from this module keep working.
 */
export type { TelemetryLogger };

/**
 * Extracts a structured, privacy-safe description of an export failure. OTLP/HTTP
 * failures carry the HTTP status on `.code`/`.status` and a short body on `.data`;
 * we surface those (truncated) plus an actionable hint for the common auth cases,
 * so a 401/403 stops being an invisible dropped batch.
 */
function describeExportError(
  error: unknown,
): { message: string; status?: number; detail?: string; hint?: string } {
  const asError = error instanceof Error ? error : new Error(String(error));
  const anyErr = asError as { code?: unknown; status?: unknown; data?: unknown };
  const status =
    typeof anyErr.code === "number"
      ? anyErr.code
      : typeof anyErr.status === "number"
        ? anyErr.status
        : undefined;
  const detail =
    typeof anyErr.data === "string" && anyErr.data.length > 0
      ? anyErr.data.slice(0, 300)
      : undefined;
  const hint =
    status === 401
      ? "auth: token inválido/expirado — verifique clientId+secret do service account (rotação invalida a credencial anterior)"
      : status === 403
        ? "auth: token sem o scope telemetry:write"
        : undefined;
  return {
    message: asError.message,
    ...(status !== undefined ? { status } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** Factory that builds the underlying OTLP delegate for a given header set. */
export type DelegateFactory = (headers: Record<string, string>) => SpanExporter;

/** Dependencies for {@link ResilientAuthSpanExporter}. */
export interface ResilientAuthSpanExporterDeps {
  /** OTLP/HTTP traces endpoint (e.g. `https://…/api/telemetry/v1/traces`). */
  readonly endpoint: string;
  /** Provides (and refreshes) the service-account bearer token. */
  readonly tokenProvider: { getToken(): Promise<string> };
  /** Builds the delegate exporter. Default: a real `OTLPTraceExporter`. */
  readonly createDelegate?: DelegateFactory;
  /** Circuit breaker instance (per target). Default: a fresh one. */
  readonly breaker?: CircuitBreaker;
  /** Retry tuning. */
  readonly retry?: RetryOptions;
  /** Local logger for degradation reporting. Default: silent. */
  readonly logger?: TelemetryLogger;
}

/** Default delegate: a real bearer-authenticated OTLP/HTTP exporter. */
function defaultDelegateFactory(endpoint: string): DelegateFactory {
  return (headers) =>
    new OTLPTraceExporter({
      url: endpoint,
      headers: { "User-Agent": SDK_USER_AGENT, ...headers },
    });
}

/**
 * A `SpanExporter` that authenticates, retries, trips a circuit breaker and
 * degrades silently. Wrap it in a `BatchSpanProcessor` (see
 * {@link createOtlpBatchProcessor}).
 */
export class ResilientAuthSpanExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly tokenProvider: { getToken(): Promise<string> };
  private readonly createDelegate: DelegateFactory;
  private readonly breaker: CircuitBreaker;
  private readonly retry: RetryOptions;
  private readonly logger: TelemetryLogger;

  private delegate: SpanExporter | undefined;
  private delegateToken: string | undefined;

  constructor(deps: ResilientAuthSpanExporterDeps) {
    this.endpoint = deps.endpoint;
    this.tokenProvider = deps.tokenProvider;
    this.createDelegate =
      deps.createDelegate ?? defaultDelegateFactory(deps.endpoint);
    this.breaker = deps.breaker ?? new CircuitBreaker();
    this.retry = deps.retry ?? {};
    this.logger = deps.logger ?? {};
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    // Circuit open → drop this batch without attempting (protects the endpoint
    // and the agent). Reported, never thrown.
    if (!this.breaker.canAttempt()) {
      this.logger.debug?.("telemetry export skipped — circuit open", {
        endpoint: this.endpoint,
      });
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    // Do the async work detached; the SpanExporter contract is fire-and-callback.
    // A rejection here would be an unhandled rejection, so we guard everything.
    void this.exportWithResilience(spans)
      .then(() => {
        this.breaker.recordSuccess();
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((error: unknown) => {
        this.breaker.recordFailure();
        this.logger.warn?.(
          "telemetry export failed — dropping batch (agent unaffected)",
          {
            endpoint: this.endpoint,
            ...describeExportError(error),
          },
        );
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
  }

  /** Fetches a fresh token, (re)builds the delegate, and exports with retry. */
  private async exportWithResilience(spans: ReadableSpan[]): Promise<void> {
    await withRetry(async () => {
      const token = await this.tokenProvider.getToken();
      const delegate = this.ensureDelegate(token);
      await exportOnce(delegate, spans);
    }, this.retry);
  }

  /** Returns a delegate whose Authorization header matches `token`. */
  private ensureDelegate(token: string): SpanExporter {
    if (this.delegate !== undefined && this.delegateToken === token)
      return this.delegate;
    const previous = this.delegate;
    this.delegate = this.createDelegate({ Authorization: `Bearer ${token}` });
    this.delegateToken = token;
    // Best-effort shutdown of the superseded delegate (never throws upward).
    if (previous !== undefined) {
      void Promise.resolve(previous.shutdown()).catch((error: unknown) => {
        this.logger.debug?.("superseded delegate shutdown failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return this.delegate;
  }

  async forceFlush(): Promise<void> {
    const delegate = this.delegate;
    if (delegate === undefined) return;
    const flush = (delegate as { forceFlush?: () => Promise<void> }).forceFlush;
    if (typeof flush === "function") await flush.call(delegate);
  }

  async shutdown(): Promise<void> {
    if (this.delegate !== undefined) await this.delegate.shutdown();
  }
}

/** Promisifies a single delegate export: resolves on SUCCESS, rejects on FAILED. */
function exportOnce(
  delegate: SpanExporter,
  spans: ReadableSpan[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      delegate.export(spans, (result) => {
        if (result.code === ExportResultCode.SUCCESS) resolve();
        else reject(result.error ?? new Error("OTLP export returned FAILED"));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ─── Batch processor factory ────────────────────────────────────────────────────

/** Tuning for the batch processor (subset of the SDK's `BatchSpanProcessor`). */
export interface OtlpBatchProcessorOptions {
  readonly maxQueueSize?: number;
  readonly maxExportBatchSize?: number;
  readonly scheduledDelayMillis?: number;
  readonly exportTimeoutMillis?: number;
}

/**
 * Builds a `BatchSpanProcessor` over a {@link ResilientAuthSpanExporter}
 * (Requirement 7.1). Task 7 attaches the returned processor to the tracer
 * provider.
 */
export function createOtlpBatchProcessor(
  deps: ResilientAuthSpanExporterDeps,
  options: OtlpBatchProcessorOptions = {},
): SpanProcessor {
  return new BatchSpanProcessor(new ResilientAuthSpanExporter(deps), options);
}
