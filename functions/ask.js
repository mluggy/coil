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
  const t0 = Date.now();
  const { results } = searchEpisodes(query, { limit, baseUrl });
  const took_ms = Date.now() - t0;

  return wantsSse(request)
    ? buildSseResponse(query, results, took_ms)
    : buildJsonResponse(query, results, took_ms);
}

export const onRequestPost = ({ request }) => handleAsk(request);
export const onRequestGet = ({ request }) => handleAsk(request);

const reject = () => errors.methodNotAllowed("GET, POST, OPTIONS");
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;

export const onRequestOptions = corsPreflight;
