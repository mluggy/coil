// Generates /auth.md — WorkOS auth.md prose walkthrough for AI agents.
//
// Orank's "/auth.md exists" and "/auth.md structure" checks both fail
// closed without this file. The spec (https://workos.com/auth-md) wants
// a top-level heading, ~200+ chars of prose, and seven named sections
// with the spec anchor keywords: agent_auth, register_uri,
// identity_assertion, id-jag, WWW-Authenticate.
//
// Middleware serves this file with Content-Type: text/markdown and
// rewrites {{SITE_URL}} per-request so the same artifact works on any
// hostname (same convention as AGENTS.md / docs.md / pricing.md).

import { writeFileSync } from "fs";
import config from "./load-config.js";

// Bake the deployment's absolute origin into auth.md at build time when
// podcast.yaml provides `site_url:`. This lets us drop the serve-time
// {{SITE_URL}} rewrite for this file — required so the generated
// use-agent-auth/SKILL.md (which inherits auth.md verbatim) ships
// byte-identical bytes that orank's agent-auth-discovery deep check
// can match against the served auth.md.
//
// When site_url is unset (coil's test/dev config), keep the existing
// {{SITE_URL}} placeholder behavior — middleware rewrites it at serve
// time. Tests run with the placeholder form.
const SITE = config.site_url || "{{SITE_URL}}";
const SCOPES = ["read:episodes", "read:transcripts", "search:episodes"];
const SCOPE_LIST = SCOPES.join(" ");

const doc = [];

doc.push(`# auth.md — ${config.title}`);
doc.push("");
doc.push(
  `> Agent authentication walkthrough for ${config.title}. ` +
  `Every read endpoint is anonymous-by-default — the OAuth surface ` +
  `below exists for agents that need a bearer token, an identity ` +
  `assertion, or a published \`agent_auth\` discovery block. Follows ` +
  `the [WorkOS auth.md spec](https://workos.com/auth-md): \`agent_auth\`, ` +
  `\`register_uri\`, \`identity_assertion\`, id-jag, \`WWW-Authenticate\`.`
);
doc.push("");

// ─── When to use ──────────────────────────────────────────────────────────
doc.push("## When to use");
doc.push("");
doc.push(
  `When to use this walkthrough: an agent needs an explicit bearer token ` +
  `(audit logging, per-token quotas, or a strict MCP client that requires ` +
  `OAuth), or needs to surface an \`identity_assertion\` bound to a user ` +
  `(id-jag style). When **not** to use: anonymous access is acceptable for ` +
  `every read endpoint on ${config.title}; skip this entire walkthrough if ` +
  `you don't need a bearer token. The OAuth surface is here for clients ` +
  `that require it, not as a gating layer.`
);
doc.push("");

// ─── Discover ─────────────────────────────────────────────────────────────
doc.push("## Discover");
doc.push("");
doc.push("Two ways to discover the auth surface, no scraping required:");
doc.push("");
doc.push("1. **WWW-Authenticate challenge.** Probe the agent-auth challenge endpoint to receive a spec-shaped 401 that points at the protected-resource metadata:");
doc.push("");
doc.push("   ```bash");
doc.push(`   curl -i ${SITE}/agent/auth`);
doc.push(`   # HTTP/1.1 401 Unauthorized`);
doc.push(`   # WWW-Authenticate: Bearer realm="${SITE}", scope="${SCOPE_LIST}", resource_metadata="${SITE}/.well-known/oauth-protected-resource", auth_md="${SITE}/auth.md"`);
doc.push("   ```");
doc.push("");
doc.push("2. **Well-known metadata.** Fetch the RFC 9728 protected-resource metadata, then follow `authorization_servers` (or `authorization_server_metadata`) to the RFC 8414 authorization-server metadata. Both documents publish an `agent_auth` block with `register_uri`, `claim_uri`, `revocation_uri`, and `identity_types_supported`.");
doc.push("");
doc.push("   ```bash");
doc.push(`   curl ${SITE}/.well-known/oauth-protected-resource`);
doc.push(`   curl ${SITE}/.well-known/oauth-authorization-server`);
doc.push(`   curl ${SITE}/.well-known/openid-configuration   # mirrors agent_auth for OIDC clients`);
doc.push("   ```");
doc.push("");
doc.push("### GET-only discovery (with just an email)");
doc.push("");
doc.push("Per [workos.com/auth-md/docs/apps](https://workos.com/auth-md/docs/apps), an agent that has only the user's email can walk the full registration-template selection without ever POSTing. Each step is a plain `GET`:");
doc.push("");
doc.push("```bash");
doc.push(`# 1. Read this walkthrough`);
doc.push(`curl ${SITE}/auth.md`);
doc.push("");
doc.push(`# 2. Fetch the protected-resource metadata, follow authorization_servers`);
doc.push(`curl ${SITE}/.well-known/oauth-protected-resource | jq '.authorization_servers, .authorization_server_metadata, .agent_auth'`);
doc.push("");
doc.push(`# 3. Fetch the authorization-server metadata; pick a registration template`);
doc.push(`curl ${SITE}/.well-known/oauth-authorization-server | jq '.agent_auth.registration_templates[]'`);
doc.push("");
doc.push(`# 4. (Optional shortcut) Fetch the templates directly from the registration endpoint`);
doc.push(`curl ${SITE}/oauth/register | jq '.templates[]'`);
doc.push("```");
doc.push("");
doc.push("The `agent_auth.registration_templates` array advertises three identity types — `anonymous`, `client_credentials`, and `identity_assertion`. The `user-email-app` template (`identity_type: identity_assertion`) is the one to pick when you only have the user's email; its `request_body_template` shows exactly which fields to fill in before the eventual POST.");
doc.push("");

