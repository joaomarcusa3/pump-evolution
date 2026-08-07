"""
security_checker — avalia uma invocação contra sinais de RUNTIME do OWASP LLM Top
10 (2025) e registra o resultado no span. Paridade 1:1 com `src/security-checker.ts`.

Escopo (runtime, no SDK): só o observável no momento da invocação a partir do que
o SDK já vê (texto de input, texto de output, tools usadas, uso de tokens).
Análise estática de código é concern de BUILD/ONBOARDING, fora deste SDK.

Detectores:
  - LLM01 Prompt Injection — frases conhecidas de injection/jailbreak no input.
  - LLM06 Sensitive Information Disclosure — segredos (AWS key, private key, JWT,
    GitHub token, credencial hardcoded) e PII de alto sinal (CPF, cartão Luhn) no
    input ou output.
  - LLM10 Unbounded Consumption — uso de tokens acima de um teto configurado.

Invariantes: telemetria nunca quebra o agente (tudo puro/total; `evaluate_security`
guardado); PRIVACIDADE — nunca emite o valor cru ofensivo (só o rótulo de regra +
localização); sem fabricação; observa, não bloqueia. Regex bounded/lineares
(ReDoS-safe).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from opentelemetry.trace import Span

from .constants import (
    CTA_SECURITY_FINDINGS,
    CTA_SECURITY_OWASP_CATEGORIES,
    CTA_SECURITY_STATUS,
)
from .types import (
    OwaspLlmCategory,
    SecurityFinding,
    SecurityFindingLocation,
    SecuritySummary,
    SecuritySeverity,
)

# ─── Códigos de finding ─────────────────────────────────────────────────────────

FINDING_PROMPT_INJECTION = "PROMPT_INJECTION"  # LLM01
FINDING_SENSITIVE_INFO_DISCLOSURE = "SENSITIVE_INFO_DISCLOSURE"  # LLM06
FINDING_UNBOUNDED_CONSUMPTION = "UNBOUNDED_CONSUMPTION"  # LLM10


# ─── Tabelas de padrões (bounded/lineares — ReDoS-safe) ────────────────────────


@dataclass(frozen=True)
class _LabeledPattern:
    re: "re.Pattern[str]"
    rule: str
    severity: SecuritySeverity


# LLM01 — frases de prompt-injection / jailbreak.
_PROMPT_INJECTION_PATTERNS: List[_LabeledPattern] = [
    _LabeledPattern(
        re.compile(
            r"ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+"
            r"(?:instructions|prompts|rules|messages)",
            re.IGNORECASE,
        ),
        "ignore_previous_instructions",
        "warning",
    ),
    _LabeledPattern(
        re.compile(
            r"disregard\s+(?:your|the|all)\s+"
            r"(?:instructions|rules|guidelines|guardrails|system\s+prompt)",
            re.IGNORECASE,
        ),
        "disregard_instructions",
        "warning",
    ),
    _LabeledPattern(
        re.compile(
            r"(?:reveal|show|print|repeat|leak)\s+(?:your|the)\s+"
            r"(?:system\s+prompt|instructions|initial\s+prompt|rules)",
            re.IGNORECASE,
        ),
        "reveal_system_prompt",
        "warning",
    ),
    _LabeledPattern(
        re.compile(
            r"(?:bypass|override|forget|turn\s+off|disable)\s+(?:your|the|all)?\s*"
            r"(?:safety|guardrails?|restrictions?|filters?|rules)",
            re.IGNORECASE,
        ),
        "bypass_guardrails",
        "critical",
    ),
    _LabeledPattern(
        re.compile(
            r"you\s+are\s+(?:now\s+)?(?:DAN\b|in\s+developer\s+mode|an?\s+unrestricted|"
            r"no\s+longer\s+bound)",
            re.IGNORECASE,
        ),
        "role_override",
        "warning",
    ),
    _LabeledPattern(
        re.compile(r"act\s+as\s+(?:an?\s+)?(?:unrestricted|jailbroken|uncensored|DAN)\b", re.IGNORECASE),
        "jailbreak_persona",
        "warning",
    ),
]

# LLM06 — segredos (severidade alta) + PII de alto sinal (warning).
_SECRET_PATTERNS: List[_LabeledPattern] = [
    _LabeledPattern(re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "aws_access_key_id", "critical"),
    _LabeledPattern(
        re.compile(r"-----BEGIN(?:\s+[A-Z0-9]+)?\s+PRIVATE\s+KEY-----"),
        "private_key",
        "critical",
    ),
    _LabeledPattern(
        re.compile(r"\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b"),
        "github_token",
        "critical",
    ),
    _LabeledPattern(
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
        "jwt",
        "warning",
    ),
    _LabeledPattern(
        re.compile(
            r"""(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password)"""
            r"""["']?\s*[:=]\s*["'][^"'\n]{8,256}["']""",
            re.IGNORECASE,
        ),
        "hardcoded_credential",
        "critical",
    ),
]

