// Action handlers — the standalone port of the Hatch-hosted version's
// `Actions` object (server/src/actions.ts). Each handler takes plain JSON
// args and returns plain JSON; server.ts wraps them in the {data} envelope
// the client expects. Validation errors throw HandlerError (400); anything
// else is a 500.
//
// Downloads are PUBLIC: no user accounts, no registration, no login wall.
// Login is admin-only (sidebar → Login → Admin Panel). Every admin action
// checks the session token and the admin role server-side.

import type {
  PlanRow,
  Store,
  SubscriptionRow,
  UserRow,
} from "./db";
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

function reqIntRange(
  args: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const rec = asRecord(args);
  const v = rec?.[field];
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < min ||
    v > max
  ) {
    throw new HandlerError(
      400,
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return v;
}

function optIntRange(
  args: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const rec = asRecord(args);
  const v = rec?.[field];
  if (v === undefined || v === null) return undefined;
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < min ||
    v > max
  ) {
    throw new HandlerError(
      400,
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return v;
}

function reqEmail(args: unknown, field: string): string {
  const email = reqString(args, field, 200).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HandlerError(400, `${field} must be a valid email address`);
  }
  return email;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const AD_SLOTS = ["head", "top", "incontent", "sidebar", "bottom"] as const;
type AdSlot = (typeof AD_SLOTS)[number];

// ---------------------------------------------------------------------------
// Admin auth — admin-only login for the Admin Panel.
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = "admin@jimengdownloader.com";
// bcrypt hash of the seeded admin password (generated once by the site
// builder; the plaintext is held by the site owner and is NOT in this
// repo). Re-seeded on every boot when no admin exists, so the admin login
// keeps working after the free host resets its database.
const ADMIN_SEED_PASSWORD_HASH =
  "$2b$10$6281AO2EYrbtazNhOnOqIOtsnI8H0kDoN0/RFVk3QQ4sMzGWoCl1.";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

async function hashPassword(pw: string): Promise<string> {
  if (typeof Bun !== "undefined" && Bun.password?.hash) {
    return Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 });
  }
  // Fallback when Bun.password is unavailable: SHA-256 with a random salt.
  const salt = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${pw}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${salt}:${hex}`;
}

async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  if (hash.startsWith("$2")) {
    if (typeof Bun !== "undefined" && Bun.password?.verify) {
      return Bun.password.verify(pw, hash);
    }
    return false;
  }
  if (hash.startsWith("sha256:")) {
    const [, salt, expected] = hash.split(":");
    if (!salt || !expected) return false;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${salt}:${pw}`),
    );
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex === expected;
  }
  return false;
}

/** Seeds the admin account when none exists yet. Safe to call on every
 *  boot/request — the insert is guarded. Called at server start and
 *  before any admin auth check, so the admin login always works even
 *  after the free host resets the database. */
export function seedAdmin(env: Env): void {
  try {
    if (env.store.countAdmins() === 0) {
      env.store.insertUser({
        name: "Admin",
        email: ADMIN_EMAIL,
        passwordHash: ADMIN_SEED_PASSWORD_HASH,
        role: "admin",
        status: "active",
      });
    }
  } catch {
    // A concurrent first request may have seeded already — ignore.
  }
}

type AuthedAdmin = { id: number; name: string; email: string };

function optToken(args: unknown): string | undefined {
  const t = optString(args, "token", 500);
  return t === "" ? undefined : t;
}

/** Validates a session token. Returns null for missing/expired tokens,
 *  disabled accounts, unknown users, or non-admin accounts. */
function authAdmin(env: Env, token: string | undefined): AuthedAdmin | null {
  if (!token) return null;
  seedAdmin(env);
  const sess = env.store.getSession(token);
  if (!sess) return null;
  if (sess.expiresAt.getTime() <= Date.now()) {
    env.store.deleteSession(token);
    return null;
  }
  const u: UserRow | null = env.store.getUserById(sess.userId);
  if (!u || u.status !== "active" || u.role !== "admin") return null;
  return { id: u.id, name: u.name, email: u.email };
}

function requireAdmin(env: Env, args: unknown): AuthedAdmin {
  const me = authAdmin(env, optToken(args));
  if (!me) throw new HandlerError(401, "Please log in as the admin.");
  return me;
}

function createSession(env: Env, userId: number): string {
  const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  env.store.insertSession(token, userId, new Date(Date.now() + SESSION_TTL_MS));
  return token;
}

// ---------------------------------------------------------------------------
// Customer accounts, plans, subscriptions and limits.
// Downloads stay PUBLIC: nobody needs an account to download. Accounts
// exist so customers can buy a monthly plan (more downloads than the
// free daily limit) and so the admin can see customers, assign plans,
// and track payments. There is NO payment gateway yet — a Buy click
// creates a pending purchase request and the admin activates the plan
// by hand after receiving the payment.
// ---------------------------------------------------------------------------

type AuthedUser = {
  id: number;
  name: string;
  email: string;
  role: "user" | "admin";
};

/** Validates a session token. Returns null for missing/expired tokens,
 *  disabled accounts, or unknown users. */
function authUser(env: Env, token: string | undefined): AuthedUser | null {
  if (!token) return null;
  seedAdmin(env);
  const sess = env.store.getSession(token);
  if (!sess) return null;
  if (sess.expiresAt.getTime() <= Date.now()) {
    env.store.deleteSession(token);
    return null;
  }
  const u: UserRow | null = env.store.getUserById(sess.userId);
  if (!u || u.status !== "active") return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role === "admin" ? "admin" : "user",
  };
}

/** Any logged-in, active account (customer or admin). */
function requireUser(env: Env, args: unknown): AuthedUser {
  const me = authUser(env, optToken(args));
  if (!me) throw new HandlerError(401, "Please log in first.");
  return me;
}

/** True when the token belongs to a suspended (disabled) customer
 *  account. authUser() returns null for those, so this separate check is
 *  needed to tell "suspended" apart from "not logged in". */
function isSuspendedUser(env: Env, token: string | undefined): boolean {
  if (!token) return false;
  const sess = env.store.getSession(token);
  if (!sess) return false;
  const u = env.store.getUserById(sess.userId);
  return !!u && u.role === "user" && u.status !== "active";
}

const DEFAULT_PLANS = [
  {
    name: "Starter",
    priceCents: 499,
    durationDays: 30,
    downloadLimit: 1000,
    description: "1,000 video downloads for 30 days.",
  },
  {
    name: "Pro",
    priceCents: 999,
    durationDays: 30,
    downloadLimit: 5000,
    description: "5,000 video downloads for 30 days.",
  },
  {
    name: "Business",
    priceCents: 1999,
    durationDays: 30,
    downloadLimit: 10000,
    description: "10,000 video downloads for 30 days.",
  },
] as const;

