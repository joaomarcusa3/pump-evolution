/**
 * resilience — self-contained retry + circuit-breaker primitives for the OTLP
 * exporter (Requirement 7.3).
 *
 * These are deliberately implemented HERE rather than reused from
 * `@a3data/cta-core`'s `CircuitBreaker`: the SDK is installed by external agent
 * developers and MUST NOT depend on any internal `cta-*` package (Requirement
 * 1.4). The design mirrors the repo's own resilience contract (retry and breaker
 * are separate responsibilities — SRP; the breaker state is PER INSTANCE, never
 * module-global — see `anti-patterns.md` §12).
 */

// ─── Circuit breaker (per instance — never module-global) ─────────────────────

/** Circuit-breaker state. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Options for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the circuit open. Default 5. */
  readonly failureThreshold?: number;
  /** Milliseconds the circuit stays open before a half-open trial. Default 30s. */
  readonly cooldownMs?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A minimal circuit breaker whose state lives on the INSTANCE (one per exporter
 * target), so an unhealthy endpoint never trips unrelated flows.
 *
 * Lifecycle: `closed` → (failures ≥ threshold) → `open` → (after cooldown) →
 * `half-open` → (success) → `closed`, or (failure) → `open` again.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private halfOpen = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Current state, computing the half-open transition lazily. */
  get state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    if (this.now() - this.openedAt >= this.cooldownMs) return 'half-open';
    return 'open';
  }

  /** Whether a call may be attempted now (closed or half-open trial). */
  canAttempt(): boolean {
    const state = this.state;
    if (state === 'open') return false;
    if (state === 'half-open') this.halfOpen = true;
    return true;
  }

  /** Records a success — closes the circuit and resets counters. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.halfOpen = false;
  }

  /** Records a failure — opens the circuit when the threshold is reached. */
  recordFailure(): void {
    // A failed half-open trial immediately re-opens for a fresh cooldown.
    if (this.halfOpen) {
      this.halfOpen = false;
      this.openedAt = this.now();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}

// ─── Retry with exponential backoff ────────────────────────────────────────────

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Max attempts INCLUDING the first. Default 3. */
  readonly maxAttempts?: number;
  /** Base backoff delay (ms). Default 200. */
  readonly baseDelayMs?: number;
  /** Backoff cap (ms). Default 5000. */
  readonly maxDelayMs?: number;
  /** Predicate: is this error/outcome retryable? Default: always retry. */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Injectable sleep (ms). Default a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Optional hook invoked before each retry (attempt index, error). */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Exponential backoff for a given (1-based) attempt, capped at `maxDelayMs`. */
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exp, maxDelayMs);
}

/**
 * Runs `fn` with retry + exponential backoff. Retries only while `isRetryable`
 * returns `true` and attempts remain. The LAST error is re-thrown when attempts
 * are exhausted or the error is not retryable — the caller decides how to
 * degrade (the exporter degrades silently).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetryable(error);
      if (!canRetry) break;
      options.onRetry?.(attempt, error);
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }
  throw lastError;
}
