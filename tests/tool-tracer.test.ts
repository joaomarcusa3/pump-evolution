import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTracerProvider,
  extractToolUseFromStreamEvent,
  extractToolUses,
  getTracer,
  recordToolUseSpans,
  traceTool,
  type ResourceAttributes,
} from '../src/index.js';

const ATTRS: ResourceAttributes = {
  'service.name': 'tool-agent',
  'gen_ai.agent.id': 'tool-agent',
  'gen_ai.request.model': 'anthropic.claude-sonnet-4',
};

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.shutdown()));
});

function setup(): { exporter: InMemorySpanExporter; tracer: ReturnType<typeof getTracer> } {
  const exporter = new InMemorySpanExporter();
  const provider = createTracerProvider({
    resourceAttributes: ATTRS,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  providers.push(provider);
  return { exporter, tracer: getTracer(provider) };
}

// ─── extractToolUses (pure) ────────────────────────────────────────────────────

describe('extractToolUses', () => {
  it('reads every toolUse block from a Converse response in order', () => {
    const output = {
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'let me check' },
            { toolUse: { toolUseId: 't1', name: 'get_weather', input: { city: 'Rio' } } },
            { toolUse: { toolUseId: 't2', name: 'search_docs' } },
          ],
        },
      },
    };
    expect(extractToolUses(output)).toEqual([
      { name: 'get_weather', toolUseId: 't1' },
      { name: 'search_docs', toolUseId: 't2' },
    ]);
  });

  it('skips blocks without a valid name and preserves duplicates', () => {
    const output = {
      output: {
        message: {
          content: [
            { toolUse: { name: '  ' } }, // blank → skipped
            { toolUse: { name: 'calc' } },
            { toolUse: { name: 'calc' } }, // same tool twice = two calls
          ],
        },
      },
    };
    expect(extractToolUses(output)).toEqual([{ name: 'calc' }, { name: 'calc' }]);
  });

  it('returns [] for malformed / missing shapes without throwing', () => {
    expect(extractToolUses(undefined)).toEqual([]);
    expect(extractToolUses(null)).toEqual([]);
    expect(extractToolUses({})).toEqual([]);
    expect(extractToolUses({ output: { message: { content: 'nope' } } })).toEqual([]);
  });
});

// ─── extractToolUseFromStreamEvent (pure) ──────────────────────────────────────

describe('extractToolUseFromStreamEvent', () => {
  it('reads a toolUse from a contentBlockStart event', () => {
    const event = {
      contentBlockStart: { start: { toolUse: { toolUseId: 't9', name: 'query_db' } } },
    };
    expect(extractToolUseFromStreamEvent(event)).toEqual({ name: 'query_db', toolUseId: 't9' });
  });

  it('returns undefined for non-tool events', () => {
    expect(
      extractToolUseFromStreamEvent({ contentBlockDelta: { delta: { text: 'x' } } }),
    ).toBeUndefined();
    expect(
      extractToolUseFromStreamEvent({ messageStop: { stopReason: 'end_turn' } }),
    ).toBeUndefined();
    expect(extractToolUseFromStreamEvent(42)).toBeUndefined();
  });
});

// ─── recordToolUseSpans ────────────────────────────────────────────────────────

describe('recordToolUseSpans', () => {
  it('emits one execute_tool span per use, parented to the invocation span', () => {
    const { exporter, tracer } = setup();
    const parent = tracer.startSpan('chat model');
    const count = recordToolUseSpans(
      tracer,
      [{ name: 'get_weather' }, { name: 'search_docs' }],
      parent,
    );
    parent.end();

    expect(count).toBe(2);
    const spans = exporter.getFinishedSpans();
    const toolSpans = spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'execute_tool');
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans.map((s) => s.attributes['gen_ai.tool.name'])).toEqual([
      'get_weather',
      'search_docs',
    ]);

    // Correlation: tool spans share the parent invocation's trace id and point
    // at the parent span id.
    const parentSpan = spans.find((s) => s.name === 'chat model');
    expect(parentSpan).toBeDefined();
    for (const toolSpan of toolSpans) {
      expect(toolSpan.spanContext().traceId).toBe(parentSpan!.spanContext().traceId);
      expect(toolSpan.parentSpanContext?.spanId).toBe(parentSpan!.spanContext().spanId);
    }
  });

  it('emits nothing for an empty list', () => {
    const { exporter, tracer } = setup();
    expect(recordToolUseSpans(tracer, [])).toBe(0);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

// ─── traceTool (manual, framework-agnostic) ────────────────────────────────────

describe('traceTool', () => {
  it('wraps a synchronous tool and returns its value', () => {
    const { exporter, tracer } = setup();
    const result = traceTool(tracer, 'sync_tool', () => 21 * 2);
    expect(result).toBe(42);

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(span!.attributes['gen_ai.tool.name']).toBe('sync_tool');
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it('wraps an async tool and ends the span when the promise settles', async () => {
    const { exporter, tracer } = setup();
    const result = await traceTool(tracer, 'async_tool', async () => {
      await Promise.resolve();
      return 'done';
    });
    expect(result).toBe('done');

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.tool.name']).toBe('async_tool');
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it('records the error and re-throws the ORIGINAL error unchanged (sync)', () => {
    const { exporter, tracer } = setup();
    const boom = new Error('tool exploded');
    expect(() =>
      traceTool(tracer, 'failing_tool', () => {
        throw boom;
      }),
    ).toThrow(boom);

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('tool exploded');
    expect(span!.events.find((e) => e.name === 'exception')).toBeDefined();
  });

  it('records the error and rejects with the ORIGINAL error (async)', async () => {
    const { exporter, tracer } = setup();
    const boom = new Error('async tool exploded');
    await expect(
      traceTool(tracer, 'failing_async', async () => {
        await Promise.resolve();
        throw boom;
      }),
    ).rejects.toBe(boom);

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });
});
