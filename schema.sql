-- Run with: wrangler d1 execute <DB_NAME> --file=schema.sql

CREATE TABLE IF NOT EXISTS token_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TEXT NOT NULL,           -- ISO-8601 string
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seen_task (
  id          TEXT PRIMARY KEY,          -- e.g. "assignment:abc123"
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  due         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);