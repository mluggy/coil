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

// Targeting OpenAPI 3.0.3 (not 3.1) for the widest parser/validator support.
// orank-style audits and many LLM function-calling pipelines still ship 3.0
// parsers; 3.1's array-typed `type` and JSON-Schema-2020-12 features confuse
// them, dropping the spec to "partial parse" and cascading to the typed-
// schema count. 3.0 + `nullable: true` is the safe lowest common denominator.
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
  paths: {
    "/api/search": {
      get: {
        summary: "Search episodes",
        description:
          "Free-text search over episode title, description, and transcript. " +
          "Returns ranked results with snippets.",
        operationId: "searchEpisodes",
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
          "402": {
            description: "Payment Required (always — voluntary tip jar).",
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
        responses: {
          "200": {
            description: "Array of episodes (sorted by id ascending).",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/EpisodeList" } },
            },
          },
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
        responses: {
          "200": {
            description: "Episode-id → indexed text.",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SearchIndex" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/rss.xml": {
      get: {
        summary: "Podcast RSS feed",
        description: "RSS 2.0 feed with iTunes/Spotify extensions. Subscribe via any podcast app.",
        operationId: "getRss",
        responses: {
          "200": {
            description: "RSS 2.0 feed (XML).",
            headers: rateLimitResponseHeaders(),
            content: {
              "application/rss+xml": { schema: { $ref: "#/components/schemas/RssFeed" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/llms.txt": {
      get: {
        summary: "Agent briefing",
        description: "Markdown briefing for assistant agents — show identity, capabilities, latest episode, and pointers to all other agent surfaces.",
        operationId: "getLlmsTxt",
        responses: {
          "200": {
            description: "Markdown briefing.",
            headers: rateLimitResponseHeaders(),
            content: {
              "text/plain": { schema: { $ref: "#/components/schemas/LlmsTxt" } },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/mcp": {
      get: {
        summary: "MCP server manifest",
        description: "Returns the MCP server manifest (tools list, transport, protocol version).",
        operationId: "getMcpManifest",
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
        requestBody: { $ref: "#/components/requestBodies/JsonRpcBody" },
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
          id: { oneOf: [{ type: "integer" }, { type: "string" }], nullable: true },
          method: { type: "string" },
          params: { type: "object" },
        },
      },
      JsonRpcResponse: {
        type: "object",
        required: ["jsonrpc"],
        properties: {
          jsonrpc: { type: "string", enum: ["2.0"] },
          id: { oneOf: [{ type: "integer" }, { type: "string" }], nullable: true },
          result: {},
          error: {
            type: "object",
            properties: {
              code: { type: "integer" },
              message: { type: "string" },
              data: {},
            },
          },
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
    requestBodies: {
      JsonRpcBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/JsonRpcRequest" },
            example: { jsonrpc: "2.0", id: 1, method: "initialize" },
          },
        },
      },
    },
    responses: {
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
console.log("Generated public/.well-known/openapi.json");
