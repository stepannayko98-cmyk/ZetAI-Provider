'use strict';
/** Normalize base URL: trim, strip trailing slashes. Keeps any /v1 path the user gave. */
function normalizeBaseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/(models|chat\/completions|completions|embeddings)$/, '');
  return s;
}
/** Build endpoint URL. If base has no version-like path segment, append /v1. */
function endpoint(baseUrl, path) {
  let b = normalizeBaseUrl(baseUrl);
  try {
    const p = new URL(b).pathname.replace(/\/+$/, '');
    if (p === '' ) b += '/v1';
  } catch { /* invalid url handled by caller */ }
  return b + path;
}
async function upstreamFetch(provider, path, { method = 'POST', body, signal, timeoutMs = 600000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = { Authorization: `Bearer ${provider.api_key}`, Accept: 'application/json, text/event-stream' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(endpoint(provider.base_url, path), {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: sig,
  });
}
async function listUpstreamModels(provider) {
  const r = await upstreamFetch(provider, '/models', { method: 'GET', timeoutMs: 15000 });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 300) || r.statusText;
    const e = new Error(`Upstream ${r.status}: ${msg}`); e.status = r.status; throw e;
  }
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).map((id) => id.replace(/^models\//, ''));
}
module.exports = { normalizeBaseUrl, endpoint, upstreamFetch, listUpstreamModels };
