"""
mcp_instrumentation — telemetria governada para **servidores MCP** (Model Context
Protocol), pra o CTA mapear MCPs no mesmo pipeline de observabilidade dos agentes.
Paridade 1:1 com `src/mcp-instrumentation.ts` — inclusive na cobertura das duas
formas de servidor (alto e baixo nível) e no falhar alto quando não reconhece.

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

import functools
import inspect
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


def _build_invocation(name: Any, payload: Any) -> McpToolInvocation:
    """Monta a invocação a partir do nome e do payload já escolhido pelo chamador."""
    tool_name = _read_tool_name(name)
    input_str = _serialize_tool_input(payload)
    return (
        McpToolInvocation(name=tool_name, input=input_str)
        if input_str is not None
        else McpToolInvocation(name=tool_name)
    )


# Marca uma função já embrulhada. O `tool()` do FastMCP delega pro `add_tool()`, e
# os dois são instrumentados — sem a marca, a mesma tool sairia com dois spans
# aninhados. `Symbol.for`-equivalente: um atributo de nome fixo na própria função.
_TRACED_ATTR = "__pump_evolution_traced__"


def _trace_tool_fn(fn: Any, deps: McpToolTracerDeps, name: Any) -> Any:
    """Embrulha a FUNÇÃO da tool (FastMCP) preservando a identidade dela.

    Preservar `functools.wraps` aqui não é cosmético: o FastMCP deriva o NOME da
    tool de `fn.__name__` e o inputSchema da assinatura via `inspect.signature`.
    Um wrapper `(*args, **kwargs)` cru registrava a tool como `traced_handler`
    com schema `{call_args, call_kwargs}` — quebrava o servidor, não só a
    telemetria. `functools.wraps` copia `__name__`/`__doc__`/`__annotations__` e
    aponta `__wrapped__` pra original, que é o que `inspect.signature` segue.

    O async precisa ser preservado no MESMO formato: o FastMCP checa
    `iscoroutinefunction` pra decidir como chamar."""
    if getattr(fn, _TRACED_ATTR, False):
        return fn

    tool_name = _read_tool_name(name if name is not None else getattr(fn, "__name__", None))

    # O FastMCP chama a tool por keyword (os argumentos vêm do JSON da chamada),
    # então o payload a escanear está em `kwargs` — não no primeiro posicional.
    def _payload(call_args: Any, call_kwargs: Any) -> Any:
        if call_kwargs:
            return call_kwargs
        return call_args[0] if call_args else None

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def traced_async(*call_args: Any, **call_kwargs: Any) -> Any:
            invocation = _build_invocation(tool_name, _payload(call_args, call_kwargs))
            return await trace_mcp_tool(
                deps, invocation, lambda: fn(*call_args, **call_kwargs)
            )

        traced: Any = traced_async
    else:

        @functools.wraps(fn)
        def traced_sync(*call_args: Any, **call_kwargs: Any) -> Any:
            invocation = _build_invocation(tool_name, _payload(call_args, call_kwargs))
            return trace_mcp_tool(deps, invocation, lambda: fn(*call_args, **call_kwargs))

        traced = traced_sync

    setattr(traced, _TRACED_ATTR, True)
    return traced


# ─── FastMCP (alto nível: uma função por tool) ──────────────────────────────────


def _wrap_add_tool(original: Callable[..., Any], deps: McpToolTracerDeps):
    """`add_tool(fn, name=None, ...)` — a função é o PRIMEIRO argumento, não o
    último. O nome vem de `name` (kw ou posicional) e, na falta dele, do
    `fn.__name__`, que é de onde o próprio FastMCP tira."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        if not args or not callable(args[0]):
            return original(*args, **kwargs)
        fn = args[0]
        name = kwargs.get("name")
        if name is None and len(args) > 1 and isinstance(args[1], str):
            name = args[1]
        new_args = (_trace_tool_fn(fn, deps, name),) + tuple(args[1:])
        return original(*new_args, **kwargs)

    return wrapper


