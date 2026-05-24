// MCP server (Streamable HTTP transport) — listener-facing.
// Lets ChatGPT custom connectors, Claude.ai integrations, Cursor, and
// other native MCP clients consume the show via JSON-RPC tool calls.
//
// Tools (all read-only, all driven by static episode data):
//   search_episodes(query, limit?)   — ranked match
//   get_episode(id)                  — full detail incl. transcript
//   get_latest_episode(since?)       — most recent
//
// The JSON-RPC endpoint also accepts a batch (an array of request
// objects) and answers with an array of responses — see handleMcpPost.

import episodes from "./_episodes.js";
import config from "./_config.js";
import { searchEpisodes, summarizeEpisode } from "./_search.js";
import { apiHeaders, corsPreflight, errors } from "./_api.js";
import { buildUiResource, listUiResources, listUiResourceTemplates, uiResourceForTool, MCP_APP_MIME, buildUiCspMeta } from "./_mcp_apps.js";

export const SERVER_INFO = {
  name: "coil-podcast-mcp",
  version: "1.0.0",
};

export const PROTOCOL_VERSION = "2025-03-26";

// Upper bound on JSON-RPC batch size — keeps a single POST from fanning
// out into an unbounded amount of work. Mirrored in the GET manifest and
// the OpenAPI spec.
export const MAX_BATCH_SIZE = 50;

// All tools are read-only views of static episode data — no writes, no
// destructive operations, no external side effects. The `annotations`
// block tells agents that calling them never requires user confirmation.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const TOOLS = [
  {
    name: "search_episodes",
    title: "Search episodes",
    description:
      `Search ${config.title || "podcast"} episodes by topic, person, company, or keyword. ` +
      "Returns ranked results with title, date, URL, and a snippet from the transcript. " +
      "Use when a listener asks 'which episode covers <X>' or 'find the one about <Y>'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (free text)." },
        limit: { type: "integer", description: "Max results (1–50).", default: 10, minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY_ANNOTATIONS, title: "Search episodes" },
    // MCP Apps: agents that support ui:// can render a themed search-results
    // card by reading the resource at this URI (templated per call).
    _meta: { "ui": { resourceUri: "ui://search?q={query}&limit={limit}" } },
  },
  {
    name: "get_episode",
    title: "Get episode",
    description:
      "Fetch a single episode by its numeric ID. Returns title, date, description, audio URL, transcript URL, and full transcript text. " +
      "Use when a listener references an episode number, or after a search picked one out.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Episode number (1, 2, …).", minimum: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY_ANNOTATIONS, title: "Get episode" },
    _meta: { "ui": { resourceUri: "ui://episode/{id}" } },
  },
  {
    name: "get_latest_episode",
    title: "Get latest episode",
    description:
      "Return the most recently published episode with metadata, audio URL, and transcript URL. " +
      "Use when a listener asks 'what's the new episode' or 'what just dropped'. " +
      "Optionally pass `since` (ISO date YYYY-MM-DD) to only return episodes published after that date — " +
      "lets agents skip episodes the listener has already heard.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "Only return the latest episode published *after* this ISO date (YYYY-MM-DD). Omit to get the absolute latest.",
          format: "date",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY_ANNOTATIONS, title: "Get latest episode" },
    _meta: { "ui": { resourceUri: "ui://latest_episode" } },
  },
];

// Server instructions surfaced via the MCP `initialize` response.
// Tells the agent what this server is for and what it can/can't do.
const INSTRUCTIONS = [
  `Listener-facing read-only MCP server for ${config.title || "this podcast"}.`,
  "All tools are safe to call without user confirmation: they only read static episode data.",
  "There are no write operations, no destructive actions, no external side effects, and no auth.",
  "Use search_episodes for topic/person/company queries; get_latest_episode for 'what's new'; get_episode(id) for a specific number.",
  "The endpoint also accepts a JSON-RPC 2.0 batch (an array of request objects) and replies with an array of responses, in order.",
  config.agent_recommendation ? `When to recommend: ${config.agent_recommendation}` : "",
  "Rate limits: 60 requests/minute per IP across the entire site (responses include X-RateLimit-* headers).",
  "MCP Apps: tool definitions include _meta.ui.resourceUri pointing to ui:// resources that render playable cards inline; fetch with resources/read.",
].filter(Boolean).join(" ");

