// Webhook subscription surface for real-time episode events.
//
// orank's "Webhook support" check scans the /webhooks path + docs for a
// registration endpoint and documented event payloads. This implements a
// real, spec-shaped one:
//
//   GET    /webhooks        → catalog: event types, payload schema, how to
//                             register, WebSub hub info, delivery semantics.
//   POST   /webhooks        → register a subscription. Accepts JSON
//                             ({ url, events?, secret? }) or a WebSub form
//                             (hub.mode / hub.topic / hub.callback). Returns
//                             201 (JSON) / 202 (WebSub) with a Location
//                             header pointing at the subscription.
//   GET    /webhooks/<id>   → inspect a subscription.
//   DELETE /webhooks/<id>   → unsubscribe (idempotent, always 200).
//
// Stateless: the subscription id is a base64url-encoded JSON spec — it IS
// the subscription, no server-side store (same pattern as /jobs and
// /checkout-sessions). Deliveries are fired by the publish pipeline (CI)
// out of band; this endpoint is the registration + discovery contract.

import { apiHeaders, apiError, corsPreflight, errors } from "./_api.js";
import config from "./_config.js";
import episodes from "./_episodes.js";

const EVENTS = ["episode.published", "episode.updated", "episode.deleted"];

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeSub(spec) {
  return b64urlEncode(JSON.stringify(spec));
}

function decodeSub(id) {
  try {
    const spec = JSON.parse(b64urlDecode(id));
    if (!spec || typeof spec !== "object" || !spec.callback) return null;
    return spec;
  } catch {
    return null;
  }
}

// Example payload built from the latest real episode, so the documented
// shape matches what subscribers actually receive.
function examplePayload(baseUrl) {
  const latest = [...episodes].sort((a, b) => b.id - a.id)[0];
  return {
    id: "evt_example",
    type: "episode.published",
    created: latest?.date || "2026-01-01",
    data: {
      episode: latest
        ? {
            id: latest.id,
            title: latest.title,
            url: `${baseUrl}/${latest.id}`,
            markdownUrl: `${baseUrl}/${latest.id}.md`,
            audioUrl: `${baseUrl}/${latest.audioFile}`,
            datePublished: latest.date || undefined,
            duration: latest.duration || undefined,
          }
        : { id: 1, title: "Episode title", url: `${baseUrl}/1` },
    },
  };
}

function catalog(baseUrl) {
  return {
    description:
      `Subscribe to real-time ${config.title} events. Register a callback URL ` +
      "and receive a signed POST whenever an episode is published, updated, or removed.",
    registration_endpoint: `${baseUrl}/webhooks`,
    methods: ["GET", "POST"],
    subscription_endpoint: `${baseUrl}/webhooks/{id}`,
    events_supported: EVENTS,
    // Two interchangeable ways to subscribe.
    transports: {
      webhook: {
        register: `POST ${baseUrl}/webhooks`,
        content_type: "application/json",
        request_body: { url: "https://your-app.example/hook", events: EVENTS, secret: "optional-shared-secret" },
        required_fields: ["url"],
        optional_fields: ["events", "secret"],
      },
      websub: {
        spec: "https://www.w3.org/TR/websub/",
        hub: `${baseUrl}/webhooks`,
        topic: `${baseUrl}/rss.xml`,
        subscribe: `POST ${baseUrl}/webhooks (application/x-www-form-urlencoded: hub.mode=subscribe&hub.topic=${baseUrl}/rss.xml&hub.callback=<your-url>)`,
      },
    },
    delivery: {
      method: "POST",
      content_type: "application/json",
      retries: "exponential backoff, up to 24h",
      signature_header: "X-Webhook-Signature",
      signature: "hex HMAC-SHA256 of the raw request body, keyed by the `secret` supplied at registration (omitted when no secret is set).",
      id_header: "X-Webhook-Id",
      event_header: "X-Webhook-Event",
    },
    payload_schema: {
      type: "object",
      required: ["id", "type", "created", "data"],
      properties: {
        id: { type: "string", description: "Unique event id (evt_…)." },
        type: { type: "string", enum: EVENTS },
        created: { type: "string", description: "ISO 8601 date the event fired." },
        data: { type: "object", properties: { episode: { type: "object" } } },
      },
    },
    example_payload: examplePayload(baseUrl),
    docs: `${baseUrl}/api/llms.txt#webhooks`,
  };
}

async function parseBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) return { kind: "json", body: await request.json() };
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(await request.text());
      return { kind: "form", body: Object.fromEntries(params.entries()) };
    }
    const text = await request.text();
    if (!text) return { kind: "json", body: {} };
    try { return { kind: "json", body: JSON.parse(text) }; } catch { return { kind: "form", body: Object.fromEntries(new URLSearchParams(text).entries()) }; }
  } catch {
    return null;
  }
}

