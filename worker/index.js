// Cloudflare Worker: serves the static SPA, proxies LLM calls (key stays
// server-side), and persists quiz history to KV — all from one origin.
import project from "../project.json";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Cost guards: this Worker holds the API key, so it forces a cheap model, caps
// output, and rate-limits per IP. The browser cannot pick a pricier model or
// hammer the proxy — the request body it sends is sanitized below.
const SAFE_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;
const MAX_CALLS_PER_DAY = 60; // ~20 quiz questions/day per IP (≈3 calls each)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- LLM proxy --------------------------------------------------------
    // Browser POSTs the same body it used to send to Anthropic directly.
    // The key is injected here, from env (populated by Doppler / wrangler secret).
    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: "ANTHROPIC_API_KEY not configured on the Worker" }, 500);
      }
      // Per-IP daily rate limit (best-effort, KV-backed; skipped if KV unbound).
      if (env.QUIZ_KV) {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        const rlKey = `rl:${ip}:${day}`;
        const used = parseInt((await env.QUIZ_KV.get(rlKey)) || "0", 10);
        if (used >= MAX_CALLS_PER_DAY) {
          return json({ error: "Daily limit reached — come back tomorrow." }, 429);
        }
        await env.QUIZ_KV.put(rlKey, String(used + 1), { expirationTtl: 172800 });
      }

      let body;
      try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
      if (!Array.isArray(body?.messages)) return json({ error: "messages[] required" }, 400);

      // Force a cheap model + token cap regardless of what the browser sent.
      const safeBody = {
        model: SAFE_MODEL,
        max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
        messages: body.messages,
      };

      const upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(safeBody),
      });
      // Pass the response straight back; same origin means no CORS dance.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Per-user history storage (KV) -----------------------------------
    // Behind Cloudflare Access, CF injects the authenticated email header,
    // so each user's history is namespaced automatically.
    if (url.pathname === "/api/storage") {
      if (!env.QUIZ_KV) return json({ error: "KV namespace not bound" }, 500);
      const user = request.headers.get("Cf-Access-Authenticated-User-Email") || "local";

      if (request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return json({ error: "missing key" }, 400);
        const value = await env.QUIZ_KV.get(`${user}:${key}`);
        return json({ key, value });
      }
      if (request.method === "PUT") {
        let payload;
        try { payload = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
        const { key, value } = payload || {};
        if (!key) return json({ error: "missing key" }, 400);
        await env.QUIZ_KV.put(`${user}:${key}`, value ?? "");
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key) return json({ error: "missing key" }, 400);
        await env.QUIZ_KV.delete(`${user}:${key}`);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // --- Portfolio schema doc (read cross-origin by the portfolio site) --
    if (url.pathname === "/project.json") {
      return new Response(JSON.stringify(project), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // --- Static assets (the Vite build) ----------------------------------
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
