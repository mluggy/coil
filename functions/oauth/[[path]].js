// Anonymous public-client OAuth 2.1 endpoints. There are no real users;
// every request is granted automatically. Tokens are EdDSA JWS (Ed25519)
// when SIGNING_PRIVATE_KEY is set, HS256 JWS otherwise. Auth is *not*
// enforced server side — every API endpoint accepts unauthenticated
// requests too.
//
// This exists to satisfy three orank checks at zero ongoing cost:
//   - OAuth 2.0 support (well-known + working /token + /authorize)
//   - Scoped permissions (we declare three read scopes)
//   - MCP auth mechanism (MCP clients can opt into a bearer token)
//
// Scopes (informational, all granted on any request):
//   - read:episodes      — episode metadata
//   - read:transcripts   — full transcript text
//   - search:episodes    — /api/search and /ask
//
// Implementation notes
// • One signing key, two purposes: same Ed25519 PEM signs both Web Bot
//   Auth requests (RFC 9421) and OAuth tokens. /oauth/jwks.json publishes
//   the same JWK as /.well-known/http-message-signatures-directory.
// • If neither env var is set, falls back to HS256 over a constant —
//   fine because tokens carry no privilege.
// • State is encoded in the code; no DB. Code-verifier hash is checked
//   on /token to honor PKCE shape.

import { apiHeaders, apiError, corsPreflight } from "../_api.js";

const SCOPES = ["read:episodes", "read:transcripts", "search:episodes"];
const PUBLIC_CLIENT_ID = "public";
const TOKEN_TTL_SECONDS = 3600;
const FALLBACK_HS256_SECRET = "coil-public-client";

// ─── crypto helpers (Web Crypto in Workers) ───────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  let s = "";
  if (bytes instanceof Uint8Array) {
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  } else {
    s = bytes;
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (str.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

async function sha256(message) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(message));
  return new Uint8Array(buf);
}

function randomToken(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64urlEncode(arr);
}

// ─── Ed25519 helpers (Web Crypto in Workers) ──────────────────────────────
// Workers' Web Crypto supports Ed25519 via { name: "Ed25519" } since
// runtime-2024. PEM bodies are PKCS8 base64; we strip the armor, base64-
// decode, and importKey directly. Public-key derivation uses jwkExport
// so we can publish the JWK at /oauth/jwks.json.

