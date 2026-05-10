// Tests for the anonymous public-client OAuth handler at functions/oauth.
// Auth is OPTIONAL on this API — the handler exists for shape compatibility
// with strict OAuth clients (orank, MCP auth probes). Tokens carry no
// privilege; we only verify the contract (RFC 6749 / 8414 / 7636 shapes).

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";
import { onRequest } from "../../functions/oauth/[[path]].js";

const BASE = "https://example.test";

function call(path, init = {}, env = {}) {
  const url = `${BASE}${path}`;
  // Strip the query string before extracting [[path]] segments — the
  // catchall param only mirrors the path portion, never the query.
  const pathOnly = path.split("?")[0];
  const segments = pathOnly.replace(/^\/oauth\/?/, "").split("/").filter(Boolean);
  return onRequest({
    request: new Request(url, init),
    params: { path: segments.length ? segments : [""] },
    env,
  });
}

async function json(resp) {
  return JSON.parse(await resp.text());
}

describe("/oauth/token", () => {
  it("issues an anonymous client_credentials token", async () => {
    const resp = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=public&scope=read:episodes",
    });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toContain("read:episodes");
    // HS256 JWS: header.payload.signature, all base64url
    expect(body.access_token.split(".")).toHaveLength(3);
  });

  it("encodes per-token subject in the JWS payload", async () => {
    const resp = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const { access_token } = await json(resp);
    const [, payloadB64] = access_token.split(".");
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/") +
      "==".slice(0, (4 - (payloadB64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    expect(claims.sub).toMatch(/^anonymous-/);
    expect(claims.client_id).toBe("public");
    expect(claims.iss).toBe(BASE);
  });

  it("filters requested scopes against allowlist", async () => {
    const resp = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // unknown scope is silently dropped, valid one kept
      body: "grant_type=client_credentials&scope=read:episodes admin:wipe",
    });
    const { scope } = await json(resp);
    expect(scope).toContain("read:episodes");
    expect(scope).not.toContain("admin:wipe");
  });

  it("rejects unsupported grant_type", async () => {
    const resp = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=password&username=foo",
    });
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error.code).toBe("unsupported_grant_type");
  });

  it("rejects GET", async () => {
    const resp = await call("/oauth/token", { method: "GET" });
    expect(resp.status).toBe(405);
  });

  it("issues a fresh token on refresh_token grant", async () => {
    const resp = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=anything",
    });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.token_type).toBe("Bearer");
  });
});

describe("/oauth/authorize", () => {
  it("returns a code as JSON when no redirect_uri", async () => {
    const resp = await call(
      "/oauth/authorize?response_type=code&client_id=public&scope=read:episodes",
      { method: "GET" }
    );
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.code).toBeTruthy();
    expect(body.expires_at).toBeGreaterThan(body.issued_at);
  });

  it("redirects with code when redirect_uri given", async () => {
    const resp = await call(
      "/oauth/authorize?response_type=code&client_id=public&redirect_uri=https://app.example/cb&state=xyz",
      { method: "GET", redirect: "manual" }
    );
    expect(resp.status).toBe(302);
    const loc = resp.headers.get("Location");
    expect(loc).toMatch(/^https:\/\/app\.example\/cb\?code=/);
    expect(loc).toContain("state=xyz");
  });

  it("rejects unknown response_type", async () => {
    const resp = await call(
      "/oauth/authorize?response_type=token&client_id=public",
      { method: "GET" }
    );
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error.code).toBe("unsupported_response_type");
  });

  it("rejects non-S256 PKCE method", async () => {
    const resp = await call(
      "/oauth/authorize?response_type=code&code_challenge=x&code_challenge_method=plain",
      { method: "GET" }
    );
    expect(resp.status).toBe(400);
    const body = await json(resp);
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("/oauth/register (RFC 7591)", () => {
  it("returns the public client_id", async () => {
    const resp = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
    });
    expect(resp.status).toBe(201);
    const body = await json(resp);
    expect(body.client_id).toBe("public");
    expect(body.client_secret).toBeNull();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.redirect_uris).toEqual(["https://app.example/cb"]);
  });
});

