import template from "./_html-template.js";
import episodes from "./_episodes.js";
import config from "./_config.js";
import { apiHeaders, errors, rateLimitHeaders } from "./_api.js";
import { handleMcpPost, buildMcpGetManifest, mcpCsp, TOOLS as MCP_TOOLS, SERVER_INFO as MCP_SERVER_INFO, PROTOCOL_VERSION as MCP_PROTOCOL_VERSION } from "./mcp.js";
import { buildUiHttpResponse } from "./_mcp_apps.js";
import * as commerce from "./_commerce.js";
import * as webhooks from "./_webhooks.js";

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

// AggregateRating sourced from the per-platform listener ratings in
// podcast.yaml (`ratings:`). Only Apple Podcasts and Spotify are read —
// they're the only platforms that expose a public podcast star rating.
// Rather than averaging, the homepage surfaces the single best platform:
// highest rating wins, ties broken by review count (5.0 from 10 reviews
// beats 4.5 from 20). Returns null when neither is configured — the
// @graph then omits the node rather than emitting a fake.
function buildAggregateRating() {
  const src = config.ratings && typeof config.ratings === "object" ? config.ratings : {};
  let best = null;
  for (const key of ["apple", "spotify"]) {
    const entry = src[key] || {};
    const rating = Number(entry.rating);
    const reviews = Number(entry.reviews);
    if (!(rating > 0) || !(reviews > 0)) continue;
    if (
      !best ||
      rating > best.rating ||
      (rating === best.rating && reviews > best.reviews)
    ) {
      best = { rating: Math.min(rating, 5), reviews };
    }
  }
  if (!best) return null;
  return {
    "@type": "AggregateRating",
    ratingValue: Math.round(best.rating * 10) / 10,
    bestRating: 5,
    worstRating: 1,
    ratingCount: best.reviews,
    reviewCount: best.reviews,
  };
}

