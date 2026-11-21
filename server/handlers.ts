// Action handlers — the standalone port of the Hatch-hosted version's
// `Actions` object (server/src/actions.ts). Each handler takes plain JSON
// args and returns plain JSON; server.ts wraps them in the {data} envelope
// the client expects. Validation errors throw HandlerError (400); anything
// else is a 500.
//
// Downloads are PUBLIC: no user accounts, no registration, no login wall.
// Login is admin-only (sidebar → Login → Admin Panel). Every admin action
// checks the session token and the admin role server-side.

import { createHmac, randomBytes } from "node:crypto";
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
  DOUYIN_HOSTS,
  DOUYIN_UA,
  extractCandidateUrls,
  fetchWithTimeout,
  resolveBuiltIn,
  resolveDouyinBuiltIn,
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

const AD_SLOTS = ["head", "top", "incontent", "sidebar", "bottom", "socialbar", "mobile"] as const;
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
// Phase 4 — system logs, login rate limiting, admin two-factor auth.
// ---------------------------------------------------------------------------

/** Records one real admin/system event. Logging never breaks the action
 *  it records: a logging failure is swallowed so the admin's work still
 *  goes through. Rows are NEVER seeded or faked — they only appear for
 *  events that actually happened after the system_logs table existed. */
function logEvent(
  env: Env,
  opts: {
    actorType: "admin" | "user" | "system";
    actorEmail: string | null;
    action: string;
    detail?: string;
  },
): void {
  try {
    env.store.insertSystemLog({
      actorType: opts.actorType,
      actorEmail: opts.actorEmail,
      action: opts.action,
      detail: opts.detail ?? "",
    });
  } catch {
    // Logging must never break the action it records.
  }
}

// Login rate limiting: 5 failed attempts for one email inside a
// 15-minute window locks that email out for 15 minutes. A successful
// login clears the counter. The window/limit are fixed constants —
// there is no test backdoor.

const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function checkLoginLock(
  env: Env,
  email: string,
): { locked: boolean; retryInMinutes: number } {
  const row = env.store.getLoginAttempt(email);
  if (!row) return { locked: false, retryInMinutes: 0 };
  const now = Date.now();
  if (row.lockedUntil && row.lockedUntil.getTime() > now) {
    return {
      locked: true,
      retryInMinutes: Math.max(
        1,
        Math.ceil((row.lockedUntil.getTime() - now) / 60000),
      ),
    };
  }
  // Window expired: the old failures no longer count.
  if (row.firstFailedAt.getTime() + LOGIN_LOCK_WINDOW_MS <= now) {
    env.store.deleteLoginAttempt(email);
  }
  return { locked: false, retryInMinutes: 0 };
}

function recordFailedLogin(env: Env, email: string): void {
  const now = new Date();
  const row = env.store.getLoginAttempt(email);
  if (!row) {
    env.store.upsertLoginAttempt({
      email,
      failedCount: 1,
      firstFailedAt: now,
      lockedUntil: null,
    });
    return;
  }
  // A failure outside the window starts a fresh window.
  const fresh = row.firstFailedAt.getTime() + LOGIN_LOCK_WINDOW_MS <= now.getTime();
  const failedCount = fresh ? 1 : row.failedCount + 1;
  const firstFailedAt = fresh ? now : row.firstFailedAt;
  const lockedUntil =
    failedCount >= LOGIN_MAX_ATTEMPTS
      ? new Date(now.getTime() + LOGIN_LOCK_WINDOW_MS)
      : null;
  env.store.upsertLoginAttempt({ email, failedCount, firstFailedAt, lockedUntil });
  if (lockedUntil) {
    logEvent(env, {
      actorType: "system",
      actorEmail: email,
      action: "security.lockout",
      detail: `${LOGIN_MAX_ATTEMPTS} failed logins in 15 minutes — locked out for 15 minutes.`,
    });
  }
}

function clearFailedLogins(env: Env, email: string): void {
  env.store.deleteLoginAttempt(email);
}

