/**
 * RedPennon Node SDK — variable-key evaluation client.
 *
 * Two evaluation methods cover the two SDK ergonomics teams reach
 * for:
 *
 *   * {@link RedPennonClient.variableValue} — "give me the value, or
 *     this fallback". Returns the resolved value or the
 *     developer-supplied default. Network failures swallow into the
 *     default so the calling app never crashes because the API is
 *     unreachable; the developer's code default is the contract.
 *
 *   * {@link RedPennonClient.variable} — "give me the full result
 *     object". Returns the typed result (`value`, `variation`,
 *     `reason`, `feature`) so callers can branch on `reason` for
 *     telemetry, dashboards, or per-state UI. Network failures
 *     surface as {@link APIError}; callers opting into the result
 *     shape opt into error handling.
 *
 * Batch evaluation ({@link RedPennonClient.variables}) lets one HTTP
 * round-trip resolve many flags for the same user context.
 */

export const DEFAULT_API_BASE_URL = "https://api.redpennon.dev";

export type UserContext = {
  id?: string;
  email?: string;
  organisation_id?: string;
  ip?: string;
  audiences?: string[];
  /**
   * Application version string supplied by the calling app. The
   * evaluator treats it as opaque text — operators like `is`,
   * `contains`, and `starts_with` work; numeric/semver comparisons do
   * not. Server-side SDKs can't auto-detect this, so populate it
   * manually if you need to target on it.
   */
  app_version?: string;
  /**
   * Free-form platform identifier (e.g. `"ios"`, `"android"`,
   * `"web"`). Server-side SDKs don't auto-populate this either.
   */
  platform?: string;
  /**
   * ISO-3166 alpha-2 country code (e.g. `"AU"`, `"US"`).
   */
  country?: string;
  /**
   * Arbitrary user attributes for `custom_property` targeting
   * conditions. Keys are looked up by the rule's `custom_key`; values
   * may be strings, numbers, booleans, or arrays of strings.
   */
  custom_data?: Record<string, unknown>;
};

/**
 * Reasons surfaced by the evaluation engine. Mirrors the server-side
 * constants 1:1 so SDK consumers can switch on the string value.
 */
export type EvaluationReason =
  | "targeting_rule_matched"
  | "default_variation"
  | "no_rule_matched"
  | "targeting_disabled"
  | "feature_complete"
  | "feature_deleted"
  | "feature_archived"
  | "self_targeting_override"
  | "variable_not_found";

export type VariableResult<T> = {
  key: string;
  /** Resolved value, or `null` when the platform served no value. */
  value: T | null;
  /** Variation slug served, or `null` when no value was served. */
  variation: string | null;
  reason: EvaluationReason;
  /** Parent feature slug, or `null` when the key didn't resolve. */
  feature: string | null;
  /** Opaque signed trace token returned by the server when the user has stable identity (`id` or `email`). `null` or absent when not available. Pass to `trackEvents` to correlate metric events with evaluations. */
  evaluation_trace?: string | null;
};

export type BatchResults = Record<string, VariableResult<unknown>>;

export type EventPayload = {
  event: string;
  variable: string;
  variation: string;
  user?: UserContext;
  value?: number;
  /** ISO-8601 timestamp; defaults to server receive time when omitted. */
  occurred_at?: string;
  /** Opaque trace token from a prior {@link VariableResult.evaluation_trace}. */
  evaluation_trace?: string;
  /**
   * De-duplication key, unique per environment, at most 200 characters.
   *
   * Send one and a retry after a timeout is free: the platform skips
   * keys it has already stored instead of counting the event twice.
   * Omit it and repeats are stored — which is correct for genuinely
   * repeated events, since nothing else can tell them apart.
   */
  event_id?: string;
};

export type TrackEventsResult = {
  accepted: number;
  /** Rows skipped because their `event_id` was already stored. */
  duplicates?: number;
};

export class APIError extends Error {
  readonly statusCode: number;
  readonly body: string;
  /**
   * Platform governance error code parsed from the response body's
   * structured `{"error", "code"}` payload (e.g. `rate_limit_exceeded`,
   * `organisation_suspended`, `monthly_active_users_exceeded`).
   * `null` for transport errors or unstructured responses. Callers
   * branching on governance state should match on `code`, not `message`.
   */
  readonly code: string | null;

  constructor(statusCode: number, message: string, body: string, code: string | null = null) {
    super(`redpennon: api error ${statusCode}: ${message}`);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.body = body;
    this.code = code;
  }
}

function parseErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.code === "string" && parsed.code) {
      return parsed.code;
    }
  } catch {
    // Body is not JSON; leave code unparsed.
  }
  return null;
}

