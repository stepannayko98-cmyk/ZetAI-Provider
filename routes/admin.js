'use strict';
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const db = require('../db');
const { authAdmin, COOKIE } = require('../middleware/authAdmin');
const { generateApiKey } = require('../lib/cryptoKeys');
const { normalizeBaseUrl, listUpstreamModels } = require('../lib/upstream');

const router = express.Router();
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

let passwordHash = null;
function getPasswordHash() {
  if (!passwordHash) passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
  return passwordHash;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
});

function parse(schema, req, res) {
  const r = schema.safeParse(req.body);
  if (!r.success) { const i = r.error.issues[0]; res.status(400).json({ error: `${i.path.join('.')}: ${i.message}` }); return null; }
  return r.data;
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const b = parse(z.object({ password: z.string().min(1).max(256) }), req, res); if (!b) return;
  const ok = await bcrypt.compare(b.password, getPasswordHash());
  if (!ok) return res.status(401).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' });
  res.cookie(COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 12 * 3600 * 1000,
  });
  res.json({ ok: true });
}));
router.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

router.use(authAdmin);
router.get('/me', (req, res) => res.json({ ok: true, baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, '') + '/v1', db: db.dialect }));

// ---------- Providers ----------
const providerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  base_url: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), 'must be http(s)'),
  api_key: z.string().trim().max(1000).optional(),
});
const maskKey = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');

router.get('/providers', wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM providers ORDER BY created_at');
  res.json(rows.map((p) => ({ id: p.id, name: p.name, base_url: p.base_url, api_key_masked: maskKey(p.api_key), created_at: p.created_at })));
}));
router.post('/providers', wrap(async (req, res) => {
  const b = parse(providerSchema.extend({ api_key: z.string().trim().min(1).max(1000) }), req, res); if (!b) return;
  const pid = id();
  await db.run('INSERT INTO providers (id,name,base_url,api_key,created_at) VALUES (?,?,?,?,?)', [pid, b.name, normalizeBaseUrl(b.base_url), b.api_key, now()]);
  res.status(201).json({ id: pid });
}));
router.put('/providers/:id', wrap(async (req, res) => {
  const b = parse(providerSchema, req, res); if (!b) return;
  const p = await db.get('SELECT * FROM providers WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  await db.run('UPDATE providers SET name=?, base_url=?, api_key=? WHERE id=?', [b.name, normalizeBaseUrl(b.base_url), b.api_key || p.api_key, p.id]);
  res.json({ ok: true });
}));
router.delete('/providers/:id', wrap(async (req, res) => {
  await db.run('DELETE FROM models WHERE provider_id = ?', [req.params.id]);
  const r = await db.run('DELETE FROM providers WHERE id = ?', [req.params.id]);
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
}));
router.post('/providers/:id/test', wrap(async (req, res) => {
  const p = await db.get('SELECT * FROM providers WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  try { const models = await listUpstreamModels(p); res.json({ ok: true, models }); }
  catch (e) { res.json({ ok: false, error: e.name === 'TimeoutError' ? 'Timeout' : e.message }); }
}));
router.post('/providers/test', wrap(async (req, res) => {
  const b = parse(providerSchema.extend({ api_key: z.string().trim().min(1) }), req, res); if (!b) return;
  try { res.json({ ok: true, models: await listUpstreamModels(b) }); }
  catch (e) { res.json({ ok: false, error: e.name === 'TimeoutError' ? 'Timeout' : e.message }); }
}));

// ---------- Models ----------
const optionalText = z.union([z.string().trim().max(500), z.null()]).optional();
const modelSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\/-]+$/, 'allowed: letters, digits, . _ : / -'),
  provider_id: z.string().min(1),
  upstream_model: z.string().trim().min(1).max(200),
  temperature: z.union([z.number().min(0).max(2), z.null()]).optional(),
  max_tokens: z.union([z.number().int().positive().max(2000000), z.null()]).optional(),
  custom_system_prompt: z.string().max(100000).optional().nullable(),
  enabled: z.boolean().optional(),
  display_name: z.union([z.string().trim().max(200), z.null()]).optional(),
  description: z.union([z.string().trim().max(2000), z.null()]).optional(),
  price_input: optionalText,
  price_output: optionalText,
  currency: z.union([z.string().trim().max(8), z.null()]).optional(),
  sort_order: z.union([z.number().int().min(-100000).max(100000), z.null()]).optional(),
});

function modelRow(m) {
  return {
    ...m,
    enabled: !!Number(m.enabled),
    display_name: m.display_name || null,
    description: m.description || null,
    price_input: m.price_input || null,
    price_output: m.price_output || null,
    currency: m.currency || 'USD',
    sort_order: Number(m.sort_order) || 0,
  };
}

