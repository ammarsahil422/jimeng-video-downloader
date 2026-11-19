-- Standalone schema for the Jimeng Video Downloader.
-- Same tables as the Hatch-hosted version (drizzle/0002_downloader_tables.sql).
-- Applied automatically at server start (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL,
  cover_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Admin-only login for the Admin Panel. Downloads are public: there are
-- no user accounts, no registration and no per-user limits.
-- users stores the admin account (role 'admin'); sessions stores the
-- 30-day login tokens. The admin account itself is seeded by the server
-- on first boot (see seedAdmin in handlers.ts), not by this schema.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Subscription system (ported from the artifact's drizzle/0004 migration).
-- Downloads stay public; customer accounts exist only for plans, and the
-- admin manages customers/plans/payments. There is no payment gateway:
-- a Buy click creates a purchase_requests row and the admin marks it
-- paid and activates the plan by hand.
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  download_limit INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  plan_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  limit_total INTEGER NOT NULL,
  limit_used INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  plan_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  purchase_request_id INTEGER,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Manual',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS download_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  anon_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- The downloads.user_id / downloads.anon_id attribution columns are NOT
-- added here: SQLite has no ADD COLUMN IF NOT EXISTS, so db.ts adds them
-- (guarded by a PRAGMA table_info check) at Store startup, so existing
-- databases created before this change keep working.
