/* ═══════════════════════════════════════════
   ANALYTIX HUB — standalone server (self-hosted)

   Serves the static app (tools/hub) + the two API endpoints that used to be
   Netlify Functions. One process, one folder: `npm ci && npm start`.

   Env vars (all config comes from env — nothing hardcoded):
     NEON_DATABASE_URL   Postgres connection string (any Postgres, not just Neon)
     HUB_TOKEN_SECRET    random hex, signs auth tokens        (required)
     HUB_PASSWORD_HASH   SHA-256 hex of the hub password      (required)
     PORT                listen port                          (default 3000)
     DB_SSL              "off" = plain TCP for LAN Postgres   (default: TLS, verified)
     ALLOWED_ORIGIN      CORS origin                          (default https://hub.analytixmedia.com)

   Behind nginx + Cloudflare Tunnel: trust X-Forwarded-For for rate limiting.
═══════════════════════════════════════════ */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://hub.analytixmedia.com';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // token lifetime — matches 30-day session

// ── DB ───────────────────────────────────────────────────────────────────────
// TLS verified by default; DB_SSL=off for a LAN Postgres without TLS.
const ssl = process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: true };
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl,
  max: 5,
});

// ── Crypto helpers (same scheme as the old Netlify functions) ────────────────
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(String(payload)).digest('hex');

function makeToken(secret) {
  const exp = Date.now() + TTL_MS;
  return { token: `${exp}.${sign(exp, secret)}`, expiry: exp };
}

function verifyToken(req) {
  const secret = process.env.HUB_TOKEN_SECRET;
  if (!secret) { console.error('[hub] HUB_TOKEN_SECRET not set'); return false; }
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const [exp, sig] = token.split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(exp).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Rate limit: 5 auth attempts / minute / IP ────────────────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX_ATTEMPTS = 5;
const _attempts = new Map();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (_attempts.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (list.length >= RL_MAX_ATTEMPTS) { _attempts.set(ip, list); return true; }
  list.push(now);
  _attempts.set(ip, list);
  if (_attempts.size > 1000) {
    for (const [k, v] of _attempts) {
      if (!v.some(t => now - t < RL_WINDOW_MS)) _attempts.delete(k);
    }
  }
  return false;
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' })); // full hub state incl. base64 images in notes

// CORS — same-origin in production, so this mostly matters for preflight.
app.use('/api', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Security headers on everything (mirror of the old netlify.toml block —
// keep in sync with the reverse proxy if it also sets these).
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

// ── POST /api/hub-auth — verify password, mint token ─────────────────────────
app.post('/api/hub-auth', (req, res) => {
  const secret = process.env.HUB_TOKEN_SECRET;
  const hash = process.env.HUB_PASSWORD_HASH;
  if (!secret || !hash) {
    console.error('[hub-auth] missing HUB_TOKEN_SECRET or HUB_PASSWORD_HASH');
    return res.status(500).json({ error: 'Auth not configured' });
  }

  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts — try again in a minute' });
  }

  const password = (req.body && req.body.password) || '';
  const candidate = Buffer.from(sha256hex(password));
  const expected = Buffer.from(hash);
  const ok = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  if (!ok) return res.status(401).json({ error: 'Invalid password' });

  res.json(makeToken(secret));
});

// ── /api/hub-data — full hub state, token-gated ──────────────────────────────
app.use('/api/hub-data', (req, res, next) => {
  if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/api/hub-data', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT apps, notes, quick_links, stages, saved_views, updated_at FROM hub_state WHERE id = 1'
    );
    if (rows.length === 0) return res.json({ empty: true });
    const r = rows[0];
    res.json({
      apps: r.apps,
      notes: r.notes,
      quickLinks: r.quick_links,
      stages: r.stages,
      savedViews: r.saved_views,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error('[hub-data GET]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/hub-data', async (req, res) => {
  try {
    const body = req.body || {};
    await pool.query(`
      INSERT INTO hub_state (id, apps, notes, quick_links, stages, saved_views, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (id) DO UPDATE SET
        apps        = EXCLUDED.apps,
        notes       = EXCLUDED.notes,
        quick_links = EXCLUDED.quick_links,
        stages      = EXCLUDED.stages,
        saved_views = EXCLUDED.saved_views,
        updated_at  = EXCLUDED.updated_at
    `, [
      JSON.stringify(body.apps ?? []),
      JSON.stringify(body.notes ?? []),
      JSON.stringify(body.quickLinks ?? []),
      JSON.stringify(body.stages ?? {}),
      JSON.stringify(body.savedViews ?? []),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[hub-data POST]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Static app ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'tools', 'hub')));

app.listen(PORT, () => {
  console.log(`[hub] listening on :${PORT} — serving tools/hub + /api/*`);
  if (!process.env.HUB_TOKEN_SECRET || !process.env.HUB_PASSWORD_HASH) {
    console.warn('[hub] WARNING: HUB_TOKEN_SECRET / HUB_PASSWORD_HASH not set — login will fail');
  }
  if (!process.env.NEON_DATABASE_URL) {
    console.warn('[hub] WARNING: NEON_DATABASE_URL not set — data sync will fail');
  }
});
