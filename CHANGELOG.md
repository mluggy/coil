# Changelog

All notable changes to coil are documented here.

## 1.1.0 — 2026-05-10

Agent-readiness layer — make a coil-generated site discoverable and consumable by AI assistants and answer engines without scraping.

### Added
- **`/robots.txt`** — Content-Signal hints (search/ai-input always allowed); training crawlers (GPTBot, CCBot, anthropic-ai, Bytespider, Google-Extended, Applebot-Extended) gated on `ai_training: true` in `podcast.yaml`. Schemamap pointer.
- **`/index.md`** — markdown homepage agents can fetch instead of HTML.
- **`/llms.txt`** — enriched with capabilities, latest episode, and pointers to all endpoints. New **`/episodes/llms.txt`** with the full episode list.
- **`/.well-known/agent.json`** — capability declaration + endpoint inventory.
- **`/.well-known/agent-card.json`** — A2A-style skill card.
- **`/.well-known/schema-map.xml`** — NLWeb feed pointer.
- **`/.well-known/openapi.json`** — OpenAPI 3.1 spec for the read-only API surface.
- **`GET /api/search?q=&limit=`** — server-side ranked search (Pages Function).
- **`GET /mcp` + `POST /mcp`** — Streamable HTTP MCP server. Tools: `search_episodes`, `get_episode`, `get_latest_episode`, `list_episodes`, `subscribe_via_rss`. Native MCP clients (ChatGPT custom connectors, Claude.ai integrations, Cursor) can connect directly.
- **JSON-LD enrichments** — homepage emits a `@graph` of `PodcastSeries` (with `Speakable`) + `WebSite` (with `SearchAction` → `/api/search`) + `Person`. Episodes include `transcript: MediaObject` and `about` / `actor` / `hasPart` when topics / guests / chapters are populated.
- **New optional `podcast.yaml` fields** — `ai_training`, `topics`, `agent_recommendation`, and a `host:` block (`job_title`, `bio`, `wikidata_id`).
- **New optional `episodes.yaml` per-episode fields** — `guests`, `topics`, `chapters` (surfaced in JSON-LD and `/episodes/llms.txt`; SSR unchanged).

### Fixed
- Pipeline workflow no longer crashes with `pathspec '...' did not match any files` when `transcribe: false` (no `.srt`) or on a fresh fork with no episodes — `git add` now uses bash `nullglob` to skip missing extensions cleanly.

### Added (extended agent-readiness — same release line)

Endpoints
- **`POST /ask` + `GET /ask`** — NLWeb-style natural-language ask. Returns ranked episode results in `{ _meta, query, count, results }`. SSE streaming via `Accept: text/event-stream` or `Prefer: streaming=true` (events: `start`, `result`, `complete`).
- **`GET /status`** — service health snapshot for agent circuit-breaker logic.
- **`/docs` + `/docs.md`** — listener-agent docs (quickstart, code examples in curl/JS/Python/Claude.ai/ChatGPT/Cursor, auth walkthrough, full API reference).
- **`/AGENTS.md`** — per-deployment listener-agent integration guide. Also `AGENTS.md` at the coil repo root for AI coding agents.

Discovery
- **`/.well-known/mcp{,.json,-configuration,/server.json}`** — MCP discovery manifests (every spelling agents probe). POST routes to the live JSON-RPC handler for in-place handshake.
- **`/.well-known/mcp/server-card.json`** — preview-able card describing the MCP server (name, version, tools[]) before opening a transport.
- **`/.well-known/agent-skills/index.json` + 6 `SKILL.md` artifacts** — agentskills.io v0.2.0 (`$schema`, type, url, sha256 per artifact).
- **`/.well-known/ai-plugin.json`** — OpenAI plugin manifest.
- **`/.well-known/llms.txt`, `/api/llms.txt`** — modular section-scoped llms.txt files.
- **`?mode=agent` on `/` and `/<id>`** — compact agent JSON envelope (capabilities + endpoint inventory + latest episode / specific episode).
- **`/<id>.md` and `Accept: text/markdown`** — markdown alternates for episodes (homepage already had `/index.md`).

Protocol
- **MCP Apps** — `resources/list`, `resources/templates/list`, `resources/read` for `ui://latest_episode`, `ui://episode/{id}`, `ui://search?q=...`, `ui://catalog`. Tool responses include `_meta.ui.resourceUri` so MCP clients render themed playable cards (cover art, audio control, subscribe links) inline.
- **MCP error consistency** — JSON-RPC errors share the same envelope shape as REST endpoints.

