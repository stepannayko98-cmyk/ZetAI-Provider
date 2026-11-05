'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const FALLBACK_BASE = 'https://zetaai-lcgb.onrender.com/v1';
  let baseUrl = FALLBACK_BASE;

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2800);
  }

  async function copyText(v) {
    try { await navigator.clipboard.writeText(v); toast('Скопировано'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Скопировано'); } catch { toast('Не удалось скопировать'); }
      ta.remove();
    }
  }

  function setBase(url) {
    baseUrl = (url || FALLBACK_BASE).replace(/\/+$/, '');
    if (!/\/v1$/i.test(baseUrl)) baseUrl += '/v1';
    $('#baseUrl').textContent = baseUrl;
    $('#baseUrl2').textContent = baseUrl;
    document.querySelectorAll('.code code').forEach((el) => {
      el.textContent = el.textContent.replace(/https:\/\/[^\s"']+\/v1/g, baseUrl);
    });
  }

  function priceLabel(p) {
    if (!p) return null;
    const cur = p.currency || 'USD';
    const parts = [];
    if (p.input) parts.push(`in: ${p.input}`);
    if (p.output) parts.push(`out: ${p.output}`);
    if (!parts.length) return null;
    return `${parts.join(' · ')} ${cur}`;
  }

  async function loadModels() {
    const status = $('#modelsStatus');
    const grid = $('#modelsGrid');
    status.textContent = 'Загрузка…';
    try {
      const r = await fetch('/public/models');
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      if (data.base_url) setBase(data.base_url);
      const list = data.data || [];
      status.textContent = list.length ? `Найдено моделей: ${list.length}` : '';
      if (!list.length) {
        grid.innerHTML = '<div class="empty">Пока нет включённых моделей. Админ может добавить их в /admin.</div>';
        return;
      }
      grid.innerHTML = list.map((m) => {
        const price = priceLabel(m.pricing);
        return `<article class="model-card">
          <h3>${esc(m.display_name || m.id)}</h3>
          <div class="model-id">id: <code>${esc(m.id)}</code></div>
          ${m.description ? `<p class="model-desc">${esc(m.description)}</p>` : '<p class="model-desc muted">Нет описания</p>'}
          <div class="model-meta">
            ${m.provider ? `<span class="pill provider">${esc(m.provider)}</span>` : ''}
            ${price ? `<span class="pill price">${esc(price)}</span>` : '<span class="pill">цена не указана</span>'}
          </div>
          <button type="button" class="btn sm btn-copy-id" data-id="${esc(m.id)}">Копировать ID</button>
        </article>`;
      }).join('');
    } catch (e) {
      status.textContent = 'Не удалось загрузить модели: ' + e.message;
      grid.innerHTML = '';
    }
  }

  $('#refreshModels').addEventListener('click', () => loadModels());
  $('#modelsGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) copyText(b.dataset.id);
  });
  $('#copyBase').addEventListener('click', () => copyText(baseUrl));

  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#keyError').textContent = '';
    $('#newKey').classList.add('hidden');
    const body = {};
    if (f.nickname.value.trim()) body.nickname = f.nickname.value.trim();
    if (f.email.value.trim()) body.email = f.email.value.trim();
    try {
      const r = await fetch('/public/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      $('#newKeyValue').textContent = data.key;
      $('#newKeyHint').textContent = data.message || '';
      if (data.base_url) setBase(data.base_url);
      $('#newKey').classList.remove('hidden');
      f.reset();
      toast('Ключ создан');
    } catch (err) {
      $('#keyError').textContent = err.message;
    }
  });
  $('#copyKey').addEventListener('click', () => copyText($('#newKeyValue').textContent));

  setBase(FALLBACK_BASE);
  loadModels();
})();
