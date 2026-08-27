/**
 * identity-context — resolves and propagates the *end user* identity behind an
 * agent invocation, so every span can be attributed to a real person /
 * department / cost center (Requirement 4).
 *
 * Three pieces:
 *  1. `withUser(ctx, fn)` / `getCurrentUser()` — an `AsyncLocalStorage` store
 *     that carries a `UserContext` across the (sync or async) callback flow.
 *  2. `parseIdentityHeaders(...)` — extracts identity from the real CTA identity
 *     carriers: the `x-cta-security-context` header and/or a Bearer JWT.
 *  3. `applyIdentityToSpan(span, ctx)` — writes `enduser.id`, `cta.department`,
 *     `cta.cost_center` when known, or the explicit `cta.identity.anonymous=true`
 *     marker when nothing is resolvable.
 *
 * Invariants (steering):
 *  - ZERO fallback (ADR-0031): no `?? 'unknown'`, no manifest-owner substitution.
 *    Absence of identity is the explicit boolean `cta.identity.anonymous=true`.
 *  - Identity is propagated, never emitted: the JWT is only read, never minted.
 *    `UserContext.token` carries the original token for downstream propagation.
 *  - Telemetry never breaks the agent: a malformed header/JWT at request time
 *    must NOT throw — it degrades to "no identity" → anonymous. (Contrast with
 *    manifest/config errors, which DO throw at init: a bad per-request identity
 *    header is a runtime condition the agent flow must survive.)
 *
 * Grounding — real `x-cta-security-context` shape (verified in-repo):
 *  - `packages/cta-api/src/services/security-context-token.ts` signs the header
 *    as an HS256 JWT whose payload carries the full `SecurityContext` under an
 *    `sc` claim (`{ sc: { principalId, email, department, costCenter, ... } }`).
 *  - `packages/cta-core/src/shared/security-context.ts` defines that
 *    `SecurityContext` ({ principalId, email, department, costCenter, ... }).
 *  - `docs/developers/onboarding-existing-agents.md` shows agents reading the
 *    header as raw JSON — so the header may also be a bare JSON object.
 *  This parser handles all three: JWT-with-`sc`, JWT-with-top-level-claims, and
 *  raw JSON.
 *
 * Grounding — Bearer JWT (Cognito user token) claim names (verified in
 * `packages/cta-api/src/middleware/auth.ts` and
 * `packages/cta-factory-mcp/src/server.ts`):
 *  - `enduser.id`  ← `email`, else `sub` (email preferred; both are real claims).
 *  - department    ← `custom:department`, else `custom:topaz_directorate`
 *    (alias `custom:cta_directorate`) used as-is. NOTE: on the real platform
 *    `department` and `directorate` are distinct fields (`SecurityContext` has
 *    no `directorate` at all — see `packages/cta-core/src/shared/security-context.ts`);
 *    the SDK's `UserContext` has no separate slot for it, so the directorate is
 *    used as the best-available `department` value only when `custom:department`
 *    itself is absent. There is no `custom:topaz_area` claim anywhere in the
 *    platform — do not reintroduce it.
 *  - cost center   ← `custom:cost_center`, else `custom:cta_cost_center` (both
 *    are real aliases used by the Cognito schema in this deployment).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Span } from '@opentelemetry/api';

import {
  CTA_COST_CENTER,
  CTA_DEPARTMENT,
  CTA_IDENTITY_ANONYMOUS,
  ENDUSER_ID,
} from './constants.js';
import type { UserContext } from './types.js';

// ─── AsyncLocalStorage store ──────────────────────────────────────────────────

const identityStore = new AsyncLocalStorage<UserContext>();

/**
 * Runs `fn` with `ctx` as the current user identity, propagated to every span
 * created within the (sync or async) call. `AsyncLocalStorage.run` preserves the
 * store across `await` boundaries, so async callbacks see the same identity.
 *
 * `fn` is typed `() => T` to match the `PumpHandle.withUser` contract; when `T`
 * is a `Promise`, the identity remains in scope until it settles because the
 * store follows the async execution context.
 *
 * Nested calls override the outer identity for the duration of the inner `fn`
 * and restore it on exit (standard ALS semantics).
 */
export function withUser<T>(ctx: UserContext, fn: () => T): T {
  return identityStore.run(ctx, fn);
}

