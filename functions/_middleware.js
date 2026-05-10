import template from "./_html-template.js";
import episodes from "./_episodes.js";
import config from "./_config.js";
import { apiHeaders, errors } from "./_api.js";
import { handleMcpPost, buildMcpGetManifest, TOOLS as MCP_TOOLS, SERVER_INFO as MCP_SERVER_INFO, PROTOCOL_VERSION as MCP_PROTOCOL_VERSION } from "./mcp.js";

const BOTS = /googlebot|google-inspectiontool|bingbot|yandex|baiduspider|twitterbot|facebookexternalhit|linkedinbot|slackbot-linkexpanding|discordbot|whatsapp|telegrambot|applebot|pinterestbot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|anthropic-ai|claudebot|ccbot/i;

const MEDIA_PATTERN = /\.(mp3|srt|txt|png|jpg)$/i;

const CONTENT_TYPES = {
  mp3: "audio/mpeg",
  srt: "application/x-subrip",
  txt: "text/plain; charset=utf-8",
  jpg: "image/jpeg",
  png: "image/png",
  xml: "application/rss+xml",
};

// Build CSP dynamically based on configured analytics providers.
// Called per-request with a fresh nonce for inline script/style tags.
function buildCsp(nonce) {
  const n = `'nonce-${nonce}'`;
  const scriptSrc = ["'self'", n];
  const styleSrc = ["'self'", n, "https://fonts.googleapis.com"];
  const connectSrc = ["'self'"];
  const imgSrc = ["'self'", "data:"];

  if (config.ga_measurement_id) {
    scriptSrc.push("https://*.googletagmanager.com");
    connectSrc.push("https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com");
    imgSrc.push("https://*.google-analytics.com", "https://*.googletagmanager.com");
  }
  if (config.fb_pixel_id) {
    scriptSrc.push("https://connect.facebook.net");
    connectSrc.push("https://www.facebook.com");
    imgSrc.push("https://www.facebook.com");
  }
  if (config.x_pixel_id) {
    scriptSrc.push("https://static.ads-twitter.com");
    connectSrc.push("https://analytics.twitter.com");
    imgSrc.push("https://analytics.twitter.com", "https://t.co");
  }
  if (config.linkedin_partner_id) {
    scriptSrc.push("https://snap.licdn.com");
    connectSrc.push("https://px.ads.linkedin.com");
    imgSrc.push("https://px.ads.linkedin.com");
  }
  if (config.clarity_project_id) {
    scriptSrc.push("https://www.clarity.ms");
    connectSrc.push("https://www.clarity.ms");
    imgSrc.push("https://www.clarity.ms");
  }
  if (config.microsoft_uet_id) {
    scriptSrc.push("https://bat.bing.com");
    connectSrc.push("https://bat.bing.com");
    imgSrc.push("https://bat.bing.com");
  }
  if (config.tiktok_pixel_id) {
    scriptSrc.push("https://analytics.tiktok.com");
    connectSrc.push("https://analytics.tiktok.com");
    imgSrc.push("https://analytics.tiktok.com");
  }
  if (config.snap_pixel_id) {
    scriptSrc.push("https://sc-static.net");
    connectSrc.push("https://tr.snapchat.com");
    imgSrc.push("https://tr.snapchat.com");
  }

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    `font-src https://fonts.gstatic.com`,
    `img-src ${imgSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    `media-src 'self'`,
    `frame-ancestors 'none'`,
  ].join("; ");
}

function securityHeaders(nonce) {
  return {
    "Content-Security-Policy": buildCsp(nonce),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

// HTML pages are the entry point of every visit. Short hard-cache keeps
// fresh content propagating quickly; SWR serves cached copies instantly
// while revalidating in the background.
const HTML_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=604800";

function esc(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildJsonLd(episode, baseUrl) {
  // Authority links for the show itself. Spotify/Apple/Amazon/YouTube
  // are settable in podcast.yaml and act as podcast-directory authority
  // profiles. Wikipedia/Wikidata/GitHub are added when the host wires
  // them up.
  const showSameAs = [
    config.spotify_url,
    config.apple_podcasts_url,
    config.youtube_url,
    config.amazon_music_url,
    config.x_url,
    config.facebook_url,
    config.instagram_url,
    config.tiktok_url,
    config.linkedin_url,
    config.wikipedia_url,
    config.github_url,
    config.github_profile_url,
  ].filter(Boolean);
  const showWikidataId = config.wikidata_id;
  if (showWikidataId) showSameAs.push(`https://www.wikidata.org/wiki/${showWikidataId}`);

  const cover = `${baseUrl}${config.cover || "/cover.png"}`;
  const topics = Array.isArray(config.topics) ? config.topics.filter(Boolean) : [];

  // Person block for the host. Used on both homepage (top-level) and as
  // `author` on episodes. Includes optional `host:` block from podcast.yaml.
  // Host-specific sameAs links — prefer host.* fields when set, fall back to
  // show-level fields. Keeps Person and Organization JSON-LD blocks
  // disambiguated for entity-resolution agents.
  const personSameAs = [
    config.host?.linkedin_url || config.linkedin_url,
    config.host?.github_url,
    config.host?.wikipedia_url,
    config.x_url,
    config.facebook_url,
    config.instagram_url,
    config.tiktok_url,
  ].filter(Boolean);
  const wikidataId = config.host?.wikidata_id;
  if (wikidataId) personSameAs.unshift(`https://www.wikidata.org/wiki/${wikidataId}`);
  const person = {
    "@type": "Person",
    "@id": `${baseUrl}/#author`,
    name: config.author,
    ...(config.host?.job_title ? { jobTitle: config.host.job_title } : {}),
    ...(config.host?.bio ? { description: config.host.bio } : {}),
    ...(personSameAs.length ? { sameAs: personSameAs } : {}),
  };

  // Use show-level sameAs for the series block (back-compat name).
  const sameAs = showSameAs;

  if (!episode) {
    // Homepage: emit a graph of PodcastSeries + WebSite (with SearchAction)
    // + Person, so agents can resolve the host as an entity and find an
    // episode-search action without scraping HTML.
    const series = {
      "@type": "PodcastSeries",
      "@id": `${baseUrl}/#podcast`,
      name: config.title,
      description: config.description,
      url: baseUrl,
      image: cover,
      inLanguage: config.language,
      author: { "@id": `${baseUrl}/#author` },
      webFeed: `${baseUrl}/rss.xml`,
      ...(config.copyright ? { copyrightNotice: config.copyright } : {}),
      ...(config.license ? { license: config.license } : {}),
      ...(topics.length ? { keywords: topics.join(", ") } : {}),
      ...(sameAs.length ? { sameAs } : {}),
      speakable: {
        "@type": "SpeakableSpecification",
        cssSelector: ["h1", "header p"],
      },
    };

    const website = {
      "@type": "WebSite",
      "@id": `${baseUrl}/#website`,
      url: baseUrl,
      name: config.title,
      ...(config.description ? { description: config.description } : {}),
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${baseUrl}/api/search?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    };

    // The podcast as a `Product`. Listener-friendly framing: the show is
    // the offering; the audience can "acquire" it for free. Helps generic
    // entity-type checks (orank, etc.) recognize the offering even though
    // PodcastSeries is the schema.org-correct primary type.
    const product = {
      "@type": "Product",
      "@id": `${baseUrl}/#product`,
      name: config.title,
      description: config.description,
      url: baseUrl,
      image: cover,
      category: "Podcast",
      brand: { "@id": `${baseUrl}/#podcast` },
      ...(sameAs.length ? { sameAs } : {}),
      ...(topics.length ? { keywords: topics.join(", ") } : {}),
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        url: baseUrl,
        category: "Free",
      },
    };

    // Publisher organisation. Defaults to the host's name if no separate
    // publisher is configured. `@id` distinct from the Person so agents
    // can disambiguate "the show's publisher" from "the show's host".
    const organization = {
      "@type": "Organization",
      "@id": `${baseUrl}/#publisher`,
      name: config.publisher || config.author,
      url: baseUrl,
      logo: cover,
      ...(sameAs.length ? { sameAs } : {}),
    };

    // FAQ schema — surfaces high-intent listener questions for answer
    // engines. Mostly static, with a few config-driven fields.
    const platformList = [
      ["Spotify", config.spotify_url],
      ["Apple Podcasts", config.apple_podcasts_url],
      ["YouTube", config.youtube_url],
      ["Amazon Music", config.amazon_music_url],
    ].filter(([, u]) => u);
    const platformsAnswer = platformList.length
      ? "Subscribe via " +
        platformList.map(([n, u]) => `${n} (${u})`).join(", ") +
        `, or add ${baseUrl}/rss.xml to any podcast app.`
      : `Add ${baseUrl}/rss.xml to any podcast app.`;
    const faq = {
      "@type": "FAQPage",
      "@id": `${baseUrl}/#faq`,
      mainEntity: [
        {
          "@type": "Question",
          name: `How do I subscribe to ${config.title}?`,
          acceptedAnswer: { "@type": "Answer", text: platformsAnswer },
        },
        {
          "@type": "Question",
          name: `Is ${config.title} free?`,
          acceptedAnswer: {
            "@type": "Answer",
            text: config.pricing
              ? config.pricing
              : "Yes. Free, no signup, no ads, no paywall.",
          },
        },
        {
          "@type": "Question",
          name: `What language is ${config.title} in?`,
          acceptedAnswer: {
            "@type": "Answer",
            text: `Episodes are in ${config.language || "the show's language"}. Full transcripts are available alongside every episode.`,
          },
        },
        ...(config.update_frequency
          ? [
              {
                "@type": "Question",
                name: `How often does ${config.title} publish?`,
                acceptedAnswer: { "@type": "Answer", text: `New episodes ${config.update_frequency}.` },
              },
            ]
          : []),
        {
          "@type": "Question",
          name: `Can my AI agent use ${config.title}?`,
          acceptedAnswer: {
            "@type": "Answer",
            text: `Yes. The site exposes a Streamable HTTP MCP server at ${baseUrl}/mcp, a search API at ${baseUrl}/api/search, an NLWeb /ask endpoint at ${baseUrl}/ask, and discovery files under /.well-known/. See ${baseUrl}/AGENTS.md for the integration guide.`,
          },
        },
        {
          "@type": "Question",
          name: `Where can I read transcripts of ${config.title}?`,
          acceptedAnswer: {
            "@type": "Answer",
            text: `Every episode has a full transcript. Open any episode at ${baseUrl}/<id> or fetch the markdown at ${baseUrl}/<id>.md.`,
          },
        },
      ],
    };

    return {
      "@context": "https://schema.org",
      "@graph": [series, product, organization, website, person, faq],
    };
  }

  const epTopics = Array.isArray(episode.topics) ? episode.topics.filter(Boolean) : [];
  const epGuests = Array.isArray(episode.guests) ? episode.guests : [];

  const ld = {
    "@type": "PodcastEpisode",
    "@id": `${baseUrl}/${episode.id}#episode`,
    name: episode.title,
    description: episode.desc || "",
    url: `${baseUrl}/${episode.id}`,
    datePublished: episode.date,
    episodeNumber: episode.id,
    inLanguage: config.language,
    author: person,
    partOfSeries: {
      "@type": "PodcastSeries",
      "@id": `${baseUrl}/#podcast`,
      name: config.title,
      url: baseUrl,
    },
    associatedMedia: {
      "@type": "MediaObject",
      contentUrl: `${baseUrl}/${episode.audioFile}`,
      encodingFormat: "audio/mpeg",
    },
    image: `${baseUrl}/s${episode.season}e${episode.id}.${config.cover_ext || "png"}`,
    sameAs: [
      episode.spotifyUrl || null,
      episode.appleUrl || null,
      episode.amazonUrl || null,
    ].filter(Boolean),
  };

  if (episode.seconds) {
    const m = Math.floor(episode.seconds / 60);
    const s = episode.seconds % 60;
    ld.duration = `PT${m}M${s}S`;
  }

  // Transcript as a MediaObject — voice/answer engines that cite podcasts
  // pick this up directly. Gated on hasSrt so agents don't 404.
  if (episode.hasSrt) {
    const txtUrl = `${baseUrl}/${episode.audioFile.replace(".mp3", ".txt")}`;
    ld.transcript = {
      "@type": "MediaObject",
      contentUrl: txtUrl,
      encodingFormat: "text/plain",
      inLanguage: config.language,
    };
  }

  // Topics → schema.org `about` (Thing). Helps "podcast about X" queries.
  if (epTopics.length) {
    ld.about = epTopics.map((t) => ({ "@type": "Thing", name: t }));
    ld.keywords = epTopics.join(", ");
  }

  // Guests → schema.org `actor` (Person). Helps "podcast with <guest>" queries.
  if (epGuests.length) {
    ld.actor = epGuests
      .map((g) =>
        typeof g === "string"
          ? { "@type": "Person", name: g }
          : g.name
            ? { "@type": "Person", name: g.name, ...(g.url ? { url: g.url } : {}) }
            : null
      )
      .filter(Boolean);
  }

  // Chapters → schema.org `hasPart` (Clip with startOffset).
  if (Array.isArray(episode.chapters) && episode.chapters.length) {
    ld.hasPart = episode.chapters
      .map((c) => {
        const title = c.title || c.name;
        if (!title) return null;
        const startStr = c.start || c.time || "";
        let startOffset;
        if (startStr) {
          const parts = startStr.split(":").map(Number);
          if (parts.length === 3) startOffset = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) startOffset = parts[0] * 60 + parts[1];
        }
        return {
          "@type": "Clip",
          name: title,
          ...(Number.isFinite(startOffset) ? { startOffset } : {}),
        };
      })
      .filter(Boolean);
  }

  // Episode pages return a @graph: PodcastEpisode + BreadcrumbList. The
  // breadcrumb gives navigation context the homepage doesn't need.
  const breadcrumb = {
    "@type": "BreadcrumbList",
    "@id": `${baseUrl}/${episode.id}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: config.title, item: baseUrl },
      {
        "@type": "ListItem",
        position: 2,
        name: episode.title,
        item: `${baseUrl}/${episode.id}`,
      },
    ],
  };

  return {
    "@context": "https://schema.org",
    "@graph": [ld, breadcrumb],
  };
}

// ─── Agent-mode JSON view ─────────────────────────────────────────────────
// Compact response served for `?mode=agent`. Pure capability + endpoint
// inventory; agents drill into the inventory for richer data instead of
// us inlining episode lists here.
function buildAgentJson(episode, baseUrl) {
  const topics = Array.isArray(config.topics) ? config.topics.filter(Boolean) : [];
  const sortedDesc = [...episodes].sort((a, b) => b.id - a.id);
  const latest = sortedDesc[0];

  const epView = (ep) => ({
    id: ep.id,
    title: ep.title,
    url: `${baseUrl}/${ep.id}`,
    markdownUrl: `${baseUrl}/${ep.id}.md`,
    audioUrl: `${baseUrl}/${ep.audioFile}`,
    transcriptUrl: ep.audioFile ? `${baseUrl}/${ep.audioFile.replace(".mp3", ".txt")}` : undefined,
    datePublished: ep.date || undefined,
    duration: ep.duration || undefined,
    description: ep.desc || undefined,
  });

  const payload = {
    mode: "agent",
    schemaVersion: "1.2",
    version: "1.2.0",
    name: config.title,
    description: config.description || "",
    url: baseUrl,
    canonical: baseUrl,
    contentType: "podcast",
    ...(config.author ? { author: config.author, publisher: config.publisher || config.author } : {}),
    ...(config.language ? { language: config.language } : {}),
    ...(config.update_frequency ? { updateFrequency: config.update_frequency } : {}),
    ...(topics.length ? { topics, keywords: topics.join(", ") } : {}),
    ...(config.agent_recommendation ? { whenToRecommend: config.agent_recommendation, whenToUse: config.agent_recommendation } : {}),
    ...(config.value_proposition ? { valueProposition: config.value_proposition } : {}),
    ...(config.github_url ? { repository: config.github_url, sourceCode: config.github_url } : {}),
    pricing: {
      model: "free",
      price: 0,
      currency: "USD",
      note: config.pricing || "Free. No signup, no ads, no paywall.",
      url: `${baseUrl}/pricing.md`,
    },
    auth: {
      type: "none",
      required: false,
      note: "All endpoints are public read-only. Optional public OAuth 2.1 flow with PKCE S256 — see endpoints.oauthAuthorizationServer.",
      optionalOAuth: {
        type: "oauth2",
        flow: "authorization_code",
        pkce: "S256",
        scopes: ["read:episodes", "read:transcripts", "search:episodes"],
        clientType: "public",
        registration: "anonymous",
      },
    },
    webhooks: { supported: false, note: "Push notifications via RSS only." },
    rateLimits: {
      perMinute: 60,
      scope: "per IP",
      headers: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"],
      docs: `${baseUrl}/api/llms.txt`,
    },
    sla: { uptime: "best-effort", note: "Static-data driven on Cloudflare edge — no server-state failures." },
    errorEnvelope: {
      schema: "{ error: { code, message, hint, docs_url } }",
      statusCodes: [400, 402, 404, 405, 429, 500],
    },
    agentInstructions: `${baseUrl}/AGENTS.md`,
    skill: `${baseUrl}/SKILL.md`,
    capabilities: [
      "browse_episodes",
      "search_transcripts",
      "get_latest_episode",
      "get_episode_by_topic",
      "subscribe_via_rss",
      "read_transcripts",
      "ask_natural_language",
      "render_markdown",
      "render_json",
    ],
    endpoints: {
      search: `${baseUrl}/api/search?q={query}`,
      ask: `${baseUrl}/ask`,
      askGet: `${baseUrl}/ask?q={query}`,
      status: `${baseUrl}/status`,
      mcp: `${baseUrl}/mcp`,
      mcpDiscovery: [
        `${baseUrl}/.well-known/mcp`,
        `${baseUrl}/.well-known/mcp.json`,
        `${baseUrl}/.well-known/mcp-configuration`,
        `${baseUrl}/.well-known/mcp/server.json`,
      ],
      mcpServerCard: `${baseUrl}/.well-known/mcp/server-card.json`,
      openapi: `${baseUrl}/.well-known/openapi.json`,
      agentJson: `${baseUrl}/.well-known/agent.json`,
      agentCard: `${baseUrl}/.well-known/agent-card.json`,
      agentSkillsIndex: `${baseUrl}/.well-known/agent-skills/index.json`,
      schemaMap: `${baseUrl}/.well-known/schema-map.xml`,
      apiCatalog: `${baseUrl}/.well-known/api-catalog`,
      webBotAuth: `${baseUrl}/.well-known/http-message-signatures-directory`,
      oauthAuthorizationServer: `${baseUrl}/.well-known/oauth-authorization-server`,
      oauthProtectedResource: `${baseUrl}/.well-known/oauth-protected-resource`,
      openidConfiguration: `${baseUrl}/.well-known/openid-configuration`,
      oauthAuthorize: `${baseUrl}/oauth/authorize`,
      oauthToken: `${baseUrl}/oauth/token`,
      oauthRegister: `${baseUrl}/oauth/register`,
      oauthJwks: `${baseUrl}/oauth/jwks.json`,
      donate: `${baseUrl}/donate`,
      x402Discovery: `${baseUrl}/.well-known/discovery/resources`,
      x402Supported: `${baseUrl}/.well-known/x402/supported`,
      rss: `${baseUrl}/rss.xml`,
      sitemap: `${baseUrl}/sitemap.xml`,
      robots: `${baseUrl}/robots.txt`,
      episodes: `${baseUrl}/episodes.json`,
      searchIndex: `${baseUrl}/search-index.json`,
      llms: `${baseUrl}/llms.txt`,
      llmsFull: `${baseUrl}/llms-full.txt`,
      episodesLlms: `${baseUrl}/episodes/llms.txt`,
      apiLlms: `${baseUrl}/api/llms.txt`,
      docsLlms: `${baseUrl}/docs/llms.txt`,
      wellKnownLlms: `${baseUrl}/.well-known/llms.txt`,
      indexMarkdown: `${baseUrl}/index.md`,
      docs: `${baseUrl}/docs.md`,
      pricing: `${baseUrl}/pricing.md`,
      agents: `${baseUrl}/AGENTS.md`,
      skillManifest: `${baseUrl}/SKILL.md`,
      ...(config.owner_email ? { support: `mailto:${config.owner_email}` } : {}),
    },
    ...(episode
      ? { episode: epView(episode) }
      : latest
        ? { latestEpisode: epView(latest), totalEpisodes: sortedDesc.length }
        : {}),
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: apiHeaders({
      "Cache-Control": HTML_CACHE_CONTROL,
      Vary: "Accept",
      Link: linkHeader(baseUrl, episode),
    }),
  });
}

// ─── Markdown view ────────────────────────────────────────────────────────
// Episode-level markdown (homepage markdown is the static /index.md). Same
// content as the SSR HTML, formatted for agent consumption.
function buildEpisodeMarkdown(episode, baseUrl) {
  const lines = [];
  lines.push(`# ${episode.title}`);
  lines.push("");
  const meta = [episode.date, `S${episode.season}E${episode.id}`, episode.duration].filter(Boolean).join(" · ");
  if (meta) {
    lines.push(`*${meta}*`);
    lines.push("");
  }
  if (episode.desc) {
    lines.push(episode.desc);
    lines.push("");
  }
  lines.push(`**Audio:** ${baseUrl}/${episode.audioFile}`);
  if (episode.hasSrt) {
    const txt = episode.audioFile.replace(".mp3", ".txt");
    lines.push(`**Transcript:** ${baseUrl}/${txt}`);
  }
  lines.push(`**Episode page:** ${baseUrl}/${episode.id}`);
  lines.push("");

  if (Array.isArray(episode.topics) && episode.topics.length) {
    lines.push("## Topics");
    for (const t of episode.topics) lines.push(`- ${t}`);
    lines.push("");
  }
  if (Array.isArray(episode.guests) && episode.guests.length) {
    lines.push("## Guests");
    for (const g of episode.guests) {
      if (typeof g === "string") lines.push(`- ${g}`);
      else if (g?.name) lines.push(g.url ? `- [${g.name}](${g.url})` : `- ${g.name}`);
    }
    lines.push("");
  }
  if (Array.isArray(episode.chapters) && episode.chapters.length) {
    lines.push("## Chapters");
    for (const c of episode.chapters) {
      const title = c.title || c.name;
      if (!title) continue;
      const t = c.start || c.time || "";
      lines.push(t ? `- ${t} — ${title}` : `- ${title}`);
    }
    lines.push("");
  }

  if (episode.fullText) {
    lines.push("## Transcript");
    lines.push("");
    for (const para of episode.fullText.split("\n").filter(Boolean)) {
      lines.push(para);
      lines.push("");
    }
  }

  lines.push("## For agents");
  lines.push(`- JSON view: \`${baseUrl}/${episode.id}?mode=agent\``);
  lines.push(`- Search API: \`GET ${baseUrl}/api/search?q=<query>\``);
  lines.push(`- MCP server: ${baseUrl}/mcp`);
  lines.push(`- All episodes: ${baseUrl}/episodes/llms.txt`);
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: apiHeaders({
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": HTML_CACHE_CONTROL,
      Vary: "Accept",
      Link: linkHeader(baseUrl, episode),
    }),
  });
}