router.get('/models', wrap(async (req, res) => {
  const rows = await db.all(
    'SELECT m.*, p.name AS provider_name FROM models m LEFT JOIN providers p ON p.id = m.provider_id ORDER BY m.sort_order ASC, m.name ASC',
  );
  res.json(rows.map(modelRow));
}));
router.post('/models', wrap(async (req, res) => {
  const b = parse(modelSchema, req, res); if (!b) return;
  if (!(await db.get('SELECT id FROM providers WHERE id = ?', [b.provider_id]))) return res.status(400).json({ error: 'Провайдер не найден' });
  if (await db.get('SELECT id FROM models WHERE name = ?', [b.name])) return res.status(409).json({ error: 'Модель с таким именем уже есть' });
  const mid = id();
  await db.run(
    `INSERT INTO models (id,name,provider_id,upstream_model,temperature,max_tokens,custom_system_prompt,enabled,created_at,
      display_name,description,price_input,price_output,currency,sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      mid, b.name, b.provider_id, b.upstream_model, b.temperature ?? null, b.max_tokens ?? null,
      b.custom_system_prompt || null, b.enabled === false ? 0 : 1, now(),
      b.display_name || null, b.description || null, b.price_input || null, b.price_output || null,
      b.currency || 'USD', b.sort_order ?? 0,
    ],
  );
  res.status(201).json({ id: mid });
}));
router.put('/models/:id', wrap(async (req, res) => {
  const b = parse(modelSchema, req, res); if (!b) return;
  const dup = await db.get('SELECT id FROM models WHERE name = ? AND id <> ?', [b.name, req.params.id]);
  if (dup) return res.status(409).json({ error: 'Модель с таким именем уже есть' });
  const r = await db.run(
    `UPDATE models SET name=?,provider_id=?,upstream_model=?,temperature=?,max_tokens=?,custom_system_prompt=?,enabled=?,
      display_name=?,description=?,price_input=?,price_output=?,currency=?,sort_order=? WHERE id=?`,
    [
      b.name, b.provider_id, b.upstream_model, b.temperature ?? null, b.max_tokens ?? null,
      b.custom_system_prompt || null, b.enabled === false ? 0 : 1,
      b.display_name || null, b.description || null, b.price_input || null, b.price_output || null,
      b.currency || 'USD', b.sort_order ?? 0, req.params.id,
    ],
  );
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
}));
router.patch('/models/:id/toggle', wrap(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean() }), req, res); if (!b) return;
  const r = await db.run('UPDATE models SET enabled=? WHERE id=?', [b.enabled ? 1 : 0, req.params.id]);
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
}));
router.delete('/models/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM models WHERE id = ?', [req.params.id]);
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
}));

// ---------- API keys ----------
router.get('/keys', wrap(async (req, res) => {
  const rows = await db.all('SELECT id,name,prefix,created_at,last_used,revoked,daily_limit,source FROM api_keys ORDER BY created_at DESC');
  res.json(rows.map((k) => ({ ...k, source: k.source || 'admin', status: Number(k.revoked) ? 'revoked' : 'active' })));
}));
router.post('/keys', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().max(100).optional(), daily_limit: z.union([z.number().int().positive(), z.null()]).optional() }), req, res); if (!b) return;
  const k = generateApiKey(); const kid = id();
  await db.run('INSERT INTO api_keys (id,name,key_hash,prefix,created_at,daily_limit,revoked,source) VALUES (?,?,?,?,?,?,0,?)', [kid, b.name || null, k.hash, k.prefix, now(), b.daily_limit ?? null, 'admin']);
  res.status(201).json({ id: kid, key: k.key, prefix: k.prefix });
}));
router.post('/keys/:id/revoke', wrap(async (req, res) => {
  const r = await db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [req.params.id]);
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
}));
router.delete('/keys/:id', wrap(async (req, res) => {
  const r = await db.run('DELETE FROM api_keys WHERE id = ? AND revoked = 1', [req.params.id]);
  res.status(r.changes ? 200 : 400).json({ ok: !!r.changes });
}));

// ---------- Dashboard / logs ----------
router.get('/stats', wrap(async (req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [tot, err, day, keys, models, top, tokens] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM logs'),
    db.get('SELECT COUNT(*) AS n FROM logs WHERE status >= 400'),
    db.get('SELECT COUNT(*) AS n FROM logs WHERE created_at >= ?', [since]),
    db.get('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0'),
    db.get('SELECT COUNT(*) AS n FROM models WHERE enabled = 1'),
    db.all('SELECT model, COUNT(*) AS n FROM logs WHERE model IS NOT NULL GROUP BY model ORDER BY n DESC LIMIT 10'),
    db.get('SELECT COALESCE(SUM(tokens_used),0) AS n FROM logs'),
  ]);
  res.json({ total_requests: +tot.n, errors: +err.n, requests_24h: +day.n, active_keys: +keys.n, enabled_models: +models.n, total_tokens: +tokens.n, top_models: top.map((t) => ({ model: t.model, count: +t.n })) });
}));
router.get('/logs', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  res.json(await db.all('SELECT id,key_prefix,endpoint,model,status,tokens_used,duration_ms,error,created_at FROM logs ORDER BY id DESC LIMIT ?', [limit]));
}));
router.delete('/logs', wrap(async (req, res) => { await db.run('DELETE FROM logs'); res.json({ ok: true }); }));

module.exports = router;
