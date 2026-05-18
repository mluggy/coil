import { forwardRef } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import config from "../utils/config";

const SearchBar = forwardRef(function SearchBar({ query, setQuery, searchRef, onFocus, onBlur }, ref) {
  const inputRef = searchRef || ref;

  return (
    // Declarative WebMCP form tool: a browser-side agent (WebMCP-capable)
    // discovers `search_episodes` straight from the markup via the tool*
    // attributes — no JS registration needed. `toolautosubmit` lets the
    // agent fill the query and submit in one step. role="search" + a real
    // <form> also make the box a semantic, crawlable search affordance.
    // Search runs live on `onChange`, so submit just suppresses navigation.
    <form
      role="search"
      style={{ position: "relative", width: "100%" }}
      onSubmit={(e) => e.preventDefault()}
      toolname="search_episodes"
      tooldescription={`Search ${config.title} episodes by topic, person, company, or keyword. Filters the episode list on this page to matching episodes.`}
      toolautosubmit=""
    >
      <span
        style={{
          position: "absolute",
          insetInlineStart: 12,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          color: "var(--text-faint)",
          display: "flex",
        }}
      >
        <MagnifyingGlass size={16} />
      </span>
      <label htmlFor="podcast-search" className="sr-only">{config.labels.search}</label>
      <input
        id="podcast-search"
        ref={inputRef}
        type="text"
        name="query"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={config.labels.search}
        toolparamtitle={config.labels.search}
        toolparamdescription="A topic, person, company, or keyword to look for across episode titles, descriptions, and transcripts."
        style={{
          width: "100%",
          paddingBlock: 9,
          paddingInlineStart: 36,
          paddingInlineEnd: 36,
          borderRadius: 10,
          border: "1.5px solid var(--border)",
          background: "var(--card)",
          color: "var(--text)",
          fontSize: 14,
          fontFamily: "var(--font-body)",
          outline: "none",
          transition: "border-color 0.15s",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "var(--accent)";
          onFocus?.(e);
        }}
        onBlur={(e) => {
          e.target.style.borderColor = "var(--border)";
          onBlur?.(e);
        }}
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          aria-label={config.labels.clear || "Clear search"}
          style={{
            position: "absolute",
            insetInlineEnd: 10,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-dim)",
            padding: 4,
            display: "flex",
          }}
        >
          <X size={16} />
        </button>
      )}
    </form>
  );
});

export default SearchBar;
