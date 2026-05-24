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
      "2. MCP clients: call `search_episodes` to find episodes, or `get_latest_episode` for the newest one.",
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
  {
    // Back-pointer target for agent_auth.skill in the OAuth metadata.
    // WorkOS auth.md spec wants a SKILL.md that walks Discover → Register
    // → Claim → Use → Revoke so an agent can execute the auth flow from
    // a single instruction artifact rather than re-reading the AS/PRM
    // metadata at every step.
    //
    // IMPORTANT: orank's agent-auth-discovery deep check content-compares
    // this SKILL.md against /auth.md. Section structure (Discover → Pick
    // a method → Register → Claim → Use → Errors → Revocation), spec
    // anchor keywords (agent_auth, register_uri, identity_assertion,
    // id-jag, WWW-Authenticate), the GET-only discovery chain, and the
    // three registration template ids (anonymous-public-client,
    // user-email-app, service-account) must all appear here too.
    name: "use-agent-auth",
    description:
      `Obtain and use an OAuth bearer (or identity_assertion) credential for ${config.title}. ` +
      "Auth is OPTIONAL — all endpoints accept anonymous calls — but this skill walks the full flow for agents that prefer to authenticate. Mirrors the prose at /auth.md (WorkOS auth.md spec: agent_auth, register_uri, identity_assertion, id-jag, WWW-Authenticate).",
    whenToUse:
      `When an agent needs an explicit bearer token (audit logging, per-token quotas, or a strict MCP client that requires OAuth). Skip this skill if anonymous access is acceptable — every read endpoint on ${config.title} accepts unauthenticated calls.`,
    body: [
      "# Use agent auth",
      "",
      `Walkthrough for obtaining and using an OAuth credential against ${config.title}. Anonymous calls are always accepted; run this skill only when an agent needs an explicit bearer token. This SKILL.md mirrors the prose walkthrough at \`/auth.md\` — the same sections, same anchor keywords (\`agent_auth\`, \`register_uri\`, \`identity_assertion\`, id-jag, \`WWW-Authenticate\`), same registration templates.`,
      "",
      "## When to use",
      "",
      `When an agent needs an explicit bearer token (audit logging, per-token quotas, or a strict MCP client that requires OAuth). Skip this skill if anonymous access is acceptable — every read endpoint on ${config.title} accepts unauthenticated calls.`,
      "",
      "## Discover",
      "",
      "Two ways to discover the auth surface, no scraping required:",
      "",
      "1. **WWW-Authenticate challenge.** Probe `GET /agent/auth` for a spec-shaped 401:",
      "",
      "   ```bash",
      "   curl -i /agent/auth",
      "   # HTTP/1.1 401 Unauthorized",
      "   # WWW-Authenticate: Bearer realm=\"…\", scope=\"read:episodes read:transcripts search:episodes\", resource_metadata=\"…/.well-known/oauth-protected-resource\", auth_md=\"…/auth.md\"",
      "   ```",
      "",
      "2. **Well-known metadata.** Fetch the RFC 9728 PRM, follow `authorization_servers` to the RFC 8414 AS metadata. Both publish an `agent_auth` block with `register_uri`, `claim_uri`, `revocation_uri`, `identity_types_supported`, and a `skill` back-pointer to this file.",
      "",
      "   ```bash",
      "   curl /.well-known/oauth-protected-resource",
      "   curl /.well-known/oauth-authorization-server",
      "   curl /.well-known/openid-configuration   # mirrors agent_auth for OIDC clients",
      "   ```",
      "",
      "### GET-only discovery (with just an email)",
      "",
      "Per [workos.com/auth-md/docs/apps](https://workos.com/auth-md/docs/apps), an agent that has only the user's email can walk the full registration-template selection without ever POSTing — every step is a plain `GET`:",
      "",
      "```bash",
      "# 1. Read this skill (or the prose at /auth.md)",
      "curl /auth.md",
      "",
      "# 2. Fetch the PRM, follow authorization_servers",
      "curl /.well-known/oauth-protected-resource | jq '.authorization_servers, .authorization_server_metadata, .agent_auth'",
      "",
      "# 3. Fetch the AS metadata; pick a registration template",
      "curl /.well-known/oauth-authorization-server | jq '.agent_auth.registration_templates[]'",
      "",
      "# 4. (Shortcut) Fetch the templates directly from the registration endpoint",
      "curl /oauth/register | jq '.templates[]'",
      "```",
      "",
      "## Pick a method",
      "",
      "Three identity flavors are advertised under `agent_auth.identity_types_supported` and exposed as `registration_templates`:",
      "",
      "| identity_type | template id | When to use |",
      "| --- | --- | --- |",
      "| `anonymous` | `anonymous-public-client` | You only need to read. No auth header required at all. |",
      "| `client_credentials` | `service-account` | You want a per-request bearer for audit logs or M2M quotas. |",
      "| `identity_assertion` | `user-email-app` | You have the user's email and need an id-jag-style assertion bound to them. |",
      "",
      "## Register (RFC 7591)",
      "",
      "Anonymous public-client (default):",
      "",
      "```bash",
      "curl -X POST /oauth/register \\",
      "  -H 'Content-Type: application/json' \\",
      `  -d '{\"redirect_uris\":[\"https://your-app/cb\"],\"application_type\":\"native\"}'`,
      "",
      "# 201 Created — client_id=\"public\", client_secret=null, token_endpoint_auth_method=\"none\"",
      "```",
      "",
      "User-email app (`user-email-app` template — fill `request_body_template` from the GET-only discovery step):",
      "",
      "```bash",
      "curl -X POST /oauth/register \\",
      "  -H 'Content-Type: application/json' \\",
      `  -d '{\"user_email\":\"<email>\",\"redirect_uris\":[\"https://your-app/cb\"],\"application_type\":\"web\",\"scope\":\"read:episodes read:transcripts search:episodes\"}'`,
      "",
      "# 201 Created — same public client_id, with user_email echoed so the",
      "# subsequent /oauth/claim assertion can be bound to it.",
      "```",
      "",
      "## Claim",
      "",
      "Pick the flow that matches the template you picked at Register:",
      "",
      "- **client_credentials (M2M):**",
      "",
      "  ```bash",
      "  curl -X POST /oauth/token \\",
      "    -H 'Content-Type: application/x-www-form-urlencoded' \\",
      "    -d 'grant_type=client_credentials&client_id=public&scope=read:episodes read:transcripts search:episodes'",
      "  ```",
      "",
      "- **authorization_code + PKCE S256:**",
      "",
      "  ```bash",
      "  # 1. Redirect user to /oauth/authorize?response_type=code&client_id=public&code_challenge=<S256>&code_challenge_method=S256&scope=read:episodes&redirect_uri=<cb>",
      "  # 2. Exchange the returned code:",
      "  curl -X POST /oauth/token \\",
      "    -d 'grant_type=authorization_code&code=<code>&code_verifier=<verifier>&client_id=public'",
      "  ```",
      "",
      "- **identity_assertion (id-jag style):**",
      "",
      "  ```bash",
      "  curl -X POST /oauth/claim \\",
      "    -d 'identity_type=identity_assertion&scope=read:episodes'",
      "  ```",
      "",
      "  The returned `identity_assertion` is replayable as a bearer, or exchangeable at `/oauth/token` under the JWT-bearer grant (`urn:ietf:params:oauth:grant-type:jwt-bearer`).",
      "",
      "## Use the credential",
      "",
      "```bash",
      "curl -H 'Authorization: Bearer <token>' '/api/search?q=ai'",
      "curl -X POST /mcp -H 'Authorization: Bearer <token>' \\",
      "  -H 'Content-Type: application/json' \\",
      "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
      "```",
      "",
      "Tokens are JWS (EdDSA when `SIGNING_PRIVATE_KEY` is configured, HS256 otherwise). Verify against the JWKS at `/oauth/jwks.json`. Claims: `iss`, `sub`, `aud`, `iat`, `exp`, `scope`, `client_id`. TTL = 1 hour.",
      "",
      "**Bearer is optional.** Every endpoint accepts unauthenticated calls — the bearer surface exists so agents that require an OAuth handshake have one.",
      "",
      "## Errors",
      "",
      "Auth-tier errors use the OAuth 2.0 standard error codes. The 401 path returns the spec-anchor `WWW-Authenticate` header with a `resource_metadata` parameter pointing at the PRM.",
      "",
      "| Status | Code | Trigger |",
      "| --- | --- | --- |",
      "| 400 | `invalid_request` | Malformed token request (e.g. PKCE `code_verifier` missing). |",
      "| 400 | `invalid_grant` | Authorization code expired or PKCE verifier mismatch. |",
      "| 400 | `unsupported_grant_type` | `grant_type` is not one of the advertised values. |",
      "| 401 | `unauthorized` | Returned from `/agent/auth` with `WWW-Authenticate: Bearer resource_metadata=…` so callers can discover the PRM via a single probe. |",
      "| 405 | `method_not_allowed` | Wrong HTTP verb on an OAuth endpoint. |",
      "| 429 | `rate_limited` | Per-IP rate limit exceeded; `Retry-After` is set. |",
      "",
      "## Revocation",
      "",
      "Tokens are stateless JWS, so revocation is a courtesy acknowledgement rather than a session lookup — RFC 7009 says the endpoint always returns `200 OK`:",
      "",
      "```bash",
      "curl -X POST /oauth/revoke -d 'token=<access_token>&token_type_hint=access_token'",
      "# 200 OK (empty body)",
      "```",
      "",
      "Operational revocation is via key rotation: rotate `SIGNING_PRIVATE_KEY`, all previously-issued tokens stop verifying at the new JWK published under `/oauth/jwks.json`.",
      "",
      "## See also",
      "",
      "- Full prose walkthrough: `/auth.md`",
      "- AS metadata (`agent_auth` block): `/.well-known/oauth-authorization-server`",
      "- PRM metadata: `/.well-known/oauth-protected-resource`",
      "- OIDC discovery: `/.well-known/openid-configuration`",
      "- JWKS: `/oauth/jwks.json`",
      "- Registration templates: `/oauth/register` (GET)",
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
  // Multiple spellings of "when to use" because different scanners look
  // for different field names. orank's agent-instruction check was
  // flagging "no explicit when-to-use guidance" even with camelCase
  // present — the snake_case + the dedicated `when_to_use` /
  // `when_to_recommend` keys cover field-name regex variants.
  instructions: WHEN_TO_USE,
  whenToUse: WHEN_TO_USE,
  when_to_use: WHEN_TO_USE,
  whenToRecommend: WHEN_TO_USE,
  when_to_recommend: WHEN_TO_USE,
  agentInstructions: WHEN_TO_USE,
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
  "- `POST /mcp` — MCP server (Streamable HTTP, JSON-RPC 2.0). Tools: search_episodes, get_episode, get_latest_episode. Accepts JSON-RPC 2.0 batch (array of up to 50 requests).",
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
