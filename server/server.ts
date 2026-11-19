// Jimeng Video Downloader — standalone server (Bun).
//
// Serves the built React client from ./public, answers the client's
// POST /actions calls (same {action, args} -> {data} protocol as the
// Hatch-hosted version), and serves prepared downloads from /blobs/<key>.
// Storage: a plain SQLite file (./data/app.db) + downloaded files under
// ./data/files/. No SDK, no external services, no npm runtime dependencies.
//
//   bun run server.ts            (or: bun run start)
//   PORT=3000 HOST=0.0.0.0 DATA_DIR=./data bun run server.ts

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "./db";
import { FileStore } from "./files";
import { ACTIONS, HandlerError, seedAdmin, type Env } from "./handlers";

const ROOT = resolve(import.meta.dir, "..");
const PUBLIC_DIR = join(ROOT, "public");

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(ROOT, "data"));
const MAX_CACHE_BYTES = Number(process.env.MAX_CACHE_BYTES ?? 5_000_000_000);

const store = new Store(DATA_DIR);
const files = new FileStore(DATA_DIR, MAX_CACHE_BYTES);
const env: Env = { store, files };

// Seed the admin account on every boot when none exists, so the admin
// login always works even after the free host resets the database
// (Render Free has no persistent disk).
seedAdmin(env);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot) : "";
  return MIME[ext] ?? "application/octet-stream";
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number | null } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = m[1] === "" ? null : Number(m[1]);
  const end = m[2] === "" ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    // suffix range: last N bytes
    const n = end ?? 0;
    if (n <= 0) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  return { start, end };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // -- health check -------------------------------------------------------
    if (path === "/api/health" && req.method === "GET") {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }

    // -- action RPC ---------------------------------------------------------
    if (path === "/actions" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const rec =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      const action = typeof rec?.action === "string" ? rec.action : "";
      const handler = ACTIONS[action];
      if (!handler) {
        return Response.json({ error: `unknown action: ${action}` }, { status: 404 });
      }
      try {
        const data = await handler(env, rec?.args ?? {});
        return Response.json({ data });
      } catch (err) {
        if (err instanceof HandlerError) {
          return Response.json({ error: err.message }, { status: err.status });
        }
        console.error(`action ${action} failed:`, err);
        return Response.json({ error: "server error" }, { status: 500 });
      }
    }

    // -- prepared downloads ---------------------------------------------------
    // /blobs/jimeng-dl/<hash>  (the URL prepareDownload returns, relative)
    // /files/jimeng-dl/<hash>  (alias)
    if (req.method === "GET" && (path.startsWith("/blobs/") || path.startsWith("/files/"))) {
      const key = decodeURIComponent(path.replace(/^\/(blobs|files)\//, ""));
      const stored = files.lookup(key);
      if (!stored) return new Response("not found", { status: 404 });
      const range = parseRange(req.headers.get("range"), stored.sizeBytes);
      const slice = await files.readSlice(stored.filename, range);
      if (!slice) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {
        "content-type": slice.contentType,
        "content-length": String(slice.blob.size),
        "accept-ranges": "bytes",
        // Force a real download in a real browser (the in-app webview that
        // blocked this flow is exactly why the site is deployed standalone).
        "content-disposition": `attachment; filename="jimeng-no-watermark.${stored.filename.split(".").pop() ?? "mp4"}"`,
        "cache-control": "public, max-age=86400",
      };
      if (range) {
        const start = range.start;
        const end = range.end === null ? stored.sizeBytes - 1 : Math.min(range.end, stored.sizeBytes - 1);
        headers["content-range"] = `bytes ${start}-${end}/${stored.sizeBytes}`;
        return new Response(slice.blob, { status: 206, headers });
      }
      return new Response(slice.blob, { headers });
    }

    // -- static client ---------------------------------------------------------
    if (req.method === "GET") {
      // Never let the SPA fallback swallow API/blob routes.
      let filePath = join(PUBLIC_DIR, decodeURIComponent(path));
      if (path === "/" || path === "") filePath = join(PUBLIC_DIR, "index.html");
      if (!existsSync(filePath) || filePath.includes("..")) {
        // SPA fallback: the client is a single page with internal views.
        filePath = join(PUBLIC_DIR, "index.html");
      }
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(file, {
        headers: { "content-type": mimeFor(filePath) },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`Jimeng Video Downloader running at http://${HOST}:${server.port}/`);
console.log(`Data: ${DATA_DIR} (SQLite app.db + cached files)`);
console.log(`Static client: ${PUBLIC_DIR}`);
