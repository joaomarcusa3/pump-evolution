import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadManifest, resolveTelemetryConfig } from '../src/index.js';
import type { AgentManifest, PumpConfig } from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (file: string): string => join(FIXTURES, file);

/** Manifest carrying ADR-0040 telemetry defaults (mirror of manifest-full.yaml). */
const MANIFEST_WITH_TELEMETRY: AgentManifest = {
  name: 'latam-credit-analyzer',
  modelId: 'gpt-4o',
  allowedTools: ['search', 'calculator'],
  runtime: {
    external: true,
    telemetry: {
      otelEndpoint: 'https://otel.cta.topaz.aws.com/v1/traces',
      serviceAccountId: 'svc-latam-credit-analyzer',
    },
  },
};

/** Manifest without a runtime block at all. */
const MANIFEST_NO_RUNTIME: AgentManifest = {
  name: 'minimal-agent',
  modelId: 'anthropic.claude-sonnet-4',
  allowedTools: ['search'],
};

/** Secret + token URL always come from config — never the manifest. */
const SECRETS = { clientSecret: 'shh-secret', tokenUrl: 'https://auth.cta/oauth2/token' } as const;

describe('resolveTelemetryConfig — manifest supplies defaults (ADR-0040)', () => {
  it('uses manifest otelEndpoint + serviceAccountId when config omits endpoint + clientId', () => {
    const config: PumpConfig = {
      manifest: MANIFEST_WITH_TELEMETRY,
      serviceAccount: { ...SECRETS },
    };

    const resolved = resolveTelemetryConfig(config, MANIFEST_WITH_TELEMETRY);

    expect(resolved.endpoint).toBe('https://otel.cta.topaz.aws.com/v1/traces');
    expect(resolved.serviceAccount.clientId).toBe('svc-latam-credit-analyzer');
    // clientSecret + tokenUrl still come from config (not the manifest).
    expect(resolved.serviceAccount.clientSecret).toBe('shh-secret');
    expect(resolved.serviceAccount.tokenUrl).toBe('https://auth.cta/oauth2/token');
  });

  it('resolves the same defaults when the manifest is loaded from the fixture file', () => {
    const manifest = loadManifest(fixture('manifest-full.yaml'));
    const config: PumpConfig = { manifest, serviceAccount: { ...SECRETS } };

    const resolved = resolveTelemetryConfig(config, manifest);

    expect(resolved.endpoint).toBe('https://otel.cta.topaz.aws.com/v1/traces');
    expect(resolved.serviceAccount.clientId).toBe('svc-latam-credit-analyzer');
  });
});

describe('resolveTelemetryConfig — explicit config wins over manifest defaults', () => {
  it('prefers config.endpoint and config.serviceAccount over the manifest', () => {
    const config: PumpConfig = {
      manifest: MANIFEST_WITH_TELEMETRY,
      endpoint: 'https://custom.endpoint/v1/traces',
      serviceAccount: {
        clientId: 'explicit-client-id',
        clientSecret: 'explicit-secret',
        tokenUrl: 'https://explicit/token',
      },
    };

    const resolved = resolveTelemetryConfig(config, MANIFEST_WITH_TELEMETRY);

    expect(resolved.endpoint).toBe('https://custom.endpoint/v1/traces');
    expect(resolved.serviceAccount.clientId).toBe('explicit-client-id');
    // Assert the manifest defaults were NOT used.
    expect(resolved.endpoint).not.toBe(MANIFEST_WITH_TELEMETRY.runtime?.telemetry?.otelEndpoint);
    expect(resolved.serviceAccount.clientId).not.toBe(
      MANIFEST_WITH_TELEMETRY.runtime?.telemetry?.serviceAccountId,
    );
  });

  it('resolves purely from config when the manifest has no runtime block', () => {
    const config: PumpConfig = {
      manifest: MANIFEST_NO_RUNTIME,
      endpoint: 'https://only.config/v1/traces',
      serviceAccount: {
        clientId: 'config-only-client',
        clientSecret: 'config-only-secret',
        tokenUrl: 'https://config-only/token',
      },
    };

    const resolved = resolveTelemetryConfig(config, MANIFEST_NO_RUNTIME);

    expect(resolved.endpoint).toBe('https://only.config/v1/traces');
    expect(resolved.serviceAccount.clientId).toBe('config-only-client');
  });
});

