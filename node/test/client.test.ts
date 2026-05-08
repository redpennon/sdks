import { describe, expect, it } from "vitest";
import { APIError, DEFAULT_API_BASE_URL, RedPennonClient } from "../src/index.js";

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
      expect(String(input)).toBe(
        `${DEFAULT_API_BASE_URL}/v1/evaluate`,
      );
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
      apiKey: "test-key",
      fetchImpl,
    });
    const res = await c.evaluate({ feature: "my-flag" });
    expect(res.variation).toBe("on");
    expect(res.variables.show_banner).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("evaluate surfaces null variation when targeting is disabled", async () => {
    // When an environment has targeting toggled off, the API returns
    // `"variation": null` and an empty `variables` map. The SDK
    // consumer is then expected to fall back to whatever default
    // value they hard-coded for the variable in their app.
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(200, {
        feature: "my-flag",
        variation: null,
        variables: {},
        reason: "targeting_disabled",
      });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });
    const res = await c.evaluate({ feature: "my-flag" });
    expect(res.variation).toBeNull();
    expect(res.variables).toEqual({});
    expect(res.reason).toBe("targeting_disabled");
  });

  it("evaluateBatch hits batch path", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(
        `${DEFAULT_API_BASE_URL}/v1/evaluate/batch`,
      );
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
      apiKey: "k",
      fetchImpl,
    });
    const batch = await c.evaluateBatch({ features: ["a"] });
    expect(batch.results.a.reason).toBe("feature_not_found");
  });

  it("evaluate forwards new built-in and custom_data fields on user", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        feature: "f",
        variation: "on",
        variables: {},
        reason: "targeting_rule_matched",
      });
    };
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });
    await c.evaluate({
      feature: "f",
      user: {
        id: "u1",
        app_version: "4.12.0",
        platform: "ios",
        country: "AU",
        customData: { plan: "enterprise", trial_days: 7 },
      },
    });
    const user = (capturedBody as { user: Record<string, unknown> }).user;
    expect(user.app_version).toBe("4.12.0");
    expect(user.platform).toBe("ios");
    expect(user.country).toBe("AU");
    expect(user.customData).toEqual({ plan: "enterprise", trial_days: 7 });
  });

  it("throws APIError on non-2xx", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(401, { error: "Invalid or missing API key." });
    const c = new RedPennonClient({
      apiKey: "bad",
      fetchImpl,
    });
    const err = await c.evaluate({ feature: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(401);
  });
});
