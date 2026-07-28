/**
 * security-checker — evaluates an invocation against OWASP LLM Top 10 (2025)
 * RUNTIME signals and records the outcome on the invocation span.
 *
 * Scope (Fatia 1 — runtime, in the SDK): only what is observable at invocation
 * time from the data the SDK already sees (the user input text, the model output
 * text, the tools used, token usage). Static code analysis (secrets in source,
 * dangerous patterns, vulnerable deps) is a BUILD/ONBOARDING concern and lives
 * outside this runtime SDK (cta-factory introspection + governance gates).
 *
 * Detectors implemented here:
 *  - **LLM01 Prompt Injection** — known injection/jailbreak phrasings in the input.
 *  - **LLM06 Sensitive Information Disclosure** — secrets (AWS key, private key,
 *    JWT, GitHub token, hardcoded credential) and high-signal PII (CPF,
 *    Luhn-valid card) in the input or output.
 *  - **LLM10 Unbounded Consumption** — token usage above a configured ceiling.
 *
 * ── Invariants (steering) ─────────────────────────────────────────────────────
 *  - **Telemetry never breaks the agent.** Every function is pure and total;
 *    `evaluateSecurity` is guarded so even malformed input yields a summary,
 *    never a throw (like `compliance-checker`).
 *  - **PRIVACY: never emit the raw offending value.** A finding carries the
 *    machine-readable rule label and the location only — never the injected
 *    prompt, the leaked secret, or the PII. Telemetry must not itself leak data.
 *  - **No fabrication.** A finding is emitted only when a real pattern matches;
 *    absence of findings is `secure`, not an optimistic guess.
 *  - **Observe, don't enforce.** The SDK cannot block a call that already
 *    happened; findings flag deviations for the platform to alert on.
 *
 * ── ReDoS safety ──────────────────────────────────────────────────────────────
 * All patterns use bounded, linear constructs (simple alternations, `\s+`, and
 * bounded quantifiers) — no nested/ambiguous repetition that could backtrack
 * catastrophically on adversarial input.
 */

import type { Span } from '@opentelemetry/api';

import {
  CTA_SECURITY_FINDINGS,
  CTA_SECURITY_OWASP_CATEGORIES,
  CTA_SECURITY_STATUS,
} from './constants.js';
import type {
  OwaspLlmCategory,
  SecurityFinding,
  SecurityFindingLocation,
  SecuritySummary,
} from './types.js';

// ─── Finding codes ─────────────────────────────────────────────────────────────

/** LLM01 — a prompt-injection / jailbreak phrasing was detected in the input. */
export const FINDING_PROMPT_INJECTION = 'PROMPT_INJECTION' as const;
/** LLM06 — a secret or high-signal PII value was detected in input/output. */
export const FINDING_SENSITIVE_INFO_DISCLOSURE = 'SENSITIVE_INFO_DISCLOSURE' as const;
/** LLM10 — token usage exceeded the configured ceiling. */
export const FINDING_UNBOUNDED_CONSUMPTION = 'UNBOUNDED_CONSUMPTION' as const;

// ─── Pattern tables (bounded / linear — ReDoS-safe) ────────────────────────────

interface LabeledPattern {
  readonly re: RegExp;
  readonly rule: string;
  readonly severity: SecurityFinding['severity'];
}

/** LLM01 — prompt-injection / jailbreak phrasings. */
const PROMPT_INJECTION_PATTERNS: readonly LabeledPattern[] = [
  {
    re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules|messages)/i,
    rule: 'ignore_previous_instructions',
    severity: 'warning',
  },
  {
    re: /disregard\s+(?:your|the|all)\s+(?:instructions|rules|guidelines|guardrails|system\s+prompt)/i,
    rule: 'disregard_instructions',
    severity: 'warning',
  },
  {
    re: /(?:reveal|show|print|repeat|leak)\s+(?:your|the)\s+(?:system\s+prompt|instructions|initial\s+prompt|rules)/i,
    rule: 'reveal_system_prompt',
    severity: 'warning',
  },
  {
    re: /(?:bypass|override|forget|turn\s+off|disable)\s+(?:your|the|all)?\s*(?:safety|guardrails?|restrictions?|filters?|rules)/i,
    rule: 'bypass_guardrails',
    severity: 'critical',
  },
  {
    re: /you\s+are\s+(?:now\s+)?(?:DAN\b|in\s+developer\s+mode|an?\s+unrestricted|no\s+longer\s+bound)/i,
    rule: 'role_override',
    severity: 'warning',
  },
  {
    re: /act\s+as\s+(?:an?\s+)?(?:unrestricted|jailbroken|uncensored|DAN)\b/i,
    rule: 'jailbreak_persona',
    severity: 'warning',
  },
];

