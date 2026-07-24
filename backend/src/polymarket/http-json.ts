import type { z } from "zod";

export type FetchPort = (input: string, init: RequestInit) => Promise<Response>;

export class HttpTimeoutError extends Error {
  public constructor(url: string, timeoutMs: number) {
    super(`HTTP request to ${url} exceeded ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

export class HttpStatusError extends Error {
  public constructor(
    public readonly status: number,
    url: string,
    responseBody: string,
  ) {
    super(`HTTP ${status} from ${url}: ${responseBody.slice(0, 256)}`);
    this.name = "HttpStatusError";
  }
}

export class ResponseValidationError extends Error {
  public constructor(url: string, reason: string) {
    super(`Invalid JSON response from ${url}: ${reason}`);
    this.name = "ResponseValidationError";
  }
}

export interface JsonHttpClientOptions {
  readonly fetch: FetchPort;
  readonly timeoutMs?: number;
}

export class JsonHttpClient {
  private readonly timeoutMs: number;

  public constructor(private readonly options: JsonHttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
  }

  public async get<Schema extends z.ZodTypeAny>(
    url: string,
    schema: Schema,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<z.output<Schema>> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.options.fetch(url, {
        method: "GET",
        headers: Object.freeze({ accept: "application/json", ...headers }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new HttpStatusError(response.status, url, body);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "malformed JSON";
        throw new ResponseValidationError(url, reason);
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new ResponseValidationError(url, result.error.issues.map((issue) => issue.message).join("; "));
      }
      return result.data;
    } catch (error) {
      if (timedOut) {
        throw new HttpTimeoutError(url, this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async post<Schema extends z.ZodTypeAny>(
    url: string,
    body: unknown,
    schema: Schema,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<z.output<Schema>> {
    return this.request(url, {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      }),
      body: JSON.stringify(body),
    }, schema);
  }

  public async postSerialized<Schema extends z.ZodTypeAny>(
    url: string,
    serializedJsonBody: string,
    schema: Schema,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<z.output<Schema>> {
    if (
      serializedJsonBody.length === 0 ||
      serializedJsonBody.length > 262_144 ||
      !serializedJsonBody.startsWith("{")
    ) {
      throw new TypeError("serialized JSON body is invalid");
    }
    try {
      JSON.parse(serializedJsonBody);
    } catch {
      throw new TypeError("serialized JSON body is malformed");
    }
    return this.request(url, {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      }),
      body: serializedJsonBody,
    }, schema);
  }

  private async request<Schema extends z.ZodTypeAny>(
    url: string,
    init: RequestInit,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.options.fetch(url, { ...init, signal: controller.signal });
      const responseBody = await response.text();
      if (!response.ok) throw new HttpStatusError(response.status, url, responseBody);
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody) as unknown;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "malformed JSON";
        throw new ResponseValidationError(url, reason);
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new ResponseValidationError(url, result.error.issues.map((issue) => issue.message).join("; "));
      }
      return result.data;
    } catch (error) {
      if (timedOut) throw new HttpTimeoutError(url, this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
