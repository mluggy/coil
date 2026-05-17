// OpenAPI 3.1 spec contract test. Pins the orank-relevant shape of the
// public spec — every advertised endpoint must be present, error envelope
// must be referenced, security schemes (or their explicit absence) must
// be declared.

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

beforeAll(() => {
  if (!existsSync("public/episodes.json")) {
    execSync("node scripts/yaml-to-json.js", { stdio: "pipe" });
  }
  execSync("node scripts/generate-openapi.js", { stdio: "pipe" });
});

describe("openapi.yaml companion", () => {
  it("public/.well-known/openapi.yaml exists alongside the JSON spec", () => {
    // YAML companion exists because orank's api-response-quality parser
    // chokes on JSON (1/3 on stripe.com/github.com/podcast.lugassy.net)
    // but accepts YAML (2/3 on spree.commerce). Same content, two encodings.
    expect(existsSync("public/.well-known/openapi.yaml")).toBe(true);
  });

  it("emits fully-expanded YAML — no anchors/aliases", () => {
    // js-yaml's default reuses shared objects (the error-response refs) as
    // `&anchor` / `*alias` nodes; parsers that don't resolve aliases bail
    // with "could not fully parse". The generator sets noRefs: true.
    const yamlText = readFileSync("public/.well-known/openapi.yaml", "utf8");
    expect(yamlText).not.toMatch(/[&*]ref_\d/);
  });
});

describe("/.well-known/openapi.json", () => {
  let spec;
  beforeAll(() => {
    spec = JSON.parse(readFileSync("public/.well-known/openapi.json", "utf8"));
  });

  it("declares OpenAPI 3.0.x", () => {
    expect(spec.openapi).toMatch(/^3\.0/);
  });

  it("declares info.title + info.version + info.description", () => {
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.info.description.length).toBeGreaterThan(20);
  });

  it("declares at least one server", () => {
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.servers.length).toBeGreaterThanOrEqual(1);
  });

  it("declares an explicit public security requirement", () => {
    // security: [] is the OpenAPI-correct "no auth required" — unambiguous
    // for agents and satisfies the security-defined check on every op.
    expect(spec.security).toEqual([]);
  });

  it("declares core read paths", () => {
    expect(spec.paths["/api/search"]).toBeTruthy();
    expect(spec.paths["/ask"]).toBeTruthy();
    expect(spec.paths["/status"]).toBeTruthy();
    expect(spec.paths["/mcp"]).toBeTruthy();
    expect(spec.paths["/episodes.json"]).toBeTruthy();
    expect(spec.paths["/rss.xml"]).toBeTruthy();
  });

  it("each operation has an operationId (orank API schema check)", () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (typeof op !== "object" || !op.responses) continue;
        expect(op.operationId, `${method.toUpperCase()} ${path} missing operationId`).toBeTruthy();
      }
    }
  });

  it("declares an Error component schema and 4xx responses reference it", () => {
    expect(spec.components?.schemas?.Error).toBeTruthy();
    // At least one path should reference the shared Error envelope.
    const json = JSON.stringify(spec);
    expect(json).toMatch(/"\$ref":\s*"#\/components\/schemas\/Error"/);
  });

  it("declares typed component schemas (EpisodeList, McpManifest, etc.)", () => {
    const expected = ["EpisodeList", "SearchIndex", "RssFeed", "McpManifest"];
    for (const name of expected) {
      expect(spec.components.schemas[name], `missing schema: ${name}`).toBeTruthy();
    }
  });

  it("declares /donate operation with a 402 response", () => {
    expect(spec.paths["/donate"]).toBeTruthy();
    const op = spec.paths["/donate"].post;
    expect(op).toBeTruthy();
    expect(op.operationId).toBe("donate");
    expect(op.responses["402"]).toBeTruthy();
  });

  it("declares x-payment-info on /donate (MPP audit signal)", () => {
    const ext = spec.paths["/donate"].post["x-payment-info"];
    expect(ext).toBeTruthy();
    expect(ext.protocols).toEqual(expect.arrayContaining(["x402", "mpp"]));
    expect(ext.asset).toBe("USDC");
    expect(ext.required).toBe(false);
  });

  it("/donate x-payment-info carries MPP discovery fields", () => {
    // MPP payment discovery (paymentauth.org draft-payment-discovery-00):
    // a payable operation declares intent / method / amount / currency.
    const ext = spec.paths["/donate"].post["x-payment-info"];
    expect(ext.intent).toBe("charge");
    expect(["tempo", "stripe", "lightning", "card"]).toContain(ext.method);
    expect(ext.amount).toBeTruthy();
    expect(ext.currency).toBe("USD");
  });

  it("declares top-level info[x-payment-info] (MPP audit signal at info-block)", () => {
    const ext = spec.info["x-payment-info"];
    expect(ext).toBeTruthy();
    expect(ext.required).toBe(false);
    expect(ext.protocols).toEqual(expect.arrayContaining(["x402", "mpp"]));
    expect(ext.endpoint).toMatch(/\/donate$/);
  });

  it("/donate response advertises Payment headers (x402 + MPP)", () => {
    const headers = spec.paths["/donate"].post.responses["402"].headers;
    expect(headers["WWW-Authenticate"]).toBeTruthy();
    expect(headers["PAYMENT-REQUIRED"]).toBeTruthy();
    expect(headers["X-Payment-Required"]).toBeTruthy();
  });
});