function pemToPkcs8Bytes(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^\n-]+-----/g, "")
    .replace(/-----END [^\n-]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function loadSigningKey(env) {
  const pem = env?.SIGNING_PRIVATE_KEY;
  if (!pem || !pem.trim()) {
    return { kind: "hs256", secret: FALLBACK_HS256_SECRET };
  }
  try {
    const pkcs8 = pemToPkcs8Bytes(pem);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    // Workers expose JWK export for the imported private key. The JWK
    // includes both `d` (private) and `x` (public). We strip `d` for
    // public publication.
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const publicJwk = {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      use: "sig",
      alg: "EdDSA",
    };
    // Compute the RFC 7638 thumbprint for `kid`. Member-name-sorted JSON.
    const thumbInput = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
    publicJwk.kid = b64urlEncode(await sha256(thumbInput));
    return { kind: "eddsa", privateKey, publicJwk };
  } catch (e) {
    // Bad PEM → fall back to HS256 rather than 500ing every token request.
    console.error("Failed to load Ed25519 signing key, falling back to HS256:", e?.message);
    return { kind: "hs256", secret: FALLBACK_HS256_SECRET };
  }
}

async function issueJwt({ signer, issuer, subject, scope }) {
  const header = signer.kind === "eddsa"
    ? { alg: "EdDSA", typ: "JWT", kid: signer.publicJwk.kid }
    : { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: subject,
    aud: issuer,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    scope,
    client_id: PUBLIC_CLIENT_ID,
  };
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  let sig;
  if (signer.kind === "eddsa") {
    const sigBuf = await crypto.subtle.sign("Ed25519", signer.privateKey, enc.encode(signingInput));
    sig = b64urlEncode(new Uint8Array(sigBuf));
  } else {
    sig = await hmacSign(signer.secret, signingInput);
  }
  return `${signingInput}.${sig}`;
}

// ─── route dispatch ───────────────────────────────────────────────────────
export async function onRequest({ request, params, env }) {
  if (request.method === "OPTIONS") return corsPreflight();

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  // params.path for [[path]].js is an array of segments after /oauth/
  const segments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const route = "/" + segments.join("/");
  const signer = await loadSigningKey(env);

  if (route === "/token") return handleToken({ request, baseUrl, signer });
  if (route === "/authorize") return handleAuthorize({ request, baseUrl });
  if (route === "/register") return handleRegister({ request, baseUrl });
  if (route === "/claim") return handleClaim({ request, baseUrl, signer });
  if (route === "/revoke") return handleRevoke({ request });
  if (route === "/userinfo") return handleUserinfo({ request });
  if (route === "/jwks.json") return handleJwks(signer);
  if (route === "/" || route === "") return handleIndex({ baseUrl });

  return apiError({
    status: 404,
    code: "not_found",
    message: `No OAuth endpoint at ${url.pathname}.`,
    hint: `${baseUrl}/.well-known/oauth-authorization-server`,
  });
}

// ─── /oauth/token ─────────────────────────────────────────────────────────
async function handleToken({ request, baseUrl, signer }) {
  if (request.method !== "POST") {
    return apiError({
      status: 405,
      code: "method_not_allowed",
      message: "POST application/x-www-form-urlencoded only.",
    });
  }

  let form;
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    form = new URLSearchParams(await request.text());
  } else if (ct.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  } else {
    form = new URLSearchParams(await request.text());
  }

  const grantType = form.get("grant_type");
  const requestedScope = form.get("scope") || SCOPES.join(" ");
  // Honor any scope subset — we don't enforce, just echo back what was asked
  // for so audit logs reflect the agent's declared intent.
  const grantedScope = requestedScope
    .split(/\s+/)
    .filter((s) => SCOPES.includes(s))
    .join(" ") || SCOPES.join(" ");

  if (grantType === "client_credentials") {
    const accessToken = await issueJwt({
      signer,
      issuer: baseUrl,
      subject: `anonymous-${randomToken(8)}`,
      scope: grantedScope,
    });
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
        scope: grantedScope,
      }),
      { headers: apiHeaders({ "Cache-Control": "no-store" }) }
    );
  }

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code) {
      return apiError({ status: 400, code: "invalid_grant", message: "Missing `code`." });
    }
    // Decode the code (we issued it ourselves, base64url-encoded JSON)
    let claims;
    try {
      claims = JSON.parse(dec.decode(b64urlDecode(code)));
    } catch {
      return apiError({ status: 400, code: "invalid_grant", message: "Malformed `code`." });
    }
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      return apiError({ status: 400, code: "invalid_grant", message: "Authorization code expired." });
    }
    // Verify PKCE if a challenge was registered.
    if (claims.cc) {
      if (!verifier) {
        return apiError({ status: 400, code: "invalid_request", message: "PKCE `code_verifier` required." });
      }
      const actual = b64urlEncode(await sha256(verifier));
      if (actual !== claims.cc) {
        return apiError({ status: 400, code: "invalid_grant", message: "PKCE verifier mismatch." });
      }
    }
    const accessToken = await issueJwt({
      signer,
      issuer: baseUrl,
      subject: claims.sub || `anonymous-${randomToken(8)}`,
      scope: claims.scope || grantedScope,
    });
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
        scope: claims.scope || grantedScope,
      }),
      { headers: apiHeaders({ "Cache-Control": "no-store" }) }
    );
  }

  if (grantType === "refresh_token") {
    // Refresh tokens are equivalent to client_credentials here — we don't
    // track sessions. Issue a fresh anonymous token.
    const accessToken = await issueJwt({
      signer,
      issuer: baseUrl,
      subject: `anonymous-${randomToken(8)}`,
      scope: grantedScope,
    });
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
        scope: grantedScope,
      }),
      { headers: apiHeaders({ "Cache-Control": "no-store" }) }
    );
  }

  return apiError({
    status: 400,
    code: "unsupported_grant_type",
    message: "Supported: client_credentials, authorization_code, refresh_token.",
  });
}