/** Seeds the three default plans when the plans table is empty. Safe to
 *  call on every request — the insert is guarded. Prices are editable
 *  defaults; the site owner sets the final prices in Admin → Plans. */
function ensureDefaultPlans(env: Env): void {
  if (env.store.countPlans() === 0) {
    for (const p of DEFAULT_PLANS) {
      env.store.insertPlan({
        name: p.name,
        priceCents: p.priceCents,
        durationDays: p.durationDays,
        downloadLimit: p.downloadLimit,
        description: p.description,
      });
    }
  }
}

const DEFAULT_FREE_DAILY_LIMIT = 10;

/** Free daily download limit from Admin → Settings (default 10). 0 means
 *  no limit. */
function getFreeDailyLimit(env: Env): number {
  const raw = env.store.getSetting("free_daily_limit");
  if (raw === null) return DEFAULT_FREE_DAILY_LIMIT;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FREE_DAILY_LIMIT;
}

/** The customer's currently usable subscription, if any. A subscription
 *  past its expiry date or with its quota used up is flipped to
 *  'expired' / 'exhausted' here and the customer falls back to the Free
 *  plan (free daily limit) — the admin never has to expire plans by hand. */
function getActiveSubscription(env: Env, userId: number): SubscriptionRow | null {
  const sub = env.store.getLatestActiveSubscription(userId);
  if (!sub) return null;
  const now = Date.now();
  if (sub.expiresAt.getTime() <= now) {
    env.store.updateSubscriptionStatus(sub.id, "expired");
    // The flip happens exactly once (status leaves 'active'), so this
    // notification is created exactly once per expired plan.
    createNotification(env, {
      userId,
      anonId: null,
      type: "plan",
      title: `Your ${sub.planName} plan has expired`,
      message: `Your ${sub.planName} plan ended on ${sub.expiresAt.toLocaleDateString()}. You are now on the Free plan.`,
    });
    return null;
  }
  if (sub.limitUsed >= sub.limitTotal) {
    env.store.updateSubscriptionStatus(sub.id, "exhausted");
    createNotification(env, {
      userId,
      anonId: null,
      type: "plan",
      title: `Your ${sub.planName} plan's downloads are used up`,
      message: `You used all ${sub.limitTotal.toLocaleString()} downloads of your ${sub.planName} plan. You are now on the Free plan.`,
    });
    return null;
  }
  return sub;
}

/** Downloads used today (UTC day) by one account, or by one anonymous
 *  browser id. Counts download_events — a resolve alone does not count. */
function countDownloadsToday(
  env: Env,
  userId: number | null,
  anonId: string | null,
): number {
  const dayStart = utcDayStartMs();
  if (userId !== null) {
    return env.store.countDownloadEventsTodayForUser(userId, dayStart);
  }
  if (anonId) {
    return env.store.countDownloadEventsTodayForAnon(anonId, dayStart);
  }
  return 0;
}

function countUserDownloadsTotal(env: Env, userId: number): number {
  return env.store.countDownloadEventsTotalForUser(userId);
}

/** Assigns a plan to a customer: any running subscription is cancelled
 *  first, then the new one starts now and ends after durationDays (or
 *  when limitTotal downloads are used up — whichever comes first). */
function assignSubscription(
  env: Env,
  userId: number,
  plan: PlanRow,
  durationDays: number,
  downloadLimit: number,
): void {
  env.store.cancelActiveSubscriptions(userId);
  const now = Date.now();
  env.store.insertSubscription({
    userId,
    planId: plan.id,
    planName: plan.name,
    priceCents: plan.priceCents,
    durationDays,
    limitTotal: downloadLimit,
    startsAt: new Date(now),
    expiresAt: new Date(now + durationDays * 24 * 3600 * 1000),
  });
  createNotification(env, {
    userId,
    anonId: null,
    type: "plan",
    title: `Your ${plan.name} plan is now active`,
    message: `Your ${plan.name} plan is active — ${downloadLimit.toLocaleString()} downloads for ${durationDays} days.`,
  });
}

function utcDayStartMs(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Quality label for a video URL, mirroring resolver.ts: the resolution
 *  found in the URL, or "Original quality" when none is there. Used as
 *  the favourite's snapshot label when the client passes none. */
function qualityLabel(url: string, isOrigin: boolean): string {
  const res = url.match(/(2160|1440|1080|720|540|480|360)p?/i)?.[1] ?? null;
  const base = res ? `${res}p` : "Original quality";
  return isOrigin ? `${base} · Origin (No Watermark)` : base;
}

// ---------------------------------------------------------------------------
// Phase 2 — notifications. Created ONLY by real server events (payment
// received, plan activated/expired/exhausted, daily limit reached).
// ---------------------------------------------------------------------------

type NotificationType = "payment" | "plan" | "limit";

/** Owner key shared by favourites and notifications: one text key per
 *  account ("user:<id>") or anonymous browser ("anon:<browser id>") so
 *  the same scoping works for logged-in and anonymous visitors. */
function ownerKeyFor(
  userId: number | null | undefined,
  anonId: string | null | undefined,
): string | null {
  if (userId !== null && userId !== undefined) return `user:${userId}`;
  if (anonId) return `anon:${anonId}`;
  return null;
}

function createNotification(
  env: Env,
  opts: {
    userId: number | null | undefined;
    anonId: string | null | undefined;
    type: NotificationType;
    title: string;
    message: string;
  },
): void {
  const ownerKey = ownerKeyFor(opts.userId, opts.anonId);
  if (!ownerKey) return;
  env.store.insertNotification({
    userId: opts.userId ?? null,
    anonId: opts.userId ? null : (opts.anonId ?? null),
    ownerKey,
    type: opts.type,
    title: opts.title,
    message: opts.message,
  });
}

/** Free-daily-limit notification, at most one per owner per UTC day. */
function maybeNotifyLimitReached(
  env: Env,
  userId: number | null,
  anonId: string | null,
  freeLimit: number,
): void {
  const ownerKey = ownerKeyFor(userId, anonId);
  if (!ownerKey) return;
  const dayStart = utcDayStartMs();
  if (env.store.hasLimitNotificationToday(ownerKey, dayStart)) return;
  createNotification(env, {
    userId,
    anonId,
    type: "limit",
    title: "Daily free limit reached",
    message: `You have used your ${freeLimit} free downloads for today. See the Plans page to download more.`,
  });
}

type QualityPref = "best" | "original" | "720p" | "480p" | "360p";
type DownloadModePref = "single" | "bulk";
const QUALITY_PREFS: readonly string[] = [
  "best",
  "original",
  "720p",
  "480p",
  "360p",
];

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
  downloadId: number | null;
};

