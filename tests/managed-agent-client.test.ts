import { describe, expect, it } from 'vitest';

import {
  buildAgentInvokeScope,
  ManagedAgentClient,
  ManagedAgentInvokeError,
  type FetchLike,
} from '../src/index.js';

// ─── Fake fetch (mesma FetchLike do token-provider: {ok,status,text}) ─────────

interface FakeResponse {
  ok?: boolean;
  status?: number;
  body: string;
}

/**
 * fetch falso que devolve as respostas na ordem dada. A 1ª chamada é o token
 * (client-credentials); as seguintes são as invocações. `calls` registra tudo
 * para asserção de headers/body/url.
 */
function fakeFetch(responses: readonly FakeResponse[]): {
  fetchImpl: FetchLike;
  calls: { url: string; headers: Record<string, string>; body: string }[];
} {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: () => Promise.resolve(r.body),
    });
  };
  return { fetchImpl, calls };
}

const TOKEN_OK: FakeResponse = {
  body: JSON.stringify({ access_token: 'machine-tok', expires_in: 3600 }),
};

const SA = {
  clientId: 'svc-agent',
  clientSecret: 's3cr3t',
  tokenUrl: 'https://auth.example.com/oauth2/token',
};

const BASE = {
  endpoint: 'https://cta.example.com/api/agents/agent-123/invoke',
  agentId: 'agent-123',
  serviceAccount: SA,
};

describe('buildAgentInvokeScope', () => {
  it('monta o scope de invoke no formato do receiver do CTA', () => {
    expect(buildAgentInvokeScope('agent-123')).toBe('cta-consumers/invoke:agent:agent-123');
  });

  it('rejeita agentId vazio', () => {
    expect(() => buildAgentInvokeScope('  ')).toThrow(/non-empty agentId/);
  });
});

describe('ManagedAgentClient.invoke', () => {
  it('autentica com client-credentials (scope de invoke) e invoca o agente', async () => {
    const { fetchImpl, calls } = fakeFetch([
      TOKEN_OK,
      {
        body: JSON.stringify({
          reply: 'olá',
          sessionId: 'sess-1',
          latencyMs: 1200,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.0003,
          correlationId: 'corr-1',
        }),
      },
    ]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    const result = await client.invoke({ message: 'oi' });

    expect(result.reply).toBe('olá');
    expect(result.sessionId).toBe('sess-1');
    expect(result.inputTokens).toBe(10);
    expect(result.costUsd).toBe(0.0003);
    expect(result.raw).toMatchObject({ correlationId: 'corr-1' });

    // 1ª chamada = token com o scope de invoke qualificado
    const [tokenCall, invokeCall] = calls;
    expect(tokenCall!.url).toBe(SA.tokenUrl);
    expect(tokenCall!.body).toContain('scope=cta-consumers%2Finvoke%3Aagent%3Aagent-123');

    // 2ª chamada = invoke com Bearer de máquina e corpo JSON
    expect(invokeCall!.url).toBe(BASE.endpoint);
    expect(invokeCall!.headers.Authorization).toBe('Bearer machine-tok');
    expect(invokeCall!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(invokeCall!.body)).toEqual({ message: 'oi' });
  });

  it('propaga o token do usuário final em x-cta-enduser-authorization (sem prefixo Bearer)', async () => {
    const { fetchImpl, calls } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ reply: 'ok' }) }]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await client.invoke({ message: 'oi', sessionId: 'sess-9', userToken: 'Bearer user-jwt' });

    const invokeCall = calls[1]!;
    expect(invokeCall.headers['x-cta-enduser-authorization']).toBe('user-jwt');
    expect(JSON.parse(invokeCall.body)).toEqual({ message: 'oi', sessionId: 'sess-9' });
  });

  it('não seta x-cta-enduser-authorization quando não há userToken', async () => {
    const { fetchImpl, calls } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ reply: 'ok' }) }]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await client.invoke({ message: 'oi' });

    expect(calls[1]!.headers['x-cta-enduser-authorization']).toBeUndefined();
  });

  it('lança ManagedAgentInvokeError com status e corpo em resposta não-2xx', async () => {
    const { fetchImpl } = fakeFetch([
      TOKEN_OK,
      { ok: false, status: 403, body: JSON.stringify({ error: 'Access denied', reason: 'scope' }) },
    ]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await expect(client.invoke({ message: 'oi' })).rejects.toMatchObject({
      name: 'ManagedAgentInvokeError',
      status: 403,
      body: { error: 'Access denied', reason: 'scope' },
    });
  });

  it('lança quando o corpo de sucesso não tem `reply`', async () => {
    const { fetchImpl } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ sessionId: 'x' }) }]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await expect(client.invoke({ message: 'oi' })).rejects.toBeInstanceOf(ManagedAgentInvokeError);
  });

  it('lança quando a resposta não é JSON', async () => {
    const { fetchImpl } = fakeFetch([TOKEN_OK, { body: '<html>500</html>' }]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await expect(client.invoke({ message: 'oi' })).rejects.toThrow(/non-JSON/);
  });

  it('lança (não silencia) quando o fetch de invoke rejeita — rede', async () => {
    let i = 0;
    const fetchImpl: FetchLike = (_url, _init) => {
      i += 1;
      if (i === 1) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(TOKEN_OK.body) });
      return Promise.reject(new Error('ECONNREFUSED'));
    };
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await expect(client.invoke({ message: 'oi' })).rejects.toThrow(/managed invoke request failed/);
  });

  it('rejeita message vazia', async () => {
    const { fetchImpl } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ reply: 'x' }) }]);
    const client = new ManagedAgentClient({ ...BASE, fetchImpl });

    await expect(client.invoke({ message: '   ' })).rejects.toThrow(/non-empty `message`/);
  });
});