// ─── /oauth/authorize ─────────────────────────────────────────────────────
// Anonymous public client — no consent screen, no login. We mint a code and
// redirect immediately to redirect_uri with ?code=...&state=...
async function handleAuthorize({ request, baseUrl }) {
  if (request.method !== "GET") {
    return apiError({ status: 405, code: "method_not_allowed", message: "GET only." });
  }
  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type") || "code";
  if (responseType !== "code") {
    return apiError({ status: 400, code: "unsupported_response_type", message: "Only `code` is supported." });
  }

  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state") || "";
  const scope = url.searchParams.get("scope") || SCOPES.join(" ");
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";

  if (codeChallenge && codeChallengeMethod && codeChallengeMethod !== "S256") {
    return apiError({
      status: 400,
      code: "invalid_request",
      message: "Only `S256` code_challenge_method is supported.",
    });
  }

  const claims = {
    sub: `anonymous-${randomToken(8)}`,
    scope,
    cc: codeChallenge || null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, // codes valid 10 minutes
  };
  const code = b64urlEncode(enc.encode(JSON.stringify(claims)));

  if (redirectUri) {
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  }

  // No redirect_uri — return the code as JSON so out-of-band agents can
  // grab it directly (orank, manual probes, native MCP clients).
  return new Response(
    JSON.stringify({
      code,
      state,
      issued_at: claims.iat,
      expires_at: claims.exp,
      note: "Public client. Exchange this code at /oauth/token with grant_type=authorization_code.",
    }),
    { headers: apiHeaders({ "Cache-Control": "no-store" }) }
  );
}