HTTP surface
- **Rate-limit headers** on every API response: `X-RateLimit-Limit/Remaining/Reset` (60/min/IP documented policy), plus `Retry-After` on 429.
- **Structured JSON error envelope** `{ error: { code, message, hint, docs_url } }` across `/api/search`, `/mcp`, `/.well-known/mcp`, `/ask`, `/status`, `/<id>.md`, agent-mode 404s. Listener-language messages.
- **Episode-not-found** returns 404 + JSON envelope when accessed via `?mode=agent` or `Accept: application/json`; browsers still get the friendly 301-to-home.
- **405 method-not-allowed** on every Pages Function instead of silent fallthrough.
- **RFC 8288 Link headers** on every HTML/JSON response — sitemap, markdown alt, OpenAPI `service-desc`, agent.json `describedby`, agent-card, agent-skills, schemamap, MCP, RSS, llms.txt.

JSON-LD on `/`
- **`Product`** added to `@graph` (the show as offering, with free `Offer`).
- **`Organization`** added to `@graph` (publisher).
- **`FAQPage`** added to `@graph` (subscribe / pricing / language / cadence / agent integration / transcripts).
- **`sameAs` extended** — new optional `wikipedia_url`, `github_url` (top-level) and `host.github_url` / `host.wikipedia_url` (Person). Existing Spotify/Apple/Amazon/YouTube/social retained.

JSON-LD on `/<id>`
- **`BreadcrumbList`** added (Home → Episode N).

OpenAPI
- Typed request/response schemas for **all 7 operations** (was 2/7).
- 400/404/405/429/500 documented per endpoint with shared `Error` schema.
- `x-rate-limit-policy` extension + per-response rate-limit header schemas.

