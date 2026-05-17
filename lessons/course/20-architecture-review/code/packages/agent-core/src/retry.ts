/**
 * Lesson 19: Exponential backoff retry wrapper.
 *
 * Inspired by pi's agent-session.ts retry logic.
 */

export interface RetryConfig {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries: number;
  /** Base delay in milliseconds. Default: 2000 */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 60000 */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
};

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

/**
 * Sleep for the specified duration, abortable via signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Error classification: does this error warrant a retry?
 *
 * Matches the pattern from pi's _isRetryableError():
 * - Rate limits (429)
 * - Server errors (500, 502, 503, 504)
 * - Network errors (connection refused, timeout, etc.)
 * - Provider overload
 *
 * Context overflow is NOT retryable (needs compaction instead).
 */
export function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  // Context overflow should be handled by compaction, not retry
  if (/context.*(overflow|too long|limit exceeded)/i.test(message)) {
    return false;
  }

  // Auth errors are not retryable
  if (/401|403|unauthorized|forbidden/i.test(message)) {
    return false;
  }

  // Client errors (bad request) are not retryable
  if (/400|bad request|invalid/i.test(message)) {
    return false;
  }

  // These are retryable
  return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|socket hang up|timed? ?out|timeout|terminated|econnreset|econnrefused|epipe/i.test(
    message,
  );
}

export interface RetryCallbacks {
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: Error) => void;
  onSuccess?: (attempts: number) => void;
  onGiveUp?: (attempts: number, lastError: Error) => void;
}

/**
 * Execute a function with automatic retry and exponential backoff.
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration
 * @param isRetryable - Optional custom error classifier. Defaults to isRetryableError.
 * @param signal - Optional AbortSignal to cancel during retry wait
 * @param callbacks - Optional callbacks for retry lifecycle events
 * @returns The result with metadata about how many attempts were needed
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetch("https://api.example.com/chat"),
 *   { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 },
 * );
 * console.log(`Succeeded after ${result.attempts} attempt(s)`);
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  isRetryable: (error: unknown) => boolean = isRetryableError,
  signal?: AbortSignal,
  callbacks?: RetryCallbacks,
): Promise<RetryResult<T>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const value = await fn();

      if (attempt > 0) {
        callbacks?.onSuccess?.(attempt + 1);
      }

      return { value, attempts: attempt + 1 };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Non-retryable errors propagate immediately
      if (!isRetryable(error)) {
        throw lastError;
      }

      // Exhausted all retries
      if (attempt >= config.maxRetries) {
        callbacks?.onGiveUp?.(attempt + 1, lastError);
        break;
      }

      // Calculate delay: baseDelay * 2^attempt, capped at maxDelay
      const delay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);

      callbacks?.onRetry?.(attempt + 1, config.maxRetries, delay, lastError);

      // Abortable sleep
      await sleep(delay, signal);
    }
  }

  throw lastError ?? new Error("withRetry: unexpected state");
}
