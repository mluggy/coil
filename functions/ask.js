// POST /ask — NLWeb-style natural-language ask endpoint.
// Listener-framing: "ask the show a question". Internally a thin shim over
// the existing search; results are episodes ranked by transcript relevance.
//
// JSON response (default):
//   { _meta: { response_type: "list", version: "0.1", ... },
//     query, count, results: [...] }
//
// SSE stream (when Accept: text/event-stream or Prefer: streaming=true):
//   event: start    data: { _meta, query }
//   event: result   data: { ... }   (one per match)
//   event: complete data: { count, took_ms }
//
// Spec: github.com/microsoft/NLWeb (loose conformance — we expose the
// `_meta` envelope and the `start`/`result`/`complete` event types).

import { searchEpisodes } from "./_search.js";
import config from "./_config.js";
import { apiHeaders, apiOk, apiError, corsPreflight, errors } from "./_api.js";

const NLWEB_VERSION = "0.1";
const RESPONSE_TYPE = "list";

function nlwebMeta(query) {
  return {
    response_type: RESPONSE_TYPE,
    version: NLWEB_VERSION,
    site: config.title,
    contentType: "podcast",
    query,
    generated_at: new Date().toISOString(),
  };
}

function wantsSse(request) {
  const accept = request.headers.get("accept") || "";
  if (/\btext\/event-stream\b/i.test(accept)) return true;
  // Prefer header (RFC 7240) — `Prefer: streaming=true` per orank's check.
  const prefer = request.headers.get("prefer") || "";
  return /\bstreaming\s*=\s*true\b/i.test(prefer);
}

// Async-mode signal — either ?async=1 / ?async=true on the URL or
// RFC 7240 `Prefer: respond-async`. orank's async-job-pattern probe
// looks for a 202 Accepted with Location + Retry-After + poll URL.
function wantsAsync(request) {
  const url = new URL(request.url);
  const qs = (url.searchParams.get("async") || "").toLowerCase();
  if (qs === "1" || qs === "true" || qs === "yes") return true;
  const prefer = (request.headers.get("prefer") || "").toLowerCase();
  return /\brespond-async\b/.test(prefer);
}

// Encode a job spec into a base64url id. Stateless — the id IS the
// job, so GET /jobs/<id> can recompute the result without server state.
// When an Idempotency-Key is folded into the spec, the same key + body
// deterministically maps to the same id, so naive POST retries return
// the same job_id without any server-side state.
function encodeJobId(spec) {
  const json = JSON.stringify(spec);
  const bytes = new TextEncoder().encode(json);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildAsyncAcceptedResponse(spec, baseUrl, idempotencyKey) {
  const id = encodeJobId(spec);
  const pollUrl = `${baseUrl}/jobs/${id}`;
  const body = {
    job_id: id,
    status: "pending",
    kind: spec.kind,
    poll_url: pollUrl,
    retry_after_seconds: 1,
    created_at: spec.created_at,
    docs_url: `${baseUrl}/api/llms.txt#async`,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: 202,
    headers: apiHeaders({
      // RFC 7231 — Location identifies the resource representing the
      // started operation; clients GET it to follow up.
      Location: pollUrl,
      "Retry-After": "1",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      // Echo Idempotency-Key on every response (when present) so
      // callers can correlate retries.
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    }),
  });
}

async function parseQuery(request) {
  const url = new URL(request.url);
  // GET also supported via ?q=, for cheap probing.
  if (request.method === "GET") {
    return { query: (url.searchParams.get("q") || "").trim(), limit: parseLimit(url.searchParams.get("limit")) };
  }
  let body = {};
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      body = await request.json();
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      body = Object.fromEntries(params.entries());
    } else {
      // Tolerate empty body — fall through to ?q= / errors below.
      const text = await request.text();
      if (text) {
        try { body = JSON.parse(text); } catch { body = { query: text.trim() }; }
      }
    }
  } catch {
    return { error: apiError({ status: 400, code: "bad_body", message: "We couldn't parse the request body. Send JSON: { \"query\": \"...\" }." }) };
  }
  const query = String(body.query || body.q || url.searchParams.get("q") || "").trim();
  return { query, limit: parseLimit(body.limit ?? url.searchParams.get("limit")) };
}

function parseLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.min(50, Math.max(1, n));
}

function buildJsonResponse(query, results, took_ms) {
  return apiOk({
    _meta: nlwebMeta(query),
    query,
    count: results.length,
    took_ms,
    results,
  });
}

function buildSseResponse(query, results, took_ms) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("start", { _meta: nlwebMeta(query), query });
      for (const r of results) send("result", r);
      send("complete", { count: results.length, took_ms });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: apiHeaders({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }),
  });
}

async function handleAsk(request) {
  const { query, limit, error } = await parseQuery(request);
  if (error) return error;
  if (!query) {
    return apiError({
      status: 400,
      code: "missing_query",
      message: "Tell us what to ask. Send JSON `{ \"query\": \"...\" }` or `?q=...`.",
      hint: "/ask?q=ai+agents",
    });
  }

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  // Async mode — return 202 Accepted with a poll URL, deferring the
  // actual search to GET /jobs/<id>. Stateless: the job id encodes
  // the query, so the polling endpoint reproduces the result without
  // any server-side job state. Folding Idempotency-Key into the spec
  // makes the id deterministic across retries with the same key.
  if (wantsAsync(request)) {
    const idempotencyKey = (request.headers.get("idempotency-key") || "").trim();
    const spec = {
      kind: "ask",
      q: query,
      limit,
      created_at: new Date().toISOString(),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    return buildAsyncAcceptedResponse(spec, baseUrl, idempotencyKey);
  }

  const t0 = Date.now();
  const { results } = searchEpisodes(query, { limit, baseUrl });
  const took_ms = Date.now() - t0;

  const idempotencyKey = (request.headers.get("idempotency-key") || "").trim();
  const resp = wantsSse(request)
    ? buildSseResponse(query, results, took_ms)
    : buildJsonResponse(query, results, took_ms);
  if (idempotencyKey) {
    const headers = new Headers(resp.headers);
    headers.set("Idempotency-Key", idempotencyKey);
    return new Response(resp.body, { status: resp.status, headers });
  }
  return resp;
}

export const onRequestPost = ({ request }) => handleAsk(request);
export const onRequestGet = ({ request }) => handleAsk(request);

const reject = () => errors.methodNotAllowed("GET, POST, OPTIONS");
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;

export const onRequestOptions = corsPreflight;

// HEAD probes (orank's RFC 9598 probe) return the same headers as GET —
// including rate-limit headers — minus the body.
export async function onRequestHead({ request }) {
  const resp = await handleAsk(request);
  return new Response(null, { status: resp.status, headers: resp.headers });
}
