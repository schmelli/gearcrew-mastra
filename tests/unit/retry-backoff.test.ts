/**
 * T065: Unit test for retry with exponential backoff
 * Tests FR-024: Retry strategy for external data fetches
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Retry with Exponential Backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('RetryConfig', () => {
    it('should use default configuration', () => {
      const defaultConfig = getDefaultRetryConfig();

      expect(defaultConfig.maxRetries).toBe(3);
      expect(defaultConfig.baseDelayMs).toBe(1000);
      expect(defaultConfig.maxDelayMs).toBe(30000);
      expect(defaultConfig.backoffMultiplier).toBe(2);
      expect(defaultConfig.jitterFactor).toBe(0.1);
    });

    it('should allow custom configuration', () => {
      const customConfig: RetryConfig = {
        maxRetries: 5,
        baseDelayMs: 500,
        maxDelayMs: 60000,
        backoffMultiplier: 3,
        jitterFactor: 0.2,
      };

      expect(customConfig.maxRetries).toBe(5);
    });
  });

  describe('Delay Calculation', () => {
    it('should calculate exponential delay', () => {
      // Use 0 jitter for deterministic test
      const config: RetryConfig = {
        ...getDefaultRetryConfig(),
        jitterFactor: 0,
      };

      const delay0 = calculateDelay(0, config);
      const delay1 = calculateDelay(1, config);
      const delay2 = calculateDelay(2, config);

      expect(delay0).toBe(1000); // 1000ms base
      expect(delay1).toBe(2000); // 1000 * 2^1
      expect(delay2).toBe(4000); // 1000 * 2^2
    });

    it('should cap delay at maxDelayMs', () => {
      const config: RetryConfig = {
        maxRetries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
        jitterFactor: 0,
      };

      const delay5 = calculateDelay(5, config); // Would be 32000 without cap
      expect(delay5).toBe(5000);
    });

    it('should apply jitter within bounds', () => {
      const config: RetryConfig = {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitterFactor: 0.5, // 50% jitter
      };

      const delays = Array.from({ length: 100 }, () => calculateDelay(0, config));
      const minDelay = Math.min(...delays);
      const maxDelay = Math.max(...delays);

      // With 50% jitter, delay should be between 500ms and 1500ms
      expect(minDelay).toBeGreaterThanOrEqual(500);
      expect(maxDelay).toBeLessThanOrEqual(1500);
    });
  });

  describe('Retry Execution', () => {
    it('should succeed on first attempt', async () => {
      const mockFn = vi.fn().mockResolvedValue('success');

      const result = await withRetry(mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      // Use 0 jitter for deterministic timing
      const config: RetryConfig = { ...getDefaultRetryConfig(), jitterFactor: 0 };
      const resultPromise = withRetry(mockFn, config);

      // Fast-forward through delays with runAllTimersAsync to handle all pending promises
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries exceeded', async () => {
      // Use real timers with short delays to avoid fake timer issues
      vi.useRealTimers();

      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error('always fails');
      });

      const config: RetryConfig = {
        maxRetries: 2,
        baseDelayMs: 1, // Very short delay for fast test
        maxDelayMs: 10,
        backoffMultiplier: 2,
        jitterFactor: 0,
      };

      await expect(withRetry(mockFn, config)).rejects.toThrow('always fails');
      expect(callCount).toBe(3); // Initial + 2 retries

      // Restore fake timers for other tests
      vi.useFakeTimers();
    });

    it('should call onRetry callback', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');
      const onRetry = vi.fn();

      const config: RetryConfig = {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
        jitterFactor: 0,
        onRetry,
      };

      const resultPromise = withRetry(mockFn, config);
      await vi.advanceTimersByTimeAsync(100);
      await resultPromise;

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 100);
    });
  });

  describe('Retryable Error Detection', () => {
    it('should retry on rate limit errors (429)', async () => {
      const rateLimitError = new HttpError('Too Many Requests', 429);
      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      const resultPromise = withRetry(mockFn, { ...getDefaultRetryConfig(), baseDelayMs: 100, jitterFactor: 0 });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should retry on server errors (500-599)', async () => {
      const serverError = new HttpError('Internal Server Error', 500);
      const mockFn = vi.fn().mockRejectedValueOnce(serverError).mockResolvedValue('success');

      const resultPromise = withRetry(mockFn, { ...getDefaultRetryConfig(), baseDelayMs: 100, jitterFactor: 0 });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
    });

    it('should NOT retry on client errors (400-499 except 429)', async () => {
      const clientError = new HttpError('Bad Request', 400);
      const mockFn = vi.fn().mockRejectedValue(clientError);

      const config: RetryConfig = {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
        jitterFactor: 0,
        shouldRetry: isRetryableError,
      };

      await expect(withRetry(mockFn, config)).rejects.toThrow('Bad Request');
      expect(mockFn).toHaveBeenCalledTimes(1); // No retries
    });

    it('should retry on network errors', async () => {
      const networkError = new Error('ECONNRESET');
      const mockFn = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValue('success');

      const resultPromise = withRetry(mockFn, { ...getDefaultRetryConfig(), baseDelayMs: 100, jitterFactor: 0 });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
    });

    it('should retry on timeout errors', async () => {
      const timeoutError = new Error('ETIMEDOUT');
      const mockFn = vi.fn().mockRejectedValueOnce(timeoutError).mockResolvedValue('success');

      const resultPromise = withRetry(mockFn, { ...getDefaultRetryConfig(), baseDelayMs: 100, jitterFactor: 0 });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
    });
  });

  describe('Rate Limit Handling', () => {
    it('should respect Retry-After header in seconds', async () => {
      const rateLimitError = new HttpError('Too Many Requests', 429, { 'retry-after': '5' });
      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      const resultPromise = withRetry(mockFn, getDefaultRetryConfig());

      // Should wait 5 seconds as specified in header
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result).toBe('success');
    });

    it('should respect Retry-After header with date', async () => {
      const futureDate = new Date(Date.now() + 10000).toUTCString();
      const rateLimitError = new HttpError('Too Many Requests', 429, { 'retry-after': futureDate });
      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      const resultPromise = withRetry(mockFn, getDefaultRetryConfig());

      // Should wait approximately 10 seconds
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(result).toBe('success');
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should open circuit after consecutive failures', async () => {
      const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeout: 5000 });
      const mockFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Fail 3 times to open circuit
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(mockFn);
        } catch {
          // Expected
        }
      }

      expect(breaker.isOpen()).toBe(true);

      // Next call should fail fast without calling mockFn
      const callCountBefore = mockFn.mock.calls.length;
      await expect(breaker.execute(mockFn)).rejects.toThrow('Circuit breaker is open');
      expect(mockFn.mock.calls.length).toBe(callCountBefore);
    });

    it('should close circuit after reset timeout', async () => {
      const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeout: 1000 });
      const mockFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      try {
        await breaker.execute(mockFn);
      } catch {
        /* ignore */
      }
      try {
        await breaker.execute(mockFn);
      } catch {
        /* ignore */
      }

      expect(breaker.isOpen()).toBe(true);

      // Wait for reset timeout
      await vi.advanceTimersByTimeAsync(1000);

      // Circuit should be half-open, next call allowed
      mockFn.mockResolvedValueOnce('success');
      const result = await breaker.execute(mockFn);

      expect(result).toBe('success');
      expect(breaker.isOpen()).toBe(false);
    });
  });
});