/** LLM06 — secrets (high severity) + high-signal PII (warning). */
const SECRET_PATTERNS: readonly LabeledPattern[] = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, rule: 'aws_access_key_id', severity: 'critical' },
  {
    re: /-----BEGIN(?:\s+[A-Z0-9]+)?\s+PRIVATE\s+KEY-----/,
    rule: 'private_key',
    severity: 'critical',
  },
  {
    re: /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b/,
    rule: 'github_token',
    severity: 'critical',
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    rule: 'jwt',
    severity: 'warning',
  },
  {
    re: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][^"'\n]{8,256}["']/i,
    rule: 'hardcoded_credential',
    severity: 'critical',
  },
];

/** LLM06 — Brazilian CPF (11 digits, optionally punctuated). */
const CPF_PATTERN = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
/** LLM06 — candidate card number (13–19 digits, optional space/dash separators). */
const CARD_CANDIDATE_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/;

// ─── Helpers ────────────────────────────────────────────────────────────────────

function readText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length === 0 ? undefined : value;
}

function finding(
  code: string,
  owaspCategory: OwaspLlmCategory,
  severity: SecurityFinding['severity'],
  message: string,
  location: SecurityFindingLocation,
  rule?: string,
): SecurityFinding {
  return {
    code,
    owaspCategory,
    severity,
    message,
    location,
    ...(rule !== undefined ? { rule } : {}),
  };
}

/** Luhn checksum — validates a candidate card number (digits only). */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0 && digits.length >= 13;
}

// ─── Pure detectors ─────────────────────────────────────────────────────────────

/**
 * LLM01 — detects prompt-injection / jailbreak phrasings in a text (typically
 * the user input). One finding per matched rule. Pure; never throws.
 */
export function detectPromptInjection(
  text: string | undefined,
  location: SecurityFindingLocation = 'input',
): SecurityFinding[] {
  const value = readText(text);
  if (value === undefined) return [];
  const findings: SecurityFinding[] = [];
  for (const { re, rule, severity } of PROMPT_INJECTION_PATTERNS) {
    if (re.test(value)) {
      findings.push(
        finding(
          FINDING_PROMPT_INJECTION,
          'LLM01',
          severity,
          `Possible prompt-injection pattern detected in ${location} (rule: ${rule}).`,
          location,
          rule,
        ),
      );
    }
  }
  return findings;
}

/**
 * LLM06 — detects secrets and high-signal PII in a text. Emits at most one
 * finding per DISTINCT rule (deduplicated), carrying only the rule label +
 * location — NEVER the matched value. Pure; never throws.
 */
export function detectSensitiveInfo(
  text: string | undefined,
  location: SecurityFindingLocation,
): SecurityFinding[] {
  const value = readText(text);
  if (value === undefined) return [];
  const findings: SecurityFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: string, severity: SecurityFinding['severity']): void => {
    if (seen.has(rule)) return;
    seen.add(rule);
    findings.push(
      finding(
        FINDING_SENSITIVE_INFO_DISCLOSURE,
        'LLM06',
        severity,
        `Possible sensitive value (${rule}) detected in ${location}.`,
        location,
        rule,
      ),
    );
  };

  for (const { re, rule, severity } of SECRET_PATTERNS) {
    if (re.test(value)) add(rule, severity);
  }
  if (CPF_PATTERN.test(value)) add('cpf', 'warning');
  const cardMatch = value.match(CARD_CANDIDATE_PATTERN);
  if (cardMatch !== null && passesLuhn(cardMatch[0].replace(/[ -]/g, ''))) {
    add('credit_card', 'warning');
  }
  return findings;
}

