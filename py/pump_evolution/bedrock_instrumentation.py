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

Respostas de streaming (`converse_stream`, `invoke_model_with_response_stream`):
o campo iterável da resposta é trocado por um observador que repassa cada evento
inalterado e finaliza o span DEPOIS do consumo — o `usage` do Bedrock chega no
evento `metadata`, no fim, e o retorno imediato de `converse_stream` traz apenas
o campo `stream`. Paridade com `observeStream` do TS. O span termina exatamente
uma vez em qualquer caminho: consumo completo, `break` antecipado (via
`GeneratorExit`) ou erro genuíno, que é re-levantado inalterado.

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
from .tool_tracer import (
    ObservedToolUse,
    extract_tool_use_from_stream_event,
    extract_tool_uses,
    record_tool_use_spans,
)
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


def _read_usage_from_event(event: Any) -> Optional[Dict[str, int]]:
    """Usage de um evento de ConverseStream. Paridade com `readUsageFromEvent`.

    O Bedrock entrega o usage no evento `metadata` do stream — nunca no retorno
    imediato de `converse_stream`, cujo unico campo e `stream`. Tolera tambem o
    formato mais raso `{usage: {...}}`.
    """
    if not _is_record(event):
        return None
    from_metadata = _read_usage(event.get("metadata"))
    if from_metadata is not None:
        return from_metadata
    return _read_usage(event)


def _read_stop_reason_from_event(event: Any) -> Optional[str]:
    """stopReason de um evento `messageStop`. Paridade com `readStopReasonFromEvent`."""
    if not _is_record(event):
        return None
    for candidato in (event.get("messageStop"), event):
        reasons = _read_finish_reasons(candidato)
        if reasons:
            return reasons[0]
    return None


def _read_stream_delta_text(event: Any) -> Optional[str]:
    """Texto de um evento `contentBlockDelta`. Paridade com `readStreamDeltaText`."""
    if not _is_record(event):
        return None
    delta = event.get("contentBlockDelta")
    delta = delta.get("delta") if _is_record(delta) else None
    if not _is_record(delta):
        return None
    text = delta.get("text")
    return text if isinstance(text, str) else None


def _read_stream(response: Any, field: str) -> Optional[Any]:
    """O iteravel de eventos da resposta (`stream` no Converse, `body` no
    InvokeModel). None quando ausente ou nao-iteravel — nesse caso o wrapper cai
    no caminho nao-streaming, sem inventar comportamento."""
    if not _is_record(response):
        return None
    candidato = response.get(field)
    if candidato is None or isinstance(candidato, (str, bytes)):
        return None
    return candidato if hasattr(candidato, "__iter__") else None


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

        # Streaming: o span so pode ser finalizado DEPOIS que o agente consumir o
        # stream — o `usage` do Bedrock chega no evento `metadata`, no fim. Aqui
        # o campo iteravel e trocado por um observador que repassa cada evento
        # inalterado e fecha o span ao terminar. Sem isso, todo span de
        # `converse_stream` saia sem tokens (e portanto sem custo).
        if streaming:
            source = _read_stream(response, stream_field)
            if source is not None:
                try:
                    response[stream_field] = _observe_stream(
                        source, span, operation, kwargs, deps, on_error
                    )
                    return response
                except Exception as e:
                    # Nao conseguimos envolver (resposta imutavel, por ex.): cai
                    # no caminho nao-streaming em vez de perder o span.
                    on_error(e)

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


def _apply_usage(span, usage: Optional[Dict[str, int]]) -> None:
    """Escreve o usage no span. Ausente → marca `tokens_available=False` e OMITE
    os `gen_ai.usage.*`; nunca um 0 fabricado, que corromperia a agregacao de
    custo downstream."""
    if usage is not None:
        span.set_attribute(GEN_AI_USAGE_INPUT_TOKENS, usage["inputTokens"])
        span.set_attribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage["outputTokens"])
        span.set_attribute(CTA_USAGE_TOKENS_AVAILABLE, True)
    else:
        span.set_attribute(CTA_USAGE_TOKENS_AVAILABLE, False)


def _apply_tools_and_compliance(span, operation, tool_uses, deps) -> None:
    """Spans `execute_tool` parenteados + avaliacao de compliance das tools."""
    if tool_uses:
        record_tool_use_spans(deps.tracer, tool_uses, parent=span)
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


def _apply_security(span, deps, user_input, model_output, usage) -> None:
    """Scan OWASP LLM de runtime. No-op quando nao configurado ou desabilitado."""
    if deps.security is None or deps.security.enabled is False:
        return
    u = None
    if usage is not None:
        u = _Usage(input_tokens=usage["inputTokens"], output_tokens=usage["outputTokens"])
    sec = evaluate_security(
        SecurityEvaluationInput(
            user_input=user_input,
            model_output=model_output,
            usage=u,
            max_total_tokens=deps.security.max_total_tokens,
        )
    )
    apply_security_to_span(span, sec)