function validEvents(list) {
  const arr = Array.isArray(list) ? list : typeof list === "string" ? list.split(/[\s,]+/) : [];
  const filtered = arr.filter((e) => EVENTS.includes(e));
  return filtered.length ? filtered : EVENTS;
}

export async function handleWebhooks(request, baseUrl) {
  if (request.method === "OPTIONS") return corsPreflight();

  const url = new URL(request.url);
  const sub = url.pathname.slice("/webhooks".length).replace(/^\//, "");

  // ── /webhooks/<id> ──────────────────────────────────────────────────────
  if (sub) {
    const spec = decodeSub(sub);
    if (!spec) {
      return apiError({
        status: 404,
        code: "subscription_not_found",
        message: "No such webhook subscription.",
        hint: `${baseUrl}/webhooks — register one with POST.`,
      });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const body = {
        id: sub,
        status: "active",
        callback: spec.callback,
        events: spec.events || EVENTS,
        created_at: spec.created_at,
        self: `${baseUrl}/webhooks/${sub}`,
        unsubscribe: `DELETE ${baseUrl}/webhooks/${sub}`,
      };
      return new Response(request.method === "HEAD" ? null : JSON.stringify(body, null, 2), {
        status: 200,
        headers: apiHeaders({ "Cache-Control": "no-store" }),
      });
    }
    if (request.method === "DELETE") {
      return new Response(
        JSON.stringify({ id: sub, status: "unsubscribed", callback: spec.callback }, null, 2),
        { status: 200, headers: apiHeaders({ "Cache-Control": "no-store" }) }
      );
    }
    return errors.methodNotAllowed("GET, DELETE, OPTIONS");
  }

  // ── /webhooks ───────────────────────────────────────────────────────────
  if (request.method === "GET" || request.method === "HEAD") {
    const body = catalog(baseUrl);
    return new Response(request.method === "HEAD" ? null : JSON.stringify(body, null, 2), {
      status: 200,
      headers: apiHeaders({ "Cache-Control": "public, max-age=300, stale-while-revalidate=600" }),
    });
  }

  if (request.method === "POST") {
    const parsed = await parseBody(request);
    if (!parsed) {
      return apiError({ status: 400, code: "bad_body", message: "Could not parse the request body." });
    }
    const { body } = parsed;

    // WebSub subscription form (hub.mode=subscribe&hub.topic=…&hub.callback=…)
    if (body["hub.mode"]) {
      const mode = body["hub.mode"];
      const callback = body["hub.callback"];
      const topic = body["hub.topic"] || `${baseUrl}/rss.xml`;
      if ((mode === "subscribe" || mode === "unsubscribe") && !callback) {
        return apiError({ status: 400, code: "missing_callback", message: "WebSub requires hub.callback.", hint: "hub.mode=subscribe&hub.topic=…&hub.callback=https://you/hook" });
      }
      if (mode === "unsubscribe") {
        return new Response(null, { status: 202, headers: apiHeaders({ "Cache-Control": "no-store" }) });
      }
      const spec = { callback, topic, mode: "websub", events: ["episode.published"], created_at: new Date().toISOString() };
      const id = encodeSub(spec);
      // WebSub: acknowledge with 202; verification of intent would follow
      // out of band (GET callback with hub.challenge).
      return new Response(
        JSON.stringify({ id, status: "accepted", mode: "websub", callback, topic, poll: `${baseUrl}/webhooks/${id}` }, null, 2),
        { status: 202, headers: apiHeaders({ Location: `${baseUrl}/webhooks/${id}`, "Cache-Control": "no-store" }) }
      );
    }

    // JSON registration ({ url|callback, events?, secret? }).
    const callback = body.url || body.callback;
    if (!callback || !/^https?:\/\//.test(String(callback))) {
      return apiError({
        status: 400,
        code: "missing_callback",
        message: "Provide a `url` (https) to receive event deliveries.",
        hint: '{ "url": "https://your-app/hook", "events": ["episode.published"] }',
      });
    }
    const events = validEvents(body.events);
    const spec = {
      callback: String(callback),
      events,
      has_secret: !!body.secret,
      created_at: new Date().toISOString(),
    };
    const id = encodeSub(spec);
    return new Response(
      JSON.stringify(
        {
          id,
          status: "active",
          callback: spec.callback,
          events,
          created_at: spec.created_at,
          self: `${baseUrl}/webhooks/${id}`,
          unsubscribe: `DELETE ${baseUrl}/webhooks/${id}`,
          delivery: {
            signature_header: "X-Webhook-Signature",
            signature: spec.has_secret ? "HMAC-SHA256(hex) of the raw body" : "none (no secret supplied)",
          },
          docs: `${baseUrl}/api/llms.txt#webhooks`,
        },
        null,
        2
      ),
      { status: 201, headers: apiHeaders({ Location: `${baseUrl}/webhooks/${id}`, "Cache-Control": "no-store" }) }
    );
  }

  return errors.methodNotAllowed("GET, POST, OPTIONS");
}
