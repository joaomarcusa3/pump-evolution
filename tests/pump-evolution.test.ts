import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ExportResultCode } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  init,
  ResilientAuthSpanExporter,
  type AgentManifest,
  type PumpConfig,
} from '../src/index.js';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
});

const MANIFEST: AgentManifest = {
  name: 'weather-agent',
  modelId: 'anthropic.claude-sonnet-4',
  allowedTools: ['get_weather'],
  dataClassification: 'internal',
  owner: { email: 'owner@acme.com', costCenter: 'CC-1' },
  squad: 'weather-squad',
};

const SERVICE_ACCOUNT = {
  clientId: 'svc-weather',
  clientSecret: 'secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
};

function baseConfig(overrides: Partial<PumpConfig> = {}): PumpConfig {
  return {
    manifest: MANIFEST,
    endpoint: 'https://cta.example.com/api/telemetry/v1/traces',
    serviceAccount: SERVICE_ACCOUNT,
    ...overrides,
  };
}

/** init wired to an in-memory exporter (no network), enablement forced on. */
function initWithExporter(config: PumpConfig) {
  const exporter = new InMemorySpanExporter();
  const handle = init(config, {
    envEnabled: true,
    register: false,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, handle };
}

function invocationSpan(spans: readonly ReadableSpan[]): ReadableSpan | undefined {
  return spans.find((s) => s.attributes['gen_ai.operation.name'] === 'chat');
}

// ─── End-to-end span ────────────────────────────────────────────────────────

describe('PumpEvolution.init — end-to-end', () => {
  it('produces a complete GenAI span with identity, usage, tools and compliance', async () => {
    const { exporter, handle } = initWithExporter(baseConfig());
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 't1', name: 'get_weather', input: { city: 'Rio' } } }],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 55, outputTokens: 12 },
    });

    const client = handle.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));

    await handle.withUser({ userId: 'alice@acme.com', department: 'engineering' }, () =>
      client.send(new ConverseCommand({ modelId: MANIFEST.modelId, messages: [] })),
    );

    const spans = exporter.getFinishedSpans();

    // Invocation span: identity + usage + compliance.
    const inv = invocationSpan(spans);
    expect(inv).toBeDefined();
    expect(inv!.attributes['enduser.id']).toBe('alice@acme.com');
    expect(inv!.attributes['cta.department']).toBe('engineering');
    expect(inv!.attributes['gen_ai.usage.input_tokens']).toBe(55);
    expect(inv!.attributes['gen_ai.usage.output_tokens']).toBe(12);
    expect(inv!.attributes['cta.compliance.status']).toBe('compliant');

    // Tool span emitted and correlated to the invocation.
    const toolSpan = spans.find((s) => s.attributes['gen_ai.tool.name'] === 'get_weather');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.spanContext().traceId).toBe(inv!.spanContext().traceId);

    await handle.shutdown();
  });

  it('marks the invocation non_compliant when a tool is outside the allowlist', async () => {
    const { exporter, handle } = initWithExporter(baseConfig());
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 't9', name: 'exfiltrate_data', input: {} } }],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const client = handle.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
    await client.send(new ConverseCommand({ modelId: MANIFEST.modelId, messages: [] }));

    const inv = invocationSpan(exporter.getFinishedSpans());
    expect(inv!.attributes['cta.compliance.status']).toBe('non_compliant');
    const findings = JSON.parse(inv!.attributes['cta.compliance.findings'] as string);
    expect(findings[0]).toMatchObject({ code: 'TOOL_NOT_ALLOWED', tool: 'exfiltrate_data' });

    await handle.shutdown();
  });
});

// ─── No-op when disabled ──────────────────────────────────────────────────────

