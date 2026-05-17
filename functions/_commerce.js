// Demo agentic-commerce surfaces — UCP (Universal Commerce Protocol,
// ucp.dev) and ACP (Agentic Commerce Protocol, OpenAI).
//
// This podcast is free: there is nothing to buy and no payment is ever
// taken. These endpoints exist only so commerce-capable agents can
// discover and exercise the protocol handshake — every response is a
// canned, zero-total demo object. No order is created, no card is
// charged. The `demo`/`livemode` flags and `availability` blocks say so
// explicitly in every payload.

import config from "./_config.js";

// Protocol spec dates (YYYY-MM-DD) advertised in the discovery profiles
// and echoed in the version response headers.
const UCP_VERSION = "2026-01-11";
const ACP_VERSION = "2025-09-29";

const DEMO_MESSAGE =
  "Demo only — this is a free podcast. Nothing is for sale and no payment " +
  "is ever taken. This surface returns canned, spec-shaped objects so that " +
  "commerce-capable agents can exercise the protocol handshake.";

// CORS + protocol headers. These surfaces serve only public,
// non-credentialed canned data, so a literal `*` origin is correct.
function commerceHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, UCP-Agent, UCP-Version, API-Version, Idempotency-Key, Authorization",
    "Access-Control-Expose-Headers":
      "UCP-Version, API-Version, Idempotency-Key, Request-Id",
    "X-Content-Type-Options": "nosniff",
    "Request-Id": crypto.randomUUID(),
    ...extra,
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: commerceHeaders(extra),
  });
}

function commerceError(status, code, message, extra = {}) {
  return json({ error: { code, message } }, status, extra);
}

function publisher(baseUrl) {
  return {
    name: config.publisher || config.author || config.title,
    url: baseUrl,
    ...(config.owner_email ? { contact: config.owner_email } : {}),
  };
}

// ─── UCP discovery profile — GET /.well-known/ucp ─────────────────────────
export function ucpDiscovery(baseUrl) {
  const profile = {
    // Top-level + nested `version` (YYYY-MM-DD) — discovery scanners read
    // either spelling.
    version: UCP_VERSION,
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": {
          version: UCP_VERSION,
          spec: "https://ucp.dev/specification/overview",
          rest: {
            schema: "https://ucp.dev/services/shopping/rest.openapi.json",
            endpoint: `${baseUrl}/checkout-sessions`,
          },
        },
      },
      capabilities: [
        {
          name: "dev.ucp.shopping.checkout",
          version: UCP_VERSION,
          spec: "https://ucp.dev/specification/checkout",
          schema: "https://ucp.dev/schemas/shopping/checkout.json",
        },
      ],
    },
    availability: {
      status: "demo-only",
      livemode: false,
      purpose: DEMO_MESSAGE,
      endpoints: [
        { operation: "create_checkout_session", method: "POST", path: "/checkout-sessions", headers: ["UCP-Agent", "Idempotency-Key"], auth: "none (demo)" },
        { operation: "get_checkout_session", method: "GET", path: "/checkout-sessions/{id}", auth: "none (demo)" },
        { operation: "complete_checkout_session", method: "POST", path: "/checkout-sessions/{id}/complete", auth: "none (demo)" },
        { operation: "cancel_checkout_session", method: "POST", path: "/checkout-sessions/{id}/cancel", auth: "none (demo)" },
      ],
    },
    publisher: publisher(baseUrl),
    related: {
      openapi: `${baseUrl}/.well-known/openapi.json`,
      mcp: `${baseUrl}/mcp`,
      acp_discovery: `${baseUrl}/.well-known/acp.json`,
      llms_txt: `${baseUrl}/llms.txt`,
    },
  };
  return json(profile, 200, {
    "Cache-Control": "public, max-age=3600",
    "UCP-Version": UCP_VERSION,
  });
}

// ─── ACP discovery profile — GET /.well-known/acp.json ────────────────────
export function acpDiscovery(baseUrl) {
  const profile = {
    protocol: {
      name: "acp",
      version: ACP_VERSION,
      supported_versions: [ACP_VERSION],
      documentation_url: "https://developers.openai.com/commerce",
    },
    api_base_url: baseUrl,
    transports: ["rest"],
    capabilities: { services: ["checkout"] },
    availability: {
      status: "demo-only",
      livemode: false,
      purpose: DEMO_MESSAGE,
      endpoints: [
        { operation: "create_checkout_session", method: "POST", path: "/checkout_sessions", headers: ["API-Version", "Idempotency-Key"], auth: "none (demo)" },
        { operation: "get_checkout_session", method: "GET", path: "/checkout_sessions/{id}", auth: "none (demo)" },
        { operation: "complete_checkout_session", method: "POST", path: "/checkout_sessions/{id}/complete", auth: "none (demo)" },
        { operation: "cancel_checkout_session", method: "POST", path: "/checkout_sessions/{id}/cancel", auth: "none (demo)" },
      ],
    },
    publisher: publisher(baseUrl),
    related: {
      openapi: `${baseUrl}/.well-known/openapi.json`,
      mcp: `${baseUrl}/mcp`,
      ucp_discovery: `${baseUrl}/.well-known/ucp`,
      llms_txt: `${baseUrl}/llms.txt`,
    },
  };
  return json(profile, 200, {
    "Cache-Control": "public, max-age=3600",
    "API-Version": ACP_VERSION,
  });
}