describe("/oauth/jwks.json", () => {
  it("returns an empty key set (HS256, no public key)", async () => {
    const resp = await call("/oauth/jwks.json", { method: "GET" });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.keys).toEqual([]);
  });
});

describe("/oauth/userinfo", () => {
  it("returns an anonymous subject without a token", async () => {
    const resp = await call("/oauth/userinfo", { method: "GET" });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.sub).toMatch(/^anonymous-/);
    expect(body.client_id).toBe("public");
  });

  it("echoes the bearer-token subject when present", async () => {
    // Mint a token first, then read it back
    const tokenResp = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const { access_token } = await json(tokenResp);
    const userResp = await call("/oauth/userinfo", {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const body = await json(userResp);
    expect(body.sub).toMatch(/^anonymous-/);
  });
});

describe("/oauth/ index", () => {
  it("describes the surface for crawler probes", async () => {
    const resp = await call("/oauth/", { method: "GET" });
    expect(resp.status).toBe(200);
    const body = await json(resp);
    expect(body.endpoints.token).toMatch(/\/oauth\/token$/);
    expect(body.endpoints.authorization_server_metadata).toMatch(
      /\/\.well-known\/oauth-authorization-server$/
    );
    expect(body.scopes).toContain("read:episodes");
  });
});

// ─── EdDSA path (SIGNING_PRIVATE_KEY env var set) ──────────────────────────
describe("EdDSA signing (SIGNING_PRIVATE_KEY set)", () => {
  let pem;
  beforeAll(() => {
    pem = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" });
  });

  it("issues an EdDSA-signed token with `kid` in the header", async () => {
    const resp = await call(
      "/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      },
      { SIGNING_PRIVATE_KEY: pem }
    );
    expect(resp.status).toBe(200);
    const { access_token } = await json(resp);
    const [headerB64] = access_token.split(".");
    const padded =
      headerB64.replace(/-/g, "+").replace(/_/g, "/") +
      "==".slice(0, (4 - (headerB64.length % 4)) % 4);
    const header = JSON.parse(atob(padded));
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBeTruthy();
  });

  it("publishes the matching public JWK at /oauth/jwks.json", async () => {
    const resp = await call(
      "/oauth/jwks.json",
      { method: "GET" },
      { SIGNING_PRIVATE_KEY: pem }
    );
    const body = await json(resp);
    expect(body.keys).toHaveLength(1);
    const k = body.keys[0];
    expect(k.kty).toBe("OKP");
    expect(k.crv).toBe("Ed25519");
    expect(k.alg).toBe("EdDSA");
    expect(k.use).toBe("sig");
    expect(k.x).toBeTruthy();
    expect(k.kid).toBeTruthy();
  });

  it("token's `kid` matches the JWK's `kid` (verifiers can resolve)", async () => {
    const tokenResp = await call(
      "/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      },
      { SIGNING_PRIVATE_KEY: pem }
    );
    const { access_token } = await json(tokenResp);
    const headerB64 = access_token.split(".")[0];
    const padded =
      headerB64.replace(/-/g, "+").replace(/_/g, "/") +
      "==".slice(0, (4 - (headerB64.length % 4)) % 4);
    const tokenKid = JSON.parse(atob(padded)).kid;

    const jwksResp = await call("/oauth/jwks.json", { method: "GET" }, { SIGNING_PRIVATE_KEY: pem });
    const jwksKid = (await json(jwksResp)).keys[0].kid;
    expect(tokenKid).toBe(jwksKid);
  });

  it("falls back to HS256 when key is invalid PEM (no 500)", async () => {
    const resp = await call(
      "/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      },
      { SIGNING_PRIVATE_KEY: "not a pem" }
    );
    expect(resp.status).toBe(200);
    const { access_token } = await json(resp);
    const headerB64 = access_token.split(".")[0];
    const padded =
      headerB64.replace(/-/g, "+").replace(/_/g, "/") +
      "==".slice(0, (4 - (headerB64.length % 4)) % 4);
    expect(JSON.parse(atob(padded)).alg).toBe("HS256");
  });
});
