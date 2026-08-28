"""Login OAuth2 (Authorization Code + PKCE) com o Cognito de usuário da plataforma.

## Por que este módulo existe

Até aqui a orientação era "não mude o Cognito do agente — o SDK só lê o
`id_token` que ele já tem". Isso funcionava quando o Cognito do agente carregava
os claims de custo (`custom:department`, `custom:cost_center`). Na prática quase
nenhum carregava, e o span saía com o usuário certo e SEM departamento — ou seja,
sem a atribuição de custo, que é a razão de a governança existir.

A solução resolve isso na raiz: o **User Pool de usuário final vive na conta de
tooling da plataforma**, com os claims de custo governados por nós. O agente
troca o login dele para esse pool. Assim TODO usuário logado carrega
`department`/`cost_center` confiáveis, sem depender de como o cliente configurou
o Cognito dele.

O App Client desse agente é provisionado no INSTALL (via Factory API), não no
registro — o instalador coleta as callback URLs do app real antes de criar o
client. As variáveis abaixo saem desse provisionamento.

## O que este módulo faz

Fecha o laço do login: adiciona três rotas ao app FastAPI/Starlette —

    /auth/login      → redireciona para o Hosted UI do Cognito
    /auth/callback   → troca o `code` por tokens, guarda o `id_token` na sessão
    /auth/logout     → encerra a sessão local e no Cognito

E entrega os dois resolvedores que o `PumpIdentityMiddleware` consome, fechando
o circuito identidade → span:

    from pump_evolution.integrations.cognito import CognitoLogin
    from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

    login = CognitoLogin.from_env()          # lê COGNITO_* do ambiente
    login.install(app)                       # monta /auth/login|callback|logout
    app.add_middleware(
        PumpIdentityMiddleware,
        user_resolver=login.user_resolver,
        id_token_resolver=login.id_token_resolver,
    )

Requer `SessionMiddleware` (starlette) montado no app — é onde o `id_token` fica
guardado entre a callback e as requisições seguintes. Sem ele, `install()` avisa
com mensagem clara em vez de falhar em runtime no meio de um login.

## Segurança

- **PKCE (S256) sempre** + parâmetro `state` — protege contra interceptação de
  código e CSRF no callback, mesmo com client confidencial.
- O `client_secret` só viaja no Basic auth da troca de token (server-to-server,
  TLS) — nunca vai para o browser.
- O `id_token` é decodificado SEM verificar assinatura (mesmo contrato do resto
  do SDK: cliente lê, o receiver verifica). A confiança vem da troca de código
  autenticada contra o token endpoint do Cognito sobre TLS.

Falha de LOGIN devolve resposta de erro clara (login é crítico para o app) — ao
contrário da telemetria, que degrada em silêncio.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional

from ..identity_context import _decode_jwt_payload, claims_to_user_context
from ..types import UserContext

try:  # pragma: no cover - depende do app hospedeiro
    from starlette.requests import Request
    from starlette.responses import JSONResponse, RedirectResponse, Response
except ImportError as erro:  # pragma: no cover
    raise ImportError(
        "pump_evolution.integrations.cognito exige starlette (instalado junto "
        "com fastapi). Instale o app com FastAPI ou use o SDK sem este módulo."
    ) from erro


# Chaves de sessão. Prefixadas para não colidir com o que o app já guarda.
_SESSION_USER = "pump_cognito_user"
_SESSION_ID_TOKEN = "pump_cognito_id_token"
_SESSION_STATE = "pump_cognito_state"
_SESSION_VERIFIER = "pump_cognito_pkce_verifier"
_SESSION_NEXT = "pump_cognito_next"

_DEFAULT_SCOPES = "openid email profile"
_TOKEN_TIMEOUT_S = 10


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


@dataclass(frozen=True)
class CognitoLoginConfig:
    """Config do login. Todos os campos exceto `client_secret` e
    `logout_redirect_uri` são obrigatórios — ZERO fallback silencioso: uma URL de
    domínio ou redirect ausente faz o login apontar para o lugar errado sem erro
    visível, exatamente o modo de falha que a governança de custo existe para eliminar."""

    domain: str  # ex.: https://<prefixo>.auth.us-east-1.amazoncognito.com
    client_id: str
    redirect_uri: str  # URL absoluta do /auth/callback registrada no App Client
    client_secret: Optional[str] = None  # só para App Client confidencial
    scopes: str = _DEFAULT_SCOPES
    logout_redirect_uri: Optional[str] = None

    def __post_init__(self) -> None:
        faltando = [
            nome
            for nome, valor in (
                ("domain", self.domain),
                ("client_id", self.client_id),
                ("redirect_uri", self.redirect_uri),
            )
            if not (isinstance(valor, str) and valor.strip())
        ]
        if faltando:
            raise ValueError(
                "CognitoLoginConfig incompleto: faltam "
                + ", ".join(faltando)
                + ". Esses valores saem do provisionamento do App Client (Factory API) "
                "e vão no .env do app — não invente."
            )
        object.__setattr__(self, "domain", self.domain.rstrip("/"))


class CognitoLogin:
    """Wiring de login OAuth2 code flow contra o Cognito da plataforma.

    Instâncias são baratas e sem estado próprio (o estado do fluxo mora na sessão
    do request). Construa uma vez no boot e reutilize.
    """

    def __init__(self, config: CognitoLoginConfig) -> None:
        self._cfg = config

    # ─── Construção ─────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "CognitoLogin":
        """Constrói a partir das variáveis `COGNITO_*` do ambiente.

        Variáveis (as três primeiras obrigatórias):
          - `COGNITO_DOMAIN` — domínio do Hosted UI
          - `COGNITO_CLIENT_ID` — App Client provisionado para este agente
          - `COGNITO_REDIRECT_URI` — URL absoluta do callback (/auth/callback)
          - `COGNITO_CLIENT_SECRET` — opcional, para App Client confidencial
          - `COGNITO_SCOPES` — opcional (default "openid email profile")
          - `COGNITO_LOGOUT_REDIRECT_URI` — opcional, para onde voltar após logout
        """
        src = env if env is not None else os.environ
        cfg = CognitoLoginConfig(
            domain=str(src.get("COGNITO_DOMAIN", "")),
            client_id=str(src.get("COGNITO_CLIENT_ID", "")),
            redirect_uri=str(src.get("COGNITO_REDIRECT_URI", "")),
            client_secret=(src.get("COGNITO_CLIENT_SECRET") or None),
            scopes=str(src.get("COGNITO_SCOPES") or _DEFAULT_SCOPES),
            logout_redirect_uri=(src.get("COGNITO_LOGOUT_REDIRECT_URI") or None),
        )
        return cls(cfg)

    @classmethod
    def from_manifest(
        cls,
        source: Any,
        *,
        client_secret: Optional[str] = None,
        env: Optional[dict] = None,
    ) -> "CognitoLogin":
        """Constrói a partir do MANIFESTO (`runtime.cognito`) — o bloco que o
        portal/MCP provisiona e grava no manifesto no install. Caminho preferido:
        o dev não copia `COGNITO_*` à mão; o SDK lê tudo do manifesto.

        O `client_secret` NUNCA vem do manifesto (git-safe). Para App Client
        confidencial, passe `client_secret` ou deixe o SDK ler `COGNITO_CLIENT_SECRET`
        do ambiente. Cliente público (PKCE) não precisa dele.

        Lança se o manifesto não declarar `runtime.cognito` — sem fallback (ADR-0031)."""
        from ..manifest_loader import load_manifest

        manifest = load_manifest(source)
        cognito = manifest.runtime.cognito if manifest.runtime else None
        if cognito is None:
            raise ValueError(
                "[pump-evolution] CognitoLogin.from_manifest: manifesto sem `runtime.cognito`. "
                "Esse bloco é provisionado pelo portal/MCP no install (App Client de login) e "
                "gravado no manifesto — sem fallback. Use CognitoLogin.from_env() se o login "
                "vier só do ambiente."
            )
        src = env if env is not None else os.environ
        secret = client_secret if client_secret is not None else src.get("COGNITO_CLIENT_SECRET")
        cfg = CognitoLoginConfig(
            domain=cognito.domain,
            client_id=cognito.client_id,
            redirect_uri=cognito.redirect_uri,
            client_secret=(secret or None),
            scopes=(cognito.scopes or _DEFAULT_SCOPES),
            logout_redirect_uri=cognito.logout_redirect_uri,
        )
        return cls(cfg)

    def install(self, app: Any, *, prefix: str = "/auth") -> None:
        """Monta `/auth/login`, `/auth/callback` e `/auth/logout` no app.

        Funciona em qualquer app da família Starlette (FastAPI incluído) via
        `add_route`. Avisa se `SessionMiddleware` não estiver presente — o login
        depende da sessão para guardar `state`/PKCE e o `id_token`.
        """
        self._warn_if_no_session(app)
        base = prefix.rstrip("/")
        app.add_route(f"{base}/login", self._login, methods=["GET"])
        app.add_route(f"{base}/callback", self._callback, methods=["GET"])
        app.add_route(f"{base}/logout", self._logout, methods=["GET"])

    @staticmethod
    def _warn_if_no_session(app: Any) -> None:
        try:
            classes = " ".join(
                type(m).__name__ + getattr(m, "cls", type("", (), {})).__name__
                for m in getattr(app, "user_middleware", [])
            )
        except Exception:
            classes = ""
        if "SessionMiddleware" not in classes:
            import warnings

            warnings.warn(
                "pump_evolution.integrations.cognito: SessionMiddleware não detectado. "
                "Adicione `app.add_middleware(SessionMiddleware, secret_key=...)` — o login "
                "guarda state/PKCE e o id_token na sessão.",
                RuntimeWarning,
                stacklevel=2,
            )

    # ─── Resolvedores para o PumpIdentityMiddleware ───────────────────────────

    def user_resolver(self, request: "Request") -> Optional[dict]:
        """Devolve o usuário logado a partir da sessão (dict com `user_id`,
        `department`, `cost_center`), ou None se ninguém logou ainda."""
        try:
            return request.session.get(_SESSION_USER)
        except Exception:
            return None

    async def id_token_resolver(self, request: "Request", _email: Optional[str]) -> Optional[str]:
        """Devolve o `id_token` guardado na sessão — é dele que o middleware extrai
        `department`/`cost_center` para os spans."""
        try:
            return request.session.get(_SESSION_ID_TOKEN)
        except Exception:
            return None

    # ─── Handlers das rotas ───────────────────────────────────────────────────

    async def _login(self, request: "Request") -> "Response":
        sessao = self._session_or_error(request)
        if sessao is None:
            return self._session_missing_response()

        verifier = _b64url_no_pad(secrets.token_bytes(32))
        challenge = _b64url_no_pad(hashlib.sha256(verifier.encode("ascii")).digest())
        state = secrets.token_urlsafe(24)

        sessao[_SESSION_STATE] = state
        sessao[_SESSION_VERIFIER] = verifier
        # Para onde voltar depois do login (default "/"). Só aceita caminho
        # relativo — nunca um host externo (open-redirect).
        destino = request.query_params.get("next", "/")
        sessao[_SESSION_NEXT] = destino if destino.startswith("/") else "/"

        params = {
            "response_type": "code",
            "client_id": self._cfg.client_id,
            "redirect_uri": self._cfg.redirect_uri,
            "scope": self._cfg.scopes,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        url = f"{self._cfg.domain}/oauth2/authorize?" + urllib.parse.urlencode(params)
        return RedirectResponse(url, status_code=302)

    async def _callback(self, request: "Request") -> "Response":
        sessao = self._session_or_error(request)
        if sessao is None:
            return self._session_missing_response()

        erro = request.query_params.get("error")
        if erro:
            desc = request.query_params.get("error_description", "")
            return JSONResponse(
                {"error": "cognito_error", "detail": f"{erro}: {desc}".strip(": ")}, status_code=400
            )

        code = request.query_params.get("code")
        state = request.query_params.get("state")
        esperado = sessao.pop(_SESSION_STATE, None)
        verifier = sessao.pop(_SESSION_VERIFIER, None)
        if not code or not state or state != esperado or not verifier:
            return JSONResponse(
                {"error": "invalid_state", "detail": "state/PKCE inválido ou expirado — refaça o login"},
                status_code=400,
            )

        tokens = self._exchange_code(code, verifier)
        if tokens is None:
            return JSONResponse(
                {"error": "token_exchange_failed", "detail": "não foi possível trocar o code por tokens"},
                status_code=502,
            )

        id_token = tokens.get("id_token")
        if not isinstance(id_token, str) or not id_token:
            return JSONResponse(
                {"error": "no_id_token", "detail": "resposta do Cognito sem id_token"}, status_code=502
            )

        claims = _decode_jwt_payload(id_token) or {}
        ctx: UserContext = claims_to_user_context(claims)

        sessao[_SESSION_ID_TOKEN] = id_token
        sessao[_SESSION_USER] = {
            "user_id": ctx.user_id,
            "department": ctx.department,
            "cost_center": ctx.cost_center,
        }

        destino = sessao.pop(_SESSION_NEXT, "/") or "/"
        return RedirectResponse(destino if destino.startswith("/") else "/", status_code=302)

    async def _logout(self, request: "Request") -> "Response":
        try:
            request.session.pop(_SESSION_ID_TOKEN, None)
            request.session.pop(_SESSION_USER, None)
        except Exception:
            pass

        # Logout no Cognito (encerra a sessão do Hosted UI também), voltando para
        # a URL configurada. Sem logout_redirect_uri, só limpa a sessão local.
        if self._cfg.logout_redirect_uri:
            params = {
                "client_id": self._cfg.client_id,
                "logout_uri": self._cfg.logout_redirect_uri,
            }
            url = f"{self._cfg.domain}/logout?" + urllib.parse.urlencode(params)
            return RedirectResponse(url, status_code=302)
        return RedirectResponse("/", status_code=302)

    # ─── URLs públicas (para quem não usa as rotas prontas) ───────────────────

    def authorize_url(self, *, state: str, code_challenge: str) -> str:
        """Monta a URL de autorização do Hosted UI. Exposto para apps que querem
        conduzir o fluxo por conta própria em vez de usar `install()`."""
        params = {
            "response_type": "code",
            "client_id": self._cfg.client_id,
            "redirect_uri": self._cfg.redirect_uri,
            "scope": self._cfg.scopes,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{self._cfg.domain}/oauth2/authorize?" + urllib.parse.urlencode(params)

    # ─── Internos ─────────────────────────────────────────────────────────────

    def _exchange_code(self, code: str, code_verifier: str) -> Optional[dict]:
        """Troca o authorization code por tokens no endpoint /oauth2/token.
        Server-to-server sobre TLS; o client_secret (se houver) vai no Basic auth.
        Retorna o dict de tokens ou None em qualquer falha (sem vazar detalhe)."""
        data = urllib.parse.urlencode(
            {
                "grant_type": "authorization_code",
                "client_id": self._cfg.client_id,
                "code": code,
                "redirect_uri": self._cfg.redirect_uri,
                "code_verifier": code_verifier,
            }
        ).encode("ascii")

        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        if self._cfg.client_secret:
            basic = base64.b64encode(
                f"{self._cfg.client_id}:{self._cfg.client_secret}".encode("utf-8")
            ).decode("ascii")
            headers["Authorization"] = f"Basic {basic}"

        req = urllib.request.Request(
            f"{self._cfg.domain}/oauth2/token", data=data, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=_TOKEN_TIMEOUT_S) as resp:
                corpo = resp.read().decode("utf-8", "replace")
            parsed = json.loads(corpo)
            return parsed if isinstance(parsed, dict) else None
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
            return None
        except Exception:
            return None

    @staticmethod
    def _session_or_error(request: "Request") -> Optional[dict]:
        try:
            _ = request.session
            return request.session
        except Exception:
            return None

    @staticmethod
    def _session_missing_response() -> "Response":
        return JSONResponse(
            {
                "error": "session_unavailable",
                "detail": "SessionMiddleware não montado — o login precisa da sessão para "
                "guardar state/PKCE e o id_token.",
            },
            status_code=500,
        )


__all__ = ["CognitoLogin", "CognitoLoginConfig"]
