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
  }): number {
    const info = this.db
      .query(
        "INSERT INTO downloads (source_url, title, video_url, cover_url, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        row.sourceUrl,
        row.title,
        row.videoUrl,
        row.coverUrl,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  listDownloads(limit: number): DownloadRow[] {
    const rows = this.db
      .query(
        "SELECT id, source_url, title, video_url, cover_url, created_at " +
          "FROM downloads ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as {
      id: number;
      source_url: string;
      title: string;
      video_url: string;
      cover_url: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sourceUrl: r.source_url,
      title: r.title,
      videoUrl: r.video_url,
      coverUrl: r.cover_url,
      createdAt: new Date(r.created_at),
    }));
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
}
