import { describe, expect, it } from 'vitest';

import { ServiceAccountTokenProvider, type FetchLike } from '../src/index.js';

/** Builds a fake fetch that returns the given token payloads in sequence. */
function fakeFetch(responses: readonly { ok?: boolean; status?: number; body: string }[]): {
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

const BASE = {
  tokenUrl: 'https://auth.example.com/oauth2/token',
  clientId: 'svc-agent',
  clientSecret: 's3cr3t',
};

describe('ServiceAccountTokenProvider', () => {
  it('mints a token via client-credentials with Basic auth and caches it', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) },
    ]);
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });

    expect(await provider.getToken()).toBe('tok-1');
    // Second call within validity → served from cache, no extra fetch.
    expect(await provider.getToken()).toBe('tok-1');
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call!.headers.Authorization).toBe(
      `Basic ${Buffer.from('svc-agent:s3cr3t').toString('base64')}`,
    );
    expect(call!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call!.body).toContain('grant_type=client_credentials');
    // Cognito exige o scope qualificado pelo resource server (telemetry/telemetry:write).
    expect(call!.body).toContain('scope=telemetry%2Ftelemetry%3Awrite');
  });

  it('refreshes after the token expires (accounting for skew)', async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([
      { body: JSON.stringify({ access_token: 'tok-1', expires_in: 100 }) },
      { body: JSON.stringify({ access_token: 'tok-2', expires_in: 100 }) },
    ]);
    const provider = new ServiceAccountTokenProvider({
      ...BASE,
      fetchImpl,
      refreshSkewMs: 10_000,
      now: () => now,
    });

    expect(await provider.getToken()).toBe('tok-1');
    // refreshAt = 0 + (100_000 - 10_000) = 90_000
    now = 89_000;
    expect(await provider.getToken()).toBe('tok-1'); // still valid
    now = 95_000;
    expect(await provider.getToken()).toBe('tok-2'); // refreshed
    expect(calls).toHaveLength(2);
  });

  it('de-duplicates concurrent refreshes into a single request', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) },
    ]);
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });

    const [a, b, c] = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect([a, b, c]).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(calls).toHaveLength(1);
  });

  it('throws on a non-ok token response', async () => {
    const { fetchImpl } = fakeFetch([{ ok: false, status: 401, body: 'unauthorized' }]);
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });
    await expect(provider.getToken()).rejects.toThrow(/401/);
  });

  it('throws when access_token is missing', async () => {
    const { fetchImpl } = fakeFetch([{ body: JSON.stringify({ token_type: 'Bearer' }) }]);
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });
    await expect(provider.getToken()).rejects.toThrow(/access_token/);
  });

  it('retries the mint after a failed refresh (in-flight is cleared)', async () => {
    let call = 0;
    const fetchImpl: FetchLike = () => {
      call += 1;
      if (call === 1)
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('err') });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: 'tok-ok', expires_in: 3600 })),
      });
    };
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });
    await expect(provider.getToken()).rejects.toThrow(/500/);
    // The failed in-flight promise must not be cached — a retry succeeds.
    await expect(provider.getToken()).resolves.toBe('tok-ok');
  });
});

describe('ServiceAccountTokenProvider — response parsing edge cases', () => {
  it('throws on a non-JSON response body', async () => {
    const { fetchImpl } = fakeFetch([{ body: '<html>gateway error</html>' }]);
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });
    await expect(provider.getToken()).rejects.toThrow(/non-JSON/);
  });

  it('throws when the payload is JSON but not an object', async () => {
    const { fetchImpl } = fakeFetch([{ body: '"just-a-string"' }]);
    const provider = new ServiceAccountTokenProvider({ ...BASE, fetchImpl, now: () => 0 });
    await expect(provider.getToken()).rejects.toThrow(/unexpected payload/);
  });

  it('defaults expires_in to 1h when the IdP omits it', async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([
      { body: JSON.stringify({ access_token: 'tok-1' }) }, // no expires_in
    ]);
    const provider = new ServiceAccountTokenProvider({
      ...BASE,
      fetchImpl,
      refreshSkewMs: 0,
      now: () => now,
    });
    expect(await provider.getToken()).toBe('tok-1');
    // Still valid just before the 1h default expiry → no extra fetch.
    now = 3_599_000;
    expect(await provider.getToken()).toBe('tok-1');
    expect(calls).toHaveLength(1);
  });

  it('throws at construction when no fetch is available', () => {
    const savedFetch = globalThis.fetch;
    // @ts-expect-error — simulate a runtime without global fetch
    delete globalThis.fetch;
    try {
      expect(() => new ServiceAccountTokenProvider({ ...BASE })).toThrow(/no `fetch` available/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