describe('resolveTelemetryConfig — fail-fast (ADR-0031, zero fallback)', () => {
  it('throws when neither config nor manifest provides an endpoint', () => {
    const config: PumpConfig = {
      manifest: MANIFEST_NO_RUNTIME,
      serviceAccount: { clientId: 'c', ...SECRETS },
    };

    expect(() => resolveTelemetryConfig(config, MANIFEST_NO_RUNTIME)).toThrow(
      /requires an OTLP endpoint/,
    );
  });

  it('throws when neither config.serviceAccount.clientId nor manifest serviceAccountId exists', () => {
    const config: PumpConfig = {
      manifest: MANIFEST_NO_RUNTIME,
      endpoint: 'https://e/v1/traces',
      serviceAccount: { ...SECRETS },
    };

    expect(() => resolveTelemetryConfig(config, MANIFEST_NO_RUNTIME)).toThrow(
      /requires a service-account clientId/,
    );
  });

  it('throws when clientSecret is missing even though endpoint + clientId resolve', () => {
    // Simulate a JS caller that omitted the secret (secrets are never in the manifest).
    const config = {
      manifest: MANIFEST_WITH_TELEMETRY,
      serviceAccount: { tokenUrl: 'https://auth/token' },
    } as unknown as PumpConfig;

    expect(() => resolveTelemetryConfig(config, MANIFEST_WITH_TELEMETRY)).toThrow(
      /requires `serviceAccount.clientSecret`/,
    );
  });

  it('throws when tokenUrl is missing even though everything else resolves', () => {
    const config = {
      manifest: MANIFEST_WITH_TELEMETRY,
      serviceAccount: { clientSecret: 'shh' },
    } as unknown as PumpConfig;

    expect(() => resolveTelemetryConfig(config, MANIFEST_WITH_TELEMETRY)).toThrow(
      /requires `serviceAccount.tokenUrl`/,
    );
  });

  it('never applies a silent default — the error message says so', () => {
    const config: PumpConfig = {
      manifest: MANIFEST_NO_RUNTIME,
      serviceAccount: { clientId: 'c', ...SECRETS },
    };

    expect(() => resolveTelemetryConfig(config, MANIFEST_NO_RUNTIME)).toThrow(
      /No default is applied/,
    );
  });
});

describe('resolveTelemetryConfig — optional tuning values', () => {
  const baseConfig: PumpConfig = {
    manifest: MANIFEST_WITH_TELEMETRY,
    serviceAccount: { ...SECRETS },
  };

  it('applies DEFAULT_FLUSH_TIMEOUT_MS when flushTimeoutMs is omitted', () => {
    const resolved = resolveTelemetryConfig(baseConfig, MANIFEST_WITH_TELEMETRY);
    expect(resolved.flushTimeoutMs).toBe(5_000);
  });

  it('respects an explicit flushTimeoutMs', () => {
    const resolved = resolveTelemetryConfig(
      { ...baseConfig, flushTimeoutMs: 12_000 },
      MANIFEST_WITH_TELEMETRY,
    );
    expect(resolved.flushTimeoutMs).toBe(12_000);
  });

  it('throws when flushTimeoutMs is not a positive number', () => {
    expect(() =>
      resolveTelemetryConfig({ ...baseConfig, flushTimeoutMs: 0 }, MANIFEST_WITH_TELEMETRY),
    ).toThrow(/`flushTimeoutMs` must be a positive finite number/);
  });

  it('passes through a valid sampling ratio', () => {
    const resolved = resolveTelemetryConfig(
      { ...baseConfig, sampling: 0.25 },
      MANIFEST_WITH_TELEMETRY,
    );
    expect(resolved.sampling).toBe(0.25);
  });

  it('omits sampling entirely when not provided', () => {
    const resolved = resolveTelemetryConfig(baseConfig, MANIFEST_WITH_TELEMETRY);
    expect(Object.prototype.hasOwnProperty.call(resolved, 'sampling')).toBe(false);
  });

  it('throws when sampling is out of the [0, 1] range', () => {
    expect(() =>
      resolveTelemetryConfig({ ...baseConfig, sampling: 1.5 }, MANIFEST_WITH_TELEMETRY),
    ).toThrow(/`sampling` must be a number in \[0, 1\]/);
  });

  it('reflects config.enabled in the resolved config (env gate applied later by init)', () => {
    const enabled = resolveTelemetryConfig(
      { ...baseConfig, enabled: true },
      MANIFEST_WITH_TELEMETRY,
    );
    const disabled = resolveTelemetryConfig(
      { ...baseConfig, enabled: false },
      MANIFEST_WITH_TELEMETRY,
    );
    expect(enabled.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
  });
});
