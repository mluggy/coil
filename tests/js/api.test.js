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

describe("/api/v1 — non-existent versioned API → x402/MPP probe surface", () => {
  it("returns HTTP 402 (no versioned API exists; pointers go to /donate)", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    expect(resp.status).toBe(402);
  });

  it("emits x402 PAYMENT-REQUIRED + WWW-Authenticate: Payment headers", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    expect(resp.headers.get("PAYMENT-REQUIRED")).toBe("x402");
    const wwwAuth = resp.headers.get("WWW-Authenticate") || "";
    expect(wwwAuth).toMatch(/^Payment\b/);
    expect(wwwAuth).toMatch(/asset="USDC"/);
  });

  it("emits machine-readable X-Payment-Required (parseable JSON)", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const parsed = JSON.parse(resp.headers.get("X-Payment-Required"));
    expect(parsed.x402Version).toBe(1);
    expect(parsed.accepts[0].asset).toBe("USDC");
    expect(parsed.accepts[0].resource).toMatch(/\/donate$/);
  });

  it("emits Link rel=payment header pointing at /donate", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const link = resp.headers.get("Link") || "";
    expect(link).toMatch(/\/donate>;\s*rel="payment"/);
    expect(link).toMatch(/rel="x402"/);
  });

  it("body folds x402 + MPP payment methods alongside the structured error", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const body = await json(resp);
    expect(body.error.code).toBe("no_versioned_api");
    const types = body.paymentMethods.map((m) => m.type);
    expect(types).toContain("x402");
    expect(types).toContain("mpp");
  });

  it("nested paths under /api/v1 also return 402", async () => {
    const resp = await catchallGet({ request: req("/api/v1/users/me") });
    expect(resp.status).toBe(402);
  });

  it("paths NOT starting with /api/v1 still return 404", async () => {
    const resp = await catchallGet({ request: req("/api/v2") });
    expect(resp.status).toBe(404);
    const resp2 = await catchallGet({ request: req("/api/foo") });
    expect(resp2.status).toBe(404);
  });
});
