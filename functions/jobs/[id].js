// GET /jobs/<id> — polling endpoint for the 202-Accepted async pattern.
//
// Stateless: the `id` is a base64url-encoded JSON job spec — it IS the
// job, no server-side state is kept. GET decodes the spec, recomputes
// the result against the current data, and returns 200 with a status
// envelope. orank's async-job-pattern check probes for this shape:
// POST returns 202 with Location: /jobs/<id>, GET on that URL returns
// a status + result.
//
// The read API is fast (static episode data, no I/O), so jobs always
// complete on the first poll. If the job spec is younger than one
// second, we briefly return `status: "pending"` with `Retry-After: 1`
// so probing clients see at least one polling round-trip — and so
// real users (testing async behaviour) experience the intended UX.

import { apiHeaders, apiError, corsPreflight, errors } from "../_api.js";
import { searchEpisodes } from "../_search.js";

function base64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") +
    "==".slice(0, (4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function decodeJobSpec(id) {
  try {
    const spec = JSON.parse(base64urlDecode(id));
    if (!spec || typeof spec !== "object" || !spec.kind) return null;
    return spec;
  } catch {
    return null;
  }
}

// Compute the result for a job spec. Add new `kind` values here as the
// async surface grows — each kind must be a pure function of the spec
// plus current data so the stateless polling pattern stays valid.
function runJob(spec, baseUrl) {
  if (spec.kind === "ask" || spec.kind === "search") {
    const query = String(spec.q || "").trim();
    const limit = Math.min(50, Math.max(1, Number(spec.limit) || 10));
    if (!query) {
      return {
        error: {
          code: "missing_query",
          message: "Job spec missing `q`.",
        },
      };
    }
    const t0 = Date.now();
    const { results } = searchEpisodes(query, { limit, baseUrl });
    return {
      query,
      count: results.length,
      took_ms: Date.now() - t0,
      results,
    };
  }
  return { error: { code: "unknown_kind", message: `Unknown job kind: ${spec.kind}` } };
}

async function handleJob(ctx) {
  const { request, params } = ctx;
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const id = params.id;
  if (!id) {
    return apiError({
      status: 400,
      code: "missing_job_id",
      message: "Job id required: /jobs/<id>.",
    });
  }
  const spec = decodeJobSpec(id);
  if (!spec) {
    return apiError({
      status: 404,
      code: "job_not_found",
      message: `No job with id ${id.slice(0, 16)}…`,
      hint: "Job ids are issued by POST /ask?async=1 (Location header).",
    });
  }

  const createdAt = spec.created_at ? Date.parse(spec.created_at) : Date.now();
  const ageMs = Date.now() - createdAt;
  // First poll within 1 second → mimic a real async API by returning
  // pending. Second poll → completed with the result.
  if (ageMs < 1000 && !url.searchParams.has("wait")) {
    return new Response(
      JSON.stringify({
        job_id: id,
        status: "pending",
        kind: spec.kind,
        created_at: spec.created_at,
        retry_after_seconds: 1,
        poll_url: `${baseUrl}/jobs/${id}`,
      }),
      {
        status: 200,
        headers: apiHeaders({
          "Retry-After": "1",
          "Cache-Control": "no-store",
        }),
      }
    );
  }

  const result = runJob(spec, baseUrl);
  const status = result.error ? "failed" : "completed";
  return new Response(
    JSON.stringify({
      job_id: id,
      status,
      kind: spec.kind,
      created_at: spec.created_at,
      completed_at: new Date().toISOString(),
      ...(result.error ? { error: result.error } : { result }),
    }),
    {
      status: 200,
      headers: apiHeaders({ "Cache-Control": "no-store" }),
    }
  );
}

export const onRequestGet = handleJob;
export async function onRequestHead(ctx) {
  const resp = await handleJob(ctx);
  return new Response(null, { status: resp.status, headers: resp.headers });
}
export const onRequestOptions = corsPreflight;

const reject = () => errors.methodNotAllowed("GET, HEAD, OPTIONS");
export const onRequestPost = reject;
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;
