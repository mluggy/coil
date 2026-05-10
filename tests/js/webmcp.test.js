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

  it("registers the search_episodes tool via navigator.modelContext (imperative WebMCP API)", () => {
    // Audits look for the canonical browser-side imperative API, not just
    // declarative discovery. The script must call registerTool with a
    // typed inputSchema so the tool is callable from a browser-side
    // agent without further introspection.
    expect(html).toMatch(/navigator\.modelContext/);
    expect(html).toMatch(/registerTool\s*\(/);
    expect(html).toMatch(/name:\s*"search_episodes"/);
    expect(html).toMatch(/invoke:\s*async\s+function/);
    // Guarded so pages running in a non-WebMCP browser don't error.
    expect(html).toMatch(/!navigator\.modelContext/);
  });

  it("declares <link rel=\"payment\"> + x402-resource meta for /donate", () => {
    expect(html).toMatch(/<link rel="payment" href="\/donate"[^>]*>/);
    expect(html).toMatch(/<meta name="x402-resource" content="\/donate">/);
  });
});
