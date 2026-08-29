/**
 * cognito-login — OAuth2 login (Authorization Code + PKCE) against the
 * platform's end-user Cognito pool.
 *
 * ## Why this exists
 *
 * The old guidance was "don't touch the agent's Cognito — the SDK just reads the
 * `id_token` it already has". But almost no customer pool carried the cost
 * claims (`custom:department`, `custom:cost_center`), so spans came out with the
 * right user and NO department — losing the cost attribution that is the whole
 * reason governance exists.
 *
 * The answer: the end-user pool lives in the platform, with the cost claims
 * governed by us, and each component gets its own App Client. The client is
 * provisioned at install time by the Factory
 * (`cta_factory_provisionar_cognito`), which writes `runtime.cognito` into the
 * manifest and hands back the matching `COGNITO_*` variables. This module is the
 * consumer of that contract — it never provisions anything.
 *
 * ## Two identities that never cross
 *
 * This is the login of the PEOPLE who use the component. The telemetry service
 * account (`PumpEvolution.init`, `client_credentials`) authenticates the PROCESS.
 * A `client_credentials` token has no user, therefore no department — which is
 * exactly why this second identity had to exist.
 *
 * ## Usage
 *
 * From the manifest, which is where the Factory writes everything (preferred —
 * nothing to copy by hand, and no secret in git):
 *
 *     const login = CognitoLogin.fromManifest('./manifest.yaml');
 *
 * Or from the environment, when the app already keeps its config there:
 *
 *     const login = CognitoLogin.fromEnv();
 *
 * With the ready-made routes (Express + express-session):
 *
 *     const routes = login.expressRoutes();
 *     app.get('/auth/login', routes.login);
 *     app.get('/auth/callback', routes.callback);
 *     app.get('/auth/logout', routes.logout);
 *
 * Then, per request, propagate the logged-in identity to the spans:
 *
 *     await pump.withUser(login.userContextFromIdToken(req.session.pumpIdToken), () => handler());
 *
 * With the primitives, for any framework:
 *
 *     const { verifier, challenge } = login.createPkce();
 *     const state = login.createState();
 *     // keep verifier+state in your session, redirect to:
 *     login.authorizeUrl({ state, codeChallenge: challenge });
 *     // in the callback, check the state and exchange the code:
 *     const result = await login.handleCallback({ code, codeVerifier: verifier });
 *
 * ## Security
 *
 * - PKCE (S256) always, plus `state` — protects against code interception and CSRF.
 * - `clientSecret` only in the Basic auth of the token exchange (server-to-server,
 *   over TLS). A public client (the platform default) has none.
 * - The `id_token` is decoded WITHOUT signature verification, which is the
 *   standard allowance for a token obtained directly from the token endpoint over
 *   TLS (OIDC Core 3.1.3.7). `iss`, `aud` and `exp` ARE checked — those are cheap
 *   and catch a stale session, which signature validation would not. To verify a
 *   token that arrives from a CALLER, use `ConsumerTokenVerifier` (RS256 + JWKS).
 * - Post-login redirects are restricted to same-site paths. `//evil.com` and
 *   `/\evil.com` are rejected, not just `https://evil.com` — a protocol-relative
 *   URL starts with `/` and would otherwise pass a naive check.
 *
 * CONFIG errors throw at boot (init-time, like the rest of the SDK). Runtime
 * failures return `{ ok: false, reason }` AND report through the injected logger —
 * login is critical, it does not degrade silently the way telemetry does.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { claimsToUserContext } from './identity-context.js';
import { loadManifest } from './manifest-loader.js';
import type { AgentManifest, ManifestCognito, TelemetryLogger, UserContext } from './types.js';

// ─── Injectable fetch (parity with consumer-auth / token-provider) ─────────────

/** Minimal `fetch` for the token exchange, injectable for tests. */
export type CognitoFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const DEFAULT_SCOPES = 'openid email profile';
const TOKEN_TIMEOUT_MS = 10_000;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface CognitoLoginConfig {
  /** Hosted UI domain, e.g. `https://<prefix>.auth.<region>.amazoncognito.com`. */
  readonly domain: string;
  /** App Client provisioned for this component (Factory API). */
  readonly clientId: string;
  /** Absolute callback URL, registered on the App Client. */
  readonly redirectUri: string;
  /**
   * Token issuer (`https://cognito-idp.<region>.amazonaws.com/<poolId>`).
   * Optional, but when given the `iss` claim of the `id_token` is checked
   * against it — a token from another pool is rejected instead of silently
   * becoming the span's identity.
   */
  readonly issuer?: string;
  /** Secret of a confidential App Client. Omitted for a public client (PKCE only). */
  readonly clientSecret?: string;
  /** OAuth scopes. Defaults to `openid email profile`. */
  readonly scopes?: string;
  /** Where to return after the Cognito logout. */
  readonly logoutRedirectUri?: string;
  /**
   * Federated provider to send to `/oauth2/authorize`, so the user lands on the
   * SSO and skips the username/password screen.
   *
   * The platform only fills this when the pool has EXACTLY ONE federated
   * provider — with two or more, guessing would send people to the wrong SSO.
   * Absence is therefore meaningful: fall back to the Hosted UI picker.
   */
  readonly identityProvider?: string;
  /** Injectable `fetch` (defaults to the global one, Node 18+). */
  readonly fetchImpl?: CognitoFetchLike;
  /**
   * Where login failures are reported. Without it a failed exchange is a 302 to
   * `/` and nothing else — the operator sees a redirect indistinguishable from
   * success.
   */
  readonly logger?: TelemetryLogger;
  /** Injectable clock, for testing the `exp` check. */
  readonly now?: () => number;
}

