import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, ResilientAuthSpanExporter, type DelegateFactory } from '../src/index.js';

// ─── Fakes ──────────────────────────────────────────────────────────────────

type ExportOutcome = 'ok' | 'fail';

interface FakeDelegate extends SpanExporter {
  readonly headers: Record<string, string>;
  exportCount: number;
  shutdownCount: number;
  flushCount: number;
}

/**
 * Builds a delegate factory whose delegates replay a queue of outcomes. The
 * factory records the headers it was constructed with, so tests can assert the
 * bearer token was injected.
 */
function makeDelegateFactory(outcomes: ExportOutcome[]): {
  createDelegate: DelegateFactory;
  delegates: FakeDelegate[];
} {
  const delegates: FakeDelegate[] = [];
  const createDelegate: DelegateFactory = (headers) => {
    const delegate: FakeDelegate = {
      headers,
      exportCount: 0,
      shutdownCount: 0,
      flushCount: 0,
      export(_spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
        delegate.exportCount += 1;
        const outcome = outcomes.shift() ?? 'ok';
        if (outcome === 'ok') cb({ code: ExportResultCode.SUCCESS });
        else cb({ code: ExportResultCode.FAILED, error: new Error('transient 5xx') });
      },
      async shutdown(): Promise<void> {
        delegate.shutdownCount += 1;
      },
      async forceFlush(): Promise<void> {
        delegate.flushCount += 1;
      },
    };
    delegates.push(delegate);
    return delegate;
  };
  return { createDelegate, delegates };
}

function staticToken(value: string) {
  return { getToken: () => Promise.resolve(value) };
}

/** Awaits the fire-and-callback `export`. */
function runExport(exporter: ResilientAuthSpanExporter): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve) => {
    exporter.export([], resolve);
  });
}

const ENDPOINT = 'https://cta.example.com/api/telemetry/v1/traces';
const noSleep = () => Promise.resolve();

// ─── Happy path ────────────────────────────────────────────────────────────────

describe('ResilientAuthSpanExporter — export success', () => {
  it('injects the bearer token and reports SUCCESS', async () => {
    const { createDelegate, delegates } = makeDelegateFactory(['ok']);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok-abc'),
      createDelegate,
    });

    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(delegates).toHaveLength(1);
    expect(delegates[0]!.headers.Authorization).toBe('Bearer tok-abc');
    expect(delegates[0]!.exportCount).toBe(1);
  });
});

// ─── Retry on transient failure ────────────────────────────────────────────────

describe('ResilientAuthSpanExporter — retry', () => {
  it('retries a transient failure on the same delegate then succeeds', async () => {
    const { createDelegate, delegates } = makeDelegateFactory(['fail', 'ok']);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok'),
      createDelegate,
      retry: { maxAttempts: 3, sleep: noSleep },
    });

    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(delegates).toHaveLength(1); // token unchanged → same delegate reused
    expect(delegates[0]!.exportCount).toBe(2);
  });
});

// ─── Silent degradation ──────────────────────────────────────────────────────

describe('ResilientAuthSpanExporter — persistent failure', () => {
  it('degrades silently: FAILED result, logs, never throws', async () => {
    const { createDelegate } = makeDelegateFactory(['fail', 'fail', 'fail']);
    const warn = vi.fn();
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok'),
      createDelegate,
      retry: { maxAttempts: 2, sleep: noSleep },
      logger: { warn },
    });

    // Must resolve (not reject / throw) — the agent is never disturbed.
    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error).toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ─── Circuit breaker ────────────────────────────────────────────────────────────

describe('ResilientAuthSpanExporter — circuit open', () => {
  it('drops the batch without touching the delegate when the circuit is open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000, now: () => 0 });
    breaker.recordFailure(); // trip open
    const { createDelegate, delegates } = makeDelegateFactory(['ok']);
    const debug = vi.fn();
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok'),
      createDelegate,
      breaker,
      logger: { debug },
    });

    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(delegates).toHaveLength(0); // never attempted
    expect(debug).toHaveBeenCalled();
  });
});

// ─── Token rotation recreates the delegate ─────────────────────────────────────

describe('ResilientAuthSpanExporter — token rotation', () => {
  it('recreates the delegate with the new bearer and shuts down the old one', async () => {
    const tokens = ['tok-1', 'tok-2'];
    const tokenProvider = { getToken: () => Promise.resolve(tokens.shift() ?? 'tok-2') };
    const { createDelegate, delegates } = makeDelegateFactory(['ok', 'ok']);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider,
      createDelegate,
    });

    await runExport(exporter);
    await runExport(exporter);

    expect(delegates).toHaveLength(2);
    expect(delegates[0]!.headers.Authorization).toBe('Bearer tok-1');
    expect(delegates[1]!.headers.Authorization).toBe('Bearer tok-2');
    // The superseded delegate is shut down (best-effort, async).
    await Promise.resolve();
    expect(delegates[0]!.shutdownCount).toBe(1);
  });
});

// ─── Flush + shutdown delegate to the underlying exporter ──────────────────────

describe('ResilientAuthSpanExporter — flush/shutdown', () => {
  it('delegates forceFlush and shutdown to the active delegate', async () => {
    const { createDelegate, delegates } = makeDelegateFactory(['ok']);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok'),
      createDelegate,
    });

    await runExport(exporter); // creates the delegate
    await exporter.forceFlush();
    await exporter.shutdown();

    expect(delegates[0]!.flushCount).toBe(1);
    expect(delegates[0]!.shutdownCount).toBe(1);
  });
});

// ─── Flush/shutdown before any export (no delegate yet) ────────────────────────

describe('ResilientAuthSpanExporter — flush/shutdown before first export', () => {
  it('is a no-op when there is no delegate yet', async () => {
    const { createDelegate, delegates } = makeDelegateFactory([]);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok'),
      createDelegate,
    });
    // No export happened → no delegate built → both resolve without touching one.
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
    expect(delegates).toHaveLength(0);
  });

  it('tolerates a delegate without a forceFlush method', async () => {
    // Delegate factory whose delegate lacks forceFlush (optional in the contract).
    const createDelegate: DelegateFactory = () => ({
      export: (_s: ReadableSpan[], cb: (r: ExportResult) => void) =>
        cb({ code: ExportResultCode.SUCCESS }),
      shutdown: () => Promise.resolve(),
    });
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken('tok'),
      createDelegate,
    });
    await runExport(exporter);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });
});
