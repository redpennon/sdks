import { describe, expect, it } from "vitest";
import { APIError, RedPennonClient } from "../src/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RedPennonClient", () => {
  it("evaluate posts feature and returns parsed body", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(init ?? {});
      expect(String(input)).toBe("http://example/v1/evaluate/");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Api-Key")).toBe("test-key");
      expect(JSON.parse(String(init?.body))).toEqual({ feature: "my-flag" });
      return jsonResponse(200, {
        feature: "my-flag",
        variation: "on",
        variables: { show_banner: true },
        reason: "targeting_rule_matched",
      });
    };
    const c = new RedPennonClient({
      baseUrl: "http://example",
      apiKey: "test-key",
      fetchImpl,
    });
    const res = await c.evaluate({ feature: "my-flag" });
    expect(res.variation).toBe("on");
    expect(res.variables.show_banner).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("evaluateBatch hits batch path", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe("http://example/v1/evaluate/batch/");
      return jsonResponse(200, {
        results: {
          a: {
            feature: "a",
            variation: "off",
            variables: {},
            reason: "feature_not_found",
          },
        },
      });
    };
    const c = new RedPennonClient({
      baseUrl: "http://example",
      apiKey: "k",
      fetchImpl,
    });
    const batch = await c.evaluateBatch({ features: ["a"] });
    expect(batch.results.a.reason).toBe("feature_not_found");
  });

  it("throws APIError on non-2xx", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(401, { error: "Invalid or missing API key." });
    const c = new RedPennonClient({
      baseUrl: "http://example",
      apiKey: "bad",
      fetchImpl,
    });
    const err = await c.evaluate({ feature: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(401);
  });
});
