"""
manifest_loader — parseia e valida o `manifest.yaml` do agente (subconjunto fiel
do `AgentSpecProps` real) em `ResourceAttributes` do OpenTelemetry. Paridade 1:1
com `src/manifest-loader.ts`.

Invariante: ZERO fallback (ADR-0031). Arquivo ausente/ilegível, YAML inválido, ou
campo obrigatório ausente/inválido → erro claro e descritivo. Nunca substitui
default silencioso e nunca preenche opcional ausente com placeholder — opcionais
ausentes são simplesmente omitidos do resultado.

As chaves lidas do manifesto são as reais (camelCase): `name`, `modelId`,
`allowedTools`, `owner.email`, `costCenter`, `squad`, `dataClassification`,
`riskTier`, `runtime.*` — mapeadas para os atributos snake_case do dataclass.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import yaml

from .constants import (
    CTA_ALLOWED_TOOLS,
    CTA_COST_CENTER,
    CTA_DATA_CLASSIFICATION,
    CTA_RISK_TIER,
    CTA_SQUAD,
    GEN_AI_AGENT_ID,
    GEN_AI_REQUEST_MODEL,
    SERVICE_NAME,
)
from .types import (
    CTA_ITEM_KIND,
    AgentManifest,
    ManifestOwner,
    ManifestRuntime,
    ManifestTelemetry,
    ResourceAttributes,
)

# ─── Valores de enum aceitos (espelham a validação do AgentSpec real) ─────────

VALID_DATA_CLASSIFICATIONS: Sequence[str] = ("public", "internal", "sensitive")
VALID_RISK_TIERS: Sequence[str] = ("T1-low", "T2-medium", "T3-sensitive", "T4-autonomous")
VALID_ITEM_KINDS: Sequence[str] = ("agent", "mcp")
DEFAULT_ITEM_KIND = "agent"


# ─── Helpers de narrowing / descrição ──────────────────────────────────────────


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _describe_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _describe_value(value: Any) -> str:
    if value is None:
        return "undefined"
    if isinstance(value, str):
        return f'"{value}"'
    if isinstance(value, list):
        return "an array"
    if isinstance(value, dict):
        return "an object"
    return str(value)


def _fail(origin: str, detail: str) -> "None":
    raise ValueError(f"[pump-evolution] manifest ({origin}) {detail} No default is applied.")


# ─── Validadores de campo (cada um lança em input inválido — fail-fast) ───────


def _require_non_empty_string(value: Any, field: str, origin: str) -> str:
    if not isinstance(value, str) or len(value.strip()) == 0:
        _fail(
            origin,
            f'field "{field}" is required and must be a non-empty string, '
            f"got {_describe_value(value)}.",
        )
    return value


def _optional_non_empty_string(value: Any, field: str, origin: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or len(value.strip()) == 0:
        _fail(
            origin,
            f'field "{field}" must be a non-empty string when present, '
            f"got {_describe_value(value)}.",
        )
    return value


def _optional_boolean(value: Any, field: str, origin: str) -> Optional[bool]:
    if value is None:
        return None
    if not isinstance(value, bool):
        _fail(origin, f'field "{field}" must be a boolean when present, got {_describe_value(value)}.')
    return value


def _require_string_array(value: Any, field: str, origin: str) -> List[str]:
    # Deve estar presente e ser lista (ausente/não-lista falha). PODE ser vazia:
    # agentes só-Converse (sem tool-calling) declaram allowedTools: [].
    if not isinstance(value, list):
        _fail(
            origin,
            f'field "{field}" is required and must be an array of tool names, '
            f"got {_describe_value(value)}.",
        )
    tools: List[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or len(item.strip()) == 0:
            _fail(
                origin,
                f'field "{field}[{index}]" must be a non-empty string, got {_describe_value(item)}.',
            )
        tools.append(item)
    return tools


def _optional_enum(value: Any, allowed: Sequence[str], field: str, origin: str) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str) and value in allowed:
        return value
    _fail(
        origin,
        f'field "{field}" must be one of [{", ".join(allowed)}] when present, '
        f"got {_describe_value(value)}.",
    )


# ─── Parsers de blocos aninhados ──────────────────────────────────────────────


def _parse_owner(value: Any, origin: str) -> Optional[ManifestOwner]:
    if value is None:
        return None
    if not _is_record(value):
        _fail(origin, f'field "owner" must be an object when present, got {_describe_type(value)}.')
    email = _require_non_empty_string(value.get("email"), "owner.email", origin)
    team = _optional_non_empty_string(value.get("team"), "owner.team", origin)
    cost_center = _optional_non_empty_string(value.get("costCenter"), "owner.costCenter", origin)
    return ManifestOwner(email=email, team=team, cost_center=cost_center)


def _parse_telemetry(value: Any, origin: str) -> Optional[ManifestTelemetry]:
    if value is None:
        return None
    if not _is_record(value):
        _fail(
            origin,
            f'field "runtime.telemetry" must be an object when present, got {_describe_type(value)}.',
        )
    otel_endpoint = _require_non_empty_string(
        value.get("otelEndpoint"), "runtime.telemetry.otelEndpoint", origin
    )
    service_account_id = _require_non_empty_string(
        value.get("serviceAccountId"), "runtime.telemetry.serviceAccountId", origin
    )
    return ManifestTelemetry(otel_endpoint=otel_endpoint, service_account_id=service_account_id)


def _parse_runtime(value: Any, origin: str) -> Optional[ManifestRuntime]:
    if value is None:
        return None
    if not _is_record(value):
        _fail(origin, f'field "runtime" must be an object when present, got {_describe_type(value)}.')
    external = _optional_boolean(value.get("external"), "runtime.external", origin)
    telemetry = _parse_telemetry(value.get("telemetry"), origin)
    return ManifestRuntime(external=external, telemetry=telemetry)


# ─── Entrada de validação ──────────────────────────────────────────────────────


def _to_manifest(value: Any, origin: str) -> AgentManifest:
    """Narrows um `Any` (YAML parseado ou objeto do chamador) num `AgentManifest`
    validado. Lança erro descritivo em qualquer obrigatório ausente/inválido ou
    opcional malformado."""
    if not _is_record(value):
        _fail(origin, f"must be a YAML mapping/object, got {_describe_type(value)}.")

    name = _require_non_empty_string(value.get("name"), "name", origin)

    # `kind` governa se modelId é exigido. Ausente → 'agent' (default semântico
    # documentado, retrocompatível com manifests de agente existentes).
    kind = _optional_enum(value.get("kind"), VALID_ITEM_KINDS, "kind", origin) or DEFAULT_ITEM_KIND

    # modelId: obrigatório p/ agentes; não se aplica a MCP. Zero fallback.
    if kind == "mcp":
        model_id = _optional_non_empty_string(value.get("modelId"), "modelId", origin)
    else:
        model_id = _require_non_empty_string(value.get("modelId"), "modelId", origin)

    allowed_tools = _require_string_array(value.get("allowedTools"), "allowedTools", origin)

    risk_tier = _optional_enum(value.get("riskTier"), VALID_RISK_TIERS, "riskTier", origin)
    data_classification = _optional_enum(
        value.get("dataClassification"), VALID_DATA_CLASSIFICATIONS, "dataClassification", origin
    )
    squad = _optional_non_empty_string(value.get("squad"), "squad", origin)
    cost_center = _optional_non_empty_string(value.get("costCenter"), "costCenter", origin)
    owner = _parse_owner(value.get("owner"), origin)
    runtime = _parse_runtime(value.get("runtime"), origin)

    return AgentManifest(
        name=name,
        kind=kind,  # type: ignore[arg-type]
        model_id=model_id,
        allowed_tools=allowed_tools,
        risk_tier=risk_tier,  # type: ignore[arg-type]
        owner=owner,
        cost_center=cost_center,
        squad=squad,
        data_classification=data_classification,  # type: ignore[arg-type]
        runtime=runtime,
    )


# ─── Mapper Manifest → ResourceAttributes ─────────────────────────────────────


def manifest_to_resource_attributes(manifest: AgentManifest) -> ResourceAttributes:
    """Mapeia um `AgentManifest` validado para `ResourceAttributes` do OTel.

    Campos obrigatórios (`name`, `modelId`, `allowedTools`) sempre produzem seus
    atributos. Opcionais são omitidos quando ausentes — nunca placeholder.

    Precedência de costCenter: a fonte autoritativa é o `costCenter` top-level;
    ausente, usa `owner.costCenter` como fonte declarada alternativa (precedência
    explícita entre dois campos reais — não é default fabricado)."""
    kind = manifest.kind or DEFAULT_ITEM_KIND
    attributes: Dict[str, object] = {
        SERVICE_NAME: manifest.name,
        GEN_AI_AGENT_ID: manifest.name,
        CTA_ITEM_KIND: kind,
        CTA_ALLOWED_TOOLS: list(manifest.allowed_tools),
    }

    # gen_ai.request.model só quando o manifesto declara modelo (agentes).
    # MCP não tem modelo → o atributo é omitido, nunca placeholder.
    if manifest.model_id is not None:
        attributes[GEN_AI_REQUEST_MODEL] = manifest.model_id

    cost_center = manifest.cost_center or (manifest.owner.cost_center if manifest.owner else None)
    if cost_center is not None:
        attributes[CTA_COST_CENTER] = cost_center
    if manifest.squad is not None:
        attributes[CTA_SQUAD] = manifest.squad
    if manifest.data_classification is not None:
        attributes[CTA_DATA_CLASSIFICATION] = manifest.data_classification
    if manifest.risk_tier is not None:
        attributes[CTA_RISK_TIER] = manifest.risk_tier

    return attributes


# ─── API pública do loader ──────────────────────────────────────────────────────


def _read_manifest_file(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as err:
        raise ValueError(
            f'[pump-evolution] manifest file could not be read at "{path}": {err}. '
            "Provide a readable manifest.yaml path or an AgentManifest object. "
            "No default is applied."
        )
    try:
        return yaml.safe_load(raw)
    except yaml.YAMLError as err:
        raise ValueError(
            f'[pump-evolution] manifest at "{path}" is not valid YAML: {err}. No default is applied.'
        )


def load_manifest(source: "str | AgentManifest") -> AgentManifest:
    """Carrega e valida um manifesto de um caminho `manifest.yaml` ou de um objeto
    já parseado. Fail-fast: lança erro descritivo quando o arquivo está
    ausente/ilegível, o YAML é malformado, ou um campo obrigatório está
    ausente/inválido."""
    if isinstance(source, AgentManifest):
        return source
    if isinstance(source, str):
        return _to_manifest(_read_manifest_file(source), f'path "{source}"')
    # dict cru (paridade com o TS que aceita objeto já parseado)
    return _to_manifest(source, "object")


def load_resource_attributes(source: "str | AgentManifest") -> ResourceAttributes:
    """Conveniência: carrega/valida um manifesto e mapeia direto pra
    `ResourceAttributes`."""
    return manifest_to_resource_attributes(load_manifest(source))
