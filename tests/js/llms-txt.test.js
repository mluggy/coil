// Tests for the four section-level llms.txt files + the /llms-full.txt
// aggregate. orank's "Identity → llms.txt content quality" check looks
// for specific structural elements: agent instructions, capabilities,
// constraints, use cases. These tests pin those down so a refactor of
// the generator can't silently drop them.

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

beforeAll(() => {
  // Generators are idempotent; ensure inputs exist + outputs are fresh.
  if (!existsSync("public/episodes.json")) {
    execSync("node scripts/yaml-to-json.js", { stdio: "pipe" });
  }
  execSync("node scripts/generate-llms.js", { stdio: "pipe" });
});

function read(path) {
  return readFileSync(path, "utf8");
}

describe("/llms.txt — show briefing", () => {
  let txt;
  beforeAll(() => {
    txt = read("public/llms.txt");
  });

  it("opens with an H1 title", () => {
    expect(txt).toMatch(/^# /);
  });

  it("includes a top-level Agent instructions block", () => {
    expect(txt).toMatch(/## Agent instructions/);
    expect(txt).toMatch(/If you are an AI agent reading this/);
  });

  it("walks an agent through the cheapest path per intent (numbered list)", () => {
    expect(txt).toMatch(/1\. \*\*Discovery:\*\*/);
    expect(txt).toMatch(/2\. \*\*Latest episode:\*\*/);
    expect(txt).toMatch(/3\. \*\*Find an episode by topic/);
    expect(txt).toMatch(/4\. \*\*Natural-language ask:\*\*/);
  });

  it("declares auth + rate-limit + error envelope inline", () => {
    expect(txt).toMatch(/\*\*Auth:\*\*/);
    expect(txt).toMatch(/\*\*Rate limit:\*\*/);
    expect(txt).toMatch(/\*\*Errors:\*\*/);
  });

  it("advertises optional OAuth + scopes", () => {
    expect(txt).toMatch(/oauth-authorization-server/);
    expect(txt).toMatch(/read:episodes/);
  });

  it("includes Why-this-podcast (value proposition)", () => {
    expect(txt).toMatch(/## Why this podcast/);
  });

  it("includes Use cases section mapping listener intent → endpoint", () => {
    expect(txt).toMatch(/## Use cases/);
  });

  it("includes Constraints (rate-limit, languages, search)", () => {
    expect(txt).toMatch(/## Constraints/);
    expect(txt).toMatch(/Rate limit/i);
    expect(txt).toMatch(/Auth/);
  });

  it("includes a Capabilities section", () => {
    expect(txt).toMatch(/## Capabilities/);
  });

  it("declares Auth & payment block with x402/MPP pointer", () => {
    expect(txt).toMatch(/## Auth & payment/);
    expect(txt).toMatch(/x402/);
  });

  it("includes Section-level llms.txt cross-links", () => {
    expect(txt).toMatch(/## Section-level llms\.txt/);
    expect(txt).toContain("/api/llms.txt");
    expect(txt).toContain("/episodes/llms.txt");
    expect(txt).toContain("/.well-known/llms.txt");
    expect(txt).toContain("/llms-full.txt");
  });

  it("uses the {{SITE_URL}} placeholder consistently (no hard-coded host)", () => {
    expect(txt).not.toMatch(/https?:\/\/(?!.*\{\{SITE_URL\}\})/);
  });
});

describe("/api/llms.txt — API surface briefing", () => {
  let txt;
  beforeAll(() => {
    txt = read("public/api/llms.txt");
  });

  it("includes Quickstart with a runnable curl block", () => {
    expect(txt).toMatch(/## Quickstart/);
    expect(txt).toMatch(/```bash/);
    expect(txt).toMatch(/curl/);
  });

  it("includes Authentication section explaining zero-auth + optional OAuth", () => {
    expect(txt).toMatch(/## Authentication/);
    expect(txt).toMatch(/zero-auth|public, read-only/i);
    expect(txt).toMatch(/PKCE S256/);
    expect(txt).toMatch(/oauth-authorization-server/);
  });

  it("includes M2M / agent auth walkthrough", () => {
    expect(txt).toMatch(/M2M|client_credentials/);
  });

  it("lists available scopes", () => {
    expect(txt).toMatch(/read:episodes/);
    expect(txt).toMatch(/read:transcripts/);
    expect(txt).toMatch(/search:episodes/);
  });

  it("includes SDK install section", () => {
    expect(txt).toMatch(/## SDK install/);
  });

  it("documents 402 in the error envelope alongside 400/404/429", () => {
    expect(txt).toMatch(/402/);
    expect(txt).toMatch(/payment_required|donation/);
  });

  it("lists every endpoint family", () => {
    expect(txt).toMatch(/### Search/);
    expect(txt).toMatch(/### Ask/);
    expect(txt).toMatch(/### Status/);
    expect(txt).toMatch(/### MCP server/);
    expect(txt).toMatch(/### OpenAPI/);
  });
});

describe("/.well-known/llms.txt", () => {
  let txt;
  beforeAll(() => {
    txt = read("public/.well-known/llms.txt");
  });

  it("enumerates discovery files (agent.json, agent-card, openapi, schema-map, mcp)", () => {
    expect(txt).toContain("agent.json");
    expect(txt).toContain("agent-card.json");
    expect(txt).toContain("openapi.json");
    expect(txt).toContain("schema-map.xml");
    expect(txt).toContain("mcp");
  });
});

describe("/episodes/llms.txt", () => {
  let txt;
  beforeAll(() => {
    txt = read("public/episodes/llms.txt");
  });

  it("opens with an H1 + cross-link to root /llms.txt", () => {
    expect(txt).toMatch(/^# /);
    expect(txt).toContain("/llms.txt");
  });
});

describe("/docs/llms.txt", () => {
  let txt;
  beforeAll(() => {
    txt = read("public/docs/llms.txt");
  });

  it("points at /docs.md and the OpenAPI spec", () => {
    expect(txt).toContain("/docs.md");
    expect(txt).toContain("openapi.json");
  });

  it("cross-links every adjacent llms.txt", () => {
    expect(txt).toContain("/llms.txt");
    expect(txt).toContain("/api/llms.txt");
    expect(txt).toContain("/episodes/llms.txt");
  });
});

describe("/llms-full.txt — single-file aggregate", () => {
  let txt;
  beforeAll(() => {
    txt = read("public/llms-full.txt");
  });

  it("contains all four section files concatenated with --- delimiters", () => {
    expect(txt).toMatch(/^# /);
    // At least 4 horizontal rules separate the 5 sections.
    const rules = (txt.match(/^---$/gm) || []).length;
    expect(rules).toBeGreaterThanOrEqual(4);
  });

  it("includes the API surface section content", () => {
    expect(txt).toMatch(/## Quickstart/);
    expect(txt).toMatch(/## Authentication/);
  });
});
