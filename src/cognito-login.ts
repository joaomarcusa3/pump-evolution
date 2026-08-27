/**
 * cognito-login — login OAuth2 (Authorization Code + PKCE) contra o Cognito de
 * usuário da plataforma. Paridade Node do `integrations/cognito.py`.
 *
 * ## Por que existe
 *
 * A orientação antiga era "não mude o Cognito do agente — o SDK só lê o
 * `id_token` que ele já tem". Só que quase nenhum Cognito de cliente carregava os
 * claims de custo (`custom:department`, `custom:cost_center`), então o span saía
 * com o usuário certo e SEM departamento — perdendo a atribuição de custo, que é
 * a razão de a governança existir.
 *
 * A solução: o **User Pool de usuário final vive na conta de tooling da
 * plataforma**, com os claims de custo governados por nós. O agente troca o login
 * dele para esse pool. O App Client é provisionado no INSTALL (Factory API), não
 * no registro — o instalador coleta as callback URLs do app real antes de criar
 * o client. As variáveis `COGNITO_*` saem desse provisionamento.
 *
 * ## O que este módulo entrega
 *
 * Diferente do Python (que tem `PumpIdentityMiddleware` p/ FastAPI), o Node não
 * assume um framework web. Este módulo entrega **primitivas testáveis** + um par
 * de **handlers estilo Express/Connect** para quem quer as rotas prontas, sem
 * adicionar `express` como dependência.
 *
 * Uso com as rotas prontas (Express + express-session):
 *
 *     import { CognitoLogin } from '@topaz-ia/pump-evolution';
 *     const login = CognitoLogin.fromEnv();
 *     const routes = login.expressRoutes();
 *     app.get('/auth/login', routes.login);
 *     app.get('/auth/callback', routes.callback);
 *     app.get('/auth/logout', routes.logout);
 *
 * Depois, por requisição, propague a identidade do usuário logado para os spans:
 *
 *     await pump.withUser(login.userContextFromIdToken(req.session.pumpIdToken), () => handler());
 *
 * Uso com as primitivas (qualquer framework — Fastify, Hono, http cru):
 *
 *     const { verifier, challenge } = login.createPkce();
 *     const state = login.createState();
 *     // guarde verifier+state na sua sessão, redirecione para:
 *     login.authorizeUrl({ state, codeChallenge: challenge });
 *     // no callback, valide o state e troque o code:
 *     const tokens = await login.exchangeCode(code, verifier);
 *
 * ## Segurança
 * - PKCE (S256) sempre + `state` — protege contra interceptação de código e CSRF.
 * - `clientSecret` só no Basic auth da troca de token (server-to-server, TLS).
 * - `id_token` decodificado SEM verificar assinatura (mesmo contrato do resto do
 *   SDK: cliente lê, receiver verifica). A confiança vem da troca autenticada
 *   contra o token endpoint do Cognito sobre TLS. Para VERIFICAR o token de quem
 *   chama uma API, use `ConsumerTokenVerifier` (RS256 + JWKS).
 *
 * Erros de CONFIG lançam no boot (init-time, igual ao resto do SDK). Falhas de
 * troca de token em runtime retornam `undefined`/resultado `{ ok:false }` — o
 * handler responde erro; login é crítico, não degrada em silêncio como telemetria.
 */

import { createHash, randomBytes } from 'node:crypto';

import { claimsToUserContext } from './identity-context.js';
import type { UserContext } from './types.js';

// ─── fetch injetável (paridade com consumer-auth / token-provider) ────────────

/** `fetch` mínimo para a troca de token, injetável para testes. */
export type CognitoFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const DEFAULT_SCOPES = 'openid email profile';
const TOKEN_TIMEOUT_MS = 10_000;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface CognitoLoginConfig {
  /** Domínio do Hosted UI, ex.: `https://<prefixo>.auth.<region>.amazoncognito.com`. */
  readonly domain: string;
  /** App Client provisionado para este agente (Factory API). */
  readonly clientId: string;
  /** URL absoluta do callback, registrada no App Client. */
  readonly redirectUri: string;
  /** Secret do App Client confidencial. Omitido para client público (só PKCE). */
  readonly clientSecret?: string;
  /** Escopos OAuth. Default `openid email profile`. */
  readonly scopes?: string;
  /** Para onde voltar após o logout do Cognito. */
  readonly logoutRedirectUri?: string;
  /** `fetch` injetável (default global `fetch`, Node 18+). */
  readonly fetchImpl?: CognitoFetchLike;
}

