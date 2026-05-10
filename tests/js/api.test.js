// Tests for the listener-facing read API: /api/search, /ask, /status,
// and the catchall 404 envelope. Pins orank-relevant headers
// (X-RateLimit-*, structured error envelope) and response shapes.

import { describe, it, expect } from "vitest";
import { onRequestGet as searchGet, onRequestPost as searchPost } from "../../functions/api/search.js";
import { onRequestGet as askGet, onRequestPost as askPost } from "../../functions/ask.js";
import { onRequestGet as statusGet } from "../../functions/status.js";
import { onRequestGet as catchallGet, onRequestOptions as catchallOptions } from "../../functions/api/[[catchall]].js";

const BASE = "https://example.test";

function req(path, init = {}) {
  return new Request(`${BASE}${path}`, init);
}

async function json(resp) {
  return JSON.parse(await resp.text());
}

describe("/api/search", () => {
  it("returns rate-limit + CORS headers", async () => {
    const resp = await searchGet({ request: req("/api/search?q=test") });
    expect(resp.headers.get("X-RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns a structured success envelope", async () => {
    const resp = await searchGet({ request: req("/api/search?q=test") });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body).toHaveProperty("query");
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("took_ms");
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("returns 400 + structured error envelope when q is missing", async () => {
    const resp = await searchGet({ request: req("/api/search") });
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error.code).toBe("missing_query");
    expect(body.error.message).toBeTruthy();
  });

  it("rejects POST with 405", async () => {
    const resp = await searchPost({ request: req("/api/search?q=x", { method: "POST" }) });
    expect(resp.status).toBe(405);
  });
});

describe("/ask (NLWeb)", () => {
  it("accepts POST with JSON body", async () => {
    const resp = await askPost({
      request: req("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", limit: 1 }),
      }),
    });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body).toHaveProperty("query");
    expect(body).toHaveProperty("results");
    // NLWeb _meta envelope
    expect(body).toHaveProperty("_meta");
  });

  it("accepts GET with q query string", async () => {
    const resp = await askGet({ request: req("/ask?q=test&limit=1") });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.query).toBe("test");
  });

  it("returns 400 + envelope on missing query", async () => {
    const resp = await askGet({ request: req("/ask") });
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error).toBeTruthy();
  });
});

describe("/status", () => {
  it("returns 200 with show metadata", async () => {
    const resp = await statusGet({ request: req("/status") });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    // Health snapshot must surface enough for an agent to circuit-break.
    expect(body).toHaveProperty("status");
  });
});

describe("/api/* catchall (unknown paths)", () => {
  it("returns 404 + structured error envelope", async () => {
    const resp = await catchallGet({ request: req("/api/does-not-exist") });
    expect(resp.status).toBe(404);
    const body = await json(resp);
    expect(body.error.code).toBeTruthy();
  });

  it("returns CORS + rate-limit headers even on 404", async () => {
    const resp = await catchallGet({ request: req("/api/nope") });
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("X-RateLimit-Limit")).toBeTruthy();
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const resp = await catchallOptions({ request: req("/api/anything", { method: "OPTIONS" }) });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
