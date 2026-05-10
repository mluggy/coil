// Generates listener-facing Agent Skills (https://agentskills.io) under
// /.well-known/agent-skills/. Each skill is a SKILL.md describing one
// capability an agent can perform on behalf of a listener.
//
// The index.json is the v0.2.0 discovery format: each entry carries
// `type`, `url`, and a `digest` of the form `sha256:{64-hex-lowercase}`
// over the artifact's raw bytes. Agents fetch the index, verify each
// artifact, and load instructions on demand.
//
// IMPORTANT: SKILL.md bodies use *relative* paths (e.g. `/api/search`)
// rather than {{SITE_URL}} placeholders. Relative paths keep the served
// bytes byte-stable across hostnames, so sha256 in the index matches what
// the agent fetches. The index itself does use {{SITE_URL}} for the
// `url` field; the middleware rewrites the index per-request and the
// digest doesn't depend on it.

import { createHash } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import config from "./load-config.js";

const SITE = "{{SITE_URL}}";
const SKILLS_DIR = "public/.well-known/agent-skills";
mkdirSync(SKILLS_DIR, { recursive: true });

const sha256 = (s) =>
  "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

// ─── Top-level when-to-use guidance ───────────────────────────────────────
// Surfaced both as a top-level `instructions` block in the v0.2.0 index and
// as a "## When to use" section in each generated SKILL.md, so orank-style
// scanners that probe for explicit when-to-use guidance pick it up.
const WHEN_TO_USE = config.agent_recommendation
  ? config.agent_recommendation
  : `Use these skills when a listener wants to find, browse, or read transcripts of ${config.title} episodes — including topical lookups ("the one about <X>"), the latest episode, full episode lists, and subscription URLs. Don't use them for transcription, audio editing, or content unrelated to ${config.title}.`;