def _wrap_tool_decorator(original: Callable[..., Any], deps: McpToolTracerDeps):
    """`tool(name=None, ...)` devolve um DECORATOR — não recebe a função na
    chamada. Embrulhamos a função no momento em que o decorator a recebe.

    O `tool()` do FastMCP delega pro `add_tool()`, que também é instrumentado; a
    marca `_TRACED_ATTR` evita o span duplicado. Instrumentar os dois é de
    propósito: versões do SDK que registrem sem passar pelo `add_tool` público
    continuam cobertas."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        decorator = original(*args, **kwargs)
        if not callable(decorator):
            return decorator
        name = kwargs.get("name")
        if name is None and args and isinstance(args[0], str):
            name = args[0]

        def traced_decorator(fn: Any) -> Any:
            if not callable(fn):
                return decorator(fn)
            return decorator(_trace_tool_fn(fn, deps, name))

        return traced_decorator

    return wrapper


# ─── Server de baixo nível (um único despacho de `tools/call`) ──────────────────

# O método por onde o servidor de baixo nível despacha TODA chamada de tool.
# No `mcp` 2.x ele é a própria chave de registro; no 1.x, o nome da classe do
# request. Mesmo papel do `CALL_TOOL_METHOD` no lado TypeScript.
_CALL_TOOL_METHOD = "tools/call"


def _trace_dispatch_fn(fn: Any, deps: McpToolTracerDeps) -> Any:
    """Embrulha o despachante do servidor de baixo nível. O SDK o chama como
    `await func(tool_name, arguments)` — nome e input vêm posicionalmente."""
    if getattr(fn, _TRACED_ATTR, False):
        return fn

    def _parts(call_args: Any, call_kwargs: Any) -> Any:
        name = call_args[0] if call_args else call_kwargs.get("name")
        payload = call_args[1] if len(call_args) > 1 else call_kwargs.get("arguments")
        return name, payload

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def traced_async(*call_args: Any, **call_kwargs: Any) -> Any:
            name, payload = _parts(call_args, call_kwargs)
            return await trace_mcp_tool(
                deps, _build_invocation(name, payload), lambda: fn(*call_args, **call_kwargs)
            )

        traced: Any = traced_async
    else:

        @functools.wraps(fn)
        def traced_sync(*call_args: Any, **call_kwargs: Any) -> Any:
            name, payload = _parts(call_args, call_kwargs)
            return trace_mcp_tool(
                deps, _build_invocation(name, payload), lambda: fn(*call_args, **call_kwargs)
            )

        traced = traced_sync

    setattr(traced, _TRACED_ATTR, True)
    return traced


def _wrap_call_tool_decorator(original: Callable[..., Any], deps: McpToolTracerDeps):
    """`call_tool(*, validate_input=True)` do `mcp.server.lowlevel.Server` devolve
    um decorator que recebe o despachante. Cada tool que ele despacha vira um
    span próprio."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        decorator = original(*args, **kwargs)
        if not callable(decorator):
            return decorator

        def traced_decorator(fn: Any) -> Any:
            if not callable(fn):
                return decorator(fn)
            return decorator(_trace_dispatch_fn(fn, deps))

        return traced_decorator

    return wrapper


def _trace_request_handler(handler: Any, deps: McpToolTracerDeps) -> Any:
    """Embrulha um handler já registrado, que recebe o objeto `CallToolRequest`
    inteiro — nome e input saem de `req.params`."""
    if getattr(handler, _TRACED_ATTR, False):
        return handler

    def _parts(req: Any) -> Any:
        params = getattr(req, "params", None)
        return getattr(params, "name", None), getattr(params, "arguments", None)

    if inspect.iscoroutinefunction(handler):

        @functools.wraps(handler)
        async def traced_async(req: Any, *rest: Any, **kw: Any) -> Any:
            name, payload = _parts(req)
            return await trace_mcp_tool(
                deps, _build_invocation(name, payload), lambda: handler(req, *rest, **kw)
            )

        traced: Any = traced_async
    else:

        @functools.wraps(handler)
        def traced_sync(req: Any, *rest: Any, **kw: Any) -> Any:
            name, payload = _parts(req)
            return trace_mcp_tool(
                deps, _build_invocation(name, payload), lambda: handler(req, *rest, **kw)
            )

        traced = traced_sync

    setattr(traced, _TRACED_ATTR, True)
    return traced


