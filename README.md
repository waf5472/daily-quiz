# Daily Drill — self-hosted on Cloudflare Workers

A single Worker serves the React frontend, proxies LLM calls (your Anthropic key
stays server-side), and stores quiz history in KV. One `deploy` command.

## Architecture

```
Browser ── /api/chat ────► Worker ──► api.anthropic.com   (key injected from env)
        ── /api/storage ─► Worker ──► KV namespace         (per-user history)
        ── everything else ► Worker ──► static Vite build (./dist)
```

Same origin for app + API → no CORS. The Anthropic key never reaches the browser.

---

## 1. Install

```bash
npm install
npm install -g wrangler   # if you don't have it
```

## 2. Local development

Frontend only (fast iteration, hits a live Worker for /api if deployed):
```bash
npm run dev
```

Full stack locally (Worker + assets + secrets):
```bash
npm run preview    # vite build → pulls ANTHROPIC_API_KEY from Doppler into a
                   # gitignored .dev.vars → wrangler dev → removes .dev.vars on exit
```
One-time, scope Doppler to this dir: `doppler setup -p portfolio -c dev`.
The Anthropic key lives **only** in Doppler — there is no committed or hand-edited
secret file. `.dev.vars` is generated on demand and never persists.

## 3. Create the KV namespace (once)

```bash
npx wrangler kv namespace create QUIZ_KV
```
Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

## 4. Secrets via Doppler (production)

The Anthropic key must be a **Worker runtime secret** — not a build var, not in
`wrangler.toml`. Two supported paths:

**Path A — Doppler native Cloudflare integration (recommended)**
In the Doppler dashboard: Integrations → Cloudflare Workers → select this Worker.
Doppler syncs `ANTHROPIC_API_KEY` into the Worker's secrets on every change.
Then just:
```bash
npm run deploy
```

**Path B — pipe Doppler → wrangler secret (no integration needed)**
```bash
doppler secrets get ANTHROPIC_API_KEY --plain | npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

> Note: `doppler run -- wrangler deploy` does NOT inject a runtime secret into the
> deployed Worker — it only sets env vars for the wrangler CLI process. Use Path A
> or B so `env.ANTHROPIC_API_KEY` is defined at request time.

## 5. Gate it (so it's not an open, billable API proxy)

In the Cloudflare dashboard: Zero Trust → Access → Applications → Add → Self-hosted.
Point it at your Worker's route/domain, add a policy (e.g. allow only your email
via Google/GitHub login). Free tier covers personal use. Cloudflare then injects
`Cf-Access-Authenticated-User-Email`, which the Worker uses to namespace KV history
per user automatically.

## 6. Deploy

```bash
npm run deploy        # vite build + wrangler deploy
```

---

## Changing study topics

All content lives in the `TOPICS` array at the top of `src/App.jsx`:

```js
{ id: "uniqueid", label: "Display Name", pillar: "Project Set 1", hint: "comma, separated, scope keywords the LLM uses to generate questions" }
```

- `id` — stable unique string (used as the KV/stats key; don't reuse an old id)
- `label` — shown in the UI
- `pillar` — grouping/color; add a matching entry to `PILLAR_COLORS` if you invent a new one
- `hint` — the scope the question generator reads; this is what steers difficulty and subject matter

Edit the array, `npm run deploy`. No other code changes needed — prompts, weighting,
stats, and exports all read from it dynamically.

## Local-only fallback

If you never set up KV/Doppler, the app still works: history falls back to
`localStorage` (per-browser, no cross-device sync). The `/api/chat` proxy still
requires the Worker + key to function.