// Admin two-factor auth — TOTP, RFC 6238 (SHA-1, 30-second step,
// 6 digits). Self-contained: no new dependency. The secret is a
// 20-byte random value shown to the admin as base32 (the format
// authenticator apps expect). Customer accounts do not get 2FA.

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 31]!;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 secret.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function totpCodeAt(secret: string, timeMs: number): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", Buffer.from(key)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Accepts the current step plus one step either side (clock skew). */
function verifyTotp(secret: string, code: string): boolean {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    const now = Date.now();
    for (const skew of [-1, 0, 1]) {
      if (totpCodeAt(secret, now + skew * TOTP_STEP_SECONDS * 1000) === clean) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function totpAuthUrl(secret: string, email: string): string {
  const issuer = encodeURIComponent("Jimeng Downloader");
  const account = encodeURIComponent(`Jimeng Downloader:${email}`);
  return `otpauth://totp/${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
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
  // Refresh "last seen" so the admin can tell live sessions apart in
  // Settings → Security. Best-effort: a failure here must never break
  // auth (e.g. the column does not exist yet on an old database).
  try {
    env.store.updateSessionLastSeen(token);
  } catch {
    // Column missing — the Store constructor adds it on the next boot.
  }
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

type NotificationType = "payment" | "plan" | "limit" | "support" | "announcement";

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
  // Douyin: the no-watermark play endpoint lives on aweme.snssdk.com and
  // 302-redirects to the zjcdn.com CDN — both are ByteDance hosts.
  "snssdk.com",
  "zjcdn.com",
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

/** Standalone equivalent of the artifact's ensureSubscriptionSchema:
 *  makes sure the downloads attribution columns (user_id / anon_id) exist
 *  before resolveLink writes a history row. The Store constructor already
 *  adds them at boot; this is belt-and-braces for a database created by an
 *  older build, so a resolve-first request can never crash with
 *  "no column named user_id". Idempotent — the PRAGMA check skips the
 *  ALTER when the column is already there. */
function ensureSubscriptionSchema(env: Env): void {
  const cols = env.store.db.query("PRAGMA table_info(downloads)").all() as {
    name: string;
  }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("user_id")) {
    env.store.db.exec("ALTER TABLE downloads ADD COLUMN user_id INTEGER");
  }
  if (!names.has("anon_id")) {
    env.store.db.exec("ALTER TABLE downloads ADD COLUMN anon_id TEXT");
  }
  if (!names.has("platform")) {
    env.store.db.exec(
      "ALTER TABLE downloads ADD COLUMN platform TEXT NOT NULL DEFAULT 'jimeng'",
    );
  }
}

async function resolveLink(env: Env, args: unknown): Promise<ResolveResponse> {
  ensureSubscriptionSchema(env);
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

// ---------------------------------------------------------------------------
// Douyin resolve — mirrors resolveLink, but for public Douyin share links
// (v.douyin.com short link or douyin.com/video/<id>). The resolver is the
// verified ttwid chain in resolver.ts (anonymous ttwid mint → iesdouyin
// share page → window._ROUTER_DATA → playwm→play swap); the dead
// iteminfo API is never used. History rows are labelled platform "douyin".
// Downloads themselves go through prepareDownload, so the free daily
// limit / plan quota applies exactly as for Jimeng.
// ---------------------------------------------------------------------------

async function resolveDouyinLink(env: Env, args: unknown): Promise<ResolveResponse> {
  ensureSubscriptionSchema(env);
  const text = reqString(args, "text", 4000);
  // Who fetched this — same attribution as resolveLink; resolving
  // itself is public.
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
  const shareUrl = candidates.find((u) => DOUYIN_HOSTS.has(hostOf(u)));
  if (!shareUrl) {
    if (candidates.length > 0) {
      return {
        ok: false, sourceUrl: candidates[0] ?? "", title: "", coverUrl: null,
        videos: [], images: [], usedCustomApi: false, note: null,
        error:
          "A link was found in the pasted text, but it is not a Douyin link. Only public share links from douyin.com or v.douyin.com work here — Jimeng links go in the Jimeng Downloader.",
        downloadId: null,
      };
    }
    return {
      ok: false, sourceUrl: "", title: "", coverUrl: null, videos: [], images: [],
      usedCustomApi: false, note: null,
      error:
        "No link was found. Paste Douyin's full share text — the link will be extracted from it automatically.",
      downloadId: null,
    };
  }

  const result = await resolveDouyinBuiltIn(shareUrl);
  if (result.ok) {
    const first = result.videos[0];
    let downloadId: number | null = null;
    if (first) {
      downloadId = env.store.insertDownload({
        sourceUrl: shareUrl,
        title: result.title,
        videoUrl: first.url,
        coverUrl: result.coverUrl,
        platform: "douyin",
        userId: ownerId,
        anonId: ownerAnon,
      });
    }
    return {
      ok: true, sourceUrl: result.sourceUrl, title: result.title,
      coverUrl: result.coverUrl, videos: result.videos, images: result.images,
      usedCustomApi: false, note: null, error: null,
      downloadId,
    };
  }
  return {
    ok: false, sourceUrl: result.sourceUrl, title: "", coverUrl: null,
    videos: [], images: [], usedCustomApi: false, note: null, error: result.error,
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
      error: "This file is not on a supported CDN (Jimeng / Douyin), so the download could not be prepared on the server.",
      limitReached: false,
    };
  }
  // Douyin files are fetched from the Douyin play endpoint / CDN,
  // which expects the iesdouyin Referer and the iOS UA the resolver
  // used; Jimeng files keep the Jimeng Referer.
  const isDouyinFile =
    parsed.hostname.toLowerCase().endsWith("snssdk.com") ||
    parsed.hostname.toLowerCase().endsWith("zjcdn.com");

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
  // One retry on transient network failures — a dropped connection
  // mid-download was observed on Douyin's CDN (and Douyin files are
  // large: a 1080p tier can be ~98 MB), and a single retry fixed it.
  // An HTTP error status is NOT retried: the CDN answered, and its
  // answer (usually an expired link) will not change in a second.
  const dlHeaders = isDouyinFile
    ? { "User-Agent": DOUYIN_UA, Referer: "https://www.iesdouyin.com/" }
    : { "User-Agent": BROWSER_UA, Referer: "https://jimeng.jianying.com/" };
  let bytes: Uint8Array | null = null;
  let contentType = "application/octet-stream";
  let httpStatus: number | null = null;
  let tooLarge = false;
  for (let attempt = 0; attempt < 2 && !bytes && !tooLarge; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: dlHeaders }, 120000);
    } catch {
      continue; // transient network failure — retry once
    }
    if (!res.ok) {
      httpStatus = res.status;
      break;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > 300_000_000) {
      tooLarge = true;
      break;
    }
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > 0) {
        bytes = buf;
        contentType =
          res.headers.get("content-type")?.split(";")[0]?.trim() ||
          "application/octet-stream";
      }
    } catch {
      // Connection reset mid-body — retry once.
      continue;
    }
  }
  if (tooLarge) {
    return { ok: false, downloadUrl: null, sizeBytes: 0, error: "The file is too large (over 300 MB) and cannot be prepared for download on the server.", limitReached: false };
  }
  if (!bytes) {
    if (httpStatus !== null) {
      return {
        ok: false, downloadUrl: null, sizeBytes: 0,
        error: `The CDN refused to serve the file (HTTP ${httpStatus}) — the link may have expired. Fetch the video again and then download it.`,
        limitReached: false,
      };
    }
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: "The file could not be loaded from the CDN — this is an internet or CDN issue. Please try again in a while.",
      limitReached: false,
    };
  }
  // A "successful" fetch is not always a video: Douyin's play endpoint
  // answers an unknown path with HTTP 200 plus a tiny JSON error body
  // ({"status_code":0,"status_msg":"url doesn't match"}). Storing that
  // as a video blob and charging a download for it would be wrong, so
  // reject BEFORE storing the blob and BEFORE logging the download
  // event — a rejected fetch consumes no quota.
  const firstByte = bytes[0];
  const bodyLooksJson =
    contentType === "application/json" || firstByte === 0x7b; // '{'
  if (bodyLooksJson) {
    return {
      ok: false, downloadUrl: null, sizeBytes: 0,
      error: "The CDN did not return a video file — the link may have expired. Fetch the video again and then download it.",
      limitReached: false,
    };
  }
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

// ---------------------------------------------------------------------------
// Site SEO (Phase 5, master spec).
//
// The title / description / keywords the site shows in its HTML meta tags
// (and the admin edits in Admin → Settings → SEO). Stored as plain
// settings rows (seo_title, seo_description, seo_keywords); an empty or
// missing value falls back to the defaults below, which match the static
// meta tags in client/index.html.
//
// Honest limit: the saved values flow to document.title/meta CLIENT-side
// via getSiteSeo — the static index.html meta tags and the static
// sitemap.xml do NOT change when the admin saves new SEO text.
// ---------------------------------------------------------------------------

const DEFAULT_SEO = {
  title: "Jimeng Video Downloader — No Watermark",
  description:
    "Download Jimeng AI videos without watermark — free, no login required. Paste a public Jimeng share link and save the original MP4 in seconds.",
  keywords:
    "jimeng downloader, jimeng video downloader, download jimeng video without watermark, dreamina downloader, jimeng mp4",
} as const;

function getSiteSeoValues(env: Env): { title: string; description: string; keywords: string } {
  const title = env.store.getSetting("seo_title");
  const description = env.store.getSetting("seo_description");
  const keywords = env.store.getSetting("seo_keywords");
  return {
    title: title?.trim() ? title.trim() : DEFAULT_SEO.title,
    description: description?.trim() ? description.trim() : DEFAULT_SEO.description,
    keywords: keywords?.trim() ? keywords.trim() : DEFAULT_SEO.keywords,
  };
}

// ---------------------------------------------------------------------------
// Adsterra smart link (the site owner's own ad link).
//
// One sponsored link, shown as a clearly labelled banner on the Jimeng
// downloader page only — below the video result, never above or over any
// Download button, never intercepting a download click, no popunder, no
// auto-redirect, no timer. Stored in the settings table:
//   smart_link_url     — the URL (empty = removed by the admin)
//   smart_link_enabled — "1" / "0"
// The default is the owner's Adsterra smart link, so the banner shows
// immediately on a fresh database; the admin can change, disable or
// remove it in Admin → Ads at any time. Removing writes an empty URL
// (not a deleted row) so the default does NOT come back after a remove.
// ---------------------------------------------------------------------------

const DEFAULT_SMART_LINK_URL =
  "https://auctionr.org/4/83adcd468ac5bbb0c8ecf153de0ed631";

function getSmartLinkValues(env: Env): { url: string | null; enabled: boolean } {
  const urlRaw = env.store.getSetting("smart_link_url");
  const enabledRaw = env.store.getSetting("smart_link_enabled");
  // Absent row = never touched → the owner's default link, enabled.
  // Present-but-empty = the admin removed it → stays removed.
  const url = urlRaw === null ? DEFAULT_SMART_LINK_URL : urlRaw.trim() ? urlRaw.trim() : null;
  const enabled = enabledRaw === null ? true : enabledRaw === "1";
  return { url, enabled: Boolean(url) && enabled };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ad slot codes (Admin → Ads).
//
// The site owner's own ad code per slot, stored in the settings table as
// adsense_<slot> (head / top / incontent / sidebar / bottom / socialbar /
// mobile). The code is a PUBLIC embed snippet by design — the same bytes any
// visitor's browser would receive inside the page HTML — so getSettings
// returns the effective code for every slot to everyone, and the client
// injects it with real script elements (see client/src/adInject.ts).
// Only the admin can change it (saveAdCode / clearAdCode).
//
// Six slots ship with the owner's Adsterra codes as defaults, so the
// ads show immediately on a fresh database: Top 728×90 banner, Head
// popunder, In-Content native banner, the Social Bar, the Sidebar
// 300×250 banner, and the Bottom 728×90 banner (which reuses the Top
// banner's code, per the owner's choice). The admin can
// change or remove any of them in Admin → Ads at any time. Removing
// writes an empty string (not a deleted row) so the default does NOT
// come back after a remove — the same pattern as the smart link.
// ---------------------------------------------------------------------------

const DEFAULT_ADSTERRA_TOP_CODE = `<script>
  atOptions = {
    'key' : 'a4e928f8eb4c0f0ff37cb6f0ac928ea2',
    'format' : 'iframe',
    'height' : 90,
    'width' : 728,
    'params' : {}
  };
</script>
<script src="https://bicea.org/22/a4e928f8eb4c0f0ff37cb6f0ac928ea2"></script>`;

/** The owner's Adsterra popunder, seeded as the Head Code default (site-wide script). */
const DEFAULT_POPUNDER_HEAD_CODE =
  `<script data-cfasync="false" src="https://afders.org/1/5a2a072ce17662b32a95c0d3c59626c7"></script>`;

/** The owner's Adsterra Social Bar, seeded as its own site-wide slot's default. */
const DEFAULT_SOCIAL_BAR_CODE =
  `<script data-cfasync="false" src="https://bicea.org/14/bf1490030c76c548336e25733bf3e827"></script>`;

/** The owner's Adsterra Native Banner, seeded as the In-Content default. */
const DEFAULT_NATIVE_INCONTENT_CODE =
  `<script async="async" data-cfasync="false" src="https://bicea.org/21/0000ec8fe23b2035eca06cc135531a16"></script>\n<div id="container-0000ec8fe23b2035eca06cc135531a16"></div>`;

/** The owner's Adsterra Sidebar banner 300×250, seeded as the Sidebar default. */
const DEFAULT_ADSTERRA_SIDEBAR_CODE = `<script>
  atOptions = {
    'key' : 'ef307c380a8a4b61b52d3c7a8ab1941d',
    'format' : 'iframe',
    'height' : 250,
    'width' : 300,
    'params' : {}
  };
</script>
<script src="https://bicea.org/22/ef307c380a8a4b61b52d3c7a8ab1941d"></script>`;

/** The Bottom 728×90 banner, seeded with the same Adsterra code as the
 *  Top banner (the owner's choice: the Top code runs in the Bottom slot
 *  too, so both slots show the same 728×90 banner). */
const DEFAULT_ADSTERRA_BOTTOM_CODE = `<script>
  atOptions = {
    'key' : 'a4e928f8eb4c0f0ff37cb6f0ac928ea2',
    'format' : 'iframe',
    'height' : 90,
    'width' : 728,
    'params' : {}
  };
</script>
<script src="https://bicea.org/22/a4e928f8eb4c0f0ff37cb6f0ac928ea2"></script>`;

/** The owner's Adsterra Mobile banner 320×50, seeded as the Mobile slot
 *  default. Shown only on phones (the slot is hidden on desktop). */
const DEFAULT_MOBILE_BANNER_CODE = `<script>
  atOptions = {
    'key' : '9de93bd0abe30b979546875a0ff4a60a',
    'format' : 'iframe',
    'height' : 50,
    'width' : 320,
    'params' : {}
  };
</script>
<script src="https://bicea.org/22/9de93bd0abe30b979546875a0ff4a60a"></script>`;

function getAdSlotCodeValues(env: Env): Record<AdSlot, string | null> {
  const out = {} as Record<AdSlot, string | null>;
  for (const key of AD_SLOTS) {
    const raw = env.store.getSetting(`adsense_${key}`);
    // Absent row = never touched → the owner's seeded default for that
    // slot (Top banner, Head popunder, In-Content native, Social Bar,
    // Sidebar banner, Bottom banner reusing the Top code, Mobile banner).
    // Present-but-empty = the admin removed it → stays removed.
    if (raw === null) {
      if (key === "top") { out[key] = DEFAULT_ADSTERRA_TOP_CODE; continue; }
      if (key === "head") { out[key] = DEFAULT_POPUNDER_HEAD_CODE; continue; }
      if (key === "incontent") { out[key] = DEFAULT_NATIVE_INCONTENT_CODE; continue; }
      if (key === "socialbar") { out[key] = DEFAULT_SOCIAL_BAR_CODE; continue; }
      if (key === "sidebar") { out[key] = DEFAULT_ADSTERRA_SIDEBAR_CODE; continue; }
      if (key === "bottom") { out[key] = DEFAULT_ADSTERRA_BOTTOM_CODE; continue; }
      if (key === "mobile") { out[key] = DEFAULT_MOBILE_BANNER_CODE; continue; }
    }
    out[key] = raw?.trim() ? raw.trim() : null;
  }
  return out;
}

function getSettings(env: Env, args: unknown): {
  apiKeyHint: string | null;
  hasApiKey: boolean;
  apiBaseUrl: string | null;
  adSlots: Record<AdSlot, boolean>;
  adCodes: Record<AdSlot, string | null>;
  smartLink: { url: string | null; enabled: boolean };
} {
  // The API-key hint and base URL are returned only to the admin — regular
  // visitors get nulls. The ad-slot codes are public embed snippets by
  // design, so everyone gets the effective code for every slot. The
  // "saved" flags follow the effective codes so the placeholder and the
  // rendered ad never disagree. The smart link is a public ad link
  // (no secrets), so everyone gets it.
  const isAdmin = authAdmin(env, optToken(args)) !== null;
  const apiKey = isAdmin ? env.store.getSetting("api_key") : null;
  // Effective codes (the owner's seeded defaults apply on a fresh
  // database); the "saved" flags follow the effective codes.
  const codes = getAdSlotCodeValues(env);
  const adSlots = {} as Record<AdSlot, boolean>;
  for (const slot of AD_SLOTS) {
    adSlots[slot] = Boolean(codes[slot]);
  }
  return {
    apiKeyHint: isAdmin ? keyHint(apiKey) : null,
    hasApiKey: isAdmin ? Boolean(apiKey) : false,
    apiBaseUrl: isAdmin ? env.store.getSetting("api_base_url") : null,
    adSlots,
    adCodes: codes,
    smartLink: getSmartLinkValues(env),
  };
}

function getSiteSeo(env: Env): { title: string; description: string; keywords: string } {
  return getSiteSeoValues(env);
}

function getSeoSettings(env: Env, args: unknown): { title: string; description: string; keywords: string } {
  requireAdmin(env, args);
  return getSiteSeoValues(env);
}

function saveSeoSettings(env: Env, args: unknown): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const title = reqString(args, "title", 120).trim();
  const description = reqString(args, "description", 300).trim();
  const keywords = optString(args, "keywords", 300).trim();
  if (!title) throw new HandlerError(400, "title is required");
  if (!description) throw new HandlerError(400, "description is required");
  env.store.setSetting("seo_title", title);
  env.store.setSetting("seo_description", description);
  env.store.setSetting("seo_keywords", keywords);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.seo_save", detail: `SEO title set to “${title}”.` });
  return { ok: true, error: null };
}

function saveSmartLink(env: Env, args: unknown): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const rec = asRecord(args);
  const url = reqString(args, "url", 500).trim();
  const enabled = rec?.enabled;
  if (typeof enabled !== "boolean") {
    throw new HandlerError(400, "enabled must be a boolean");
  }
  if (!isHttpUrl(url)) {
    return { ok: false, error: "Enter a valid link starting with http:// or https://" };
  }
  env.store.setSetting("smart_link_url", url);
  env.store.setSetting("smart_link_enabled", enabled ? "1" : "0");
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.ads.smartlink_save", detail: `Smart link saved (${enabled ? "enabled" : "disabled"}).` });
  return { ok: true, error: null };
}

function clearSmartLink(env: Env, args: unknown): { ok: true } {
  const admin = requireAdmin(env, args);
  // Writes an empty URL (not a deleted row) so the default link does not
  // come back after a remove.
  env.store.setSetting("smart_link_url", "");
  env.store.setSetting("smart_link_enabled", "0");
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.ads.smartlink_clear", detail: "Smart link removed — the Sponsored banner is hidden." });
  return { ok: true as const };
}

function saveApiKey(env: Env, args: unknown): { ok: true; hint: string } {
  const admin = requireAdmin(env, args);
  const key = reqString(args, "apiKey", 500).trim();
  if (key.length < 4) throw new HandlerError(400, "API key must be at least 4 characters");
  env.store.setSetting("api_key", key);
  const base = optString(args, "apiBaseUrl", 500).trim();
  if (base) env.store.setSetting("api_base_url", base);
  else env.store.deleteSetting("api_base_url");
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.apikey.save", detail: `Custom resolver API key saved (${keyHint(key) ?? "no hint"}).` });
  return { ok: true as const, hint: keyHint(key) ?? "" };
}

function clearApiKey(env: Env, args: unknown): { ok: true } {
  const admin = requireAdmin(env, args);
  env.store.deleteSetting("api_key");
  env.store.deleteSetting("api_base_url");
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.apikey.clear", detail: "Custom resolver API key removed." });
  return { ok: true as const };
}

function saveAdCode(env: Env, args: unknown): { ok: true } {
  const admin = requireAdmin(env, args);
  const rec = asRecord(args);
  const slot = rec?.slot;
  if (typeof slot !== "string" || !(AD_SLOTS as readonly string[]).includes(slot)) {
    throw new HandlerError(400, "slot must be one of: " + AD_SLOTS.join(", "));
  }
  const code = reqString(args, "code", 20000).trim();
  if (!code) throw new HandlerError(400, "code is required");
  env.store.setSetting(`adsense_${slot}`, code);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.ads.save", detail: `Ad code saved for the "${slot}" slot.` });
  return { ok: true as const };
}

function clearAdCode(env: Env, args: unknown): { ok: true } {
  const admin = requireAdmin(env, args);
  const rec = asRecord(args);
  const slot = rec?.slot;
  if (typeof slot !== "string" || !(AD_SLOTS as readonly string[]).includes(slot)) {
    throw new HandlerError(400, "slot must be one of: " + AD_SLOTS.join(", "));
  }
  // Writes an empty value (not a deleted row) so a seeded default —
  // the Top banner, Bottom banner, Sidebar banner, Head popunder,
  // In-Content native, Social Bar, or Mobile banner —
  // does not come back after a remove.
  env.store.setSetting(`adsense_${slot}`, "");
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.ads.clear", detail: `Ad code removed from the "${slot}" slot.` });
  return { ok: true as const };
}

function listHistory(env: Env, args: unknown): {
  items: {
    id: number;
    sourceUrl: string;
    title: string;
    videoUrl: string;
    coverUrl: string | null;
    platform: "jimeng" | "douyin";
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
      platform: r.platform,
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
  totpRequired: boolean;
}> {
  seedAdmin(env);
  const email = reqString(args, "email", 200).trim().toLowerCase();
  const password = reqString(args, "password", 200);
  const totpCode = optString(args, "totpCode", 10).trim() || undefined;
  const lock = checkLoginLock(env, email);
  if (lock.locked) {
    return { ok: false, token: null, error: `Too many failed attempts. Try again in ${lock.retryInMinutes} minute${lock.retryInMinutes === 1 ? "" : "s"}.`, admin: null, totpRequired: false };
  }
  const u = env.store.getUserByEmail(email);
  // Same message for unknown email, wrong password and non-admin accounts —
  // never reveal which one failed.
  if (!u || u.role !== "admin" || !(await verifyPassword(password, u.passwordHash))) {
    recordFailedLogin(env, email);
    if (u && u.role === "admin") {
      logEvent(env, { actorType: "admin", actorEmail: email, action: "admin.login.failed", detail: "Wrong password." });
    }
    return { ok: false, token: null, error: "Incorrect email or password.", admin: null, totpRequired: false };
  }
  if (u.status !== "active") {
    return { ok: false, token: null, error: "This account is disabled. Contact the site owner.", admin: null, totpRequired: false };
  }
  if (u.totpEnabled) {
    if (!totpCode) {
      return { ok: false, token: null, error: null, admin: null, totpRequired: true };
    }
    if (!u.totpSecret || !verifyTotp(u.totpSecret, totpCode)) {
      recordFailedLogin(env, email);
      logEvent(env, { actorType: "admin", actorEmail: email, action: "admin.login.failed", detail: "Wrong two-factor code." });
      return { ok: false, token: null, error: "Incorrect verification code.", admin: null, totpRequired: true };
    }
  }
  clearFailedLogins(env, email);
  const token = createSession(env, u.id);
  env.store.updateUserLastLogin(u.id);
  logEvent(env, { actorType: "admin", actorEmail: email, action: "admin.login", detail: "Admin signed in." });
  return {
    ok: true,
    token,
    error: null,
    admin: { id: u.id, name: u.name, email: u.email, role: "admin" },
    totpRequired: false,
  };
}

function adminLogout(env: Env, args: unknown): { ok: true } {
  const token = optToken(args);
  if (token) {
    const me = authUser(env, token);
    env.store.deleteSession(token);
    if (me?.role === "admin") {
      logEvent(env, { actorType: "admin", actorEmail: me.email, action: "admin.logout", detail: "Admin signed out." });
    }
  }
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
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "admin.password_change", detail: "Admin password changed (other sessions signed out)." });
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
  const lock = checkLoginLock(env, email);
  if (lock.locked) {
    return { ok: false, token: null, error: `Too many failed attempts. Try again in ${lock.retryInMinutes} minute${lock.retryInMinutes === 1 ? "" : "s"}.`, user: null };
  }
  const u = env.store.getUserByEmail(email);
  // Same message for unknown email, wrong password and non-customer
  // accounts — never reveal which one failed.
  if (!u || u.role !== "user" || !(await verifyPassword(password, u.passwordHash))) {
    recordFailedLogin(env, email);
    return { ok: false, token: null, error: "Incorrect email or password.", user: null };
  }
  if (u.status !== "active") {
    return { ok: false, token: null, error: "Your account is suspended. Contact the site owner for help.", user: null };
  }
  clearFailedLogins(env, email);
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
  totpRequired: boolean;
}> {
  seedAdmin(env);
  const email = reqEmail(args, "email");
  const password = reqString(args, "password", 200);
  const totpCode = optString(args, "totpCode", 10).trim() || undefined;
  const lock = checkLoginLock(env, email);
  if (lock.locked) {
    return { ok: false, role: null, token: null, error: `Too many failed attempts. Try again in ${lock.retryInMinutes} minute${lock.retryInMinutes === 1 ? "" : "s"}.`, admin: null, user: null, totpRequired: false };
  }
  const u = env.store.getUserByEmail(email);
  if (!u || !(await verifyPassword(password, u.passwordHash))) {
    recordFailedLogin(env, email);
    if (u && u.role === "admin") {
      logEvent(env, { actorType: "admin", actorEmail: email, action: "admin.login.failed", detail: "Wrong password." });
    }
    return { ok: false, role: null, token: null, error: "Incorrect email or password.", admin: null, user: null, totpRequired: false };
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
      totpRequired: false,
    };
  }
  if (u.role === "admin" && u.totpEnabled) {
    if (!totpCode) {
      return { ok: false, role: null, token: null, error: null, admin: null, user: null, totpRequired: true };
    }
    if (!u.totpSecret || !verifyTotp(u.totpSecret, totpCode)) {
      recordFailedLogin(env, email);
      logEvent(env, { actorType: "admin", actorEmail: email, action: "admin.login.failed", detail: "Wrong two-factor code." });
      return { ok: false, role: null, token: null, error: "Incorrect verification code.", admin: null, user: null, totpRequired: true };
    }
  }
  clearFailedLogins(env, email);
  const token = createSession(env, u.id);
  env.store.updateUserLastLogin(u.id);
  if (u.role === "admin") {
    logEvent(env, { actorType: "admin", actorEmail: email, action: "admin.login", detail: "Admin signed in." });
    return {
      ok: true,
      role: "admin" as const,
      token,
      error: null,
      admin: { id: u.id, name: u.name, email: u.email, role: "admin" },
      user: null,
      totpRequired: false,
    };
  }
  return {
    ok: true,
    role: "customer" as const,
    token,
    error: null,
    admin: null,
    user: { id: u.id, name: u.name, email: u.email, role: "user" },
    totpRequired: false,
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
  const admin = requireAdmin(env, args);
  // Phase 5 fix: seed the defaults first — creating the very first plan
  // must not suppress the 3 default plans (they seed only when the table
  // is empty on first read).
  ensureDefaultPlans(env);
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
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "plan.create", detail: `${name} — $${(priceCents / 100).toFixed(2)} / ${downloadLimit} downloads / ${durationDays} days.` });
  return { ok: true, error: null, id };
}

function updatePlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
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
  const action = rec?.active === true ? "plan.activate" : rec?.active === false ? "plan.deactivate" : "plan.update";
  const changed = Object.keys(patch).join(", ");
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action, detail: `Plan #${id} — changed: ${changed}.` });
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
  const admin = requireAdmin(env, args);
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
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "payment.record", detail: `${user.email} — ${planName} — $${(amountCents / 100).toFixed(2)} via ${method}.` });
  return { ok: true, error: null, id };
}

