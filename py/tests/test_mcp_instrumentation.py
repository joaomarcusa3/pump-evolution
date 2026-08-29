"""Instrumentacao de servidor MCP, contra o pacote `mcp` REAL — nao um duplo.

Por que estes testes existem: `instrument_mcp_server` procurava
`register_tool`/`tool`/`add_tool` e embrulhava o ultimo argumento callable. Essa
forma nao corresponde a nenhuma das duas classes do pacote `mcp`:

  - no `FastMCP`, `add_tool(fn, name=None, ...)` recebe a funcao no PRIMEIRO
    argumento. O wrapper cru substituia a funcao por um `traced_handler(*args,
    **kwargs)` — e como o FastMCP tira o nome da tool de `fn.__name__` e o
    inputSchema da assinatura, TODA tool passava a se chamar `traced_handler`
    com schema `{call_args, call_kwargs}`. Nao era so telemetria faltando: o
    servidor ficava quebrado;
  - o `Server` de baixo nivel (`mcp.server.lowlevel`) nao tem nenhum dos tres
    metodos. Ele despacha pelo decorator `call_tool()`, entao nenhum span saia.

A licao e a mesma do lado TypeScript: duplo de servidor MCP nao prova
instrumentacao. Estes testes exercitam as classes reais, o de baixo nivel ponta
a ponta (cliente <-> streams em memoria <-> servidor).
"""

from __future__ import annotations

import asyncio
from typing import Any, List

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from pump_evolution.mcp_instrumentation import McpToolTracerDeps, instrument_mcp_server

mcp = pytest.importorskip("mcp", reason="pacote `mcp` necessario para os testes de paridade")

import mcp.types as types  # noqa: E402
from mcp.server.lowlevel import Server  # noqa: E402

# O `mcp` 2.x renomeou `FastMCP` para `MCPServer` e trocou o registro de baixo
# nivel (`call_tool` -> `add_request_handler`). A instrumentacao e estrutural, so
# olha nome de metodo, entao cobre as duas majors -- estes testes rodam nas duas.
try:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as ServidorAltoNivel  # noqa: E402
    MCP_MAJOR = 1
except ModuleNotFoundError:  # mcp 2.x
    from mcp.server.mcpserver import MCPServer as ServidorAltoNivel  # noqa: E402
    MCP_MAJOR = 2

try:
    from mcp.shared.memory import (  # noqa: E402
        create_connected_server_and_client_session as conectar_em_memoria,
    )
except Exception:  # pragma: no cover - so existe no 1.x
    conectar_em_memoria = None

SEGREDO = "AKIAIOSFODNN7EXAMPLE"


@pytest.fixture
def exportador() -> InMemorySpanExporter:
    return InMemorySpanExporter()


@pytest.fixture
def deps(exportador: InMemorySpanExporter) -> McpToolTracerDeps:
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exportador))
    return McpToolTracerDeps(
        tracer=provider.get_tracer("teste"),
        allowed_tools=["buscar"],
        security_enabled=True,
    )


def atributos(exportador: InMemorySpanExporter) -> List[Any]:
    return [s.attributes for s in exportador.get_finished_spans()]


def texto(resultado: Any) -> str:
    """O retorno de `call_tool` mudou de forma entre as majors: no 1.x e a tupla
    `(conteudo, structured)`, no 2.x e um `CallToolResult`. Os testes se importam
    com o texto que a tool devolveu, nao com o involucro."""
    conteudo = getattr(resultado, "content", None)
    if conteudo is None:
        conteudo = resultado[0]
    return conteudo[0].text


def schema(tool: Any) -> dict:
    """`inputSchema` no 1.x, `input_schema` no 2.x."""
    bruto = getattr(tool, "inputSchema", None)
    return bruto if bruto is not None else tool.input_schema


# ─── FastMCP (alto nivel) ──────────────────────────────────────────────────────