// FAQPage built from the localizable `labels.faqs` list in podcast.yaml.
// Each entry is a { q, a } pair; coil ships an English default set and
// each deployment can translate it in its own podcast.yaml. Question and
// answer text may use placeholder tokens — {title}, {site}, {language},
// {frequency}, {platforms} — filled in here so translated copy still
// renders real URLs and platform names. Returns null when none are set.
function buildFaqPage(baseUrl) {
  const list = Array.isArray(config.labels?.faqs) ? config.labels.faqs : [];
  const entries = list.filter((f) => {
    if (!f || !f.q || !f.a) return false;
    // Drop the publishing-cadence question when no update_frequency is set.
    if (!config.update_frequency && /\{frequency\}/.test(`${f.q} ${f.a}`)) return false;
    return true;
  });
  if (!entries.length) return null;

  const platformList = [
    [config.labels?.spotify || "Spotify", config.spotify_url],
    [config.labels?.apple || "Apple Podcasts", config.apple_podcasts_url],
    [config.labels?.youtube || "YouTube", config.youtube_url],
    [config.labels?.amazon || "Amazon Music", config.amazon_music_url],
  ].filter(([, u]) => u);
  const platforms = platformList.length
    ? platformList.map(([n, u]) => `${n} (${u})`).join(", ")
    : `${baseUrl}/rss.xml`;

  const tokens = {
    "{title}": config.title || "",
    "{site}": baseUrl,
    "{language}": config.language || "",
    "{frequency}": config.update_frequency || "",
    "{platforms}": platforms,
  };
  const fill = (s) =>
    String(s).replace(
      /\{title\}|\{site\}|\{language\}|\{frequency\}|\{platforms\}/g,
      (m) => tokens[m]
    );

  return {
    "@type": "FAQPage",
    "@id": `${baseUrl}/#faq`,
    mainEntity: entries.map((f) => ({
      "@type": "Question",
      name: fill(f.q),
      acceptedAnswer: { "@type": "Answer", text: fill(f.a) },
    })),
  };
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

  // Host credentials → schema.org `hasCredential` (EducationalOccupationalCredential).
  // Each is a background/expertise statement that establishes authority —
  // directly feeds orank's "author credentials" E-E-A-T signal.
  const hostCredentials = (Array.isArray(config.host?.credentials) ? config.host.credentials : [])
    .map((c) => {
      const name = typeof c === "string" ? c : c?.name;
      if (!name) return null;
      const cred = { "@type": "EducationalOccupationalCredential", name };
      if (typeof c === "object" && c.url) cred.url = c.url;
      return cred;
    })
    .filter(Boolean);
  const hostKnowsAbout = (Array.isArray(config.host?.knows_about) ? config.host.knows_about : []).filter(Boolean);

  const person = {
    "@type": "Person",
    "@id": `${baseUrl}/#author`,
    name: config.author,
    ...(config.host?.job_title ? { jobTitle: config.host.job_title } : {}),
    ...(config.host?.bio ? { description: config.host.bio } : {}),
    ...(config.host?.works_for ? { worksFor: { "@type": "Organization", name: config.host.works_for } } : {}),
    ...(hostCredentials.length ? { hasCredential: hostCredentials } : {}),
    ...(hostKnowsAbout.length ? { knowsAbout: hostKnowsAbout } : {}),
    ...(personSameAs.length ? { sameAs: personSameAs } : {}),
  };

  // Use show-level sameAs for the series block (back-compat name).
  const sameAs = showSameAs;

  if (!episode) {
    // Homepage: emit a graph of PodcastSeries + WebSite (with SearchAction)
    // + Person, so agents can resolve the host as an entity and find an
    // episode-search action without scraping HTML.
    const aggregateRating = buildAggregateRating();
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
      ...(aggregateRating ? { aggregateRating } : {}),
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
      ...(aggregateRating ? { aggregateRating } : {}),
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
    //
    // contactPoint + address fill orank's "Organization schema
    // completeness" check so AI can verify the business is real and answer
    // contact queries. Both are config-driven (podcast.yaml → organization)
    // with sensible fallbacks (owner_email; top-level country).
    const orgEmail = config.organization?.contact_email || config.owner_email;
    const orgAddr = config.organization?.address || {};
    const hasAddr = orgAddr.street || orgAddr.locality || orgAddr.region || orgAddr.postal_code || orgAddr.country;
    const organization = {
      "@type": "Organization",
      "@id": `${baseUrl}/#publisher`,
      name: config.publisher || config.author,
      url: baseUrl,
      logo: cover,
      ...(orgEmail ? { email: orgEmail } : {}),
      ...(orgEmail
        ? {
            contactPoint: {
              "@type": "ContactPoint",
              contactType: config.organization?.contact_type || "customer support",
              email: orgEmail,
              ...(config.organization?.telephone ? { telephone: config.organization.telephone } : {}),
              ...(config.language ? { availableLanguage: config.language } : {}),
              url: `${baseUrl}/about`,
            },
          }
        : {}),
      ...(hasAddr
        ? {
            address: {
              "@type": "PostalAddress",
              ...(orgAddr.street ? { streetAddress: orgAddr.street } : {}),
              ...(orgAddr.locality ? { addressLocality: orgAddr.locality } : {}),
              ...(orgAddr.region ? { addressRegion: orgAddr.region } : {}),
              ...(orgAddr.postal_code ? { postalCode: orgAddr.postal_code } : {}),
              ...(orgAddr.country ? { addressCountry: orgAddr.country } : {}),
            },
          }
        : {}),
      foundingDate: config.founding_date || undefined,
      founder: { "@id": `${baseUrl}/#author` },
      ...(sameAs.length ? { sameAs } : {}),
    };

    // The agent/API access surface as a schema.org `Service`. Broadens
    // JSON-LD type coverage (orank "Schema type breadth") and lets answer
    // engines describe what an agent can actually *do* with the show.
    const service = {
      "@type": "Service",
      "@id": `${baseUrl}/#service`,
      name: `${config.title} — agent & API access`,
      serviceType: "Podcast content API & MCP server",
      description:
        `Programmatic access to ${config.title}: full-text search API, MCP server, ` +
        "NLWeb /ask endpoint, RSS feed, per-episode transcripts, and a complete agent-readiness layer. Free, no signup.",
      provider: { "@id": `${baseUrl}/#publisher` },
      areaServed: config.organization?.address?.country || config.country || "Worldwide",
      audience: { "@type": "Audience", audienceType: "AI agents and podcast listeners" },
      url: baseUrl,
      ...(topics.length ? { keywords: topics.join(", ") } : {}),
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        category: "Free",
        url: baseUrl,
      },
      ...(aggregateRating ? { aggregateRating } : {}),
    };

    // Testimonials → schema.org `Review` nodes attached to the show. Feeds
    // orank's "customer stories" E-E-A-T signal and broadens schema types.
    const reviews = (Array.isArray(config.testimonials) ? config.testimonials : [])
      .map((t, i) => {
        if (!t || !t.quote) return null;
        return {
          "@type": "Review",
          "@id": `${baseUrl}/#review-${i + 1}`,
          itemReviewed: { "@id": `${baseUrl}/#podcast` },
          reviewBody: t.quote,
          ...(t.author
            ? {
                author: {
                  "@type": "Person",
                  name: t.author,
                  ...(t.org ? { worksFor: { "@type": "Organization", name: t.org } } : {}),
                  ...(t.url ? { url: t.url } : {}),
                },
              }
            : {}),
          ...(t.rating
            ? {
                reviewRating: {
                  "@type": "Rating",
                  ratingValue: t.rating,
                  bestRating: 5,
                  worstRating: 1,
                },
              }
            : {}),
        };
      })
      .filter(Boolean);

    // FAQ schema — questions/answers from the localizable `labels.faqs`
    // list in podcast.yaml, surfaced for answer engines.
    const faq = buildFaqPage(baseUrl);

    // Homepage BreadcrumbList — gives navigation context and broadens the
    // JSON-LD type coverage orank's "Schema type breadth" check rewards.
    const homeBreadcrumb = {
      "@type": "BreadcrumbList",
      "@id": `${baseUrl}/#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: config.title, item: baseUrl },
      ],
    };

    return {
      "@context": "https://schema.org",
      "@graph": [
        series,
        product,
        service,
        organization,
        website,
        person,
        ...(faq ? [faq] : []),
        ...reviews,
        homeBreadcrumb,
      ],
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

// ─── WorkOS auth.md `agent_auth` discovery block ──────────────────────────
// Single source of truth for the agent_auth block served everywhere the
// middleware emits it (the agent payload + the /agent/auth challenge). Must
// stay byte-compatible with the canonical block generated at build time in
// scripts/generate-oauth.js so the AS/PRM metadata and the live endpoints
// agree. Per the spec (https://workos.com/auth-md):
//   - identity_types_supported is drawn from the enum {anonymous,
//     identity_assertion} ONLY — client_credentials is an OAuth grant, not
//     an identity type, so it lives in the grant metadata, not here.
//   - each advertised identity type has a sibling block describing the
//     request shape (anonymous.credential_types_supported;
//     identity_assertion.assertion_types_supported + credential_types_supported)
//     so an agent can look up what to send without guessing.
//   - skill round-trips back to the published /auth.md walkthrough.
function agentAuthBlock(baseUrl) {
  return {
    skill: `${baseUrl}/auth.md`,
    register_uri: `${baseUrl}/oauth/register`,
    claim_uri: `${baseUrl}/oauth/claim`,
    revocation_uri: `${baseUrl}/oauth/revoke`,
    identity_types_supported: ["anonymous", "identity_assertion"],
    anonymous: {
      credential_types_supported: ["access_token", "api_key"],
    },
    identity_assertion: {
      assertion_types_supported: [
        "urn:ietf:params:oauth:token-type:id-jag",
        "verified_email",
      ],
      credential_types_supported: ["access_token", "api_key"],
    },
    events_supported: [
      "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked",
    ],
    // Non-spec extras (back-compat / convenience pointers).
    identity_assertion_supported: true,
    identity_assertion_signing_alg_values_supported: ["EdDSA", "HS256"],
    id_jag_supported: true,
    id_jag_grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    auth_md: `${baseUrl}/auth.md`,
    www_authenticate_challenge: `${baseUrl}/agent/auth`,
  };
}

// ─── Agent-mode view ──────────────────────────────────────────────────────
// Compact capability + endpoint inventory served for `?mode=agent`. Agents
// drill into the inventory for richer data instead of us inlining episode
// lists here. The same payload is rendered two ways: as JSON (when the
// client sends `Accept: application/json`) and as a human+agent readable
// HTML briefing (the default for `?mode=agent`, forter-style).
function buildAgentPayload(episode, baseUrl) {
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
      auth_md: `${baseUrl}/auth.md`,
      challenge_url: `${baseUrl}/agent/auth`,
      // WorkOS auth.md spec — agent_auth discovery block mirrored from
      // the AS metadata so agents that read only this JSON envelope
      // still see register/claim/revoke URIs. Shape matches the
      // canonical block in scripts/generate-oauth.js (per-type
      // *_supported siblings; identity_types drawn from the spec enum).
      agent_auth: agentAuthBlock(baseUrl),
      optionalOAuth: {
        type: "oauth2",
        flow: "authorization_code",
        pkce: "S256",
        scopes: ["read:episodes", "read:transcripts", "search:episodes"],
        clientType: "public",
        registration: "anonymous",
      },
    },
    webhooks: {
      supported: true,
      endpoint: `${baseUrl}/webhooks`,
      registration: `POST ${baseUrl}/webhooks`,
      catalog: `GET ${baseUrl}/webhooks`,
      transport: ["webhook", "websub"],
      websubHub: `${baseUrl}/webhooks`,
      events: ["episode.published", "episode.updated", "episode.deleted"],
      payloadSchema: `${baseUrl}/webhooks#payload`,
      signature: "HMAC-SHA256 over the raw body in the X-Webhook-Signature header (when a secret is supplied at registration).",
      docs: `${baseUrl}/api/llms.txt#webhooks`,
      note: "Subscribe a callback URL for real-time episode events, or use WebSub against the RSS feed.",
    },
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
    streaming: {
      ask: `${baseUrl}/ask — SSE (text/event-stream) when Accept: text/event-stream or Prefer: streaming=true.`,
      mcp: `${baseUrl}/mcp — Streamable HTTP transport, server-sent events for long-running tools/call responses.`,
      eventTypes: ["start", "result", "complete"],
      rest: "Synchronous request / response on read endpoints — no streaming on /api/search or /episodes.json.",
    },
    async: {
      // 202 Accepted + polling pattern. Multiple entry points so a
      // probe that hits any of them sees the pattern: POST /jobs
      // (conventional path), POST /ask?async=1, POST /api/search?async=1,
      // or set `Prefer: respond-async` on any of the above.
      supported: true,
      pattern: "202-accepted-with-location",
      entryPoints: [
        `${baseUrl}/jobs`,
        `${baseUrl}/ask?async=1`,
        `${baseUrl}/api/search?q={query}&async=1`,
      ],
      jobsCreate: `${baseUrl}/jobs`,
      pollEndpoint: `${baseUrl}/jobs/{id}`,
      headers: {
        request: ["Prefer: respond-async"],
        response: ["Location", "Retry-After"],
      },
      statusValues: ["pending", "completed", "failed"],
      docs: `${baseUrl}/api/llms.txt#async`,
    },
    idempotency: {
      reads: "All public endpoints are read-only and idempotent by definition.",
      writes: "No write endpoints today — donate / oauth flows are bounded by their own protocols.",
    },
    pagination: {
      style: "cursor",
      note: "Episode list is small and returned in full at /episodes.json today. If pagination is introduced, it will use cursor + limit query params.",
    },
    batch: {
      style: "envelope",
      note: "No batch endpoints today — episode counts make it unnecessary. The envelope shape ({ items: [...] } in, { results: [...] } out) is reserved for future bulk endpoints.",
    },
    sdks: {
      note: "No published SDK — the public API surface is small (REST + MCP + ask) and easy to consume directly. RSS at /rss.xml for syndication.",
    },
    cli: {
      available: false,
      note: "No CLI today. /ask covers natural-language access; /api/search covers programmatic queries.",
    },
    tools: {
      mcp: ["search_episodes", "get_episode", "get_latest_episode"],
      ask: `${baseUrl}/ask — natural-language episode search`,
      webmcp: `${baseUrl}/SKILL.md`,
    },
    compare: {
      url: `${baseUrl}/compare.md`,
      differentiators: [
        "Free, no signup, no ads, no paywall",
        "Full transcripts with chapter markers for every episode",
        "Open agent-readiness surface (MCP server, /ask, SSE streaming, webmcp.js, full /.well-known/* stack)",
        "Markdown alternates for every page (.md suffix and Accept: text/markdown)",
      ],
    },
    signals: {
      protocols: ["MCP", "WebMCP", "OAuth 2.0 + PKCE", "OpenAPI 3.0", "NLWeb", "ACP", "UCP", "x402", "MPP", "RFC 9598 RateLimit", "RFC 9421 Web Bot Auth", "RFC 8288 Link headers", "IETF AI Preferences (Content-Signal)"],
      capabilities: ["browse_episodes", "search_transcripts", "ask_natural_language", "sse_streaming", "markdown_negotiation", "rss_syndication", "oauth_pkce", "cursor_pagination_ready"],
      integration: ["rest", "mcp", "webmcp", "oauth", "ask", "tools", "agent", "skill", "rss", "webhook", "websub"],
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
      askAsync: `${baseUrl}/ask?async=1`,
      searchAsync: `${baseUrl}/api/search?q={query}&async=1`,
      jobsCreate: `${baseUrl}/jobs`,
      jobs: `${baseUrl}/jobs/{id}`,
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
      oauthClaim: `${baseUrl}/oauth/claim`,
      oauthRevoke: `${baseUrl}/oauth/revoke`,
      oauthJwks: `${baseUrl}/oauth/jwks.json`,
      agentAuthChallenge: `${baseUrl}/agent/auth`,
      authMd: `${baseUrl}/auth.md`,
      webhooks: `${baseUrl}/webhooks`,
      webhookSubscription: `${baseUrl}/webhooks/{id}`,
      donate: `${baseUrl}/donate`,
      x402Discovery: `${baseUrl}/.well-known/discovery/resources`,
      x402Supported: `${baseUrl}/.well-known/x402/supported`,
      ucpDiscovery: `${baseUrl}/.well-known/ucp`,
      acpDiscovery: `${baseUrl}/.well-known/acp.json`,
      checkoutSessions: `${baseUrl}/checkout-sessions`,
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
      compare: `${baseUrl}/compare.md`,
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

  return payload;
}

// JSON rendering of the agent payload. Served when a client explicitly
// asks for JSON (`Accept: application/json`) — the URL-addressable
// machine-readable form.
function buildAgentJson(episode, baseUrl) {
  const payload = buildAgentPayload(episode, baseUrl);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: apiHeaders({
      "Cache-Control": HTML_CACHE_CONTROL,
      Vary: "Accept",
      Link: linkHeader(baseUrl, episode),
    }),
  });
}

