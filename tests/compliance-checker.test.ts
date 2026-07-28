import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyComplianceToSpan,
  checkDataClassificationGuardrail,
  checkTools,
  createTracerProvider,
  evaluateCompliance,
  FINDING_GUARDRAIL_EVIDENCE_MISSING,
  FINDING_TOOL_NOT_ALLOWED,
  getTracer,
  summarizeCompliance,
  type ResourceAttributes,
} from '../src/index.js';

const ATTRS: ResourceAttributes = {
  'service.name': 'cmp-agent',
  'gen_ai.agent.id': 'cmp-agent',
  'gen_ai.request.model': 'anthropic.claude-sonnet-4',
};

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.shutdown()));
});

// ─── checkTools ────────────────────────────────────────────────────────────────

describe('checkTools', () => {
  it('returns no findings when every used tool is in the allowlist', () => {
    expect(checkTools(['get_weather', 'search'], ['get_weather', 'search', 'calc'])).toEqual([]);
  });

  it('flags each distinct tool used outside the allowlist (deduplicated)', () => {
    const findings = checkTools(['rm_rf', 'rm_rf', 'exfiltrate'], ['get_weather']);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.tool)).toEqual(['rm_rf', 'exfiltrate']);
    expect(findings[0]).toMatchObject({ code: FINDING_TOOL_NOT_ALLOWED, severity: 'warning' });
  });

  it('ignores blank tool names', () => {
    expect(checkTools(['   ', ''], ['x'])).toEqual([]);
  });
});

// ─── checkDataClassificationGuardrail ──────────────────────────────────────────

describe('checkDataClassificationGuardrail', () => {
  it('flags a sensitive classification with no guardrail evidence', () => {
    const findings = checkDataClassificationGuardrail('sensitive', undefined);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: FINDING_GUARDRAIL_EVIDENCE_MISSING,
      dataClassification: 'sensitive',
    });
  });

  it('does not flag sensitive when guardrail evidence is declared', () => {
    expect(checkDataClassificationGuardrail('sensitive', true)).toEqual([]);
  });

  it('does not flag non-sensitive classifications', () => {
    expect(checkDataClassificationGuardrail('internal', undefined)).toEqual([]);
    expect(checkDataClassificationGuardrail('public', false)).toEqual([]);
  });

  it('does not flag when classification is absent', () => {
    expect(checkDataClassificationGuardrail(undefined, undefined)).toEqual([]);
  });
});

// ─── summarizeCompliance ───────────────────────────────────────────────────────

describe('summarizeCompliance', () => {
  it('is compliant with no findings and omits the findings field', () => {
    expect(summarizeCompliance([])).toEqual({ status: 'compliant' });
  });

  it('is non_compliant when any finding exists', () => {
    const summary = summarizeCompliance([
      { code: FINDING_TOOL_NOT_ALLOWED, severity: 'warning', message: 'x' },
    ]);
    expect(summary.status).toBe('non_compliant');
    expect(summary.findings).toHaveLength(1);
  });
});

// ─── evaluateCompliance (composition, best-effort) ─────────────────────────────

describe('evaluateCompliance', () => {
  it('is compliant when tools are allowed and classification needs no guardrail', () => {
    expect(
      evaluateCompliance({
        usedTools: ['search'],
        allowedTools: ['search'],
        dataClassification: 'internal',
      }),
    ).toEqual({ status: 'compliant' });
  });

  it('aggregates a tool violation and a guardrail gap into non_compliant', () => {
    const summary = evaluateCompliance({
      usedTools: ['exfiltrate'],
      allowedTools: ['search'],
      dataClassification: 'sensitive',
    });
    expect(summary.status).toBe('non_compliant');
    expect(summary.findings?.map((f) => f.code)).toEqual([
      FINDING_TOOL_NOT_ALLOWED,
      FINDING_GUARDRAIL_EVIDENCE_MISSING,
    ]);
  });

  it('treats missing optional inputs as empty (no throw, compliant)', () => {
    expect(evaluateCompliance({})).toEqual({ status: 'compliant' });
  });
});

// ─── applyComplianceToSpan ─────────────────────────────────────────────────────

describe('applyComplianceToSpan', () => {
  function makeTracerSpan() {
    const exporter = new InMemorySpanExporter();
    const provider = createTracerProvider({
      resourceAttributes: ATTRS,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    providers.push(provider);
    return { exporter, span: getTracer(provider).startSpan('invocation') };
  }

  it('sets the status attribute and serialises findings as a JSON string', () => {
    const { exporter, span } = makeTracerSpan();
    applyComplianceToSpan(span, {
      status: 'non_compliant',
      findings: [
        { code: FINDING_TOOL_NOT_ALLOWED, severity: 'warning', message: 'nope', tool: 'x' },
      ],
    });
    span.end();

    const [finished] = exporter.getFinishedSpans();
    expect(finished!.attributes['cta.compliance.status']).toBe('non_compliant');
    const raw = finished!.attributes['cta.compliance.findings'];
    expect(typeof raw).toBe('string');
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual([
      { code: FINDING_TOOL_NOT_ALLOWED, severity: 'warning', message: 'nope', tool: 'x' },
    ]);
  });

  it('sets only the status when compliant (no findings attribute)', () => {
    const { exporter, span } = makeTracerSpan();
    applyComplianceToSpan(span, { status: 'compliant' });
    span.end();

    const [finished] = exporter.getFinishedSpans();
    expect(finished!.attributes['cta.compliance.status']).toBe('compliant');
    expect('cta.compliance.findings' in finished!.attributes).toBe(false);
  });
});
