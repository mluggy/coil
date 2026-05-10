# 🎙️ coil

Self-hosted podcast platform: drop a WAV, push, and get the whole thing around it — a production podcast website with player, search, transcripts, analytics, OG images, RSS, and a CDN-deployed site.

**Demos:** [English](https://coil-demo.lugassy.net) [[Source](https://github.com/mluggy/coil-demo)] · [Hebrew](https://podcast.lugassy.net) (RTL) [[Source](https://github.com/mluggy/podcast)]

<p align="center">
  <video src="https://github.com/user-attachments/assets/6b80147b-cb2e-4240-9e39-1e2127092583" width="848" height="720" autoplay loop muted playsinline></video>
</p>

## What It Does

An end-to-end podcast pipeline triggered by a git push:

- **WAV to MP3** conversion with loudness normalization (ffmpeg)
- **Auto-transcription** to SRT subtitles (AWS Transcribe)
- **AI subtitle correction** (Google Gemini)
- **RSS feed** generation with iTunes/Spotify metadata
- **React website** with per-episode pages, OG images, sitemap, and SSR for crawlers
- **Player** with variable speed (0.8×–2×), closed captions, seek, keyboard shortcuts, and persistent preferences
- **Full-text search** across episode titles, descriptions, and transcripts
- **Analytics** — Google Analytics + Meta Pixel with event tracking (plays, seeks, downloads, subscribes, shares, searches, external clicks)
- **Cookie consent** banner with terms & privacy pages, all configurable
- **Caching** — long-lived media, SWR HTML, immutable build assets — tuned for Cloudflare's edge
- **CDN deploy** to Cloudflare Pages with media served from R2
- **Agent-ready** — `llms.txt`, OpenAPI 3.1, Streamable HTTP MCP server (`/mcp`), Agent Skills (agentskills.io), anonymous public-client OAuth, and an x402/MPP tip jar so AI assistants can find, search, and tip without scraping (see [Agent-readiness](#agent-readiness))

## Architecture

```
                                   ┌──────────────────────────┐
   git push ─▶ GitHub Actions ─▶   │ Cloudflare Pages         │
                │                  │  ├─ SPA (React)          │
                │                  │  └─ _middleware.js       │  ◀─── Googlebot / users
                │                  │       (SSR + routing)    │        see SSR HTML
                │                  └──────────┬───────────────┘
                │                             │ R2 binding
                ▼                             ▼
           episodes/*.mp3,.srt  ──▶ Cloudflare R2 (media CDN)
```

The pipeline runs Python + Node scripts, commits generated artifacts back to the repo, syncs media to R2, and deploys the site. Media files (MP3/SRT/PNG) are served from R2 via the Pages R2 binding — no separate worker needed.

## Agent-readiness

A coil-generated site exposes a complete machine-readable surface for AI assistants and answer engines. Every artifact below is generated at build time from `podcast.yaml` + `episodes.yaml`, served with `{{SITE_URL}}` rewritten per request, and cached at the edge — nothing to hand-maintain.

| Family | Surfaces |
|---|---|
| **Crawler policy** | `/robots.txt` — Content-Signal hints + per-bot TIER 1 (browse-on-behalf agents incl. DeepSeekBot, ChatGPT-User, Claude-User, Perplexity, …) and TIER 2 (training crawlers, gated on `ai_training`). `/sitemap.xml`. |
| **llms.txt** | `/llms.txt` (show briefing), `/llms-full.txt` (single-file aggregate), `/episodes/llms.txt`, `/api/llms.txt`, `/docs/llms.txt`, `/.well-known/llms.txt`. |
| **Markdown views** | `/index.md`, `/<id>.md`, `/AGENTS.md`, `/docs.md`, `/pricing.md`, `/SKILL.md` (skills.sh manifest). Also via `Accept: text/markdown`. |
| **Capability declarations** | `/.well-known/agent.json`, `/.well-known/agent-card.json` (A2A), `/.well-known/agent-skills/index.json` (agentskills.io v0.2.0, with sha256-pinned SKILL.md artifacts), `/.well-known/ai-plugin.json`, `/.well-known/api-catalog` (RFC 9727), `/.well-known/schema-map.xml` (NLWeb). |
| **Read APIs** | `GET /api/search`, `POST /ask` (NLWeb, SSE), `GET /status`. Structured `{ error: { code, message, hint, docs_url } }` envelope, 60 req/min/IP, `X-RateLimit-*` headers. |
| **MCP server** | `POST /mcp` (Streamable HTTP, JSON-RPC 2.0). Tools: `search_episodes`, `get_episode`, `get_latest_episode`, `list_episodes`, `subscribe_via_rss`. Discovery at `/.well-known/mcp{,.json,-configuration,/server.json,/server-card.json}` plus in-page WebMCP signals (`<link rel="mcp">`, `<meta name="mcp-server">`, inline `<script type="application/mcp+json">`) on every HTML page. |
| **Agent-mode views** | `?mode=agent` on `/` or `/<id>` returns a compact JSON envelope with capabilities, endpoints, pricing, optional OAuth metadata, and the latest-episode block. |
| **Optional auth** | `/.well-known/oauth-authorization-server` (RFC 8414), `/.well-known/oauth-protected-resource` (RFC 9728), `/.well-known/openid-configuration`. Anonymous public-client flow at `/oauth/{authorize,token,register,userinfo,jwks.json}` with PKCE S256. Tokens are EdDSA JWS when `SIGNING_PRIVATE_KEY` is set (same key as Web Bot Auth), HS256 fallback otherwise. Auth is **not enforced**; tokens exist for shape compatibility with strict OAuth clients. |
| **Optional payment** | `POST /donate` returns HTTP 402 with `WWW-Authenticate: Payment` + `PAYMENT-REQUIRED: x402` + `X-Payment-Required` JSON. Discovery at `/.well-known/x402/supported` and `/.well-known/discovery/resources`. The free read API never returns 402. |
| **Web Bot Auth** | `/.well-known/http-message-signatures-directory` (RFC 9421). Empty `keys[]` by default; ships an Ed25519 JWK when `SIGNING_PRIVATE_KEY` is set (same JWK is also published at `/oauth/jwks.json`). |
| **HTTP Link headers** | Every HTML response advertises sitemap, markdown alternate, OpenAPI, agent.json, agent-card, agent-skills, schemamap, MCP, RSS, and llms.txt (RFC 8288). |

### JSON-LD

- **Homepage:** `@graph` of `PodcastSeries` (with `Speakable`) + `Product` (offer) + `Organization` (publisher) + `WebSite` (with `SearchAction` pointing at `/api/search`) + `Person` (host) + `FAQPage`.
- **Episodes:** `PodcastEpisode` enriched with `transcript: MediaObject`, `about: Thing[]` (topics), `actor: Person[]` (guests), `hasPart: Clip[]` (chapters), and `BreadcrumbList` when those optional fields are populated.

### What to configure

Every agent-readiness field is documented inline in [`podcast.yaml`](podcast.yaml). All fields are optional — empty values fall back to templated defaults built from `title` / `language` / `topics` / `update_frequency`. Filling in `host.bio`, `value_proposition`, `wikidata_id`, and `payment.usdc_address` lifts the score on third-party agent-readiness scanners (e.g. [orank](https://ora.run)). Per-episode `guests`, `topics`, and `chapters` in `episodes/episodes.yaml` enrich the `PodcastEpisode` JSON-LD.

## Quick Start

1. **Fork this repo** and clone it locally.
2. **Run `npm install`** — registers a git merge driver that protects your files from upstream sync (see [Staying in sync](#staying-in-sync-with-upstream)).
3. **Set up Cloudflare** — Pages project + R2 bucket (see [Cloudflare setup](#cloudflare-setup) below).
4. **Edit `wrangler.toml`** — replace `your-pages-project` with your Pages project name and set `bucket_name` to your R2 bucket.
5. **Edit `podcast.yaml`** — every field is documented inline (title, colors, social links, labels).
6. **Replace the cover art** — overwrite `public/cover.png` (1400–3000 px, square, RGB PNG/JPG, under ~500 KB).
7. **Replace or start fresh with the demo episode**:
   - **Keep episode 1**: overwrite `episodes/s1e1.wav` with your own audio and update the episode entry in `episodes/episodes.yaml`.
   - **Start fresh**: delete `episodes/s1e1.*`, reset `episodes/episodes.yaml` to `episodes: {}`, then drop your first WAV as `episodes/s{season}e{episode}.wav`.
8. **Configure GitHub secrets** (see [Secrets](#github-secrets) — minimum required: Cloudflare API token + account ID and the four `R2_*` keys).
9. **Push** — the pipeline converts, transcribes, builds, and deploys.

First run typically takes 2–8 minutes depending on episode size and whether transcription runs.

## Prerequisites

**GitHub Actions (default path):** nothing local. Runner provides Node 20, Python 3.11, ffmpeg, git-lfs.

**Local dev:** Node 20 (`nvm use`), Python 3.11+, `brew install ffmpeg git-lfs && git lfs install`, then `npm install && pip install -r requirements.txt`.

## Service setup

The pipeline needs three services: **Cloudflare** (required — hosts the site and media), **AWS** (optional — auto-transcription), and **Google Gemini** (optional — AI subtitle correction). Each has a CLI path and a browser path — pick one per service.

After creating credentials, they go into **GitHub Secrets** so the Actions pipeline can use them. The final step — editing `wrangler.toml` — is the same regardless of which path you chose.

### Cloudflare (required)

You need a **Pages project** (hosts the site) and an **R2 bucket** (stores MP3/SRT/PNG). Both are free tier.

<details>
<summary><b>CLI path</b></summary>

```bash
# One-time install
npm i -g wrangler                    # or use npx
wrangler login                       # opens browser → authorize

# Create resources
wrangler pages project create my-podcast --production-branch main
wrangler r2 bucket create my-podcast

# Get your account ID (needed for secrets)
wrangler whoami                      # shows Account ID in table
```
</details>

<details>
<summary><b>Browser path</b></summary>

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create application → **Upload your static files** → name it (e.g. `my-podcast`) → upload any small file to finish.
2. R2 → Create bucket → name it (e.g. `my-podcast`).
3. **Account ID** — shown in the dashboard sidebar (right side, under your account name).
</details>

**Create two credentials** (browser required for both — no CLI equivalent):

1. **API token** — My Profile → API Tokens → Create Token → scroll to bottom → **"Create Custom Token"**:
   - Token name: anything (e.g. `coil-deploy`)
   - Permissions: **Account → Cloudflare Pages → Edit** (only this one)
   - Account resources: select your account
   - Zone resources: All zones
   - This is a **User API Token** — not the legacy Account token. The pipeline only needs Pages deploy; R2 is accessed via separate S3-compatible keys below.

2. **R2 access keys** — R2 → Manage R2 API Tokens → Create API token:
   - Permissions: **Object Read & Write**
   - Specify bucket(s): select **"Apply to specific buckets only"** → pick your podcast bucket
   - Gives you an **Access Key ID** + **Secret Access Key**

### AWS (optional — transcription)

Powers auto-transcription via AWS Transcribe with S3 as staging. Requires `transcribe: true` in `podcast.yaml`. Supports ~30 languages — derived from `language` + `country` (e.g. `en-US`, `he-IL`, `fr-FR`).

<details>
<summary><b>CLI path</b></summary>

```bash
# One-time install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
aws configure                        # enter root/admin credentials once

BUCKET="my-podcast-transcribe"
USER="coil-transcribe"

# Create S3 bucket
aws s3 mb s3://$BUCKET --region us-east-1

# Create policy → user → attach → access key (all in one go)
aws iam create-policy --policy-name coil-transcribe --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:GetObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"transcribe:StartTranscriptionJob\",\"transcribe:GetTranscriptionJob\",\"transcribe:DeleteTranscriptionJob\"],\"Resource\":\"*\"}
  ]
}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam create-user --user-name $USER
aws iam attach-user-policy --user-name $USER \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/coil-transcribe"

aws iam create-access-key --user-name $USER
# → save AccessKeyId + SecretAccessKey from the output
```
</details>

<details>
<summary><b>Browser path</b></summary>

1. **S3** → Create bucket → name it, region `us-east-1`.
2. **IAM → Policies** → Create policy → JSON tab → paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
       },
       {
         "Effect": "Allow",
         "Action": [
           "transcribe:StartTranscriptionJob",
           "transcribe:GetTranscriptionJob",
           "transcribe:DeleteTranscriptionJob"
         ],
         "Resource": "*"
       }
     ]
   }
   ```
   Name it `coil-transcribe` → Create policy.
3. **IAM → Users** → Create user → name `coil-transcribe` → Next → Attach policies directly → search `coil-transcribe` → select it → Next → Create user.
4. Click the user → Security credentials → Create access key → **"Application running outside AWS"** → Next → Create. Save the **Access Key ID** and **Secret Access Key**.
</details>

### Gemini (optional — subtitle correction)

Corrects raw AWS Transcribe output using Google's Gemini model. Free tier is plenty for podcasts.

1. Go to [Google AI Studio](https://aistudio.google.com) → Create API key.
2. **Restrict the key** — [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) → click your key → API restrictions → **"Restrict key"** → select only **"Generative Language API"** → Save.

### USDC tip jar (optional)

Setting `payment.usdc_address` in `podcast.yaml` makes `POST /donate` route optional USDC tips per x402 + MPP. Leave empty and `/donate` still serves valid 402 metadata — just no transferable address. The free read API (`/api/*`, `/mcp`, `/ask`, `/status`) never returns 402.

Generate a fresh Base Sepolia (testnet) address:

```bash
# CLI — Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup
cast wallet new       # prints 0x address + private key. Save the key in 1Password.
```

Or install MetaMask / Coinbase Wallet → create account → copy the address. Base Sepolia chain ID is `84532`. Get test USDC from the [Circle faucet](https://faucet.circle.com/).

The same address works on Base mainnet later — change `payment.network` to `"base"` in `podcast.yaml` and use a hardware wallet for any real funds.

### GitHub secrets & variables

All credentials go into your fork's GitHub repo. The pipeline reads them at runtime.

<details>
<summary><b>CLI path</b></summary>

```bash
# One-time install
brew install gh                      # or see https://cli.github.com
gh auth login                        # authenticate with GitHub

REPO="your-username/your-podcast"
ACCOUNT_ID="your-cloudflare-account-id"

# Required — Cloudflare deploy
gh secret set CLOUDFLARE_API_TOKEN     -R $REPO   # paste when prompted
gh secret set CLOUDFLARE_ACCOUNT_ID    -R $REPO --body "$ACCOUNT_ID"

# Required — R2 media sync
gh secret set R2_ACCESS_KEY_ID         -R $REPO   # paste when prompted
gh secret set R2_SECRET_ACCESS_KEY     -R $REPO   # paste when prompted
gh secret set R2_ENDPOINT_URL          -R $REPO --body "https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
gh secret set R2_BUCKET                -R $REPO --body "my-podcast"

# Optional — AWS transcription
gh secret set AWS_ACCESS_KEY_ID        -R $REPO   # paste when prompted
gh secret set AWS_SECRET_ACCESS_KEY    -R $REPO   # paste when prompted
gh secret set AWS_REGION               -R $REPO --body "us-east-1"
gh secret set AWS_S3_BUCKET            -R $REPO --body "my-podcast-transcribe"

# Optional — Gemini SRT correction
gh secret set GEMINI_API_KEY           -R $REPO   # paste when prompted

# Optional — site signing key (Ed25519). Used by both Web Bot Auth
# (RFC 9421) and /oauth/token (EdDSA JWS). One key, two purposes.
# Generate locally with: node scripts/generate-web-bot-auth.js --new-key
gh secret set SIGNING_PRIVATE_KEY -R $REPO   # paste the PEM when prompted

# Required — variable (not a secret)
gh variable set CLOUDFLARE_PROJECT_NAME -R $REPO --body "my-podcast"

# Required — allow pipeline to commit processed episodes back
gh api -X PUT repos/$REPO/actions/permissions/workflow \
  -f default_workflow_permissions=write
```
</details>

<details>
<summary><b>Browser path</b></summary>

Go to your fork → **Settings → Secrets and variables → Actions**.

**Secrets tab** — click "New repository secret" for each:

| Secret | Value | Required |
|:---|:---|:---|
| `CLOUDFLARE_API_TOKEN` | Custom token with Pages Edit | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | From `wrangler whoami` or dashboard sidebar | Yes |
| `R2_ACCESS_KEY_ID` | R2 API token access key | Yes |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | Yes |
| `R2_ENDPOINT_URL` | `https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com` | Yes |
| `R2_BUCKET` | Your R2 bucket name | Yes |
| `AWS_ACCESS_KEY_ID` | IAM user access key | No — transcription skipped |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key | No — transcription skipped |
| `AWS_REGION` | e.g. `us-east-1` | No — transcription skipped |
| `AWS_S3_BUCKET` | S3 staging bucket for Transcribe | No — transcription skipped |
| `GEMINI_API_KEY` | Google AI Studio API key | No — raw SRT used as-is |
| `SIGNING_PRIVATE_KEY` | Ed25519 PEM. One key, two purposes: signs Web Bot Auth requests (RFC 9421) AND OAuth EdDSA tokens at `/oauth/token`. The matching public JWK is published at both `/.well-known/http-message-signatures-directory` and `/oauth/jwks.json`. Generate with `node scripts/generate-web-bot-auth.js --new-key`. | No — surfaces ship with empty `keys[]` and OAuth tokens fall back to HS256 |

**Variables tab** — click "New repository variable":

| Variable | Value |
|:---|:---|
| `CLOUDFLARE_PROJECT_NAME` | Must match your Pages project name and `name` in `wrangler.toml` |

**Workflow permissions** — Settings → Actions → General → scroll to Workflow permissions → **Read and write permissions** → Save. (Required — the pipeline commits processed episodes back to your repo.)
</details>

### Edit `wrangler.toml`

Set `name` to your Pages project name and `bucket_name` to your R2 bucket name:
```toml
name = "my-podcast"
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "my-podcast"
```

## Costs

coil runs entirely on free tiers for most podcasts. Here's what each service costs beyond free:

| Service | Free tier | Beyond free |
|:---|:---|:---|
| **Cloudflare Pages** | 500 builds/month | $5/month Pro plan |
| **Cloudflare R2** | 10 GB storage, unlimited egress | $0.015/GB-month storage |
| **GitHub Actions** | Unlimited for public repos; 2,000 min/month for private | ~$0.008/min |
| **Git LFS** | 1 GB storage + 1 GB bandwidth/month | $5 per 50 GB data pack |
| **AWS Transcribe** | 250,000 min free (first 12 months) | ~$0.024/min of audio |
| **AWS S3** | 5 GB storage (first 12 months) | Negligible for staging |
| **Google Gemini** | Free tier (generous) | See [pricing](https://ai.google.dev/pricing) |
| **Custom domain** | Free on Cloudflare DNS (SSL included) | Domain registration ~$10–15/year |

For a typical podcast (weekly episodes, < 1 hour each), everything stays well within free tiers — **total cost: $0/month**. The only service likely to exceed free limits is AWS Transcribe after the first year, at roughly $1.50 per hour of audio.

## Publishing to podcast directories

After your first successful deploy, your site is at `https://your-pages-project.pages.dev` (or your custom domain). Your feed is at `/rss.xml`.

- **Spotify**: [Spotify for Podcasters](https://podcasters.spotify.com) → Add or claim podcast → paste RSS URL.
- **Apple Podcasts**: [Podcasts Connect](https://podcastsconnect.apple.com) → New Show → paste your RSS URL.
- **YouTube Music / Amazon Music**: similar flows via their creator portals.

After approval, add the returned IDs to `podcast.yaml` (`spotify_id`, `apple_podcasts_id`, etc.) and each episode's `spotify_id`/`apple_id`/`youtube_id`/`amazon_id` for deep linking.

**Setting `podcast_guid` — do this before first publish.** Generate a UUIDv4 at [uuidgenerator.net/version4](https://www.uuidgenerator.net/version4) and set `podcast_guid` in `podcast.yaml`. This gives your show a stable identifier across feed URL changes. If migrating from another platform, **copy the existing `<podcast:guid>` instead** (see next section).

## Custom domain

In your Pages project: *Custom Domains → Set up domain*. Point a CNAME (or A record via Cloudflare DNS) at `your-pages-project.pages.dev`. SSL is auto-provisioned.

## Staying in sync with upstream

coil evolves — new features ship upstream and you'll want them without losing your customizations.

Your `podcast.yaml`, `episodes/episodes.yaml`, episode media, `public/cover.png`, and `wrangler.toml` are **frozen upstream** and protected from sync conflicts. Favicons and app icons are regenerated from your `cover.png` on every build — nothing to maintain separately.

**To pull updates:** click **Sync fork** on your GitHub repo, or locally:
```bash
git remote add upstream https://github.com/mluggy/coil
git pull upstream main
git push
```

Your content and config stay exactly as you left them.

<details>
<summary>How the protection works (three layers)</summary>

1. **CI check** on coil PRs blocks any modification to frozen files.
2. **`.gitattributes`** lists these files with `merge=ours` — local `git pull upstream main` silently keeps your version.
3. **`npm install`** registers the `ours` merge driver via a postinstall hook.

New `podcast.yaml` fields are announced in [GitHub Releases](https://github.com/mluggy/coil/releases) — add them to your own config if you want the feature; code uses safe defaults otherwise. For a reference config, see [mluggy/coil-demo](https://github.com/mluggy/coil-demo).
</details>

## Troubleshooting

**Pipeline fails at the commit step (`git push` → 403)**
Enable write permissions: *Settings → Actions → General → Workflow permissions* → **Read and write permissions**.

**Deploy fails with "project not found"**
Edit `wrangler.toml` — replace `your-pages-project` with your actual Pages project name. Also set the `CLOUDFLARE_PROJECT_NAME` Actions variable (Settings → Secrets and variables → Actions → Variables tab).

**Media 404s on the deployed site**
R2 bucket not bound. *Pages project → Settings → Functions → R2 bucket bindings* → add variable `R2_BUCKET` pointing to your bucket. Also verify `bucket_name` in `wrangler.toml` is non-empty.

**Episodes appear without transcripts**
Either AWS secrets aren't set, `transcribe: true` is missing in `podcast.yaml`, the language isn't supported by AWS Transcribe, or the `AWS_S3_BUCKET` staging bucket isn't reachable from your IAM user.

**`git push` is slow or fails on large WAVs**
Git LFS not initialized: `brew install git-lfs && git lfs install` on the machine pushing. Also check LFS quota on your GitHub account.

**`npm run dev` shows a blank page**
Vite dev doesn't run the middleware (no SSR). Use `npm run preview` for the full Cloudflare Pages runtime.

**Synced from upstream but something got overwritten**
You likely skipped `npm install`, which registers the merge-driver protection. Run it now. Restore your file from git history: `git log -p path/to/file` → copy the version before the sync commit.

**Gemini error: "model not found"**
Update `gemini_model` in `podcast.yaml` to a current model ID — see [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models).

**OG image still shows old content after update**
OG images only regenerate when missing. Delete `episodes/sXeY.png` and push to force regeneration.

## Migrating from another platform

If you have an existing podcast on Anchor, Transistor, Spotify for Podcasters, Podbean, etc., import by RSS URL:

```bash
python scripts/import_rss.py https://your-rss-feed-url
python scripts/import_rss.py https://your-rss-feed-url --download  # also fetch MP3s
```

Generates `episodes/episodes.yaml` with all metadata including GUIDs (critical for preserving subscriber state).

**After importing:**
1. Verify GUIDs in `episodes.yaml` match your old feed.
2. Copy your old `<podcast:guid>` value into `podcast_guid` in `podcast.yaml`.
3. Set `legacy_slug_pattern` in `podcast.yaml` if your old URLs used slugs (Transistor example: `"/episodes/.+-(\\d+)$"`).
4. After deploying, update your RSS URL in Spotify, Apple Podcasts Connect, and other directories. Most follow 301 redirects.
5. Add `spotify_id`/`apple_id`/`youtube_id`/`amazon_id` to each episode for deep linking.

**Where to find your RSS feed URL:**

| Platform | Location |
|:---|:---|
| Anchor / Spotify for Podcasters | Settings → Distribution → RSS feed |
| Transistor | Dashboard → Show Settings → RSS feed |
| Podbean | Settings → Feed → RSS feed URL |
| Buzzsprout | Podcasts → RSS Feed |

## Local development

```bash
nvm use && npm install && pip install -r requirements.txt
npm run dev         # Vite dev server (no middleware — fine for UI iteration)
npm run preview     # Full Cloudflare Pages runtime with middleware
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for script breakdown, SSR verification, and running pipeline stages by hand.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

## Support

If coil is useful to you, consider [sponsoring the project](https://github.com/sponsors/mluggy).
