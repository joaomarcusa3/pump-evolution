/**
 * compliance-checker — evaluates an invocation against the agent manifest and
 * records the outcome on the invocation span (Requirement 6).
 *
 * The checker is deliberately built from small PURE functions so each rule is
 * unit-testable in isolation, plus a best-effort `evaluateCompliance` composer
 * and a span writer. None of these functions may throw into the agent flow:
 * compliance is telemetry, and telemetry never breaks the agent (Requirement
 * 6.4). `evaluateCompliance` is guarded so even malformed input yields a result.
 *
 * ── Decisions (documented, per the task) ─────────────────────────────────────
 *  - **Tool-outside-allowlist severity = `warning`.** A tool used that is not
 *    declared in the manifest `allowedTools` is a real governance deviation, but
 *    the SDK observes rather than enforces (it cannot block the call that already
 *    happened). `warning` flags it for review without implying the run was
 *    catastrophic; the design does not call for a stronger level.
 *  - **Data-classification guardrail threshold = `sensitive`.** Only the
 *    `sensitive` classification is treated as requiring declared guardrail /
 *    isolation evidence. `public` and `internal` do not. This is the natural
 *    reading of the CTA classification ladder (sensitive data is what needs a
 *    guardrail); the threshold is centralised in {@link GUARDRAIL_REQUIRED} so it
 *    is explicit and easy to change.
 *  - **`evidence` is an explicit input, not an assumption.** Because the SDK is
 *    client-side it cannot verify a real runtime guardrail. `guardrailEvidence`
 *    is an opt-in boolean the developer/init passes to declare that a guardrail
 *    is in place. When absent/false for a `sensitive` agent, the checker emits a
 *    DECLARED-GAP finding — it flags that the manifest declares a classification
 *    needing a guardrail but the SDK has no signal one is in place. This is a
 *    declared-gap signal, NOT runtime guardrail enforcement (aligns with
 *    ADR-0040: the SDK audits declared config; it does not enforce a firewall).
 *  - **Any finding ⇒ `non_compliant`.** The simplest rule that satisfies Req
 *    6.1/6.2: presence of any finding flips the status; no findings ⇒ compliant.
 *  - **`cta.compliance.findings` encoding.** Findings are serialised as a SINGLE
 *    JSON string (a JSON array of finding objects) under
 *    `cta.compliance.findings`. OTel attribute values cannot be arbitrary
 *    objects; a single JSON string is the simplest faithful encoding. The
 *    server-side mapper (Tasks 9/10) that reads `metadata.compliance` MUST mirror
 *    this by `JSON.parse`-ing the attribute back into `ComplianceFinding[]`.
 */

import type { Span } from '@opentelemetry/api';

import { CTA_COMPLIANCE_FINDINGS, CTA_COMPLIANCE_STATUS } from './constants.js';
import type {
  ComplianceFinding,
  ComplianceStatus,
  ComplianceSummary,
  DataClassification,
} from './types.js';

// ─── Finding codes ─────────────────────────────────────────────────────────────

/** A tool was used that is not declared in the manifest `allowedTools`. */
export const FINDING_TOOL_NOT_ALLOWED = 'TOOL_NOT_ALLOWED' as const;

/**
 * The manifest declares a `dataClassification` that requires a guardrail /
 * isolation, but no evidence of one was provided to the SDK.
 */
export const FINDING_GUARDRAIL_EVIDENCE_MISSING = 'GUARDRAIL_EVIDENCE_MISSING' as const;

/** Data classifications that require declared guardrail/isolation evidence. */
const GUARDRAIL_REQUIRED: ReadonlySet<DataClassification> = new Set<DataClassification>([
  'sensitive',
]);

// ─── Pure rules ─────────────────────────────────────────────────────────────────

/**
 * Produces one finding per DISTINCT used tool that is not present in
 * `allowedTools`. Empty/non-string tool names are ignored. Deduplicated so the
 * same offending tool is reported once. Pure.
 */
