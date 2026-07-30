"""
Attribute-name constants used across the SDK.

Paridade 1:1 com `src/constants.ts` do SDK TS. São os nomes literais dos
atributos OpenTelemetry GenAI + os atributos custom `cta.*` que o receiver do CTA
entende. Definidos aqui (em vez de importados) para o conjunto ser explícito e
estável, independente da versão do pacote de semantic-conventions.
"""

from typing import Final

# ─── GenAI semantic conventions ───────────────────────────────────────────────

GEN_AI_AGENT_ID: Final = "gen_ai.agent.id"
GEN_AI_REQUEST_MODEL: Final = "gen_ai.request.model"
GEN_AI_USAGE_INPUT_TOKENS: Final = "gen_ai.usage.input_tokens"
GEN_AI_USAGE_OUTPUT_TOKENS: Final = "gen_ai.usage.output_tokens"
GEN_AI_PROVIDER_NAME: Final = "gen_ai.provider.name"
GEN_AI_OPERATION_NAME: Final = "gen_ai.operation.name"
GEN_AI_TOOL_NAME: Final = "gen_ai.tool.name"
GEN_AI_SESSION_ID: Final = "gen_ai.session.id"
GEN_AI_RESPONSE_FINISH_REASONS: Final = "gen_ai.response.finish_reasons"

# ─── Standard OTel attributes reused by the SDK ────────────────────────────────

SERVICE_NAME: Final = "service.name"
ENDUSER_ID: Final = "enduser.id"

# ─── CTA custom attributes ─────────────────────────────────────────────────────

CTA_COST_CENTER: Final = "cta.cost_center"
CTA_SQUAD: Final = "cta.squad"
CTA_DATA_CLASSIFICATION: Final = "cta.data_classification"
CTA_RISK_TIER: Final = "cta.risk_tier"
CTA_ALLOWED_TOOLS: Final = "cta.allowed_tools"
CTA_DEPARTMENT: Final = "cta.department"
CTA_COMPLIANCE_STATUS: Final = "cta.compliance.status"
CTA_COMPLIANCE_FINDINGS: Final = "cta.compliance.findings"
CTA_IDENTITY_ANONYMOUS: Final = "cta.identity.anonymous"

# ─── CTA security attributes (OWASP LLM Top 10 — runtime) ─────────────────────

# `secure` | `at_risk` — a postura de segurança de runtime da invocação.
CTA_SECURITY_STATUS: Final = "cta.security.status"
# JSON array (string) de objetos `SecurityFinding` (redigidos — sem valor cru).
CTA_SECURITY_FINDINGS: Final = "cta.security.findings"
# Categorias OWASP LLM distintas presentes, para dimensionar métrica no servidor.
CTA_SECURITY_OWASP_CATEGORIES: Final = "cta.security.owasp_categories"

# Marcador explícito de disponibilidade de contagem de tokens numa invocação.
#
# Quando a resposta do Bedrock expõe usage, isto é `True` e os `gen_ai.usage.*`
# são setados. Quando a resposta NÃO expõe contagem de tokens, isto é `False` e
# os `gen_ai.usage.*` são OMITIDOS — nunca setados como `0`. Um `0` fabricado
# corromperia silenciosamente a agregação de custo downstream; o `False`
# explícito registra a ausência honestamente ("nunca fabricar métrica — ausência
# é ausência explícita").
CTA_USAGE_TOKENS_AVAILABLE: Final = "cta.usage.tokens_available"

# ─── Well-known attribute values ───────────────────────────────────────────────

# Valor de `gen_ai.provider.name` para o Amazon Bedrock.
PROVIDER_AWS_BEDROCK: Final = "aws.bedrock"

# Valor de `gen_ai.operation.name` para um span de execução de tool.
OPERATION_EXECUTE_TOOL: Final = "execute_tool"

# Valor de `gen_ai.operation.name` para uma invocação de chat/conversa. Usado
# para as operações Bedrock `Converse` / `ConverseStream` (GenAI semconv).
OPERATION_CHAT: Final = "chat"

# Valor de `gen_ai.operation.name` para uma invocação de text-completion crua.
# Usado para `InvokeModel` / `InvokeModelWithResponseStream`, cujo payload é
# nativo do modelo em vez do formato normalizado do Converse.
OPERATION_TEXT_COMPLETION: Final = "text_completion"

# Discriminador `source` para os usage events produzidos por este SDK.
USAGE_SOURCE_EXTERNAL_OTEL: Final = "external-otel"

# ─── Environment / config ──────────────────────────────────────────────────────

# Variável de ambiente que habilita o SDK. Só `'true'` liga.
PUMP_EVOLUTION_ENABLED_ENV: Final = "PUMP_EVOLUTION_ENABLED"

# Timeout (ms) padrão para dar flush nos spans pendentes no shutdown.
DEFAULT_FLUSH_TIMEOUT_MS: Final = 5_000
