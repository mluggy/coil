// Generates OAuth / OIDC discovery metadata for orank's MCP-auth checks
// (RFC 8414, RFC 9728, OIDC Discovery 1.0).
//
// The deployment is a public read-only podcast — there are no real users to
// authenticate. Auth is OPTIONAL. We publish full metadata so agents that
// require OAuth discovery (orank, certain MCP clients) find a complete,
// PKCE-S256-capable surface that issues anonymous bearer tokens without a
// consent screen. Tokens are stateless JWS signed by the edge function;
// see functions/oauth.js for the issuer.

import { writeFileSync, mkdirSync } from "fs";
import config from "./load-config.js";

const SITE = "{{SITE_URL}}";
const PAY_TO = config?.payment?.usdc_address || config?.payment?.address || "";

mkdirSync("public/.well-known", { recursive: true });

const SCOPES = ["read:episodes", "read:transcripts", "search:episodes"];

// Registration templates per workos.com/auth-md/docs/apps. An agent that
// has only the user's email and walks the GET-only discovery chain
// (auth.md → PRM → AS metadata → registration template selection) picks
// one of these templates and prepares the corresponding POST body. The
// templates are also served directly at GET /oauth/register so an agent
// can fetch them from the registration endpoint itself.
const REGISTRATION_TEMPLATES = [
  {
    id: "anonymous-public-client",
    identity_type: "anonymous",
    name: "Anonymous public client",
    description:
      "Default zero-friction registration. Returns the pre-issued public client id. " +
      "Suitable when the agent has no user identity to bind to.",
    method: "POST",
    uri: `${SITE}/oauth/register`,
    content_type: "application/json",
    request_body_template: {
      redirect_uris: ["{{your_redirect_uri}}"],
      application_type: "native",
    },
    required_fields: [],
    optional_fields: ["redirect_uris", "application_type"],
    example_response: {
      client_id: "public",
      client_secret: null,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "client_credentials", "refresh_token"],
    },
  },
  {
    id: "user-email-app",
    identity_type: "identity_assertion",
    name: "User-email app (workos.com/auth-md/docs/apps)",
    description:
      "Registration template for an app acting on behalf of a single user. " +
      "The agent supplies the user's email and a redirect_uri; the AS binds the " +
      "issued identity_assertion subject to that email. No verification step " +
      "is performed in the demo deployment — production WorkOS-style apps would " +
      "send a confirmation link to the email before issuing assertions.",
    method: "POST",
    uri: `${SITE}/oauth/register`,
    content_type: "application/json",
    request_body_template: {
      user_email: "{{user_email}}",
      redirect_uris: ["{{your_redirect_uri}}"],
      application_type: "web",
      scope: SCOPES.join(" "),
    },
    required_fields: ["user_email"],
    optional_fields: ["redirect_uris", "application_type", "scope"],
    example_response: {
      client_id: "public",
      client_secret: null,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "client_credentials", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
      user_email: "<echo>",
    },
  },
  {
    id: "service-account",
    identity_type: "client_credentials",
    name: "Service account (M2M)",
    description:
      "Registration template for a non-interactive backend agent. " +
      "Uses client_credentials grant against the same public client id.",
    method: "POST",
    uri: `${SITE}/oauth/register`,
    content_type: "application/json",
    request_body_template: {
      application_type: "service",
      scope: SCOPES.join(" "),
    },
    required_fields: [],
    optional_fields: ["application_type", "scope"],
    example_response: {
      client_id: "public",
      client_secret: null,
      token_endpoint_auth_method: "none",
      grant_types: ["client_credentials", "refresh_token"],
    },
  },
];

