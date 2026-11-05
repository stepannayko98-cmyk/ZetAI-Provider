'use strict';
const path = require('path');
const fs = require('fs');

const url = process.env.DATABASE_URL || './zeta.db';
const isPg = /^postgres(ql)?:\/\//i.test(url);

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL, temperature REAL, max_tokens INTEGER, custom_system_prompt TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0, daily_limit INTEGER);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT, key_prefix TEXT, endpoint TEXT, model TEXT, status INTEGER,
  tokens_used INTEGER, duration_ms INTEGER, error TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_key ON logs(key_id, created_at);
`;
const PG_SCHEMA = SQLITE_SCHEMA
  .replace('id INTEGER PRIMARY KEY AUTOINCREMENT', 'id SERIAL PRIMARY KEY')
  .replace('temperature REAL', 'temperature DOUBLE PRECISION');

let sqlite = null;
let pool = null;

function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }

async function init() {
  if (isPg) {
    const { Pool } = require('pg');
    const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 10 });
    await pool.query(PG_SCHEMA);
  } else {
    const Database = require('better-sqlite3');
    const file = path.resolve(url.replace(/^sqlite:(\/\/)?/i, ''));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new Database(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(SQLITE_SCHEMA);
  }
}

async function all(sql, params = []) {
  if (isPg) return (await pool.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}
async function get(sql, params = []) { return (await all(sql, params))[0] || null; }
async function run(sql, params = []) {
  if (isPg) { const r = await pool.query(toPg(sql), params); return { changes: r.rowCount }; }
  const r = sqlite.prepare(sql).run(...params); return { changes: r.changes };
}
async function close() { if (pool) await pool.end(); if (sqlite) sqlite.close(); }

module.exports = { init, all, get, run, close, dialect: isPg ? 'postgres' : 'sqlite' };