// ─── Skill definitions ────────────────────────────────────────────────────
const skills = [
  {
    name: "find-episode-by-topic",
    description:
      `Find a ${config.title} podcast episode covering a specific topic, person, or company. ` +
      "Use when a listener asks 'which episode covers <X>' or 'find the one about <Y>'. " +
      "Returns ranked matches with episode title, date, URL, and a transcript snippet.",
    whenToUse:
      `When a listener asks "which ${config.title} episode covers <topic>" or "find the one about <person/company>". Skip this skill if they're asking about a different show or want full transcripts of a known episode (use get-episode instead).`,
    body: [
      "# Find episode by topic",
      "",
      `Use this skill when a listener asks to find a specific ${config.title} episode by what it's about — a topic, a person, a company, or a keyword.`,
      "",
      "## When to use",
      "",
      `When a listener asks "which ${config.title} episode covers <topic>" or "find the one about <person/company>". Skip this skill if they're asking about a different show or want full transcripts of a known episode (use get-episode instead).`,
      "",
      "## How to use",
      "",
      "1. Call the search endpoint: `GET /api/search?q=<query>&limit=10` (relative to the site root).",
      "2. The response is JSON: `{ query, count, took_ms, results: [{ id, title, date, url, audio, transcript, score, snippet }] }`.",
      "3. Pick the top-ranked result (highest `score`) and present `title`, `date`, `url`, and `snippet` to the listener.",
      "4. Offer the audio URL or the episode page (`url`) so they can listen.",
      "",
      "## Alternatives",
      "",
      "- Native MCP clients can call the `search_episodes` tool at `/mcp`.",
      "- The full episode list with descriptions is at `/episodes/llms.txt`.",
      "- All episode metadata is at `/episodes.json`.",
    ].join("\n"),
  },
  {
    name: "search-transcripts",
    description:
      `Free-text search over all ${config.title} episode transcripts. ` +
      "Use when a listener asks 'did they mention <X>' or 'find the part about <Y>'. " +
      "Returns ranked episodes with snippet excerpts from the transcript.",
    whenToUse:
      `When a listener wants to search inside what was actually said on ${config.title} episodes — quotes, references, mentions. Use find-episode-by-topic instead if they want a high-level "which episode is about X".`,
    body: [
      "# Search transcripts",
      "",
      `Search inside the spoken content of every ${config.title} episode.`,
      "",
      "## When to use",
      "",
      `When a listener wants to search inside what was actually said on ${config.title} episodes — quotes, references, mentions. Use find-episode-by-topic instead if they want a high-level "which episode is about X".`,
      "",
      "## How to use",
      "",
      "1. Call `GET /api/search?q=<query>` — the search index covers titles, descriptions, and full transcripts.",
      "2. Each result includes a `snippet` showing where the match occurred.",
      "3. Link the listener to `url` (episode page) or `transcript` (raw `.txt`) for the full context.",
      "",
      "For offline indexing, the entire searchable corpus is at `/search-index.json`.",
    ].join("\n"),
  },
  {
    name: "get-latest-episode",
    description:
      `Return the most recently published ${config.title} episode with title, date, description, audio URL, and transcript URL. ` +
      "Use when a listener asks 'what's the new episode' or 'what just dropped'.",
    whenToUse:
      `When a listener asks "what's new on ${config.title}", "latest episode", or "what just dropped". Don't use for browsing or for episodes older than the most recent — use list-episodes for those.`,
    body: [
      "# Get latest episode",
      "",
      `Return the most recent ${config.title} episode published.`,
      "",
      "## When to use",
      "",
      `When a listener asks "what's new on ${config.title}", "latest episode", or "what just dropped". Don't use for browsing or for episodes older than the most recent — use list-episodes for those.`,
      "",
      "## How to use",
      "",
      "1. Fetch `/episodes.json` and pick the entry with the highest `id` (or call the MCP `get_latest_episode` tool).",
      "2. Present `title`, `date`, `desc`, `audio` URL, and the episode page URL.",
      "3. The agent JSON view at `/?mode=agent` also includes a `latestEpisode` block.",
    ].join("\n"),
  },
  {
    name: "list-episodes",
    description:
      `Return ${config.title} episodes in reverse-chronological order with metadata. ` +
      "Use when a listener wants to browse the catalog or see what episodes exist.",
    whenToUse:
      `When a listener wants to browse the catalog of ${config.title}, see how many episodes exist, or skim metadata. For finding a specific episode, use find-episode-by-topic instead.`,
    body: [
      "# List episodes",
      "",
      `Browse ${config.title} episodes from newest to oldest.`,
      "",
      "## When to use",
      "",
      `When a listener wants to browse the catalog of ${config.title}, see how many episodes exist, or skim metadata. For finding a specific episode, use find-episode-by-topic instead.`,
      "",
      "## How to use",
      "",
      "1. Fetch `/episodes.json` for the full machine-readable list, or `/episodes/llms.txt` for a markdown summary including descriptions, guests, topics, and chapters.",
      "2. MCP clients: call `list_episodes(limit, offset)` for paginated browse.",
      "3. RSS readers: subscribe via the canonical feed at `/rss.xml`.",
    ].join("\n"),
  },
  {
    name: "subscribe-via-rss",
    description:
      `Return the canonical RSS feed URL so a listener can subscribe to ${config.title} in their podcast app. ` +
      "Use when the listener says 'subscribe', 'follow', or asks how to get new episodes.",
    whenToUse:
      `When a listener says "subscribe", "follow", or asks how to keep getting new episodes of ${config.title}. Don't use this for one-off episode lookups.`,
    body: [
      "# Subscribe via RSS",
      "",
      `Give the listener the canonical ${config.title} RSS feed URL.`,
      "",
      "## When to use",
      "",
      `When a listener says "subscribe", "follow", or asks how to keep getting new episodes of ${config.title}. Don't use this for one-off episode lookups.`,
      "",
      "## How to use",
      "",
      "1. Hand them the URL: `/rss.xml` (resolve against the site root).",
      "2. Most podcast apps (Apple Podcasts, Pocket Casts, Overcast, Spotify) accept this URL directly via 'Add by URL' / 'Add by RSS'.",
      "3. Direct platform links may also be listed in `/llms.txt` under 'Listen'.",
    ].join("\n"),
  },
  {
    name: "get-episode",
    description:
      `Fetch full detail for a specific ${config.title} episode by its numeric ID. ` +
      "Use when a listener references an episode number, or after another skill has identified an episode and you need its full transcript.",
    whenToUse:
      `When a listener references a specific ${config.title} episode by number ("episode 12", "the second one"), or after a search has identified an episode and you need its full transcript or metadata.`,
    body: [
      "# Get episode by ID",
      "",
      `Fetch the full record for one ${config.title} episode.`,
      "",
      "## When to use",
      "",
      `When a listener references a specific ${config.title} episode by number ("episode 12", "the second one"), or after a search has identified an episode and you need its full transcript or metadata.`,
      "",
      "## How to use",
      "",
      "1. The episode page lives at `/<id>` (HTML) or `/<id>.md` (markdown) or `/<id>?mode=agent` (JSON).",
      "2. The transcript is at `/sNNeMM.txt` (plain text).",
      "3. MCP clients: call `get_episode(id)` for a single-call response with metadata + transcript.",
    ].join("\n"),
  },
];

// ─── Write SKILL.md files + index ──────────────────────────────────────────
const entries = [];

