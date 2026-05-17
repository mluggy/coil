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

const SITE = "{{SITE_URL}}";

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
    version: "1.1.0",
    description:
      `Read-only API for consuming ${config.title} episodes. ` +
      `All endpoints are public, unauthenticated, and safe to call from ` +
      `assistant agents on behalf of a listener. ` +
      `For native MCP clients see POST ${SITE}/mcp. ` +
      `For natural-language search see POST ${SITE}/ask (NLWeb-style, JSON or SSE).`,
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
        ],
        responses: {
          "200": {
            description: "Ranked search results with pagination metadata.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchResponse" },
              },
            },
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
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AskResponse" } },
              "text/event-stream": { schema: { type: "string", description: "NLWeb event stream (start, result*, complete)." } },
            },
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
        ],
        "x-payment-info": {
          protocols: ["x402", "mpp"],
          scheme: "stablecoin",
          asset: "USDC",
          network: config.payment?.network || "base-sepolia",
          address: config.payment?.usdc_address || "",
          minAmount: config.payment?.min_amount || "0.01",
          suggestedAmount: config.payment?.suggested_amount || "1.00",
          currency: "USD",
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
              },
            },
          },
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
          "Methods: initialize, ping, tools/list, tools/call. " +
          "Tools: search_episodes, get_episode, get_latest_episode, list_episodes, subscribe_via_rss.",
        operationId: "callMcp",
        tags: ["mcp"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JsonRpcRequest" },
              example: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "search_episodes", arguments: { query: "agents", limit: 5 } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "JSON-RPC 2.0 response.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/JsonRpcResponse" } } },
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
        description: "Same JSON-RPC endpoint as /mcp; agents that probe well-known can initialize directly.",
        operationId: "callMcpWellKnown",
        tags: ["mcp"],
        // Inlined (instead of `$ref: "#/components/requestBodies/..."`).
        // Some scanners can't dereference requestBody refs and bail with
        // "could not fully parse".
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JsonRpcRequest" },
              example: { jsonrpc: "2.0", id: 1, method: "initialize" },
            },
          },
        },
        responses: {
          "200": {
            description: "JSON-RPC 2.0 response.",
            headers: rateLimitResponseHeaders(),
            content: { "application/json": { schema: { $ref: "#/components/schemas/JsonRpcResponse" } } },
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
      Error: {
        type: "object",
        required: ["error"],
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
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "The requested resource doesn't exist on this show.",
        headers: rateLimitResponseHeaders(),
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      MethodNotAllowed: {
        description: "The HTTP method isn't supported on this endpoint.",
        headers: rateLimitResponseHeaders(),
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      RateLimited: {
        description: "Rate limit exceeded. Inspect Retry-After / X-RateLimit-* headers.",
        headers: {
          ...rateLimitResponseHeaders(),
          "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait before retrying." },
        },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      InternalError: {
        description: "Something broke on our side.",
        headers: rateLimitResponseHeaders(),
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
};

function rateLimitResponseHeaders() {
  return {
    "X-RateLimit-Limit": { schema: { type: "integer" }, description: "Requests allowed per window." },
    "X-RateLimit-Remaining": { schema: { type: "integer" }, description: "Requests remaining in window." },
    "X-RateLimit-Reset": { schema: { type: "integer" }, description: "Unix timestamp when window resets." },
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
