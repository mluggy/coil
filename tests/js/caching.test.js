// Caching-policy tests — lock in the "immutable or always-revalidate"
// contract: no stale-while-revalidate anywhere, no-cache HTML, immutable
// ?v= data files, and RFC-correct conditional/range handling for R2 media
// (If-None-Match → 304, If-Range validation, suffix ranges, 416).
//
// The If-Range test matters most: without validator checking, a client
// resuming playback from a cached prefix of an old upload would get byte
// ranges of the NEW file spliced onto the OLD prefix — corrupt audio.

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { onRequest } from "../../functions/_middleware.js";

const BASE = "https://example.test";

beforeAll(() => {
  if (!existsSync("functions/_episodes.js") || !existsSync("functions/_config.js")) {
    execSync("node scripts/yaml-to-json.js && node scripts/generate-html-template.js", { stdio: "pipe" });
  }
});

// next() keyed by path so extensioned requests get a plausible static body
// (the middleware treats an HTML 200 for an asset path as a masked 404).
function next(rawPath) {
  const path = rawPath.split("?")[0];
  return () => {
    if (path.endsWith(".json")) {
      return Promise.resolve(new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"static-etag"' },
      }));
    }
    if (path.endsWith(".js")) {
      return Promise.resolve(new Response("export {}", {
        status: 200,
        headers: { "Content-Type": "text/javascript" },
      }));
    }
    return Promise.resolve(new Response("<!DOCTYPE html><title>spa</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
  };
}

const MP3_BYTES = new TextEncoder().encode("OLD-MP3-CONTENT-0123456789");
const MP3_ETAG = "aabbccdd";

// Minimal R2 bucket: one object, supporting head/get with onlyIf + range,
// mirroring the R2 API surface serveR2 relies on.
function mockR2() {
  const meta = { size: MP3_BYTES.length, httpEtag: `"${MP3_ETAG}"`, httpMetadata: { contentType: "audio/mpeg" } };
  return {
    async head(key) {
      return key === "s1e1.mp3" ? { ...meta } : null;
    },
    async get(key, options = {}) {
      if (key !== "s1e1.mp3") return null;
      if (options.onlyIf?.etagDoesNotMatch === MP3_ETAG) {
        return { ...meta, body: undefined }; // precondition failed → R2Object, no body
      }
      let range, body = MP3_BYTES;
      if (options.range) {
        if (options.range.suffix != null) {
          const s = Math.min(options.range.suffix, MP3_BYTES.length);
          range = { suffix: options.range.suffix };
          body = MP3_BYTES.slice(MP3_BYTES.length - s);
        } else {
          const offset = options.range.offset ?? 0;
          if (offset >= MP3_BYTES.length) throw new Error("range not satisfiable");
          const length = Math.min(options.range.length ?? MP3_BYTES.length - offset, MP3_BYTES.length - offset);
          range = { offset, length };
          body = MP3_BYTES.slice(offset, offset + length);
        }
      }
      return { ...meta, range, body };
    },
  };
}

const env = { R2_BUCKET: mockR2() };

async function call(path, init = {}) {
  const request = new Request(`${BASE}${path}`, init);
  return onRequest({ request, next: next(path), env });
}

describe("cache-control policy", () => {
  it("serves HTML with no-cache (never stale after a deploy)", async () => {
    const res = await call("/");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("serves versioned data files as immutable", async () => {
    const res = await call("/episodes.json?v=deadbeef");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves bare data files with no-cache", async () => {
    const res = await call("/episodes.json");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("serves hashed assets as immutable", async () => {
    const res = await call("/assets/index-abc123.js");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("never emits stale-while-revalidate on core surfaces", async () => {
    for (const path of ["/", "/episodes.json", "/rss.xml", "/llms.txt", "/AGENTS.md", "/sitemap.xml", "/s1e1.mp3"]) {
      const res = await call(path);
      expect(res.headers.get("Cache-Control") || "", path).not.toContain("stale-while-revalidate");
    }
  });
});

describe("R2 media conditional requests", () => {
  it("serves a full 200 with ETag and no-cache", async () => {
    const res = await call("/s1e1.mp3");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"${MP3_ETAG}"`);
    expect(res.headers.get("Cache-Control")).toBe("public, no-cache");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await res.text()).toBe("OLD-MP3-CONTENT-0123456789");
  });

  it("answers If-None-Match with 304 and no body", async () => {
    const res = await call("/s1e1.mp3", { headers: { "If-None-Match": `"${MP3_ETAG}"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("re-downloads in full when If-None-Match is stale", async () => {
    const res = await call("/s1e1.mp3", { headers: { "If-None-Match": '"old-etag"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OLD-MP3-CONTENT-0123456789");
  });

  it("honors Range when If-Range matches the current ETag", async () => {
    const res = await call("/s1e1.mp3", {
      headers: { Range: "bytes=4-10", "If-Range": `"${MP3_ETAG}"` },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 4-10/${MP3_BYTES.length}`);
    expect(await res.text()).toBe("MP3-CON");
  });

  it("ignores Range and serves the full body when If-Range is stale (corrupt-audio fix)", async () => {
    const res = await call("/s1e1.mp3", {
      headers: { Range: "bytes=4-10", "If-Range": '"etag-of-a-previous-upload"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OLD-MP3-CONTENT-0123456789");
  });

  it("supports suffix ranges (bytes=-N)", async () => {
    const res = await call("/s1e1.mp3", { headers: { Range: "bytes=-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes ${MP3_BYTES.length - 4}-${MP3_BYTES.length - 1}/${MP3_BYTES.length}`);
    expect(await res.text()).toBe("6789");
  });

  it("answers unsatisfiable ranges with 416, not 500", async () => {
    const res = await call("/s1e1.mp3", { headers: { Range: "bytes=9999-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${MP3_BYTES.length}`);
  });
});