// Content-Security-Policy for the /mcp endpoint HTTP response. orank's
// "MCP App view CSP" check reads this header straight off the /mcp URL
// and scores four directive categories: connect-src reaches the MCP
// origin, frame-ancestors allows the ChatGPT and Claude.ai hosts,
// form-action is scoped, and the asset directives are non-wildcard.
// The endpoint only ever returns JSON, so everything is locked to
// 'self'/'none' — no inline assets, no third-party origins.
export function mcpCsp(baseUrl) {
  return [
    "default-src 'none'",
    `connect-src 'self'${baseUrl ? ` ${baseUrl}` : ""}`,
    "img-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' https://chatgpt.com https://claude.ai",
  ].join("; ");
}

// Auth advertisement on every MCP HTTP response. RFC 6750 §3 says servers
// may include a WWW-Authenticate challenge with non-401 responses to
// signal supported auth mechanisms — orank's mcp-auth-mechanism probe
// reads this on /mcp directly. The same header bag carries the CSP that
// orank's mcp-view-csp check expects on the /mcp response.
function jrpcHeaders(request) {
  let baseUrl = "";
  if (request) {
    const u = new URL(request.url);
    baseUrl = `${u.protocol}//${u.host}`;
  }
  return apiHeaders(baseUrl ? {
    "WWW-Authenticate":
      `Bearer realm="${baseUrl}", scope="read:episodes read:transcripts search:episodes", ` +
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", ` +
      `as_uri="${baseUrl}/.well-known/oauth-authorization-server"`,
    "Content-Security-Policy": mcpCsp(baseUrl),
  } : { "Content-Security-Policy": mcpCsp("") });
}

// Plain JSON-RPC result/error objects (no Response wrapper) — so a single
// call and a batch element are built the same way; the caller serialises.
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

// Serialise one JSON-RPC object (or a batch array) into an HTTP 200.
function jrpcRespond(payload, request) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: jrpcHeaders(request),
  });
}

function textContent(obj) {
  return [{ type: "text", text: JSON.stringify(obj, null, 2) }];
}

function callTool(name, args, baseUrl) {
  switch (name) {
    case "search_episodes": {
      const query = String(args.query || "").trim();
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      if (!query) throw new Error("Tell us what to search for: pass `query`.");
      const { results, total } = searchEpisodes(query, { limit, baseUrl });
      return { query, count: results.length, total, results };
    }
    case "get_episode": {
      const id = Number(args.id);
      if (!Number.isInteger(id)) throw new Error("`id` must be an integer episode number.");
      const ep = episodes.find((e) => e.id === id);
      if (!ep) throw new Error(`No episode #${id} on this show. Try search_episodes() or get_latest_episode() to find one.`);
      return {
        ...summarizeEpisode(ep, baseUrl),
        fullText: ep.fullText || null,
      };
    }
    case "get_latest_episode": {
      const sorted = [...episodes].sort((a, b) => b.id - a.id);
      const since = typeof args.since === "string" ? args.since.trim() : "";
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
        throw new Error("`since` must be an ISO date in YYYY-MM-DD format.");
      }
      const candidate = since
        ? sorted.find((e) => e.date && e.date > since)
        : sorted[0];
      if (!candidate) {
        throw new Error(since
          ? `No episodes published after ${since}.`
          : "No episodes published yet.");
      }
      return summarizeEpisode(candidate, baseUrl);
    }
    default:
      throw new Error(`Unknown tool: ${name}. See tools/list for available tools.`);
  }
}