function markPaid(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
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
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "payment.mark_paid", detail: `${user.email} — ${req.planName} — $${(amount / 100).toFixed(2)} via ${method}.` });
  return { ok: true, error: null };
}

function activatePlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
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
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "plan.activate", detail: `${user.email} — ${req.planName} (${durationDays ?? plan.durationDays} days, ${downloadLimit ?? plan.downloadLimit} downloads).` });
  return { ok: true, error: null };
}

function assignPlan(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
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
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "plan.assign", detail: `${user.email} — ${plan.name} (${durationDays ?? plan.durationDays} days, ${downloadLimit ?? plan.downloadLimit} downloads).` });
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
  const admin = requireAdmin(env, args);
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
  logEvent(env, {
    actorType: "admin",
    actorEmail: admin.email,
    action: status === "disabled" ? "customer.suspend" : "customer.unsuspend",
    detail: `${user.email} — account ${status === "disabled" ? "suspended (downloads blocked)" : "re-activated"}.`,
  });
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
  const admin = requireAdmin(env, args);
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
  const ticketIds = env.store.listTicketIdsForUser(userId);
  env.store.deleteTicketMessagesForTickets(ticketIds);
  env.store.deleteTicketsForUser(userId);
  env.store.deleteUserById(userId);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "customer.delete", detail: `${user.email} — account deleted (recorded payments kept).` });
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
  const admin = requireAdmin(env, args);
  const freeDailyLimit = reqIntRange(args, "freeDailyLimit", 0, 1000);
  env.store.setSetting("free_daily_limit", String(freeDailyLimit));
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "settings.save", detail: `Free daily limit set to ${freeDailyLimit === 0 ? "unlimited" : freeDailyLimit + " downloads"}.` });
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
): { defaultQuality: QualityPref; defaultMode: DownloadModePref; theme: "dark" | "light"; language: "en" | "ur" } {
  const me = authUser(env, optToken(args));
  if (!me) return { defaultQuality: "best", defaultMode: "single", theme: "dark", language: "en" };
  const row = env.store.getUserSettings(me.id);
  return {
    defaultQuality: (row?.defaultQuality ?? "best") as QualityPref,
    defaultMode: (row?.defaultMode ?? "single") as DownloadModePref,
    theme: (row?.theme ?? "dark") as "dark" | "light",
    language: (row?.language ?? "en") as "en" | "ur",
  };
}

