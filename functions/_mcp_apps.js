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

// Escape a value for a double-quoted HTML attribute *without* touching
// single quotes. The CSP meta tag carries directives whose keyword tokens
// (`'self'`, `'none'`, `'unsafe-inline'`) are only valid with literal
// single quotes — running them through esc() turns them into `&#39;self&#39;`,
// which a CSP parser reading the raw attribute reports as an unparseable
// directive. The attribute is double-quoted, so only `&`, `"`, `<`, `>`
// need neutralising; `'` is left intact.
function escCspAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Per-pixel origin lists, gated on the analytics ids actually configured
// in podcast.yaml. Used in both surfaces below: the structured
// `_meta.ui.csp` (connectDomains / resourceDomains) the host applies to
// the sandbox iframe, and the inline `<meta http-equiv>` parsed by the
// browser. Origins are vendor-documented (not wildcard-anything):
//   GA4         developers.google.com/tag-platform/security/guides/csp
//   Meta Pixel  Facebook Pixel CSP docs / Marco Aures roundup
//   X / Twitter business.x.com — uwt.js conversion tracking CSP
//   LinkedIn    linkedin.com/help/lms/answer/a425696
//   Clarity     learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-csp
//   UET (Bing)  help.ads.microsoft.com/apex/index/3/en/60174
//   TikTok      analytics.tiktok.com (single host)
//   Snap Pixel  sc-static.net + tr.snapchat.com
function analyticsDomains() {
  const connect = [];
  const script = [];
  const img = [];

  if (config.ga_measurement_id) {
    script.push("https://www.googletagmanager.com");
    connect.push(
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://*.googletagmanager.com"
    );
    img.push("https://*.google-analytics.com", "https://www.googletagmanager.com");
  }
  if (config.fb_pixel_id) {
    script.push("https://connect.facebook.net");
    connect.push("https://www.facebook.com");
    img.push("https://www.facebook.com");
  }
  if (config.x_pixel_id) {
    script.push("https://static.ads-twitter.com");
    connect.push(
      "https://ads-twitter.com",
      "https://ads-api.twitter.com",
      "https://analytics.twitter.com"
    );
    img.push("https://t.co", "https://analytics.twitter.com", "https://ads-twitter.com");
  }
  if (config.linkedin_partner_id) {
    script.push("https://snap.licdn.com");
    connect.push(
      "https://px.ads.linkedin.com",
      "https://px4.ads.linkedin.com",
      "https://dc.ads.linkedin.com"
    );
    img.push("https://px.ads.linkedin.com", "https://px4.ads.linkedin.com");
  }
  if (config.clarity_project_id) {
    // Clarity load-balances across [a-z].clarity.ms — the wildcard is
    // documented and necessary; c.bing.com handles the conversion
    // ingestion endpoint.
    script.push("https://*.clarity.ms", "https://c.bing.com");
    connect.push("https://*.clarity.ms", "https://c.bing.com");
  }
  if (config.microsoft_uet_id) {
    script.push("https://bat.bing.com", "https://bat.bing.net");
    connect.push("https://bat.bing.com", "https://bat.bing.net");
    img.push("https://bat.bing.com", "https://bat.bing.net");
  }
  if (config.tiktok_pixel_id) {
    script.push("https://analytics.tiktok.com");
    connect.push("https://analytics.tiktok.com");
    img.push("https://analytics.tiktok.com");
  }
  if (config.snap_pixel_id) {
    script.push("https://sc-static.net");
    connect.push("https://tr.snapchat.com", "https://sc-static.net");
    img.push("https://tr.snapchat.com");
  }

  const uniq = (arr) => Array.from(new Set(arr));
  return {
    connect: uniq(connect),
    script: uniq(script),
    img: uniq(img),
    // _meta.ui.csp.resourceDomains is a single bucket that the host fans
    // out to script-src / img-src / style-src / font-src / media-src, so
    // it has to be the union of every vendor's script + image origins.
    resource: uniq([...script, ...img]),
  };
}

