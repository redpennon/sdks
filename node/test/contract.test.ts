import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APIError, RedPennonClient } from "../src/index.js";
import type { EventPayload, UserContext } from "../src/index.js";

// Replays the shared wire-format cases (sdks/contract/cases.json).
type Response_ = { status: number; body: unknown };
type Cases = {
  track_events: Array<{
    name: string;
    events: EventPayload[];
    response: Response_;
    expect: {
      path: string;
      request_body?: unknown;
      result?: { accepted: number; duplicates: number };
      error?: { status: number; code: string | null };
    };
  }>;
  variable: Array<{
    name: string;
    key: string;
    user?: UserContext;
    response: Response_;
    expect: {
      path: string;
      request_body?: unknown;
      result?: Record<string, unknown>;
      error?: { status: number; code: string | null };
    };
  }>;
  variable_value_fail_open: Array<{
    name: string;
    key: string;
    default: string;
    response: Response_;
    expect: { value: string };
  }>;
};

const cases: Cases = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../contract/cases.json"), "utf8"),
);

function harness(response: Response_) {
  const seen: { path?: string; body?: unknown; apiKey?: string } = {};
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    seen.path = new URL(String(input)).pathname + new URL(String(input)).search;
    // Keep the encoded form: URL.pathname preserves percent-escapes.
    seen.body = JSON.parse(String(init.body));
    seen.apiKey = (init.headers as Record<string, string>)["X-API-Key"];
    const raw = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(raw, { status: response.status });
  };
  const client = new RedPennonClient({
    apiKey: "test-key",
    baseUrl: "http://api.test",
    fetchImpl,
  });
  return { client, seen };
}

describe("shared wire contract", () => {
  describe("trackEvents", () => {
    it.each(cases.track_events)("$name", async (c) => {
      const { client, seen } = harness(c.response);
      if (c.expect.error) {
        const err = await client.trackEvents(c.events).catch((e) => e);
        expect(err).toBeInstanceOf(APIError);
        expect(err.statusCode).toBe(c.expect.error.status);
        expect(err.code).toBe(c.expect.error.code);
      } else {
        const result = await client.trackEvents(c.events);
        expect(result.accepted).toBe(c.expect.result!.accepted);
        // The wire omits `duplicates` when nothing was skipped.
        expect(result.duplicates ?? 0).toBe(c.expect.result!.duplicates);
        expect(seen.body).toEqual(c.expect.request_body);
      }
      expect(seen.path).toBe(c.expect.path);
      expect(seen.apiKey).toBe("test-key");
    });
  });

  describe("variable", () => {
    it.each(cases.variable)("$name", async (c) => {
      const { client, seen } = harness(c.response);
      if (c.expect.error) {
        const err = await client.variable(c.key, { user: c.user }).catch((e) => e);
        expect(err).toBeInstanceOf(APIError);
        expect(err.statusCode).toBe(c.expect.error.status);
        expect(err.code).toBe(c.expect.error.code);
      } else {
        const result = await client.variable(c.key, { user: c.user });
        expect(result).toMatchObject(c.expect.result!);
        expect(seen.body).toEqual(c.expect.request_body);
      }
      expect(seen.path).toBe(c.expect.path);
    });
  });

  describe("variableValue fails open", () => {
    it.each(cases.variable_value_fail_open)("$name", async (c) => {
      const { client } = harness(c.response);
      expect(await client.variableValue(c.key, c.default)).toBe(c.expect.value);
    });
  });
});
