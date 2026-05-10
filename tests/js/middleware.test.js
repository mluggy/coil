// Middleware tests — exercise the file-based-routing edge that handles
// content negotiation, agent-mode JSON, Link headers (RFC 8288), MCP
// well-known dispatch, and redirects.
//
// We mock `next()` and `env.ASSETS` minimally so the handler runs inside
// vitest without a real Cloudflare Worker.

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { onRequest } from "../../functions/_middleware.js";

const BASE = "https://example.test";

// Make sure the build artifacts middleware reads (functions/_episodes.js,
// functions/_config.js, functions/_html-template.js) are fresh enough to
// import. They are already imported at module load — running yaml-to-json
// + html-template before the import is the safest way to ensure they
// exist on a fresh checkout. Vitest hot-reload handles re-imports per run.
beforeAll(() => {
  if (!existsSync("functions/_episodes.js") || !existsSync("functions/_config.js")) {
    execSync("node scripts/yaml-to-json.js && node scripts/generate-html-template.js", { stdio: "pipe" });
  }
});

function makeReq(path, init = {}) {
  return new Request(`${BASE}${path}`, init);
}

// `next()` mimics Pages' static-asset fallback. We always return a small
// HTML body so the middleware's "did Pages give us SPA HTML for an
// extensioned path?" check has something to inspect.
function next() {
  return Promise.resolve(
    new Response("<!DOCTYPE html><title>spa</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );
}

// Minimal ASSETS binding that returns a fixed text body — enough for the
// /docs and /pricing alias paths + Accept: text/markdown homepage path.
const env = {
  ASSETS: {
    fetch(_req) {
      return Promise.resolve(
        new Response("# fixture\n\n{{SITE_URL}}/cover.png\n", {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        })
      );
    },
  },
};

async function call(path, init = {}) {
  return onRequest({ request: makeReq(path, init), next, env });
}

describe("homepage HTML", () => {
  it("returns 200 + HTML + Link header (RFC 8288)", async () => {
    const resp = await call("/");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type") || "").toMatch(/text\/html/);
    const link = resp.headers.get("Link") || "";
    expect(link).toMatch(/rel="sitemap"/);
    expect(link).toMatch(/agent\.json>;\s*rel="describedby"/);
    expect(link).toMatch(/openapi\.json>;\s*rel="service-desc"/);
    expect(link).toMatch(/rel="mcp"/);
    expect(link).toMatch(/index\.md>;\s*rel="alternate";\s*type="text\/markdown"/);
  });

  it("emits security headers (CSP, X-Frame-Options, etc.)", async () => {
    const resp = await call("/");
    expect(resp.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(resp.headers.get("X-Frame-Options")).toBe("DENY");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(resp.headers.get("Referrer-Policy")).toBeTruthy();
  });
});

describe("homepage ?mode=agent", () => {
  let body;
  beforeAll(async () => {
    const resp = await call("/?mode=agent");
    body = JSON.parse(await resp.text());
  });

  it("returns the agent-mode JSON envelope", () => {
    expect(body.mode).toBe("agent");
    expect(body.schemaVersion).toMatch(/^1\./);
    expect(body.contentType).toBe("podcast");
  });

  it("includes auth.optionalOAuth metadata block", () => {
    expect(body.auth.type).toBe("none");
    expect(body.auth.required).toBe(false);
    expect(body.auth.optionalOAuth.flow).toBe("authorization_code");
    expect(body.auth.optionalOAuth.pkce).toBe("S256");
    expect(body.auth.optionalOAuth.scopes).toContain("read:episodes");
  });

  it("includes pricing + rateLimits + errorEnvelope blocks", () => {
    expect(body.pricing.model).toBe("free");
    expect(body.rateLimits.perMinute).toBe(60);
    expect(body.errorEnvelope.statusCodes).toEqual(
      expect.arrayContaining([400, 402, 404, 429])
    );
  });

  it("publishes endpoint URIs (search, mcp, openapi, oauth, donate, x402)", () => {
    expect(body.endpoints.search).toMatch(/\/api\/search/);
    expect(body.endpoints.mcp).toMatch(/\/mcp$/);
    expect(body.endpoints.openapi).toMatch(/openapi\.json$/);
    expect(body.endpoints.oauthAuthorizationServer).toMatch(/oauth-authorization-server$/);
    expect(body.endpoints.oauthToken).toMatch(/\/oauth\/token$/);
    expect(body.endpoints.donate).toMatch(/\/donate$/);
    expect(body.endpoints.x402Discovery).toMatch(/\/discovery\/resources$/);
    expect(body.endpoints.skillManifest).toMatch(/\/SKILL\.md$/);
  });

  it("publishes capability list", () => {
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        "browse_episodes",
        "search_transcripts",
        "ask_natural_language",
      ])
    );
  });
});

