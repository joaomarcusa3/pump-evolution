import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyIdentityToSpan,
  claimsToUserContext,
  createTracerProvider,
  getCurrentUser,
  getTracer,
  parseIdentityHeaders,
  withUser,
} from '../src/index.js';
import type { ResourceAttributes, UserContext } from '../src/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds an unsigned-but-well-formed JWT (header.payload.signature) for parsing. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const RES_ATTRS: ResourceAttributes = {
  'service.name': 'agent',
  'gen_ai.agent.id': 'agent',
  'gen_ai.request.model': 'gpt-4o',
};

/** Runs `fn` with an in-memory-exporting span and returns its recorded attributes. */
function recordSpanAttributes(
  fn: (span: ReturnType<ReturnType<typeof getTracer>['startSpan']>) => void,
): Record<string, unknown> {
  const exporter = new InMemorySpanExporter();
  const provider = createTracerProvider({
    resourceAttributes: RES_ATTRS,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const span = getTracer(provider).startSpan('invoke');
  fn(span);
  span.end();
  const [finished] = exporter.getFinishedSpans();
  const attrs = finished?.attributes ?? {};
  void provider.shutdown();
  return attrs;
}

// ─── withUser / getCurrentUser ────────────────────────────────────────────────

describe('withUser / getCurrentUser', () => {
  it('exposes the identity inside the callback and clears it outside', () => {
    const ctx: UserContext = { userId: 'alice@topaz.com', department: 'engineering' };
    expect(getCurrentUser()).toBeUndefined();
    const inside = withUser(ctx, () => getCurrentUser());
    expect(inside).toEqual(ctx);
    expect(getCurrentUser()).toBeUndefined();
  });

  it('lets a nested withUser override the outer identity', () => {
    const outer: UserContext = { userId: 'alice@topaz.com' };
    const inner: UserContext = { userId: 'bob@topaz.com' };
    withUser(outer, () => {
      expect(getCurrentUser()?.userId).toBe('alice@topaz.com');
      withUser(inner, () => {
        expect(getCurrentUser()?.userId).toBe('bob@topaz.com');
      });
      expect(getCurrentUser()?.userId).toBe('alice@topaz.com');
    });
  });

  it('propagates identity across async awaits', async () => {
    const ctx: UserContext = { userId: 'alice@topaz.com', costCenter: 'CC-1' };
    const seen = await withUser(ctx, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentUser();
    });
    expect(seen).toEqual(ctx);
    expect(getCurrentUser()).toBeUndefined();
  });
});

// ─── parseIdentityHeaders ─────────────────────────────────────────────────────

describe('parseIdentityHeaders — x-cta-security-context', () => {
  it('extracts identity from a signed SecurityContext JWT (sc claim)', () => {
    const token = makeJwt({
      sc: {
        principalId: 'u-123',
        email: 'alice@topaz.com',
        department: 'engineering',
        costCenter: 'CC-ENG-001',
      },
    });
    const ctx = parseIdentityHeaders({ securityContext: token });
    expect(ctx?.userId).toBe('alice@topaz.com');
    expect(ctx?.department).toBe('engineering');
    expect(ctx?.costCenter).toBe('CC-ENG-001');
    expect(ctx?.token).toBe(token);
  });

  it('accepts a bare JSON security-context value', () => {
    const raw = JSON.stringify({
      email: 'bob@topaz.com',
      department: 'finance',
      costCenter: 'CC-FIN-002',
    });
    const ctx = parseIdentityHeaders({ securityContext: raw });
    expect(ctx?.userId).toBe('bob@topaz.com');
    expect(ctx?.department).toBe('finance');
    expect(ctx?.costCenter).toBe('CC-FIN-002');
  });
});

describe('parseIdentityHeaders — Bearer JWT (Cognito)', () => {
  it('extracts email/custom:department/custom:cost_center', () => {
    const token = makeJwt({
      sub: 'u-1',
      email: 'carol@topaz.com',
      'custom:department': 'data-engineering',
      'custom:cost_center': 'CC-DE-003',
    });
    const ctx = parseIdentityHeaders({ authorization: `Bearer ${token}` });
    expect(ctx?.userId).toBe('carol@topaz.com');
    expect(ctx?.department).toBe('data-engineering');
    expect(ctx?.costCenter).toBe('CC-DE-003');
    expect(ctx?.token).toBe(token);
  });

  it('falls back to sub for enduser.id and the cta_cost_center alias', () => {
    const token = makeJwt({
      sub: 'u-42',
      'custom:cta_cost_center': 'CC-ALIAS',
    });
    const ctx = parseIdentityHeaders({ authorization: token });
    expect(ctx?.userId).toBe('u-42');
    expect(ctx?.costCenter).toBe('CC-ALIAS');
  });

  it('falls back to custom:topaz_directorate when custom:department is absent', () => {
    const token = makeJwt({
      sub: 'u-99',
      'custom:topaz_directorate': 'CEL 926',
    });
    const ctx = parseIdentityHeaders({ authorization: token });
    expect(ctx?.department).toBe('CEL 926');
  });

  it('falls back to the custom:cta_directorate alias', () => {
    const token = makeJwt({ sub: 'u-1', 'custom:cta_directorate': 'CEL 926' });
    const ctx = parseIdentityHeaders({ authorization: token });
    expect(ctx?.department).toBe('CEL 926');
  });

  it('prefers custom:department over the directorate fallback', () => {
    const token = makeJwt({
      sub: 'u-3',
      'custom:department': 'engineering',
      'custom:topaz_directorate': 'CEL 926',
    });
    const ctx = parseIdentityHeaders({ authorization: token });
    expect(ctx?.department).toBe('engineering');
  });
});

describe('claimsToUserContext', () => {
  it('maps custom:department directly', () => {
    const ctx = claimsToUserContext({ email: 'dana@topaz.com', 'custom:department': 'finance' });
    expect(ctx.department).toBe('finance');
  });

  it('falls back to custom:topaz_directorate when custom:department is absent', () => {
    const ctx = claimsToUserContext({
      email: 'diego.resta@topazevolution.com',
      'custom:topaz_directorate': 'CEL 926',
    });
    expect(ctx.department).toBe('CEL 926');
  });
});

describe('parseIdentityHeaders — precedence and resilience', () => {
  it('prefers the security context over the Bearer JWT, backfilling missing fields', () => {
    const sc = makeJwt({ sc: { email: 'sc@topaz.com', department: 'engineering' } });
    const bearer = makeJwt({
      email: 'jwt@topaz.com',
      'custom:department': 'finance',
      'custom:cost_center': 'CC-FROM-JWT',
    });
    const ctx = parseIdentityHeaders({ securityContext: sc, authorization: `Bearer ${bearer}` });
    // security context wins on overlapping fields...
    expect(ctx?.userId).toBe('sc@topaz.com');
    expect(ctx?.department).toBe('engineering');
    // ...but the JWT backfills what the context lacked.
    expect(ctx?.costCenter).toBe('CC-FROM-JWT');
  });

  it('returns undefined when nothing is provided', () => {
    expect(parseIdentityHeaders({})).toBeUndefined();
  });

  it('does NOT throw on a malformed header/JWT — degrades to no identity', () => {
    expect(() => parseIdentityHeaders({ securityContext: 'not-a-jwt-or-json' })).not.toThrow();
    expect(parseIdentityHeaders({ securityContext: 'not-a-jwt-or-json' })).toBeUndefined();
    expect(() => parseIdentityHeaders({ authorization: 'Bearer garbage.token' })).not.toThrow();
    expect(parseIdentityHeaders({ authorization: 'Bearer garbage.token' })).toBeUndefined();
  });
});

// ─── applyIdentityToSpan ──────────────────────────────────────────────────────

describe('applyIdentityToSpan', () => {
  const providers: Array<{ shutdown(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(providers.splice(0).map((p) => p.shutdown()));
  });

  it('sets enduser.id / cta.department / cta.cost_center when identity is present', () => {
    const attrs = recordSpanAttributes((span) => {
      applyIdentityToSpan(span, {
        userId: 'alice@topaz.com',
        department: 'engineering',
        costCenter: 'CC-1',
      });
    });
    expect(attrs['enduser.id']).toBe('alice@topaz.com');
    expect(attrs['cta.department']).toBe('engineering');
    expect(attrs['cta.cost_center']).toBe('CC-1');
    expect('cta.identity.anonymous' in attrs).toBe(false);
  });

  it('marks the span explicitly anonymous when no identity is resolvable', () => {
    const attrs = recordSpanAttributes((span) => {
      applyIdentityToSpan(span, undefined);
    });
    expect(attrs['cta.identity.anonymous']).toBe(true);
    // Never substitute 'unknown' or a manifest owner.
    expect('enduser.id' in attrs).toBe(false);
    expect(attrs['enduser.id']).not.toBe('unknown');
  });

  it('reads the current withUser scope when no ctx is passed', () => {
    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider({
      resourceAttributes: RES_ATTRS,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    providers.push(provider);
    const tracer = getTracer(provider);

    withUser({ userId: 'scoped@topaz.com', department: 'ops' }, () => {
      const span = tracer.startSpan('invoke');
      applyIdentityToSpan(span);
      span.end();
    });

    const [finished] = exporter.getFinishedSpans();
    expect(finished?.attributes['enduser.id']).toBe('scoped@topaz.com');
    expect(finished?.attributes['cta.department']).toBe('ops');
  });

  it('treats a token-only context (no identity fields) as anonymous', () => {
    const attrs = recordSpanAttributes((span) => {
      applyIdentityToSpan(span, { token: 'propagated-jwt' });
    });
    expect(attrs['cta.identity.anonymous']).toBe(true);
  });
});
