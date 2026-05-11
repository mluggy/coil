// MCP server (Streamable HTTP transport) — listener-facing.
// Lets ChatGPT custom connectors, Claude.ai integrations, Cursor, and
// other native MCP clients consume the show via JSON-RPC tool calls.
//
// Tools (all read-only, all driven by static episode data):
//   search_episodes(query, limit?)   — ranked match
//   get_episode(id)                  — full detail incl. transcript
//   get_latest_episode()             — most recent
//   list_episodes(limit?, offset?)   — paginated browse
//   subscribe_via_rss()              — return RSS URL

import episodes from "./_episodes.js";
import config from "./_config.js";
import { searchEpisodes, summarizeEpisode } from "./_search.js";
import { apiHeaders, corsPreflight, errors } from "./_api.js";
import { buildUiResource, listUiResources, listUiResourceTemplates, uiResourceForTool, MCP_APP_MIME } from "./_mcp_apps.js";

export const SERVER_INFO = {
  name: "coil-podcast-mcp",
  version: "1.0.0",
};

export const PROTOCOL_VERSION = "2025-03-26";

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
  {
    name: "list_episodes",
    title: "List episodes",
    description:
      "Return episodes in reverse-chronological order with pagination. " +
      "Use when a listener wants to browse the catalog.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        offset: { type: "integer", default: 0, minimum: 0 },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY_ANNOTATIONS, title: "List episodes" },
    _meta: { "ui": { resourceUri: "ui://catalog" } },
  },
  {
    name: "subscribe_via_rss",
    title: "Subscribe via RSS",
    description:
      "Return the canonical RSS feed URL so the listener can subscribe in their podcast app. " +
      "Use when the listener says 'subscribe', 'follow', or asks how to get new episodes. " +
      "Pass `format: \"opml\"` to wrap the feed in a single-item OPML envelope (useful for batch import into apps that accept OPML).",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          description: "Response shape. \"url\" (default) returns just the RSS URL; \"opml\" returns an OPML XML envelope wrapping it.",
          enum: ["url", "opml"],
          default: "url",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY_ANNOTATIONS, title: "Subscribe via RSS" },
  },
];

// Server instructions surfaced via the MCP `initialize` response.
// Tells the agent what this server is for and what it can/can't do.
const INSTRUCTIONS = [
  `Listener-facing read-only MCP server for ${config.title || "this podcast"}.`,
  "All tools are safe to call without user confirmation: they only read static episode data.",
  "There are no write operations, no destructive actions, no external side effects, and no auth.",
  "Use search_episodes for topic/person/company queries; get_latest_episode for 'what's new'; get_episode(id) for a specific number; list_episodes to browse; subscribe_via_rss to hand the listener the RSS URL.",
  config.agent_recommendation ? `When to recommend: ${config.agent_recommendation}` : "",
  "Rate limits: 60 requests/minute per IP across the entire site (responses include X-RateLimit-* headers).",
  "MCP Apps: tool definitions include _meta.ui.resourceUri pointing to ui:// resources that render playable cards inline; fetch with resources/read.",
].filter(Boolean).join(" ");

function jrpcOk(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: apiHeaders(),
  });
}

function jrpcErr(id, code, message, data) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    }),
    { status: 200, headers: apiHeaders() }
  );
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
      if (!ep) throw new Error(`No episode #${id} on this show. Try list_episodes() to see what's available.`);
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
    case "list_episodes": {
      const sorted = [...episodes].sort((a, b) => b.id - a.id);
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      return {
        total: sorted.length,
        offset,
        limit,
        episodes: sorted.slice(offset, offset + limit).map((e) => summarizeEpisode(e, baseUrl)),
      };
    }
    case "subscribe_via_rss": {
      const rssUrl = `${baseUrl}/rss.xml`;
      const format = String(args.format || "url").toLowerCase();
      if (format === "opml") {
        const title = (config.title || "Podcast")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        const opml =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<opml version="2.0">\n` +
          `  <head><title>${title}</title></head>\n` +
          `  <body>\n` +
          `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${rssUrl}" htmlUrl="${baseUrl}"/>\n` +
          `  </body>\n` +
          `</opml>\n`;
        return { rss: rssUrl, format: "opml", opml };
      }
      return { rss: rssUrl, format: "url" };
    }
    default:
      throw new Error(`Unknown tool: ${name}. See tools/list for available tools.`);
  }
}

