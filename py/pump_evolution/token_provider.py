"""
token_provider — obtém e cacheia o bearer token de service account usado pra
autenticar o export OTLP (Requirement 7.2). Paridade 1:1 com `src/token-provider.ts`.

O token é emitido pelo grant OAuth 2.0 **client-credentials** contra o `token_url`
(um endpoint Cognito `/oauth2/token`). Credenciais vão como HTTP Basic auth (estilo
padrão client-credentials do Cognito). O token é cacheado e renovado
proativamente um skew antes de expirar, e refreshes concorrentes são deduplicados
atrás de um único request in-flight. `fetch_impl` é injetável pra teste. Este
módulo nunca loga e nunca lança pro fluxo do agente além de um coroutine
rejeitado que o exporter trata.

Segurança: o client secret vive só no ambiente/config do agente, é usado apenas
pra montar o header Basic auth, e nunca é logado nem anexado à telemetria.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional
from urllib.parse import quote
from urllib.request import Request, urlopen

# Scope OAuth default do receiver de telemetria.
#
# O Cognito exige o scope qualificado pelo resource server no pedido
# client-credentials: `<resourceServerIdentifier>/<scopeName>`. No CTA o resource
# server é `telemetry` e o scope `telemetry:write` → `telemetry/telemetry:write`.
# O receiver valida via `endsWith('/telemetry:write')`, então o qualificado é
# aceito. Pedir o scope bare resulta em 400 invalid_scope. Sobrescreva via
# `scope` pra outro resource server.
DEFAULT_TELEMETRY_SCOPE = "telemetry/telemetry:write"


# ─── Fetch injetável ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FetchResponse:
    """Subconjunto estrutural mínimo da resposta de `fetch`, pra injeção em teste."""

    ok: bool
    status: int
    body: str

    def text(self) -> str:
        return self.body


# (url, method, headers, body) -> resposta
FetchLike = Callable[[str, str, Dict[str, str], str], Awaitable[FetchResponse]]


async def _default_fetch(url: str, method: str, headers: Dict[str, str], body: str) -> FetchResponse:
    """Fetch default via urllib (stdlib), rodado numa thread pra não bloquear o loop."""

    def _do() -> FetchResponse:
        req = Request(url, data=body.encode("utf-8"), headers=headers, method=method)
        try:
            with urlopen(req) as resp:  # noqa: S310 — URL vem de config do dono
                text = resp.read().decode("utf-8")
                status = resp.getcode() or 0
                return FetchResponse(ok=200 <= status < 300, status=status, body=text)
        except Exception as err:  # HTTPError tem .code/.read()
            code = getattr(err, "code", 0) or 0
            try:
                text = err.read().decode("utf-8")  # type: ignore[attr-defined]
            except Exception:
                text = ""
            return FetchResponse(ok=False, status=code, body=text)

    return await asyncio.to_thread(_do)


# ─── Narrowing ──────────────────────────────────────────────────────────────────


def _read_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return None if len(trimmed) == 0 else trimmed


def _parse_token_response(text: str) -> "tuple[str, float]":
    """Parseia a resposta do token endpoint em `(access_token, expires_in_sec)`.
    Lança em resposta não-JSON ou sem `access_token`. `expires_in` ausente/inválido
    → default 3600s."""
    try:
        parsed = json.loads(text)
    except Exception:
        raise ValueError("[pump-evolution] token endpoint returned non-JSON response.")
    if not isinstance(parsed, dict):
        raise ValueError("[pump-evolution] token endpoint returned non-JSON response.")
    access_token = _read_string(parsed.get("access_token"))
    if access_token is None:
        raise ValueError("[pump-evolution] token response missing access_token.")
    raw_expires = parsed.get("expires_in")
    expires_in_sec = (
        float(raw_expires)
        if isinstance(raw_expires, (int, float)) and not isinstance(raw_expires, bool)
        else 3600.0
    )
    return access_token, expires_in_sec


# ─── Provider ─────────────────────────────────────────────────────────────────


def _default_now() -> float:
    return time.time() * 1000.0


@dataclass(frozen=True)
class _CachedToken:
    value: str
    refresh_at: float  # epoch-ms absoluto em que o token deve ser considerado expirado


class ServiceAccountTokenProvider:
    """Cacheia um bearer token client-credentials e o renova antes de expirar."""

    def __init__(
        self,
        *,
        token_url: str,
        client_id: str,
        client_secret: str,
        scope: Optional[str] = None,
        refresh_skew_ms: float = 60_000,
        fetch_impl: Optional[FetchLike] = None,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self._token_url = token_url
        self._basic_auth = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode(
            "ascii"
        )
        self._scope = scope if scope is not None else DEFAULT_TELEMETRY_SCOPE
        self._refresh_skew_ms = refresh_skew_ms
        self._fetch_impl: FetchLike = fetch_impl if fetch_impl is not None else _default_fetch
        self._now = now if now is not None else _default_now
        self._cached: Optional[_CachedToken] = None
        self._in_flight: Optional["asyncio.Future[str]"] = None

    async def get_token(self) -> str:
        """Retorna um bearer válido, emitindo/renovando conforme necessário.
        Chamadas concorrentes durante um refresh compartilham o mesmo request."""
        current = self._cached
        if current is not None and self._now() < current.refresh_at:
            return current.value
        if self._in_flight is None:
            self._in_flight = asyncio.ensure_future(self._refresh())
        try:
            return await self._in_flight
        finally:
            self._in_flight = None

    async def _refresh(self) -> str:
        response = await self._fetch_impl(
            self._token_url,
            "POST",
            {
                "Authorization": f"Basic {self._basic_auth}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            f"grant_type=client_credentials&scope={quote(self._scope, safe='')}",
        )
        if not response.ok:
            raise ValueError(
                f"[pump-evolution] token endpoint responded {response.status} "
                "for client-credentials grant."
            )
        access_token, expires_in_sec = _parse_token_response(response.text())
        refresh_at = self._now() + max(0.0, expires_in_sec * 1000 - self._refresh_skew_ms)
        self._cached = _CachedToken(value=access_token, refresh_at=refresh_at)
        return access_token
