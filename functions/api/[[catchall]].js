// /api/* catchall — any unknown path under /api/ returns a structured
// JSON 404 envelope so agents don't get HTML back from the SPA fallback.
//
// Special case: paths under `/api/v1*` return HTTP 402 with x402/MPP
// payment-discovery headers pointing at /donate. We don't implement a
// versioned API — `/api/v1` is a common probe path for paid APIs, and
// returning 402 there lets payment-aware audits find the (voluntary)
// tip-jar surface without us having to make any working endpoint pretend
// to be paid. Real consumers never hit /api/v1; we never document it.

import config from "../_config.js";
import { apiHeaders, apiError, corsPreflight } from "../_api.js";

const DEFAULT_NETWORK = "base-sepolia";
const DEFAULT_ASSET = "USDC";

function paymentRequiredResponse({ request }) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const cfg = config.payment || {};
  const address = cfg.usdc_address || cfg.address || "";
  const network = cfg.network || DEFAULT_NETWORK;
  const asset = cfg.asset || DEFAULT_ASSET;
  const oneUsdc = 1_000_000;
  const recommended = parseFloat(cfg.suggested_amount || "1.00");

  // x402-spec body: top-level x402Version + accepts + error are required
  // for canonical x402 detection. Audit parsers fail if these aren't on
  // the root object. The structured error envelope and MPP alternative
  // ride alongside in `_meta` so we don't lose any information.
  const body = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: String(Math.floor(recommended * oneUsdc)),
        resource: `${baseUrl}/donate`,
        description: `No versioned API at ${url.pathname}. ${config.title || "This podcast"} ships free read endpoints; tips welcome at /donate.`,
        mimeType: "application/json",
        payTo: address,
        maxTimeoutSeconds: 600,
        asset,
      },
    ],
    error: "payment_required",
    _meta: {
      code: "no_versioned_api",
      message: `No versioned API at ${url.pathname}. The free read endpoints are unversioned.`,
      hint: `${baseUrl}/api/llms.txt — full list of supported endpoints. ${baseUrl}/donate — voluntary USDC tip jar.`,
      docs_url: `${baseUrl}/api/llms.txt`,
      alternativePayment: {
        type: "mpp",
        scheme: "stablecoin",
        asset,
        network,
        address,
        amount: recommended.toFixed(2),
        currency: "USD",
        memo: `Tip for ${config.title || "podcast"}`,
      },
    },
  };

  // Build headers manually so we can emit two WWW-Authenticate values:
  // one with scheme "x402" (canonical x402 audits) and one with scheme
  // "Payment" (MPP audits). RFC 9110 allows multiple challenge values.
  const headers = new Headers(apiHeaders({
    "Cache-Control": "no-store",
    "PAYMENT-REQUIRED": "x402",
    "X-Payment-Required": JSON.stringify({ x402Version: body.x402Version, accepts: body.accepts, error: body.error }),
    "Link": `<${baseUrl}/donate>; rel="payment"; type="application/json", <${baseUrl}/.well-known/x402/supported>; rel="x402"; type="application/json"`,
  }));
  headers.append("WWW-Authenticate", `x402 realm="${baseUrl}/donate", network="${network}", asset="${asset}"`);
  headers.append("WWW-Authenticate", `Payment realm="${baseUrl}/donate", network="${network}", asset="${asset}"`);

  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
}

function dispatch(ctx) {
  const { pathname } = new URL(ctx.request.url);
  // /api/v1 and anything underneath it → 402 (no versioned API exists).
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
    return paymentRequiredResponse(ctx);
  }
  // Everything else → structured 404.
  return apiError({
    status: 404,
    code: "endpoint_not_found",
    message: `No API endpoint at ${pathname}.`,
    hint: "/api/llms.txt — full list of supported endpoints",
  });
}

export const onRequestGet = dispatch;
export const onRequestPost = dispatch;
export const onRequestPut = dispatch;
export const onRequestDelete = dispatch;
export const onRequestPatch = dispatch;
export const onRequestOptions = corsPreflight;
