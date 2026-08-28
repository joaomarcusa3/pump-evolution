"""CognitoLogin (Python) — paridade com tests/cognito-login.test.ts.

O contrato nao e inventado: e o que o `cta_factory_provisionar_cognito` grava.
Ele emite `runtime.cognito` no manifesto (domain, issuer, clientId, redirectUri,
scopes, identityProviders, identityProvider, logoutRedirectUri) e o bloco
`COGNITO_*` equivalente para o `.env`. Os testes de `from_manifest`/`from_env`
fixam os dois formatos -- se a plataforma mudar um campo, e aqui que aparece.

O `identity_provider` singular merece atencao: a plataforma so o emite quando o
pool tem EXATAMENTE UM IdP federado. Com dois ou mais ele e omitido de proposito,
porque adivinhar mandaria o usuario para o SSO errado.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, Dict, Optional

import pytest

from pump_evolution.integrations.cognito import CognitoLogin, CognitoLoginConfig, safe_next_path
from pump_evolution.manifest_loader import load_manifest

DOMAIN = "https://topaz-cta-dev.auth.us-east-1.amazoncognito.com"
ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_5ppMHdWW7"
CLIENT_ID = "5o9kpobp3c7kudnvm4onvjpgr0"
REDIRECT = "https://claude.ai/api/mcp/auth_callback"


class LoggerFalso:
    def __init__(self) -> None:
        self.avisos: list = []

    def warn(self, mensagem: str, meta: Any = None) -> None:
        self.avisos.append((mensagem, meta))

    def texto(self) -> str:
        return " ".join(f"{m} {d}" for m, d in self.avisos)


def config(**extra: Any) -> CognitoLoginConfig:
    base: Dict[str, Any] = {
        "domain": DOMAIN,
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT,
        "issuer": ISSUER,
    }
    base.update(extra)
    return CognitoLoginConfig(**base)


def id_token(claims: Dict[str, Any]) -> str:
    def parte(obj: Any) -> str:
        bruto = json.dumps(obj).encode("utf-8")
        return base64.urlsafe_b64encode(bruto).decode("ascii").rstrip("=")

    return f"{parte({'alg': 'RS256'})}.{parte(claims)}.assinatura"


def claims_validos(**extra: Any) -> Dict[str, Any]:
    base = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "exp": int(time.time()) + 3600,
        "email": "diego.resta@topazevolution.com",
        "custom:department": "engineering",
    }
    base.update(extra)
    return base


COGNITO_COMPLETO = {
    "domain": DOMAIN,
    "issuer": ISSUER,
    "clientId": CLIENT_ID,
    "redirectUri": REDIRECT,
    "scopes": "openid email profile",
}


def manifesto(cognito: Optional[Dict[str, Any]] = None) -> Any:
    corpo: Dict[str, Any] = {"name": "tpz-cel926-cmdb-jira-assets", "kind": "mcp", "allowedTools": []}
    if cognito is not None:
        corpo["runtime"] = {"cognito": cognito}
    return load_manifest(corpo)


# ─── Config ───────────────────────────────────────────────────────────────────


def test_lanca_nomeando_os_campos_que_faltam() -> None:
    with pytest.raises(ValueError, match="domain, client_id, redirect_uri"):
        CognitoLoginConfig(domain="", client_id="", redirect_uri="")


def test_from_env_le_o_bloco_que_a_factory_imprime() -> None:
    login = CognitoLogin.from_env(
        {
            "COGNITO_DOMAIN": DOMAIN,
            "COGNITO_ISSUER": ISSUER,
            "COGNITO_CLIENT_ID": CLIENT_ID,
            "COGNITO_REDIRECT_URI": REDIRECT,
            "COGNITO_SCOPES": "openid email profile",
            "COGNITO_IDENTITY_PROVIDER": "Microsoft",
        }
    )
    assert login.issuer == ISSUER
    assert "identity_provider=Microsoft" in login.authorize_url(state="s", code_challenge="c")


# ─── from_manifest — o caminho preferido ──────────────────────────────────────


def test_from_manifest_le_runtime_cognito_como_a_plataforma_grava() -> None:
    login = CognitoLogin.from_manifest(
        manifesto(
            {
                **COGNITO_COMPLETO,
                "identityProviders": ["Microsoft"],
                "identityProvider": "Microsoft",
                "logoutRedirectUri": "https://app.exemplo/logout",
            }
        ),
        env={},
    )
    url = login.authorize_url(state="st", code_challenge="ch")
    assert f"client_id={CLIENT_ID}" in url
    assert "identity_provider=Microsoft" in url
    assert login.issuer == ISSUER
    assert "logout_uri=" in (login.logout_url() or "")


def test_omite_identity_provider_com_mais_de_um_idp() -> None:
    # A plataforma NAO emite o campo singular nesse caso -- adivinhar mandaria o
    # usuario para o SSO errado. Sem ele, cai na tela de escolha do Hosted UI.
    login = CognitoLogin.from_manifest(
        manifesto({**COGNITO_COMPLETO, "identityProviders": ["Microsoft", "Google"]}), env={}
    )
    assert "identity_provider" not in login.authorize_url(state="s", code_challenge="c")


def test_secret_vem_do_ambiente_manifesto_e_git_safe() -> None:
    login = CognitoLogin.from_manifest(
        manifesto(COGNITO_COMPLETO), env={"COGNITO_CLIENT_SECRET": "segredo"}
    )
    assert isinstance(login, CognitoLogin)


def test_from_manifest_sem_bloco_aponta_o_passo_que_falta() -> None:
    with pytest.raises(ValueError, match="provisionar_cognito"):
        CognitoLogin.from_manifest(manifesto(), env={})


# ─── Manifesto: validacao do bloco ────────────────────────────────────────────


@pytest.mark.parametrize("campo", ["domain", "issuer", "clientId", "redirectUri", "scopes"])
def test_manifesto_falha_nomeando_o_campo_ausente(campo: str) -> None:
    parcial = dict(COGNITO_COMPLETO)
    del parcial[campo]
    with pytest.raises(ValueError, match=f"runtime.cognito.{campo}"):
        manifesto(parcial)


def test_manifesto_omite_opcionais_ausentes_em_vez_de_placeholder() -> None:
    m = manifesto(COGNITO_COMPLETO)
    assert m.runtime is not None and m.runtime.cognito is not None
    assert m.runtime.cognito.identity_provider is None
    assert m.runtime.cognito.identity_providers is None


# ─── PKCE ─────────────────────────────────────────────────────────────────────


def test_challenge_e_s256_do_verifier() -> None:
    login = CognitoLogin(config())
    par = login.create_pkce()
    esperado = (
        base64.urlsafe_b64encode(hashlib.sha256(par["verifier"].encode("ascii")).digest())
        .decode("ascii")
        .rstrip("=")
    )
    assert par["challenge"] == esperado


# ─── Redirect pos-login ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "entrada,esperado",
    [
        ("/pagina", "/pagina"),
        ("//evil.com", "/"),
        ("/\\evil.com", "/"),
        ("https://evil.com", "/"),
        ("", "/"),
        (None, "/"),
    ],
)
def test_safe_next_path(entrada: Any, esperado: str) -> None:
    assert safe_next_path(entrada) == esperado


# ─── id_token: iss, aud e exp ─────────────────────────────────────────────────


def test_mapeia_os_claims_de_custo() -> None:
    login = CognitoLogin(config())
    ctx = login.user_context_from_id_token(id_token(claims_validos()))
    assert ctx.user_id == "diego.resta@topazevolution.com"
    assert ctx.department == "engineering"
    assert ctx.token is not None


def test_recusa_token_expirado() -> None:
    logger = LoggerFalso()
    login = CognitoLogin(config(logger=logger))
    ctx = login.user_context_from_id_token(id_token(claims_validos(exp=int(time.time()) - 10)))
    assert ctx.user_id is None
    assert "expirado" in logger.texto()


def test_recusa_token_de_outro_pool() -> None:
    login = CognitoLogin(config())
    ctx = login.user_context_from_id_token(id_token(claims_validos(iss="https://outro")))
    assert ctx.user_id is None


def test_recusa_token_de_outro_app_client() -> None:
    login = CognitoLogin(config())
    ctx = login.user_context_from_id_token(id_token(claims_validos(aud="outro-client")))
    assert ctx.user_id is None


def test_token_malformado_devolve_contexto_vazio_sem_lancar() -> None:
    login = CognitoLogin(config())
    assert login.user_context_from_id_token("nao-e-jwt").user_id is None
    assert login.user_context_from_id_token(None).user_id is None


# ─── Troca de code ────────────────────────────────────────────────────────────


class RespostaFalsa:
    def __init__(self, corpo: str) -> None:
        self._corpo = corpo

    def read(self) -> bytes:
        return self._corpo.encode("utf-8")

    def __enter__(self) -> "RespostaFalsa":
        return self

    def __exit__(self, *_: Any) -> None:
        return None


def test_manda_basic_auth_no_client_confidencial() -> None:
    capturado: Dict[str, Any] = {}

    def falso_urlopen(req: Any, timeout: Any = None) -> Any:
        capturado["headers"] = dict(req.headers)
        return RespostaFalsa('{"id_token":"x"}')

    login = CognitoLogin(config(client_secret="segredo", urlopen_impl=falso_urlopen))
    login.exchange_code("code", "verifier")
    assert any(str(v).startswith("Basic ") for v in capturado["headers"].values())


def test_client_publico_nao_manda_basic_auth() -> None:
    capturado: Dict[str, Any] = {}

    def falso_urlopen(req: Any, timeout: Any = None) -> Any:
        capturado["headers"] = dict(req.headers)
        return RespostaFalsa("{}")

    login = CognitoLogin(config(urlopen_impl=falso_urlopen))
    login.exchange_code("code", "verifier")
    assert not any(str(v).startswith("Basic ") for v in capturado["headers"].values())


def test_falha_na_troca_devolve_motivo_e_chega_no_logger() -> None:
    logger = LoggerFalso()

    def falso_urlopen(req: Any, timeout: Any = None) -> Any:
        raise RuntimeError("HTTP Error 401: Unauthorized")

    login = CognitoLogin(config(logger=logger, urlopen_impl=falso_urlopen))
    r = login.exchange_code("code", "verifier")
    assert r["ok"] is False
    assert "401" in logger.texto()


def test_handle_callback_sem_id_token_falha_com_motivo() -> None:
    login = CognitoLogin(
        config(urlopen_impl=lambda req, timeout=None: RespostaFalsa('{"access_token":"x"}'))
    )
    r = login.handle_callback(code="c", code_verifier="v")
    assert r["ok"] is False
    assert "id_token" in r["reason"]


# ─── Resolvers do PumpIdentityMiddleware ──────────────────────────────────────


class RequestFalso:
    def __init__(self, session: Optional[Dict[str, Any]] = None) -> None:
        self.session = session if session is not None else {}


def test_resolvers_leem_a_sessao() -> None:
    login = CognitoLogin(config())
    req = RequestFalso({"pump_id_token": id_token(claims_validos())})
    assert login.id_token_resolver(req) is not None
    usuario = login.user_resolver(req)
    assert usuario is not None and usuario["email"] == "diego.resta@topazevolution.com"
    assert usuario["department"] == "engineering"


def test_user_resolver_sem_token_devolve_none() -> None:
    login = CognitoLogin(config())
    assert login.user_resolver(RequestFalso()) is None


# ─── install() contra Starlette REAL — nao um duplo ───────────────────────────
#
# O `install()` monta rotas num framework de terceiro. Duplo de app so confirmaria
# o formato que eu imaginei -- foi assim que o `instrument_mcp_server` passou meses
# sem instrumentar o servidor de baixo nivel, com a suite verde. Aqui o fluxo roda
# de verdade: cliente HTTP -> Starlette -> as rotas.

starlette = pytest.importorskip("starlette", reason="starlette necessario para testar install()")
pytest.importorskip("itsdangerous", reason="SessionMiddleware do starlette exige itsdangerous")

from starlette.applications import Starlette  # noqa: E402
from starlette.middleware.sessions import SessionMiddleware  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402


def app_com_login(**extra: Any) -> Any:
    app = Starlette()
    app.add_middleware(SessionMiddleware, secret_key="teste")
    CognitoLogin(config(**extra)).install(app)
    return TestClient(app)


def test_install_login_vai_pro_hosted_ui_com_o_sso() -> None:
    r = app_com_login(identity_provider="Microsoft").get(
        "/auth/login", follow_redirects=False
    )
    assert r.status_code == 302
    destino = r.headers["location"]
    assert "/oauth2/authorize?" in destino
    assert "identity_provider=Microsoft" in destino


def test_install_callback_com_state_errado_nao_vaza_o_next() -> None:
    # O `next=//evil.com` entra no login e NAO pode voltar como destino: seria
    # open redirect num usuario que acabou de passar pelo SSO.
    cliente = app_com_login()
    cliente.get("/auth/login?next=//evil.com", follow_redirects=False)
    r = cliente.get("/auth/callback?code=c&state=errado", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/"


def test_install_logout_sem_logout_uri_volta_pra_raiz() -> None:
    r = app_com_login().get("/auth/logout", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/"


def test_install_logout_com_logout_uri_encerra_no_cognito() -> None:
    r = app_com_login(logout_redirect_uri="https://app.exemplo/bye").get(
        "/auth/logout", follow_redirects=False
    )
    assert "/logout?" in r.headers["location"]