describe("homepage Accept: text/markdown", () => {
  it("returns markdown content-type (served via env.ASSETS)", async () => {
    const resp = await call("/", {
      headers: { Accept: "text/markdown" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(resp.headers.get("Vary") || "").toMatch(/Accept/);
  });
});

describe("episode redirect /<id>", () => {
  // Episode regex matches /\d{1,3} — use a 3-digit ID that doesn't exist
  // in the seeded fixture (the test fixture has only id=1).
  it("redirects 301 to / for unknown episodes when not an agent context", async () => {
    const resp = await call("/999");
    expect(resp.status).toBe(301);
    expect(resp.headers.get("Location")).toBe("/");
  });

  it("returns JSON 404 envelope for unknown episodes when ?mode=agent", async () => {
    const resp = await call("/999?mode=agent");
    expect(resp.status).toBe(404);
    const body = JSON.parse(await resp.text());
    expect(body.error.code).toBe("episode_not_found");
  });

  it("returns JSON 404 envelope for unknown episodes when Accept: application/json", async () => {
    const resp = await call("/999", { headers: { Accept: "application/json" } });
    expect(resp.status).toBe(404);
  });
});

describe("/.well-known/mcp dispatch", () => {
  it("GET returns the manifest with auth metadata + WWW-Authenticate", async () => {
    const resp = await call("/.well-known/mcp");
    expect(resp.status).toBe(200);
    const wwwAuth = resp.headers.get("WWW-Authenticate") || "";
    expect(wwwAuth).toMatch(/^Bearer\b/);
    expect(wwwAuth).toMatch(/resource_metadata="[^"]+oauth-protected-resource"/);
    const body = JSON.parse(await resp.text());
    expect(body.protocolVersion).toBeTruthy();
    expect(body.transport).toBe("streamable-http");
    expect(body.auth.type).toBe("oauth2");
    expect(body.auth.required).toBe(false);
    expect(body.auth.pkce).toBe("S256");
  });

  it("POST routes to the MCP JSON-RPC handler (live handshake)", async () => {
    const resp = await call("/.well-known/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(resp.status).toBe(200);
    const body = JSON.parse(await resp.text());
    expect(body.id).toBe(1);
    expect(body.result).toEqual({});
  });

  it("aliases /.well-known/mcp.json + /mcp-configuration to the same manifest", async () => {
    for (const p of [
      "/.well-known/mcp.json",
      "/.well-known/mcp-configuration",
      "/.well-known/mcp/server.json",
    ]) {
      const resp = await call(p);
      expect(resp.status).toBe(200);
      const body = JSON.parse(await resp.text());
      expect(body.transport).toBe("streamable-http");
    }
  });

  it("/.well-known/mcp/server-card.json exposes auth + tools[]", async () => {
    const resp = await call("/.well-known/mcp/server-card.json");
    expect(resp.status).toBe(200);
    const body = JSON.parse(await resp.text());
    expect(body.auth.type).toBe("oauth2");
    expect(body.auth.pkce).toBe("S256");
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThanOrEqual(5);
  });
});

describe("legacy redirects", () => {
  it("/subscribe → 301 to /", async () => {
    const resp = await call("/subscribe");
    expect(resp.status).toBe(301);
    expect(resp.headers.get("Location")).toBe("/");
  });

  it("unknown extensionless path → 301 to /", async () => {
    const resp = await call("/does-not-exist");
    expect(resp.status).toBe(301);
  });
});
