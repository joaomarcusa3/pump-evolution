/**
 * managed-agent-client — cliente para **invocar um agente hospedado no runtime
 * AgentCore gerenciado da plataforma** (ADR-0068, "hospedagem opcional").
 *
 * Diferente do resto do SDK, esta é uma capacidade **ativa** (não observacional):
 * o agente do desenvolvedor deixa de rodar um runtime próprio e passa a **chamar**
 * o runtime de PRD da plataforma (na conta de tooling) por HTTPS + OAuth. O "cérebro"
 * (prompt + modelo + tools) e o catálogo de modelos são da plataforma; o dev só
 * manda mensagem e recebe resposta. Funciona de **qualquer conta AWS, region ou
 * cloud** — não requer credencial AWS no lado do dev, só o par client-credentials
 * do Cognito.
 *
 * Autenticação: token de **máquina** (service account, client-credentials) com o
 * scope de invoke `cta-consumers/invoke:agent:<agentId>` — reusa o mesmo
 * {@link ServiceAccountTokenProvider} da telemetria, apenas com outro scope. A
 * identidade do **usuário final** (para atribuição de custo/departamento) é
 * propagada opcionalmente pelo header `x-cta-enduser-authorization` (o JWT bruto
 * do Cognito do usuário). A plataforma **verifica** esse token via JWKS do user
 * pool antes de confiar — o SDK só o encaminha; ele nunca substitui a identidade
 * de máquina que autorizou a chamada.
 *
 * IMPORTANTE — semântica de erro: ao contrário da telemetria (que degrada em
 * silêncio e NUNCA derruba o processo), a invocação é a chamada real do agente do
 * dev. Uma falha aqui é um erro de negócio que o chamador PRECISA tratar — então
 * `invoke` **lança** {@link ManagedAgentInvokeError} em falha (HTTP não-2xx, rede,
 * corpo inválido). Não há fallback silencioso (ADR-0031).
 */

import { ServiceAccountTokenProvider, type FetchLike } from './token-provider.js';

// ─── Scope helper ──────────────────────────────────────────────────────────────

/**
 * Monta o scope de invoke que o receiver do CTA exige para um agente
 * (`cta-consumers/invoke:agent:<agentId>`). Verificado contra
 * `packages/cta-api/src/middleware/service-account-auth.ts`
 * (`resolveResourceFromScopes` / `hasInvokeScope`), cujo prefixo é
 * `cta-consumers/invoke:` e o tipo de recurso `agent`.
 */
