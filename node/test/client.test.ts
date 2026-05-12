import { describe, expect, it } from "vitest";
import {
  APIError,
  DEFAULT_API_BASE_URL,
  RedPennonClient,
} from "../src/index.js";

describe("RedPennonClient", () => {
  it("constructs with an api key and default origin", () => {
    const c = new RedPennonClient({ apiKey: "test-key" });
    expect(c.apiKey).toBe("test-key");
    expect(c.origin).toBe(DEFAULT_API_BASE_URL);
  });

  it("accepts a custom fetch implementation", () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("", { status: 204 });
    const c = new RedPennonClient({ apiKey: "k", fetchImpl });
    expect(c.fetchImpl).toBe(fetchImpl);
  });

  it("APIError exposes status code and body", () => {
    const err = new APIError(401, "Unauthorized", '{"error":"nope"}');
    expect(err.statusCode).toBe(401);
    expect(err.body).toBe('{"error":"nope"}');
    expect(err.name).toBe("APIError");
  });
});
