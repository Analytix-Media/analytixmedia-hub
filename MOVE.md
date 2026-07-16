# Move Report — Analytix Hub → self-hosted

Prepared 2026-07-16 for migration off Netlify onto the home server
(nginx + Cloudflare Tunnel + Cloudflare Access in front).

## Run it

```bash
npm ci
npm start        # → node server.js
```

One process serves everything: static app + API. No build step.

| Setting | Value |
|---|---|
| Start command | `npm start` (`node server.js`) |
| Port | `PORT` env var, default **3000** |
| Static root | `tools/hub/` (served by server.js itself) |
| API endpoints | `POST /api/hub-auth` · `GET/POST /api/hub-data` |
| Health signal | logs `[hub] listening on :<port>` on boot; warns if env vars missing |

## Env vars (all required unless noted)

| Var | Purpose |
|---|---|
| `NEON_DATABASE_URL` | Postgres connection string — any Postgres, name kept for compatibility |
| `HUB_TOKEN_SECRET` | random 32-byte hex; signs 30-day HMAC auth tokens |
| `HUB_PASSWORD_HASH` | SHA-256 hex of the hub password |
| `PORT` | optional, default 3000 |
| `DB_SSL` | optional; `off` = plain TCP for a LAN Postgres without TLS. Default = TLS with cert verification |
| `ALLOWED_ORIGIN` | optional; CORS origin, default `https://hub.analytixmedia.com` |

**Secrets must be rotated at provision** (old values were exposed in a chat
transcript): new DB password, new `HUB_TOKEN_SECRET`
(`openssl rand -hex 32`), new hub password → new `HUB_PASSWORD_HASH`
(`echo -n '<password>' | shasum -a 256`).

## Database

One table. Create it once (see `neon-setup.sql` for the original; schema):

```sql
CREATE TABLE hub_state (
  id          INT PRIMARY KEY,
  apps        JSONB,
  notes       JSONB,
  quick_links JSONB,
  stages      JSONB,
  saved_views JSONB,
  updated_at  TIMESTAMPTZ
);
```

Server upserts row `id = 1`. To migrate existing data: log into the current
Netlify deploy → Settings → export backup (data.json), then import via the
UI on the new host — or copy the row out of Neon directly.

## Security (already in code)

- Server-side auth; hash + secret env-only; constant-time compares
- Rate limit on `/api/hub-auth`: 5 attempts / min / IP (in-memory; reads
  `X-Forwarded-For` — fine behind nginx/CF)
- URL scheme whitelist client-side (blocks `javascript:`/`data:` links)
- DOMPurify sanitizes all note HTML at render (vendored at
  `tools/hub/vendor/purify.min.js`, no CDN)
- DB TLS verified by default (`DB_SSL=off` for LAN Postgres)
- Security headers set by server.js: `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` (camera/mic/geo off). If nginx also sets these,
  keep them in one place to avoid duplicates.
- Client JSON body limit 10 MB (notes embed base64 screenshots)

## nginx notes

- Proxy everything to `127.0.0.1:$PORT` — server.js handles static + API
- Pass `X-Forwarded-For` (rate limiting keys off it)
- No special websocket/streaming needs; plain HTTP
- Client polls `GET /api/hub-data` every 30 s per open tab

## Still assuming Netlify (delete after cutover)

| Item | Action |
|---|---|
| `netlify.toml` | transition shims map `/api/*` → old functions so the current Netlify prod keeps working until DNS cutover. Delete file after. |
| `netlify/functions/` | superseded by server.js. Delete after cutover. |
| `.github/workflows/deploy.yml` | deploys to Netlify on push to `main`. **Disable/delete at cutover** or every push keeps updating the old site. |
| Netlify site `analytixmedia-hub` + GitHub secrets (`NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`) | delete site, remove secrets. |
| DNS | `hub.analytixmedia.com` CNAME currently → `analytixmedia-hub.netlify.app` (in **Wix DNS**, not GoDaddy). Repoint to the Cloudflare Tunnel. |

## Not Netlify-dependent (no action)

- `tools/hub/` static app — client calls relative `/api/*` paths, works anywhere
- `data.json` — seed/export artifact only, never fetched at runtime
- Local dev: `npm start` with env vars now replaces both `npx serve` and `netlify dev`
