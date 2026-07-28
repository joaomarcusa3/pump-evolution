/**
 * tracer — bootstraps an OpenTelemetry `TracerProvider` for the SDK.
 *
 * Scope (Task 3): build a `NodeTracerProvider` whose `Resource` is derived from
 * the manifest-provided `ResourceAttributes`, applying the sampling ratio from
 * resolved config when present. This module deliberately does NOT wire the OTLP
 * exporter — that is the OtlpExporter's concern (Task 6). To keep the concerns
 * separated and the provider unit-testable, callers MAY inject `SpanProcessor`s
 * (e.g. a `BatchSpanProcessor` from Task 6, or an `InMemorySpanExporter` +
 * `SimpleSpanProcessor` in tests). With no processors, the provider records
 * spans but exports nowhere.
 *
 * Global registration is opt-in (`register`), left `false` by default so `init`
 * (Task 7) decides when to make the provider global. Unit tests can build a
 * provider without touching global state.
 *
 * OTel API note (grounded against `@opentelemetry/resources` ^2.9.0 and
 * `@opentelemetry/sdk-trace-node` ^2.9.0, mirroring
 * `cta-adapter-observability-agentcore`): the 2.x Resource API exposes
 * `resourceFromAttributes(...)` (there is no `new Resource(...)`), and
 * `NodeTracerProvider` takes `{ resource, sampler, spanProcessors }` at
 * construction (there is no post-construction `addSpanProcessor`).
 */

import type { Attributes, AttributeValue, Tracer } from '@opentelemetry/api';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  NodeTracerProvider,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import type { ResourceAttributes } from './types.js';

/** Default tracer name used when a caller does not supply one. */
export const TRACER_NAME = '@a3data/pump-evolution' as const;

/** Default tracer version reported to OpenTelemetry. */
export const TRACER_VERSION = '0.0.1' as const;

// ─── ResourceAttributes → OTel Attributes ─────────────────────────────────────

/**
 * Converts the SDK's typed `ResourceAttributes` into a plain OTel `Attributes`
 * object. Undefined optional fields are dropped (never placeholder-filled, per
 * Requirement 2.4) and the readonly `cta.allowed_tools` array is copied into a
 * mutable array (OTel `AttributeValue` arrays are mutable `string[]`).
 */
function toOtelAttributes(attributes: ResourceAttributes): Attributes {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * Builds an OTel `Resource` from the manifest-derived `ResourceAttributes`.
 * Exposed separately so the exporter/init layers can reuse the exact same
 * resource without rebuilding a provider.
 */
export function buildResource(attributes: ResourceAttributes): Resource {
  return resourceFromAttributes(toOtelAttributes(attributes));
}

// ─── Sampler resolution ───────────────────────────────────────────────────────

/**
 * Resolves the trace sampler.
 *
 * When a `sampling` ratio in `[0, 1]` is provided, a `TraceIdRatioBasedSampler`
 * is used. When omitted, the sampler is `AlwaysOnSampler` — this is a DELIBERATE
 * default (sample everything), not a masked/absent value: for governance
 * telemetry the platform wants every invocation recorded unless the developer
 * explicitly opts into sampling. Callers that want less should pass `sampling`.
 *
 * `resolveTelemetryConfig` already validates the `[0, 1]` range, but this guards
 * the boundary defensively for direct callers.
 */
export function resolveSampler(sampling?: number): Sampler {
  if (sampling === undefined) return new AlwaysOnSampler();
  if (!Number.isFinite(sampling) || sampling < 0 || sampling > 1) {
    throw new Error(
      `[pump-evolution] tracer sampling ratio must be a number in [0, 1], got ${String(
        sampling,
      )}. No default is applied.`,
    );
  }
  return new TraceIdRatioBasedSampler(sampling);
}

// ─── Provider factory ─────────────────────────────────────────────────────────

/** Options for {@link createTracerProvider}. */
export interface CreateTracerProviderOptions {
  /** Resource attributes derived from the agent manifest. */
  readonly resourceAttributes: ResourceAttributes;
  /**
   * Trace sampling ratio in `[0, 1]`. Omitted → AlwaysOn (deliberate default,
   * see {@link resolveSampler}).
   */
  readonly sampling?: number;
  /**
   * Span processors to attach at construction. Task 6 injects the batch
   * processor here; tests inject `SimpleSpanProcessor(new InMemorySpanExporter())`.
   * Omitted → the provider records but exports nowhere (no exporter is wired by
   * this module).
   */
  readonly spanProcessors?: readonly SpanProcessor[];
  /**
   * Register the provider as the global OTel `TracerProvider`. Defaults to
   * `false` so this module has no global side-effects — `init` (Task 7) decides
   * when to register globally.
   */
  readonly register?: boolean;
}

/**
 * Creates (and optionally registers) a `NodeTracerProvider` configured with the
 * manifest resource and sampler. The OTLP exporter is intentionally NOT wired
 * here (Task 6).
 */
export function createTracerProvider(options: CreateTracerProviderOptions): NodeTracerProvider {
  const provider = new NodeTracerProvider({
    resource: buildResource(options.resourceAttributes),
    sampler: resolveSampler(options.sampling),
    ...(options.spanProcessors !== undefined
      ? { spanProcessors: [...options.spanProcessors] }
      : {}),
  });

  if (options.register === true) provider.register();

  return provider;
}

/**
 * Convenience accessor for a `Tracer` from a provider, using the SDK's default
 * instrumentation-scope name/version unless overridden.
 */
export function getTracer(
  provider: NodeTracerProvider,
  name: string = TRACER_NAME,
  version: string = TRACER_VERSION,
): Tracer {
  return provider.getTracer(name, version);
}