// ─── Pick a method ────────────────────────────────────────────────────────
doc.push("## Pick a method");
doc.push("");
doc.push("Three identity flavors are advertised under `agent_auth.identity_types_supported`. Pick the one that fits your agent:");
doc.push("");
doc.push("| identity_type | When to use | Endpoint |");
doc.push("| --- | --- | --- |");
doc.push("| `anonymous` | You only need to read. No auth header required at all. | (no call needed) |");
doc.push(`| \`client_credentials\` | You want a per-request bearer for audit logs or quotas. | \`POST ${SITE}/oauth/token\` with \`grant_type=client_credentials\` |`);
doc.push(`| \`identity_assertion\` | You need an id-jag-style replayable assertion bound to a subject. | \`POST ${SITE}/oauth/claim\` |`);
doc.push("");
doc.push("All three live on the same public client (`client_id=public`, no client secret, PKCE S256 supported). No tier is rate-limited differently — the choice is about credential shape, not access level.");
doc.push("");

// ─── Register ─────────────────────────────────────────────────────────────
doc.push("## Register");
doc.push("");
doc.push(`The \`register_uri\` is [\`${SITE}/oauth/register\`](${SITE}/oauth/register) — RFC 7591 Dynamic Client Registration. The endpoint is open to anyone and returns the pre-issued public client id without an out-of-band approval step. There is no email confirmation, no contact-sales gate, and no manual provisioning queue.`);
doc.push("");
doc.push("```bash");
doc.push(`curl -X POST ${SITE}/oauth/register \\`);
doc.push(`  -H 'Content-Type: application/json' \\`);
doc.push(`  -d '{"redirect_uris":["https://your-app.example/cb"],"application_type":"native"}'`);
doc.push("");
doc.push("# 201 Created");
doc.push("# {");
doc.push('#   "client_id": "public",');
doc.push('#   "client_secret": null,');
doc.push('#   "token_endpoint_auth_method": "none",');
doc.push('#   "grant_types": ["authorization_code", "client_credentials", "refresh_token"],');
doc.push(`#   "scope": "${SCOPE_LIST}"`);
doc.push("# }");
doc.push("```");
doc.push("");
doc.push("Self-serve sandbox: production *is* the sandbox. Endpoints are read-only over static episode data, so there is no separate staging environment or test-key handoff — call the live URLs from day one.");
doc.push("");
doc.push("**`user-email-app` template** — when the agent only has the user's email, fill the `request_body_template` from the GET-only discovery step above and POST it:");
doc.push("");
doc.push("```bash");
doc.push(`curl -X POST ${SITE}/oauth/register \\`);
doc.push(`  -H 'Content-Type: application/json' \\`);
doc.push(`  -d '{"user_email":"<email>","redirect_uris":["https://your-app/cb"],"application_type":"web","scope":"${SCOPE_LIST}"}'`);
doc.push("");
doc.push("# 201 Created — same public client_id, with user_email echoed so the");
doc.push("# subsequent /oauth/claim assertion can be bound to it.");
doc.push("```");
doc.push("");
doc.push("`GET /oauth/register` returns the same `templates` array advertised in `agent_auth.registration_templates`, with `request_body_template`, `required_fields`, and `optional_fields` per template. Available templates:");
doc.push("");
doc.push("| id | identity_type | When to pick |");
doc.push("| --- | --- | --- |");
doc.push("| `anonymous-public-client` | `anonymous` | Agent has no user identity — wants a zero-friction read client. |");
doc.push("| `user-email-app` | `identity_assertion` | Agent has the user's email and needs an identity_assertion bound to it. |");
doc.push("| `service-account` | `client_credentials` | Non-interactive backend agent (M2M). |");
doc.push("");

