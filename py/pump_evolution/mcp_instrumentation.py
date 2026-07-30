"""
mcp_instrumentation — telemetria governada para **servidores MCP** (Model Context
Protocol), pra o CTA mapear MCPs no mesmo pipeline de observabilidade dos agentes.
Paridade 1:1 com `src/mcp-instrumentation.ts`.

Um servidor MCP é um provedor de tools sem modelo próprio: a unidade observável é
a **chamada de tool**. `trace_mcp_tool` embrulha um handler de tool MCP num span
GenAI `execute_tool` com os MESMOS sinais de governança dos agentes: identidade
(herdada do `with_user` ativo), compliance (tool vs `allowedTools`) e segurança
(input escaneado LOCALMENTE p/ sinais OWASP; só findings REDIGIDOS).

Invariantes: telemetria NUNCA quebra a tool call (se o span não inicia, `fn`
ainda roda; retorno/erro original preservado); sem dado fabricado; observa, não
bloqueia.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, TypeVar

from opentelemetry.trace import Span, SpanKind, Tracer

from .compliance_checker import (
    ComplianceEvaluationInput,
    apply_compliance_to_span,
    evaluate_compliance,
)
from .constants import GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, OPERATION_EXECUTE_TOOL
from .identity_context import apply_identity_to_span
from .security_checker import SecurityEvaluationInput, apply_security_to_span, evaluate_security
from .tool_tracer import run_with_span
from .types import DataClassification, McpToolInvocation

_T = TypeVar("_T")

# Máx. de chars do input escaneado p/ sinais OWASP (bound do trabalho por call).
_MAX_INPUT_SCAN_LEN = 8192


# ─── Dependencies ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class McpToolTracerDeps:
    tracer: Tracer
    allowed_tools: Sequence[str] = ()
    data_classification: Optional[DataClassification] = None
    security_enabled: bool = True


# ─── Helpers ────────────────────────────────────────────────────────────────────


def _read_tool_name(name: Any) -> str:
    trimmed = name.strip() if isinstance(name, str) else ""
    return "unknown_tool" if len(trimmed) == 0 else trimmed


def _apply_governance(
    span: Span, tool_name: str, invocation: McpToolInvocation, deps: McpToolTracerDeps
) -> None:
    """Aplica compliance + (opcional) segurança ao span da tool. Totalmente
    guardado — nunca quebra a tool call."""
    try:
        # Identidade — igual aos spans de agente: do contexto `with_user` ativo,
        # ou o marcador anônimo explícito (nunca um usuário fabricado).
        apply_identity_to_span(span)
        apply_compliance_to_span(
            span,
            evaluate_compliance(
                ComplianceEvaluationInput(
                    used_tools=[tool_name],
                    allowed_tools=list(deps.allowed_tools),
                    data_classification=deps.data_classification,
                )
            ),
        )
        if deps.security_enabled:
            apply_security_to_span(
                span,
                evaluate_security(
                    SecurityEvaluationInput(user_input=invocation.input)
                    if invocation.input is not None
                    else SecurityEvaluationInput()
                ),
            )
    except Exception:
        # Governança é telemetria — nunca quebra a tool call MCP.
        pass


# ─── Public API ─────────────────────────────────────────────────────────────────


def trace_mcp_tool(
    deps: McpToolTracerDeps, invocation: McpToolInvocation, fn: Callable[[], _T]
) -> _T:
    """Embrulha uma chamada de tool MCP num span `execute_tool` governado. O span
    aninha sob o span ativo (ex. um `with_user`), correlacionando à identidade do
    chamador. Registra compliance + segurança e roda `fn` com o mesmo tempo de
    vida/semântica de erro do `trace_tool`. Se iniciar o span falhar, `fn` roda
    sem traçar."""
    tool_name = _read_tool_name(invocation.name)
    try:
        span = deps.tracer.start_span(
            f"{OPERATION_EXECUTE_TOOL} {tool_name}", kind=SpanKind.INTERNAL
        )
        span.set_attribute(GEN_AI_OPERATION_NAME, OPERATION_EXECUTE_TOOL)
        span.set_attribute(GEN_AI_TOOL_NAME, tool_name)
    except Exception:
        return fn()

    _apply_governance(span, tool_name, invocation, deps)
    return run_with_span(span, fn)


# ─── Auto-instrumentação de um servidor MCP ─────────────────────────────────────


def _serialize_tool_input(value: Any) -> Optional[str]:
    """Serializa um input de tool p/ scan local; bounded, nunca lança."""
    if value is None:
        return None
    if isinstance(value, str):
        return value[:_MAX_INPUT_SCAN_LEN] if len(value) > _MAX_INPUT_SCAN_LEN else value
    try:
        s = json.dumps(value, default=str)
        return s[:_MAX_INPUT_SCAN_LEN] if len(s) > _MAX_INPUT_SCAN_LEN else s
    except Exception:
        return None


def _wrap_tool_registration(original: Callable[..., Any], deps: McpToolTracerDeps):
    """Embrulha um método de registro de tool (`register_tool`/`tool`/`add_tool`)
    pra todo handler registrado rodar dentro de um span `execute_tool` governado.
    O nome da tool é o primeiro arg string; o handler é o último arg callable. O
    input (primeiro arg passado ao handler em runtime) é escaneado localmente."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        name = args[0] if len(args) > 0 and isinstance(args[0], str) else "unknown_tool"
        # último arg posicional callable = handler
        last_index = -1
        for i in range(len(args) - 1, -1, -1):
            if callable(args[i]):
                last_index = i
                break
        if last_index < 0:
            return original(*args, **kwargs)
        original_handler = args[last_index]

        def traced_handler(*call_args: Any, **call_kwargs: Any) -> Any:
            input_str = _serialize_tool_input(call_args[0] if call_args else None)
            invocation = (
                McpToolInvocation(name=name, input=input_str)
                if input_str is not None
                else McpToolInvocation(name=name)
            )
            return trace_mcp_tool(deps, invocation, lambda: original_handler(*call_args, **call_kwargs))

        new_args = list(args)
        new_args[last_index] = traced_handler
        return original(*new_args, **kwargs)

    return wrapper


def instrument_mcp_server(deps: McpToolTracerDeps, server: Any) -> Any:
    """Auto-instrumenta um servidor MCP pra que TODA tool registrada seja
    governada transparentemente — sem `trace_mcp_tool` por handler. Os métodos de
    registro de tool são substituídos in-place; a mesma instância é retornada.

    ORDEM: chame logo após construir o servidor e ANTES de registrar tools — só
    tools registradas APÓS a instrumentação são embrulhadas."""
    for method in ("register_tool", "tool", "add_tool"):
        original = getattr(server, method, None)
        if callable(original):
            try:
                setattr(server, method, _wrap_tool_registration(original, deps))
            except Exception:
                pass
    return server
