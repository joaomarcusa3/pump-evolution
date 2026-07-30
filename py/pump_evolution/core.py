"""
core — a composição de topo (`PumpEvolution.init`) que liga cada componente do
SDK num único handle plug-and-play (Requirement 1). Paridade 1:1 com
`src/pump-evolution.ts`.

Ordem de composição: carrega+valida manifesto → resolve config efetiva → monta o
pipeline OTLP em batch (auth + resiliência) → cria o tracer provider do resource
do manifesto → retorna um handle que instrumenta Bedrock, embrulha tools manuais,
propaga identidade e dá flush no shutdown.

Habilitação (Requirement 1.2): o SDK é **no-op** a menos que
`PUMP_EVOLUTION_ENABLED == 'true'` E `config.enabled != False`. O handle no-op não
valida nada e não inicializa exporter — só roda as funções do dev intocadas. Só
quando habilitado o `init` valida manifesto/config (fail-fast).
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Callable, List, Optional, Sequence, TypeVar

from .bedrock_instrumentation import (
    BedrockInstrumentationDeps,
    ComplianceConfig,
    SecurityConfig,
    instrument_bedrock_client,
)
from .config_resolver import resolve_telemetry_config
from .constants import PUMP_EVOLUTION_ENABLED_ENV
from .identity_context import with_user as _with_user
from .manifest_loader import load_manifest, manifest_to_resource_attributes
from .mcp_instrumentation import (
    McpToolTracerDeps,
    instrument_mcp_server as _instrument_mcp_server,
    trace_mcp_tool as _trace_mcp_tool,
)
from .otlp_exporter import create_otlp_batch_processor
from .token_provider import ServiceAccountTokenProvider
from .tool_tracer import trace_tool as _trace_tool
from .tracer import create_tracer_provider, get_tracer
from .types import McpToolInvocation, PumpConfig, UserContext

_T = TypeVar("_T")
_C = TypeVar("_C")
_S = TypeVar("_S")


# ─── Test / advanced seams ─────────────────────────────────────────────────────


class PumpInitInternals:
    """Costuras internas de composição (não fazem parte da API do dia a dia):
    deixam testes injetar um span processor em memória e controlar o gate de
    habilitação deterministicamente."""

    def __init__(
        self,
        *,
        span_processors: Optional[Sequence[Any]] = None,
        register: Optional[bool] = None,
        logger: Optional[Any] = None,
        env_enabled: Optional[bool] = None,
    ) -> None:
        self.span_processors = span_processors
        self.register = register
        self.logger = logger
        self.env_enabled = env_enabled


# ─── Gate de habilitação ───────────────────────────────────────────────────────


def _resolve_enabled(config: PumpConfig, internals: PumpInitInternals) -> bool:
    env_enabled = (
        internals.env_enabled
        if internals.env_enabled is not None
        else os.environ.get(PUMP_EVOLUTION_ENABLED_ENV) == "true"
    )
    return bool(env_enabled) and config.enabled is not False


# ─── Handles ─────────────────────────────────────────────────────────────────


class _NoopHandle:
    """Handle que não faz nada — o SDK está desabilitado (Requirement 1.2)."""

    def instrument_bedrock(self, client: _C) -> _C:
        return client

    def trace_tool(self, name: str, fn: Callable[[], _T]) -> _T:
        return fn()

    def trace_mcp_tool(self, invocation: McpToolInvocation, fn: Callable[[], _T]) -> _T:
        return fn()

    def instrument_mcp_server(self, server: _S) -> _S:
        return server

    def with_user(self, ctx: UserContext, fn: Callable[[], _T]) -> _T:
        return fn()

    async def shutdown(self) -> None:
        return None


class _PumpHandle:
    """Handle real: liga instrumentação + identidade + shutdown com flush."""

    def __init__(self, tracer, compliance, security, mcp_deps, provider, flush_timeout_ms) -> None:
        self._tracer = tracer
        self._compliance = compliance
        self._security = security
        self._mcp_deps = mcp_deps
        self._provider = provider
        self._flush_timeout_ms = flush_timeout_ms

    def instrument_bedrock(self, client: _C) -> _C:
        instrument_bedrock_client(
            client,
            BedrockInstrumentationDeps(
                tracer=self._tracer, compliance=self._compliance, security=self._security
            ),
        )
        return client

    def trace_tool(self, name: str, fn: Callable[[], _T]) -> _T:
        return _trace_tool(self._tracer, name, fn)

    def trace_mcp_tool(self, invocation: McpToolInvocation, fn: Callable[[], _T]) -> _T:
        return _trace_mcp_tool(self._mcp_deps, invocation, fn)

    def instrument_mcp_server(self, server: _S) -> _S:
        return _instrument_mcp_server(self._mcp_deps, server)

    def with_user(self, ctx: UserContext, fn: Callable[[], _T]) -> _T:
        return _with_user(ctx, fn)

    async def shutdown(self) -> None:
        """Desliga o provider (que dá flush nos spans pendentes), mas nunca segura
        a saída do agente mais que `flush_timeout_ms`. Em timeout resolve mesmo
        assim — telemetria não pode atrasar o shutdown."""
        try:
            await asyncio.wait_for(
                asyncio.to_thread(self._provider.shutdown),
                timeout=self._flush_timeout_ms / 1000.0,
            )
        except Exception:
            # Timeout ou erro no flush — resolve mesmo assim (nunca lança).
            pass


# ─── init ──────────────────────────────────────────────────────────────────────


def init(config: PumpConfig, internals: Optional[PumpInitInternals] = None) -> Any:
    """Inicializa o SDK e retorna um handle controlável. No-op quando
    desabilitado; fail-fast em manifesto/config inválidos quando habilitado."""
    internals = internals or PumpInitInternals()
    if not _resolve_enabled(config, internals):
        return _NoopHandle()

    # Habilitado → valida tudo de cara (fail-fast, sem default silencioso).
    manifest = load_manifest(config.manifest)
    resolved = resolve_telemetry_config(config, manifest)
    resource_attributes = manifest_to_resource_attributes(manifest)

    if internals.span_processors is not None:
        span_processors: List[Any] = list(internals.span_processors)
    else:
        span_processors = [
            create_otlp_batch_processor(
                endpoint=resolved.endpoint,
                token_provider=ServiceAccountTokenProvider(
                    token_url=resolved.service_account.token_url,
                    client_id=resolved.service_account.client_id,
                    client_secret=resolved.service_account.client_secret,
                ),
                logger=internals.logger,
            )
        ]

    provider = create_tracer_provider(
        resource_attributes,
        span_processors=span_processors,
        register=internals.register if internals.register is not None else True,
        sampling=resolved.sampling,
    )
    tracer = get_tracer(provider)

    compliance = ComplianceConfig(
        allowed_tools=list(manifest.allowed_tools),
        data_classification=manifest.data_classification,
    )

    # Scanning OWASP LLM (Fatia 1b): ON por default quando habilitado; opt-out via
    # `config.security.enabled = False`. Resolvido uma vez (booleano explícito) e
    # compartilhado pela instrumentação Bedrock e pelo tracer de tools MCP.
    security_enabled = True
    if config.security is not None and config.security.enabled is not None:
        security_enabled = config.security.enabled
    security = SecurityConfig(
        enabled=security_enabled,
        max_total_tokens=(config.security.max_total_tokens if config.security is not None else None),
    )

    mcp_deps = McpToolTracerDeps(
        tracer=tracer,
        allowed_tools=list(manifest.allowed_tools),
        data_classification=manifest.data_classification,
        security_enabled=security_enabled,
    )

    return _PumpHandle(
        tracer=tracer,
        compliance=compliance,
        security=security,
        mcp_deps=mcp_deps,
        provider=provider,
        flush_timeout_ms=resolved.flush_timeout_ms,
    )


class PumpEvolution:
    """Entry point no estilo namespace, casando com o `PumpEvolution.init(...)`
    documentado."""

    @staticmethod
    def init(config: PumpConfig, internals: Optional[PumpInitInternals] = None) -> Any:
        return init(config, internals)
