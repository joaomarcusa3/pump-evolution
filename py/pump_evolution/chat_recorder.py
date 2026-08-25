"""record_chat — registra uma chamada de modelo que o SDK não instrumenta sozinho.

O `instrument_bedrock()` cobre Bedrock. Para qualquer outro provider — OpenAI,
Anthropic direto, SAI, LangChain — o integrador precisava montar o span à mão:
abrir o tracer, acertar cinco atributos, propagar identidade e fechar o status.
São ~30 linhas copiadas de um guia, e basta esquecer UM atributo para o receiver
do CTA responder `202` com `accepted: 0` — ou seja, aceitar o request e
descartar o span em silêncio. Tudo parece funcionar e nada chega.

Esta função existe para que esse caminho tenha uma chamada só:

    from pump_evolution import record_chat

    resposta = await llm.ainvoke(mensagens)
    record_chat(
        model="gpt-4o",
        input_tokens=resposta.usage_metadata["input_tokens"],
        output_tokens=resposta.usage_metadata["output_tokens"],
    )

O que ela garante, e o integrador não precisa lembrar:

- `gen_ai.operation.name = "chat"` — sem isto o CTA descarta o span
- nome do span no formato que o receiver reconhece
- identidade do usuário corrente propagada (enduser.id, department, cost_center)
- tokens marcados como disponíveis, para o cálculo de custo
- status OK, ou ERROR quando a chamada falhou

Nunca levanta exceção: telemetria não derruba o agente. Um erro aqui vira
retorno `False`, e o chamador segue a vida.
"""

from __future__ import annotations

from typing import Any, Optional

from .constants import (
    CTA_USAGE_TOKENS_AVAILABLE,
    GEN_AI_OPERATION_NAME,
    GEN_AI_PROVIDER_NAME,
    GEN_AI_REQUEST_MODEL,
    GEN_AI_USAGE_INPUT_TOKENS,
    GEN_AI_USAGE_OUTPUT_TOKENS,
)
from .identity_context import apply_identity_to_span

OPERACAO_CHAT = "chat"


def record_chat(
    *,
    model: str,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    provider: Optional[str] = None,
    error: Optional[BaseException] = None,
    tracer: Optional[Any] = None,
) -> bool:
    """Emite um span de chat no formato que o receiver do CTA aceita.

    Args:
        model: modelo REALMENTE usado na chamada. Vai em `gen_ai.request.model`
            e é o que aparece por invocação no portal — diferente do `modelId`
            do manifesto, que é declaração estática.
        input_tokens: tokens de entrada, quando a resposta do provider informa.
        output_tokens: tokens de saída, idem.
        provider: nome do provider (`openai`, `anthropic`, ...). Opcional.
        error: se a chamada ao modelo falhou, passe a exceção — o span sai com
            status ERROR em vez de sumir. Falha registrada vale mais que
            silêncio.
        tracer: tracer alternativo. Por padrão usa o do OpenTelemetry global,
            que é o que o `PumpEvolution.init()` configurou.

    Returns:
        True se o span foi emitido; False se algo impediu. Nunca levanta.
    """
    try:
        if tracer is None:
            from opentelemetry import trace as _trace

            tracer = _trace.get_tracer("pump-evolution")

        from opentelemetry.trace import SpanKind, Status, StatusCode

        nome = f"{OPERACAO_CHAT} {model}" if model else OPERACAO_CHAT
        span = tracer.start_span(nome, kind=SpanKind.CLIENT)
        try:
            # Este atributo é a diferença entre o span ser contado e ser
            # descartado com accepted: 0. Não é opcional.
            span.set_attribute(GEN_AI_OPERATION_NAME, OPERACAO_CHAT)
            if model:
                span.set_attribute(GEN_AI_REQUEST_MODEL, str(model))
            if provider:
                span.set_attribute(GEN_AI_PROVIDER_NAME, str(provider))

            entrada = int(input_tokens) if isinstance(input_tokens, int) else 0
            saida = int(output_tokens) if isinstance(output_tokens, int) else 0
            if entrada or saida:
                span.set_attribute(GEN_AI_USAGE_INPUT_TOKENS, entrada)
                span.set_attribute(GEN_AI_USAGE_OUTPUT_TOKENS, saida)
                span.set_attribute(CTA_USAGE_TOKENS_AVAILABLE, True)

            apply_identity_to_span(span)

            if error is not None:
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR))
            else:
                span.set_status(Status(StatusCode.OK))
        finally:
            span.end()
        return True
    except Exception:
        # Telemetria nunca derruba o agente (mesmo contrato do resto do SDK).
        return False
