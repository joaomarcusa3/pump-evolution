/**
 * consumer-auth — verifica o **Bearer JWT de QUEM CHAMA** o agente/MCP contra o
 * JWKS do IdP (Cognito), conferindo assinatura (RS256), issuer, audience e
 * expiração. É o "protege o consumo" que o `_sdk-externo` só declarava
 * (consumer-auth.json) — aqui vira código, reutilizável por agente E por MCP.
 *
 * Concern SEPARADO da telemetria: NÃO faz parte do `PumpHandle`. O dono do
 * agente/MCP chama `ConsumerTokenVerifier.verify(bearer)` na BORDA HTTP, antes de
 * executar a tool/invocação; se ok, mapeia os claims para `UserContext`
 * (`claimsToUserContext`) e propaga via `pump.withUser`.
 *
 * ── Invariantes (zero-trust, fail-closed) ────────────────────────────────────
 *  - Só RS256 (o que o Cognito emite). `alg: none`/HS* → REJEITADO.
 *  - Assinatura verificada contra o JWK do `kid` do header (via `node:crypto`,
 *    sem dependência externa — mantém o SDK leve).
 *  - `iss` deve bater; `exp` (com tolerância de clock) obrigatório; `aud`/
 *    `client_id` deve bater com `audience` quando configurado.
 *  - Nunca lança para o fluxo do chamador: retorna `Result` (`ok:false` + motivo).
 *  - JWKS em cache com TTL; `kid` desconhecido dispara UM refetch (chave rotacionada).
 */

