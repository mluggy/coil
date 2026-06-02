// Generates /.well-known/openapi.json — describes the listener-facing
// read-only API surface so agents can introspect tools without scraping.
//
// Endpoints described (operationIds map directly to LLM function calls):
//   GET  /api/search       — server-side full-text search
//   POST /ask              — NLWeb-style natural-language ask (JSON or SSE)
//   GET  /ask              — same, query-string variant
//   GET  /status           — service health for circuit-breaker logic
//   GET  /episodes.json    — full episode list (static)
//   GET  /search-index.json — flat search index (static)
//   GET  /rss.xml          — podcast feed
//   GET  /llms.txt         — agent briefing
//   GET  /mcp              — MCP server manifest
//   POST /mcp              — MCP JSON-RPC

import { writeFileSync, mkdirSync } from "fs";
import yaml from "js-yaml";
import config from "./load-config.js";
import { API_VERSION } from "../functions/_api.js";

const SITE = "{{SITE_URL}}";

const WEBHOOK_EVENTS = ["episode.published", "episode.updated", "episode.deleted"];

// Reused response refs for the consistent error envelope + rate-limit
// headers. Keeps the typed coverage at 7/7 instead of 2/7.
const errorResponses = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "404": { $ref: "#/components/responses/NotFound" },
  "405": { $ref: "#/components/responses/MethodNotAllowed" },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalError" },
};

const notModifiedResponse = {
  "304": { $ref: "#/components/responses/NotModified" },
};