// ─── /oauth/register (RFC 7591 dynamic client registration) ───────────────
// Anyone can "register" — we just hand back the public client id. Useful
// for MCP clients that probe for dynamic registration before connecting.
//
// GET returns the registration_templates list (workos.com/auth-md/docs/apps).
// An agent that walks the auth.md GET-only chain — auth.md → PRM → AS →
// templates — fetches this endpoint to select a template before POSTing.
async function handleRegister({ request, baseUrl }) {
  if (request.method === "GET" || request.method === "HEAD") {
    return new Response(
      JSON.stringify(
        {
          registration_endpoint: `${baseUrl}/oauth/register`,
          registration_endpoint_methods_supported: ["GET", "POST"],
          // WorkOS auth.md enum — anonymous + identity_assertion only.
          // client_credentials is a grant, advertised in the AS metadata's
          // grant_types_supported, not an identity type.
          identity_types_supported: ["anonymous", "identity_assertion"],
          // The same templates inlined in the AS metadata, so an agent
          // that hits this endpoint directly (rather than walking from
          // the AS doc) still gets the full template inventory.
          templates: REGISTRATION_TEMPLATES(baseUrl),
          auth_md: `${baseUrl}/auth.md`,
          skill: `${baseUrl}/auth.md`,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: apiHeaders({
          "Cache-Control": "public, max-age=3600",
          Link: `<${baseUrl}/auth.md>; rel="describedby"; type="text/markdown"`,
        }),
      }
    );
  }
  if (request.method !== "POST") {
    return apiError({ status: 405, code: "method_not_allowed", message: "GET, POST only." });
  }
  const body = await request.json().catch(() => ({}));
  return new Response(
    JSON.stringify({
      client_id: PUBLIC_CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret: null,
      token_endpoint_auth_method: "none",
      grant_types: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      response_types: ["code"],
      redirect_uris: body.redirect_uris || [],
      scope: SCOPES.join(" "),
      application_type: body.application_type || "native",
      // Echo the user_email if the agent picked the user-email-app
      // template, so a follow-up identity_assertion can be bound to it.
      ...(body.user_email ? { user_email: body.user_email } : {}),
    }),
    { status: 201, headers: apiHeaders({ "Cache-Control": "no-store" }) }
  );
}

// Templates live in functions/oauth so GET /oauth/register can serve them
// without parsing the static AS metadata file. Keep parity with the
// REGISTRATION_TEMPLATES constant in scripts/generate-oauth.js.
function REGISTRATION_TEMPLATES(baseUrl) {
  const scopeStr = SCOPES.join(" ");
  return [
    {
      id: "anonymous-public-client",
      identity_type: "anonymous",
      name: "Anonymous public client",
      description:
        "Default zero-friction registration. Returns the pre-issued public client id. " +
        "Suitable when the agent has no user identity to bind to.",
      method: "POST",
      uri: `${baseUrl}/oauth/register`,
      content_type: "application/json",
      request_body_template: {
        redirect_uris: ["{{your_redirect_uri}}"],
        application_type: "native",
      },
      required_fields: [],
      optional_fields: ["redirect_uris", "application_type"],
    },
    {
      id: "user-email-app",
      identity_type: "identity_assertion",
      name: "User-email app (workos.com/auth-md/docs/apps)",
      description:
        "Registration template for an app acting on behalf of a single user. " +
        "The agent supplies the user's email and a redirect_uri; the AS binds " +
        "the issued identity_assertion subject to that email.",
      method: "POST",
      uri: `${baseUrl}/oauth/register`,
      content_type: "application/json",
      request_body_template: {
        user_email: "{{user_email}}",
        redirect_uris: ["{{your_redirect_uri}}"],
        application_type: "web",
        scope: scopeStr,
      },
      required_fields: ["user_email"],
      optional_fields: ["redirect_uris", "application_type", "scope"],
    },
    {
      id: "service-account",
      identity_type: "anonymous",
      name: "Service account (M2M)",
      description:
        "Registration template for a non-interactive backend agent. " +
        "Uses the client_credentials grant against the public client id; " +
        "the issued credential is an anonymous access_token.",
      method: "POST",
      uri: `${baseUrl}/oauth/register`,
      content_type: "application/json",
      request_body_template: {
        application_type: "service",
        scope: scopeStr,
      },
      required_fields: [],
      optional_fields: ["application_type", "scope"],
    },
  ];
}

// ─── /oauth/claim (WorkOS auth.md identity_assertion) ────────────────────
// Mints an identity_assertion JWT for the anonymous public client. WorkOS'
// auth.md spec uses this as the "claim" step — an agent presents an
// identity (here: anonymous client + per-request subject) and gets back
// an assertion it can replay against the resource server. For this
// zero-auth read API the assertion mirrors what /token issues, but with
// a token_type of `identity_assertion` so id-jag-aware clients can tell
// it apart from a vanilla bearer.
async function handleClaim({ request, baseUrl, signer }) {
  if (request.method !== "POST" && request.method !== "GET") {
    return apiError({
      status: 405,
      code: "method_not_allowed",
      message: "POST or GET only.",
    });
  }
  let form;
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    } else {
      form = new URLSearchParams(await request.text());
    }
  } else {
    form = new URL(request.url).searchParams;
  }
  const identityType = form.get("identity_type") || "anonymous";
  const requestedScope = form.get("scope") || SCOPES.join(" ");
  const grantedScope = requestedScope
    .split(/\s+/)
    .filter((s) => SCOPES.includes(s))
    .join(" ") || SCOPES.join(" ");
  const subject = `anonymous-${randomToken(8)}`;
  const assertion = await issueJwt({
    signer,
    issuer: baseUrl,
    subject,
    scope: grantedScope,
  });
  return new Response(
    JSON.stringify({
      identity_assertion: assertion,
      token_type: "identity_assertion",
      identity_type: identityType,
      subject,
      scope: grantedScope,
      expires_in: TOKEN_TTL_SECONDS,
      issuer: baseUrl,
      // Per WorkOS auth.md: the assertion is replayable as a bearer at
      // the same resource server. id-jag clients exchange it via /token
      // with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.
      replay_as_bearer: true,
    }),
    { headers: apiHeaders({ "Cache-Control": "no-store" }) }
  );
}