function wantsAgentMode(url) {
  return url.searchParams.get("mode") === "agent";
}

function wantsMarkdown(request) {
  const accept = request.headers.get("accept") || "";
  // Match `text/markdown` even with parameters (q-values, charset).
  return /\btext\/markdown\b/i.test(accept);
}

function wantsApplicationJson(request) {
  const accept = request.headers.get("accept") || "";
  // Strict — only when the client explicitly asks for JSON (not `*/*`).
  return /\bapplication\/json\b/i.test(accept);
}

// ─── /.well-known/mcp* manifest + live handshake ──────────────────────────
// Multiple URL spellings, one manifest body. Cheap announcement surface for
// any client that probes a candidate well-known path. POST routes to the
// real MCP JSON-RPC handler (orank-style "live handshake" check).
const WELL_KNOWN_MCP_PATHS = new Set([
  "/.well-known/mcp",
  "/.well-known/mcp.json",
  "/.well-known/mcp-configuration",
  "/.well-known/mcp/server.json",
]);
const WELL_KNOWN_MCP_SERVER_CARD = "/.well-known/mcp/server-card.json";

function buildMcpManifest(baseUrl) {
  return new Response(
    JSON.stringify(
      {
        $schema: "https://modelcontextprotocol.io/schemas/discovery.json",
        name: MCP_SERVER_INFO.name,
        title: config.title,
        description: config.description || "",
        version: MCP_SERVER_INFO.version,
        protocolVersion: MCP_PROTOCOL_VERSION,
        transport: "streamable-http",
        url: `${baseUrl}/mcp`,
        endpoint: `${baseUrl}/mcp`,
        // Same well-known URL also accepts POST for the live handshake.
        handshakeUrl: `${baseUrl}/.well-known/mcp`,
        serverCard: `${baseUrl}${WELL_KNOWN_MCP_SERVER_CARD}`,
        servers: [{ url: `${baseUrl}/mcp`, transport: "streamable-http" }],
        methods: ["initialize", "ping", "tools/list", "tools/call"],
        documentation: `${baseUrl}/.well-known/openapi.json`,
        // Auth — optional public OAuth 2.1 + PKCE S256. Clients that probe
        // for an authorization-server URL (orank, MCP auth checks) find one;
        // clients that skip auth altogether also work.
        auth: {
          type: "oauth2",
          required: false,
          flows: ["authorization_code", "client_credentials"],
          pkce: "S256",
          scopes: ["read:episodes", "read:transcripts", "search:episodes"],
          authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
          protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
          openid_configuration: `${baseUrl}/.well-known/openid-configuration`,
          authorize: `${baseUrl}/oauth/authorize`,
          token: `${baseUrl}/oauth/token`,
          publicClientId: "public",
        },
      },
      null,
      2
    ) + "\n",
    {
      headers: apiHeaders({
        "Cache-Control": HTML_CACHE_CONTROL,
        // RFC 6750: advertise the protected-resource metadata location so
        // 401-aware clients can find OAuth metadata even when auth isn't
        // required. Helps orank's MCP-auth-mechanism probe.
        "WWW-Authenticate": `Bearer realm="${baseUrl}", scope="read:episodes read:transcripts search:episodes", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      }),
    }
  );
}

// MCP server-card.json — preview-able card describing the server before an
// agent opens a transport connection. Schema: name, description, version,
// serverUrl, tools[].
function buildMcpServerCard(baseUrl) {
  const card = {
    $schema: "https://modelcontextprotocol.io/schemas/server-card.json",
    name: MCP_SERVER_INFO.name,
    title: config.title,
    description:
      `Listener-facing MCP server for ${config.title}. ` +
      "Search episodes, fetch transcripts, get the latest, browse the catalog, and grab the RSS feed for subscription.",
    version: MCP_SERVER_INFO.version,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "streamable-http",
    serverUrl: `${baseUrl}/mcp`,
    handshakeUrl: `${baseUrl}/.well-known/mcp`,
    documentation: `${baseUrl}/.well-known/openapi.json`,
    publisher: config.author || undefined,
    contentType: "podcast",
    language: config.language || undefined,
    auth: {
      type: "oauth2",
      required: false,
      pkce: "S256",
      flows: ["authorization_code", "client_credentials"],
      authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
      protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
      scopes: ["read:episodes", "read:transcripts", "search:episodes"],
      publicClientId: "public",
    },
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
  return new Response(JSON.stringify(card, null, 2) + "\n", {
    headers: apiHeaders({ "Cache-Control": HTML_CACHE_CONTROL }),
  });
}

// ─── RFC 8288 Link header ─────────────────────────────────────────────────
// Advertises sitemap, markdown alternates, OpenAPI service description,
// agent.json/agent-card, llms.txt, and the MCP server. Cheap, broadcasts
// every machine-readable representation of the resource.
function linkHeader(baseUrl, episode) {
  const mdAlternate = episode ? `${baseUrl}/${episode.id}.md` : `${baseUrl}/index.md`;
  const links = [
    `<${baseUrl}/sitemap.xml>; rel="sitemap"`,
    `<${mdAlternate}>; rel="alternate"; type="text/markdown"`,
    `<${baseUrl}/llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt"`,
    `<${baseUrl}/.well-known/openapi.json>; rel="service-desc"; type="application/json"`,
    `<${baseUrl}/.well-known/agent.json>; rel="describedby"; type="application/json"`,
    `<${baseUrl}/.well-known/agent-card.json>; rel="alternate"; type="application/json"; title="agent-card"`,
    `<${baseUrl}/.well-known/agent-skills/index.json>; rel="alternate"; type="application/json"; title="agent-skills"`,
    `<${baseUrl}/.well-known/schema-map.xml>; rel="alternate"; type="application/xml"; title="schemamap"`,
    `<${baseUrl}/mcp>; rel="mcp"; type="application/json"`,
    `<${baseUrl}/.well-known/mcp>; rel="mcp"; type="application/json"`,
    `<${baseUrl}/rss.xml>; rel="alternate"; type="application/rss+xml"`,
  ];
  return links.join(", ");
}

function getThemeFromCookie(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)theme=(dark|light)/);
  return match ? match[1] : config.default_theme || "dark";
}

// Process {{#if KEY}}...{{/if}} conditionals in label text against config
function processConditionals(text) {
  return (text || "")
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) =>
      config[key] ? content : ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const L = config.labels;

function buildEpisodeHtml(ep) {
  const parts = [`<article>`];
  parts.push(`<h2><a href="/${ep.id}">${esc(ep.title)}</a></h2>`);
  parts.push(`<p>${L.season} ${ep.season} · ${L.episode} ${ep.id}`);
  if (ep.duration) parts.push(` · ${esc(ep.duration)}`);
  if (ep.date) parts.push(` · <time datetime="${ep.date}">${ep.date}</time>`);
  parts.push(`</p>`);
  if (ep.desc) parts.push(`<p>${esc(ep.desc)}</p>`);
  parts.push(`</article>`);
  return parts.join("");
}

// Build SSR content: real HTML visible before JS executes.
// React replaces this on mount.
function buildSsrContent(episode) {
  if (!episode) {
    // Homepage — render all episodes grouped by latest first
    const sorted = [...episodes].sort((a, b) => b.id - a.id);
    const parts = [
      `<header><h1>${esc(config.title)}</h1><p>${esc(config.description)}</p></header>`,
      `<section>`,
    ];
    for (const ep of sorted) {
      parts.push(buildEpisodeHtml(ep));
    }
    parts.push(`</section>`);
    return parts.join("");
  }

  // Episode page — full detail with transcript
  const parts = [`<article>`];
  parts.push(`<h1>${esc(episode.title)}</h1>`);
  parts.push(`<p>${L.season} ${episode.season} · ${L.episode} ${episode.id}`);
  if (episode.duration) parts.push(` · ${esc(episode.duration)}`);
  if (episode.date) parts.push(` · <time datetime="${episode.date}">${episode.date}</time>`);
  parts.push(`</p>`);
  if (episode.desc) parts.push(`<p>${esc(episode.desc)}</p>`);
  if (episode.fullText) {
    parts.push(`<div>`);
    for (const para of episode.fullText.split("\n").filter(Boolean)) {
      parts.push(`<p>${esc(para)}</p>`);
    }
    parts.push(`</div>`);
  }
  parts.push(`<audio src="/${esc(episode.audioFile)}" preload="none"></audio>`);
  parts.push(`</article>`);
  return parts.join("");
}

function buildStaticSsr(title, text) {
  const parts = [`<article>`, `<h1>${esc(title)}</h1>`];
  for (const para of (text || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
    parts.push(`<p>${esc(para)}</p>`);
  }
  parts.push(`</article>`);
  return parts.join("");
}

function getBaseUrl(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function renderStaticPage(kind, request) {
  const theme = getThemeFromCookie(request);
  const themeColor = theme === "light" ? (config.bg_light || "#fafaf9") : (config.bg_dark || "#0a0a0b");
  const baseUrl = getBaseUrl(request);
  const title = kind === "terms" ? L.terms : L.privacy;
  const rawText = kind === "terms" ? L.terms_text : L.privacy_text;
  const text = processConditionals(rawText);
  const pageTitle = `${title} | ${config.title}`;
  const canonical = `${baseUrl}/${kind}`;
  const desc = esc(title);

  const ogTags = `
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${desc}">
  <meta name="theme-color" content="${themeColor}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:type" content="article">
  <meta property="og:locale" content="${config.locale}">
  <meta name="robots" content="noindex,follow">`;

  const nonce = crypto.randomUUID();
  const html = template
    .replace("<!--OG_TAGS-->", ogTags)
    .replace("__EP_JSON__", "null")
    .replace("__SEARCH_JSON__", JSON.stringify({ staticPage: kind }))
    .replace("__SSR_CONTENT__", buildStaticSsr(title, text))
    .replace("__SSR_H1__", esc(title))
    .replace(/<html\b/, `<html data-theme="${theme}"`)
    .replace(/\{\{CSP_NONCE\}\}/g, nonce);

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": HTML_CACHE_CONTROL,
    Vary: "Accept",
    Link: linkHeader(baseUrl, null),
    ...securityHeaders(nonce),
  });
  return new Response(html, { headers });
}

function renderPage(episode, request) {
  const theme = getThemeFromCookie(request);
  const themeColor = theme === "light" ? (config.bg_light || "#fafaf9") : (config.bg_dark || "#0a0a0b");
  const baseUrl = getBaseUrl(request);

  const title = episode
    ? `${L.episode} ${episode.id}: ${esc(episode.title)}`
    : config.title;
  const pageTitle = episode ? `${title} | ${config.title}` : config.title;
  const desc = esc(
    episode?.desc || config.description
  );
  const ogImage = episode
    ? `${baseUrl}/s${episode.season}e${episode.id}.${config.cover_ext || "png"}`
    : `${baseUrl}${config.cover}`;
  // Escape </ sequences to prevent </script> breakout in JSON-LD
  const jsonLd = JSON.stringify(buildJsonLd(episode, baseUrl)).replace(/</g, "\\u003c");

  const canonical = `${baseUrl}/${episode?.id || ""}`;
  const audioUrl = episode ? `${baseUrl}/${episode.audioFile}` : "";

  const ogTags = `
  <title>${pageTitle}</title>
  <meta name="description" content="${desc}">
  <meta name="theme-color" content="${themeColor}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">${audioUrl ? `\n  <meta property="og:audio" content="${audioUrl}">\n  <meta property="og:audio:type" content="audio/mpeg">` : ""}
  <meta property="og:image" content="${ogImage}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:type" content="${episode ? "article" : "website"}">
  <meta property="og:locale" content="${config.locale}">${episode?.date ? `\n  <meta property="article:published_time" content="${episode.date}">` : ""}
  <meta name="twitter:card" content="summary_large_image">${config.x_username ? `\n  <meta name="twitter:site" content="@${config.x_username}">` : ""}
  <script type="application/ld+json">${jsonLd}</script>`;

  // Preload episode resources so the browser fetches them in parallel with
  // the JS bundle instead of waiting for React to request them.
  let preloadHints = "";
  if (episode) {
    const txtFile = episode.audioFile.replace(".mp3", ".txt");
    preloadHints += `\n  <link rel="preload" href="/${txtFile}" as="fetch" crossorigin>`;
    if (episode.hasSrt) {
      preloadHints += `\n  <link rel="preload" href="/${episode.srtFile}" as="fetch" crossorigin>`;
    }
  }

  const ssrH1 = episode ? esc(episode.title) : esc(config.title);

  const nonce = crypto.randomUUID();
  const html = template
    .replace("<!--OG_TAGS-->", ogTags)
    .replace("__EP_JSON__", JSON.stringify(episode || null))
    .replace("__SEARCH_JSON__", "null")
    .replace("__SSR_CONTENT__", buildSsrContent(episode))
    .replace("__SSR_H1__", ssrH1)
    .replace(/<html\b/, `<html data-theme="${theme}"`)
    .replace("</head>", `${preloadHints}\n  </head>`)
    .replace(/\{\{CSP_NONCE\}\}/g, nonce);

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": HTML_CACHE_CONTROL,
    Vary: "Accept",
    Link: linkHeader(baseUrl, episode),
    ...securityHeaders(nonce),
  });
  return new Response(html, { headers });
}

