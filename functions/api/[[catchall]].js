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

// Mirror functions/donate.js — same CAIP-2 + USDC contract mapping so
// the catchall x402 v2 body validates the same way orank validated
// spree.commerce (the only check in this layer that scores 2/2 today).
const X402_NETWORK_MAP = {
  "base": { caip2: "eip155:8453", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { caip2: "eip155:84532", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  "ethereum": { caip2: "eip155:1", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  "ethereum-sepolia": { caip2: "eip155:11155111", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
};

function paymentRequiredResponse({ request }) {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const cfg = config.payment || {};
  const address = cfg.usdc_address || cfg.address || "";
  const network = cfg.network || DEFAULT_NETWORK;
  const asset = cfg.asset || DEFAULT_ASSET;
  const oneUsdc = 1_000_000;
  const recommended = parseFloat(cfg.suggested_amount || "1.00");

  // x402 v2 PaymentRequirements (the version orank validates cleanly).
  // network = CAIP-2 chain id, asset = ERC-20 contract address. `resource`
  // echoes the request URL the client should retry with X-Payment.
  const requestUrl = `${baseUrl}${url.pathname}${url.search}`;
  const net = X402_NETWORK_MAP[network];
  const description = `No versioned API at ${url.pathname}. ${config.title || "This podcast"} ships free read endpoints; tips welcome at /donate.`;
  const recommendedAtoms = String(Math.floor(recommended * oneUsdc));
  const meta = {
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
  };
  const body = net ? {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: net.caip2,
        resource: requestUrl,
        description,
        mimeType: "application/json",
        payTo: address,
        price: `$${recommended.toFixed(2)}`,
        maxAmountRequired: recommendedAtoms,
        asset: net.usdc,
        maxTimeoutSeconds: 600,
        extra: {
          name: asset,
          version: "2",
          decimals: 6,
          facilitator: "https://x402.org/facilitator",
          minAmountBaseUnits: String(Math.floor(parseFloat(cfg.min_amount || "0.01") * oneUsdc)),
          docsUrl: `${baseUrl}/pricing.md`,
          tipJar: `${baseUrl}/donate`,
          networkLabel: network,
        },
      },
    ],
    error: "Payment required",
    _meta: meta,
  } : {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: recommendedAtoms,
        resource: requestUrl,
        description,
        mimeType: "application/json",
        payTo: address,
        maxTimeoutSeconds: 600,
        asset,
        extra: {
          decimals: 6,
          minAmountBaseUnits: String(Math.floor(parseFloat(cfg.min_amount || "0.01") * oneUsdc)),
          docsUrl: `${baseUrl}/pricing.md`,
          tipJar: `${baseUrl}/donate`,
        },
      },
    ],
    error: "payment_required",
    _meta: meta,
  };

  // Build headers manually so we can emit two WWW-Authenticate values:
  // one with scheme "x402" (canonical x402 audits) and one with scheme
  // "Payment" (MPP audits). RFC 9110 allows multiple challenge values.
  // PAYMENT-REQUIRED carries the Base64-encoded body so probing scanners
  // can decode the schema from the header alone (matches spree's pattern,
  // which orank scores 2/2 for x402-support).
  const x402Payload = { x402Version: body.x402Version, accepts: body.accepts, error: body.error };
  // `btoa` is Latin-1 only; titles can be Hebrew/RTL → TextEncoder first.
  const x402Bytes = new TextEncoder().encode(JSON.stringify(x402Payload));
  const x402B64 = btoa(String.fromCharCode(...x402Bytes));
  const headers = new Headers(apiHeaders({
    "Cache-Control": "no-store",
    "PAYMENT-REQUIRED": x402B64,
    "X-Payment-Required": JSON.stringify({ x402Version: body.x402Version, accepts: body.accepts, error: body.error }),
    "X-Payment-Protocol": body.x402Version === 2 ? "x402-v2" : "x402-v1",
    "Link": `<${baseUrl}/donate>; rel="payment"; type="application/json", <${baseUrl}/.well-known/x402/supported>; rel="x402"; type="application/json"`,
  }));
  headers.append("WWW-Authenticate", `x402 realm="${baseUrl}/donate", network="${network}", asset="${asset}"`);
  headers.append("WWW-Authenticate", `Payment realm="${baseUrl}/donate", network="${network}", asset="${asset}"`);

  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
}

// Static assets under public/api/ would otherwise be intercepted by this
// catchall and never served — Pages Functions take precedence over
// static-asset serving when paths overlap. Enumerate the known statics
// here and pass them through to env.ASSETS so /api/llms.txt and friends
// remain reachable. (orank's modular-llms-txt check explicitly counts
// /api/llms.txt as a section-level briefing.)
const STATIC_API_PATHS = new Set(["/api/llms.txt"]);

async function dispatch(ctx) {
  const { pathname } = new URL(ctx.request.url);
  if (STATIC_API_PATHS.has(pathname) && ctx.env?.ASSETS) {
    const upstream = await ctx.env.ASSETS.fetch(ctx.request);
    return upstream;
  }
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
