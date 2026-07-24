export interface RetryDelayPort {
  sleep(durationMs: number): Promise<void>;
}

export interface ProviderRetryOptions {
  readonly operation: string;
  /** Writes may only be retried when the provider operation has a stable idempotency key. */
  readonly safety: Readonly<
    | { readonly kind: "read" }
    | { readonly kind: "idempotent_write"; readonly idempotencyKey: string }
  >;
  readonly timeoutMs: number;
  readonly maximumAttempts: number;
  readonly initialBackoffMs: number;
  readonly maximumBackoffMs: number;
  readonly retryable: (error: unknown) => boolean;
}

export class ProviderTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderRetryExhaustedError extends Error {
  public constructor(operation: string, attempts: number, cause: unknown) {
    super(`${operation} failed after ${attempts} attempts`, { cause });
    this.name = "ProviderRetryExhaustedError";
  }
}

function validate(options: ProviderRetryOptions): void {
  if (options.operation.length === 0 || options.operation.length > 128) {
    throw new RangeError("provider operation must contain 1-128 characters");
  }
  if (
    options.safety.kind === "idempotent_write" &&
    (options.safety.idempotencyKey.length === 0 || options.safety.idempotencyKey.length > 256)
  ) {
    throw new RangeError("idempotent provider writes require a 1-256 character idempotency key");
  }
  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs],
    ["maximumAttempts", options.maximumAttempts],
    ["initialBackoffMs", options.initialBackoffMs],
    ["maximumBackoffMs", options.maximumBackoffMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (options.maximumAttempts > 20 || options.maximumBackoffMs < options.initialBackoffMs) {
    throw new RangeError("invalid provider retry bounds");
  }
}

async function withTimeout<Result>(
  operation: string,
  timeoutMs: number,
  callback: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([callback(controller.signal), expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Deterministic backoff for reads and provider writes protected by stable idempotency keys. */
export async function executeWithProviderRetry<Result>(
  callback: (attempt: number, signal: AbortSignal) => Promise<Result>,
  delay: RetryDelayPort,
  options: ProviderRetryOptions,
): Promise<Result> {
  validate(options);
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
    try {
      return await withTimeout(options.operation, options.timeoutMs, (signal) => callback(attempt, signal));
    } catch (error) {
      lastError = error;
      if (!options.retryable(error)) throw error;
      if (attempt === options.maximumAttempts) break;
      const exponent = Math.min(attempt - 1, 30);
      const backoff = Math.min(options.initialBackoffMs * (2 ** exponent), options.maximumBackoffMs);
      await delay.sleep(backoff);
    }
  }
  throw new ProviderRetryExhaustedError(options.operation, options.maximumAttempts, lastError);
}
