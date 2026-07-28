/**
 * config-resolver — resolves the SDK's *effective* telemetry configuration by
 * merging what the developer passed to `PumpConfig` with the defaults declared
 * in the manifest's `runtime.telemetry` block (ADR-0040,
 * `ExternalRuntimeTelemetry`).
 *
 * Precedence (manifest values are DEFAULTS, so explicit developer config wins):
 *   1. Explicit value in `PumpConfig` (`config.endpoint`,
 *      `config.serviceAccount.clientId`).
 *   2. Manifest default: `runtime.telemetry.otelEndpoint` → `endpoint`;
 *      `runtime.telemetry.serviceAccountId` → `serviceAccount.clientId`.
 *   3. If a REQUIRED effective value is still missing → fail fast with a clear
 *      error (ADR-0031 zero-fallback). No silent default is ever applied.
 *
 * Field-semantics grounding (verified against
 * `packages/cta-agent-lifecycle/src/domain/value-objects/agent-spec.ts`):
 * `ExternalRuntimeTelemetry.serviceAccountId` is documented as
 * "client_id do service account Cognito emitido para este agente" — so it is
 * the natural default for `serviceAccount.clientId`.
 *
 * Secrets never live in the manifest (design "Security Considerations":
 * "secret do service account fica no ambiente do agente, nunca no manifesto").
 * `clientSecret` and `tokenUrl` therefore ALWAYS come from `PumpConfig`; there
 * is no manifest fallback for them.
 */

import { DEFAULT_FLUSH_TIMEOUT_MS } from './constants.js';
import type { AgentManifest, ManifestTelemetry, PumpConfig } from './types.js';

// ─── Resolved config shape ────────────────────────────────────────────────────

/** Effective service-account credentials after merging config + manifest. */
export interface ResolvedServiceAccount {
  /** From `config.serviceAccount.clientId` or manifest `serviceAccountId`. */
  readonly clientId: string;
  /** From `config.serviceAccount.clientSecret` (never the manifest). */
  readonly clientSecret: string;
  /** From `config.serviceAccount.tokenUrl` (never the manifest). */
  readonly tokenUrl: string;
}

/**
 * Effective telemetry configuration the SDK will run with. Every required field
 * is guaranteed present (the resolver throws otherwise). Genuinely-optional
 * tuning values are typed optional and only present when explicitly provided.
 */
export interface ResolvedTelemetryConfig {
  /** Effective OTLP endpoint (config wins, else manifest default). */
  readonly endpoint: string;
  /** Effective service-account credentials. */
  readonly serviceAccount: ResolvedServiceAccount;
  /** Flush timeout on shutdown; defaults to `DEFAULT_FLUSH_TIMEOUT_MS`. */
  readonly flushTimeoutMs: number;
  /** Trace sampling ratio in `[0, 1]`; omitted when the developer did not set it. */
  readonly sampling?: number;
  /**
   * Whether the SDK is enabled per the developer's explicit config intent.
   *
   * NOTE: this reflects `config.enabled` ONLY. The `PUMP_EVOLUTION_ENABLED`
   * env-var gate (Requirement 1.2) is applied by `init` (Task 7), not here —
   * this resolver stays focused on merging manifest telemetry defaults.
   */
  readonly enabled: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(detail: string): never {
  throw new Error(`[pump-evolution] telemetry config ${detail} No default is applied.`);
}

/** Returns the value when it is a non-blank string, otherwise `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length === 0 ? undefined : value;
}

function describeNumber(value: number): string {
  return Number.isNaN(value) ? 'NaN' : String(value);
}

// ─── Per-field resolution (each fails fast when a required value is missing) ──

function resolveEndpoint(config: PumpConfig, telemetry: ManifestTelemetry | undefined): string {
  const endpoint = nonEmpty(config.endpoint) ?? nonEmpty(telemetry?.otelEndpoint);
  if (endpoint === undefined) {
    fail(
      'requires an OTLP endpoint: set `endpoint` in PumpConfig or ' +
        '`runtime.telemetry.otelEndpoint` in the manifest (ADR-0040).',
    );
  }
  return endpoint;
}

function resolveClientId(config: PumpConfig, telemetry: ManifestTelemetry | undefined): string {
  const clientId =
    nonEmpty(config.serviceAccount?.clientId) ?? nonEmpty(telemetry?.serviceAccountId);
  if (clientId === undefined) {
    fail(
      'requires a service-account clientId: set `serviceAccount.clientId` in PumpConfig or ' +
        '`runtime.telemetry.serviceAccountId` in the manifest (ADR-0040).',
    );
  }
  return clientId;
}

function resolveClientSecret(config: PumpConfig): string {
  const clientSecret = nonEmpty(config.serviceAccount?.clientSecret);
  if (clientSecret === undefined) {
    fail(
      'requires `serviceAccount.clientSecret` from PumpConfig — ' +
        'the client secret is never stored in the manifest.',
    );
  }
  return clientSecret;
}

function resolveTokenUrl(config: PumpConfig): string {
  const tokenUrl = nonEmpty(config.serviceAccount?.tokenUrl);
  if (tokenUrl === undefined) {
    fail(
      'requires `serviceAccount.tokenUrl` from PumpConfig — ' +
        'the token endpoint is never stored in the manifest.',
    );
  }
  return tokenUrl;
}

function resolveSampling(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(value) || value < 0 || value > 1) {
    fail(`\`sampling\` must be a number in [0, 1] when present, got ${describeNumber(value)}.`);
  }
  return value;
}

function resolveFlushTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FLUSH_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    fail(
      `\`flushTimeoutMs\` must be a positive finite number when present, got ${describeNumber(
        value,
      )}.`,
    );
  }
  return value;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolves the effective telemetry configuration from the developer's
 * `PumpConfig` and the agent `manifest`. Explicit config values take precedence
 * over the manifest's `runtime.telemetry` defaults (ADR-0040). Missing required
 * effective values fail fast (ADR-0031).
 */
export function resolveTelemetryConfig(
  config: PumpConfig,
  manifest: AgentManifest,
): ResolvedTelemetryConfig {
  const telemetry = manifest.runtime?.telemetry;

  const endpoint = resolveEndpoint(config, telemetry);
  const clientId = resolveClientId(config, telemetry);
  const clientSecret = resolveClientSecret(config);
  const tokenUrl = resolveTokenUrl(config);
  const sampling = resolveSampling(config.sampling);
  const flushTimeoutMs = resolveFlushTimeoutMs(config.flushTimeoutMs);

  return {
    endpoint,
    serviceAccount: { clientId, clientSecret, tokenUrl },
    flushTimeoutMs,
    enabled: config.enabled ?? true,
    ...(sampling !== undefined ? { sampling } : {}),
  };
}
