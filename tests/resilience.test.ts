import { describe, expect, it, vi } from 'vitest';

import { backoffDelayMs, CircuitBreaker, withRetry } from '../src/index.js';

// ─── CircuitBreaker ────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('stays closed and allows attempts until the failure threshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => 0 });
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('opens after reaching the threshold and blocks attempts during cooldown', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canAttempt()).toBe(false);

    now = 500; // still within cooldown
    expect(breaker.canAttempt()).toBe(false);
  });

  it('goes half-open after cooldown, then closes on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
    breaker.recordFailure();
    expect(breaker.state).toBe('open');

    now = 1000; // cooldown elapsed
    expect(breaker.state).toBe('half-open');
    expect(breaker.canAttempt()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('re-opens for a fresh cooldown when the half-open trial fails', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now });
    breaker.recordFailure();

    now = 1000;
    expect(breaker.canAttempt()).toBe(true); // half-open trial taken
    breaker.recordFailure(); // trial failed → re-open at now=1000

    now = 1500;
    expect(breaker.canAttempt()).toBe(false); // cooldown restarted at 1000
    now = 2000;
    expect(breaker.state).toBe('half-open');
  });
});

// ─── withRetry ──────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  const noSleep = () => Promise.resolve();

  it('returns immediately on first success (no retries)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('5xx')).mockResolvedValue('recovered');
    const onRetry = vi.fn();
    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep, onRetry })).resolves.toBe(
      'recovered',
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not retry when isRetryable returns false', async () => {
    const boom = new Error('4xx');
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(
      withRetry(fn, { maxAttempts: 5, sleep: noSleep, isRetryable: () => false }),
    ).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValue(new Error('e3'));
    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toThrow('e3');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('caps exponential backoff at maxDelayMs', () => {
    expect(backoffDelayMs(1, 200, 5000)).toBe(200);
    expect(backoffDelayMs(2, 200, 5000)).toBe(400);
    expect(backoffDelayMs(10, 200, 5000)).toBe(5000); // capped
  });
});