describe('PumpEvolution.init — disabled (no-op)', () => {
  it('does not instrument, does not validate, and runs functions untouched', async () => {
    // envEnabled=false → no-op. Deliberately invalid config (missing token url)
    // must NOT throw, because a disabled SDK initialises nothing.
    const handle = init(
      { manifest: MANIFEST, serviceAccount: { clientId: '', clientSecret: '', tokenUrl: '' } },
      { envEnabled: false },
    );

    const raw = new BedrockRuntimeClient({ region: 'us-east-1' });
    const returned = handle.instrumentBedrock(raw);
    expect(returned).toBe(raw);

    expect(handle.traceTool('x', () => 7)).toBe(7);
    expect(handle.withUser({ userId: 'a' }, () => 'ran')).toBe('ran');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('is a no-op when config.enabled is false even if the env gate is on', () => {
    const handle = init(baseConfig({ enabled: false }), { envEnabled: true });
    expect(handle.traceTool('x', () => 1)).toBe(1);
  });
});

// ─── Fail-fast when enabled ───────────────────────────────────────────────────

describe('PumpEvolution.init — enabled fail-fast', () => {
  it('throws on an invalid manifest', () => {
    const bad = { modelId: 'm', allowedTools: [] } as unknown as AgentManifest; // missing name
    expect(() =>
      init(baseConfig({ manifest: bad }), { envEnabled: true, register: false }),
    ).toThrow();
  });

  it('throws when a required telemetry value is missing', () => {
    expect(() =>
      init(baseConfig({ serviceAccount: { clientId: 'c', clientSecret: '', tokenUrl: 't' } }), {
        envEnabled: true,
        register: false,
        spanProcessors: [],
      }),
    ).toThrow(/clientSecret/);
  });
});

// ─── Streaming end-to-end ──────────────────────────────────────────────────────

/** Builds an async iterable stream from a fixed list of events. */
async function* toStream(events: readonly unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

describe('PumpEvolution.init — streaming end-to-end', () => {
  it('captures identity, aggregated tokens, tool and compliance for a ConverseStream', async () => {
    const { exporter, handle } = initWithExporter(baseConfig());
    const events = [
      { contentBlockStart: { start: { toolUse: { toolUseId: 't1', name: 'get_weather' } } } },
      { contentBlockDelta: { delta: { text: 'checking' } } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 30, outputTokens: 8 } } },
    ];
    const client = handle.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: toStream(events) });

    const response = await handle.withUser({ userId: 'bob@acme.com', department: 'finance' }, () =>
      client.send(new ConverseStreamCommand({ modelId: MANIFEST.modelId, messages: [] })),
    );

    // The span only finishes once the agent consumes the stream to completion.
    const stream = (response as { stream: AsyncIterable<unknown> }).stream;
    for await (const _event of stream) {
      /* agent consumes every event */
    }

    const inv = invocationSpan(exporter.getFinishedSpans());
    expect(inv).toBeDefined();
    expect(inv!.attributes['enduser.id']).toBe('bob@acme.com');
    expect(inv!.attributes['cta.department']).toBe('finance');
    expect(inv!.attributes['gen_ai.usage.input_tokens']).toBe(30);
    expect(inv!.attributes['gen_ai.usage.output_tokens']).toBe(8);
    expect(inv!.attributes['cta.compliance.status']).toBe('compliant'); // get_weather is allowed

    const toolSpan = exporter
      .getFinishedSpans()
      .find((s) => s.attributes['gen_ai.tool.name'] === 'get_weather');
    expect(toolSpan).toBeDefined();

    await handle.shutdown();
  });
});

// ─── Anonymous invocation (no withUser) ────────────────────────────────────────

describe('PumpEvolution.init — no identity', () => {
  it('marks the span explicitly anonymous when invoked outside withUser', async () => {
    const { exporter, handle } = initWithExporter(baseConfig());
    const client = handle.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: 'hi' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await client.send(new ConverseCommand({ modelId: MANIFEST.modelId, messages: [] }));

    const inv = invocationSpan(exporter.getFinishedSpans());
    expect(inv!.attributes['cta.identity.anonymous']).toBe(true);
    expect('enduser.id' in inv!.attributes).toBe(false);

    await handle.shutdown();
  });
});

// ─── Export failure never breaks the agent (Requirement 7.4) ───────────────────

describe('PumpEvolution.init — export failure resilience', () => {
  it('returns the agent response and resolves shutdown even when export fails', async () => {
    // A delegate that always fails, wrapped by the real resilient exporter with
    // fast (no-op sleep) retry — proves a persistently-failing telemetry backend
    // never disturbs the agent nor hangs shutdown.
    const failingExporter = new ResilientAuthSpanExporter({
      endpoint: 'http://unused.local/v1/traces',
      tokenProvider: { getToken: () => Promise.resolve('tok') },
      createDelegate: () => ({
        export: (_spans, cb) => cb({ code: ExportResultCode.FAILED, error: new Error('503') }),
        shutdown: () => Promise.resolve(),
      }),
      retry: { maxAttempts: 2, sleep: () => Promise.resolve() },
      logger: {},
    });

    const handle = init(baseConfig(), {
      envEnabled: true,
      register: false,
      spanProcessors: [new SimpleSpanProcessor(failingExporter)],
    });
    const client = handle.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: 'hi' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    // The agent gets its response back regardless of the failing telemetry.
    const result = await client.send(
      new ConverseCommand({ modelId: MANIFEST.modelId, messages: [] }),
    );
    expect(result).toMatchObject({ stopReason: 'end_turn' });

    // Shutdown flushes and resolves — never throws, never hangs.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

// ─── Shutdown never blocks the agent longer than the timeout (Requirement 7.5) ──

describe('PumpEvolution.init — shutdown timeout', () => {
  it('resolves shutdown via the timeout even when the provider flush never settles', async () => {
    // A processor whose shutdown/forceFlush never resolve simulates a hung
    // telemetry backend on exit. The injected timer fires immediately, so
    // shutdown must still resolve (telemetry must not hold up the agent's exit).
    const hangingProcessor: SpanProcessor = {
      onStart() {},
      onEnd() {},
      forceFlush: () => new Promise<void>(() => {}),
      shutdown: () => new Promise<void>(() => {}),
    };
    let timerFired = false;
    const handle = init(baseConfig(), {
      envEnabled: true,
      register: false,
      spanProcessors: [hangingProcessor],
      setTimeoutFn: (fn) => {
        timerFired = true;
        fn();
        return 0;
      },
    });

    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(timerFired).toBe(true);
  });
});
