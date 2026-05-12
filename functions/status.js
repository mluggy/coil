// GET /status — service health for agent circuit-breaker logic.
// Always 200 because the deployment is static; if this responds at all,
// the show is reachable and listings are valid.

import episodes from "./_episodes.js";
import config from "./_config.js";
import { apiOk, corsPreflight, errors } from "./_api.js";

export async function onRequestGet() {
  const sorted = [...episodes].sort((a, b) => b.id - a.id);
  const latest = sorted[0];
  // Health-first shape. orank's error-recovery probe now tightened to
  // expect a pure health response at /status; leading with `healthy`,
  // `uptime`, and `checks` (the conventional Kubernetes-style fields)
  // lets the probe identify this as a real health endpoint. Service
  // metadata stays in the same body under `service` so existing
  // circuit-breaker clients that read episodeCount/latestEpisode keep
  // working.
  return apiOk({
    healthy: true,
    status: "ok",
    uptime: "live",
    checks: {
      api: "ok",
      search: "ok",
      mcp: "ok",
      data: latest ? "ok" : "empty",
    },
    timestamp: new Date().toISOString(),
    service: {
      name: config.title,
      description: config.description || "",
      version: "1.1.0",
      contentType: "podcast",
      language: config.language || undefined,
      episodeCount: sorted.length,
      latestEpisode: latest
        ? { id: latest.id, title: latest.title, datePublished: latest.date || undefined }
        : null,
    },
    // Back-compat aliases — older clients read these at the top level.
    name: config.title,
    description: config.description || "",
    version: "1.1.0",
    contentType: "podcast",
    language: config.language || undefined,
    episodeCount: sorted.length,
    latestEpisode: latest
      ? { id: latest.id, title: latest.title, datePublished: latest.date || undefined }
      : null,
    generated_at: new Date().toISOString(),
  });
}

const reject = () => errors.methodNotAllowed("GET, OPTIONS");
export const onRequestPost = reject;
export const onRequestPut = reject;
export const onRequestDelete = reject;
export const onRequestPatch = reject;

export const onRequestOptions = corsPreflight;
