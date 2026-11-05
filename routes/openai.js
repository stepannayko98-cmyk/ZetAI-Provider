'use strict';
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { authApiKey } = require('../middleware/authApiKey');
const { injectSystemPrompt, injectIntoPrompt } = require('../lib/promptInject');
const { upstreamFetch } = require('../lib/upstream');

const router = express.Router();

const oaiErr = (res, status, message, type = 'invalid_request_error', code = null, param = null) =>
  res.status(status).json({ error: { message, type, param, code } });

const chatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string().min(1) }).passthrough()).min(1),
  stream: z.boolean().optional(),
}).passthrough();
const complSchema = z.object({
  model: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.any())]),
  stream: z.boolean().optional(),
}).passthrough();
const embSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.any())]),
}).passthrough();

async function writeLog(req, endpoint, model, status, tokens, started, error) {
  try {
    await db.run(
      'INSERT INTO logs (key_id, key_prefix, endpoint, model, status, tokens_used, duration_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.apiKey?.id || null, req.apiKey?.prefix || null, endpoint, model, status, tokens ?? null,
        Date.now() - started, error ? String(error).slice(0, 500) : null, new Date().toISOString()]);
  } catch (e) { console.error('[log] failed:', e.message); }
}

async function resolveModel(name) {
  return db.get(
    `SELECT m.*, p.base_url, p.api_key, p.name AS provider_name FROM models m
     JOIN providers p ON p.id = m.provider_id WHERE m.name = ? AND m.enabled = 1`, [name]);
}

function validate(schema, req, res) {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    const i = r.error.issues[0];
    oaiErr(res, 400, `Invalid request: ${i.path.join('.') || 'body'} ${i.message}`, 'invalid_request_error', null, i.path.join('.') || null);
    return null;
  }
  return r.data;
}

/** Generic proxy handler. */
function makeHandler({ schema, path, endpointName, transform }) {
  return async (req, res, next) => {
    const started = Date.now();
    const body = validate(schema, req, res);
    if (!body) return writeLog(req, endpointName, req.body?.model || null, 400, null, started, 'validation');
    const vm = await resolveModel(body.model).catch(next);
    if (!vm) {
      await writeLog(req, endpointName, body.model, 404, null, started, 'model_not_found');
      return oaiErr(res, 404, `The model \`${body.model}\` does not exist or you do not have access to it.`, 'invalid_request_error', 'model_not_found', 'model');
    }
    const payload = transform({ ...body }, vm);
    payload.model = vm.upstream_model;
    const stream = payload.stream === true;

    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClose);

    let up;
    try {
      up = await upstreamFetch(vm, path, { body: payload, signal: ac.signal });
    } catch (e) {
      res.off('close', onClose);
      if (ac.signal.aborted) return writeLog(req, endpointName, vm.name, 499, null, started, 'client_closed');
      const timeout = e.name === 'TimeoutError';
      await writeLog(req, endpointName, vm.name, timeout ? 504 : 502, null, started, e.message);
      return oaiErr(res, timeout ? 504 : 502, timeout ? 'Upstream timeout' : 'Upstream connection failed', 'api_error', 'upstream_error');
    }

    // Non-OK: pass through OpenAI-style error
    if (!up.ok) {
      res.off('close', onClose);
      const text = await up.text().catch(() => '');
      let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
      const msg = json?.error?.message || json?.message || (Array.isArray(json) && json[0]?.error?.message) || text.slice(0, 500) || up.statusText;
      await writeLog(req, endpointName, vm.name, up.status, null, started, msg);
      if (json?.error && typeof json.error === 'object') {
        return res.status(up.status).json({ error: { message: json.error.message || msg, type: json.error.type || 'api_error', param: json.error.param ?? null, code: json.error.code ?? null } });
      }
      return oaiErr(res, up.status, msg, up.status >= 500 ? 'api_error' : 'invalid_request_error', 'upstream_error');
    }

    if (stream && up.body) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      let tokens = null, tail = '';
      const dec = new TextDecoder();
      try {
        for await (const chunk of up.body) {
          if (ac.signal.aborted) break;
          res.write(chunk);
          // sniff usage from final chunks (when stream_options.include_usage)
          tail = (tail + dec.decode(chunk, { stream: true })).slice(-8192);
          const m = tail.match(/"total_tokens"\s*:\s*(\d+)/g);
          if (m) tokens = Number(m[m.length - 1].match(/\d+/)[0]);
        }
        res.end();
        await writeLog(req, endpointName, vm.name, 200, tokens, started, null);
      } catch (e) {
        if (!res.writableEnded) res.end();
        await writeLog(req, endpointName, vm.name, ac.signal.aborted ? 499 : 502, tokens, started, ac.signal.aborted ? 'client_closed' : e.message);
      } finally { res.off('close', onClose); }
      return;
    }

    try {
      const text = await up.text();
      res.off('close', onClose);
      let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
      if (json) {
        if (json.model && endpointName !== 'embeddings') json.model = vm.name;
        await writeLog(req, endpointName, vm.name, up.status, json?.usage?.total_tokens ?? null, started, null);
        return res.status(up.status).json(json);
      }
      await writeLog(req, endpointName, vm.name, up.status, null, started, null);
      res.status(up.status).type(up.headers.get('content-type') || 'application/json').send(text);
    } catch (e) {
      res.off('close', onClose);
      await writeLog(req, endpointName, vm.name, 502, null, started, e.message);
      if (!res.headersSent) oaiErr(res, 502, 'Upstream read failed', 'api_error', 'upstream_error');
    }
  };
}

