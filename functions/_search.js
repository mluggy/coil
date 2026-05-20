// Lightweight ranking shared by /api/search and /mcp.
// No external deps — bundling Orama into Workers isn't worth it for the
// small index sizes a podcast site produces.

import episodes from "./_episodes.js";
import config from "./_config.js";

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","being",
  "of","in","on","at","to","for","with","by","from","as","its","it","this","that",
  "into","over","up","down","out","off","than","then","also","not","no","yes",
]);

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function countMatches(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count++;
    from = i + needle.length;
  }
}

function buildSnippet(text, tokens, maxLen = 220) {
  if (!text) return "";
  const lower = text.toLowerCase();
  let bestPos = 0;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      bestPos = Math.max(0, i - 60);
      break;
    }
  }
  let snippet = text.slice(bestPos, bestPos + maxLen);
  if (bestPos > 0) snippet = "…" + snippet;
  if (bestPos + maxLen < text.length) snippet += "…";
  return snippet.replace(/\s+/g, " ").trim();
}

// Episode-ID pre-pass for the search query. Pulls 1-5 digit numbers,
// matches them against actual episode IDs, then strips those numbers,
// the localized episode label (config.labels.episode — "Episode" /
// "פרק" / etc.), a couple of English shortcuts, and the sNNeNN file
// pattern so the remainder is clean text for full-text search. Lets
// queries like "42", "episode 42", "פרק 42", or "ep 42" go straight
// to ep 42, while "42 about AI" surfaces ep 42 first and searches
// "about AI" through the normal scorer.
function extractEpisodeIdHints(query, episodeIds, episodeLabel) {
  const text = String(query || "");
  const numbers = (text.match(/\d{1,5}/g) || []).map((n) => parseInt(n, 10));
  const ids = numbers.filter((n) => episodeIds.has(n));
  const labelSet = new Set(
    [episodeLabel, "episode", "ep", "#"].filter(Boolean).map((t) => String(t).toLowerCase())
  );
  const remainder = text
    .replace(/s\d+e\d+/giu, " ")
    .replace(/#\d{1,5}\b/g, " ")
    .split(/\s+/)
    .filter((tok) => {
      if (!tok) return false;
      const clean = tok.toLowerCase();
      if (labelSet.has(clean)) return false;
      if (/^\d{1,5}$/.test(clean)) return false;
      return true;
    })
    .join(" ")
    .trim();
  return { ids, remainder };
}

function buildHit(ep, baseUrl, score, snippet) {
  return {
    id: ep.id,
    title: ep.title,
    date: ep.date || "",
    season: ep.season,
    duration: ep.duration || "",
    url: baseUrl ? `${baseUrl}/${ep.id}` : `/${ep.id}`,
    audio: baseUrl ? `${baseUrl}/${ep.audioFile}` : `/${ep.audioFile}`,
    transcript: ep.hasSrt
      ? (baseUrl ? `${baseUrl}/${ep.audioFile.replace(".mp3", ".txt")}` : `/${ep.audioFile.replace(".mp3", ".txt")}`)
      : null,
    score,
    snippet,
  };
}

export function searchEpisodes(query, { limit = 10, offset = 0, baseUrl = "" } = {}) {
  const episodeIds = new Set(episodes.map((e) => e.id));
  const { ids: idHits, remainder } = extractEpisodeIdHints(
    query,
    episodeIds,
    config.labels && config.labels.episode
  );
  const tokens = tokenize(remainder);
  if (!idHits.length && !tokens.length) return { results: [], total: 0 };

  // Direct ID matches first, in query order, deduped. Sentinel score so
  // they always sort above text hits even when merged.
  const seen = new Set();
  const results = [];
  for (const id of idHits) {
    if (seen.has(id)) continue;
    const ep = episodes.find((e) => e.id === id);
    if (!ep) continue;
    seen.add(id);
    results.push(buildHit(ep, baseUrl, Number.MAX_SAFE_INTEGER, ep.desc || ""));
  }

  // Full-text score on the remainder, skipping anything already matched by id.
  if (tokens.length) {
    const scored = [];
    for (const ep of episodes) {
      if (seen.has(ep.id)) continue;
      const title = (ep.title || "").toLowerCase();
      const desc = (ep.desc || "").toLowerCase();
      const text = (ep.fullText || "").toLowerCase();
      let score = 0;
      let matched = false;
      for (const tok of tokens) {
        const t = countMatches(title, tok);
        const d = countMatches(desc, tok);
        const x = countMatches(text, tok);
        if (t + d + x > 0) matched = true;
        score += t * 4 + d * 2 + x;
      }
      if (matched) {
        scored.push(buildHit(ep, baseUrl, score, buildSnippet(ep.fullText || ep.desc || "", tokens)));
      }
    }
    scored.sort((a, b) => b.score - a.score);
    results.push(...scored);
  }

  return { results: results.slice(offset, offset + limit), total: results.length };
}

export function summarizeEpisode(ep, baseUrl = "") {
  if (!ep) return null;
  return {
    id: ep.id,
    title: ep.title,
    date: ep.date || "",
    season: ep.season,
    duration: ep.duration || "",
    description: ep.desc || "",
    guests: Array.isArray(ep.guests) && ep.guests.length ? ep.guests : undefined,
    topics: Array.isArray(ep.topics) && ep.topics.length ? ep.topics : undefined,
    chapters: Array.isArray(ep.chapters) && ep.chapters.length ? ep.chapters : undefined,
    url: baseUrl ? `${baseUrl}/${ep.id}` : `/${ep.id}`,
    audio: baseUrl ? `${baseUrl}/${ep.audioFile}` : `/${ep.audioFile}`,
    transcript: ep.hasSrt
      ? (baseUrl ? `${baseUrl}/${ep.audioFile.replace(".mp3", ".txt")}` : `/${ep.audioFile.replace(".mp3", ".txt")}`)
      : null,
  };
}