/**
 * Default per-request timeout, in milliseconds.
 *
 * A flag lookup that has not answered within a second is not going to
 * be useful to the render that asked for it. Without a bound, a hung
 * API hangs the calling application indefinitely — the exact failure
 * the fail-open design exists to prevent, and one `variableValue`
 * cannot catch because the request never returns.
 */
export const DEFAULT_TIMEOUT_MS = 1000;

export type ClientOptions = {
  apiKey: string;
  /** Override the API origin. Defaults to {@link DEFAULT_API_BASE_URL}. */
  baseUrl?: string;
  /** Override the fetch implementation (handy for tests). */
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}. Pass 0 to disable the bound entirely —
   * only sensible when the caller imposes its own.
   */
  timeoutMs?: number;
};

export type EvalOptions = {
  user?: UserContext;
};

/**
 * Thin client around the variable-key evaluation endpoints.
 * Stateless — one instance can serve any number of concurrent
 * evaluations and is safe to keep as a module-level singleton.
 */
export class RedPennonClient {
  readonly origin: string;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.origin = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Request init shared by every call, including the timeout signal. */
  private requestInit(body: unknown): RequestInit {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
    if (this.timeoutMs > 0) {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }
    return init;
  }

  /**
   * Resolve a single variable to its full result object.
   *
   * Network errors and non-2xx responses surface as {@link APIError};
   * callers that want fail-open semantics should use
   * {@link variableValue} instead.
   */
  async variable<T = unknown>(
    key: string,
    options: EvalOptions = {},
  ): Promise<VariableResult<T>> {
    const body: Record<string, unknown> = {};
    if (options.user) body.user = options.user;
    const response = await this.fetchImpl(
      `${this.origin}/v1/variables/${encodeURIComponent(key)}`,
      this.requestInit(body),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new APIError(response.status, response.statusText, text, parseErrorCode(text));
    }

    return (await response.json()) as VariableResult<T>;
  }

  /**
   * Resolve a single variable to its value, falling back to
   * `defaultValue` whenever the platform served no value (network
   * error, unknown key, deleted/archived feature, targeting
   * disabled). This is the method that should be reached for in
   * application code: the developer-supplied default is the
   * load-bearing contract.
   */
  async variableValue<T>(
    key: string,
    defaultValue: T,
    options: EvalOptions = {},
  ): Promise<T> {
    try {
      const result = await this.variable<T>(key, options);
      return result.value === null ? defaultValue : result.value;
    } catch {
      // Swallow all errors — network, API, JSON parse — and serve the
      // developer-supplied default. The SDK's job is to keep the
      // calling app running, not to surface infra problems.
      return defaultValue;
    }
  }

  /**
   * Record one or more metric events. Pass the `evaluation_trace` from a
   * prior {@link variable} call to correlate events with the evaluation
   * that triggered them.
   *
   * Throws {@link APIError} on any non-2xx response, including governance
   * errors (`events_batch_too_large`, `rate_limit_exceeded`, etc.).
   */
  async trackEvents(events: EventPayload[]): Promise<TrackEventsResult> {
    const response = await this.fetchImpl(
      `${this.origin}/v1/events`,
      this.requestInit({ events }),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new APIError(response.status, response.statusText, text, parseErrorCode(text));
    }

    return (await response.json()) as TrackEventsResult;
  }

  /**
   * Resolve multiple variables in one HTTP round-trip. Each result
   * has the same shape as {@link variable}; unknown keys surface as
   * `variable_not_found` inline.
   */
  async variables(
    keys: string[],
    options: EvalOptions = {},
  ): Promise<BatchResults> {
    const body: Record<string, unknown> = { keys };
    if (options.user) body.user = options.user;
    const response = await this.fetchImpl(
      `${this.origin}/v1/variables`,
      this.requestInit(body),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new APIError(response.status, response.statusText, text, parseErrorCode(text));
    }

    const parsed = (await response.json()) as { results: BatchResults };
    return parsed.results;
  }

  /**
   * Batch counterpart of {@link variableValue}: resolve many keys and
   * return a value for each, falling back to the matching entry in
   * `defaults` whenever the platform served no value or the call failed
   * outright.
   *
   * Without this, only the single-key path actually failed open — a
   * caller batching for efficiency had to hand-roll the try/catch that
   * makes the SDK's central promise true.
   */
  async variableValues<T extends Record<string, unknown>>(
    defaults: T,
    options: EvalOptions = {},
  ): Promise<T> {
    const keys = Object.keys(defaults);
    try {
      const results = await this.variables(keys, options);
      const out = { ...defaults };
      for (const key of keys) {
        const value = results[key]?.value;
        if (value !== null && value !== undefined) {
          (out as Record<string, unknown>)[key] = value;
        }
      }
      return out;
    } catch {
      return { ...defaults };
    }
  }
}
