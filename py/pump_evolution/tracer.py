"""
tracer — faz o bootstrap de um `TracerProvider` do OpenTelemetry para o SDK.
Paridade 1:1 com `src/tracer.ts`.

Constrói um `TracerProvider` cujo `Resource` deriva dos `ResourceAttributes` do
manifesto, aplicando o sampler resolvido. NÃO conecta o exporter OTLP — isso é
responsabilidade do `otlp_exporter`. Registro global é opt-in (`register`),
default `False`, pra este módulo não ter efeito colateral global; o `init`
decide quando registrar.
"""

from __future__ import annotations

from typing import Optional, Sequence

from opentelemetry import trace as _ot_trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SpanProcessor
from opentelemetry.sdk.trace.sampling import ALWAYS_ON, Sampler, TraceIdRatioBased
from opentelemetry.trace import Tracer

from .types import ResourceAttributes

# Nome default do tracer (instrumentation-scope reportado ao OTel).
TRACER_NAME = "@topaz-ia/pump-evolution"
# Versão default do tracer reportada ao OpenTelemetry.
TRACER_VERSION = "0.0.1"


# ─── ResourceAttributes → OTel Resource ───────────────────────────────────────


def build_resource(attributes: ResourceAttributes) -> Resource:
    """Monta um `Resource` OTel a partir dos `ResourceAttributes` derivados do
    manifesto. Exposto separado pra as camadas de exporter/init reusarem o mesmo
    resource sem reconstruir um provider. Campos ausentes já vêm omitidos do dict
    (nunca placeholder); arrays (allowed_tools) são copiados."""
    otel_attrs = {}
    for key, value in attributes.items():
        if value is None:
            continue
        otel_attrs[key] = list(value) if isinstance(value, (list, tuple)) else value
    return Resource.create(otel_attrs)


# ─── Resolução do sampler ──────────────────────────────────────────────────────


def resolve_sampler(sampling: Optional[float] = None) -> Sampler:
    """Resolve o sampler de trace.

    Com `sampling` em `[0, 1]`, usa `TraceIdRatioBased`. Omitido → `ALWAYS_ON`
    — default DELIBERADO (amostra tudo), não valor mascarado/ausente: pra
    telemetria de governança a plataforma quer toda invocação registrada, a menos
    que o dev opte explicitamente por sampling."""
    if sampling is None:
        return ALWAYS_ON
    import math

    if not math.isfinite(sampling) or sampling < 0 or sampling > 1:
        raise ValueError(
            f"[pump-evolution] tracer sampling ratio must be a number in [0, 1], "
            f"got {sampling}. No default is applied."
        )
    return TraceIdRatioBased(sampling)


# ─── Fábrica do provider ────────────────────────────────────────────────────────


def create_tracer_provider(
    resource_attributes: ResourceAttributes,
    *,
    sampling: Optional[float] = None,
    span_processors: Optional[Sequence[SpanProcessor]] = None,
    register: bool = False,
) -> TracerProvider:
    """Cria (e opcionalmente registra) um `TracerProvider` configurado com o
    resource do manifesto e o sampler. O exporter OTLP NÃO é conectado aqui."""
    provider = TracerProvider(
        resource=build_resource(resource_attributes),
        sampler=resolve_sampler(sampling),
    )
    if span_processors is not None:
        for sp in span_processors:
            provider.add_span_processor(sp)
    if register is True:
        _ot_trace.set_tracer_provider(provider)
    return provider


def get_tracer(
    provider: TracerProvider,
    name: str = TRACER_NAME,
    version: str = TRACER_VERSION,
) -> Tracer:
    """Acessor de conveniência pra um `Tracer` de um provider, usando o
    nome/versão default de instrumentation-scope do SDK salvo se sobrescrito."""
    return provider.get_tracer(name, version)
