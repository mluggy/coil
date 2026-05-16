import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { deriveConfig } from "./scripts/derive-config.js";

const podcastConfig = deriveConfig(yaml.load(fs.readFileSync("podcast.yaml", "utf8")));

function buildHeadTags(config) {
  const sameAs = [
    config.spotify_url, config.apple_podcasts_url,
    config.youtube_url, config.amazon_music_url,
    config.x_url, config.facebook_url, config.instagram_url,
    config.tiktok_url, config.linkedin_url,
  ].filter(Boolean);

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "PodcastSeries",
    name: config.title,
    description: config.description,
    url: "{{SITE_URL}}",
    image: `{{SITE_URL}}${config.cover || "/cover.png"}`,
    inLanguage: config.language,
    author: { "@type": "Person", name: config.author },
    webFeed: "{{SITE_URL}}/rss.xml",
    sameAs,
  });

  const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const themeColor = (config.default_theme || "dark") === "light" ? (config.bg_light || "#fafaf9") : (config.bg_dark || "#0a0a0b");
  const lines = [
    `<title>${config.title}</title>`,
    `<meta name="description" content="${esc(config.description)}">`,
    `<meta name="theme-color" content="${themeColor}">`,
    `<link rel="canonical" href="{{SITE_URL}}/">`,
    `<link rel="manifest" href="/manifest.json">`,
    `<link rel="preload" href="/episodes.json" as="fetch" crossorigin>`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<style nonce="{{CSP_NONCE}}">:root{--bg:${config.bg_dark||"#0a0a0b"}}[data-theme="light"]{--bg:${config.bg_light||"#fafaf9"}}body{background:var(--bg)}</style>`,
    // Google Fonts — preconnect + stylesheet
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    (() => {
      const fontBody = (config.font || "Noto Sans").replace(/ /g, "+");
      const fontUrl = `https://fonts.googleapis.com/css2?family=${fontBody}:wght@300;400;500;600;700&display=swap`;
      return `<link rel="preload" as="style" href="${fontUrl}"><link rel="stylesheet" href="${fontUrl}" media="print" id="gfonts"><script nonce="{{CSP_NONCE}}">document.getElementById('gfonts').onload=function(){this.media='all'}</script>`;
    })(),
    `<meta property="og:title" content="${esc(config.title)}">`,
    `<meta property="og:description" content="${esc(config.description)}">`,
    `<meta property="og:image" content="{{SITE_URL}}${config.cover}">`,
    `<meta property="og:url" content="{{SITE_URL}}/">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="${config.locale}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ];
  // If cookie_consent label is set, gate analytics behind an accepted cookie.
  // Otherwise load them immediately (backwards compatible).
  const consentGated = !!config.labels?.cookie_consent;
  const consentOk = consentGated
    ? `(document.cookie.indexOf('cookie_consent=accepted')>-1)`
    : `true`;
  // Preconnect hints and the <noscript> pixel would fire before consent,
  // so when consent gating is on we inject the preconnect via JS *inside*
  // the same consent-gated block and omit the <noscript> pixel entirely
  // (no-JS users never see the consent banner, so we cannot ask them).
  if (config.ga_measurement_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://www.googletagmanager.com">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://www.googletagmanager.com';document.head.appendChild(pc);var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${config.ga_measurement_id}';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','${config.ga_measurement_id}',{send_page_view:false});}</script>`,
    );
  }
  if (config.fb_pixel_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://connect.facebook.net">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://connect.facebook.net';document.head.appendChild(pc);!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${config.fb_pixel_id}');}</script>`,
    );
    if (!consentGated) {
      lines.push(`<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${config.fb_pixel_id}&ev=PageView&noscript=1"/></noscript>`);
    }
  }
  if (config.x_pixel_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://static.ads-twitter.com">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://static.ads-twitter.com';document.head.appendChild(pc);!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments)},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');twq('init','${config.x_pixel_id}');}</script>`,
    );
  }
  if (config.linkedin_partner_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://snap.licdn.com">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://snap.licdn.com';document.head.appendChild(pc);window._linkedin_partner_id='${config.linkedin_partner_id}';window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(window._linkedin_partner_id);!function(l){if(!l.getElementById('linkedin-insight')){var s=l.createElement('script');s.id='linkedin-insight';s.async=!0;s.src='https://snap.licdn.com/li.lms-analytics/insight.min.js';var b=l.getElementsByTagName('script')[0];b.parentNode.insertBefore(s,b)}}(document);}</script>`,
    );
  }
  if (config.clarity_project_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://www.clarity.ms">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://www.clarity.ms';document.head.appendChild(pc);!function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src='https://www.clarity.ms/tag/'+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)}(window,document,'clarity','script','${config.clarity_project_id}');}</script>`,
    );
  }
  if (config.microsoft_uet_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://bat.bing.com">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://bat.bing.com';document.head.appendChild(pc);!function(w,d,t,r,u){var f,n,i;w[u]=w[u]||[],f=function(){var o={ti:'${config.microsoft_uet_id}'};o.q=w[u],w[u]=new UET(o)},n=d.createElement(t),n.src=r,n.async=1,n.onload=n.onreadystatechange=function(){var s=this.readyState;s&&s!=='loaded'&&s!=='complete'||(f(),n.onload=n.onreadystatechange=null)},i=d.getElementsByTagName(t)[0],i.parentNode.insertBefore(n,i)}(window,document,'script','https://bat.bing.com/bat.js','uetq');}</script>`,
    );
  }
  if (config.tiktok_pixel_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://analytics.tiktok.com">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://analytics.tiktok.com';document.head.appendChild(pc);!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement('script');o.type='text/javascript',o.async=!0,o.src=i+'?sdkid='+e+'&lib='+t;var a=document.getElementsByTagName('script')[0];a.parentNode.insertBefore(o,a)};ttq.load('${config.tiktok_pixel_id}')}(window,document,'ttq');}</script>`,
    );
  }
  if (config.snap_pixel_id) {
    if (!consentGated) {
      lines.push(`<link rel="preconnect" href="https://sc-static.net">`);
    }
    lines.push(
      `<script nonce="{{CSP_NONCE}}">if(${consentOk}){var pc=document.createElement('link');pc.rel='preconnect';pc.href='https://sc-static.net';document.head.appendChild(pc);!function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s=t.createElement('script');s.async=!0;s.src=n;var u=t.getElementsByTagName('script')[0];u.parentNode.insertBefore(s,u)}(window,document,'https://sc-static.net/scevent.min.js');snaptr('init','${config.snap_pixel_id}',{});}</script>`,
    );
  }
  lines.push(`<script type="application/ld+json">${jsonLd}</script>`);
  // Inline theme init — reads cookie and applies data-theme before React hydrates (prevents FOUC)
  lines.push(`<script nonce="{{CSP_NONCE}}">!function(){try{var m=document.cookie.match(/(?:^|;\\s*)theme=(dark|light)/);var t=m?m[1]:"${config.default_theme||"dark"}";document.documentElement.setAttribute("data-theme",t);document.querySelector('meta[name=theme-color]').content=t==="light"?"${config.bg_light||"#fafaf9"}":"${config.bg_dark||"#0a0a0b"}"}catch(e){}}()</script>`);
  return lines.join("\n    ");
}

