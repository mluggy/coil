import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { XLogo, LinkedinLogo, FacebookLogo, InstagramLogo, TiktokLogo, Heart } from "@phosphor-icons/react";
import config from "./utils/config";
import Header from "./components/Header";
import EpisodeList from "./components/EpisodeList";
import EpisodeDetail from "./components/EpisodeDetail";
import Player from "./components/Player";
import StaticPage from "./components/StaticPage";
import CookieConsent from "./components/CookieConsent";
import usePlayer from "./hooks/usePlayer";
import useSearch from "./hooks/useSearch";
import { getCookie, setCookie } from "./utils/cookies";
import { trackExternalClick, trackEpisodeSelect, trackSearch, trackPageView } from "./utils/analytics";

function setCanonical(path) {
  const url = `${window.location.origin}${path}`;
  const link = document.querySelector('link[rel="canonical"]');
  if (link) link.setAttribute("href", url);
  window.history.replaceState(null, "", path);
  // SPA navigation — fire a page view on every URL change. GA config and
  // FB init are set to skip the auto-fired PageView, so this covers both
  // the initial load (called on mount) and every in-app navigation.
  trackPageView(url);
}

export default function App() {
  const [episodes, setEpisodes] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [season, setSeason] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [query, setQuery] = useState("");
  const [staticPage, setStaticPage] = useState(() => {
    if (typeof window === "undefined") return null;
    const p = window.location.pathname;
    if (p === "/terms" && config.labels?.terms && config.labels?.terms_text) return "terms";
    if (p === "/privacy" && config.labels?.privacy && config.labels?.privacy_text) return "privacy";
    return null;
  });
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = getCookie("theme");
      if (saved) return saved;
      if (config.default_theme) return config.default_theme;
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    return "dark";
  });

  const player = usePlayer();

  // Load episodes. Also refetches when the tab regains focus or the
  // browser goes back online (throttled to once per minute) so returning
  // visitors and PWA users see new episodes without a manual reload.
  useEffect(() => {
    let lastFetch = 0;
    let firstLoad = true;
    const fetchEpisodes = (opts = {}) => {
      if (!opts.force && Date.now() - lastFetch < 60_000) return;
      lastFetch = Date.now();
      // First load: the ?v= content-hash URL — immutable-cached and already
      // preloaded from <head>, so repeat visits cost zero requests. Focus/
      // online refetches: the bare URL with revalidation forced, so a
      // long-lived tab sees episodes published after its HTML was rendered.
      const versioned = typeof __DATA_VERSIONS__ !== "undefined"
        ? `/episodes.json?v=${__DATA_VERSIONS__.episodes}`
        : "/episodes.json";
      fetch(firstLoad ? versioned : "/episodes.json", firstLoad ? undefined : { cache: "no-cache" })
        .then((r) => r.json())
        .then((data) => {
          setEpisodes(data);
          setLoaded(true);
          if (!firstLoad) return;
          firstLoad = false;
          // On initial load: if the URL is /NN, open that episode's detail
          // and snap to its season.
          const m = window.location.pathname.match(/^\/(\d{1,4})$/);
          const ep = m ? data.find((e) => e.id === parseInt(m[1])) : null;
          if (ep) {
            setSeason(ep.season);
            setSelected(ep);
            setShowDetail(true);
          } else {
            const seasons = [...new Set(data.map((e) => e.season))].sort();
            setSeason(seasons[seasons.length - 1]);
          }
        })
        .catch(console.error);
    };
    fetchEpisodes({ force: true });
    const onFocus = () => fetchEpisodes();
    const onOnline = () => fetchEpisodes({ force: true });
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Apply direction and language from config; set canonical (strip query params)
  useEffect(() => {
    document.documentElement.setAttribute("dir", config.direction);
    document.documentElement.setAttribute("lang", config.language);
    setCanonical(window.location.pathname);
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    setCookie("theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const seasons = useMemo(
    () => [...new Set(episodes.map((e) => e.season))].sort(),
    [episodes]
  );

  // Compute the display list — same logic as EpisodeList uses
  const { filtered, snippets } = useSearch(episodes, query);
  const displayList = useMemo(() => {
    const list = query ? filtered : filtered.filter((ep) => ep.season === season);
    return [...list].sort((a, b) => b.id - a.id);
  }, [filtered, query, season]);

  // Full episode list sorted for navigation (spans all seasons)
  const allSorted = useMemo(
    () => [...episodes].sort((a, b) => b.id - a.id),
    [episodes]
  );

  const displayListRef = useRef(displayList);
  const allSortedRef = useRef(allSorted);
  useEffect(() => {
    displayListRef.current = displayList;
    allSortedRef.current = allSorted;
  }, [displayList, allSorted]);

  const newestEpisodeId = useMemo(() => {
    if (episodes.length === 0) return null;
    return Math.max(...episodes.map((e) => e.id));
  }, [episodes]);

  // Search commit tracking — fires one `search` event per session with an
  // outcome: clicked / cleared / abandoned. Keystrokes and typing pauses
  // never fire; only the terminal action does.
  const sessionTermRef = useRef("");
  const sessionFiredRef = useRef(false);
  const sessionResultsRef = useRef(0);
  const blurCommitTimerRef = useRef(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length >= 2) {
      // Only reset the "fired" flag when the term actually changes, so an
      // updated results count doesn't let us fire twice for the same term.
      if (trimmed !== sessionTermRef.current) {
        sessionTermRef.current = trimmed;
        sessionFiredRef.current = false;
      }
      sessionResultsRef.current = displayList.length;
    } else if (!trimmed && sessionTermRef.current) {
      // Query fully cleared (× button, Esc, season switch, nav home, etc.)
      if (!sessionFiredRef.current) {
        trackSearch(sessionTermRef.current, sessionResultsRef.current, "cleared");
      }
      sessionTermRef.current = "";
      sessionFiredRef.current = false;
      sessionResultsRef.current = 0;
    }
  }, [query, displayList.length]);

  // Blur → fire `abandoned` after a short delay, so that a click on a
  // result (which triggers blur first, then click) can preempt it.
  const commitSearchOnBlur = useCallback(() => {
    clearTimeout(blurCommitTimerRef.current);
    blurCommitTimerRef.current = setTimeout(() => {
      if (sessionTermRef.current && !sessionFiredRef.current) {
        trackSearch(sessionTermRef.current, sessionResultsRef.current, "abandoned");
        sessionFiredRef.current = true;
      }
    }, 200);
  }, []);

  // Focus → user came back to the box; allow a fresh commit.
  const commitSearchOnFocus = useCallback(() => {
    clearTimeout(blurCommitTimerRef.current);
    sessionFiredRef.current = false;
  }, []);

  // Unmount — last chance to flush an uncommitted term.
  useEffect(() => () => {
    clearTimeout(blurCommitTimerRef.current);
    if (sessionTermRef.current && !sessionFiredRef.current) {
      trackSearch(sessionTermRef.current, sessionResultsRef.current, "abandoned");
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        if (e.target.tagName === "INPUT") e.target.blur();
        setShowDetail(false);
        setQuery("");
        return;
      }
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === " " && player.playing) {
        e.preventDefault();
        player.togglePlay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [player]);

  const selectEpisode = (ep) => {
    // Preempt any pending blur-commit — clicking a result is "clicked",
    // not "abandoned", even though blur fired first in the event chain.
    clearTimeout(blurCommitTimerRef.current);
    if (sessionTermRef.current && !sessionFiredRef.current) {
      trackSearch(sessionTermRef.current, sessionResultsRef.current, "clicked");
      sessionFiredRef.current = true;
    }
    setSelected(ep);
    setShowDetail(true);
    trackEpisodeSelect(ep.id);
    setCanonical(`/${ep.id}`);
  };

  const latestSeason = seasons.length ? seasons[seasons.length - 1] : null;
  const canGoHome = !!(showDetail || selected || staticPage || query || (latestSeason != null && season !== latestSeason));

  const goHome = useCallback(() => {
    setShowDetail(false);
    setSelected(null);
    setStaticPage(null);
    setQuery("");
    if (latestSeason != null) setSeason(latestSeason);
    setCanonical("/");
  }, [latestSeason]);

  const openStaticPage = useCallback((kind, e) => {
    if (e) e.preventDefault();
    setShowDetail(false);
    setQuery("");
    setStaticPage(kind);
    setCanonical(`/${kind}`);
    window.scrollTo(0, 0);
  }, []);

  // Navigate to next/prev episode — try display list first, fall back to all episodes
  const navigateEpisode = useCallback((direction) => {
    if (!player.playingEp) return;
    const display = displayListRef.current;
    const all = allSortedRef.current;
    // Try display list first
    let idx = display.findIndex(ep => ep.id === player.playingEp.id);
    let list = display;
    if (idx === -1 || idx + direction < 0 || idx + direction >= display.length) {
      // Fall back to full sorted list (spans all seasons)
      idx = all.findIndex(ep => ep.id === player.playingEp.id);
      list = all;
    }
    if (idx === -1) return;
    const nextIdx = idx + direction;
    if (nextIdx >= 0 && nextIdx < list.length) {
      const ep = list[nextIdx];
      if (ep.season !== season) {
        setSeason(ep.season);
      }
      setCanonical(`/${ep.id}`);
      player.playEpisode(ep);
      setTimeout(() => {
        const el = document.querySelector(`[data-episode-id="${ep.id}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  }, [player, season]);

  // Auto-advance when episode ends — go to next in the display list
  useEffect(() => {
    if (!player.onEndedRef) return;
    player.onEndedRef.current = () => {
      navigateEpisode(1);
    };
  }, [navigateEpisode, player]);

  // Compute prev/next availability — use full list so cross-season works
  const playingIdxAll = useMemo(() => {
    if (!player.playingEp) return -1;
    return allSorted.findIndex(ep => ep.id === player.playingEp.id);
  }, [allSorted, player.playingEp]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <Header
        seasons={seasons}
        season={season}
        setSeason={(s) => { setSeason(s); if (staticPage) { setStaticPage(null); setCanonical("/"); } }}
        query={query}
        setQuery={setQuery}
        episodes={episodes}
        theme={theme}
        toggleTheme={toggleTheme}
        onGoHome={goHome}
        canGoHome={canGoHome}
        isHome={!showDetail && !staticPage}
        staticPage={staticPage}
        onSearchFocus={commitSearchOnFocus}
        onSearchBlur={commitSearchOnBlur}
      />

      <main
        style={{
          flex: 1,
          padding: "8px 10px",
          paddingBottom: player.playing ? (player.showSubs && player.playingEp?.hasSrt ? 200 : 140) : 40,
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
        {staticPage === "terms" ? (
          <StaticPage title={config.labels.terms} text={config.labels.terms_text} />
        ) : staticPage === "privacy" ? (
          <StaticPage title={config.labels.privacy} text={config.labels.privacy_text} />
        ) : !loaded ? null : (
        <EpisodeList
          displayList={displayList}
          playing={player.playingEp}
          isPlaying={player.isPlaying}
          onPlay={player.playEpisode}
          onSelect={selectEpisode}
          newestEpisodeId={newestEpisodeId}
          query={query}
          snippets={snippets}
        />
        )}
        </div>
      </main>

      {showDetail && selected && (
        <EpisodeDetail
          episode={selected}
          playing={player.playingEp}
          isPlaying={player.isPlaying}
          onPlay={player.playEpisode}
          onClose={() => setShowDetail(false)}
          query={query}
        />
      )}

      {player.playingEp && (
        <Player
          player={player}
          onPrevEpisode={() => navigateEpisode(1)}
          onNextEpisode={() => navigateEpisode(-1)}
          hasPrev={playingIdxAll >= 0 && playingIdxAll < allSorted.length - 1}
          hasNext={playingIdxAll > 0}
        />
      )}

      <CookieConsent playing={player.playing} />

      {!player.playing && (
        <footer
          style={{
            borderTop: "1px solid var(--border)",
            padding: "20px 20px",
          }}
        >
          <div
            style={{
              maxWidth: 880,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "4px 0",
              fontSize: 12,
              color: "var(--text-faint)",
              flexWrap: "wrap",
              lineHeight: 1.8,
            }}
          >
            {canGoHome ? (
              <a href="/" onClick={(e) => { e.preventDefault(); goHome(); }} style={{ color: "var(--text-faint)", textDecoration: "none", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
                {config.title}
              </a>
            ) : (
              <span>{config.title}</span>
            )}
            {config.x_url && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href={config.x_url} target="_blank" rel="noopener" aria-label="X" onClick={() => trackExternalClick("twitter", "footer")} style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              <XLogo size={14} />
            </a>
            </>)}
            {config.linkedin_url && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href={config.linkedin_url} target="_blank" rel="noopener" aria-label="LinkedIn" onClick={() => trackExternalClick("linkedin", "footer")} style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              <LinkedinLogo size={14} />
            </a>
            </>)}
            {config.facebook_url && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href={config.facebook_url} target="_blank" rel="noopener" aria-label="Facebook" onClick={() => trackExternalClick("facebook", "footer")} style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#1877F2"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              <FacebookLogo size={14} />
            </a>
            </>)}
            {config.instagram_url && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href={config.instagram_url} target="_blank" rel="noopener" aria-label="Instagram" onClick={() => trackExternalClick("instagram", "footer")} style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#E4405F"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              <InstagramLogo size={14} />
            </a>
            </>)}
            {config.tiktok_url && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href={config.tiktok_url} target="_blank" rel="noopener" aria-label="TikTok" onClick={() => trackExternalClick("tiktok", "footer")} style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#00F2EA"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              <TiktokLogo size={14} />
            </a>
            </>)}
            {config.labels.terms && config.labels.terms_text && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href="/terms" onClick={(e) => openStaticPage("terms", e)} style={{ color: "var(--text-faint)", textDecoration: "none", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              {config.labels.terms}
            </a>
            </>)}
            {config.labels.privacy && config.labels.privacy_text && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href="/privacy" onClick={(e) => openStaticPage("privacy", e)} style={{ color: "var(--text-faint)", textDecoration: "none", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              {config.labels.privacy}
            </a>
            </>)}
            {config.labels.powered_by && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href="https://github.com/mluggy/coil" target="_blank" rel="noopener" style={{ color: "var(--text-faint)", textDecoration: "none", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              {config.labels.powered_by} coil
            </a>
            </>)}
            {config.funding_url && (<>
            <span style={{ margin: "0 8px" }}>&middot;</span>
            <a href={config.funding_url} target="_blank" rel="noopener" aria-label={config.labels.funding || "Support"} onClick={() => trackExternalClick("funding", "footer")} style={{ color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#db2777"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-faint)"; }}>
              <Heart size={14} weight="fill" />
            </a>
            </>)}
          </div>
        </footer>
      )}
    </div>
  );
}
