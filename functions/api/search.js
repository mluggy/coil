// GET /api/search?q=<query>&limit=<1..50>
// Lightweight server-side search over title + description + transcript.
// Use this from agents that don't want to download search-index.json.

import { searchEpisodes } from "../_search.js";
import { apiOk, apiError, corsPreflight, errors } from "../_api.js";

// Validation matches OpenAPI minLength/maxLength + integer bounds. Anything
// outside that range returns 400 with a structured error — no silent clamps,
// no 200+empty for malformed input (orank "agent error recovery" gap).
const Q_MIN = 2;
const Q_MAX = 256;
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
const OFFSET_MAX = 10000;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return errors.missingQuery();
  if (q.length < Q_MIN) {
    return apiError({
      status: 400,
      code: "query_too_short",
      message: `\`q\` must be at least ${Q_MIN} characters.`,
      hint: "/api/search?q=ai",
    });
  }
  if (q.length > Q_MAX) {
    return apiError({
      status: 400,
      code: "query_too_long",
      message: `\`q\` must be at most ${Q_MAX} characters.`,
      hint: "/api/search?q=ai",
    });
  }
  if (!WORD_CHAR_RE.test(q)) {
    return apiError({
      status: 400,
      code: "invalid_query",
      message: "`q` must contain at least one letter or number.",
      hint: "/api/search?q=ai",
    });
  }

  const limitParam = url.searchParams.get("limit");
  let limit = 10;
  if (limitParam != null) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== limitParam.trim() || parsed < LIMIT_MIN || parsed > LIMIT_MAX) {
      return apiError({
        status: 400,
        code: "bad_limit",
        message: `\`limit\` must be an integer between ${LIMIT_MIN} and ${LIMIT_MAX}.`,
        hint: "/api/search?q=ai&limit=10",
      });
    }
    limit = parsed;
  }

  const offsetParam = url.searchParams.get("offset");
  let offset = 0;
  if (offsetParam != null) {
    const parsed = parseInt(offsetParam, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== offsetParam.trim() || parsed < 0 || parsed > OFFSET_MAX) {
      return apiError({
        status: 400,
        code: "bad_offset",
        message: `\`offset\` must be an integer between 0 and ${OFFSET_MAX}.`,
        hint: "/api/search?q=ai&offset=0",
      });
    }
    offset = parsed;
  }

  try {
    const t0 = Date.now();
    const baseUrl = `${url.protocol}//${url.host}`;
    const { results, total } = searchEpisodes(q, { limit, offset, baseUrl });
    const took_ms = Date.now() - t0;
    const has_more = offset + results.length < total;

    return apiOk({ query: q, count: results.length, total, offset, limit, has_more, took_ms, results });
  } catch (e) {
    return errors.internal(e?.message);
  }
}

// Reject other methods with structured 405s — agents need a clean signal,
// not the implicit "GET only" that file-route conventions imply.
const reject = () => errors.methodNotAllowed("GET");
export const onRequestPost = reject;
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;

export const onRequestOptions = corsPreflight;
