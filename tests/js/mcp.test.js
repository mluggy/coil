// MCP server contract test (Streamable HTTP, JSON-RPC 2.0).
// Pins orank-relevant behavior: initialize handshake (with OAuth metadata),
// tools/list shape, tools/call argument validation, parameter schemas.

import { describe, it, expect, beforeAll } from "vitest";
import { handleMcpPost, TOOLS, SERVER_INFO, PROTOCOL_VERSION } from "../../functions/mcp.js";

const BASE = "https://example.test";

function rpc(body) {
  return handleMcpPost(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function rpcJson(body) {
  return JSON.parse(await (await rpc(body)).text());
}

describe("MCP TOOLS catalog", () => {
  it("declares at least the five listener-facing tools", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search_episodes",
        "get_episode",
        "get_latest_episode",
        "list_episodes",
        "subscribe_via_rss",
      ])
    );
  });

  it("every tool has a >= 20 char description (orank MCP descriptions check)", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("every tool has a typed inputSchema with properties + required", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeTruthy();
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("every tool advertises read-only annotations", () => {
    for (const t of TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.annotations.idempotentHint).toBe(true);
    }
  });
});

describe("initialize", () => {
  it("returns serverInfo + protocolVersion + instructions", async () => {
    const r = await rpcJson({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.result.serverInfo.name).toBe(SERVER_INFO.name);
    expect(r.result.serverInfo.version).toBe(SERVER_INFO.version);
    expect(r.result.instructions.length).toBeGreaterThan(50);
  });

  it("declares tools + resources capabilities", async () => {
    const r = await rpcJson({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r.result.capabilities.tools).toBeTruthy();
    expect(r.result.capabilities.resources).toBeTruthy();
  });

  it("advertises OAuth metadata for the optional bearer flow", async () => {
    const r = await rpcJson({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const auth = r.result.auth;
    expect(auth.type).toBe("oauth2");
    // The server actually accepts anonymous calls; metadata is present
    // for clients that want to use OAuth, but it isn't required.
    expect(auth.required).toBe(false);
    expect(auth.anonymous).toBe(true);
    expect(auth.pkce).toBe("S256");
    expect(auth.code_challenge_methods_supported).toEqual(["S256"]);
    expect(auth.flows).toEqual(
      expect.arrayContaining(["authorization_code", "client_credentials"])
    );
    expect(auth.scopes).toEqual(
      expect.arrayContaining(["read:episodes", "read:transcripts", "search:episodes"])
    );
    expect(auth.metadata.authorization_server).toMatch(/oauth-authorization-server$/);
    expect(auth.metadata.protected_resource).toMatch(/oauth-protected-resource$/);
    expect(auth.publicClientId).toBe("public");
  });
});

describe("ping", () => {
  it("returns an empty result", async () => {
    const r = await rpcJson({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(r.id).toBe(7);
    expect(r.result).toEqual({});
  });
});

describe("tools/list", () => {
  it("returns the full TOOLS catalog", async () => {
    const r = await rpcJson({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.result.tools.length).toBe(TOOLS.length);
  });
});

describe("tools/call validation", () => {
  it("rejects unknown tools with -32601 + availableTools hint", async () => {
    const r = await rpcJson({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(r.error.code).toBe(-32601);
    expect(r.error.data.availableTools).toContain("search_episodes");
  });

  it("rejects calls with no name with -32602 + availableTools hint", async () => {
    const r = await rpcJson({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {},
    });
    expect(r.error.code).toBe(-32602);
    expect(r.error.data.availableTools).toBeTruthy();
  });

  it("invokes search_episodes successfully", async () => {
    const r = await rpcJson({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "search_episodes", arguments: { query: "test", limit: 1 } },
    });
    expect(r.result.isError).toBe(false);
    expect(Array.isArray(r.result.content)).toBe(true);
  });
});

describe("MCP App view CSP (resources/read)", () => {
  let html;
  beforeAll(async () => {
    const r = await rpcJson({
      jsonrpc: "2.0",
      id: 20,
      method: "resources/read",
      params: { uri: "ui://catalog" },
    });
    html = r.result.contents[0].text;
  });

  it("ships a Content-Security-Policy meta tag", () => {
    expect(html).toMatch(
      /<meta http-equiv="Content-Security-Policy" content="[^"]+"/
    );
  });

  it("uses a scoped policy — no permissive bare wildcard", () => {
    const csp = html.match(/content="([^"]+)"/)[1].replace(/&#39;/g, "'");
    expect(csp).toMatch(/default-src 'none'/);
    // A bare `*` source is permissive and loses orank points; a scoped
    // subdomain wildcard like `*.googletagmanager.com` (GA) is fine.
    expect(csp).not.toMatch(/(^|[\s;])\*([\s;]|$)/);
  });

  it("scopes connect-src/img-src to the MCP server origin", () => {
    const csp = html.match(/content="([^"]+)"/)[1].replace(/&#39;/g, "'");
    expect(csp).toMatch(/connect-src[^;]*https:\/\/example\.test/);
    expect(csp).toMatch(/img-src[^;]*https:\/\/example\.test/);
  });

  it("allows framing only by ChatGPT and Claude", () => {
    const csp = html.match(/content="([^"]+)"/)[1].replace(/&#39;/g, "'");
    expect(csp).toMatch(/frame-ancestors[^;]*https:\/\/chatgpt\.com/);
    expect(csp).toMatch(/frame-ancestors[^;]*https:\/\/claude\.ai/);
  });
});

describe("unknown method", () => {
  it("returns -32601 method not found", async () => {
    const r = await rpcJson({ jsonrpc: "2.0", id: 9, method: "garbage/here" });
    expect(r.error.code).toBe(-32601);
  });
});

describe("malformed JSON", () => {
  it("returns -32700 parse error", async () => {
    const r = JSON.parse(
      await (
        await handleMcpPost(
          new Request(`${BASE}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "not json",
          })
        )
      ).text()
    );
    expect(r.error.code).toBe(-32700);
  });
});