async function resolveLink(env: Env, args: unknown): Promise<ResolveResponse> {
  const text = reqString(args, "text", 4000);
  // Who fetched this — a logged-in account, or an anonymous browser
  // (anonId the client stores in localStorage). Used only to attribute
  // the history entry; resolving itself is public.
  const me = authUser(env, optToken(args));
  const ownerId = me?.id ?? null;
  const ownerAnon = me ? null : (optString(args, "anonId", 100) || null);
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
        downloadId: null,
      };
    }
    return {
      ok: false, sourceUrl: "", title: "", coverUrl: null, videos: [], images: [],
      usedCustomApi: false, note: null,
      error:
        "No link was found. Paste Jimeng's FULL share text (together with the Chinese text) — the link will be extracted from it automatically.",
      downloadId: null,
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
        let downloadId: number | null = null;
        if (first) {
          downloadId = env.store.insertDownload({
            sourceUrl: shareUrl,
            title: viaApi.title,
            videoUrl: first.url,
            coverUrl: viaApi.coverUrl,
            userId: ownerId,
            anonId: ownerAnon,
          });
        }
        return {
          ok: true, sourceUrl: shareUrl, title: viaApi.title,
          coverUrl: viaApi.coverUrl, videos: viaApi.videos, images: viaApi.images,
          usedCustomApi: true, note: "The video was fetched using your saved API key.", error: null,
          downloadId,
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
    let downloadId: number | null = null;
    if (first) {
      downloadId = env.store.insertDownload({
        sourceUrl: shareUrl,
        title: result.title,
        videoUrl: first.url,
        coverUrl: result.coverUrl,
        userId: ownerId,
        anonId: ownerAnon,
      });
    }
    return {
      ok: true, sourceUrl: result.sourceUrl, title: result.title,
      coverUrl: result.coverUrl, videos: result.videos, images: result.images,
      usedCustomApi: false, note, error: null,
      downloadId,
    };
  }
  return {
    ok: false, sourceUrl: result.sourceUrl, title: "", coverUrl: null,
    videos: [], images: [], usedCustomApi: false, note: note ?? avatarNote, error: result.error,
    downloadId: null,
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
  limitReached: boolean;
}> {
  const url = reqString(args, "url", 4000);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "The file link is not valid.", limitReached: false };
  }
  if (parsed.protocol !== "https:" || !isDownloadableHost(parsed.hostname)) {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: "This file is not on Jimeng's CDN, so the download could not be prepared on the server.",
      limitReached: false,
    };
  }

  // --- Limits (checked BEFORE any file is fetched) -------------------
  // Suspended customers cannot download at all (server-enforced).
  if (isSuspendedUser(env, optToken(args))) {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: "Your account is suspended, so downloads are blocked. Contact the site owner for help.",
      limitReached: false,
    };
  }
  const me = authUser(env, optToken(args));
  const sub = me ? getActiveSubscription(env, me.id) : null;
  if (!sub) {
    // No running plan → free daily limit (0 = unlimited).
    const freeLimit = getFreeDailyLimit(env);
    if (freeLimit > 0) {
      const used = countDownloadsToday(
        env,
        me?.id ?? null,
        me ? null : (optString(args, "anonId", 100) || null),
      );
      if (used >= freeLimit) {
        maybeNotifyLimitReached(
          env,
          me?.id ?? null,
          me ? null : (optString(args, "anonId", 100) || null),
          freeLimit,
        );
        return {
          ok: false, downloadUrl: null, sizeBytes: 0,
          error: `You have used your ${freeLimit} free downloads for today. See the Plans page to download more.`,
          limitReached: true,
        };
      }
    }
  }

  // One successful download = one event (and one plan-quota use when a
  // plan is running). Cached files count too — re-downloading a file
  // still uses a download.
  const logDownload = (sizeBytes: number): void => {
    env.store.insertDownloadEvent({
      userId: me?.id ?? null,
      anonId: me ? null : (optString(args, "anonId", 100) || null),
      sizeBytes,
    });
    if (sub) {
      env.store.incrementSubscriptionUsed(sub.id, sub.limitUsed + 1);
    }
  };

  const key = blobKeyForUrl(url);
  const cached = env.files.existing(key);
  if (cached) {
    logDownload(cached.sizeBytes);
    return {
      ok: true,
      downloadUrl: `./blobs/${key}`,
      sizeBytes: cached.sizeBytes,
      error: null,
      limitReached: false,
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
      limitReached: false,
    };
  }
  if (!res.ok) {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: `Jimeng's CDN refused to serve the file (HTTP ${res.status}) — the link may have expired. Fetch the video again and then download it.`,
      limitReached: false,
    };
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > 300_000_000) {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "The file is too large (over 300 MB) and cannot be prepared for download on the server.", limitReached: false };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "An empty file was received from the CDN — please try again.", limitReached: false };
  }
  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ||
    "application/octet-stream";
  const stored = await env.files.store(key, bytes, contentType);
  logDownload(bytes.byteLength);
  return {
    ok: true,
    downloadUrl: `./blobs/${key}`,
    sizeBytes: stored.sizeBytes,
    error: null,
    limitReached: false,
  };
}

function getSettings(env: Env, args: unknown): {
  apiKeyHint: string | null;
  hasApiKey: boolean;
  apiBaseUrl: string | null;
  adSlots: Record<AdSlot, boolean>;
} {
  // The API-key hint and base URL are returned only to the admin — regular
  // visitors get nulls. The ad-slot booleans drive the public placeholders.
  const isAdmin = authAdmin(env, optToken(args)) !== null;
  const apiKey = isAdmin ? env.store.getSetting("api_key") : null;
  const adSlots = {} as Record<AdSlot, boolean>;
  for (const slot of AD_SLOTS) {
    adSlots[slot] = Boolean(env.store.getSetting(`adsense_${slot}`));
  }
  return {
    apiKeyHint: isAdmin ? keyHint(apiKey) : null,
    hasApiKey: isAdmin ? Boolean(apiKey) : false,
    apiBaseUrl: isAdmin ? env.store.getSetting("api_base_url") : null,
    adSlots,
  };
}

function saveApiKey(env: Env, args: unknown): { ok: true; hint: string } {
  requireAdmin(env, args);
  const key = reqString(args, "apiKey", 500).trim();
  if (key.length < 4) throw new HandlerError(400, "API key must be at least 4 characters");
  env.store.setSetting("api_key", key);
  const base = optString(args, "apiBaseUrl", 500).trim();
  if (base) env.store.setSetting("api_base_url", base);
  else env.store.deleteSetting("api_base_url");
  return { ok: true as const, hint: keyHint(key) ?? "" };
}

