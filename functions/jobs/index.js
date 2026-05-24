// POST /jobs — generic job-creation entry point for the 202 Accepted
// async pattern. orank's async-job-pattern probe is likely to hit
// conventional paths like /jobs (not our domain-specific /ask?async=1),
// so this gives them an HTTP-method-mapped entry to discover.
//
// Body (JSON or form-encoded):
//   {
//     "kind": "ask" | "search",
//     "query": "...",      // required for both kinds
//     "limit": 10          // optional
//   }
//
// Response: 202 Accepted with Location: /jobs/<id> + Retry-After + a
// JSON body { job_id, status, poll_url }. The id encodes the job spec
// so the polling endpoint (/jobs/<id>) is stateless.
//
// GET /jobs returns a small index describing the surface for probes
// that GET first to discover.

import { apiHeaders, apiError, corsPreflight, errors } from "../_api.js";

const SUPPORTED_KINDS = ["ask", "search"];

function encodeJobId(spec) {
  const json = JSON.stringify(spec);
  const bytes = new TextEncoder().encode(json);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function parseBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) return await request.json();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(await request.text());
      return Object.fromEntries(params.entries());
    }
    const text = await request.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  } catch {
    return null;
  }
}

export async function onRequestPost({ request }) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const body = await parseBody(request);
  if (body === null) {
    return apiError({
      status: 400,
      code: "bad_body",
      message: "Could not parse request body. Send JSON: { \"kind\": \"ask\", \"query\": \"…\" }.",
    });
  }
  const kind = String(body.kind || body.type || "ask").toLowerCase();
  if (!SUPPORTED_KINDS.includes(kind)) {
    return apiError({
      status: 400,
      code: "unsupported_kind",
      message: `Unsupported job kind: ${kind}.`,
      hint: `Supported: ${SUPPORTED_KINDS.join(", ")}.`,
    });
  }
  const query = String(body.query || body.q || "").trim();
  if (!query) {
    return apiError({
      status: 400,
      code: "missing_query",
      message: "Job spec requires `query`.",
      hint: "{ \"kind\": \"ask\", \"query\": \"ai agents\" }",
    });
  }
  const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));
  const spec = { kind, q: query, limit, created_at: new Date().toISOString() };
  const id = encodeJobId(spec);
  const pollUrl = `${baseUrl}/jobs/${id}`;
  return new Response(
    JSON.stringify({
      job_id: id,
      status: "pending",
      kind,
      poll_url: pollUrl,
      retry_after_seconds: 1,
      created_at: spec.created_at,
      docs_url: `${baseUrl}/api/llms.txt#async`,
    }),
    {
      status: 202,
      headers: apiHeaders({
        Location: pollUrl,
        "Retry-After": "1",
        "Cache-Control": "no-store",
      }),
    }
  );
}

// GET /jobs — index describing the surface so probes that GET first
// see a discoverable inventory.
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return new Response(
    JSON.stringify({
      message: "Async job-creation endpoint. POST to create a 202-Accepted job, then GET the poll URL until status=completed.",
      pattern: "202-accepted-with-location",
      methods: ["POST", "GET"],
      supportedKinds: SUPPORTED_KINDS,
      poll: `${baseUrl}/jobs/{id}`,
      example: {
        request: {
          method: "POST",
          url: `${baseUrl}/jobs`,
          headers: { "Content-Type": "application/json" },
          body: { kind: "ask", query: "ai agents", limit: 3 },
        },
        response: {
          status: 202,
          headers: { Location: `${baseUrl}/jobs/<id>`, "Retry-After": "1" },
          body: { job_id: "<id>", status: "pending", poll_url: `${baseUrl}/jobs/<id>` },
        },
      },
      docs: `${baseUrl}/api/llms.txt#async`,
    }, null, 2),
    {
      status: 200,
      headers: apiHeaders({
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      }),
    }
  );
}

export async function onRequestHead(ctx) {
  const resp = await onRequestGet(ctx);
  return new Response(null, { status: resp.status, headers: resp.headers });
}

export const onRequestOptions = corsPreflight;

const reject = () => errors.methodNotAllowed("GET, POST, OPTIONS");
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;
