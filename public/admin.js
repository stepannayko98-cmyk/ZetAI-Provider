'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => (d ? new Date(d).toLocaleString('ru-RU') : '—');
  let providers = [], models = [];

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3000); }

  async function api(path, opts = {}) {
    const r = await fetch('/admin/api' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null; try { data = await r.json(); } catch { /* empty */ }
    if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Требуется вход'); }
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  }

  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#password').focus(); }
  async function showApp() {
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    try { const me = await api('/me'); $('#baseUrl').textContent = me.baseUrl; } catch { /* ignore */ }
    switchTab('dashboard');
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#loginError').textContent = '';
    try { await api('/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; showApp(); }
    catch (err) { $('#loginError').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // Tabs
  const loaders = { dashboard: loadStats, providers: loadProviders, models: loadModels, keys: loadKeys, logs: loadLogs };
  function switchTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
    loaders[name]().catch((e) => toast(e.message));
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Dashboard
  async function loadStats() {
    const s = await api('/stats');
    $('#sTotal').textContent = s.total_requests; $('#sErr').textContent = s.errors; $('#sDay').textContent = s.requests_24h;
    $('#sKeys').textContent = s.active_keys; $('#sModels').textContent = s.enabled_models; $('#sTokens').textContent = s.total_tokens;
    $('#topModels').innerHTML = s.top_models.map((m) => `<tr><td>${esc(m.model)}</td><td>${m.count}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Пока нет данных</td></tr>';
  }

  // Providers
  async function loadProviders() {
    providers = await api('/providers');
    $('#providersBody').innerHTML = providers.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.base_url)}</td><td class="muted">${esc(p.api_key_masked)}</td>
      <td><button class="btn sm" data-act="ptest" data-id="${p.id}">Проверить соединение</button><button class="btn sm danger" data-act="pdel" data-id="${p.id}">Удалить</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">Нет провайдеров</td></tr>';
  }
  const showModels = (el, r) => { el.classList.remove('hidden'); el.textContent = r.ok ? `✅ Соединение OK. Моделей: ${r.models.length}\n\n${r.models.join('\n')}` : `❌ Ошибка: ${r.error}`; };
  $('#providerForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('/providers', { method: 'POST', body: { name: f.name.value, base_url: f.base_url.value, api_key: f.api_key.value } }); f.reset(); $('#providerTestOut').classList.add('hidden'); toast('Провайдер добавлен'); loadProviders(); }
    catch (err) { toast(err.message); }
  });
  $('#providerTestNew').addEventListener('click', async () => {
    const f = $('#providerForm'); const out = $('#providerTestOut'); out.classList.remove('hidden'); out.textContent = 'Проверяю…';
    try { showModels(out, await api('/providers/test', { method: 'POST', body: { name: f.name.value || 'test', base_url: f.base_url.value, api_key: f.api_key.value } })); }
    catch (err) { out.textContent = '❌ ' + err.message; }
  });
  $('#providersBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'ptest') {
      const out = $('#providerModelsOut'); out.classList.remove('hidden'); out.textContent = 'Проверяю…';
      try { showModels(out, await api(`/providers/${b.dataset.id}/test`, { method: 'POST' })); } catch (err) { out.textContent = '❌ ' + err.message; }
    } else if (b.dataset.act === 'pdel') {
      if (!confirm('Удалить провайдера и все его модели?')) return;
      try { await api(`/providers/${b.dataset.id}`, { method: 'DELETE' }); toast('Удалено'); loadProviders(); } catch (err) { toast(err.message); }
    }
  });

  // Models
  async function loadModels() {
    [providers, models] = await Promise.all([api('/providers'), api('/models')]);
    $('#modelProvider').innerHTML = providers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">— сначала добавьте провайдера —</option>';
    $('#modelsBody').innerHTML = models.map((m) => {
      const title = m.display_name ? `${esc(m.display_name)}<div class="muted small"><code>${esc(m.name)}</code></div>` : `<b>${esc(m.name)}</b>`;
      const price = [m.price_input && `in ${esc(m.price_input)}`, m.price_output && `out ${esc(m.price_output)}`].filter(Boolean).join(' / ') || '—';
      const cur = (m.price_input || m.price_output) ? ` <span class="muted">${esc(m.currency || 'USD')}</span>` : '';
      return `<tr><td>${title}</td><td>${esc(m.provider_name || '—')}</td><td>${esc(m.upstream_model)}</td>
      <td>${price}${cur}</td><td>${m.sort_order ?? 0}</td><td>${m.custom_system_prompt ? '✔' : '—'}</td>
      <td><label class="switch"><input type="checkbox" data-act="toggle" data-id="${m.id}" ${m.enabled ? 'checked' : ''}><span></span></label></td>
      <td><button class="btn sm" data-act="medit" data-id="${m.id}">Изменить</button><button class="btn sm danger" data-act="mdel" data-id="${m.id}">Удалить</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="muted">Нет моделей</td></tr>';
  }
  function resetModelForm() { const f = $('#modelForm'); f.reset(); f.id.value = ''; $('#modelFormTitle').textContent = 'Добавить модель'; $('#modelCancel').classList.add('hidden'); }
  $('#modelCancel').addEventListener('click', resetModelForm);
  $('#modelForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    const body = {
      name: f.name.value.trim(), provider_id: f.provider_id.value, upstream_model: f.upstream_model.value.trim(),
      temperature: f.temperature.value === '' ? null : Number(f.temperature.value),
      max_tokens: f.max_tokens.value === '' ? null : parseInt(f.max_tokens.value, 10),
      custom_system_prompt: f.custom_system_prompt.value, enabled: f.enabled.checked,
      display_name: f.display_name.value.trim() || null,
      description: f.description.value.trim() || null,
      price_input: f.price_input.value.trim() || null,
      price_output: f.price_output.value.trim() || null,
      currency: f.currency.value.trim() || 'USD',
      sort_order: f.sort_order.value === '' ? 0 : parseInt(f.sort_order.value, 10),
    };
    try {
      if (f.id.value) await api(`/models/${f.id.value}`, { method: 'PUT', body }); else await api('/models', { method: 'POST', body });
      toast('Модель сохранена'); resetModelForm(); loadModels();
    } catch (err) { toast(err.message); }
  });
  $('#loadUpstream').addEventListener('click', async () => {
    const pid = $('#modelProvider').value; if (!pid) return toast('Выберите провайдера');
    try {
      const r = await api(`/providers/${pid}/test`, { method: 'POST' });
      if (!r.ok) return toast('Ошибка: ' + r.error);
      $('#upstreamModels').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); toast(`Загружено моделей: ${r.models.length}`);
    } catch (err) { toast(err.message); }
  });
  $('#modelsBody').addEventListener('change', async (e) => {
    const i = e.target; if (i.dataset.act !== 'toggle') return;
    try { await api(`/models/${i.dataset.id}/toggle`, { method: 'PATCH', body: { enabled: i.checked } }); toast(i.checked ? 'Включена' : 'Выключена'); }
    catch (err) { i.checked = !i.checked; toast(err.message); }
  });
  $('#modelsBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const m = models.find((x) => x.id === b.dataset.id); if (!m) return;
    if (b.dataset.act === 'mdel') {
      if (!confirm(`Удалить модель ${m.name}?`)) return;
      try { await api(`/models/${m.id}`, { method: 'DELETE' }); toast('Удалено'); loadModels(); } catch (err) { toast(err.message); }
    } else if (b.dataset.act === 'medit') {
      const f = $('#modelForm');
      f.id.value = m.id; f.name.value = m.name; f.provider_id.value = m.provider_id; f.upstream_model.value = m.upstream_model;
      f.temperature.value = m.temperature ?? ''; f.max_tokens.value = m.max_tokens ?? ''; f.custom_system_prompt.value = m.custom_system_prompt || ''; f.enabled.checked = m.enabled;
      f.display_name.value = m.display_name || ''; f.description.value = m.description || '';
      f.price_input.value = m.price_input || ''; f.price_output.value = m.price_output || '';
      f.currency.value = m.currency || 'USD'; f.sort_order.value = m.sort_order ?? 0;
      $('#modelFormTitle').textContent = 'Изменить модель: ' + m.name; $('#modelCancel').classList.remove('hidden'); f.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // Keys
  async function loadKeys() {
    const keys = await api('/keys');
    $('#keysBody').innerHTML = keys.map((k) => `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.name || '—')}</td><td><span class="badge ${k.source === 'public' ? 'ok' : ''}">${esc(k.source || 'admin')}</span></td><td>${fmt(k.created_at)}</td><td>${fmt(k.last_used)}</td>
      <td>${k.daily_limit ?? '∞'}</td><td><span class="badge ${k.status === 'active' ? 'ok' : 'bad'}">${k.status}</span></td>
      <td>${k.status === 'active' ? `<button class="btn sm danger" data-act="revoke" data-id="${k.id}">Отозвать</button>` : `<button class="btn sm ghost" data-act="kdel" data-id="${k.id}">Удалить</button>`}</td></tr>`).join('')
      || '<tr><td colspan="8" class="muted">Нет ключей</td></tr>';
  }
  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try {
      const r = await api('/keys', { method: 'POST', body: { name: f.name.value || undefined, daily_limit: f.daily_limit.value ? parseInt(f.daily_limit.value, 10) : null } });
      $('#newKeyValue').textContent = r.key; $('#newKey').classList.remove('hidden'); f.reset(); loadKeys();
    } catch (err) { toast(err.message); }
  });
  $('#copyKey').addEventListener('click', async () => {
    const v = $('#newKeyValue').textContent;
    try { await navigator.clipboard.writeText(v); toast('Скопировано'); }
    catch { const r = document.createRange(); r.selectNodeContents($('#newKeyValue')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Выделено — нажмите Ctrl+C'); }
  });
  $('#keysBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.act === 'revoke') { if (!confirm('Отозвать ключ? Это необратимо.')) return; await api(`/keys/${b.dataset.id}/revoke`, { method: 'POST' }); toast('Ключ отозван'); }
      else if (b.dataset.act === 'kdel') { await api(`/keys/${b.dataset.id}`, { method: 'DELETE' }); toast('Удалено'); }
      loadKeys();
    } catch (err) { toast(err.message); }
  });

  // Logs
  async function loadLogs() {
    const logs = await api('/logs?limit=' + $('#logLimit').value);
    $('#logsBody').innerHTML = logs.map((l) => `<tr><td>${fmt(l.created_at)}</td><td><code>${esc(l.key_prefix || '—')}</code></td><td>${esc(l.endpoint)}</td><td>${esc(l.model || '—')}</td>
      <td><span class="badge ${l.status < 400 ? 'ok' : 'bad'}">${l.status}</span></td><td>${l.tokens_used ?? '—'}</td><td>${l.duration_ms ?? '—'}</td><td class="muted small">${esc(l.error || '')}</td></tr>`).join('')
      || '<tr><td colspan="8" class="muted">Логов нет</td></tr>';
  }
  $('#refreshLogs').addEventListener('click', () => loadLogs().catch((e) => toast(e.message)));
  $('#logLimit').addEventListener('change', () => loadLogs().catch((e) => toast(e.message)));
  $('#clearLogs').addEventListener('click', async () => { if (!confirm('Очистить все логи?')) return; await api('/logs', { method: 'DELETE' }).catch((e) => toast(e.message)); loadLogs(); });

  // Boot
  fetch('/admin/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? showApp() : showLogin())).catch(showLogin);
})();
