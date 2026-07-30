import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConsumerTokenVerifier, getCurrentUser, type JwksFetchLike } from '../src/index.js';

// ─── Test crypto helpers ────────────────────────────────────────────────────

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST';
const CLIENT_ID = 'test-client-id';
const NOW_MS = 1_800_000_000_000; // fixed clock
const nowSec = Math.floor(NOW_MS / 1000);

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function makeToken(opts: {
  privateKey: KeyObject;
  kid: string;
  claims: Record<string, unknown>;
  alg?: string;
}): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(opts.claims));
  const input = `${header}.${payload}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(input), opts.privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function jwkFor(publicKey: KeyObject, kid: string): Record<string, unknown> {
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

/** A fetch that serves the given JWKS payloads in sequence (one per call). */
function jwksFetch(payloads: unknown[]): { fetchImpl: JwksFetchLike; calls: () => number } {
  let i = 0;
  const fetchImpl: JwksFetchLike = () => {
    const body = payloads[Math.min(i, payloads.length - 1)];
    i += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { fetchImpl, calls: () => i };
}

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-1';
const JWKS = { keys: [jwkFor(kp.publicKey, KID)] };

// Second keypair, for the key-rotation scenario.
const kp2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID2 = 'kid-2';

function baseClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'user-123',
    email: 'alice@acme.com',
    aud: CLIENT_ID,
    exp: nowSec + 3600,
    iat: nowSec,
    ...over,
  };
}

function verifier(): ConsumerTokenVerifier {
  return new ConsumerTokenVerifier({
    issuer: ISSUER,
    audience: CLIENT_ID,
    now: () => NOW_MS,
    fetchImpl: jwksFetch([JWKS]).fetchImpl,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ConsumerTokenVerifier', () => {
  it('accepts a valid RS256 token and returns its claims', async () => {
    const token = makeToken({ privateKey: kp.privateKey, kid: KID, claims: baseClaims() });
    const res = await verifier().verify(`Bearer ${token}`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.sub).toBe('user-123');
      expect(res.claims.email).toBe('alice@acme.com');
    }
  });

  it('accepts a raw token (without the Bearer prefix)', async () => {
    const token = makeToken({ privateKey: kp.privateKey, kid: KID, claims: baseClaims() });
    expect((await verifier().verify(token)).ok).toBe(true);
  });

  it('rejects an expired token', async () => {
    const token = makeToken({
      privateKey: kp.privateKey,
      kid: KID,
      claims: baseClaims({ exp: nowSec - 120 }),
    });
    const res = await verifier().verify(token);
    expect(res).toEqual({ ok: false, reason: 'token expired' });
  });

  it('rejects an issuer mismatch', async () => {
    const token = makeToken({
      privateKey: kp.privateKey,
      kid: KID,
      claims: baseClaims({ iss: 'https://evil.example.com' }),
    });
    const res = await verifier().verify(token);
    expect(res).toEqual({ ok: false, reason: 'issuer mismatch' });
  });

  it('rejects an audience mismatch', async () => {
    const token = makeToken({
      privateKey: kp.privateKey,
      kid: KID,
      claims: baseClaims({ aud: 'other-client' }),
    });
    const res = await verifier().verify(token);
    expect(res).toEqual({ ok: false, reason: 'audience mismatch' });
  });

  it('accepts a Cognito access token that carries client_id instead of aud', async () => {
    const claims = baseClaims({ token_use: 'access', client_id: CLIENT_ID });
    delete claims.aud;
    const token = makeToken({ privateKey: kp.privateKey, kid: KID, claims });
    expect((await verifier().verify(token)).ok).toBe(true);
  });

  it('rejects a tampered payload (invalid signature)', async () => {
    const token = makeToken({ privateKey: kp.privateKey, kid: KID, claims: baseClaims() });
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify(baseClaims({ email: 'attacker@evil.com' })))}.${s}`;
    const res = await verifier().verify(forged);
    expect(res).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('rejects an unsupported algorithm (fail-closed, no alg:none/HS*)', async () => {
    const token = makeToken({
      privateKey: kp.privateKey,
      kid: KID,
      claims: baseClaims(),
      alg: 'none',
    });
    const res = await verifier().verify(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unsupported alg/);
  });

  it('rejects a malformed token', async () => {
    expect(await verifier().verify('not.a.jwt.at.all')).toEqual({
      ok: false,
      reason: 'malformed token',
    });
    expect(await verifier().verify('onlyonepart')).toEqual({
      ok: false,
      reason: 'malformed token',
    });
  });

  it('refetches the JWKS when a fresh cache is missing the kid (key rotation)', async () => {
    // Load 1 has only KID; load 2 (after rotation) adds KID2. The first verify
    // caches load 1; the second verify sees a fresh cache missing KID2 and must
    // refetch to find the rotated key.
    const { fetchImpl, calls } = jwksFetch([
      { keys: [jwkFor(kp.publicKey, KID)] },
      { keys: [jwkFor(kp.publicKey, KID), jwkFor(kp2.publicKey, KID2)] },
    ]);
    const v = new ConsumerTokenVerifier({
      issuer: ISSUER,
      audience: CLIENT_ID,
      now: () => NOW_MS,
      fetchImpl,
    });

    const tokenA = makeToken({ privateKey: kp.privateKey, kid: KID, claims: baseClaims() });
    expect((await v.verify(tokenA)).ok).toBe(true); // fetch #1

    const tokenB = makeToken({ privateKey: kp2.privateKey, kid: KID2, claims: baseClaims() });
    expect((await v.verify(tokenB)).ok).toBe(true); // fresh cache misses KID2 → fetch #2
    expect(calls()).toBe(2);
  });

  it('fails closed when the signing key cannot be found even after refetch', async () => {
    const v = new ConsumerTokenVerifier({
      issuer: ISSUER,
      audience: CLIENT_ID,
      now: () => NOW_MS,
      fetchImpl: jwksFetch([{ keys: [] }]).fetchImpl,
    });
    const token = makeToken({
      privateKey: kp.privateKey,
      kid: 'unknown-kid',
      claims: baseClaims(),
    });
    expect(await v.verify(token)).toEqual({ ok: false, reason: 'unknown signing key' });
  });
});