def test_fastmcp_preserva_nome_descricao_e_schema(deps, exportador) -> None:
    """A regressao central: instrumentar nao pode renomear a tool nem destruir o
    schema derivado da assinatura."""
    servidor = ServidorAltoNivel("teste")
    instrument_mcp_server(deps, servidor)

    @servidor.tool()
    def buscar(q: str) -> str:
        """busca licitacao"""
        return "ok:" + q

    (tool,) = asyncio.run(servidor.list_tools())
    assert tool.name == "buscar"
    assert tool.description == "busca licitacao"
    assert schema(tool)["properties"]["q"]["type"] == "string"


def test_fastmcp_emite_um_span_por_tool_e_preserva_o_retorno(deps, exportador) -> None:
    servidor = ServidorAltoNivel("teste")
    instrument_mcp_server(deps, servidor)

    @servidor.tool()
    def buscar(q: str) -> str:
        """b"""
        return "ok:" + q

    resultado = asyncio.run(servidor.call_tool("buscar", {"q": "x"}))
    assert texto(resultado) == "ok:x"

    (attrs,) = atributos(exportador)
    assert attrs["gen_ai.operation.name"] == "execute_tool"
    assert attrs["gen_ai.tool.name"] == "buscar"
    assert attrs["cta.compliance.status"] == "compliant"


def test_fastmcp_nao_duplica_span_no_caminho_tool_para_add_tool(deps, exportador) -> None:
    """`tool()` delega pro `add_tool()`, e os dois sao instrumentados. Sem a
    marca na funcao, a mesma tool sairia com dois spans aninhados."""
    servidor = ServidorAltoNivel("teste")
    instrument_mcp_server(deps, servidor)

    @servidor.tool()
    def buscar(q: str) -> str:
        """b"""
        return "ok"

    asyncio.run(servidor.call_tool("buscar", {"q": "x"}))
    assert len(exportador.get_finished_spans()) == 1


def test_fastmcp_preserva_tool_assincrona(deps, exportador) -> None:
    """O FastMCP checa `iscoroutinefunction` — o wrapper precisa manter o
    formato, e o span so fecha quando o awaitable conclui."""
    servidor = ServidorAltoNivel("teste")
    instrument_mcp_server(deps, servidor)

    @servidor.tool()
    async def buscar(q: str) -> str:
        """b"""
        await asyncio.sleep(0)
        return "async:" + q

    resultado = asyncio.run(servidor.call_tool("buscar", {"q": "x"}))
    assert texto(resultado) == "async:x"
    (attrs,) = atributos(exportador)
    assert attrs["gen_ai.tool.name"] == "buscar"


def test_fastmcp_governa_compliance_e_redige_segredo(deps, exportador) -> None:
    servidor = ServidorAltoNivel("teste")
    instrument_mcp_server(deps, servidor)

    @servidor.tool()
    def exec_shell(token: str) -> str:
        """fora da allowlist"""
        return "ran"

    asyncio.run(servidor.call_tool("exec_shell", {"token": SEGREDO}))

    (attrs,) = atributos(exportador)
    assert attrs["cta.compliance.status"] == "non_compliant"
    assert attrs["cta.security.status"] == "at_risk"
    assert SEGREDO not in str(attrs.get("cta.security.findings"))


def test_fastmcp_add_tool_direto_tambem_e_governado(deps, exportador) -> None:
    servidor = ServidorAltoNivel("teste")
    instrument_mcp_server(deps, servidor)

    def buscar(q: str) -> str:
        """b"""
        return "ok"

    servidor.add_tool(buscar)

    (tool,) = asyncio.run(servidor.list_tools())
    assert tool.name == "buscar"
    asyncio.run(servidor.call_tool("buscar", {"q": "x"}))
    assert atributos(exportador)[0]["gen_ai.tool.name"] == "buscar"


# ─── Server de baixo nivel — ponta a ponta com cliente real ────────────────────