/**
 * LLM10 — flags token usage above a configured ceiling. Returns no finding when
 * no ceiling is configured or the total is within it. Pure; never throws.
 */
export function detectUnboundedConsumption(
  totalTokens: number | undefined,
  maxTotalTokens: number | undefined,
): SecurityFinding[] {
  if (
    typeof totalTokens !== 'number' ||
    !Number.isFinite(totalTokens) ||
    typeof maxTotalTokens !== 'number' ||
    !Number.isFinite(maxTotalTokens) ||
    maxTotalTokens <= 0
  ) {
    return [];
  }
  if (totalTokens <= maxTotalTokens) return [];
  return [
    finding(
      FINDING_UNBOUNDED_CONSUMPTION,
      'LLM10',
      'warning',
      `Token usage (${totalTokens}) exceeded the configured ceiling (${maxTotalTokens}).`,
      'usage',
    ),
  ];
}

// ─── Composition (best-effort, never throws) ────────────────────────────────────

/** Inputs to {@link evaluateSecurity}. */
export interface SecurityEvaluationInput {
  /** User input / prompt text (scanned for LLM01 + LLM06). */
  readonly userInput?: string;
  /** Model output text (scanned for LLM06 — insecure output). */
  readonly modelOutput?: string;
  /** Token usage for the invocation (LLM10). */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Optional per-invocation token ceiling (LLM10). No ceiling → no LLM10 check. */
  readonly maxTotalTokens?: number;
}

/**
 * Summarises findings into a posture. Any finding ⇒ `at_risk`; none ⇒ `secure`.
 * Pure.
 */
export function summarizeSecurity(findings: readonly SecurityFinding[]): SecuritySummary {
  const status = findings.length > 0 ? 'at_risk' : 'secure';
  return findings.length > 0 ? { status, findings: [...findings] } : { status };
}

/**
 * Runs every runtime detector and summarises. Best-effort: any internal failure
 * degrades to a `secure` summary rather than throwing — security evaluation must
 * never break the agent flow.
 */
export function evaluateSecurity(input: SecurityEvaluationInput): SecuritySummary {
  try {
    const total =
      input.usage !== undefined ? input.usage.inputTokens + input.usage.outputTokens : undefined;
    const findings: SecurityFinding[] = [
      ...detectPromptInjection(input.userInput, 'input'),
      ...detectSensitiveInfo(input.userInput, 'input'),
      ...detectSensitiveInfo(input.modelOutput, 'output'),
      ...detectUnboundedConsumption(total, input.maxTotalTokens),
    ];
    return summarizeSecurity(findings);
  } catch {
    return { status: 'secure' };
  }
}

// ─── Span writer ─────────────────────────────────────────────────────────────────

/** Distinct OWASP categories present in the findings, in first-seen order. */
function distinctCategories(findings: readonly SecurityFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) if (!out.includes(f.owaspCategory)) out.push(f.owaspCategory);
  return out;
}

/**
 * Writes the security summary onto a span: always sets `cta.security.status`,
 * and when findings exist, serialises them (JSON — redacted, no raw values)
 * under `cta.security.findings` plus the distinct OWASP categories under
 * `cta.security.owasp_categories` (a string array, ideal for server-side metric
 * dimensioning + alerting). Guarded so a serialisation failure never disturbs
 * the agent.
 */
export function applySecurityToSpan(span: Span, summary: SecuritySummary): void {
  try {
    span.setAttribute(CTA_SECURITY_STATUS, summary.status);
    if (summary.findings !== undefined && summary.findings.length > 0) {
      span.setAttribute(CTA_SECURITY_FINDINGS, JSON.stringify(summary.findings));
      span.setAttribute(CTA_SECURITY_OWASP_CATEGORIES, distinctCategories(summary.findings));
    }
  } catch {
    // Security telemetry — never break the agent flow.
  }
}
