/**
 * pump-evolution — the top-level composition (`PumpEvolution.init`) that wires
 * every SDK component into a single plug-and-play handle (Requirement 1).
 *
 * ```ts
 * const pump = PumpEvolution.init({ manifest: './manifest.yaml', serviceAccount });
 * const bedrock = pump.instrumentBedrock(new BedrockRuntimeClient({ region }));
 * await pump.withUser({ userId: 'alice@acme.com' }, () => runAgent(bedrock));
 * ```
 *
 * Composition order: load+validate manifest → resolve effective config → build
 * the OTLP batch pipeline (auth + resilience) → create the tracer provider from
 * the manifest resource → return a handle that instruments Bedrock, wraps manual
 * tools, propagates identity, and flushes on shutdown.
 *
 * Enablement (Requirement 1.2): the SDK is a **no-op** unless
 * `PUMP_EVOLUTION_ENABLED === 'true'` AND `config.enabled !== false`. A no-op
 * handle validates nothing and initialises no exporter — it just runs the
 * developer's functions untouched. Only when enabled does `init` validate the
 * manifest/config (Requirement 1.3, fail-fast).
 */

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-node';

import {
  instrumentBedrockClient,
  type ComplianceConfig,
  type SecurityConfig,
} from './bedrock-instrumentation.js';
import { resolveTelemetryConfig } from './config-resolver.js';
import { PUMP_EVOLUTION_ENABLED_ENV } from './constants.js';
import { withUser } from './identity-context.js';
import { loadManifest, manifestToResourceAttributes } from './manifest-loader.js';
import { createOtlpBatchProcessor, type TelemetryLogger } from './otlp-exporter.js';
import { ServiceAccountTokenProvider } from './token-provider.js';
import { traceTool } from './tool-tracer.js';
import { createTracerProvider, getTracer } from './tracer.js';
import type { PumpConfig, PumpHandle, UserContext } from './types.js';

// ─── Test / advanced seams ─────────────────────────────────────────────────────

/**
 * Internal composition seams. Not part of the everyday API — they let tests
 * inject an in-memory span processor (instead of the real network OTLP pipeline)
 * and control the enablement gate deterministically.
 */
export interface PumpInitInternals {
  /** Span processors to use INSTEAD of the real OTLP batch pipeline (tests). */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Register the provider globally. Default `true`. */
  readonly register?: boolean;
  /** Local logger for exporter degradation. */
  readonly logger?: TelemetryLogger;
  /** Override the `PUMP_EVOLUTION_ENABLED` env gate (tests). */
  readonly envEnabled?: boolean;
  /** Injectable timer for the shutdown flush timeout (tests). */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

// ─── Enablement gate ───────────────────────────────────────────────────────────

function resolveEnabled(config: PumpConfig, internals: PumpInitInternals): boolean {
  const envEnabled = internals.envEnabled ?? process.env[PUMP_EVOLUTION_ENABLED_ENV] === 'true';
  return envEnabled && config.enabled !== false;
}

/** A handle that does nothing — the SDK is disabled (Requirement 1.2). */
function noopHandle(): PumpHandle {
  return {
    instrumentBedrock: (client) => client,
    traceTool: (_name, fn) => fn(),
    withUser: (_ctx, fn) => fn(),
    shutdown: () => Promise.resolve(),
  };
}

// ─── Shutdown flush with timeout (Requirement 7.5) ─────────────────────────────

/**
 * Shuts the provider down (which flushes pending spans), but never blocks the
 * agent's exit longer than `timeoutMs`. On timeout the promise resolves anyway —
 * telemetry must not hold up shutdown.
 */
function shutdownWithTimeout(
  provider: { shutdown: () => Promise<void> },
  timeoutMs: number,
  setTimeoutFn: (fn: () => void, ms: number) => unknown,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    setTimeoutFn(done, timeoutMs);
    void Promise.resolve(provider.shutdown()).then(done, done);
  });
}

// ─── init ──────────────────────────────────────────────────────────────────────

/**
 * Initialises the SDK and returns a controllable {@link PumpHandle}. No-op when
 * disabled; fail-fast on invalid manifest/config when enabled.
 */
export function init(config: PumpConfig, internals: PumpInitInternals = {}): PumpHandle {
  if (!resolveEnabled(config, internals)) return noopHandle();

  // Enabled → validate everything up front (fail-fast, no silent defaults).
  const manifest = loadManifest(config.manifest);
  const resolved = resolveTelemetryConfig(config, manifest);
  const resourceAttributes = manifestToResourceAttributes(manifest);

  const spanProcessors = internals.spanProcessors ?? [
    createOtlpBatchProcessor({
      endpoint: resolved.endpoint,
      tokenProvider: new ServiceAccountTokenProvider({
        tokenUrl: resolved.serviceAccount.tokenUrl,
        clientId: resolved.serviceAccount.clientId,
        clientSecret: resolved.serviceAccount.clientSecret,
      }),
      ...(internals.logger !== undefined ? { logger: internals.logger } : {}),
    }),
  ];

  const provider = createTracerProvider({
    resourceAttributes,
    spanProcessors,
    register: internals.register ?? true,
    ...(resolved.sampling !== undefined ? { sampling: resolved.sampling } : {}),
  });
  const tracer = getTracer(provider);

  const compliance: ComplianceConfig = {
    allowedTools: manifest.allowedTools,
    ...(manifest.dataClassification !== undefined
      ? { dataClassification: manifest.dataClassification }
      : {}),
  };

  // OWASP LLM runtime scanning (Fatia 1b): ON by default when enabled; opt-out
  // via `config.security.enabled = false`. Reads content locally, emits only
  // redacted findings.
  const security: SecurityConfig = {
    enabled: config.security?.enabled ?? true,
    ...(config.security?.maxTotalTokens !== undefined
      ? { maxTotalTokens: config.security.maxTotalTokens }
      : {}),
  };

  const setTimeoutFn = internals.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));

  return {
    instrumentBedrock<C>(client: C): C {
      // Boundary cast: the public contract is structural (`C`), while the
      // implementation expects an AWS SDK v3 `BedrockRuntimeClient`.
      // `instrumentBedrockClient` mutates the client in place and returns the
      // same instance, so the original `client` (typed `C`) is returned.
      instrumentBedrockClient(client as unknown as BedrockRuntimeClient, {
        tracer,
        compliance,
        security,
      });
      return client;
    },
    traceTool<T>(name: string, fn: () => T): T {
      return traceTool(tracer, name, fn);
    },
    withUser<T>(ctx: UserContext, fn: () => T): T {
      return withUser(ctx, fn);
    },
    shutdown(): Promise<void> {
      return shutdownWithTimeout(provider, resolved.flushTimeoutMs, setTimeoutFn);
    },
  };
}

/** Namespace-style entry point matching the documented `PumpEvolution.init(...)`. */
export const PumpEvolution = { init } as const;
