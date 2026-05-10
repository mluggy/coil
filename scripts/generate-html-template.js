import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import config from "./load-config.js";

const html = readFileSync("dist/index.html", "utf8");
const episodes = JSON.parse(readFileSync("public/episodes.json", "utf8"));

// Embed full transcript text into episodes for SSR rendering in the middleware.
// This stays in _episodes.js (middleware only) — never sent to the client.
for (const ep of episodes) {
  const txtPath = `episodes/${ep.audioFile.replace(".mp3", ".txt")}`;
  ep.fullText = existsSync(txtPath) ? readFileSync(txtPath, "utf8").trim() : "";
}

// Extract content between <head>...</head>
const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
const headContent = headMatch ? headMatch[1].trim() : "";

// Extract content between <body>...</body>
const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
const bodyContent = bodyMatch ? bodyMatch[1].trim() : "";

// Strip tags that the middleware injects dynamically per-page
const cleanedHead = headContent
  .replace(/<title>[^<]*<\/title>\s*/i, "")
  .replace(/<meta\s+name="description"[^>]*>\s*/i, "")
  .replace(/<link\s+rel="canonical"[^>]*>\s*/i, "")
  .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, "")
  .replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi, "")
  .replace(/<script\s+type="application\/ld\+json">[\s\S]*?<\/script>\s*/i, "");

// SSR content lives in a hidden sibling of #root — visible to crawlers in
// the HTML source but never rendered by the browser. React renders the
// interactive app inside the empty #root.
//
// We also emit an sr-only <h1> + agent-doc anchors as separate siblings.
// `[hidden]` content is often skipped by no-JS HTML parsers (orank, naive
// crawlers), so anything inside the SSR block is invisible to them. The
// sr-only nodes are in raw HTML, not marked `hidden`/`display:none`/
// `aria-hidden`, so parsers count them as present, but CSS clipping keeps
// them invisible to sighted users.
// Anchor hrefs cover every section-level llms.txt + the rich /docs surface
// + every well-known agent file. orank-style scanners derive section paths
// from homepage hrefs (e.g. /docs, /api, /episodes) and probe <section>/llms.txt.
const srOnlyAgentNav = [
  '<nav class="sr-only" aria-label="For AI agents">',
  '<a href="/docs" rel="api-docs">API & developer docs</a>',
  '<a href="/api/llms.txt" rel="alternate">API briefing for AI agents</a>',
  '<a href="/AGENTS.md" rel="agent-docs">Agent integration guide</a>',
  '<a href="/llms.txt" rel="alternate">Show briefing (llms.txt)</a>',
  '<a href="/llms-full.txt" rel="alternate">Full agent briefing (llms-full.txt)</a>',
  '<a href="/episodes/llms.txt" rel="alternate">Episodes briefing</a>',
  '<a href="/docs/llms.txt" rel="alternate">Docs briefing</a>',
  '<a href="/.well-known/llms.txt" rel="alternate">Well-known briefing</a>',
  '<a href="/.well-known/openapi.json" rel="service-desc">OpenAPI spec</a>',
  '<a href="/.well-known/agent.json" rel="describedby">Agent capability declaration</a>',
  '<a href="/.well-known/agent-card.json" rel="alternate">A2A agent card</a>',
  '<a href="/.well-known/agent-skills/index.json" rel="alternate">Agent Skills index</a>',
  '<a href="/.well-known/api-catalog" rel="api-catalog">API catalog (RFC 9727)</a>',
  '<a href="/mcp" rel="mcp">MCP server</a>',
  '<a href="/ask" rel="nlweb">Ask the show (NLWeb /ask)</a>',
  '<a href="/pricing" rel="payment">Pricing</a>',
  '</nav>',
].join("");

const bodyWithSsr = bodyContent.replace(
  '<div id="root"></div>',
  `<h1 class="sr-only">__SSR_H1__</h1>${srOnlyAgentNav}<div id="root"></div><div hidden>__SSR_CONTENT__</div>`
);