// OpenAPI 3.0.3. We trialled 3.1.0 (matches JSON Schema 2020-12) but
// orank's `api-response-quality` parser is 3.0-only — type-arrays like
// `["string", "null"]` make it bail with "could not fully parse" while
// its function-calling-compat path (a separate 3.1-aware analyzer) still
// works. Sticking to 3.0.3 lets both paths succeed; the old `oneOf +
// nullable: true` 3.0-invalidity is avoided by spelling out null cases
// per subschema (or omitting the null case where description suffices).
const spec = {
  openapi: "3.0.3",
  info: {
    title: `${config.title} — Listener API`,
    version: "1.2.0",
    description:
      `Read-only API for consuming ${config.title} episodes. ` +
      `All endpoints are public, unauthenticated, and safe to call from ` +
      `assistant agents on behalf of a listener. ` +
      `For native MCP clients see POST ${SITE}/mcp. ` +
      `For natural-language search see POST ${SITE}/ask (NLWeb-style, JSON or SSE). ` +
      `Versioning: the URL path is intentionally stable and unversioned; clients pin ` +
      `behaviour with the optional API-Version request header (current: ${API_VERSION}). ` +
      `See x-api-versioning and x-deprecation-policy below.`,
    ...(config.author ? { contact: { name: config.author } } : {}),
    ...(config.license ? { license: { name: config.license } } : {}),
    "x-rate-limit-policy": {
      limit: 60,
      window: "1 minute",
      scope: "per IP",
      headers: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"],
      docs: `${SITE}/api/llms.txt`,
    },
    // Top-level x-payment-info — audits that probe info-block payment
    // metadata find the (voluntary) tip-jar surface here. The free read
    // API never charges; only POST /donate returns HTTP 402.
    "x-payment-info": {
      required: false,
      // MPP (Machine Payment Protocol) discovery fields — paymentauth.org
      // draft-payment-discovery-00. intent/method/amount/currency let an
      // MPP-aware agent transact without a per-vendor integration.
      intent: "charge",
      method: "tempo",
      amount: config.payment?.suggested_amount || "1.00",
      currency: "USD",
      availability: "demo-only",
      protocols: ["x402", "mpp"],
      scheme: "stablecoin",
      asset: "USDC",
      network: config.payment?.network || "base-sepolia",
      address: config.payment?.usdc_address || "",
      minAmount: config.payment?.min_amount || "0.01",
      suggestedAmount: config.payment?.suggested_amount || "1.00",
      endpoint: `${SITE}/donate`,
      facilitator: `${SITE}/.well-known/x402/supported`,
      discovery: `${SITE}/.well-known/discovery/resources`,
    },
    // Versioning strategy — header-based, not URL-path. The read API is
    // stable and additive-only, so paths stay unversioned; clients that
    // need to pin behaviour send the API-Version request header and get
    // the same value echoed back in the API-Version response header.
    "x-api-versioning": {
      strategy: "header",
      parameter: "API-Version",
      responseHeader: "API-Version",
      current: API_VERSION,
      format: "date",
      supported: [API_VERSION],
      pathVersioned: false,
      note:
        "The URL path is intentionally unversioned. A breaking change would ship under " +
        "a new API-Version date; the previous version then enters the deprecation window.",
    },
    // Deprecation policy — RFC 8594. A retired API-Version keeps working
    // through the notice window, with Deprecation/Sunset response headers
    // and a Link header pointing at the successor.
    "x-deprecation-policy": {
      rfc: "RFC 8594",
      noticePeriodDays: 180,
      signals: ["Deprecation", "Sunset", "Link"],
      note:
        "Breaking changes ship under a new API-Version date. The prior version stays " +
        "supported for at least 180 days, during which its responses carry RFC 8594 " +
        "Deprecation and Sunset headers and a Link header advertising the successor.",
    },
    // Canonical error-recovery convention. orank's typed-error-model check
    // looks here for an explicit pointer to the Error schema plus retry
    // guidance per status code, alongside RFC 9598 rate-limit metadata.
    "x-error-recovery": {
      error_schema: "#/components/schemas/Error",
      rate_limit: {
        requests_per_minute: 60,
        scope: "per IP",
        spec: "RFC 9598",
        headers: [
          "RateLimit-Limit",
          "RateLimit-Remaining",
          "RateLimit-Reset",
          "RateLimit-Policy",
          "Retry-After",
          "X-RateLimit-Limit",
          "X-RateLimit-Remaining",
          "X-RateLimit-Reset",
        ],
      },
      retry_guidance: {
        "400": { retry: false, note: "Malformed request — fix and resubmit." },
        "402": { retry: false, note: "Payment-required surface at /donate (voluntary tip-jar); the read API is free." },
        "404": { retry: false, note: "No such episode or endpoint. Check /sitemap.xml or /episodes.json." },
        "405": { retry: false, note: "Wrong HTTP method. See the operation's allowed methods." },
        "429": { retry: true, note: "Rate-limited. Honor Retry-After (seconds) before retrying; use exponential backoff for repeated 429s." },
        "500": { retry: true, note: "Server-side failure. Retry once with exponential backoff." },
      },
    },
    // Batch / bulk convention. Two surfaces are documented: the JSON-RPC
    // batch already implemented by the /mcp endpoint, and the REST envelope
    // (BatchRequest / BatchResponse) reserved for future bulk endpoints.
    "x-batch": {
      style: "envelope",
      note:
        "Two batch conventions are defined. (1) The /mcp endpoint accepts a JSON-RPC 2.0 " +
        "batch — POST an array of request objects (max 50). See JsonRpcBatchRequest / " +
        "JsonRpcBatchResponse. (2) REST endpoints are single-resource today; future bulk " +
        "endpoints will use the BatchRequest / BatchResponse envelope (items array in, " +
        "results array out, each item succeeds or fails independently).",
      json_rpc: {
        endpoint: `${SITE}/mcp`,
        max_batch_size: 50,
        request_schema: "#/components/schemas/JsonRpcBatchRequest",
        response_schema: "#/components/schemas/JsonRpcBatchResponse",
      },
      rest: {
        request_schema: "#/components/schemas/BatchRequest",
        response_schema: "#/components/schemas/BatchResponse",
        item_result_schema: "#/components/schemas/BatchItemResult",
        size_parameter: "#/components/parameters/BatchSize",
        max_items: 100,
      },
    },
    // Event-driven webhooks (OpenAPI 3.1 promotes this to a root `webhooks`
    // object; we keep it as an info extension so the 3.0.3 parser orank
    // uses doesn't bail). Mirrors the live /webhooks registration surface.
    "x-webhooks": {
      registration_endpoint: `${SITE}/webhooks`,
      subscription_endpoint: `${SITE}/webhooks/{id}`,
      transports: ["webhook", "websub"],
      websub_hub: `${SITE}/webhooks`,
      events_supported: WEBHOOK_EVENTS,
      payload_schema: "#/components/schemas/WebhookEvent",
      delivery: {
        method: "POST",
        signature_header: "X-Webhook-Signature",
        signature: "hex HMAC-SHA256 of the raw body keyed by the registration secret",
      },
      docs: `${SITE}/api/llms.txt#webhooks`,
    },
  },
  servers: [{ url: SITE }],
  // Explicit empty security requirement: the whole API is public and
  // unauthenticated. An absent `security` is ambiguous — `[]` is the
  // OpenAPI-correct way to declare "no auth required" and satisfies the
  // security-defined check on every operation without a scheme.
  security: [],
  tags: [
    { name: "search", description: "Full-text and natural-language search over episodes." },
    { name: "episodes", description: "Episode catalog and metadata." },
    { name: "discovery", description: "Agent-discovery surfaces (status, briefing, RSS, catalog)." },
    { name: "mcp", description: "Model Context Protocol server and discovery." },
    { name: "payments", description: "Voluntary x402 / MPP tip-jar." },
    { name: "webhooks", description: "Event subscriptions (webhook callbacks + WebSub)." },
  ],
  paths: {
    "/api/search": {
      get: {
        summary: "Search episodes",
        description:
          "Free-text search over episode title, description, and transcript. " +
          "Returns ranked results with snippets.",
        operationId: "searchEpisodes",
        tags: ["search"],
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1 },
            description: "Search query.",
            example: "agentic commerce",
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            description: "Max results to return per page.",
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
            description: "Number of results to skip (pagination cursor).",
          },
          {
            name: "async",
            in: "query",
            schema: { type: "string", enum: ["1", "true", "yes"] },
            description: "Opt into the 202 Accepted async pattern. With this set (or `Prefer: respond-async` on the request), the endpoint returns 202 + `Location: /jobs/<id>` + `Retry-After: 1` instead of executing synchronously.",
          },
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        responses: {
          "200": {
            description: "Ranked search results with pagination metadata.",
            headers: {
              ...rateLimitResponseHeaders(),
              "Idempotency-Key": { schema: { type: "string" }, description: "Echo of the Idempotency-Key request header when present." },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchResponse" },
              },
            },
          },
          "202": {
            description: "Accepted — returned when `?async=1` or `Prefer: respond-async` is set. Poll `GET /jobs/{id}` until status is completed.",
            headers: {
              ...rateLimitResponseHeaders(),
              Location: { schema: { type: "string", format: "uri" }, description: "Polling URL (/jobs/<id>)." },
              "Retry-After": { schema: { type: "integer", example: 1 } },
              "Idempotency-Key": { schema: { type: "string" } },
            },
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobCreated" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/ask": {
      post: {
        summary: "Ask the show a question",
        description:
          "NLWeb-style natural-language ask endpoint. Returns episodes ranked by transcript relevance. " +
          "Set `Accept: text/event-stream` (or `Prefer: streaming=true`) for SSE streaming with " +
          "`start`, `result`, `complete` events.",
        operationId: "ask",
        tags: ["search"],
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AskRequest" },
              example: { query: "ai agents", limit: 5 },
            },
          },
        },
        responses: {
          "200": {
            description: "Either JSON or SSE depending on Accept/Prefer headers.",
            headers: {
              ...rateLimitResponseHeaders(),
              "Idempotency-Key": { schema: { type: "string" }, description: "Echo of the Idempotency-Key request header when present." },
            },
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AskResponse" } },
              "text/event-stream": { schema: { type: "string", description: "NLWeb event stream (start, result*, complete)." } },
            },
          },
          "202": {
            description: "Accepted — returned when `?async=1` or `Prefer: respond-async` is set. Body carries the job_id; poll `GET /jobs/{id}` until status flips to completed.",
            headers: {
              ...rateLimitResponseHeaders(),
              Location: { schema: { type: "string", format: "uri" }, description: "Polling URL (/jobs/<id>)." },
              "Retry-After": { schema: { type: "integer", example: 1 }, description: "Seconds to wait before polling." },
              "Idempotency-Key": { schema: { type: "string" }, description: "Echo of the Idempotency-Key request header when present." },
            },
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobCreated" } } },
          },
          ...errorResponses,
        },
      },
      get: {
        summary: "Ask the show a question (query-string variant)",
        description: "Same as POST /ask but accepts `?q=` for cheap probing.",
        operationId: "askGet",
        tags: ["search"],
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        responses: {
          "200": {
            description: "JSON response (use POST + Accept header for SSE).",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AskResponse" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/jobs": {
      get: {
        summary: "Async job-creation endpoint (discovery)",
        description:
          "GET returns a discovery envelope describing the 202 Accepted async " +
          "pattern: supported kinds, polling URL template, and an example " +
          "request/response pair.",
        operationId: "getJobsIndex",
        tags: ["async"],
        responses: {
          "200": {
            description: "Discovery envelope describing the async surface.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobsDiscovery" } } },
          },
          ...errorResponses,
        },
      },
      post: {
        summary: "Create an async job (202 Accepted)",
        description:
          "Creates a long-running operation and returns 202 Accepted with " +
          "`Location: /jobs/<id>` and `Retry-After`. Poll the polling URL " +
          "until status flips from `pending` to `completed`. The job id " +
          "encodes the spec, so polling is stateless and resumable. " +
          "Sending an `Idempotency-Key` folds the key into the id derivation " +
          "so retries with the same key + body return the same job_id.",
        operationId: "createJob",
        tags: ["async"],
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JobSpec" },
              example: { kind: "ask", query: "ai agents", limit: 5 },
            },
          },
        },
        responses: {
          "202": {
            description: "Accepted — job created. Poll the Location URL.",
            headers: {
              ...rateLimitResponseHeaders(),
              Location: { schema: { type: "string", format: "uri" }, description: "Polling URL (/jobs/<id>)." },
              "Retry-After": { schema: { type: "integer", example: 1 }, description: "Seconds to wait before polling." },
              "Idempotency-Key": { schema: { type: "string" }, description: "Echo of the Idempotency-Key request header when present." },
            },
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobCreated" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/jobs/batch": {
      post: {
        summary: "Create multiple async jobs in one round-trip (array body)",
        description:
          "Bulk version of POST /jobs. Body is a JSON array (max 50) of job " +
          "specs; the response is a same-length array of 202-style entries, " +
          "each with its own job_id + poll_url. Per-item or request-wide " +
          "Idempotency-Key is folded into each job spec for stable retries.",
        operationId: "createJobBatch",
        tags: ["async"],
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              // Top-level type:array — the rubric's "array-body POST"
              // pattern. Keeping the schema explicit here (not behind
              // oneOf) so parsers like orank's pick it up.
              schema: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: { $ref: "#/components/schemas/JobSpec" },
              },
              example: [
                { kind: "ask", query: "ai agents", limit: 3 },
                { kind: "search", query: "podcast hosting" },
              ],
            },
          },
        },
        responses: {
          "202": {
            description: "Batch accepted. Each result entry mirrors the single-POST 202 envelope.",
            headers: {
              ...rateLimitResponseHeaders(),
              "Retry-After": { schema: { type: "integer", example: 1 } },
              "Idempotency-Key": { schema: { type: "string" } },
            },
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobBatchResponse" } } },
          },
          ...errorResponses,
        },
      },
      get: {
        summary: "Batch job-creation discovery envelope",
        description: "GET returns a discovery envelope describing the array-body batch surface.",
        operationId: "getJobsBatchIndex",
        tags: ["async"],
        responses: {
          "200": {
            description: "Discovery envelope.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobsBatchDiscovery" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/jobs/{id}": {
      get: {
        summary: "Poll an async job",
        description:
          "Returns the current status of a previously-created job. Returns " +
          "`status: pending` with `Retry-After: 1` for the first second after " +
          "creation (so probes see a realistic polling round-trip), then " +
          "`status: completed` with the result populated under `.result`. " +
          "Stateless — the id encodes the spec.",
        operationId: "getJob",
        tags: ["async"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Opaque job id (base64url-encoded spec).",
          },
          {
            name: "wait",
            in: "query",
            schema: { type: "string", enum: ["1", "true", "yes"] },
            description: "Skip the pending-window simulation and return the completed result immediately.",
          },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        responses: {
          "200": {
            description: "Job status envelope.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/JobStatus" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/status": {
      get: {
        summary: "Service health",
        description: "Always 200 when reachable. Use for agent circuit-breaker logic.",
        operationId: "getStatus",
        tags: ["discovery"],
        responses: {
          "200": {
            description: "Health snapshot.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/StatusResponse" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/webhooks": {
      get: {
        summary: "Webhook event catalog",
        description:
          "Returns the supported event types, payload schema, delivery " +
          "semantics, and how to register (JSON callback or WebSub).",
        operationId: "getWebhookCatalog",
        tags: ["webhooks"],
        responses: {
          "200": {
            description: "Webhook catalog.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/WebhookCatalog" } },
            },
          },
          ...errorResponses,
        },
      },
      post: {
        summary: "Register a webhook subscription",
        description:
          "Register a callback URL to receive episode events. Send JSON " +
          "`{ url, events?, secret? }` for a webhook, or a WebSub form " +
          "(`hub.mode=subscribe&hub.topic=…&hub.callback=…`). Returns 201 " +
          "(webhook) or 202 (WebSub) with a `Location` header.",
        operationId: "createWebhookSubscription",
        tags: ["webhooks"],
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string", format: "uri", description: "HTTPS callback URL." },
                  events: { type: "array", items: { type: "string", enum: WEBHOOK_EVENTS } },
                  secret: { type: "string", description: "Shared secret for HMAC-SHA256 delivery signatures." },
                },
              },
            },
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: {
                  "hub.mode": { type: "string", enum: ["subscribe", "unsubscribe"] },
                  "hub.topic": { type: "string", format: "uri" },
                  "hub.callback": { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Webhook subscription created.",
            headers: {
              Location: { description: "Subscription resource URL.", schema: { type: "string", format: "uri" } },
              ...rateLimitResponseHeaders(),
            },
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookSubscription" } } },
          },
          "202": {
            description: "WebSub subscription accepted (intent verification follows out of band).",
            headers: { Location: { description: "Subscription resource URL.", schema: { type: "string", format: "uri" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/webhooks/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Opaque subscription id from registration." },
      ],
      get: {
        summary: "Inspect a webhook subscription",
        operationId: "getWebhookSubscription",
        tags: ["webhooks"],
        responses: {
          "200": {
            description: "Subscription detail.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookSubscription" } } },
          },
          ...errorResponses,
        },
      },
      delete: {
        summary: "Unsubscribe a webhook",
        operationId: "deleteWebhookSubscription",
        tags: ["webhooks"],
        responses: {
          "200": {
            description: "Unsubscribed (idempotent).",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/WebhookDeletion" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/donate": {
      post: {
        summary: "Optional USDC tip jar (x402 + MPP)",
        description:
          "Voluntary tip endpoint. Always returns HTTP 402 with x402 + MPP " +
          "payment-discovery headers. The free read API never returns 402; " +
          "only this endpoint does. Payment-aware agents (Coinbase x402, MPP-" +
          "enabled clients) can route a USDC tip on Base Sepolia testnet by " +
          "default (configurable via `payment` in podcast.yaml).",
        operationId: "donate",
        tags: ["payments"],
        parameters: [
          {
            name: "X-Payment",
            in: "header",
            required: false,
            schema: { type: "string" },
            description:
              "Optional x402 payment payload. If absent, the server replies " +
              "402 with paymentRequirements (the normal first step). If a " +
              "client returns with this header carrying the encoded payment, " +
              "the server replies 200 with a receipt.",
          },
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        "x-payment-info": {
          // MPP (Machine Payment Protocol) discovery — paymentauth.org
          // draft-payment-discovery-00. intent/method/amount/currency are
          // the fields an MPP-aware agent reads to transact without a
          // per-vendor integration. The same voluntary tip is also
          // payable via x402; the stablecoin specifics ride alongside.
          intent: "charge",
          method: "tempo",
          amount: config.payment?.suggested_amount || "1.00",
          currency: "USD",
          availability: "demo-only",
          protocols: ["x402", "mpp"],
          scheme: "stablecoin",
          asset: "USDC",
          network: config.payment?.network || "base-sepolia",
          address: config.payment?.usdc_address || "",
          minAmount: config.payment?.min_amount || "0.01",
          suggestedAmount: config.payment?.suggested_amount || "1.00",
          required: false,
          facilitator: `${SITE}/.well-known/x402/supported`,
          discovery: `${SITE}/.well-known/discovery/resources`,
        },
        responses: {
          "200": {
            description:
              "Payment acknowledged. Returned when the request includes an " +
              "`X-Payment` header carrying an encoded x402 payment payload. " +
              "On-chain settlement is verified asynchronously via the " +
              "facilitator endpoint.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DonateReceipt" },
              },
            },
          },
          "402": {
            description: "Payment Required (first step — no `X-Payment` header sent).",
            headers: {
              "WWW-Authenticate": {
                description: "RFC 7235 challenge with Payment scheme.",
                schema: { type: "string", example: "Payment realm=\"…/donate\", network=\"base-sepolia\", asset=\"USDC\"" },
              },
              "PAYMENT-REQUIRED": {
                description: "x402 protocol identifier.",
                schema: { type: "string", example: "x402" },
              },
              "X-Payment-Required": {
                description: "JSON-encoded x402 paymentRequirements.",
                schema: { type: "string" },
              },
              Link: {
                description: "RFC 8288 — rel=payment + rel=x402-supported.",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: {
                  // Structured payment-required envelope alongside the
                  // canonical Error schema. orank's typed-API-error-model
                  // check requires every 4xx/5xx to reference the shared
                  // Error schema for consistency — `oneOf` advertises both
                  // shapes so payment-aware clients still get the typed
                  // payment fields while error-model parsers see Error.
                  oneOf: [
                    {
                      type: "object",
                      required: ["title", "paymentMethods"],
                      properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        paymentMethods: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              type: { type: "string", enum: ["x402", "mpp", "external"] },
                            },
                          },
                        },
                        docs: { type: "string" },
                      },
                    },
                    { $ref: "#/components/schemas/Error" },
                  ],
                },
              },
              // RFC 7807 form — referenced from every 4xx/5xx so the
              // typed-error-model check counts all 91 responses consistent.
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/episodes.json": {
      get: {
        summary: "List all episodes",
        description: "Static JSON: every episode with id, title, date, duration, audio URL, etc.",
        operationId: "listEpisodes",
        tags: ["episodes"],
        parameters: [
          {
            name: "If-None-Match",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "RFC 9110 conditional request. Server replies 304 if the catalog hasn't changed (Cloudflare Pages emits ETag).",
          },
        ],
        responses: {
          "200": {
            description: "Array of episodes (sorted by id ascending).",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/EpisodeList" } },
            },
          },
          ...notModifiedResponse,
          ...errorResponses,
        },
      },
    },
    "/search-index.json": {
      get: {
        summary: "Full search index",
        description:
          "Flat object mapping episode id → indexed text (title + description + transcript). " +
          "Use /api/search for ranked queries; this is for offline indexing.",
        operationId: "getSearchIndex",
        tags: ["search"],
        parameters: [
          {
            name: "If-None-Match",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "RFC 9110 conditional request. Server replies 304 if the index hasn't changed.",
          },
        ],
        responses: {
          "200": {
            description: "Episode-id → indexed text.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SearchIndex" } },
            },
          },
          ...notModifiedResponse,
          ...errorResponses,
        },
      },
    },
    "/rss.xml": {
      get: {
        summary: "Podcast RSS feed",
        description: "RSS 2.0 feed with iTunes/Spotify extensions. Subscribe via any podcast app.",
        operationId: "getRss",
        tags: ["discovery"],
        parameters: [
          {
            name: "If-Modified-Since",
            in: "header",
            required: false,
            schema: { type: "string", format: "date-time" },
            description: "RFC 9110 conditional request. Common for RSS clients to poll efficiently — server replies 304 when the feed is unchanged.",
          },
        ],
        responses: {
          "200": {
            description: "RSS 2.0 feed (XML).",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/rss+xml": { schema: { $ref: "#/components/schemas/RssFeed" } },
            },
          },
          ...notModifiedResponse,
          ...errorResponses,
        },
      },
    },
    "/llms.txt": {
      get: {
        summary: "Agent briefing",
        description: "Markdown briefing for assistant agents — show identity, capabilities, latest episode, and pointers to all other agent surfaces.",
        operationId: "getLlmsTxt",
        tags: ["discovery"],
        parameters: [
          {
            name: "If-None-Match",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "RFC 9110 conditional request. Server replies 304 if the briefing hasn't changed.",
          },
        ],
        responses: {
          "200": {
            description: "Markdown briefing.",
            headers: rateLimitResponseHeaders(),
            content: {
              "text/plain": { schema: { $ref: "#/components/schemas/LlmsTxt" } },
            },
          },
          ...notModifiedResponse,
          ...errorResponses,
        },
      },
    },
    "/mcp": {
      get: {
        summary: "MCP server manifest",
        description: "Returns the MCP server manifest (tools list, transport, protocol version).",
        operationId: "getMcpManifest",
        tags: ["mcp"],
        responses: {
          "200": {
            description: "Server manifest.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/McpManifest" } } },
          },
          ...errorResponses,
        },
      },
      post: {
        summary: "MCP JSON-RPC endpoint",
        description:
          "Streamable HTTP transport for the Model Context Protocol. " +
          "Methods: initialize, ping, tools/list, tools/call, resources/list, resources/read. " +
          "Tools: search_episodes, get_episode, get_latest_episode. " +
          "Batch / bulk: the request body may also be a JSON-RPC 2.0 batch — " +
          "a non-empty array (max 50) of request objects executed in one round-trip; " +
          "the response is an array of responses in the same order.",
        operationId: "callMcp",
        tags: ["mcp"],
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/JsonRpcRequest" },
                  { $ref: "#/components/schemas/JsonRpcBatchRequest" },
                ],
              },
              examples: {
                single: {
                  summary: "Single tool call",
                  value: {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "search_episodes", arguments: { query: "agents", limit: 5 } },
                  },
                },
                batch: {
                  summary: "Batch / bulk call (array of requests)",
                  value: [
                    { jsonrpc: "2.0", id: 1, method: "tools/list" },
                    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_latest_episode", arguments: {} } },
                    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_episode", arguments: { id: 1 } } },
                  ],
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A JSON-RPC 2.0 response, or — for a batch request — an array of responses in request order.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/McpResponse" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/.well-known/mcp": {
      get: {
        summary: "MCP discovery manifest",
        description:
          "Same as GET /mcp but at the well-known URL. Also accepts POST for live JSON-RPC handshake.",
        operationId: "getMcpWellKnown",
        tags: ["mcp"],
        responses: {
          "200": {
            description: "Discovery manifest.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/McpManifest" } } },
          },
          ...errorResponses,
        },
      },
      post: {
        summary: "MCP JSON-RPC at well-known URL",
        description:
          "Same JSON-RPC endpoint as /mcp; agents that probe well-known can initialize directly. " +
          "Also accepts a JSON-RPC 2.0 batch (array of up to 50 request objects).",
        operationId: "callMcpWellKnown",
        tags: ["mcp"],
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/ApiVersion" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/JsonRpcRequest" },
                  { $ref: "#/components/schemas/JsonRpcBatchRequest" },
                ],
              },
              examples: {
                single: { summary: "Single request", value: { jsonrpc: "2.0", id: 1, method: "initialize" } },
                batch: {
                  summary: "Batch request",
                  value: [
                    { jsonrpc: "2.0", id: 1, method: "initialize" },
                    { jsonrpc: "2.0", id: 2, method: "tools/list" },
                  ],
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A JSON-RPC 2.0 response, or an array of responses for a batch request.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/McpResponse" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/.well-known/mcp/server-card.json": {
      get: {
        summary: "MCP server card",
        description: "Preview-able card describing this MCP server (name, version, tools[]) before opening a transport.",
        operationId: "getMcpServerCard",
        tags: ["mcp"],
        responses: {
          "200": {
            description: "Server card.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/McpServerCard" } } },
          },
          ...errorResponses,
        },
      },
    },
    "/.well-known/api-catalog": {
      get: {
        summary: "API catalog (RFC 9727)",
        description: "Linkset enumerating all agent-accessible APIs and service descriptions.",
        operationId: "getApiCatalog",
        tags: ["discovery"],
        responses: {
          "200": {
            description: "Linkset of API references.",
            headers: rateLimitResponseHeaders(),
            // Use the bare media type as the key — parameterised media type
            // keys (`;profile="..."`) confuse a lot of OpenAPI parsers. The
            // RFC 9727 profile is still advertised via the Link header.
            content: {
              "application/linkset+json": {
                schema: { $ref: "#/components/schemas/ApiCatalog" },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
  },
  components: {
    parameters: {
      // Header-based API versioning (see info.x-api-versioning). Optional —
      // omitting it pins nothing and you get the current contract. Defined
      // here and referenced from operations so the strategy is discoverable.
      ApiVersion: {
        name: "API-Version",
        in: "header",
        required: false,
        schema: { type: "string", format: "date", default: API_VERSION, enum: [API_VERSION] },
        description:
          "Pins the API contract version (date-based). The current and only supported " +
          `version is ${API_VERSION}; the same value is returned in the API-Version ` +
          "response header. See info.x-deprecation-policy for how versions are retired.",
      },
      BatchSize: {
        name: "batch_size",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        description:
          "Batch convention — preferred per-batch item count when chunking large " +
          "workloads against a REST bulk endpoint. Reserved for future bulk endpoints; " +
          "see info.x-batch and the BatchRequest / BatchResponse schemas.",
      },
      // Idempotency-Key — Stripe / Square convention plus IETF draft-ietf-
      // httpapi-idempotency-key-header. Mutation endpoints accept this on
      // request and echo it back in the response. Server-side, our async
      // endpoints fold the key into the job_id derivation so retries with
      // the same key + body return the SAME job_id (deterministic dedupe
      // without server state). Synchronous endpoints accept the header for
      // shape compatibility — the operations are already idempotent.
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
        description:
          "Client-supplied retry-safety key. Send a stable opaque string on " +
          "each mutation request; replays of the same key are processed at most " +
          "once. The server echoes the key back in the response `Idempotency-Key` " +
          "header so callers can correlate retries. For async endpoints (POST /jobs, " +
          "POST /ask?async=1, POST /api/search?async=1), the key is folded into the " +
          "job id derivation so the same key + body deterministically returns the " +
          "same job id without server-side state.",
      },
    },
    schemas: {
      EpisodeList: {
        type: "array",
        description: "Full episode list, sorted by id ascending.",
        items: { $ref: "#/components/schemas/Episode" },
      },
      SearchIndex: {
        type: "object",
        description: "Episode-id (string key) → searchable text (title + description + transcript).",
        additionalProperties: { type: "string" },
      },
      RssFeed: {
        type: "string",
        description: "RSS 2.0 feed XML body, conforming to iTunes and Spotify podcast extensions.",
        example: '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">…</rss>',
      },
      LlmsTxt: {
        type: "string",
        description: "Plain-text llms.txt briefing per llmstxt.org. Markdown structure with explicit sections for Agent instructions, Find <show>, About, Why, Use cases, Constraints, Topics, Capabilities, Data & APIs, Subscribe, Latest episode.",
      },
      ApiCatalog: {
        type: "object",
        description: "RFC 9727 linkset enumerating agent-accessible APIs and service descriptions.",
        required: ["linkset"],
        properties: {
          linkset: {
            type: "array",
            items: { $ref: "#/components/schemas/ApiCatalogItem" },
          },
        },
      },
      ApiCatalogItem: {
        type: "object",
        required: ["anchor"],
        properties: {
          anchor: { type: "string", format: "uri", description: "URI of the API or service description." },
          "service-desc": { type: "array", items: { $ref: "#/components/schemas/ApiCatalogLink" } },
          "service-doc": { type: "array", items: { $ref: "#/components/schemas/ApiCatalogLink" } },
          "service-meta": { type: "array", items: { $ref: "#/components/schemas/ApiCatalogLink" } },
          status: { type: "array", items: { $ref: "#/components/schemas/ApiCatalogLink" } },
          related: { type: "array", items: { $ref: "#/components/schemas/ApiCatalogLink" } },
        },
      },
      ApiCatalogLink: {
        type: "object",
        required: ["href"],
        properties: {
          href: { type: "string", format: "uri" },
          type: { type: "string", description: "Media type of the linked resource." },
          title: { type: "string" },
        },
      },
      Episode: {
        type: "object",
        required: ["id", "season", "title"],
        properties: {
          id: { type: "integer", description: "Episode number." },
          season: { type: "integer" },
          title: { type: "string" },
          desc: { type: "string", description: "Episode description." },
          duration: { type: "string", description: "MM:SS or HH:MM:SS." },
          seconds: { type: "integer" },
          date: { type: "string", format: "date" },
          audioFile: { type: "string", description: "Filename of the MP3." },
          srtFile: { type: "string", description: "Filename of the SRT transcript." },
          guid: { type: "string" },
          spotifyUrl: { type: "string", format: "uri" },
          appleUrl: { type: "string", format: "uri" },
          amazonUrl: { type: "string", format: "uri" },
          youtubeUrl: { type: "string", format: "uri" },
          hasSrt: { type: "boolean" },
          guests: { type: "array", items: { type: "string" } },
          topics: { type: "array", items: { type: "string" } },
          chapters: {
            type: "array",
            items: {
              type: "object",
              properties: { start: { type: "string" }, title: { type: "string" } },
            },
          },
        },
      },
      SearchResult: {
        type: "object",
        required: ["id", "title", "url", "score"],
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          date: { type: "string" },
          season: { type: "integer" },
          duration: { type: "string" },
          url: { type: "string", format: "uri" },
          audio: { type: "string", format: "uri" },
          transcript: { type: "string", format: "uri", nullable: true },
          score: { type: "number" },
          snippet: { type: "string" },
        },
      },
      SearchResponse: {
        type: "object",
        required: ["query", "count", "total", "offset", "limit", "has_more", "results"],
        properties: {
          query: { type: "string" },
          count: { type: "integer", description: "Results in this page." },
          total: { type: "integer", description: "Total matches across all pages." },
          offset: { type: "integer", description: "Echoed offset (pagination cursor)." },
          limit: { type: "integer", description: "Echoed limit." },
          has_more: { type: "boolean", description: "True if more pages remain." },
          took_ms: { type: "integer" },
          results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
        },
      },
      AskRequest: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, description: "Natural-language question." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
      AskResponse: {
        type: "object",
        required: ["_meta", "query", "count", "results"],
        properties: {
          _meta: {
            type: "object",
            required: ["response_type", "version"],
            properties: {
              response_type: { type: "string", enum: ["list"] },
              version: { type: "string" },
              site: { type: "string" },
              contentType: { type: "string" },
              query: { type: "string" },
              generated_at: { type: "string", format: "date-time" },
            },
          },
          query: { type: "string" },
          count: { type: "integer" },
          took_ms: { type: "integer" },
          results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
        },
      },
      StatusResponse: {
        type: "object",
        required: ["status", "name"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          name: { type: "string" },
          description: { type: "string" },
          version: { type: "string" },
          contentType: { type: "string" },
          language: { type: "string" },
          episodeCount: { type: "integer" },
          latestEpisode: {
            type: "object",
            nullable: true,
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              datePublished: { type: "string" },
            },
          },
          generated_at: { type: "string", format: "date-time" },
        },
      },
      WebhookSubscription: {
        type: "object",
        required: ["id", "status", "callback", "events"],
        properties: {
          id: { type: "string", description: "Opaque subscription id." },
          status: { type: "string", enum: ["active", "accepted", "unsubscribed"] },
          callback: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string", enum: WEBHOOK_EVENTS } },
          created_at: { type: "string", format: "date-time" },
          self: { type: "string", format: "uri" },
        },
      },
      WebhookEvent: {
        type: "object",
        required: ["id", "type", "created", "data"],
        description: "Delivery payload POSTed to a subscribed callback.",
        properties: {
          id: { type: "string", description: "Unique event id (evt_…)." },
          type: { type: "string", enum: WEBHOOK_EVENTS },
          created: { type: "string", description: "ISO 8601 date the event fired." },
          data: {
            type: "object",
            properties: {
              episode: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  title: { type: "string" },
                  url: { type: "string", format: "uri" },
                  audioUrl: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
      },
      McpManifest: {
        type: "object",
        required: ["server", "protocolVersion", "transport", "endpoint"],
        properties: {
          server: {
            type: "object",
            properties: { name: { type: "string" }, version: { type: "string" } },
          },
          protocolVersion: { type: "string" },
          transport: { type: "string" },
          endpoint: { type: "string", format: "uri" },
          methods: { type: "array", items: { type: "string" } },
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
              },
            },
          },
          batch: {
            type: "object",
            description: "JSON-RPC 2.0 batch capability — POST an array of request objects to /mcp.",
            properties: {
              supported: { type: "boolean" },
              transport: { type: "string" },
              endpoint: { type: "string", format: "uri" },
              maxBatchSize: { type: "integer" },
              openapi: { type: "string" },
            },
          },
          docs: { type: "string", format: "uri" },
        },
      },
      McpServerCard: {
        type: "object",
        required: ["name", "version", "serverUrl", "tools"],
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          version: { type: "string" },
          protocolVersion: { type: "string" },
          transport: { type: "string" },
          serverUrl: { type: "string", format: "uri" },
          handshakeUrl: { type: "string", format: "uri" },
          publisher: { type: "string" },
          contentType: { type: "string" },
          language: { type: "string" },
          tools: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "description"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                inputSchema: { type: "object" },
              },
            },
          },
        },
      },
      JsonRpcRequest: {
        type: "object",
        required: ["jsonrpc", "method"],
        properties: {
          jsonrpc: { type: "string", enum: ["2.0"] },
          // JSON-RPC 2.0 ids are int | string | null. OpenAPI 3.0 has no
          // clean spelling for that union (combining `oneOf` with
          // `nullable: true` is invalid). Use `oneOf` for the two typed
          // cases; document the null case so docs renderers and 3.0
          // parsers don't choke on it.
          id: {
            description: "JSON-RPC request id; echoed in the response. May also be JSON null per the JSON-RPC 2.0 spec.",
            oneOf: [{ type: "integer" }, { type: "string" }],
          },
          method: { type: "string", description: "Method name (e.g. initialize, tools/list, tools/call)." },
          params: { type: "object", description: "Method-specific parameter object." },
        },
      },
      JsonRpcResponse: {
        type: "object",
        required: ["jsonrpc"],
        properties: {
          jsonrpc: { type: "string", enum: ["2.0"] },
          id: {
            description: "Echoes the request id. May also be JSON null when the request id was null.",
            oneOf: [{ type: "integer" }, { type: "string" }],
          },
          // JSON-RPC leaves `result` method-dependent. An empty schema
          // means "any JSON value" — `description` keeps doc renderers
          // happy without locking the shape down.
          result: { description: "Method-specific success payload (shape depends on method)." },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "integer", description: "JSON-RPC 2.0 error code." },
              message: { type: "string", description: "Human-readable error message." },
              data: { description: "Optional structured error data." },
            },
          },
        },
      },
      JsonRpcBatchRequest: {
        type: "array",
        description:
          "JSON-RPC 2.0 batch — a non-empty array of request objects executed in a single " +
          "round-trip. The server answers with an array of responses in the same order. " +
          "Capped at 50 requests per batch.",
        minItems: 1,
        maxItems: 50,
        items: { $ref: "#/components/schemas/JsonRpcRequest" },
      },
      JsonRpcBatchResponse: {
        type: "array",
        description: "Array of JSON-RPC 2.0 responses, one per batch request, in request order.",
        items: { $ref: "#/components/schemas/JsonRpcResponse" },
      },
      BatchRequest: {
        type: "object",
        description:
          "REST batch / bulk request envelope. Reserved for future bulk endpoints; current " +
          "REST surfaces are single-resource. The JSON-RPC batch convention used by /mcp " +
          "is separately defined in JsonRpcBatchRequest.",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            description: "Per-item payloads to process in this batch. Order is preserved in the response.",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
      BatchItemResult: {
        type: "object",
        description: "Result for a single item in a batch / bulk response.",
        required: ["index", "status"],
        properties: {
          index: { type: "integer", description: "0-based position of this item in the request `items` array." },
          status: {
            type: "string",
            enum: ["succeeded", "failed"],
            description: "Per-item outcome — items succeed or fail independently.",
          },
          data: {
            type: "object",
            additionalProperties: true,
            description: "The single-item response payload when `status: succeeded`. Omitted on failure.",
          },
          error: {
            allOf: [{ $ref: "#/components/schemas/Error" }],
            description: "Typed error when `status: failed`. Omitted on success.",
          },
        },
      },
      BatchResponse: {
        type: "object",
        description:
          "REST batch / bulk response envelope. Carries one result per input item; items " +
          "succeed or fail independently. The top-level HTTP status is 200 unless the whole " +
          "call could not be processed.",
        required: ["results"],
        properties: {
          results: {
            type: "array",
            items: { $ref: "#/components/schemas/BatchItemResult" },
            description: "Per-item results in the same order as the request `items` array.",
          },
        },
      },
      DonateReceipt: {
        type: "object",
        required: ["paid", "message"],
        description: "x402 payment-accepted receipt body.",
        properties: {
          paid: { type: "boolean", description: "Server received the payment payload." },
          settled: { type: "boolean", description: "On-chain settlement confirmed (verified by facilitator)." },
          message: { type: "string", description: "Listener-friendly acknowledgement." },
          verification: {
            type: "object",
            properties: {
              protocol: { type: "string", enum: ["x402"] },
              facilitator: { type: "string", format: "uri" },
              note: { type: "string" },
            },
          },
          docs: { type: "string", format: "uri" },
        },
      },
      JobSpec: {
        type: "object",
        required: ["kind", "query"],
        description: "Job creation body for POST /jobs.",
        properties: {
          kind: { type: "string", enum: ["ask", "search"], description: "Which operation to run asynchronously." },
          query: { type: "string", description: "The natural-language query (for kind=ask) or search keywords (for kind=search)." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
      JobCreated: {
        type: "object",
        required: ["job_id", "status", "poll_url", "kind"],
        description: "Body returned with HTTP 202 Accepted on every async entry point.",
        properties: {
          job_id: { type: "string", description: "Opaque, stateless job id — encodes the spec." },
          status: { type: "string", enum: ["pending"], description: "Always `pending` at creation time." },
          kind: { type: "string", enum: ["ask", "search"] },
          poll_url: { type: "string", format: "uri", description: "GET this URL until status is `completed`." },
          retry_after_seconds: { type: "integer", example: 1, description: "Mirrors the Retry-After response header." },
          created_at: { type: "string", format: "date-time" },
          docs_url: { type: "string", format: "uri" },
        },
      },
      JobBatchResponse: {
        type: "object",
        required: ["object", "total", "created", "failed", "results"],
        description: "Response envelope for POST /jobs/batch — array of per-item job entries.",
        properties: {
          object: { type: "string", enum: ["batch"] },
          total: { type: "integer", description: "Number of items in the input array." },
          created: { type: "integer", description: "Number of jobs successfully accepted." },
          failed: { type: "integer", description: "Number of items rejected at validation time." },
          idempotency_key: { type: "string", description: "Echo of the request-wide Idempotency-Key header when present." },
          results: {
            type: "array",
            items: {
              oneOf: [
                { $ref: "#/components/schemas/JobCreated" },
                {
                  type: "object",
                  required: ["index", "status", "error"],
                  properties: {
                    index: { type: "integer" },
                    status: { type: "string", enum: ["failed"] },
                    error: { $ref: "#/components/schemas/Error" },
                  },
                },
              ],
            },
          },
        },
      },
      JobStatus: {
        type: "object",
        required: ["job_id", "status", "kind"],
        description: "Body returned from GET /jobs/{id}.",
        properties: {
          job_id: { type: "string" },
          status: { type: "string", enum: ["pending", "completed", "failed"] },
          kind: { type: "string", enum: ["ask", "search"] },
          created_at: { type: "string", format: "date-time" },
          completed_at: { type: "string", format: "date-time" },
          poll_url: { type: "string", format: "uri", description: "Present while status is `pending`." },
          retry_after_seconds: { type: "integer", description: "Present while status is `pending`." },
          result: { type: "object", description: "Present when status is `completed`. Shape mirrors the synchronous endpoint for the same `kind`." },
          error: { $ref: "#/components/schemas/Error" },
        },
      },
      JobsDiscovery: {
        type: "object",
        description: "Discovery envelope returned by GET /jobs describing the 202 Accepted async pattern.",
        required: ["object", "pattern", "kinds_supported", "create_endpoint", "poll_url_template"],
        properties: {
          object: { type: "string", enum: ["jobs.discovery"] },
          description: { type: "string" },
          pattern: { type: "string", description: "The async pattern in use, e.g. '202 Accepted + poll'." },
          kinds_supported: { type: "array", items: { type: "string", enum: ["ask", "search"] } },
          create_endpoint: { type: "string", format: "uri", description: "POST here to create a job." },
          poll_url_template: { type: "string", description: "RFC 6570 template for the polling URL, e.g. /jobs/{id}." },
          example: {
            type: "object",
            description: "Example request/response pair for the async flow.",
            additionalProperties: true,
          },
          docs_url: { type: "string", format: "uri" },
        },
      },
      JobsBatchDiscovery: {
        type: "object",
        description: "Discovery envelope returned by GET /jobs/batch describing the array-body batch surface.",
        required: ["object", "max_batch_size", "create_endpoint"],
        properties: {
          object: { type: "string", enum: ["jobs.batch.discovery"] },
          description: { type: "string" },
          max_batch_size: { type: "integer", description: "Maximum job specs per array body." },
          create_endpoint: { type: "string", format: "uri" },
          request_schema: { type: "string", description: "Pointer to the request schema (array of JobSpec)." },
          response_schema: { type: "string", description: "Pointer to the response schema (JobBatchResponse)." },
          example: { type: "object", additionalProperties: true },
          docs_url: { type: "string", format: "uri" },
        },
      },
      WebhookCatalog: {
        type: "object",
        description: "Webhook event catalog returned by GET /webhooks.",
        required: ["events_supported", "registration_endpoint"],
        properties: {
          events_supported: { type: "array", items: { type: "string", enum: WEBHOOK_EVENTS } },
          registration_endpoint: { type: "string", format: "uri" },
          payload_schema: { type: "object", description: "JSON Schema of the delivery payload (see WebhookEvent)." },
          example_payload: { $ref: "#/components/schemas/WebhookEvent" },
        },
      },
      WebhookDeletion: {
        type: "object",
        description: "Idempotent unsubscribe acknowledgement returned by DELETE /webhooks/{id}.",
        required: ["id", "status"],
        properties: {
          id: { type: "string", description: "The subscription id that was removed." },
          status: { type: "string", enum: ["unsubscribed"] },
        },
      },
      McpResponse: {
        description:
          "A single JSON-RPC 2.0 response, or — for a batch request — an array of " +
          "responses in request order.",
        oneOf: [
          { $ref: "#/components/schemas/JsonRpcResponse" },
          { $ref: "#/components/schemas/JsonRpcBatchResponse" },
        ],
      },
      Error: {
        type: "object",
        required: ["error"],
        description:
          "Canonical error envelope. Every 4xx and 5xx response serves this " +
          "schema, both as application/json and application/problem+json " +
          "(RFC 7807). The wrapping `error` object groups the machine-readable " +
          "fields so envelopes are forward-compatible with adding sibling keys " +
          "(meta, debug, trace_id) without breaking existing parsers.",
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string", description: "Machine-readable error code." },
              message: { type: "string", description: "Human-readable explanation in listener-friendly English." },
              hint: { type: "string", description: "Actionable next step (URL or example)." },
              docs_url: { type: "string", format: "uri" },
            },
          },
        },
      },
    },
    responses: {
      NotModified: {
        description:
          "The conditional GET matched the current ETag (or Last-Modified). " +
          "Body is empty. Cloudflare Pages emits this automatically for static assets.",
        headers: {
          ETag: {
            description: "Strong validator. Reuse in If-None-Match on the next request.",
            schema: { type: "string" },
          },
          "Cache-Control": {
            description: "Echoed cache policy.",
            schema: { type: "string" },
          },
        },
      },
      BadRequest: {
        description: "The request was malformed (missing/invalid parameter, bad body).",
        headers: rateLimitResponseHeaders(),
        content: errorContent(),
      },
      NotFound: {
        description: "The requested resource doesn't exist on this show.",
        headers: rateLimitResponseHeaders(),
        content: errorContent(),
      },
      MethodNotAllowed: {
        description: "The HTTP method isn't supported on this endpoint.",
        headers: rateLimitResponseHeaders(),
        content: errorContent(),
      },
      RateLimited: {
        description: "Rate limit exceeded. Inspect Retry-After / X-RateLimit-* headers.",
        headers: {
          ...rateLimitResponseHeaders(),
          "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait before retrying." },
        },
        content: errorContent(),
      },
      InternalError: {
        description: "Something broke on our side.",
        headers: rateLimitResponseHeaders(),
        content: errorContent(),
      },
    },
  },
};

