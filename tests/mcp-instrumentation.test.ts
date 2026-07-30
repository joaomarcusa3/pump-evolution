import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTracerProvider,
  getTracer,
  instrumentMcpServer,
  traceMcpTool,
  withUser,
  type ResourceAttributes,
} from '../src/index.js';

const ATTRS: ResourceAttributes = {
  'service.name': 'meu-mcp',
  'gen_ai.agent.id': 'meu-mcp',
  'cta.item_kind': 'mcp',
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

describe('traceMcpTool — governed MCP tool span', () => {
  it('emits an execute_tool span with the tool name and returns the value', () => {
    const { exporter, tracer } = setup();
    const result = traceMcpTool(
      { tracer, allowedTools: ['buscar_licitacao'], security: { enabled: true } },
      { name: 'buscar_licitacao' },
      () => 42,
    );
    expect(result).toBe(42);

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(span!.attributes['gen_ai.tool.name']).toBe('buscar_licitacao');
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it('marks the span compliant when the tool is in allowedTools', () => {
    const { exporter, tracer } = setup();
    traceMcpTool(
      { tracer, allowedTools: ['buscar_licitacao'], security: { enabled: true } },
      { name: 'buscar_licitacao' },
      () => undefined,
    );
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['cta.compliance.status']).toBe('compliant');
    expect(Object.prototype.hasOwnProperty.call(span!.attributes, 'cta.compliance.findings')).toBe(
      false,
    );
  });

  it('flags TOOL_NOT_ALLOWED (non_compliant) when the tool is outside allowedTools', () => {
    const { exporter, tracer } = setup();
    traceMcpTool(
      { tracer, allowedTools: ['buscar_licitacao'], security: { enabled: true } },
      { name: 'exec_shell' },
      () => undefined,
    );
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['cta.compliance.status']).toBe('non_compliant');
    const findings = String(span!.attributes['cta.compliance.findings']);
    expect(findings).toContain('TOOL_NOT_ALLOWED');
    expect(findings).toContain('exec_shell');
  });

  it('flags at_risk security when the input carries a secret (redacted — no raw value)', () => {
    const { exporter, tracer } = setup();
    traceMcpTool(
      { tracer, allowedTools: ['buscar_licitacao'], security: { enabled: true } },
      { name: 'buscar_licitacao', input: 'token=AKIAIOSFODNN7EXAMPLE' },
      () => undefined,
    );
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['cta.security.status']).toBe('at_risk');
    const findings = String(span!.attributes['cta.security.findings']);
    expect(findings).toContain('aws_access_key_id');
    // PRIVACY: the raw secret is never emitted.
    expect(findings).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('skips security scanning when security.enabled is false', () => {
    const { exporter, tracer } = setup();
    traceMcpTool(
      { tracer, allowedTools: [], security: { enabled: false } },
      { name: 'buscar', input: 'token=AKIAIOSFODNN7EXAMPLE' },
      () => undefined,
    );
    const [span] = exporter.getFinishedSpans();
    expect(Object.prototype.hasOwnProperty.call(span!.attributes, 'cta.security.status')).toBe(
      false,
    );
  });

  it('records the error and re-throws the ORIGINAL error unchanged', () => {
    const { exporter, tracer } = setup();
    const boom = new Error('mcp tool exploded');
    expect(() =>
      traceMcpTool(
        { tracer, allowedTools: ['buscar'], security: { enabled: true } },
        { name: 'buscar' },
        () => {
          throw boom;
        },
      ),
    ).toThrow(boom);

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('mcp tool exploded');
  });

  it('wraps an async MCP tool and ends the span when the promise settles', async () => {
    const { exporter, tracer } = setup();
    const result = await traceMcpTool(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      { name: 'buscar' },
      async () => {
        await Promise.resolve();
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it('applies the active withUser identity to the span (parity with agents)', () => {
    const { exporter, tracer } = setup();
    withUser({ userId: 'alice@acme.com', department: 'engineering' }, () =>
      traceMcpTool(
        { tracer, allowedTools: ['buscar'], security: { enabled: true } },
        { name: 'buscar' },
        () => undefined,
      ),
    );
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['enduser.id']).toBe('alice@acme.com');
    expect(span!.attributes['cta.department']).toBe('engineering');
  });

  it('marks the span anonymous when there is no active identity (never invents one)', () => {
    const { exporter, tracer } = setup();
    traceMcpTool(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      { name: 'buscar' },
      () => undefined,
    );
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['cta.identity.anonymous']).toBe(true);
  });
});

// ─── instrumentMcpServer (auto-instrumentation) ──────────────────────────────

/** Minimal MCP-server-like double: both registration APIs store the handler. */
class FakeMcpServer {
  readonly handlers = new Map<string, (...a: unknown[]) => unknown>();
  registerTool(name: string, _config: unknown, handler: (...a: unknown[]) => unknown): this {
    this.handlers.set(name, handler);
    return this;
  }
  tool(name: string, handler: (...a: unknown[]) => unknown): this {
    this.handlers.set(name, handler);
    return this;
  }
}

describe('instrumentMcpServer — auto-instrumentation (no manual wrapping)', () => {
  it('returns the same server instance', () => {
    const { tracer } = setup();
    const server = new FakeMcpServer();
    const returned = instrumentMcpServer(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      server,
    );
    expect(returned).toBe(server);
  });

  it('wraps registerTool: the registered handler emits a governed span and keeps its return', () => {
    const { exporter, tracer } = setup();
    const server = instrumentMcpServer(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      new FakeMcpServer(),
    );

    server.registerTool('buscar', {}, (args: unknown) => `ok:${(args as { q: string }).q}`);
    const result = server.handlers.get('buscar')!({ q: 'x' });

    expect(result).toBe('ok:x');
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.tool.name']).toBe('buscar');
    expect(span!.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(span!.attributes['cta.compliance.status']).toBe('compliant');
  });

  it('flags non_compliant when an auto-instrumented tool is outside allowedTools', () => {
    const { exporter, tracer } = setup();
    const server = instrumentMcpServer(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      new FakeMcpServer(),
    );

    server.registerTool('exec_shell', {}, () => 'done');
    server.handlers.get('exec_shell')!({});

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['cta.compliance.status']).toBe('non_compliant');
    expect(String(span!.attributes['cta.compliance.findings'])).toContain('exec_shell');
  });

  it('scans the tool input passed at call time (secret → at_risk, redacted)', () => {
    const { exporter, tracer } = setup();
    const server = instrumentMcpServer(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      new FakeMcpServer(),
    );

    server.registerTool('buscar', {}, () => undefined);
    server.handlers.get('buscar')!({ token: 'AKIAIOSFODNN7EXAMPLE' });

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['cta.security.status']).toBe('at_risk');
    expect(String(span!.attributes['cta.security.findings'])).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('also wraps the older tool(name, handler) form (handler is the last arg)', () => {
    const { exporter, tracer } = setup();
    const server = instrumentMcpServer(
      { tracer, allowedTools: ['buscar'], security: { enabled: true } },
      new FakeMcpServer(),
    );

    server.tool('buscar', () => 7);
    expect(server.handlers.get('buscar')!()).toBe(7);

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.tool.name']).toBe('buscar');
  });
});