// ─── Claim ────────────────────────────────────────────────────────────────
doc.push("## Claim");
doc.push("");
doc.push(`The \`claim_uri\` is [\`${SITE}/oauth/claim\`](${SITE}/oauth/claim). It mints an \`identity_assertion\` JWT bound to a per-request anonymous subject. Use this when you want an id-jag-shaped assertion to exchange for a bearer at another resource server, or to replay against this one.`);
doc.push("");
doc.push("```bash");
doc.push(`curl -X POST ${SITE}/oauth/claim \\`);
doc.push(`  -H 'Content-Type: application/x-www-form-urlencoded' \\`);
doc.push(`  -d 'identity_type=identity_assertion&scope=${encodeURIComponent(SCOPE_LIST)}'`);
doc.push("");
doc.push("# {");
doc.push('#   "identity_assertion": "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6Ii4uLiJ9.<payload>.<sig>",');
doc.push('#   "token_type": "identity_assertion",');
doc.push('#   "identity_type": "identity_assertion",');
doc.push(`#   "subject": "anonymous-<random>",`);
doc.push(`#   "scope": "${SCOPE_LIST}",`);
doc.push("#   \"expires_in\": 3600,");
doc.push("#   \"replay_as_bearer\": true");
doc.push("# }");
doc.push("```");
doc.push("");
doc.push("**id-jag exchange (Identity Assertion Grant):** the assertion is acceptable at `/oauth/token` under the JWT-bearer grant type. This is the spec-anchor flow for agents that present a pre-issued assertion from another AS:");
doc.push("");
doc.push("```bash");
doc.push(`curl -X POST ${SITE}/oauth/token \\`);
doc.push(`  -H 'Content-Type: application/x-www-form-urlencoded' \\`);
doc.push(`  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \\`);
doc.push(`  --data-urlencode 'assertion=<identity_assertion-from-claim>'`);
doc.push("```");
doc.push("");
doc.push("(For the simple anonymous case you can also call `grant_type=client_credentials` directly and skip the claim step entirely — the resulting bearer is functionally equivalent for this API.)");
doc.push("");

// ─── Use the credential ───────────────────────────────────────────────────
doc.push("## Use the credential");
doc.push("");
doc.push("Send the bearer (or identity_assertion replayed as a bearer) in the `Authorization` header:");
doc.push("");
doc.push("```bash");
doc.push(`curl -H 'Authorization: Bearer <token>' '${SITE}/api/search?q=ai'`);
doc.push(`curl -H 'Authorization: Bearer <token>' '${SITE}/episodes.json'`);
doc.push("");
doc.push("# MCP transport — same bearer works on POST /mcp:");
doc.push(`curl -X POST ${SITE}/mcp \\`);
doc.push(`  -H 'Authorization: Bearer <token>' \\`);
doc.push(`  -H 'Content-Type: application/json' \\`);
doc.push(`  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`);
doc.push("```");
doc.push("");
doc.push("Tokens are JWS (EdDSA when `SIGNING_PRIVATE_KEY` is configured, HS256 otherwise). Verify against the JWKS at [`/oauth/jwks.json`](`/oauth/jwks.json`). Claims: `iss`, `sub`, `aud`, `iat`, `exp`, `scope`, `client_id`. Token TTL is one hour; refresh via the `refresh_token` grant or by calling `/oauth/token` again.");
doc.push("");
doc.push("**Bearer is optional.** Every endpoint accepts unauthenticated calls — the bearer surface exists so agents that require an OAuth handshake (audit pipelines, strict MCP clients, id-jag bridges) have one.");
doc.push("");

