// WebMCP declarative discovery — verifies the homepage HTML carries the
// in-page MCP signals (link rel=mcp, meta name=mcp-server, inline
// application/mcp+json manifest) so browser-side agents can find the
// server without a separate /.well-known fetch.

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

beforeAll(() => {
  // Ensure the template is fresh — generate-html-template depends on
  // dist/index.html (vite build) + public/episodes.json (yaml-to-json).
  if (!existsSync("dist/index.html") || !existsSync("public/episodes.json")) {
    execSync("npm run build", { stdio: "pipe" });
  } else {
    execSync("node scripts/generate-html-template.js", { stdio: "pipe" });
  }
});

describe("WebMCP discovery in homepage HTML template", () => {
  let html;
  beforeAll(() => {
    // The template is exported as `export default "<!DOCTYPE html>…"` —
    // pull the string body so we can match against literal HTML.
    const tpl = readFileSync("functions/_html-template.js", "utf8");
    const m = tpl.match(/^export default (".*");\s*$/s);
    expect(m, "expected `export default \"…\";` shape").toBeTruthy();
    html = JSON.parse(m[1]);
  });

  it("includes <link rel=\"mcp\" href=\"/mcp\">", () => {
    expect(html).toMatch(/<link rel="mcp" href="\/mcp" type="application\/json">/);
  });

  it("includes <meta name=\"mcp-server\" content=\"/mcp\">", () => {
    expect(html).toMatch(/<meta name="mcp-server" content="\/mcp">/);
  });

  it("includes <script type=\"application/mcp+json\"> with a CSP nonce", () => {
    expect(html).toMatch(/<script type="application\/mcp\+json" nonce="\{\{CSP_NONCE\}\}">/);
  });

  it("inline manifest declares Streamable HTTP MCP at /mcp", () => {
    const m = html.match(/<script type="application\/mcp\+json"[^>]*>(.*?)<\/script>/s);
    expect(m).toBeTruthy();
    const manifest = JSON.parse(m[1]);
    expect(manifest.transport).toBe("streamable-http");
    expect(manifest.url).toBe("/mcp");
    expect(manifest.manifest).toBe("/.well-known/mcp");
  });

  it("inline manifest declares the search_episodes tool with a typed input schema", () => {
    const m = html.match(/<script type="application\/mcp\+json"[^>]*>(.*?)<\/script>/s);
    const manifest = JSON.parse(m[1]);
    expect(manifest.tools).toHaveLength(1);
    const tool = manifest.tools[0];
    expect(tool.name).toBe("search_episodes");
    expect(tool.description.length).toBeGreaterThanOrEqual(20);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toContain("query");
    expect(tool.inputSchema.properties.query.type).toBe("string");
    expect(tool.inputSchema.properties.limit.type).toBe("integer");
  });
});