pular_sem_ponta_a_ponta = pytest.mark.skipif(
    conectar_em_memoria is None or MCP_MAJOR != 1,
    reason="ponta a ponta do baixo nivel usa o helper in-memory do mcp 1.x",
)


def servidor_baixo_nivel() -> Server:
    return Server("cta-factory-mcp")


def registra_handlers(servidor: Server) -> None:
    @servidor.list_tools()
    async def _listar() -> List[types.Tool]:
        return [types.Tool(name="buscar", description="b", inputSchema={"type": "object"})]

    @servidor.call_tool()
    async def _despachar(nome: str, args: dict) -> List[types.TextContent]:
        return [types.TextContent(type="text", text=f"chamou {nome}")]


async def chamar(servidor: Server, nome: str, args: dict) -> Any:
    async with conectar_em_memoria(servidor) as cliente:
        await cliente.list_tools()
        return await cliente.call_tool(nome, args)


def test_baixo_nivel_nao_tem_as_superficies_do_alto_nivel() -> None:
    """A premissa do bug, fixada: e por nao ter nenhum desses metodos que a
    versao anterior devolvia o servidor intacto. O metodo de registro proprio
    muda entre as majors -- `call_tool` no 1.x, `add_request_handler` no 2.x --
    e a instrumentacao precisa achar um dos dois."""
    servidor = servidor_baixo_nivel()
    assert not hasattr(servidor, "add_tool")
    assert not hasattr(servidor, "register_tool")
    assert not hasattr(servidor, "tool")
    assert callable(getattr(servidor, "call_tool", None)) or callable(
        getattr(servidor, "add_request_handler", None)
    )


def test_baixo_nivel_e_instrumentado_em_qualquer_major(deps) -> None:
    """Sem isso, o baixo nivel do 2.x cairia no `raise` de falha alta."""
    servidor = servidor_baixo_nivel()
    assert instrument_mcp_server(deps, servidor) is servidor


@pular_sem_ponta_a_ponta
def test_baixo_nivel_emite_span_por_tool_despachada(deps, exportador) -> None:
    servidor = servidor_baixo_nivel()
    instrument_mcp_server(deps, servidor)
    registra_handlers(servidor)

    resultado = asyncio.run(chamar(servidor, "buscar", {"q": "x"}))
    assert texto(resultado) == "chamou buscar"

    attrs = atributos(exportador)
    assert len(attrs) == 1, "tools/list nao pode virar span de tool"
    assert attrs[0]["gen_ai.tool.name"] == "buscar"
    assert attrs[0]["cta.compliance.status"] == "compliant"


@pular_sem_ponta_a_ponta
def test_baixo_nivel_governa_cada_tool_separadamente(deps, exportador) -> None:
    servidor = servidor_baixo_nivel()
    instrument_mcp_server(deps, servidor)
    registra_handlers(servidor)

    asyncio.run(chamar(servidor, "exec_shell", {"token": SEGREDO}))

    (attrs,) = atributos(exportador)
    assert attrs["gen_ai.tool.name"] == "exec_shell"
    assert attrs["cta.compliance.status"] == "non_compliant"
    assert attrs["cta.security.status"] == "at_risk"
    assert SEGREDO not in str(attrs.get("cta.security.findings"))


@pular_sem_ponta_a_ponta
def test_baixo_nivel_retrofita_despacho_registrado_antes(deps, exportador) -> None:
    """Ordem invertida de proposito: registrar ANTES de instrumentar. Sem o
    retrofit isso seria outro no-op silencioso, so que por outro motivo."""
    servidor = servidor_baixo_nivel()
    registra_handlers(servidor)
    instrument_mcp_server(deps, servidor)

    resultado = asyncio.run(chamar(servidor, "buscar", {"q": "x"}))
    assert texto(resultado) == "chamou buscar"
    assert atributos(exportador)[0]["gen_ai.tool.name"] == "buscar"


