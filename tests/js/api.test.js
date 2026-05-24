// Tests for the listener-facing read API: /api/search, /ask, /status,
// and the catchall 404 envelope. Pins orank-relevant headers
// (X-RateLimit-*, structured error envelope) and response shapes.

import { describe, it, expect } from "vitest";
import { onRequestGet as searchGet, onRequestPost as searchPost, onRequestHead as searchHead } from "../../functions/api/search.js";
import { onRequestGet as askGet, onRequestPost as askPost } from "../../functions/ask.js";
import { onRequestGet as jobsGet, onRequestPost as jobsPost } from "../../functions/jobs/[id].js";
import { onRequestGet as jobsIndexGet, onRequestPost as jobsIndexPost } from "../../functions/jobs/index.js";
import { onRequestGet as statusGet, onRequestHead as statusHead } from "../../functions/status.js";
import { onRequestGet as catchallGet, onRequestOptions as catchallOptions, onRequestHead as catchallHead } from "../../functions/api/[[catchall]].js";

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
    // RFC 9598 canonical names too (orank probes for these specifically).
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("RateLimit-Remaining")).toBeTruthy();
    expect(resp.headers.get("RateLimit-Reset")).toBeTruthy();
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("HEAD returns the same rate-limit headers as GET, no body", async () => {
    const resp = await searchHead({ request: req("/api/search?q=test", { method: "HEAD" }) });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(resp.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await resp.text()).toBe("");
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

describe("HEAD probes on /api/* + /status (RFC 9598 rate-limit probe)", () => {
  it("HEAD /status returns rate-limit headers", async () => {
    const resp = await statusHead({ request: req("/status", { method: "HEAD" }) });
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(await resp.text()).toBe("");
  });

  it("HEAD on a 404 catchall path still carries rate-limit headers", async () => {
    const resp = await catchallHead({ request: req("/api/nope", { method: "HEAD" }) });
    expect(resp.status).toBe(404);
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Limit")).toBeTruthy();
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

describe("/ask + /jobs/<id> — 202 Accepted async job pattern", () => {
  it("POST /ask?async=1 → 202 Accepted with Location + Retry-After + poll_url", async () => {
    const resp = await askPost({
      request: req("/ask?async=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ai", limit: 3 }),
      }),
    });
    expect(resp.status).toBe(202);
    expect(resp.headers.get("Location")).toMatch(/\/jobs\//);
    expect(resp.headers.get("Retry-After")).toBe("1");
    const body = await json(resp);
    expect(body.status).toBe("pending");
    expect(body.job_id).toBeTruthy();
    expect(body.poll_url).toMatch(/\/jobs\//);
    expect(body.retry_after_seconds).toBe(1);
    expect(body.kind).toBe("ask");
  });

  it("Prefer: respond-async triggers 202 too (RFC 7240)", async () => {
    const resp = await askPost({
      request: req("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "respond-async" },
        body: JSON.stringify({ query: "ai" }),
      }),
    });
    expect(resp.status).toBe(202);
    expect(resp.headers.get("Location")).toMatch(/\/jobs\//);
  });

  it("GET /jobs/<id> returns status=pending within the first second", async () => {
    // Fresh job: created_at = now → < 1s old → pending.
    const askResp = await askPost({
      request: req("/ask?async=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ai" }),
      }),
    });
    const { job_id } = await json(askResp);
    const resp = await jobsGet({ request: req(`/jobs/${job_id}`), params: { id: job_id } });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.status).toBe("pending");
    expect(body.poll_url).toMatch(/\/jobs\//);
    expect(resp.headers.get("Retry-After")).toBe("1");
  });

  it("GET /jobs/<id>?wait skips the pending-window simulation → completed + result", async () => {
    const askResp = await askPost({
      request: req("/ask?async=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ai", limit: 2 }),
      }),
    });
    const { job_id } = await json(askResp);
    const resp = await jobsGet({ request: req(`/jobs/${job_id}?wait=1`), params: { id: job_id } });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.status).toBe("completed");
    expect(body.kind).toBe("ask");
    expect(body.result.query).toBe("ai");
    expect(Array.isArray(body.result.results)).toBe(true);
    expect(body.completed_at).toBeTruthy();
  });

  it("GET /jobs/<bad-id> returns 404 with structured error", async () => {
    const resp = await jobsGet({ request: req("/jobs/not-a-job"), params: { id: "not-a-job" } });
    expect(resp.status).toBe(404);
    const body = await json(resp);
    expect(body.error.code).toBe("job_not_found");
  });

  it("rejects POST on /jobs/<id> with 405", async () => {
    const resp = await jobsPost({ request: req("/jobs/x", { method: "POST" }), params: { id: "x" } });
    expect(resp.status).toBe(405);
  });

  it("POST /jobs (conventional path) → 202 + Location + body", async () => {
    const resp = await jobsIndexPost({
      request: req("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "ask", query: "ai", limit: 3 }),
      }),
    });
    expect(resp.status).toBe(202);
    expect(resp.headers.get("Location")).toMatch(/\/jobs\//);
    expect(resp.headers.get("Retry-After")).toBe("1");
    const body = await json(resp);
    expect(body.status).toBe("pending");
    expect(body.kind).toBe("ask");
    expect(body.poll_url).toMatch(/\/jobs\//);
  });

  it("POST /jobs with Prefer: respond-async also works (RFC 7240)", async () => {
    const resp = await jobsIndexPost({
      request: req("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "respond-async" },
        body: JSON.stringify({ kind: "search", query: "ai" }),
      }),
    });
    expect(resp.status).toBe(202);
  });

  it("POST /jobs rejects unknown kind with structured 400", async () => {
    const resp = await jobsIndexPost({
      request: req("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "delete-all-data", query: "x" }),
      }),
    });
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error.code).toBe("unsupported_kind");
  });

  it("GET /jobs returns a discovery envelope with the 202 pattern", async () => {
    const resp = await jobsIndexGet({ request: req("/jobs") });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.pattern).toBe("202-accepted-with-location");
    expect(body.supportedKinds).toEqual(expect.arrayContaining(["ask", "search"]));
    expect(body.poll).toMatch(/\/jobs\/\{id\}$/);
  });

  it("GET /api/search?async=1 → 202 + Location + Retry-After", async () => {
    const resp = await searchGet({ request: req("/api/search?q=ai&async=1") });
    expect(resp.status).toBe(202);
    expect(resp.headers.get("Location")).toMatch(/\/jobs\//);
    expect(resp.headers.get("Retry-After")).toBe("1");
    const body = await json(resp);
    expect(body.kind).toBe("search");
    expect(body.status).toBe("pending");
  });

  it("non-async POST /ask still returns the synchronous 200 envelope", async () => {
    const resp = await askPost({
      request: req("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "ai", limit: 1 }),
      }),
    });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body._meta).toBeTruthy();
    expect(body.query).toBe("ai");
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

  it("emits x402 PAYMENT-REQUIRED + WWW-Authenticate with both x402 and Payment schemes", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    // PAYMENT-REQUIRED is Base64-encoded JSON body in the v2 wire format.
    const header = resp.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header, "base64").toString());
    expect(decoded.x402Version).toBeGreaterThanOrEqual(1);
    const wwwAuth = resp.headers.get("WWW-Authenticate") || "";
    expect(wwwAuth).toMatch(/\bx402\b/);
    expect(wwwAuth).toMatch(/\bPayment\b/);
    expect(wwwAuth).toMatch(/asset="USDC"/);
  });

  it("emits machine-readable X-Payment-Required (parseable JSON)", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const parsed = JSON.parse(resp.headers.get("X-Payment-Required"));
    expect(parsed.x402Version).toBeGreaterThanOrEqual(1);
    expect(parsed.accepts[0].asset).toMatch(/^(0x[a-fA-F0-9]+|USDC)$/);
    // canonical x402: `resource` is the URL the client should retry with
    // X-Payment (the original request URL). /donate is exposed via
    // extra.tipJar for clients that want to redirect a voluntary tip.
    expect(parsed.accepts[0].resource).toMatch(/\/api\/v1/);
    expect(parsed.accepts[0].extra.tipJar).toMatch(/\/donate$/);
  });

  it("emits Link rel=payment header pointing at /donate", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const link = resp.headers.get("Link") || "";
    expect(link).toMatch(/\/donate>;\s*rel="payment"/);
    expect(link).toMatch(/rel="x402"/);
  });

  it("body is x402-spec compliant (x402Version + accepts + error at top level)", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const body = await json(resp);
    expect(body.x402Version).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0].asset).toMatch(/^(0x[a-fA-F0-9]+|USDC)$/);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.error).toMatch(/payment[_ ]required/i);
  });

  it("body _meta carries the structured error + MPP alternative", async () => {
    const resp = await catchallGet({ request: req("/api/v1") });
    const body = await json(resp);
    expect(body._meta.code).toBe("no_versioned_api");
    expect(body._meta.alternativePayment.type).toBe("mpp");
    expect(body._meta.alternativePayment.asset).toBe("USDC");
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
