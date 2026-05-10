import { execSync } from "child_process";
import { copyFileSync, mkdirSync } from "fs";

const steps = [
  { label: "yaml-to-json", cmd: "node scripts/yaml-to-json.js" },
  { label: "generate-og", cmd: "node scripts/generate-og.js" },
  { label: "generate-feed", cmd: "python scripts/generate_feed.py episodes/" },
  {
    label: "copy-rss-to-public",
    fn: () => {
      // episodes/rss.xml is the committed canonical feed. Copy it into
      // public/ so Vite bundles it into dist/ for Cloudflare Pages to serve.
      mkdirSync("public", { recursive: true });
      copyFileSync("episodes/rss.xml", "public/rss.xml");
    },
  },
  { label: "generate-sitemap", cmd: "node scripts/generate-sitemap.js" },
  { label: "generate-llms", cmd: "node scripts/generate-llms.js" },
  { label: "generate-pricing", cmd: "node scripts/generate-pricing.js" },
  { label: "generate-docs", cmd: "node scripts/generate-docs.js" },
  { label: "generate-agent-files", cmd: "node scripts/generate-agent-files.js" },
  { label: "generate-agent-skills", cmd: "node scripts/generate-agent-skills.js" },
  { label: "generate-web-bot-auth", cmd: "node scripts/generate-web-bot-auth.js" },
  { label: "generate-oauth", cmd: "node scripts/generate-oauth.js" },
  { label: "generate-openapi", cmd: "node scripts/generate-openapi.js" },
  { label: "vite build", cmd: "npx vite build" },
  { label: "generate-html-template", cmd: "node scripts/generate-html-template.js" },
];

for (let i = 0; i < steps.length; i++) {
  const { label, cmd, fn } = steps[i];
  console.log(`\nStep ${i + 1}/${steps.length}: ${label}`);
  if (fn) fn();
  else execSync(cmd, { stdio: "inherit" });
}

console.log("\nBuild complete!");
