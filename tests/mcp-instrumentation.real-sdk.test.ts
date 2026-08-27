/**
 * Regressão contra o `@modelcontextprotocol/sdk` REAL — não um duplo.
 *
 * Por que este arquivo existe: `instrumentMcpServer` embrulhava só
 * `registerTool`/`tool`, métodos que existem apenas na classe `McpServer` (alto
 * nível). Servidores construídos sobre a classe `Server` (baixo nível) — como o
 * `cta-factory-mcp` da plataforma — despacham tools por
 * `setRequestHandler(CallToolRequestSchema, …)` e não têm nenhum dos dois. O SDK
 * subia, logava telemetria ativa e NUNCA emitia um span de tool. Nada falhava:
 * typecheck, lint, build e os testes com fakes passavam todos.
 *
 * A lição é que fake de servidor MCP não prova instrumentação. Estes testes
 * exercitam as duas classes reais ponta a ponta (cliente ↔ transport in-memory
 * ↔ servidor) e checam os spans que saíram.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createTracerProvider,
  getTracer,
  instrumentMcpServer,
  type McpToolTracerDeps,
  type ResourceAttributes,
} from '../src/index.js';

const ATTRS: ResourceAttributes = {
  'service.name': 'cta-factory-mcp',
  'gen_ai.agent.id': 'cta-factory-mcp',
  'cta.item_kind': 'mcp',
};

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.shutdown()));
});

function setup(): { exporter: InMemorySpanExporter; deps: McpToolTracerDeps } {
  const exporter = new InMemorySpanExporter();
  const provider = createTracerProvider({
    resourceAttributes: ATTRS,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    register: false,
  });
  providers.push(provider);
  return {
    exporter,
    deps: {
      tracer: getTracer(provider),
      allowedTools: ['cta_factory_menu'],
      security: { enabled: true },
    },
  };
}

/** Liga um `Client` real ao servidor por um par de transports in-memory. */
async function connect(server: { connect: (t: InMemoryTransport) => Promise<void> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('instrumentMcpServer — classe Server real (baixo nível)', () => {
  it('emite um span por tool despachada via setRequestHandler(CallToolRequestSchema)', async () => {
    const { exporter, deps } = setup();
    const server = new Server(
      { name: 'cta-factory-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    // A classe de baixo nível não tem NENHUM método por tool — era exatamente
    // por isso que a instrumentação virava no-op silencioso.
    expect((server as unknown as { registerTool?: unknown }).registerTool).toBeUndefined();
    expect((server as unknown as { tool?: unknown }).tool).toBeUndefined();

    instrumentMcpServer(deps, server);
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'cta_factory_menu', inputSchema: { type: 'object' as const } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, (req) => ({
      content: [{ type: 'text' as const, text: `chamou ${req.params.name}` }],
    }));

    const client = await connect(server);
    await client.listTools();
    const result = await client.callTool({
      name: 'cta_factory_menu',
      arguments: { q: 'oi' },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'chamou cta_factory_menu' }]);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1); // tools/list não vira span de tool
    expect(spans[0]!.name).toBe('execute_tool cta_factory_menu');
    expect(spans[0]!.attributes['gen_ai.tool.name']).toBe('cta_factory_menu');
    expect(spans[0]!.attributes['cta.compliance.status']).toBe('compliant');
    await client.close();
  });

  it('governa cada tool separadamente, com o input real da chamada (redigido)', async () => {
    const { exporter, deps } = setup();
    const server = new Server(
      { name: 'cta-factory-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    instrumentMcpServer(deps, server);
    server.setRequestHandler(CallToolRequestSchema, () => ({ content: [] }));

    const client = await connect(server);
    await client.callTool({
      name: 'tool_fora_da_allowlist',
      arguments: { token: 'AKIAIOSFODNN7EXAMPLE' },
    });

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.tool.name']).toBe('tool_fora_da_allowlist');
    expect(span!.attributes['cta.compliance.status']).toBe('non_compliant');
    expect(span!.attributes['cta.security.status']).toBe('at_risk');
    expect(String(span!.attributes['cta.security.findings'])).not.toContain(
      'AKIAIOSFODNN7EXAMPLE',
    );
    await client.close();
  });

  it('instrumenta também quando o handler de tools/call já estava registrado', async () => {
    const { exporter, deps } = setup();
    const server = new Server(
      { name: 'cta-factory-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    // Ordem invertida de propósito: registrar ANTES de instrumentar.
    server.setRequestHandler(CallToolRequestSchema, () => ({ content: [] }));
    instrumentMcpServer(deps, server);

    const client = await connect(server);
    await client.callTool({ name: 'cta_factory_menu', arguments: {} });

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.tool.name']).toBe('cta_factory_menu');
    await client.close();
  });
});

describe('instrumentMcpServer — classe McpServer real (alto nível)', () => {
  it('continua emitindo um span por tool registrada com registerTool', async () => {
    const { exporter, deps } = setup();
    const server = new McpServer({ name: 'cta-factory-mcp', version: '1.0.0' });
    instrumentMcpServer(deps, server);

    server.registerTool(
      'cta_factory_menu',
      { inputSchema: { q: z.string() } },
      ({ q }) => ({ content: [{ type: 'text' as const, text: `menu:${q}` }] }),
    );

    const client = await connect(server);
    const result = await client.callTool({ name: 'cta_factory_menu', arguments: { q: 'oi' } });

    expect(result.content).toEqual([{ type: 'text', text: 'menu:oi' }]);
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.tool.name']).toBe('cta_factory_menu');
    expect(span!.attributes['cta.compliance.status']).toBe('compliant');
    await client.close();
  });
});