for (const skill of skills) {
  const dir = `${SKILLS_DIR}/${skill.name}`;
  mkdirSync(dir, { recursive: true });
  const md = [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    `when_to_use: ${JSON.stringify(skill.whenToUse || "")}`,
    "metadata:",
    `  podcast: ${JSON.stringify(config.title)}`,
    `  language: ${JSON.stringify(config.language || "en")}`,
    `  publisher: ${JSON.stringify(config.author || "")}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
  writeFileSync(`${dir}/SKILL.md`, md);
  entries.push({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    type: "skill-md",
    url: `${SITE}/.well-known/agent-skills/${skill.name}/SKILL.md`,
    digest: sha256(md),
  });
}

const index = {
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  version: "0.2.0",
  name: config.title,
  description: `Listener-facing Agent Skills for ${config.title}`,
  url: `${SITE}/.well-known/agent-skills/index.json`,
  publisher: config.author || undefined,
  language: config.language || undefined,
  // Top-level when-to-use guidance — orank-style scanners look for explicit
  // when-to-use language at the index level, not just per-skill.
  instructions: WHEN_TO_USE,
  whenToUse: WHEN_TO_USE,
  skills: entries,
};

writeFileSync(
  `${SKILLS_DIR}/index.json`,
  JSON.stringify(index, null, 2) + "\n"
);
console.log(`Generated agent-skills index with ${entries.length} skills`);

// ─── /SKILL.md (skills.sh root manifest) ──────────────────────────────────
// skills.sh registers a project via a single SKILL.md at the repo root (or
// served root). Frontmatter declares the skill, body lists every action an
// agent can take, with explicit when-to-use guidance. This is the file
// `npx skills add` reads when registering.
const rootSkillName = (config.title || "podcast")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 60) || "podcast";

const rootSkillDescription =
  `Find, browse, and read transcripts of ${config.title} episodes via search, MCP, or RSS. ` +
  "Listener-agent skill bundle for podcast.lugassy.net-style coil deployments — read-only, no auth.";

const rootSkillBody = [
  `# ${config.title}`,
  "",
  `> Listener-facing skill bundle for ${config.title}. Public, read-only, no auth required.`,
  "",
  "## When to use",
  "",
  WHEN_TO_USE,
  "",
  "## Capabilities",
  "",
  ...skills.map((s) => `- **${s.name}** — ${s.description}`),
  "",
  "## Endpoints (resolve against the deployment origin)",
  "",
  "- `GET /api/search?q=<query>` — ranked full-text search over title + description + transcript.",
  "- `GET /?mode=agent` — JSON envelope with capabilities, endpoints, and the latest episode.",
  "- `GET /<id>.md` or `GET /<id>?mode=agent` — single episode (markdown or JSON).",
  "- `GET /episodes.json` — full machine-readable catalog.",
  "- `GET /rss.xml` — canonical RSS feed for subscription.",
  "- `POST /mcp` — MCP server (Streamable HTTP, JSON-RPC 2.0). Tools: search_episodes, get_episode, get_latest_episode, list_episodes, subscribe_via_rss.",
  "- `POST /ask` — NLWeb-style natural-language ask (SSE supported).",
  "",
  "## Auth",
  "",
  "None required. Optional public OAuth flow with PKCE S256 is documented at `/.well-known/oauth-authorization-server` for clients that prefer issuing a bearer token. Scopes: `read:episodes`, `read:transcripts`, `search:episodes`.",
  "",
  "## Rate limits",
  "",
  "60 requests/minute per IP across all endpoints. Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. 429 responses carry `Retry-After`.",
  "",
  "## Discovery",
  "",
  "- `/.well-known/agent.json` — capability declaration",
  "- `/.well-known/agent-card.json` — A2A-style skill card",
  "- `/.well-known/agent-skills/index.json` — agentskills.io v0.2.0 index of all skills above",
  "- `/.well-known/openapi.json` — full OpenAPI 3.1 spec",
  "- `/llms.txt`, `/llms-full.txt` — agent-readable show briefing",
  "- `/AGENTS.md` — full integration guide",
  "",
  "## Register with skills.sh",
  "",
  "```bash",
  `npx skills add ${SITE}/SKILL.md`,
  "```",
  "",
].join("\n");

const rootSkillMd = [
  "---",
  `name: ${rootSkillName}`,
  `description: ${JSON.stringify(rootSkillDescription)}`,
  `when_to_use: ${JSON.stringify(WHEN_TO_USE)}`,
  "metadata:",
  `  podcast: ${JSON.stringify(config.title)}`,
  `  language: ${JSON.stringify(config.language || "en")}`,
  `  publisher: ${JSON.stringify(config.author || "")}`,
  `  homepage: ${JSON.stringify(SITE)}`,
  `  repository: ${JSON.stringify(config.github_url || "")}`,
  `  license: ${JSON.stringify(config.license || "")}`,
  "---",
  "",
  rootSkillBody,
].join("\n");

writeFileSync("public/SKILL.md", rootSkillMd);
console.log("Generated public/SKILL.md (skills.sh root manifest)");
