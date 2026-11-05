'use strict';
const db = require('../db');
const { hashKey } = require('../lib/cryptoKeys');

function invalid(res) {
  return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } });
}
function extractKey(req) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.get('x-api-key') || '').trim() || null;
}
async function authApiKey(req, res, next) {
  try {
    const key = extractKey(req);
    if (!key) return invalid(res);
    const row = await db.get('SELECT * FROM api_keys WHERE key_hash = ?', [hashKey(key)]);
    if (!row || Number(row.revoked)) return invalid(res);
    if (row.daily_limit && Number(row.daily_limit) > 0) {
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const c = await db.get('SELECT COUNT(*) AS n FROM logs WHERE key_id = ? AND created_at >= ?', [row.id, since.toISOString()]);
      if (Number(c?.n || 0) >= Number(row.daily_limit)) {
        return res.status(429).json({ error: { message: 'Daily request limit exceeded for this API key', type: 'rate_limit_error', param: null, code: 'daily_limit_exceeded' } });
      }
    }
    req.apiKey = { id: row.id, prefix: row.prefix };
    db.run('UPDATE api_keys SET last_used = ? WHERE id = ?', [new Date().toISOString(), row.id]).catch(() => {});
    next();
  } catch (e) { next(e); }
}
module.exports = { authApiKey, extractKey };