export function buildAgentInvokeScope(agentId: string): string {
  const trimmed = agentId.trim();
  if (trimmed.length === 0) {
    throw new Error('[pump-evolution] buildAgentInvokeScope requires a non-empty agentId.');
  }
  return `cta-consumers/invoke:agent:${trimmed}`;
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Credenciais do service account (client-credentials) usadas para autenticar a
 * invocação. `clientSecret` e `tokenUrl` vêm sempre do ambiente/config do dev —
 * nunca do manifesto. `scope`, quando omitido, é derivado do `agentId`.
 */
export interface ManagedAgentServiceAccount {
  /** App client id do Cognito emitido para o agente. */
  readonly clientId: string;
  /** App client secret. */
  readonly clientSecret: string;
  /** Endpoint OAuth (`.../oauth2/token`). */
  readonly tokenUrl: string;
  /**
   * Scope de invoke. Default: `cta-consumers/invoke:agent:<agentId>`. Só
   * sobrescreva se o resource server/escopo do seu deployment for diferente.
   */
  readonly scope?: string;
}

/** Configuração do {@link ManagedAgentClient}. */
export interface ManagedAgentClientConfig {
  /**
   * URL completa de invocação do agente
   * (ex.: `https://<cta>/api/agents/<agentId>/invoke`). Alternativamente, use
   * {@link ManagedAgentClient.forAgent} para montá-la a partir de uma base + id.
   */
  readonly endpoint: string;
  /** Id do agente no registro do CTA (usado para derivar o scope de invoke). */
  readonly agentId: string;
  /** Credenciais de máquina (client-credentials). */
  readonly serviceAccount: ManagedAgentServiceAccount;
  /** `fetch` injetável (default: global `fetch`, disponível no Node 18+). */
  readonly fetchImpl?: FetchLike;
}

// ─── Request / result ──────────────────────────────────────────────────────────

/** Uma invocação do agente gerenciado. */
export interface ManagedAgentInvocation {
  /** Mensagem do usuário para o agente. */
  readonly message: string;
  /** Id de sessão (UUID) para manter contexto/memória entre turnos. */
  readonly sessionId?: string;
  /**
   * JWT do usuário final (Cognito), propagado para atribuição de identidade/custo
   * via `x-cta-enduser-authorization` (a plataforma o VERIFICA via JWKS antes de
   * confiar). Prefixo `Bearer ` é tolerado. Opcional: sem ele, a invocação é
   * atribuída apenas à identidade de máquina.
   */
  readonly userToken?: string;
}

/**
 * Resultado normalizado da invocação. Os campos conhecidos são extraídos do JSON
 * de resposta do CTA; `raw` preserva o corpo completo para campos adicionais.
 */
export interface ManagedAgentResult {
  /** Resposta do agente. */
  readonly reply: string;
  readonly sessionId?: string;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly correlationId?: string;
  /** Corpo bruto da resposta (para campos não normalizados). */
  readonly raw: Record<string, unknown>;
}

/**
 * Erro de invocação do agente gerenciado. Carrega o `status` HTTP (quando houve
 * resposta) e o corpo de erro do CTA (quando disponível) para o chamador decidir.
 */
export class ManagedAgentInvokeError extends Error {
  readonly status: number | undefined;
  readonly body: unknown;
  constructor(message: string, options: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'ManagedAgentInvokeError';
    this.status = options.status;
    this.body = options.body;
  }
}

// ─── Narrowing helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`[pump-evolution] ManagedAgentClient requires a non-empty \`${field}\`.`);
  }
  return value;
}

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * Cliente de invocação de um agente hospedado no runtime gerenciado (ADR-0068).
 *
 * ```ts
 * const agent = ManagedAgentClient.fromEnv();
 * const r = await agent.invoke({ message: 'Analise...', userToken: req.headers.authorization });
 * console.log(r.reply);
 * ```
 */
export class ManagedAgentClient {
  private readonly endpoint: string;
  private readonly tokenProvider: ServiceAccountTokenProvider;
  private readonly fetchImpl: FetchLike;

  constructor(config: ManagedAgentClientConfig) {
    this.endpoint = requireNonEmpty(config.endpoint, 'endpoint');
    const agentId = requireNonEmpty(config.agentId, 'agentId');
    const sa = config.serviceAccount;
    this.tokenProvider = new ServiceAccountTokenProvider({
      tokenUrl: requireNonEmpty(sa.tokenUrl, 'serviceAccount.tokenUrl'),
      clientId: requireNonEmpty(sa.clientId, 'serviceAccount.clientId'),
      clientSecret: requireNonEmpty(sa.clientSecret, 'serviceAccount.clientSecret'),
      scope: sa.scope ?? buildAgentInvokeScope(agentId),
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
    });
    const resolvedFetch = config.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (resolvedFetch === undefined) {
      throw new Error(
        '[pump-evolution] no `fetch` available: provide `fetchImpl` or run on Node 18+.',
      );
    }
    this.fetchImpl = resolvedFetch;
  }

  /**
   * Monta o cliente a partir de uma base do CTA + agentId, derivando o endpoint
   * de invoke (`<base>/api/agents/<agentId>/invoke`).
   */
  static forAgent(config: {
    baseUrl: string;
    agentId: string;
    serviceAccount: ManagedAgentServiceAccount;
    fetchImpl?: FetchLike;
  }): ManagedAgentClient {
    const base = requireNonEmpty(config.baseUrl, 'baseUrl').replace(/\/+$/, '');
    const agentId = requireNonEmpty(config.agentId, 'agentId');
    return new ManagedAgentClient({
      endpoint: `${base}/api/agents/${encodeURIComponent(agentId)}/invoke`,
      agentId,
      serviceAccount: config.serviceAccount,
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
    });
  }