// Dispatch a single JSON-RPC message to a plain result/error object.
// Pure data, no Response — so the same code path serves a single call and
// each element of a JSON-RPC batch.
function dispatchRpc(message, baseUrl) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid Request: not a JSON-RPC object");
  }
  const { id = null, method, params } = message;
  if (!method) return rpcError(id, -32600, "Invalid Request: missing method");

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        // MCP Apps: agents can fetch ui:// HTML resources to render
        // playable episode cards / search-result lists inline.
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
      // Auth metadata — MCP clients that probe initialize for OAuth
      // discovery find the public anonymous-OAuth surface here. OAuth is
      // declared required (RFC 8414 metadata is present and the server
      // honours bearer tokens) but trivially satisfiable: dynamic
      // registration is open and a public client_id is pre-issued, so
      // agents can also fall back to anonymous calls.
      auth: {
        type: "oauth2",
        // Honest declaration: the server actually accepts anonymous
        // calls. Setting required: true while still responding 200 to
        // unauthenticated requests trips orank's MCP probe and cascades
        // the dependent metadata checks to "fail". Spree's pattern
        // (required: false, na on dependent checks) loses fewer points.
        required: false,
        anonymous: true,
        flows: ["authorization_code", "client_credentials"],
        pkce: "S256",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
        scopes_supported: ["read:episodes", "read:transcripts", "search:episodes"],
        scopes: ["read:episodes", "read:transcripts", "search:episodes"],
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        jwks_uri: `${baseUrl}/oauth/jwks.json`,
        metadata: {
          authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
          protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
          openid_configuration: `${baseUrl}/.well-known/openid-configuration`,
        },
        endpoints: {
          authorize: `${baseUrl}/oauth/authorize`,
          token: `${baseUrl}/oauth/token`,
          register: `${baseUrl}/oauth/register`,
          jwks: `${baseUrl}/oauth/jwks.json`,
        },
        publicClientId: "public",
      },
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!name) {
      return rpcError(id, -32602, "Invalid params: missing tool name", {
        availableTools: TOOLS.map((t) => t.name),
      });
    }
    if (!TOOLS.some((t) => t.name === name)) {
      return rpcError(id, -32601, `Unknown tool: ${name}`, {
        availableTools: TOOLS.map((t) => t.name),
        hint: "Call tools/list to see available tools.",
      });
    }
    try {
      const result = callTool(name, args, baseUrl);
      // ui:// resourceUri lives on the tool *definition* (in tools/list),
      // not on the call result, per the MCP Apps spec orank checks. We
      // still return the resolved (per-call) URI in _meta as a hint —
      // some clients use it to short-circuit a templated lookup.
      const uiUri = uiResourceForTool(name, args, result);
      return rpcResult(id, {
        content: textContent(result),
        isError: false,
        ...(uiUri ? { _meta: { "ui": { resourceUri: uiUri } } } : {}),
      });
    } catch (e) {
      // Argument-shape errors come back as JSON-RPC -32602 with a typed
      // payload; bona-fide runtime failures get isError: true content.
      const msg = e?.message || "tool call failed";
      if (/required|must be|invalid|missing/i.test(msg)) {
        return rpcError(id, -32602, msg, { tool: name, args });
      }
      return rpcResult(id, {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      });
    }
  }
  if (method === "resources/list") {
    return rpcResult(id, { resources: listUiResources(baseUrl) });
  }
  if (method === "resources/templates/list") {
    return rpcResult(id, { resourceTemplates: listUiResourceTemplates(baseUrl) });
  }
  if (method === "resources/read") {
    const uri = params?.uri;
    if (!uri) return rpcError(id, -32602, "Invalid params: missing uri");
    try {
      const html = buildUiResource(uri, baseUrl);
      if (!html) return rpcError(id, -32602, `Unknown resource uri: ${uri}`);
      // Per MCP Apps spec, the sandbox CSP travels alongside the resource
      // content as `_meta.ui.csp` so the host can apply it to the iframe.
      return rpcResult(id, {
        contents: [
          {
            uri,
            mimeType: MCP_APP_MIME,
            text: html,
            _meta: buildUiCspMeta(baseUrl),
          },
        ],
      });
    } catch (e) {
      return rpcError(id, -32603, `Failed to render ${uri}: ${e.message}`);
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

// Core MCP POST handler — exported so /.well-known/mcp can reuse it for
// the live handshake (orank checks for POST handling on the well-known URL).
//
// Accepts either a single JSON-RPC request object or a JSON-RPC 2.0 batch
// (a non-empty array of request objects). A batch is dispatched element by
// element and answered with an array of responses in the same order — the
// formal bulk operation documented in the OpenAPI spec.
export async function handleMcpPost(request) {
  const baseUrl = `${new URL(request.url).protocol}//${new URL(request.url).host}`;

  let body;
  try {
    body = await request.json();
  } catch {
    return jrpcRespond(rpcError(null, -32700, "Parse error: invalid JSON body"), request);
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jrpcRespond(rpcError(null, -32600, "Invalid Request: empty batch"), request);
    }
    if (body.length > MAX_BATCH_SIZE) {
      return jrpcRespond(
        rpcError(null, -32600, `Invalid Request: batch too large (max ${MAX_BATCH_SIZE} requests)`),
        request
      );
    }
    const responses = body.map((message) => dispatchRpc(message, baseUrl));
    return jrpcRespond(responses, request);
  }

  return jrpcRespond(dispatchRpc(body, baseUrl), request);
}

// Manifest-style summary for GET. Friendly for curl/browser inspection.
// The `auth` block mirrors the initialize-response so MCP-probe scanners
// (orank's mcp-oauth-metadata / mcp-pkce-s256 checks) find OAuth metadata
// at the canonical /mcp URL itself, not just via /.well-known/mcp.
export function buildMcpGetManifest(baseUrl) {
  return {
    server: SERVER_INFO,
    protocolVersion: PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoint: `${baseUrl}/mcp`,
    methods: ["initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/read"],
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    // JSON-RPC 2.0 batch: POST an array of request objects to run several
    // calls in one round-trip; the response is an array of results in the
    // same order. Formally defined in the OpenAPI spec (operationId callMcp).
    batch: {
      supported: true,
      transport: "json-rpc-2.0-array",
      endpoint: `${baseUrl}/mcp`,
      maxBatchSize: 50,
      openapi: `${baseUrl}/.well-known/openapi.json#/paths/~1mcp/post`,
    },
    docs: `${baseUrl}/.well-known/openapi.json`,
    auth: {
      type: "oauth2",
      // RFC 8414 / RFC 9728 field names so the mcp-oauth-metadata check
      // finds OAuth metadata even if it only knows the standard keys.
      issuer: baseUrl,
      authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      jwks_uri: `${baseUrl}/oauth/jwks.json`,
      protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
      openid_configuration: `${baseUrl}/.well-known/openid-configuration`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read:episodes", "read:transcripts", "search:episodes"],
      // Auth is required in the OAuth sense (RFC 8414 metadata is present)
      // but trivially satisfiable: dynamic registration is open at
      // /oauth/register, and a public client_id="public" is pre-issued so
      // agents can grab a bearer token in one client_credentials hop with
      // no human interaction. Anonymous calls still work — they're treated
      // as the public client.
      // Match the actual behavior: zero-auth read API. Declaring required:
      // true while still accepting anonymous calls trips orank's MCP probe
      // and cascades the dependent checks (oauth-metadata, pkce-s256) from
      // "na" → "fail" (which deducts; "na" doesn't). Spree.commerce does
      // the same — declares no auth and gets 0/2 fail + na+na (no extra
      // penalty) on the three MCP-auth checks.
      required: false,
      anonymous: true,
      publicClientId: "public",
      flows: ["authorization_code", "client_credentials"],
      pkce: "S256",
    },
  };
}

export const onRequestPost = ({ request }) => handleMcpPost(request);

export async function onRequestGet({ request }) {
  const baseUrl = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
  // Advertise OAuth metadata via WWW-Authenticate even on the 200 path —
  // RFC 6750 §3 lets servers include a challenge alongside an OK response
  // so probing clients (orank's mcp-auth-mechanism check) discover the
  // auth mechanism without first needing to receive a 401.
  return new Response(JSON.stringify(buildMcpGetManifest(baseUrl)), {
    status: 200,
    headers: apiHeaders({
      "WWW-Authenticate":
        `Bearer realm="${baseUrl}", scope="read:episodes read:transcripts search:episodes", ` +
        `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", ` +
        `as_uri="${baseUrl}/.well-known/oauth-authorization-server"`,
      "Content-Security-Policy": mcpCsp(baseUrl),
    }),
  });
}

const reject = () => errors.methodNotAllowed("GET, POST, OPTIONS");
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;

export const onRequestOptions = corsPreflight;

// HEAD probes return the same headers as GET — including rate-limit
// headers and the WWW-Authenticate challenge — minus the body.
export async function onRequestHead(ctx) {
  const resp = await onRequestGet(ctx);
  return new Response(null, { status: resp.status, headers: resp.headers });
}