import {
  createPublicKey,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import { claimsToUserContext, withUser } from "./identity-context.js";
import type { UserContext } from "./types.js";

// ─── Config & tipos ─────────────────────────────────────────────────────────

/** `fetch` mínimo (GET do JWKS), injetável para testes. Default: global `fetch`. */
export type JwksFetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ConsumerAuthConfig {
  /** Issuer esperado (Cognito: `https://cognito-idp.<region>.amazonaws.com/<poolId>`). */
  readonly issuer: string;
  /** URI do JWKS. Default: `${issuer}/.well-known/jwks.json`. */
  readonly jwksUri?: string;
  /**
   * Audience esperado (o `client_id` do app). Access tokens do Cognito não têm
   * `aud` — trazem `client_id`; ID tokens têm `aud`. Quando definido, aceita se
   * `aud` OU `client_id` bater. Ausente = não confere audience (não recomendado).
   */
  readonly audience?: string;
  /** Tolerância de relógio em segundos (default 60). */
  readonly clockToleranceSec?: number;
  /** TTL do cache de JWKS em ms (default 10 min). */
  readonly jwksCacheTtlMs?: number;
  /** `fetch` injetável (default global `fetch`, Node 18+). */
  readonly fetchImpl?: JwksFetchLike;
  /** Relógio injetável (ms). Default `Date.now`. */
  readonly now?: () => number;
}

/** Resultado da verificação — nunca lança para o chamador. */
export type ConsumerAuthResult =
  | { readonly ok: true; readonly claims: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

interface Jwk {
  readonly kid: string;
  readonly kty: string;
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
}

// ─── Narrowing helpers ──────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function decodeSegment(seg: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(seg, "base64url").toString("utf8"),
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJwks(payload: unknown): Jwk[] {
  if (!isRecord(payload) || !Array.isArray(payload.keys)) return [];
  const keys: Jwk[] = [];
  for (const k of payload.keys) {
    if (!isRecord(k)) continue;
    const kid = readString(k.kid);
    const kty = readString(k.kty);
    const n = readString(k.n);
    const e = readString(k.e);
    if (
      kid !== undefined &&
      kty === "RSA" &&
      n !== undefined &&
      e !== undefined
    ) {
      const alg = readString(k.alg);
      keys.push(
        alg !== undefined ? { kid, kty, n, e, alg } : { kid, kty, n, e },
      );
    }
  }
  return keys;
}

// ─── Verifier ────────────────────────────────────────────────────────────────

/** Verifica Bearer JWTs (RS256) contra o JWKS do IdP. Reusável por agente e MCP. */
export class ConsumerTokenVerifier {
  private readonly issuer: string;
  private readonly jwksUri: string;
  private readonly audience: string | undefined;
  private readonly clockToleranceSec: number;
  private readonly jwksCacheTtlMs: number;
  private readonly fetchImpl: JwksFetchLike;
  private readonly now: () => number;

  private cache:
    | { keys: Map<string, KeyObject>; fetchedAt: number }
    | undefined;
  private inFlight: Promise<Map<string, KeyObject>> | undefined;

  constructor(config: ConsumerAuthConfig) {
    this.issuer = config.issuer;
    this.jwksUri =
      config.jwksUri ??
      `${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
    this.audience = config.audience;
    this.clockToleranceSec = config.clockToleranceSec ?? 60;
    this.jwksCacheTtlMs = config.jwksCacheTtlMs ?? 600_000;
    const resolvedFetch =
      config.fetchImpl ?? (globalThis.fetch as JwksFetchLike | undefined);
    if (resolvedFetch === undefined) {
      throw new Error(
        "[pump-evolution] consumer-auth: no `fetch` available (provide fetchImpl).",
      );
    }
    this.fetchImpl = resolvedFetch;
    this.now = config.now ?? Date.now;
  }

  /**
   * Verifica um header `Authorization` (com ou sem o prefixo `Bearer `) ou o token
   * cru. Retorna os claims validados em caso de sucesso; fail-closed caso contrário.
   */
  async verify(authorizationOrToken: string): Promise<ConsumerAuthResult> {
    const token = authorizationOrToken.replace(/^Bearer\s+/i, "").trim();
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed token" };

    const header = decodeSegment(parts[0]!);
    const payload = decodeSegment(parts[1]!);
    if (header === undefined || payload === undefined)
      return { ok: false, reason: "malformed token" };
    if (header.alg !== "RS256")
      return { ok: false, reason: `unsupported alg: ${String(header.alg)}` };
    const kid = readString(header.kid);
    if (kid === undefined) return { ok: false, reason: "missing kid" };

    const key = await this.resolveKey(kid);
    if (key === undefined) return { ok: false, reason: "unknown signing key" };

    if (!this.verifySignature(parts, key))
      return { ok: false, reason: "invalid signature" };

    const claimError = this.validateClaims(payload);
    if (claimError !== undefined) return { ok: false, reason: claimError };

    return { ok: true, claims: payload };
  }

  /**
   * Um-liner de baixa fricção para agentes E MCPs: valida o Bearer do Cognito,
   * extrai a identidade dos claims (`claimsToUserContext`) e roda `fn` JÁ DENTRO
   * do contexto `withUser` — então TODA telemetria daquele fluxo (spans do agente
   * Bedrock, `execute_tool` de MCP, compliance, segurança) sai para o CTA com
   * `enduser.id`/`cta.department` preenchidos automaticamente. O dev não passa
   * `user-id` manualmente nem escreve o glue verify→map→withUser.
   *
   * O JWT original é propagado no `UserContext.token` (nunca emitido pela SDK),
   * para o Tool Gateway / A2A repassarem a identidade end-to-end.
   *
   * Fail-closed: token ausente/inválido → `{ ok: false, reason }` (o chamador
   * devolve 401), e `fn` NÃO roda.
   */
  async runWithIdentity<T>(
    authorizationOrToken: string | undefined,
    fn: (user: UserContext) => T | Promise<T>,
  ): Promise<
    | { ok: true; user: UserContext; value: Awaited<T> }
    | { ok: false; reason: string }
  > {
    const header = authorizationOrToken ?? "";
    const result = await this.verify(header);
    if (!result.ok) return result;

    const bareToken = header.replace(/^Bearer\s+/i, "").trim();
    const user: UserContext = {
      ...claimsToUserContext(result.claims),
      token: bareToken,
    };
    const value = (await withUser(user, () => fn(user))) as Awaited<T>;
    return { ok: true, user, value };
  }

  private verifySignature(parts: string[], key: KeyObject): boolean {
    try {
      return cryptoVerify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2]!, "base64url"),
      );
    } catch {
      return false;
    }
  }

  private validateClaims(payload: Record<string, unknown>): string | undefined {
    const nowSec = Math.floor(this.now() / 1000);
    const tol = this.clockToleranceSec;

    if (readString(payload.iss) !== this.issuer) return "issuer mismatch";

    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    if (exp === undefined) return "missing exp";
    if (nowSec > exp + tol) return "token expired";

    if (typeof payload.nbf === "number" && nowSec < payload.nbf - tol)
      return "token not yet valid";

    if (this.audience !== undefined && !this.audienceMatches(payload))
      return "audience mismatch";

    return undefined;
  }

  private audienceMatches(payload: Record<string, unknown>): boolean {
    const aud = payload.aud;
    if (typeof aud === "string" && aud === this.audience) return true;
    if (Array.isArray(aud) && aud.includes(this.audience)) return true;
    // Cognito access tokens carry `client_id` instead of `aud`.
    return readString(payload.client_id) === this.audience;
  }

  private async resolveKey(kid: string): Promise<KeyObject | undefined> {
    const fresh =
      this.cache !== undefined &&
      this.now() - this.cache.fetchedAt < this.jwksCacheTtlMs;
    if (fresh && this.cache!.keys.has(kid)) return this.cache!.keys.get(kid);

    // Unknown kid or stale cache → refetch once (handles key rotation).
    const keys = await this.refreshJwks();
    return keys.get(kid);
  }

  private async refreshJwks(): Promise<Map<string, KeyObject>> {
    this.inFlight ??= this.fetchJwks();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async fetchJwks(): Promise<Map<string, KeyObject>> {
    const keys = new Map<string, KeyObject>();
    try {
      const res = await this.fetchImpl(this.jwksUri, { method: "GET" });
      if (!res.ok) {
        this.cache = { keys, fetchedAt: this.now() };
        return keys;
      }
      for (const jwk of parseJwks(await res.json())) {
        try {
          keys.set(
            jwk.kid,
            createPublicKey({
              key: jwk as unknown as JsonWebKey,
              format: "jwk",
            }),
          );
        } catch {
          // Skip an unparseable JWK rather than failing the whole set.
        }
      }
    } catch {
      // Network/parse failure → empty set (fail-closed: verify() → unknown key).
    }
    this.cache = { keys, fetchedAt: this.now() };
    return keys;
  }
}