describe('ManagedAgentClient.forAgent', () => {
  it('deriva o endpoint de invoke a partir da base + agentId', async () => {
    const { fetchImpl, calls } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ reply: 'ok' }) }]);
    const client = ManagedAgentClient.forAgent({
      baseUrl: 'https://cta.example.com/',
      agentId: 'agent-xyz',
      serviceAccount: SA,
      fetchImpl,
    });

    await client.invoke({ message: 'oi' });

    expect(calls[1]!.url).toBe('https://cta.example.com/api/agents/agent-xyz/invoke');
    // scope derivado do agentId
    expect(calls[0]!.body).toContain('scope=cta-consumers%2Finvoke%3Aagent%3Aagent-xyz');
  });
});

describe('ManagedAgentClient.fromEnv', () => {
  const ENV = {
    PUMP_MANAGED_AGENT_ENDPOINT: 'https://cta.example.com/api/agents/agent-123/invoke',
    PUMP_MANAGED_AGENT_ID: 'agent-123',
    PUMP_MANAGED_CLIENT_ID: 'svc-agent',
    PUMP_MANAGED_CLIENT_SECRET: 's3cr3t',
    PUMP_MANAGED_TOKEN_URL: 'https://auth.example.com/oauth2/token',
  };

  it('monta o cliente a partir das variáveis de ambiente', async () => {
    const { fetchImpl, calls } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ reply: 'ok' }) }]);
    // fromEnv não aceita fetch — injeta via reconstrução para o teste da composição:
    const client = new ManagedAgentClient({
      endpoint: ENV.PUMP_MANAGED_AGENT_ENDPOINT!,
      agentId: ENV.PUMP_MANAGED_AGENT_ID!,
      serviceAccount: {
        clientId: ENV.PUMP_MANAGED_CLIENT_ID!,
        clientSecret: ENV.PUMP_MANAGED_CLIENT_SECRET!,
        tokenUrl: ENV.PUMP_MANAGED_TOKEN_URL!,
      },
      fetchImpl,
    });
    await client.invoke({ message: 'oi' });
    expect(calls[1]!.url).toBe(ENV.PUMP_MANAGED_AGENT_ENDPOINT);
  });

  it('falha explícita quando falta uma variável obrigatória', () => {
    expect(() => ManagedAgentClient.fromEnv({ PUMP_MANAGED_AGENT_ID: 'x' })).toThrow(
      /missing env `PUMP_MANAGED_AGENT_ENDPOINT`/,
    );
  });

  it('aceita o cliente completo via fromEnv (sem invocar)', () => {
    expect(() => ManagedAgentClient.fromEnv(ENV)).not.toThrow();
  });
});


// ─── fromManifest (portal/MCP grava runtime.managed; o SDK lê) ────────────────

describe('ManagedAgentClient.fromManifest', () => {
  const baseManifest = {
    name: 'weather-agent',
    kind: 'agent' as const,
    modelId: 'anthropic.claude-sonnet-4',
    allowedTools: [] as string[],
  };

  const managed = {
    endpoint: 'https://cta.example.com/api/agents/agent-123/invoke',
    agentId: 'agent-123',
    tokenUrl: 'https://auth.example.com/oauth2/token',
  };

  it('reads runtime.managed and merges the invoke credential from env (secret never in manifest)', async () => {
    const { fetchImpl, calls } = fakeFetch([
      TOKEN_OK,
      { body: JSON.stringify({ reply: 'ok' }) },
    ]);
    const client = ManagedAgentClient.fromManifest(
      { ...baseManifest, runtime: { managed } },
      {
        clientId: 'svc-agent',
        clientSecret: 's3cr3t',
        fetchImpl,
      },
    );
    await client.invoke({ message: 'hi' });
    // 1ª chamada é o token endpoint (client-credentials) — confirma que tokenUrl veio do manifesto.
    expect(calls[0]!.url).toBe(managed.tokenUrl);
    // 2ª é a invocação no endpoint do manifesto.
    expect(calls[1]!.url).toBe(managed.endpoint);
  });

  it('reads the credential from PUMP_MANAGED_* env when not passed explicitly', async () => {
    const { fetchImpl, calls } = fakeFetch([TOKEN_OK, { body: JSON.stringify({ reply: 'ok' }) }]);
    const client = ManagedAgentClient.fromManifest(
      { ...baseManifest, runtime: { managed } },
      {
        env: { PUMP_MANAGED_CLIENT_ID: 'svc-env', PUMP_MANAGED_CLIENT_SECRET: 'sek-env' },
        fetchImpl,
      },
    );
    await client.invoke({ message: 'hi' });
    // Cognito client-credentials manda a credencial no Basic auth, não no body.
    const auth = calls[0]!.headers.Authorization ?? '';
    expect(auth.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe('svc-env:sek-env');
  });

  it('throws (no fallback) when the manifest has no runtime.managed block', () => {
    expect(() => ManagedAgentClient.fromManifest(baseManifest, { env: {} })).toThrow(
      /sem `runtime\.managed`/,
    );
  });
});
