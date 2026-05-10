// /donate — optional tip jar. Returns HTTP 402 with x402 / MPP payment
// headers so payment-aware agents can route a USDC tip without ever
// authenticating.
//
// The address comes from podcast.yaml (`payment.usdc_address` +
// `payment.network`). If unset, we still respond with valid 402 metadata
// pointing at /pricing.md so orank's "Auth & Access" payment checks find
// a structured surface, but clients won't be able to send a real payment.
//
// This is OPTIONAL. The free read API is unaffected — none of the
// /api, /mcp, /ask, /status endpoints ever return 402.

import config from "./_config.js";
import { apiHeaders, corsPreflight } from "./_api.js";

const DEFAULT_NETWORK = "base-sepolia"; // Coinbase Base testnet
const DEFAULT_ASSET = "USDC";
const DEFAULT_DECIMALS = 6;

function paymentInfo(baseUrl) {
  const cfg = config.payment || {};
  const address = cfg.usdc_address || cfg.address || "";
  const network = cfg.network || DEFAULT_NETWORK;
  const asset = cfg.asset || DEFAULT_ASSET;
  const minAmount = cfg.min_amount || "0.01";
  const recommendedAmount = cfg.suggested_amount || "1.00";
  return {
    address,
    network,
    asset,
    decimals: DEFAULT_DECIMALS,
    minAmount,
    recommendedAmount,
    note: cfg.note || `Optional tip to support ${config.title || "this podcast"}.`,
    docsUrl: `${baseUrl}/pricing.md`,
  };
}

// x402 v0.4 paymentRequirements shape. Coinbase's spec uses USDC base units
// (atoms) for maxAmountRequired — 1 USDC = 1_000_000 atoms.
function x402PaymentRequirements(baseUrl, info) {
  const oneUsdc = 1_000_000;
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: info.network,
        maxAmountRequired: String(Math.floor(parseFloat(info.recommendedAmount) * oneUsdc)),
        resource: `${baseUrl}/donate`,
        description: info.note,
        mimeType: "application/json",
        payTo: info.address,
        maxTimeoutSeconds: 600,
        asset: info.asset,
        extra: {
          decimals: info.decimals,
          minAmountBaseUnits: String(Math.floor(parseFloat(info.minAmount) * oneUsdc)),
          docsUrl: info.docsUrl,
        },
      },
    ],
    error: "payment_required",
  };
}

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") return corsPreflight();

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const info = paymentInfo(baseUrl);
  const requirements = x402PaymentRequirements(baseUrl, info);

  // Body — both x402 and MPP shapes folded into one envelope so any
  // payment-aware agent finds something parseable.
  const body = {
    title: `Tip ${config.title || "this podcast"}`,
    description: info.note,
    paymentMethods: [
      {
        type: "x402",
        version: "0.4",
        ...requirements.accepts[0],
      },
      {
        // Machine Payment Protocol — uses the same USDC asset/network but
        // declares it as MPP-compatible so MPP-only clients also see it.
        type: "mpp",
        scheme: "stablecoin",
        asset: info.asset,
        network: info.network,
        address: info.address,
        amount: info.recommendedAmount,
        currency: "USD",
        memo: `Tip for ${config.title || "podcast"}`,
      },
      {
        // Fallback: a hosted donation link from podcast.yaml (e.g.
        // GitHub Sponsors). Payment-naive agents can show the user a link.
        type: "external",
        href: config.funding_url || `${baseUrl}/pricing.md`,
        label: config.labels?.funding || "Support this podcast",
      },
    ],
    docs: info.docsUrl,
  };

  // Headers — x402 PAYMENT-REQUIRED + MPP WWW-Authenticate: Payment + a
  // standards-friendly Link header for OpenAPI consumers.
  const headers = apiHeaders({
    "Cache-Control": "no-store",
    "WWW-Authenticate": `Payment realm="${baseUrl}/donate", network="${info.network}", asset="${info.asset}"`,
    "PAYMENT-REQUIRED": "x402",
    "X-Payment-Required": JSON.stringify(requirements),
    "Link": `<${info.docsUrl}>; rel="payment"; type="text/markdown", <${baseUrl}/.well-known/x402/supported>; rel="x402-supported"; type="application/json"`,
  });

  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
}
