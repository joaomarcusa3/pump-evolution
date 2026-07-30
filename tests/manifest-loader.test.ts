import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  loadManifest,
  loadResourceAttributes,
  manifestToResourceAttributes,
} from '../src/index.js';
import type { AgentManifest } from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (file: string): string => join(FIXTURES, file);

const FULL_MANIFEST: AgentManifest = {
  name: 'latam-credit-analyzer',
  modelId: 'gpt-4o',
  allowedTools: ['search', 'calculator'],
  riskTier: 'T2-medium',
  owner: { email: 'vincenzo@topaz.com', team: 'data-engineering', costCenter: 'OWNER-CC-999' },
  costCenter: 'LATAM-CC-001',
  squad: 'data-engineering',
  dataClassification: 'internal',
};

describe('ManifestLoader — valid full manifest', () => {
  it('maps a full manifest file to complete ResourceAttributes', () => {
    const attrs = loadResourceAttributes(fixture('manifest-full.yaml'));

    expect(attrs).toEqual({
      'service.name': 'latam-credit-analyzer',
      'gen_ai.agent.id': 'latam-credit-analyzer',
      'gen_ai.request.model': 'gpt-4o',
      'cta.item_kind': 'agent',
      'cta.allowed_tools': ['search', 'calculator'],
      'cta.cost_center': 'LATAM-CC-001',
      'cta.squad': 'data-engineering',
      'cta.data_classification': 'internal',
      'cta.risk_tier': 'T2-medium',
    });
  });

  it('maps a full manifest object to the same ResourceAttributes as the path form', () => {
    const fromObject = manifestToResourceAttributes(FULL_MANIFEST);
    const fromPath = loadResourceAttributes(fixture('manifest-full.yaml'));

    expect(fromObject).toEqual(fromPath);
  });

  it('preserves the runtime block when parsing the file (for later telemetry resolution)', () => {
    const manifest = loadManifest(fixture('manifest-full.yaml'));

    expect(manifest.runtime).toEqual({
      external: true,
      telemetry: {
        otelEndpoint: 'https://otel.cta.topaz.aws.com/v1/traces',
        serviceAccountId: 'svc-latam-credit-analyzer',
      },
    });
  });

  it('prefers top-level costCenter over owner.costCenter', () => {
    const attrs = manifestToResourceAttributes({
      name: 'a',
      modelId: 'm',
      allowedTools: ['t'],
      costCenter: 'TOP-LEVEL-CC',
      owner: { email: 'x@y.com', costCenter: 'OWNER-CC' },
    });

    expect(attrs['cta.cost_center']).toBe('TOP-LEVEL-CC');
  });

  it('falls back to owner.costCenter only when top-level costCenter is absent', () => {
    const attrs = manifestToResourceAttributes({
      name: 'a',
      modelId: 'm',
      allowedTools: ['t'],
      owner: { email: 'x@y.com', costCenter: 'OWNER-CC' },
    });

    expect(attrs['cta.cost_center']).toBe('OWNER-CC');
  });
});

describe('ManifestLoader — valid minimal manifest', () => {
  it('omits optional attribute keys entirely when the fields are absent', () => {
    const attrs = loadResourceAttributes(fixture('manifest-minimal.yaml'));

    expect(attrs).toEqual({
      'service.name': 'minimal-agent',
      'gen_ai.agent.id': 'minimal-agent',
      'gen_ai.request.model': 'anthropic.claude-sonnet-4',
      'cta.item_kind': 'agent',
      'cta.allowed_tools': ['search'],
    });
    // Assert keys are absent, not present-with-undefined.
    expect(Object.prototype.hasOwnProperty.call(attrs, 'cta.cost_center')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(attrs, 'cta.squad')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(attrs, 'cta.data_classification')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(attrs, 'cta.risk_tier')).toBe(false);
  });
});