def _trace_params_handler(handler: Any, deps: McpToolTracerDeps) -> Any:
    """Embrulha um handler no formato do `mcp` 2.x, que o servidor chama como
    `await handler(ctx, params)` — nome e input saem de `params`."""
    if getattr(handler, _TRACED_ATTR, False):
        return handler

    def _parts(call_args: Any, call_kwargs: Any) -> Any:
        params = call_args[1] if len(call_args) > 1 else call_kwargs.get("params")
        return getattr(params, "name", None), getattr(params, "arguments", None)

    if inspect.iscoroutinefunction(handler):

        @functools.wraps(handler)
        async def traced_async(*call_args: Any, **call_kwargs: Any) -> Any:
            name, payload = _parts(call_args, call_kwargs)
            return await trace_mcp_tool(
                deps,
                _build_invocation(name, payload),
                lambda: handler(*call_args, **call_kwargs),
            )

        traced: Any = traced_async
    else:

        @functools.wraps(handler)
        def traced_sync(*call_args: Any, **call_kwargs: Any) -> Any:
            name, payload = _parts(call_args, call_kwargs)
            return trace_mcp_tool(
                deps,
                _build_invocation(name, payload),
                lambda: handler(*call_args, **call_kwargs),
            )

        traced = traced_sync

    setattr(traced, _TRACED_ATTR, True)
    return traced


def _wrap_add_request_handler(original: Callable[..., Any], deps: McpToolTracerDeps):
    """`add_request_handler(method, params_type, handler)` — o registro de baixo
    nível do `mcp` 2.x, onde o método é uma STRING. Só o handler de `tools/call`
    é embrulhado; os demais são registrados intactos."""

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        method = kwargs.get("method")
        if method is None and args and isinstance(args[0], str):
            method = args[0]
        if method != _CALL_TOOL_METHOD:
            return original(*args, **kwargs)

        if callable(kwargs.get("handler")):
            novos_kwargs = dict(kwargs)
            novos_kwargs["handler"] = _trace_params_handler(kwargs["handler"], deps)
            return original(*args, **novos_kwargs)

        novos_args = list(args)
        for i in range(len(novos_args) - 1, -1, -1):
            if callable(novos_args[i]):
                novos_args[i] = _trace_params_handler(novos_args[i], deps)
                break
        return original(*novos_args, **kwargs)

    return wrapper


def _retrofit_1x(server: Any, deps: McpToolTracerDeps) -> bool:
    """`mcp` 1.x: dict público `request_handlers`, chaveado pelo TIPO do request.
    A chave é achada pelo nome da classe, sem importar o pacote `mcp` — ele não é
    dependência deste SDK."""
    handlers = getattr(server, "request_handlers", None)
    if not isinstance(handlers, dict):
        return False
    for key, handler in list(handlers.items()):
        if getattr(key, "__name__", "") == "CallToolRequest" and callable(handler):
            handlers[key] = _trace_request_handler(handler, deps)
    return True


def _retrofit_2x(server: Any, deps: McpToolTracerDeps) -> bool:
    """`mcp` 2.x: dict privado `_request_handlers`, chaveado pela STRING do
    método, com a entrada carregando `(params_type, handler)`."""
    handlers = getattr(server, "_request_handlers", None)
    if not isinstance(handlers, dict):
        return False
    entrada = handlers.get(_CALL_TOOL_METHOD)
    if entrada is None:
        return True
    interno = getattr(entrada, "handler", None)
    params_type = getattr(entrada, "params_type", None)
    if not callable(interno) or params_type is None:
        return True
    try:
        handlers[_CALL_TOOL_METHOD] = type(entrada)(
            params_type, _trace_params_handler(interno, deps)
        )
    except Exception:
        # Forma interna diferente da esperada — deixa em paz. O caminho de
        # registro já cobre quem instrumenta na ordem certa.
        pass
    return True


def _retrofit_call_tool_handler(server: Any, deps: McpToolTracerDeps) -> None:
    """Instrumenta um despacho de `tools/call` registrado ANTES desta chamada,
    nas duas majors do `mcp`. Best-effort: estrutura desconhecida é ignorada."""
    if not _retrofit_1x(server, deps):
        _retrofit_2x(server, deps)