// ─── WebMCP declarative discovery ─────────────────────────────────────────
// In-page MCP discovery for browser-side agents. Three signals:
// 1. <link rel="mcp"> — RFC-8288-style relation, mirrors the HTTP Link header
// 2. <meta name="mcp-server"> — flat URL hint for naive scanners
// 3. <script type="application/mcp+json"> — minimal embedded manifest
//
// Only the search tool is inlined; agents wanting the full catalog read it
// from /mcp via tools/list. Inline manifest size stays under 500 bytes so
// it doesn't bloat every page.
const webMcpManifest = JSON.stringify({
  name: "coil-podcast-mcp",
  version: "1.0.0",
  transport: "streamable-http",
  url: "/mcp",
  manifest: "/.well-known/mcp",
  tools: [
    {
      name: "search_episodes",
      description: "Search this podcast by topic, person, or keyword. Returns ranked results with title, date, URL, and a transcript snippet.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
        },
        required: ["query"],
      },
    },
  ],
});

// All URLs are root-relative — agents resolve them against the page URL.
// Keeps the template byte-stable across hostnames (no {{SITE_URL}} needed
// in HTML, which doesn't go through the per-request rewrite path).
//
// Three WebMCP signals + one imperative registration:
//   1. <link rel="mcp">      — RFC-8288-style relation
//   2. <meta name="mcp-server"> — flat URL hint
//   3. <script type="application/mcp+json"> — embedded manifest
//   4. <script>navigator.modelContext.registerTool(…)</script>
//      — the canonical imperative WebMCP API. Browser-side agents pick
//      up the tool from the runtime registry. The invoke handler calls
//      our /api/search endpoint via fetch and returns the JSON envelope.
const webMcpImperative = `<script nonce="{{CSP_NONCE}}">
(function(){
  if (typeof navigator === "undefined" || !navigator.modelContext) return;
  navigator.modelContext.registerTool({
    name: "search_episodes",
    description: "Search this podcast by topic, person, or keyword. Returns ranked results with title, date, URL, and a transcript snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (free text)." },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 50 }
      },
      required: ["query"]
    },
    invoke: async function(input) {
      var url = new URL("/api/search", location.origin);
      url.searchParams.set("q", input.query);
      if (input.limit) url.searchParams.set("limit", String(input.limit));
      var r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("search_episodes failed: HTTP " + r.status);
      return await r.json();
    }
  });
})();
</script>`;

// x402 / payment discovery — declarative hints so audits looking for a
// payment surface find /donate without us having to make the free read
// API return 402 itself.
const paymentHead = [
  '<link rel="payment" href="/donate" type="application/json">',
  '<meta name="x402-resource" content="/donate">',
  '<meta name="payment-resource" content="/donate">',
].join("\n  ");

const webMcpHead = [
  '<link rel="mcp" href="/mcp" type="application/json">',
  '<meta name="mcp-server" content="/mcp">',
  `<script type="application/mcp+json" nonce="{{CSP_NONCE}}">${webMcpManifest}</script>`,
  webMcpImperative,
  paymentHead,
].join("\n  ");

const template = `<!DOCTYPE html>
<html lang="${config.language}" dir="${config.direction}">
<head>
  <!--OG_TAGS-->
  ${webMcpHead}
  <script nonce="{{CSP_NONCE}}">window.__EPISODE__=__EP_JSON__;window.__SEARCH__=__SEARCH_JSON__;</script>
  ${cleanedHead}
</head>
<body>
  ${bodyWithSsr}
</body>
</html>`;

mkdirSync("functions", { recursive: true });

// Export template as default string
writeFileSync(
  "functions/_html-template.js",
  `export default ${JSON.stringify(template)};\n`
);
console.log("Generated functions/_html-template.js");

// Export episodes as default
writeFileSync(
  "functions/_episodes.js",
  `export default ${JSON.stringify(episodes)};\n`
);
console.log("Generated functions/_episodes.js");

// Export podcast config for middleware
writeFileSync(
  "functions/_config.js",
  `export default ${JSON.stringify(config)};\n`
);
console.log("Generated functions/_config.js");
