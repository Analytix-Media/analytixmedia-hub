// hub-auth — verifies the hub password (server-side) and issues a signed,
// expiring token. The password hash lives ONLY in the HUB_PASSWORD_HASH env
// var — never in the client bundle — so it can't be read or cracked offline.
// hub-data requires a token from here for every read/write.

const crypto = require('crypto');

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches the remembered session

// ── Rate limit ──────────────────────────────────────────────────────────────
// In-memory, per-IP sliding window. On serverless this only persists per warm
// instance (still slows bursts); on a long-running home-server process it's
// fully effective. 10 attempts / 15 min per IP.
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX_ATTEMPTS = 10;
const _attempts = new Map(); // ip → [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (_attempts.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (list.length >= RL_MAX_ATTEMPTS) { _attempts.set(ip, list); return true; }
  list.push(now);
  _attempts.set(ip, list);
  // housekeeping so the map can't grow unbounded
  if (_attempts.size > 1000) {
    for (const [k, v] of _attempts) {
      if (!v.some(t => now - t < RL_WINDOW_MS)) _attempts.delete(k);
    }
  }
  return false;
}

function clientIp(event) {
  return event.headers['x-nf-client-connection-ip']
    || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || 'unknown';
}

// Same-origin app → CORS can be locked to our own host. Set ALLOWED_ORIGIN
// (e.g. https://hub.analytixmedia.com) in env; unset = open (local dev).
const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(String(payload)).digest('hex');

// token = "<expiryMs>.<hmac(expiryMs, secret)>"
function makeToken(secret) {
  const exp = Date.now() + TTL_MS;
  return { token: `${exp}.${sign(exp, secret)}`, expiry: exp };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const secret = process.env.HUB_TOKEN_SECRET;
  const hash   = process.env.HUB_PASSWORD_HASH;
  if (!secret || !hash) {
    console.error('[hub-auth] missing HUB_TOKEN_SECRET or HUB_PASSWORD_HASH env var');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Auth not configured' }) };
  }

  const ip = clientIp(event);
  if (rateLimited(ip)) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Too many attempts — try again in 15 minutes' }) };
  }

  let password = '';
  try { password = JSON.parse(event.body || '{}').password || ''; } catch { /* bad body */ }

  // Constant-time compare of the candidate hash against the configured one
  const candidate = Buffer.from(sha256hex(password));
  const expected  = Buffer.from(hash);
  const ok = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  if (!ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid password' }) };

  return { statusCode: 200, headers: CORS, body: JSON.stringify(makeToken(secret)) };
};