/** Returns the `UserContext` in scope, or `undefined` outside any `withUser`. */
export function getCurrentUser(): UserContext | undefined {
  return identityStore.getStore();
}

// ─── Narrowing helpers (parse `unknown`, never cast) ──────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a trimmed non-empty string, or `undefined`. Never throws. */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// ─── JWT payload decoding (no signature verification — client side) ───────────

/**
 * Base64url-decodes and JSON-parses the payload segment of a JWT WITHOUT
 * verifying its signature. The SDK is a client: signature verification is the
 * receiver's job. Returns the decoded claims as a record, or `undefined` when
 * the token is not a well-formed 3-segment JWT with a JSON object payload.
 *
 * Never throws — malformed input yields `undefined` (telemetry must not break
 * the agent flow).
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  const payloadSegment = segments[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) return undefined;
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Interprets a raw `x-cta-security-context` value into a claims record. The
 * value may be a JWT (payload carries claims, optionally nested under `sc`) or a
 * bare JSON object. Returns `undefined` when neither parses. Never throws.
 */
function decodeSecurityContext(raw: string): Record<string, unknown> | undefined {
  const jwtPayload = decodeJwtPayload(raw);
  if (jwtPayload !== undefined) return jwtPayload;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ─── Claim extraction ─────────────────────────────────────────────────────────

/**
 * Falls back to the `custom:topaz_directorate` claim (alias `custom:cta_directorate`)
 * as `department` when `custom:department` itself is absent. Used in both
 * {@link extractIdentity} and {@link claimsToUserContext}.
 */
function resolveDirectorateAsDepartment(source: Record<string, unknown>): string | undefined {
  return (
    readString(source['custom:topaz_directorate']) ?? readString(source['custom:cta_directorate'])
  );
}

/**
 * Extracts `{ userId, department, costCenter }` from a claims record, matching
 * the real CTA/Cognito claim names. Understands both the wrapped
 * `SecurityContext` shape (claims under `sc`, using `principalId`/`email`) and a
 * flat Cognito token (`email`/`sub`, `custom:department`,
 * `custom:cost_center`/`custom:cta_cost_center`).
 */
function extractIdentity(claims: Record<string, unknown>): UserContext {
  // A signed SecurityContext nests the real fields under `sc`.
  const sc = isRecord(claims.sc) ? claims.sc : claims;

  const userId =
    readString(sc.email) ??
    readString(sc.principalId) ??
    readString(sc.sub) ??
    readString(claims.email) ??
    readString(claims.sub);

  const department =
    readString(sc.department) ??
    readString(sc['custom:department']) ??
    resolveDirectorateAsDepartment(sc);

  const costCenter =
    readString(sc.costCenter) ??
    readString(sc['custom:cost_center']) ??
    readString(sc['custom:cta_cost_center']);

  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(department !== undefined ? { department } : {}),
    ...(costCenter !== undefined ? { costCenter } : {}),
  };
}

/** Merges two contexts, preferring already-set (higher-precedence) fields. */
function mergeContext(primary: UserContext, secondary: UserContext): UserContext {
  return {
    userId: primary.userId ?? secondary.userId,
    department: primary.department ?? secondary.department,
    costCenter: primary.costCenter ?? secondary.costCenter,
    token: primary.token ?? secondary.token,
  };
}

/** Inputs for {@link parseIdentityHeaders}. */
export interface IdentityHeaderInput {
  /** Raw `x-cta-security-context` header value (JWT or JSON). */
  readonly securityContext?: string;
  /**
   * Raw `Authorization` header value or bare Bearer JWT. A leading `Bearer `
   * prefix is tolerated. Decoded WITHOUT signature verification.
   */
  readonly authorization?: string;
}

/**
 * Parses identity from the request's identity carriers into a `UserContext`.
 *
 * Precedence when both carriers are present: the `x-cta-security-context` header
 * wins over the Bearer JWT. Rationale: the security context is the CTA's own
 * resolved, propagated identity (already mapped to department/cost center by the
 * control plane), whereas the raw Bearer token is the upstream credential the
 * context was derived from. Any field missing from the security context is
 * backfilled from the Bearer JWT.
 *
 * The original token is preserved on `UserContext.token` for downstream
 * propagation — it is only read, never emitted (Requirement 4.4). The security
 * context header value is preferred as the propagated token when present.
 *
 * Returns `undefined` when neither carrier yields any identity field. NEVER
 * throws — malformed carriers degrade to "no identity".
 */