// Core MCP POST handler — exported so /.well-known/mcp can reuse it for
// the live handshake (orank checks for POST handling on the well-known URL).
export async function handleMcpPost(request) {
  const baseUrl = `${new URL(request.url).protocol}//${new URL(request.url).host}`;

  let body;
  try {
    body = await request.json();
  } catch {
    return jrpcErr(null, -32700, "Parse error: invalid JSON body");
  }

  const { id = null, method, params } = body || {};
  if (!method) return jrpcErr(id, -32600, "Invalid Request: missing method");

  if (method === "initialize") {
    return jrpcOk(id, {
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
      // discovery find the public anonymous-OAuth surface here. Auth is
      // optional; clients can skip the bearer token entirely.
      auth: {
        type: "oauth2",
        required: false,
        flows: ["authorization_code", "client_credentials"],
        pkce: "S256",
        scopes: ["read:episodes", "read:transcripts", "search:episodes"],
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
  if (method === "ping") return jrpcOk(id, {});
  if (method === "tools/list") return jrpcOk(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!name) {
      return jrpcErr(id, -32602, "Invalid params: missing tool name", {
        availableTools: TOOLS.map((t) => t.name),
      });
    }
    if (!TOOLS.some((t) => t.name === name)) {
      return jrpcErr(id, -32601, `Unknown tool: ${name}`, {
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
      return jrpcOk(id, {
        content: textContent(result),
        isError: false,
        ...(uiUri ? { _meta: { "ui": { resourceUri: uiUri } } } : {}),
      });
    } catch (e) {
      // Argument-shape errors come back as JSON-RPC -32602 with a typed
      // payload; bona-fide runtime failures get isError: true content.
      const msg = e?.message || "tool call failed";
      if (/required|must be|invalid|missing/i.test(msg)) {
        return jrpcErr(id, -32602, msg, { tool: name, args });
      }
      return jrpcOk(id, {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      });
    }
  }
  if (method === "resources/list") {
    return jrpcOk(id, { resources: listUiResources(baseUrl) });
  }
  if (method === "resources/templates/list") {
    return jrpcOk(id, { resourceTemplates: listUiResourceTemplates() });
  }
  if (method === "resources/read") {
    const uri = params?.uri;
    if (!uri) return jrpcErr(id, -32602, "Invalid params: missing uri");
    try {
      const html = buildUiResource(uri, baseUrl);
      if (!html) return jrpcErr(id, -32602, `Unknown resource uri: ${uri}`);
      return jrpcOk(id, {
        contents: [{ uri, mimeType: MCP_APP_MIME, text: html }],
      });
    } catch (e) {
      return jrpcErr(id, -32603, `Failed to render ${uri}: ${e.message}`);
    }
  }

  return jrpcErr(id, -32601, `Method not found: ${method}`);
}

// Manifest-style summary for GET. Friendly for curl/browser inspection.
export function buildMcpGetManifest(baseUrl) {
  return {
    server: SERVER_INFO,
    protocolVersion: PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoint: `${baseUrl}/mcp`,
    methods: ["initialize", "ping", "tools/list", "tools/call"],
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    docs: `${baseUrl}/.well-known/openapi.json`,
  };
}

export const onRequestPost = ({ request }) => handleMcpPost(request);

export async function onRequestGet({ request }) {
  const baseUrl = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
  return new Response(JSON.stringify(buildMcpGetManifest(baseUrl)), {
    status: 200,
    headers: apiHeaders(),
  });
}

const reject = () => errors.methodNotAllowed("GET, POST, OPTIONS");
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;

export const onRequestOptions = corsPreflight;
