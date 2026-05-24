// POST /jobs/batch — array-body bulk job creation.
//
// Body is a JSON array of job specs ({ kind, query, limit }), max 50.
// Response is an array of the same length: each entry is the 202-style
// envelope you'd get from a single POST /jobs (job_id, poll_url, etc).
//
// Why it exists: orank's batch-endpoints check parses OpenAPI for either
// a /batch path OR a POST whose requestBody is type:array. This file
// satisfies BOTH branches (literal /batch path + array body). Pages
// Functions resolve literal segment names before catchall params, so
// /jobs/batch lands here even though /jobs/[id].js also exists.

import { apiHeaders, apiError, corsPreflight, errors } from "../_api.js";

const MAX_BATCH = 50;
const SUPPORTED_KINDS = ["ask", "search"];

function encodeJobId(spec) {
  const json = JSON.stringify(spec);
  const bytes = new TextEncoder().encode(json);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildJobEntry(item, baseUrl, idempotencyKey, index) {
  if (!item || typeof item !== "object") {
    return {
      index,
      status: "failed",
      error: { code: "bad_item", message: "Batch item must be an object." },
    };
  }
  const kind = String(item.kind || item.type || "ask").toLowerCase();
  if (!SUPPORTED_KINDS.includes(kind)) {
    return {
      index,
      status: "failed",
      error: { code: "unsupported_kind", message: `Unsupported kind: ${kind}.` },
    };
  }
  const query = String(item.query || item.q || "").trim();
  if (!query) {
    return {
      index,
      status: "failed",
      error: { code: "missing_query", message: "Batch item missing `query`." },
    };
  }
  const limit = Math.min(50, Math.max(1, Number(item.limit) || 10));
  // Per-item Idempotency-Key wins; falls back to the request-wide key.
  const itemKey = String(item.idempotency_key || idempotencyKey || "").trim();
  const spec = {
    kind,
    q: query,
    limit,
    created_at: new Date().toISOString(),
    ...(itemKey ? { idempotency_key: itemKey, batch_index: index } : { batch_index: index }),
  };
  const id = encodeJobId(spec);
  const pollUrl = `${baseUrl}/jobs/${id}`;
  return {
    index,
    job_id: id,
    status: "pending",
    kind,
    poll_url: pollUrl,
    retry_after_seconds: 1,
    created_at: spec.created_at,
    ...(itemKey ? { idempotency_key: itemKey } : {}),
  };
}

export async function onRequestPost({ request }) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  let body;
  try {
    body = await request.json();
  } catch {
    return apiError({
      status: 400,
      code: "bad_body",
      message: "Batch body must be a JSON array of job specs.",
      hint: '[{"kind":"ask","query":"ai"},{"kind":"search","query":"agents"}]',
    });
  }
  if (!Array.isArray(body)) {
    return apiError({
      status: 400,
      code: "not_an_array",
      message: "Batch body must be a JSON array (top-level).",
      hint: `Wrap your jobs in [ ... ]. Max ${MAX_BATCH} items per batch.`,
    });
  }
  if (body.length === 0) {
    return apiError({
      status: 400,
      code: "empty_batch",
      message: "Batch must contain at least one item.",
    });
  }
  if (body.length > MAX_BATCH) {
    return apiError({
      status: 400,
      code: "batch_too_large",
      message: `Batch must contain at most ${MAX_BATCH} items.`,
    });
  }
  const idempotencyKey = (request.headers.get("idempotency-key") || "").trim();
  const results = body.map((item, i) => buildJobEntry(item, baseUrl, idempotencyKey, i));
  const failed = results.filter((r) => r.status === "failed").length;
  return new Response(
    JSON.stringify({
      object: "batch",
      total: results.length,
      created: results.length - failed,
      failed,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      results,
    }, null, 2),
    {
      status: 202,
      headers: apiHeaders({
        "Retry-After": "1",
        "Cache-Control": "no-store",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      }),
    }
  );
}

// GET /jobs/batch — discovery envelope, mirrors GET /jobs.
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  return new Response(
    JSON.stringify({
      message: "Array-body batch job creation. POST a JSON array of job specs (max 50); receive an array of 202-style entries with per-item job_ids.",
      methods: ["POST", "GET"],
      maxBatchSize: MAX_BATCH,
      supportedKinds: SUPPORTED_KINDS,
      example: {
        request: {
          method: "POST",
          url: `${baseUrl}/jobs/batch`,
          headers: { "Content-Type": "application/json" },
          body: [
            { kind: "ask", query: "ai agents", limit: 3 },
            { kind: "search", query: "podcast hosting" },
          ],
        },
        response: {
          status: 202,
          body: {
            object: "batch",
            total: 2,
            created: 2,
            failed: 0,
            results: [
              { index: 0, job_id: "<id1>", status: "pending", poll_url: `${baseUrl}/jobs/<id1>` },
              { index: 1, job_id: "<id2>", status: "pending", poll_url: `${baseUrl}/jobs/<id2>` },
            ],
          },
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