function redirect301(url) {
  return new Response(null, {
    status: 301,
    headers: { Location: url },
  });
}


async function serveR2(env, key, request) {
  if (!env?.R2_BUCKET) return null;
  const rangeHeader = request.headers.get("Range");
  let options = {};
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1]) : undefined;
      const end = m[2] ? parseInt(m[2]) : undefined;
      options.range = {};
      if (start !== undefined) options.range.offset = start;
      if (end !== undefined && start !== undefined) options.range.length = end - start + 1;
    }
  }
  const obj = await env.R2_BUCKET.get(key, options);
  if (!obj) return null;
  const ext = key.split(".").pop().toLowerCase();
  const headers = new Headers();
  headers.set("Content-Type", CONTENT_TYPES[ext] || obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=604800");
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
  if (rangeHeader && obj.range) {
    headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(obj.range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// Static files that embed absolute URLs via a `{{SITE_URL}}` placeholder,
// rewritten per-request so the same artifact works on any hostname.
const SITE_URL_REWRITES = new Set([
  "/rss.xml",
  "/sitemap.xml",
  "/llms.txt",
  "/robots.txt",
  "/index.md",
  "/episodes/llms.txt",
  "/api/llms.txt",
  "/docs/llms.txt",
  "/.well-known/llms.txt",
  "/.well-known/agent.json",
  "/.well-known/agent-card.json",
  "/.well-known/schema-map.xml",
  "/.well-known/openapi.json",
  "/.well-known/agent-skills/index.json",
  "/.well-known/ai-plugin.json",
  "/.well-known/api-catalog",
  "/.well-known/http-message-signatures-directory",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/openid-configuration",
  "/.well-known/x402/supported",
  "/.well-known/discovery/resources",
  "/AGENTS.md",
  "/docs.md",
  "/pricing.md",
  "/llms-full.txt",
  "/SKILL.md",
]);

const REWRITE_CONTENT_TYPES = {
  "/rss.xml": "application/rss+xml; charset=utf-8",
  "/sitemap.xml": "application/xml; charset=utf-8",
  "/llms.txt": "text/plain; charset=utf-8",
  "/robots.txt": "text/plain; charset=utf-8",
  "/index.md": "text/markdown; charset=utf-8",
  "/episodes/llms.txt": "text/plain; charset=utf-8",
  "/api/llms.txt": "text/plain; charset=utf-8",
  "/docs/llms.txt": "text/plain; charset=utf-8",
  "/.well-known/llms.txt": "text/plain; charset=utf-8",
  "/.well-known/agent.json": "application/json; charset=utf-8",
  "/.well-known/agent-card.json": "application/json; charset=utf-8",
  "/.well-known/schema-map.xml": "application/xml; charset=utf-8",
  "/.well-known/openapi.json": "application/json; charset=utf-8",
  "/.well-known/agent-skills/index.json": "application/json; charset=utf-8",
  "/.well-known/ai-plugin.json": "application/json; charset=utf-8",
  "/.well-known/api-catalog": 'application/linkset+json;profile="https://www.rfc-editor.org/info/rfc9727"; charset=utf-8',
  "/.well-known/http-message-signatures-directory": "application/json; charset=utf-8",
  "/.well-known/oauth-authorization-server": "application/json; charset=utf-8",
  "/.well-known/oauth-protected-resource": "application/json; charset=utf-8",
  "/.well-known/openid-configuration": "application/json; charset=utf-8",
  "/.well-known/x402/supported": "application/json; charset=utf-8",
  "/.well-known/discovery/resources": "application/json; charset=utf-8",
  "/AGENTS.md": "text/markdown; charset=utf-8",
  "/docs.md": "text/markdown; charset=utf-8",
  "/pricing.md": "text/markdown; charset=utf-8",
  "/llms-full.txt": "text/plain; charset=utf-8",
  "/SKILL.md": "text/markdown; charset=utf-8",
};

const REWRITE_CACHE_CONTROL = {
  "/rss.xml": "public, max-age=300, stale-while-revalidate=604800",
  "/sitemap.xml": "public, max-age=3600, stale-while-revalidate=604800",
  "/llms.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/index.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/episodes/llms.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/api/llms.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/docs/llms.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/llms.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/agent.json": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/agent-card.json": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/schema-map.xml": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/openapi.json": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/agent-skills/index.json": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/ai-plugin.json": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/api-catalog": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/http-message-signatures-directory": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/oauth-authorization-server": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/oauth-protected-resource": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/openid-configuration": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/x402/supported": "public, max-age=3600, stale-while-revalidate=604800",
  "/.well-known/discovery/resources": "public, max-age=3600, stale-while-revalidate=604800",
  "/AGENTS.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/docs.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/pricing.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/llms-full.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/SKILL.md": "public, max-age=3600, stale-while-revalidate=604800",
};

// Cache rules for static files served through middleware (mirrors _headers)
const STATIC_CACHE_RULES = {
  "/episodes.json": "public, max-age=60, stale-while-revalidate=604800",
  "/search-index.json": "public, max-age=60, stale-while-revalidate=604800",
  "/cover.png": "public, max-age=86400, stale-while-revalidate=604800",
};

const ASSETS_CACHE_CONTROL = "public, max-age=31536000, immutable";

async function rewriteSiteUrl(request, next) {
  const resp = await next();
  const text = await resp.text();
  const baseUrl = getBaseUrl(request);
  const rewritten = text.replace(/\{\{SITE_URL\}\}/g, baseUrl);
  const headers = new Headers(resp.headers);
  const path = new URL(request.url).pathname;
  if (REWRITE_CONTENT_TYPES[path]) headers.set("Content-Type", REWRITE_CONTENT_TYPES[path]);
  if (REWRITE_CACHE_CONTROL[path]) headers.set("Cache-Control", REWRITE_CACHE_CONTROL[path]);
  headers.set("Content-Length", String(new TextEncoder().encode(rewritten).length));
  return new Response(rewritten, { status: resp.status, headers });
}

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const ua = request.headers.get("user-agent") || "";
  const bot = BOTS.test(ua);
  const baseUrl = getBaseUrl(request);

  // MCP discovery — multiple well-known spellings, one manifest. Handle
  // before the static-asset branch so the `.json` suffix doesn't fall
  // through to the Pages asset server. POST routes to the live JSON-RPC
  // handler so agents can initialize directly at the well-known URL.
  if (WELL_KNOWN_MCP_PATHS.has(path)) {
    if (request.method === "POST") return handleMcpPost(request);
    if (request.method === "GET" || request.method === "HEAD") return buildMcpManifest(baseUrl);
    return errors.methodNotAllowed("GET, POST, OPTIONS");
  }
  if (path === WELL_KNOWN_MCP_SERVER_CARD) {
    if (request.method === "GET" || request.method === "HEAD") return buildMcpServerCard(baseUrl);
    return errors.methodNotAllowed("GET, OPTIONS");
  }

  // Absolute-URL placeholders in generated static files
  if (SITE_URL_REWRITES.has(path)) {
    return rewriteSiteUrl(request, next);
  }

  // Pages Functions (search API, MCP server, /ask, /status, /oauth/*,
  // /donate) handle their own paths. Pass through so file-based routes
  // under functions/ can run.
  if (
    path === "/mcp" ||
    path === "/ask" ||
    path === "/status" ||
    path === "/donate" ||
    path.startsWith("/api/") ||
    path.startsWith("/oauth/")
  ) {
    return next();
  }

  // Episode markdown view (/<NN>.md) — must run BEFORE the static-asset
  // branch below, which would otherwise serve a 404 from Pages for the
  // `.md` extension.
  const epMdMatch = path.match(/^\/(\d{1,3})\.md$/);
  if (epMdMatch) {
    const id = parseInt(epMdMatch[1]);
    const ep = episodes.find((e) => e.id === id);
    if (!ep) return errors.episodeNotFound(id);
    return buildEpisodeMarkdown(ep, baseUrl);
  }

  // /docs and /pricing aliases → serve the corresponding .md bytes with
  // markdown content-type. Pages routes by URL path, so we can't simply
  // call next() with a rewritten URL — fetch the static asset via
  // env.ASSETS instead.
  const ALIAS_TO_FILE = { "/docs": "/docs.md", "/pricing": "/pricing.md" };
  if (ALIAS_TO_FILE[path]) {
    const target = ALIAS_TO_FILE[path];
    if (env?.ASSETS) {
      const url = new URL(request.url);
      url.pathname = target;
      const upstream = await env.ASSETS.fetch(new Request(url, request));
      const text = (await upstream.text()).replace(/\{\{SITE_URL\}\}/g, baseUrl);
      return new Response(text, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": REWRITE_CACHE_CONTROL[target],
          Vary: "Accept",
          Link: linkHeader(baseUrl, null),
        },
      });
    }
    // No ASSETS binding (shouldn't happen on Pages) → redirect.
    return redirect301(target);
  }

  // Static assets: pass through to Pages with cache headers
  if (
    path.match(/\.\w{2,5}$/) ||
    path.startsWith("/assets/")
  ) {
    // Media files → serve from R2
    if (MEDIA_PATTERN.test(path)) {
      const key = path.slice(1); // strip leading /
      const r2Response = await serveR2(env, key, request);
      if (r2Response) return r2Response;
    }
    const resp = await next();
    // Pages' SPA fallback returns index.html (200, text/html) for any missing
    // path. For an extensioned/asset request that's a real 404 — surface it.
    const respType = resp.headers.get("content-type") || "";
    if (resp.status === 200 && /^text\/html\b/i.test(respType) && !/\.html?$/i.test(path)) {
      return errors.notFound(path);
    }
    const cacheControl = path.startsWith("/assets/")
      ? ASSETS_CACHE_CONTROL
      : STATIC_CACHE_RULES[path];
    if (cacheControl) {
      const headers = new Headers(resp.headers);
      headers.set("Cache-Control", cacheControl);
      return new Response(resp.body, { status: resp.status, headers });
    }
    return resp;
  }

  // Old Transistor slugs: /episodes/slug-34-... → 301 to /34
  if (path.startsWith("/episodes/") && config.legacy_slug_pattern) {
    const decoded = decodeURIComponent(path);
    const m = decoded.match(new RegExp(config.legacy_slug_pattern));
    return redirect301(m ? `/${m[1]}` : "/");
  }

  // Old /subscribe → 301 to /
  if (path === "/subscribe") {
    return redirect301("/");
  }

  // Episode: /NN with optional ?mode=agent or Accept: text/markdown.
  // (The /NN.md form is handled earlier, before the static-asset branch.)
  const epMatch = path.match(/^\/(\d{1,3})$/);
  if (epMatch) {
    const id = parseInt(epMatch[1]);
    const ep = episodes.find((e) => e.id === id);
    const wantsJson = wantsAgentMode(url) || wantsApplicationJson(request);
    if (!ep) {
      // Agent context → real 404 with JSON envelope. Browsers → 301 to home.
      return wantsJson || wantsMarkdown(request) ? errors.episodeNotFound(id) : redirect301("/");
    }
    if (wantsAgentMode(url) || wantsApplicationJson(request)) return buildAgentJson(ep, baseUrl);
    if (wantsMarkdown(request)) return buildEpisodeMarkdown(ep, baseUrl);
    return renderPage(ep, request);
  }

  // Legal pages
  if (path === "/terms" && L.terms && L.terms_text) {
    return renderStaticPage("terms", request);
  }
  if (path === "/privacy" && L.privacy && L.privacy_text) {
    return renderStaticPage("privacy", request);
  }

  // Homepage — agent JSON view, markdown negotiation, or HTML
  if (path === "/" || path === "") {
    if (wantsAgentMode(url)) return buildAgentJson(null, baseUrl);
    if (wantsMarkdown(request)) {
      // Pages routes by URL path — next() can't be re-pointed at /index.md.
      // Fetch the static asset via env.ASSETS instead and serve it with the
      // markdown content-type and the correct Vary/Link/cache headers.
      if (env?.ASSETS) {
        const mdUrl = new URL(request.url);
        mdUrl.pathname = "/index.md";
        const upstream = await env.ASSETS.fetch(new Request(mdUrl, request));
        const text = (await upstream.text()).replace(/\{\{SITE_URL\}\}/g, baseUrl);
        return new Response(text, {
          status: upstream.status,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": REWRITE_CACHE_CONTROL["/index.md"],
            Vary: "Accept",
            Link: linkHeader(baseUrl, null),
          },
        });
      }
      return redirect301("/index.md");
    }
    return renderPage(null, request);
  }

  // Catch-all: 301 to home
  return redirect301("/");
}