/** PKCE pair — verifier stays in the session, challenge goes in the authorize URL. */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** Framework-neutral result of handling the callback. */
export type CallbackResult =
  | {
      readonly ok: true;
      readonly idToken: string;
      readonly user: UserContext;
      readonly tokens: Record<string, unknown>;
    }
  | { readonly ok: false; readonly reason: string };

function base64UrlNoPad(buf: Buffer): string {
  return buf.toString('base64url');
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Constant-time comparison of the `state`. The value is single-use and
 * session-bound, so a timing attack is far-fetched — but the comparison is
 * against attacker-supplied input, and `timingSafeEqual` costs nothing here.
 */
function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Post-login destination, restricted to a same-site path.
 *
 * `startsWith('/')` alone is NOT enough: `//evil.com` and `/\evil.com` both pass
 * it, and browsers read them as protocol-relative URLs — an open redirect on an
 * ALREADY-AUTHENTICATED user, which is the worst moment for one.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

// ─── CognitoLogin ─────────────────────────────────────────────────────────────

export class CognitoLogin {
  private readonly domain: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly issuerValue: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly scopes: string;
  private readonly logoutRedirectUri: string | undefined;
  private readonly identityProvider: string | undefined;
  private readonly fetchImpl: CognitoFetchLike;
  private readonly logger: TelemetryLogger | undefined;
  private readonly now: () => number;

  constructor(config: CognitoLoginConfig) {
    const missing = (['domain', 'clientId', 'redirectUri'] as const).filter(
      (k) => !isNonEmpty(config[k]),
    );
    if (missing.length > 0) {
      throw new Error(
        `[pump-evolution] CognitoLogin: incomplete config (${missing.join(', ')}). ` +
          'These values come from provisioning the App Client (Factory API) and land in ' +
          '`runtime.cognito` of the manifest or in the app `.env`. No default is applied.',
      );
    }
    const resolvedFetch = config.fetchImpl ?? (globalThis.fetch as CognitoFetchLike | undefined);
    if (resolvedFetch === undefined) {
      throw new Error('[pump-evolution] CognitoLogin: no `fetch` available (provide fetchImpl).');
    }
    this.domain = config.domain.replace(/\/$/, '');
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.issuerValue = config.issuer;
    this.clientSecret = config.clientSecret;
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
    this.logoutRedirectUri = config.logoutRedirectUri;
    this.identityProvider = config.identityProvider;
    this.fetchImpl = resolvedFetch;
    this.logger = config.logger;
    this.now = config.now ?? Date.now;
  }

  /**
   * Builds from `runtime.cognito` in the manifest — the block the Factory writes
   * when it provisions the App Client. Preferred over {@link fromEnv}: nothing is
   * copied by hand, and the block is git-safe (the platform never writes a secret
   * there).
   *
   * A confidential client still needs its secret from the environment, so
   * `COGNITO_CLIENT_SECRET` is read as an override when present.
   *
   * @param manifest Path to `manifest.yaml`, or an already-loaded manifest.
   */
  static fromManifest(
    manifest: string | AgentManifest,
    overrides: Partial<CognitoLoginConfig> & {
      readonly env?: Record<string, string | undefined>;
    } = {},
  ): CognitoLogin {
    const loaded = typeof manifest === 'string' ? loadManifest(manifest) : manifest;
    const cognito: ManifestCognito | undefined = loaded.runtime?.cognito;
    if (cognito === undefined) {
      throw new Error(
        '[pump-evolution] CognitoLogin.fromManifest: the manifest has no `runtime.cognito`. ' +
          'Provision the login App Client first (Factory: `cta_factory_provisionar_cognito`), ' +
          'which writes that block. No default is applied.',
      );
    }
    const env = overrides.env ?? process.env;
    const { env: _ignored, ...rest } = overrides;
    return new CognitoLogin({
      domain: cognito.domain,
      clientId: cognito.clientId,
      redirectUri: cognito.redirectUri,
      ...(cognito.issuer !== undefined ? { issuer: cognito.issuer } : {}),
      ...(cognito.scopes !== undefined ? { scopes: cognito.scopes } : {}),
      ...(cognito.identityProvider !== undefined
        ? { identityProvider: cognito.identityProvider }
        : {}),
      ...(cognito.logoutRedirectUri !== undefined
        ? { logoutRedirectUri: cognito.logoutRedirectUri }
        : {}),
      // The manifest never carries the secret — a confidential client reads it
      // from the environment, same as the telemetry service account.
      ...(isNonEmpty(env.COGNITO_CLIENT_SECRET)
        ? { clientSecret: env.COGNITO_CLIENT_SECRET }
        : {}),
      ...rest,
    });
  }

  /**
   * Builds from the `COGNITO_*` variables — the same block the Factory prints
   * after provisioning. Required: `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`,
   * `COGNITO_REDIRECT_URI`. Optional: `COGNITO_ISSUER`, `COGNITO_CLIENT_SECRET`,
   * `COGNITO_SCOPES`, `COGNITO_IDENTITY_PROVIDER`, `COGNITO_LOGOUT_REDIRECT_URI`.
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    overrides: Partial<CognitoLoginConfig> = {},
  ): CognitoLogin {
    return new CognitoLogin({
      domain: env.COGNITO_DOMAIN ?? '',
      clientId: env.COGNITO_CLIENT_ID ?? '',
      redirectUri: env.COGNITO_REDIRECT_URI ?? '',
      ...(env.COGNITO_ISSUER ? { issuer: env.COGNITO_ISSUER } : {}),
      ...(env.COGNITO_CLIENT_SECRET ? { clientSecret: env.COGNITO_CLIENT_SECRET } : {}),
      ...(env.COGNITO_SCOPES ? { scopes: env.COGNITO_SCOPES } : {}),
      ...(env.COGNITO_IDENTITY_PROVIDER
        ? { identityProvider: env.COGNITO_IDENTITY_PROVIDER }
        : {}),
      ...(env.COGNITO_LOGOUT_REDIRECT_URI
        ? { logoutRedirectUri: env.COGNITO_LOGOUT_REDIRECT_URI }
        : {}),
      ...overrides,
    });
  }

  /** Token issuer, when configured. Useful to wire a `ConsumerTokenVerifier`. */
  get issuer(): string | undefined {
    return this.issuerValue;
  }

  // ─── Primitives ─────────────────────────────────────────────────────────

  /** Generates a PKCE pair (random verifier + S256 challenge). */
  createPkce(): Pkce {
    const verifier = base64UrlNoPad(randomBytes(32));
    const challenge = base64UrlNoPad(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  /** Generates an opaque `state` for CSRF protection on the callback. */
  createState(): string {
    return base64UrlNoPad(randomBytes(24));
  }

  /**
   * Builds the Hosted UI authorization URL. When `identityProvider` is known,
   * `identity_provider` goes along and the user lands straight on the SSO.
   */
  authorizeUrl(args: { state: string; codeChallenge: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes,
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
      ...(this.identityProvider !== undefined
        ? { identity_provider: this.identityProvider }
        : {}),
    });
    return `${this.domain}/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Cognito logout URL, or `undefined` when `logoutRedirectUri` is not set.
   *
   * Without it there is no Cognito logout at all: clearing the local session
   * leaves the Cognito session alive, and the next `/auth/login` re-authenticates
   * with no prompt — the user swears they logged out. The routes below warn
   * through the logger when they hit that case.
   */
  logoutUrl(): string | undefined {
    if (this.logoutRedirectUri === undefined) return undefined;
    const params = new URLSearchParams({
      client_id: this.clientId,
      logout_uri: this.logoutRedirectUri,
    });
    return `${this.domain}/logout?${params.toString()}`;
  }

  /**
   * Exchanges the authorization code for tokens at `/oauth2/token`.
   * Server-to-server over TLS; the `clientSecret` (when there is one) goes in
   * Basic auth. Returns `{ ok: false, reason }` on failure — and reports the
   * reason through the logger, because a swallowed 401 here looks exactly like a
   * network blip.
   */
  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<
    { readonly ok: true; readonly tokens: Record<string, unknown> } | { readonly ok: false; readonly reason: string }
  > {
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
      if (!res.ok) {
        // The body carries Cognito's `error`/`error_description`, which is what
        // tells apart a bad secret from a redirect_uri mismatch. It never
        // contains the secret itself — the secret travels in the request header.
        const detail = await res.text().catch(() => '');
        const reason = `token endpoint returned HTTP ${res.status}`;
        this.report(reason, { status: res.status, detail: detail.slice(0, 300) });
        return { ok: false, reason };
      }
      const parsed: unknown = JSON.parse(await res.text());
      if (typeof parsed !== 'object' || parsed === null) {
        const reason = 'token endpoint returned a non-object payload';
        this.report(reason);
        return { ok: false, reason };
      }
      return { ok: true, tokens: parsed as Record<string, unknown> };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.report('token exchange failed', { error: reason });
      return { ok: false, reason };
    }
  }

  /**
   * Decodes the `id_token` (no signature check — see the Security note at the
   * top) and maps the claims to a `UserContext`. `iss`, `aud` and `exp` ARE
   * validated: an expired token in a long-lived session would otherwise keep
   * attributing spans to someone who logged out hours ago.
   *
   * Never throws — a malformed or expired token yields an empty context, which
   * the span records as anonymous rather than as a fabricated user.
   */
  userContextFromIdToken(idToken: string | undefined): UserContext {
    if (!isNonEmpty(idToken)) return {};
    const claims = decodeJwtPayload(idToken);
    if (claims === undefined) {
      this.report('id_token could not be decoded');
      return {};
    }
    const problem = this.checkClaims(claims);
    if (problem !== undefined) {
      this.report(`id_token rejected: ${problem}`);
      return {};
    }
    return { ...claimsToUserContext(claims), token: idToken };
  }

  /**
   * Handles the callback framework-neutrally: the caller has already checked the
   * `state`. Exchanges the code and resolves the identity.
   */
  async handleCallback(args: { code: string; codeVerifier: string }): Promise<CallbackResult> {
    const exchanged = await this.exchangeCode(args.code, args.codeVerifier);
    if (!exchanged.ok) return { ok: false, reason: exchanged.reason };
    const idToken = exchanged.tokens.id_token;
    if (!isNonEmpty(idToken)) {
      const reason = 'token response has no id_token';
      this.report(reason);
      return { ok: false, reason };
    }
    return {
      ok: true,
      idToken,
      user: this.userContextFromIdToken(idToken),
      tokens: exchanged.tokens,
    };
  }

  // ─── Express/Connect handlers (optional, without depending on `express`) ──

  /**
   * `(req, res)` handlers compatible with Express/Connect for `/auth/login`,
   * `/auth/callback` and `/auth/logout`. They use `req.session`
   * (express-session) to hold `state`/PKCE and the `id_token`. `express` is not
   * imported — anything exposing `req.query`, `req.session` and `res.redirect`
   * works.
   */
  expressRoutes(): {
    login: (req: ExpressLikeReq, res: ExpressLikeRes) => void;
    callback: (req: ExpressLikeReq, res: ExpressLikeRes) => Promise<void>;
    logout: (req: ExpressLikeReq, res: ExpressLikeRes) => void;
  } {
    return {
      login: (req, res) => {
        const session = req.session;
        if (session === undefined) return this.sessionMissing(res);
        const { verifier, challenge } = this.createPkce();
        const state = this.createState();
        session.pumpCognitoState = state;
        session.pumpCognitoVerifier = verifier;
        session.pumpCognitoNext = safeNextPath(req.query.next);
        res.redirect(this.authorizeUrl({ state, codeChallenge: challenge }));
      },

      callback: async (req, res) => {
        const session = req.session;
        if (session === undefined) return this.sessionMissing(res);

        const expected = session.pumpCognitoState;
        const verifier = session.pumpCognitoVerifier;
        // Single-use: cleared before any early return, so a replayed callback
        // cannot reuse them.
        delete session.pumpCognitoState;
        delete session.pumpCognitoVerifier;

        if (typeof req.query.error === 'string') {
          return this.failCallback(req, res, `authorize returned error=${req.query.error}`);
        }
        const code = typeof req.query.code === 'string' ? req.query.code : undefined;
        const state = typeof req.query.state === 'string' ? req.query.state : undefined;
        if (!code || !state || !expected || !verifier) {
          return this.failCallback(req, res, 'callback missing code/state or session data');
        }
        if (!sameState(state, expected)) {
          return this.failCallback(req, res, 'state mismatch (possible CSRF)');
        }

        const result = await this.handleCallback({ code, codeVerifier: verifier });
        if (!result.ok) {
          return this.failCallback(req, res, result.reason);
        }
        session.pumpIdToken = result.idToken;
        const next = safeNextPath(session.pumpCognitoNext);
        delete session.pumpCognitoNext;
        res.redirect(next);
      },

      logout: (req, res) => {
        if (req.session !== undefined) {
          delete req.session.pumpIdToken;
          delete req.session.pumpCognitoState;
          delete req.session.pumpCognitoVerifier;
          delete req.session.pumpCognitoNext;
        }
        const url = this.logoutUrl();
        if (url === undefined) {
          this.report(
            'logout only cleared the local session: no logoutRedirectUri configured, so the ' +
              'Cognito session stays alive and the next login will not prompt',
          );
          res.redirect('/');
          return;
        }
        res.redirect(url);
      },
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Validates the claims the SDK can check without the signature. Returns the
   * problem, or `undefined` when the token is acceptable.
   */
  private checkClaims(claims: Record<string, unknown>): string | undefined {
    if (this.issuerValue !== undefined && claims.iss !== this.issuerValue) {
      return 'iss does not match the configured issuer';
    }
    const aud = claims.aud;
    const audMatches =
      aud === undefined
        ? true
        : typeof aud === 'string'
          ? aud === this.clientId
          : Array.isArray(aud) && aud.includes(this.clientId);
    if (!audMatches) return 'aud does not match the App Client';
    const exp = claims.exp;
    if (typeof exp === 'number' && exp * 1000 <= this.now()) return 'expired';
    return undefined;
  }

  /** Reports a login problem. Silent only when no logger was provided. */
  private report(message: string, meta?: Record<string, unknown>): void {
    try {
      this.logger?.warn?.(`[pump-evolution] CognitoLogin: ${message}`, meta);
    } catch {
      // A broken logger must not break the login flow.
    }
  }

  private failCallback(req: ExpressLikeReq, res: ExpressLikeRes, reason: string): void {
    this.report(`login failed: ${reason}`);
    const next = safeNextPath(req.session?.pumpCognitoNext);
    if (req.session !== undefined) delete req.session.pumpCognitoNext;
    // Express's `redirect` overrides any status set beforehand, so the status is
    // not what carries the failure — the logger is. The user goes back to the
    // entry point rather than to a blank page.
    res.redirect(next);
  }

  private sessionMissing(res: ExpressLikeRes): void {
    this.report('no `req.session`: express-session (or equivalent) is required');
    res.status(500);
    res.redirect('/');
  }

  private async withTimeout<T>(fn: (signalInit: { signal?: AbortSignal }) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      return await fn({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Minimal Express/Connect types (without importing express) ────────────────

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

// ─── Local JWT payload decoding (no signature check) ──────────────────────────

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
