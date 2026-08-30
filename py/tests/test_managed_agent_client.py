"""
Testes de ManagedAgentClient (paridade 1:1 com tests/managed-agent-client.test.ts).

AAA (Arrange/Act/Assert), sem mocks de rede reais — `fetch_impl` injetado.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Dict, List, Sequence

import pytest

from pump_evolution.managed_agent_client import (
    ManagedAgentClient,
    ManagedAgentInvokeError,
    build_agent_invoke_scope,
)
from pump_evolution.token_provider import FetchResponse

# ─── Fake fetch (mesma FetchLike do token_provider) ───────────────────────────


class _Call:
    def __init__(self, url: str, method: str, headers: Dict[str, str], body: str) -> None:
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body


def fake_fetch(responses: Sequence[Dict[str, Any]]):
    """fetch_impl falso que devolve as respostas na ordem dada. A 1ª chamada é o
    token (client-credentials); as seguintes são as invocações. `calls` registra
    tudo para asserção de headers/body/url."""
    calls: List[_Call] = []
    state = {"i": 0}

    async def _fetch_impl(url: str, method: str, headers: Dict[str, str], body: str) -> FetchResponse:
        calls.append(_Call(url, method, headers, body))
        r = responses[min(state["i"], len(responses) - 1)]
        state["i"] += 1
        return FetchResponse(ok=r.get("ok", True), status=r.get("status", 200), body=r["body"])

    return _fetch_impl, calls


TOKEN_OK: Dict[str, Any] = {"body": json.dumps({"access_token": "machine-tok", "expires_in": 3600})}

SA = {
    "client_id": "svc-agent",
    "client_secret": "s3cr3t",
    "token_url": "https://auth.example.com/oauth2/token",
}

BASE = {
    "endpoint": "https://cta.example.com/api/agents/agent-123/invoke",
    "agent_id": "agent-123",
    "service_account": SA,
}


class TestBuildAgentInvokeScope:
    def test_monta_o_scope_no_formato_do_receiver_do_cta(self) -> None:
        # Arrange / Act
        scope = build_agent_invoke_scope("agent-123")

        # Assert
        assert scope == "cta-consumers/invoke:agent:agent-123"

    def test_rejeita_agent_id_vazio(self) -> None:
        # Arrange / Act / Assert
        with pytest.raises(ValueError, match="non-empty agent_id"):
            build_agent_invoke_scope("  ")


class TestManagedAgentClientInvoke:
    @pytest.mark.asyncio
    async def test_autentica_com_client_credentials_e_invoca_o_agente(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch(
            [
                TOKEN_OK,
                {
                    "body": json.dumps(
                        {
                            "reply": "olá",
                            "sessionId": "sess-1",
                            "latencyMs": 1200,
                            "inputTokens": 10,
                            "outputTokens": 20,
                            "costUsd": 0.0003,
                            "correlationId": "corr-1",
                        }
                    )
                },
            ]
        )
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act
        result = await client.invoke(message="oi")

        # Assert
        assert result.reply == "olá"
        assert result.session_id == "sess-1"
        assert result.input_tokens == 10
        assert result.cost_usd == 0.0003
        assert result.raw.get("correlationId") == "corr-1"

        token_call, invoke_call = calls
        assert token_call.url == SA["token_url"]
        assert "scope=cta-consumers%2Finvoke%3Aagent%3Aagent-123" in token_call.body

        assert invoke_call.url == BASE["endpoint"]
        assert invoke_call.headers["Authorization"] == "Bearer machine-tok"
        assert invoke_call.headers["Content-Type"] == "application/json"
        assert json.loads(invoke_call.body) == {"message": "oi"}

    @pytest.mark.asyncio
    async def test_propaga_o_token_do_usuario_final_sem_prefixo_bearer(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act
        await client.invoke(message="oi", session_id="sess-9", user_token="Bearer user-jwt")

        # Assert
        invoke_call = calls[1]
        assert invoke_call.headers["x-cta-enduser-authorization"] == "user-jwt"
        assert json.loads(invoke_call.body) == {"message": "oi", "sessionId": "sess-9"}

    @pytest.mark.asyncio
    async def test_nao_seta_header_quando_nao_ha_user_token(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act
        await client.invoke(message="oi")

        # Assert
        assert "x-cta-enduser-authorization" not in calls[1].headers

    @pytest.mark.asyncio
    async def test_inclui_model_id_no_corpo_quando_fornecido(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act
        await client.invoke(message="oi", model_id="us.amazon.nova-pro-v1:0")

        # Assert
        assert json.loads(calls[1].body) == {
            "message": "oi",
            "modelId": "us.amazon.nova-pro-v1:0",
        }

    @pytest.mark.asyncio
    async def test_nao_inclui_model_id_quando_omitido_regressao(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act
        await client.invoke(message="oi", session_id="sess-9")

        # Assert
        body = json.loads(calls[1].body)
        assert body == {"message": "oi", "sessionId": "sess-9"}
        assert "modelId" not in body

    @pytest.mark.asyncio
    async def test_normaliza_model_id_da_resposta(self) -> None:
        # Arrange
        fetch_impl, _calls = fake_fetch(
            [TOKEN_OK, {"body": json.dumps({"reply": "ok", "modelId": "us.amazon.nova-pro-v1:0"})}]
        )
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act
        result = await client.invoke(message="oi", model_id="us.amazon.nova-pro-v1:0")

        # Assert
        assert result.model_id == "us.amazon.nova-pro-v1:0"

    @pytest.mark.asyncio
    async def test_lanca_managed_agent_invoke_error_com_status_e_corpo_em_resposta_nao_2xx(self) -> None:
        # Arrange
        fetch_impl, _calls = fake_fetch(
            [
                TOKEN_OK,
                {
                    "ok": False,
                    "status": 403,
                    "body": json.dumps({"error": "Access denied", "reason": "scope"}),
                },
            ]
        )
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act / Assert
        with pytest.raises(ManagedAgentInvokeError) as exc_info:
            await client.invoke(message="oi")
        assert exc_info.value.status == 403
        assert exc_info.value.body == {"error": "Access denied", "reason": "scope"}

    @pytest.mark.asyncio
    async def test_lanca_quando_corpo_de_sucesso_nao_tem_reply(self) -> None:
        # Arrange
        fetch_impl, _calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"sessionId": "x"})}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act / Assert
        with pytest.raises(ManagedAgentInvokeError):
            await client.invoke(message="oi")

    @pytest.mark.asyncio
    async def test_lanca_quando_resposta_nao_e_json(self) -> None:
        # Arrange
        fetch_impl, _calls = fake_fetch([TOKEN_OK, {"body": "<html>500</html>"}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act / Assert
        with pytest.raises(ManagedAgentInvokeError, match="non-JSON"):
            await client.invoke(message="oi")

    @pytest.mark.asyncio
    async def test_rejeita_message_vazia(self) -> None:
        # Arrange
        fetch_impl, _calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "x"})}])
        client = ManagedAgentClient(**BASE, fetch_impl=fetch_impl)

        # Act / Assert
        with pytest.raises(ValueError, match="non-empty `message`"):
            await client.invoke(message="   ")


class TestManagedAgentClientForAgent:
    @pytest.mark.asyncio
    async def test_deriva_endpoint_de_invoke_a_partir_da_base_e_agent_id(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])
        client = ManagedAgentClient.for_agent(
            base_url="https://cta.example.com/",
            agent_id="agent-xyz",
            service_account=SA,
            fetch_impl=fetch_impl,
        )

        # Act
        await client.invoke(message="oi")

        # Assert
        assert calls[1].url == "https://cta.example.com/api/agents/agent-xyz/invoke"
        assert "scope=cta-consumers%2Finvoke%3Aagent%3Aagent-xyz" in calls[0].body


class TestManagedAgentClientFromEnv:
    ENV = {
        "PUMP_MANAGED_AGENT_ENDPOINT": "https://cta.example.com/api/agents/agent-123/invoke",
        "PUMP_MANAGED_AGENT_ID": "agent-123",
        "PUMP_MANAGED_CLIENT_ID": "svc-agent",
        "PUMP_MANAGED_CLIENT_SECRET": "s3cr3t",
        "PUMP_MANAGED_TOKEN_URL": "https://auth.example.com/oauth2/token",
    }

    def test_falha_explicita_quando_falta_variavel_obrigatoria(self) -> None:
        # Arrange / Act / Assert — Python valida service_account (client_id/secret/token_url)
        # antes de endpoint/agent_id (ordem de construção do dict), diferente do TS, mas
        # ambos são fail-closed: falta qualquer uma delas → ValueError explícito.
        with pytest.raises(ValueError, match="missing env `PUMP_MANAGED_CLIENT_ID`"):
            ManagedAgentClient.from_env({"PUMP_MANAGED_AGENT_ID": "x"})

    def test_aceita_o_cliente_completo_via_from_env_sem_invocar(self) -> None:
        # Arrange / Act / Assert (não deve lançar)
        ManagedAgentClient.from_env(self.ENV)


class TestManagedAgentClientFromManifest:
    base_manifest = {
        "name": "weather-agent",
        "kind": "agent",
        "modelId": "anthropic.claude-sonnet-4",
        "allowedTools": [],
    }

    managed = {
        "endpoint": "https://cta.example.com/api/agents/agent-123/invoke",
        "agentId": "agent-123",
        "tokenUrl": "https://auth.example.com/oauth2/token",
    }

    @pytest.mark.asyncio
    async def test_le_runtime_managed_e_mescla_credencial_do_env(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])

        # Act
        client = ManagedAgentClient.from_manifest(
            {**self.base_manifest, "runtime": {"managed": self.managed}},
            client_id="svc-agent",
            client_secret="s3cr3t",
            fetch_impl=fetch_impl,
        )
        await client.invoke(message="hi")

        # Assert
        assert calls[0].url == self.managed["tokenUrl"]
        assert calls[1].url == self.managed["endpoint"]

    @pytest.mark.asyncio
    async def test_le_credencial_do_env_pump_managed_quando_nao_passada_explicitamente(self) -> None:
        # Arrange
        fetch_impl, calls = fake_fetch([TOKEN_OK, {"body": json.dumps({"reply": "ok"})}])

        # Act
        client = ManagedAgentClient.from_manifest(
            {**self.base_manifest, "runtime": {"managed": self.managed}},
            env={"PUMP_MANAGED_CLIENT_ID": "svc-env", "PUMP_MANAGED_CLIENT_SECRET": "sek-env"},
            fetch_impl=fetch_impl,
        )
        await client.invoke(message="hi")

        # Assert — Cognito client-credentials manda a credencial no Basic auth.
        auth = calls[0].headers.get("Authorization", "")
        assert auth.startswith("Basic ")
        decoded = base64.b64decode(auth[len("Basic ") :]).decode("utf-8")
        assert decoded == "svc-env:sek-env"

    def test_lanca_quando_manifesto_nao_tem_runtime_managed(self) -> None:
        # Arrange / Act / Assert
        with pytest.raises(ValueError, match=r"sem `runtime\.managed`"):
            ManagedAgentClient.from_manifest(self.base_manifest, env={})
