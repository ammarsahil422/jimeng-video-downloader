// Disk blob store — standalone replacement for the Hatch ctx.blobs store.
// prepareDownload fetches a Jimeng CDN file once, saves it under
// <dataDir>/files/, and the server serves it back from /blobs/<key>.
// Files are keyed by an FNV-1a hash of the source URL (same scheme as the
// hosted version), so re-downloading the same video is a cache hit.
//
// A size cap keeps a busy site from filling the disk: when the total cache
// passes MAX_CACHE_BYTES (default 5 GB), the oldest files are deleted first.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type StoredFile = {
  key: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
};

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export function blobKeyForUrl(url: string): string {
  // FNV-1a 32-bit — stable cache key per source URL.
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `jimeng-dl/${hash.toString(16).padStart(8, "0")}`;
}

function filenameFor(key: string, contentType: string): string {
  const base = key.split("/").pop() ?? "file";
  const ext =
    EXT_BY_CONTENT_TYPE[contentType.split(";")[0]?.trim() ?? ""] ?? "bin";
  return `${base}.${ext}`;
}

export class FileStore {
  readonly dir: string;
  readonly maxBytes: number;

  constructor(dataDir: string, maxBytes = 5_000_000_000) {
    this.dir = join(dataDir, "files");
    mkdirSync(this.dir, { recursive: true });
    this.maxBytes = maxBytes;
  }

  private pathFor(filename: string): string {
    // Keys are server-generated hashes; reject anything with separators.
    if (!/^[0-9a-f]+\.(mp4|webm|jpg|jpeg|png|webp|gif|bin)$/.test(filename)) {
      throw new Error("bad file key");
    }
    return join(this.dir, filename);
  }

  /** The file already stored for this source URL, if any. */
  existing(key: string): StoredFile | null {
    const base = key.split("/").pop() ?? "";
    for (const ext of Object.keys(CONTENT_TYPE_BY_EXT)) {
      const filename = `${base}.${ext}`;
      const path = join(this.dir, filename);
      if (existsSync(path)) {
        const st = statSync(path);
        return {
          key,
          filename,
          sizeBytes: st.size,
          contentType: CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream",
        };
      }
    }
    return null;
  }

  store(key: string, bytes: Uint8Array, contentType: string): StoredFile {
    const filename = filenameFor(key, contentType);
    const path = this.pathFor(filename);
    Bun.write(path, bytes);
    this.prune();
    return {
      key,
      filename,
      sizeBytes: bytes.byteLength,
      contentType:
        CONTENT_TYPE_BY_EXT[filename.split(".").pop() ?? ""] ??
        "application/octet-stream",
    };
  }

  /** Look a stored file up by the public key (jimeng-dl/<hash>). */
  lookup(key: string): StoredFile | null {
    if (!/^jimeng-dl\/[0-9a-f]{8}$/.test(key)) return null;
    return this.existing(key);
  }

  /** Total bytes currently stored in the cache (admin dashboard). */
  totalBytes(): number {
    try {
      return readdirSync(this.dir).reduce((sum, name) => {
        try {
          return sum + statSync(join(this.dir, name)).size;
        } catch {
          return sum;
        }
      }, 0);
    } catch {
      return 0;
    }
  }

  /** Read a byte range (or the whole file when range is null). */
  async readSlice(
    filename: string,
    range: { start: number; end: number | null } | null,
  ): Promise<{ blob: Blob; sizeBytes: number; contentType: string } | null> {
    let path: string;
    try {
      path = this.pathFor(filename);
    } catch {
      return null;
    }
    if (!existsSync(path)) return null;
    const file = Bun.file(path);
    const sizeBytes = file.size;
    const contentType =
      CONTENT_TYPE_BY_EXT[filename.split(".").pop() ?? ""] ??
      "application/octet-stream";
    if (!range) return { blob: file, sizeBytes, contentType };
    const start = Math.max(0, range.start);
    const end = range.end === null ? sizeBytes - 1 : Math.min(range.end, sizeBytes - 1);
    if (start > end) return null;
    return { blob: file.slice(start, end + 1), sizeBytes, contentType };
  }

  private prune(): void {
    try {
      const entries = readdirSync(this.dir)
        .map((name) => {
          const path = join(this.dir, name);
          const st = statSync(path);
          return { name, path, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
      let total = entries.reduce((s, e) => s + e.size, 0);
      for (const e of entries) {
        if (total <= this.maxBytes) break;
        unlinkSync(e.path);
        total -= e.size;
      }
    } catch {
      /* cache pruning is best-effort */
    }
  }
}