function saveDownloadSettings(env: Env, args: unknown): { ok: true } {
  const me = requireUser(env, args);
  const rec = asRecord(args);
  const quality = rec?.defaultQuality;
  const mode = rec?.defaultMode;
  const theme = rec?.theme;
  const language = rec?.language;
  if (typeof quality !== "string" || !QUALITY_PREFS.includes(quality)) {
    throw new HandlerError(
      400,
      "defaultQuality must be one of: best, original, 720p, 480p, 360p",
    );
  }
  if (mode !== "single" && mode !== "bulk") {
    throw new HandlerError(400, 'defaultMode must be "single" or "bulk"');
  }
  if (theme !== undefined && theme !== "dark" && theme !== "light") {
    throw new HandlerError(400, 'theme must be "dark" or "light"');
  }
  if (language !== undefined && language !== "en" && language !== "ur") {
    throw new HandlerError(400, 'language must be "en" or "ur"');
  }
  // Same as the artifact: omitted theme/language default to dark/en
  // (they are not preserved from a previous save).
  env.store.upsertUserSettings(
    me.id,
    quality as QualityPref,
    mode as DownloadModePref,
    (theme as "dark" | "light") ?? "dark",
    (language as "en" | "ur") ?? "en",
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

// ---------------------------------------------------------------------------
// Phase 3 — Help Center + Support Tickets (master spec).
//
// Tickets work for logged-in customers (per account) and anonymous
// visitors (per browser), like History and Favourites. There is no
// email service on this site, so ticket replies are delivered
// in-app: the owner gets a "support" notification when the admin
// replies, and sees the thread on the Support Tickets page.
// ---------------------------------------------------------------------------

/** The Help Center articles shown to every visitor. Real content only,
 *  written for this site — no invented support email, no invented
 *  claims. Seeded once when the table is empty; the admin manages them
 *  from Admin → Support afterwards. */
const DEFAULT_HELP_ARTICLES: { title: string; body: string; category: string }[] = [
  {
    title: "How do I download a Jimeng video?",
    category: "Downloading",
    body: "Open the video in the Jimeng app or on jimeng.jianying.com, make sure it is Published (Public), then use the share arrow and copy the link. Paste the link in the box on the Jimeng Downloader page and tap “Get Video”. The video preview appears — choose a quality and tap “Download MP4”. The file is first prepared on this site's server, then the Save buttons appear below. On a phone, “Share and Save” is the most reliable option: choose “Save to Files” or your Gallery app in the share sheet. Another method that works on phones: open the playing video's three dots (⋮) menu, tap Share, then Save at the end — the video goes straight to your gallery.",
  },
  {
    title: "Why is my link not working?",
    category: "Downloading",
    body: "The most common reasons: (1) the video is still a draft or private — Publish (Public) it on Jimeng first, private drafts cannot be fetched; (2) the share link is old or expired — copy a fresh link from the Jimeng app and try again (avatar / cast-template invite links are usually only valid for about 48 hours); (3) the link was copied incompletely — paste the full share text and the link is extracted from it automatically. If the page says “page opened, no video file found”, the link opened but Jimeng returned no video for it — it is usually a draft, a deleted video, or an expired invite.",
  },
  {
    title: "Why does the downloaded video have no watermark?",
    category: "Watermark",
    body: "Jimeng keeps two files for every published video: a display file, with the “AI generated” badge at the top and the Jimeng @user watermark at the bottom burned in, plus a Jimeng ending card appended at the end; and an original master (origin) file that is completely clean. This tool always fetches the master file from the public share link. If only the display file is ever available for a link, it is clearly labelled “File with watermark” in the quality list — a watermarked file is never called “No Watermark”.",
  },
  {
    title: "What is the free daily limit?",
    category: "Plans & limits",
    body: "Downloading is free up to a daily limit set by the site owner (10 downloads per day by default). The limit counts successful downloads only — a failed download does not use up any of your quota — and it resets at the start of each new day (UTC). Visitors without an account are counted per browser; logged-in customers are counted per account. When the limit is reached, the Plans page opens automatically so you can buy a monthly plan. If you need more than the free limit, a plan gives you a fixed number of downloads (for example 1,000, 5,000 or 10,000) for 30 days.",
  },
  {
    title: "How do monthly plans work?",
    category: "Plans & limits",
    body: "On the Plans page, tap Buy on a plan — this creates a purchase request for the admin (there is no payment gateway on the site yet). The admin marks the request as paid once the payment is received, then activates the plan for your account. Your plan then gives you its download quota for its duration (for example 1,000 downloads for 30 days). When the quota is used up or the plan expires, you fall back to the Free plan with its daily limit. You can see your active plan, remaining downloads and purchase history on the My Plan page.",
  },
  {
    title: "How does Bulk Download work?",
    category: "Downloading",
    body: "Open Bulk Download from the menu (or the Bulk tab on the Jimeng page) and paste one Jimeng link per line — up to 10 at a time. Tap “Fetch All Videos” and each video is fetched one by one, each with its own export-quality dropdown and its own Download button. “Download All” downloads the fetched videos one after another, and “Download ZIP” puts them all in one ZIP file. Every successful video also counts toward your free daily limit or plan quota, exactly like a single download.",
  },
  {
    title: "How do Favourites, Notifications and Download Settings work?",
    category: "Account",
    body: "Tap the heart on any video (on the result, in Bulk, or in your History) to save it to Favourites — your Favourites page lists them with a Download again button. In Download Settings you can choose a default quality (for example 720p) and a default mode (Single or Bulk) — the chosen quality is pre-selected on every video you fetch. Notifications appear when a payment is received, a plan is activated or ends, your free daily limit is reached, or the admin replies to one of your support tickets. Logged-in customers keep all of these on their account; visitors without an account keep them in this browser.",
  },
  {
    title: "How do I log in, or change my password?",
    category: "Account",
    body: "Downloads are free and need no login. An account is only needed to buy a monthly plan. Register once on the Login page (name, email, password) and you stay logged in. The same login page is used by everyone: the admin signs in there with the admin email and password and goes straight to the Admin Panel. To change your password, open My Profile when logged in and use “Change password” — your current password is required, and all other sessions are signed out.",
  },
  {
    title: "What is Jimeng AI?",
    category: "About",
    body: "Jimeng AI (jimeng.jianying.com) is ByteDance's AI creative platform — the same company behind TikTok and CapCut. You can create AI videos and images just by typing text or providing an image. It runs on the Seedance model family, and text-to-video, image-to-video and AI image generation are all available in one place. Jimeng is mainly for China; its international version is Dreamina (under CapCut), so public Dreamina share links can also work with this downloader. This tool is not affiliated with Jimeng or ByteDance.",
  },
  {
    title: "Can I use these videos anywhere?",
    category: "About",
    body: "Download videos for personal use only. All rights remain with their creators and ByteDance / Jimeng AI — do not repost someone else's video as your own or use it commercially. If you are a rights holder and a video should not be available here, use the Contact page to reach us and include the video link and proof of ownership.",
  },
];

function ensureHelpArticles(env: Env): void {
  if (env.store.countHelpArticles() === 0) {
    for (const a of DEFAULT_HELP_ARTICLES) {
      env.store.insertHelpArticle(a);
    }
  }
}

const TICKET_CATEGORIES = [
  "billing",
  "download",
  "account",
  "problem",
  "other",
] as const;
type TicketCategory = (typeof TICKET_CATEGORIES)[number];

function listHelpArticles(env: Env): {
  articles: {
    id: number;
    title: string;
    body: string;
    category: string;
    createdAt: string;
  }[];
} {
  ensureHelpArticles(env);
  return {
    articles: env.store.listHelpArticles().map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function createHelpArticle(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null; id: number | null } {
  const admin = requireAdmin(env, args);
  // Phase 5 fix: seed the defaults first — creating the very first
  // article must not suppress the 10 default articles (they seed only
  // when the table is empty on first read).
  ensureHelpArticles(env);
  const title = reqString(args, "title", 200).trim();
  const category = reqString(args, "category", 100).trim();
  const body = reqString(args, "body", 20000).trim();
  const id = env.store.insertHelpArticle({ title, category, body });
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "help_article.create", detail: `“${title}” (${category}).` });
  return { ok: true, error: null, id };
}

function updateHelpArticle(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const id = reqInt(args, "id");
  const rec = asRecord(args);
  const patch: { title?: string; category?: string; body?: string } = {};
  for (const field of ["title", "category", "body"] as const) {
    const v = rec?.[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      throw new HandlerError(400, `${field} is required`);
    }
    const max = field === "body" ? 20000 : field === "title" ? 200 : 100;
    if (v.length > max) throw new HandlerError(400, `${field} is too long`);
    patch[field] = v.trim();
  }
  env.store.updateHelpArticle(id, patch);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "help_article.update", detail: `Article #${id} edited.` });
  return { ok: true, error: null };
}