// Canned checkout-session object. Stateless: the id is echoed, the body
// is always a zero-total demo session — nothing is persisted or charged.
function checkoutSession(protocol, id, status, baseUrl, idemKey) {
  const isUcp = protocol === "ucp";
  const base = isUcp ? "/checkout-sessions" : "/checkout_sessions";
  return {
    id,
    object: "checkout_session",
    protocol: protocol.toUpperCase(),
    [isUcp ? "ucp_version" : "api_version"]: isUcp ? UCP_VERSION : ACP_VERSION,
    status,
    line_items: [],
    currency: "USD",
    totals: {
      subtotal: { amount: "0.00", currency: "USD" },
      total: { amount: "0.00", currency: "USD" },
    },
    payment: {
      status: status === "completed" ? "not_charged" : "not_required",
      note: "No payment is collected — this is a free podcast.",
    },
    livemode: false,
    demo: true,
    message: DEMO_MESSAGE,
    ...(idemKey ? { idempotency_key: idemKey } : {}),
    links: {
      self: `${baseUrl}${base}/${id}`,
      discovery: isUcp ? `${baseUrl}/.well-known/ucp` : `${baseUrl}/.well-known/acp.json`,
      spec: isUcp
        ? "https://ucp.dev/specification/overview"
        : "https://developers.openai.com/commerce",
    },
    created: Math.floor(Date.now() / 1000),
  };
}

// Both protocols require Idempotency-Key on writes plus a protocol agent
// header (UCP-Agent / API-Version). Returns { ok, idemKey } or
// { ok:false, field }.
function requireHeaders(request, protocol) {
  const agentField = protocol === "ucp" ? "UCP-Agent" : "API-Version";
  if (!request.headers.get(agentField)) return { ok: false, field: agentField };
  const idem = request.headers.get("Idempotency-Key");
  if (!idem) return { ok: false, field: "Idempotency-Key" };
  return { ok: true, idemKey: idem };
}

// ─── Checkout REST surface ────────────────────────────────────────────────
// UCP  → /checkout-sessions[...]   (protocol="ucp")
// ACP  → /checkout_sessions[...]   (protocol="acp")
export function handleCheckout(request, baseUrl, protocol) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: commerceHeaders() });
  }

  const base = protocol === "ucp" ? "/checkout-sessions" : "/checkout_sessions";
  const sub = new URL(request.url).pathname.slice(base.length);
  const version = protocol === "ucp" ? UCP_VERSION : ACP_VERSION;
  const verHeader = protocol === "ucp" ? "UCP-Version" : "API-Version";
  const missing = (field) =>
    commerceError(400, "missing_header", `Missing required header: ${field}.`, {
      [verHeader]: version,
    });

  // Create — POST /checkout[-_]sessions
  if (sub === "" || sub === "/") {
    if (request.method !== "POST") {
      return commerceError(405, "method_not_allowed", `Create a checkout session with POST ${base}.`, { Allow: "POST, OPTIONS" });
    }
    const hdr = requireHeaders(request, protocol);
    if (!hdr.ok) return missing(hdr.field);
    const id = `cs_demo_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    return json(checkoutSession(protocol, id, "ready_for_payment", baseUrl, hdr.idemKey), 200, {
      [verHeader]: version,
      "Idempotency-Key": hdr.idemKey,
    });
  }

  // /{id} or /{id}/{action}
  const m = sub.match(/^\/([A-Za-z0-9_-]+)(?:\/(complete|cancel))?$/);
  if (!m) return commerceError(404, "not_found", "Unknown checkout-session path.");
  const [, id, action] = m;

  // Retrieve / update a session — GET or POST /checkout[-_]sessions/{id}
  if (!action) {
    if (request.method === "GET") {
      return json(checkoutSession(protocol, id, "ready_for_payment", baseUrl, null), 200, { [verHeader]: version });
    }
    if (request.method === "POST") {
      const hdr = requireHeaders(request, protocol);
      if (!hdr.ok) return missing(hdr.field);
      return json(checkoutSession(protocol, id, "ready_for_payment", baseUrl, hdr.idemKey), 200, {
        [verHeader]: version,
        "Idempotency-Key": hdr.idemKey,
      });
    }
    return commerceError(405, "method_not_allowed", "Use GET or POST on a checkout session.", { Allow: "GET, POST, OPTIONS" });
  }

  // Complete / cancel — POST /checkout[-_]sessions/{id}/{action}
  if (request.method !== "POST") {
    return commerceError(405, "method_not_allowed", `${action} requires POST.`, { Allow: "POST, OPTIONS" });
  }
  const hdr = requireHeaders(request, protocol);
  if (!hdr.ok) return missing(hdr.field);
  const status = action === "complete" ? "completed" : "canceled";
  return json(checkoutSession(protocol, id, status, baseUrl, hdr.idemKey), 200, {
    [verHeader]: version,
    "Idempotency-Key": hdr.idemKey,
  });
}
