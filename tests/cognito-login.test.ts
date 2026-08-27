import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CognitoLogin, type CognitoFetchLike } from '../src/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DOMAIN = 'https://tooling.auth.us-east-1.amazoncognito.com';
const CLIENT_ID = 'app-client-123';
const REDIRECT = 'https://app.example.com/auth/callback';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** An id_token-shaped JWT (unsigned — the SDK decodes without verifying). */
function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none' })}.${b64url(claims)}.`;
}

/** A fetch stub that returns a fixed token response. */
function tokenFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: CognitoFetchLike; seen: () => { url: string; init: unknown } | undefined } {
  let captured: { url: string; init: unknown } | undefined;
  const fetchImpl: CognitoFetchLike = (url, init) => {
    captured = { url, init };
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };
  return { fetchImpl, seen: () => captured };
}

function login(over: Partial<Parameters<typeof CognitoLogin.prototype.constructor>[0]> = {}) {
  return new CognitoLogin({
    domain: DOMAIN,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    fetchImpl: tokenFetch({}).fetchImpl,
    ...over,
  });
}

// ─── Config / fail-closed ─────────────────────────────────────────────────────

describe('CognitoLogin config', () => {
  it('throws with a clear message when required config is missing', () => {
    expect(() => new CognitoLogin({ domain: '', clientId: CLIENT_ID, redirectUri: REDIRECT }))
      .toThrow(/config incompleto \(domain\)/);
  });

  it('fromEnv reads COGNITO_* vars', () => {
    const l = CognitoLogin.fromEnv({
      COGNITO_DOMAIN: DOMAIN,
      COGNITO_CLIENT_ID: CLIENT_ID,
      COGNITO_REDIRECT_URI: REDIRECT,
    });
    const url = l.authorizeUrl({ state: 's', codeChallenge: 'c' });
    expect(url).toContain(`client_id=${CLIENT_ID}`);
  });
});

// ─── PKCE + authorize URL ─────────────────────────────────────────────────────