/** Par PKCE (verifier guardado na sessão; challenge vai na URL de autorização). */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** Resultado do tratamento de callback (framework-neutro). */
export type CallbackResult =
  | { readonly ok: true; readonly idToken: string; readonly user: UserContext; readonly tokens: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

function base64UrlNoPad(buf: Buffer): string {
  return buf.toString('base64url');
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// ─── CognitoLogin ───────────────────────────────────────────────────────────

export class CognitoLogin {
  private readonly domain: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly clientSecret: string | undefined;
  private readonly scopes: string;
  private readonly logoutRedirectUri: string | undefined;
  private readonly fetchImpl: CognitoFetchLike;

  constructor(config: CognitoLoginConfig) {
    const missing = (['domain', 'clientId', 'redirectUri'] as const).filter(
      (k) => !isNonEmpty(config[k]),
    );
    if (missing.length > 0) {
      throw new Error(
        `[pump-evolution] CognitoLogin: config incompleto (${missing.join(', ')}). ` +
          'Esses valores saem do provisionamento do App Client (Factory API) e vão no ' +
          '.env do app — sem fallback.',
      );
    }
    const resolvedFetch = config.fetchImpl ?? (globalThis.fetch as CognitoFetchLike | undefined);
    if (resolvedFetch === undefined) {
      throw new Error('[pump-evolution] CognitoLogin: no `fetch` available (provide fetchImpl).');
    }
    this.domain = config.domain.replace(/\/$/, '');
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.clientSecret = config.clientSecret;
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
    this.logoutRedirectUri = config.logoutRedirectUri;
    this.fetchImpl = resolvedFetch;
  }

  /**
   * Constrói a partir das variáveis `COGNITO_*` do ambiente. As três primeiras
   * são obrigatórias:
   *  - `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, `COGNITO_REDIRECT_URI`
   *  - `COGNITO_CLIENT_SECRET` (opcional, client confidencial)
   *  - `COGNITO_SCOPES` (opcional), `COGNITO_LOGOUT_REDIRECT_URI` (opcional)
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): CognitoLogin {
    return new CognitoLogin({
      domain: env.COGNITO_DOMAIN ?? '',
      clientId: env.COGNITO_CLIENT_ID ?? '',
      redirectUri: env.COGNITO_REDIRECT_URI ?? '',
      ...(env.COGNITO_CLIENT_SECRET ? { clientSecret: env.COGNITO_CLIENT_SECRET } : {}),
      ...(env.COGNITO_SCOPES ? { scopes: env.COGNITO_SCOPES } : {}),
      ...(env.COGNITO_LOGOUT_REDIRECT_URI
        ? { logoutRedirectUri: env.COGNITO_LOGOUT_REDIRECT_URI }
        : {}),
    });
  }

  // ─── Primitivas ─────────────────────────────────────────────────────────

  /** Gera um par PKCE (verifier aleatório + challenge S256). */
  createPkce(): Pkce {
    const verifier = base64UrlNoPad(randomBytes(32));
    const challenge = base64UrlNoPad(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  /** Gera um `state` opaco para proteção CSRF no callback. */
  createState(): string {
    return base64UrlNoPad(randomBytes(24));
  }

  /** Monta a URL de autorização do Hosted UI. */
  authorizeUrl(args: { state: string; codeChallenge: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes,
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.domain}/oauth2/authorize?${params.toString()}`;
  }

  /** URL de logout do Cognito, ou `undefined` se `logoutRedirectUri` não configurado. */
  logoutUrl(): string | undefined {
    if (this.logoutRedirectUri === undefined) return undefined;
    const params = new URLSearchParams({
      client_id: this.clientId,
      logout_uri: this.logoutRedirectUri,
    });
    return `${this.domain}/logout?${params.toString()}`;
  }

  /**
   * Troca o authorization code por tokens no endpoint `/oauth2/token`.
   * Server-to-server sobre TLS; o `clientSecret` (se houver) vai no Basic auth.
   * Retorna o dict de tokens, ou `undefined` em qualquer falha (sem vazar detalhe).
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<Record<string, unknown> | undefined> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    }).toString();

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (this.clientSecret !== undefined) {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }

    try {
      const res = await this.withTimeout((signalInit) =>
        this.fetchImpl(`${this.domain}/oauth2/token`, {
          method: 'POST',
          headers,
          body,
          ...signalInit,
        }),
      );
      if (!res.ok) return undefined;
      const parsed: unknown = JSON.parse(await res.text());
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Decodifica o `id_token` (SEM verificar assinatura) e mapeia os claims para
   * `UserContext` (`enduser.id`/`department`/`cost_center`). O token é preservado
   * em `UserContext.token` para propagação downstream. Alimenta `pump.withUser`.
   * Nunca lança — token malformado devolve contexto vazio (anônimo no span).
   */
  userContextFromIdToken(idToken: string | undefined): UserContext {
    if (!isNonEmpty(idToken)) return {};
    const claims = decodeJwtPayload(idToken);
    if (claims === undefined) return {};
    return { ...claimsToUserContext(claims), token: idToken };
  }

  // ─── Handlers Express/Connect (opcionais, sem depender de `express`) ──────

  /**
   * Handlers `(req, res)` compatíveis com Express/Connect para `/auth/login`,
   * `/auth/callback` e `/auth/logout`. Usam `req.session` (express-session) para
   * guardar `state`/PKCE e o `id_token`. Não importam `express` — funcionam com
   * qualquer framework que exponha `req.query`, `req.session` e `res.redirect`.
   */
  expressRoutes(): {
    login: (req: ExpressLikeReq, res: ExpressLikeRes) => void;
    callback: (req: ExpressLikeReq, res: ExpressLikeRes) => Promise<void>;
    logout: (req: ExpressLikeReq, res: ExpressLikeRes) => void;
  } {
    return {
      login: (req, res) => {
        const session = req.session;
        if (session === undefined) return sessionMissing(res);
        const { verifier, challenge } = this.createPkce();
        const state = this.createState();
        session.pumpCognitoState = state;
        session.pumpCognitoVerifier = verifier;
        const next = typeof req.query.next === 'string' && req.query.next.startsWith('/')
          ? req.query.next
          : '/';
        session.pumpCognitoNext = next;
        res.redirect(this.authorizeUrl({ state, codeChallenge: challenge }));
      },

      callback: async (req, res) => {
        const session = req.session;
        if (session === undefined) return sessionMissing(res);

        if (typeof req.query.error === 'string') {
          res.status(400);
          res.redirect('/');
          return;
        }
        const code = typeof req.query.code === 'string' ? req.query.code : undefined;
        const state = typeof req.query.state === 'string' ? req.query.state : undefined;
        const expected = session.pumpCognitoState;
        const verifier = session.pumpCognitoVerifier;
        delete session.pumpCognitoState;
        delete session.pumpCognitoVerifier;

        if (!code || !state || state !== expected || !verifier) {
          res.status(400);
          res.redirect('/');
          return;
        }

        const result = await this.handleCallback({ code, codeVerifier: verifier });
        if (!result.ok) {
          res.status(502);
          res.redirect('/');
          return;
        }
        session.pumpIdToken = result.idToken;
        const next = session.pumpCognitoNext ?? '/';
        delete session.pumpCognitoNext;
        res.redirect(typeof next === 'string' && next.startsWith('/') ? next : '/');
      },

      logout: (req, res) => {
        if (req.session !== undefined) {
          delete req.session.pumpIdToken;
          delete req.session.pumpCognitoState;
          delete req.session.pumpCognitoVerifier;
        }
        res.redirect(this.logoutUrl() ?? '/');
      },
    };
  }

  /**
   * Trata a callback de forma framework-neutra: valida nada de sessão (o chamador
   * já validou o `state`), troca o code e resolve a identidade. Testável sem
   * framework web.
   */
  async handleCallback(args: { code: string; codeVerifier: string }): Promise<CallbackResult> {
    const tokens = await this.exchangeCode(args.code, args.codeVerifier);
    if (tokens === undefined) return { ok: false, reason: 'token_exchange_failed' };
    const idToken = tokens.id_token;
    if (!isNonEmpty(idToken)) return { ok: false, reason: 'no_id_token' };
    return { ok: true, idToken, user: this.userContextFromIdToken(idToken), tokens };
  }

  // ─── Interno ──────────────────────────────────────────────────────────────

  private async withTimeout<T>(
    fn: (signalInit: { signal?: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      return await fn({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Tipos mínimos Express/Connect (sem importar express) ─────────────────────

interface ExpressLikeSession {
  pumpCognitoState?: string;
  pumpCognitoVerifier?: string;
  pumpCognitoNext?: string;
  pumpIdToken?: string;
  [key: string]: unknown;
}

interface ExpressLikeReq {
  query: Record<string, unknown>;
  session?: ExpressLikeSession;
}

interface ExpressLikeRes {
  status: (code: number) => unknown;
  redirect: (url: string) => unknown;
}

function sessionMissing(res: ExpressLikeRes): void {
  res.status(500);
  res.redirect('/');
}

// ─── Decodificação local do payload JWT (sem verificar assinatura) ────────────

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  const payloadSegment = segments[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) return undefined;
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
