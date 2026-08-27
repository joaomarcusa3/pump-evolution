import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it, vi } from "vitest";

import {
  CircuitBreaker,
  ResilientAuthSpanExporter,
  type DelegateFactory,
} from "../src/index.js";

// `defaultDelegateFactory` (used when `createDelegate` is omitted) constructs a
// real `OTLPTraceExporter` — mock it to assert the headers it's given.
const otlpConstructorCalls: Array<{
  url: string;
  headers: Record<string, string>;
}> = [];
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    constructor(config: { url: string; headers: Record<string, string> }) {
      otlpConstructorCalls.push(config);
    }
    export(_spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
      cb({ code: ExportResultCode.SUCCESS });
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

// ─── Fakes ──────────────────────────────────────────────────────────────────

type ExportOutcome = "ok" | "fail";

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
        const outcome = outcomes.shift() ?? "ok";
        if (outcome === "ok") cb({ code: ExportResultCode.SUCCESS });
        else
          cb({
            code: ExportResultCode.FAILED,
            error: new Error("transient 5xx"),
          });
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

const ENDPOINT = "https://cta.example.com/api/telemetry/v1/traces";
const noSleep = () => Promise.resolve();

// ─── Happy path ────────────────────────────────────────────────────────────────

describe("ResilientAuthSpanExporter — export success", () => {
  it("injects the bearer token and reports SUCCESS", async () => {
    const { createDelegate, delegates } = makeDelegateFactory(["ok"]);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok-abc"),
      createDelegate,
    });

    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(delegates).toHaveLength(1);
    expect(delegates[0]!.headers.Authorization).toBe("Bearer tok-abc");
    expect(delegates[0]!.exportCount).toBe(1);
  });
});

// ─── Retry on transient failure ────────────────────────────────────────────────

describe("ResilientAuthSpanExporter — retry", () => {
  it("retries a transient failure on the same delegate then succeeds", async () => {
    const { createDelegate, delegates } = makeDelegateFactory(["fail", "ok"]);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
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

describe("ResilientAuthSpanExporter — persistent failure", () => {
  it("degrades silently: FAILED result, logs, never throws", async () => {
    const { createDelegate } = makeDelegateFactory(["fail", "fail", "fail"]);
    const warn = vi.fn();
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
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

// ─── Enriched failure diagnostics (401 → status + hint) ───────────────────────

describe("ResilientAuthSpanExporter — enriched failure log", () => {
  it("surfaces HTTP status and an actionable hint for a 401 on the warn meta", async () => {
    // Delegate that fails with an OTLP-style coded error (status on `.code`).
    const createDelegate: DelegateFactory = () => ({
      export: (_s: ReadableSpan[], cb: (r: ExportResult) => void) => {
        const err = Object.assign(new Error("Unauthorized"), {
          code: 401,
          data: '{"message":"invalid token"}',
        });
        cb({ code: ExportResultCode.FAILED, error: err });
      },
      shutdown: () => Promise.resolve(),
    });
    const warn = vi.fn();
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
      createDelegate,
      retry: { maxAttempts: 1, sleep: noSleep },
      logger: { warn },
    });

    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(warn).toHaveBeenCalledTimes(1);
    const meta = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta.status).toBe(401);
    expect(String(meta.hint)).toMatch(/token/i);
    expect(meta.detail).toContain("invalid token");
  });
});

// ─── Circuit breaker ────────────────────────────────────────────────────────────

describe("ResilientAuthSpanExporter — circuit open", () => {
  it("drops the batch without touching the delegate when the circuit is open", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => 0,
    });
    breaker.recordFailure(); // trip open
    const { createDelegate, delegates } = makeDelegateFactory(["ok"]);
    const debug = vi.fn();
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
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

describe("ResilientAuthSpanExporter — token rotation", () => {
  it("recreates the delegate with the new bearer and shuts down the old one", async () => {
    const tokens = ["tok-1", "tok-2"];
    const tokenProvider = {
      getToken: () => Promise.resolve(tokens.shift() ?? "tok-2"),
    };
    const { createDelegate, delegates } = makeDelegateFactory(["ok", "ok"]);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider,
      createDelegate,
    });

    await runExport(exporter);
    await runExport(exporter);

    expect(delegates).toHaveLength(2);
    expect(delegates[0]!.headers.Authorization).toBe("Bearer tok-1");
    expect(delegates[1]!.headers.Authorization).toBe("Bearer tok-2");
    // The superseded delegate is shut down (best-effort, async).
    await Promise.resolve();
    expect(delegates[0]!.shutdownCount).toBe(1);
  });
});

// ─── Flush + shutdown delegate to the underlying exporter ──────────────────────

describe("ResilientAuthSpanExporter — flush/shutdown", () => {
  it("delegates forceFlush and shutdown to the active delegate", async () => {
    const { createDelegate, delegates } = makeDelegateFactory(["ok"]);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
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

describe("ResilientAuthSpanExporter — flush/shutdown before first export", () => {
  it("is a no-op when there is no delegate yet", async () => {
    const { createDelegate, delegates } = makeDelegateFactory([]);
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
      createDelegate,
    });
    // No export happened → no delegate built → both resolve without touching one.
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
    expect(delegates).toHaveLength(0);
  });

  it("tolerates a delegate without a forceFlush method", async () => {
    // Delegate factory whose delegate lacks forceFlush (optional in the contract).
    const createDelegate: DelegateFactory = () => ({
      export: (_s: ReadableSpan[], cb: (r: ExportResult) => void) =>
        cb({ code: ExportResultCode.SUCCESS }),
      shutdown: () => Promise.resolve(),
    });
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok"),
      createDelegate,
    });
    await runExport(exporter);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });
});

// ─── Default delegate factory sets a User-Agent ────────────────────────────────

describe("ResilientAuthSpanExporter — default delegate (no createDelegate override)", () => {
  it("sends a User-Agent header alongside the bearer token", async () => {
    otlpConstructorCalls.length = 0;
    const exporter = new ResilientAuthSpanExporter({
      endpoint: ENDPOINT,
      tokenProvider: staticToken("tok-abc"),
      // No `createDelegate` — exercises `defaultDelegateFactory`, which builds a
      // real `OTLPTraceExporter` (mocked above).
    });

    const result = await runExport(exporter);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(otlpConstructorCalls).toHaveLength(1);
    expect(otlpConstructorCalls[0]!.url).toBe(ENDPOINT);
    // Node's http/https client sends no User-Agent by default, and AWS Managed
    // Rules' NoUserAgent_HEADER (AWSManagedRulesCommonRuleSet) blocks requests
    // missing it — without this header, the batch is dropped silently at the WAF.
    expect(otlpConstructorCalls[0]!.headers["User-Agent"]).toMatch(
      /^@topaz-ia\/pump-evolution\//,
    );
    expect(otlpConstructorCalls[0]!.headers.Authorization).toBe(
      "Bearer tok-abc",
    );
  });
});
