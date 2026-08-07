"""
compliance_checker — avalia uma invocação contra o manifesto do agente e registra
o resultado no span da invocação (Requirement 6). Paridade 1:1 com
`src/compliance-checker.ts`.

Funções PURAS por regra (unit-testáveis isoladas) + um compositor best-effort e
um writer de span. Nenhuma pode lançar pro fluxo do agente: compliance é
telemetria, e telemetria nunca quebra o agente.

Decisões: tool fora do allowlist → `warning` (observa, não bloqueia); guardrail
exigido só pra `sensitive`; `evidence` é input explícito (o SDK é cliente, não
verifica guardrail real) → ausente/False pra agente `sensitive` gera finding de
GAP DECLARADO (não enforcement); qualquer finding ⇒ `non_compliant`; findings
serializados como UMA string JSON sob `cta.compliance.findings`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from opentelemetry.trace import Span

from .constants import CTA_COMPLIANCE_FINDINGS, CTA_COMPLIANCE_STATUS
from .types import ComplianceFinding, ComplianceSummary, DataClassification

# ─── Códigos de finding ─────────────────────────────────────────────────────────

# Uma tool usada não declarada no `allowedTools` do manifesto.
FINDING_TOOL_NOT_ALLOWED = "TOOL_NOT_ALLOWED"

# O manifesto declara `dataClassification` que exige guardrail/isolamento, mas
# nenhuma evidência foi fornecida ao SDK.
FINDING_GUARDRAIL_EVIDENCE_MISSING = "GUARDRAIL_EVIDENCE_MISSING"

# Classificações que exigem evidência declarada de guardrail/isolamento.
_GUARDRAIL_REQUIRED = frozenset(("sensitive",))


# ─── Regras puras ────────────────────────────────────────────────────────────────


def check_tools(
    used_tools: Sequence[str], allowed_tools: Sequence[str]
) -> List[ComplianceFinding]:
    """Um finding por tool DISTINTA usada que não está em `allowedTools`.
    Nomes vazios/não-string ignorados. Deduplicado (mesma tool ofensora reportada
    uma vez). Puro."""
    allowed = set(allowed_tools)
    reported: set = set()
    findings: List[ComplianceFinding] = []
    for tool in used_tools:
        if not isinstance(tool, str):
            continue
        name = tool.strip()
        if len(name) == 0 or name in allowed or name in reported:
            continue
        reported.add(name)
        findings.append(
            ComplianceFinding(
                code=FINDING_TOOL_NOT_ALLOWED,
                severity="warning",
                message=f'Tool "{name}" was used but is not declared in the manifest allowedTools.',
                tool=name,
            )
        )
    return findings


def check_data_classification_guardrail(
    data_classification: Optional[DataClassification],
    has_guardrail_evidence: Optional[bool],
) -> List[ComplianceFinding]:
    """Finding de gap de guardrail quando a `dataClassification` do manifesto
    exige guardrail e nenhuma evidência foi declarada. Puro."""
    if data_classification is None:
        return []
    if data_classification not in _GUARDRAIL_REQUIRED:
        return []
    if has_guardrail_evidence is True:
        return []
    return [
        ComplianceFinding(
            code=FINDING_GUARDRAIL_EVIDENCE_MISSING,
            severity="warning",
            message=(
                f'Data classification "{data_classification}" requires a declared '
                "guardrail/isolation, but no evidence was provided to the SDK. "
                "This is a declared-gap signal, not runtime enforcement."
            ),
            data_classification=data_classification,
        )
    ]


def summarize_compliance(findings: Sequence[ComplianceFinding]) -> ComplianceSummary:
    """Sumariza findings num status. Qualquer finding ⇒ `non_compliant`; nenhum ⇒
    `compliant`. Findings só anexados quando presentes. Puro."""
    status = "non_compliant" if len(findings) > 0 else "compliant"
    return (
        ComplianceSummary(status=status, findings=list(findings))
        if len(findings) > 0
        else ComplianceSummary(status=status)
    )


# ─── Composição (best-effort, nunca lança) ───────────────────────────────────────


@dataclass(frozen=True)
class ComplianceEvaluationInput:
    """Entradas de `evaluate_compliance`."""

    used_tools: Optional[Sequence[str]] = None
    allowed_tools: Optional[Sequence[str]] = None
    data_classification: Optional[DataClassification] = None
    guardrail_evidence: Optional[bool] = None


def evaluate_compliance(input: ComplianceEvaluationInput) -> ComplianceSummary:
    """Roda toda regra de compliance e sumariza. Best-effort: qualquer falha
    interna degrada pra um sumário `compliant` em vez de lançar — avaliação de
    compliance nunca quebra o fluxo do agente (Requirement 6.4)."""
    try:
        findings: List[ComplianceFinding] = [
            *check_tools(input.used_tools or [], input.allowed_tools or []),
            *check_data_classification_guardrail(
                input.data_classification, input.guardrail_evidence
            ),
        ]
        return summarize_compliance(findings)
    except Exception:
        return ComplianceSummary(status="compliant")


# ─── Writer de span ──────────────────────────────────────────────────────────────


def _finding_to_wire(f: ComplianceFinding) -> Dict[str, Any]:
    """Serializa um finding na forma do contrato (camelCase, omite ausentes)."""
    out: Dict[str, Any] = {"code": f.code, "severity": f.severity, "message": f.message}
    if f.tool is not None:
        out["tool"] = f.tool
    if f.data_classification is not None:
        out["dataClassification"] = f.data_classification
    return out


def apply_compliance_to_span(span: Span, summary: ComplianceSummary) -> None:
    """Escreve `cta.compliance.status` e, quando houver findings, os serializa como
    UMA string JSON sob `cta.compliance.findings`. Guardado — nunca lança."""
    try:
        span.set_attribute(CTA_COMPLIANCE_STATUS, summary.status)
        if summary.findings:
            span.set_attribute(
                CTA_COMPLIANCE_FINDINGS,
                json.dumps([_finding_to_wire(f) for f in summary.findings]),
            )
    except Exception:
        # Telemetria nunca quebra o fluxo do agente.
        pass
