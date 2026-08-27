"""Middleware de identidade para FastAPI/Starlette.

Até agora este código era um ARQUIVO PARA COPIAR, entregue solto no kit de
onboarding. Cada integrador colava no projeto e adaptava — e a versão que
circulava trazia imports da aplicação de origem (`src.db.models.Setting`), que
não existem em lugar nenhum além dela. Ou seja: um template que não roda sem
edição, num ponto onde errar significa perder a atribuição de custo por
departamento.

Aqui ele é módulo: importável, sem dependência de como o SEU app guarda as
coisas. O que varia entre projetos entra por callback.

Uso mínimo — quando o usuário logado está em `request.state.user`:

    from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

    app.add_middleware(PumpIdentityMiddleware)

Uso completo — quando o departamento vem do `id_token` que o app guardou:

    async def buscar_id_token(request, email):
        # de um banco, cookie, sessão, header... o que for o seu caso
        return await meu_repositorio.token_de(email)

    app.add_middleware(PumpIdentityMiddleware, id_token_resolver=buscar_id_token)

Por que o id_token importa: o grupo de acesso interno do app (`Administrador`,
`Operador`) NÃO é o departamento da pessoa. O departamento real vem dos claims
`custom:department` / `custom:topaz_directorate` do Cognito, e é ele que
sustenta o custo por centro de custo no portal. Sem o id_token, o span sai com
o usuário correto e sem departamento.

O middleware nunca quebra o request: qualquer falha aqui é engolida e a
requisição segue. Telemetria não derruba aplicação.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

from ..identity_context import _identity_store, claims_to_user_context
from ..types import UserContext

try:  # pragma: no cover - depende do app hospedeiro
    from starlette.middleware.base import BaseHTTPMiddleware
except ImportError as erro:  # pragma: no cover
    raise ImportError(
        "pump_evolution.integrations.fastapi exige starlette (instalado junto "
        "com fastapi). Instale o app com FastAPI ou use o SDK sem este módulo."
    ) from erro


ResolvedorDeUsuario = Callable[[Any], Optional[Any]]
ResolvedorDeIdToken = Callable[[Any, Optional[str]], Awaitable[Optional[str]]]


def _usuario_padrao(request: Any) -> Optional[Any]:
    """Convenção mais comum em FastAPI: o auth middleware do app popula
    `request.state.user`."""
    return getattr(getattr(request, "state", None), "user", None)


def _email_de(usuario: Any) -> Optional[str]:
    for atributo in ("email", "user_id", "username", "sub"):
        valor = getattr(usuario, atributo, None)
        if isinstance(valor, str) and valor:
            return valor
    if isinstance(usuario, dict):
        for chave in ("email", "user_id", "username", "sub"):
            valor = usuario.get(chave)
            if isinstance(valor, str) and valor:
                return valor
    return None


class PumpIdentityMiddleware(BaseHTTPMiddleware):
    """Propaga a identidade do usuário logado para os spans da requisição.

    O SDK NÃO valida o JWT: ele confia no middleware de autenticação do próprio
    agente, que já resolveu quem é a pessoa. Aqui apenas lemos o resultado e
    propagamos por contextvar, de modo que qualquer span emitido durante a
    requisição saia atribuído.

    Isso é o que permite o agente usar QUALQUER Cognito, SSO ou auth próprio:
    as duas identidades — a da pessoa e a da máquina que envia telemetria —
    nunca se cruzam.
    """

    def __init__(
        self,
        app: Any,
        *,
        user_resolver: ResolvedorDeUsuario = _usuario_padrao,
        id_token_resolver: Optional[ResolvedorDeIdToken] = None,
    ) -> None:
        super().__init__(app)
        self._resolver_usuario = user_resolver
        self._resolver_id_token = id_token_resolver

    async def dispatch(self, request: Any, call_next: Any) -> Any:
        contexto = None
        try:
            contexto = await self._montar_contexto(request)
        except Exception:
            contexto = None  # nunca quebra o request por telemetria

        if contexto is None:
            return await call_next(request)

        token = _identity_store.set(contexto)
        try:
            return await call_next(request)
        finally:
            _identity_store.reset(token)

    async def _montar_contexto(self, request: Any) -> Optional[UserContext]:
        usuario = self._resolver_usuario(request)
        if usuario is None:
            return None
        email = _email_de(usuario)
        if not email:
            return None

        # Sem resolvedor de id_token, temos QUEM é — e não de onde vem o custo.
        if self._resolver_id_token is None:
            return UserContext(user_id=email)

        try:
            id_token = await self._resolver_id_token(request, email)
        except Exception:
            id_token = None
        if not id_token:
            return UserContext(user_id=email)

        from ..identity_context import _decode_jwt_payload

        claims = _decode_jwt_payload(id_token)
        if not claims:
            return UserContext(user_id=email)

        # claims_to_user_context já cobre os aliases de department e cost_center
        # (custom:department / custom:topaz_directorate, custom:cost_center /
        # custom:cta_cost_center) — o mesmo que o template fazia à mão.
        contexto = claims_to_user_context(claims)
        if not contexto.user_id:
            contexto = UserContext(
                user_id=email,
                department=contexto.department,
                cost_center=contexto.cost_center,
            )
        return contexto


__all__ = ["PumpIdentityMiddleware"]
