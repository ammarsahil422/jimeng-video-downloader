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
}
