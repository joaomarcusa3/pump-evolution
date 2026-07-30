"""
tool_tracer — captura as tools que um agente invoca (Requirement 5) como spans
GenAI `execute_tool`, correlacionados à invocação de modelo pai. Paridade 1:1
com `src/tool-tracer.ts`.

Dois caminhos:
  1. Auto — `extract_tool_uses` parseia os blocos `toolUse` de uma resposta
     Bedrock `Converse` (ou nomes agregados de um `ConverseStream`), e
     `record_tool_use_spans` emite um span `execute_tool` por chamada, parenteado
     ao span de invocação. Já rodaram → spans point-in-time.
  2. Manual — `trace_tool` embrulha uma função arbitrária (LangChain, HTTP cru,
     qualquer coisa) num span `execute_tool` cujo tempo de vida é a execução da
     função, registrando erros e preservando o retorno/exceção original.

Invariantes: telemetria nunca quebra o agente (auto totalmente guardado; manual
relança o erro ORIGINAL); nada fabricado (só nomes reais lidos da resposta/args).
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, TypeVar

from opentelemetry import context as otel_context
from opentelemetry.trace import (
    Span,
    SpanKind,
    Status,
    StatusCode,
    Tracer,
    set_span_in_context,
)

from .constants import GEN_AI_OPERATION_NAME, GEN_AI_TOOL_NAME, OPERATION_EXECUTE_TOOL

_T = TypeVar("_T")

# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ObservedToolUse:
    """Uma invocação de tool observada numa resposta Bedrock."""

    name: str  # gen_ai.tool.name — sempre string não-vazia
    tool_use_id: Optional[str] = None  # id de correlação do provider, quando presente


# ─── Helpers de narrowing (parseiam `unknown`, nunca fabricam) ────────────────


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _read_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return None if len(trimmed) == 0 else trimmed


def _read_tool_use(tool_use: Any) -> Optional[ObservedToolUse]:
    """Lê um `{name, toolUseId}` de um record `toolUse`."""
    if not _is_record(tool_use):
        return None
    name = _read_string(tool_use.get("name"))
    if name is None:
        return None
    tool_use_id = _read_string(tool_use.get("toolUseId"))
    return ObservedToolUse(name=name, tool_use_id=tool_use_id)


# ─── Extração auto (pura) ─────────────────────────────────────────────────────


def extract_tool_uses(converse_output: Any) -> List[ObservedToolUse]:
    """Extrai todo bloco `toolUse` de uma resposta Bedrock `Converse`. Lê
    `output.message.content[].toolUse`. Um `ObservedToolUse` por bloco em ordem
    (duplicatas preservadas — a mesma tool usada duas vezes são duas chamadas).
    Blocos sem `name` válido são pulados. Puro; nunca lança."""
    if not _is_record(converse_output):
        return []
    output = converse_output.get("output")
    if not _is_record(output):
        return []
    message = output.get("message")
    if not _is_record(message):
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []

    uses: List[ObservedToolUse] = []
    for block in content:
        if not _is_record(block):
            continue
        use = _read_tool_use(block.get("toolUse"))
        if use is not None:
            uses.append(use)
    return uses


def extract_tool_use_from_stream_event(event: Any) -> Optional[ObservedToolUse]:
    """Extrai um `toolUse` de um único evento `ConverseStream` da forma
    `{contentBlockStart: {start: {toolUse: {toolUseId, name}}}}`. None para
    qualquer outro evento. Puro; nunca lança."""
    if not _is_record(event):
        return None
    content_block_start = event.get("contentBlockStart")
    if not _is_record(content_block_start):
        return None
    start = content_block_start.get("start")
    if not _is_record(start):
        return None
    return _read_tool_use(start.get("toolUse"))


# ─── Emissão de span ───────────────────────────────────────────────────────────


def _context_for_parent(parent: Optional[Span]):
    """Monta o trace context que parenteia spans-filho sob `parent`."""
    active = otel_context.get_current()
    return set_span_in_context(parent, active) if parent is not None else active


def record_tool_use_spans(
    tracer: Tracer,
    tool_uses: Sequence[ObservedToolUse],
    parent: Optional[Span] = None,
) -> int:
    """Emite um span `execute_tool` por tool observada, parenteado (via trace
    context) a `parent`. Cada span carrega `gen_ai.operation.name=execute_tool` e
    `gen_ai.tool.name`. Representam chamadas que já aconteceram → abrem e fecham
    na hora. Totalmente guardado (falha de emissão é engolida). Retorna o número
    de spans emitidos."""
    emitted = 0
    ctx = _context_for_parent(parent)
    for use in tool_uses:
        try:
            span = tracer.start_span(
                f"{OPERATION_EXECUTE_TOOL} {use.name}",
                context=ctx,
                kind=SpanKind.INTERNAL,
            )
            span.set_attribute(GEN_AI_OPERATION_NAME, OPERATION_EXECUTE_TOOL)
            span.set_attribute(GEN_AI_TOOL_NAME, use.name)
            span.set_status(Status(StatusCode.OK))
            span.end()
            emitted += 1
        except Exception:
            # Telemetria nunca quebra o fluxo do agente.
            pass
    return emitted


# ─── Tracing manual (framework-agnóstico) ──────────────────────────────────────


def trace_tool(tracer: Tracer, name: str, fn: Callable[[], _T]) -> _T:
    """Embrulha `fn` num span `execute_tool` (Requirement 5.2) pra instrumentar
    tools que não passam pelo Bedrock. O span aninha sob o span ativo. Tempo de
    vida = execução da função; pra `fn` async, termina quando o awaitable
    concluir. Erros são registrados e o erro ORIGINAL é relançado inalterado. Se
    iniciar o span falhar, `fn` ainda roda (telemetria nunca bloqueia o agente)."""
    tool_name = _read_string(name) or "unknown_tool"
    try:
        span = tracer.start_span(
            f"{OPERATION_EXECUTE_TOOL} {tool_name}", kind=SpanKind.INTERNAL
        )
        span.set_attribute(GEN_AI_OPERATION_NAME, OPERATION_EXECUTE_TOOL)
        span.set_attribute(GEN_AI_TOOL_NAME, tool_name)
    except Exception:
        # Não deu pra iniciar o span — roda a função sem traçar.
        return fn()

    try:
        result = fn()
    except BaseException as error:
        span.record_exception(error)
        span.set_status(Status(StatusCode.ERROR))
        span.end()
        raise

    if inspect.isawaitable(result):

        async def _end_on_settle() -> Any:
            try:
                value = await result  # type: ignore[misc]
            except BaseException as error:
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR))
                span.end()
                raise
            span.set_status(Status(StatusCode.OK))
            span.end()
            return value

        return _end_on_settle()  # type: ignore[return-value]

    span.set_status(Status(StatusCode.OK))
    span.end()
    return result