export default defineConfig({
  define: {
    __PODCAST_CONFIG__: JSON.stringify(podcastConfig),
  },
  plugins: [
    react(),
    {
      name: "inject-head-tags",
      transformIndexHtml(html) {
        return html.replace(/\s*<!--HEAD_TAGS-->\s*/, "\n    " + buildHeadTags(podcastConfig) + "\n  ");
      },
    },
    {
      name: "inline-css-and-preload-entry",
      apply(_config, { command }) { return command === "build"; },
      enforce: "post",
      generateBundle(_, bundle) {
        const cssAssets = [];
        const htmlFiles = [];
        let entryJs = null;
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (fileName.endsWith(".css")) cssAssets.push({ fileName, source: chunk.source });
          if (fileName.endsWith(".html")) htmlFiles.push(chunk);
          if (chunk.type === "chunk" && chunk.isEntry) entryJs = fileName;
        }
        for (const html of htmlFiles) {
          let src = html.source;
          for (const css of cssAssets) {
            const escaped = css.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            src = src.replace(
              new RegExp(`<link[^>]+href="/[^"]*${escaped}"[^>]*>`),
              `<style nonce="{{CSP_NONCE}}">${css.source}</style>`,
            );
            delete bundle[css.fileName];
          }
          // Inject modulepreload for the entry JS so the browser fetches it
          // immediately via the preload scanner, breaking the critical chain.
          if (entryJs) {
            src = src.replace("</head>", `  <link rel="modulepreload" href="/${entryJs}">\n  </head>`);
          }
          html.source = src;
        }
      },
    },
    {
      name: "watch-config-and-episodes",
      apply(_config, { command }) { return command === "serve" && !process.env.VITEST; },
      configureServer(server) {
        const watched = [
          path.resolve("podcast.yaml"),
          path.resolve("episodes/episodes.yaml"),
        ];
        const onChange = async (file) => {
          console.log(`\n[coil] ${path.basename(file)} changed — regenerating & restarting dev server...`);
          try { execSync("node scripts/yaml-to-json.js", { stdio: "inherit" }); } catch {}
          // forceOptimize=true ensures deps and config are fully re-evaluated,
          // then nudge the browser to full-reload once restart completes.
          await server.restart(true);
          server.ws.send({ type: "full-reload", path: "*" });
        };
        for (const f of watched) fs.watchFile(f, { interval: 500 }, () => onChange(f));
        server.httpServer?.on("close", () => watched.forEach(f => fs.unwatchFile(f)));
      },
    },
    {
      name: "serve-episodes",
      apply(_config, { command }) { return command === "serve" && !process.env.VITEST; },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Files containing the {{SITE_URL}} placeholder — read from
          // public/ (or episodes/ for rss.xml), substitute with the dev
          // server's own origin, and serve. Also forces charset=utf-8 so
          // non-ASCII content renders correctly.
          const rewriteMatch = req.url && /^\/(llms\.txt|robots\.txt|sitemap\.xml|rss\.xml)(\?|$)/.test(req.url);
          if (rewriteMatch) {
            const bare = req.url.split("?")[0].slice(1);
            const searchRoots = bare === "rss.xml" ? ["episodes", "public"] : ["public"];
            let filePath = null;
            for (const root of searchRoots) {
              const p = path.resolve(root, decodeURIComponent(bare));
              if (fs.existsSync(p)) { filePath = p; break; }
            }
            if (filePath) {
              const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
              const body = fs.readFileSync(filePath, "utf8").replace(/\{\{SITE_URL\}\}/g, origin);
              const mime = bare.endsWith(".xml")
                ? (bare === "rss.xml" ? "application/rss+xml" : "application/xml")
                : "text/plain";
              res.setHeader("Content-Type", `${mime}; charset=utf-8`);
              res.setHeader("Content-Length", Buffer.byteLength(body));
              res.end(body);
              return;
            }
          }
          // Episode media (sXeY.{mp3|srt|txt|png|jpg}) comes from episodes/.
          // Match only that pattern so unrelated static files fall through
          // to the public/ dir.
          const isEpisodeMedia = req.url && /^\/s\d+e\d+\.(mp3|srt|txt|png|jpg)(\?|$)/.test(req.url);
          if (isEpisodeMedia) {
            const filePath = path.resolve("episodes", decodeURIComponent(req.url.split("?")[0].slice(1)));
            if (fs.existsSync(filePath)) {
              const ext = path.extname(filePath);
              const mimeMap = { ".mp3": "audio/mpeg", ".srt": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg" };
              const mime = mimeMap[ext] || "application/octet-stream";
              const stat = fs.statSync(filePath);
              res.setHeader("Content-Type", mime);
              res.setHeader("Content-Length", stat.size);
              res.setHeader("Accept-Ranges", "bytes");
              fs.createReadStream(filePath).pipe(res);
              return;
            }
            // Episode file expected but missing locally — 404. Dev plays only
            // what's in episodes/; use `npm run preview` (wrangler pages dev)
            // to test R2-backed episodes via the real middleware.
            res.statusCode = 404;
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    modulePreload: { polyfill: false },
  },
});