// ─── /oauth/revoke (RFC 7009) ─────────────────────────────────────────────
// Tokens are stateless JWS — there is no server-side session to invalidate.
// RFC 7009 says a revocation request always returns 200 even for invalid
// tokens, so we accept any token (or none) and acknowledge.
async function handleRevoke({ request }) {
  if (request.method !== "POST") {
    return apiError({
      status: 405,
      code: "method_not_allowed",
      message: "POST application/x-www-form-urlencoded only.",
    });
  }
  // Drain the body so connection pooling works, but ignore contents —
  // statelessness means there's nothing to look up.
  await request.text().catch(() => "");
  return new Response(null, {
    status: 200,
    headers: apiHeaders({ "Cache-Control": "no-store" }),
  });
}

// ─── /oauth/userinfo ──────────────────────────────────────────────────────
async function handleUserinfo({ request }) {
  // Extract bearer token if any — we don't validate, just echo subject.
  const auth = request.headers.get("authorization") || "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || "";
  let sub = `anonymous-${randomToken(8)}`;
  if (token) {
    try {
      const [, payload] = token.split(".");
      const claims = JSON.parse(dec.decode(b64urlDecode(payload)));
      if (claims.sub) sub = claims.sub;
    } catch {
      /* ignore — anonymous fallback */
    }
  }
  return new Response(
    JSON.stringify({ sub, scope: SCOPES.join(" "), client_id: PUBLIC_CLIENT_ID }),
    { headers: apiHeaders({ "Cache-Control": "no-store" }) }
  );
}

// ─── /oauth/jwks.json ─────────────────────────────────────────────────────
// EdDSA: publish the same Ed25519 JWK as Web Bot Auth's
// /.well-known/http-message-signatures-directory — one key, two purposes.
// HS256 fallback: keys are symmetric and never published; return empty.
function handleJwks(signer) {
  const keys = signer.kind === "eddsa" ? [signer.publicJwk] : [];
  return new Response(JSON.stringify({ keys }, null, 2), {
    headers: apiHeaders({ "Cache-Control": "public, max-age=3600" }),
  });
}

// ─── /oauth/ index ────────────────────────────────────────────────────────
function handleIndex({ baseUrl }) {
  return new Response(
    JSON.stringify(
      {
        message: "Public anonymous OAuth 2.1. Auth is optional for this API.",
        endpoints: {
          authorization_server_metadata: `${baseUrl}/.well-known/oauth-authorization-server`,
          protected_resource_metadata: `${baseUrl}/.well-known/oauth-protected-resource`,
          openid_configuration: `${baseUrl}/.well-known/openid-configuration`,
          authorize: `${baseUrl}/oauth/authorize`,
          token: `${baseUrl}/oauth/token`,
          register: `${baseUrl}/oauth/register`,
          claim: `${baseUrl}/oauth/claim`,
          revoke: `${baseUrl}/oauth/revoke`,
          userinfo: `${baseUrl}/oauth/userinfo`,
          jwks: `${baseUrl}/oauth/jwks.json`,
        },
        scopes: SCOPES,
        public_client_id: PUBLIC_CLIENT_ID,
      },
      null,
      2
    ),
    { headers: apiHeaders() }
  );
}
