import { useState, useEffect, useMemo, useRef } from "react";
import { create, insertMultiple, search } from "@orama/orama";
import config from "../utils/config";
import { tokenize } from "../utils/hebrew";
import { extractSnippet } from "../utils/highlight";

const W = config.search_weights || {};

// Episode-ID pre-pass for the search query. Pulls 1-5 digit numbers,
// matches them against actual episode IDs, then strips those numbers,
// the localized episode label (config.labels.episode — "Episode" /
// "פרק" / etc.), a couple of English shortcuts, and the sNNeNN file
// pattern so the remainder is clean text for full-text search. Lets
// queries like "42", "episode 42", "פרק 42", or "ep 42" go straight
// to ep 42, while "42 about AI" surfaces ep 42 first and runs
// "about AI" through Orama.
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

export default function useSearch(episodes, externalQuery) {
  const [searchTexts, setSearchTexts] = useState({});
  const [db, setDb] = useState(null);
  const fetchedRef = useRef(false);
  const buildingRef = useRef(false);

  // Lazy-load full-text search index on first query
  useEffect(() => {
    if (!externalQuery || fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/search-index.json")
      .then((r) => r.json())
      .then(setSearchTexts)
      .catch(() => {});
  }, [externalQuery]);

  // Build Orama index when episodes + transcripts are available
  useEffect(() => {
    if (!episodes.length || !Object.keys(searchTexts).length || buildingRef.current) return;
    buildingRef.current = true;

    const orama = create({
      schema: {
        epId: "number",
        title: "string",
        desc: "string",
        transcript: "string",
      },
      components: {
        tokenizer: { tokenize },
      },
    });

    const docs = episodes.map((ep) => ({
      epId: ep.id,
      title: ep.title || "",
      desc: ep.desc || "",
      transcript: searchTexts[ep.id] || "",
    }));

    insertMultiple(orama, docs);
    setDb(orama);
  }, [episodes, searchTexts]);

  // Search with BM25 + field boosting, with an episode-ID pre-pass:
  // queries like "42" / "episode 42" / "פרק 42" surface ep 42 directly;
  // any remaining text still runs through Orama.
  const searchResults = useMemo(() => {
    if (!externalQuery || !db) return null;
    const episodeIds = new Set(episodes.map((e) => e.id));
    const { ids: idHits, remainder } = extractEpisodeIdHints(
      externalQuery,
      episodeIds,
      config.labels && config.labels.episode
    );

    const seen = new Set();
    const idDocs = [];
    for (const id of idHits) {
      if (seen.has(id)) continue;
      const ep = episodes.find((e) => e.id === id);
      if (!ep) continue;
      seen.add(id);
      // Shape mirrors Orama hit { document } so downstream code stays
      // unchanged; score sentinel sorts ID matches above text hits.
      idDocs.push({ id: String(id), score: Infinity, document: { epId: id } });
    }

    if (!remainder) return { hits: idDocs };

    const oramaRes = search(db, {
      term: remainder,
      properties: ["title", "desc", "transcript"],
      boost: {
        title: W.title ?? 10,
        desc: W.description ?? 5,
        transcript: W.transcript ?? 2,
      },
    });
    const oramaHits = (oramaRes.hits || []).filter((h) => !seen.has(h.document.epId));
    return { hits: [...idDocs, ...oramaHits] };
  }, [externalQuery, db, episodes]);

  // Build snippets for matched episodes
  const snippets = useMemo(() => {
    if (!searchResults || !externalQuery) return {};
    const map = {};
    for (const hit of searchResults.hits) {
      const id = hit.document.epId;
      const raw = searchTexts[id];
      if (raw) {
        const snip = extractSnippet(raw, externalQuery);
        if (snip) map[id] = snip;
      }
    }
    return map;
  }, [searchResults, searchTexts, externalQuery]);

  // Map Orama hits back to episode objects, preserving BM25 rank order
  const filtered = useMemo(() => {
    if (!searchResults) return externalQuery ? [] : episodes;
    const ranked = searchResults.hits.map((h) => h.document.epId);
    const idOrder = new Map(ranked.map((id, i) => [id, i]));
    return episodes
      .filter((ep) => idOrder.has(ep.id))
      .sort((a, b) => idOrder.get(a.id) - idOrder.get(b.id));
  }, [searchResults, episodes, externalQuery]);

  return { filtered, snippets };
}
