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
  { loc: `${SITE}/about`, lastmod: "", priority: "0.6" },
  { loc: `${SITE}/pricing`, lastmod: "", priority: "0.6" },
  { loc: `${SITE}/auth.md`, lastmod: "", priority: "0.6" },
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

// Generate robots.txt — forter-style: User-agent lines grouped under a
// single rule block. Four sections: discovery (Sitemap/Schemamap),
// mixed training+reasoning bots (gated on ai_training), runtime answer
// engines (always allowed), training-only scrapers (always blocked),
// generic catch-all. Content-Signal travels per group.
const allowTraining = config.ai_training === true;
const trainSignal = allowTraining ? "yes" : "no";

// Crawlers that do BOTH training AND reasoning / search. Gated on
// ai_training because blocking them costs visibility in answer engines.
const TRAINING_MIXED = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "Google-Extended",
  "Applebot-Extended",
];

// Runtime browse-on-behalf bots — always allowed (they fetch one page
// to answer a live user query and cite the source).
const RUNTIME_BOTS = [
  "ChatGPT-User",
  "OAI-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Claude-User",
  "Claude-SearchBot",
  "Applebot",
  "Googlebot",
  "Google-CloudVertexBot",
  "DuckAssistBot",
  "Amazonbot",
  "MistralAI-User",
  "Cohere-AI",
  "DeepSeekBot",
];

// Training-only crawlers and scrapers — always disallowed. orank's
// robots-ai-policy-quality check awards the point for blocking these
// specifically (CCBot + Bytespider in particular). Meta/Facebook are
// also training-only.
const TRAINING_ONLY = [
  "CCBot",
  "Bytespider",
  "FacebookBot",
  "Meta-ExternalAgent",
  "ImagesiftBot",
  "Diffbot",
  "omgili",
  "omgilibot",
];

function block(bots, signal, rule) {
  return [
    ...bots.map((b) => `User-agent: ${b}`),
    `Content-Signal: ${signal}`,
    rule,
  ].join("\n");
}

const robots = [
  `Sitemap: ${SITE}/sitemap.xml`,
  `Schemamap: ${SITE}/.well-known/schema-map.xml`,
  "",
  allowTraining
    ? "# Training + reasoning crawlers (ai_training: true)"
    : "# Training + reasoning crawlers (ai_training: false — blocked)",
  block(
    TRAINING_MIXED,
    `search=yes, ai-input=yes, ai-train=${trainSignal}`,
    allowTraining ? "Allow: /" : "Disallow: /",
  ),
  "",
  "# Runtime answer engines (always allowed)",
  block(RUNTIME_BOTS, "search=yes, ai-input=yes", "Allow: /"),
  "",
  "# Training-only crawlers + scrapers (always blocked)",
  block(TRAINING_ONLY, "search=no, ai-input=no, ai-train=no", "Disallow: /"),
  "",
  "# Default",
  "User-agent: *",
  `Content-Signal: search=yes, ai-input=yes, ai-train=${trainSignal}`,
  "Allow: /",
  "",
].join("\n");

writeFileSync("public/robots.txt", robots);
console.log(`Generated robots.txt (ai-train=${trainSignal}, ${TRAINING_ONLY.length} crawlers blocked)`);
