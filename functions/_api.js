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

function rateLimitHeaders() {
  // Reset = next minute boundary in Unix seconds.
  const reset = Math.ceil(Date.now() / 60000) * 60;
  return {
    "X-RateLimit-Limit": String(RATE_LIMIT_PER_MIN),
    // We don't track per-IP usage in code; remaining mirrors the limit
    // because we never deny. Cloudflare edge rate-limit rules (configured
    // in the dashboard) are the actual enforcement layer.
    "X-RateLimit-Remaining": String(RATE_LIMIT_PER_MIN),
    "X-RateLimit-Reset": String(reset),
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Prefer",
    "Access-Control-Expose-Headers":
      "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
  };
}

// Build the full response header set. Override or extend via `extra`.
export function apiHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
    Vary: "Accept, Prefer",
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
