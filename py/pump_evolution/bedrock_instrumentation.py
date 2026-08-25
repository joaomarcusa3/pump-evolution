"""
bedrock_instrumentation — instrumenta um cliente Amazon Bedrock (boto3
`bedrock-runtime`) pra cada invocação de modelo emitir um span GenAI-semconv
(Requirement 3), sem o dev mudar call-site. Contrato de span idêntico ao
`src/bedrock-instrumentation.ts`.

Nota de adaptação (framework-específico, não perde contrato): o SDK TS
patcheia `client.send(command)` do AWS SDK v3. O boto3 não tem command — expõe
métodos diretos (`converse`, `converse_stream`, `invoke_model`,
`invoke_model_with_response_stream`). Aqui envolvemos esses métodos no cliente.
O span emitido é o MESMO: `gen_ai.operation.name` (chat/text_completion),
`gen_ai.provider.name=aws.bedrock`, `gen_ai.request.model`, usage (ou o marcador
explícito `cta.usage.tokens_available=false`), finish reasons, spans
`execute_tool` das tools, compliance + OWASP-security + identidade.

Invariantes: idempotente (flag no cliente); um erro REAL do Bedrock propaga
inalterado; um bug da NOSSA telemetria é engolido (reportado via `on_error`) e a
chamada original ainda retorna. Privacidade: input/output crus nunca viram
telemetria — só findings redigidos.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence

from opentelemetry.trace import SpanKind, Status, StatusCode, Tracer

from .compliance_checker import (
    ComplianceEvaluationInput,
    apply_compliance_to_span,
    evaluate_compliance,
)
from .constants import (
    CTA_USAGE_TOKENS_AVAILABLE,
    GEN_AI_OPERATION_NAME,
    GEN_AI_PROVIDER_NAME,
    GEN_AI_REQUEST_MODEL,
    GEN_AI_RESPONSE_FINISH_REASONS,
    GEN_AI_USAGE_INPUT_TOKENS,
    GEN_AI_USAGE_OUTPUT_TOKENS,
    OPERATION_CHAT,
    OPERATION_TEXT_COMPLETION,
    PROVIDER_AWS_BEDROCK,
)
from .identity_context import apply_identity_to_span
from .security_checker import SecurityEvaluationInput, _Usage, apply_security_to_span, evaluate_security
from .tool_tracer import ObservedToolUse, extract_tool_uses, record_tool_use_spans
from .types import DataClassification

# Flag de idempotência (marca um cliente já instrumentado).
_INSTRUMENTED = "_pump_evolution_instrumented"

# Método boto3 → (operation, streaming, stream_field)
_METHODS = {
    "converse": (OPERATION_CHAT, False, None),
    "converse_stream": (OPERATION_CHAT, True, "stream"),
    "invoke_model": (OPERATION_TEXT_COMPLETION, False, "body"),
    "invoke_model_with_response_stream": (OPERATION_TEXT_COMPLETION, True, "body"),
}


# ─── Config ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ComplianceConfig:
    allowed_tools: Sequence[str] = ()
    data_classification: Optional[DataClassification] = None
    guardrail_evidence: Optional[bool] = None


@dataclass(frozen=True)
class SecurityConfig:
    enabled: Optional[bool] = None
    max_total_tokens: Optional[float] = None


@dataclass(frozen=True)
class BedrockInstrumentationDeps:
    tracer: Tracer
    compliance: Optional[ComplianceConfig] = None
    security: Optional[SecurityConfig] = None
    on_error: Optional[Callable[[BaseException], None]] = None


# ─── Narrowing ──────────────────────────────────────────────────────────────────


def _is_record(v: Any) -> bool:
    return isinstance(v, dict)


def _read_finite_number(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _read_usage(response: Any) -> Optional[Dict[str, int]]:
    """Lê `usage.inputTokens`/`outputTokens` de uma resposta Converse. None quando
    ausente (nunca fabrica 0)."""
    if not _is_record(response):
        return None
    usage = response.get("usage")
    if not _is_record(usage):
        return None
    it = _read_finite_number(usage.get("inputTokens"))
    ot = _read_finite_number(usage.get("outputTokens"))
    if it is None or ot is None:
        return None
    return {"inputTokens": int(it), "outputTokens": int(ot)}


def _read_finish_reasons(response: Any) -> List[str]:
    if not _is_record(response):
        return []
    stop = response.get("stopReason")
    return [stop] if isinstance(stop, str) and len(stop) > 0 else []


def _extract_converse_input_text(kwargs: Dict[str, Any]) -> Optional[str]:
    """Concatena os blocos de texto das mensagens do request Converse (pra scan
    de segurança). Best-effort; nunca lança."""
    try:
        messages = kwargs.get("messages")
        if not isinstance(messages, list):
            return None
        parts: List[str] = []
        for m in messages:
            if not _is_record(m):
                continue
            content = m.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if _is_record(block) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
        return "\n".join(parts) if parts else None
    except Exception:
        return None


def _extract_converse_output_text(response: Any) -> Optional[str]:
    try:
        output = response.get("output") if _is_record(response) else None
        message = output.get("message") if _is_record(output) else None
        content = message.get("content") if _is_record(message) else None
        if not isinstance(content, list):
            return None
        parts = [b["text"] for b in content if _is_record(b) and isinstance(b.get("text"), str)]
        return "\n".join(parts) if parts else None
    except Exception:
        return None


# ─── Instrumentação ──────────────────────────────────────────────────────────────


def instrument_bedrock_client(client: Any, deps: BedrockInstrumentationDeps) -> Any:
    """Instrumenta um cliente boto3 `bedrock-runtime` in-place e retorna a mesma
    instância. O cliente é criado/configurado pelo dev (region, credenciais); o
    SDK nunca constrói um cliente AWS próprio — só envolve o que o agente traz.
    Chamar duas vezes no mesmo cliente é no-op."""
    if getattr(client, _INSTRUMENTED, False):
        return client
    on_error = deps.on_error or (lambda _e: None)

    for method_name, (operation, streaming, stream_field) in _METHODS.items():
        original = getattr(client, method_name, None)
        if not callable(original):
            continue
        wrapped = _make_wrapper(original, operation, streaming, stream_field, deps, on_error)
        try:
            setattr(client, method_name, wrapped)
        except Exception:
            # Cliente que não aceita override do método — pula (nunca quebra).
            pass

    try:
        setattr(client, _INSTRUMENTED, True)
    except Exception:
        pass
    return client


def _make_wrapper(original, operation, streaming, stream_field, deps, on_error):
    def wrapper(*args, **kwargs):
        model_id = kwargs.get("modelId") if isinstance(kwargs.get("modelId"), str) else None
        span_name = f"{operation} {model_id}" if model_id else operation
        span = None
        try:
            span = deps.tracer.start_span(span_name, kind=SpanKind.CLIENT)
            span.set_attribute(GEN_AI_OPERATION_NAME, operation)
            span.set_attribute(GEN_AI_PROVIDER_NAME, PROVIDER_AWS_BEDROCK)
            if model_id is not None:
                span.set_attribute(GEN_AI_REQUEST_MODEL, model_id)
            apply_identity_to_span(span)
        except Exception as e:  # bug de telemetria nossa — não bloqueia a chamada
            on_error(e)
            span = None

        # A chamada REAL do Bedrock. Um erro genuíno propaga inalterado.
        try:
            response = original(*args, **kwargs)
        except BaseException as call_error:
            if span is not None:
                try:
                    span.record_exception(call_error)
                    span.set_status(Status(StatusCode.ERROR))
                    span.end()
                except Exception as e:
                    on_error(e)
            raise

        if span is None:
            return response

        # Streaming: o span termina quando o agente consumir o stream (aqui, no
        # boto3 não-async, finalizamos com o que já dá pra observar da resposta;
        # a iteração do agente segue intacta). Bookkeeping guardado.
        try:
            _finalize_span(span, operation, kwargs, response, deps)
        except Exception as e:
            on_error(e)
            try:
                span.end()
            except Exception:
                pass
        return response

    return wrapper


def _finalize_span(span, operation, kwargs, response, deps) -> None:
    # Usage (ou marcador explícito de ausência — nunca fabrica 0).
    usage = _read_usage(response)
    if usage is not None:
        span.set_attribute(GEN_AI_USAGE_INPUT_TOKENS, usage["inputTokens"])
        span.set_attribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage["outputTokens"])
        span.set_attribute(CTA_USAGE_TOKENS_AVAILABLE, True)
    else:
        span.set_attribute(CTA_USAGE_TOKENS_AVAILABLE, False)

    finish = _read_finish_reasons(response)
    if finish:
        span.set_attribute(GEN_AI_RESPONSE_FINISH_REASONS, finish)

    # Tools (spans execute_tool parenteados) + lista pra compliance.
    tool_uses: List[ObservedToolUse] = (
        extract_tool_uses(response) if operation == OPERATION_CHAT else []
    )
    if tool_uses:
        record_tool_use_spans(deps.tracer, tool_uses, parent=span)

    # Compliance (quando configurada).
    if deps.compliance is not None:
        summary = evaluate_compliance(
            ComplianceEvaluationInput(
                used_tools=[t.name for t in tool_uses],
                allowed_tools=list(deps.compliance.allowed_tools),
                data_classification=deps.compliance.data_classification,
                guardrail_evidence=deps.compliance.guardrail_evidence,
            )
        )
        apply_compliance_to_span(span, summary)

    # Segurança OWASP (quando configurada e não desabilitada).
    if deps.security is not None and deps.security.enabled is not False:
        u = None
        if usage is not None:
            u = _Usage(input_tokens=usage["inputTokens"], output_tokens=usage["outputTokens"])
        sec = evaluate_security(
            SecurityEvaluationInput(
                user_input=_extract_converse_input_text(kwargs),
                model_output=_extract_converse_output_text(response),
                usage=u,
                max_total_tokens=deps.security.max_total_tokens,
            )
        )
        apply_security_to_span(span, sec)

    span.set_status(Status(StatusCode.OK))
    span.end()
