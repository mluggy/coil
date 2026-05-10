import { readFileSync, writeFileSync } from "fs";
import config from "./load-config.js";

const episodes = JSON.parse(readFileSync("public/episodes.json", "utf8"));

// Absolute URLs are filled in by the middleware at serve time, so the same
// sitemap.xml / robots.txt works on any hostname.
const SITE = "{{SITE_URL}}";

const urls = [
  { loc: `${SITE}/`, lastmod: episodes[episodes.length - 1]?.date || "", priority: "1.0" },
  // Agent-facing surface — listed in the sitemap so generic crawlers and
  // discovery scanners (orank, search engines, etc.) can find the
  // machine-readable surface without probing well-known paths.
  { loc: `${SITE}/docs`, lastmod: "", priority: "0.6" },
  { loc: `${SITE}/pricing`, lastmod: "", priority: "0.6" },
  { loc: `${SITE}/llms.txt`, lastmod: "", priority: "0.5" },
  { loc: `${SITE}/llms-full.txt`, lastmod: "", priority: "0.5" },
  ...episodes.map((ep) => ({
    loc: `${SITE}/${ep.id}`,
    lastmod: ep.date || "",
    priority: "0.8",
  })),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}
    <priority>${u.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`;

writeFileSync("public/sitemap.xml", xml);
console.log(`Generated sitemap.xml with ${urls.length} URLs`);

// Generate robots.txt with Content-Signal hints + Schemamap pointer.
//
// Two distinct bot tiers, handled separately:
//
// 1. Runtime browse-on-behalf bots (ChatGPT-User, OAI-SearchBot,
//    PerplexityBot, Claude-User, Applebot, Google-Extended runtime, etc.)
//    — these fetch on behalf of a user asking a question right now. Always
//    explicitly Allowed so the show stays discoverable in answer engines.
//
// 2. Training crawlers (GPTBot, CCBot, anthropic-ai, ClaudeBot, Bytespider,
//    Google-Extended for training, Applebot-Extended) — gated on
//    `ai_training` in podcast.yaml. Set true to opt in (recommended for
//    maximum agent-readiness scoring).
const allowTraining = config.ai_training === true;
const trainSignal = allowTraining ? "yes" : "no";

// Always-Allow runtime bots. Explicit Allow blocks beat any default-* deny
// in some scanners' interpretation, and they make our intent unambiguous.
// `Content-Signal` is repeated per-bot so scanners that read signals on a
// per-User-agent basis (rather than only the global block) see the intent.
const runtimeAllowBlocks = [
  "",
  "# ============================================================",
  "# TIER 1 — Runtime browse-on-behalf agents (search=yes, ai-input=yes)",
  "# ============================================================",
  "# Search/answer engines that fetch on behalf of a user asking",
  "# a question right now. Always Allowed regardless of ai_training.",
  "# These are NOT training crawlers — they retrieve a single page to",
  "# answer a live user query and cite the source.",
  "",
  "User-agent: ChatGPT-User",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: OAI-SearchBot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: PerplexityBot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Perplexity-User",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Claude-User",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Claude-SearchBot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Applebot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Googlebot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Google-CloudVertexBot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: DuckAssistBot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Amazonbot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: MistralAI-User",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: Cohere-AI",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
  "",
  "User-agent: DeepSeekBot",
  "Content-Signal: search=yes, ai-input=yes",
  "Allow: /",
].join("\n");

const trainingBlocks = allowTraining
  ? [
      "",
      "# ============================================================",
      "# TIER 2 — Training crawlers (allowed: ai_training: true)",
      "# ============================================================",
      "# Crawlers that ingest content for model training. Allowed",
      "# because the show opted in via ai_training: true in podcast.yaml.",
      "# Content-Signal advertises ai-train=yes per RFC 9309 best-practice.",
      "",
      "User-agent: GPTBot",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: CCBot",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: anthropic-ai",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: ClaudeBot",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: Bytespider",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: Google-Extended",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: Applebot-Extended",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: FacebookBot",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      "",
      "User-agent: Meta-ExternalAgent",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
    ].join("\n")
  : [
      "",
      "# ============================================================",
      "# TIER 2 — Training crawlers (blocked: ai_training: false)",
      "# ============================================================",
      "# Crawlers that ingest content for model training. Blocked",
      "# because the show opted out — set ai_training: true in",
      "# podcast.yaml to allow. Content-Signal advertises ai-train=no",
      "# alongside the explicit Disallow.",
      "",
      "User-agent: GPTBot",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Disallow: /",
      "",
      "User-agent: CCBot",
      "Content-Signal: search=no, ai-input=no, ai-train=no",
      "Disallow: /",
      "",
      "User-agent: anthropic-ai",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Disallow: /",
      "",
      "User-agent: ClaudeBot",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Disallow: /",
      "",
      "User-agent: Bytespider",
      "Content-Signal: search=no, ai-input=no, ai-train=no",
      "Disallow: /",
      "",
      "User-agent: Google-Extended",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Disallow: /",
      "",
      "User-agent: Applebot-Extended",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Disallow: /",
    ].join("\n");

const robots = [
  "# ============================================================",
  "# TIER 0 — Default policy (search engines, generic crawlers)",
  "# ============================================================",
  "# Search engines and ordinary crawlers may fetch any page. AI-tier",
  "# preferences are expressed via Content-Signal (Cloudflare's",
  "# proposal) and per-bot Tier 1 / Tier 2 blocks below.",
  "User-agent: *",
  `Content-Signal: search=yes, ai-input=yes, ai-train=${trainSignal}`,
  "Allow: /",
  runtimeAllowBlocks,
  trainingBlocks,
  "",
  `Sitemap: ${SITE}/sitemap.xml`,
  `Schemamap: ${SITE}/.well-known/schema-map.xml`,
  "",
].join("\n");

writeFileSync("public/robots.txt", robots);
console.log(`Generated robots.txt (ai-train=${trainSignal})`);