# ─── Entrada da auto-instrumentação ─────────────────────────────────────────────

_INSTRUMENTED_ATTR = "__pump_evolution_mcp_instrumented__"

# Métodos de registro por tipo de servidor. `add_tool`/`tool` são o FastMCP (alto
# nível); `call_tool` é o `Server` de baixo nível.
_FASTMCP_METHODS = (("add_tool", _wrap_add_tool), ("tool", _wrap_tool_decorator))
_LOWLEVEL_METHODS = (
    ("call_tool", _wrap_call_tool_decorator),          # mcp 1.x
    ("add_request_handler", _wrap_add_request_handler),  # mcp 2.x
)


def _instrument_methods(server: Any, deps: McpToolTracerDeps, methods: Any) -> bool:
    wrapped = False
    for nome, embrulhador in methods:
        original = getattr(server, nome, None)
        if callable(original):
            setattr(server, nome, embrulhador(original, deps))
            wrapped = True
    return wrapped


def instrument_mcp_server(deps: McpToolTracerDeps, server: Any) -> Any:
    """Auto-instrumenta um servidor MCP pra que TODA chamada de tool que ele serve
    seja governada transparentemente — sem `trace_mcp_tool` por handler. Os
    métodos são substituídos in-place; a mesma instância é retornada.

    Cobre as duas formas do pacote `mcp`, nas duas majors:
      - alto nível (`FastMCP` no 1.x, `MCPServer` no 2.x) — `add_tool` e o
        decorator `tool`, uma função por tool. A identidade da função é
        preservada, então nome e inputSchema continuam saindo corretos;
      - baixo nível (`mcp.server.lowlevel.Server`) — o decorator `call_tool` no
        1.x, `add_request_handler("tools/call", ...)` no 2.x. Cada tool que o
        despacho serve vira um span próprio, e um despacho já registrado antes
        desta chamada é instrumentado também.

    A busca é estrutural, por nome de método — o pacote `mcp` não é dependência
    deste SDK, e é o que faz as duas majors serem cobertas pelo mesmo código.

    ORDEM: chame logo após construir o servidor. No FastMCP só tools registradas
    APÓS a instrumentação são embrulhadas, então chame ANTES de registrá-las.

    FALHA ALTO (zero fallback): servidor que não expõe nenhuma dessas superfícies
    LANÇA. Devolvê-lo intacto significaria nunca emitir um span enquanto o
    processo se diz instrumentado — foi assim que este SDK passou meses sem
    telemetria de MCP nenhuma. O SDK desabilitado não chega aqui: o handle no-op
    devolve o servidor sem tocar.

    Instrumentar o mesmo servidor duas vezes é no-op — não duplica span."""
    if server is None:
        raise ValueError(
            "[pump-evolution] instrument_mcp_server espera uma instância de servidor MCP, "
            "recebeu None. Sem fallback."
        )
    if getattr(server, _INSTRUMENTED_ATTR, False):
        return server

    instrumentado = _instrument_methods(server, deps, _FASTMCP_METHODS)
    if not instrumentado:
        instrumentado = _instrument_methods(server, deps, _LOWLEVEL_METHODS)
        if instrumentado:
            _retrofit_call_tool_handler(server, deps)

    if not instrumentado:
        raise TypeError(
            "[pump-evolution] instrument_mcp_server não encontrou superfície de tool neste "
            "servidor: ele não expõe `add_tool`/`tool` (alto nível — FastMCP/MCPServer) nem "
            "`call_tool`/`add_request_handler` (baixo nível — mcp.server.lowlevel.Server, "
            "1.x e 2.x). Nenhum span de tool sairia daqui, então isso falha alto em vez de "
            "em silêncio. Se o servidor tem formato próprio, embrulhe cada handler na mão "
            "com `trace_mcp_tool({'name': ..., 'input': ...}, fn)`."
        )

    try:
        setattr(server, _INSTRUMENTED_ATTR, True)
    except Exception:
        # Servidor que recusa atributos novos — a instrumentação em si já valeu.
        pass
    return server