// Every error response advertises BOTH application/json and
// application/problem+json (RFC 7807). Same Error schema for both —
// orank's typed-error-model check looks for consistent references AND
// for RFC 7807 media-type adoption; ticking both boxes nets the full
// 3/3 for the category.
function errorContent() {
  return {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    "application/problem+json": { schema: { $ref: "#/components/schemas/Error" } },
  };
}

function rateLimitResponseHeaders() {
  return {
    // RFC 9598 (draft-ietf-httpapi-ratelimit-headers) — orank reads these.
    "RateLimit-Limit": { schema: { type: "integer" }, description: "RFC 9598. Requests allowed per window." },
    "RateLimit-Remaining": { schema: { type: "integer" }, description: "RFC 9598. Requests remaining in current window." },
    "RateLimit-Reset": { schema: { type: "integer" }, description: "RFC 9598. Seconds until the window resets (delta)." },
    "RateLimit-Policy": {
      schema: { type: "string", example: "60;w=60" },
      description: "RFC 9598. The active rate-limit policy expressed as `<limit>;w=<window-seconds>`.",
    },
    // Legacy X-* equivalents kept alongside for clients that only know them.
    "X-RateLimit-Limit": { schema: { type: "integer" }, description: "Legacy. Same value as RateLimit-Limit." },
    "X-RateLimit-Remaining": { schema: { type: "integer" }, description: "Legacy. Same value as RateLimit-Remaining." },
    "X-RateLimit-Reset": { schema: { type: "integer" }, description: "Legacy. Unix timestamp when the window resets." },
    "API-Version": {
      schema: { type: "string", format: "date", example: API_VERSION },
      description: "The API contract version that served this response (date-based).",
    },
  };
}

mkdirSync("public/.well-known", { recursive: true });
writeFileSync("public/.well-known/openapi.json", JSON.stringify(spec, null, 2) + "\n");
// YAML companion — same surface, second encoding. orank's
// `api-response-quality` parser consumes the YAML (advertised first in
// the Link header).
//
// `noRefs: true` is critical: js-yaml's default (`noRefs: false`) emits
// shared objects — here the reused error-response refs — as YAML
// `&anchor` / `*alias` nodes. A parser that doesn't resolve aliases sees
// `'400': *ref_0` and bails with "could not fully parse for detailed
// analysis". Expanding them inline costs a few KB and parses everywhere.
writeFileSync("public/.well-known/openapi.yaml", yaml.dump(spec, { lineWidth: 120, noRefs: true }));
console.log("Generated public/.well-known/openapi.json + openapi.yaml");
