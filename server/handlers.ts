// Action handlers — the standalone port of the Hatch-hosted version's
// `Actions` object (server/src/actions.ts). Each handler takes plain JSON
// args and returns plain JSON; server.ts wraps them in the {data} envelope
// the client expects. Validation errors throw HandlerError (400); anything
// else is a 500.

import type { Store } from "./db";
import { blobKeyForUrl, type FileStore } from "./files";
import {
  ALLOWED_HOSTS,
  BROWSER_UA,
  extractCandidateUrls,
  fetchWithTimeout,
  resolveBuiltIn,
  resolveViaCustomApi,
} from "./resolver";

export class HandlerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Env = { store: Store; files: FileStore };

function keyHint(key: string | null): string | null {
  if (!key) return null;
  return "••••" + key.slice(-4);
}

function reqString(args: unknown, field: string, max = 4000): string {
  const rec = asRecord(args);
  const v = rec?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new HandlerError(400, `${field} is required`);
  }
  if (v.length > max) throw new HandlerError(400, `${field} is too long`);
  return v;
}

function optString(args: unknown, field: string, max = 500): string {
  const rec = asRecord(args);
  const v = rec?.[field];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HandlerError(400, `${field} must be a string`);
  if (v.length > max) throw new HandlerError(400, `${field} is too long`);
  return v;
}

function reqInt(args: unknown, field: string): number {
  const rec = asRecord(args);
  const v = rec?.[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new HandlerError(400, `${field} must be a positive integer`);
  }
  return v;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const AD_SLOTS = ["head", "top", "incontent", "sidebar", "bottom"] as const;
type AdSlot = (typeof AD_SLOTS)[number];

const DOWNLOAD_HOST_SUFFIXES = [
  "jimeng.com",
  "jianying.com",
  "capcut.com",
  "douyinvod.com",
  "douyinpic.com",
  "byteimg.com",
  "ibytedtos.com",
  "bytecdn.cn",
  // The clean origin masters from mget_item_info are served from ByteDance's
  // vlab VOD CDN (e.g. v3-artist.vlabvod.com) — without this suffix the
  // download proxy would refuse the very file the site promises.
  "vlabvod.com",
];

function isDownloadableHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return DOWNLOAD_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

type ResolveResponse = {
  ok: boolean;
  sourceUrl: string;
  title: string;
  coverUrl: string | null;
  videos: import("./resolver").VideoOption[];
  images: import("./resolver").ImageOption[];
  usedCustomApi: boolean;
  note: string | null;
  error: string | null;
};

async function resolveLink(env: Env, args: unknown): Promise<ResolveResponse> {
  const text = reqString(args, "text", 4000);
  const candidates = extractCandidateUrls(text);
  const hostOf = (u: string): string => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  const shareUrl = candidates.find((u) => ALLOWED_HOSTS.has(hostOf(u)));
  // Share texts ending in "录入分身，一起出镜吧" are Jimeng's avatar
  // (分身 / cast-template) invites. The video on them resolves through the
  // same item API when the link is fresh, but these invite links are
  // only valid ~48 hours — say so when one fails.
  const avatarNote = /分身/.test(text)
    ? "Note: Your share text mentions the avatar feature — this is a link for Jimeng's avatar / cast-template feature. These links are usually only valid for 48 hours; copy a fresh link from the Jimeng app and paste it here right away."
    : null;
  if (!shareUrl) {
    if (candidates.length > 0) {
      return {
        ok: false, sourceUrl: candidates[0] ?? "", title: "", coverUrl: null,
        videos: [], images: [], usedCustomApi: false, note: avatarNote,
        error:
          "A link was found in the pasted text, but it is not a Jimeng link. Only public share links from jimeng.jianying.com, jimeng.cn or dreamina.capcut.com work.",
      };
    }
    return {
      ok: false, sourceUrl: "", title: "", coverUrl: null, videos: [], images: [],
      usedCustomApi: false, note: null,
      error:
        "No link was found. Paste Jimeng's FULL share text (together with the Chinese text) — the link will be extracted from it automatically.",
    };
  }

  const apiKey = env.store.getSetting("api_key");
  const apiBase = env.store.getSetting("api_base_url");
  let note: string | null = null;

  if (apiKey && apiBase) {
    try {
      const viaApi = await resolveViaCustomApi(apiBase, apiKey, shareUrl);
      if (viaApi && viaApi.videos.length > 0) {
        const first = viaApi.videos[0];
        if (first) {
          env.store.insertDownload({
            sourceUrl: shareUrl,
            title: viaApi.title,
            videoUrl: first.url,
            coverUrl: viaApi.coverUrl,
          });
        }
        return {
          ok: true, sourceUrl: shareUrl, title: viaApi.title,
          coverUrl: viaApi.coverUrl, videos: viaApi.videos, images: viaApi.images,
          usedCustomApi: true, note: "The video was fetched using your saved API key.", error: null,
        };
      }
      note = "The custom API did not respond, so the built-in method was used instead.";
    } catch {
      note = "The custom API failed, so the built-in method was used instead.";
    }
  }

  const result = await resolveBuiltIn(shareUrl);
  if (result.ok) {
    const first = result.videos[0];
    if (first) {
      env.store.insertDownload({
        sourceUrl: shareUrl,
        title: result.title,
        videoUrl: first.url,
        coverUrl: result.coverUrl,
      });
    }
    return {
      ok: true, sourceUrl: result.sourceUrl, title: result.title,
      coverUrl: result.coverUrl, videos: result.videos, images: result.images,
      usedCustomApi: false, note, error: null,
    };
  }
  return {
    ok: false, sourceUrl: result.sourceUrl, title: "", coverUrl: null,
    videos: [], images: [], usedCustomApi: false, note: note ?? avatarNote, error: result.error,
  };
}

async function prepareDownload(
  env: Env,
  args: unknown,
): Promise<{
  ok: boolean;
  downloadUrl: string | null;
  sizeBytes: number;
  error: string | null;
}> {
  const url = reqString(args, "url", 4000);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "The file link is not valid." };
  }
  if (parsed.protocol !== "https:" || !isDownloadableHost(parsed.hostname)) {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: "This file is not on Jimeng's CDN, so the download could not be prepared on the server.",
    };
  }
  const key = blobKeyForUrl(url);
  const cached = env.files.existing(key);
  if (cached) {
    return {
      ok: true,
      downloadUrl: `./blobs/${key}`,
      sizeBytes: cached.sizeBytes,
      error: null,
    };
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": BROWSER_UA, Referer: "https://jimeng.jianying.com/" } },
      120000,
    );
  } catch {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: "The file could not be loaded from Jimeng's CDN — this is an internet or CDN issue. Please try again in a while.",
    };
  }
  if (!res.ok) {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: `Jimeng's CDN refused to serve the file (HTTP ${res.status}) — the link may have expired. Fetch the video again and then download it.`,
    };
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > 300_000_000) {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "The file is too large (over 300 MB) and cannot be prepared for download on the server." };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "An empty file was received from the CDN — please try again." };
  }
  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ||
    "application/octet-stream";
  const stored = env.files.store(key, bytes, contentType);
  return {
    ok: true,
    downloadUrl: `./blobs/${key}`,
    sizeBytes: stored.sizeBytes,
    error: null,
  };
}