describe('ConsumerTokenVerifier.runWithIdentity', () => {
  it('verifies + runs fn within the Cognito identity and returns the user', async () => {
    const token = makeToken({
      privateKey: kp.privateKey,
      kid: KID,
      claims: baseClaims({ email: 'alice@acme.com', 'custom:department': 'engineering' }),
    });
    let insideUserId;
    let insideDept;
    const r = await verifier().runWithIdentity(`Bearer ${token}`, (user) => {
      // Dentro do fn, o contexto withUser já está ativo (spans herdam a identidade).
      const cur = getCurrentUser();
      insideUserId = cur?.userId;
      insideDept = cur?.department;
      return `hi ${user.userId}`;
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.userId).toBe('alice@acme.com');
      expect(r.user.department).toBe('engineering');
      expect(r.value).toBe('hi alice@acme.com');
    }
    expect(insideUserId).toBe('alice@acme.com');
    expect(insideDept).toBe('engineering');
  });

  it('is fail-closed: invalid token -> ok:false and fn is NOT called', async () => {
    let called = false;
    const r = await verifier().runWithIdentity('Bearer not.a.validjwt', () => {
      called = true;
      return 1;
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('propagates the raw JWT on the user context (end-to-end propagation)', async () => {
    const token = makeToken({ privateKey: kp.privateKey, kid: KID, claims: baseClaims() });
    const r = await verifier().runWithIdentity(`Bearer ${token}`, (u) => u.token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.token).toBe(token);
      expect(r.value).toBe(token);
    }
  });
});