export function parseIdentityHeaders(input: IdentityHeaderInput): UserContext | undefined {
  const bearer = readString(input.authorization);
  const rawToken = bearer?.replace(/^Bearer\s+/i, '');
  const rawSecurityContext = readString(input.securityContext);

  let resolved: UserContext = {};

  // Only carriers that actually decode contribute identity AND are eligible to
  // be propagated as a token. An unparseable value is garbage — not a credential
  // to forward downstream — so it neither yields identity nor a propagated token.
  let propagatedToken: string | undefined;

  if (rawSecurityContext !== undefined) {
    const claims = decodeSecurityContext(rawSecurityContext);
    if (claims !== undefined) {
      resolved = mergeContext(resolved, extractIdentity(claims));
      propagatedToken = rawSecurityContext;
    }
  }

  if (rawToken !== undefined && rawToken.length > 0) {
    const claims = decodeJwtPayload(rawToken);
    if (claims !== undefined) {
      resolved = mergeContext(resolved, extractIdentity(claims));
      // Security-context value is preferred as the propagated token when present.
      propagatedToken ??= rawToken;
    }
  }

  // Propagate the original token, never mint one (Requirement 4.4).
  if (propagatedToken !== undefined) resolved = { ...resolved, token: propagatedToken };

  const hasIdentity =
    resolved.userId !== undefined ||
    resolved.department !== undefined ||
    resolved.costCenter !== undefined;

  if (!hasIdentity && resolved.token === undefined) return undefined;
  return resolved;
}

// ─── Applying identity to a span ──────────────────────────────────────────────

/**
 * Applies the resolved identity to a span.
 *
 * When any of `userId`/`department`/`costCenter` is present, the corresponding
 * `enduser.id` / `cta.department` / `cta.cost_center` attributes are set. When
 * NO identity field is resolvable, the span is marked explicitly anonymous
 * (`cta.identity.anonymous=true`) — the SDK never substitutes `'unknown'` and
 * never falls back to the manifest owner (Requirement 4.3).
 *
 * The `token` is intentionally NOT written to the span: it is a credential for
 * downstream propagation, not telemetry (Requirement 4.4).
 *
 * `ctx` defaults to the current `withUser` scope, so callers can simply pass a
 * span.
 */
export function applyIdentityToSpan(
  span: Span,
  ctx: UserContext | undefined = getCurrentUser(),
): void {
  const userId = readString(ctx?.userId);
  const department = readString(ctx?.department);
  const costCenter = readString(ctx?.costCenter);

  const hasIdentity = userId !== undefined || department !== undefined || costCenter !== undefined;

  if (!hasIdentity) {
    span.setAttribute(CTA_IDENTITY_ANONYMOUS, true);
    return;
  }

  if (userId !== undefined) span.setAttribute(ENDUSER_ID, userId);
  if (department !== undefined) span.setAttribute(CTA_DEPARTMENT, department);
  if (costCenter !== undefined) span.setAttribute(CTA_COST_CENTER, costCenter);
}

/**
 * Mapeia claims verificados do IdP (Cognito) para um {@link UserContext}, para
 * alimentar `withUser`. Fecha o laço do consumer-auth: valida o Bearer de quem
 * chama e propaga a identidade dele para os spans governados. Precedência entre
 * fontes reais de claim (não é fallback fabricado); claims ausentes são omitidos.
 */
export function claimsToUserContext(claims: Record<string, unknown>): UserContext {
  const userId =
    readString(claims.email) ??
    readString(claims['cognito:username']) ??
    readString(claims.username) ??
    readString(claims.sub);
  const department =
    readString(claims['custom:department']) ?? resolveDirectorateAsDepartment(claims);
  const costCenter =
    readString(claims['custom:costCenter']) ??
    readString(claims['custom:cost_center']) ??
    readString(claims['custom:cta_cost_center']);
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(department !== undefined ? { department } : {}),
    ...(costCenter !== undefined ? { costCenter } : {}),
  };
}
