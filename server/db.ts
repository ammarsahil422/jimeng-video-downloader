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
};

export type SessionRow = {
  token: string;
  userId: number;
  expiresAt: Date;
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
    } | null;
    if (!row) return null;
    return {
      token: row.token,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    };
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
}
