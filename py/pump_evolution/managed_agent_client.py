"""
managed_agent_client — cliente para **invocar um agente hospedado no runtime
AgentCore gerenciado da plataforma** ("hospedagem opcional"). Paridade 1:1 com
`src/managed-agent-client.ts`.

Diferente do resto do SDK, esta é uma capacidade **ativa** (não observacional): o
agente do desenvolvedor deixa de rodar um runtime próprio e passa a **chamar** o
runtime de PRD da plataforma (na conta de tooling) por HTTPS + OAuth. O "cérebro"
(prompt + tools) é da plataforma; o dev manda mensagem e recebe resposta, e pode
OPCIONALMENTE escolher dinamicamente, por invocação, qual modelo do catálogo do
tenant (``model_id``) deve processá-la — nunca um modelo próprio do agente
externo. Sem esse override, a plataforma usa o ``modelId`` fixo configurado para
o agente. Funciona de **qualquer conta AWS, region ou cloud** — não requer
credencial AWS no lado do dev, só o par client-credentials do Cognito.

Autenticação: token de **máquina** (service account, client-credentials) com o scope
de invoke `cta-consumers/invoke:agent:<agent_id>` — reusa o mesmo
:class:`ServiceAccountTokenProvider` da telemetria, apenas com outro scope. A
identidade do **usuário final** é propagada opcionalmente pelo header
`x-cta-enduser-authorization` (JWT bruto do Cognito do usuário). A plataforma
**verifica** esse token via JWKS do user pool antes de confiar — o SDK só o
encaminha; ele nunca substitui a identidade de máquina que autorizou a chamada.

IMPORTANTE — semântica de erro: ao contrário da telemetria (que degrada em silêncio
e NUNCA derruba o processo), a invocação é a chamada real do agente do dev. Uma
falha aqui é um erro de negócio que o chamador PRECISA tratar — então ``invoke``
**lança** :class:`ManagedAgentInvokeError` em falha (HTTP não-2xx, rede, corpo
inválido). Não há fallback silencioso.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

from .token_provider import FetchLike, ServiceAccountTokenProvider, _default_fetch

_BEARER_RE = re.compile(r"^Bearer\s+", re.IGNORECASE)

# ─── Scope helper ─────────────────────────────────────────────────────────────


def build_agent_invoke_scope(agent_id: str) -> str:
    """Monta o scope de invoke que o receiver do CTA exige para um agente
    (``cta-consumers/invoke:agent:<agent_id>``)."""
    trimmed = agent_id.strip()
    if len(trimmed) == 0:
        raise ValueError("[pump-evolution] build_agent_invoke_scope requires a non-empty agent_id.")
    return f"cta-consumers/invoke:agent:{trimmed}"


# ─── Erros / resultado ────────────────────────────────────────────────────────


class ManagedAgentInvokeError(Exception):
    """Erro de invocação do agente gerenciado. Carrega o ``status`` HTTP (quando
    houve resposta) e o ``body`` de erro do CTA (quando disponível)."""

    def __init__(self, message: str, *, status: Optional[int] = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


@dataclass(frozen=True)
class ManagedAgentResult:
    """Resultado normalizado da invocação. ``raw`` preserva o corpo completo."""

    reply: str
    raw: Dict[str, Any] = field(default_factory=dict)
    session_id: Optional[str] = None
    latency_ms: Optional[float] = None
    input_tokens: Optional[float] = None
    output_tokens: Optional[float] = None
    cost_usd: Optional[float] = None
    correlation_id: Optional[str] = None
    model_id: Optional[str] = None


# ─── Narrowing ────────────────────────────────────────────────────────────────


def _read_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _read_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


def _require_non_empty(value: str, field_name: str) -> str:
    if not isinstance(value, str) or len(value.strip()) == 0:
        raise ValueError(f"[pump-evolution] ManagedAgentClient requires a non-empty `{field_name}`.")
    return value


# ─── Cliente ──────────────────────────────────────────────────────────────────


class ManagedAgentClient:
    """Cliente de invocação de um agente hospedado no runtime gerenciado.

    Exemplo::

        agent = ManagedAgentClient.from_env()
        r = await agent.invoke(message="Analise...", user_token=req.headers["authorization"])
        print(r.reply)
    """

    def __init__(
        self,
        *,
        endpoint: str,
        agent_id: str,
        service_account: Mapping[str, str],
        fetch_impl: Optional[FetchLike] = None,
    ) -> None:
        self._endpoint = _require_non_empty(endpoint, "endpoint")
        agent_id = _require_non_empty(agent_id, "agent_id")
        scope = service_account.get("scope") or build_agent_invoke_scope(agent_id)
        self._token_provider = ServiceAccountTokenProvider(
            token_url=_require_non_empty(service_account.get("token_url", ""), "service_account.token_url"),
            client_id=_require_non_empty(service_account.get("client_id", ""), "service_account.client_id"),
            client_secret=_require_non_empty(
                service_account.get("client_secret", ""), "service_account.client_secret"
            ),
            scope=scope,
            fetch_impl=fetch_impl,
        )
        self._fetch_impl: FetchLike = fetch_impl if fetch_impl is not None else _default_fetch

    @classmethod
    def for_agent(
        cls,
        *,
        base_url: str,
        agent_id: str,
        service_account: Mapping[str, str],
        fetch_impl: Optional[FetchLike] = None,
    ) -> "ManagedAgentClient":
        """Monta o cliente a partir de uma base do CTA + agent_id, derivando o
        endpoint de invoke (``<base>/api/agents/<agent_id>/invoke``)."""
        base = _require_non_empty(base_url, "base_url").rstrip("/")
        agent_id = _require_non_empty(agent_id, "agent_id")
        from urllib.parse import quote

        return cls(
            endpoint=f"{base}/api/agents/{quote(agent_id, safe='')}/invoke",
            agent_id=agent_id,
            service_account=service_account,
            fetch_impl=fetch_impl,
        )

    @classmethod
    def from_env(
        cls,
        env: Optional[Mapping[str, str]] = None,
        *,
        fetch_impl: Optional[FetchLike] = None,
    ) -> "ManagedAgentClient":
        """Monta o cliente a partir de variáveis de ambiente:
        ``PUMP_MANAGED_AGENT_ENDPOINT``, ``PUMP_MANAGED_AGENT_ID``,
        ``PUMP_MANAGED_CLIENT_ID``, ``PUMP_MANAGED_CLIENT_SECRET``,
        ``PUMP_MANAGED_TOKEN_URL`` (e opcional ``PUMP_MANAGED_INVOKE_SCOPE``).
        Falha explícita se alguma obrigatória estiver ausente."""
        source: Mapping[str, str] = env if env is not None else os.environ

        def get(key: str) -> str:
            value = source.get(key)
            if not isinstance(value, str) or len(value.strip()) == 0:
                raise ValueError(f"[pump-evolution] ManagedAgentClient.from_env: missing env `{key}`.")
            return value

        scope = source.get("PUMP_MANAGED_INVOKE_SCOPE")
        service_account: Dict[str, str] = {
            "client_id": get("PUMP_MANAGED_CLIENT_ID"),
            "client_secret": get("PUMP_MANAGED_CLIENT_SECRET"),
            "token_url": get("PUMP_MANAGED_TOKEN_URL"),
        }
        if isinstance(scope, str) and len(scope.strip()) > 0:
            service_account["scope"] = scope
        return cls(
            endpoint=get("PUMP_MANAGED_AGENT_ENDPOINT"),
            agent_id=get("PUMP_MANAGED_AGENT_ID"),
            service_account=service_account,
            fetch_impl=fetch_impl,
        )

    @classmethod
    def from_manifest(
        cls,
        source: Any,
        *,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        fetch_impl: Optional[FetchLike] = None,
    ) -> "ManagedAgentClient":
        """Monta o cliente a partir do MANIFESTO (``runtime.managed``) — o bloco que
        o portal/MCP grava quando o agente externo opta pela hospedagem no runtime
        gerenciado. Caminho preferido: o dev não copia ``PUMP_MANAGED_*`` à mão.

        A credencial de invoke (``client_id`` + ``client_secret``) NUNCA vem do
        manifesto (git-safe): é provisionada show-once. Passe explicitamente ou
        deixe o SDK ler ``PUMP_MANAGED_CLIENT_ID`` / ``PUMP_MANAGED_CLIENT_SECRET``
        do ambiente. Lança se o manifesto não declarar ``runtime.managed``."""
        from .manifest_loader import load_manifest

        manifest = load_manifest(source)
        managed = manifest.runtime.managed if manifest.runtime else None
        if managed is None:
            raise ValueError(
                "[pump-evolution] ManagedAgentClient.from_manifest: manifesto sem "
                "`runtime.managed`. Esse bloco é gravado pelo portal/MCP quando o agente "
                "externo opta pelo runtime gerenciado — sem fallback. Use "
                "ManagedAgentClient.from_env() se a config vier só do ambiente."
            )
        source_env: Mapping[str, str] = env if env is not None else os.environ
        cid = client_id if client_id is not None else source_env.get("PUMP_MANAGED_CLIENT_ID", "")
        secret = (
            client_secret
            if client_secret is not None
            else source_env.get("PUMP_MANAGED_CLIENT_SECRET", "")
        )
        service_account: Dict[str, str] = {
            "client_id": cid or "",
            "client_secret": secret or "",
            "token_url": managed.token_url,
        }
        if managed.scope:
            service_account["scope"] = managed.scope
        return cls(
            endpoint=managed.endpoint,
            agent_id=managed.agent_id,
            service_account=service_account,
            fetch_impl=fetch_impl,
        )

    async def invoke(
        self,
        *,
        message: str,
        session_id: Optional[str] = None,
        user_token: Optional[str] = None,
        model_id: Optional[str] = None,
    ) -> ManagedAgentResult:
        """Invoca o agente gerenciado. Autentica com o token de máquina, propaga a
        identidade do usuário (quando fornecida) e retorna a resposta normalizada.
        **Lança** :class:`ManagedAgentInvokeError` em falha (não degrada em silêncio).

        ``model_id``: override de modelo para esta invocação — o agente externo
        escolhe dinamicamente entre os modelos habilitados no catálogo do tenant
        na conta Tooling (nunca um modelo próprio do agente externo). Opcional:
        quando omitido, a plataforma usa o ``modelId`` fixo configurado para o
        agente no registro. Um ``model_id`` fora do allowlist do tenant é
        rejeitado fail-closed pela plataforma (:class:`ManagedAgentInvokeError`),
        nunca cai de volta ao modelo padrão do agente silenciosamente."""
        message = _require_non_empty(message, "message")
        token = await self._token_provider.get_token()

        headers: Dict[str, str] = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        if isinstance(user_token, str) and len(user_token.strip()) > 0:
            # JWT bruto do usuário final. A plataforma VERIFICA via JWKS antes de
            # confiar (nunca eleva identidade a partir de header não verificado).
            headers["x-cta-enduser-authorization"] = _BEARER_RE.sub("", user_token)

        payload: Dict[str, Any] = {"message": message}
        if session_id is not None:
            payload["sessionId"] = session_id
        if model_id is not None:
            payload["modelId"] = model_id
        body = json.dumps(payload)

        try:
            response = await self._fetch_impl(self._endpoint, "POST", headers, body)
        except Exception as err:  # falha de rede → erro explícito (nunca silencia)
            raise ManagedAgentInvokeError(
                f"[pump-evolution] managed invoke request failed: {err}"
            ) from err

        text = response.text()
        if not response.ok:
            raise _error_from_response(response.status, text)

        return _to_result(_parse_success_body(text, response.status))


# ─── Helpers de resposta ──────────────────────────────────────────────────────


def _error_from_response(status: int, text: str) -> ManagedAgentInvokeError:
    try:
        parsed: Any = json.loads(text)
    except Exception:
        parsed = text
    return ManagedAgentInvokeError(
        f"[pump-evolution] managed invoke responded {status}.", status=status, body=parsed
    )


def _parse_success_body(text: str, status: int) -> Dict[str, Any]:
    try:
        parsed = json.loads(text)
    except Exception:
        raise ManagedAgentInvokeError(
            "[pump-evolution] managed invoke returned a non-JSON response.", status=status
        )
    if not isinstance(parsed, dict):
        raise ManagedAgentInvokeError(
            "[pump-evolution] managed invoke returned an unexpected payload.",
            status=status,
            body=parsed,
        )
    return parsed


def _to_result(parsed: Dict[str, Any]) -> ManagedAgentResult:
    reply = _read_string(parsed.get("reply"))
    if reply is None:
        raise ManagedAgentInvokeError(
            "[pump-evolution] managed invoke response missing `reply`.", body=parsed
        )
    return ManagedAgentResult(
        reply=reply,
        raw=parsed,
        session_id=_read_string(parsed.get("sessionId")),
        latency_ms=_read_number(parsed.get("latencyMs")),
        input_tokens=_read_number(parsed.get("inputTokens")),
        output_tokens=_read_number(parsed.get("outputTokens")),
        cost_usd=_read_number(parsed.get("costUsd")),
        correlation_id=_read_string(parsed.get("correlationId")),
        model_id=_read_string(parsed.get("modelId")),
    )
