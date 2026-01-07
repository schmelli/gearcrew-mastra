/**
 * T087: Circuit Breaker Pattern
 * Protects external API calls with automatic failure recovery
 */

import { incrementCounter, observeHistogram, startTimer } from './metrics';

// ============================================================================
// Types
// ============================================================================

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms before attempting recovery */
  resetTimeout: number;
  /** Number of successes needed to close circuit from half-open */
  successThreshold: number;
  /** Time window in ms for failure counting */
  failureWindow: number;
  /** Name for logging/metrics */
  name: string;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
  failureWindow: 60000, // 1 minute
};

// ============================================================================
// Circuit Breaker Implementation
// ============================================================================

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'closed';
  private failures: number[] = [];
  private halfOpenSuccesses = 0;
  private lastStateChange: Date = new Date();
  private stats: {
    totalCalls: number;
    totalFailures: number;
    totalSuccesses: number;
    lastFailure: Date | null;
    lastSuccess: Date | null;
  } = {
    totalCalls: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    lastFailure: null,
    lastSuccess: null,
  };

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.stats.totalCalls++;

    // Check circuit state
    if (this.state === 'open') {
      // Check if we should try half-open
      const timeSinceOpen = Date.now() - this.lastStateChange.getTime();
      if (timeSinceOpen >= this.config.resetTimeout) {
        this.transition('half-open');
      } else {
        incrementCounter('external_api_requests_total', {
          api: this.config.name,
          status: 'circuit_open',
        });
        throw new CircuitOpenError(
          `Circuit breaker ${this.config.name} is open`,
          this.config.resetTimeout - timeSinceOpen
        );
      }
    }

    // Execute the function
    const stopTimer = startTimer('external_api_duration_seconds', {
      api: this.config.name,
    });

    try {
      const result = await fn();
      this.recordSuccess();
      stopTimer();
      return result;
    } catch (error) {
      stopTimer();
      this.recordFailure(error as Error);
      throw error;
    }
  }

  /**
   * Record a successful call
   */
  private recordSuccess(): void {
    this.stats.totalSuccesses++;
    this.stats.lastSuccess = new Date();

    incrementCounter('external_api_requests_total', {
      api: this.config.name,
      status: 'success',
    });

    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transition('closed');
      }
    }
  }

  /**
   * Record a failed call
   */
  private recordFailure(error: Error): void {
    this.stats.totalFailures++;
    this.stats.lastFailure = new Date();

    incrementCounter('external_api_requests_total', {
      api: this.config.name,
      status: 'failure',
    });

    const now = Date.now();
    this.failures.push(now);

    // Clean old failures outside the window
    this.failures = this.failures.filter(
      (f) => now - f < this.config.failureWindow
    );

    if (this.state === 'half-open') {
      // Any failure in half-open returns to open
      this.transition('open');
    } else if (this.state === 'closed') {
      // Check if we've exceeded failure threshold
      if (this.failures.length >= this.config.failureThreshold) {
        this.transition('open');
      }
    }
  }

  /**
   * Transition to a new state
   */
  private transition(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = new Date();

    if (newState === 'closed') {
      this.failures = [];
      this.halfOpenSuccesses = 0;
    } else if (newState === 'half-open') {
      this.halfOpenSuccesses = 0;
    }

    console.log(
      `CircuitBreaker ${this.config.name}: ${oldState} -> ${newState}`
    );
  }

  /**
   * Get current statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures.length,
      successes: this.halfOpenSuccesses,
      lastFailure: this.stats.lastFailure,
      lastSuccess: this.stats.lastSuccess,
      totalCalls: this.stats.totalCalls,
      totalFailures: this.stats.totalFailures,
      totalSuccesses: this.stats.totalSuccesses,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.transition('closed');
  }

  /**
   * Manually trip the circuit breaker
   */
  trip(): void {
    this.transition('open');
  }
}

// ============================================================================
// Custom Error
// ============================================================================

export class CircuitOpenError extends Error {
  constructor(
    message: string,
    public retryAfterMs: number
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

// ============================================================================
// Circuit Breaker Registry
// ============================================================================

const circuitBreakers: Map<string, CircuitBreaker> = new Map();

/**
 * Get or create a circuit breaker for a service
 */
export function getCircuitBreaker(
  name: string,
  config?: Partial<Omit<CircuitBreakerConfig, 'name'>>
): CircuitBreaker {
  let breaker = circuitBreakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker({ name, ...config });
    circuitBreakers.set(name, breaker);
  }
  return breaker;
}

/**
 * Execute with a named circuit breaker
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  config?: Partial<Omit<CircuitBreakerConfig, 'name'>>
): Promise<T> {
  const breaker = getCircuitBreaker(name, config);
  return breaker.execute(fn);
}

/**
 * Get all circuit breaker stats
 */
export function getAllCircuitBreakerStats(): Record<string, CircuitBreakerStats> {
  const stats: Record<string, CircuitBreakerStats> = {};
  for (const [name, breaker] of circuitBreakers) {
    stats[name] = breaker.getStats();
  }
  return stats;
}

/**
 * Reset all circuit breakers
 */
export function resetAllCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
}

// ============================================================================
// Retry with Circuit Breaker
// ============================================================================

export interface RetryWithCircuitBreakerConfig {
  circuitBreakerName: string;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Execute with retry and circuit breaker
 */
export async function retryWithCircuitBreaker<T>(
  fn: () => Promise<T>,
  config: Partial<RetryWithCircuitBreakerConfig> & { circuitBreakerName: string }
): Promise<T> {
  const {
    circuitBreakerName,
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
  } = config;

  const breaker = getCircuitBreaker(circuitBreakerName);
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await breaker.execute(fn);
    } catch (error) {
      lastError = error as Error;

      // Don't retry if circuit is open
      if (error instanceof CircuitOpenError) {
        throw error;
      }

      // Don't delay after the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt),
        maxDelayMs
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export default {
  CircuitBreaker,
  CircuitOpenError,
  getCircuitBreaker,
  withCircuitBreaker,
  getAllCircuitBreakerStats,
  resetAllCircuitBreakers,
  retryWithCircuitBreaker,
};
