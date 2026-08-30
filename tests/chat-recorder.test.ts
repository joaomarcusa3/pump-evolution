import { describe, expect, it } from 'vitest';
import { recordChat } from '../src/chat-recorder.js';

function tracerFalso() {
  const attrs: Record<string, unknown> = {};
  let nome = '';
  let encerrado = false;
  let status: unknown = null;
  const span = {
    setAttribute: (k: string, v: unknown) => { attrs[k] = v; },
    setStatus: (s: unknown) => { status = s; },
    recordException: () => { attrs['_exc'] = true; },
    end: () => { encerrado = true; },
  };
  return {
    startSpan: (n: string) => { nome = n; return span as never; },
    ver: () => ({ attrs, nome, encerrado, status }),
  };
}

describe('recordChat', () => {
  it('emite o atributo sem o qual o receiver descarta', () => {
    const t = tracerFalso();
    const ok = recordChat({ model: 'gpt-4o', inputTokens: 120, outputTokens: 45, provider: 'openai', tracer: t as never });
    const { attrs, nome, encerrado } = t.ver();
    expect(ok).toBe(true);
    expect(nome).toBe('chat gpt-4o');
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.request.model']).toBe('gpt-4o');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(120);
    expect(attrs['cta.usage.tokens_available']).toBe(true);
    expect(encerrado).toBe(true);
  });

  it('erro na chamada vira status ERROR, nao sumico', () => {
    const t = tracerFalso();
    recordChat({ model: 'gpt-4o', error: new Error('timeout'), tracer: t as never });
    expect(t.ver().attrs['_exc']).toBe(true);
  });

  it('nunca derruba o agente', () => {
    const quebrado = { startSpan: () => { throw new Error('boom'); } };
    expect(recordChat({ model: 'x', tracer: quebrado as never })).toBe(false);
  });
});