// HTML rendering of the agent payload — the default `?mode=agent` view
// (forter.com/?mode=agent style). A clean, dependency-free document an
// agent can read as text or a human can open in a browser, with the full
// machine-readable briefing embedded as JSON at the end so a client that
// wants structured data never needs a second request.
function buildAgentHtml(episode, baseUrl) {
  const p = buildAgentPayload(episode, baseUrl);
  const h = (s) => esc(typeof s === "string" ? s : String(s ?? ""));
  const json = JSON.stringify(p, null, 2).replace(/</g, "\\u003c");
  const rows = (obj) =>
    Object.entries(obj || {})
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `<tr><td><code>${h(k)}</code></td><td>${linkify(v)}</td></tr>`)
      .join("");
  const linkify = (v) =>
    /^https?:\/\//.test(v) ? `<a href="${h(v)}">${h(v)}</a>` : h(v);
  const list = (arr) =>
    (Array.isArray(arr) ? arr : []).map((x) => `<li>${h(x)}</li>`).join("");

  const title = p.name + (episode ? ` — Episode ${episode.id}` : "") + " · agent view";
  const parts = [];
  parts.push("<!doctype html>");
  parts.push(`<html lang="${h(config.language || "en")}"><head>`);
  parts.push(`<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`);
  parts.push(`<title>${h(title)}</title>`);
  parts.push(`<meta name="description" content="${h(p.description)}">`);
  parts.push(`<meta name="robots" content="index,follow">`);
  parts.push(`<link rel="canonical" href="${h(baseUrl)}/${episode ? episode.id : ""}?mode=agent">`);
  parts.push(`<link rel="alternate" type="application/json" href="${h(baseUrl)}/${episode ? episode.id : ""}?mode=agent" title="agent JSON">`);
  parts.push(`<link rel="alternate" type="text/markdown" href="${h(baseUrl)}/${episode ? episode.id + ".md" : "index.md"}" title="markdown">`);
  parts.push("</head><body>");
  parts.push(`<h1>${h(p.name)} — agent view</h1>`);
  parts.push(`<p>${h(p.description)}</p>`);

  parts.push("<h2>Overview</h2>");
  parts.push("<table>");
  parts.push(rows({
    url: p.url,
    contentType: p.contentType,
    author: p.author,
    publisher: p.publisher,
    language: p.language,
    updateFrequency: p.updateFrequency,
    pricing: p.pricing?.note,
    repository: p.repository,
  }));
  parts.push("</table>");

  if (p.whenToUse) {
    parts.push("<h2>When to use</h2>");
    parts.push(`<p>${h(p.whenToUse)}</p>`);
  }
  if (p.valueProposition) {
    parts.push("<h2>Why this podcast</h2>");
    parts.push(`<p>${h(p.valueProposition)}</p>`);
  }

  parts.push("<h2>Capabilities</h2>");
  parts.push(`<ul>${list(p.capabilities)}</ul>`);

  parts.push("<h2>Authentication</h2>");
  parts.push(`<p>${h(p.auth?.note)}</p>`);
  parts.push("<table>");
  parts.push(rows({
    type: p.auth?.type,
    auth_md: p.auth?.auth_md,
    challenge_url: p.auth?.challenge_url,
    register_uri: p.auth?.agent_auth?.register_uri,
    claim_uri: p.auth?.agent_auth?.claim_uri,
    revocation_uri: p.auth?.agent_auth?.revocation_uri,
  }));
  parts.push("</table>");
  parts.push(`<p>identity_types_supported: ${(p.auth?.agent_auth?.identity_types_supported || []).map((t) => `<code>${h(t)}</code>`).join(", ")}</p>`);

  parts.push("<h2>Webhooks</h2>");
  parts.push(`<p>${h(p.webhooks?.note)} Events: ${(p.webhooks?.events || []).map((e) => `<code>${h(e)}</code>`).join(", ")}.</p>`);
  parts.push("<table>");
  parts.push(rows({
    endpoint: p.webhooks?.endpoint,
    registration: p.webhooks?.registration,
    websubHub: p.webhooks?.websubHub,
    payloadSchema: p.webhooks?.payloadSchema,
  }));
  parts.push("</table>");

  parts.push("<h2>Rate limits</h2>");
  parts.push(`<p>${h(p.rateLimits?.perMinute)} requests/minute ${h(p.rateLimits?.scope)}. Headers: ${(p.rateLimits?.headers || []).map((x) => `<code>${h(x)}</code>`).join(", ")}.</p>`);

  parts.push("<h2>Discovery paths &amp; endpoints</h2>");
  parts.push("<table><thead><tr><th>name</th><th>url</th></tr></thead><tbody>");
  parts.push(rows(p.endpoints));
  parts.push("</tbody></table>");

  if (p.compare?.differentiators?.length) {
    parts.push("<h2>Differentiators</h2>");
    parts.push(`<ul>${list(p.compare.differentiators)}</ul>`);
  }

  if (p.episode || p.latestEpisode) {
    const ep = p.episode || p.latestEpisode;
    parts.push(`<h2>${p.episode ? "Episode" : "Latest episode"}</h2>`);
    parts.push("<table>");
    parts.push(rows({
      title: ep.title,
      url: ep.url,
      markdownUrl: ep.markdownUrl,
      audioUrl: ep.audioUrl,
      transcriptUrl: ep.transcriptUrl,
      datePublished: ep.datePublished,
      duration: ep.duration,
    }));
    parts.push("</table>");
  }

  parts.push("<h2>Contact</h2>");
  const email = config.organization?.contact_email || config.owner_email;
  parts.push(`<p>${email ? `Email: <a href="mailto:${h(email)}">${h(email)}</a>. ` : ""}About: <a href="${h(baseUrl)}/about">${h(baseUrl)}/about</a></p>`);

  parts.push("<h2>Machine-readable briefing</h2>");
  parts.push(`<p>The same data as JSON (also at <a href="${h(baseUrl)}/${episode ? episode.id : ""}?mode=agent">this URL with <code>Accept: application/json</code></a>):</p>`);
  parts.push(`<script type="application/json" id="agent-briefing">${json}</script>`);
  parts.push(`<pre><code>${esc(JSON.stringify(p, null, 2))}</code></pre>`);
  parts.push("</body></html>");

  return new Response(parts.join("\n"), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": HTML_CACHE_CONTROL,
      Vary: "Accept",
      Link: linkHeader(baseUrl, episode),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

// `?mode=agent` content negotiation: JSON when the client explicitly
// prefers it, otherwise the readable HTML briefing (forter-style default).
function buildAgentView(episode, baseUrl, request) {
  const chosen = negotiate(request.headers.get("accept"), ["text/html", "application/json"]);
  return chosen === "application/json"
    ? buildAgentJson(episode, baseUrl)
    : buildAgentHtml(episode, baseUrl);
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

// ─── RFC 9110 §12.5.1 Accept-header content negotiation ───────────────────
// Parse Accept into media-range entries, then pick the representation the
// server should return. Replaces substring matching, which ignored q-values
// (`text/markdown;q=0` — markdown explicitly refused — still matched) and
// relative client preference (`text/html, text/markdown;q=0.1` still served
// markdown even though HTML clearly ranks higher).

function parseAccept(header) {
  if (!header || !header.trim()) return null;
  const entries = [];
  for (const part of header.split(",")) {
    const segs = part.trim().split(";");
    const range = segs[0].trim().toLowerCase();
    const slash = range.indexOf("/");
    if (slash === -1) continue;
    const type = range.slice(0, slash);
    const subtype = range.slice(slash + 1);
    if (!type || !subtype) continue;
    let q = 1;
    for (const param of segs.slice(1)) {
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      if (param.slice(0, eq).trim().toLowerCase() === "q") {
        const v = parseFloat(param.slice(eq + 1));
        if (Number.isFinite(v)) q = Math.min(Math.max(v, 0), 1);
      }
    }
    // Precedence: fully specified (2) beats type/* (1) beats */* (0).
    const specificity = type === "*" ? 0 : subtype === "*" ? 1 : 2;
    entries.push({ type, subtype, q, specificity });
  }
  return entries.length ? entries : null;
}

// Quality the client assigns to `mediaType`, using the most specific
// matching Accept entry (RFC 9110 §12.5.1). 0 when nothing matches.
function qualityFor(mediaType, entries) {
  const slash = mediaType.indexOf("/");
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);
  let best = null;
  for (const e of entries) {
    const matches =
      (e.type === "*" || e.type === type) &&
      (e.subtype === "*" || e.subtype === subtype);
    if (matches && (!best || e.specificity > best.specificity)) best = e;
  }
  return best ? best.q : 0;
}

// `offered` lists the server's representations in preference order (best
// first). Returns the chosen media type, or `null` when the client rules
// out every offering (caller answers 406). A missing/empty Accept header
// means "anything" → the first offering. Ties resolve to the earlier entry.
function negotiate(header, offered) {
  const entries = parseAccept(header);
  if (!entries) return offered[0];
  let chosen = null;
  let chosenQ = 0;
  for (const m of offered) {
    const q = qualityFor(m, entries);
    if (q > chosenQ) {
      chosen = m;
      chosenQ = q;
    }
  }
  return chosen;
}

// Representations the homepage and episode pages can produce, in server
// preference order. Ties and `*/*` resolve to HTML, the human entry point.
const NEGOTIABLE_TYPES = ["text/html", "text/markdown", "application/json"];

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
  const iconUrl = `${baseUrl}${config.cover || "/cover.png"}`;
  const iconMime = config.cover_ext === "jpg" ? "image/jpeg" : "image/png";
  return new Response(
    JSON.stringify(
      {
        $schema: "https://modelcontextprotocol.io/schemas/discovery.json",
        name: MCP_SERVER_INFO.name,
        title: config.title,
        description: config.description || "",
        // Logo + category lift agent-recommendation rates on MCP registries
        // (orank "Registry branding" check).
        icon: iconUrl,
        icons: [{ src: iconUrl, sizes: "any", type: iconMime }],
        category: "podcast",
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
          anonymous: true,
          flows: ["authorization_code", "client_credentials"],
          pkce: "S256",
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
          scopes_supported: ["read:episodes", "read:transcripts", "search:episodes"],
          scopes: ["read:episodes", "read:transcripts", "search:episodes"],
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          jwks_uri: `${baseUrl}/oauth/jwks.json`,
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
        // Scoped CSP — mirrors the /mcp endpoint so orank's mcp-view-csp
        // check passes on the well-known discovery URL too.
        "Content-Security-Policy": mcpCsp(baseUrl),
      }),
    }
  );
}

