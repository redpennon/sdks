import { describe, expect, it, vi } from "vitest";
import {
  APIError,
  DEFAULT_API_BASE_URL,
  RedPennonClient,
  VariableResult,
} from "../src/index.js";

/**
 * Build a fake `fetch` that returns the supplied JSON body with the
 * supplied status, and captures every call so tests can assert on
 * URL / method / headers / body.
 */
function makeFetch(
  responses: Array<{ status?: number; body: unknown }> | { status?: number; body: unknown },
) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const next = queue.shift() ?? queue[queue.length - 1];
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("RedPennonClient (construction)", () => {
  // Plain `new RedPennonClient({ apiKey })` + the default origin are
  // exercised transitively by every per-method test below; the redundant
  // construction smoke test was removed.

  it("accepts a custom origin and strips trailing slashes", () => {
    const c = new RedPennonClient({
      apiKey: "k",
      baseUrl: "http://localhost:8001//",
    });
    expect(c.origin).toBe("http://localhost:8001");
  });

  it("APIError exposes status code and body", () => {
    const err = new APIError(401, "Unauthorized", '{"error":"nope"}');
    expect(err.statusCode).toBe(401);
    expect(err.body).toBe('{"error":"nope"}');
    expect(err.code).toBeNull();
    expect(err.name).toBe("APIError");
  });

  it("APIError carries governance code parsed from response body", async () => {
    // Governance error responses carry `{"error", "code"}`; callers
    // branch on `code` (`rate_limit_exceeded`, `organisation_suspended` …)
    // rather than scraping `message`. The code is parsed once when the
    // SDK constructs the APIError, so consumers don't need to JSON.parse
    // `body` themselves.
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: "Rate limit exceeded.", code: "rate_limit_exceeded" }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await expect(c.variable("any-key")).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limit_exceeded",
    });
  });
});

describe("variable()", () => {
  it("POSTs to /v1/variables/<key> with X-API-Key and user context", async () => {
    // Server-shape response from the new endpoint.
    const { fetchImpl, calls } = makeFetch({
      body: {
        key: "show-banner",
        value: true,
        variation: "on",
        reason: "targeting_rule_matched",
        feature: "marketing-banner",
      },
    });
    const c = new RedPennonClient({ apiKey: "env-key", fetchImpl });

    const result = await c.variable<boolean>("show-banner", {
      user: { id: "user-123", email: "alice@example.com" },
    });

    expect(result).toEqual({
      key: "show-banner",
      value: true,
      variation: "on",
      reason: "targeting_rule_matched",
      feature: "marketing-banner",
    } satisfies VariableResult<boolean>);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`${DEFAULT_API_BASE_URL}/v1/variables/show-banner`);
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("X-API-Key")).toBe("env-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({
      user: { id: "user-123", email: "alice@example.com" },
    });
  });

  it("URL-encodes the key (so a slash in the key cannot path-traverse)", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { key: "weird/key", value: null, variation: null, reason: "variable_not_found", feature: null },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await c.variable("weird/key");

    expect(calls[0].url.endsWith("/v1/variables/weird%2Fkey")).toBe(true);
  });

  it("omits the user field when no user context is supplied (anonymous eval)", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { key: "k", value: false, variation: "off", reason: "default_variation", feature: "f" },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await c.variable("k");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
  });

  it("throws APIError with status + body on non-2xx responses", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error":"Invalid or missing API key."}', { status: 401 });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await expect(c.variable("k")).rejects.toMatchObject({
      name: "APIError",
      statusCode: 401,
    });
  });

  it("populates evaluation_trace when present in the API response", async () => {
    const trace = { matched_rule: "rule-1", environment: "production" };
    const { fetchImpl } = makeFetch({
      body: {
        key: "show-banner",
        value: true,
        variation: "on",
        reason: "targeting_rule_matched",
        feature: "marketing-banner",
        evaluation_trace: trace,
      },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const result = await c.variable<boolean>("show-banner");
    expect(result.evaluation_trace).toEqual(trace);
  });

  it("leaves evaluation_trace undefined when absent from the API response", async () => {
    const { fetchImpl } = makeFetch({
      body: { key: "k", value: false, variation: "off", reason: "default_variation", feature: "f" },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const result = await c.variable("k");
    expect(result.evaluation_trace).toBeUndefined();
  });
});

describe("variableValue()", () => {
  it("returns just the value when the server served one", async () => {
    const { fetchImpl } = makeFetch({
      body: {
        key: "discount-pct",
        value: 25,
        variation: "on",
        reason: "targeting_rule_matched",
        feature: "promo",
      },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const value = await c.variableValue("discount-pct", 0, { user: { id: "u" } });
    expect(value).toBe(25);
  });

  it("falls back to the default when the server returned null (no value served)", async () => {
    // ``variable_not_found``, ``targeting_disabled``, deleted/archived
    // features all produce ``value: null``. SDK consumers expect the
    // developer-supplied default in that case — that's the whole
    // point of fail-open evaluation.
    const { fetchImpl } = makeFetch({
      body: {
        key: "discount-pct",
        value: null,
        variation: null,
        reason: "variable_not_found",
        feature: null,
      },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const value = await c.variableValue("discount-pct", 10);
    expect(value).toBe(10);
  });

  it("returns the typed default when fetch itself throws (offline / network error)", async () => {
    /**
     * Network failures must not crash the calling app; the SDK
     * promises "the developer-supplied default always wins on any
     * failure". The single-flag method swallows the error and returns
     * the default. ``variable()`` (the result-shape method) still
     * surfaces the error — callers that opt in to that shape have
     * opted in to handling errors too.
     */
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("offline");
    };
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const value = await c.variableValue("flag", "fallback");
    expect(value).toBe("fallback");
  });
});

describe("variables() (batch)", () => {
  it("POSTs to /v1/variables with keys and user, returns a result map", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: {
        results: {
          a: { key: "a", value: true, variation: "on", reason: "default_variation", feature: "f-a" },
          b: { key: "b", value: null, variation: null, reason: "variable_not_found", feature: null },
        },
      },
    });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const results = await c.variables(["a", "b"], { user: { id: "u" } });

    expect(results.a.value).toBe(true);
    expect(results.b.reason).toBe("variable_not_found");
    expect(calls[0].url).toBe(`${DEFAULT_API_BASE_URL}/v1/variables`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      keys: ["a", "b"],
      user: { id: "u" },
    });
  });

  it("does not include user when omitted", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { results: {} } });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await c.variables([]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ keys: [] });
  });

  it("throws APIError on non-2xx", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error":"nope"}', { status: 401 });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await expect(c.variables(["a"])).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
