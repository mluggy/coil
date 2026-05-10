// Tests for /donate — voluntary tip jar that returns HTTP 402 with x402,
// MPP, and WWW-Authenticate: Payment headers. The free read API never
// returns 402; only this endpoint does.

import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/donate.js";

const BASE = "https://example.test";

function call(init = {}) {
  return onRequest({ request: new Request(`${BASE}/donate`, init) });
}

describe("POST /donate", () => {
  it("returns HTTP 402 Payment Required", async () => {
    const resp = await call({ method: "POST" });
    expect(resp.status).toBe(402);
  });

  it("emits x402 PAYMENT-REQUIRED header", async () => {
    const resp = await call({ method: "POST" });
    expect(resp.headers.get("PAYMENT-REQUIRED")).toBe("x402");
  });

  it("emits WWW-Authenticate with both x402 and Payment schemes", async () => {
    const resp = await call({ method: "POST" });
    const wwwAuth = resp.headers.get("WWW-Authenticate") || "";
    // Both schemes present (multiple challenges joined with comma per RFC 9110).
    expect(wwwAuth).toMatch(/\bx402\b/);
    expect(wwwAuth).toMatch(/\bPayment\b/);
    expect(wwwAuth).toMatch(/realm="[^"]+\/donate"/);
    expect(wwwAuth).toMatch(/asset="USDC"/);
    expect(wwwAuth).toMatch(/network="[^"]+"/);
  });

  it("emits machine-readable X-Payment-Required (parseable JSON)", async () => {
    const resp = await call({ method: "POST" });
    const raw = resp.headers.get("X-Payment-Required");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.x402Version).toBe(1);
    expect(parsed.error).toBe("payment_required");
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0].asset).toBe("USDC");
    expect(parsed.accepts[0].scheme).toBe("exact");
    // maxAmountRequired is in USDC base units (atoms, 6 decimals)
    expect(parsed.accepts[0].maxAmountRequired).toMatch(/^\d+$/);
  });

  it("emits Link: rel=payment header pointing at /pricing.md", async () => {
    const resp = await call({ method: "POST" });
    const link = resp.headers.get("Link") || "";
    expect(link).toMatch(/rel="payment"/);
    expect(link).toContain("/pricing.md");
    expect(link).toMatch(/rel="x402-supported"/);
  });

  it("body is x402-spec compliant (x402Version + accepts + error at top level)", async () => {
    const resp = await call({ method: "POST" });
    const body = JSON.parse(await resp.text());
    expect(body.x402Version).toBe(1);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0].asset).toBe("USDC");
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.error).toBe("payment_required");
  });

  it("body's _meta carries MPP + external donation alternatives", async () => {
    const resp = await call({ method: "POST" });
    const body = JSON.parse(await resp.text());
    expect(body._meta.title).toBeTruthy();
    expect(body._meta.description).toBeTruthy();
    const types = body._meta.alternativePayments.map((m) => m.type);
    expect(types).toContain("mpp");
    expect(types).toContain("external");
    const mpp = body._meta.alternativePayments.find((m) => m.type === "mpp");
    expect(mpp.asset).toBe("USDC");
    expect(mpp.scheme).toBe("stablecoin");
  });

  it("CORS preflight returns 204", async () => {
    const resp = await call({ method: "OPTIONS" });
    expect(resp.status).toBe(204);
  });
});
