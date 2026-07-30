"""
identity_context — resolve e propaga a identidade do *usuário final* por trás de
uma invocação, pra cada span ser atribuído a uma pessoa/departamento/centro de
custo reais (Requirement 4). Paridade 1:1 com `src/identity-context.ts`.

Três peças:
  1. `with_user(ctx, fn)` / `get_current_user()` — um `contextvars.ContextVar`
     que carrega o `UserContext` pelo fluxo (sync ou async).
  2. `parse_identity_headers(...)` — extrai identidade dos carriers reais do CTA:
     header `x-cta-security-context` e/ou um Bearer JWT.
  3. `apply_identity_to_span(span, ctx)` — grava `enduser.id`, `cta.department`,
     `cta.cost_center` quando conhecidos, ou o marcador explícito
     `cta.identity.anonymous=true` quando nada é resolvível.

Invariantes: ZERO fallback (sem `?? 'unknown'`, sem owner do manifesto);
identidade é propagada, nunca emitida (o JWT só é lido); telemetria nunca quebra
o agente (header/JWT malformado degrada pra "sem identidade" → anônimo, nunca
lança).
"""

from __future__ import annotations

import base64
import inspect
import json
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, TypeVar

from opentelemetry.trace import Span

from .constants import (
    CTA_COST_CENTER,
    CTA_DEPARTMENT,
    CTA_IDENTITY_ANONYMOUS,
    ENDUSER_ID,
)
from .types import UserContext

_T = TypeVar("_T")

# ─── Store contextvars ────────────────────────────────────────────────────────

_identity_store: ContextVar[Optional[UserContext]] = ContextVar(
    "pump_evolution_identity", default=None
)


def with_user(ctx: UserContext, fn: Callable[[], _T]) -> _T:
    """Roda `fn` com `ctx` como identidade corrente, propagada a todos os spans
    criados dentro da chamada (sync ou async). Para `fn` async (retorna
    awaitable), a identidade permanece em escopo até o await concluir; chamadas
    aninhadas sobrescrevem e restauram (semântica de contextvars)."""
    token = _identity_store.set(ctx)
    try:
        result = fn()
    except BaseException:
        _identity_store.reset(token)
        raise
    if inspect.isawaitable(result):

        async def _await_within_scope() -> Any:
            try:
                return await result  # type: ignore[misc]
            finally:
                _identity_store.reset(token)

        return _await_within_scope()  # type: ignore[return-value]
    _identity_store.reset(token)
    return result


def get_current_user() -> Optional[UserContext]:
    """Retorna o `UserContext` em escopo, ou `None` fora de qualquer `with_user`."""
    return _identity_store.get()


