/**
 * Error Handling Utilities
 * Implements FR-025a: Retry with exponential backoff
 * Implements circuit breaker pattern for external API protection
 */

// ============================================================================
// Custom Error Types
// ============================================================================

export class GardeningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean = true
  ) {
    super(message);
    this.name = 'GardeningError';
  }
}

export class RetryableError extends GardeningError {
  constructor(
    message: string,
    public readonly retryCount: number = 0,
    public readonly maxRetries: number = 3
  ) {
    super(message, 'RETRYABLE', true);
    this.name = 'RetryableError';
  }
}

export class CircuitBreakerOpenError extends GardeningError {
  constructor(
    message: string,
    public readonly resetTime: Date
  ) {
    super(message, 'CIRCUIT_OPEN', false);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class ValidationError extends GardeningError {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message, 'VALIDATION', false);
    this.name = 'ValidationError';
  }
}

export class CatastrophicOperationError extends GardeningError {
  constructor(message: string) {
    super(message, 'CATASTROPHIC', false);
    this.name = 'CatastrophicOperationError';
  }
}

// ============================================================================
// Retry with Exponential Backoff
// ============================================================================

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 64000,
  backoffMultiplier: 2,
  shouldRetry: () => true,
  onRetry: () => {},
};

/**
 * Execute a function with exponential backoff retry
 * Per FR-025a: Retry 3 times with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;
  let delayMs = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Check if we should retry
      if (!opts.shouldRetry(error)) {
        break;
      }

      // Notify retry callback
      opts.onRetry(error, attempt + 1, delayMs);

      // Wait before retry
      await sleep(delayMs);

      // Increase delay for next retry
      delayMs = Math.min(delayMs * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError;
}

// ============================================================================
// Circuit Breaker Pattern
// ============================================================================

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutMs?: number;
  windowMs?: number;
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: number[] = [];
  private successes = 0;
  private lastFailureTime?: Date;
  private options: Required<CircuitBreakerOptions>;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      successThreshold: options.successThreshold ?? 3,
      timeoutMs: options.timeoutMs ?? 60000, // 1 minute
      windowMs: options.windowMs ?? 300000, // 5 minutes
    };
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    this.checkTimeout();

    if (this.state === 'OPEN') {
      const resetTime = new Date(
        (this.lastFailureTime?.getTime() ?? Date.now()) + this.options.timeoutMs
      );
      throw new CircuitBreakerOpenError(
        `Circuit breaker "${this.name}" is open`,
        resetTime
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Record a successful execution
   */
  private recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this.state = 'CLOSED';
        this.failures = [];
        this.successes = 0;
        console.info(`Circuit breaker "${this.name}" closed`);
      }
    }
  }

  /**
   * Record a failed execution
   */
  private recordFailure(): void {
    const now = Date.now();
    this.lastFailureTime = new Date(now);
    this.failures.push(now);
    this.successes = 0;

    // Remove failures outside the window
    const windowStart = now - this.options.windowMs;
    this.failures = this.failures.filter((t) => t > windowStart);

    // Check if we should open the circuit
    if (this.failures.length >= this.options.failureThreshold) {
      this.state = 'OPEN';
      console.warn(`Circuit breaker "${this.name}" opened after ${this.failures.length} failures`);
    }
  }

  /**
   * Check if timeout has passed and transition to HALF_OPEN
   */
  private checkTimeout(): void {
    if (this.state === 'OPEN' && this.lastFailureTime) {
      const elapsed = Date.now() - this.lastFailureTime.getTime();
      if (elapsed >= this.options.timeoutMs) {
        this.state = 'HALF_OPEN';
        console.info(`Circuit breaker "${this.name}" transitioned to half-open`);
      }
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    this.checkTimeout();
    return this.state;
  }

  /**
   * Get failure rate (percentage)
   */
  getFailureRate(): number {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    const recentFailures = this.failures.filter((t) => t > windowStart).length;
    return (recentFailures / this.options.failureThreshold) * 100;
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = [];
    this.successes = 0;
    this.lastFailureTime = undefined;
  }
}

// ============================================================================
// Circuit Breaker Registry
// ============================================================================

const circuitBreakers: Map<string, CircuitBreaker> = new Map();

export function getCircuitBreaker(
  name: string,
  options?: CircuitBreakerOptions
): CircuitBreaker {
  let breaker = circuitBreakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, options);
    circuitBreakers.set(name, breaker);
  }
  return breaker;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof GardeningError) {
    return error.recoverable;
  }

  // Network errors are typically retryable
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('network') ||
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('503')
    );
  }

  return false;
}

/**
 * Wrap a function with both retry and circuit breaker
 */
export async function withProtection<T>(
  name: string,
  fn: () => Promise<T>,
  options?: RetryOptions & CircuitBreakerOptions
): Promise<T> {
  const breaker = getCircuitBreaker(name, options);

  return breaker.execute(() =>
    withRetry(fn, {
      ...options,
      shouldRetry: isRetryableError,
    })
  );
}

export default {
  withRetry,
  withProtection,
  getCircuitBreaker,
  isRetryableError,
  sleep,
};