function getSettings(env: Env): {
  apiKeyHint: string | null;
  hasApiKey: boolean;
  apiBaseUrl: string | null;
  adSlots: Record<AdSlot, boolean>;
} {
  const apiKey = env.store.getSetting("api_key");
  const adSlots = {} as Record<AdSlot, boolean>;
  for (const slot of AD_SLOTS) {
    adSlots[slot] = Boolean(env.store.getSetting(`adsense_${slot}`));
  }
  return {
    apiKeyHint: keyHint(apiKey),
    hasApiKey: Boolean(apiKey),
    apiBaseUrl: env.store.getSetting("api_base_url"),
    adSlots,
  };
}

function saveApiKey(env: Env, args: unknown): { ok: true; hint: string } {
  const key = reqString(args, "apiKey", 500).trim();
  if (key.length < 4) throw new HandlerError(400, "API key must be at least 4 characters");
  env.store.setSetting("api_key", key);
  const base = optString(args, "apiBaseUrl", 500).trim();
  if (base) env.store.setSetting("api_base_url", base);
  else env.store.deleteSetting("api_base_url");
  return { ok: true as const, hint: keyHint(key) ?? "" };
}

function clearApiKey(env: Env): { ok: true } {
  env.store.deleteSetting("api_key");
  env.store.deleteSetting("api_base_url");
  return { ok: true as const };
}

function saveAdCode(env: Env, args: unknown): { ok: true } {
  const rec = asRecord(args);
  const slot = rec?.slot;
  if (typeof slot !== "string" || !(AD_SLOTS as readonly string[]).includes(slot)) {
    throw new HandlerError(400, "slot must be one of: " + AD_SLOTS.join(", "));
  }
  const code = reqString(args, "code", 20000).trim();
  if (!code) throw new HandlerError(400, "code is required");
  env.store.setSetting(`adsense_${slot}`, code);
  return { ok: true as const };
}

function clearAdCode(env: Env, args: unknown): { ok: true } {
  const rec = asRecord(args);
  const slot = rec?.slot;
  if (typeof slot !== "string" || !(AD_SLOTS as readonly string[]).includes(slot)) {
    throw new HandlerError(400, "slot must be one of: " + AD_SLOTS.join(", "));
  }
  env.store.deleteSetting(`adsense_${slot}`);
  return { ok: true as const };
}

function listHistory(env: Env, args: unknown): {
  items: {
    id: number;
    sourceUrl: string;
    title: string;
    videoUrl: string;
    coverUrl: string | null;
    createdAt: string;
  }[];
} {
  const rec = asRecord(args);
  let limit = 30;
  const raw = rec?.limit;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    limit = Math.min(raw, 100);
  }
  return {
    items: env.store.listDownloads(limit).map((r) => ({
      id: r.id,
      sourceUrl: r.sourceUrl,
      title: r.title,
      videoUrl: r.videoUrl,
      coverUrl: r.coverUrl,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function deleteHistoryItem(env: Env, args: unknown): { ok: true } {
  const id = reqInt(args, "id");
  env.store.deleteDownload(id);
  return { ok: true as const };
}

function clearHistory(env: Env): { ok: true } {
  env.store.clearDownloads();
  return { ok: true as const };
}

function submitContact(env: Env, args: unknown): { ok: true } {
  const name = reqString(args, "name", 120).trim();
  const email = reqString(args, "email", 200).trim();
  const message = reqString(args, "message", 4000).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HandlerError(400, "email must be a valid email address");
  }
  env.store.insertContactMessage({ name, email, message });
  return { ok: true as const };
}

export type ActionHandler = (env: Env, args: unknown) => Promise<unknown> | unknown;

export const ACTIONS: Record<string, ActionHandler> = {
  resolveLink,
  prepareDownload,
  getSettings,
  saveApiKey,
  clearApiKey,
  saveAdCode,
  clearAdCode,
  listHistory,
  deleteHistoryItem,
  clearHistory,
  submitContact,
};
