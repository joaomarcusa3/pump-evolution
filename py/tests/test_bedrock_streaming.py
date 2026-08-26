"""Tokens em respostas de streaming do Bedrock.

O retorno imediato de `converse_stream` tem um unico campo (`stream`); o `usage`
so chega no evento `metadata`, no fim. Antes destes testes o span era finalizado
na chamada e saia SEMPRE sem tokens — e portanto sem custo, que e a metrica que a
governanca existe para produzir.

Cobrem os tres caminhos do observador, porque o span precisa terminar
exatamente uma vez em todos: consumo completo, `break` antecipado e erro.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from pump_evolution.bedrock_instrumentation import (
    BedrockInstrumentationDeps,
    instrument_bedrock_client,
)
from pump_evolution.constants import (
    CTA_USAGE_TOKENS_AVAILABLE,
    GEN_AI_RESPONSE_FINISH_REASONS,
    GEN_AI_USAGE_INPUT_TOKENS,
    GEN_AI_USAGE_OUTPUT_TOKENS,
)

MODELO = "global.anthropic.claude-sonnet-4-20250514-v1:0"
MENSAGENS = [{"role": "user", "content": [{"text": "oi"}]}]


class SpanFalso:
    def __init__(self) -> None:
        self.attributes: Dict[str, Any] = {}
        self.encerramentos = 0
        self.status: Optional[Any] = None
        self.excecoes: List[BaseException] = []

    def set_attribute(self, k: str, v: Any) -> None:
        self.attributes[k] = v

    def set_status(self, status: Any) -> None:
        self.status = status

    def record_exception(self, e: BaseException) -> None:
        self.excecoes.append(e)

    def end(self) -> None:
        self.encerramentos += 1


class TracerFalso:
    def __init__(self) -> None:
        self.spans: List[SpanFalso] = []

    def start_span(self, _nome: str, **_kw: Any) -> SpanFalso:
        span = SpanFalso()
        self.spans.append(span)
        return span

    # usado por record_tool_use_spans
    def start_as_current_span(self, *_a: Any, **_kw: Any):  # pragma: no cover
        raise AssertionError("nao esperado nestes testes")


EVENTOS_COMPLETOS = [
    {"messageStart": {"role": "assistant"}},
    {"contentBlockDelta": {"delta": {"text": "ok"}}},
    {"messageStop": {"stopReason": "end_turn"}},
    {"metadata": {"usage": {"inputTokens": 12, "outputTokens": 3}}},
]


class ClienteFalso:
    """Minimo de um client boto3 bedrock-runtime, com os dois formatos reais."""

    def __init__(self, eventos: Optional[List[Any]] = None, erro_no_meio: bool = False) -> None:
        self._eventos = eventos if eventos is not None else EVENTOS_COMPLETOS
        self._erro_no_meio = erro_no_meio
        self.stream_consumido = 0

    def converse(self, **_kw: Any) -> Dict[str, Any]:
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}},
            "usage": {"inputTokens": 12, "outputTokens": 3},
            "stopReason": "end_turn",
        }

    def converse_stream(self, **_kw: Any) -> Dict[str, Any]:
        def gerar():
            for ev in self._eventos:
                self.stream_consumido += 1
                if self._erro_no_meio and "messageStop" in ev:
                    raise RuntimeError("stream quebrou de verdade")
                yield ev

        return {"stream": gerar()}


def _instrumentar(cliente: ClienteFalso):
    tracer = TracerFalso()
    instrument_bedrock_client(cliente, BedrockInstrumentationDeps(tracer=tracer))
    return tracer


def test_consumo_completo_captura_tokens_do_evento_metadata():
    cliente = ClienteFalso()
    tracer = _instrumentar(cliente)

    resposta = cliente.converse_stream(modelId=MODELO, messages=MENSAGENS)
    eventos = list(resposta["stream"])

    span = tracer.spans[0]
    assert span.attributes[GEN_AI_USAGE_INPUT_TOKENS] == 12
    assert span.attributes[GEN_AI_USAGE_OUTPUT_TOKENS] == 3
    assert span.attributes[CTA_USAGE_TOKENS_AVAILABLE] is True
    assert span.attributes[GEN_AI_RESPONSE_FINISH_REASONS] == ["end_turn"]
    assert span.encerramentos == 1
    # O consumidor recebe os eventos inalterados.
    assert eventos == EVENTOS_COMPLETOS


def test_span_nao_e_finalizado_antes_do_consumo():
    """O bug original: o span fechava na chamada, antes de existir usage."""
    cliente = ClienteFalso()
    tracer = _instrumentar(cliente)

    cliente.converse_stream(modelId=MODELO, messages=MENSAGENS)

    span = tracer.spans[0]
    assert span.encerramentos == 0, "span nao pode fechar antes de o stream ser lido"
    assert GEN_AI_USAGE_INPUT_TOKENS not in span.attributes


def test_break_antecipado_encerra_o_span_uma_vez_sem_fabricar_zero():
    cliente = ClienteFalso()
    tracer = _instrumentar(cliente)

    resposta = cliente.converse_stream(modelId=MODELO, messages=MENSAGENS)
    for _ev in resposta["stream"]:
        break  # abandona antes do metadata
    resposta["stream"].close()

    span = tracer.spans[0]
    assert span.encerramentos == 1, "span vazaria se o finally nao rodasse"
    # Sem usage observado: marcador explicito de ausencia, nunca um 0 fabricado.
    assert span.attributes[CTA_USAGE_TOKENS_AVAILABLE] is False
    assert GEN_AI_USAGE_INPUT_TOKENS not in span.attributes


def test_erro_no_stream_propaga_original_e_marca_erro():
    cliente = ClienteFalso(erro_no_meio=True)
    tracer = _instrumentar(cliente)

    resposta = cliente.converse_stream(modelId=MODELO, messages=MENSAGENS)
    with pytest.raises(RuntimeError, match="stream quebrou de verdade"):
        list(resposta["stream"])

    span = tracer.spans[0]
    assert span.encerramentos == 1
    assert len(span.excecoes) == 1


def test_nao_streaming_continua_funcionando():
    cliente = ClienteFalso()
    tracer = _instrumentar(cliente)

    cliente.converse(modelId=MODELO, messages=MENSAGENS)

    span = tracer.spans[0]
    assert span.attributes[GEN_AI_USAGE_INPUT_TOKENS] == 12
    assert span.attributes[CTA_USAGE_TOKENS_AVAILABLE] is True
    assert span.encerramentos == 1