@pular_sem_ponta_a_ponta
def test_baixo_nivel_instrumentar_duas_vezes_nao_duplica(deps, exportador) -> None:
    servidor = servidor_baixo_nivel()
    instrument_mcp_server(deps, servidor)
    instrument_mcp_server(deps, servidor)
    registra_handlers(servidor)

    asyncio.run(chamar(servidor, "buscar", {"q": "x"}))
    assert len(exportador.get_finished_spans()) == 1


# ─── Server de baixo nivel no mcp 2.x (registro por string de metodo) ─────────

so_2x = pytest.mark.skipif(MCP_MAJOR != 2, reason="registro por `add_request_handler` e do mcp 2.x")


def despachar_2x(servidor: Server, nome: str, args: dict) -> Any:
    """Chama o handler registrado do jeito que o servidor 2.x chama:
    `await handler(ctx, params)`."""
    entrada = servidor.get_request_handler("tools/call")
    params = types.CallToolRequestParams(name=nome, arguments=args)
    return asyncio.run(entrada.handler(None, params))


@so_2x
def test_2x_emite_span_por_tool_despachada(deps, exportador) -> None:
    servidor = servidor_baixo_nivel()
    instrument_mcp_server(deps, servidor)

    async def _despachar(ctx: Any, params: Any) -> Any:
        return {"texto": f"chamou {params.name}"}

    servidor.add_request_handler("tools/call", types.CallToolRequestParams, _despachar)
    assert despachar_2x(servidor, "buscar", {"q": "x"}) == {"texto": "chamou buscar"}

    (attrs,) = atributos(exportador)
    assert attrs["gen_ai.tool.name"] == "buscar"
    assert attrs["cta.compliance.status"] == "compliant"


@so_2x
def test_2x_nao_toca_handlers_de_outros_metodos(deps, exportador) -> None:
    servidor = servidor_baixo_nivel()
    instrument_mcp_server(deps, servidor)

    async def _listar(ctx: Any, params: Any) -> Any:
        return {"tools": []}

    servidor.add_request_handler("tools/list", types.PaginatedRequestParams, _listar)
    entrada = servidor.get_request_handler("tools/list")
    assert entrada.handler is _listar
    asyncio.run(entrada.handler(None, None))
    assert len(exportador.get_finished_spans()) == 0


@so_2x
def test_2x_retrofita_despacho_registrado_antes(deps, exportador) -> None:
    servidor = servidor_baixo_nivel()

    async def _despachar(ctx: Any, params: Any) -> Any:
        return {"texto": f"chamou {params.name}"}

    servidor.add_request_handler("tools/call", types.CallToolRequestParams, _despachar)
    instrument_mcp_server(deps, servidor)  # ordem INVERTIDA

    despachar_2x(servidor, "exec_shell", {"token": SEGREDO})
    (attrs,) = atributos(exportador)
    assert attrs["gen_ai.tool.name"] == "exec_shell"
    assert attrs["cta.compliance.status"] == "non_compliant"
    assert SEGREDO not in str(attrs.get("cta.security.findings"))


# ─── Falha alto ───────────────────────────────────────────────────────────────


def test_lanca_quando_o_servidor_nao_expoe_superficie_de_tool(deps) -> None:
    class ServidorEstranho:
        def connect(self) -> None: ...

    with pytest.raises(TypeError, match="superf"):
        instrument_mcp_server(deps, ServidorEstranho())


def test_a_mensagem_nomeia_as_duas_superficies_suportadas(deps) -> None:
    with pytest.raises(TypeError) as erro:
        instrument_mcp_server(deps, object())
    texto = str(erro.value)
    assert "add_tool" in texto and "call_tool" in texto


def test_lanca_quando_nao_recebe_servidor(deps) -> None:
    with pytest.raises(ValueError, match="inst.ncia"):
        instrument_mcp_server(deps, None)