function deleteHelpArticle(env: Env, args: unknown): { ok: true } {
  const admin = requireAdmin(env, args);
  const id = reqInt(args, "id");
  env.store.deleteHelpArticle(id);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "help_article.delete", detail: `Article #${id} deleted.` });
  return { ok: true as const };
}

function createTicket(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null; ticketId: number | null } {
  const subject = reqString(args, "subject", 200).trim();
  const rec = asRecord(args);
  const category = rec?.category;
  if (
    typeof category !== "string" ||
    !(TICKET_CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new HandlerError(
      400,
      "category must be one of: billing, download, account, problem, other",
    );
  }
  const messageText = reqString(args, "message", 4000).trim();
  const link = optString(args, "link", 500).trim();
  const me = authUser(env, optToken(args));
  const userId = me?.id ?? null;
  const anonId = me ? null : (optString(args, "anonId", 100) || null);
  const ownerKey = ownerKeyFor(userId, anonId);
  if (!ownerKey) {
    return { ok: false, error: "Could not identify this browser — please try again.", ticketId: null };
  }
  const message = link ? `${messageText}\n\nLink: ${link}` : messageText;
  const ticketId = env.store.insertTicket({
    userId,
    anonId,
    ownerKey,
    subject,
    category: category as TicketCategory,
  });
  env.store.insertTicketMessage({
    ticketId,
    authorRole: "user",
    message,
  });
  return { ok: true, error: null, ticketId };
}

function listMyTickets(env: Env, args: unknown): {
  tickets: {
    id: number;
    subject: string;
    category: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }[];
} {
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { tickets: [] };
  return {
    tickets: env.store.listTicketsForOwner(ownerKey).map((r) => ({
      id: r.id,
      subject: r.subject,
      category: r.category,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

function getTicket(env: Env, args: unknown): {
  ticket: {
    id: number;
    subject: string;
    category: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  messages: {
    id: number;
    authorRole: string;
    message: string;
    createdAt: string;
  }[];
} {
  const id = reqInt(args, "id");
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { ticket: null, messages: [] };
  const t = env.store.getTicketByIdAndOwner(id, ownerKey);
  if (!t) return { ticket: null, messages: [] };
  return {
    ticket: {
      id: t.id,
      subject: t.subject,
      category: t.category,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    },
    messages: env.store.listTicketMessages(t.id).map((m) => ({
      id: m.id,
      authorRole: m.authorRole,
      message: m.message,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

function replyTicket(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const id = reqInt(args, "id");
  const message = reqString(args, "message", 4000).trim();
  const me = authUser(env, optToken(args));
  const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
  if (!ownerKey) return { ok: false, error: "Could not identify this browser — please try again." };
  const t = env.store.getTicketByIdAndOwner(id, ownerKey);
  if (!t) return { ok: false, error: "Ticket not found." };
  env.store.insertTicketMessage({
    ticketId: t.id,
    authorRole: "user",
    message,
  });
  env.store.updateTicketStatus(t.id, "open");
  return { ok: true, error: null };
}

function closeTicket(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const id = reqInt(args, "id");
  const me = authUser(env, optToken(args));
  const isAdmin = me?.role === "admin";
  let t;
  if (isAdmin) {
    // Admin can close any ticket.
    t = env.store.getTicketById(id);
  } else {
    // Owner close, same ownerKey scoping as replyTicket: a logged-in
    // owner uses "user:<id>", an anonymous owner uses "anon:<browser>".
    // No login gate — anonymous owners can close their own tickets.
    const ownerKey = ownerKeyFor(me?.id ?? null, me ? null : (optString(args, "anonId", 100) || null));
    if (!ownerKey) return { ok: false, error: "Could not identify this browser — please try again." };
    t = env.store.getTicketByIdAndOwner(id, ownerKey);
  }
  if (!t) return { ok: false, error: "Ticket not found." };
  env.store.updateTicketStatus(t.id, "closed");
  return { ok: true, error: null };
}

function listAllTickets(env: Env, args: unknown): {
  tickets: {
    id: number;
    subject: string;
    category: string;
    status: string;
    customerName: string;
    customerEmail: string;
    createdAt: string;
    updatedAt: string;
  }[];
} {
  requireAdmin(env, args);
  return {
    tickets: env.store.listAllTickets().map((r) => {
      let customerName = "Guest (browser)";
      let customerEmail = "";
      if (r.userId !== null) {
        const u = env.store.getUserById(r.userId);
        customerName = u?.name ?? "Deleted account";
        customerEmail = u?.email ?? "";
      }
      return {
        id: r.id,
        subject: r.subject,
        category: r.category,
        status: r.status,
        customerName,
        customerEmail,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    }),
  };
}

function getAdminTicket(env: Env, args: unknown): {
  ticket: {
    id: number;
    subject: string;
    category: string;
    status: string;
    customerName: string;
    customerEmail: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  messages: {
    id: number;
    authorRole: string;
    message: string;
    createdAt: string;
  }[];
} {
  requireAdmin(env, args);
  const t = env.store.getTicketById(reqInt(args, "id"));
  if (!t) return { ticket: null, messages: [] };
  let customerName = "Guest (browser)";
  let customerEmail = "";
  if (t.userId !== null) {
    const u = env.store.getUserById(t.userId);
    customerName = u?.name ?? "Deleted account";
    customerEmail = u?.email ?? "";
  }
  return {
    ticket: {
      id: t.id,
      subject: t.subject,
      category: t.category,
      status: t.status,
      customerName,
      customerEmail,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    },
    messages: env.store.listTicketMessages(t.id).map((m) => ({
      id: m.id,
      authorRole: m.authorRole,
      message: m.message,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

function replyTicketAdmin(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const id = reqInt(args, "id");
  const message = reqString(args, "message", 4000).trim();
  const t = env.store.getTicketById(id);
  if (!t) return { ok: false, error: "Ticket not found." };
  env.store.insertTicketMessage({
    ticketId: t.id,
    authorRole: "admin",
    message,
  });
  env.store.updateTicketStatus(t.id, "answered");
  createNotification(env, {
    userId: t.userId,
    anonId: t.anonId,
    type: "support",
    title: "Admin replied to your ticket",
    message: `The admin replied to your ticket “${t.subject}”. Open Support Tickets to read the reply.`,
  });
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "ticket.reply", detail: `Ticket #${t.id} “${t.subject}” — admin replied.` });
  return { ok: true, error: null };
}

function setTicketStatus(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const id = reqInt(args, "id");
  const rec = asRecord(args);
  const status = rec?.status;
  if (status !== "open" && status !== "closed") {
    throw new HandlerError(400, 'status must be "open" or "closed"');
  }
  const t = env.store.getTicketById(id);
  if (!t) return { ok: false, error: "Ticket not found." };
  env.store.updateTicketStatus(id, status);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "ticket.status", detail: `Ticket #${id} marked ${status}.` });
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Phase 4 — System Logs, Backup & Restore, Reports, Security, Broadcasts
// (master spec). All admin-only and server-enforced. Logs are NEVER
// seeded — rows only appear for real admin actions. There is no email
// service: ticket replies and broadcasts are delivered in-app via
// notifications. On this hosting (no persistent disk) backups are
// manual downloads — there is no automatic scheduled backup.
// ---------------------------------------------------------------------------

function listSystemLogs(env: Env, args: unknown): {
  logs: {
    id: number;
    actorType: string;
    actorEmail: string | null;
    action: string;
    detail: string;
    createdAt: string;
  }[];
  total: number;
  actions: string[];
} {
  requireAdmin(env, args);
  const rec = asRecord(args);
  const action = optString(args, "action", 100).trim() || undefined;
  const search = optString(args, "search", 200).trim() || undefined;
  let limit = 50;
  const rawLimit = rec?.limit;
  if (typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0) {
    limit = Math.min(rawLimit, 100);
  }
  let offset = 0;
  const rawOffset = rec?.offset;
  if (typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0) {
    offset = rawOffset;
  }
  const rows = env.store.listSystemLogs({ action, search, limit, offset });
  return {
    logs: rows.map((r) => ({
      id: r.id,
      actorType: r.actorType,
      actorEmail: r.actorEmail,
      action: r.action,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    })),
    total: env.store.countSystemLogs({ action, search }),
    actions: env.store.listSystemLogActions(),
  };
}

function exportBackup(env: Env, args: unknown): {
  ok: boolean;
  error: string | null;
  filename: string;
  json: string;
} {
  const admin = requireAdmin(env, args);
  const users = env.store.listAllUsers();
  // Date fields serialize to ISO strings (same shape as the artifact's
  // drizzle export); users carry epoch-ms timestamps, also like the
  // artifact. Password hashes, 2FA secrets and session tokens are
  // NEVER included (sessions are excluded entirely).
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: "jimeng-video-downloader",
    tables: {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt.getTime(),
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.getTime() : null,
        // passwordHash and totpSecret deliberately excluded.
        totpEnabled: u.totpEnabled ? 1 : 0,
      })),
      plans: env.store.listPlans(false),
      subscriptions: env.store.listAllSubscriptions(),
      purchaseRequests: env.store.listPurchaseRequests(),
      payments: env.store.listPayments(),
      downloads: env.store.listAllDownloads(),
      downloadEvents: env.store.listDownloadEvents(),
      favorites: env.store.listAllFavorites(),
      userSettings: env.store.listUserSettings(),
      notifications: env.store.listAllNotifications(),
      helpArticles: env.store.listHelpArticles(),
      supportTickets: env.store.listAllTickets(),
      ticketMessages: env.store.listAllTicketMessages(),
      systemLogs: env.store.listSystemLogs({ limit: 1000000, offset: 0 }),
      broadcasts: env.store.listBroadcasts(1000000),
      settings: env.store.listSettings(),
      contactMessages: env.store.listContactMessages(),
      // sessions deliberately excluded — restoring them would revive
      // revoked logins and could lock the admin out.
    },
  };
  const stamp = new Date().toISOString().slice(0, 10);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "backup.export", detail: `Backup downloaded (${users.length} users, ${backup.tables.downloads.length} downloads).` });
  return {
    ok: true,
    error: null,
    filename: `jimeng-backup-${stamp}.json`,
    json: JSON.stringify(backup, null, 2),
  };
}

async function restoreBackup(
  env: Env,
  args: unknown,
): Promise<{
  ok: boolean;
  error: string | null;
  restored: {
    users: number;
    plans: number;
    downloads: number;
    payments: number;
    tickets: number;
  } | null;
}> {
  const admin = requireAdmin(env, args);
  const json = reqString(args, "json", 100_000_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "This is not a valid JSON file.", restored: null };
  }
  const fail = (msg: string) => ({ ok: false as const, error: msg, restored: null });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("This is not a Jimeng backup file.");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1 || root.app !== "jimeng-video-downloader") {
    return fail("This backup file is from another app or an unsupported version.");
  }
  const tables = root.tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    return fail("The backup file has no tables section.");
  }
  const t = tables as Record<string, unknown>;
  const tableNames = [
    "users", "plans", "subscriptions", "purchaseRequests", "payments",
    "downloads", "downloadEvents", "favorites", "userSettings",
    "notifications", "helpArticles", "supportTickets", "ticketMessages",
    "systemLogs", "broadcasts", "settings", "contactMessages",
  ];
  for (const name of tableNames) {
    if (t[name] !== undefined && !Array.isArray(t[name])) {
      return fail(`The backup file is malformed: table "${name}" is not a list.`);
    }
  }
  const isRow = (r: unknown): r is Record<string, unknown> =>
    !!r && typeof r === "object" && !Array.isArray(r);
  const usersRows = ((t.users as unknown[]) ?? []).filter(isRow);
  const seenEmails = new Set<string>();
  for (const r of usersRows) {
    if (typeof r.id !== "number" || typeof r.name !== "string" || typeof r.email !== "string") {
      return fail("The backup file is malformed: a user row is missing id, name or email.");
    }
    if (r.role !== "user" && r.role !== "admin") {
      return fail("The backup file is malformed: a user row has an unknown role.");
    }
    if (r.status !== "active" && r.status !== "disabled") {
      return fail("The backup file is malformed: a user row has an unknown status.");
    }
    const email = (r.email as string).toLowerCase();
    if (seenEmails.has(email)) return fail("The backup file is malformed: duplicate user email.");
    seenEmails.add(email);
  }
  // Keep the calling admin intact: snapshot the real account first.
  const currentAdmin = env.store.getUserById(admin.id);
  if (!currentAdmin) return fail("Your admin account was not found — restore refused.");
  const toMs = (v: unknown): number | null =>
    typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : null;
  const db = env.store.db;
  // Replace strategy: wipe child tables first, then parents.
  db.exec("DELETE FROM download_events");
  db.exec("DELETE FROM ticket_messages");
  db.exec("DELETE FROM favorites");
  db.exec("DELETE FROM notifications");
  db.exec("DELETE FROM user_settings");
  db.exec("DELETE FROM purchase_requests");
  db.exec("DELETE FROM payments");
  db.exec("DELETE FROM subscriptions");
  db.exec("DELETE FROM downloads");
  db.exec("DELETE FROM support_tickets");
  db.exec("DELETE FROM help_articles");
  db.exec("DELETE FROM system_logs");
  db.exec("DELETE FROM broadcasts");
  db.exec("DELETE FROM settings");
  db.exec("DELETE FROM contact_messages");
  db.exec("DELETE FROM plans");
  db.exec("DELETE FROM users");
  // Users: every restored customer gets a random unusable password —
  // password hashes are never stored in a backup file. The admin row
  // from the backup is skipped; the real admin row is restored below
  // with its actual hash.
  const insertUser = db.query(
    "INSERT INTO users (id, name, email, password_hash, role, status, created_at, last_login_at, totp_secret, totp_enabled) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const restoredUserIds = new Set<number>();
  for (const r of usersRows) {
    if ((r.id as number) === currentAdmin.id) continue;
    const hash = await hashPassword(randomBytes(16).toString("hex"));
    insertUser.run(
      r.id as number,
      r.name as string,
      (r.email as string).toLowerCase(),
      hash,
      r.role as string,
      r.status as string,
      toMs(r.createdAt) ?? Date.now(),
      toMs(r.lastLoginAt),
      null,
      0,
    );
    restoredUserIds.add(r.id as number);
  }
  insertUser.run(
    currentAdmin.id,
    currentAdmin.name,
    currentAdmin.email,
    currentAdmin.passwordHash,
    "admin",
    currentAdmin.status,
    currentAdmin.createdAt.getTime(),
    currentAdmin.lastLoginAt ? currentAdmin.lastLoginAt.getTime() : null,
    currentAdmin.totpSecret ?? null,
    currentAdmin.totpEnabled ? 1 : 0,
  );
  const plansRows = ((t.plans as unknown[]) ?? []).filter(isRow);
  const insertPlan = db.query(
    "INSERT INTO plans (id, name, price_cents, duration_days, download_limit, description, active, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of plansRows) {
    if (typeof r.id !== "number" || typeof r.name !== "string") continue;
    insertPlan.run(
      r.id,
      r.name,
      typeof r.priceCents === "number" ? r.priceCents : 0,
      typeof r.durationDays === "number" ? r.durationDays : 30,
      typeof r.downloadLimit === "number" ? r.downloadLimit : 100,
      typeof r.description === "string" ? r.description : "",
      r.active === 0 ? 0 : 1,
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const subsRows = ((t.subscriptions as unknown[]) ?? []).filter(isRow);
  const insertSub = db.query(
    "INSERT INTO subscriptions (id, user_id, plan_id, plan_name, price_cents, duration_days, limit_total, limit_used, starts_at, expires_at, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of subsRows) {
    if (typeof r.id !== "number" || typeof r.userId !== "number") continue;
    insertSub.run(
      r.id,
      r.userId,
      typeof r.planId === "number" ? r.planId : 0,
      typeof r.planName === "string" ? r.planName : "",
      typeof r.priceCents === "number" ? r.priceCents : 0,
      typeof r.durationDays === "number" ? r.durationDays : 30,
      typeof r.limitTotal === "number" ? r.limitTotal : (typeof r.downloadLimit === "number" ? r.downloadLimit : 0),
      typeof r.limitUsed === "number" ? r.limitUsed : (typeof r.downloadsUsed === "number" ? r.downloadsUsed : 0),
      toMs(r.startsAt) ?? Date.now(),
      toMs(r.expiresAt) ?? Date.now(),
      ["active", "expired", "exhausted", "cancelled"].includes(String(r.status)) ? String(r.status) : "active",
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const reqRows = ((t.purchaseRequests as unknown[]) ?? []).filter(isRow);
  const insertReq = db.query(
    "INSERT INTO purchase_requests (id, user_id, plan_id, plan_name, price_cents, status, created_at, decided_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of reqRows) {
    if (typeof r.id !== "number" || typeof r.userId !== "number") continue;
    insertReq.run(
      r.id,
      r.userId,
      typeof r.planId === "number" ? r.planId : 0,
      typeof r.planName === "string" ? r.planName : "",
      typeof r.priceCents === "number" ? r.priceCents : 0,
      ["pending", "paid", "activated", "rejected"].includes(String(r.status)) ? String(r.status) : "pending",
      toMs(r.createdAt) ?? Date.now(),
      toMs(r.decidedAt),
    );
  }
  const payRows = ((t.payments as unknown[]) ?? []).filter(isRow);
  const insertPay = db.query(
    "INSERT INTO payments (id, user_id, purchase_request_id, customer_name, customer_email, plan_name, amount_cents, method, note, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of payRows) {
    if (typeof r.id !== "number") continue;
    insertPay.run(
      r.id,
      typeof r.userId === "number" ? r.userId : null,
      typeof r.purchaseRequestId === "number" ? r.purchaseRequestId : null,
      typeof r.customerName === "string" ? r.customerName : "",
      typeof r.customerEmail === "string" ? r.customerEmail : "",
      typeof r.planName === "string" ? r.planName : "",
      typeof r.amountCents === "number" ? r.amountCents : 0,
      typeof r.method === "string" ? r.method : "Manual",
      typeof r.note === "string" ? r.note : "",
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const dlRows = ((t.downloads as unknown[]) ?? []).filter(isRow);
  const insertDl = db.query(
    "INSERT INTO downloads (id, source_url, title, video_url, cover_url, user_id, anon_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of dlRows) {
    if (typeof r.id !== "number" || typeof r.sourceUrl !== "string") continue;
    insertDl.run(
      r.id,
      r.sourceUrl,
      typeof r.title === "string" ? r.title : "",
      typeof r.videoUrl === "string" ? r.videoUrl : "",
      typeof r.coverUrl === "string" ? r.coverUrl : null,
      typeof r.userId === "number" ? r.userId : null,
      typeof r.anonId === "string" ? r.anonId : null,
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const evRows = ((t.downloadEvents as unknown[]) ?? []).filter(isRow);
  const insertEv = db.query(
    "INSERT INTO download_events (id, user_id, anon_id, size_bytes, created_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of evRows) {
    if (typeof r.id !== "number") continue;
    insertEv.run(
      r.id,
      typeof r.userId === "number" ? r.userId : null,
      typeof r.anonId === "string" ? r.anonId : null,
      typeof r.sizeBytes === "number" ? r.sizeBytes : (typeof r.bytes === "number" ? r.bytes : 0),
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const favRows = ((t.favorites as unknown[]) ?? []).filter(isRow);
  const insertFav = db.query(
    "INSERT INTO favorites (id, download_id, user_id, anon_id, owner_key, title, cover_url, video_url, quality_label, source_url, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of favRows) {
    if (typeof r.id !== "number") continue;
    insertFav.run(
      r.id,
      typeof r.downloadId === "number" ? r.downloadId : 0,
      typeof r.userId === "number" ? r.userId : null,
      typeof r.anonId === "string" ? r.anonId : null,
      typeof r.ownerKey === "string" ? r.ownerKey : "",
      typeof r.title === "string" ? r.title : "",
      typeof r.coverUrl === "string" ? r.coverUrl : null,
      typeof r.videoUrl === "string" ? r.videoUrl : "",
      typeof r.qualityLabel === "string" ? r.qualityLabel : "",
      typeof r.sourceUrl === "string" ? r.sourceUrl : "",
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const usRows = ((t.userSettings as unknown[]) ?? []).filter(isRow);
  const insertUs = db.query(
    "INSERT INTO user_settings (user_id, default_quality, default_mode, updated_at) " +
      "VALUES (?, ?, ?, ?)",
  );
  for (const r of usRows) {
    if (typeof r.userId !== "number") continue;
    insertUs.run(
      r.userId,
      typeof r.defaultQuality === "string" ? r.defaultQuality : "best",
      typeof r.defaultMode === "string" ? r.defaultMode : "single",
      toMs(r.updatedAt) ?? Date.now(),
    );
  }
  const notifRows = ((t.notifications as unknown[]) ?? []).filter(isRow);
  const insertNotif = db.query(
    "INSERT INTO notifications (id, user_id, anon_id, owner_key, type, title, message, read, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of notifRows) {
    if (typeof r.id !== "number") continue;
    insertNotif.run(
      r.id,
      typeof r.userId === "number" ? r.userId : null,
      typeof r.anonId === "string" ? r.anonId : null,
      typeof r.ownerKey === "string" ? r.ownerKey : "",
      ["payment", "plan", "limit", "support", "announcement"].includes(String(r.type)) ? String(r.type) : "announcement",
      typeof r.title === "string" ? r.title : "",
      typeof r.message === "string" ? r.message : "",
      r.read === 1 ? 1 : 0,
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const artRows = ((t.helpArticles as unknown[]) ?? []).filter(isRow);
  const insertArt = db.query(
    "INSERT INTO help_articles (id, title, body, category, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of artRows) {
    if (typeof r.id !== "number" || typeof r.title !== "string") continue;
    insertArt.run(
      r.id,
      r.title,
      typeof r.body === "string" ? r.body : "",
      typeof r.category === "string" ? r.category : "General",
      toMs(r.createdAt) ?? Date.now(),
      toMs(r.updatedAt) ?? Date.now(),
    );
  }
  const tickRows = ((t.supportTickets as unknown[]) ?? []).filter(isRow);
  const insertTick = db.query(
    "INSERT INTO support_tickets (id, user_id, anon_id, owner_key, subject, category, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of tickRows) {
    if (typeof r.id !== "number" || typeof r.subject !== "string") continue;
    insertTick.run(
      r.id,
      typeof r.userId === "number" ? r.userId : null,
      typeof r.anonId === "string" ? r.anonId : null,
      typeof r.ownerKey === "string" ? r.ownerKey : "",
      r.subject,
      ["billing", "download", "account", "problem", "other"].includes(String(r.category)) ? String(r.category) : "other",
      ["open", "answered", "closed"].includes(String(r.status)) ? String(r.status) : "open",
      toMs(r.createdAt) ?? Date.now(),
      toMs(r.updatedAt) ?? Date.now(),
    );
  }
  const msgRows = ((t.ticketMessages as unknown[]) ?? []).filter(isRow);
  const insertMsg = db.query(
    "INSERT INTO ticket_messages (id, ticket_id, author_role, message, created_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of msgRows) {
    if (typeof r.id !== "number" || typeof r.ticketId !== "number") continue;
    insertMsg.run(
      r.id,
      r.ticketId,
      r.authorRole === "admin" ? "admin" : "user",
      typeof r.message === "string" ? r.message : "",
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const logRows = ((t.systemLogs as unknown[]) ?? []).filter(isRow);
  const insertLog = db.query(
    "INSERT INTO system_logs (id, actor_type, actor_email, action, detail, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of logRows) {
    if (typeof r.id !== "number" || typeof r.action !== "string") continue;
    insertLog.run(
      r.id,
      ["admin", "user", "system"].includes(String(r.actorType)) ? String(r.actorType) : "system",
      typeof r.actorEmail === "string" ? r.actorEmail : null,
      r.action,
      typeof r.detail === "string" ? r.detail : "",
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const bcRows = ((t.broadcasts as unknown[]) ?? []).filter(isRow);
  const insertBc = db.query(
    "INSERT INTO broadcasts (id, title, message, recipient_count, created_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of bcRows) {
    if (typeof r.id !== "number" || typeof r.title !== "string") continue;
    insertBc.run(
      r.id,
      r.title,
      typeof r.message === "string" ? r.message : "",
      typeof r.recipientCount === "number" ? r.recipientCount : 0,
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  const setRows = ((t.settings as unknown[]) ?? []).filter(isRow);
  const insertSet = db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?)",
  );
  for (const r of setRows) {
    if (typeof r.key !== "string") continue;
    insertSet.run(r.key, typeof r.value === "string" ? r.value : String(r.value ?? ""));
  }
  const cmRows = ((t.contactMessages as unknown[]) ?? []).filter(isRow);
  const insertCm = db.query(
    "INSERT INTO contact_messages (id, name, email, message, created_at) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of cmRows) {
    if (typeof r.id !== "number") continue;
    insertCm.run(
      r.id,
      typeof r.name === "string" ? r.name : "",
      typeof r.email === "string" ? r.email : "",
      typeof r.message === "string" ? r.message : "",
      toMs(r.createdAt) ?? Date.now(),
    );
  }
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "backup.restore", detail: `Backup restored (${restoredUserIds.size} customers, ${plansRows.length} plans, ${dlRows.length} downloads). Restored customer accounts need a password reset before they can log in.` });
  return {
    ok: true,
    error: null,
    restored: {
      users: usersRows.length,
      plans: plansRows.length,
      downloads: dlRows.length,
      payments: payRows.length,
      tickets: tickRows.length,
    },
  };
}

function getReports(env: Env, args: unknown): {
  ok: boolean;
  error: string | null;
  days: { date: string; downloads: number; revenueCents: number; signups: number }[];
  totals: { downloads: number; revenueCents: number; signups: number; plansSold: number; mbUsed: number };
  topCustomers: { userId: number; name: string; email: string; downloads: number; mb: number }[];
} {
  requireAdmin(env, args);
  const from = reqString(args, "from", 10).trim();
  const to = reqString(args, "to", 10).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new HandlerError(400, "from and to must be dates like 2026-11-01");
  }
  const empty = {
    ok: false as const,
    error: "",
    days: [] as { date: string; downloads: number; revenueCents: number; signups: number }[],
    totals: { downloads: 0, revenueCents: 0, signups: 0, plansSold: 0, mbUsed: 0 },
    topCustomers: [] as { userId: number; name: string; email: string; downloads: number; mb: number }[],
  };
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    return { ...empty, error: "Pick a valid date range." };
  }
  if ((toMs - fromMs) / (24 * 60 * 60 * 1000) > 366) {
    return { ...empty, error: "The range is too long — pick at most 366 days." };
  }
  const dayKeys: string[] = [];
  for (let d = new Date(fromMs); d.getTime() < toMs; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const perDay = new Map<string, { downloads: number; revenueCents: number; signups: number }>();
  for (const k of dayKeys) perDay.set(k, { downloads: 0, revenueCents: 0, signups: 0 });
  const events = env.store.listDownloadEventsInRange(fromMs, toMs);
  let totalBytes = 0;
  const perUser = new Map<number, { downloads: number; bytes: number }>();
  for (const e of events) {
    const key = e.createdAt.toISOString().slice(0, 10);
    const bucket = perDay.get(key);
    if (bucket) bucket.downloads += 1;
    totalBytes += e.sizeBytes;
    if (e.userId) {
      const u = perUser.get(e.userId) ?? { downloads: 0, bytes: 0 };
      u.downloads += 1;
      u.bytes += e.sizeBytes;
      perUser.set(e.userId, u);
    }
  }
  const pays = env.store.listPaymentsInRange(fromMs, toMs);
  for (const p of pays) {
    const key = p.createdAt.toISOString().slice(0, 10);
    const bucket = perDay.get(key);
    if (bucket) bucket.revenueCents += p.amountCents;
  }
  const signups = env.store.listUserSignupsInRange(fromMs, toMs);
  for (const s of signups) {
    const key = s.createdAt.toISOString().slice(0, 10);
    const bucket = perDay.get(key);
    if (bucket) bucket.signups += 1;
  }
  const sold = env.store.countActivatedRequestsInRange(fromMs, toMs);
  const topIds = [...perUser.entries()].sort((a, b) => b[1].downloads - a[1].downloads).slice(0, 10);
  const topCustomers: { userId: number; name: string; email: string; downloads: number; mb: number }[] = [];
  for (const [userId, stats] of topIds) {
    const u = env.store.getUserById(userId);
    topCustomers.push({
      userId,
      name: u?.name ?? `Customer #${userId}`,
      email: u?.email ?? "",
      downloads: stats.downloads,
      mb: stats.bytes / (1024 * 1024),
    });
  }
  const days = dayKeys.map((date) => ({ date, ...perDay.get(date)! }));
  const totals = {
    downloads: events.length,
    revenueCents: pays.reduce((s, p) => s + p.amountCents, 0),
    signups: signups.length,
    plansSold: sold,
    mbUsed: totalBytes / (1024 * 1024),
  };
  return { ok: true, error: null, days, totals, topCustomers };
}

function createBroadcast(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null; recipientCount: number } {
  const admin = requireAdmin(env, args);
  const title = reqString(args, "title", 200).trim();
  const message = reqString(args, "message", 2000).trim();
  const customers = env.store.listUsersByRole("user");
  const id = env.store.insertBroadcast({
    title,
    message,
    recipientCount: customers.length,
  });
  if (!id) return { ok: false, error: "Could not send the announcement — please try again.", recipientCount: 0 };
  for (const c of customers) {
    createNotification(env, {
      userId: c.id,
      anonId: null,
      type: "announcement",
      title,
      message,
    });
  }
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "broadcast.send", detail: `“${title}” sent to ${customers.length} customers.` });
  return { ok: true, error: null, recipientCount: customers.length };
}

function listBroadcasts(env: Env, args: unknown): {
  broadcasts: {
    id: number;
    title: string;
    message: string;
    recipientCount: number;
    createdAt: string;
  }[];
} {
  requireAdmin(env, args);
  return {
    broadcasts: env.store.listBroadcasts(50).map((r) => ({
      id: r.id,
      title: r.title,
      message: r.message,
      recipientCount: r.recipientCount,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function getSecurityOverview(env: Env, args: unknown): {
  totpEnabled: boolean;
  sessions: {
    tokenPrefix: string;
    email: string;
    role: string;
    isCurrent: boolean;
    createdAt: string;
    lastSeenAt: string | null;
  }[];
  lockedAccounts: {
    email: string;
    failedCount: number;
    lockedUntil: string | null;
  }[];
} {
  const admin = requireAdmin(env, args);
  const adminUser = env.store.getUserById(admin.id);
  const now = Date.now();
  const sessRows = env.store
    .listSessions()
    .filter((s) => s.expiresAt.getTime() >= now);
  const sessions: {
    tokenPrefix: string;
    email: string;
    role: string;
    isCurrent: boolean;
    createdAt: string;
    lastSeenAt: string | null;
  }[] = [];
  for (const s of sessRows) {
    const u = env.store.getUserById(s.userId);
    if (!u) continue;
    sessions.push({
      tokenPrefix: `${s.token.slice(0, 8)}…`,
      email: u.email,
      role: u.role,
      isCurrent: optToken(args) === s.token,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
    });
  }
  const locks = env.store.listLoginAttempts();
  const lockedAccounts = locks
    .filter((l) => l.lockedUntil && l.lockedUntil.getTime() > now)
    .map((l) => ({
      email: l.email,
      failedCount: l.failedCount,
      lockedUntil: l.lockedUntil ? l.lockedUntil.toISOString() : null,
    }));
  return {
    totpEnabled: adminUser?.totpEnabled ?? false,
    sessions,
    lockedAccounts,
  };
}

function revokeSession(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const tokenPrefix = reqString(args, "tokenPrefix", 20).trim();
  if (tokenPrefix.length < 8) {
    throw new HandlerError(400, "tokenPrefix must be at least 8 characters");
  }
  const prefix = tokenPrefix.replace(/…$/, "");
  const rows = env.store.listSessions();
  const match = rows.find((s) => s.token.startsWith(prefix));
  if (!match) return { ok: false, error: "Session not found — it may already be gone." };
  if (optToken(args) && match.token === optToken(args)) {
    return { ok: false, error: "You cannot revoke your own current session." };
  }
  const u = env.store.getUserById(match.userId);
  env.store.deleteSession(match.token);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "security.session_revoke", detail: `Session revoked for ${u?.email ?? `user #${match.userId}`}.` });
  return { ok: true, error: null };
}

function startTotpSetup(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null; secret: string | null; otpauthUrl: string | null } {
  const admin = requireAdmin(env, args);
  const secret = generateTotpSecret();
  env.store.updateUserTotp(admin.id, { totpSecret: secret });
  return { ok: true, error: null, secret, otpauthUrl: totpAuthUrl(secret, admin.email) };
}

function confirmTotpSetup(
  env: Env,
  args: unknown,
): { ok: boolean; error: string | null } {
  const admin = requireAdmin(env, args);
  const code = reqString(args, "code", 10).trim();
  const u = env.store.getUserById(admin.id);
  if (!u || !u.totpSecret) {
    return { ok: false, error: "Start 2FA setup first — no secret was generated." };
  }
  if (!verifyTotp(u.totpSecret, code)) {
    return { ok: false, error: "That code is not correct. Check the authenticator app and try again." };
  }
  env.store.updateUserTotp(admin.id, { totpEnabled: true });
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "security.totp_enabled", detail: "Two-factor authentication enabled for the admin account." });
  return { ok: true, error: null };
}

async function disableTotp(
  env: Env,
  args: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const admin = requireAdmin(env, args);
  const password = reqString(args, "password", 200);
  const code = reqString(args, "code", 10).trim();
  const u = env.store.getUserById(admin.id);
  if (!u) return { ok: false, error: "Admin account not found." };
  if (!(await verifyPassword(password, u.passwordHash))) {
    return { ok: false, error: "The password is incorrect." };
  }
  if (!u.totpEnabled || !u.totpSecret || !verifyTotp(u.totpSecret, code)) {
    return { ok: false, error: "That code is not correct." };
  }
  env.store.updateUserTotp(admin.id, { totpEnabled: false, totpSecret: null });
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "security.totp_disabled", detail: "Two-factor authentication disabled for the admin account." });
  return { ok: true, error: null };
}

async function resetCustomerPassword(
  env: Env,
  args: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const admin = requireAdmin(env, args);
  const userId = reqInt(args, "userId");
  const newPassword = reqString(args, "newPassword", 200);
  if (newPassword.length < 8) {
    return { ok: false, error: "The new password must be at least 8 characters." };
  }
  const u = env.store.getUserById(userId);
  if (!u || u.role !== "user") {
    return { ok: false, error: "Customer not found." };
  }
  env.store.updateUserPassword(userId, await hashPassword(newPassword));
  env.store.deleteSessionsForUser(userId);
  logEvent(env, { actorType: "admin", actorEmail: admin.email, action: "customer.password_reset", detail: `${u.email} — password reset by the admin (sessions revoked).` });
  return { ok: true, error: null };
}

export type ActionHandler = (env: Env, args: unknown) => Promise<unknown> | unknown;

export const ACTIONS: Record<string, ActionHandler> = {
  resolveLink,
  resolveDouyinLink,
  prepareDownload,
  getSettings,
  getSiteSeo,
  getSeoSettings,
  saveSeoSettings,
  saveSmartLink,
  clearSmartLink,
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
  listHelpArticles,
  createHelpArticle,
  updateHelpArticle,
  deleteHelpArticle,
  createTicket,
  listMyTickets,
  getTicket,
  replyTicket,
  closeTicket,
  listAllTickets,
  getAdminTicket,
  replyTicketAdmin,
  setTicketStatus,
  listSystemLogs,
  exportBackup,
  restoreBackup,
  getReports,
  createBroadcast,
  listBroadcasts,
  getSecurityOverview,
  revokeSession,
  startTotpSetup,
  confirmTotpSetup,
  disableTotp,
  resetCustomerPassword,
};
