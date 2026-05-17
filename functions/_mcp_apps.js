// MCP Apps — ui:// resources for the listener-facing MCP server.
// Returns themed HTML cards (cover art, audio player, description,
// subscribe links) so MCP clients that support MCP Apps can render
// playable episode cards inline instead of dumping raw JSON.
//
// Theme is pulled from the show's podcast.yaml: accent_color, bg_dark,
// bg_light, default_theme. Cards work in both light and dark surfaces
// via prefers-color-scheme media queries.
//
// Each resource is a full HTML5 document (DOCTYPE + color-scheme meta)
// served with `text/html;profile=mcp-app` per the MCP Apps spec.

import episodes from "./_episodes.js";
import config from "./_config.js";
import { searchEpisodes, summarizeEpisode } from "./_search.js";

export const MCP_APP_MIME = "text/html;profile=mcp-app";

const ACCENT = config.accent_color || "#ff4d00";
const BG_DARK = config.bg_dark || "#0a0a0b";
const BG_LIGHT = config.bg_light || "#fafaf9";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Content-Security-Policy for the MCP App document. MCP clients render
// these cards inside a sandboxed iframe, so the policy ships as a
// <meta http-equiv> — there is no HTTP response of our own to carry a
// header. Scoped per agent-readiness audits: no `*`, no permissive
// default-src. The show's own origin is listed explicitly because a
// srcdoc iframe has an opaque origin, so `'self'` alone would not match
// the cover-art / audio URLs. GA origins mirror the main-site CSP and
// appear only when the show configures a measurement id.
function buildAppCsp(baseUrl) {
  const origin = baseUrl || "";
  const scriptSrc = ["'self'"];
  const connectSrc = ["'self'", origin].filter(Boolean);
  const imgSrc = ["'self'", origin, "data:"].filter(Boolean);
  const mediaSrc = ["'self'", origin].filter(Boolean);
  if (config.ga_measurement_id) {
    scriptSrc.push("https://*.googletagmanager.com");
    connectSrc.push(
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://*.googletagmanager.com"
    );
    imgSrc.push("https://*.google-analytics.com", "https://*.googletagmanager.com");
  }
  return [
    "default-src 'none'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'unsafe-inline'",
    `img-src ${imgSrc.join(" ")}`,
    `media-src ${mediaSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' https://chatgpt.com https://claude.ai",
  ].join("; ");
}

// Wrap card body in a complete HTML5 document. MCP clients render this
// in an iframe / sandboxed surface — the DOCTYPE, viewport, and
// color-scheme meta are required for reliable rendering across light
// and dark themes; the CSP meta scopes the sandbox.
function wrapDocument(title, body, baseUrl) {
  return `<!DOCTYPE html>
<html lang="${esc(config.language || "en")}" dir="${esc(config.direction || "ltr")}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(buildAppCsp(baseUrl))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${styles()}
</head>
<body>
${body}
</body>
</html>`;
}

// Common stylesheet — prefers-color-scheme aware, sized for inline render.
function styles() {
  return `
<style>
  .coil-card {
    font-family: system-ui, -apple-system, sans-serif;
    color: ${BG_DARK === "#0a0a0b" ? "#eae8e4" : "#1a1a1d"};
    background: ${BG_DARK};
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 16px;
    max-width: 540px;
    margin: 8px 0;
    box-sizing: border-box;
  }
  @media (prefers-color-scheme: light) {
    .coil-card { background: ${BG_LIGHT}; color: #1a1a1d; border-color: rgba(0,0,0,0.08); }
  }
  .coil-card h3, .coil-card h2 { margin: 0 0 8px 0; font-size: 18px; line-height: 1.3; }
  .coil-card .meta { font-size: 13px; opacity: 0.7; margin: 4px 0 12px; }
  .coil-card .desc { font-size: 14px; line-height: 1.5; margin: 0 0 12px; }
  .coil-card audio { width: 100%; margin: 8px 0; }
  .coil-card .links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .coil-card .links a {
    text-decoration: none;
    background: ${ACCENT};
    color: #fff;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
  }
  .coil-card .links a.secondary {
    background: transparent;
    color: ${ACCENT};
    border: 1px solid ${ACCENT};
  }
  .coil-card img.cover {
    width: 100%; height: auto; max-width: 200px; float: right;
    margin: 0 0 8px 12px; border-radius: 8px; display: block;
  }
  .coil-list { list-style: none; padding: 0; margin: 0; }
  .coil-list li { padding: 10px 0; border-bottom: 1px solid rgba(127,127,127,0.18); }
  .coil-list li:last-child { border-bottom: 0; }
  .coil-list .title { font-weight: 600; font-size: 15px; line-height: 1.3; }
  .coil-list .snippet { font-size: 13px; opacity: 0.75; margin-top: 4px; line-height: 1.4; }
  .coil-empty { font-size: 14px; opacity: 0.7; padding: 8px 0; }
</style>`;
}

function transcriptUrl(ep, baseUrl) {
  return ep.audioFile ? `${baseUrl}/${ep.audioFile.replace(".mp3", ".txt")}` : null;
}

function audioUrl(ep, baseUrl) {
  return `${baseUrl}/${ep.audioFile}`;
}

function coverUrl(ep, baseUrl) {
  return `${baseUrl}/s${ep.season}e${ep.id}.${config.cover_ext || "png"}`;
}

// Render a single episode card — cover, title, audio control, description,
// and listener-facing subscribe links.
function episodeCard(ep, baseUrl) {
  const meta = [ep.date, `S${ep.season}E${ep.id}`, ep.duration].filter(Boolean).join(" · ");
  const subscribeLinks = [
    [config.spotify_url, "Spotify"],
    [config.apple_podcasts_url, "Apple Podcasts"],
    [config.youtube_url, "YouTube"],
    [config.amazon_music_url, "Amazon"],
  ].filter(([u]) => u);

  return `
<div class="coil-card">
<img class="cover" src="${esc(coverUrl(ep, baseUrl))}" alt="${esc(ep.title)} cover" />
  <h3>${esc(ep.title)}</h3>
  <div class="meta">${esc(meta)}</div>
  ${ep.desc ? `<p class="desc">${esc(ep.desc)}</p>` : ""}
  <audio controls preload="none" src="${esc(audioUrl(ep, baseUrl))}"></audio>
  <div class="links">
    <a href="${esc(`${baseUrl}/${ep.id}`)}" target="_blank">Open episode</a>
    ${ep.hasSrt ? `<a class="secondary" href="${esc(transcriptUrl(ep, baseUrl))}" target="_blank">Transcript</a>` : ""}
    <a class="secondary" href="${esc(`${baseUrl}/rss.xml`)}" target="_blank">Subscribe (RSS)</a>
    ${subscribeLinks.map(([u, n]) => `<a class="secondary" href="${esc(u)}" target="_blank">${esc(n)}</a>`).join("")}
  </div>
</div>`.trim();
}

function searchResultsCard(query, results, baseUrl) {
  if (!results.length) {
    return `<div class="coil-card"><h3>No matches for "${esc(query)}"</h3><p class="coil-empty">Try a broader search, or browse the catalog at <a href="${esc(`${baseUrl}/episodes/llms.txt`)}" target="_blank" style="color:${ACCENT}">/episodes/llms.txt</a>.</p></div>`;
  }
  const items = results.map((r) => `
    <li>
      <div class="title"><a href="${esc(r.url)}" target="_blank" style="color:inherit;text-decoration:none">${esc(r.title)}</a></div>
      <div class="meta" style="font-size:12px;opacity:0.65">${esc([r.date, `S${r.season}E${r.id}`, r.duration].filter(Boolean).join(" · "))}</div>
      ${r.snippet ? `<div class="snippet">${esc(r.snippet)}</div>` : ""}
    </li>`).join("");
  return `
<div class="coil-card">
<h3>${results.length} result${results.length === 1 ? "" : "s"} for "${esc(query)}"</h3>
  <ul class="coil-list">${items}</ul>
  <div class="links" style="margin-top:14px">
    <a class="secondary" href="${esc(`${baseUrl}/api/search?q=${encodeURIComponent(query)}`)}" target="_blank">Open full search</a>
  </div>
</div>`.trim();
}

function catalogCard(baseUrl, limit = 12) {
  const sorted = [...episodes].sort((a, b) => b.id - a.id).slice(0, limit);
  if (!sorted.length) {
    return `<div class="coil-card"><h3>${esc(config.title)}</h3><p class="coil-empty">No episodes published yet.</p></div>`;
  }
  const items = sorted.map((ep) => `
    <li>
      <div class="title"><a href="${esc(`${baseUrl}/${ep.id}`)}" target="_blank" style="color:inherit;text-decoration:none">${esc(ep.title)}</a></div>
      <div class="meta" style="font-size:12px;opacity:0.65">${esc([ep.date, `S${ep.season}E${ep.id}`, ep.duration].filter(Boolean).join(" · "))}</div>
      ${ep.desc ? `<div class="snippet">${esc(ep.desc.slice(0, 160))}${ep.desc.length > 160 ? "…" : ""}</div>` : ""}
    </li>`).join("");
  return `
<div class="coil-card">
<h3>${esc(config.title)} — recent episodes</h3>
  <ul class="coil-list">${items}</ul>
  <div class="links" style="margin-top:14px">
    <a href="${esc(baseUrl)}" target="_blank">Browse all</a>
    <a class="secondary" href="${esc(`${baseUrl}/rss.xml`)}" target="_blank">Subscribe (RSS)</a>
  </div>
</div>`.trim();
}

// ─── MCP method implementations ─────────────────────────────────────────
export function listUiResources(/* baseUrl */) {
  // Concrete (non-template) ui:// resources.
  return [
    {
      uri: "ui://latest_episode",
      name: "Latest episode card",
      description: "A playable card with cover, title, audio control, and subscribe links for the most recent episode.",
      mimeType: MCP_APP_MIME,
    },
    {
      uri: "ui://catalog",
      name: "Episode catalog card",
      description: "A list of recent episodes with titles, dates, and short descriptions.",
      mimeType: MCP_APP_MIME,
    },
  ];
}

export function listUiResourceTemplates() {
  return [
    {
      uriTemplate: "ui://episode/{id}",
      name: "Episode card by id",
      description: "Playable card for a specific episode.",
      mimeType: MCP_APP_MIME,
    },
    {
      uriTemplate: "ui://search?q={query}&limit={limit}",
      name: "Search results card",
      description: "Themed list of episode matches for a search query.",
      mimeType: MCP_APP_MIME,
    },
  ];
}

// Resolve a ui:// URI to a complete HTML5 document. Returns null for
// unknown URIs (caller turns that into an MCP error).
export function buildUiResource(uri, baseUrl) {
  if (typeof uri !== "string" || !uri.startsWith("ui://")) return null;

  const sorted = [...episodes].sort((a, b) => b.id - a.id);

  if (uri === "ui://latest_episode") {
    const ep = sorted[0];
    if (!ep) return wrapDocument(config.title, `<div class="coil-card"><h3>${esc(config.title)}</h3><p class="coil-empty">No episodes yet.</p></div>`, baseUrl);
    return wrapDocument(`${ep.title} — ${config.title}`, episodeCard(ep, baseUrl), baseUrl);
  }

  if (uri === "ui://catalog") {
    return wrapDocument(`${config.title} — recent episodes`, catalogCard(baseUrl), baseUrl);
  }

  const epMatch = uri.match(/^ui:\/\/episode\/(\d{1,4})$/);
  if (epMatch) {
    const id = parseInt(epMatch[1], 10);
    const ep = episodes.find((e) => e.id === id);
    if (!ep) return wrapDocument(`Episode #${id} not found`, `<div class="coil-card"><h3>Episode #${id} not found</h3><p class="coil-empty">Try the catalog at <a href="${esc(baseUrl)}" target="_blank" style="color:${ACCENT}">${esc(baseUrl)}</a>.</p></div>`, baseUrl);
    return wrapDocument(`${ep.title} — ${config.title}`, episodeCard(ep, baseUrl), baseUrl);
  }

  if (uri.startsWith("ui://search")) {
    const qs = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const query = (params.get("q") || params.get("query") || "").trim();
    const limit = Math.min(20, Math.max(1, parseInt(params.get("limit") || "5", 10) || 5));
    if (!query) return wrapDocument("Search", `<div class="coil-card"><h3>Search</h3><p class="coil-empty">Pass a query: ui://search?q=&lt;your+question&gt;</p></div>`, baseUrl);
    const { results } = searchEpisodes(query, { limit, baseUrl });
    return wrapDocument(`Search: ${query}`, searchResultsCard(query, results, baseUrl), baseUrl);
  }

  return null;
}

// Tool → ui:// URI mapping. Returns the relevant resource URI for a tool
// invocation so agents can render an inline card alongside the JSON.
export function uiResourceForTool(name, args, _result) {
  switch (name) {
    case "search_episodes": {
      const q = String(args?.query || "").trim();
      const limit = Math.min(20, Math.max(1, Number(args?.limit) || 5));
      if (!q) return null;
      return `ui://search?q=${encodeURIComponent(q)}&limit=${limit}`;
    }
    case "get_episode": {
      const id = Number(args?.id);
      if (!Number.isInteger(id)) return null;
      return `ui://episode/${id}`;
    }
    case "get_latest_episode":
      return "ui://latest_episode";
    case "list_episodes":
      return "ui://catalog";
    default:
      return null;
  }
}