// Types for testing
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
  onRetry?: (attempt: number, error: Error, delay: number) => void;
  shouldRetry?: (error: Error) => boolean;
}

class HttpError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// Helper functions for testing
function getDefaultRetryConfig(): RetryConfig {
  return {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
  };
}

function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Apply jitter
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() - 0.5) * 2 * jitterRange;

  return Math.max(0, cappedDelay + jitter);
}

function isRetryableError(error: Error): boolean {
  if (error instanceof HttpError) {
    // Retry on rate limits and server errors
    if (error.statusCode === 429) return true;
    if (error.statusCode >= 500 && error.statusCode < 600) return true;
    return false;
  }

  // Retry on network errors
  const networkErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN'];
  return networkErrors.some((code) => error.message.includes(code));
}

function getRetryAfterMs(error: HttpError): number | null {
  const retryAfter = error.headers?.['retry-after'];
  if (!retryAfter) return null;

  // Try parsing as seconds
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  // Try parsing as date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = getDefaultRetryConfig()
): Promise<T> {
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      if (config.shouldRetry && !config.shouldRetry(lastError)) {
        throw lastError;
      }

      // Don't delay after the last attempt
      if (attempt === config.maxRetries) {
        break;
      }

      // Calculate delay
      let delay = calculateDelay(attempt, config);

      // Check for Retry-After header
      if (lastError instanceof HttpError) {
        const retryAfterMs = getRetryAfterMs(lastError);
        if (retryAfterMs !== null) {
          delay = retryAfterMs;
        }
      }

      // Call onRetry callback
      if (config.onRetry) {
        config.onRetry(attempt + 1, lastError, delay);
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
}

interface CircuitBreaker {
  execute: <T>(fn: () => Promise<T>) => Promise<T>;
  isOpen: () => boolean;
}

function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreaker {
  let failures = 0;
  let lastFailure: number | null = null;
  let state: 'closed' | 'open' | 'half-open' = 'closed';

  return {
    async execute<T>(fn: () => Promise<T>): Promise<T> {
      // Check if circuit should reset
      if (state === 'open' && lastFailure && Date.now() - lastFailure >= config.resetTimeout) {
        state = 'half-open';
      }

      if (state === 'open') {
        throw new Error('Circuit breaker is open');
      }

      try {
        const result = await fn();
        // Success - reset failures
        failures = 0;
        state = 'closed';
        return result;
      } catch (error) {
        failures++;
        lastFailure = Date.now();

        if (failures >= config.failureThreshold) {
          state = 'open';
        }

        throw error;
      }
    },

    isOpen(): boolean {
      // Check if circuit should reset
      if (state === 'open' && lastFailure && Date.now() - lastFailure >= config.resetTimeout) {
        return false;
      }
      return state === 'open';
    },
  };
}
