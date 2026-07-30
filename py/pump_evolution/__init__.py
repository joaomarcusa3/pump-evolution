"""
pump-evolution (Python) — SDK de telemetria governada para agentes de IA e
servidores MCP. Paridade com o pacote TS `@topaz-ia/pump-evolution`.

Este __init__ expõe a superfície pública já implementada. Os módulos de runtime
(tracer, token_provider, otlp_exporter, checkers, instrumentations, o compositor
PumpEvolution) são adicionados nas próximas fatias, espelhando 1:1 o `index.ts`.
"""

from .constants import (
    PUMP_EVOLUTION_ENABLED_ENV,
    USAGE_SOURCE_EXTERNAL_OTEL,
)
from .config_resolver import (
    ResolvedServiceAccount,
    ResolvedTelemetryConfig,
    resolve_telemetry_config,
)
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

__version__ = "0.0.1"

__all__ = [
    "resolve_telemetry_config",
    "ResolvedServiceAccount",
    "ResolvedTelemetryConfig",
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
    "PUMP_EVOLUTION_ENABLED_ENV",
    "USAGE_SOURCE_EXTERNAL_OTEL",
    "__version__",
]
