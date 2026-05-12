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
  customData?: Record<string, unknown>;
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
  readonly origin: string;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.origin = DEFAULT_API_BASE_URL.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
}
