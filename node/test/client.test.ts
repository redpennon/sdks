import { describe, expect, it } from "vitest";
import {
  APIError,
  DEFAULT_API_BASE_URL,
  RedPennonClient,
  VariableResult,
} from "../src/index.js";
import type { EventPayload, TrackEventsResult } from "../src/index.js";

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
    const trace = "rpe_v1:sometoken";
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
    // evaluation_trace is an opaque signed string from the API
    const _typeCheck: string | null | undefined = result.evaluation_trace;
    expect(result.evaluation_trace).toBe(trace);
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

  it("returns the default when the API responds with a non-2xx status", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error":"Invalid or missing API key."}', { status: 401 });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const value = await c.variableValue("flag", false);
    expect(value).toBe(false);
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

describe("trackEvents()", () => {
  it("POSTs to /v1/events with events array and returns accepted count", async () => {
    const { fetchImpl, calls } = makeFetch({ status: 202, body: { accepted: 2 } });
    const c = new RedPennonClient({ apiKey: "env-key", fetchImpl });

    const events: EventPayload[] = [
      { event: "button_clicked", variable: "checkout-flow", variation: "variant-a" },
      {
        event: "purchase",
        variable: "checkout-flow",
        variation: "variant-a",
        user: { id: "user-123" },
        value: 42.5,
        occurred_at: "2026-05-01T05:06:07Z",
        evaluation_trace: "rpe_v1:sometoken",
      },
    ];

    const result: TrackEventsResult = await c.trackEvents(events);

    expect(result).toEqual({ accepted: 2 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`${DEFAULT_API_BASE_URL}/v1/events`);
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("X-API-Key")).toBe("env-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({ events });
  });

  it("accepts an empty array and returns accepted: 0", async () => {
    const { fetchImpl, calls } = makeFetch({ status: 202, body: { accepted: 0 } });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    const result = await c.trackEvents([]);

    expect(result.accepted).toBe(0);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ events: [] });
  });

  it("throws APIError with governance code on non-2xx response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: "Batch too large.", code: "events_batch_too_large" }),
        { status: 413 },
      );
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await expect(
      c.trackEvents([{ event: "e", variable: "v", variation: "r" }]),
    ).rejects.toMatchObject({
      name: "APIError",
      statusCode: 413,
      code: "events_batch_too_large",
    });
  });

  it("throws APIError on rate limit governance error", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: "Rate limit exceeded.", code: "rate_limit_exceeded" }),
        { status: 429 },
      );
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });

    await expect(
      c.trackEvents([{ event: "e", variable: "v", variation: "r" }]),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limit_exceeded",
    });
  });
});

describe("request timeout", () => {
  it("aborts a request that outlives the timeout", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });

    const client = new RedPennonClient({
      apiKey: "k",
      fetchImpl: hang,
      timeoutMs: 20,
    });

    await expect(client.variable("flag")).rejects.toThrow();
  });

  it("serves the default when the API never answers", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });

    const client = new RedPennonClient({
      apiKey: "k",
      fetchImpl: hang,
      timeoutMs: 20,
    });

    // The whole point: a hung API must not hang the caller.
    await expect(client.variableValue("flag", "fallback")).resolves.toBe(
      "fallback",
    );
  });

  it("attaches no signal when the timeout is disabled", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const capture: typeof fetch = async (_url, init) => {
      seenSignal = init?.signal;
      return new Response(JSON.stringify({ key: "f", value: 1 }), {
        status: 200,
      });
    };

    const client = new RedPennonClient({
      apiKey: "k",
      fetchImpl: capture,
      timeoutMs: 0,
    });
    await client.variable("f");
    expect(seenSignal).toBeUndefined();
  });
});

describe("variableValues", () => {
  it("fills in defaults for keys the platform served no value for", async () => {
    const stub: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: {
            alpha: { key: "alpha", value: true, variation: "on", reason: "x", feature: "f" },
            beta: { key: "beta", value: null, variation: null, reason: "targeting_disabled", feature: "f" },
          },
        }),
        { status: 200 },
      );

    const client = new RedPennonClient({ apiKey: "k", fetchImpl: stub });
    const values = await client.variableValues({ alpha: false, beta: "fallback" });
    expect(values).toEqual({ alpha: true, beta: "fallback" });
  });

  it("returns every default when the call fails outright", async () => {
    const boom: typeof fetch = async () => {
      throw new Error("network down");
    };
    const client = new RedPennonClient({ apiKey: "k", fetchImpl: boom });
    const values = await client.variableValues({ alpha: false, beta: 3 });
    expect(values).toEqual({ alpha: false, beta: 3 });
  });
});
