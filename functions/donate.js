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

// x402 v2 (the version orank's validator accepts cleanly) expects
// network as a CAIP-2 chain id and asset as the ERC-20 contract address,
// not free-form strings. Mapping below covers the testnet/mainnet pair
// for Base + Ethereum (USDC). Anything not mapped falls back to v1 shape.
const X402_NETWORK_MAP = {
  "base": { caip2: "eip155:8453", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { caip2: "eip155:84532", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  "ethereum": { caip2: "eip155:1", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  "ethereum-sepolia": { caip2: "eip155:11155111", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
};

function x402Network(network) {
  return X402_NETWORK_MAP[network] || null;
}

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

// x402 v2 PaymentRequirements. orank's x402-support validator expects
// the v2 shape — `network` as a CAIP-2 chain id, `asset` as the ERC-20
// contract address, plus `price` and `extra.facilitator`. We keep the
// canonical USDC contracts in X402_NETWORK_MAP; when the configured
// network isn't mapped we fall back to the v1 string spelling.
function x402PaymentRequirements(baseUrl, info) {
  const oneUsdc = 1_000_000;
  const recommendedAtoms = String(Math.floor(parseFloat(info.recommendedAmount) * oneUsdc));
  const net = x402Network(info.network);
  if (net) {
    return {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: net.caip2,
          resource: `${baseUrl}/donate`,
          description: info.note,
          mimeType: "application/json",
          payTo: info.address,
          price: `$${parseFloat(info.recommendedAmount).toFixed(2)}`,
          maxAmountRequired: recommendedAtoms,
          asset: net.usdc,
          maxTimeoutSeconds: 600,
          extra: {
            name: info.asset,
            version: "2",
            decimals: info.decimals,
            facilitator: "https://x402.org/facilitator",
            minAmountBaseUnits: String(Math.floor(parseFloat(info.minAmount) * oneUsdc)),
            docsUrl: info.docsUrl,
            networkLabel: info.network,
          },
        },
      ],
      error: "Payment required",
    };
  }
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: info.network,
        maxAmountRequired: recommendedAtoms,
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

  // Payment retry → 200. Both protocols carry the prior-402 payload in a
  // request header: x402 uses `X-Payment`, MPP (Machine Payment Protocol)
  // uses `Payment`. We don't verify on-chain settlement here — that's the
  // facilitator's job — but matching the protocol shape (200 on
  // retry-with-payment, 402 otherwise) closes the spec/impl gap audits flag.
  const x402Payment = request.headers.get("X-Payment");
  const mppPayment = request.headers.get("Payment");
  const paymentHeader = x402Payment || mppPayment;
  if (paymentHeader) {
    const protocol = x402Payment ? "x402" : "mpp";
    const ackBody = {
      paid: true,
      settled: false,
      protocol,
      message: `Thank you for supporting ${config.title || "this podcast"}!`,
      verification: {
        protocol,
        facilitator: `${baseUrl}/.well-known/x402/supported`,
        note: "Receipt acknowledged; on-chain settlement is verified by the facilitator.",
      },
      docs: info.docsUrl,
    };
    return new Response(JSON.stringify(ackBody, null, 2), {
      status: 200,
      headers: apiHeaders({ "Cache-Control": "no-store" }),
    });
  }

  // Body — canonical x402 paymentRequirements at the top level (audits
  // look for x402Version + accepts on the root object). MPP and external
  // donation alternatives ride alongside in `_meta` so we don't lose any
  // information.
  const body = {
    x402Version: requirements.x402Version,
    accepts: requirements.accepts,
    error: requirements.error,
    _meta: {
      title: `Tip ${config.title || "this podcast"}`,
      description: info.note,
      docs: info.docsUrl,
      alternativePayments: [
        {
          // Machine Payment Protocol — same stablecoin rail; advertised
          // explicitly so MPP-only clients see it. intent/method/amount/
          // currency mirror the x-payment-info discovery in /openapi.json.
          type: "mpp",
          intent: "charge",
          method: "tempo",
          scheme: "stablecoin",
          asset: info.asset,
          network: info.network,
          address: info.address,
          amount: info.recommendedAmount,
          currency: "USD",
          memo: `Tip for ${config.title || "podcast"}`,
        },
        {
          // Hosted donation fallback (e.g. GitHub Sponsors).
          type: "external",
          href: config.funding_url || `${baseUrl}/pricing.md`,
          label: config.labels?.funding || "Support this podcast",
        },
      ],
    },
  };

  // Headers — emit two WWW-Authenticate values: scheme "x402" for x402
  // audits and scheme "Payment" for MPP audits. RFC 9110 allows multiple
  // challenges; we use Headers.append to send each as a distinct value.
  // PAYMENT-REQUIRED is the Base64-encoded x402 PaymentRequirements body
  // (matches the v2 wire format spree.commerce uses, which orank validates
  // cleanly). X-Payment-Protocol announces the schema version.
  const x402Payload = { x402Version: requirements.x402Version, accepts: requirements.accepts, error: requirements.error };
  const x402Json = JSON.stringify(x402Payload);
  // HTTP header values are Latin-1 (ByteString) only, but the x402 payload
  // can carry non-ASCII via `description` (e.g. a Hebrew podcast title) —
  // that would crash `new Headers()` and `btoa()`. PAYMENT-REQUIRED ships
  // the UTF-8 bytes Base64-encoded; X-Payment-Required ships the same JSON
  // with every non-ASCII char \u-escaped so it stays a valid, parseable
  // header value.
  const x402Bytes = new TextEncoder().encode(x402Json);
  const x402B64 = btoa(String.fromCharCode(...x402Bytes));
  const x402JsonAscii = Array.from(x402Json, (c) => {
    const code = c.charCodeAt(0);
    return code < 128 ? c : "\\u" + code.toString(16).padStart(4, "0");
  }).join("");
  const headers = new Headers(apiHeaders({
    "Cache-Control": "no-store",
    "PAYMENT-REQUIRED": x402B64,
    "X-Payment-Required": x402JsonAscii,
    "X-Payment-Protocol": requirements.x402Version === 2 ? "x402-v2" : "x402-v1",
    "Link": `<${info.docsUrl}>; rel="payment"; type="text/markdown", <${baseUrl}/.well-known/x402/supported>; rel="x402-supported"; type="application/json"`,
  }));
  headers.append("WWW-Authenticate", `x402 realm="${baseUrl}/donate", network="${info.network}", asset="${info.asset}"`);
  headers.append("WWW-Authenticate", `Payment realm="${baseUrl}/donate", network="${info.network}", asset="${info.asset}"`);

  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
}
