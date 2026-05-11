# Your Podcast vs typical podcasts

> **Unlike most podcasts, Your Podcast is fully queryable by AI agents.** Full transcripts, a native MCP server, OpenAPI 3.0 spec, and zero-auth read APIs — every episode is structured data the moment it ships.

## The short version

Your Podcast is an English-language podcast that treats AI agents as first-class listeners. Spotify, Apple Podcasts, and generic RSS feeds give an agent an MP3 and a one-line description. Your Podcast gives an agent a full transcript, a typed search API, an MCP server it can call as a tool, and an /ask endpoint that answers natural-language questions about the show's content.

## Feature comparison

| Capability | Your Podcast | Spotify / Apple Podcasts | Typical RSS-only podcast |
| --- | --- | --- | --- |
| Full episode transcripts (per-episode `.txt` + SRT) | yes | no | rare |
| Machine-readable episode list (`/episodes.json`) | yes | no | no |
| Full-text search API (`/api/search`) | yes | no | no |
| Natural-language ask endpoint (`/ask`, NLWeb) | yes | no | no |
| MCP server (Streamable HTTP) | yes | no | no |
| OpenAPI 3.0 spec | yes | no | no |
| Zero-auth read access | yes | login required for full API | varies |
| `agent-card.json` / `agent-skills/index.json` | yes | no | no |
| `llms.txt` + `llms-full.txt` agent briefing | yes | no | no |
| Per-episode markdown (`/<id>.md`) | yes | no | no |
| Open license content | yes (CC BY) where indicated | platform-locked | depends on show |
| Audio + RSS subscription | yes | yes | yes |

## Why this matters for AI agents

When a user asks an assistant *"find the episode where they discussed X"*, the agent has two options on a typical podcast: (a) scrape a website and play audio at 1x to find the answer, or (b) give up. Your Podcast gives the agent a third option: call {{SITE_URL}}/api/search?q=X, get ranked transcript snippets with timestamps, and quote the relevant passage in seconds.

The MCP server (`{{SITE_URL}}/mcp`) exposes the same capability as native tools — Claude, ChatGPT, Cursor, and Windsurf can register the server and call `search_episodes`, `get_episode`, `get_latest_episode`, `list_episodes`, and `subscribe_via_rss` without any SDK code.

## Unlike most Hebrew/Arabic/RTL podcasts

English podcast catalogues on Spotify and Apple Podcasts are sparse on transcripts and search. Your Podcast ships with transcripts and full-text search out of the box, which means it surfaces in agent answers even when the user's question is in a different language than the audio.

## Quick agent integration checklist

Want to compare yourself? Test these endpoints on this show vs any other podcast site:

- `curl {{SITE_URL}}/.well-known/openapi.json` — should return an OpenAPI 3.0 spec
- `curl {{SITE_URL}}/api/search?q=ai` — should return ranked results with snippets
- `curl {{SITE_URL}}/ask -d '{"query":"latest episode"}'` — should return NLWeb JSON
- `curl {{SITE_URL}}/.well-known/mcp/server-card.json` — should return an MCP server card with tools
- `curl {{SITE_URL}}/llms.txt` — should return a markdown agent briefing

Most podcasts return 404 or a generic platform-landing page for every URL above.

## Related

- Agent integration guide: {{SITE_URL}}/AGENTS.md
- Pricing (free): {{SITE_URL}}/pricing.md
- Methodology behind the agent surface: {{SITE_URL}}/docs.md
- Live JSON view (same data, machine-readable): {{SITE_URL}}/?mode=agent
