"""
config_resolver — resolve a configuração *efetiva* de telemetria mesclando o que
o desenvolvedor passou em `PumpConfig` com os defaults declarados no bloco
`runtime.telemetry` do manifesto (ADR-0040, `ExternalRuntimeTelemetry`).

Paridade 1:1 com `src/config-resolver.ts`.

Precedência (valores do manifesto são DEFAULTS; config explícita vence):
  1. Valor explícito em `PumpConfig` (`config.endpoint`,
     `config.service_account.client_id`).
  2. Default do manifesto: `runtime.telemetry.otelEndpoint` → `endpoint`;
     `runtime.telemetry.serviceAccountId` → `service_account.client_id`.
  3. Se um valor efetivo OBRIGATÓRIO ainda estiver faltando → falha imediata com
     erro claro (ADR-0031 zero-fallback). Nenhum default silencioso é aplicado.

Segredos nunca vivem no manifesto: `client_secret` e `token_url` vêm SEMPRE do
`PumpConfig`; não há fallback do manifesto para eles.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from .constants import DEFAULT_FLUSH_TIMEOUT_MS
from .types import AgentManifest, ManifestTelemetry, PumpConfig


# ─── Resolved config shape ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ResolvedServiceAccount:
    """Credenciais efetivas do service account após mesclar config + manifesto."""

    client_id: str  # de config.service_account.client_id ou manifesto serviceAccountId
    client_secret: str  # de config.service_account.client_secret (nunca do manifesto)
    token_url: str  # de config.service_account.token_url (nunca do manifesto)


@dataclass(frozen=True)
class ResolvedTelemetryConfig:
    """Config de telemetria efetiva com que o SDK vai rodar. Todo campo
    obrigatório é garantido presente (o resolver lança caso contrário). Valores
    de tuning genuinamente opcionais são opcionais e só presentes quando dados."""

    endpoint: str
    service_account: ResolvedServiceAccount
    flush_timeout_ms: int
    enabled: bool
    sampling: Optional[float] = None


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _fail(detail: str) -> "None":
    raise ValueError(f"[pump-evolution] telemetry config {detail} No default is applied.")


def _non_empty(value: Optional[str]) -> Optional[str]:
    """Retorna o valor quando é string não-vazia, senão `None`."""
    if not isinstance(value, str):
        return None
    return None if len(value.strip()) == 0 else value


def _describe_number(value: float) -> str:
    return "NaN" if isinstance(value, float) and math.isnan(value) else str(value)


# ─── Per-field resolution (cada um falha rápido quando falta valor obrigatório) ──


def _resolve_endpoint(config: PumpConfig, telemetry: Optional[ManifestTelemetry]) -> str:
    endpoint = _non_empty(config.endpoint) or _non_empty(
        telemetry.otel_endpoint if telemetry else None
    )
    if endpoint is None:
        _fail(
            "requires an OTLP endpoint: set `endpoint` in PumpConfig or "
            "`runtime.telemetry.otelEndpoint` in the manifest (ADR-0040)."
        )
    return endpoint  # type: ignore[return-value]


def _resolve_client_id(config: PumpConfig, telemetry: Optional[ManifestTelemetry]) -> str:
    client_id = _non_empty(config.service_account.client_id) or _non_empty(
        telemetry.service_account_id if telemetry else None
    )
    if client_id is None:
        _fail(
            "requires a service-account clientId: set `serviceAccount.clientId` in PumpConfig or "
            "`runtime.telemetry.serviceAccountId` in the manifest (ADR-0040)."
        )
    return client_id  # type: ignore[return-value]


def _resolve_client_secret(config: PumpConfig) -> str:
    client_secret = _non_empty(config.service_account.client_secret)
    if client_secret is None:
        _fail(
            "requires `serviceAccount.clientSecret` from PumpConfig — "
            "the client secret is never stored in the manifest."
        )
    return client_secret  # type: ignore[return-value]


def _resolve_token_url(config: PumpConfig) -> str:
    token_url = _non_empty(config.service_account.token_url)
    if token_url is None:
        _fail(
            "requires `serviceAccount.tokenUrl` from PumpConfig — "
            "the token endpoint is never stored in the manifest."
        )
    return token_url  # type: ignore[return-value]


def _resolve_sampling(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    if (isinstance(value, float) and math.isnan(value)) or value < 0 or value > 1:
        _fail(f"`sampling` must be a number in [0, 1] when present, got {_describe_number(value)}.")
    return value


def _resolve_flush_timeout_ms(value: Optional[int]) -> int:
    if value is None:
        return DEFAULT_FLUSH_TIMEOUT_MS
    if not math.isfinite(value) or value <= 0:
        _fail(
            "`flushTimeoutMs` must be a positive finite number when present, "
            f"got {_describe_number(value)}."
        )
    return value


# ─── Public API ─────────────────────────────────────────────────────────────


def resolve_telemetry_config(config: PumpConfig, manifest: AgentManifest) -> ResolvedTelemetryConfig:
    """Resolve a config de telemetria efetiva a partir do `PumpConfig` do dev e do
    `manifest`. Valores de config explícitos têm precedência sobre os defaults de
    `runtime.telemetry` do manifesto (ADR-0040). Valores efetivos obrigatórios
    ausentes falham rápido (ADR-0031)."""

    telemetry = manifest.runtime.telemetry if manifest.runtime else None

    endpoint = _resolve_endpoint(config, telemetry)
    client_id = _resolve_client_id(config, telemetry)
    client_secret = _resolve_client_secret(config)
    token_url = _resolve_token_url(config)
    sampling = _resolve_sampling(config.sampling)
    flush_timeout_ms = _resolve_flush_timeout_ms(config.flush_timeout_ms)

    return ResolvedTelemetryConfig(
        endpoint=endpoint,
        service_account=ResolvedServiceAccount(
            client_id=client_id,
            client_secret=client_secret,
            token_url=token_url,
        ),
        flush_timeout_ms=flush_timeout_ms,
        enabled=config.enabled if config.enabled is not None else True,
        sampling=sampling,
    )