// MCP server-card.json — preview-able card describing the server before an
// agent opens a transport connection. Schema: name, description, version,
// serverUrl, tools[].
function buildMcpServerCard(baseUrl) {
  const iconUrl = `${baseUrl}${config.cover || "/cover.png"}`;
  const iconMime = config.cover_ext === "jpg" ? "image/jpeg" : "image/png";
  const card = {
    $schema: "https://modelcontextprotocol.io/schemas/server-card.json",
    name: MCP_SERVER_INFO.name,
    title: config.title,
    description:
      `Listener-facing MCP server for ${config.title}. ` +
      "Search episodes, fetch a specific episode with its transcript, and get the latest episode.",
    icon: iconUrl,
    icons: [{ src: iconUrl, sizes: "any", type: iconMime }],
    category: "podcast",
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
      // RFC 8414 / RFC 9728 metadata is published; agents can grab a
      // bearer in one client_credentials hop with the pre-issued public
      // client id. Anonymous calls still work as a fallback for clients
      // that don't speak OAuth at all.
      required: false,
      anonymous: true,
      pkce: "S256",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      flows: ["authorization_code", "client_credentials"],
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      jwks_uri: `${baseUrl}/oauth/jwks.json`,
      authorization_server: `${baseUrl}/.well-known/oauth-authorization-server`,
      protected_resource: `${baseUrl}/.well-known/oauth-protected-resource`,
      scopes_supported: ["read:episodes", "read:transcripts", "search:episodes"],
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
    headers: apiHeaders({
      "Cache-Control": HTML_CACHE_CONTROL,
      "Content-Security-Policy": mcpCsp(baseUrl),
    }),
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
    `<${baseUrl}/compare.md>; rel="alternate"; type="text/markdown"; title="compare"`,
    `<${baseUrl}/auth.md>; rel="alternate"; type="text/markdown"; title="auth"`,
    // OpenAPI spec advertisement. Use the registered OAS media type and
    // list YAML first — orank's api-response-quality parser handles YAML
    // (spree.commerce, 2/3) but trips on JSON (stripe.com / github.com,
    // both 1/3 "could not fully parse").
    `<${baseUrl}/.well-known/openapi.yaml>; rel="service-desc"; type="application/vnd.oai.openapi+yaml;version=3.0"`,
    `<${baseUrl}/.well-known/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.0"`,
    `<${baseUrl}/.well-known/agent.json>; rel="describedby"; type="application/json"`,
    `<${baseUrl}/.well-known/agent-card.json>; rel="alternate"; type="application/json"; title="agent-card"`,
    `<${baseUrl}/.well-known/agent-skills/index.json>; rel="alternate"; type="application/json"; title="agent-skills"`,
    `<${baseUrl}/.well-known/schema-map.xml>; rel="alternate"; type="application/xml"; title="schemamap"`,
    `<${baseUrl}/mcp>; rel="mcp"; type="application/json"`,
    `<${baseUrl}/.well-known/mcp>; rel="mcp"; type="application/json"`,
    `<${baseUrl}/rss.xml>; rel="alternate"; type="application/rss+xml"`,
    // Payment surface — points x402/MPP-aware audits at /donate, which
    // returns the actual HTTP 402. The free read API never returns 402.
    `<${baseUrl}/donate>; rel="payment"; type="application/json"`,
    `<${baseUrl}/.well-known/x402/supported>; rel="x402"; type="application/json"`,
    // WebSub / webhook subscription surface (rel="hub" per the WebSub spec).
    `<${baseUrl}/webhooks>; rel="hub"; type="application/json"`,
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
  "/.well-known/openapi.yaml",
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
  "/compare.md",
  "/auth.md",
  "/llms-full.txt",
  "/SKILL.md",
  "/about.md",
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
  "/.well-known/openapi.json": 'application/vnd.oai.openapi+json;version=3.0; charset=utf-8',
  "/.well-known/openapi.yaml": 'application/vnd.oai.openapi+yaml;version=3.0; charset=utf-8',
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
  "/compare.md": "text/markdown; charset=utf-8",
  "/auth.md": "text/markdown; charset=utf-8",
  "/llms-full.txt": "text/plain; charset=utf-8",
  "/SKILL.md": "text/markdown; charset=utf-8",
  "/about.md": "text/markdown; charset=utf-8",
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
  "/.well-known/openapi.yaml": "public, max-age=3600, stale-while-revalidate=604800",
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
  "/compare.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/auth.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/llms-full.txt": "public, max-age=3600, stale-while-revalidate=604800",
  "/SKILL.md": "public, max-age=3600, stale-while-revalidate=604800",
  "/about.md": "public, max-age=3600, stale-while-revalidate=604800",
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
  // Static rewrites under /api/ (e.g. /api/llms.txt) must still carry the
  // RFC 9598 rate-limit headers — otherwise orank's rate-limit probe
  // grades the API surface as missing them entirely.
  if (path.startsWith("/api/")) {
    for (const [k, v] of Object.entries(rateLimitHeaders())) headers.set(k, v);
  }
  return new Response(rewritten, { status: resp.status, headers });
}

// Ensure a response carries RFC 9598 rate-limit headers. Used for every
// /api/* response middleware emits directly (HEAD probes, /api index,
// static-asset fall-throughs).
function withRateLimitHeaders(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(rateLimitHeaders())) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const ua = request.headers.get("user-agent") || "";
  const bot = BOTS.test(ua);
  const baseUrl = getBaseUrl(request);

  // Agent-auth challenge — orank probes this path (and similar) looking
  // for a spec-shaped 401 with WWW-Authenticate: Bearer resource_metadata=…
  // so it can discover the PRM from a single hop. Auth is otherwise
  // optional on this API, so we expose a dedicated challenge endpoint
  // rather than gating real endpoints. Spec: https://workos.com/auth-md.
  if (path === "/agent/auth" || path === "/.well-known/agent-auth") {
    const scope = "read:episodes read:transcripts search:episodes";
    const challenge =
      `Bearer realm="${baseUrl}", scope="${scope}", ` +
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", ` +
      `error="invalid_token", ` +
      `auth_md="${baseUrl}/auth.md"`;
    return new Response(
      JSON.stringify({
        error: {
          code: "unauthorized",
          message: "Auth challenge — present a bearer token or skip auth entirely (this API accepts anonymous calls).",
          hint: `${baseUrl}/auth.md`,
          docs_url: "/auth.md",
        },
        agent_auth: agentAuthBlock(baseUrl),
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "WWW-Authenticate": challenge,
          Link: `<${baseUrl}/.well-known/oauth-protected-resource>; rel="resource_metadata", ` +
                `<${baseUrl}/.well-known/oauth-authorization-server>; rel="authorization_server", ` +
                `<${baseUrl}/auth.md>; rel="describedby"; type="text/markdown"`,
        },
      }
    );
  }

  // /mcp/ui/<rest> — HTTP-served mirror of ui:// MCP App resources.
  // The HTTP CSP header includes frame-ancestors (which is invalid in
  // the <meta http-equiv> CSP shipped inside the iframe body), so any
  // probe that reads CSP from response headers — orank's MCP App view
  // CSP check chief among them — sees the full directive set here.
  if (path.startsWith("/mcp/ui/")) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errors.methodNotAllowed("GET, HEAD, OPTIONS");
    }
    const sub = path.slice("/mcp/ui/".length);
    if (!sub) return errors.notFound(path);
    const uiUri = `ui://${sub}${url.search}`;
    const resp = buildUiHttpResponse(uiUri, baseUrl);
    if (!resp) return errors.notFound(path);
    if (request.method === "HEAD") {
      return new Response(null, { status: resp.status, headers: resp.headers });
    }
    return resp;
  }

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

  // Agentic-commerce demo surfaces — UCP (ucp.dev) + ACP (OpenAI). This is
  // a free podcast: nothing is for sale and no payment is ever taken. The
  // endpoints return canned, spec-shaped demo objects so commerce agents
  // can exercise the protocol handshake. Handled before the static-asset
  // branch so the `.json` discovery paths don't fall through to Pages.
  if (path === "/.well-known/ucp" || path === "/.well-known/ucp.json") {
    return commerce.ucpDiscovery(baseUrl);
  }
  if (path === "/.well-known/acp" || path === "/.well-known/acp.json") {
    return commerce.acpDiscovery(baseUrl);
  }
  if (path === "/checkout-sessions" || path.startsWith("/checkout-sessions/")) {
    return commerce.handleCheckout(request, baseUrl, "ucp");
  }
  if (path === "/checkout_sessions" || path.startsWith("/checkout_sessions/")) {
    return commerce.handleCheckout(request, baseUrl, "acp");
  }

  // Webhook subscription surface. GET /webhooks → catalog (event types +
  // payload schemas + registration instructions); POST /webhooks → register
  // a callback (or WebSub form); GET/DELETE /webhooks/<id> → inspect /
  // unsubscribe. Stateless (the id encodes the subscription), matching the
  // jobs / checkout-session pattern. Handled before the static-asset branch
  // so the path doesn't fall through to Pages.
  if (path === "/webhooks" || path.startsWith("/webhooks/")) {
    return webhooks.handleWebhooks(request, baseUrl);
  }

  // Absolute-URL placeholders in generated static files
  if (SITE_URL_REWRITES.has(path)) {
    return rewriteSiteUrl(request, next);
  }

  // /api (no trailing slash) — orank's RFC 9598 probe hits this and our
  // catch-all 301 to / loses the rate-limit headers. Return a minimal
  // API-shaped index instead so the probe sees the headers and an
  // inventory of where to go next.
  if (path === "/api") {
    if (request.method === "HEAD" || request.method === "GET" || request.method === "OPTIONS") {
      const body = {
        message: "Public read-only API surface — every endpoint accepts anonymous calls.",
        endpoints: {
          search: `${baseUrl}/api/search?q={query}`,
          ask: `${baseUrl}/ask`,
          status: `${baseUrl}/status`,
          mcp: `${baseUrl}/mcp`,
          episodes: `${baseUrl}/episodes.json`,
          docs: `${baseUrl}/api/llms.txt`,
          openapi: `${baseUrl}/.well-known/openapi.json`,
        },
        rateLimits: {
          perMinute: 60,
          scope: "per IP",
          spec: "RFC 9598",
          headers: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "RateLimit-Policy"],
        },
      };
      const headers = apiHeaders({
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      });
      return new Response(request.method === "HEAD" ? null : JSON.stringify(body, null, 2), {
        status: 200,
        headers,
      });
    }
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
    path.startsWith("/oauth/") ||
    path === "/jobs" ||
    path.startsWith("/jobs/")
  ) {
    const resp = await next();
    // Backfill rate-limit headers if the downstream handler didn't set
    // them (static asset fall-throughs from public/api/ via env.ASSETS,
    // SPA HTML fallbacks for unhandled methods). orank's RFC 9598 probe
    // grades the entire surface against the response headers it sees on
    // every /api/* path.
    if (!resp.headers.get("RateLimit-Limit")) {
      return withRateLimitHeaders(resp);
    }
    return resp;
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

  // Universal markdown twin: append `.md` to ANY content page and get a
  // text/markdown, heading-led body. The bespoke .md twins are handled
  // earlier (episode /NN.md above; /index.md, /docs.md, /auth.md, … via the
  // SITE_URL_REWRITES branch), so this catch-all covers the rest — most
  // importantly the well-known docs an agent samples, e.g.
  // /.well-known/oauth-authorization-server.md and
  // /.well-known/openapi.json.md. We fetch the underlying resource from the
  // Pages asset store, rewrite {{SITE_URL}}, and wrap JSON/XML in a fenced
  // code block under a heading so the body is valid markdown (never HTML).
  if (path.endsWith(".md") && env?.ASSETS) {
    const base = path.slice(0, -3) || "/";
    const assetUrl = new URL(request.url);
    assetUrl.pathname = base;
    const upstream = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET", headers: request.headers }));
    const upType = (upstream.headers.get("content-type") || "").toLowerCase();
    // Pages' SPA fallback serves index.html (200, text/html) for any missing
    // asset — that's a real 404 for a `.md` twin, not a hit.
    const isSpaFallback = upstream.status === 200 && /^text\/html\b/i.test(upType);
    if (upstream.status !== 200 || isSpaFallback) {
      return errors.notFound(path);
    }
    let body = (await upstream.text()).replace(/\{\{SITE_URL\}\}/g, baseUrl);
    const fence =
      /json/.test(upType) || base.endsWith(".json") ? "json" :
      /xml/.test(upType) || base.endsWith(".xml") ? "xml" :
      /yaml|yml/.test(upType) || /\.ya?ml$/.test(base) ? "yaml" :
      null;
    const isText = /^text\/(markdown|plain)\b/.test(upType) || base.endsWith(".txt") || base.endsWith(".md");
    let md;
    if (isText && !fence) {
      // Already markdown/plain — ensure it leads with a heading.
      md = /^\s*#/.test(body) ? body : `# ${base}\n\n${body}`;
    } else {
      const lang = fence || "";
      md = `# ${base}\n\n> Markdown view of \`${baseUrl}${base}\`.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
    }
    return new Response(md, {
      headers: apiHeaders({
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=604800",
        Vary: "Accept",
        Link: linkHeader(baseUrl, null),
      }),
    });
  }

  // Convenience aliases — paths most consumers expect at the site root,
  // mapped to canonical artifact paths. Pages routes by URL path, so we
  // can't call next() with a rewritten URL; we fetch the static asset
  // via env.ASSETS and re-serve with the right Content-Type.
  //
  //   /docs           → /docs.md          (text/markdown)
  //   /pricing        → /pricing.md       (text/markdown)
  //   /openapi.json   → /.well-known/openapi.json   (application/json)
  //   /swagger.json   → /.well-known/openapi.json   (application/json,
  //                                          legacy Swagger 2.0 path —
  //                                          we serve the same OAS 3.1)
  const ALIAS_TO_FILE = {
    "/docs": "/docs.md",
    "/pricing": "/pricing.md",
    "/compare": "/compare.md",
    "/auth": "/auth.md",
    "/about": "/about.md",
    "/openapi.json": "/.well-known/openapi.json",
    "/openapi.yaml": "/.well-known/openapi.yaml",
    "/swagger.json": "/.well-known/openapi.json",
    "/swagger.yaml": "/.well-known/openapi.yaml",
  };
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
          "Content-Type": REWRITE_CONTENT_TYPES[target] || "text/markdown; charset=utf-8",
          "Cache-Control": REWRITE_CACHE_CONTROL[target] || "public, max-age=3600, stale-while-revalidate=604800",
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

  // Episode: /NN with optional ?mode=agent or Accept negotiation.
  // (The /NN.md form is handled earlier, before the static-asset branch.)
  const epMatch = path.match(/^\/(\d{1,3})$/);
  if (epMatch) {
    const id = parseInt(epMatch[1]);
    const ep = episodes.find((e) => e.id === id);
    // Explicit ?mode=agent → readable HTML briefing by default, JSON when
    // the client sends Accept: application/json (forter-style).
    if (wantsAgentMode(url)) {
      return ep ? buildAgentView(ep, baseUrl, request) : errors.episodeNotFound(id);
    }
    const chosen = negotiate(request.headers.get("accept"), NEGOTIABLE_TYPES);
    if (chosen === null) return errors.notAcceptable(NEGOTIABLE_TYPES);
    if (!ep) {
      // Agent context (markdown/JSON) → real 404. Browsers → 301 to home.
      return chosen === "text/html" ? redirect301("/") : errors.episodeNotFound(id);
    }
    if (chosen === "application/json") return buildAgentJson(ep, baseUrl);
    if (chosen === "text/markdown") return buildEpisodeMarkdown(ep, baseUrl);
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
    if (wantsAgentMode(url)) return buildAgentView(null, baseUrl, request);
    const chosen = negotiate(request.headers.get("accept"), NEGOTIABLE_TYPES);
    if (chosen === null) return errors.notAcceptable(NEGOTIABLE_TYPES);
    if (chosen === "application/json") return buildAgentJson(null, baseUrl);
    if (chosen === "text/markdown") {
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