def _finalize_span(span, operation, kwargs, response, deps) -> None:
    """Finaliza o span de uma resposta NAO-streaming, onde tudo ja esta presente."""
    usage = _read_usage(response)
    _apply_usage(span, usage)

    finish = _read_finish_reasons(response)
    if finish:
        span.set_attribute(GEN_AI_RESPONSE_FINISH_REASONS, finish)

    tool_uses: List[ObservedToolUse] = (
        extract_tool_uses(response) if operation == OPERATION_CHAT else []
    )
    _apply_tools_and_compliance(span, operation, tool_uses, deps)
    _apply_security(
        span,
        deps,
        _extract_converse_input_text(kwargs),
        _extract_converse_output_text(response),
        usage,
    )

    span.set_status(Status(StatusCode.OK))
    span.end()


# Teto de acumulacao de texto de saida para o scan de seguranca — evita segurar
# uma resposta longa inteira em memoria so para escanear.
_MAX_SCAN_CHARS = 20_000


def _observe_stream(source, span, operation, kwargs, deps, on_error):
    """Generator que repassa cada evento do stream e finaliza o span DEPOIS.

    Paridade com `observeStream` do TS. Existe porque o retorno imediato de
    `converse_stream` traz um unico campo (`stream`) — o `usage` so chega no
    evento `metadata`, no fim. Finalizar o span na chamada, como era feito antes,
    registrava identidade/modelo/latencia mas SEMPRE sem tokens, e portanto sem
    custo: exatamente a metrica que a governanca existe para produzir.

    Os eventos sao repassados inalterados; o consumidor nao percebe diferenca.

    Tres caminhos, e o span termina EXATAMENTE UMA VEZ em todos:
      - consumo ate o fim  → finaliza com o usage observado;
      - `break` antecipado → o `close()` do generator dispara o `finally`,
        finalizando com o que deu para observar (em vez de vazar o span);
      - erro genuino       → marca ERROR e re-levanta o erro ORIGINAL inalterado.
    """
    usage: Optional[Dict[str, int]] = None
    stop_reason: Optional[str] = None
    tool_uses: List[ObservedToolUse] = []
    partes: List[str] = []
    chars = 0
    estado = {"finalizado": False, "encerrado": False}

    def finalizar_ok() -> None:
        if estado["finalizado"]:
            return
        estado["finalizado"] = True
        try:
            _apply_usage(span, usage)
            if stop_reason:
                span.set_attribute(GEN_AI_RESPONSE_FINISH_REASONS, [stop_reason])
            if operation == OPERATION_CHAT:
                _apply_tools_and_compliance(span, operation, tool_uses, deps)
            _apply_security(
                span,
                deps,
                _extract_converse_input_text(kwargs),
                "".join(partes) if partes else None,
                usage,
            )
            span.set_status(Status(StatusCode.OK))
        except Exception as e:
            on_error(e)

    def encerrar_uma_vez() -> None:
        if estado["encerrado"]:
            return
        estado["encerrado"] = True
        try:
            span.end()
        except Exception as e:
            on_error(e)

    try:
        for event in source:
            try:
                usage = _read_usage_from_event(event) or usage
                stop_reason = _read_stop_reason_from_event(event) or stop_reason
                if operation == OPERATION_CHAT:
                    uso = extract_tool_use_from_stream_event(event)
                    if uso is not None:
                        tool_uses.append(uso)
                    if deps.security is not None and chars < _MAX_SCAN_CHARS:
                        delta = _read_stream_delta_text(event)
                        if delta:
                            partes.append(delta)
                            chars += len(delta)
            except Exception as e:
                # Bug de bookkeeping nosso nunca corrompe o stream do agente.
                on_error(e)
            yield event
        finalizar_ok()
    except GeneratorExit:
        # Consumidor abandonou o stream (`break`, ou `close()` explicito). NAO e
        # erro: o Python levanta GeneratorExit no ponto do `yield`, e como ela
        # herda de BaseException seria confundida com falha do stream. Aqui ela
        # so propaga — o `finally` finaliza com o que deu para observar.
        raise
    except BaseException as erro:
        # Erro genuino do stream: marca finalizado ANTES para que o `finally` nao
        # sobrescreva o ERROR com OK, e re-levanta o erro original inalterado.
        estado["finalizado"] = True
        try:
            span.record_exception(erro)
            span.set_status(Status(StatusCode.ERROR))
        except Exception as e:
            on_error(e)
        raise
    finally:
        finalizar_ok()
        encerrar_uma_vez()
