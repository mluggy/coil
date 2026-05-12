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

// ─── /.well-known/oauth-authorization-server (RFC 8414) ──────────────────
const authServer = {
  issuer: SITE,
  authorization_endpoint: `${SITE}/oauth/authorize`,
  token_endpoint: `${SITE}/oauth/token`,
  registration_endpoint: `${SITE}/oauth/register`,
  jwks_uri: `${SITE}/oauth/jwks.json`,
  scopes_supported: SCOPES,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  service_documentation: `${SITE}/docs.md`,
  ui_locales_supported: ["en"],
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
const protectedResource = {
  resource: SITE,
  authorization_servers: [SITE],
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],
  resource_documentation: `${SITE}/docs.md`,
  // EdDSA when SIGNING_PRIVATE_KEY is set, HS256 fallback otherwise.
  // Both are JWS-compatible; clients verify against /oauth/jwks.json.
  resource_signing_alg_values_supported: ["EdDSA", "HS256"],
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
  jwks_uri: `${SITE}/oauth/jwks.json`,
  registration_endpoint: `${SITE}/oauth/register`,
  scopes_supported: ["openid", ...SCOPES],
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["EdDSA", "HS256"],
  token_endpoint_auth_methods_supported: ["none"],
  grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  claims_supported: ["sub", "iss", "aud", "iat", "exp", "scope"],
  service_documentation: `${SITE}/docs.md`,
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