export function checkTools(
  usedTools: readonly string[],
  allowedTools: readonly string[],
): ComplianceFinding[] {
  const allowed = new Set(allowedTools);
  const reported = new Set<string>();
  const findings: ComplianceFinding[] = [];
  for (const tool of usedTools) {
    if (typeof tool !== 'string') continue;
    const name = tool.trim();
    if (name.length === 0 || allowed.has(name) || reported.has(name)) continue;
    reported.add(name);
    findings.push({
      code: FINDING_TOOL_NOT_ALLOWED,
      severity: 'warning',
      message: `Tool "${name}" was used but is not declared in the manifest allowedTools.`,
      tool: name,
    });
  }
  return findings;
}

/**
 * Produces a guardrail-gap finding when the manifest's `dataClassification`
 * requires a guardrail (see {@link GUARDRAIL_REQUIRED}) and no evidence of one
 * was declared. Pure.
 *
 * @param dataClassification the manifest's declared classification (may be absent)
 * @param hasGuardrailEvidence explicit opt-in signalling a guardrail is in place
 */
export function checkDataClassificationGuardrail(
  dataClassification: DataClassification | undefined,
  hasGuardrailEvidence: boolean | undefined,
): ComplianceFinding[] {
  if (dataClassification === undefined) return [];
  if (!GUARDRAIL_REQUIRED.has(dataClassification)) return [];
  if (hasGuardrailEvidence === true) return [];
  return [
    {
      code: FINDING_GUARDRAIL_EVIDENCE_MISSING,
      severity: 'warning',
      message:
        `Data classification "${dataClassification}" requires a declared guardrail/isolation, ` +
        'but no evidence was provided to the SDK. This is a declared-gap signal, not runtime enforcement.',
      dataClassification,
    },
  ];
}

/**
 * Summarises findings into a status. Any finding ⇒ `non_compliant`; none ⇒
 * `compliant`. Findings are only attached when present. Pure.
 */
export function summarizeCompliance(findings: readonly ComplianceFinding[]): ComplianceSummary {
  const status: ComplianceStatus = findings.length > 0 ? 'non_compliant' : 'compliant';
  return findings.length > 0 ? { status, findings: [...findings] } : { status };
}

// ─── Composition (best-effort, never throws) ────────────────────────────────────

/** Inputs to {@link evaluateCompliance}. */
export interface ComplianceEvaluationInput {
  /** Tool names observed during the invocation. */
  readonly usedTools?: readonly string[];
  /** The manifest `allowedTools` allowlist. */
  readonly allowedTools?: readonly string[];
  /** The manifest `dataClassification`. */
  readonly dataClassification?: DataClassification;
  /** Explicit opt-in evidence that a guardrail/isolation is in place. */
  readonly guardrailEvidence?: boolean;
}

/**
 * Runs every compliance rule and summarises the result. Best-effort: any
 * internal failure (e.g. a non-iterable slipping past the types) degrades to a
 * `compliant` summary rather than throwing — compliance evaluation must never
 * break the agent flow (Requirement 6.4).
 */
export function evaluateCompliance(input: ComplianceEvaluationInput): ComplianceSummary {
  try {
    const findings: ComplianceFinding[] = [
      ...checkTools(input.usedTools ?? [], input.allowedTools ?? []),
      ...checkDataClassificationGuardrail(input.dataClassification, input.guardrailEvidence),
    ];
    return summarizeCompliance(findings);
  } catch {
    return { status: 'compliant' };
  }
}

// ─── Span writer ─────────────────────────────────────────────────────────────────

/**
 * Writes the compliance summary onto a span: always sets
 * `cta.compliance.status`, and when findings exist, serialises them as a single
 * JSON string under `cta.compliance.findings` (see module docs — the server side
 * mirrors this by `JSON.parse`). Guarded so a serialisation failure never
 * disturbs the agent.
 */
export function applyComplianceToSpan(span: Span, summary: ComplianceSummary): void {
  try {
    span.setAttribute(CTA_COMPLIANCE_STATUS, summary.status);
    if (summary.findings !== undefined && summary.findings.length > 0) {
      span.setAttribute(CTA_COMPLIANCE_FINDINGS, JSON.stringify(summary.findings));
    }
  } catch {
    // Compliance is telemetry — never break the agent flow (Requirement 6.4).
  }
}
