import { context, trace } from '@opentelemetry/api';
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import { buildResource, createTracerProvider, getTracer, resolveSampler } from '../src/index.js';
import type { ResourceAttributes } from '../src/index.js';

const ATTRS: ResourceAttributes = {
  'service.name': 'latam-credit-analyzer',
  'gen_ai.agent.id': 'latam-credit-analyzer',
  'gen_ai.request.model': 'gpt-4o',
  'cta.cost_center': 'LATAM-CC-001',
  'cta.squad': 'data-engineering',
  'cta.data_classification': 'internal',
  'cta.risk_tier': 'T2-medium',
  'cta.allowed_tools': ['search', 'calculator'],
};

describe('buildResource', () => {
  it('carries the manifest-derived attributes on the resource', () => {
    const resource = buildResource(ATTRS);
    expect(resource.attributes['service.name']).toBe('latam-credit-analyzer');
    expect(resource.attributes['gen_ai.agent.id']).toBe('latam-credit-analyzer');
    expect(resource.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(resource.attributes['cta.cost_center']).toBe('LATAM-CC-001');
    expect(resource.attributes['cta.allowed_tools']).toEqual(['search', 'calculator']);
  });

  it('omits absent optional attributes (never placeholder-filled)', () => {
    const minimal: ResourceAttributes = {
      'service.name': 'minimal-agent',
      'gen_ai.agent.id': 'minimal-agent',
      'gen_ai.request.model': 'anthropic.claude-sonnet-4',
    };
    const resource = buildResource(minimal);
    expect('cta.cost_center' in resource.attributes).toBe(false);
    expect('cta.squad' in resource.attributes).toBe(false);
  });
});

describe('resolveSampler', () => {
  it('defaults to AlwaysOn when no ratio is provided (deliberate default)', () => {
    expect(resolveSampler()).toBeInstanceOf(AlwaysOnSampler);
  });

  it('uses TraceIdRatioBased when a ratio is provided', () => {
    expect(resolveSampler(0.25)).toBeInstanceOf(TraceIdRatioBasedSampler);
  });

  it('throws on an out-of-range ratio', () => {
    expect(() => resolveSampler(1.5)).toThrow(/\[0, 1\]/);
  });
});

describe('createTracerProvider', () => {
  const providers: Array<{ shutdown(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(providers.splice(0).map((p) => p.shutdown()));
  });

  it('produces spans that carry the manifest resource attributes', () => {
    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider({
      resourceAttributes: ATTRS,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    providers.push(provider);

    const tracer = getTracer(provider);
    tracer.startSpan('invoke_agent').end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const resource = spans[0]!.resource;
    expect(resource.attributes['service.name']).toBe('latam-credit-analyzer');
    expect(resource.attributes['gen_ai.agent.id']).toBe('latam-credit-analyzer');
    expect(resource.attributes['cta.cost_center']).toBe('LATAM-CC-001');
  });

  it('constructs without error when a sampling ratio is provided', () => {
    const provider = createTracerProvider({ resourceAttributes: ATTRS, sampling: 0.5 });
    providers.push(provider);
    // A ratio-based sampler is parent-based-wrapped internally; the provider must
    // still hand out a working tracer.
    expect(getTracer(provider)).toBeDefined();
  });

  it('does not register globally by default', () => {
    const before = trace.getTracerProvider();
    const provider = createTracerProvider({ resourceAttributes: ATTRS });
    providers.push(provider);
    expect(trace.getTracerProvider()).toBe(before);
  });

  it('samples nothing at ratio 0 (records no sampled spans)', () => {
    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider({
      resourceAttributes: ATTRS,
      sampling: 0,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    providers.push(provider);

    const tracer = getTracer(provider);
    const root = tracer.startSpan('root');
    context.with(trace.setSpan(context.active(), root), () => {
      tracer.startSpan('child').end();
    });
    root.end();

    // A ratio-0 sampler drops spans; InMemorySpanExporter only receives sampled ones.
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    // Sanity: the SDK re-exports ParentBasedSampler used to wrap ratio samplers.
    expect(ParentBasedSampler).toBeDefined();
  });
});
