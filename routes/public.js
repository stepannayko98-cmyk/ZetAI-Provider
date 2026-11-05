'use strict';
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const db = require('../db');
const { generateApiKey } = require('../lib/cryptoKeys');

const router = express.Router();
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function formatPrice(input, output, currency) {
  const cur = currency || 'USD';
  const hasIn = input != null && String(input).trim() !== '';
  const hasOut = output != null && String(output).trim() !== '';
  if (!hasIn && !hasOut) return null;
  return { input: hasIn ? String(input) : null, output: hasOut ? String(output) : null, currency: cur };
}

/** Rich public catalog for the UI (no auth). */
router.get('/models', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT m.name, m.display_name, m.description, m.price_input, m.price_output, m.currency,
            m.sort_order, m.created_at, p.name AS provider_name
     FROM models m
     LEFT JOIN providers p ON p.id = m.provider_id
     WHERE m.enabled = 1
     ORDER BY m.sort_order ASC, m.name ASC`,
  );
  res.json({
    object: 'list',
    base_url: ((process.env.BASE_URL || '').replace(/\/+$/, '') || '') + '/v1',
    data: rows.map((r) => ({
      id: r.name,
      object: 'model',
      display_name: r.display_name || r.name,
      description: r.description || null,
      provider: r.provider_name || null,
      pricing: formatPrice(r.price_input, r.price_output, r.currency),
      sort_order: Number(r.sort_order) || 0,
      created: Math.floor(new Date(r.created_at).getTime() / 1000) || 0,
      owned_by: 'zeta-ai',
    })),
  });
}));

const keyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.PUBLIC_KEY_RATE_LIMIT || 3),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => 'pubkey:' + req.ip,
  handler: (req, res) => res.status(429).json({
    error: 'Слишком много запросов. Можно создать не более 3 ключей в час с одного IP. Попробуйте позже.',
  }),
});

const createKeySchema = z.object({
  nickname: z.string().trim().max(80).optional().nullable(),
  email: z.string().trim().email().max(200).optional().nullable(),
});

/** Self-serve API key — no admin JWT. Heavily rate-limited by IP. */
router.post('/keys', keyLimiter, wrap(async (req, res) => {
  const parsed = createKeySchema.safeParse(req.body || {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return res.status(400).json({ error: `${i.path.join('.') || 'body'}: ${i.message}` });
  }
  const { nickname, email } = parsed.data;
  const labelParts = [];
  if (nickname) labelParts.push(nickname);
  if (email) labelParts.push(email);
  const name = (labelParts.join(' · ') || 'public').slice(0, 100);

  const k = generateApiKey();
  const kid = id();
  await db.run(
    'INSERT INTO api_keys (id,name,key_hash,prefix,created_at,daily_limit,revoked,source) VALUES (?,?,?,?,?,?,0,?)',
    [kid, name, k.hash, k.prefix, now(), null, 'public'],
  );
  res.status(201).json({
    id: kid,
    key: k.key,
    prefix: k.prefix,
    name,
    base_url: ((process.env.BASE_URL || '').replace(/\/+$/, '') || '') + '/v1',
    message: 'Сохраните ключ сейчас — повторно он не показывается.',
  });
}));

module.exports = router;