# ─── Helpers de narrowing (parseiam `unknown`, nunca fabricam) ────────────────


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _read_string(value: Any) -> Optional[str]:
    """String não-vazia (trim), senão None. Nunca lança."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return None if len(trimmed) == 0 else trimmed


# ─── Decodificação de payload JWT (sem verificar assinatura — lado cliente) ───


def _decode_jwt_payload(token: str) -> Optional[Dict[str, Any]]:
    """Base64url-decodifica e faz JSON-parse do payload de um JWT SEM verificar a
    assinatura (o SDK é cliente; verificação é do receiver). Retorna o dict de
    claims, ou None quando não é um JWT de 3 segmentos com payload objeto. Nunca
    lança."""
    segments = token.split(".")
    if len(segments) != 3:
        return None
    payload_segment = segments[1]
    if len(payload_segment) == 0:
        return None
    try:
        pad = "=" * (-len(payload_segment) % 4)
        raw = base64.urlsafe_b64decode(payload_segment + pad).decode("utf-8")
        parsed = json.loads(raw)
        return parsed if _is_record(parsed) else None
    except Exception:
        return None


def _decode_security_context(raw: str) -> Optional[Dict[str, Any]]:
    """Interpreta um valor cru de `x-cta-security-context` num dict de claims. O
    valor pode ser um JWT (claims, possivelmente sob `sc`) ou um objeto JSON cru.
    Retorna None quando nenhum parseia. Nunca lança."""
    jwt_payload = _decode_jwt_payload(raw)
    if jwt_payload is not None:
        return jwt_payload
    try:
        parsed = json.loads(raw)
        return parsed if _is_record(parsed) else None
    except Exception:
        return None


# ─── Extração de claim ─────────────────────────────────────────────────────────


def _extract_identity(claims: Dict[str, Any]) -> UserContext:
    """Extrai `{user_id, department, cost_center}` de um dict de claims, casando
    os nomes reais do CTA/Cognito. Entende tanto o `SecurityContext` embrulhado
    (claims sob `sc`, usando `principalId`/`email`) quanto um token Cognito plano
    (`email`/`sub`, `custom:department`, `custom:cost_center`/`custom:cta_cost_center`)."""
    sc = claims["sc"] if _is_record(claims.get("sc")) else claims

    user_id = (
        _read_string(sc.get("email"))
        or _read_string(sc.get("principalId"))
        or _read_string(sc.get("sub"))
        or _read_string(claims.get("email"))
        or _read_string(claims.get("sub"))
    )
    department = _read_string(sc.get("department")) or _read_string(sc.get("custom:department"))
    cost_center = (
        _read_string(sc.get("costCenter"))
        or _read_string(sc.get("custom:cost_center"))
        or _read_string(sc.get("custom:cta_cost_center"))
    )
    return UserContext(user_id=user_id, department=department, cost_center=cost_center)


def _merge_context(primary: UserContext, secondary: UserContext) -> UserContext:
    """Mescla dois contextos, preferindo os campos já setados (maior precedência)."""
    return UserContext(
        user_id=primary.user_id or secondary.user_id,
        department=primary.department or secondary.department,
        cost_center=primary.cost_center or secondary.cost_center,
        token=primary.token or secondary.token,
    )


@dataclass(frozen=True)
class IdentityHeaderInput:
    """Entradas para `parse_identity_headers`."""

    security_context: Optional[str] = None  # header x-cta-security-context (JWT ou JSON)
    authorization: Optional[str] = None  # header Authorization ou Bearer JWT cru


_BEARER_RE = re.compile(r"^Bearer\s+", re.IGNORECASE)


def parse_identity_headers(input: IdentityHeaderInput) -> Optional[UserContext]:
    """Parseia identidade dos carriers da request num `UserContext`.

    Precedência quando ambos presentes: o header `x-cta-security-context` vence o
    Bearer JWT (é a identidade já resolvida/propagada pelo control plane); campos
    ausentes no security context são preenchidos pelo Bearer. O token original é
    preservado em `UserContext.token` pra propagação downstream — só é lido,
    nunca emitido. Retorna None quando nenhum carrier rende identidade. NUNCA
    lança — carriers malformados degradam pra "sem identidade"."""
    bearer = _read_string(input.authorization)
    raw_token = _BEARER_RE.sub("", bearer) if bearer is not None else None
    raw_security_context = _read_string(input.security_context)

    resolved = UserContext()
    propagated_token: Optional[str] = None

    if raw_security_context is not None:
        claims = _decode_security_context(raw_security_context)
        if claims is not None:
            resolved = _merge_context(resolved, _extract_identity(claims))
            propagated_token = raw_security_context

    if raw_token is not None and len(raw_token) > 0:
        claims = _decode_jwt_payload(raw_token)
        if claims is not None:
            resolved = _merge_context(resolved, _extract_identity(claims))
            if propagated_token is None:
                propagated_token = raw_token

    has_identity = (
        resolved.user_id is not None
        or resolved.department is not None
        or resolved.cost_center is not None
    )
    if not has_identity:
        return None
    return UserContext(
        user_id=resolved.user_id,
        department=resolved.department,
        cost_center=resolved.cost_center,
        token=propagated_token,
    )


def apply_identity_to_span(span: Span, ctx: Optional[UserContext] = None) -> None:
    """Aplica a identidade resolvida a um span. Quando algum de
    `user_id`/`department`/`cost_center` está presente, seta o atributo
    correspondente (`enduser.id`/`cta.department`/`cta.cost_center`). Quando NADA
    é resolvível, marca o span explicitamente anônimo (`cta.identity.anonymous=true`)
    — nunca substitui por `'unknown'` nem cai no owner do manifesto. O `token`
    NÃO é escrito no span (é credencial de propagação, não telemetria). `ctx`
    default é o escopo corrente de `with_user`."""
    if ctx is None:
        ctx = get_current_user()

    user_id = _read_string(ctx.user_id) if ctx else None
    department = _read_string(ctx.department) if ctx else None
    cost_center = _read_string(ctx.cost_center) if ctx else None

    has_identity = user_id is not None or department is not None or cost_center is not None
    if not has_identity:
        span.set_attribute(CTA_IDENTITY_ANONYMOUS, True)
        return

    if user_id is not None:
        span.set_attribute(ENDUSER_ID, user_id)
    if department is not None:
        span.set_attribute(CTA_DEPARTMENT, department)
    if cost_center is not None:
        span.set_attribute(CTA_COST_CENTER, cost_center)


def claims_to_user_context(claims: Dict[str, Any]) -> UserContext:
    """Mapeia claims verificados do IdP (Cognito) para um `UserContext`, pra
    alimentar `with_user`. Fecha o laço do consumer-auth. Precedência entre
    fontes reais de claim (não é fallback fabricado); ausentes são omitidos."""
    user_id = (
        _read_string(claims.get("email"))
        or _read_string(claims.get("cognito:username"))
        or _read_string(claims.get("username"))
        or _read_string(claims.get("sub"))
    )
    department = _read_string(claims.get("custom:department"))
    cost_center = _read_string(claims.get("custom:costCenter")) or _read_string(
        claims.get("custom:cost_center")
    )
    return UserContext(user_id=user_id, department=department, cost_center=cost_center)
