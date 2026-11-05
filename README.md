# ζ Zeta AI — OpenAI-совместимый API-агрегатор

Zeta AI — прокси/агрегатор с API 1-в-1 как у OpenAI. Вы подключаете upstream-провайдеров (OpenAI, OpenRouter, Gemini OpenAI-compat, Groq, DeepSeek и т.д.), создаёте «виртуальные модели» с собственным system-prompt и выдаёте клиентам ключи `zeta-sk-…`.

- **Base URL:** `https://zetaai-lcgb.onrender.com/v1` (то же самое: `https://zetaai-lcgb.onrender.com/v1`; корень сервиса — https://zetaai-lcgb.onrender.com/)
- **Публичный сайт:** `https://zetaai-lcgb.onrender.com/` — список моделей и «Получить API-ключ»
- **Админка:** `https://zetaai-lcgb.onrender.com/admin`
- **Health:** `GET /health` → `{"status":"ok"}`

## Почему Node.js + Express, а не FastAPI
- SSE-стриминг pass-through: `fetch` в Node 20 отдаёт `ReadableStream`, байты апстрима пишутся клиенту без перепарсинга и буферизации, отмена через `AbortController` при отключении клиента.
- Один рантайм для бэкенда и админки, без сборки; маленький Docker-образ `node:20-alpine`.
- Render отлично поддерживает Node (быстрый холодный старт, health-check, Docker).

## Эндпоинты
| Метод | Путь | Описание |
|---|---|---|
| POST | `/v1/chat/completions` | чат, поддерживает `stream: true` (SSE) |
| POST | `/v1/completions` | legacy completions |
| POST | `/v1/embeddings` | эмбеддинги |
| GET | `/v1/models` | включённые виртуальные модели (+ owned_by, pricing) |
| GET | `/public/models` | публичный каталог моделей (без ключа) |
| POST | `/public/keys` | самообслуживание: создать `zeta-sk-…` (лимит 3/час с IP) |
| GET | `/` | публичная HTML-страница (модели + получить ключ) |
| GET | `/health` | health-check |

Ошибки в формате OpenAI: `{"error":{"message","type","param","code"}}`. Ошибки апстрима проксируются с исходным статусом. Невалидный JSON → 400.

## Как это работает
1. Клиент шлёт `Authorization: Bearer zeta-sk-…` → ключ хэшируется sha256 и ищется в БД (отозван/нет → 401 `Invalid API key`).
2. По `model` находится включённая виртуальная модель (нет → 404 `model_not_found`).
3. Если задан **Custom System Prompt**: при первом `system`-сообщении → `content = prompt + "\n\n" + original`; иначе в начало вставляется `{role:"system", content: prompt}`. Для `/v1/completions` промпт добавляется перед `prompt`. Работает и для стрима.
4. `model` заменяется на `upstream_model`, подставляются дефолтные `temperature`/`max_tokens` (если клиент их не прислал), запрос уходит апстриму. В ответе `model` переписывается на публичное имя — upstream-модель и промпт клиенту не раскрываются.
5. Обновляется `last_used` ключа, пишется лог (без ключей и промптов).

Лимиты: 60 запросов/мин на ключ (`V1_RATE_LIMIT`), опциональный дневной лимит на ключ, 5 попыток входа в админку / 15 мин с IP.

## Локальный запуск
```bash
cp .env.example .env      # поменяйте ADMIN_PASSWORD и JWT_SECRET
# Важно: значение ADMIN_PASSWORD в .env держите в одинарных кавычках — иначе `#` обрежет пароль как комментарий.
npm install
npm run dev               # http://localhost:3000/admin
```
Сгенерировать JWT_SECRET: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## Docker
```bash
docker build -t zeta-ai .
docker run -p 3000:3000 -e ADMIN_PASSWORD='...' -e JWT_SECRET='...' -e DATABASE_URL=/app/data/zeta.db -v zeta-data:/app/data zeta-ai
```

## Деплой на Render
```bash
git init && git add . && git commit -m "Zeta AI"
git remote add origin https://github.com/<you>/zeta-ai.git
git push -u origin main
```
**Вариант A — Blueprint:** Render → New → Blueprint → выберите репозиторий; `render.yaml` создаст Web Service (Docker, health-check `/health`, Persistent Disk `/app/data`, `JWT_SECRET` генерируется автоматически). Задайте `ADMIN_PASSWORD` в Environment.

**Вариант B — вручную:** New → Web Service → репозиторий →
- Runtime: **Docker** (Dockerfile в корне), *или* Runtime: Node с Build Command `npm ci --omit=dev`, Start Command `node server.js`
- Health Check Path: `/health`
- Environment: `NODE_ENV=production`, `ADMIN_PASSWORD=<ваш пароль>`, `JWT_SECRET=<случайная строка>`, `DATABASE_URL=/app/data/zeta.db` (или postgres-URL), `BASE_URL=https://zetaai-lcgb.onrender.com`
- Имя сервиса `zetaai` → адрес `https://zetaai-lcgb.onrender.com`

> ⚠️ **Диск на бесплатном плане Render — эфемерный.** SQLite-файл стирается при каждом деплое/рестарте: пропадут провайдеры, модели и ключи. Для продакшена:
> - **Persistent Disk** (платные планы): Settings → Disks → Mount Path `/app/data`, `DATABASE_URL=/app/data/zeta.db` (уже описано в `render.yaml`, требует plan `starter`+). Для free-плана удалите блок `disk` из `render.yaml`.
> - **Postgres (Neon / Supabase / Render Postgres)**: создайте базу, скопируйте connection string и задайте `DATABASE_URL=postgresql://user:pass@host/db?sslmode=require`. Схема создаётся автоматически при старте.

Если `JWT_SECRET` не задан, при старте генерируется случайный (с предупреждением в логах) — сессии админки будут сбрасываться при рестарте, поэтому на Render задайте его явно. Если `ADMIN_PASSWORD` не задан, используется пароль по умолчанию `7fN$2pX#9wK!5vM@8sLQ` — **смените его**. Пароль меняется правкой env и рестартом.

## Первая настройка в /admin
1. Откройте `/admin`, введите пароль.
2. **Провайдеры** → имя, Base URL (например `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`), API-ключ → «Проверить соединение» (GET `{base_url}/models`) → «Добавить». Если в URL нет пути, автоматически добавится `/v1`; хвостовые `/` убираются.
3. **Модели** → ID (`zeta-gpt-4`), отображаемое имя, описание, цены input/output, валюта, sort_order, провайдер, upstream-модель, temperature / max_tokens, Custom System Prompt, «Включена» → «Сохранить». Включённые модели появляются на публичной странице `/`.
4. **API-ключи** → «Сгенерировать ключ» → скопируйте (показывается **один раз**). Можно задать лимит запросов/день. Отзыв — кнопка «Отозвать».
5. **Дашборд** и **Логи** — статистика и последние запросы.

> Примечание: Anthropic нативно не OpenAI-совместим по `/v1/chat/completions`; используйте его через OpenRouter или совместимый шлюз.

### Как выглядит /admin
Тёмная тема. Без авторизации — карточка по центру «ζ Zeta AI / Вход в админ-панель» с полем пароля. После входа — верхняя панель с логотипом и Base URL, вкладки **Дашборд | Провайдеры | Модели | API-ключи | Логи** и кнопка «Выйти». Дашборд — 6 плиток (всего запросов, ошибки, за 24ч, активные ключи, модели, токены) и таблица топ-моделей. Провайдеры — форма добавления + таблица с кнопками «Проверить соединение»/«Удалить» и блок со списком моделей апстрима. Модели — форма с textarea для промпта и таблица с переключателями enabled. API-ключи — форма генерации, рамка с новым ключом и кнопкой «Копировать», таблица (префикс, даты, лимит, статус-бейдж, «Отозвать»). Логи — таблица с цветными статусами, выбор N и «Очистить».

## Примеры подключения
### curl
```bash
curl https://zetaai-lcgb.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer zeta-sk-XXXX" -H "Content-Type: application/json" \
  -d '{"model":"zeta-gpt-4","messages":[{"role":"user","content":"Привет!"}],"stream":false}'
```
### Python (openai SDK)
```python
from openai import OpenAI
client = OpenAI(base_url="https://zetaai-lcgb.onrender.com/v1", api_key="zeta-sk-XXXX")
r = client.chat.completions.create(model="zeta-gpt-4", messages=[{"role": "user", "content": "Привет!"}])
print(r.choices[0].message.content)
for chunk in client.chat.completions.create(model="zeta-gpt-4", messages=[{"role":"user","content":"Расскажи анекдот"}], stream=True):
    print(chunk.choices[0].delta.content or "", end="")
```
### JavaScript (openai SDK)
```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'https://zetaai-lcgb.onrender.com/v1', apiKey: 'zeta-sk-XXXX' });
const stream = await client.chat.completions.create({ model: 'zeta-gpt-4', messages: [{ role: 'user', content: 'Привет!' }], stream: true });
for await (const c of stream) process.stdout.write(c.choices[0]?.delta?.content || '');
```
### OpenWebUI / LibreChat / SillyTavern / Cursor
OpenWebUI: Settings → Connections → OpenAI API → URL `https://zetaai-lcgb.onrender.com/v1`, Key `zeta-sk-…` → модели подтянутся из `/v1/models`. В остальных клиентах аналогично: «OpenAI-compatible», base URL + ключ.

## Переменные окружения
| Переменная | Описание |
|---|---|
| `ADMIN_PASSWORD` | пароль админки |
| `JWT_SECRET` | секрет подписи сессий |
| `PORT` | порт (Render задаёт сам) |
| `DATABASE_URL` | путь к SQLite-файлу или `postgres://…` |
| `BASE_URL` | публичный адрес (для отображения) |
| `NODE_ENV` | `production` включает secure-cookie |
| `V1_RATE_LIMIT` | запросов/мин на ключ (по умолчанию 60) |
| `TRUST_PROXY` | число прокси перед сервисом (по умолчанию 1) |

## Безопасность
Helmet + CSP, CORS `*` только для `/v1` (админка — same-origin), httpOnly JWT-cookie (`secure` в production, `sameSite=strict`), bcrypt для пароля, sha256 для ключей, zod-валидация, ключи апстримов в API админки маскируются и нигде не логируются.
