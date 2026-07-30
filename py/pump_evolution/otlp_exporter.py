"""
otlp_exporter — o SpanExporter OTLP autenticado e resiliente (Requirement 7).
Paridade 1:1 com `src/otlp-exporter.ts`. Compõe:
  - delegate OTLP/HTTP **autenticado por bearer** (o token de service account do
    `token_provider` é injetado como `Authorization: Bearer …` e renovado
    transparentemente);
  - **retry com backoff** em falhas transitórias;
  - **circuit breaker por instância** (nunca global);
  - **degradação silenciosa**: falha persistente é reportada a um logger
    injetável e o batch é dropado — o exporter NUNCA lança pro agente, e o
    `BatchSpanProcessor` roda fora do hot path.

Nota async→sync: no Python o `SpanExporter.export` é SÍNCRONO (o
`BatchSpanProcessor` chama numa thread worker própria, sem event loop). O
`token_provider.get_token()` é async (paridade com o TS); aqui é rodado via
`asyncio.run` dentro dessa thread — o cache do provider evita rede na maioria
das exportações.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExporter,
    SpanExportResult,
    SpanProcessor,
)

from .resilience import CircuitBreaker, backoff_delay_ms


# ─── Logging hook (o SDK nunca usa print) ──────────────────────────────────────


class TelemetryLogger:
    """Logger local mínimo pra onde o exporter reporta degradação. Opcional: sem
    logger o SDK degrada de fato em silêncio (o host injeta o seu se quiser
    visibilidade). Duck-typed: basta ter `warn(msg, meta)`/`debug(msg, meta)`."""

    def warn(self, message: str, meta: Optional[Dict[str, Any]] = None) -> None:  # pragma: no cover
        ...

    def debug(self, message: str, meta: Optional[Dict[str, Any]] = None) -> None:  # pragma: no cover
        ...


# Factory que constrói o delegate OTLP pra um dado header set.
DelegateFactory = Callable[[Dict[str, str]], SpanExporter]


def _default_delegate_factory(endpoint: str) -> DelegateFactory:
    """Delegate default: um OTLP/HTTP exporter real autenticado por bearer.
    Import tardio pra não exigir o pacote OTLP quando um delegate é injetado."""

    def build(headers: Dict[str, str]) -> SpanExporter:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        return OTLPSpanExporter(endpoint=endpoint, headers=headers)

    return build


def _run_async(coro: "asyncio.Future") -> Any:
    """Roda um coroutine até o fim a partir de contexto síncrono (a thread do
    BatchSpanProcessor não tem loop)."""
    return asyncio.run(coro)


class ResilientAuthSpanExporter(SpanExporter):
    """Um `SpanExporter` que autentica, re-tenta, aciona um circuit breaker e
    degrada em silêncio. Embrulhe num `BatchSpanProcessor` (ver
    `create_otlp_batch_processor`)."""

    def __init__(
        self,
        *,
        endpoint: str,
        token_provider: Any,  # duck-typed: async get_token() -> str
        create_delegate: Optional[DelegateFactory] = None,
        breaker: Optional[CircuitBreaker] = None,
        retry: Optional[Dict[str, Any]] = None,
        logger: Optional[Any] = None,
    ) -> None:
        self._endpoint = endpoint
        self._token_provider = token_provider
        self._create_delegate = (
            create_delegate if create_delegate is not None else _default_delegate_factory(endpoint)
        )
        self._breaker = breaker if breaker is not None else CircuitBreaker()
        self._retry = retry or {}
        self._logger = logger
        self._delegate: Optional[SpanExporter] = None
        self._delegate_token: Optional[str] = None

    # ─── SpanExporter API (síncrona) ─────────────────────────────────────────

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        # Circuito aberto → dropa o batch sem tentar (protege endpoint e agente).
        if not self._breaker.can_attempt():
            self._log("debug", "telemetry export skipped — circuit open", {"endpoint": self._endpoint})
            return SpanExportResult.FAILURE
        try:
            self._export_with_resilience(list(spans))
            self._breaker.record_success()
            return SpanExportResult.SUCCESS
        except BaseException as error:  # noqa: BLE001 — nunca propaga pro agente
            self._breaker.record_failure()
            self._log(
                "warn",
                "telemetry export failed — dropping batch (agent unaffected)",
                {"endpoint": self._endpoint, "error": str(error)},
            )
            return SpanExportResult.FAILURE

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        delegate = self._delegate
        if delegate is None:
            return True
        flush = getattr(delegate, "force_flush", None)
        if callable(flush):
            try:
                return bool(flush(timeout_millis))
            except Exception:
                return False
        return True

    def shutdown(self) -> None:
        if self._delegate is not None:
            try:
                self._delegate.shutdown()
            except Exception:
                pass

    # ─── Internos ─────────────────────────────────────────────────────────────

    def _export_with_resilience(self, spans: List[ReadableSpan]) -> None:
        """Busca token fresco, (re)constrói o delegate e exporta com retry."""
        max_attempts = int(self._retry.get("max_attempts", 3))
        base_delay = float(self._retry.get("base_delay_ms", 200))
        max_delay = float(self._retry.get("max_delay_ms", 5_000))
        is_retryable = self._retry.get("is_retryable") or (lambda _e: True)

        last_error: Optional[BaseException] = None
        for attempt in range(1, max_attempts + 1):
            try:
                token = _run_async(self._token_provider.get_token())
                delegate = self._ensure_delegate(token)
                self._export_once(delegate, spans)
                return
            except BaseException as error:  # noqa: BLE001
                last_error = error
                if attempt < max_attempts and is_retryable(error):
                    time.sleep(backoff_delay_ms(attempt, base_delay, max_delay) / 1000.0)
                else:
                    break
        assert last_error is not None
        raise last_error

    def _ensure_delegate(self, token: str) -> SpanExporter:
        """Retorna um delegate cujo header Authorization casa com `token`."""
        if self._delegate is not None and self._delegate_token == token:
            return self._delegate
        previous = self._delegate
        self._delegate = self._create_delegate({"Authorization": f"Bearer {token}"})
        self._delegate_token = token
        if previous is not None:
            try:
                previous.shutdown()
            except Exception:
                pass
        return self._delegate

    @staticmethod
    def _export_once(delegate: SpanExporter, spans: List[ReadableSpan]) -> None:
        """Exporta uma vez: retorna em SUCCESS, lança em FAILURE."""
        result = delegate.export(spans)
        if result != SpanExportResult.SUCCESS:
            raise RuntimeError("OTLP export returned FAILED")

    def _log(self, level: str, message: str, meta: Dict[str, Any]) -> None:
        if self._logger is None:
            return
        fn = getattr(self._logger, level, None)
        if callable(fn):
            try:
                fn(message, meta)
            except Exception:
                pass


# ─── Factory do batch processor ──────────────────────────────────────────────────


def create_otlp_batch_processor(
    *,
    endpoint: str,
    token_provider: Any,
    create_delegate: Optional[DelegateFactory] = None,
    breaker: Optional[CircuitBreaker] = None,
    retry: Optional[Dict[str, Any]] = None,
    logger: Optional[Any] = None,
    max_queue_size: Optional[int] = None,
    max_export_batch_size: Optional[int] = None,
    schedule_delay_millis: Optional[float] = None,
    export_timeout_millis: Optional[float] = None,
) -> SpanProcessor:
    """Constrói um `BatchSpanProcessor` sobre um `ResilientAuthSpanExporter`
    (Requirement 7.1). O `init` anexa o processor retornado ao tracer provider."""
    exporter = ResilientAuthSpanExporter(
        endpoint=endpoint,
        token_provider=token_provider,
        create_delegate=create_delegate,
        breaker=breaker,
        retry=retry,
        logger=logger,
    )
    kwargs: Dict[str, Any] = {}
    if max_queue_size is not None:
        kwargs["max_queue_size"] = max_queue_size
    if max_export_batch_size is not None:
        kwargs["max_export_batch_size"] = max_export_batch_size
    if schedule_delay_millis is not None:
        kwargs["schedule_delay_millis"] = schedule_delay_millis
    if export_timeout_millis is not None:
        kwargs["export_timeout_millis"] = export_timeout_millis
    return BatchSpanProcessor(exporter, **kwargs)