// ─── Errors ───────────────────────────────────────────────────────────────
doc.push("## Errors");
doc.push("");
doc.push("Auth-tier errors use the OAuth 2.0 standard error codes plus the project-wide JSON envelope (`{ error: { code, message, hint, docs_url } }`). The 401 path returns the spec-anchor `WWW-Authenticate` header with a `resource_metadata` parameter pointing at the PRM.");
doc.push("");
doc.push("| Status | Code | Trigger |");
doc.push("| --- | --- | --- |");
doc.push("| 400 | `invalid_request` | Malformed token request (e.g. PKCE `code_verifier` missing). |");
doc.push("| 400 | `invalid_grant` | Authorization code expired or PKCE verifier mismatch. |");
doc.push("| 400 | `unsupported_grant_type` | `grant_type` is not one of the advertised values. |");
doc.push("| 400 | `unsupported_response_type` | `/oauth/authorize` only supports `code`. |");
doc.push("| 401 | `unauthorized` | Returned from `/agent/auth` with `WWW-Authenticate: Bearer resource_metadata=…` so callers can discover the PRM via a single probe. |");
doc.push("| 405 | `method_not_allowed` | Wrong HTTP verb on an OAuth endpoint. |");
doc.push("| 429 | `rate_limited` | Per-IP rate limit exceeded; `Retry-After` is set. |");
doc.push("");
doc.push("Example 401 response from `/agent/auth`:");
doc.push("");
doc.push("```");
doc.push("HTTP/1.1 401 Unauthorized");
doc.push(`WWW-Authenticate: Bearer realm="${SITE}", scope="${SCOPE_LIST}", resource_metadata="${SITE}/.well-known/oauth-protected-resource", auth_md="${SITE}/auth.md"`);
doc.push("Content-Type: application/json");
doc.push("");
doc.push("{");
doc.push('  "error": {');
doc.push('    "code": "unauthorized",');
doc.push('    "message": "Auth challenge — present a bearer token or skip auth entirely.",');
doc.push(`    "hint": "${SITE}/auth.md"`);
doc.push("  }");
doc.push("}");
doc.push("```");
doc.push("");

// ─── Revocation ───────────────────────────────────────────────────────────
doc.push("## Revocation");
doc.push("");
doc.push(`The \`revocation_uri\` is [\`${SITE}/oauth/revoke\`](${SITE}/oauth/revoke) — RFC 7009. Tokens are stateless JWS, so revocation is a courtesy acknowledgement rather than a session lookup: the endpoint accepts any token (or none) and returns \`200 OK\` as the spec mandates. Tokens still expire on their own one-hour TTL.`);
doc.push("");
doc.push("```bash");
doc.push(`curl -X POST ${SITE}/oauth/revoke \\`);
doc.push(`  -H 'Content-Type: application/x-www-form-urlencoded' \\`);
doc.push(`  -d 'token=<access_token>&token_type_hint=access_token'`);
doc.push("");
doc.push("# 200 OK (empty body, per RFC 7009)");
doc.push("```");
doc.push("");
doc.push("If you cycle keys (rotate `SIGNING_PRIVATE_KEY`), all previously-issued tokens stop verifying at the new JWK published under [`/oauth/jwks.json`](`/oauth/jwks.json`). That is the operational revocation mechanism — useful in incident response if a token leaks.");
doc.push("");

// ─── See also ─────────────────────────────────────────────────────────────
doc.push("## See also");
doc.push("");
doc.push(`- Authorization-server metadata (RFC 8414): [\`${SITE}/.well-known/oauth-authorization-server\`](${SITE}/.well-known/oauth-authorization-server)`);
doc.push(`- Protected-resource metadata (RFC 9728): [\`${SITE}/.well-known/oauth-protected-resource\`](${SITE}/.well-known/oauth-protected-resource)`);
doc.push(`- OIDC discovery: [\`${SITE}/.well-known/openid-configuration\`](${SITE}/.well-known/openid-configuration)`);
doc.push(`- JWKS: [\`${SITE}/oauth/jwks.json\`](${SITE}/oauth/jwks.json)`);
doc.push(`- Agent integration guide: [\`${SITE}/AGENTS.md\`](${SITE}/AGENTS.md)`);
doc.push(`- Developer docs: [\`${SITE}/docs.md\`](${SITE}/docs.md)`);
doc.push("");

writeFileSync("public/auth.md", doc.join("\n"));
console.log("Generated public/auth.md");
