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
    // Payment + x402 discovery in HTTP Link header
    expect(link).toMatch(/\/donate>;\s*rel="payment"/);
    expect(link).toMatch(/rel="x402"/);
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
    const resp = await call("/?mode=agent", { headers: { Accept: "application/json" } });
    body = JSON.parse(await resp.text());
  });

  it("returns the agent-mode JSON envelope", () => {
    expect(body.mode).toBe("agent");
    expect(body.schemaVersion).toMatch(/^1\./);
    expect(body.contentType).toBe("podcast");
  });

  it("defaults to an HTML briefing (forter-style) with embedded JSON", async () => {
    const resp = await call("/?mode=agent");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);
    const html = await resp.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/When to use/i);
    expect(html).toMatch(/Webhooks/i);
    // Embedded machine-readable briefing.
    expect(html).toMatch(/<script type="application\/json" id="agent-briefing">/);
    const m = html.match(/<script type="application\/json" id="agent-briefing">([\s\S]*?)<\/script>/);
    const embedded = JSON.parse(m[1].replace(/\\u003c/g, "<"));
    expect(embedded.mode).toBe("agent");
  });

  it("webhooks block advertises supported=true + endpoint", () => {
    expect(body.webhooks.supported).toBe(true);
    expect(body.webhooks.endpoint).toMatch(/\/webhooks$/);
    expect(body.webhooks.events).toContain("episode.published");
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

describe("/webhooks (event subscriptions)", () => {
  it("GET returns the event catalog + payload schema", async () => {
    const resp = await call("/webhooks");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = JSON.parse(await resp.text());
    expect(body.events_supported).toContain("episode.published");
    expect(body.registration_endpoint).toMatch(/\/webhooks$/);
    expect(body.transports.websub.hub).toMatch(/\/webhooks$/);
    expect(body.payload_schema).toBeTruthy();
    expect(body.example_payload.type).toBe("episode.published");
  });

  it("POST (JSON) registers a subscription → 201 + Location", async () => {
    const resp = await call("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://app.example/hook", events: ["episode.published"], secret: "s3cret" }),
    });
    expect(resp.status).toBe(201);
    expect(resp.headers.get("Location")).toMatch(/\/webhooks\//);
    const body = JSON.parse(await resp.text());
    expect(body.status).toBe("active");
    expect(body.callback).toBe("https://app.example/hook");
    // round-trip: GET the subscription
    const id = body.id;
    const got = await call(`/webhooks/${id}`);
    expect(got.status).toBe(200);
    const sub = JSON.parse(await got.text());
    expect(sub.callback).toBe("https://app.example/hook");
    // unsubscribe
    const del = await call(`/webhooks/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(JSON.parse(await del.text()).status).toBe("unsubscribed");
  });

  it("POST (WebSub form) accepts a hub subscription → 202", async () => {
    const resp = await call("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "hub.mode=subscribe&hub.topic=https://example.test/rss.xml&hub.callback=https://app.example/hook",
    });
    expect(resp.status).toBe(202);
    expect(resp.headers.get("Location")).toMatch(/\/webhooks\//);
  });

  it("POST without a callback URL → 400", async () => {
    const resp = await call("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: ["episode.published"] }),
    });
    expect(resp.status).toBe(400);
    expect(JSON.parse(await resp.text()).error.code).toBe("missing_callback");
  });

  it("advertises a WebSub hub in the homepage Link header", async () => {
    const resp = await call("/");
    expect(resp.headers.get("Link") || "").toMatch(/\/webhooks>;\s*rel="hub"/);
  });
});

describe("universal .md twins", () => {
  it("serves a markdown twin for a well-known doc (content page + .md)", async () => {
    const resp = await call("/.well-known/oauth-authorization-server.md");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
    const body = await resp.text();
    // heading-led, never HTML
    expect(body.trimStart().startsWith("#")).toBe(true);
  });

  it("/about alias serves about.md as markdown", async () => {
    const resp = await call("/about");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
  });
});

describe("Accept-header content negotiation (RFC 9110)", () => {
  it("serves markdown when q-value ranks it above HTML", async () => {
    const resp = await call("/", {
      headers: { Accept: "text/html;q=0.8, text/markdown;q=0.9" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
  });

  it("serves HTML when q-value ranks it above markdown", async () => {
    const resp = await call("/", {
      headers: { Accept: "text/markdown;q=0.1, text/html" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("does NOT serve markdown when explicitly refused (q=0)", async () => {
    const resp = await call("/", {
      headers: { Accept: "text/markdown;q=0, text/html" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("returns 406 when no offered type is acceptable", async () => {
    const resp = await call("/", { headers: { Accept: "application/xml" } });
    expect(resp.status).toBe(406);
    const body = JSON.parse(await resp.text());
    expect(body.error.code).toBe("not_acceptable");
    expect(resp.headers.get("Vary") || "").toMatch(/Accept/);
  });

  it("returns 406 when every offering is refused with q=0", async () => {
    const resp = await call("/", {
      headers: { Accept: "text/markdown;q=0, text/html;q=0" },
    });
    expect(resp.status).toBe(406);
  });

  it("treats */* as indifferent → server-preferred HTML", async () => {
    const resp = await call("/", { headers: { Accept: "*/*" } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("serves HTML for a typical browser Accept header", async () => {
    const resp = await call("/", {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("episode /<id> honours q-weighted markdown preference", async () => {
    const resp = await call("/1", {
      headers: { Accept: "text/html;q=0.5, text/markdown;q=1.0" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
  });

  it("episode /<id> returns 406 for an unsatisfiable Accept header", async () => {
    const resp = await call("/1", { headers: { Accept: "image/png" } });
    expect(resp.status).toBe(406);
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
    expect(body.auth.anonymous).toBe(true);
    expect(body.auth.pkce).toBe("S256");
    expect(body.auth.code_challenge_methods_supported).toEqual(["S256"]);
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
    expect(body.tools.length).toBeGreaterThanOrEqual(3);
  });
});

describe("/openapi.json + /swagger.json aliases", () => {
  // env.ASSETS in our test fixture returns markdown for any fetch — the
  // middleware should still rewrite the Content-Type to application/json
  // for the OpenAPI aliases, since real Pages serves the JSON file.
  it("/openapi.json returns the OAS JSON content-type", async () => {
    const resp = await call("/openapi.json");
    expect(resp.status).toBe(200);
    // application/vnd.oai.openapi+json is the registered OAS media type;
    // the +json structured suffix makes it JSON-parseable for clients
    // that don't recognise the vendor prefix.
    expect(resp.headers.get("Content-Type")).toMatch(/application\/vnd\.oai\.openapi\+json/);
  });

  it("/swagger.json (legacy alias) returns the OAS JSON content-type", async () => {
    const resp = await call("/swagger.json");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/application\/vnd\.oai\.openapi\+json/);
  });

  it("aliases include the standard Link header", async () => {
    const resp = await call("/openapi.json");
    const link = resp.headers.get("Link") || "";
    expect(link).toMatch(/rel="sitemap"/);
  });

  it("/openapi.yaml alias returns the OAS YAML content-type", async () => {
    const resp = await call("/openapi.yaml");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/application\/vnd\.oai\.openapi\+yaml/);
  });

  it("/compare alias serves compare.md as markdown", async () => {
    const resp = await call("/compare");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
  });

  it("/auth alias serves auth.md as markdown", async () => {
    const resp = await call("/auth");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
  });
});

describe("/agent/auth (WorkOS auth.md WWW-Authenticate challenge)", () => {
  it("returns 401 with spec-shaped WWW-Authenticate", async () => {
    const resp = await call("/agent/auth");
    expect(resp.status).toBe(401);
    const www = resp.headers.get("WWW-Authenticate") || "";
    expect(www).toMatch(/^Bearer\s/);
    expect(www).toMatch(/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
    expect(www).toMatch(/auth_md="[^"]+\/auth\.md"/);
    expect(www).toMatch(/scope="read:episodes read:transcripts search:episodes"/);
  });

  it("returns JSON body with agent_auth block", async () => {
    const resp = await call("/agent/auth");
    const body = JSON.parse(await resp.text());
    expect(body.error.code).toBe("unauthorized");
    expect(body.agent_auth.register_uri).toMatch(/\/oauth\/register$/);
    expect(body.agent_auth.claim_uri).toMatch(/\/oauth\/claim$/);
    expect(body.agent_auth.revocation_uri).toMatch(/\/oauth\/revoke$/);
    // Spec enum only — anonymous + identity_assertion (client_credentials is
    // a grant, not an identity type).
    expect(body.agent_auth.identity_types_supported).toEqual(
      ["anonymous", "identity_assertion"]
    );
    // Per-type request-shape sibling blocks.
    expect(body.agent_auth.anonymous.credential_types_supported).toContain("api_key");
    expect(body.agent_auth.identity_assertion.assertion_types_supported).toContain(
      "urn:ietf:params:oauth:token-type:id-jag"
    );
    expect(body.agent_auth.identity_assertion.credential_types_supported).toContain("access_token");
    expect(body.agent_auth.skill).toMatch(/\/auth\.md$/);
  });

  it("/.well-known/agent-auth alias works the same way", async () => {
    const resp = await call("/.well-known/agent-auth");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("WWW-Authenticate") || "").toMatch(/^Bearer\s/);
  });
});

describe("homepage ?mode=agent — auth.md surface", () => {
  let body;
  beforeAll(async () => {
    const resp = await call("/?mode=agent", { headers: { Accept: "application/json" } });
    body = JSON.parse(await resp.text());
  });

  it("publishes auth.agent_auth with register/claim/revoke URIs", () => {
    expect(body.auth.agent_auth).toBeTruthy();
    expect(body.auth.agent_auth.register_uri).toMatch(/\/oauth\/register$/);
    expect(body.auth.agent_auth.claim_uri).toMatch(/\/oauth\/claim$/);
    expect(body.auth.agent_auth.revocation_uri).toMatch(/\/oauth\/revoke$/);
    expect(body.auth.agent_auth.identity_assertion_supported).toBe(true);
    expect(body.auth.agent_auth.id_jag_supported).toBe(true);
  });

  it("publishes auth.auth_md + auth.challenge_url", () => {
    expect(body.auth.auth_md).toMatch(/\/auth\.md$/);
    expect(body.auth.challenge_url).toMatch(/\/agent\/auth$/);
  });

  it("publishes oauthClaim, oauthRevoke, authMd, agentAuthChallenge endpoints", () => {
    expect(body.endpoints.oauthClaim).toMatch(/\/oauth\/claim$/);
    expect(body.endpoints.oauthRevoke).toMatch(/\/oauth\/revoke$/);
    expect(body.endpoints.authMd).toMatch(/\/auth\.md$/);
    expect(body.endpoints.agentAuthChallenge).toMatch(/\/agent\/auth$/);
  });
});

describe("Link header — auth.md alternate", () => {
  it("advertises /auth.md as a markdown alternate", async () => {
    const resp = await call("/");
    const link = resp.headers.get("Link") || "";
    expect(link).toMatch(/auth\.md>;\s*rel="alternate";\s*type="text\/markdown";\s*title="auth"/);
  });
});

describe("/mcp/ui/<name> — HTTP view of ui:// MCP App resources", () => {
  it("GET /mcp/ui/latest_episode returns the iframe HTML with full HTTP CSP", async () => {
    const resp = await call("/mcp/ui/latest_episode");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);
    const csp = resp.headers.get("Content-Security-Policy") || "";
    // frame-ancestors only works as an HTTP header (CSP3 forbids it in
    // <meta>) — this surface exists specifically to ship that directive
    // to probes that read CSP from response headers.
    expect(csp).toMatch(/frame-ancestors[^;]*https:\/\/chatgpt\.com/);
    expect(csp).toMatch(/frame-ancestors[^;]*https:\/\/claude\.ai/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/chatgpt\.com/);
    expect(csp).toMatch(/form-action[^;]*https:\/\/claude\.ai/);
    expect(csp).toMatch(/style-src 'self' 'nonce-[0-9a-f]{32}'/);
    const html = await resp.text();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  it("HEAD /mcp/ui/catalog returns the same headers, empty body", async () => {
    const resp = await call("/mcp/ui/catalog", { method: "HEAD" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Security-Policy")).toMatch(/frame-ancestors/);
    expect(await resp.text()).toBe("");
  });

  it("preserves the query string for template URIs", async () => {
    const resp = await call("/mcp/ui/search?q=ai&limit=3");
    expect(resp.status).toBe(200);
    const html = await resp.text();
    // Body should reference the query somehow — at minimum, render the
    // search-results card title for "ai".
    expect(html.toLowerCase()).toContain("ai");
  });

  it("unknown ui:// URI returns a structured 404", async () => {
    const resp = await call("/mcp/ui/does-not-exist");
    expect(resp.status).toBe(404);
  });

  it("OPTIONS preflight allows GET / HEAD", async () => {
    const resp = await call("/mcp/ui/latest_episode", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    const methods = resp.headers.get("Access-Control-Allow-Methods") || "";
    expect(methods.toUpperCase()).toContain("GET");
  });
});

describe("RFC 9598 rate-limit headers on every /api/* response", () => {
  it("GET /api returns a JSON index with rate-limit headers", async () => {
    const resp = await call("/api");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    const body = JSON.parse(await resp.text());
    expect(body.endpoints.search).toMatch(/\/api\/search/);
  });

  it("HEAD /api returns the same rate-limit headers, empty body", async () => {
    const resp = await call("/api", { method: "HEAD" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(await resp.text()).toBe("");
  });

  it("middleware backfills rate-limit headers when downstream forgot them", async () => {
    // Simulate a downstream Pages function returning a bare response —
    // the /api/* passthrough must inject rate-limit headers before
    // returning to the client.
    const bareNext = () =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    const resp = await onRequest({
      request: makeReq("/api/something"),
      next: bareNext,
      env,
    });
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
    expect(resp.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("/api/llms.txt rewrite carries rate-limit headers", async () => {
    const resp = await call("/api/llms.txt");
    expect(resp.headers.get("RateLimit-Limit")).toBeTruthy();
  });
});

describe("agent-mode envelope advertises 202 async pattern + /jobs endpoint", () => {
  let body;
  beforeAll(async () => {
    const resp = await call("/?mode=agent", { headers: { Accept: "application/json" } });
    body = JSON.parse(await resp.text());
  });

  it("includes async block (orank async-job-pattern check)", () => {
    expect(body.async.supported).toBe(true);
    expect(body.async.pattern).toBe("202-accepted-with-location");
    expect(body.async.statusValues).toEqual(
      expect.arrayContaining(["pending", "completed", "failed"]),
    );
    expect(body.async.headers.response).toEqual(
      expect.arrayContaining(["Location", "Retry-After"]),
    );
    expect(body.async.pollEndpoint).toMatch(/\/jobs\/\{id\}$/);
  });

  it("endpoints map publishes askAsync + jobs", () => {
    expect(body.endpoints.askAsync).toMatch(/\/ask\?async=1$/);
    expect(body.endpoints.jobs).toMatch(/\/jobs\/\{id\}$/);
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

// Regression: the universal `.md` twin handler used to strip `.md` from
// every request and 404 when the bare path wasn't an asset — which
// shadowed the real per-skill Agent Skills artifacts (served as static
// files at /.well-known/agent-skills/<name>/SKILL.md) and broke the
// v0.2.0 index. A real `.md` asset must be served verbatim (byte-stable
// so its published sha256 digest still matches), while a `.md` twin of a
// non-.md resource must still be synthesized.
describe("static .md asset vs .md twin", () => {
  const SKILL_BODY =
    "---\nname: find-episode-by-topic\n---\n\nRelative links only: /api/search?q=x\n";
  // Realistic Pages binding: real static files resolve; everything else
  // falls back to SPA index.html (200 text/html), exactly like Pages.
  const realEnv = {
    ASSETS: {
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/.well-known/agent-skills/find-episode-by-topic/SKILL.md") {
          return Promise.resolve(
            new Response(SKILL_BODY, {
              status: 200,
              headers: { "Content-Type": "text/markdown; charset=utf-8" },
            })
          );
        }
        if (p === "/.well-known/oauth-authorization-server") {
          return Promise.resolve(
            new Response('{"issuer":"{{SITE_URL}}"}', {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            })
          );
        }
        // SPA fallback for any missing asset (including the bare `.md` path).
        return Promise.resolve(
          new Response("<!DOCTYPE html><title>spa</title>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        );
      },
    },
  };
  const callReal = (path, init = {}) =>
    onRequest({ request: makeReq(path, init), next, env: realEnv });

  it("serves a real per-skill SKILL.md verbatim (digest-stable)", async () => {
    const resp = await callReal("/.well-known/agent-skills/find-episode-by-topic/SKILL.md");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
    // Body unchanged — no {{SITE_URL}} rewrite, no fence-wrapping — so the
    // bytes match the digest pinned in the agent-skills index.
    expect(await resp.text()).toBe(SKILL_BODY);
  });

  it("still synthesizes a .md twin for a non-.md resource", async () => {
    const resp = await callReal("/.well-known/oauth-authorization-server.md");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/markdown/);
    const body = await resp.text();
    // Twin path fetched the base JSON, fenced it, and rewrote {{SITE_URL}}.
    expect(body).toMatch(/```json/);
    expect(body).not.toMatch(/\{\{SITE_URL\}\}/);
  });
});