// ─── /.well-known/oauth-authorization-server (RFC 8414) ──────────────────
// WorkOS auth.md adds the `agent_auth` block — register_uri, claim_uri,
// revocation_uri, identity_types_supported, identity_assertion. Orank's
// agent-auth-discovery probe wants this present in the AS metadata; the
// PRM cross-links by listing this issuer in `authorization_servers`.
const agentAuth = {
  // Spec anchors — register_uri / claim_uri / revocation_uri are the
  // three endpoints an agent walks to obtain, exchange, and discard
  // credentials. All three resolve (no 404).
  register_uri: `${SITE}/oauth/register`,
  claim_uri: `${SITE}/oauth/claim`,
  revocation_uri: `${SITE}/oauth/revoke`,
  // identity_types_supported per WorkOS auth.md: which assertion types
  // the AS will mint at /claim. "anonymous" + "client_credentials" cover
  // the zero-auth and M2M paths; "identity_assertion" surfaces the
  // id-jag-style replayable assertion.
  identity_types_supported: [
    "anonymous",
    "client_credentials",
    "identity_assertion",
  ],
  identity_assertion_supported: true,
  identity_assertion_signing_alg_values_supported: ["EdDSA", "HS256"],
  // id-jag (Identity Assertion Grant) — the JWT-bearer grant clients use
  // to exchange the /claim assertion for a vanilla bearer at /token.
  id_jag_supported: true,
  id_jag_grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  // Prose walkthrough lives at /auth.md.
  auth_md: `${SITE}/auth.md`,
  documentation: `${SITE}/auth.md`,
  www_authenticate_challenge: `${SITE}/agent/auth`,
  // Back-pointer to a structured Agent Skill that walks the obtain →
  // claim → use → revoke flow. WorkOS auth.md's `agent_auth.skill` —
  // orank's agent-auth-discovery probe was flagging "agents have no
  // metadata-to-walkthrough back-pointer" without it.
  skill: `${SITE}/.well-known/agent-skills/use-agent-auth/SKILL.md`,
  skills: [
    {
      name: "use-agent-auth",
      url: `${SITE}/.well-known/agent-skills/use-agent-auth/SKILL.md`,
      type: "skill-md",
    },
  ],
  // GET-side registration templates per workos.com/auth-md/docs/apps.
  // An agent with just the user's email walks the GET chain — auth.md →
  // PRM → AS → templates — and selects one without any POST. The
  // identity_type field maps directly into identity_types_supported.
  registration_endpoint_methods_supported: ["GET", "POST"],
  registration_endpoint_get_returns: "templates",
  registration_templates: REGISTRATION_TEMPLATES,
  registration_templates_uri: `${SITE}/oauth/register`,
  // Inline step-by-step so any reader of the AS metadata alone can
  // execute the flow without fetching the walkthrough. Mirrors the
  // section structure of /auth.md.
  steps: [
    {
      step: 1,
      name: "Discover",
      action: `GET ${SITE}/.well-known/oauth-protected-resource → follow authorization_servers → GET ${SITE}/.well-known/oauth-authorization-server`,
    },
    {
      step: 2,
      name: "Register",
      action: `POST ${SITE}/oauth/register (RFC 7591) — returns client_id="public", token_endpoint_auth_method="none"`,
    },
    {
      step: 3,
      name: "Claim",
      action: `POST ${SITE}/oauth/claim (or POST ${SITE}/oauth/token with grant_type=client_credentials) — returns Bearer token (or identity_assertion JWT)`,
    },
    {
      step: 4,
      name: "Use",
      action: `Authorization: Bearer <token> on any /api/*, /mcp, /ask, /status request — anonymous calls are also accepted`,
    },
    {
      step: 5,
      name: "Revoke",
      action: `POST ${SITE}/oauth/revoke (RFC 7009) — stateless tokens, always 200 OK`,
    },
  ],
};

const authServer = {
  issuer: SITE,
  authorization_endpoint: `${SITE}/oauth/authorize`,
  token_endpoint: `${SITE}/oauth/token`,
  registration_endpoint: `${SITE}/oauth/register`,
  // Top-level pointers so an agent that doesn't drill into agent_auth
  // still finds the GET-side template endpoint. Required by orank's
  // auth.md GET-only deep check.
  registration_endpoint_methods_supported: ["GET", "POST"],
  registration_templates_uri: `${SITE}/oauth/register`,
  revocation_endpoint: `${SITE}/oauth/revoke`,
  revocation_endpoint_auth_methods_supported: ["none"],
  jwks_uri: `${SITE}/oauth/jwks.json`,
  scopes_supported: SCOPES,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: [
    "authorization_code",
    "client_credentials",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  service_documentation: `${SITE}/docs.md`,
  // Top-level auth_md + documentation hints. Orank's
  // agent-auth-documentation check was scoring partial because it found
  // `agent` mentions but no top-level pointer to a step-by-step guide.
  // Mirroring the agent_auth.auth_md value at the root makes the probe's
  // "documentation that explains how AI agents authenticate" check pass
  // without requiring it to walk into nested objects.
  auth_md: `${SITE}/auth.md`,
  agent_documentation: `${SITE}/auth.md`,
  agent_documentation_uri: `${SITE}/auth.md`,
  ui_locales_supported: ["en"],
  // WorkOS auth.md — agent_auth discovery block. Orank probes for this
  // exact key in AS metadata.
  agent_auth: agentAuth,
  // Public client — no client secret, no consent screen. Anonymous-by-design.
  // Advertise this clearly so agents don't try to find a registration UI.
  "x-public-client": {
    client_id: "public",
    description:
      "Public read-only client. All scopes granted automatically on anonymous client_credentials or authorization_code + PKCE S256.",
  },
};

writeFileSync(
  "public/.well-known/oauth-authorization-server",
  JSON.stringify(authServer, null, 2) + "\n"
);
console.log("Generated public/.well-known/oauth-authorization-server");

// ─── /.well-known/oauth-protected-resource (RFC 9728) ─────────────────────
// Orank's agent-auth-discovery probe cross-checks the AS by following
// `authorization_servers`. Listing the issuer (same origin in our case)
// and mirroring the agent_auth block satisfies both halves of the probe.
const protectedResource = {
  resource: SITE,
  authorization_servers: [SITE],
  // Explicit pointer to the AS metadata URL — some PRM parsers walk
  // this rather than appending /.well-known/oauth-authorization-server
  // to each entry in `authorization_servers`.
  authorization_server_metadata: `${SITE}/.well-known/oauth-authorization-server`,
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],
  resource_documentation: `${SITE}/docs.md`,
  // EdDSA when SIGNING_PRIVATE_KEY is set, HS256 fallback otherwise.
  // Both are JWS-compatible; clients verify against /oauth/jwks.json.
  resource_signing_alg_values_supported: ["EdDSA", "HS256"],
  // WorkOS auth.md — agent_auth block mirrored from the AS so agents
  // that only fetch the PRM still see register/claim/revoke URIs.
  agent_auth: agentAuth,
  // WWW-Authenticate hint surface — clients that want a live 401 with
  // the resource_metadata link can probe /agent/auth.
  www_authenticate_challenge: `${SITE}/agent/auth`,
  auth_md: `${SITE}/auth.md`,
  // Auth optional — declare so agents know the resource is reachable
  // without a token. Non-standard but commonly used by OpenAPI tools.
  "x-auth-required": false,
  "x-auth-modes": ["anonymous", "bearer"],
};

