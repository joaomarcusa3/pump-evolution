import { describe, expect, it } from 'vitest';

import {
  CTA_ALLOWED_TOOLS,
  CTA_COMPLIANCE_STATUS,
  GEN_AI_AGENT_ID,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  OPERATION_EXECUTE_TOOL,
  PROVIDER_AWS_BEDROCK,
  USAGE_SOURCE_EXTERNAL_OTEL,
} from '../src/index.js';
import type {
  AgentManifest,
  ComplianceFinding,
  PumpConfig,
  ResourceAttributes,
  UsageEventContract,
} from '../src/index.js';

describe('pump-evolution scaffold contracts', () => {
  it('exposes the GenAI and CTA attribute-name constants with their literal values', () => {
    expect(GEN_AI_AGENT_ID).toBe('gen_ai.agent.id');
    expect(GEN_AI_REQUEST_MODEL).toBe('gen_ai.request.model');
    expect(GEN_AI_USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens');
    expect(CTA_ALLOWED_TOOLS).toBe('cta.allowed_tools');
    expect(CTA_COMPLIANCE_STATUS).toBe('cta.compliance.status');
    expect(PROVIDER_AWS_BEDROCK).toBe('aws.bedrock');
    expect(OPERATION_EXECUTE_TOOL).toBe('execute_tool');
    expect(USAGE_SOURCE_EXTERNAL_OTEL).toBe('external-otel');
  });

  it('models a manifest as a faithful subset of AgentSpecProps', () => {
    const manifest: AgentManifest = {
      name: 'latam-credit-analyzer',
      modelId: 'gpt-4o',
      allowedTools: ['search', 'calculator'],
      riskTier: 'T2-medium',
      owner: { email: 'vincenzo@topaz.com', costCenter: 'LATAM-CC-001' },
      costCenter: 'LATAM-CC-001',
      squad: 'data-engineering',
      dataClassification: 'internal',
      runtime: {
        external: true,
        telemetry: {
          otelEndpoint: 'https://otel.cta.topaz.aws.com/v1/traces',
          serviceAccountId: 'svc-latam-credit-analyzer',
        },
      },
    };

    expect(manifest.owner?.email).toBe('vincenzo@topaz.com');
    expect(manifest.runtime?.telemetry?.serviceAccountId).toBe('svc-latam-credit-analyzer');
  });

  it('shapes ResourceAttributes with literal attribute keys', () => {
    const attrs: ResourceAttributes = {
      'service.name': 'latam-credit-analyzer',
      'gen_ai.agent.id': 'latam-credit-analyzer',
      'gen_ai.request.model': 'gpt-4o',
      'cta.cost_center': 'LATAM-CC-001',
      'cta.allowed_tools': ['search'],
    };

    expect(attrs['gen_ai.agent.id']).toBe('latam-credit-analyzer');
    expect(attrs['cta.allowed_tools']).toEqual(['search']);
  });

  it('shapes a PumpConfig with service-account credentials', () => {
    const config: PumpConfig = {
      endpoint: 'https://otel.cta.topaz.aws.com/v1/traces',
      serviceAccount: {
        clientId: 'svc-latam-credit-analyzer',
        clientSecret: 'shh',
        tokenUrl: 'https://auth.cta.topaz.aws.com/oauth2/token',
      },
      manifest: './manifest.yaml',
      enabled: true,
    };

    expect(config.serviceAccount.clientId).toBe('svc-latam-credit-analyzer');
    expect(typeof config.manifest).toBe('string');
  });

  it('shapes a UsageEventContract with a compliance finding', () => {
    const finding: ComplianceFinding = {
      code: 'TOOL_NOT_ALLOWED',
      severity: 'warning',
      message: 'Tool "shell" is not in allowedTools',
      tool: 'shell',
    };

    const event: UsageEventContract = {
      source: 'external-otel',
      userId: 'alice@topaz.com',
      model: 'gpt-4o',
      provider: 'aws.bedrock',
      inputTokens: 120,
      outputTokens: 45,
      metadata: {
        tools: ['search'],
        compliance: { status: 'non_compliant', findings: [finding] },
      },
    };

    expect(event.source).toBe('external-otel');
    expect(event.metadata?.compliance?.findings?.[0]?.code).toBe('TOOL_NOT_ALLOWED');
  });
});
