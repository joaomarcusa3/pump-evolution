/**
 * CognitoLogin — login de usuário final contra o pool da plataforma.
 *
 * O contrato aqui não é inventado: é exatamente o que o
 * `cta_factory_provisionar_cognito` grava. Ele emite `runtime.cognito` no
 * manifesto (domain, issuer, clientId, redirectUri, scopes, identityProviders,
 * identityProvider, logoutRedirectUri) e o bloco `COGNITO_*` equivalente para o
 * `.env`. Os testes de `fromManifest`/`fromEnv` fixam esses dois formatos — se a
 * plataforma mudar um campo, é aqui que aparece.
 *
 * O `identityProvider` singular merece atenção: a plataforma só o emite quando o
 * pool tem EXATAMENTE UM IdP federado. Com dois ou mais ele é omitido de
 * propósito, porque adivinhar mandaria o usuário para o SSO errado. Então a
 * ausência dele é informação, não esquecimento — e o `authorizeUrl` tem que
 * lidar com os dois casos.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { CognitoLogin, safeNextPath, type AgentManifest } from '../src/index.js';

const DOMAIN = 'https://topaz-cta-dev.auth.us-east-1.amazoncognito.com';
const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_5ppMHdWW7';
const CLIENT_ID = '5o9kpobp3c7kudnvm4onvjpgr0';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function base(extra: Record<string, unknown> = {}) {
  return {
    domain: DOMAIN,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    issuer: ISSUER,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    ...extra,
  } as never;
}

/** Monta um id_token (só o payload importa — o SDK não confere assinatura). */
function idToken(claims: Record<string, unknown>): string {
  const parte = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${parte({ alg: 'RS256' })}.${parte(claims)}.assinatura`;
}

function claimsValidos(extra: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'diego.resta@topazevolution.com',
    'custom:department': 'engineering',
    ...extra,
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

describe('CognitoLogin — config', () => {
  it('lança nomeando os campos que faltam', () => {
    expect(() => new CognitoLogin({ domain: '', clientId: '', redirectUri: '' })).toThrow(
      /domain, clientId, redirectUri/,
    );
  });

  it('fromEnv lê o bloco COGNITO_* que a Factory imprime', () => {
    const login = CognitoLogin.fromEnv({
      COGNITO_DOMAIN: DOMAIN,
      COGNITO_ISSUER: ISSUER,
      COGNITO_CLIENT_ID: CLIENT_ID,
      COGNITO_REDIRECT_URI: REDIRECT,
      COGNITO_SCOPES: 'openid email profile',
      COGNITO_IDENTITY_PROVIDER: 'Microsoft',
    });
    expect(login.issuer).toBe(ISSUER);
    expect(login.authorizeUrl({ state: 's', codeChallenge: 'c' })).toContain(
      'identity_provider=Microsoft',
    );
  });
});

// ─── fromManifest — o caminho preferido ───────────────────────────────────────

function manifesto(cognito?: Record<string, unknown>): AgentManifest {
  return {
    name: 'tpz-cel926-cmdb-jira-assets',
    allowedTools: [],
    ...(cognito !== undefined ? { runtime: { cognito } } : {}),
  } as unknown as AgentManifest;
}

describe('CognitoLogin.fromManifest', () => {
  it('lê runtime.cognito exatamente como a plataforma grava', () => {
    const login = CognitoLogin.fromManifest(
      manifesto({
        domain: DOMAIN,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        scopes: 'openid email profile',
        identityProviders: ['Microsoft'],
        identityProvider: 'Microsoft',
        logoutRedirectUri: 'https://app.exemplo/logout',
      }),
      { env: {} },
    );

    const url = login.authorizeUrl({ state: 'st', codeChallenge: 'ch' });
    expect(url).toContain(`client_id=${CLIENT_ID}`);
    expect(url).toContain('identity_provider=Microsoft');
    expect(login.issuer).toBe(ISSUER);
    expect(login.logoutUrl()).toContain('logout_uri=https%3A%2F%2Fapp.exemplo%2Flogout');
  });

  it('omite identity_provider quando o pool tem mais de um IdP federado', () => {
    // A plataforma NÃO emite o campo singular nesse caso — adivinhar mandaria o
    // usuário para o SSO errado. Sem ele, cai na tela de escolha do Hosted UI.
    const login = CognitoLogin.fromManifest(
      manifesto({
        domain: DOMAIN,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        scopes: 'openid email profile',
        identityProviders: ['Microsoft', 'Google'],
      }),
      { env: {} },
    );
    expect(login.authorizeUrl({ state: 's', codeChallenge: 'c' })).not.toContain(
      'identity_provider',
    );
  });

  it('pega o secret do ambiente — o manifesto é git-safe e nunca o carrega', () => {
    const login = CognitoLogin.fromManifest(
      manifesto({
        domain: DOMAIN,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        scopes: 'openid email profile',
      }),
      { env: { COGNITO_CLIENT_SECRET: 'segredo' } },
    );
    expect(login).toBeInstanceOf(CognitoLogin);
  });

  it('aceita o manifesto ANTIGO, sem issuer — o que está em produção hoje', () => {
    // Validado contra o manifest.yaml real do tpz-cel926-cmdb-jira-assets.
    // Sem issuer a checagem de `iss` não roda; o resto do login funciona igual.
    const login = CognitoLogin.fromManifest(
      manifesto({
        domain: DOMAIN,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        scopes: 'openid email profile',
      }),
      { env: {} },
    );
    expect(login.issuer).toBeUndefined();
    expect(login.authorizeUrl({ state: 's', codeChallenge: 'c' })).toContain('response_type=code');
  });
  it('lança quando o manifesto não tem runtime.cognito, apontando o passo que falta', () => {
    expect(() => CognitoLogin.fromManifest(manifesto(), { env: {} })).toThrow(
      /provisionar_cognito/,
    );
  });
});

// ─── PKCE e authorize ─────────────────────────────────────────────────────────

describe('PKCE', () => {
  it('o challenge é S256(verifier)', () => {
    const login = new CognitoLogin(base());
    const { verifier, challenge } = login.createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

// ─── Redirect pós-login — o achado do open redirect ───────────────────────────

describe('safeNextPath', () => {
  it.each([
    ['/pagina', '/pagina'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['https://evil.com', '/'],
    ['', '/'],
    [undefined, '/'],
  ])('%s → %s', (entrada, esperado) => {
    expect(safeNextPath(entrada)).toBe(esperado);
  });
});

// ─── id_token: iss, aud e exp ─────────────────────────────────────────────────

describe('userContextFromIdToken', () => {
  it('mapeia os claims de custo', () => {
    const login = new CognitoLogin(base());
    const ctx = login.userContextFromIdToken(idToken(claimsValidos()));
    expect(ctx.userId).toBe('diego.resta@topazevolution.com');
    expect(ctx.department).toBe('engineering');
    expect(ctx.token).toBeDefined();
  });

  it('recusa token expirado — sessão longa não pode atribuir span a quem saiu', () => {
    const avisos: string[] = [];
    const login = new CognitoLogin(
      base({ logger: { warn: (m: string) => avisos.push(m) } }),
    );
    const ctx = login.userContextFromIdToken(
      idToken(claimsValidos({ exp: Math.floor(Date.now() / 1000) - 10 })),
    );
    expect(ctx).toEqual({});
    expect(avisos.join(' ')).toContain('expired');
  });

  it('recusa token de outro pool (iss diferente)', () => {
    const login = new CognitoLogin(base());
    const ctx = login.userContextFromIdToken(
      idToken(claimsValidos({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/outro' })),
    );
    expect(ctx).toEqual({});
  });

  it('recusa token emitido para outro App Client (aud diferente)', () => {
    const login = new CognitoLogin(base());
    const ctx = login.userContextFromIdToken(idToken(claimsValidos({ aud: 'outro-client' })));
    expect(ctx).toEqual({});
  });

  it('token malformado devolve contexto vazio, nunca lança', () => {
    const login = new CognitoLogin(base());
    expect(login.userContextFromIdToken('nao-e-um-jwt')).toEqual({});
    expect(login.userContextFromIdToken(undefined)).toEqual({});
  });
});

// ─── Troca de code: o achado da falha muda ────────────────────────────────────

describe('exchangeCode', () => {
  it('manda Basic auth no client confidencial', async () => {
    let headers: Record<string, string> | undefined;
    const login = new CognitoLogin(
      base({
        clientSecret: 'segredo',
        fetchImpl: async (_u: string, init?: { headers?: Record<string, string> }) => {
          headers = init?.headers;
          return { ok: true, status: 200, text: async () => '{"id_token":"x"}' };
        },
      }),
    );
    await login.exchangeCode('code', 'verifier');
    expect(headers?.Authorization).toMatch(/^Basic /);
  });

  it('não manda Basic auth no client público (só PKCE)', async () => {
    let headers: Record<string, string> | undefined;
    const login = new CognitoLogin(
      base({
        fetchImpl: async (_u: string, init?: { headers?: Record<string, string> }) => {
          headers = init?.headers;
          return { ok: true, status: 200, text: async () => '{}' };
        },
      }),
    );
    await login.exchangeCode('code', 'verifier');
    expect(headers?.Authorization).toBeUndefined();
  });

  it('erro HTTP vira motivo E chega no logger — não some em silêncio', async () => {
    const avisos: Array<{ msg: string; meta?: unknown }> = [];
    const login = new CognitoLogin(
      base({
        logger: { warn: (msg: string, meta?: unknown) => avisos.push({ msg, meta }) },
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          text: async () => '{"error":"invalid_client"}',
        }),
      }),
    );
    const r = await login.exchangeCode('code', 'verifier');
    expect(r.ok).toBe(false);
    expect(avisos).toHaveLength(1);
    expect(JSON.stringify(avisos[0])).toContain('invalid_client');
  });
});

// ─── Rotas Express ────────────────────────────────────────────────────────────

interface SessaoFake {
  [k: string]: unknown;
}
function reqRes(query: Record<string, unknown> = {}, session?: SessaoFake) {
  const res = { url: '', code: 0, status(c: number) { this.code = c; return this; }, redirect(u: string) { this.url = u; } };
  return { req: { query, session } as never, res: res as never, ver: res };
}

describe('expressRoutes', () => {
  it('login guarda state/verifier e sanitiza o next', () => {
    const login = new CognitoLogin(base());
    const sessao: SessaoFake = {};
    const { req, res, ver } = reqRes({ next: '//evil.com' }, sessao);
    login.expressRoutes().login(req, res);

    expect(sessao.pumpCognitoState).toBeTypeOf('string');
    expect(sessao.pumpCognitoVerifier).toBeTypeOf('string');
    expect(sessao.pumpCognitoNext).toBe('/'); // não guardou o //evil.com
    expect(ver.url).toContain('/oauth2/authorize?');
  });

  it('callback com state divergente não troca o code e reporta', async () => {
    const avisos: string[] = [];
    const trocou = vi.fn();
    const login = new CognitoLogin(
      base({ logger: { warn: (m: string) => avisos.push(m) }, fetchImpl: trocou }),
    );
    const sessao: SessaoFake = { pumpCognitoState: 'certo', pumpCognitoVerifier: 'v' };
    const { req, res } = reqRes({ code: 'c', state: 'errado' }, sessao);
    await login.expressRoutes().callback(req, res);

    expect(trocou).not.toHaveBeenCalled();
    expect(avisos.join(' ')).toContain('state mismatch');
  });

  it('sucesso guarda o id_token e volta para o next sanitizado', async () => {
    const login = new CognitoLogin(
      base({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id_token: idToken(claimsValidos()) }),
        }),
      }),
    );
    const sessao: SessaoFake = {
      pumpCognitoState: 'st',
      pumpCognitoVerifier: 'v',
      pumpCognitoNext: '//evil.com',
    };
    const { req, res, ver } = reqRes({ code: 'c', state: 'st' }, sessao);
    await login.expressRoutes().callback(req, res);

    expect(sessao.pumpIdToken).toBeTypeOf('string');
    expect(ver.url).toBe('/'); // nunca //evil.com
  });

  it('logout sem logoutRedirectUri avisa que a sessão do Cognito continua viva', () => {
    const avisos: string[] = [];
    const login = new CognitoLogin(base({ logger: { warn: (m: string) => avisos.push(m) } }));
    const sessao: SessaoFake = { pumpIdToken: 'x' };
    const { req, res, ver } = reqRes({}, sessao);
    login.expressRoutes().logout(req, res);

    expect(sessao.pumpIdToken).toBeUndefined();
    expect(ver.url).toBe('/');
    expect(avisos.join(' ')).toContain('Cognito session stays alive');
  });

  it('logout com logoutRedirectUri encerra a sessão no Cognito', () => {
    const login = new CognitoLogin(base({ logoutRedirectUri: 'https://app.exemplo/bye' }));
    const { req, res, ver } = reqRes({}, {});
    login.expressRoutes().logout(req, res);
    expect(ver.url).toContain('/logout?');
  });
});
