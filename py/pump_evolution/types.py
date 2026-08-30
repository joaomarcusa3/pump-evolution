"""
Shared contract types for the `pump-evolution` SDK (paridade com `src/types.ts`).

Standalone de propósito: o SDK é instalado por desenvolvedores de agentes
externos e NÃO PODE depender de nenhum pacote interno `cta-*`. Onde um tipo
espelha um conceito do CTA (manifesto, usage event), ele é redefinido aqui como
um subconjunto fiel e mínimo, nunca importado.

Notas de mapeamento TS→Python:
  - `interface` readonly  → `@dataclass(frozen=True)`.
  - union de string literal → `typing.Literal`.
  - chaves camelCase do YAML (`modelId`, `otelEndpoint`, ...) são mapeadas para
    atributos snake_case pelo `manifest_loader` (mesmo manifest.yaml parseia).
  - `ResourceAttributes` (chaves com ponto, ex. `service.name`) é um `dict`
    construído por `manifest_to_resource_attributes`, não um dataclass.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Protocol, Sequence, TypeVar

# ─── Manifest (subset of the real AgentSpecProps) ────────────────────────────

# Níveis de classificação que o SDK entende. Espelha o `DataClassificationValue`
# do CTA (`restricted` é deliberadamente excluído — GenAI não processa dado
# restrito).
DataClassification = Literal["public", "internal", "sensitive"]

# Risk tiers que o SDK entende. Espelha os valores de `RiskTier` do CTA.
RiskTier = Literal["T1-low", "T2-medium", "T3-sensitive", "T4-autonomous"]

# Tipo do item descrito pelo manifesto:
#  - `agent` — agente com LLM (tem `modelId`). Default quando omitido.
#  - `mcp`   — servidor Model Context Protocol: provedor de tools governado, sem
#              modelo próprio. `modelId` não é exigido para este kind.
ItemKind = Literal["agent", "mcp"]


@dataclass(frozen=True)
class ManifestOwner:
    """Bloco owner do manifesto. `email` é o principal auditável; `team` e
    `cost_center` habilitam chargeback de FinOps."""

    email: str
    team: Optional[str] = None
    cost_center: Optional[str] = None  # YAML: costCenter


@dataclass(frozen=True)
class ManifestTelemetry:
    """Config de telemetria declarada no manifesto (ADR-0040,
    `ExternalRuntimeTelemetry`). Quando presentes, agem como defaults da config
    de runtime do SDK."""

    otel_endpoint: str  # YAML: otelEndpoint
    service_account_id: str  # YAML: serviceAccountId — client_id do service account Cognito


@dataclass(frozen=True)
class ManifestCognito:
    """Bloco de login de usuário final que a plataforma grava no manifesto ao
    provisionar o App Client (`cta_factory_provisionar_cognito`).

    É o login das PESSOAS que usam o componente — identidade distinta do
    `ManifestTelemetry`, que autentica o processo. As duas nunca se cruzam:
    telemetria é `client_credentials`, esta é `authorization_code` + PKCE.

    Git-safe por construção: a plataforma nunca escreve o secret aqui. Um client
    confidencial guarda o secret no cofre show-once do portal, e ele chega ao app
    pelo ambiente.
    """

    domain: str
    issuer: str
    client_id: str
    redirect_uri: str
    scopes: str
    identity_providers: Optional[Sequence[str]] = None
    #: Só sai quando o pool tem EXATAMENTE UM federado — com dois ou mais,
    #: adivinhar mandaria o usuário para o SSO errado. A ausência é informação.
    identity_provider: Optional[str] = None
    logout_redirect_uri: Optional[str] = None


@dataclass(frozen=True)
class ManifestRuntime:
    """Bloco external runtime (subconjunto do `ExternalRuntime` real). Só as
    partes que o SDK precisa: defaults de telemetria, login de usuário, runtime
    gerenciado e catálogo de modelos."""

    external: Optional[bool] = None
    telemetry: Optional[ManifestTelemetry] = None
    cognito: Optional["ManifestCognito"] = None
    #: Defaults de runtime gerenciado — fonte para `ManagedAgentClient.from_manifest`.
    managed: Optional["ManifestManagedRuntime"] = None
    #: Snapshot (escrito pelo portal) do catálogo Bedrock habilitado na conta.
    models: Optional[List["ManifestModel"]] = None


@dataclass(frozen=True)
class ManifestManagedRuntime:
    """Config de runtime gerenciado declarada no manifesto.

    Valores NÃO-SECRETOS que o portal/MCP produz quando um agente externo opta
    pela hospedagem no runtime AgentCore gerenciado da plataforma, gravados no
    manifesto para o SDK montar o `ManagedAgentClient` direto do manifesto —
    `ManagedAgentClient.from_manifest(manifest)` — em vez do dev copiar as
    variáveis `PUMP_MANAGED_*` à mão.

    SEGURANÇA: a credencial de invoke (`client_id` + `client_secret`) NUNCA é
    armazenada aqui — é provisionada show-once e vive no ambiente/secrets
    manager, mesclada em runtime. Só a fiação estável e git-safe fica no
    manifesto."""

    endpoint: str  # YAML: endpoint — invoke completo (<cta>/api/agents/<agentId>/invoke)
    agent_id: str  # YAML: agentId — id do agente no registro do CTA
    token_url: str  # YAML: tokenUrl — endpoint OAuth do Cognito da plataforma
    scope: Optional[str] = None  # YAML: scope — default cta-consumers/invoke:agent:<agentId>


@dataclass(frozen=True)
class ManifestModel:
    """Um modelo disponível para o agente, como snapshot que o portal/MCP grava
    no manifesto a partir do catálogo Bedrock ao vivo (`/api/discovery/models`)
    no install/update. Espelha a forma do catálogo (`modelId`, `name`,
    `provider`, `streaming`).

    IMPORTANTE: isso é um snapshot **escrito pelo portal** do que a conta/região
    tem habilitado — NÃO é uma lista estática mantida à mão. A checagem
    autoritativa de disponibilidade continua atrás da API da plataforma / runtime
    gerenciado; a lista do manifesto é o que o SDK expõe ao desenvolvedor."""

    model_id: str  # YAML: modelId — inference-profile model id
    name: Optional[str] = None
    provider: Optional[str] = None
    streaming: Optional[bool] = None


@dataclass(frozen=True)
class AgentManifest:
    """Subconjunto fiel do `AgentSpecProps` real. Só os campos que o SDK lê do
    `manifest.yaml` para montar os resource attributes. Opcionais permanecem
    opcionais — o SDK nunca os preenche com placeholder."""

    name: str
    allowed_tools: List[str] = field(default_factory=list)  # YAML: allowedTools
    kind: Optional[ItemKind] = None
    model_id: Optional[str] = None  # YAML: modelId — obrigatório p/ kind=agent
    risk_tier: Optional[RiskTier] = None  # YAML: riskTier
    owner: Optional[ManifestOwner] = None
    cost_center: Optional[str] = None  # YAML: costCenter
    squad: Optional[str] = None
    data_classification: Optional[DataClassification] = None  # YAML: dataClassification
    runtime: Optional[ManifestRuntime] = None


# ─── SDK init configuration ──────────────────────────────────────────────────


@dataclass(frozen=True)
class ServiceAccountCredentials:
    """Credenciais de service account (OAuth client-credentials) para autenticar
    o export OTLP ao receiver de telemetria do CTA.

    `client_id` é opcional: quando omitido, cai no `serviceAccountId` do manifesto
    (ADR-0040). `client_secret` e `token_url` são obrigatórios e vêm sempre do
    ambiente/config do desenvolvedor — segredos nunca ficam no manifesto."""

    client_secret: str
    token_url: str
    client_id: Optional[str] = None


@dataclass(frozen=True)
class SecurityOptions:
    """Scanning de segurança OWASP LLM em runtime. Default: LIGADO quando o SDK
    está habilitado. O texto de input/output do agente é escaneado LOCALMENTE e
    só findings REDIGIDOS são emitidos (`cta.security.*`) — o conteúdo cru nunca
    vira telemetria. `enabled=False` desliga."""

    enabled: Optional[bool] = None
    # Teto opcional de tokens por invocação para o check LLM10 (unbounded consumption).
    max_total_tokens: Optional[int] = None


@dataclass(frozen=True)
class PumpConfig:
    """Configuração de inicialização do `PumpEvolution.init`."""

    service_account: ServiceAccountCredentials
    manifest: "str | AgentManifest"
    # Endpoint OTLP/HTTP do receiver do CTA. Opcional — default do manifesto
    # (`runtime.telemetry.otelEndpoint`, ADR-0040).
    endpoint: Optional[str] = None
    # Chave-mestra. `False` (ou `PUMP_EVOLUTION_ENABLED` != `true`) → no-op.
    enabled: Optional[bool] = None
    # Timeout (ms) para flush dos spans pendentes no shutdown.
    flush_timeout_ms: Optional[int] = None
    # Razão de sampling em [0, 1].
    sampling: Optional[float] = None
    # Scanning OWASP LLM (default ON quando habilitado).
    security: Optional[SecurityOptions] = None
    # Logger de diagnóstico opcional (duck-typed: warn(msg, meta)/debug(msg, meta)).
    # Quando presente, o SDK reporta falhas de export (auth 401/403, rede, 5xx) em
    # vez de degradar em silêncio — o sinal mais útil quando a telemetria "não
    # chega". Ausente → silencioso (default). Nunca recebe valores sensíveis.
    logger: Optional[Any] = None


# ─── Resource attributes produced by the SDK ─────────────────────────────────

# Atributos OTel derivados do manifesto. As chaves são os nomes literais dos
# atributos emitidos em cada span (ex. `service.name`, `gen_ai.agent.id`,
# `cta.item_kind`, ...). Opcionais são omitidos (nunca placeholder). Representado
# como dict — chaves com ponto não são atributos Python válidos.
AttributeValue = "str | int | float | bool | List[str]"
ResourceAttributes = Dict[str, object]

# Chave literal do resource attribute de kind (agent|mcp), setada sempre pelo
# manifest_to_resource_attributes (sem constante correspondente no constants.ts).
CTA_ITEM_KIND = "cta.item_kind"


# ─── Compliance ───────────────────────────────────────────────────────────────

ComplianceStatus = Literal["compliant", "non_compliant"]
ComplianceSeverity = Literal["info", "warning", "critical"]


@dataclass(frozen=True)
class ComplianceFinding:
    """Um finding de compliance quando o SDK detecta desvio do manifesto (ex.
    tool fora de `allowedTools`, ou guardrail ausente para a `dataClassification`)."""

    code: str  # ex. TOOL_NOT_ALLOWED
    severity: ComplianceSeverity
    message: str
    tool: Optional[str] = None
    data_classification: Optional[DataClassification] = None


@dataclass(frozen=True)
class ComplianceSummary:
    status: ComplianceStatus
    findings: Optional[List[ComplianceFinding]] = None


# ─── Security (OWASP LLM Top 10 — runtime signals) ─────────────────────────────

OwaspLlmCategory = Literal[
    "LLM01",  # Prompt Injection
    "LLM02",  # Insecure Output Handling
    "LLM03",  # Training Data Poisoning
    "LLM04",  # Model Denial of Service
    "LLM05",  # Supply Chain
    "LLM06",  # Sensitive Information Disclosure
    "LLM07",  # Insecure Plugin Design
    "LLM08",  # Excessive Agency
    "LLM09",  # Overreliance
    "LLM10",  # Unbounded Consumption
]

SecurityStatus = Literal["secure", "at_risk"]
SecuritySeverity = ComplianceSeverity
SecurityFindingLocation = Literal["input", "output", "tool", "usage"]


@dataclass(frozen=True)
class SecurityFinding:
    """Finding de segurança de runtime alinhado ao OWASP LLM Top 10.

    INVARIANTE DE PRIVACIDADE: um finding NUNCA carrega o valor cru ofensivo (o
    prompt injetado, o segredo/PII vazado). Carrega só o rótulo de regra
    machine-readable e a localização — telemetria não pode virar vazamento."""

    code: str  # ex. PROMPT_INJECTION
    owasp_category: OwaspLlmCategory
    severity: SecuritySeverity
    message: str
    location: SecurityFindingLocation
    rule: Optional[str] = None  # rótulo redigido (ex. aws_access_key_id) — NUNCA o valor cru


@dataclass(frozen=True)
class SecuritySummary:
    status: SecurityStatus
    findings: Optional[List[SecurityFinding]] = None


# ─── Usage event contract (SDK side) ──────────────────────────────────────────


@dataclass(frozen=True)
class UsageEventMetadata:
    tools: Optional[List[str]] = None
    compliance: Optional[ComplianceSummary] = None
    security: Optional[SecuritySummary] = None


@dataclass(frozen=True)
class UsageEventContract:
    """Contrato lado-SDK do que os dados de uso mapeiam no fio. Espelha o
    `UsageEvent` interno do servidor, mas é standalone — sem import cross-package.
    O servidor é dono do tipo autoritativo; esta é a forma que os spans do SDK
    são desenhados para traduzir."""

    source: Literal["external-otel"]
    user_id: str
    model: str
    input_tokens: int
    output_tokens: int
    department: Optional[str] = None
    cost_center: Optional[str] = None
    provider: Optional[str] = None
    latency_ms: Optional[int] = None
    agent_id: Optional[str] = None
    session_id: Optional[str] = None
    metadata: Optional[UsageEventMetadata] = None


# ─── Handle returned by init ──────────────────────────────────────────────────


@dataclass(frozen=True)
class UserContext:
    """Contexto de identidade do usuário propagado por um fluxo via `with_user`."""

    user_id: Optional[str] = None
    department: Optional[str] = None
    cost_center: Optional[str] = None
    token: Optional[str] = None  # JWT propagado (nunca emitido pelo SDK)


@dataclass(frozen=True)
class McpToolInvocation:
    """Uma invocação de tool MCP a ser traçada como span `execute_tool` governado.
    `input`, quando fornecido, é escaneado LOCALMENTE para sinais OWASP LLM e só
    findings REDIGIDOS são emitidos — o input cru nunca vira telemetria."""

    name: str  # gen_ai.tool.name
    input: Optional[str] = None


_T = TypeVar("_T")
_C = TypeVar("_C")
_S = TypeVar("_S")


class PumpHandle(Protocol):
    """Handle controlável retornado por `PumpEvolution.init`. Contrato público
    que os desenvolvedores externos programam (nomes de método em snake_case,
    idiomático Python; mesma capacidade do `PumpHandle` do TS)."""

    def instrument_bedrock(self, client: _C) -> _C:
        """Instrumenta um cliente Bedrock in-place (idempotente): cada invocação
        de modelo emite um span GenAI com usage, identidade, tools e compliance.
        Retorna o mesmo cliente. Com o SDK desabilitado, retorna intocado."""
        ...

    def trace_tool(self, name: str, fn):  # -> T
        """Embrulha uma tool call não-Bedrock num span `execute_tool`
        (framework-agnóstico). Com o SDK desabilitado, roda `fn` sem traçar."""
        ...

    def trace_mcp_tool(self, invocation: McpToolInvocation, fn):  # -> T
        """Embrulha uma tool MCP governada num span `execute_tool` com os MESMOS
        checks de compliance (allowedTools) + segurança OWASP-LLM dos agentes."""
        ...

    def instrument_mcp_server(self, server: _S) -> _S:
        """Auto-instrumenta um servidor MCP in-place: toda tool registrada é
        governada automaticamente. Chame logo após construir o servidor e ANTES
        de registrar as tools."""
        ...

    def with_user(self, ctx: UserContext, fn):  # -> T
        """Roda `fn` com a identidade do usuário propagada a todos os spans do fluxo."""
        ...

    async def shutdown(self) -> None:
        """Dá flush nos spans pendentes e desmonta o pipeline de telemetria."""
        ...
