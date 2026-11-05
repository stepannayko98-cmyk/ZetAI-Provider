'use strict';
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { extractKey } = require('./middleware/authApiKey');
const { hashKey } = require('./lib/cryptoKeys');

const DEFAULT_ADMIN_PASSWORD = '7fN$2pX#9wK!5vM@8sLQ';
if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = DEFAULT_ADMIN_PASSWORD;
  console.warn('[zeta] ADMIN_PASSWORD не задан — используется пароль по умолчанию. Задайте свой в env!');
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-generate-random') {
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[zeta] JWT_SECRET не задан — сгенерирован случайный (сессии сбросятся при рестарте). Задайте JWT_SECRET в env.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1)); // Render sits behind 1 proxy

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"] },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cookieParser());

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ name: 'Zeta AI', base_url: (process.env.BASE_URL || '').replace(/\/+$/, '') + '/v1', health: '/health' }));

// ---------- /v1 (public, CORS *) ----------
const v1Limiter = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.V1_RATE_LIMIT || 60), standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => { const k = extractKey(req); return k ? 'k:' + hashKey(k) : 'ip:' + req.ip; },
  handler: (req, res) => res.status(429).json({ error: { message: 'Rate limit exceeded: 60 requests per minute', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } }),
});
app.use('/v1', cors({ origin: '*', allowedHeaders: ['Authorization', 'Content-Type', 'X-Api-Key', 'OpenAI-Organization', 'OpenAI-Beta'], methods: ['GET', 'POST', 'OPTIONS'] }));
app.use('/v1', v1Limiter, express.json({ limit: '20mb' }), require('./routes/openai'));

// ---------- /admin (same-origin only: no CORS headers) ----------
app.use('/admin/api', express.json({ limit: '1mb' }), require('./routes/admin'));
const pub = path.join(__dirname, 'public');
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use('/admin', express.static(pub, { index: false, maxAge: '1h' }));

app.use((req, res) => res.status(404).json({ error: { message: 'Not found', type: 'invalid_request_error' } }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error', param: null, code: 'invalid_json' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Request body too large', type: 'invalid_request_error', param: null, code: null } });
  }
  console.error('[zeta] error:', err.message);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: { message: 'Internal server error', type: 'api_error', param: null, code: null } });
});

const PORT = Number(process.env.PORT || 3000);
db.init().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`[zeta] listening on :${PORT} (db: ${db.dialect})`));
  server.keepAliveTimeout = 65000; server.headersTimeout = 66000; server.requestTimeout = 0;
  const shutdown = () => { console.log('[zeta] shutting down'); server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}).catch((e) => { console.error('[zeta] DB init failed:', e); process.exit(1); });
