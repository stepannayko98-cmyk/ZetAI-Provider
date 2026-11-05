'use strict';
const crypto = require('crypto');
const PREFIX = 'zeta-sk-';
function generateApiKey() {
  const key = PREFIX + crypto.randomBytes(24).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}
function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
module.exports = { generateApiKey, hashKey, safeEqual, PREFIX };