  /**
   * Monta o cliente a partir de variáveis de ambiente:
   * `PUMP_MANAGED_AGENT_ENDPOINT`, `PUMP_MANAGED_AGENT_ID`,
   * `PUMP_MANAGED_CLIENT_ID`, `PUMP_MANAGED_CLIENT_SECRET`,
   * `PUMP_MANAGED_TOKEN_URL` (e opcional `PUMP_MANAGED_INVOKE_SCOPE`). Falha
   * explícita (throw) se alguma obrigatória estiver ausente — zero fallback.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): ManagedAgentClient {
    const get = (key: string): string => {
      const value = env[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`[pump-evolution] ManagedAgentClient.fromEnv: missing env \`${key}\`.`);
      }
      return value;
    };
    const scope = env.PUMP_MANAGED_INVOKE_SCOPE;
    return new ManagedAgentClient({
      endpoint: get('PUMP_MANAGED_AGENT_ENDPOINT'),
      agentId: get('PUMP_MANAGED_AGENT_ID'),
      serviceAccount: {
        clientId: get('PUMP_MANAGED_CLIENT_ID'),
        clientSecret: get('PUMP_MANAGED_CLIENT_SECRET'),
        tokenUrl: get('PUMP_MANAGED_TOKEN_URL'),
        ...(typeof scope === 'string' && scope.trim().length > 0 ? { scope } : {}),
      },
    });
  }

  /**
   * Invoca o agente gerenciado. Autentica com o token de máquina, propaga a
   * identidade do usuário (quando fornecida) e retorna a resposta normalizada.
   * **Lança** {@link ManagedAgentInvokeError} em falha (não degrada em silêncio).
   */
  async invoke(invocation: ManagedAgentInvocation): Promise<ManagedAgentResult> {
    const message = requireNonEmpty(invocation.message, 'message');
    const token = await this.tokenProvider.getToken();
    const headers = buildInvokeHeaders(token, invocation.userToken);
    const body = JSON.stringify({
      message,
      ...(invocation.sessionId !== undefined ? { sessionId: invocation.sessionId } : {}),
    });

    const response = await this.sendInvoke(headers, body);
    const text = await response.text();
    if (!response.ok) throw errorFromResponse(response.status, text);

    return toResult(parseSuccessBody(text, response.status));
  }

  /** Envia o POST de invoke, convertendo falha de rede em erro explícito. */
  private async sendInvoke(
    headers: Record<string, string>,
    body: string,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    try {
      return await this.fetchImpl(this.endpoint, { method: 'POST', headers, body });
    } catch (err) {
      throw new ManagedAgentInvokeError(
        `[pump-evolution] managed invoke request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ─── Response helpers (mantêm `invoke` sob o limite de complexidade) ──────────

/** Monta os headers da invocação (Bearer de máquina + identidade opcional). */
function buildInvokeHeaders(token: string, userToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (typeof userToken === 'string' && userToken.trim().length > 0) {
    // JWT bruto do usuário final. A plataforma VERIFICA via JWKS antes de confiar
    // (nunca eleva identidade a partir de header não verificado). Header dedicado —
    // distinto do `x-cta-security-context` (que é o SC assinado interno da plataforma).
    headers['x-cta-enduser-authorization'] = userToken.replace(/^Bearer\s+/i, '');
  }
  return headers;
}

/** Constrói o erro de invoke a partir de uma resposta não-2xx (corpo JSON ou texto). */
function errorFromResponse(status: number, text: string): ManagedAgentInvokeError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return new ManagedAgentInvokeError(
    `[pump-evolution] managed invoke responded ${String(status)}.`,
    { status, body: parsed },
  );
}

/** Faz o parse do corpo de sucesso, exigindo um objeto JSON. */
function parseSuccessBody(text: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ManagedAgentInvokeError(
      '[pump-evolution] managed invoke returned a non-JSON response.',
      { status },
    );
  }
  if (!isRecord(parsed)) {
    throw new ManagedAgentInvokeError(
      '[pump-evolution] managed invoke returned an unexpected payload.',
      { status, body: parsed },
    );
  }
  return parsed;
}

/** Normaliza o corpo de sucesso em {@link ManagedAgentResult} (exige `reply`). */
function toResult(parsed: Record<string, unknown>): ManagedAgentResult {
  const reply = readString(parsed.reply);
  if (reply === undefined) {
    throw new ManagedAgentInvokeError('[pump-evolution] managed invoke response missing `reply`.', {
      body: parsed,
    });
  }
  const sessionId = readString(parsed.sessionId);
  const latencyMs = readNumber(parsed.latencyMs);
  const inputTokens = readNumber(parsed.inputTokens);
  const outputTokens = readNumber(parsed.outputTokens);
  const costUsd = readNumber(parsed.costUsd);
  const correlationId = readString(parsed.correlationId);
  return {
    reply,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    raw: parsed,
  };
}
