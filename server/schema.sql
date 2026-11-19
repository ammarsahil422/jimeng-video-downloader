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

-- Phase 2 (master spec, ported from the artifact's drizzle/0005
-- migration): favourites, per-account download settings and the
-- notification centre. Notifications are created ONLY by real server
-- events (payment received, plan activated/expired/exhausted, daily
-- limit reached) — never seeded or faked.
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  download_id INTEGER NOT NULL,
  user_id INTEGER,
  anon_id TEXT,
  owner_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  video_url TEXT NOT NULL,
  quality_label TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS favorites_owner_download_idx
  ON favorites (owner_key, download_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  default_quality TEXT NOT NULL DEFAULT 'best',
  default_mode TEXT NOT NULL DEFAULT 'single',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  anon_id TEXT,
  owner_key TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_owner_idx
  ON notifications (owner_key, created_at);

-- Phase 3 (master spec, ported from the artifact's drizzle/0006
-- migration): Help Center articles and support tickets. Articles are
-- seeded once on first read (see ensureHelpArticles in handlers.ts);
-- the admin manages them from Admin → Support. Tickets work for
-- logged-in customers (per account) and anonymous visitors (per
-- browser), like History and Favourites. There is no email service:
-- ticket replies are delivered in-app via a "support" notification.
CREATE TABLE IF NOT EXISTS help_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  anon_id TEXT,
  owner_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS support_tickets_owner_idx
  ON support_tickets (owner_key, created_at);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author_role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx
  ON ticket_messages (ticket_id, created_at);

-- Phase 4 (master spec, ported from the artifact's drizzle/0007
-- migration): system logs, login rate limiting, broadcasts. The
-- users.totp_secret / users.totp_enabled and sessions.last_seen_at
-- columns are added by db.ts at Store startup (PRAGMA-guarded ALTER,
-- like downloads.user_id / anon_id), so old databases keep working.
-- Logs are NEVER seeded — rows only appear for real admin actions.
-- There is no email service: ticket replies and broadcasts are
-- delivered in-app via notifications.
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS system_logs_created_idx
  ON system_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS system_logs_action_idx
  ON system_logs (action, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
