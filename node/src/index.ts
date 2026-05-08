export const DEFAULT_API_BASE_URL = "https://api.redpennon.dev";

export type UserContext = {
  id?: string;
  email?: string;
  organisation_id?: string;
  ip?: string;
  audiences?: string[];
};

export type EvaluateRequest = {
  feature: string;
  user?: UserContext;
};

export type EvaluateResponse = {
  feature: string;
  /**
   * The slug of the served variation, or `null` when the platform did
   * not serve a value for this environment (e.g. targeting is toggled
   * off, returning `reason: "targeting_disabled"`). When `null`, fall
   * back to whatever default value you hard-coded for the variable.
   */
  variation: string | null;
  variables: Record<string, unknown>;
  reason: string;
};

export type BatchRequest = {
  features: string[];
  user?: UserContext;
};

export type BatchResponse = {
  results: Record<string, EvaluateResponse>;
};

export class APIError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, message: string, body: string) {
    super(`redpennon: api error ${statusCode}: ${message}`);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export type ClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export class RedPennonClient {
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.origin = DEFAULT_API_BASE_URL.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async evaluate(input: EvaluateRequest): Promise<EvaluateResponse> {
    return this.postJson("/v1/evaluate", input);
  }

  async evaluateBatch(input: BatchRequest): Promise<BatchResponse> {
    return this.postJson("/v1/evaluate/batch", input);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.origin}${path}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        const j = JSON.parse(text) as { error?: string };
        if (typeof j.error === "string") message = j.error;
      } catch {
        // keep raw text
      }
      throw new APIError(res.status, message, text);
    }
    return JSON.parse(text) as T;
  }
}
