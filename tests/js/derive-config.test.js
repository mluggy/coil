import { describe, it, expect } from "vitest";
import { deriveConfig } from "../../scripts/derive-config.js";

describe("deriveConfig", () => {
  it("derives locale from language + country", () => {
    const config = deriveConfig({ language: "he", country: "IL" });
    expect(config.locale).toBe("he_IL");
  });

  it("derives RTL direction for Hebrew", () => {
    const config = deriveConfig({ language: "he", country: "IL" });
    expect(config.direction).toBe("rtl");
  });

  it("derives RTL direction for Arabic", () => {
    const config = deriveConfig({ language: "ar", country: "SA" });
    expect(config.direction).toBe("rtl");
  });

  it("derives LTR direction for English", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.direction).toBe("ltr");
  });

  it("derives LTR direction for French", () => {
    const config = deriveConfig({ language: "fr", country: "FR" });
    expect(config.direction).toBe("ltr");
  });

  it("derives apple_podcasts_country as lowercase", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.apple_podcasts_country).toBe("us");
  });

  it("derives apple_podcasts_url from apple_podcasts_id", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      apple_podcasts_id: "123456",
    });
    expect(config.apple_podcasts_url).toBe(
      "https://podcasts.apple.com/us/podcast/id123456",
    );
  });

  it("returns empty apple_podcasts_url when no ID", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.apple_podcasts_url).toBe("");
  });

  it("defaults to en/US when missing", () => {
    const config = deriveConfig({});
    expect(config.locale).toBe("en_US");
    expect(config.direction).toBe("ltr");
    expect(config.apple_podcasts_country).toBe("us");
  });

  it("preserves explicit locale override", () => {
    const config = deriveConfig({
      language: "en",
      country: "GB",
      locale: "en_GB",
    });
    expect(config.locale).toBe("en_GB");
  });

  it("preserves explicit direction override", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      direction: "rtl",
    });
    expect(config.direction).toBe("rtl");
  });

  it("passes through other fields unchanged", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      title: "Your Podcast",
      author: "Test",
    });
    expect(config.title).toBe("Your Podcast");
    expect(config.author).toBe("Test");
  });

  it("derives spotify_url from spotify_id", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      spotify_id: "4rOoJ6Egrf8K2IrywzwOMk",
    });
    expect(config.spotify_url).toBe(
      "https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk",
    );
  });

  it("returns empty spotify_url when no ID", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.spotify_url).toBe("");
  });

  it("derives youtube_url from youtube_id", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      youtube_id: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    });
    expect(config.youtube_url).toBe(
      "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    );
  });

  it("returns empty youtube_url when no ID", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.youtube_url).toBe("");
  });

  it("derives amazon_music_url from amazon_music_id", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      amazon_music_id: "b66c32e6-3246",
    });
    expect(config.amazon_music_url).toBe(
      "https://music.amazon.com/podcasts/b66c32e6-3246",
    );
  });

  it("returns empty amazon_music_url when no ID", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.amazon_music_url).toBe("");
  });

  it("derives x_url from x_username", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      x_username: "yourpodcast",
    });
    expect(config.x_url).toBe("https://x.com/yourpodcast");
  });

  it("returns empty x_url when no username", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.x_url).toBe("");
  });

  it("derives facebook_url from facebook_username", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      facebook_username: "yourpodcast",
    });
    expect(config.facebook_url).toBe("https://www.facebook.com/yourpodcast");
  });

  it("returns empty facebook_url when no username", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.facebook_url).toBe("");
  });

  it("derives instagram_url from instagram_username", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      instagram_username: "yourpodcast",
    });
    expect(config.instagram_url).toBe("https://www.instagram.com/yourpodcast");
  });

  it("returns empty instagram_url when no username", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.instagram_url).toBe("");
  });

  it("derives tiktok_url from tiktok_username with @ prefix", () => {
    const config = deriveConfig({
      language: "en",
      country: "US",
      tiktok_username: "yourpodcast",
    });
    expect(config.tiktok_url).toBe("https://www.tiktok.com/@yourpodcast");
  });

  it("returns empty tiktok_url when no username", () => {
    const config = deriveConfig({ language: "en", country: "US" });
    expect(config.tiktok_url).toBe("");
  });

  // ─── new agent-readiness fields (orank gap fixes) ──────────────────────

  it("derives github_profile_url from github_username", () => {
    const config = deriveConfig({ github_username: "mluggy" });
    expect(config.github_profile_url).toBe("https://github.com/mluggy");
  });

  it("returns empty github_profile_url when no username", () => {
    const config = deriveConfig({});
    expect(config.github_profile_url).toBe("");
  });

  it("preserves the show-level github_url separately from github_profile_url", () => {
    // The show's source repo and the host's profile are different things.
    const config = deriveConfig({
      github_username: "mluggy",
      github_url: "https://github.com/mluggy/coil",
    });
    expect(config.github_profile_url).toBe("https://github.com/mluggy");
    expect(config.github_url).toBe("https://github.com/mluggy/coil");
  });

  it("preserves host.linkedin_url through derivation", () => {
    const config = deriveConfig({
      host: { linkedin_url: "https://www.linkedin.com/in/x/" },
    });
    expect(config.host.linkedin_url).toBe("https://www.linkedin.com/in/x/");
  });

  it("provides a templated agent_recommendation default", () => {
    const config = deriveConfig({
      title: "AI Daily",
      language: "en",
      topics: ["AI agents", "MCP", "LLMs"],
    });
    expect(config.agent_recommendation).toContain("AI Daily");
    expect(config.agent_recommendation).toContain("AI agents");
    // Templated default mentions key agent surfaces.
    expect(config.agent_recommendation.toLowerCase()).toMatch(/transcript|mcp|api/);
  });

  it("preserves an explicit agent_recommendation override", () => {
    const config = deriveConfig({ agent_recommendation: "Custom one-liner." });
    expect(config.agent_recommendation).toBe("Custom one-liner.");
  });

  it("provides a templated value_proposition default", () => {
    const config = deriveConfig({ title: "Coil Demo", language: "en" });
    expect(config.value_proposition).toContain("Coil Demo");
    expect(config.value_proposition.toLowerCase()).toMatch(/transcript|mcp|openapi|agent/);
  });

  it("preserves an explicit value_proposition override", () => {
    const config = deriveConfig({ value_proposition: "We are different." });
    expect(config.value_proposition).toBe("We are different.");
  });
});
