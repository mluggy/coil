import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

describe("yaml-to-json script", () => {
  it("generates episodes.json with expected structure", () => {
    // Run the script fresh
    execSync("node scripts/yaml-to-json.js", { stdio: "pipe" });

    const json = JSON.parse(readFileSync("public/episodes.json", "utf8"));
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThan(0);

    const ep = json[0];
    // Required fields
    expect(ep).toHaveProperty("id");
    expect(ep).toHaveProperty("season");
    expect(ep).toHaveProperty("title");
    expect(ep).toHaveProperty("audioFile");
    expect(ep).toHaveProperty("srtFile");
    expect(ep).toHaveProperty("guid");
    // `hasSrt` is intentionally not asserted here: compact() strips falsy
    // fields, so an episode without a transcript has no hasSrt key at all.

    // Audio file naming convention
    expect(ep.audioFile).toMatch(/^s\d+e\d+\.mp3$/);
    expect(ep.srtFile).toMatch(/^s\d+e\d+\.srt$/);
  });

  it("generates search-index.json", () => {
    execSync("node scripts/yaml-to-json.js", { stdio: "pipe" });

    expect(existsSync("public/search-index.json")).toBe(true);
    const index = JSON.parse(readFileSync("public/search-index.json", "utf8"));
    expect(typeof index).toBe("object");
    // At least one episode should be indexed
    expect(Object.keys(index).length).toBeGreaterThan(0);
  });

  it("does not leak _fullText into episodes.json", () => {
    execSync("node scripts/yaml-to-json.js", { stdio: "pipe" });

    const json = JSON.parse(readFileSync("public/episodes.json", "utf8"));
    for (const ep of json) {
      expect(ep).not.toHaveProperty("_fullText");
    }
  });

  it("emits hasSrt only as a true flag (false is compacted out)", () => {
    execSync("node scripts/yaml-to-json.js", { stdio: "pipe" });

    const json = JSON.parse(readFileSync("public/episodes.json", "utf8"));
    // compact() strips falsy fields, so hasSrt is either absent or true —
    // never false. A present hasSrt therefore always means "has transcript".
    for (const ep of json) {
      if ("hasSrt" in ep) expect(ep.hasSrt).toBe(true);
    }
  });
});
