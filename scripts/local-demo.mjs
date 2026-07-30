/**
 * Local end-to-end demo of the @topaz-ia/pump-evolution SDK — NO AWS required.
 *
 * Spins up a throwaway HTTP server that plays BOTH roles the SDK talks to:
 *   • the OAuth token endpoint  (POST /oauth2/token → client-credentials token)
 *   • the OTLP/HTTP receiver     (POST /v1/traces   → captures the exported spans)
 *
 * Then it initialises the SDK for real (the true public path, gated by
 * PUMP_EVOLUTION_ENABLED=true), instruments a *stubbed* Bedrock client (so no
 * Bedrock/network call happens), runs one Converse invocation inside
 * `withUser(...)`, and flushes on shutdown. The captured spans are printed so
 * you can see identity + token usage + tool + compliance attributes flowing.
 *
 * Run:  node packages/pump-evolution/scripts/local-demo.mjs
 * (build first: pnpm --filter @topaz-ia/pump-evolution build)
 */

import http from 'node:http';

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

import { init } from '../dist/index.js';

// ─── 1. Throwaway local server: token endpoint + OTLP receiver ────────────────

const captured = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');

    if (req.url === '/oauth2/token') {
      console.log(`\n[token] ${req.method} ${req.url}  auth=${req.headers.authorization}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'demo-token-abc', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }

    if (req.url === '/v1/traces') {
      console.log(`\n[otlp]  ${req.method} ${req.url}  auth=${req.headers.authorization}`);
      try {
        captured.push(JSON.parse(body));
      } catch {
        console.log('  (non-JSON payload, bytes:', body.length, ')');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    res.writeHead(404);
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`local server up on ${baseUrl}`);

// ─── 2. Initialise the SDK (real public path) ─────────────────────────────────

process.env.PUMP_EVOLUTION_ENABLED = 'true';

const pump = init(
  {
    endpoint: `${baseUrl}/v1/traces`,
    serviceAccount: {
      clientId: 'svc-weather-agent',
      clientSecret: 'local-demo-secret',
      tokenUrl: `${baseUrl}/oauth2/token`,
    },
    manifest: {
      name: 'weather-agent',
      modelId: 'anthropic.claude-sonnet-4',
      allowedTools: ['get_weather'], // note: the agent also calls a NON-allowed tool below
      dataClassification: 'internal',
      owner: { email: 'owner@acme.com', costCenter: 'CC-42' },
      squad: 'weather-squad',
    },
  },
  {
    logger: {
      warn: (msg, meta) => console.log(`[sdk-warn] ${msg}`, meta ?? ''),
      debug: (msg, meta) => console.log(`[sdk-debug] ${msg}`, meta ?? ''),
    },
  },
);

// ─── 3. Stub the Bedrock client (no real Bedrock call) ────────────────────────

const client = new BedrockRuntimeClient({ region: 'us-east-1' });
// Replace send BEFORE instrumenting so the SDK wraps this stub.
client.send = async () => ({
  output: {
    message: {
      role: 'assistant',
      content: [
        { toolUse: { toolUseId: 't1', name: 'get_weather', input: { city: 'Rio' } } },
        { toolUse: { toolUseId: 't2', name: 'delete_database', input: {} } }, // NOT allowed
      ],
    },
  },
  stopReason: 'tool_use',
  usage: { inputTokens: 55, outputTokens: 12 },
});

pump.instrumentBedrock(client);

// ─── 4. Run one invocation as a real end user ─────────────────────────────────

await pump.withUser({ userId: 'alice@acme.com', department: 'engineering' }, () =>
  client.send(
    new ConverseCommand({
      modelId: 'anthropic.claude-sonnet-4',
      messages: [{ role: 'user', content: [{ text: 'What is the weather in Rio?' }] }],
    }),
  ),
);

// Flush pending spans and tear down.
await pump.shutdown();
await new Promise((resolve) => server.close(resolve));

// ─── 5. Show what the receiver captured ───────────────────────────────────────

const spans = captured.flatMap((payload) =>
  (payload.resourceSpans ?? []).flatMap((rs) =>
    (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
  ),
);

const attrsOf = (span) =>
  Object.fromEntries((span.attributes ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]]));

console.log(`\n================ captured ${spans.length} span(s) ================`);
for (const span of spans) {
  const a = attrsOf(span);
  console.log(`\n• ${span.name}`);
  console.log(`  operation      : ${a['gen_ai.operation.name']}`);
  if (a['gen_ai.tool.name']) console.log(`  tool           : ${a['gen_ai.tool.name']}`);
  if (a['gen_ai.request.model']) console.log(`  model          : ${a['gen_ai.request.model']}`);
  if (a['enduser.id']) console.log(`  enduser.id     : ${a['enduser.id']}`);
  if (a['cta.department']) console.log(`  department     : ${a['cta.department']}`);
  if (a['gen_ai.usage.input_tokens'] !== undefined)
    console.log(`  input_tokens   : ${a['gen_ai.usage.input_tokens']}`);
  if (a['gen_ai.usage.output_tokens'] !== undefined)
    console.log(`  output_tokens  : ${a['gen_ai.usage.output_tokens']}`);
  if (a['cta.compliance.status']) console.log(`  compliance     : ${a['cta.compliance.status']}`);
  if (a['cta.compliance.findings']) console.log(`  findings       : ${a['cta.compliance.findings']}`);
}
console.log('\n=================================================');
