// SQLite storage (Bun's built-in bun:sqlite). Same schema as the
// Hatch-hosted version: settings (key/value), downloads (history),
// contact_messages. No ORM, no migrations framework — the CREATE TABLE
// statements in schema.sql run at startup with IF NOT EXISTS.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DownloadRow = {
  id: number;
  sourceUrl: string;
  title: string;
  videoUrl: string;
  coverUrl: string | null;
  createdAt: Date;
  userId: number | null;
  anonId: string | null;
};

export type PlanRow = {
  id: number;
  name: string;
  priceCents: number;
  durationDays: number;
  downloadLimit: number;
  description: string;
  active: boolean;
  createdAt: Date;
};

export type SubscriptionRow = {
  id: number;
  userId: number;
  planId: number;
  planName: string;
  priceCents: number;
  durationDays: number;
  limitTotal: number;
  limitUsed: number;
  startsAt: Date;
  expiresAt: Date;
  status: string;
  createdAt: Date;
};

export type PurchaseRequestRow = {
  id: number;
  userId: number;
  planId: number;
  planName: string;
  priceCents: number;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
};

export type PaymentRow = {
  id: number;
  userId: number | null;
  purchaseRequestId: number | null;
  customerName: string;
  customerEmail: string;
  planName: string;
  amountCents: number;
  method: string;
  note: string;
  createdAt: Date;
};

export type UserRow = {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  status: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  // Phase 4 — admin two-factor auth (TOTP, RFC 6238): the secret is set
  // when 2FA setup starts, totpEnabled only flips on after the admin
  // confirms a valid code. Customer accounts do not get 2FA.
  totpSecret: string | null;
  totpEnabled: boolean;
};

export type SessionRow = {
  token: string;
  userId: number;
  expiresAt: Date;
  createdAt: Date;
  // Phase 4 — refreshed whenever the token is used, so the admin can
  // tell live sessions apart in Settings → Security.
  lastSeenAt: Date | null;
};

// Phase 2 — favourites, per-account download settings, notifications.

export type FavoriteRow = {
  id: number;
  downloadId: number;
  userId: number | null;
  anonId: string | null;
  ownerKey: string;
  title: string;
  coverUrl: string | null;
  videoUrl: string;
  qualityLabel: string;
  sourceUrl: string;
  createdAt: Date;
};

export type UserSettingsRow = {
  userId: number;
  defaultQuality: string;
  defaultMode: string;
  theme: string;
  language: string;
  updatedAt: Date;
};

export type NotificationRow = {
  id: number;
  userId: number | null;
  anonId: string | null;
  ownerKey: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
};

// Phase 3 — Help Center articles and support tickets.

