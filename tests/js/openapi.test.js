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

  it("every 4xx/5xx response across every operation references the shared Error schema (orank typed-error-model consistency)", () => {
    // The donate 402 used to ship a payment-only inline schema with no
    // Error ref, breaking 100% consistency. Re-audit on every build so
    // a future addition can't silently regress us back to 1/3.
    const errs = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op || typeof op !== "object" || !op.responses) continue;
        for (const [code, resp] of Object.entries(op.responses)) {
          if (!/^[45]/.test(code)) continue;
          if (resp.$ref?.startsWith("#/components/responses/")) continue; // shared, already consistent
          const content = resp.content || {};
          const refsError = (s) =>
            JSON.stringify(s || {}).includes('"$ref":"#/components/schemas/Error"');
          const jsonRefsError = refsError(content["application/json"]?.schema);
          const problemRefsError = refsError(content["application/problem+json"]?.schema);
          if (!jsonRefsError) errs.push(`${method.toUpperCase()} ${path} ${code}: application/json doesn't include $ref to Error`);
          if (!problemRefsError) errs.push(`${method.toUpperCase()} ${path} ${code}: application/problem+json missing or doesn't $ref Error`);
        }
      }
    }
    expect(errs, errs.join("\n")).toEqual([]);
  });

  it("every named error response references the shared Error schema in BOTH application/json AND application/problem+json", () => {
    // Typed-error-model probe wants consistent shape across every 4xx/5xx
    // response and RFC 7807 media-type adoption.
    const named = ["BadRequest", "NotFound", "MethodNotAllowed", "RateLimited", "InternalError"];
    for (const r of named) {
      const resp = spec.components.responses[r];
      expect(resp, `missing response: ${r}`).toBeTruthy();
      expect(resp.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/Error");
      expect(resp.content?.["application/problem+json"]?.schema?.$ref).toBe("#/components/schemas/Error");
    }
  });

  it("every POST operation declares Idempotency-Key as a header parameter", () => {
    // Mutation endpoints should accept Idempotency-Key per Stripe / IETF
    // draft-ietf-httpapi-idempotency-key-header so agents can retry safely.
    const postOps = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (methods.post) postOps.push({ path, op: methods.post });
    }
    expect(postOps.length).toBeGreaterThan(0);
    for (const { path, op } of postOps) {
      const params = op.parameters || [];
      const refs = params.map((p) => p.$ref).filter(Boolean);
      expect(
        refs.includes("#/components/parameters/IdempotencyKey"),
        `POST ${path} (${op.operationId}) is missing Idempotency-Key parameter`,
      ).toBe(true);
    }
  });

  it("declares the IdempotencyKey shared parameter", () => {
    const p = spec.components?.parameters?.IdempotencyKey;
    expect(p).toBeTruthy();
    expect(p.in).toBe("header");
    expect(p.name).toBe("Idempotency-Key");
    expect(p.required).toBe(false);
  });

  it("declares /jobs + /jobs/{id} operations with the 202/200 envelope", () => {
    expect(spec.paths["/jobs"]?.post?.operationId).toBe("createJob");
    expect(spec.paths["/jobs"].post.responses["202"]).toBeTruthy();
    expect(spec.paths["/jobs/{id}"]?.get?.operationId).toBe("getJob");
    expect(spec.components.schemas.JobCreated).toBeTruthy();
    expect(spec.components.schemas.JobStatus).toBeTruthy();
    expect(spec.components.schemas.JobSpec).toBeTruthy();
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
