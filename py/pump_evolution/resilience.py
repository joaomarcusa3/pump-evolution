"""
resilience — primitivas self-contained de retry + circuit-breaker para o exporter
OTLP (Requirement 7.3). Paridade 1:1 com `src/resilience.ts`.

Implementadas AQUI de propósito (não reusadas de nenhum `cta-*`): o SDK é
instalado por terceiros e NÃO PODE depender de pacote interno. Retry e breaker
são responsabilidades separadas (SRP); o estado do breaker é POR INSTÂNCIA,
nunca global de módulo.
"""

from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Literal, Optional, TypeVar

_T = TypeVar("_T")

# ─── Circuit breaker (por instância — nunca global de módulo) ─────────────────

CircuitState = Literal["closed", "open", "half-open"]


def _default_now() -> float:
    """Relógio padrão em milissegundos (paridade com Date.now())."""
    return time.time() * 1000.0


class CircuitBreaker:
    """Circuit breaker mínimo cujo estado vive na INSTÂNCIA (um por target do
    exporter), pra um endpoint doente nunca derrubar fluxos não relacionados.

    Ciclo: `closed` → (falhas ≥ threshold) → `open` → (após cooldown) →
    `half-open` → (sucesso) → `closed`, ou (falha) → `open` de novo."""

    def __init__(
        self,
        failure_threshold: int = 5,
        cooldown_ms: float = 30_000,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self._failure_threshold = failure_threshold
        self._cooldown_ms = cooldown_ms
        self._now = now if now is not None else _default_now
        self._consecutive_failures = 0
        self._opened_at: Optional[float] = None
        self._half_open = False

    @property
    def state(self) -> CircuitState:
        """Estado atual, computando a transição half-open preguiçosamente."""
        if self._opened_at is None:
            return "closed"
        if self._now() - self._opened_at >= self._cooldown_ms:
            return "half-open"
        return "open"

    def can_attempt(self) -> bool:
        """Se uma chamada pode ser tentada agora (closed ou trial half-open)."""
        state = self.state
        if state == "open":
            return False
        if state == "half-open":
            self._half_open = True
        return True

    def record_success(self) -> None:
        """Registra sucesso — fecha o circuito e zera os contadores."""
        self._consecutive_failures = 0
        self._opened_at = None
        self._half_open = False

    def record_failure(self) -> None:
        """Registra falha — abre o circuito ao atingir o threshold."""
        # Um trial half-open que falha re-abre imediatamente pra novo cooldown.
        if self._half_open:
            self._half_open = False
            self._opened_at = self._now()
            return
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._failure_threshold:
            self._opened_at = self._now()


# ─── Retry com backoff exponencial ─────────────────────────────────────────────


def backoff_delay_ms(attempt: int, base_delay_ms: float, max_delay_ms: float) -> float:
    """Backoff exponencial para uma tentativa (1-based), limitado a max_delay_ms."""
    exp = base_delay_ms * (2 ** (attempt - 1))
    return min(exp, max_delay_ms)


async def _default_sleep(ms: float) -> None:
    await asyncio.sleep(ms / 1000.0)


async def with_retry(
    fn: Callable[[], Awaitable[_T]],
    *,
    max_attempts: int = 3,
    base_delay_ms: float = 200,
    max_delay_ms: float = 5_000,
    is_retryable: Optional[Callable[[BaseException], bool]] = None,
    sleep: Optional[Callable[[float], Awaitable[None]]] = None,
    on_retry: Optional[Callable[[int, BaseException], None]] = None,
) -> _T:
    """Roda `fn` com retry + backoff exponencial. Só re-tenta enquanto
    `is_retryable` retornar True e houver tentativas. O ÚLTIMO erro é relançado
    quando as tentativas acabam ou o erro não é retryable — o chamador decide
    como degradar (o exporter degrada em silêncio)."""

    retryable = is_retryable if is_retryable is not None else (lambda _e: True)
    do_sleep = sleep if sleep is not None else _default_sleep

    last_error: Optional[BaseException] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await fn()
        except BaseException as error:  # noqa: BLE001 — repassa o último erro adiante
            last_error = error
            can_retry = attempt < max_attempts and retryable(error)
            if not can_retry:
                break
            if on_retry is not None:
                on_retry(attempt, error)
            await do_sleep(backoff_delay_ms(attempt, base_delay_ms, max_delay_ms))
    assert last_error is not None
    raise last_error
