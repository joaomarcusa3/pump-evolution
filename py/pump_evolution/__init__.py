"""
pump-evolution (Python) — SDK de telemetria governada para agentes de IA e
servidores MCP. Paridade com o pacote TS `@topaz-ia/pump-evolution`.

Superfície pública espelhando o `index.ts`: um único ponto de entrada
(`PumpEvolution.init`) + os componentes (manifest, tracer, identidade,
instrumentações Bedrock/MCP, checkers de compliance e segurança OWASP,
consumer-auth, token provider, exporter resiliente).
"""

from .constants import (
    DEFAULT_FLUSH_TIMEOUT_MS,
    PUMP_EVOLUTION_ENABLED_ENV,
    USAGE_SOURCE_EXTERNAL_OTEL,
)
from .config_resolver import (
    ResolvedServiceAccount,
    ResolvedTelemetryConfig,
    resolve_telemetry_config,
)
from .manifest_loader import (
    load_manifest,
    load_resource_attributes,
    manifest_to_resource_attributes,
)
from .tracer import (
    TRACER_NAME,
    TRACER_VERSION,
    build_resource,
    create_tracer_provider,
    get_tracer,
    resolve_sampler,
)
from .identity_context import (
    IdentityHeaderInput,
    apply_identity_to_span,
    claims_to_user_context,
    get_current_user,
    parse_identity_headers,
    with_user,
)
from .tool_tracer import (
    ObservedToolUse,
    extract_tool_use_from_stream_event,
    extract_tool_uses,
    record_tool_use_spans,
    run_with_span,
    trace_tool,
)
from .resilience import CircuitBreaker, backoff_delay_ms, with_retry
from .token_provider import DEFAULT_TELEMETRY_SCOPE, FetchResponse, ServiceAccountTokenProvider
from .otlp_exporter import (
    ResilientAuthSpanExporter,
    TelemetryLogger,
    create_otlp_batch_processor,
)
from .compliance_checker import (
    FINDING_GUARDRAIL_EVIDENCE_MISSING,
    FINDING_TOOL_NOT_ALLOWED,
    ComplianceEvaluationInput,
    apply_compliance_to_span,
    check_data_classification_guardrail,
    check_tools,
    evaluate_compliance,
    summarize_compliance,
)
from .security_checker import (
    FINDING_PROMPT_INJECTION,
    FINDING_SENSITIVE_INFO_DISCLOSURE,
    FINDING_UNBOUNDED_CONSUMPTION,
    SecurityEvaluationInput,
    apply_security_to_span,
    detect_prompt_injection,
    detect_sensitive_info,
    detect_unbounded_consumption,
    evaluate_security,
    summarize_security,
)
from .consumer_auth import (
    ConsumerAuthResult,
    ConsumerTokenVerifier,
    RunWithIdentityResult,
)
from .bedrock_instrumentation import (
    BedrockInstrumentationDeps,
    ComplianceConfig,
    SecurityConfig,
    instrument_bedrock_client,
)
from .mcp_instrumentation import (
    McpToolTracerDeps,
    instrument_mcp_server,
    trace_mcp_tool,
)
from .chat_recorder import OPERACAO_CHAT, record_chat
from .core import PumpEvolution, PumpInitInternals, init
from .types import (
    AgentManifest,
    ComplianceFinding,
    ComplianceSummary,
    DataClassification,
    ItemKind,
    ManifestOwner,
    ManifestRuntime,
    ManifestTelemetry,
    McpToolInvocation,
    OwaspLlmCategory,
    PumpConfig,
    PumpHandle,
    ResourceAttributes,
    RiskTier,
    SecurityFinding,
    SecuritySummary,
    ServiceAccountCredentials,
    UsageEventContract,
    UserContext,
)

__version__ = "0.0.4"

__all__ = [
    "record_chat",
    # entry point
    "PumpEvolution",
    "init",
    "PumpInitInternals",
    # config / manifest
    "resolve_telemetry_config",
    "ResolvedServiceAccount",
    "ResolvedTelemetryConfig",
    "load_manifest",
    "load_resource_attributes",
    "manifest_to_resource_attributes",
    # tracer
    "build_resource",
    "create_tracer_provider",
    "get_tracer",
    "resolve_sampler",
    "TRACER_NAME",
    "TRACER_VERSION",
    # identity
    "with_user",
    "get_current_user",
    "apply_identity_to_span",
    "parse_identity_headers",
    "claims_to_user_context",
    "IdentityHeaderInput",
    # tools
    "trace_tool",
    "run_with_span",
    "extract_tool_uses",
    "extract_tool_use_from_stream_event",
    "record_tool_use_spans",
    "ObservedToolUse",
    # instrumentations
    "instrument_bedrock_client",
    "BedrockInstrumentationDeps",
    "ComplianceConfig",
    "SecurityConfig",
    "instrument_mcp_server",
    "trace_mcp_tool",
    "McpToolTracerDeps",
    # compliance
    "evaluate_compliance",
    "check_tools",
    "check_data_classification_guardrail",
    "summarize_compliance",
    "apply_compliance_to_span",
    "ComplianceEvaluationInput",
    "FINDING_TOOL_NOT_ALLOWED",
    "FINDING_GUARDRAIL_EVIDENCE_MISSING",
    # security
    "evaluate_security",
    "detect_prompt_injection",
    "detect_sensitive_info",
    "detect_unbounded_consumption",
    "summarize_security",
    "apply_security_to_span",
    "SecurityEvaluationInput",
    "FINDING_PROMPT_INJECTION",
    "FINDING_SENSITIVE_INFO_DISCLOSURE",
    "FINDING_UNBOUNDED_CONSUMPTION",
    # auth / export / resilience
    "ConsumerTokenVerifier",
    "ConsumerAuthResult",
    "RunWithIdentityResult",
    "ServiceAccountTokenProvider",
    "DEFAULT_TELEMETRY_SCOPE",
    "FetchResponse",
    "create_otlp_batch_processor",
    "ResilientAuthSpanExporter",
    "TelemetryLogger",
    "CircuitBreaker",
    "with_retry",
    "backoff_delay_ms",
    # types
    "AgentManifest",
    "PumpConfig",
    "PumpHandle",
    "ServiceAccountCredentials",
    "ManifestOwner",
    "ManifestRuntime",
    "ManifestTelemetry",
    "ResourceAttributes",
    "UserContext",
    "McpToolInvocation",
    "UsageEventContract",
    "ComplianceFinding",
    "ComplianceSummary",
    "SecurityFinding",
    "SecuritySummary",
    "DataClassification",
    "RiskTier",
    "ItemKind",
    "OwaspLlmCategory",
    "DEFAULT_FLUSH_TIMEOUT_MS",
    "PUMP_EVOLUTION_ENABLED_ENV",
    "USAGE_SOURCE_EXTERNAL_OTEL",
    "__version__",
]