# LLM06 — CPF brasileiro (11 dígitos, pontuação opcional).
_CPF_PATTERN = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")
# LLM06 — candidato a número de cartão (13–19 dígitos, separadores opcionais).
_CARD_CANDIDATE_PATTERN = re.compile(r"\b\d(?:[ -]?\d){12,18}\b")


# ─── Helpers ────────────────────────────────────────────────────────────────────


def _read_text(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return None if len(value) == 0 else value


def _finding(
    code: str,
    owasp_category: OwaspLlmCategory,
    severity: SecuritySeverity,
    message: str,
    location: SecurityFindingLocation,
    rule: Optional[str] = None,
) -> SecurityFinding:
    return SecurityFinding(
        code=code,
        owasp_category=owasp_category,
        severity=severity,
        message=message,
        location=location,
        rule=rule,
    )


def _passes_luhn(digits: str) -> bool:
    """Checksum de Luhn — valida um candidato a cartão (só dígitos)."""
    total = 0
    double = False
    for i in range(len(digits) - 1, -1, -1):
        d = ord(digits[i]) - 48  # '0' = 48
        if d < 0 or d > 9:
            return False
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0 and len(digits) >= 13


# ─── Detectores puros ────────────────────────────────────────────────────────────


def detect_prompt_injection(
    text: Optional[str], location: SecurityFindingLocation = "input"
) -> List[SecurityFinding]:
    """LLM01 — detecta frases de prompt-injection / jailbreak num texto (tipicamente
    o input do usuário). Um finding por regra casada. Puro; nunca lança."""
    value = _read_text(text)
    if value is None:
        return []
    findings: List[SecurityFinding] = []
    for p in _PROMPT_INJECTION_PATTERNS:
        if p.re.search(value):
            findings.append(
                _finding(
                    FINDING_PROMPT_INJECTION,
                    "LLM01",
                    p.severity,
                    f"Possible prompt-injection pattern detected in {location} (rule: {p.rule}).",
                    location,
                    p.rule,
                )
            )
    return findings


def detect_sensitive_info(
    text: Optional[str], location: SecurityFindingLocation
) -> List[SecurityFinding]:
    """LLM06 — detecta segredos e PII de alto sinal num texto. No máximo um finding
    por regra DISTINTA (deduplicado), carregando só o rótulo + localização — NUNCA
    o valor casado. Puro; nunca lança."""
    value = _read_text(text)
    if value is None:
        return []
    findings: List[SecurityFinding] = []
    seen: set = set()

    def add(rule: str, severity: SecuritySeverity) -> None:
        if rule in seen:
            return
        seen.add(rule)
        findings.append(
            _finding(
                FINDING_SENSITIVE_INFO_DISCLOSURE,
                "LLM06",
                severity,
                f"Possible sensitive value ({rule}) detected in {location}.",
                location,
                rule,
            )
        )

    for p in _SECRET_PATTERNS:
        if p.re.search(value):
            add(p.rule, p.severity)
    if _CPF_PATTERN.search(value):
        add("cpf", "warning")
    card_match = _CARD_CANDIDATE_PATTERN.search(value)
    if card_match is not None and _passes_luhn(re.sub(r"[ -]", "", card_match.group(0))):
        add("credit_card", "warning")
    return findings


def detect_unbounded_consumption(
    total_tokens: Optional[float], max_total_tokens: Optional[float]
) -> List[SecurityFinding]:
    """LLM10 — sinaliza uso de tokens acima de um teto configurado. Sem finding
    quando não há teto ou o total está dentro dele. Puro; nunca lança."""
    import math

    if (
        not isinstance(total_tokens, (int, float))
        or isinstance(total_tokens, bool)
        or not math.isfinite(total_tokens)
        or not isinstance(max_total_tokens, (int, float))
        or isinstance(max_total_tokens, bool)
        or not math.isfinite(max_total_tokens)
        or max_total_tokens <= 0
    ):
        return []
    if total_tokens <= max_total_tokens:
        return []
    return [
        _finding(
            FINDING_UNBOUNDED_CONSUMPTION,
            "LLM10",
            "warning",
            f"Token usage ({total_tokens}) exceeded the configured ceiling ({max_total_tokens}).",
            "usage",
        )
    ]


# ─── Composição (best-effort, nunca lança) ───────────────────────────────────────


@dataclass(frozen=True)
class _Usage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class SecurityEvaluationInput:
    """Entradas de `evaluate_security`."""

    user_input: Optional[str] = None
    model_output: Optional[str] = None
    usage: Optional[_Usage] = None
    max_total_tokens: Optional[float] = None


def summarize_security(findings: List[SecurityFinding]) -> SecuritySummary:
    """Sumariza findings numa postura. Qualquer finding ⇒ `at_risk`; nenhum ⇒
    `secure`. Puro."""
    status = "at_risk" if len(findings) > 0 else "secure"
    return (
        SecuritySummary(status=status, findings=list(findings))
        if len(findings) > 0
        else SecuritySummary(status=status)
    )


def evaluate_security(input: SecurityEvaluationInput) -> SecuritySummary:
    """Roda todo detector e sumariza. Best-effort: qualquer falha degrada pra
    `secure` em vez de lançar — telemetria nunca quebra o agente."""
    try:
        total = (
            input.usage.input_tokens + input.usage.output_tokens
            if input.usage is not None
            else None
        )
        findings: List[SecurityFinding] = [
            *detect_prompt_injection(input.user_input, "input"),
            *detect_sensitive_info(input.user_input, "input"),
            *detect_sensitive_info(input.model_output, "output"),
            *detect_unbounded_consumption(total, input.max_total_tokens),
        ]
        return summarize_security(findings)
    except Exception:
        return SecuritySummary(status="secure")


# ─── Writer de span ──────────────────────────────────────────────────────────────


def _finding_to_wire(f: SecurityFinding) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "code": f.code,
        "owaspCategory": f.owasp_category,
        "severity": f.severity,
        "message": f.message,
        "location": f.location,
    }
    if f.rule is not None:
        out["rule"] = f.rule
    return out


def apply_security_to_span(span: Span, summary: SecuritySummary) -> None:
    """Escreve `cta.security.status`; havendo findings, serializa-os como UMA
    string JSON sob `cta.security.findings` e as categorias OWASP distintas sob
    `cta.security.owasp_categories`. Guardado — nunca lança."""
    try:
        span.set_attribute(CTA_SECURITY_STATUS, summary.status)
        if summary.findings:
            span.set_attribute(
                CTA_SECURITY_FINDINGS,
                json.dumps([_finding_to_wire(f) for f in summary.findings]),
            )
            categories: List[str] = []
            for f in summary.findings:
                if f.owasp_category not in categories:
                    categories.append(f.owasp_category)
            span.set_attribute(CTA_SECURITY_OWASP_CATEGORIES, categories)
    except Exception:
        # Telemetria nunca quebra o fluxo do agente.
        pass
