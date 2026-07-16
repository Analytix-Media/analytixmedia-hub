const { Pool } = require('pg');
const crypto = require('crypto');

// TLS: verify certs by default (Neon and any properly configured Postgres pass).
// For a home-server Postgres on the LAN without TLS, set DB_SSL=off.
const ssl =
  process.env.DB_SSL === 'off' ? false :
  { rejectUnauthorized: true };

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl,
  max: 1, // serverless — keep pool tiny
});

// Same-origin app → CORS can be locked to our own host. Set ALLOWED_ORIGIN
// (e.g. https://hub.analytixmedia.com) in env; unset = open (local dev).
const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Verify the HMAC token minted by hub-auth. Fails closed: no/invalid/expired
// token, or unset secret → not authorized. Secret never leaves the server.
function verifyToken(event) {
  const secret = process.env.HUB_TOKEN_SECRET;
  if (!secret) { console.error('[hub-data] HUB_TOKEN_SECRET not set'); return false; }
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const [exp, sig] = token.split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false; // expired
  const expected = crypto.createHmac('sha256', secret).update(exp).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (!verifyToken(event)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let client;
  try {
    client = await pool.connect();

    // ── GET — return full hub state ──────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const { rows } = await client.query(
        'SELECT apps, notes, quick_links, stages, saved_views, updated_at FROM hub_state WHERE id = 1'
      );
      if (rows.length === 0) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ empty: true }) };
      }
      const r = rows[0];
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          apps:       r.apps,
          notes:      r.notes,
          quickLinks: r.quick_links,
          stages:     r.stages,
          savedViews: r.saved_views,
          updatedAt:  r.updated_at,
        }),
      };
    }

    // ── POST — save full hub state ───────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      await client.query(`
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
        JSON.stringify(body.apps       ?? []),
        JSON.stringify(body.notes      ?? []),
        JSON.stringify(body.quickLinks ?? []),
        JSON.stringify(body.stages     ?? {}),
        JSON.stringify(body.savedViews ?? []),
      ]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  } catch (err) {
    console.error('[hub-data]', err.message);
    // Generic message to the client — DB error details stay in server logs.
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server error' }) };
  } finally {
    if (client) client.release();
  }
};