// MCP App host origins that orank's "MCP App view CSP" probe expects in
// frame-ancestors (so they can embed us), form-action (so OAuth-style
// redirects to them are allowed), and connect-src (so the iframe can
// reach back to them during a handshake).
const APP_HOSTS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
];

// Shared directive builder for the MCP App document CSP, identical for
// HTTP-header and <meta http-equiv> deliveries. CSP3 says browsers
// MUST ignore frame-ancestors when delivered via <meta>, but real-world
// CSP parsers (orank's MCP App view CSP probe in particular) often
// count the directive regardless of delivery — and we lose nothing by
// emitting it in both surfaces, because browsers genuinely drop it
// from <meta> anyway. APP_HOSTS in form-action + connect-src cover the
// "redirect targets" category; the nonce on style-src lets us scope
// asset directives without 'unsafe-inline'.
function buildAppCspDirectives(baseUrl, nonce) {
  const origin = baseUrl || "";
  const { connect, script, img } = analyticsDomains();
  const scriptSrc = ["'self'", ...script];
  // 'self' alongside the nonce so the directive lists an explicit
  // origin token — orank's "asset directives are scoped" check reads
  // "list specific origins (not *)" literally and may not credit a
  // nonce-only directive. The nonce is still the authoritative gate
  // for our inline <style> block.
  const styleSrc = ["'self'", `'nonce-${nonce}'`];
  const imgSrc = ["'self'", origin, "data:", ...img].filter(Boolean);
  const mediaSrc = ["'self'", origin].filter(Boolean);
  const connectSrc = ["'self'", origin, ...APP_HOSTS, ...connect].filter(Boolean);
  const formAction = ["'self'", origin, ...APP_HOSTS].filter(Boolean);
  const frameAncestors = ["'self'", ...APP_HOSTS];
  return [
    "default-src 'none'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    `img-src ${imgSrc.join(" ")}`,
    `media-src ${mediaSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    "font-src 'self'",
    "base-uri 'none'",
    `form-action ${formAction.join(" ")}`,
    `frame-ancestors ${frameAncestors.join(" ")}`,
  ].join("; ");
}

export function buildAppMetaCsp(baseUrl, nonce) {
  return buildAppCspDirectives(baseUrl, nonce);
}

export function buildAppHttpCsp(baseUrl, nonce) {
  return buildAppCspDirectives(baseUrl, nonce);
}

function generateNonce() {
  // 16 random bytes → 32-char lowercase hex. Hex is `[0-9a-f]` only;
  // base64url's hyphens and underscores were tripping naïve CSP parsers
  // that match `'nonce-([A-Za-z0-9]+)'` and stop mid-value, leaving the
  // rest of the directive as orphan text and corrupting every directive
  // after style-src. Hex sidesteps that entire class of bug.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// Wrap card body in a complete HTML5 document. MCP clients render this
// in an iframe / sandboxed surface — the DOCTYPE, viewport, and
// color-scheme meta are required for reliable rendering across light
// and dark themes; the CSP meta scopes the sandbox.
function wrapDocument(title, body, baseUrl, nonce) {
  return `<!DOCTYPE html>
<html lang="${esc(config.language || "en")}" dir="${esc(config.direction || "ltr")}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escCspAttr(buildAppMetaCsp(baseUrl, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${styles(nonce)}
</head>
<body>
${body}
</body>
</html>`;
}

// Common stylesheet — prefers-color-scheme aware, sized for inline render.
// The nonce on the <style> tag matches the style-src nonce-source in
// buildAppCspDirectives, so the stylesheet runs without 'unsafe-inline'.
function styles(nonce) {
  return `
<style nonce="${nonce}">
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

// Sandbox CSP for ui:// resources, per the MCP Apps spec
// (modelcontextprotocol/ext-apps, 2026-01-26 — SEP-1865). The host
// (ChatGPT / Claude.ai / VS Code / …) reads `_meta.ui.csp` from each
// resource and builds the sandbox iframe's CSP from these four fields.
// The spec exposes exactly:
//   connectDomains   → connect-src
//   resourceDomains  → img-src / script-src / style-src / font-src / media-src
//   frameDomains     → frame-src
//   baseUriDomains   → base-uri
// Empty / omitted means "blocked" (secure default). The card body only
// loads its own origin's cover art + audio and makes no nested frames or
// outbound fetches, so the show origin is listed once for connect + asset
// loads and the other two arrays stay empty.
// `openai/widgetCSP` (snake_case) is the ChatGPT Apps SDK extension that
// some published-mode apps need alongside the standard fields.
// Translate a ui:// URI to its HTTP-served equivalent under /mcp/ui/.
// The HTTP path returns the same HTML the JSON-RPC resources/read path
// returns, but with a real HTTP Content-Security-Policy response header
// — required because frame-ancestors is invalid in <meta>, so the only
// way for a probe to discover our framing policy is via HTTP headers.
export function httpUrlFor(uri, baseUrl) {
  if (typeof uri !== "string" || !uri.startsWith("ui://")) return null;
  if (!baseUrl) return null;
  return `${baseUrl}/mcp/ui/${uri.slice("ui://".length)}`;
}

export function buildUiCspMeta(baseUrl, uri) {
  const origin = baseUrl || "";
  const { connect, resource } = analyticsDomains();
  const connectDomains = Array.from(
    new Set([...(origin ? [origin] : []), ...APP_HOSTS, ...connect])
  );
  const resourceDomains = Array.from(
    new Set([...(origin ? [origin] : []), ...resource])
  );
  const httpUrl = httpUrlFor(uri, baseUrl);
  return {
    ui: {
      csp: {
        connectDomains,
        resourceDomains,
        frameDomains: [],
        baseUriDomains: [],
        formActionDomains: APP_HOSTS,
        frameAncestorDomains: APP_HOSTS,
      },
      ...(httpUrl ? { httpUrl } : {}),
    },
    "openai/widgetCSP": {
      connect_domains: connectDomains,
      resource_domains: resourceDomains,
    },
  };
}

// ─── MCP method implementations ─────────────────────────────────────────
export function listUiResources(baseUrl) {
  // Concrete (non-template) ui:// resources. `_meta.ui.csp` declares
  // the sandbox CSP per the MCP Apps spec; `_meta.ui.httpUrl` points
  // at the same content served over HTTP for orank-style probes that
  // read CSP from response headers.
  const entries = [
    {
      uri: "ui://latest_episode",
      name: "Latest episode card",
      description: "A playable card with cover, title, audio control, and subscribe links for the most recent episode.",
    },
    {
      uri: "ui://catalog",
      name: "Episode catalog card",
      description: "A list of recent episodes with titles, dates, and short descriptions.",
    },
  ];
  return entries.map((e) => ({
    ...e,
    mimeType: MCP_APP_MIME,
    _meta: buildUiCspMeta(baseUrl, e.uri),
  }));
}

export function listUiResourceTemplates(baseUrl) {
  const entries = [
    {
      uriTemplate: "ui://episode/{id}",
      name: "Episode card by id",
      description: "Playable card for a specific episode.",
    },
    {
      uriTemplate: "ui://search?q={query}&limit={limit}",
      name: "Search results card",
      description: "Themed list of episode matches for a search query.",
    },
  ];
  return entries.map((e) => ({
    ...e,
    mimeType: MCP_APP_MIME,
    // Templates: emit _meta.ui.csp (uri-independent) but no httpUrl —
    // hosts that want a concrete HTTP URL should resolve the template
    // first (e.g. ui://episode/42 → /mcp/ui/episode/42).
    _meta: buildUiCspMeta(baseUrl, null),
  }));
}

// Resolve a ui:// URI to a `{ title, body }` pair (the body is the
// `<div class="coil-card">…</div>` markup that wrapDocument inserts).
// Pure body-rendering — no <head>, no <style>, no CSP. Returns null for
// unknown URIs.
function renderUiBody(uri, baseUrl) {
  if (typeof uri !== "string" || !uri.startsWith("ui://")) return null;

  if (uri === "ui://latest_episode") {
    const sorted = [...episodes].sort((a, b) => b.id - a.id);
    const ep = sorted[0];
    if (!ep) {
      return {
        title: config.title,
        body: `<div class="coil-card"><h3>${esc(config.title)}</h3><p class="coil-empty">No episodes yet.</p></div>`,
      };
    }
    return { title: `${ep.title} — ${config.title}`, body: episodeCard(ep, baseUrl) };
  }

  if (uri === "ui://catalog") {
    return { title: `${config.title} — recent episodes`, body: catalogCard(baseUrl) };
  }

  const epMatch = uri.match(/^ui:\/\/episode\/(\d{1,4})$/);
  if (epMatch) {
    const id = parseInt(epMatch[1], 10);
    const ep = episodes.find((e) => e.id === id);
    if (!ep) {
      return {
        title: `Episode #${id} not found`,
        body: `<div class="coil-card"><h3>Episode #${id} not found</h3><p class="coil-empty">Try the catalog at <a href="${esc(baseUrl)}" target="_blank" style="color:${ACCENT}">${esc(baseUrl)}</a>.</p></div>`,
      };
    }
    return { title: `${ep.title} — ${config.title}`, body: episodeCard(ep, baseUrl) };
  }

  if (uri.startsWith("ui://search")) {
    const qs = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const query = (params.get("q") || params.get("query") || "").trim();
    const limit = Math.min(20, Math.max(1, parseInt(params.get("limit") || "5", 10) || 5));
    if (!query) {
      return {
        title: "Search",
        body: `<div class="coil-card"><h3>Search</h3><p class="coil-empty">Pass a query: ui://search?q=&lt;your+question&gt;</p></div>`,
      };
    }
    const { results } = searchEpisodes(query, { limit, baseUrl });
    return { title: `Search: ${query}`, body: searchResultsCard(query, results, baseUrl) };
  }

  return null;
}

// Resolve a ui:// URI to a complete HTML5 document + the per-render
// nonce + the HTTP-flavoured CSP. Single source of truth for both
// resources/read (uses .html) and /mcp/ui/<name> (uses all three).
function buildUiDocument(uri, baseUrl) {
  const parts = renderUiBody(uri, baseUrl);
  if (!parts) return null;
  const nonce = generateNonce();
  const html = wrapDocument(parts.title, parts.body, baseUrl, nonce);
  return { html, nonce, httpCsp: buildAppHttpCsp(baseUrl, nonce) };
}

// Back-compat: resources/read still wants just the HTML string.
export function buildUiResource(uri, baseUrl) {
  const doc = buildUiDocument(uri, baseUrl);
  return doc ? doc.html : null;
}

// HTTP-served view of the same content. Used by the /mcp/ui/<name>
// route in functions/_middleware.js so orank's MCP App view CSP probe
// can fetch the iframe HTML over HTTP and read the response-header CSP
// (which carries frame-ancestors — invalid in <meta>).
export function buildUiHttpResponse(uri, baseUrl) {
  const doc = buildUiDocument(uri, baseUrl);
  if (!doc) return null;
  return new Response(doc.html, {
    status: 200,
    headers: {
      "Content-Type": MCP_APP_MIME,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      "Content-Security-Policy": doc.httpCsp,
      "X-Content-Type-Options": "nosniff",
      // Hosts (chatgpt.com, claude.ai) embed via <iframe src="…"> from
      // a different origin, so CORS isn't strictly required, but make
      // the resource freely fetchable for inspection tools / agents.
      "Access-Control-Allow-Origin": "*",
      "Vary": "Accept",
    },
  });
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
    default:
      return null;
  }
}