function clearApiKey(env: Env, args: unknown): { ok: true } {
  requireAdmin(env, args);
  env.store.deleteSetting("api_key");
  env.store.deleteSetting("api_base_url");
  return { ok: true as const };
}

function saveAdCode(env: Env, args: unknown): { ok: true } {
  requireAdmin(env, args);
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
  requireAdmin(env, args);
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
  // A logged-in customer sees only their own downloads; an anonymous
  // visitor sees their own browser's downloads plus older unattributed
  // entries; the admin sees everything.
  const me = authUser(env, optToken(args));
  let rows;
  if (me?.role === "admin") {
    rows = env.store.listDownloads(limit);
  } else if (me) {
    rows = env.store.listDownloadsForUser(me.id, limit);
  } else {
    const anonId = optString(args, "anonId", 100);
    rows = anonId
      ? env.store.listDownloadsForAnon(anonId, limit)
      : env.store.listDownloads(limit);
  }
  return {
    items: rows.map((r) => ({
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
  env.store.deleteFavoritesForDownload(id);
  env.store.deleteDownload(id);
  return { ok: true as const };
}

function clearHistory(env: Env): { ok: true } {
  env.store.deleteAllFavorites();
  env.store.clearDownloads();
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Admin actions — login is admin-only. There is no user registration:
// downloads are public and need no account.
// ---------------------------------------------------------------------------

async function adminLogin(
  env: Env,
  args: unknown,
): Promise<{
  ok: boolean;
  token: string | null;
  error: string | null;
  admin: { id: number; name: string; email: string; role: string } | null;
}> {
  seedAdmin(env);
  const email = reqString(args, "email", 200).trim().toLowerCase();
  const password = reqString(args, "password", 200);
  const u = env.store.getUserByEmail(email);
  // Same message for unknown email, wrong password and non-admin accounts —
  // never reveal which one failed.
  if (!u || u.role !== "admin" || !(await verifyPassword(password, u.passwordHash))) {
    return { ok: false, token: null, error: "Incorrect email or password.", admin: null };
  }
  if (u.status !== "active") {
    return { ok: false, token: null, error: "This account is disabled. Contact the site owner.", admin: null };
  }
  const token = createSession(env, u.id);
  env.store.updateUserLastLogin(u.id);
  return {
    ok: true,
    token,
    error: null,
    admin: { id: u.id, name: u.name, email: u.email, role: "admin" },
  };
}

function adminLogout(env: Env, args: unknown): { ok: true } {
  const token = optToken(args);
  if (token) env.store.deleteSession(token);
  return { ok: true as const };
}

function adminMe(
  env: Env,
  args: unknown,
): {
  ok: boolean;
  admin: { id: number; name: string; email: string; role: string } | null;
} {
  const me = authAdmin(env, optToken(args));
  if (!me) return { ok: false, admin: null };
  return { ok: true, admin: { id: me.id, name: me.name, email: me.email, role: "admin" } };
}

function adminStats(env: Env, args: unknown): {
  downloadsToday: number;
  downloadsTotal: number;
  storageBytes: number;
  totalCustomers: number;
  freeUsers: number;
  subscribedUsers: number;
  plansSold: number;
  totalRevenueCents: number;
  totalTransactions: number;
  mbToday: number;
  mbTotal: number;
  recentDownloads: {
    id: number;
    title: string;
    sourceUrl: string;
    createdAt: string;
  }[];
  recentPayments: {
    id: number;
    customerName: string;
    planName: string;
    amountCents: number;
    createdAt: string;
  }[];
  recentSignups: {
    id: number;
    name: string;
    email: string;
    createdAt: string;
  }[];
  last7Days: { date: string; downloads: number }[];
} {
  requireAdmin(env, args);
  const dayStart = utcDayStartMs();
  const eventsToday = env.store.countDownloadEventsSince(dayStart);
  const eventsTotal = env.store.countDownloadEventsTotal();
  const mbToday = Math.round(env.store.sumDownloadEventsBytesSince(dayStart) / 1_000_000);
  const mbTotal = Math.round(env.store.sumDownloadEventsBytesTotal() / 1_000_000);
  const allUsers = env.store.listUsersByRole("user");
  const allPayments = env.store.listPayments();
  const recentPaymentsRows = allPayments.slice(0, 5);
  // Subscribed = customers with a currently usable subscription (this
  // also flips expired/exhausted ones to their final status).
  let subscribedUsers = 0;
  for (const u of allUsers) {
    if (getActiveSubscription(env, u.id)) subscribedUsers++;
  }
  const totalCustomers = allUsers.length;
  // Downloads per UTC day for the last 7 days (missing days = 0).
  const weekAgo = utcDayStartMs(Date.now() - 6 * 24 * 3600 * 1000);
  const byDay = new Map(
    env.store.downloadEventsByDay(weekAgo).map((r) => [r.day, r.n]),
  );
  const last7Days: { date: string; downloads: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(utcDayStartMs(Date.now() - i * 24 * 3600 * 1000));
    const key = d.toISOString().slice(0, 10);
    last7Days.push({ date: key, downloads: byDay.get(key) ?? 0 });
  }
  const recentSignups = allUsers.slice(0, 5).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt.toISOString(),
  }));
  return {
    downloadsToday: eventsToday,
    downloadsTotal: eventsTotal,
    storageBytes: env.files.totalBytes(),
    totalCustomers,
    freeUsers: totalCustomers - subscribedUsers,
    subscribedUsers,
    plansSold: env.store.countPaidOrActivatedRequests(),
    totalRevenueCents: allPayments.reduce((sum, p) => sum + p.amountCents, 0),
    totalTransactions: allPayments.length,
    mbToday,
    mbTotal,
    recentDownloads: env.store.recentDownloads(10).map((r) => ({
      id: r.id,
      title: r.title,
      sourceUrl: r.sourceUrl,
      createdAt: r.createdAt.toISOString(),
    })),
    recentPayments: recentPaymentsRows.map((p) => ({
      id: p.id,
      customerName: p.customerName,
      planName: p.planName,
      amountCents: p.amountCents,
      createdAt: p.createdAt.toISOString(),
    })),
    recentSignups,
    last7Days,
  };
}

async function adminChangePassword(
  env: Env,
  args: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const admin = requireAdmin(env, args);
  const currentPassword = reqString(args, "currentPassword", 200);
  const newPassword = reqString(args, "newPassword", 200);
  if (newPassword.length < 8) {
    return { ok: false, error: "The new password must be at least 8 characters." };
  }
  const u = env.store.getUserById(admin.id);
  if (!u || !(await verifyPassword(currentPassword, u.passwordHash))) {
    return { ok: false, error: "The current password is incorrect." };
  }
  env.store.updateUserPassword(admin.id, await hashPassword(newPassword));
  // Sign out the admin's OTHER sessions so the old password stops working
  // everywhere else — the current session stays logged in.
  env.store.deleteSessionsForUserExcept(admin.id, optToken(args));
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Customer accounts, plans, subscriptions and payments.
// ---------------------------------------------------------------------------

async function register(
  env: Env,
  args: unknown,
): Promise<{
  ok: boolean;
  token: string | null;
  error: string | null;
  user: { id: number; name: string; email: string; role: string } | null;
}> {
  seedAdmin(env);
  const name = reqString(args, "name", 120).trim();
  const email = reqEmail(args, "email");
  const password = reqString(args, "password", 200);
  if (password.length < 8) {
    return { ok: false, token: null, error: "The password must be at least 8 characters.", user: null };
  }
  // The admin email is reserved — it can never be registered as a
  // customer account. Same message as the duplicate check below, so
  // nothing leaks about which addresses exist.
  if (email === ADMIN_EMAIL) {
    return { ok: false, token: null, error: "An account with this email already exists. Try logging in instead.", user: null };
  }
  if (env.store.getUserByEmail(email)) {
    return { ok: false, token: null, error: "An account with this email already exists. Try logging in instead.", user: null };
  }
  const id = env.store.insertUser({
    name,
    email,
    passwordHash: await hashPassword(password),
    role: "user",
    status: "active",
  });
  const token = createSession(env, id);
  return {
    ok: true,
    token,
    error: null,
    user: { id, name, email, role: "user" },
  };
}

async function userLogin(
  env: Env,
  args: unknown,
): Promise<{
  ok: boolean;
  token: string | null;
  error: string | null;
  user: { id: number; name: string; email: string; role: string } | null;
}> {
  seedAdmin(env);
  const email = reqEmail(args, "email");
  const password = reqString(args, "password", 200);
  const u = env.store.getUserByEmail(email);
  // Same message for unknown email, wrong password and non-customer
  // accounts — never reveal which one failed.
  if (!u || u.role !== "user" || !(await verifyPassword(password, u.passwordHash))) {
    return { ok: false, token: null, error: "Incorrect email or password.", user: null };
  }
  if (u.status !== "active") {
    return { ok: false, token: null, error: "Your account is suspended. Contact the site owner for help.", user: null };
  }
  const token = createSession(env, u.id);
  env.store.updateUserLastLogin(u.id);
  return {
    ok: true,
    token,
    error: null,
    user: { id: u.id, name: u.name, email: u.email, role: "user" },
  };
}

// ---------------------------------------------------------------------------
// Unified login — the single login form for everyone. The admin account is
// checked first (admin email + bcrypt password); a match returns role
// "admin" and the admin session token, which opens the Admin Panel
// directly. Otherwise the customer account is checked and role "customer"
// is returned. All failures use the same generic message so nothing leaks
// about which accounts exist.
// ---------------------------------------------------------------------------
async function login(
  env: Env,
  args: unknown,
): Promise<{
  ok: boolean;
  role: "admin" | "customer" | null;
  token: string | null;
  error: string | null;
  admin: { id: number; name: string; email: string; role: string } | null;
  user: { id: number; name: string; email: string; role: string } | null;
}> {
  seedAdmin(env);
  const email = reqEmail(args, "email");
  const password = reqString(args, "password", 200);
  const u = env.store.getUserByEmail(email);
  if (!u || !(await verifyPassword(password, u.passwordHash))) {
    return { ok: false, role: null, token: null, error: "Incorrect email or password.", admin: null, user: null };
  }
  if (u.status !== "active") {
    return {
      ok: false,
      role: null,
      token: null,
      error: u.role === "admin"
        ? "This account is disabled. Contact the site owner."
        : "Your account is suspended. Contact the site owner for help.",
      admin: null,
      user: null,
    };
  }
  const token = createSession(env, u.id);
  env.store.updateUserLastLogin(u.id);
  if (u.role === "admin") {
    return {
      ok: true,
      role: "admin" as const,
      token,
      error: null,
      admin: { id: u.id, name: u.name, email: u.email, role: "admin" },
      user: null,
    };
  }
  return {
    ok: true,
    role: "customer" as const,
    token,
    error: null,
    admin: null,
    user: { id: u.id, name: u.name, email: u.email, role: "user" },
  };
}

function me(env: Env, args: unknown): {
  ok: boolean;
  user: { id: number; name: string; email: string; role: string } | null;
  plan: {
    id: number;
    planId: number;
    planName: string;
    priceCents: number;
    durationDays: number;
    limitTotal: number;
    limitUsed: number;
    remaining: number;
    startsAt: string;
    expiresAt: string;
    status: string;
  } | null;
  downloadsToday: number;
  downloadsTotal: number;
  freeDailyLimit: number;
  freeRemaining: number;
  joinedAt: string | null;
} {
  const user = authUser(env, optToken(args));
  const freeLimit = getFreeDailyLimit(env);
  if (!user) {
    return {
      ok: false, user: null, plan: null,
      downloadsToday: 0, downloadsTotal: 0,
      freeDailyLimit: freeLimit, freeRemaining: 0,
      joinedAt: null,
    };
  }
  const sub = getActiveSubscription(env, user.id);
  const today = countDownloadsToday(env, user.id, null);
  const total = countUserDownloadsTotal(env, user.id);
  return {
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    plan: sub
      ? {
          id: sub.id,
          planId: sub.planId,
          planName: sub.planName,
          priceCents: sub.priceCents,
          durationDays: sub.durationDays,
          limitTotal: sub.limitTotal,
          limitUsed: sub.limitUsed,
          remaining: Math.max(0, sub.limitTotal - sub.limitUsed),
          startsAt: sub.startsAt.toISOString(),
          expiresAt: sub.expiresAt.toISOString(),
          status: sub.status,
        }
      : null,
    downloadsToday: today,
    downloadsTotal: total,
    freeDailyLimit: freeLimit,
    freeRemaining: sub ? 0 : freeLimit === 0 ? -1 : Math.max(0, freeLimit - today),
    joinedAt: env.store.getUserById(user.id)?.createdAt.toISOString() ?? null,
  };
}

function logout(env: Env, args: unknown): { ok: true } {
  const token = optToken(args);
  if (token) env.store.deleteSession(token);
  return { ok: true as const };
}

function myRequests(env: Env, args: unknown): {
  requests: {
    id: number;
    planId: number;
    planName: string;
    priceCents: number;
    status: string;
    createdAt: string;
  }[];
} {
  const user = requireUser(env, args);
  return {
    requests: env.store.listPurchaseRequestsForUser(user.id).map((r) => ({
      id: r.id,
      planId: r.planId,
      planName: r.planName,
      priceCents: r.priceCents,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function listPlans(env: Env): {
  plans: {
    id: number;
    name: string;
    priceCents: number;
    durationDays: number;
    downloadLimit: number;
    description: string;
  }[];
} {
  ensureDefaultPlans(env);
  return {
    plans: env.store.listPlans(true).map((p) => ({
      id: p.id,
      name: p.name,
      priceCents: p.priceCents,
      durationDays: p.durationDays,
      downloadLimit: p.downloadLimit,
      description: p.description,
    })),
  };
}

function listAdminPlans(env: Env, args: unknown): {
  plans: {
    id: number;
    name: string;
    priceCents: number;
    durationDays: number;
    downloadLimit: number;
    description: string;
    active: boolean;
    createdAt: string;
  }[];
} {
  requireAdmin(env, args);
  ensureDefaultPlans(env);
  return {
    plans: env.store.listPlans(false).map((p) => ({
      id: p.id,
      name: p.name,
      priceCents: p.priceCents,
      durationDays: p.durationDays,
      downloadLimit: p.downloadLimit,
      description: p.description,
      active: p.active,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

function createPlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null; id: number | null } {
  requireAdmin(env, args);
  const name = reqString(args, "name", 120).trim();
  const priceCents = reqIntRange(args, "priceCents", 0, 100000000);
  const durationDays = reqIntRange(args, "durationDays", 1, 3650);
  const downloadLimit = reqIntRange(args, "downloadLimit", 1, 1000000);
  const description = optString(args, "description", 500).trim();
  const id = env.store.insertPlan({
    name,
    priceCents,
    durationDays,
    downloadLimit,
    description,
  });
  return { ok: true, error: null, id };
}

function updatePlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  requireAdmin(env, args);
  const id = reqInt(args, "id");
  const rec = asRecord(args);
  const patch: {
    name?: string;
    priceCents?: number;
    durationDays?: number;
    downloadLimit?: number;
    description?: string;
    active?: boolean;
  } = {};
  if (rec?.name !== undefined) patch.name = reqString(args, "name", 120).trim();
  if (rec?.priceCents !== undefined) {
    patch.priceCents = reqIntRange(args, "priceCents", 0, 100000000);
  }
  if (rec?.durationDays !== undefined) {
    patch.durationDays = reqIntRange(args, "durationDays", 1, 3650);
  }
  if (rec?.downloadLimit !== undefined) {
    patch.downloadLimit = reqIntRange(args, "downloadLimit", 1, 1000000);
  }
  if (rec?.description !== undefined) {
    patch.description = optString(args, "description", 500).trim();
  }
  if (rec?.active !== undefined) {
    if (typeof rec.active !== "boolean") {
      throw new HandlerError(400, "active must be a boolean");
    }
    patch.active = rec.active;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Nothing to change." };
  }
  env.store.updatePlan(id, patch);
  return { ok: true, error: null };
}

function createPurchaseRequest(
  env: Env,
  args: unknown,
): {
  ok: boolean;
  error: string | null;
  request: {
    id: number;
    planName: string;
    priceCents: number;
    status: string;
  } | null;
  duplicate: boolean;
} {
  const user = requireUser(env, args);
  if (user.role !== "user") {
    return { ok: false, error: "The admin account cannot buy a plan.", request: null, duplicate: false };
  }
  ensureDefaultPlans(env);
  const planId = reqInt(args, "planId");
  const plan = env.store.getPlanById(planId);
  if (!plan || !plan.active) {
    return { ok: false, error: "This plan is not available.", request: null, duplicate: false };
  }
  // One pending request per customer per plan is enough — return the
  // existing one instead of piling up duplicates.
  const existing = env.store.findPendingRequest(user.id, plan.id);
  if (existing) {
    return {
      ok: true, error: null,
      request: { id: existing.id, planName: existing.planName, priceCents: existing.priceCents, status: existing.status },
      duplicate: true,
    };
  }
  const id = env.store.insertPurchaseRequest({
    userId: user.id,
    planId: plan.id,
    planName: plan.name,
    priceCents: plan.priceCents,
  });
  return {
    ok: true, error: null,
    request: { id, planName: plan.name, priceCents: plan.priceCents, status: "pending" },
    duplicate: false,
  };
}

function listPurchaseRequests(env: Env, args: unknown): {
  requests: {
    id: number;
    userId: number;
    customerName: string;
    customerEmail: string;
    planId: number;
    planName: string;
    priceCents: number;
    status: string;
    createdAt: string;
    decidedAt: string | null;
  }[];
} {
  requireAdmin(env, args);
  return {
    requests: env.store.listPurchaseRequests().map((r) => {
      const u = env.store.getUserById(r.userId);
      return {
        id: r.id,
        userId: r.userId,
        customerName: u?.name ?? "Deleted account",
        customerEmail: u?.email ?? "",
        planId: r.planId,
        planName: r.planName,
        priceCents: r.priceCents,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
      };
    }),
  };
}

function listPayments(env: Env, args: unknown): {
  payments: {
    id: number;
    customerName: string;
    customerEmail: string;
    planName: string;
    amountCents: number;
    method: string;
    note: string;
    createdAt: string;
    purchaseRequestId: number | null;
  }[];
  totalRevenueCents: number;
  totalTransactions: number;
} {
  requireAdmin(env, args);
  const rows = env.store.listPayments();
  return {
    payments: rows.map((p) => ({
      id: p.id,
      customerName: p.customerName,
      customerEmail: p.customerEmail,
      planName: p.planName,
      amountCents: p.amountCents,
      method: p.method,
      note: p.note,
      createdAt: p.createdAt.toISOString(),
      purchaseRequestId: p.purchaseRequestId,
    })),
    totalRevenueCents: rows.reduce((sum, p) => sum + p.amountCents, 0),
    totalTransactions: rows.length,
  };
}

function recordPayment(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null; id: number | null } {
  requireAdmin(env, args);
  const userId = reqInt(args, "userId");
  const planId = optIntRange(args, "planId", 1, 100000000);
  const amountCents = reqIntRange(args, "amountCents", 1, 100000000);
  const method = reqString(args, "method", 100).trim();
  const note = optString(args, "note", 500).trim();
  const user = env.store.getUserById(userId);
  if (!user || user.role !== "user") {
    return { ok: false, error: "Customer not found.", id: null };
  }
  let planName = "Manual payment";
  if (planId) {
    const plan = env.store.getPlanById(planId);
    if (plan) planName = plan.name;
  }
  const id = env.store.insertPayment({
    userId: user.id,
    purchaseRequestId: null,
    customerName: user.name,
    customerEmail: user.email,
    planName,
    amountCents,
    method,
    note,
  });
  return { ok: true, error: null, id };
}

function markPaid(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  requireAdmin(env, args);
  const requestId = reqInt(args, "requestId");
  const amountCents = optIntRange(args, "amountCents", 1, 100000000);
  const method = optString(args, "method", 100).trim() || "Manual";
  const note = optString(args, "note", 500).trim();
  const req = env.store.getPurchaseRequestById(requestId);
  if (!req) return { ok: false, error: "Purchase request not found." };
  if (req.status !== "pending") {
    return { ok: false, error: `This request is already ${req.status}.` };
  }
  const user = env.store.getUserById(req.userId);
  if (!user) return { ok: false, error: "The customer account no longer exists." };
  const amount = amountCents ?? req.priceCents;
  env.store.insertPayment({
    userId: user.id,
    purchaseRequestId: req.id,
    customerName: user.name,
    customerEmail: user.email,
    planName: req.planName,
    amountCents: amount,
    method,
    note,
  });
  env.store.updatePurchaseRequestStatus(req.id, "paid");
  createNotification(env, {
    userId: user.id,
    anonId: null,
    type: "payment",
    title: `Payment received for the ${req.planName} plan`,
    message: `Your payment of $${(amount / 100).toFixed(2)} for the ${req.planName} plan was received. The admin will activate your plan shortly.`,
  });
  return { ok: true, error: null };
}

function activatePlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  requireAdmin(env, args);
  const requestId = reqInt(args, "requestId");
  const durationDays = optIntRange(args, "durationDays", 1, 3650);
  const downloadLimit = optIntRange(args, "downloadLimit", 1, 1000000);
  const req = env.store.getPurchaseRequestById(requestId);
  if (!req) return { ok: false, error: "Purchase request not found." };
  if (req.status !== "paid") {
    return { ok: false, error: "Mark this request as paid first — only paid requests can be activated." };
  }
  const plan = env.store.getPlanById(req.planId);
  if (!plan) return { ok: false, error: "The plan no longer exists." };
  const user = env.store.getUserById(req.userId);
  if (!user || user.role !== "user") {
    return { ok: false, error: "The customer account no longer exists." };
  }
  assignSubscription(
    env,
    user.id,
    plan,
    durationDays ?? plan.durationDays,
    downloadLimit ?? plan.downloadLimit,
  );
  env.store.updatePurchaseRequestStatus(req.id, "activated");
  return { ok: true, error: null };
}

function assignPlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  requireAdmin(env, args);
  ensureDefaultPlans(env);
  const userId = reqInt(args, "userId");
  const planId = reqInt(args, "planId");
  const durationDays = optIntRange(args, "durationDays", 1, 3650);
  const downloadLimit = optIntRange(args, "downloadLimit", 1, 1000000);
  const user = env.store.getUserById(userId);
  if (!user || user.role !== "user") {
    return { ok: false, error: "Customer not found." };
  }
  const plan = env.store.getPlanById(planId);
  if (!plan) return { ok: false, error: "Plan not found." };
  assignSubscription(
    env,
    user.id,
    plan,
    durationDays ?? plan.durationDays,
    downloadLimit ?? plan.downloadLimit,
  );
  return { ok: true, error: null };
}

function listCustomers(env: Env, args: unknown): {
  customers: {
    id: number;
    name: string;
    email: string;
    status: string;
    joinedAt: string;
    downloadsToday: number;
    downloadsTotal: number;
    plan: {
      id: number;
      planName: string;
      limitTotal: number;
      limitUsed: number;
      remaining: number;
      expiresAt: string;
      status: string;
    } | null;
  }[];
} {
  requireAdmin(env, args);
  return {
    customers: env.store.listUsersByRole("user").map((u) => {
      const sub = getActiveSubscription(env, u.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        joinedAt: u.createdAt.toISOString(),
        downloadsToday: countDownloadsToday(env, u.id, null),
        downloadsTotal: countUserDownloadsTotal(env, u.id),
        plan: sub
          ? {
              id: sub.id,
              planName: sub.planName,
              limitTotal: sub.limitTotal,
              limitUsed: sub.limitUsed,
              remaining: Math.max(0, sub.limitTotal - sub.limitUsed),
              expiresAt: sub.expiresAt.toISOString(),
              status: sub.status,
            }
          : null,
      };
    }),
  };
}

function setUserStatus(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  requireAdmin(env, args);
  const userId = reqInt(args, "userId");
  const rec = asRecord(args);
  const status = rec?.status;
  if (status !== "active" && status !== "disabled") {
    throw new HandlerError(400, 'status must be "active" or "disabled"');
  }
  const user = env.store.getUserById(userId);
  if (!user || user.role !== "user") {
    return { ok: false, error: "Customer not found." };
  }
  env.store.updateUserStatus(userId, status);
  // Sessions are deliberately KEPT on suspend: the suspended user's
  // token must still identify them, so prepareDownload can block
  // their downloads with a clear "suspended" message. (The account
  // itself can do nothing while disabled — authUser rejects it for
  // every account action.) If sessions were deleted instead, the
  // caller would look anonymous and the public downloader would
  // just let them through.
  return { ok: true, error: null };
}

function deleteUser(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  requireAdmin(env, args);
  const userId = reqInt(args, "userId");
  const user = env.store.getUserById(userId);
  if (!user || user.role !== "user") {
    return { ok: false, error: "Customer not found." };
  }
  env.store.deleteSessionsForUser(userId);
  env.store.deleteSubscriptionsForUser(userId);
  env.store.deletePurchaseRequestsForUser(userId);
  env.store.deleteFavoritesForUser(userId);
  env.store.deleteNotificationsForUser(userId);
  env.store.deleteUserSettings(userId);
  env.store.deleteUserById(userId);
  // Recorded payments are KEPT (they carry the customer name/email) so
  // revenue history stays correct.
  return { ok: true, error: null };
}

function getAdminSettings(env: Env, args: unknown): {
  freeDailyLimit: number;
  adminEmail: string;
} {
  const admin = requireAdmin(env, args);
  return {
    freeDailyLimit: getFreeDailyLimit(env),
    adminEmail: admin.email,
  };
}

function saveAdminSettings(env: Env, args: unknown): { ok: true } {
  requireAdmin(env, args);
  const freeDailyLimit = reqIntRange(args, "freeDailyLimit", 0, 1000);
  env.store.setSetting("free_daily_limit", String(freeDailyLimit));
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

// ---------------------------------------------------------------------------
// Phase 2 — favourites, profile, download settings, notifications.
// ---------------------------------------------------------------------------

function toggleFavorite(
  env: Env,
  args: unknown,
): { ok: boolean; favorited: boolean; error: string | null } {
  const downloadId = reqInt(args, "downloadId");
  const label = optString(args, "label", 200).trim();
  const me = authUser(env, optToken(args));
  const userId = me?.id ?? null;
  const anonId = me ? null : (optString(args, "anonId", 100) || null);
  const ownerKey = ownerKeyFor(userId, anonId);
  if (!ownerKey) {
    return { ok: false, favorited: false, error: "Could not identify this browser — please try again." };
  }
  const existing = env.store.findFavorite(ownerKey, downloadId);
  if (existing) {
    env.store.deleteFavoriteById(existing.id, ownerKey);
    return { ok: true, favorited: false, error: null };
  }
  const row = env.store.getDownloadById(downloadId);
  // Only the owner's own history rows (or old unattributed rows, which
  // are visible to everyone) can be favourited.
  const ownsRow =
    !!row &&
    ((userId !== null && row.userId === userId) ||
      (userId === null && anonId !== null && row.anonId === anonId) ||
      (row.userId === null && row.anonId === null));
  if (!row || !ownsRow) {
    return { ok: false, favorited: false, error: "This video is not in your history." };
  }
  env.store.insertFavorite({
    downloadId: row.id,
    userId,
    anonId,
    ownerKey,
    title: row.title,
    coverUrl: row.coverUrl,
    videoUrl: row.videoUrl,
    qualityLabel: label || qualityLabel(row.videoUrl, true),
    sourceUrl: row.sourceUrl,
  });
  return { ok: true, favorited: true, error: null };
}

function listFavorites(env: Env, args: unknown): {
  items: {
    id: number;
    downloadId: number;
    title: string;
    coverUrl: string | null;
    videoUrl: string;
    qualityLabel: string;
    sourceUrl: string;
    createdAt: string;
  }[];
} {
  const rec = asRecord(args);
  let limit = 50;
  const raw = rec?.limit;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    limit = Math.min(raw, 100);
  }
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { items: [] };
  return {
    items: env.store.listFavorites(ownerKey, limit).map((r) => ({
      id: r.id,
      downloadId: r.downloadId,
      title: r.title,
      coverUrl: r.coverUrl,
      videoUrl: r.videoUrl,
      qualityLabel: r.qualityLabel,
      sourceUrl: r.sourceUrl,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function removeFavorite(env: Env, args: unknown): { ok: true } {
  const id = reqInt(args, "id");
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { ok: true as const };
  env.store.deleteFavoriteById(id, ownerKey);
  return { ok: true as const };
}

function updateProfileName(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const me = requireUser(env, args);
  const name = reqString(args, "name", 100).trim();
  if (!name) return { ok: false, error: "Enter your name." };
  env.store.updateUserName(me.id, name);
  return { ok: true, error: null };
}

async function changeUserPassword(
  env: Env,
  args: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const me = requireUser(env, args);
  const currentPassword = reqString(args, "currentPassword", 200);
  const newPassword = reqString(args, "newPassword", 200);
  if (newPassword.length < 8) {
    return { ok: false, error: "The new password must be at least 8 characters." };
  }
  const u = env.store.getUserById(me.id);
  if (!u || !(await verifyPassword(currentPassword, u.passwordHash))) {
    return { ok: false, error: "The current password is incorrect." };
  }
  env.store.updateUserPassword(me.id, await hashPassword(newPassword));
  env.store.deleteSessionsForUserExcept(me.id, optToken(args));
  return { ok: true, error: null };
}

function getDownloadSettings(
  env: Env,
  args: unknown,
): { defaultQuality: QualityPref; defaultMode: DownloadModePref } {
  const me = authUser(env, optToken(args));
  if (!me) return { defaultQuality: "best", defaultMode: "single" };
  const row = env.store.getUserSettings(me.id);
  return {
    defaultQuality: (row?.defaultQuality ?? "best") as QualityPref,
    defaultMode: (row?.defaultMode ?? "single") as DownloadModePref,
  };
}

function saveDownloadSettings(env: Env, args: unknown): { ok: true } {
  const me = requireUser(env, args);
  const rec = asRecord(args);
  const quality = rec?.defaultQuality;
  const mode = rec?.defaultMode;
  if (typeof quality !== "string" || !QUALITY_PREFS.includes(quality)) {
    throw new HandlerError(
      400,
      "defaultQuality must be one of: best, original, 720p, 480p, 360p",
    );
  }
  if (mode !== "single" && mode !== "bulk") {
    throw new HandlerError(400, 'defaultMode must be "single" or "bulk"');
  }
  env.store.upsertUserSettings(
    me.id,
    quality as QualityPref,
    mode as DownloadModePref,
  );
  return { ok: true as const };
}

function listNotifications(env: Env, args: unknown): {
  items: {
    id: number;
    type: string;
    title: string;
    message: string;
    read: boolean;
    createdAt: string;
  }[];
  unreadCount: number;
} {
  const rec = asRecord(args);
  let limit = 50;
  const raw = rec?.limit;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    limit = Math.min(raw, 100);
  }
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { items: [], unreadCount: 0 };
  const rows = env.store.listNotifications(ownerKey, limit);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      message: r.message,
      read: r.read,
      createdAt: r.createdAt.toISOString(),
    })),
    // Same as the artifact: the unread count is computed over the
    // fetched window (limit 50), not over the whole table.
    unreadCount: rows.filter((r) => !r.read).length,
  };
}

function markNotificationRead(env: Env, args: unknown): { ok: true } {
  const id = reqInt(args, "id");
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { ok: true as const };
  env.store.markNotificationRead(id, ownerKey);
  return { ok: true as const };
}

function markAllNotificationsRead(env: Env, args: unknown): { ok: true } {
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { ok: true as const };
  env.store.markAllNotificationsRead(ownerKey);
  return { ok: true as const };
}

function deleteNotification(env: Env, args: unknown): { ok: true } {
  const id = reqInt(args, "id");
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { ok: true as const };
  env.store.deleteNotification(id, ownerKey);
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
  adminLogin,
  adminLogout,
  adminMe,
  adminStats,
  adminChangePassword,
  register,
  userLogin,
  login,
  me,
  logout,
  myRequests,
  listPlans,
  listAdminPlans,
  createPlan,
  updatePlan,
  createPurchaseRequest,
  listPurchaseRequests,
  listPayments,
  recordPayment,
  markPaid,
  activatePlan,
  assignPlan,
  listCustomers,
  setUserStatus,
  deleteUser,
  getAdminSettings,
  saveAdminSettings,
  toggleFavorite,
  listFavorites,
  removeFavorite,
  updateProfileName,
  changeUserPassword,
  getDownloadSettings,
  saveDownloadSettings,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
};
