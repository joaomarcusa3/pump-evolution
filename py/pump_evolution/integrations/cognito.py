"""cognito — login OAuth2 (Authorization Code + PKCE) do usuário final contra o
pool Cognito da plataforma. Paridade 1:1 com `src/cognito-login.ts`.

## Por que existe

A orientação antiga era "não mexa no Cognito do agente — o SDK só lê o `id_token`
que ele já tem". Só que quase nenhum pool de cliente carregava os claims de custo
(`custom:department`, `custom:cost_center`), então o span saía com o usuário certo
e SEM departamento — perdendo a atribuição de custo, que é a razão de a governança
existir.

A solução: o pool de usuário final vive na plataforma, com os claims de custo
governados por nós, e cada componente ganha seu App Client. O client é
provisionado no install pela Factory (`cta_factory_provisionar_cognito`), que
grava `runtime.cognito` no manifesto e devolve as variáveis `COGNITO_*`. Este
módulo é o consumidor desse contrato — ele nunca provisiona nada.

## Duas identidades que nunca se cruzam

Este é o login das PESSOAS que usam o componente. O service account de telemetria
(`PumpEvolution.init`, `client_credentials`) autentica o PROCESSO. Um token de
`client_credentials` não tem usuário e portanto não tem departamento — que é
exatamente por que esta segunda identidade precisou existir.

## Uso

Do manifesto, que é onde a Factory grava tudo (preferido — nada copiado à mão, e
o bloco é git-safe):

    from pump_evolution.integrations.cognito import CognitoLogin
    from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

    login = CognitoLogin.from_manifest("./manifest.yaml")
    login.install(app)                # /auth/login, /auth/callback, /auth/logout
    app.add_middleware(
        PumpIdentityMiddleware,
        user_resolver=login.user_resolver,
        id_token_resolver=login.id_token_resolver,
    )

Ou do ambiente, com `CognitoLogin.from_env()`. Requer `SessionMiddleware` montado
— é a sessão que guarda `state`, o verifier do PKCE e o `id_token`.

## Segurança

- PKCE (S256) sempre, mais `state` — protege contra interceptação de código e CSRF.
- `client_secret` só no Basic auth da troca de token (server-to-server, TLS). O
  client público (default da plataforma) não tem secret.
- O `id_token` é decodificado SEM verificar assinatura, que é a permissão padrão
  para token obtido direto do token endpoint sobre TLS (OIDC Core 3.1.3.7). `iss`,
  `aud` e `exp` SÃO conferidos — são baratos e pegam sessão velha, coisa que a
  assinatura não pegaria. Para verificar token que CHEGA de um chamador, use o
  `ConsumerTokenVerifier` (RS256 + JWKS).
- Redirect pós-login restrito a caminho same-site. `//evil.com` e `/\\evil.com`
  são rejeitados, não só `https://evil.com` — URL protocol-relative começa com
  `/` e passaria numa checagem ingênua.

Erro de CONFIG lança no boot. Falha em runtime devolve motivo E reporta no logger
— login é crítico, não degrada em silêncio como telemetria.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Sequence
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..identity_context import claims_to_user_context
from ..manifest_loader import load_manifest
from ..types import UserContext

# Chaves de sessão — mesmas do TypeScript, com o prefixo do SDK para não colidir
# com o que o app do dono já guarda.
_SESSION_STATE = "pump_cognito_state"
_SESSION_VERIFIER = "pump_cognito_verifier"
_SESSION_NEXT = "pump_cognito_next"
_SESSION_ID_TOKEN = "pump_id_token"

_DEFAULT_SCOPES = "openid email profile"
_TOKEN_TIMEOUT_S = 10


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _nao_vazio(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def safe_next_path(value: Any) -> str:
    """Destino pós-login, restrito a caminho same-site.

    `startswith("/")` sozinho NÃO basta: `//evil.com` e `/\\evil.com` passam, e o
    browser lê os dois como URL protocol-relative — open redirect num usuário JÁ
    AUTENTICADO, que é o pior momento para um.
    """
    if not isinstance(value, str) or value == "":
        return "/"
    if not value.startswith("/"):
        return "/"
    if value.startswith("//") or value.startswith("/\\"):
        return "/"
    return value


@dataclass(frozen=True)
class CognitoLoginConfig:
    """Configuração do login. Os três primeiros campos são obrigatórios — sem
    eles o login apontaria para o lugar errado sem erro."""

    domain: str
    client_id: str
    redirect_uri: str
    #: Emissor do token. Quando presente, o claim `iss` do `id_token` é conferido
    #: contra ele — token de outro pool é recusado em vez de virar identidade.
    issuer: Optional[str] = None
    client_secret: Optional[str] = None
    scopes: str = _DEFAULT_SCOPES
    logout_redirect_uri: Optional[str] = None
    #: Provedor federado a mandar no `/oauth2/authorize`, para cair direto no SSO.
    #: A plataforma só o emite com EXATAMENTE UM federado no pool; com dois ou
    #: mais ele é omitido de propósito, porque adivinhar mandaria a pessoa para o
    #: SSO errado. A ausência é informação.
    identity_provider: Optional[str] = None
    #: Para onde as falhas de login são reportadas. Sem ele, um 401 na troca de
    #: token vira um redirect indistinguível de sucesso.
    logger: Any = None
    #: Relógio injetável, para testar a checagem de `exp`.
    now: Optional[Callable[[], float]] = None
    #: HTTP injetável (assinatura de `urllib.request.urlopen`), para testes.
    urlopen_impl: Optional[Callable[..., Any]] = None

    def __post_init__(self) -> None:
        faltando = [
            nome
            for nome in ("domain", "client_id", "redirect_uri")
            if not _nao_vazio(getattr(self, nome))
        ]
        if faltando:
            raise ValueError(
                "[pump-evolution] CognitoLogin: config incompleto ("
                + ", ".join(faltando)
                + "). Esses valores saem do provisionamento do App Client (Factory API) e "
                "chegam em `runtime.cognito` do manifesto ou no `.env` do app. Sem fallback."
            )


class CognitoLogin:
    """Login de usuário final. Consome o que a Factory provisiona; não provisiona."""

    def __init__(self, config: CognitoLoginConfig) -> None:
        self._cfg = config
        self._domain = config.domain.rstrip("/")
        self._now = config.now or time.time
        self._urlopen = config.urlopen_impl or urlopen

    # ─── Construtores ────────────────────────────────────────────────────────

    @classmethod
    def from_manifest(
        cls,
        manifest: Any,
        env: Optional[Dict[str, Optional[str]]] = None,
        **overrides: Any,
    ) -> "CognitoLogin":
        """Monta a partir de `runtime.cognito` do manifesto — o bloco que a
        Factory grava ao provisionar o App Client. Preferido ao `from_env`: nada
        é copiado à mão e o bloco é git-safe (a plataforma nunca escreve secret
        lá; um client confidencial segue lendo `COGNITO_CLIENT_SECRET` do
        ambiente).
        """
        import os

        carregado = load_manifest(manifest) if isinstance(manifest, str) else manifest
        runtime = getattr(carregado, "runtime", None)
        cognito = getattr(runtime, "cognito", None) if runtime is not None else None
        if cognito is None:
            raise ValueError(
                "[pump-evolution] CognitoLogin.from_manifest: o manifesto não tem "
                "`runtime.cognito`. Provisione o App Client de login primeiro (Factory: "
                "`cta_factory_provisionar_cognito`), que é quem grava esse bloco. Sem fallback."
            )
        ambiente = os.environ if env is None else env
        segredo = ambiente.get("COGNITO_CLIENT_SECRET")
        return cls(
            CognitoLoginConfig(
                domain=getattr(cognito, "domain", "") or "",
                client_id=getattr(cognito, "client_id", "") or "",
                redirect_uri=getattr(cognito, "redirect_uri", "") or "",
                issuer=getattr(cognito, "issuer", None),
                scopes=getattr(cognito, "scopes", None) or _DEFAULT_SCOPES,
                identity_provider=getattr(cognito, "identity_provider", None),
                logout_redirect_uri=getattr(cognito, "logout_redirect_uri", None),
                # O manifesto nunca carrega o secret -- um client confidencial le
                # do ambiente, igual ao service account de telemetria.
                client_secret=segredo if _nao_vazio(segredo) else None,
                **overrides,
            )
        )

    @classmethod
    def from_env(
        cls, env: Optional[Dict[str, Optional[str]]] = None, **overrides: Any
    ) -> "CognitoLogin":
        """Monta a partir do bloco `COGNITO_*` que a Factory imprime. Obrigatórias:
        `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, `COGNITO_REDIRECT_URI`."""
        import os

        src = os.environ if env is None else env

        def opcional(chave: str) -> Optional[str]:
            valor = src.get(chave)
            return valor if _nao_vazio(valor) else None

        return cls(
            CognitoLoginConfig(
                domain=src.get("COGNITO_DOMAIN") or "",
                client_id=src.get("COGNITO_CLIENT_ID") or "",
                redirect_uri=src.get("COGNITO_REDIRECT_URI") or "",
                issuer=opcional("COGNITO_ISSUER"),
                client_secret=opcional("COGNITO_CLIENT_SECRET"),
                scopes=opcional("COGNITO_SCOPES") or _DEFAULT_SCOPES,
                identity_provider=opcional("COGNITO_IDENTITY_PROVIDER"),
                logout_redirect_uri=opcional("COGNITO_LOGOUT_REDIRECT_URI"),
                **overrides,
            )
        )

    @property
    def issuer(self) -> Optional[str]:
        """Emissor do token, quando configurado. Útil para ligar um
        `ConsumerTokenVerifier`."""
        return self._cfg.issuer

    # ─── Primitivas ──────────────────────────────────────────────────────────

    def create_pkce(self) -> Dict[str, str]:
        """Par PKCE: verifier fica na sessão, challenge vai na URL de autorização."""
        verifier = _b64url_no_pad(secrets.token_bytes(32))
        challenge = _b64url_no_pad(hashlib.sha256(verifier.encode("ascii")).digest())
        return {"verifier": verifier, "challenge": challenge}

    def create_state(self) -> str:
        """`state` opaco para proteção CSRF no callback."""
        return _b64url_no_pad(secrets.token_bytes(24))

    def authorize_url(self, *, state: str, code_challenge: str) -> str:
        """URL de autorização do Hosted UI. Com `identity_provider` conhecido, o
        usuário cai direto no SSO e pula a tela de usuário/senha."""
        params = {
            "response_type": "code",
            "client_id": self._cfg.client_id,
            "redirect_uri": self._cfg.redirect_uri,
            "scope": self._cfg.scopes,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if self._cfg.identity_provider:
            params["identity_provider"] = self._cfg.identity_provider
        return f"{self._domain}/oauth2/authorize?{urlencode(params)}"

    def logout_url(self) -> Optional[str]:
        """URL de logout do Cognito, ou `None` sem `logout_redirect_uri`.

        Sem ela não há logout no Cognito: limpar a sessão local deixa a do
        Cognito viva, e o próximo `/auth/login` reautentica sem pedir nada — o
        usuário jura que deslogou. As rotas avisam pelo logger nesse caso.
        """
        if not self._cfg.logout_redirect_uri:
            return None
        params = {"client_id": self._cfg.client_id, "logout_uri": self._cfg.logout_redirect_uri}
        return f"{self._domain}/logout?{urlencode(params)}"

    def exchange_code(self, code: str, code_verifier: str) -> Dict[str, Any]:
        """Troca o code por tokens em `/oauth2/token`. Devolve
        `{"ok": True, "tokens": {...}}` ou `{"ok": False, "reason": "..."}` — e
        reporta o motivo, porque um 401 engolido parece falha de rede."""
        corpo = urlencode(
            {
                "grant_type": "authorization_code",
                "client_id": self._cfg.client_id,
                "code": code,
                "redirect_uri": self._cfg.redirect_uri,
                "code_verifier": code_verifier,
            }
        ).encode("utf-8")
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        if self._cfg.client_secret:
            par = f"{self._cfg.client_id}:{self._cfg.client_secret}".encode("utf-8")
            headers["Authorization"] = "Basic " + base64.b64encode(par).decode("ascii")

        req = Request(  # noqa: S310 — URL vem da config do dono
            f"{self._domain}/oauth2/token", data=corpo, headers=headers, method="POST"
        )
        try:
            with self._urlopen(req, timeout=_TOKEN_TIMEOUT_S) as resp:
                bruto = resp.read().decode("utf-8")
            dados = json.loads(bruto)
            if not isinstance(dados, dict):
                motivo = "token endpoint devolveu payload que não é objeto"
                self._reportar(motivo)
                return {"ok": False, "reason": motivo}
            return {"ok": True, "tokens": dados}
        except Exception as erro:  # noqa: BLE001 — o motivo real vai pro logger
            # O corpo do erro traz `error`/`error_description` do Cognito, que é
            # o que distingue secret errado de redirect_uri divergente. O secret
            # nunca está aí — ele viaja no header.
            detalhe = getattr(erro, "read", None)
            corpo_erro = ""
            if callable(detalhe):
                try:
                    corpo_erro = detalhe().decode("utf-8")[:300]
                except Exception:  # noqa: BLE001
                    corpo_erro = ""
            motivo = str(erro)
            self._reportar("falha na troca de token", {"erro": motivo, "detalhe": corpo_erro})
            return {"ok": False, "reason": motivo}

    def user_context_from_id_token(self, id_token: Optional[str]) -> UserContext:
        """Decodifica o `id_token` (sem conferir assinatura — ver a nota de
        segurança no topo) e mapeia os claims. `iss`, `aud` e `exp` SÃO
        conferidos: token expirado numa sessão longa atribuiria spans a quem saiu
        horas atrás. Nunca lança — token inválido devolve contexto vazio, que o
        span registra como anônimo em vez de usuário fabricado."""
        if not _nao_vazio(id_token):
            return UserContext()
        claims = _decodificar_payload_jwt(id_token or "")
        if claims is None:
            self._reportar("id_token não pôde ser decodificado")
            return UserContext()
        problema = self._conferir_claims(claims)
        if problema is not None:
            self._reportar(f"id_token recusado: {problema}")
            return UserContext()
        ctx = claims_to_user_context(claims)
        return UserContext(
            user_id=ctx.user_id,
            department=ctx.department,
            cost_center=ctx.cost_center,
            token=id_token,
        )

    def handle_callback(self, *, code: str, code_verifier: str) -> Dict[str, Any]:
        """Trata o callback de forma neutra de framework — o chamador já conferiu
        o `state`."""
        trocado = self.exchange_code(code, code_verifier)
        if not trocado["ok"]:
            return {"ok": False, "reason": trocado["reason"]}
        id_token = trocado["tokens"].get("id_token")
        if not _nao_vazio(id_token):
            motivo = "resposta de token sem id_token"
            self._reportar(motivo)
            return {"ok": False, "reason": motivo}
        return {
            "ok": True,
            "id_token": id_token,
            "user": self.user_context_from_id_token(id_token),
            "tokens": trocado["tokens"],
        }

    # ─── Resolvers para o PumpIdentityMiddleware ─────────────────────────────

    def id_token_resolver(self, request: Any) -> Optional[str]:
        """Lê o `id_token` guardado na sessão. Assinatura esperada pelo
        `PumpIdentityMiddleware`."""
        sessao = _sessao(request)
        if sessao is None:
            return None
        valor = sessao.get(_SESSION_ID_TOKEN)
        return valor if _nao_vazio(valor) else None

    def user_resolver(self, request: Any) -> Optional[Dict[str, Any]]:
        """Resolve o usuário logado a partir da sessão, para o
        `PumpIdentityMiddleware` atribuir os spans da requisição."""
        ctx = self.user_context_from_id_token(self.id_token_resolver(request))
        if not ctx.user_id:
            return None
        dados: Dict[str, Any] = {"email": ctx.user_id}
        if ctx.department:
            dados["department"] = ctx.department
        if ctx.cost_center:
            dados["cost_center"] = ctx.cost_center
        return dados

    # ─── Rotas prontas (Starlette/FastAPI) ───────────────────────────────────

    def install(self, app: Any, *, prefix: str = "/auth") -> None:
        """Monta `/auth/login`, `/auth/callback` e `/auth/logout` no app.

        Requer `SessionMiddleware` — é a sessão que guarda `state`, o verifier do
        PKCE e o `id_token`. O import do Starlette é local: o SDK não exige
        framework web, e quem não usa este módulo não paga por ele.
        """
        try:
            from starlette.responses import RedirectResponse
        except ImportError as erro:  # pragma: no cover - depende do ambiente
            raise ImportError(
                "[pump-evolution] CognitoLogin.install requer starlette/fastapi instalado. "
                "Use as primitivas (create_pkce/authorize_url/handle_callback) com o seu "
                "framework, se preferir não instalar."
            ) from erro

        def login(request: Any) -> Any:
            sessao = _sessao(request)
            if sessao is None:
                return self._sem_sessao(RedirectResponse)
            pkce = self.create_pkce()
            estado = self.create_state()
            sessao[_SESSION_STATE] = estado
            sessao[_SESSION_VERIFIER] = pkce["verifier"]
            sessao[_SESSION_NEXT] = safe_next_path(request.query_params.get("next"))
            return RedirectResponse(
                self.authorize_url(state=estado, code_challenge=pkce["challenge"]), status_code=302
            )

        def callback(request: Any) -> Any:
            sessao = _sessao(request)
            if sessao is None:
                return self._sem_sessao(RedirectResponse)

            esperado = sessao.pop(_SESSION_STATE, None)
            verifier = sessao.pop(_SESSION_VERIFIER, None)
            destino = safe_next_path(sessao.pop(_SESSION_NEXT, "/"))

            erro = request.query_params.get("error")
            if erro:
                return self._falhou(RedirectResponse, destino, f"authorize devolveu error={erro}")
            code = request.query_params.get("code")
            estado = request.query_params.get("state")
            if not code or not estado or not esperado or not verifier:
                return self._falhou(RedirectResponse, destino, "callback sem code/state ou sessão")
            if not secrets.compare_digest(str(estado), str(esperado)):
                return self._falhou(RedirectResponse, destino, "state divergente (possível CSRF)")

            resultado = self.handle_callback(code=code, code_verifier=verifier)
            if not resultado["ok"]:
                return self._falhou(RedirectResponse, destino, resultado["reason"])
            sessao[_SESSION_ID_TOKEN] = resultado["id_token"]
            return RedirectResponse(destino, status_code=302)

        def logout(request: Any) -> Any:
            sessao = _sessao(request)
            if sessao is not None:
                for chave in (_SESSION_ID_TOKEN, _SESSION_STATE, _SESSION_VERIFIER, _SESSION_NEXT):
                    sessao.pop(chave, None)
            url = self.logout_url()
            if url is None:
                self._reportar(
                    "logout limpou só a sessão local: sem logout_redirect_uri a sessão do "
                    "Cognito continua viva e o próximo login não vai pedir nada"
                )
                return RedirectResponse("/", status_code=302)
            return RedirectResponse(url, status_code=302)

        app.add_route(f"{prefix}/login", login, methods=["GET"])
        app.add_route(f"{prefix}/callback", callback, methods=["GET"])
        app.add_route(f"{prefix}/logout", logout, methods=["GET"])

    # ─── Interno ─────────────────────────────────────────────────────────────

    def _conferir_claims(self, claims: Dict[str, Any]) -> Optional[str]:
        """Confere o que dá sem a assinatura. Devolve o problema, ou `None`."""
        if self._cfg.issuer is not None and claims.get("iss") != self._cfg.issuer:
            return "iss não bate com o issuer configurado"
        aud = claims.get("aud")
        if aud is not None:
            bate = (
                aud == self._cfg.client_id
                if isinstance(aud, str)
                else isinstance(aud, Sequence) and self._cfg.client_id in aud
            )
            if not bate:
                return "aud não bate com o App Client"
        exp = claims.get("exp")
        if isinstance(exp, (int, float)) and exp <= self._now():
            return "expirado"
        return None

    def _reportar(self, mensagem: str, meta: Optional[Dict[str, Any]] = None) -> None:
        """Reporta problema de login. Silencioso só quando não há logger."""
        try:
            avisar = getattr(self._cfg.logger, "warn", None)
            if callable(avisar):
                avisar(f"[pump-evolution] CognitoLogin: {mensagem}", meta)
        except Exception:  # noqa: BLE001 — logger quebrado não quebra o login
            pass

    def _falhou(self, redirect: Any, destino: str, motivo: str) -> Any:
        self._reportar(f"login falhou: {motivo}")
        return redirect(destino, status_code=302)

    def _sem_sessao(self, redirect: Any) -> Any:
        self._reportar("sem sessão na request: SessionMiddleware é obrigatório")
        return redirect("/", status_code=302)


def _sessao(request: Any) -> Optional[Dict[str, Any]]:
    sessao = getattr(request, "session", None)
    return sessao if isinstance(sessao, dict) else None


def _decodificar_payload_jwt(token: str) -> Optional[Dict[str, Any]]:
    partes = token.split(".")
    if len(partes) != 3 or not partes[1]:
        return None
    try:
        segmento = partes[1]
        segmento += "=" * (-len(segmento) % 4)
        dados = json.loads(base64.urlsafe_b64decode(segmento).decode("utf-8"))
        return dados if isinstance(dados, dict) else None
    except Exception:  # noqa: BLE001
        return None
