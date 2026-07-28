/**
 * token-provider — obtains and caches the service-account bearer token used to
 * authenticate OTLP export (Requirement 7.2).
 *
 * The token is minted via the OAuth 2.0 **client-credentials** grant against the
 * configured `tokenUrl` (a Cognito `/oauth2/token` endpoint in the CTA
 * deployment — the Resource Server + app client are provisioned by Task 8.2's
 * Terraform, which does not exist yet; this client side is standard OAuth and is
 * implementable independently). Credentials are sent as HTTP Basic auth, the
 * standard Cognito client-credentials style.
 *
 * The token is cached and proactively refreshed a configurable skew before it
 * expires, and concurrent refreshes are de-duplicated behind a single in-flight
 * promise. `fetch` is injectable for testing (defaults to the global `fetch`,
 * available on Node 18+). This module never logs and never throws to the agent
 * flow beyond returning a rejected promise the exporter handles.
 *
 * Security: the client secret lives only in the agent's environment/config, is
 * used solely to build the Basic auth header, and is never logged or attached to
 * telemetry (design "Security Considerations").
 */

// ─── Public config ──────────────────────────────────────────────────────────

/** A minimal structural subset of the global `fetch`, for injection in tests. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** Dependencies for {@link ServiceAccountTokenProvider}. */
export interface ServiceAccountTokenProviderDeps {
  /** OAuth token endpoint (Cognito `/oauth2/token`). */
  readonly tokenUrl: string;
  /** App client id. */
  readonly clientId: string;
  /** App client secret (from the environment — never the manifest). */
  readonly clientSecret: string;
  /** OAuth scope requested. Default `telemetry:write`. */
  readonly scope?: string;
  /** Milliseconds before expiry to refresh proactively. Default 60s. */
  readonly refreshSkewMs?: number;
  /** Injectable `fetch`. Default global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Injectable clock (ms). Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Default OAuth scope for the telemetry receiver.
 *
 * Cognito exige o scope **qualificado pelo resource server** no pedido de token
 * client-credentials: `<resourceServerIdentifier>/<scopeName>`. No CTA o resource
 * server é `telemetry` e o scope `telemetry:write` → `telemetry/telemetry:write`.
 * O receiver (`serviceAccountAuthMiddleware`) valida via `endsWith('/telemetry:write')`,
 * então o token qualificado é aceito. Pedir o scope bare (`telemetry:write`) resulta
 * em 400 invalid_scope no Cognito. Sobrescreva via `deps.scope` para outro resource server.
 */
export const DEFAULT_TELEMETRY_SCOPE = 'telemetry/telemetry:write' as const;

// ─── Narrowing ────────────────────────────────────────────────────────────────

interface ParsedTokenResponse {
  readonly accessToken: string;
  readonly expiresInSec: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parses the OAuth token response, requiring a non-empty `access_token`. */
function parseTokenResponse(body: string): ParsedTokenResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('[pump-evolution] token endpoint returned a non-JSON response.');
  }
  if (!isRecord(parsed)) {
    throw new Error('[pump-evolution] token endpoint returned an unexpected payload.');
  }
  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
  if (accessToken.length === 0) {
    throw new Error('[pump-evolution] token endpoint response missing `access_token`.');
  }
  // `expires_in` is seconds per RFC 6749; default to 1h when the IdP omits it.
  const expiresInSec =
    typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
      ? parsed.expires_in
      : 3600;
  return { accessToken, expiresInSec };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

interface CachedToken {
  readonly value: string;
  /** Absolute epoch-ms at which the token should be considered expired. */
  readonly refreshAt: number;
}

/**
 * Caches a client-credentials bearer token and refreshes it before expiry.
 */
export class ServiceAccountTokenProvider {
  private readonly tokenUrl: string;
  private readonly basicAuth: string;
  private readonly scope: string;
  private readonly refreshSkewMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(deps: ServiceAccountTokenProviderDeps) {
    this.tokenUrl = deps.tokenUrl;
    this.basicAuth = Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString('base64');
    this.scope = deps.scope ?? DEFAULT_TELEMETRY_SCOPE;
    this.refreshSkewMs = deps.refreshSkewMs ?? 60_000;
    const resolvedFetch = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (resolvedFetch === undefined) {
      throw new Error(
        '[pump-evolution] no `fetch` available: provide `fetchImpl` or run on Node 18+.',
      );
    }
    this.fetchImpl = resolvedFetch;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Returns a valid bearer token, minting/refreshing as needed. Concurrent
   * callers during a refresh share the same in-flight request.
   */
  async getToken(): Promise<string> {
    const current = this.cached;
    if (current !== undefined && this.now() < current.refreshAt) return current.value;
    this.inFlight ??= this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async refresh(): Promise<string> {
    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(this.scope)}`,
    });

    if (!response.ok) {
      throw new Error(
        `[pump-evolution] token endpoint responded ${String(response.status)} for client-credentials grant.`,
      );
    }

    const { accessToken, expiresInSec } = parseTokenResponse(await response.text());
    const refreshAt = this.now() + Math.max(0, expiresInSec * 1000 - this.refreshSkewMs);
    this.cached = { value: accessToken, refreshAt };
    return accessToken;
  }
}