describe('ManifestLoader — fail-fast (ADR-0031, zero fallback)', () => {
  it('throws a clear error when the file path does not exist', () => {
    expect(() => loadManifest(fixture('does-not-exist.yaml'))).toThrow(
      /could not be read.*does-not-exist\.yaml/s,
    );
  });

  it('throws a clear error on malformed YAML', () => {
    expect(() => loadManifest(fixture('manifest-malformed.yaml'))).toThrow(/not valid YAML/);
  });

  it('throws naming the field when required "name" is missing', () => {
    expect(() =>
      manifestToResourceAttributes(loadManifest({ modelId: 'm', allowedTools: ['t'] } as never)),
    ).toThrow(/field "name" is required/);
  });

  it('throws naming the field when required "modelId" is missing', () => {
    expect(() => loadManifest({ name: 'agent-x', allowedTools: ['t'] } as never)).toThrow(
      /field "modelId" is required/,
    );
  });

  it('throws naming the field when "allowedTools" is absent', () => {
    expect(() => loadManifest({ name: 'agent-x', modelId: 'm' } as never)).toThrow(
      /field "allowedTools" is required/,
    );
  });

  it('accepts an empty "allowedTools" (Converse-only agent, no tool-calling)', () => {
    const m = loadManifest({ name: 'agent-x', modelId: 'm', allowedTools: [] } as never);
    expect(m.allowedTools).toEqual([]);
  });

  it('throws when "allowedTools" is not an array', () => {
    expect(() =>
      loadManifest({ name: 'agent-x', modelId: 'm', allowedTools: 'nope' } as never),
    ).toThrow(/field "allowedTools" is required/);
  });

  it('throws when a tool entry is not a non-empty string', () => {
    expect(() =>
      loadManifest({ name: 'agent-x', modelId: 'm', allowedTools: ['ok', ''] } as never),
    ).toThrow(/allowedTools\[1\]/);
  });

  it('throws on invalid dataClassification enum', () => {
    expect(() =>
      loadManifest({
        name: 'agent-x',
        modelId: 'm',
        allowedTools: ['t'],
        dataClassification: 'top-secret',
      } as never),
    ).toThrow(/dataClassification.*must be one of/s);
  });

  it('throws on invalid riskTier enum', () => {
    expect(() =>
      loadManifest({
        name: 'agent-x',
        modelId: 'm',
        allowedTools: ['t'],
        riskTier: 'T9-ultra',
      } as never),
    ).toThrow(/riskTier.*must be one of/s);
  });

  it('throws when owner is present but owner.email is missing', () => {
    expect(() =>
      loadManifest({
        name: 'agent-x',
        modelId: 'm',
        allowedTools: ['t'],
        owner: { team: 'data-engineering' },
      } as never),
    ).toThrow(/field "owner.email" is required/);
  });

  it('never applies a silent default — the error message says so', () => {
    expect(() => loadManifest({ modelId: 'm', allowedTools: ['t'] } as never)).toThrow(
      /No default is applied/,
    );
  });
});

describe('ManifestLoader — MCP kind (the CTA maps MCPs too)', () => {
  it('accepts a kind:mcp manifest WITHOUT modelId and omits gen_ai.request.model', () => {
    const attrs = manifestToResourceAttributes(
      loadManifest({ name: 'meu-mcp', kind: 'mcp', allowedTools: ['buscar'] } as never),
    );

    expect(attrs).toEqual({
      'service.name': 'meu-mcp',
      'gen_ai.agent.id': 'meu-mcp',
      'cta.item_kind': 'mcp',
      'cta.allowed_tools': ['buscar'],
    });
    expect(Object.prototype.hasOwnProperty.call(attrs, 'gen_ai.request.model')).toBe(false);
  });

  it('defaults kind to "agent" and emits cta.item_kind=agent when kind is omitted', () => {
    const attrs = manifestToResourceAttributes(
      loadManifest({ name: 'a', modelId: 'm', allowedTools: [] } as never),
    );
    expect(attrs['cta.item_kind']).toBe('agent');
  });

  it('still requires modelId for kind:agent (explicit)', () => {
    expect(() => loadManifest({ name: 'a', kind: 'agent', allowedTools: ['t'] } as never)).toThrow(
      /field "modelId" is required/,
    );
  });

  it('keeps modelId on a kind:mcp manifest when it is provided (harmless)', () => {
    const m = loadManifest({
      name: 'mcp-x',
      kind: 'mcp',
      modelId: 'm',
      allowedTools: ['t'],
    } as never);
    expect(m.modelId).toBe('m');
    expect(m.kind).toBe('mcp');
  });

  it('throws on an invalid kind enum', () => {
    expect(() =>
      loadManifest({ name: 'a', kind: 'robot', modelId: 'm', allowedTools: ['t'] } as never),
    ).toThrow(/kind.*must be one of/s);
  });
});