function applyDefaults(body, vm, maxKey = 'max_tokens') {
  if (body.temperature === undefined && vm.temperature !== null && vm.temperature !== undefined) body.temperature = Number(vm.temperature);
  if (body[maxKey] === undefined && body.max_completion_tokens === undefined && vm.max_tokens) body[maxKey] = Number(vm.max_tokens);
  return body;
}

function toOaiModel(r) {
  const out = {
    id: r.name,
    object: 'model',
    created: Math.floor(new Date(r.created_at).getTime() / 1000) || 0,
    owned_by: r.provider_name || 'zeta-ai',
  };
  if (r.display_name) out.display_name = r.display_name;
  if (r.description) out.description = r.description;
  const hasIn = r.price_input != null && String(r.price_input).trim() !== '';
  const hasOut = r.price_output != null && String(r.price_output).trim() !== '';
  if (hasIn || hasOut) {
    out.pricing = {
      input: hasIn ? String(r.price_input) : null,
      output: hasOut ? String(r.price_output) : null,
      currency: r.currency || 'USD',
    };
  }
  return out;
}

const MODEL_SELECT = `SELECT m.name, m.display_name, m.description, m.price_input, m.price_output, m.currency,
  m.created_at, p.name AS provider_name
  FROM models m LEFT JOIN providers p ON p.id = m.provider_id`;

router.get('/models', authApiKey, async (req, res, next) => {
  try {
    const rows = await db.all(`${MODEL_SELECT} WHERE m.enabled = 1 ORDER BY m.sort_order ASC, m.name ASC`);
    res.json({ object: 'list', data: rows.map(toOaiModel) });
  } catch (e) { next(e); }
});
router.get('/models/:id', authApiKey, async (req, res, next) => {
  try {
    const r = await db.get(`${MODEL_SELECT} WHERE m.enabled = 1 AND m.name = ?`, [req.params.id]);
    if (!r) return oaiErr(res, 404, `The model \`${req.params.id}\` does not exist`, 'invalid_request_error', 'model_not_found', 'model');
    res.json(toOaiModel(r));
  } catch (e) { next(e); }
});

router.post('/chat/completions', authApiKey, makeHandler({
  schema: chatSchema, path: '/chat/completions', endpointName: 'chat.completions',
  transform: (b, vm) => { b.messages = injectSystemPrompt(b.messages, vm.custom_system_prompt); return applyDefaults(b, vm); },
}));
router.post('/completions', authApiKey, makeHandler({
  schema: complSchema, path: '/completions', endpointName: 'completions',
  transform: (b, vm) => { b.prompt = injectIntoPrompt(b.prompt, vm.custom_system_prompt); return applyDefaults(b, vm); },
}));
router.post('/embeddings', authApiKey, makeHandler({
  schema: embSchema, path: '/embeddings', endpointName: 'embeddings', transform: (b) => b,
}));

router.use((req, res) => oaiErr(res, 404, `Unknown endpoint: ${req.method} /v1${req.path}`, 'invalid_request_error', 'unknown_url'));

module.exports = router;