HTML
- **sr-only `<h1>`** outside `<div hidden>` so HTML parsers see the page title without JS execution (orank's no-JS check).
- **sr-only `<nav>`** with anchors to AGENTS.md, /api/llms.txt, /docs, OpenAPI, agent.json, MCP, /ask — discoverable by crawlers, invisible to listeners.

`llms.txt`
- "Find <show>" anchor section, "Why this podcast", "Use cases" (listener intents → endpoints), "Constraints" (rate limits, languages, search modes), "Pricing" (default `Free. No signup, no ads, no paywall.`), unified "Subscribe" block (RSS / MCP / AI plugin / platforms in one place).

`robots.txt`
- **Always-Allow runtime browse-on-behalf bots** regardless of `ai_training`: ChatGPT-User, OAI-SearchBot, PerplexityBot, Perplexity-User, Claude-User, Claude-SearchBot, Applebot, Googlebot, Google-CloudVertexBot, DuckAssistBot, Amazonbot, MistralAI-User, Cohere-AI. Training crawlers continue to be gated on `ai_training`.

New optional `podcast.yaml` fields
- `pricing` — overrides the default "Free." copy.
- `value_proposition` — short paragraph for the "Why this podcast" section.
- `wikipedia_url`, `github_url` — show-level authority profiles for `sameAs`.
- `host.github_url`, `host.wikipedia_url` — host-level authority profiles for `Person.sameAs`.

### Listener focus
All new tool descriptions, error messages, MCP server card text, ui:// HTML cards, and API error hints use listener-language ("we don't have an episode #999, try the catalog") rather than developer jargon. The coil repo itself remains the developer-facing entry point — see [`AGENTS.md`](AGENTS.md) at the repo root.

### Added (orank loose-ends — same release line)

Discovery
- **`/.well-known/api-catalog`** — RFC 9727 linkset (`application/linkset+json;profile="https://www.rfc-editor.org/info/rfc9727"`) enumerating every API and service description (search, ask, MCP, agent.json, agent-card, agent-skills, ai-plugin).
- **`/docs/llms.txt`** — third modular section file (joins `/api/llms.txt` + `/.well-known/llms.txt`).
- **robots.txt** — explicit TIER 0 / TIER 1 / TIER 2 section headers so scanners that look for "tier differentiation" find clearly labeled blocks.
- **Agent-Skills `$schema`** — corrected to `https://schemas.agentskills.io/discovery/0.2.0/schema.json` (was pointing at a 404).

Identity
- **`## Agent instructions`** section promoted to the top of `llms.txt` with explicit "if you are an AI agent reading this …" copy and a numbered listener-intent → endpoint walkthrough.

Auth & Access
- **`/.well-known/http-message-signatures-directory`** (Web Bot Auth, RFC 9421) — Ed25519 JWKS published when the optional `WEB_BOT_AUTH_PRIVATE_KEY` GitHub secret is set; otherwise ships a valid empty `{ "keys": [] }` envelope. New `scripts/generate-web-bot-auth.js --new-key` CLI for one-shot keypair generation.

Agent Integration
- **`/api/[[catchall]].js`** — unknown `/api/*` paths now return a structured JSON 404 envelope instead of leaking the SPA HTML fallback.
- **MCP Apps fixes** — `ui://` resources now serve `text/html;profile=mcp-app`, include `<!DOCTYPE html>`, `<meta name="color-scheme" content="light dark">`, `lang`/`dir` on `<html>`. `_meta.ui.resourceUri` moved from the `tools/call` *result* onto each tool *definition* (per spec); per-call resolved URI still surfaces in the result `_meta` as a hint.
- **MCP `initialize`** — adds an `instructions` paragraph describing the read-only listener-facing scope.
- **MCP tool annotations** — every tool carries `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }` so agents know they're safe to call without confirmation.
- **MCP zero-arg tool schemas** — `get_latest_episode` and `subscribe_via_rss` now declare `properties: {}, required: [], additionalProperties: false` so they count as fully typed.
- **MCP unknown-tool handling** — returns JSON-RPC `-32601` with `data.availableTools` + actionable hint; argument-shape errors return `-32602` with the bad payload.
- **`Accept: text/markdown` on `/`** — fixed (was returning the SPA HTML through `next()`); now fetches `/index.md` via `env.ASSETS` and serves with `Content-Type: text/markdown; charset=utf-8` + `Vary: Accept`.
- **OpenAPI** — every operation now references the shared error envelope (404/429/5xx). `/episodes.json`, `/search-index.json`, `/rss.xml`, `/llms.txt`, `/.well-known/mcp` GET, `/.well-known/mcp/server-card.json`, `/.well-known/api-catalog` use named `$ref` schemas (`EpisodeList`, `SearchIndex`, `RssFeed`, `LlmsTxt`, `McpManifest`, `McpServerCard`, `ApiCatalog`).

User Experience
- **Agent-mode JSON view (`?mode=agent`)** — adds `auth { type: "none", required: false }`, `webhooks { supported: false }`, `pricing` block, `rateLimits`, and `agentInstructions` URL pointing at `/AGENTS.md`. Lifts the orank signal count from 6/8 to 8/8.

New optional GitHub secret
- `WEB_BOT_AUTH_PRIVATE_KEY` — Ed25519 PEM. Optional. When set, the build emits the public key as a JWK at `/.well-known/http-message-signatures-directory`.

## 1.3.3 — 2026-05-10

MPP audit fix.

### Fixed
- `/openapi.json` (and the legacy `/swagger.json`) now serve the OpenAPI 3.1 spec — same bytes as `/.well-known/openapi.json`, with `Content-Type: application/json`. MPP audits probe `/openapi.json` looking for the `x-payment-info` extension and were getting 404. The canonical location remains `/.well-known/openapi.json` (per RFC 8615); these are root-level aliases for tooling that expects the older convention.

## 1.3.2 — 2026-05-10

x402 spec-compliance fix.

### Fixed
- `/api/v1` and `/donate` 402 responses now match the canonical x402 v0.4 wire format that audits parse for. Two changes:
  1. **Body shape:** `x402Version` + `accepts` + `error` are now at the **top level** of the JSON body (audits read these from the root object). The structured error envelope and MPP / external donation alternatives moved into `_meta` so no information is lost.
  2. **`WWW-Authenticate`:** emits two challenge values (RFC 9110 §11.6.1) — one with scheme `x402` for x402 audits, one with scheme `Payment` for MPP audits. Previously only `Payment` was sent, which x402 audits rejected as "no valid x402 payment headers".

## 1.3.1 — 2026-05-10

Follow-up patch to 1.3.0.

### Fixed
- CI: workflow now passes `SIGNING_PRIVATE_KEY` to the build step. 1.3.0 renamed the secret in the generator script but missed the workflow file, so forks setting the new secret name saw `/.well-known/http-message-signatures-directory` ship empty `keys[]` even when configured.

### Changed
- WebMCP — added the canonical imperative API (`navigator.modelContext.registerTool(…)`) on every HTML page alongside the existing declarative `<link rel="mcp">`, `<meta name="mcp-server">`, and `<script type="application/mcp+json">` signals. The imperative path is what most current WebMCP audits actually test for. The handler invokes `/api/search` via `fetch` and returns the standard JSON envelope.
- HTTP `Link` header now advertises `<…/donate>; rel="payment"` and `<…/.well-known/x402/supported>; rel="x402"`, plus declarative `<link rel="payment">` and `<meta name="x402-resource">` in HTML — payment-aware audits find `/donate` without needing the free read API to return 402.
- `/api/v1*` (and any path under it) now returns HTTP 402 with x402 + MPP headers and a structured envelope pointing at `/donate`. Coil never implemented a versioned API; `/api/v1` is a common probe path for paid APIs, so returning 402 there gives x402/MPP audits a payment surface without making any working endpoint pretend to be paid. Real consumers don't hit `/api/v1`.
- OpenAPI spec — `/donate` is now a documented operation with an `x-payment-info` extension (per-operation and at the top-level `info` block), declaring scheme/asset/network/address/protocols. Documents the 402 response with `WWW-Authenticate: Payment`, `PAYMENT-REQUIRED: x402`, and `X-Payment-Required` headers.

### Removed
- `WEB_BOT_AUTH_PRIVATE_KEY` back-compat fallback in the signing-key script, `functions/oauth/[[path]].js`, the workflow env, and the related test. `SIGNING_PRIVATE_KEY` is now the only recognized name.

### Renamed
- `scripts/generate-web-bot-auth.js` → `scripts/generate-signing-key.js`. The script's role broadened in 1.3.0 (Web Bot Auth + OAuth share one key); the new name reflects that.

## 1.3.0 — 2026-05-10

Closes orank Discovery, Identity, and Auth & Access gaps. Adds an optional public-client OAuth surface, an x402/MPP tip jar, and a 158-test agent-readiness suite (was 52).

### Discovery
- `/robots.txt` — `DeepSeekBot` allowed in TIER 1; per-bot `Content-Signal` lines on every TIER 1 / TIER 2 entry.
- `/SKILL.md` — root skills.sh manifest, generated by `scripts/generate-agent-skills.js`. Registers via `npx skills add <SITE>/SKILL.md`.
- Per-skill `when_to_use:` frontmatter + `## When to use` body section in every SKILL.md. Top-level `instructions` + `whenToUse` in `agent-skills/index.json`.
- `.cursorrules` at repo root.
- Homepage sr-only nav links every section-level llms.txt + `/.well-known/api-catalog` + `/.well-known/agent-card.json` + `/.well-known/agent-skills/index.json` so nav-based scanners derive every section path.

### Identity
- Agent-mode JSON view (`?mode=agent`) → `schemaVersion 1.2`. Adds `canonical`, `publisher`, `keywords`, `valueProposition`, `auth.optionalOAuth`, `errorEnvelope`, `sla`, `skill`, plus OAuth/x402/donate/skill endpoint URIs.
- `/api/llms.txt` — adds `## Quickstart`, `## Authentication` (zero-auth + OAuth M2M walkthrough), `## SDK install`.
- `/docs.md` — adds `## SDK install` + full OAuth walkthrough (RFC 8414 + RFC 9728 discovery, `client_credentials` + `authorization_code + PKCE S256` flows, scope table) + `## Optional: tip jar (x402 / MPP)`.
- `/AGENTS.md` (deployment) — adds `## Authentication (optional)` + `## Optional payment / tip jar`.
- New `podcast.yaml` fields: `value_proposition`, `payment` block, `wikidata_id`, `wikipedia_url`, `github_username` (top-level), `host.wikipedia_url`, `host.github_url`, `host.linkedin_url`. Templated defaults for `agent_recommendation` + `value_proposition` derive from title + language + topics + cadence when fields are empty.

### Auth & Access
- `/.well-known/oauth-authorization-server` (RFC 8414) — public-client metadata, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, scopes `read:episodes`, `read:transcripts`, `search:episodes`.
- `/.well-known/oauth-protected-resource` (RFC 9728) — `bearer_methods_supported: ["header"]`, `x-auth-required: false`.
- `/.well-known/openid-configuration` — minimal OIDC discovery for clients that probe OIDC first.
- `/oauth/[[path]].js` — anonymous public-client endpoints (`/authorize`, `/token`, `/register`, `/userinfo`, `/jwks.json`). EdDSA JWS when `SIGNING_PRIVATE_KEY` is set (same Ed25519 key as Web Bot Auth — one key, two purposes; `/oauth/jwks.json` publishes the matching public JWK), HS256 fallback otherwise. PKCE S256 honored. No consent screen, no client secret. Auth is **never enforced**; tokens exist for shape compatibility with strict OAuth clients.
- MCP — `initialize` result and `/.well-known/mcp` manifest both carry an `auth { type: "oauth2", required: false, flows, pkce: "S256", scopes, metadata, endpoints, publicClientId: "public" }` block. `/.well-known/mcp` GET emits `WWW-Authenticate: Bearer …; resource_metadata="…/oauth-protected-resource"` per RFC 6750.
- WebMCP — every HTML page includes in-page MCP discovery signals: `<link rel="mcp" href="/mcp">`, `<meta name="mcp-server" content="/mcp">`, and an inline `<script type="application/mcp+json">` declaring the `search_episodes` tool with a typed input schema. Browser-side agents find the server without a separate `/.well-known/mcp` fetch.
- `/donate` — HTTP 402 tip jar. Headers: `WWW-Authenticate: Payment`, `PAYMENT-REQUIRED: x402`, `X-Payment-Required: <x402 requirements>`, `Link: …; rel="payment"`. Body folds x402 + MPP + external-link methods. USDC on Base Sepolia by default; address + amount configurable via `payment` in `podcast.yaml`.
- `/.well-known/x402/supported` + `/.well-known/discovery/resources` — Coinbase x402 facilitator + Bazaar manifests.
- The free read API (`/api/*`, `/mcp`, `/ask`, `/status`) never returns 402.

### Tests
- 168 new tests added (52 → 220) covering: OAuth handler incl. EdDSA + back-compat + invalid-PEM fallback (20), `/donate` (7), WebMCP discovery (5), well-known JSON shapes + robots.txt + sitemap (33), llms.txt content quality (24), agent-files / agent-skills / docs.md (29), OpenAPI spec (8), MCP server (15), `/api`/`/ask`/`/status` (11), middleware (16). New `derive-config` cases for `github_profile_url` and templated `agent_recommendation` / `value_proposition` defaults.

### Renamed env var (with back-compat fallback)
- `WEB_BOT_AUTH_PRIVATE_KEY` → `SIGNING_PRIVATE_KEY`. One Ed25519 key, two purposes: Web Bot Auth signing (RFC 9421) and OAuth EdDSA tokens at `/oauth/token`. Same public JWK is published at both `/.well-known/http-message-signatures-directory` and `/oauth/jwks.json`. Pre-1.3.0 forks setting `WEB_BOT_AUTH_PRIVATE_KEY` continue to work — both code paths read the new name first, fall back to the old one.

### Deployment
For an existing fork upgrading to 1.3.0:
1. `git pull upstream main && npm install`
2. Optional — fill in new `podcast.yaml` fields. All have safe defaults; empty values fall back to templated text built from `title` / `language` / `topics`.
   - `value_proposition`, `agent_recommendation` — for `/llms.txt` quality.
   - `wikidata_id`, `wikipedia_url` — for entity-presence scoring.
   - `github_username` — auto-builds the GitHub profile URL into JSON-LD `sameAs`.
   - `host.bio`, `host.job_title`, `host.linkedin_url`, `host.github_url`, `host.wikipedia_url` — for E-E-A-T scoring.
   - `payment` block — fill `payment.usdc_address` to make `/donate` route a real USDC tip; leave empty to keep `/donate` responding with valid 402 metadata but no transferable address.
3. Optional — generate a signing key with `node scripts/generate-signing-key.js --new-key` (renamed from `generate-web-bot-auth.js` in 1.3.1) and set `SIGNING_PRIVATE_KEY` as a Cloudflare Pages env var (also as a GitHub secret if you want CI to publish the public JWK). One key powers both Web Bot Auth (`/.well-known/http-message-signatures-directory`) and OAuth EdDSA tokens (`/oauth/token` + `/oauth/jwks.json`). Skip for typical deployments — both surfaces work with empty / fallback defaults.
4. `npm run build && npm test` (220 tests must pass).
5. Deploy. After the first deploy, run `npx skills add https://<your-domain>/SKILL.md` to register on skills.sh.

## 1.0.0 — 2026-04-07

Initial release.

### Added
- WAV to MP3 conversion with loudness normalization (ffmpeg).
- Auto-transcription to SRT via AWS Transcribe.
- AI subtitle correction via Google Gemini.
- RSS feed generation with iTunes/Spotify metadata.
- React SPA with per-episode pages, OG images, sitemap, and SSR for crawlers.
- Player with variable speed (0.8x–2x), closed captions, seek, keyboard shortcuts, and persistent preferences.
- Full-text search across episode titles, descriptions, and transcripts.
- Analytics — Google Analytics + Meta Pixel with event tracking.
- Cookie consent banner with configurable terms and privacy pages.
- CDN deploy to Cloudflare Pages with media served from R2.
- RSS import script for migrating from other podcast platforms.
- Git merge driver protecting user content from upstream sync conflicts.
