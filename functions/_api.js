// Shared helpers for /api/*, /mcp, /ask, /status, and middleware-served
// JSON errors. Underscore prefix keeps this out of the route namespace.
//
// Conventions:
//   - Every JSON response carries CORS, rate-limit, and Cache-Control
//     headers via `apiHeaders()`.
//   - Every error response is a `{ error: { code, message, hint, docs_url } }`
//     envelope via `apiError()`. Listener-language messages preferred —
//     these surface to humans through the agent.
//   - Rate limits are documented (60 req/min/IP) but not enforced in
//     code; enforcement is one Cloudflare dashboard rule away. The
//     headers tell agents the policy so they can self-throttle.

export const RATE_LIMIT_PER_MIN = 60;

export const ERROR_DOCS_URL = "/api/llms.txt";

// Date-based API contract version. The read API is intentionally
// unversioned in its URL path — it's stable and additive-only. Clients
// that want to pin behaviour send the `API-Version` request header; the
// same value is echoed back in the `API-Version` response header on every
// API response. A breaking change would ship under a new date, with the
// prior version kept alive per the deprecation policy in the OpenAPI spec.
export const API_VERSION = "2026-05-18";

// Exported so middleware can attach RFC 9598 rate-limit headers to
// responses it builds itself (static rewrites under /api/, HEAD probes,
// the /api catch-all). Without these, orank's RFC 9598 probe sees
// "no rate-limit headers found on API endpoints".
export function rateLimitHeaders() {
  // We don't track per-IP usage in code; `Remaining` mirrors the limit
  // because we never deny. Cloudflare edge rate-limit rules (configured
  // in the dashboard) are the actual enforcement layer.
  //
  // Emit both the IETF / RFC 9598 names (no `X-` prefix) and the legacy
  // `X-RateLimit-*` names — orank's rate-limit-headers check looks for
  // RFC 9598, and many existing clients only understand the legacy names.
  const now = Date.now();
  const resetUnix = Math.ceil(now / 60000) * 60;
  const resetDelta = Math.max(0, resetUnix - Math.floor(now / 1000));
  const limit = String(RATE_LIMIT_PER_MIN);
  return {
    // RFC 9598 — Reset is delta-seconds until the next window.
    "RateLimit-Limit": limit,
    "RateLimit-Remaining": limit,
    "RateLimit-Reset": String(resetDelta),
    "RateLimit-Policy": `${RATE_LIMIT_PER_MIN};w=60`,
    // Legacy X-* equivalents — Reset is the Unix timestamp.
    "X-RateLimit-Limit": limit,
    "X-RateLimit-Remaining": limit,
    "X-RateLimit-Reset": String(resetUnix),
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Prefer",
    "Access-Control-Expose-Headers":
      "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, " +
      "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, API-Version",
  };
}

// Build the full response header set. Override or extend via `extra`.
export function apiHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
    Vary: "Accept, Prefer",
    "API-Version": API_VERSION,
    ...corsHeaders(),
    ...rateLimitHeaders(),
    ...extra,
  };
}

// Standard CORS preflight handler.
export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "Access-Control-Max-Age": "86400",
    },
  });
}

// JSON success envelope. `body` is whatever payload the endpoint returns.
export function apiOk(body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: apiHeaders(extra),
  });
}

// JSON error envelope. Status defaults to 400.
//   code:    short machine string ("missing_query", "episode_not_found", …)
//   message: one short sentence in listener-friendly English
//   hint:    actionable next step (URL or example), optional
export function apiError({
  status = 400,
  code,
  message,
  hint,
  docsUrl = ERROR_DOCS_URL,
  retryAfterSeconds,
}) {
  const error = { code, message };
  if (hint) error.hint = hint;
  if (docsUrl) error.docs_url = docsUrl;

  const extra = {};
  if (retryAfterSeconds != null) extra["Retry-After"] = String(retryAfterSeconds);

  return new Response(JSON.stringify({ error }), {
    status,
    headers: apiHeaders(extra),
  });
}

// Common error builders — keeps wording consistent across endpoints.
export const errors = {
  missingQuery: () =>
    apiError({
      status: 400,
      code: "missing_query",
      message: "Tell us what to search for. Pass `?q=<your question>`.",
      hint: "/api/search?q=ai",
    }),
  badQuery: (msg) =>
    apiError({
      status: 400,
      code: "bad_query",
      message: msg || "We couldn't read that query.",
      hint: "/api/search?q=<plain text>",
    }),
  episodeNotFound: (id) =>
    apiError({
      status: 404,
      code: "episode_not_found",
      message: `We don't have an episode #${id} on this show.`,
      hint: "/episodes.json — full catalog with valid IDs",
    }),
  notFound: (path) =>
    apiError({
      status: 404,
      code: "not_found",
      message: `No file at ${path}.`,
      hint: "/sitemap.xml — full list of valid paths",
    }),
  methodNotAllowed: (allowed) =>
    apiError({
      status: 405,
      code: "method_not_allowed",
      message: `This endpoint only accepts ${allowed}.`,
      hint: "/api/llms.txt",
    }),
  notAcceptable: (offered) =>
    apiError({
      status: 406,
      code: "not_acceptable",
      message: "We can't serve a representation that matches your Accept header.",
      hint: `Available types: ${(offered || []).join(", ")}. Try Accept: text/html or text/markdown.`,
    }),
  rateLimited: (retryAfter = 60) =>
    apiError({
      status: 429,
      code: "rate_limited",
      message: `You're going faster than ${RATE_LIMIT_PER_MIN} requests/minute.`,
      hint: `Wait ${retryAfter}s, then try again. Headers tell you the limit.`,
      retryAfterSeconds: retryAfter,
    }),
  internal: (detail) =>
    apiError({
      status: 500,
      code: "internal_error",
      message: "Something broke on our side. The show is fine; the API stumbled.",
      hint: detail || "Try again in a moment.",
    }),
};