describe('PKCE and authorize URL', () => {
  it('generates a PKCE pair whose challenge is S256(verifier)', () => {
    const { verifier, challenge } = login().createPkce();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    expect(verifier).not.toContain('=');
  });

  it('builds an authorize URL with code flow + PKCE params', () => {
    const url = new URL(login().authorizeUrl({ state: 'st8', codeChallenge: 'chal' }));
    expect(url.origin + url.pathname).toBe(`${DOMAIN}/oauth2/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('logoutUrl is undefined without logoutRedirectUri and set with it', () => {
    expect(login().logoutUrl()).toBeUndefined();
    const l = login({ logoutRedirectUri: 'https://app.example.com/' });
    expect(l.logoutUrl()).toContain('/logout?');
  });
});

// ─── Token exchange ───────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('sends Basic auth for a confidential client and returns tokens', async () => {
    const f = tokenFetch({ id_token: 'tok', access_token: 'a' });
    const l = login({ clientSecret: 'shh', fetchImpl: f.fetchImpl });

    const tokens = await l.exchangeCode('the-code', 'the-verifier');

    expect(tokens).toEqual({ id_token: 'tok', access_token: 'a' });
    const seen = f.seen()!;
    expect(seen.url).toBe(`${DOMAIN}/oauth2/token`);
    const headers = (seen.init as { headers: Record<string, string> }).headers;
    const expectedBasic = Buffer.from(`${CLIENT_ID}:shh`).toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
  });

  it('omits Basic auth for a public client (PKCE only)', async () => {
    const f = tokenFetch({ id_token: 'tok' });
    await login({ fetchImpl: f.fetchImpl }).exchangeCode('c', 'v');
    const headers = (f.seen()!.init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns undefined on non-2xx and never throws', async () => {
    const f = tokenFetch({ error: 'invalid_grant' }, { ok: false, status: 400 });
    expect(await login({ fetchImpl: f.fetchImpl }).exchangeCode('c', 'v')).toBeUndefined();
  });
});

// ─── Identity mapping ─────────────────────────────────────────────────────────

describe('userContextFromIdToken', () => {
  it('maps Cognito custom claims to UserContext and preserves the token', () => {
    const tok = idToken({
      email: 'ana@acme.com',
      'custom:department': 'Engenharia',
      'custom:cost_center': 'CC-42',
    });
    const ctx = login().userContextFromIdToken(tok);
    expect(ctx).toEqual({
      userId: 'ana@acme.com',
      department: 'Engenharia',
      costCenter: 'CC-42',
      token: tok,
    });
  });

  it('falls back to custom:topaz_directorate for department', () => {
    const ctx = login().userContextFromIdToken(
      idToken({ email: 'x@y.com', 'custom:topaz_directorate': 'Diretoria X' }),
    );
    expect(ctx.department).toBe('Diretoria X');
  });

  it('reads custom:cta_cost_center (the claim the platform pool emits)', () => {
    const ctx = login().userContextFromIdToken(
      idToken({ email: 'x@y.com', 'custom:cta_cost_center': 'CC-99' }),
    );
    expect(ctx.costCenter).toBe('CC-99');
  });

  it('returns an empty context (anonymous) for a malformed token', () => {
    expect(login().userContextFromIdToken('not-a-jwt')).toEqual({});
    expect(login().userContextFromIdToken(undefined)).toEqual({});
  });
});

// ─── handleCallback ───────────────────────────────────────────────────────────

describe('handleCallback', () => {
  it('resolves identity on a successful exchange', async () => {
    const f = tokenFetch({ id_token: idToken({ email: 'ana@acme.com' }) });
    const res = await login({ fetchImpl: f.fetchImpl }).handleCallback({
      code: 'c',
      codeVerifier: 'v',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.userId).toBe('ana@acme.com');
  });

  it('fails closed when the exchange fails', async () => {
    const f = tokenFetch({}, { ok: false, status: 500 });
    const res = await login({ fetchImpl: f.fetchImpl }).handleCallback({ code: 'c', codeVerifier: 'v' });
    expect(res).toEqual({ ok: false, reason: 'token_exchange_failed' });
  });

  it('fails when the response has no id_token', async () => {
    const f = tokenFetch({ access_token: 'a' });
    const res = await login({ fetchImpl: f.fetchImpl }).handleCallback({ code: 'c', codeVerifier: 'v' });
    expect(res).toEqual({ ok: false, reason: 'no_id_token' });
  });
});

// ─── Express-style routes ─────────────────────────────────────────────────────

interface FakeSession {
  [key: string]: unknown;
}
function fakeRes() {
  return {
    statusCode: 200,
    location: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    redirect(url: string) {
      this.location = url;
      return this;
    },
  };
}

describe('expressRoutes', () => {
  it('login stores state + verifier in the session and redirects to the Hosted UI', () => {
    const session: FakeSession = {};
    const res = fakeRes();
    login().expressRoutes().login({ query: {}, session }, res);

    expect(session.pumpCognitoState).toBeTypeOf('string');
    expect(session.pumpCognitoVerifier).toBeTypeOf('string');
    expect(res.location).toContain('/oauth2/authorize?');
    expect(res.location).toContain(`state=${session.pumpCognitoState as string}`);
  });

  it('callback rejects a mismatched state with a 400 redirect and does not exchange', async () => {
    const f = tokenFetch({ id_token: 'x' });
    const routes = login({ fetchImpl: f.fetchImpl }).expressRoutes();
    const session: FakeSession = { pumpCognitoState: 'right', pumpCognitoVerifier: 'v' };
    const res = fakeRes();

    await routes.callback({ query: { code: 'c', state: 'WRONG' }, session }, res);

    expect(res.statusCode).toBe(400);
    expect(f.seen()).toBeUndefined();
    expect(session.pumpIdToken).toBeUndefined();
  });

  it('callback stores the id_token on success and redirects to next', async () => {
    const f = tokenFetch({ id_token: idToken({ email: 'ana@acme.com' }) });
    const routes = login({ fetchImpl: f.fetchImpl }).expressRoutes();
    const session: FakeSession = {
      pumpCognitoState: 'st',
      pumpCognitoVerifier: 'v',
      pumpCognitoNext: '/dashboard',
    };
    const res = fakeRes();

    await routes.callback({ query: { code: 'c', state: 'st' }, session }, res);

    expect(session.pumpIdToken).toBeTypeOf('string');
    expect(res.location).toBe('/dashboard');
  });

  it('login without a session responds 500', () => {
    const res = fakeRes();
    login().expressRoutes().login({ query: {} }, res);
    expect(res.statusCode).toBe(500);
  });
});