export type HelpArticleRow = {
  id: number;
  title: string;
  body: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SupportTicketRow = {
  id: number;
  userId: number | null;
  anonId: string | null;
  ownerKey: string;
  subject: string;
  category: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TicketMessageRow = {
  id: number;
  ticketId: number;
  authorRole: string;
  message: string;
  createdAt: Date;
};

// Phase 4 — system logs, login rate limiting, broadcasts.

export type SystemLogRow = {
  id: number;
  actorType: string;
  actorEmail: string | null;
  action: string;
  detail: string;
  createdAt: Date;
};

export type LoginAttemptRow = {
  email: string;
  failedCount: number;
  firstFailedAt: Date;
  lockedUntil: Date | null;
};

export type BroadcastRow = {
  id: number;
  title: string;
  message: string;
  recipientCount: number;
  createdAt: Date;
};

type UserRaw = {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: number;
  last_login_at: number | null;
  totp_secret?: string | null;
  totp_enabled?: number | null;
};

export class Store {
  readonly db: Database;
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "app.db");
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
    this.db.exec(readFileSync(schemaPath, "utf8"));
    // Attribution columns on downloads (added after the first release):
    // SQLite has no ADD COLUMN IF NOT EXISTS, so add them only when the
    // PRAGMA check says they are missing.
    const cols = this.db.query("PRAGMA table_info(downloads)").all() as {
      name: string;
    }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("user_id")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN user_id INTEGER");
    }
    if (!names.has("anon_id")) {
      this.db.exec("ALTER TABLE downloads ADD COLUMN anon_id TEXT");
    }
    // Phase 4 columns (added after the first release): the admin's
    // two-factor secret/enabled flag and the session last-seen stamp.
    // Added here at startup, BEFORE any auth query — this is the
    // standalone equivalent of the artifact's ensurePhase4Schema-first
    // fix: an old database without these columns must still log in.
    const userCols = this.db.query("PRAGMA table_info(users)").all() as {
      name: string;
    }[];
    const userNames = new Set(userCols.map((c) => c.name));
    if (!userNames.has("totp_secret")) {
      this.db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
    }
    if (!userNames.has("totp_enabled")) {
      this.db.exec(
        "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
      );
    }
    const sessCols = this.db.query("PRAGMA table_info(sessions)").all() as {
      name: string;
    }[];
    const sessNames = new Set(sessCols.map((c) => c.name));
    if (!sessNames.has("last_seen_at")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER");
    }
    // Phase 5 columns (added after the first release): the theme and
    // language preferences on user_settings. Added here at startup,
    // BEFORE any auth query — same pattern as the Phase 4 columns above.
    const settingsCols = this.db
      .query("PRAGMA table_info(user_settings)")
      .all() as { name: string }[];
    const settingsNames = new Set(settingsCols.map((c) => c.name));
    if (!settingsNames.has("theme")) {
      this.db.exec(
        "ALTER TABLE user_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'",
      );
    }
    if (!settingsNames.has("language")) {
      this.db.exec(
        "ALTER TABLE user_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'en'",
      );
    }
  }

  // -- settings (key/value) -------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM settings WHERE key = ? LIMIT 1")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.query("DELETE FROM settings WHERE key = ?").run(key);
  }

  // -- downloads (history) --------------------------------------------------

  insertDownload(row: {
    sourceUrl: string;
    title: string;
    videoUrl: string;
    coverUrl: string | null;
    userId?: number | null;
    anonId?: string | null;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO downloads (source_url, title, video_url, cover_url, user_id, anon_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.sourceUrl,
        row.title,
        row.videoUrl,
        row.coverUrl,
        row.userId ?? null,
        row.anonId ?? null,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  private toDownloadRow(r: {
    id: number;
    source_url: string;
    title: string;
    video_url: string;
    cover_url: string | null;
    user_id: number | null;
    anon_id: string | null;
    created_at: number;
  }): DownloadRow {
    return {
      id: r.id,
      sourceUrl: r.source_url,
      title: r.title,
      videoUrl: r.video_url,
      coverUrl: r.cover_url,
      createdAt: new Date(r.created_at),
      userId: r.user_id,
      anonId: r.anon_id,
    };
  }

  listDownloads(limit: number): DownloadRow[] {
    const rows = this.db
      .query(
        "SELECT id, source_url, title, video_url, cover_url, user_id, anon_id, created_at " +
          "FROM downloads ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as {
      id: number;
      source_url: string;
      title: string;
      video_url: string;
      cover_url: string | null;
      user_id: number | null;
      anon_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => this.toDownloadRow(r));
  }

  /** History scoped to one customer account. */
  listDownloadsForUser(userId: number, limit: number): DownloadRow[] {
    const rows = this.db
      .query(
        "SELECT id, source_url, title, video_url, cover_url, user_id, anon_id, created_at " +
          "FROM downloads WHERE user_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(userId, limit) as {
      id: number;
      source_url: string;
      title: string;
      video_url: string;
      cover_url: string | null;
      user_id: number | null;
      anon_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => this.toDownloadRow(r));
  }

  /** History for an anonymous browser: its own rows plus old unattributed
   *  rows (no user, no browser id). Rows attributed to another browser
   *  id are not shown. */
  listDownloadsForAnon(anonId: string, limit: number): DownloadRow[] {
    const rows = this.db
      .query(
        "SELECT id, source_url, title, video_url, cover_url, user_id, anon_id, created_at " +
          "FROM downloads WHERE anon_id = ? OR (user_id IS NULL AND anon_id IS NULL) " +
          "ORDER BY id DESC LIMIT ?",
      )
      .all(anonId, limit) as {
      id: number;
      source_url: string;
      title: string;
      video_url: string;
      cover_url: string | null;
      user_id: number | null;
      anon_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => this.toDownloadRow(r));
  }

  deleteDownload(id: number): void {
    this.db.query("DELETE FROM downloads WHERE id = ?").run(id);
  }

  clearDownloads(): void {
    this.db.query("DELETE FROM downloads").run();
  }

  // -- contact messages ------------------------------------------------------

  insertContactMessage(row: {
    name: string;
    email: string;
    message: string;
  }): void {
    this.db
      .query(
        "INSERT INTO contact_messages (name, email, message, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(row.name, row.email, row.message, Date.now());
  }

  // -- admin users + sessions -------------------------------------------------
  // Admin-only login: the admin account is the only login on the site.

  private toUserRow(r: UserRaw): UserRow {
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      passwordHash: r.password_hash,
      role: r.role,
      status: r.status,
      createdAt: new Date(r.created_at),
      lastLoginAt: r.last_login_at === null ? null : new Date(r.last_login_at),
      totpSecret: r.totp_secret ?? null,
      totpEnabled: r.totp_enabled === 1,
    };
  }

  getUserByEmail(email: string): UserRow | null {
    const row = this.db
      .query("SELECT * FROM users WHERE email = ? LIMIT 1")
      .get(email) as UserRaw | null;
    return row ? this.toUserRow(row) : null;
  }

  getUserById(id: number): UserRow | null {
    const row = this.db
      .query("SELECT * FROM users WHERE id = ? LIMIT 1")
      .get(id) as UserRaw | null;
    return row ? this.toUserRow(row) : null;
  }

  countAdmins(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get() as { n: number };
    return row.n;
  }

  insertUser(row: {
    name: string;
    email: string;
    passwordHash: string;
    role: string;
    status: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO users (name, email, password_hash, role, status, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.name, row.email, row.passwordHash, row.role, row.status, Date.now());
    return Number(info.lastInsertRowid);
  }

  updateUserLastLogin(id: number): void {
    this.db
      .query("UPDATE users SET last_login_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  updateUserPassword(id: number, passwordHash: string): void {
    this.db
      .query("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(passwordHash, id);
  }

  insertSession(token: string, userId: number, expiresAt: Date): void {
    this.db
      .query(
        "INSERT INTO sessions (token, user_id, expires_at, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(token, userId, expiresAt.getTime(), Date.now());
  }

  getSession(token: string): SessionRow | null {
    const row = this.db
      .query("SELECT * FROM sessions WHERE token = ? LIMIT 1")
      .get(token) as {
      token: string;
      user_id: number;
      expires_at: number;
      created_at: number;
      last_seen_at?: number | null;
    } | null;
    if (!row) return null;
    return {
      token: row.token,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      lastSeenAt: row.last_seen_at == null ? null : new Date(row.last_seen_at),
    };
  }

  /** All sessions, newest first (used by the Security overview). */
  listSessions(): SessionRow[] {
    const rows = this.db
      .query("SELECT * FROM sessions ORDER BY created_at DESC")
      .all() as {
      token: string;
      user_id: number;
      expires_at: number;
      created_at: number;
      last_seen_at?: number | null;
    }[];
    return rows.map((row) => ({
      token: row.token,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      lastSeenAt: row.last_seen_at == null ? null : new Date(row.last_seen_at),
    }));
  }

  updateSessionLastSeen(token: string): void {
    this.db
      .query("UPDATE sessions SET last_seen_at = ? WHERE token = ?")
      .run(Date.now(), token);
  }

  /** Phase 4 — admin two-factor auth: set the TOTP secret and/or the
   *  enabled flag. Pass totpSecret: null to clear the secret. */
  updateUserTotp(
    id: number,
    patch: { totpSecret?: string | null; totpEnabled?: boolean },
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.totpSecret !== undefined) {
      sets.push("totp_secret = ?");
      params.push(patch.totpSecret);
    }
    if (patch.totpEnabled !== undefined) {
      sets.push("totp_enabled = ?");
      params.push(patch.totpEnabled ? 1 : 0);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db
      .query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  /** All accounts (used by the backup export). */
  listAllUsers(): UserRow[] {
    const rows = this.db.query("SELECT * FROM users ORDER BY id ASC").all() as UserRaw[];
    return rows.map((r) => this.toUserRow(r));
  }

  deleteSession(token: string): void {
    this.db.query("DELETE FROM sessions WHERE token = ?").run(token);
  }

  deleteSessionsForUserExcept(userId: number, keepToken: string | null | undefined): void {
    if (keepToken) {
      this.db
        .query("DELETE FROM sessions WHERE user_id = ? AND token != ?")
        .run(userId, keepToken);
    } else {
      this.db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
  }

  // -- download stats (admin dashboard) --------------------------------------

  countDownloads(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM downloads")
      .get() as { n: number };
    return row.n;
  }

  countDownloadsSince(ms: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM downloads WHERE created_at >= ?")
      .get(ms) as { n: number };
    return row.n;
  }

  recentDownloads(limit: number): DownloadRow[] {
    return this.listDownloads(limit);
  }

  // -- customer accounts ------------------------------------------------------

  listUsersByRole(role: string): UserRow[] {
    const rows = this.db
      .query("SELECT * FROM users WHERE role = ? ORDER BY id DESC")
      .all(role) as UserRaw[];
    return rows.map((r) => this.toUserRow(r));
  }

  updateUserStatus(id: number, status: string): void {
    this.db
      .query("UPDATE users SET status = ? WHERE id = ?")
      .run(status, id);
  }

  deleteUserById(id: number): void {
    this.db.query("DELETE FROM users WHERE id = ?").run(id);
  }

  deleteSessionsForUser(userId: number): void {
    this.db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  // -- plans ------------------------------------------------------------------

  private toPlanRow(r: {
    id: number;
    name: string;
    price_cents: number;
    duration_days: number;
    download_limit: number;
    description: string;
    active: number;
    created_at: number;
  }): PlanRow {
    return {
      id: r.id,
      name: r.name,
      priceCents: r.price_cents,
      durationDays: r.duration_days,
      downloadLimit: r.download_limit,
      description: r.description,
      active: r.active === 1,
      createdAt: new Date(r.created_at),
    };
  }

  countPlans(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM plans").get() as {
      n: number;
    };
    return row.n;
  }

  listPlans(activeOnly: boolean): PlanRow[] {
    const sql = activeOnly
      ? "SELECT * FROM plans WHERE active = 1 ORDER BY price_cents ASC"
      : "SELECT * FROM plans ORDER BY price_cents ASC";
    const rows = this.db.query(sql).all() as {
      id: number;
      name: string;
      price_cents: number;
      duration_days: number;
      download_limit: number;
      description: string;
      active: number;
      created_at: number;
    }[];
    return rows.map((r) => this.toPlanRow(r));
  }

  getPlanById(id: number): PlanRow | null {
    const row = this.db
      .query("SELECT * FROM plans WHERE id = ? LIMIT 1")
      .get(id) as {
      id: number;
      name: string;
      price_cents: number;
      duration_days: number;
      download_limit: number;
      description: string;
      active: number;
      created_at: number;
    } | null;
    return row ? this.toPlanRow(row) : null;
  }

  insertPlan(row: {
    name: string;
    priceCents: number;
    durationDays: number;
    downloadLimit: number;
    description: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO plans (name, price_cents, duration_days, download_limit, description, active, created_at) " +
          "VALUES (?, ?, ?, ?, ?, 1, ?)",
      )
      .run(
        row.name,
        row.priceCents,
        row.durationDays,
        row.downloadLimit,
        row.description,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  updatePlan(
    id: number,
    patch: {
      name?: string;
      priceCents?: number;
      durationDays?: number;
      downloadLimit?: number;
      description?: string;
      active?: boolean;
    },
  ): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.priceCents !== undefined) {
      sets.push("price_cents = ?");
      params.push(patch.priceCents);
    }
    if (patch.durationDays !== undefined) {
      sets.push("duration_days = ?");
      params.push(patch.durationDays);
    }
    if (patch.downloadLimit !== undefined) {
      sets.push("download_limit = ?");
      params.push(patch.downloadLimit);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.active !== undefined) {
      sets.push("active = ?");
      params.push(patch.active ? 1 : 0);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db
      .query(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  // -- subscriptions ----------------------------------------------------------

  private toSubscriptionRow(r: {
    id: number;
    user_id: number;
    plan_id: number;
    plan_name: string;
    price_cents: number;
    duration_days: number;
    limit_total: number;
    limit_used: number;
    starts_at: number;
    expires_at: number;
    status: string;
    created_at: number;
  }): SubscriptionRow {
    return {
      id: r.id,
      userId: r.user_id,
      planId: r.plan_id,
      planName: r.plan_name,
      priceCents: r.price_cents,
      durationDays: r.duration_days,
      limitTotal: r.limit_total,
      limitUsed: r.limit_used,
      startsAt: new Date(r.starts_at),
      expiresAt: new Date(r.expires_at),
      status: r.status,
      createdAt: new Date(r.created_at),
    };
  }

  getLatestActiveSubscription(userId: number): SubscriptionRow | null {
    const row = this.db
      .query(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' " +
          "ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as {
      id: number;
      user_id: number;
      plan_id: number;
      plan_name: string;
      price_cents: number;
      duration_days: number;
      limit_total: number;
      limit_used: number;
      starts_at: number;
      expires_at: number;
      status: string;
      created_at: number;
    } | null;
    return row ? this.toSubscriptionRow(row) : null;
  }

  insertSubscription(row: {
    userId: number;
    planId: number;
    planName: string;
    priceCents: number;
    durationDays: number;
    limitTotal: number;
    startsAt: Date;
    expiresAt: Date;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO subscriptions (user_id, plan_id, plan_name, price_cents, duration_days, limit_total, limit_used, starts_at, expires_at, status, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?)",
      )
      .run(
        row.userId,
        row.planId,
        row.planName,
        row.priceCents,
        row.durationDays,
        row.limitTotal,
        row.startsAt.getTime(),
        row.expiresAt.getTime(),
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  cancelActiveSubscriptions(userId: number): void {
    this.db
      .query(
        "UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ? AND status = 'active'",
      )
      .run(userId);
  }

  updateSubscriptionStatus(id: number, status: string): void {
    this.db
      .query("UPDATE subscriptions SET status = ? WHERE id = ?")
      .run(status, id);
  }

  incrementSubscriptionUsed(id: number, used: number): void {
    this.db
      .query("UPDATE subscriptions SET limit_used = ? WHERE id = ?")
      .run(used, id);
  }

  deleteSubscriptionsForUser(userId: number): void {
    this.db
      .query("DELETE FROM subscriptions WHERE user_id = ?")
      .run(userId);
  }

  // -- purchase requests ------------------------------------------------------

  private toPurchaseRequestRow(r: {
    id: number;
    user_id: number;
    plan_id: number;
    plan_name: string;
    price_cents: number;
    status: string;
    created_at: number;
    decided_at: number | null;
  }): PurchaseRequestRow {
    return {
      id: r.id,
      userId: r.user_id,
      planId: r.plan_id,
      planName: r.plan_name,
      priceCents: r.price_cents,
      status: r.status,
      createdAt: new Date(r.created_at),
      decidedAt: r.decided_at === null ? null : new Date(r.decided_at),
    };
  }

  getPurchaseRequestById(id: number): PurchaseRequestRow | null {
    const row = this.db
      .query("SELECT * FROM purchase_requests WHERE id = ? LIMIT 1")
      .get(id) as {
      id: number;
      user_id: number;
      plan_id: number;
      plan_name: string;
      price_cents: number;
      status: string;
      created_at: number;
      decided_at: number | null;
    } | null;
    return row ? this.toPurchaseRequestRow(row) : null;
  }

  findPendingRequest(userId: number, planId: number): PurchaseRequestRow | null {
    const row = this.db
      .query(
        "SELECT * FROM purchase_requests WHERE user_id = ? AND plan_id = ? AND status = 'pending' LIMIT 1",
      )
      .get(userId, planId) as {
      id: number;
      user_id: number;
      plan_id: number;
      plan_name: string;
      price_cents: number;
      status: string;
      created_at: number;
      decided_at: number | null;
    } | null;
    return row ? this.toPurchaseRequestRow(row) : null;
  }

  insertPurchaseRequest(row: {
    userId: number;
    planId: number;
    planName: string;
    priceCents: number;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO purchase_requests (user_id, plan_id, plan_name, price_cents, status, created_at) " +
          "VALUES (?, ?, ?, ?, 'pending', ?)",
      )
      .run(row.userId, row.planId, row.planName, row.priceCents, Date.now());
    return Number(info.lastInsertRowid);
  }

  listPurchaseRequests(): PurchaseRequestRow[] {
    const rows = this.db
      .query("SELECT * FROM purchase_requests ORDER BY id DESC")
      .all() as {
      id: number;
      user_id: number;
      plan_id: number;
      plan_name: string;
      price_cents: number;
      status: string;
      created_at: number;
      decided_at: number | null;
    }[];
    return rows.map((r) => this.toPurchaseRequestRow(r));
  }

  listPurchaseRequestsForUser(userId: number): PurchaseRequestRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM purchase_requests WHERE user_id = ? ORDER BY id DESC",
      )
      .all(userId) as {
      id: number;
      user_id: number;
      plan_id: number;
      plan_name: string;
      price_cents: number;
      status: string;
      created_at: number;
      decided_at: number | null;
    }[];
    return rows.map((r) => this.toPurchaseRequestRow(r));
  }

  updatePurchaseRequestStatus(id: number, status: string): void {
    this.db
      .query(
        "UPDATE purchase_requests SET status = ?, decided_at = ? WHERE id = ?",
      )
      .run(status, Date.now(), id);
  }

  deletePurchaseRequestsForUser(userId: number): void {
    this.db
      .query("DELETE FROM purchase_requests WHERE user_id = ?")
      .run(userId);
  }

  countPaidOrActivatedRequests(): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM purchase_requests WHERE status IN ('paid', 'activated')",
      )
      .get() as { n: number };
    return row.n;
  }

  // -- payments ---------------------------------------------------------------

  private toPaymentRow(r: {
    id: number;
    user_id: number | null;
    purchase_request_id: number | null;
    customer_name: string;
    customer_email: string;
    plan_name: string;
    amount_cents: number;
    method: string;
    note: string;
    created_at: number;
  }): PaymentRow {
    return {
      id: r.id,
      userId: r.user_id,
      purchaseRequestId: r.purchase_request_id,
      customerName: r.customer_name,
      customerEmail: r.customer_email,
      planName: r.plan_name,
      amountCents: r.amount_cents,
      method: r.method,
      note: r.note,
      createdAt: new Date(r.created_at),
    };
  }

  listPayments(): PaymentRow[] {
    const rows = this.db
      .query("SELECT * FROM payments ORDER BY id DESC")
      .all() as {
      id: number;
      user_id: number | null;
      purchase_request_id: number | null;
      customer_name: string;
      customer_email: string;
      plan_name: string;
      amount_cents: number;
      method: string;
      note: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toPaymentRow(r));
  }

  insertPayment(row: {
    userId: number | null;
    purchaseRequestId: number | null;
    customerName: string;
    customerEmail: string;
    planName: string;
    amountCents: number;
    method: string;
    note: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO payments (user_id, purchase_request_id, customer_name, customer_email, plan_name, amount_cents, method, note, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.userId,
        row.purchaseRequestId,
        row.customerName,
        row.customerEmail,
        row.planName,
        row.amountCents,
        row.method,
        row.note,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  // -- download events (limits + MB stats) ------------------------------------

  insertDownloadEvent(row: {
    userId: number | null;
    anonId: string | null;
    sizeBytes: number;
  }): void {
    this.db
      .query(
        "INSERT INTO download_events (user_id, anon_id, size_bytes, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(row.userId, row.anonId, row.sizeBytes, Date.now());
  }

  countDownloadEventsSince(ms: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM download_events WHERE created_at >= ?")
      .get(ms) as { n: number };
    return row.n;
  }

  countDownloadEventsTotal(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM download_events")
      .get() as { n: number };
    return row.n;
  }

  countDownloadEventsTodayForUser(userId: number, dayStartMs: number): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM download_events WHERE user_id = ? AND created_at >= ?",
      )
      .get(userId, dayStartMs) as { n: number };
    return row.n;
  }

  countDownloadEventsTodayForAnon(anonId: string, dayStartMs: number): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM download_events WHERE anon_id = ? AND created_at >= ?",
      )
      .get(anonId, dayStartMs) as { n: number };
    return row.n;
  }

  countDownloadEventsTotalForUser(userId: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM download_events WHERE user_id = ?")
      .get(userId) as { n: number };
    return row.n;
  }

  sumDownloadEventsBytesSince(ms: number): number {
    const row = this.db
      .query(
        "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM download_events WHERE created_at >= ?",
      )
      .get(ms) as { total: number };
    return row.total;
  }

  sumDownloadEventsBytesTotal(): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM download_events")
      .get() as { total: number };
    return row.total;
  }

  /** Downloads per UTC day since `sinceMs`, as {day: "YYYY-MM-DD", n}. */
  downloadEventsByDay(sinceMs: number): { day: string; n: number }[] {
    const rows = this.db
      .query(
        "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n " +
          "FROM download_events WHERE created_at >= ? GROUP BY day ORDER BY day DESC",
      )
      .all(sinceMs) as { day: string; n: number }[];
    return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
  }

  // -- Phase 2: favourites, download settings, notifications --------------
  // Owner key is one text key per account ("user:<id>") or anonymous
  // browser ("anon:<browser id>"), so the same scoping works for
  // logged-in and anonymous visitors.

  getDownloadById(id: number): DownloadRow | null {
    const row = this.db
      .query(
        "SELECT id, source_url, title, video_url, cover_url, user_id, anon_id, created_at " +
          "FROM downloads WHERE id = ? LIMIT 1",
      )
      .get(id) as {
      id: number;
      source_url: string;
      title: string;
      video_url: string;
      cover_url: string | null;
      user_id: number | null;
      anon_id: string | null;
      created_at: number;
    } | null;
    return row ? this.toDownloadRow(row) : null;
  }

  private toFavoriteRow(r: {
    id: number;
    download_id: number;
    user_id: number | null;
    anon_id: string | null;
    owner_key: string;
    title: string;
    cover_url: string | null;
    video_url: string;
    quality_label: string;
    source_url: string;
    created_at: number;
  }): FavoriteRow {
    return {
      id: r.id,
      downloadId: r.download_id,
      userId: r.user_id,
      anonId: r.anon_id,
      ownerKey: r.owner_key,
      title: r.title,
      coverUrl: r.cover_url,
      videoUrl: r.video_url,
      qualityLabel: r.quality_label,
      sourceUrl: r.source_url,
      createdAt: new Date(r.created_at),
    };
  }

  insertFavorite(row: {
    downloadId: number;
    userId: number | null;
    anonId: string | null;
    ownerKey: string;
    title: string;
    coverUrl: string | null;
    videoUrl: string;
    qualityLabel: string;
    sourceUrl: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO favorites (download_id, user_id, anon_id, owner_key, title, cover_url, video_url, quality_label, source_url, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.downloadId,
        row.userId,
        row.anonId,
        row.ownerKey,
        row.title,
        row.coverUrl,
        row.videoUrl,
        row.qualityLabel,
        row.sourceUrl,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  findFavorite(ownerKey: string, downloadId: number): FavoriteRow | null {
    const row = this.db
      .query(
        "SELECT * FROM favorites WHERE owner_key = ? AND download_id = ? LIMIT 1",
      )
      .get(ownerKey, downloadId) as {
      id: number;
      download_id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      title: string;
      cover_url: string | null;
      video_url: string;
      quality_label: string;
      source_url: string;
      created_at: number;
    } | null;
    return row ? this.toFavoriteRow(row) : null;
  }

  listFavorites(ownerKey: string, limit: number): FavoriteRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM favorites WHERE owner_key = ? ORDER BY id DESC LIMIT ?",
      )
      .all(ownerKey, limit) as {
      id: number;
      download_id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      title: string;
      cover_url: string | null;
      video_url: string;
      quality_label: string;
      source_url: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toFavoriteRow(r));
  }

  deleteFavoriteById(id: number, ownerKey: string): void {
    this.db
      .query("DELETE FROM favorites WHERE id = ? AND owner_key = ?")
      .run(id, ownerKey);
  }

  deleteFavoritesForDownload(downloadId: number): void {
    this.db
      .query("DELETE FROM favorites WHERE download_id = ?")
      .run(downloadId);
  }

  deleteFavoritesForUser(userId: number): void {
    this.db.query("DELETE FROM favorites WHERE user_id = ?").run(userId);
  }

  deleteAllFavorites(): void {
    this.db.query("DELETE FROM favorites").run();
  }

  // -- per-account download settings ----------------------------------------

  getUserSettings(userId: number): UserSettingsRow | null {
    const row = this.db
      .query("SELECT * FROM user_settings WHERE user_id = ? LIMIT 1")
      .get(userId) as {
      user_id: number;
      default_quality: string;
      default_mode: string;
      theme?: string | null;
      language?: string | null;
      updated_at: number;
    } | null;
    if (!row) return null;
    return {
      userId: row.user_id,
      defaultQuality: row.default_quality,
      defaultMode: row.default_mode,
      theme: row.theme === "light" ? "light" : "dark",
      language: row.language === "ur" ? "ur" : "en",
      updatedAt: new Date(row.updated_at),
    };
  }

  upsertUserSettings(
    userId: number,
    defaultQuality: string,
    defaultMode: string,
    theme: string,
    language: string,
  ): void {
    this.db
      .query(
        "INSERT INTO user_settings (user_id, default_quality, default_mode, theme, language, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET default_quality = excluded.default_quality, " +
          "default_mode = excluded.default_mode, theme = excluded.theme, " +
          "language = excluded.language, updated_at = excluded.updated_at",
      )
      .run(userId, defaultQuality, defaultMode, theme, language, Date.now());
  }

  deleteUserSettings(userId: number): void {
    this.db
      .query("DELETE FROM user_settings WHERE user_id = ?")
      .run(userId);
  }

  updateUserName(id: number, name: string): void {
    this.db.query("UPDATE users SET name = ? WHERE id = ?").run(name, id);
  }

  // -- notifications ----------------------------------------------------------
  // Created ONLY by real server events (payment received, plan
  // activated/expired/exhausted, daily limit reached) — never seeded.

  insertNotification(row: {
    userId: number | null;
    anonId: string | null;
    ownerKey: string;
    type: string;
    title: string;
    message: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO notifications (user_id, anon_id, owner_key, type, title, message, read, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .run(
        row.userId,
        row.anonId,
        row.ownerKey,
        row.type,
        row.title,
        row.message,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  private toNotificationRow(r: {
    id: number;
    user_id: number | null;
    anon_id: string | null;
    owner_key: string;
    type: string;
    title: string;
    message: string;
    read: number;
    created_at: number;
  }): NotificationRow {
    return {
      id: r.id,
      userId: r.user_id,
      anonId: r.anon_id,
      ownerKey: r.owner_key,
      type: r.type,
      title: r.title,
      message: r.message,
      read: r.read === 1,
      createdAt: new Date(r.created_at),
    };
  }

  listNotifications(ownerKey: string, limit: number): NotificationRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM notifications WHERE owner_key = ? ORDER BY id DESC LIMIT ?",
      )
      .all(ownerKey, limit) as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      type: string;
      title: string;
      message: string;
      read: number;
      created_at: number;
    }[];
    return rows.map((r) => this.toNotificationRow(r));
  }

  markNotificationRead(id: number, ownerKey: string): void {
    this.db
      .query(
        "UPDATE notifications SET read = 1 WHERE id = ? AND owner_key = ?",
      )
      .run(id, ownerKey);
  }

  markAllNotificationsRead(ownerKey: string): void {
    this.db
      .query(
        "UPDATE notifications SET read = 1 WHERE owner_key = ? AND read = 0",
      )
      .run(ownerKey);
  }

  deleteNotification(id: number, ownerKey: string): void {
    this.db
      .query("DELETE FROM notifications WHERE id = ? AND owner_key = ?")
      .run(id, ownerKey);
  }

  deleteNotificationsForUser(userId: number): void {
    this.db
      .query("DELETE FROM notifications WHERE user_id = ?")
      .run(userId);
  }

  /** True when this owner already got a daily-limit notification today
   *  (UTC day) — the limit notification is sent at most once per day. */
  hasLimitNotificationToday(ownerKey: string, dayStartMs: number): boolean {
    const row = this.db
      .query(
        "SELECT id FROM notifications WHERE owner_key = ? AND type = 'limit' AND created_at >= ? LIMIT 1",
      )
      .get(ownerKey, dayStartMs) as { id: number } | null;
    return !!row;
  }

  // -- Help Center articles (Phase 3) --------------------------------------

  private toHelpArticleRow(r: {
    id: number;
    title: string;
    body: string;
    category: string;
    created_at: number;
    updated_at: number;
  }): HelpArticleRow {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  countHelpArticles(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM help_articles")
      .get() as { n: number };
    return row.n;
  }

  listHelpArticles(): HelpArticleRow[] {
    const rows = this.db
      .query("SELECT * FROM help_articles ORDER BY id ASC")
      .all() as {
      id: number;
      title: string;
      body: string;
      category: string;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => this.toHelpArticleRow(r));
  }

  insertHelpArticle(row: {
    title: string;
    body: string;
    category: string;
  }): number {
    const now = Date.now();
    const info = this.db
      .query(
        "INSERT INTO help_articles (title, body, category, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.title, row.body, row.category, now, now);
    return Number(info.lastInsertRowid);
  }

  updateHelpArticle(
    id: number,
    patch: { title?: string; category?: string; body?: string },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number)[] = [Date.now()];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.category !== undefined) {
      sets.push("category = ?");
      values.push(patch.category);
    }
    if (patch.body !== undefined) {
      sets.push("body = ?");
      values.push(patch.body);
    }
    this.db
      .query(`UPDATE help_articles SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
  }

  deleteHelpArticle(id: number): void {
    this.db.query("DELETE FROM help_articles WHERE id = ?").run(id);
  }

  // -- Support tickets (Phase 3) --------------------------------------------

  private toSupportTicketRow(r: {
    id: number;
    user_id: number | null;
    anon_id: string | null;
    owner_key: string;
    subject: string;
    category: string;
    status: string;
    created_at: number;
    updated_at: number;
  }): SupportTicketRow {
    return {
      id: r.id,
      userId: r.user_id,
      anonId: r.anon_id,
      ownerKey: r.owner_key,
      subject: r.subject,
      category: r.category,
      status: r.status,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  private toTicketMessageRow(r: {
    id: number;
    ticket_id: number;
    author_role: string;
    message: string;
    created_at: number;
  }): TicketMessageRow {
    return {
      id: r.id,
      ticketId: r.ticket_id,
      authorRole: r.author_role,
      message: r.message,
      createdAt: new Date(r.created_at),
    };
  }

  insertTicket(row: {
    userId: number | null;
    anonId: string | null;
    ownerKey: string;
    subject: string;
    category: string;
  }): number {
    const now = Date.now();
    const info = this.db
      .query(
        "INSERT INTO support_tickets (user_id, anon_id, owner_key, subject, category, status, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
      )
      .run(
        row.userId,
        row.anonId,
        row.ownerKey,
        row.subject,
        row.category,
        now,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  getTicketById(id: number): SupportTicketRow | null {
    const row = this.db
      .query("SELECT * FROM support_tickets WHERE id = ? LIMIT 1")
      .get(id) as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      subject: string;
      category: string;
      status: string;
      created_at: number;
      updated_at: number;
    } | null;
    return row ? this.toSupportTicketRow(row) : null;
  }

  getTicketByIdAndOwner(id: number, ownerKey: string): SupportTicketRow | null {
    const row = this.db
      .query(
        "SELECT * FROM support_tickets WHERE id = ? AND owner_key = ? LIMIT 1",
      )
      .get(id, ownerKey) as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      subject: string;
      category: string;
      status: string;
      created_at: number;
      updated_at: number;
    } | null;
    return row ? this.toSupportTicketRow(row) : null;
  }

  listTicketsForOwner(ownerKey: string): SupportTicketRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM support_tickets WHERE owner_key = ? ORDER BY id DESC",
      )
      .all(ownerKey) as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      subject: string;
      category: string;
      status: string;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => this.toSupportTicketRow(r));
  }

  listAllTickets(): SupportTicketRow[] {
    const rows = this.db
      .query("SELECT * FROM support_tickets ORDER BY id DESC")
      .all() as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      subject: string;
      category: string;
      status: string;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => this.toSupportTicketRow(r));
  }

  updateTicketStatus(id: number, status: string): void {
    this.db
      .query(
        "UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, Date.now(), id);
  }

  insertTicketMessage(row: {
    ticketId: number;
    authorRole: string;
    message: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO ticket_messages (ticket_id, author_role, message, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(row.ticketId, row.authorRole, row.message, Date.now());
    return Number(info.lastInsertRowid);
  }

  listTicketMessages(ticketId: number): TicketMessageRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC",
      )
      .all(ticketId) as {
      id: number;
      ticket_id: number;
      author_role: string;
      message: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toTicketMessageRow(r));
  }

  deleteTicketMessagesForTickets(ticketIds: number[]): void {
    if (ticketIds.length === 0) return;
    const placeholders = ticketIds.map(() => "?").join(", ");
    this.db
      .query(
        `DELETE FROM ticket_messages WHERE ticket_id IN (${placeholders})`,
      )
      .run(...ticketIds);
  }

  deleteTicketsForUser(userId: number): void {
    this.db
      .query("DELETE FROM support_tickets WHERE user_id = ?")
      .run(userId);
  }

  /** All subscriptions (used by the backup export). */
  listAllSubscriptions(): SubscriptionRow[] {
    const rows = this.db
      .query("SELECT * FROM subscriptions ORDER BY id ASC")
      .all() as {
      id: number;
      user_id: number;
      plan_id: number;
      plan_name: string;
      price_cents: number;
      duration_days: number;
      limit_total: number;
      limit_used: number;
      starts_at: number;
      expires_at: number;
      status: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toSubscriptionRow(r));
  }

  /** All history rows (used by the backup export). */
  listAllDownloads(): DownloadRow[] {
    const rows = this.db
      .query(
        "SELECT id, source_url, title, video_url, cover_url, user_id, anon_id, created_at " +
          "FROM downloads ORDER BY id ASC",
      )
      .all() as {
      id: number;
      source_url: string;
      title: string;
      video_url: string;
      cover_url: string | null;
      user_id: number | null;
      anon_id: string | null;
      created_at: number;
    }[];
    return rows.map((r) => this.toDownloadRow(r));
  }

  /** All favourites (used by the backup export). */
  listAllFavorites(): FavoriteRow[] {
    const rows = this.db
      .query("SELECT * FROM favorites ORDER BY id ASC")
      .all() as {
      id: number;
      download_id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      title: string;
      cover_url: string | null;
      video_url: string;
      quality_label: string;
      source_url: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toFavoriteRow(r));
  }

  listTicketIdsForUser(userId: number): number[] {
    const rows = this.db
      .query("SELECT id FROM support_tickets WHERE user_id = ?")
      .all(userId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  // -- Phase 4: system logs, login rate limiting, broadcasts, reports --
  // The log is NEVER seeded — rows only appear for real admin actions.

  private toSystemLogRow(r: {
    id: number;
    actor_type: string;
    actor_email: string | null;
    action: string;
    detail: string;
    created_at: number;
  }): SystemLogRow {
    return {
      id: r.id,
      actorType: r.actor_type,
      actorEmail: r.actor_email,
      action: r.action,
      detail: r.detail,
      createdAt: new Date(r.created_at),
    };
  }

  insertSystemLog(row: {
    actorType: string;
    actorEmail: string | null;
    action: string;
    detail: string;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO system_logs (actor_type, actor_email, action, detail, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.actorType, row.actorEmail, row.action, row.detail, Date.now());
    return Number(info.lastInsertRowid);
  }

  listSystemLogs(opts: {
    action?: string;
    search?: string;
    limit: number;
    offset: number;
  }): SystemLogRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.action) {
      where.push("action = ?");
      params.push(opts.action);
    }
    if (opts.search) {
      const q = `%${opts.search}%`;
      where.push("(actor_email LIKE ? OR detail LIKE ? OR action LIKE ?)");
      params.push(q, q, q);
    }
    const sql =
      "SELECT * FROM system_logs" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id DESC LIMIT ? OFFSET ?";
    const rows = this.db.query(sql).all(...params, opts.limit, opts.offset) as {
      id: number;
      actor_type: string;
      actor_email: string | null;
      action: string;
      detail: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toSystemLogRow(r));
  }

  countSystemLogs(opts: { action?: string; search?: string }): number {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.action) {
      where.push("action = ?");
      params.push(opts.action);
    }
    if (opts.search) {
      const q = `%${opts.search}%`;
      where.push("(actor_email LIKE ? OR detail LIKE ? OR action LIKE ?)");
      params.push(q, q, q);
    }
    const sql =
      "SELECT COUNT(*) AS n FROM system_logs" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "");
    const row = this.db.query(sql).get(...params) as { n: number };
    return row.n;
  }

  /** Distinct action names present in the log (for the filter list). */
  listSystemLogActions(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT action FROM system_logs ORDER BY action")
      .all() as { action: string }[];
    return rows.map((r) => r.action);
  }

  deleteSystemLogs(): void {
    this.db.query("DELETE FROM system_logs").run();
  }

  // -- login attempts (rate limiting) --------------------------------------

  getLoginAttempt(email: string): LoginAttemptRow | null {
    const row = this.db
      .query("SELECT * FROM login_attempts WHERE email = ? LIMIT 1")
      .get(email) as {
      email: string;
      failed_count: number;
      first_failed_at: number;
      locked_until: number | null;
    } | null;
    if (!row) return null;
    return {
      email: row.email,
      failedCount: row.failed_count,
      firstFailedAt: new Date(row.first_failed_at),
      lockedUntil: row.locked_until === null ? null : new Date(row.locked_until),
    };
  }

  upsertLoginAttempt(row: {
    email: string;
    failedCount: number;
    firstFailedAt: Date;
    lockedUntil: Date | null;
  }): void {
    this.db
      .query(
        "INSERT INTO login_attempts (email, failed_count, first_failed_at, locked_until) " +
          "VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(email) DO UPDATE SET failed_count = excluded.failed_count, " +
          "first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until",
      )
      .run(
        row.email,
        row.failedCount,
        row.firstFailedAt.getTime(),
        row.lockedUntil ? row.lockedUntil.getTime() : null,
      );
  }

  deleteLoginAttempt(email: string): void {
    this.db.query("DELETE FROM login_attempts WHERE email = ?").run(email);
  }

  listLoginAttempts(): LoginAttemptRow[] {
    const rows = this.db
      .query("SELECT * FROM login_attempts ORDER BY email ASC")
      .all() as {
      email: string;
      failed_count: number;
      first_failed_at: number;
      locked_until: number | null;
    }[];
    return rows.map((r) => ({
      email: r.email,
      failedCount: r.failed_count,
      firstFailedAt: new Date(r.first_failed_at),
      lockedUntil: r.locked_until === null ? null : new Date(r.locked_until),
    }));
  }

  // -- broadcasts ------------------------------------------------------------

  insertBroadcast(row: {
    title: string;
    message: string;
    recipientCount: number;
  }): number {
    const info = this.db
      .query(
        "INSERT INTO broadcasts (title, message, recipient_count, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(row.title, row.message, row.recipientCount, Date.now());
    return Number(info.lastInsertRowid);
  }

  private toBroadcastRow(r: {
    id: number;
    title: string;
    message: string;
    recipient_count: number;
    created_at: number;
  }): BroadcastRow {
    return {
      id: r.id,
      title: r.title,
      message: r.message,
      recipientCount: r.recipient_count,
      createdAt: new Date(r.created_at),
    };
  }

  listBroadcasts(limit = 50): BroadcastRow[] {
    const rows = this.db
      .query("SELECT * FROM broadcasts ORDER BY id DESC LIMIT ?")
      .all(limit) as {
      id: number;
      title: string;
      message: string;
      recipient_count: number;
      created_at: number;
    }[];
    return rows.map((r) => this.toBroadcastRow(r));
  }

  deleteBroadcasts(): void {
    this.db.query("DELETE FROM broadcasts").run();
  }

  // -- reports (real aggregates over a UTC date range) ----------------------

  /** Download events in [fromMs, toMs) with the fields reports need. */
  listDownloadEventsInRange(
    fromMs: number,
    toMs: number,
  ): { userId: number | null; sizeBytes: number; createdAt: Date }[] {
    const rows = this.db
      .query(
        "SELECT user_id, size_bytes, created_at FROM download_events " +
          "WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC",
      )
      .all(fromMs, toMs) as {
      user_id: number | null;
      size_bytes: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      userId: r.user_id,
      sizeBytes: r.size_bytes,
      createdAt: new Date(r.created_at),
    }));
  }

  listPaymentsInRange(
    fromMs: number,
    toMs: number,
  ): { amountCents: number; createdAt: Date }[] {
    const rows = this.db
      .query(
        "SELECT amount_cents, created_at FROM payments " +
          "WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC",
      )
      .all(fromMs, toMs) as { amount_cents: number; created_at: number }[];
    return rows.map((r) => ({
      amountCents: r.amount_cents,
      createdAt: new Date(r.created_at),
    }));
  }

  listUserSignupsInRange(fromMs: number, toMs: number): { createdAt: Date }[] {
    const rows = this.db
      .query(
        "SELECT created_at FROM users WHERE role = 'user' " +
          "AND created_at >= ? AND created_at < ? ORDER BY created_at ASC",
      )
      .all(fromMs, toMs) as { created_at: number }[];
    return rows.map((r) => ({ createdAt: new Date(r.created_at) }));
  }

  countActivatedRequestsInRange(fromMs: number, toMs: number): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM purchase_requests WHERE status = 'activated' " +
          "AND decided_at >= ? AND decided_at < ?",
      )
      .get(fromMs, toMs) as { n: number };
    return row.n;
  }

  // -- backup export helpers (whole-table reads) ----------------------------

  listDownloadEvents(): { id: number; userId: number | null; anonId: string | null; sizeBytes: number; createdAt: Date }[] {
    const rows = this.db
      .query("SELECT * FROM download_events ORDER BY id ASC")
      .all() as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      size_bytes: number;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      anonId: r.anon_id,
      sizeBytes: r.size_bytes,
      createdAt: new Date(r.created_at),
    }));
  }

  listSettings(): { key: string; value: string }[] {
    return this.db.query("SELECT key, value FROM settings ORDER BY key ASC").all() as {
      key: string;
      value: string;
    }[];
  }

  listContactMessages(): { id: number; name: string; email: string; message: string; createdAt: Date }[] {
    const rows = this.db
      .query("SELECT * FROM contact_messages ORDER BY id ASC")
      .all() as {
      id: number;
      name: string;
      email: string;
      message: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      message: r.message,
      createdAt: new Date(r.created_at),
    }));
  }

  listAllNotifications(): NotificationRow[] {
    const rows = this.db
      .query("SELECT * FROM notifications ORDER BY id ASC")
      .all() as {
      id: number;
      user_id: number | null;
      anon_id: string | null;
      owner_key: string;
      type: string;
      title: string;
      message: string;
      read: number;
      created_at: number;
    }[];
    return rows.map((r) => this.toNotificationRow(r));
  }

  listAllTicketMessages(): TicketMessageRow[] {
    const rows = this.db
      .query("SELECT * FROM ticket_messages ORDER BY id ASC")
      .all() as {
      id: number;
      ticket_id: number;
      author_role: string;
      message: string;
      created_at: number;
    }[];
    return rows.map((r) => this.toTicketMessageRow(r));
  }

  listUserSettings(): UserSettingsRow[] {
    const rows = this.db
      .query("SELECT * FROM user_settings ORDER BY user_id ASC")
      .all() as {
      user_id: number;
      default_quality: string;
      default_mode: string;
      theme?: string | null;
      language?: string | null;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      userId: r.user_id,
      defaultQuality: r.default_quality,
      defaultMode: r.default_mode,
      theme: r.theme === "light" ? "light" : "dark",
      language: r.language === "ur" ? "ur" : "en",
      updatedAt: new Date(r.updated_at),
    }));
  }
}