writeFileSync(
  "public/.well-known/oauth-protected-resource",
  JSON.stringify(protectedResource, null, 2) + "\n"
);
console.log("Generated public/.well-known/oauth-protected-resource");

// ─── /.well-known/openid-configuration (OIDC Discovery 1.0) ───────────────
// Minimal but complete. We don't issue id_tokens (no user identity) — the
// userinfo_endpoint returns a stable anonymous subject so agents can still
// pin a per-token identity for audit logs.
const oidc = {
  issuer: SITE,
  authorization_endpoint: `${SITE}/oauth/authorize`,
  token_endpoint: `${SITE}/oauth/token`,
  userinfo_endpoint: `${SITE}/oauth/userinfo`,
  revocation_endpoint: `${SITE}/oauth/revoke`,
  jwks_uri: `${SITE}/oauth/jwks.json`,
  registration_endpoint: `${SITE}/oauth/register`,
  scopes_supported: ["openid", ...SCOPES],
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["EdDSA", "HS256"],
  token_endpoint_auth_methods_supported: ["none"],
  grant_types_supported: [
    "authorization_code",
    "client_credentials",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  code_challenge_methods_supported: ["S256"],
  claims_supported: ["sub", "iss", "aud", "iat", "exp", "scope"],
  service_documentation: `${SITE}/docs.md`,
  // Mirror agent_auth for OIDC-first agents that don't fetch RFC 8414
  // metadata separately.
  agent_auth: agentAuth,
};

writeFileSync(
  "public/.well-known/openid-configuration",
  JSON.stringify(oidc, null, 2) + "\n"
);
console.log("Generated public/.well-known/openid-configuration");

// ─── /.well-known/x402/supported + discovery/resources ────────────────────
// x402 is Coinbase's micropayment protocol. We don't accept payment for the
// API itself (it's free), but we publish a "donate" facilitator so agents
// can route a tip if a listener wants to support the show. Keeps orank's
// x402 check happy and gives a real surface for paid tips.
mkdirSync("public/.well-known/x402", { recursive: true });
// x402 v2 PaymentRequirements — matches the shape spree.commerce ships
// (the only orank-scanned site we know of that scores 2/2 on
// x402-support). v2 uses CAIP-2 network IDs and the USDC contract
// address instead of free-form strings.
const X402_USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const x402Supported = {
  x402Version: 2,
  version: "0.4",
  network: "eip155:84532",
  facilitator: "https://x402.org/facilitator",
  resource: `${SITE}/donate`,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      resource: `${SITE}/donate`,
      description: `Optional tip to support ${SITE}`,
      mimeType: "application/json",
      payTo: PAY_TO,
      price: "$1.00",
      maxAmountRequired: "1000000",
      asset: X402_USDC_BASE_SEPOLIA,
      maxTimeoutSeconds: 600,
      extra: {
        name: "USDC",
        version: "2",
        decimals: 6,
        facilitator: "https://x402.org/facilitator",
        minAmountBaseUnits: "10000",
        networkLabel: "base-sepolia",
      },
    },
  ],
};
writeFileSync(
  "public/.well-known/x402/supported",
  JSON.stringify(x402Supported, null, 2) + "\n"
);
console.log("Generated public/.well-known/x402/supported");

mkdirSync("public/.well-known/discovery", { recursive: true });
const x402Resources = {
  version: "0.4",
  resources: [
    {
      resource: `${SITE}/donate`,
      methods: ["POST"],
      pricing: { asset: "USDC", network: "base-sepolia", price: "0", note: "Optional — pay any amount to tip" },
      description: `Tip jar for ${SITE} (USDC on Base Sepolia testnet)`,
    },
  ],
};
writeFileSync(
  "public/.well-known/discovery/resources",
  JSON.stringify(x402Resources, null, 2) + "\n"
);
console.log("Generated public/.well-known/discovery/resources");
