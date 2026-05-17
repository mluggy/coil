// Agentic-commerce surface tests — UCP + ACP discovery profiles and the
// demo /checkout-sessions REST surface. The podcast sells nothing; these
// endpoints return canned, spec-shaped demo objects only.

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { onRequest } from "../../functions/_middleware.js";

const BASE = "https://example.test";

beforeAll(() => {
  if (!existsSync("functions/_episodes.js") || !existsSync("functions/_config.js")) {
    execSync("node scripts/yaml-to-json.js && node scripts/generate-html-template.js", { stdio: "pipe" });
  }
});

function next() {
  return Promise.resolve(new Response("<!DOCTYPE html><title>spa</title>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
}

async function call(path, init = {}) {
  return onRequest({ request: new Request(`${BASE}${path}`, init), next, env: {} });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe("UCP discovery — /.well-known/ucp", () => {
  let body;
  beforeAll(async () => {
    body = JSON.parse(await (await call("/.well-known/ucp")).text());
  });

  it("publishes a valid version (YYYY-MM-DD)", () => {
    expect(body.version).toMatch(DATE_RE);
    expect(body.ucp.version).toMatch(DATE_RE);
  });

  it("advertises services and capabilities per ucp.dev", () => {
    expect(body.ucp.services["dev.ucp.shopping"]).toBeTruthy();
    expect(body.ucp.services["dev.ucp.shopping"].rest.endpoint).toMatch(/\/checkout-sessions$/);
    expect(Array.isArray(body.ucp.capabilities)).toBe(true);
    expect(body.ucp.capabilities.length).toBeGreaterThanOrEqual(1);
  });

  it("declares itself demo-only — nothing for sale", () => {
    expect(body.availability.status).toBe("demo-only");
    expect(body.availability.livemode).toBe(false);
    expect(body.availability.purpose).toMatch(/free podcast|nothing is for sale/i);
  });

  it("is also reachable at /.well-known/ucp.json", async () => {
    expect((await call("/.well-known/ucp.json")).status).toBe(200);
  });
});

describe("ACP discovery — /.well-known/acp.json", () => {
  let body;
  beforeAll(async () => {
    body = JSON.parse(await (await call("/.well-known/acp.json")).text());
  });

  it("publishes protocol name + valid version", () => {
    expect(body.protocol.name).toBe("acp");
    expect(body.protocol.version).toMatch(DATE_RE);
  });

  it("advertises the checkout capability", () => {
    expect(body.transports).toContain("rest");
    expect(body.capabilities.services).toContain("checkout");
  });

  it("declares itself demo-only", () => {
    expect(body.availability.status).toBe("demo-only");
    expect(body.availability.livemode).toBe(false);
  });
});

describe("UCP checkout — POST /checkout-sessions", () => {
  it("creates a demo session with UCP-Agent + Idempotency-Key headers", async () => {
    const resp = await call("/checkout-sessions", {
      method: "POST",
      headers: { "UCP-Agent": "test-agent/1.0", "Idempotency-Key": "idem-123" },
      body: JSON.stringify({ cart: { items: [] } }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Idempotency-Key")).toBe("idem-123");
    const body = JSON.parse(await resp.text());
    expect(body.object).toBe("checkout_session");
    expect(body.protocol).toBe("UCP");
    expect(body.demo).toBe(true);
    expect(body.livemode).toBe(false);
    expect(body.totals.total.amount).toBe("0.00");
    expect(body.message).toMatch(/demo/i);
  });

  it("400s when a required header is missing", async () => {
    const resp = await call("/checkout-sessions", {
      method: "POST",
      headers: { "UCP-Agent": "test-agent/1.0" },
    });
    expect(resp.status).toBe(400);
    const body = JSON.parse(await resp.text());
    expect(body.error.code).toBe("missing_header");
    expect(body.error.message).toMatch(/Idempotency-Key/);
  });

  it("retrieves a session by id (GET, no headers required)", async () => {
    const resp = await call("/checkout-sessions/cs_demo_abc123");
    expect(resp.status).toBe(200);
    const body = JSON.parse(await resp.text());
    expect(body.id).toBe("cs_demo_abc123");
    expect(body.object).toBe("checkout_session");
  });

  it("completes a session — no charge taken", async () => {
    const resp = await call("/checkout-sessions/cs_demo_abc123/complete", {
      method: "POST",
      headers: { "UCP-Agent": "test-agent/1.0", "Idempotency-Key": "idem-9" },
    });
    expect(resp.status).toBe(200);
    const body = JSON.parse(await resp.text());
    expect(body.status).toBe("completed");
    expect(body.payment.status).toBe("not_charged");
  });

  it("answers CORS preflight (OPTIONS) with 204", async () => {
    const resp = await call("/checkout-sessions", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Headers")).toMatch(/UCP-Agent/);
    expect(resp.headers.get("Access-Control-Allow-Headers")).toMatch(/Idempotency-Key/);
  });
});

describe("ACP checkout — POST /checkout_sessions", () => {
  it("creates a demo session with API-Version + Idempotency-Key headers", async () => {
    const resp = await call("/checkout_sessions", {
      method: "POST",
      headers: { "API-Version": "2025-09-29", "Idempotency-Key": "idem-acp-1" },
    });
    expect(resp.status).toBe(200);
    const body = JSON.parse(await resp.text());
    expect(body.object).toBe("checkout_session");
    expect(body.protocol).toBe("ACP");
    expect(body.demo).toBe(true);
    expect(resp.headers.get("Idempotency-Key")).toBe("idem-acp-1");
  });

  it("400s without the API-Version header", async () => {
    const resp = await call("/checkout_sessions", {
      method: "POST",
      headers: { "Idempotency-Key": "idem-acp-2" },
    });
    expect(resp.status).toBe(400);
    expect((JSON.parse(await resp.text())).error.message).toMatch(/API-Version/);
  });
});
