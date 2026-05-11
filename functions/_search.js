// Lightweight ranking shared by /api/search and /mcp.
// No external deps — bundling Orama into Workers isn't worth it for the
// small index sizes a podcast site produces.

import episodes from "./_episodes.js";

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

export function searchEpisodes(query, { limit = 10, offset = 0, baseUrl = "" } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return { results: [], total: 0 };

  const scored = [];
  for (const ep of episodes) {
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
      scored.push({
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
        snippet: buildSnippet(ep.fullText || ep.desc || "", tokens),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(offset, offset + limit), total: scored.length };
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
