import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import JSZip from "jszip";
import QRCode from "qrcode";
import { SafeAreaTopScrim } from "./safe-area";
import { api, type ApiResponse } from "./api";
import { injectAdCode, injectHeadCode } from "./adInject";
import {
  LangProvider,
  PrefsProvider,
  applyTheme,
  getLocalLang,
  getLocalTheme,
  setLocalLang,
  setLocalTheme,
  usePrefs,
  useT,
  type Lang,
  type Theme,
} from "./i18n";

const FIELDS = {
  resolveLink: { text: {} },
  resolveDouyinLink: { text: {} },
  saveApiKey: { apiKey: {}, apiBaseUrl: {} },
  saveAdCode: { code: {} },
  saveSmartLink: { url: {} },
  saveSeoSettings: { title: {}, description: {}, keywords: {} },
  submitContact: { name: {}, email: {}, message: {} },
  register: { name: {}, email: {}, password: {} },
  login: { email: {}, password: {} },
  userLogin: { email: {}, password: {} },
  assignPlan: { durationDays: {}, downloadLimit: {} },
  createPlan: { name: {}, durationDays: {}, downloadLimit: {}, description: {} },
  recordPayment: { amountCents: {}, method: {}, note: {} },
  saveAdminSettings: { freeDailyLimit: {} },
  toggleFavorite: { downloadId: {}, label: {} },
  listFavorites: { limit: {} },
  removeFavorite: { id: {} },
  updateProfileName: { name: {} },
  changeUserPassword: { currentPassword: {}, newPassword: {} },
  getDownloadSettings: {},
  saveDownloadSettings: { defaultQuality: {}, defaultMode: {} },
  listNotifications: { limit: {} },
  markNotificationRead: { id: {} },
  markAllNotificationsRead: {},
  deleteNotification: { id: {} },
  createTicket: { subject: {}, message: {} },
  replyTicket: { message: {} },
  replyTicketAdmin: { message: {} },
  createHelpArticle: { title: {}, category: {}, body: {} },
} as const;

type ResolveResult = ApiResponse<typeof api, "resolveLink">;
type AdminMeResult = ApiResponse<typeof api, "adminMe">;
type AdminUser = NonNullable<AdminMeResult["admin"]>;
type MeResult = ApiResponse<typeof api, "me">;
type MeUser = NonNullable<MeResult["user"]>;
type View =
  | "home"
  | "jimeng"
  | "douyin"
  | "history"
  | "favorites"
  | "profile"
  | "download-settings"
  | "notifications"
  | "plans"
  | "auth"
  | "myplan"
  | "whatis"
  | "howto"
  | "faq"
  | "help"
  | "tickets"
  | "report"
  | "terms"
  | "copyright"
  | "disclaimer"
  | "bulk"
  | "sora"
  | "about"
  | "privacy"
  | "contact"
  | "admin";
type AdSlotKey = "head" | "top" | "incontent" | "sidebar" | "bottom" | "socialbar" | "mobile";

/** Admin session token storage — the token lives in the browser only; the
 *  server validates it on every admin action. Downloads are public and
 *  need no login. */
const TOKEN_KEY = "jimeng_admin_token";
function getToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode / storage blocked — the admin just stays logged out.
  }
}

/** Customer session token — same 30-day token system as the admin login,
 *  but for a customer account (needed to buy a plan). */
const USER_TOKEN_KEY = "jimeng_user_token";
function getUserToken(): string | undefined {
  try {
    return localStorage.getItem(USER_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function setUserToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(USER_TOKEN_KEY, token);
    else localStorage.removeItem(USER_TOKEN_KEY);
  } catch {
    // Private mode / storage blocked — the customer just stays logged out.
  }
}

/** Anonymous browser id for the free daily limit. The artifact runtime
 *  does not expose the visitor's IP address to server actions, so the
 *  free limit for visitors without an account is counted per browser
 *  instead: a random id stored in localStorage, created once. Clearing
 *  browser data resets it — the same limitation as any cookie-based
 *  limit. Logged-in customers are always counted per account. */
const ANON_ID_KEY = "jimeng_anon_id";
function getAnonId(): string {
  try {
    let id = localStorage.getItem(ANON_ID_KEY);
    if (!id) {
      id =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(ANON_ID_KEY, id);
    }
    return id;
  } catch {
    return "anon-unavailable";
  }
}

/** Download preferences (Phase 2 + Phase 5). Logged-in customers keep
 *  them on their account (server); anonymous visitors keep the same
 *  preferences in this browser's localStorage. Quality values are real
 *  options only — "best" means the default first option (720p Origin).
 *  Theme + language live here too (Phase 5): localStorage is the
 *  first-paint source, the account value is applied once it loads. */
type QualityPref = "best" | "original" | "720p" | "480p" | "360p";
type DownloadModePref = "single" | "bulk";
type DownloadSettingsPref = { defaultQuality: QualityPref; defaultMode: DownloadModePref; theme: Theme; language: Lang };
const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettingsPref = { defaultQuality: "best", defaultMode: "single", theme: "dark", language: "en" };
const QUALITY_OPTIONS: { value: QualityPref; label: string }[] = [
  { value: "best", label: "Best available (720p Origin)" },
  { value: "original", label: "Original master" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "360p", label: "360p" },
];

const LOCAL_SETTINGS_KEY = "jimeng_download_settings";
function getLocalDownloadSettings(): DownloadSettingsPref {
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_DOWNLOAD_SETTINGS, theme: getLocalTheme(), language: getLocalLang() };
    const parsed = JSON.parse(raw) as Partial<DownloadSettingsPref>;
    const quality = QUALITY_OPTIONS.some((o) => o.value === parsed.defaultQuality)
      ? (parsed.defaultQuality as QualityPref)
      : "best";
    const mode: DownloadModePref = parsed.defaultMode === "bulk" ? "bulk" : "single";
    return { defaultQuality: quality, defaultMode: mode, theme: getLocalTheme(), language: getLocalLang() };
  } catch {
    return { ...DEFAULT_DOWNLOAD_SETTINGS, theme: getLocalTheme(), language: getLocalLang() };
  }
}
function setLocalDownloadSettings(pref: DownloadSettingsPref): void {
  try {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify({ defaultQuality: pref.defaultQuality, defaultMode: pref.defaultMode }));
    setLocalTheme(pref.theme);
    setLocalLang(pref.language);
  } catch {
    /* storage blocked — the preference just doesn't stick */
  }
}

/** The install prompt the browser fires when the site is installable
 *  as a PWA. Stored (not auto-shown) so the Install button appears only
 *  when the browser really offers installation — never a fake button. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** Index of the video matching a saved quality preference, falling back
 *  to the best available (index 0) when the preferred quality does not
 *  exist for this video. */
function pickVideoIndex(videos: { label: string }[], pref: QualityPref): number {
  if (videos.length === 0) return 0;
  if (pref === "best") return 0;
  if (pref === "original") {
    const i = videos.findIndex((v) => v.label.toLowerCase().startsWith("original"));
    return i >= 0 ? i : 0;
  }
  const i = videos.findIndex((v) => v.label.includes(pref));
  return i >= 0 ? i : 0;
}

/** Effective download preferences for this visitor: a logged-in
 *  customer's server settings (once loaded), otherwise the browser's
 *  localStorage settings. */
function useDownloadSettings(): DownloadSettingsPref {
  const loggedIn = Boolean(getUserToken());
  const server = useQuery({
    queryKey: ["download-settings"],
    queryFn: () => api.getDownloadSettings({ token: getUserToken() }),
    enabled: loggedIn,
  });
  if (loggedIn) {
    if (server.data) {
      return {
        defaultQuality: server.data.defaultQuality as QualityPref,
        defaultMode: server.data.defaultMode as DownloadModePref,
        theme: (server.data.theme === "light" ? "light" : "dark") as Theme,
        language: (server.data.language === "ur" ? "ur" : "en") as Lang,
      };
    }
    return DEFAULT_DOWNLOAD_SETTINGS;
  }
  return getLocalDownloadSettings();
}

/** Applies the site's SEO title/description/keywords (admin-editable in
 *  Admin → Settings → SEO) to the document on load. The static meta tags
 *  in index.html carry the same defaults, so the page is never bare. */
function useSeo(): void {
  useEffect(() => {
    let cancelled = false;
    api.getSiteSeo({}).then((seo) => {
      if (cancelled) return;
      document.title = seo.title;
      const setMeta = (selector: string, content: string) => {
        const el = document.querySelector<HTMLMetaElement>(selector);
        if (el) el.setAttribute("content", content);
      };
      setMeta('meta[name="description"]', seo.description);
      setMeta('meta[name="keywords"]', seo.keywords);
      setMeta('meta[property="og:title"]', seo.title);
      setMeta('meta[property="og:description"]', seo.description);
      setMeta('meta[name="twitter:title"]', seo.title);
      setMeta('meta[name="twitter:description"]', seo.description);
    }).catch(() => {
      /* offline — the static meta tags in index.html stay in place */
    });
    return () => {
      cancelled = true;
    };
  }, []);
}

const AD_SLOTS: { key: AdSlotKey; label: string; size: string }[] = [
  { key: "top", label: "Top Banner", size: "728 × 90 · Leaderboard" },
  { key: "incontent", label: "In-Content", size: "Native Banner · In-article" },
  { key: "sidebar", label: "Sidebar", size: "300 × 250 · Rectangle" },
  { key: "bottom", label: "Bottom Banner", size: "728 × 90 · Leaderboard" },
  { key: "mobile", label: "Mobile Banner", size: "320 × 50 · Mobile only" },
  { key: "head", label: "Head Code", size: "Site-wide · Popunder / verification" },
  { key: "socialbar", label: "Social Bar", size: "Site-wide · Floating corner bar" },
];

type PreparedSave = {
  tag: string;
  /** Same-origin URL of the file our server fetched and stored. */
  url: string;
  filename: string;
  sizeBytes: number;
};

/**
 * A file our server prepared for saving. The previous flow fetched the file
 * into a blob: object URL and clicked a temporary anchor from code — inside
 * the phone's app webview that click silently does nothing (the video kept
 * "not downloading" even though the code reported success). So saving is now
 * a real element the user taps themselves: a same-origin link with a
 * `download` filename (the browser / download manager handles a real tap on
 * a real URL), plus a Web Share button that hands the actual file bytes to
 * the system share sheet ("Save to Files" / gallery apps) on phones that
 * support sharing files.
 */
function SavePanel({
  prepared,
  onShare,
}: {
  prepared: PreparedSave;
  onShare: () => void;
}) {
  const t = useT();
  const size = formatBytes(prepared.sizeBytes);
  return (
    <div
      className="mt-3 border border-[var(--accent)] bg-[var(--surface-alt)] p-3"
      style={{ borderRadius: "var(--radius)" }}
    >
      <p className="text-sm font-bold">
        ✓ {t("save.ready")}{size ? ` (${size})` : ""}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <a
          href={prepared.url}
          download={prepared.filename}
          className="flex-1 bg-[var(--accent)] px-4 py-2.5 text-center text-sm font-extrabold text-[var(--accent-ink)]"
          style={{ borderRadius: "var(--radius)" }}
        >
          {t("save.download_now")}
        </a>
        <button
          type="button"
          onClick={onShare}
          className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
          style={{ borderRadius: "var(--radius)" }}
        >
          📤 {t("save.share")}
        </button>
        <a
          href={prepared.url}
          target="_blank"
          rel="noopener"
          className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-center text-sm font-extrabold"
          style={{ borderRadius: "var(--radius)" }}
        >
          {t("save.open_tab")}
        </a>
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        {t("save.hint")}
      </p>
    </div>
  );
}

function formatBytes(n: number | null): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/** Design-style ad slot. With no saved code it stays the dashed "Ad
 *  Space" placeholder; with code, the snippet is injected with real
 *  script elements (see client/src/adInject.ts) — scripts set through
 *  innerHTML would never execute, so the ad would never earn. The
 *  injected ad loads async and never blocks the download flow. On a
 *  narrow phone a 728 px banner scrolls sideways inside the slot instead
 *  of breaking the page layout. */
function AdSlot({ label, sub, saved, tall, code }: { label: string; sub?: string; saved: boolean; tall?: boolean; code?: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!code) {
      host.replaceChildren();
      return;
    }
    injectAdCode(host, code);
    return () => {
      host.replaceChildren();
    };
  }, [code]);
  if (!code) {
    return (
      <div
        role="complementary"
        aria-label={`Ad space: ${label}`}
        className={`glass flex flex-col items-center justify-center gap-1 border-2 border-dashed border-[var(--ad-border)] bg-[var(--surface-alt)] px-4 text-center ${tall ? "min-h-64 py-8" : "min-h-24 py-4"}`}
        style={{ borderRadius: "var(--radius)" }}
      >
        <p className="text-xs font-bold tracking-[0.18em] text-[var(--dim)] uppercase">{label}</p>
        {sub && <p className="text-xs text-[var(--dim)]">{sub}</p>}
        {saved ? (
          <p className="text-xs font-semibold text-[var(--accent)]">✓ AdSense code saved — your ad will appear here</p>
        ) : (
          <p className="text-xs text-[var(--dim)]">Your Google AdSense ad will appear here</p>
        )}
      </div>
    );
  }
  return (
    <div
      role="complementary"
      aria-label={`Advertisement: ${label}`}
      className="w-full"
      style={{ maxWidth: "100%", overflowX: "auto" }}
    >
      <p className="mb-1 text-center text-[10px] font-bold tracking-[0.18em] text-[var(--dim)] uppercase">Advertisement</p>
      <div className="mx-auto w-fit max-w-full">
        <div ref={hostRef} />
      </div>
    </div>
  );
}

/** Injects a saved site-wide ad script (Head slot / Social Bar) into
 *  document.head once the settings load; removes it again on change or
 *  unmount. Renders nothing visible — the ad script builds its own
 *  floating bar. The script loads async and never blocks the page or a
 *  download. */
function SiteWideAdCode({ code }: { code?: string | null }) {
  useEffect(() => {
    if (!code) return;
    return injectHeadCode(code);
  }, [code]);
  return null;
}

/** The owner's Adsterra smart link, as a clearly labelled banner on the
 *  Jimeng downloader page only — below the video result, never over or
 *  above any Download button. Clicking opens it in a new tab; the
 *  download flow is untouched. Renders nothing when the link is
 *  disabled or removed, so there is never an empty box. */
function SmartLinkBanner({ smartLink }: { smartLink: { url: string | null; enabled: boolean } | undefined }) {
  const t = useT();
  if (!smartLink?.url || !smartLink.enabled) return null;
  return (
    <a
      href={smartLink.url}
      target="_blank"
      rel="noopener noreferrer"
      className="glass mt-4 flex items-center justify-center gap-2 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-3 text-center text-sm font-bold"
      style={{ borderRadius: "var(--radius)" }}
    >
      <span className="bg-[var(--surface)] px-2 py-0.5 text-[11px] font-extrabold tracking-[0.14em] text-[var(--dim)] uppercase" style={{ borderRadius: 999 }}>
        {t("ads.sponsored")}
      </span>
      <span>{t("ads.sponsored_note")}</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function SectionCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`glass border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg shadow-black/30 ${className}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      {children}
    </section>
  );
}

/** Shared page header used by every User Panel page: centered icon,
 *  bold title and a short subtitle — the reference mockups all open
 *  their pages this way. */
function PageHero({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }) {
  return (
    <div className="animate-fade-up pt-4 text-center sm:pt-8">
      <span className="mx-auto flex h-14 w-14 items-center justify-center border border-[rgba(0,233,154,0.4)] bg-[rgba(0,233,154,0.10)] text-2xl shadow-[0_0_28px_rgba(0,233,154,0.18)]" style={{ borderRadius: 999 }}>
        {icon}
      </span>
      <h1 className="text-gradient mt-4 text-3xl font-extrabold sm:text-4xl">{title}</h1>
      {subtitle && <p className="mx-auto mt-2 max-w-xl text-base text-[var(--dim)]">{subtitle}</p>}
    </div>
  );
}

/** Status pill — green (paid/active/done), amber (pending/fetching),
 *  red (rejected/error), gray (waiting). */
function StatusPill({ tone, label, pulse = false }: { tone: "green" | "amber" | "red" | "gray"; label: string; pulse?: boolean }) {
  const tones = {
    green: "border-[rgba(0,233,154,0.45)] bg-[rgba(0,233,154,0.12)] text-[var(--accent)]",
    amber: "border-[rgba(251,191,36,0.45)] bg-[rgba(245,158,11,0.12)] text-[var(--warn-text)]",
    red: "border-[rgba(248,113,113,0.45)] bg-[var(--err-bg)] text-[var(--err-text)]",
    gray: "border-[var(--border)] bg-[var(--surface-alt)] text-[var(--dim)]",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-extrabold whitespace-nowrap ${tones[tone]}`} style={{ borderRadius: 999 }}>
      {pulse && <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-current" />}
      {label}
    </span>
  );
}

/** Skeleton loading block. */
function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton h-4 w-full ${className}`} aria-hidden="true">&nbsp;</div>;
}

/** Feature strip from the reference: Lightning Fast, Secure & Safe,
 *  Fully Responsive, Modern Design, Free Forever. */
function FeatureStrip() {
  const t = useT();
  const items = [
    { icon: "⚡", title: t("home.feat_1_title"), sub: t("home.feat_1_sub") },
    { icon: "🛡", title: t("home.feat_2_title"), sub: t("home.feat_2_sub") },
    { icon: "📱", title: t("home.feat_3_title"), sub: t("home.feat_3_sub") },
    { icon: "💎", title: t("home.feat_4_title"), sub: t("home.feat_4_sub") },
    { icon: "⭐", title: t("home.feat_5_title"), sub: t("home.feat_5_sub") },
  ];
  return (
    <div className="glass mt-8 grid grid-cols-2 gap-4 border border-[var(--border)] bg-[var(--surface)] px-4 py-5 sm:grid-cols-3 lg:grid-cols-5" style={{ borderRadius: "var(--radius)" }}>
      {items.map((f) => (
        <div key={f.title} className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden="true">{f.icon}</span>
          <span>
            <span className="block text-sm font-extrabold">{f.title}</span>
            <span className="block text-xs text-[var(--dim)]">{f.sub}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Green brand banner shown above the footer links. */
function BrandBanner() {
  const t = useT();
  return (
    <div className="cta-gradient flex flex-col items-center justify-between gap-3 px-6 py-5 text-center sm:flex-row sm:text-left" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-black/20 text-xl text-[var(--accent-ink)]" style={{ borderRadius: 12 }}>▶</span>
        <div>
          <p className="text-xl font-extrabold text-[var(--accent-ink)]">{t("home.brand_title")}</p>
          <p className="text-sm font-bold text-[var(--accent-ink)]/80">{t("home.brand_sub")}</p>
        </div>
      </div>
      <p className="text-sm font-extrabold whitespace-nowrap text-[var(--accent-ink)]">{t("home.brand_tag")}</p>
    </div>
  );
}

/** Play-triangle logo from the design: green-to-teal gradient triangle
 *  with "JIMENG" in white and "DOWNLOADER" in neon green below it. */
function Logo({ compact = false }: { compact?: boolean }) {
  const gid = useId();
  return (
    <span className="flex items-center gap-2.5">
      <svg width={compact ? 30 : 38} height={compact ? 30 : 38} viewBox="0 0 40 40" aria-hidden="true" className="shrink-0">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2bffa0" />
            <stop offset="55%" stopColor="#00e99a" />
            <stop offset="100%" stopColor="#00b4d8" />
          </linearGradient>
        </defs>
        <path d="M20 2 36 11v18L20 38 4 29V11Z" fill={`url(#${gid})`} opacity="0.18" />
        <path d="M15 11.5v17l14-8.5Z" fill={`url(#${gid})`} />
      </svg>
      <span className="flex flex-col leading-none">
        <span className="text-lg font-extrabold tracking-wide text-[var(--text)]">JIMENG</span>
        <span className="mt-0.5 text-[11px] font-extrabold tracking-[0.22em] text-[var(--accent)]">DOWNLOADER</span>
      </span>
    </span>
  );
}

/** Decorative hero art from the design: a large glowing play-triangle ring
 *  on the left and a clapperboard with a play button + green download
 *  arrow on the right. Purely decorative — hidden on small screens. */
function HeroArt() {
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2 hidden -translate-y-1/2 xl:block">
        <svg width="150" height="150" viewBox="0 0 150 150" className="opacity-25">
          <defs>
            <linearGradient id="hero-play" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#2bffa0" />
              <stop offset="100%" stopColor="#00b4d8" />
            </linearGradient>
          </defs>
          <circle cx="75" cy="75" r="72" fill="none" stroke="url(#hero-play)" strokeWidth="2" />
          <circle cx="75" cy="75" r="58" fill="none" stroke="url(#hero-play)" strokeWidth="1" opacity="0.6" />
          <path d="M60 45v60l52-30Z" fill="url(#hero-play)" />
        </svg>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 xl:block">
        <svg width="150" height="122" viewBox="0 0 160 130" className="opacity-90">
          <defs>
            <clipPath id="slat-clip">
              <rect x="18" y="24" width="124" height="18" rx="5" />
            </clipPath>
          </defs>
          <g transform="rotate(-7 80 33)">
            <rect x="18" y="24" width="124" height="18" rx="5" fill="#1b2c42" stroke="rgba(148,163,184,0.4)" />
            <g clipPath="url(#slat-clip)" fill="#e8f1f8">
              <polygon points="28,24 44,24 34,42 18,42" />
              <polygon points="58,24 74,24 64,42 48,42" />
              <polygon points="88,24 104,24 94,42 78,42" />
              <polygon points="118,24 134,24 124,42 108,42" />
            </g>
          </g>
          <rect x="18" y="44" width="124" height="72" rx="10" fill="#0d1826" stroke="rgba(148,163,184,0.4)" />
          <path d="M66 62v36l32-18Z" fill="#e8f1f8" />
          <circle cx="128" cy="104" r="16" fill="#00e99a" />
          <path d="M128 96v13m-6-6 6 6 6-6" stroke="#03130a" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
}

const MENU_ITEMS: { view: View; label: string; icon: string; badge?: string }[] = [
  { view: "home", label: "menu.home", icon: "🏠" },
  { view: "jimeng", label: "menu.jimeng", icon: "🎬" },
  { view: "douyin", label: "menu.douyin", icon: "🎵" },
  { view: "history", label: "menu.history", icon: "🕘" },
  { view: "favorites", label: "menu.favorites", icon: "❤️" },
  { view: "notifications", label: "menu.notifications", icon: "🔔" },
  { view: "plans", label: "menu.plans", icon: "💎" },
  { view: "download-settings", label: "menu.download_settings", icon: "⚙️" },
  { view: "whatis", label: "menu.whatis", icon: "❓" },
  { view: "howto", label: "menu.howto", icon: "📖" },
  { view: "faq", label: "menu.faq", icon: "💬" },
  { view: "help", label: "menu.help", icon: "🆘" },
  { view: "tickets", label: "menu.tickets", icon: "🎫" },
  { view: "report", label: "menu.report", icon: "⚠️" },
  { view: "bulk", label: "menu.bulk", icon: "📦" },
  { view: "sora", label: "menu.sora", icon: "🎬", badge: "menu.coming_soon" },
  { view: "contact", label: "menu.contact", icon: "✉️" },
  { view: "about", label: "menu.about", icon: "ℹ️" },
  { view: "privacy", label: "menu.privacy", icon: "🔒" },
  { view: "terms", label: "menu.terms", icon: "📜" },
  { view: "copyright", label: "menu.copyright", icon: "©️" },
  { view: "disclaimer", label: "menu.disclaimer", icon: "⚖️" },
];

/** Heart toggle for one history video. Shows the filled heart when the
 *  video is already a favourite; the server decides the state, so the
 *  button never lies about it. */
function FavoriteButton({ downloadId, label }: { downloadId: number | null; label?: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const favorites = useQuery({
    queryKey: ["favorites"],
    queryFn: () => api.listFavorites({ limit: 50, token: getUserToken(), anonId: getAnonId() }),
  });
  const isFav = downloadId !== null && (favorites.data?.items.some((f) => f.downloadId === downloadId) ?? false);
  const mut = useMutation({
    mutationFn: () =>
      api.toggleFavorite({ downloadId: downloadId!, label, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["favorites"] });
    },
  });
  if (downloadId === null) return null;
  return (
    <button
      type="button"
      disabled={mut.isPending}
      onClick={() => mut.mutate()}
      aria-pressed={isFav}
      aria-label={isFav ? t("fav.aria_remove") : t("fav.aria_add")}
      className={`border px-3 py-1.5 text-xs font-extrabold disabled:opacity-50 ${isFav ? "border-[rgba(248,113,113,0.5)] text-[var(--err-text)]" : "border-[var(--border)]"}`}
      style={{ borderRadius: 8 }}
    >
      {isFav ? t("fav.remove") : t("fav.add")}
    </button>
  );
}

/** Phase 5 — outer shell: owns the theme + language state and provides
 *  it (and the translation function) to the whole tree. localStorage is
 *  the first-paint source (index.html sets data-theme before CSS
 *  renders); the account value is applied by AppShell once it loads. */
export function App() {
  const [theme, setThemeState] = useState<Theme>(() => getLocalTheme());
  const [lang, setLangState] = useState<Lang>(() => getLocalLang());
  return (
    <PrefsProvider value={{ theme, lang, setTheme: setThemeState, setLang: setLangState }}>
      <LangProvider value={lang}>
        <AppShell />
      </LangProvider>
    </PrefsProvider>
  );
}

function AppShell() {
  const t = useT();
  const { theme, lang, setTheme, setLang } = usePrefs();
  const [view, setView] = useState<View>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const queryClient = useQueryClient();

  // --- Admin session: login is admin-only. Downloads are public and need
  // no account. The token is stored in the browser and validated by the
  // server on every admin action.
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [adminChecked, setAdminChecked] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setAdminChecked(true);
      return;
    }
    api.adminMe({ token }).then((data) => {
      if (data.ok && data.admin) setAdmin(data.admin);
      else setToken(null);
    }).catch(() => {
      /* offline — stay logged out until the server answers */
    }).finally(() => setAdminChecked(true));
  }, []);

  async function handleLogout() {
    const token = getToken();
    setToken(null);
    setAdmin(null);
    setView("home");
    setMenuOpen(false);
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    if (token) {
      try { await api.adminLogout({ token }); } catch { /* already signed out */ }
    }
  }

  // --- Customer session: an account is only needed to buy a plan.
  // Downloads are public and need no account. The token is stored in the
  // browser and validated by the server on every account action.
  const [user, setUser] = useState<MeUser | null>(null);
  const [userChecked, setUserChecked] = useState(false);

  useEffect(() => {
    const token = getUserToken();
    if (!token) {
      setUserChecked(true);
      return;
    }
    api.me({ token }).then((data) => {
      if (data.ok && data.user) setUser(data.user);
      else setUserToken(null);
    }).catch(() => {
      /* offline — stay logged out until the server answers */
    }).finally(() => setUserChecked(true));
  }, []);

  async function handleUserLogout() {
    const token = getUserToken();
    setUserToken(null);
    setUser(null);
    setView("home");
    setMenuOpen(false);
    queryClient.invalidateQueries({ queryKey: ["me"] });
    if (token) {
      try { await api.logout({ token }); } catch { /* already signed out */ }
    }
  }

  function handleUserLoggedIn(u: MeUser) {
    setUser(u);
    setUserChecked(true);
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["history"] });
  }

  const meQuery = useQuery({ queryKey: ["me"], queryFn: () => api.me({ token: getUserToken() }) });

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({ token: getToken() }) });
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.listHistory({ limit: 30, token: getUserToken(), anonId: getAnonId() }) });
  const historyCount = history.data?.items.length ?? 0;
  const dlSettings = useDownloadSettings();

  // Phase 5 — SEO meta from the server (admin-editable in Settings).
  useSeo();

  // Phase 5 — theme: keep <html data-theme> in sync with the state.
  // The first paint already applied the localStorage value from the
  // inline script in index.html; this only runs on later changes.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Phase 5 — when a customer logs in, their account theme + language
  // win over this browser's values (same rule as the download quality /
  // mode preference). Runs once per login.
  const prefsSyncedRef = useRef(false);
  useEffect(() => {
    if (!user || prefsSyncedRef.current) return;
    prefsSyncedRef.current = true;
    api.getDownloadSettings({ token: getUserToken() }).then((s) => {
      const serverTheme = (s.theme === "light" ? "light" : "dark") as Theme;
      const serverLang = (s.language === "ur" ? "ur" : "en") as Lang;
      if (serverTheme !== getLocalTheme()) {
        setTheme(serverTheme);
        setLocalTheme(serverTheme);
      }
      if (serverLang !== getLocalLang()) {
        setLang(serverLang);
        setLocalLang(serverLang);
      }
    }).catch(() => {
      /* offline — the browser values stay */
    });
  }, [user, setTheme, setLang]);

  // Phase 5 — PWA install prompt: the browser fires
  // beforeinstallprompt when the site is installable. We store the
  // event (never auto-show it); the Install button renders only while
  // it is set, so it never appears where installation is impossible.
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  async function handleInstallApp() {
    if (!installEvt) return;
    try {
      await installEvt.prompt();
      await installEvt.userChoice;
    } catch {
      /* dismissed or unsupported — the button just stays hidden next time */
    }
    setInstallEvt(null);
  }

  /** Saves a theme change: localStorage right away (no flash), and the
   *  account too when logged in. */
  async function changeTheme(next: Theme) {
    setTheme(next);
    setLocalTheme(next);
    applyTheme(next);
    if (user) {
      try {
        await api.saveDownloadSettings({
          defaultQuality: dlSettings.defaultQuality,
          defaultMode: dlSettings.defaultMode,
          theme: next,
          language: lang,
          token: getUserToken(),
        });
        queryClient.invalidateQueries({ queryKey: ["download-settings"] });
      } catch {
        /* offline — the browser value already applied */
      }
    }
  }

  /** Saves a language change the same way as the theme. */
  async function changeLang(next: Lang) {
    setLang(next);
    setLocalLang(next);
    if (user) {
      try {
        await api.saveDownloadSettings({
          defaultQuality: dlSettings.defaultQuality,
          defaultMode: dlSettings.defaultMode,
          theme,
          language: next,
          token: getUserToken(),
        });
        queryClient.invalidateQueries({ queryKey: ["download-settings"] });
      } catch {
        /* offline — the browser value already applied */
      }
    }
  }

  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSave | null>(null);
  const preparedBlobRef = useRef<{ tag: string; blob: Blob } | null>(null);

  function go(next: View) {
    setView(next);
    setMenuOpen(false);
  }

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  /**
   * Step 1 of saving: our server fetches the Jimeng CDN file and stores it,
   * then the file bytes are pulled into this page so the Share button can
   * hand the real file to the system. The actual save happens when the user
   * taps one of the SavePanel controls — no programmatic click is trusted
   * to save anything, and no success is claimed before the user saves.
   */
  async function handleDownload(url: string, filename: string, tag: string) {
    setDownloading(tag);
    setDownloadNote("Fetching the file from the server…");
    setPrepared(null);
    preparedBlobRef.current = null;
    try {
      const prep = await api.prepareDownload({ url, token: getUserToken(), anonId: getAnonId() });
      if (prep.ok && prep.downloadUrl) {
        let blob: Blob | null = null;
        try {
          const res = await fetch(prep.downloadUrl);
          if (res.ok) blob = await res.blob();
        } catch {
          /* the direct link / new-tab options still work without the bytes */
        }
        preparedBlobRef.current = blob ? { tag, blob } : null;
        setPrepared({ tag, url: prep.downloadUrl, filename, sizeBytes: prep.sizeBytes });
        setDownloadNote(null);
        queryClient.invalidateQueries({ queryKey: ["me"] });
      } else {
        setDownloadNote(prep.error ?? "The file could not be prepared — please try again.");
        // Free daily limit reached → open the Plans page automatically so
        // the user can see the paid plans right away.
        if (prep.limitReached) {
          queryClient.invalidateQueries({ queryKey: ["me"] });
          setView("plans");
          setMenuOpen(false);
        }
      }
    } catch {
      setDownloadNote("The file could not be loaded from the server — check your internet and try again.");
    }
    setDownloading(null);
  }

  /** Step 2 (phone path): hand the prepared file to the system share sheet. */
  async function handleShareSave(tag: string) {
    const p = prepared;
    const held = preparedBlobRef.current;
    if (!p || p.tag !== tag) return;
    if (!held || held.tag !== tag) {
      setDownloadNote("The file bytes didn't load into the page — use “Download Now” or the “new tab” option instead.");
      return;
    }
    const file = new File([held.blob], p.filename, {
      type: held.blob.type || "video/mp4",
    });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: p.filename });
        setDownloadNote("Sent via the share sheet — if you didn't save it there, the file is still ready below and you can try again.");
      } else {
        setDownloadNote("Saving via Share doesn't work in this browser — tap the “Download Now” button instead.");
      }
    } catch {
      /* user closed the share sheet — the file stays prepared below */
    }
  }

  // Admin shell: when the admin is logged in, the Admin Panel renders as
  // its own full-screen shell (sidebar + header) instead of inside the
  // User Panel page. Login is unified — admin credentials on the single
  // login page open this shell directly; logout returns to the User Panel.
  if (view === "admin" && admin) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <AdminPanel admin={admin} onLoggedOut={handleLogout} />
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <SiteWideAdCode code={settings.data?.adCodes.head} />
      <SiteWideAdCode code={settings.data?.adCodes.socialbar} />

      {/* Side menu drawer — slides in from the LEFT (hamburger opens it);
          overlay click or the X button closes it. */}
      {menuOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Site menu">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setMenuOpen(false)} />
          <div className="glass animate-drawer-in absolute top-0 left-0 flex h-full w-[80%] max-w-[340px] flex-col overflow-y-auto bg-[var(--surface)] shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-5 pb-2">
              <Logo compact />
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label={t("menu.close")}
                className="flex h-10 w-10 items-center justify-center bg-[var(--surface-alt)] text-lg font-bold"
                style={{ borderRadius: 10 }}
              >
                ✕
              </button>
            </div>
            <nav aria-label="Menu" className="flex flex-col px-3 py-2">
              {admin ? (
                <div className="mb-1 border-b border-[var(--border)] px-3 pt-1 pb-3">
                  <p className="text-base font-extrabold break-words">Admin</p>
                  <p className="text-xs text-[var(--dim)] break-all">{admin.email}</p>
                </div>
              ) : user ? (
                <div className="mb-1 border-b border-[var(--border)] px-3 pt-1 pb-3">
                  <p className="text-base font-extrabold break-words">{user.name}</p>
                  <p className="text-xs text-[var(--dim)] break-all">{user.email}</p>
                </div>
              ) : (
                <div className="mb-1 border-b border-[var(--border)] px-3 pt-1 pb-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center bg-[var(--surface-alt)] text-xl" style={{ borderRadius: 999 }}>👤</span>
                    <div>
                      <p className="text-base font-extrabold">{t("menu.guest")}</p>
                      <p className="text-xs text-[var(--dim)]">{t("menu.welcome")}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => go("auth")}
                    className="cta-gradient mt-3 w-full px-4 py-2.5 text-sm font-extrabold"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    🔑 {t("menu.login_register")}
                  </button>
                </div>
              )}
              {/* Phase 5 — theme + language quick toggles (same controls as
                  the header buttons and Download Settings). */}
              <div className="mb-1 flex gap-2 border-b border-[var(--border)] px-3 pt-1 pb-3">
                <button
                  type="button"
                  onClick={() => changeTheme(theme === "dark" ? "light" : "dark")}
                  aria-label={theme === "dark" ? t("header.theme_to_light") : t("header.theme_to_dark")}
                  className="glass flex-1 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-extrabold"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  {theme === "dark" ? `☀️ ${t("settings.theme_light")}` : `🌙 ${t("settings.theme_dark")}`}
                </button>
                <button
                  type="button"
                  onClick={() => changeLang(lang === "en" ? "ur" : "en")}
                  aria-label={lang === "en" ? t("header.lang_to_ur") : t("header.lang_to_en")}
                  className="glass flex-1 border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-extrabold"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  🌐 {lang === "en" ? t("settings.language_ur") : t("settings.language_en")}
                </button>
              </div>
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.view}
                  type="button"
                  onClick={() => go(item.view)}
                  className={`flex items-center justify-between gap-2 px-3 py-3.5 text-left text-lg font-semibold ${view === item.view ? "text-[var(--accent)]" : ""}`}
                >
                  <span>{item.icon} {t(item.label)}</span>
                  {item.view === "history" && historyCount > 0 && (
                    <span className="bg-[var(--accent)] px-2 py-0.5 text-xs font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
                      {historyCount}
                    </span>
                  )}
                  {item.badge && (
                    <span className="border border-[var(--border)] px-2 py-0.5 text-xs font-bold text-[var(--dim)]" style={{ borderRadius: 999 }}>
                      {t(item.badge)}
                    </span>
                  )}
                </button>
              ))}
              {installEvt && (
                <button
                  type="button"
                  onClick={handleInstallApp}
                  className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-3.5 text-left text-lg font-semibold text-[var(--accent)]"
                >
                  <span>📲 {t("home.install_app")}</span>
                </button>
              )}
              {user && !admin && (
                <>
                  <button
                    type="button"
                    onClick={() => go("myplan")}
                    className={`flex items-center justify-between gap-2 px-3 py-3.5 text-left text-lg font-semibold ${view === "myplan" ? "text-[var(--accent)]" : ""}`}
                  >
                    <span>💎 {t("menu.myplan")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => go("profile")}
                    className={`flex items-center justify-between gap-2 px-3 py-3.5 text-left text-lg font-semibold ${view === "profile" ? "text-[var(--accent)]" : ""}`}
                  >
                    <span>👤 {t("menu.profile")}</span>
                  </button>
                </>
              )}
              {admin && (
                <button
                  type="button"
                  onClick={handleLogout}
                  className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-3.5 text-left text-lg font-semibold text-[var(--err-text)]"
                >
                  <span>🚪 {t("menu.logout")}</span>
                </button>
              )}
              {user && !admin && (
                <button
                  type="button"
                  onClick={handleUserLogout}
                  className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-3.5 text-left text-lg font-semibold text-[var(--err-text)]"
                >
                  <span>🚪 {t("menu.logout")}</span>
                </button>
              )}
            </nav>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-7xl px-4 pb-8">
        {/* Header: hamburger + logo only (see below). The Top banner ad
            used to sit here, above the header — it now lives below the
            page content, just above the footer. */}
        {/* Sticky site header — hamburger (three lines, no text) at the
            far left, logo right after it. The bell, History button,
            language and theme shortcuts are NOT here any more: they live
            in the sidebar drawer (Favourites, Notifications, History)
            and Download Settings (theme + language), so nothing overlaps
            on a 360 px phone. */}
        <header className="glass sticky top-0 z-40 -mx-4 border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label={t("menu.open")}
              className="flex h-11 w-11 shrink-0 items-center justify-center border border-[var(--border)] bg-[var(--surface-alt)] text-xl font-extrabold"
              style={{ borderRadius: 12 }}
            >
              ☰
            </button>
            <button type="button" onClick={() => go("home")} aria-label="Jimeng Downloader — home" className="min-w-0 shrink-0">
              <Logo />
            </button>
          </div>
        </header>

        {view === "home" && (
          <>
            {/* Hero (design) */}
            <section className="relative overflow-hidden py-6 text-center sm:py-10">
              <HeroArt />
              <div className="relative">
                <p className="inline-block border border-[var(--accent)] bg-[rgba(0,233,154,0.08)] px-4 py-1.5 text-xs font-extrabold tracking-[0.18em] text-[var(--accent)]" style={{ borderRadius: 999 }}>
                  {t("home.badge")}
                </p>
                <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-extrabold leading-tight sm:text-5xl">
                  {t("home.title_a")} <span className="text-gradient">{t("home.title_b")}</span>
                </h1>
                <p className="mx-auto mt-3 max-w-2xl text-base text-[var(--dim)] sm:text-lg">
                  {t("home.subtitle")}
                </p>
                <p className="mx-auto mt-4 text-sm font-semibold text-[var(--dim)]">{t("home.live_note")}</p>
                {meQuery.data?.ok && meQuery.data.user && (
                  <p className="mt-3 text-sm font-semibold text-[var(--accent)]">
                    {meQuery.data.plan
                      ? t("home.plan_left", { plan: meQuery.data.plan.planName, remaining: String(meQuery.data.plan.remaining), total: String(meQuery.data.plan.limitTotal), date: new Date(meQuery.data.plan.expiresAt).toLocaleDateString() })
                      : meQuery.data.freeDailyLimit === 0
                        ? t("home.plan_free_unlimited")
                        : t("home.plan_free_left", { remaining: String(meQuery.data.freeRemaining), limit: String(meQuery.data.freeDailyLimit) })}
                  </p>
                )}
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <main className="flex min-w-0 flex-col gap-6">

              {/* Choose a downloader */}
              <section>
                <h2 className="text-2xl font-extrabold">{t("home.choose_title")}</h2>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  {t("home.choose_sub")}
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="glass card-hover flex flex-col border border-[rgba(0,233,154,0.35)] bg-[var(--surface)] p-5 shadow-[0_0_45px_rgba(0,233,154,0.10)]" style={{ borderRadius: "var(--radius)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-3xl" aria-hidden="true">🎬</span>
                      <StatusPill tone="green" label="● LIVE" pulse />
                    </div>
                    <h3 className="mt-3 text-xl font-extrabold">{t("home.jimeng_title")}</h3>
                    <p className="mt-1 flex-1 text-sm leading-relaxed text-[var(--dim)]">
                      {t("home.jimeng_desc")}
                    </p>
                    <button
                      type="button"
                      onClick={() => go("jimeng")}
                      className="cta-gradient mt-4 w-full px-5 py-3 text-base font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("home.open_downloader")}
                    </button>
                  </div>
                  <div className="glass card-hover flex flex-col border border-[rgba(0,233,154,0.35)] bg-[var(--surface)] p-5 shadow-[0_0_45px_rgba(0,233,154,0.10)]" style={{ borderRadius: "var(--radius)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-3xl" aria-hidden="true">🎵</span>
                      <StatusPill tone="green" label="● LIVE" pulse />
                    </div>
                    <h3 className="mt-3 text-xl font-extrabold">{t("home.douyin_title")}</h3>
                    <p className="mt-1 flex-1 text-sm leading-relaxed text-[var(--dim)]">
                      {t("home.douyin_desc")}
                    </p>
                    <button
                      type="button"
                      onClick={() => go("douyin")}
                      className="cta-gradient mt-4 w-full px-5 py-3 text-base font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("home.open_downloader")}
                    </button>
                  </div>
                  <div className="glass flex flex-col border border-[var(--border)] bg-[var(--surface)] p-5" style={{ borderRadius: "var(--radius)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-3xl" aria-hidden="true">🎥</span>
                      <StatusPill tone="amber" label={t("menu.coming_soon")} />
                    </div>
                    <h3 className="mt-3 text-xl font-extrabold">{t("home.sora_title")}</h3>
                    <p className="mt-1 flex-1 text-sm leading-relaxed text-[var(--dim)]">
                      {t("home.sora_desc")}
                    </p>
                    <button
                      type="button"
                      disabled
                      className="mt-4 w-full cursor-not-allowed border border-[var(--border)] bg-[var(--surface-alt)] px-5 py-3 text-base font-extrabold text-[var(--dim)]"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("menu.coming_soon")}
                    </button>
                  </div>
                </div>
              </section>
            </main>

            {/* Sidebar */}
            <aside className="flex min-w-0 flex-col gap-6">
              <AdSlot label="Advertisement · Sidebar" sub="300 × 250" saved={Boolean(settings.data?.adSlots.sidebar)} code={settings.data?.adCodes.sidebar} tall />
              <SectionCard>
                <h2 className="flex items-center gap-2 text-lg font-extrabold">
                  <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>?</span>
                  {t("home.need_help")}
                </h2>
                <div className="mt-3 flex flex-col">
                  <button type="button" onClick={() => go("howto")} className="flex items-center justify-between border-b border-[var(--border)] py-2.5 text-left text-sm font-bold text-[var(--accent)]">
                    <span>📖 {t("menu.howto")}</span><span aria-hidden="true">›</span>
                  </button>
                  <button type="button" onClick={() => go("faq")} className="flex items-center justify-between py-2.5 text-left text-sm font-bold text-[var(--accent)]">
                    <span>💬 {t("menu.faq")}</span><span aria-hidden="true">›</span>
                  </button>
                </div>
              </SectionCard>
            </aside>
            </div>

            {/* In-content ad (design: full width, below the downloader) */}
            <div className="mt-6">
              <AdSlot label="Advertisement · In-Content" saved={Boolean(settings.data?.adSlots.incontent)} code={settings.data?.adCodes.incontent} />
            </div>

            {/* How it works (design) */}
            <section className="mt-10">
              <h2 className="text-2xl font-extrabold">{t("home.how_title")}</h2>
              <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-stretch">
                {[
                  { n: "1", icon: "🎬", title: t("home.how_1_title"), text: t("home.how_1_text") },
                  { n: "2", icon: "📋", title: t("home.how_2_title"), text: t("home.how_2_text") },
                  { n: "3", icon: "⬇", title: t("home.how_3_title"), text: t("home.how_3_text") },
                ].map((step, i) => (
                  <div key={step.n} className="flex flex-1 items-center gap-4">
                    <div className="glass flex flex-1 items-center gap-3 border border-[var(--border)] bg-[var(--surface)] p-4" style={{ borderRadius: "var(--radius)" }}>
                      <span className="text-2xl" aria-hidden="true">{step.icon}</span>
                      <div>
                        <p className="flex items-center gap-2 text-base font-extrabold">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[var(--accent)] text-xs font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>{step.n}</span>
                          {step.title}
                        </p>
                        <p className="mt-0.5 text-sm text-[var(--dim)]">{step.text}</p>
                      </div>
                    </div>
                    {i < 2 && (
                      <span aria-hidden="true" className="hidden text-2xl font-extrabold text-[var(--accent)] lg:block">›</span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* Feature highlights (design) */}
            <FeatureStrip />
          </>
        )}

        {view === "history" && (
          <HistoryPage
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
            onGoHome={() => go("jimeng")}
          />
        )}
        {view === "favorites" && (
          <FavouritesPage
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
            onGoHome={() => go("jimeng")}
          />
        )}
        {view === "notifications" && <NotificationsPage />}
        {view === "download-settings" && <DownloadSettingsPage />}
        {view === "profile" && !userChecked && (
          <main className="mx-auto max-w-3xl py-16 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="mt-3 text-base text-[var(--dim)]">{t("common.loading")}</p>
          </main>
        )}
        {view === "profile" && userChecked && !user && (
          <AuthPage
            onLoggedIn={(u) => { handleUserLoggedIn(u); }}
            onAdminLoggedIn={(a) => { setAdmin(a); queryClient.invalidateQueries({ queryKey: ["settings"] }); go("admin"); }}
          />
        )}
        {view === "profile" && userChecked && user && (
          <MyProfilePage user={user} onUserChanged={setUser} />
        )}
        {view === "plans" && (
          <PlansPage
            user={user}
            onNeedLogin={() => go("auth")}
          />
        )}
        {view === "auth" && !userChecked && (
          <main className="mx-auto max-w-3xl py-16 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="mt-3 text-base text-[var(--dim)]">{t("common.loading")}</p>
          </main>
        )}
        {view === "auth" && userChecked && !user && !admin && (
          <AuthPage
            onLoggedIn={(u) => { handleUserLoggedIn(u); go("home"); }}
            onAdminLoggedIn={(a) => { setAdmin(a); queryClient.invalidateQueries({ queryKey: ["settings"] }); go("admin"); }}
          />
        )}
        {view === "auth" && admin && (
          <main className="mx-auto flex max-w-md flex-col gap-5 pt-16 text-center">
            <SectionCard>
              <p className="text-6xl" aria-hidden="true">🛡</p>
              <h1 className="text-gradient mt-4 text-2xl font-extrabold">Signed in as Admin</h1>
              <p className="mt-2 text-sm text-[var(--dim)]">You are signed in with {admin.email}.</p>
              <button
                type="button"
                onClick={() => go("admin")}
                className="cta-gradient mt-5 w-full px-5 py-3 font-extrabold"
                style={{ borderRadius: "var(--radius)" }}
              >
                Open Admin Panel
              </button>
            </SectionCard>
          </main>
        )}
        {view === "auth" && userChecked && user && (
          <MyPlanPage user={user} onGoPlans={() => go("plans")} />
        )}
        {view === "myplan" && !userChecked && (
          <main className="mx-auto max-w-3xl py-16 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="mt-3 text-base text-[var(--dim)]">{t("common.loading")}</p>
          </main>
        )}
        {view === "myplan" && userChecked && !user && (
          <AuthPage
            onLoggedIn={(u) => { handleUserLoggedIn(u); }}
            onAdminLoggedIn={(a) => { setAdmin(a); queryClient.invalidateQueries({ queryKey: ["settings"] }); go("admin"); }}
          />
        )}
        {view === "myplan" && userChecked && user && (
          <MyPlanPage user={user} onGoPlans={() => go("plans")} />
        )}
        {view === "whatis" && <WhatIsJimengPage />}
        {view === "howto" && <HowToPage />}
        {view === "faq" && <FaqPage />}
        {view === "jimeng" && (
          <JimengDownloaderPage
            initialMode={dlSettings.defaultMode}
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
            onGoPlans={() => go("plans")}
            onGoHistory={() => go("history")}
            sidebarAdSaved={Boolean(settings.data?.adSlots.sidebar)}
            sidebarAdCode={settings.data?.adCodes.sidebar}
            smartLink={settings.data?.smartLink}
          />
        )}
        {view === "douyin" && (
          <DouyinDownloaderPage
            initialMode={dlSettings.defaultMode}
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
            onGoPlans={() => go("plans")}
            onGoHistory={() => go("history")}
            sidebarAdSaved={Boolean(settings.data?.adSlots.sidebar)}
            sidebarAdCode={settings.data?.adCodes.sidebar}
            smartLink={settings.data?.smartLink}
          />
        )}
        {view === "bulk" && (
          <JimengDownloaderPage
            initialMode="bulk"
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
            onGoPlans={() => go("plans")}
            onGoHistory={() => go("history")}
            sidebarAdSaved={Boolean(settings.data?.adSlots.sidebar)}
            sidebarAdCode={settings.data?.adCodes.sidebar}
            smartLink={settings.data?.smartLink}
          />
        )}
        {view === "admin" && !adminChecked && (
          <main className="mx-auto max-w-3xl py-16 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="mt-3 text-base text-[var(--dim)]">{t("common.loading")}</p>
          </main>
        )}
        {view === "admin" && adminChecked && !admin && (
          <AuthPage
            onLoggedIn={(u) => { handleUserLoggedIn(u); go("home"); }}
            onAdminLoggedIn={(a) => { setAdmin(a); queryClient.invalidateQueries({ queryKey: ["settings"] }); go("admin"); }}
          />
        )}
        {view === "sora" && <SoraPage onGoHome={() => go("jimeng")} />}
        {view === "about" && <AboutPage />}
        {view === "privacy" && <PrivacyPage />}
        {view === "contact" && <ContactPage />}
        {view === "help" && <HelpCenterPage />}
        {view === "tickets" && <SupportTicketsPage />}
        {view === "report" && <ReportProblemPage onTicketCreated={() => go("tickets")} />}
        {view === "terms" && <TermsPage />}
        {view === "copyright" && <CopyrightPage />}
        {view === "disclaimer" && <DisclaimerPage />}

        {/* Top banner ad — moved down here, below the page content and
            just above the footer (it used to sit above the header, where
            it ruined the site's look). Same slot, same code, same real
            script injection — only the position moved. */}
        <div className="mt-10">
          <AdSlot label="Advertisement · Top Banner 728 × 90" saved={Boolean(settings.data?.adSlots.top)} code={settings.data?.adCodes.top} />
        </div>

        {/* Mobile banner ad 320×50 — same position (below the page
            content, just above the footer, next to the Bottom slot) but
            visible only on phones: the .mobile-only-ad wrapper hides it
            on desktop via a media query, so the desktop layout is
            untouched. Same real script injection as the other slots. */}
        <div className="mobile-only-ad mt-6">
          <AdSlot label="Advertisement · Mobile Banner 320 × 50" saved={Boolean(settings.data?.adSlots.mobile)} code={settings.data?.adCodes.mobile} />
        </div>

        <footer className="mt-10 border-t border-[var(--border)] pt-6 text-center">
          <BrandBanner />
          <nav aria-label="Footer" className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-bold">
            <button type="button" onClick={() => go("jimeng")} className="py-1">{t("menu.jimeng")}</button>
            <button type="button" onClick={() => go("douyin")} className="py-1">{t("menu.douyin")}</button>
            <button type="button" onClick={() => go("history")} className="py-1">{t("menu.history")}</button>
            <button type="button" onClick={() => go("plans")} className="py-1">{t("menu.plans")}</button>
            <button type="button" onClick={() => go("howto")} className="py-1">{t("menu.howto")}</button>
            <button type="button" onClick={() => go("faq")} className="py-1">{t("menu.faq")}</button>
            <button type="button" onClick={() => go("help")} className="py-1">{t("menu.help")}</button>
            <button type="button" onClick={() => go("tickets")} className="py-1">{t("menu.tickets")}</button>
            <button type="button" onClick={() => go("report")} className="py-1">{t("menu.report")}</button>
            <button type="button" onClick={() => go("bulk")} className="py-1">{t("menu.bulk")}</button>
            <button type="button" onClick={() => go("about")} className="py-1">{t("menu.about")}</button>
            <button type="button" onClick={() => go("privacy")} className="py-1">{t("menu.privacy")}</button>
            <button type="button" onClick={() => go("terms")} className="py-1">{t("menu.terms")}</button>
            <button type="button" onClick={() => go("copyright")} className="py-1">{t("menu.copyright")}</button>
            <button type="button" onClick={() => go("disclaimer")} className="py-1">{t("menu.disclaimer")}</button>
            <button type="button" onClick={() => go("contact")} className="py-1">{t("menu.contact")}</button>
          </nav>
          {/* Bottom banner ad slot (design: below the footer links) */}
          <div className="mt-6">
            <AdSlot label="Advertisement · Bottom Banner 728 × 90" saved={Boolean(settings.data?.adSlots.bottom)} code={settings.data?.adCodes.bottom} />
          </div>
          <p className="mt-4 pb-2 text-xs text-[var(--dim)] italic">
            {t("home.footer_note")}
          </p>
        </footer>
      </div>
    </div>
  );
}

type DownloadFlowProps = {
  downloading: string | null;
  prepared: PreparedSave | null;
  downloadNote: string | null;
  onDownload: (url: string, filename: string, tag: string) => void;
  onShare: (tag: string) => void;
  onGoHome?: () => void;
};

function HistoryPage({ downloading, prepared, downloadNote, onDownload, onShare, onGoHome }: DownloadFlowProps) {
  const t = useT();
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.listHistory({ limit: 30, token: getUserToken(), anonId: getAnonId() }) });
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🕘" title={t("history.title")} subtitle={t("history.subtitle")} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-[var(--dim)]">
          {history.data ? t("history.count", { n: String(history.data.items.length), s: history.data.items.length === 1 ? "" : "s" }) : t("common.loading")}
        </p>
        {history.data && history.data.items.length > 0 && <ClearHistoryButton />}
      </div>
      {history.data && history.data.items.length > 0 && (
        <p className="border border-[var(--warn-text)] bg-[var(--warn-bg)] p-3 text-sm font-semibold text-[var(--warn-text)]" style={{ borderRadius: "var(--radius)" }}>
          Note: Files in your earlier history may contain Jimeng's watermark (the AI badge at the top and the Jimeng @user mark at the bottom) — those were Jimeng's display files. The site now fetches the clean master file: to get a clean download, paste the same link again and fetch it fresh.
        </p>
      )}
      {history.isPending && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}
      {history.data && history.data.items.length === 0 && (
        <SectionCard className="py-12 text-center">
          <p className="text-6xl" aria-hidden="true">🎬</p>
          <h2 className="mt-4 text-xl font-extrabold">{t("history.empty_title")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
            {t("history.empty_text")}
          </p>
          <button
            type="button"
            onClick={onGoHome}
            className="cta-gradient mt-5 px-6 py-3 text-base font-extrabold"
            style={{ borderRadius: "var(--radius)" }}
          >
            {t("history.go_downloader")}
          </button>
        </SectionCard>
      )}
      {downloadNote && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
      <ul className="flex flex-col gap-3">
        {history.data?.items.map((item) => (
          <li key={item.id} className="glass card-hover border border-[var(--border)] bg-[var(--surface)] p-3" style={{ borderRadius: "var(--radius)" }}>
            <div className="flex gap-3">
              {item.coverUrl ? (
                <img src={item.coverUrl} alt="" className="h-20 w-16 shrink-0 object-cover" style={{ borderRadius: 10 }} />
              ) : (
                <div className="flex h-20 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-2xl" style={{ borderRadius: 10 }}>🎬</div>
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-base font-extrabold">{item.title || (item.platform === "douyin" ? t("dy.douyin_video") : t("dl.jimeng_video"))}</span>
                  <span
                    className={`shrink-0 px-2 py-0.5 text-[11px] font-extrabold ${item.platform === "douyin" ? "bg-[rgba(0,233,154,0.15)] text-[var(--accent)]" : "bg-[var(--surface-alt)] text-[var(--dim)]"}`}
                    style={{ borderRadius: 999 }}
                  >
                    {item.platform === "douyin" ? `🎵 ${t("history.douyin")}` : `🎬 ${t("history.jimeng")}`}
                  </span>
                </p>
                <p className="truncate text-xs text-[var(--dim)]">{item.sourceUrl}</p>
                <p className="text-xs text-[var(--dim)]">{new Date(item.createdAt).toLocaleString()}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={downloading === `h-${item.id}`} onClick={() => onDownload(item.videoUrl, item.platform === "douyin" ? "douyin-no-watermark.mp4" : "jimeng-no-watermark.mp4", `h-${item.id}`)} className="bg-[var(--accent)] px-4 py-1.5 text-xs font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: 8 }}>
                    {downloading === `h-${item.id}` ? t("dl.preparing") : t("history.download")}
                  </button>
                  <FavoriteButton downloadId={item.id} />
                  <DeleteHistoryButton id={item.id} />
                </div>
              </div>
            </div>
            {prepared?.tag === `h-${item.id}` && (
              <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Favourites — videos the visitor saved with the heart button.        */
/* Scoped exactly like History: per account when logged in, per        */
/* browser when anonymous.                                             */
/* ------------------------------------------------------------------ */

function FavouritesPage({ downloading, prepared, downloadNote, onDownload, onShare, onGoHome }: DownloadFlowProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: () => api.listFavorites({ limit: 50, token: getUserToken(), anonId: getAnonId() }) });
  const removeMut = useMutation({
    mutationFn: (id: number) => api.removeFavorite({ id, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["favorites"] }),
  });
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="❤️" title={t("favorites.title")} subtitle={t("favorites.subtitle")} />
      <p className="text-sm font-bold text-[var(--dim)]">
        {favorites.data ? t("favorites.count", { n: String(favorites.data.items.length), s: favorites.data.items.length === 1 ? "" : "s" }) : t("common.loading")}
      </p>
      {favorites.isPending && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}
      {favorites.data && favorites.data.items.length === 0 && (
        <SectionCard className="py-12 text-center">
          <p className="text-6xl" aria-hidden="true">❤️</p>
          <h2 className="mt-4 text-xl font-extrabold">{t("favorites.empty_title")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
            {t("favorites.hint")}
          </p>
          <button
            type="button"
            onClick={onGoHome}
            className="cta-gradient mt-5 px-6 py-3 text-base font-extrabold"
            style={{ borderRadius: "var(--radius)" }}
          >
            {t("history.go_downloader")}
          </button>
        </SectionCard>
      )}
      {downloadNote && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
      <ul className="flex flex-col gap-3">
        {favorites.data?.items.map((item) => (
          <li key={item.id} className="glass card-hover border border-[var(--border)] bg-[var(--surface)] p-3" style={{ borderRadius: "var(--radius)" }}>
            <div className="flex gap-3">
              {item.coverUrl ? (
                <img src={item.coverUrl} alt="" className="h-20 w-16 shrink-0 object-cover" style={{ borderRadius: 10 }} />
              ) : (
                <div className="flex h-20 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-2xl" style={{ borderRadius: 10 }}>🎬</div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-extrabold">{item.title || t("dl.jimeng_video")}</p>
                <p className="truncate text-xs text-[var(--dim)]">{item.qualityLabel}</p>
                <p className="truncate text-xs text-[var(--dim)]">{item.sourceUrl}</p>
                <p className="text-xs text-[var(--dim)]">{t("favorites.saved", { date: new Date(item.createdAt).toLocaleString() })}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={downloading === `f-${item.id}`} onClick={() => onDownload(item.videoUrl, slugFilename(item.title, "jimeng-no-watermark.mp4"), `f-${item.id}`)} className="bg-[var(--accent)] px-4 py-1.5 text-xs font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: 8 }}>
                    {downloading === `f-${item.id}` ? t("dl.preparing") : t("history.download_again")}
                  </button>
                  <button
                    type="button"
                    disabled={removeMut.isPending && removeMut.variables === item.id}
                    onClick={() => removeMut.mutate(item.id)}
                    className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)] disabled:opacity-50"
                    style={{ borderRadius: 8 }}
                  >
                    {t("favorites.remove")}
                  </button>
                </div>
              </div>
            </div>
            {prepared?.tag === `f-${item.id}` && (
              <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* My Profile — logged-in customers only: name, email, joined date,    */
/* plan, download stats, favourites count, name edit + password        */
/* change.                                                             */
/* ------------------------------------------------------------------ */

function MyProfilePage({ user, onUserChanged }: { user: MeUser; onUserChanged: (u: MeUser) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me({ token: getUserToken() }) });
  const favorites = useQuery({ queryKey: ["favorites"], queryFn: () => api.listFavorites({ limit: 50, token: getUserToken(), anonId: getAnonId() }) });
  const data = me.data;

  const [name, setName] = useState(user.name);
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameMut = useMutation({
    mutationFn: (next: string) => api.updateProfileName({ name: next, token: getUserToken() }),
    onSuccess: (res, next) => {
      if (res.ok) {
        onUserChanged({ ...user, name: next });
        queryClient.invalidateQueries({ queryKey: ["me"] });
        setNameMsg(t("profile.name_updated"));
        setNameError(null);
      } else {
        setNameError(res.error ?? t("profile.name_failed"));
        setNameMsg(null);
      }
    },
    onError: () => {
      setNameError(t("common.error_server"));
      setNameMsg(null);
    },
  });

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const pwMut = useMutation({
    mutationFn: () => api.changeUserPassword({ currentPassword: currentPw, newPassword: newPw, token: getUserToken() }),
    onSuccess: (res) => {
      if (res.ok) {
        setPwMsg(t("profile.pw_changed"));
        setPwError(null);
        setCurrentPw("");
        setNewPw("");
        setConfirmPw("");
      } else {
        setPwError(res.error ?? t("profile.pw_failed"));
        setPwMsg(null);
      }
    },
    onError: () => {
      setPwError(t("common.error_server"));
      setPwMsg(null);
    },
  });

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPw || !newPw) {
      setPwError(t("profile.pw_missing"));
      setPwMsg(null);
      return;
    }
    if (newPw.length < 8) {
      setPwError(t("profile.pw_short"));
      setPwMsg(null);
      return;
    }
    if (newPw !== confirmPw) {
      setPwError(t("profile.pw_mismatch"));
      setPwMsg(null);
      return;
    }
    setPwError(null);
    setPwMsg(null);
    pwMut.mutate();
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="👤" title={t("menu.profile")} subtitle={t("profile.subtitle")} />
      <SectionCard className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center bg-[var(--accent)] text-2xl font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
          {user.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold">{user.name}</p>
          <p className="truncate text-sm text-[var(--dim)]">{user.email}</p>
          {data?.joinedAt && (
            <p className="text-xs text-[var(--dim)]">{t("profile.joined_date", { date: new Date(data.joinedAt).toLocaleDateString() })}</p>
          )}
        </div>
        <span className="ml-auto shrink-0">
          <StatusPill tone={data?.plan ? "green" : "gray"} label={data?.plan ? data.plan.planName : t("plans.free_plan")} />
        </span>
      </SectionCard>

      {data?.ok && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard value={String(data.downloadsToday)} label={t("myplan.downloads_today")} />
          <StatCard value={String(data.downloadsTotal)} label={t("myplan.downloads_total")} />
          <StatCard value={String(favorites.data?.items.length ?? 0)} label="Favourites" />
          <StatCard value={data.plan ? new Date(data.plan.expiresAt).toLocaleDateString() : data.freeDailyLimit === 0 ? "—" : `${data.freeDailyLimit}/day`} label={data.plan ? t("myplan.expires_label") : t("myplan.free_limit_label")} />
        </div>
      )}

      <SectionCard>
        <h2 className="text-lg font-extrabold">{t("profile.edit_name")}</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">{t("profile.email_fixed")}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            aria-label={t("auth.name_label")}
            value={name}
            onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); if (nameMsg) setNameMsg(null); }}
            placeholder={t("auth.name_label")}
            maxLength={100}
            className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
            style={{ borderRadius: "var(--radius)" }}
          />
          <button
            type="button"
            disabled={nameMut.isPending || !name.trim() || name.trim() === user.name}
            onClick={() => nameMut.mutate(name.trim())}
            className="bg-[var(--accent)] px-5 py-2 font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {nameMut.isPending ? t("common.saving") : t("profile.save_name")}
          </button>
        </div>
        {nameMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{nameMsg}</p>}
        {nameError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{nameError}</p>}
      </SectionCard>

      <SectionCard>
        <h2 className="text-lg font-extrabold">{t("profile.change_password")}</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">Your other sessions will be signed out; this session stays logged in.</p>
        <form onSubmit={handlePasswordSubmit} className="mt-3 flex flex-col gap-3">
          <div>
            <label htmlFor="profile-current-pw" className="text-sm font-bold">{t("profile.current_password")}</label>
            <input
              id="profile-current-pw"
              type="password"
              autoComplete="current-password"
              value={currentPw}
              onChange={(e) => { setCurrentPw(e.target.value); if (pwError) setPwError(null); }}
              placeholder="Your current password"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="profile-new-pw" className="text-sm font-bold">{t("profile.new_password")}</label>
            <input
              id="profile-new-pw"
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => { setNewPw(e.target.value); if (pwError) setPwError(null); }}
              placeholder="At least 8 characters"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="profile-confirm-pw" className="text-sm font-bold">{t("profile.confirm_password")}</label>
            <input
              id="profile-confirm-pw"
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              onChange={(e) => { setConfirmPw(e.target.value); if (pwError) setPwError(null); }}
              placeholder="Repeat the new password"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {pwMsg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{pwMsg}</p>}
          {pwError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{pwError}</p>}
          <button
            type="submit"
            disabled={pwMut.isPending}
            className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {pwMut.isPending ? "Please wait…" : "Change password"}
          </button>
        </form>
      </SectionCard>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Download Settings — default quality + default mode. Logged-in       */
/* customers save theirs on the account; anonymous visitors save       */
/* theirs in this browser. Nothing else lives here (no theme or        */
/* language options — those come in a later phase).                    */
/* ------------------------------------------------------------------ */

function DownloadSettingsPage() {
  const t = useT();
  const { theme, lang, setTheme, setLang } = usePrefs();
  const queryClient = useQueryClient();
  const loggedIn = Boolean(getUserToken());
  const server = useQuery({
    queryKey: ["download-settings"],
    queryFn: () => api.getDownloadSettings({ token: getUserToken() }),
    enabled: loggedIn,
  });
  const [quality, setQuality] = useState<QualityPref>(() => getLocalDownloadSettings().defaultQuality);
  const [mode, setMode] = useState<DownloadModePref>(() => getLocalDownloadSettings().defaultMode);
  const [themeSel, setThemeSel] = useState<Theme>(theme);
  const [langSel, setLangSel] = useState<Lang>(lang);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const didInit = useRef(false);

  // Logged-in customers start from their saved server settings.
  useEffect(() => {
    if (loggedIn && server.data && !didInit.current) {
      didInit.current = true;
      setQuality(server.data.defaultQuality as QualityPref);
      setMode(server.data.defaultMode as DownloadModePref);
      setThemeSel(server.data.theme === "light" ? "light" : "dark");
      setLangSel(server.data.language === "ur" ? "ur" : "en");
    }
  }, [loggedIn, server.data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveDownloadSettings({ defaultQuality: quality, defaultMode: mode, theme: themeSel, language: langSel, token: getUserToken() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["download-settings"] });
      setTheme(themeSel);
      setLang(langSel);
      setLocalTheme(themeSel);
      setLocalLang(langSel);
      applyTheme(themeSel);
      setSavedMsg(t("settings.saved_account"));
      setSaveError(null);
    },
    onError: () => {
      setSaveError(t("common.error_server"));
      setSavedMsg(null);
    },
  });

  function handleSave() {
    setSavedMsg(null);
    setSaveError(null);
    if (loggedIn) {
      saveMut.mutate();
    } else {
      setLocalDownloadSettings({ defaultQuality: quality, defaultMode: mode, theme: themeSel, language: langSel });
      setTheme(themeSel);
      setLang(langSel);
      applyTheme(themeSel);
      setSavedMsg(t("settings.saved_browser"));
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="⚙️" title={t("menu.download_settings")} subtitle={t("settings.subtitle")} />
      <SectionCard>
        <div>
          <label htmlFor="settings-quality" className="text-sm font-bold">{t("settings.quality")}</label>
          <p className="mt-0.5 text-xs text-[var(--dim)]">{t("settings.quality_hint")}</p>
          <select
            id="settings-quality"
            value={quality}
            onChange={(e) => setQuality(e.target.value as QualityPref)}
            className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm font-semibold"
            style={{ borderRadius: "var(--radius)" }}
          >
            {QUALITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="mt-5">
          <label htmlFor="settings-mode" className="text-sm font-bold">{t("settings.mode")}</label>
          <p className="mt-0.5 text-xs text-[var(--dim)]">{t("settings.mode_hint")}</p>
          <select
            id="settings-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as DownloadModePref)}
            className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm font-semibold"
            style={{ borderRadius: "var(--radius)" }}
          >
            <option value="single">{t("dl.single")}</option>
            <option value="bulk">{t("settings.mode_bulk")}</option>
          </select>
        </div>
        <div className="mt-5">
          <label htmlFor="settings-theme" className="text-sm font-bold">{t("settings.theme")}</label>
          <p className="mt-0.5 text-xs text-[var(--dim)]">{t("settings.theme_hint")}</p>
          <select
            id="settings-theme"
            value={themeSel}
            onChange={(e) => setThemeSel(e.target.value as Theme)}
            className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm font-semibold"
            style={{ borderRadius: "var(--radius)" }}
          >
            <option value="dark">{t("settings.theme_dark")}</option>
            <option value="light">{t("settings.theme_light")}</option>
          </select>
        </div>
        <div className="mt-5">
          <label htmlFor="settings-language" className="text-sm font-bold">{t("settings.language")}</label>
          <p className="mt-0.5 text-xs text-[var(--dim)]">{t("settings.language_hint")}</p>
          <select
            id="settings-language"
            value={langSel}
            onChange={(e) => setLangSel(e.target.value as Lang)}
            className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm font-semibold"
            style={{ borderRadius: "var(--radius)" }}
          >
            <option value="en">{t("settings.language_en")}</option>
            <option value="ur">{t("settings.language_ur")}</option>
          </select>
        </div>
        <p className="mt-4 text-xs text-[var(--dim)]">
          {loggedIn ? t("settings.note_account") : t("settings.note_browser")}
        </p>
        {savedMsg && <p className="mt-3 text-sm font-semibold text-[var(--accent)]" role="status">{savedMsg}</p>}
        {saveError && <p className="mt-3 text-sm font-semibold text-[var(--err-text)]" role="alert">{saveError}</p>}
        <button
          type="button"
          disabled={saveMut.isPending}
          onClick={handleSave}
          className="cta-gradient mt-4 w-full px-5 py-2.5 font-extrabold disabled:opacity-50"
          style={{ borderRadius: "var(--radius)" }}
        >
          {saveMut.isPending ? t("common.saving") : t("settings.save")}
        </button>
      </SectionCard>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications — created only by real server events: payment         */
/* received, plan activated/expired/used up, daily free limit          */
/* reached. The header bell badge shows the real unread count.         */
/* ------------------------------------------------------------------ */

function NotificationsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.listNotifications({ limit: 50, token: getUserToken(), anonId: getAnonId() }),
  });
  const readMut = useMutation({
    mutationFn: (id: number) => api.markNotificationRead({ id, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const readAllMut = useMutation({
    mutationFn: () => api.markAllNotificationsRead({ token: getUserToken(), anonId: getAnonId() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteNotification({ id, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = notifications.data?.items ?? [];
  const unreadCount = notifications.data?.unreadCount ?? 0;
  const typeIcon: Record<string, string> = { payment: "💳", plan: "💎", limit: "⚠️", support: "🎫", announcement: "📢" };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🔔" title={t("menu.notifications")} subtitle={t("notif.subtitle")} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-[var(--dim)]">
          {notifications.data
            ? unreadCount > 0
              ? `${unreadCount} unread · ${items.length} total`
              : `${items.length} notification${items.length === 1 ? "" : "s"}`
            : "Loading…"}
        </p>
        {unreadCount > 0 && (
          <button
            type="button"
            disabled={readAllMut.isPending}
            onClick={() => readAllMut.mutate()}
            className="text-sm font-bold text-[var(--accent)] disabled:opacity-50"
          >
            {t("notif.mark_all")}
          </button>
        )}
      </div>
      {notifications.isPending && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}
      {notifications.data && items.length === 0 && (
        <SectionCard className="py-12 text-center">
          <p className="text-6xl" aria-hidden="true">🔔</p>
          <h2 className="mt-4 text-xl font-extrabold">{t("notif.empty_title")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
            {t("notif.empty_text")}
          </p>
        </SectionCard>
      )}
      <ul className="flex flex-col gap-3">
        {items.map((n) => (
          <li
            key={n.id}
            className={`glass border bg-[var(--surface)] p-4 ${n.read ? "border-[var(--border)]" : "border-[rgba(0,233,154,0.45)] shadow-[0_0_24px_rgba(0,233,154,0.08)]"}`}
            style={{ borderRadius: "var(--radius)" }}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-xl" style={{ borderRadius: 999 }} aria-hidden="true">
                {typeIcon[n.type] ?? "🔔"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-extrabold">{n.title}</p>
                  {!n.read && <StatusPill tone="green" label={t("notif.new")} pulse />}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{n.message}</p>
                <p className="mt-1 text-xs text-[var(--dim)]">{new Date(n.createdAt).toLocaleString()}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {!n.read && (
                    <button
                      type="button"
                      disabled={readMut.isPending && readMut.variables === n.id}
                      onClick={() => readMut.mutate(n.id)}
                      className="border border-[var(--border)] px-3 py-1.5 text-xs font-extrabold disabled:opacity-50"
                      style={{ borderRadius: 8 }}
                    >
                      {t("notif.mark_read")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={deleteMut.isPending && deleteMut.variables === n.id}
                    onClick={() => deleteMut.mutate(n.id)}
                    className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)] disabled:opacity-50"
                    style={{ borderRadius: 8 }}
                  >
                    {t("notif.delete")}
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Jimeng downloader page — Single + Bulk modes in one component.      */
/* The "bulk" menu item opens this same page with Bulk pre-selected.   */
/* ------------------------------------------------------------------ */

const BULK_MAX_LINKS = 10;

type BulkItem = {
  line: string;
  status: "waiting" | "working" | "done" | "error";
  result: ResolveResult | null;
  /** Index into result.videos — the export quality chosen for this video. */
  selectedVideo: number;
};

type JimengDownloaderPageProps = DownloadFlowProps & {
  initialMode: "single" | "bulk";
  onGoPlans: () => void;
  onGoHistory: () => void;
  sidebarAdSaved: boolean;
  sidebarAdCode: string | null | undefined;
  smartLink: { url: string | null; enabled: boolean } | undefined;
};

/** Safe download filename from a video title (falls back when empty). */
function slugFilename(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${slug}.mp4` : fallback;
}

/** De-duplicated filename for the ZIP (jimeng-video.mp4, jimeng-video-2.mp4…). */
function uniqueZipName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const stem = base.replace(/\.mp4$/, "");
  let k = 2;
  while (used.has(`${stem}-${k}.mp4`)) k++;
  const name = `${stem}-${k}.mp4`;
  used.add(name);
  return name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Triggers a real browser download from a real anchor tap in code. In a
 * normal browser (Chrome on the phone) this saves through the download
 * manager; inside the Muse app webview a programmatic click can silently
 * do nothing, which is why every batch flow tells the user to fall back
 * to each video's own Download button.
 */
function triggerBrowserDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function JimengDownloaderPage({
  initialMode,
  downloading,
  prepared,
  downloadNote,
  onDownload,
  onShare,
  onGoPlans,
  onGoHistory,
  sidebarAdSaved,
  sidebarAdCode,
  smartLink,
}: JimengDownloaderPageProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"single" | "bulk">(initialMode);
  const dlSettings = useDownloadSettings();

  // The saved default mode (Single/Bulk) applies when this page opens.
  // initialMode changes once when the server settings finish loading, so
  // the mode follows the preference without resetting a manual switch
  // afterwards (initialMode only changes on load or view change).
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  /* ---------------- Single mode state ---------------- */
  const [linkText, setLinkText] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [selectedVideo, setSelectedVideo] = useState(0);
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);
  const chosenVideo = result?.ok ? result.videos[selectedVideo] : undefined;

  const resolve = useMutation({
    mutationFn: (text: string) => api.resolveLink({ text, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: (data) => {
      setResult(data);
      // The saved default quality is pre-selected; when this video does
      // not offer it, the best available is used instead.
      setSelectedVideo(pickVideoIndex(data.videos, dlSettings.defaultQuality));
      if (data.ok) queryClient.invalidateQueries({ queryKey: ["history"] });
    },
    onError: () => {
      setResult({
        ok: false, sourceUrl: "", title: "", coverUrl: null, videos: [], images: [],
        usedCustomApi: false, note: null, downloadId: null,
        error: t("common.error_server"),
      });
    },
  });

  function handleResolve() {
    if (!linkText.trim()) {
      setLinkError(t("dl.link_empty"));
      return;
    }
    setLinkError(null);
    resolve.mutate(linkText.trim());
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setLinkText(text);
        setLinkError(null);
        setPasteMsg(t("dl.pasted"));
      } else setPasteMsg(t("dl.clipboard_empty"));
    } catch {
      setPasteMsg(t("dl.paste_failed"));
    }
  }

  /* ---------------- Bulk mode state ---------------- */
  const [bulkText, setBulkText] = useState("");
  const [bulkTextError, setBulkTextError] = useState<string | null>(null);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);
  const [zipRunning, setZipRunning] = useState(false);
  const [zipStatus, setZipStatus] = useState<string | null>(null);
  const [zipSummary, setZipSummary] = useState<string | null>(null);

  async function handleBulk() {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      setBulkTextError(t("dl.bulk_empty"));
      return;
    }
    setBulkTextError(null);
    setBatchSummary(null);
    setZipSummary(null);
    const batch = lines.slice(0, BULK_MAX_LINKS);
    setItems(batch.map((line) => ({ line, status: "waiting", result: null, selectedVideo: 0 })));
    setBulkRunning(true);
    for (let i = 0; i < batch.length; i++) {
      const line = batch[i];
      if (!line) continue;
      setItems((prev) => prev.map((it, j) => (j === i ? { ...it, status: "working" } : it)));
      try {
        const data = await api.resolveLink({ text: line, token: getUserToken(), anonId: getAnonId() });
        setItems((prev) =>
          prev.map((it, j) => (j === i ? { ...it, status: data.ok ? "done" : "error", result: data, selectedVideo: pickVideoIndex(data.videos, dlSettings.defaultQuality) } : it)),
        );
        if (data.ok) queryClient.invalidateQueries({ queryKey: ["history"] });
      } catch {
        setItems((prev) =>
          prev.map((it, j) =>
            j === i
              ? {
                  ...it,
                  status: "error",
                  result: {
                    ok: false, sourceUrl: line, title: "", coverUrl: null, videos: [], images: [],
                    usedCustomApi: false, note: null, downloadId: null,
                    error: t("common.error_server"),
                  },
                }
              : it,
          ),
        );
      }
    }
    setBulkRunning(false);
  }

  /** Videos that fetched successfully, with their chosen export quality. */
  function batchTargets() {
    return items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.status === "done" && it.result?.ok && it.result.videos[it.selectedVideo]);
  }

  /**
   * Prepares one video for saving (server-side). This is the same
   * prepareDownload the single Download button uses, so each video counts
   * toward the free daily limit / plan quota exactly as before, and a hit
   * limit returns limitReached so the Plans page can open.
   */
  async function prepareOne(
    videoUrl: string,
  ): Promise<
    | { ok: true; downloadUrl: string; sizeBytes: number }
    | { ok: false; error: string; limitReached: boolean }
  > {
    try {
      const prep = await api.prepareDownload({ url: videoUrl, token: getUserToken(), anonId: getAnonId() });
      if (prep.ok && prep.downloadUrl) {
        return { ok: true, downloadUrl: prep.downloadUrl, sizeBytes: prep.sizeBytes };
      }
      return { ok: false, error: prep.error ?? t("dl.prepare_failed"), limitReached: prep.limitReached };
    } catch {
      return { ok: false, error: t("dl.no_response_short"), limitReached: false };
    }
  }

  async function handleDownloadAll() {
    const targets = batchTargets();
    if (targets.length === 0 || batchRunning) return;
    setBatchRunning(true);
    setBatchSummary(null);
    let okCount = 0;
    const failed: string[] = [];
    let hitLimit = false;
    for (let n = 0; n < targets.length; n++) {
      const entry = targets[n];
      if (!entry) continue;
      const { it, i } = entry;
      const video = it.result!.videos[it.selectedVideo]!;
      const name = it.result!.title || t("dl.jimeng_video") + ` ${i + 1}`;
      setBatchStatus(t("dl.downloading_n", { n: String(n + 1), total: String(targets.length), name }));
      const prep = await prepareOne(video.url);
      if (!prep.ok) {
        failed.push(`${name}: ${prep.error}`);
        if (prep.limitReached) {
          hitLimit = true;
          break;
        }
        continue;
      }
      triggerBrowserDownload(prep.downloadUrl, slugFilename(it.result!.title, `jimeng-video-${i + 1}.mp4`));
      okCount++;
      if (n < targets.length - 1) await sleep(1500);
    }
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["history"] });
    setBatchRunning(false);
    setBatchStatus(null);
    setBatchSummary(
      [
        t("dl.batch_done", { ok: String(okCount), total: String(targets.length), s: targets.length === 1 ? "" : "s" }),
        failed.length > 0
          ? t("dl.batch_failed", { n: String(failed.length), list: failed.slice(0, 3).join(" · ") }) + (failed.length > 3 ? ` ${t("dl.and_more", { n: String(failed.length - 3) })}` : "")
          : null,
        t("dl.batch_fallback"),
      ].filter(Boolean).join(" "),
    );
    if (hitLimit) onGoPlans();
  }

  async function handleDownloadZip() {
    const targets = batchTargets();
    if (targets.length === 0 || zipRunning) return;
    setZipRunning(true);
    setZipSummary(null);
    const zip = new JSZip();
    const usedNames = new Set<string>();
    let added = 0;
    const failed: string[] = [];
    let hitLimit = false;
    for (let n = 0; n < targets.length; n++) {
      const entry = targets[n];
      if (!entry) continue;
      const { it, i } = entry;
      const video = it.result!.videos[it.selectedVideo]!;
      const name = it.result!.title || t("dl.jimeng_video") + ` ${i + 1}`;
      setZipStatus(t("dl.zip_preparing_n", { n: String(n + 1), total: String(targets.length), name }));
      const prep = await prepareOne(video.url);
      if (!prep.ok) {
        failed.push(`${name}: ${prep.error}`);
        if (prep.limitReached) {
          hitLimit = true;
          break;
        }
        continue;
      }
      try {
        const res = await fetch(prep.downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size === 0) throw new Error("empty file");
        zip.file(
          uniqueZipName(slugFilename(it.result!.title, `jimeng-video-${i + 1}.mp4`), usedNames),
          blob,
        );
        added++;
      } catch {
        failed.push(t("dl.zip_failed_read", { name }));
      }
    }
    if (added === 0) {
      setZipRunning(false);
      setZipStatus(null);
      setZipSummary(
        `${t("dl.zip_none")} ${failed.slice(0, 3).join(" · ")}`,
      );
      if (hitLimit) onGoPlans();
      return;
    }
    setZipStatus(t("dl.zipping", { n: String(added), s: added === 1 ? "" : "s" }));
    try {
      // MP4s are already compressed, so STORE keeps zipping fast and light.
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const url = URL.createObjectURL(zipBlob);
      triggerBrowserDownload(url, "jimeng-videos.zip");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setZipSummary(
        [
          t("dl.zip_ready", { n: String(added), s: added === 1 ? "" : "s" }),
          failed.length > 0
            ? t("dl.zip_skipped", { n: String(failed.length), list: failed.slice(0, 3).join(" · ") }) + (failed.length > 3 ? ` ${t("dl.and_more", { n: String(failed.length - 3) })}` : "")
            : null,
        ].filter(Boolean).join(" "),
      );
    } catch {
      setZipSummary(t("dl.zip_failed"));
    }
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["history"] });
    setZipRunning(false);
    setZipStatus(null);
    if (hitLimit) onGoPlans();
  }

  const doneCount = items.filter((it) => it.status === "done").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="flex min-w-0 flex-col gap-6">
        <PageHero icon="🎬" title={t("menu.jimeng")} subtitle={t("dl.subtitle")} />
        <p className="mx-auto flex max-w-full flex-wrap items-center justify-center gap-2 border border-[rgba(251,191,36,0.4)] bg-[var(--warn-bg)] px-4 py-2 text-center text-sm font-bold text-[var(--warn-text)]" style={{ borderRadius: 999 }}>
          {t("dl.public_only")}
        </p>

        <SectionCard className="border-[rgba(0,233,154,0.35)] shadow-[0_0_45px_rgba(0,233,154,0.10)]">
          {/* Single / Bulk mode toggle */}
          <div className="flex gap-2" role="tablist" aria-label={t("dl.download_mode")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "single"}
              onClick={() => setMode("single")}
              className={`flex-1 px-4 py-2.5 text-sm font-extrabold ${mode === "single" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              {t("dl.single")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "bulk"}
              onClick={() => setMode("bulk")}
              className={`flex-1 px-4 py-2.5 text-sm font-extrabold ${mode === "bulk" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              {t("dl.bulk", { n: String(BULK_MAX_LINKS) })}
            </button>
          </div>

          {mode === "single" && (
            <>
              <h2 className="mt-5 flex items-center gap-2 text-xl font-extrabold">
                <span className="text-[var(--accent)]">🔗</span> {t("dl.paste_heading")}
              </h2>
              <p className="mt-1 text-sm text-[var(--dim)]">
                {t("dl.paste_hint")}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <textarea
                  {...FIELDS.resolveLink.text}
                  id="jimeng-link"
                  aria-label={t("dl.link_aria")}
                  value={linkText}
                  onChange={(e) => { setLinkText(e.target.value); if (linkError) setLinkError(null); }}
                  placeholder="https://jimeng.jianying.com/s/xxxxx"
                  rows={2}
                  className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
                  style={{ borderRadius: "var(--radius)" }}
                />
                <div className="flex gap-2 sm:flex-col">
                  <button type="button" onClick={handlePaste} className="glass flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm font-bold sm:flex-none" style={{ borderRadius: "var(--radius)" }}>
                    {t("dl.paste")}
                  </button>
                  <button type="button" onClick={() => { setLinkText(""); setResult(null); setLinkError(null); }} className="flex-1 border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--dim)] sm:flex-none" style={{ borderRadius: "var(--radius)" }}>
                    {t("dl.clear")}
                  </button>
                </div>
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                {t("dl.tip_share_text")}
              </p>
              {linkError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{linkError}</p>}
              <button
                type="button"
                disabled={resolve.isPending}
                onClick={handleResolve}
                className="cta-gradient mt-3 w-full px-5 py-3.5 text-lg font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {resolve.isPending ? t("dl.fetching") : t("dl.get_video")}
              </button>
              <p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-sm font-semibold text-[var(--dim)]">
                <span><span className="text-[var(--accent)]">✓</span> {t("dl.free_start")}</span>
                <span aria-hidden="true" className="text-[var(--border)]">|</span>
                <span><span className="text-[var(--accent)]">⚡</span> {t("dl.original_mp4")}</span>
                <span aria-hidden="true" className="text-[var(--border)]">|</span>
                <span><span className="text-[var(--accent)]">✓</span> {t("dl.no_login")}</span>
              </p>
              {pasteMsg && <p className="mt-2 text-sm text-[var(--dim)]">{pasteMsg}</p>}

              {/* Single result */}
              {result && !result.ok && (
                <div className="mt-4 bg-[var(--err-bg)] p-4 text-sm font-semibold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }} role="alert">
                  {result.error}
                  {result.note && <p className="mt-1 font-normal">{result.note}</p>}
                  {result.sourceUrl && (
                    <p className="mt-2 break-all font-normal">
                      {t("dl.link_found")} <span className="font-mono text-xs">{result.sourceUrl}</span>
                      <br />
                      {t("dl.link_incomplete")}
                    </p>
                  )}
                </div>
              )}
              {result?.ok && chosenVideo && (
                <div className="mt-5">
                  <div className="flex flex-col items-center gap-1 text-center">
                    <span className="flex h-12 w-12 items-center justify-center bg-[var(--accent)] text-2xl font-extrabold text-[var(--accent-ink)] shadow-[0_0_28px_rgba(0,233,154,0.4)]" style={{ borderRadius: 999 }}>✓</span>
                    <h3 className="mt-1 text-2xl font-extrabold">{t("dl.ready")}</h3>
                    <p className="text-sm text-[var(--dim)]">{t("dl.ready_sub")}</p>
                  </div>
                  {result.note && <p className="mt-3 mb-2 text-sm text-[var(--dim)]">{result.note}</p>}
                  <video
                    key={chosenVideo.url}
                    src={chosenVideo.url}
                    poster={result.coverUrl ?? undefined}
                    controls
                    playsInline
                    width={chosenVideo.width ?? undefined}
                    height={chosenVideo.height ?? undefined}
                    className="mx-auto max-h-[75vh] w-auto max-w-full bg-black object-contain"
                    style={{
                      borderRadius: "var(--radius)",
                      ...(chosenVideo.width && chosenVideo.height
                        ? { aspectRatio: `${chosenVideo.width} / ${chosenVideo.height}` }
                        : {}),
                    }}
                  />
                  {chosenVideo.width && chosenVideo.height && (
                    <p className="mt-1 text-center text-xs text-[var(--dim)]">
                      {t("dl.file_size", { w: String(chosenVideo.width), h: String(chosenVideo.height) })}
                    </p>
                  )}
                  {result.title && <p className="mt-2 text-sm font-semibold">{result.title}</p>}

                  <p className="mt-4 text-sm font-bold">{t("dl.choose_quality")}</p>
                  <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="Video quality options">
                    {result.videos.map((v, i) => (
                      <button
                        key={v.url}
                        type="button"
                        role="radio"
                        aria-checked={i === selectedVideo}
                        onClick={() => setSelectedVideo(i)}
                        className={`flex items-center justify-between gap-2 border px-4 py-2.5 text-left text-sm font-semibold ${i === selectedVideo ? "border-[var(--accent)] bg-[var(--surface-alt)]" : "border-[var(--border)]"}`}
                        style={{ borderRadius: "var(--radius)" }}
                      >
                        <span className="min-w-0 flex-1 truncate">🎬 {v.label}</span>
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          {[v.width && v.height ? `${v.width}×${v.height}` : null, formatBytes(v.sizeBytes), "MP4"]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={downloading === "main"}
                    onClick={() => onDownload(chosenVideo.url, "jimeng-no-watermark.mp4", "main")}
                    className="cta-gradient mt-3 w-full px-5 py-3 text-base font-extrabold disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {downloading === "main" ? t("dl.preparing") : t("dl.download_mp4")}
                  </button>
                  {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
                  {prepared?.tag === "main" && (
                    <SavePanel prepared={prepared} onShare={() => onShare("main")} />
                  )}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => { setResult(null); setLinkText(""); setLinkError(null); setPasteMsg(null); }}
                      className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("dl.download_another")}
                    </button>
                    <button
                      type="button"
                      onClick={onGoHistory}
                      className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("dl.saved_history")}
                    </button>
                    <FavoriteButton downloadId={result.downloadId} label={chosenVideo.label} />
                  </div>
                  <p className="mt-3 flex flex-wrap items-center justify-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.08)] px-4 py-2.5 text-center text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>
                    {t("dl.tip_offline")}
                  </p>
                  <p className="mt-2 text-xs text-[var(--dim)]">
                    {t("dl.how_save")}
                  </p>

                  {result.images.length > 0 && (
                    <>
                      <p className="mt-5 text-sm font-bold">{t("dl.images_from_link")}</p>
                      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {result.images.map((img, i) => (
                          <figure key={img.url} className="border border-[var(--border)] p-2" style={{ borderRadius: "var(--radius)" }}>
                            <img src={img.url} alt={t("dl.image_alt", { n: String(i + 1) })} className="h-28 w-full bg-[var(--surface-alt)] object-contain" loading="lazy" />
                            <button
                              type="button"
                              disabled={downloading === `img-${i}`}
                              onClick={() => onDownload(img.url, `jimeng-image-${i + 1}.jpg`, `img-${i}`)}
                              className="mt-2 w-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                              style={{ borderRadius: "var(--radius)" }}
                            >
                              {downloading === `img-${i}` ? "…" : t("dl.image_download")}
                            </button>
                          </figure>
                        ))}
                      </div>
                      {prepared?.tag.startsWith("img-") && (
                        <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
                      )}
                    </>
                  )}
                </div>
              )}
              {result?.ok && !chosenVideo && result.images.length > 0 && (
                <div className="mt-5">
                  {result.note && <p className="mb-2 text-sm text-[var(--dim)]">{result.note}</p>}
                  <p className="text-sm font-semibold">{t("dl.no_video")}</p>
                  {result.title && <p className="mt-2 text-sm font-semibold">{result.title}</p>}
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {result.images.map((img, i) => (
                      <figure key={img.url} className="border border-[var(--border)] p-2" style={{ borderRadius: "var(--radius)" }}>
                        <img src={img.url} alt={t("dl.image_alt", { n: String(i + 1) })} className="h-28 w-full bg-[var(--surface-alt)] object-contain" loading="lazy" />
                        <button
                          type="button"
                          disabled={downloading === `img-${i}`}
                          onClick={() => onDownload(img.url, `jimeng-image-${i + 1}.jpg`, `img-${i}`)}
                          className="mt-2 w-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                          style={{ borderRadius: "var(--radius)" }}
                        >
                          {downloading === `img-${i}` ? "…" : t("dl.image_download")}
                        </button>
                      </figure>
                    ))}
                  </div>
                  {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
                  {prepared?.tag.startsWith("img-") && (
                    <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
                  )}
                </div>
              )}
              {result?.ok && <SmartLinkBanner smartLink={smartLink} />}
            </>
          )}

          {mode === "bulk" && (
            <>
              <div className="mt-5 flex flex-col items-center gap-1 border-2 border-dashed border-[var(--ad-border)] bg-[var(--surface-alt)] px-4 py-5 text-center" style={{ borderRadius: "var(--radius)" }}>
                <span className="text-4xl" aria-hidden="true">☁️</span>
                <p className="text-base font-extrabold">{t("dl.bulk_intro_title")}</p>
                <p className="text-sm text-[var(--dim)]">{t("dl.bulk_intro_text", { n: String(BULK_MAX_LINKS) })}</p>
              </div>
              <label htmlFor="bulk-links" className="mt-4 block text-sm font-bold">{t("dl.bulk_label")}</label>
              <textarea
                id="bulk-links"
                aria-label={t("dl.bulk_links_aria")}
                value={bulkText}
                onChange={(e) => { setBulkText(e.target.value); if (bulkTextError) setBulkTextError(null); }}
                placeholder={"https://jimeng.jianying.com/s/xxxxx\nhttps://jimeng.jianying.com/s/yyyyy"}
                rows={6}
                className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
                style={{ borderRadius: "var(--radius)" }}
              />
              {bulkTextError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{bulkTextError}</p>}
              <button
                type="button"
                disabled={bulkRunning}
                onClick={handleBulk}
                className="cta-gradient mt-3 w-full px-5 py-3 text-base font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {bulkRunning ? t("dl.fetching_videos") : t("dl.fetch_all_n", { n: String(BULK_MAX_LINKS) })}
              </button>
              {items.length > 0 && (
                <div className="mt-4" role="status">
                  <div className="flex justify-between text-sm font-bold">
                    <span>{bulkRunning ? t("dl.progress_working", { done: String(doneCount), total: String(items.length) }) : t("dl.progress_done", { done: String(doneCount), total: String(items.length) })}</span>
                    <span>{Math.round((doneCount / Math.max(1, items.length)) * 100)}%</span>
                  </div>
                  <div className="mt-1 h-3 w-full overflow-hidden bg-[var(--surface-alt)]" style={{ borderRadius: 999 }}>
                    <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${Math.round((doneCount / Math.max(1, items.length)) * 100)}%` }} />
                  </div>
                </div>
              )}
              {doneCount > 0 && (
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    disabled={batchRunning || zipRunning || bulkRunning}
                    onClick={handleDownloadAll}
                    className="flex-1 bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {batchRunning ? (batchStatus ?? t("dl.downloading")) : t("dl.download_all_n", { n: String(doneCount) })}
                  </button>
                  <button
                    type="button"
                    disabled={batchRunning || zipRunning || bulkRunning}
                    onClick={handleDownloadZip}
                    className="flex-1 border border-[var(--accent)] bg-[var(--surface)] px-4 py-3 text-sm font-extrabold text-[var(--accent)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {zipRunning ? (zipStatus ?? t("dl.preparing_zip")) : t("dl.download_zip_n", { n: String(doneCount) })}
                  </button>
                </div>
              )}
              {batchSummary && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{batchSummary}</p>}
              {zipSummary && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{zipSummary}</p>}
              {(batchRunning || zipRunning) && (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  {t("dl.limit_note")}
                </p>
              )}
              {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
              <ul className="mt-3 flex flex-col gap-3">
                {items.map((item, i) => {
                  const video = item.result?.ok ? item.result.videos[item.selectedVideo] : undefined;
                  const tag = `bulk-${i}`;
                  return (
                    <li key={i} className="glass card-hover border border-[var(--border)] bg-[var(--surface)] p-3" style={{ borderRadius: "var(--radius)" }}>
                      <div className="flex gap-3">
                        {item.result?.ok && item.result.coverUrl ? (
                          <img src={item.result.coverUrl} alt="" className="h-20 w-16 shrink-0 object-cover" style={{ borderRadius: 10 }} />
                        ) : (
                          <div className="flex h-20 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-2xl" style={{ borderRadius: 10 }}>🎬</div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate text-xs text-[var(--dim)]">{item.line}</p>
                            {item.status === "waiting" && <StatusPill tone="gray" label={t("dl.status_waiting")} />}
                            {item.status === "working" && <StatusPill tone="amber" label={t("dl.status_fetching")} pulse />}
                            {item.status === "done" && <StatusPill tone="green" label={t("dl.status_done")} />}
                            {item.status === "error" && <StatusPill tone="red" label={t("dl.status_error")} />}
                          </div>
                          {item.status === "waiting" && <p className="mt-1 text-sm font-semibold text-[var(--dim)]">{t("dl.waiting_turn")}</p>}
                          {item.status === "working" && <p className="mt-1 text-sm font-semibold">{t("dl.fetching")}</p>}
                          {item.status === "error" && item.result && !item.result.ok && (
                            <p className="mt-1 text-sm font-semibold text-[var(--err-text)]">{item.result.error}</p>
                          )}
                          {item.status === "done" && item.result?.ok && (
                            <>
                              <p className="mt-1 truncate text-sm font-bold">{item.result.title || "Jimeng video"}</p>
                              {video ? (
                                <>
                                  <label className="mt-2 block text-xs font-bold text-[var(--dim)]" htmlFor={`bulk-quality-${i}`}>
                                    {t("dl.choose_quality_bulk")}
                                  </label>
                                  <select
                                    id={`bulk-quality-${i}`}
                                    aria-label={t("dl.export_quality_for", { n: String(i + 1) })}
                                    value={item.selectedVideo}
                                    onChange={(e) => {
                                      const next = Number(e.target.value);
                                      setItems((prev) => prev.map((it, j) => (j === i ? { ...it, selectedVideo: next } : it)));
                                    }}
                                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-semibold"
                                    style={{ borderRadius: "var(--radius)" }}
                                  >
                                    {item.result.videos.map((v, vi) => (
                                      <option key={v.url} value={vi}>
                                        {v.label}
                                        {[v.width && v.height ? ` ${v.width}×${v.height}` : null, formatBytes(v.sizeBytes) ? ` · ${formatBytes(v.sizeBytes)}` : null]
                                          .filter(Boolean)
                                          .join("")}
                                      </option>
                                    ))}
                                  </select>
                                  <p className="mt-1 text-xs text-[var(--dim)]">
                                    {[video.label, video.width && video.height ? `${video.width}×${video.height}` : null, formatBytes(video.sizeBytes), "MP4"].filter(Boolean).join(" · ")}
                                  </p>
                                  <button
                                    type="button"
                                    disabled={downloading === tag}
                                    onClick={() => onDownload(video.url, slugFilename(item.result!.title, `jimeng-video-${i + 1}.mp4`), tag)}
                                    className="mt-1.5 bg-[var(--accent)] px-3 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                                    style={{ borderRadius: 8 }}
                                  >
                                    {downloading === tag ? t("dl.preparing") : t("dl.download_mp4")}
                                  </button>
                                  <span className="mt-1.5 inline-block">
                                    <FavoriteButton downloadId={item.result.downloadId} label={video.label} />
                                  </span>
                                </>
                              ) : (
                                <p className="mt-1 text-sm font-semibold">{t("dl.no_video_bulk")}</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {prepared?.tag === tag && (
                        <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
                      )}
                    </li>
                  );
                })}
              </ul>
              {items.length > 0 && <SmartLinkBanner smartLink={smartLink} />}
            </>
          )}
        </SectionCard>
      </main>

      {/* Sidebar */}
      <aside className="flex min-w-0 flex-col gap-6">
        <SectionCard>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>✓</span>
            Supported links
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {[
              "jimeng.jianying.com/s/xxxxx",
              "jimeng.cn",
              "dreamina.jianying.com",
              "dreamina.capcut.com",
            ].map((link) => (
              <li key={link} className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-xs font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span>
                <span className="break-all">{link}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex items-start gap-2 border-t border-[var(--border)] pt-3 text-sm text-[var(--dim)]">
            <span className="text-[var(--accent)]">ℹ️</span> Only public / published creations work.
          </p>
        </SectionCard>
        <AdSlot label="Advertisement · Sidebar" sub="300 × 250" saved={sidebarAdSaved} code={sidebarAdCode} tall />
        <SectionCard>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>?</span>
            {t("home.need_help")}
          </h2>
          <div className="mt-3 flex flex-col">
            <button type="button" onClick={() => onGoHistory()} className="flex items-center justify-between border-b border-[var(--border)] py-2.5 text-left text-sm font-bold text-[var(--accent)]">
              <span>{t("menu.history")}</span><span aria-hidden="true">›</span>
            </button>
            <p className="py-2.5 text-sm text-[var(--dim)]">Tip: on a phone, open the playing video's ⋮ menu → Share → Save to save it straight to your gallery.</p>
          </div>
        </SectionCard>
      </aside>
    </div>
  );
}
/* ------------------------------------------------------------------ */
/* Douyin downloader page — Single + Bulk (max 5) modes, mirroring    */
/* the Jimeng page's structure and behaviour. Downloads go through    */
/* the same prepareDownload flow (same free daily limit / plan        */
/* quota, same Save panel), and resolves land in the same History,    */
/* labelled Douyin. The default quality is 720p: Douyin files are     */
/* large, and only the tiers the resolver actually confirmed for      */
/* that video are listed.                                             */
/* ------------------------------------------------------------------ */

const DOUYIN_BULK_MAX_LINKS = 5;

function DouyinDownloaderPage({
  initialMode,
  downloading,
  prepared,
  downloadNote,
  onDownload,
  onShare,
  onGoPlans,
  onGoHistory,
  sidebarAdSaved,
  sidebarAdCode,
  smartLink,
}: JimengDownloaderPageProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"single" | "bulk">(initialMode);

  // Same saved-default-mode behaviour as the Jimeng page.
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  /* ---------------- Single mode state ---------------- */
  const [linkText, setLinkText] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [selectedVideo, setSelectedVideo] = useState(0);
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);
  const chosenVideo = result?.ok ? result.videos[selectedVideo] : undefined;

  const resolve = useMutation({
    mutationFn: (text: string) => api.resolveDouyinLink({ text, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: (data) => {
      setResult(data);
      // Douyin's default quality is 720p (its files are large); when
      // this video does not offer 720p, the best available is used.
      setSelectedVideo(pickVideoIndex(data.videos, "720p"));
      if (data.ok) queryClient.invalidateQueries({ queryKey: ["history"] });
    },
    onError: () => {
      setResult({
        ok: false, sourceUrl: "", title: "", coverUrl: null, videos: [], images: [],
        usedCustomApi: false, note: null, downloadId: null,
        error: t("common.error_server"),
      });
    },
  });

  function handleResolve() {
    if (!linkText.trim()) {
      setLinkError(t("dy.link_empty"));
      return;
    }
    setLinkError(null);
    resolve.mutate(linkText.trim());
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setLinkText(text);
        setLinkError(null);
        setPasteMsg(t("dl.pasted"));
      } else setPasteMsg(t("dy.clipboard_empty"));
    } catch {
      setPasteMsg(t("dl.paste_failed"));
    }
  }

  /* ---------------- Bulk mode state (max 5) ---------------- */
  const [bulkText, setBulkText] = useState("");
  const [bulkTextError, setBulkTextError] = useState<string | null>(null);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);
  const [zipRunning, setZipRunning] = useState(false);
  const [zipStatus, setZipStatus] = useState<string | null>(null);
  const [zipSummary, setZipSummary] = useState<string | null>(null);

  async function handleBulk() {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      setBulkTextError(t("dy.bulk_empty"));
      return;
    }
    setBulkTextError(null);
    setBatchSummary(null);
    setZipSummary(null);
    const batch = lines.slice(0, DOUYIN_BULK_MAX_LINKS);
    setItems(batch.map((line) => ({ line, status: "waiting", result: null, selectedVideo: 0 })));
    setBulkRunning(true);
    for (let i = 0; i < batch.length; i++) {
      const line = batch[i];
      if (!line) continue;
      setItems((prev) => prev.map((it, j) => (j === i ? { ...it, status: "working" } : it)));
      try {
        const data = await api.resolveDouyinLink({ text: line, token: getUserToken(), anonId: getAnonId() });
        setItems((prev) =>
          prev.map((it, j) => (j === i ? { ...it, status: data.ok ? "done" : "error", result: data, selectedVideo: pickVideoIndex(data.videos, "720p") } : it)),
        );
        if (data.ok) queryClient.invalidateQueries({ queryKey: ["history"] });
      } catch {
        setItems((prev) =>
          prev.map((it, j) =>
            j === i
              ? {
                  ...it,
                  status: "error",
                  result: {
                    ok: false, sourceUrl: line, title: "", coverUrl: null, videos: [], images: [],
                    usedCustomApi: false, note: null, downloadId: null,
                    error: t("common.error_server"),
                  },
                }
              : it,
          ),
        );
      }
    }
    setBulkRunning(false);
  }

  /** Videos that fetched successfully, with their chosen export quality. */
  function batchTargets() {
    return items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.status === "done" && it.result?.ok && it.result.videos[it.selectedVideo]);
  }

  /** Same prepareDownload as the Jimeng page: each video counts toward
   *  the free daily limit / plan quota, and a hit limit returns
   *  limitReached so the Plans page can open. */
  async function prepareOne(
    videoUrl: string,
  ): Promise<
    | { ok: true; downloadUrl: string; sizeBytes: number }
    | { ok: false; error: string; limitReached: boolean }
  > {
    try {
      const prep = await api.prepareDownload({ url: videoUrl, token: getUserToken(), anonId: getAnonId() });
      if (prep.ok && prep.downloadUrl) {
        return { ok: true, downloadUrl: prep.downloadUrl, sizeBytes: prep.sizeBytes };
      }
      return { ok: false, error: prep.error ?? t("dl.prepare_failed"), limitReached: prep.limitReached };
    } catch {
      return { ok: false, error: t("dl.no_response_short"), limitReached: false };
    }
  }

  async function handleDownloadAll() {
    const targets = batchTargets();
    if (targets.length === 0 || batchRunning) return;
    setBatchRunning(true);
    setBatchSummary(null);
    let okCount = 0;
    const failed: string[] = [];
    let hitLimit = false;
    for (let n = 0; n < targets.length; n++) {
      const entry = targets[n];
      if (!entry) continue;
      const { it, i } = entry;
      const video = it.result!.videos[it.selectedVideo]!;
      const name = it.result!.title || t("dy.douyin_video") + ` ${i + 1}`;
      setBatchStatus(t("dl.downloading_n", { n: String(n + 1), total: String(targets.length), name }));
      const prep = await prepareOne(video.url);
      if (!prep.ok) {
        failed.push(`${name}: ${prep.error}`);
        if (prep.limitReached) {
          hitLimit = true;
          break;
        }
        continue;
      }
      triggerBrowserDownload(prep.downloadUrl, slugFilename(it.result!.title, `douyin-video-${i + 1}.mp4`));
      okCount++;
      if (n < targets.length - 1) await sleep(1500);
    }
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["history"] });
    setBatchRunning(false);
    setBatchStatus(null);
    setBatchSummary(
      [
        t("dl.batch_done", { ok: String(okCount), total: String(targets.length), s: targets.length === 1 ? "" : "s" }),
        failed.length > 0
          ? t("dl.batch_failed", { n: String(failed.length), list: failed.slice(0, 3).join(" · ") }) + (failed.length > 3 ? ` ${t("dl.and_more", { n: String(failed.length - 3) })}` : "")
          : null,
        t("dl.batch_fallback"),
      ].filter(Boolean).join(" "),
    );
    if (hitLimit) onGoPlans();
  }

  async function handleDownloadZip() {
    const targets = batchTargets();
    if (targets.length === 0 || zipRunning) return;
    setZipRunning(true);
    setZipSummary(null);
    const zip = new JSZip();
    const usedNames = new Set<string>();
    let added = 0;
    const failed: string[] = [];
    let hitLimit = false;
    for (let n = 0; n < targets.length; n++) {
      const entry = targets[n];
      if (!entry) continue;
      const { it, i } = entry;
      const video = it.result!.videos[it.selectedVideo]!;
      const name = it.result!.title || t("dy.douyin_video") + ` ${i + 1}`;
      setZipStatus(t("dl.zip_preparing_n", { n: String(n + 1), total: String(targets.length), name }));
      const prep = await prepareOne(video.url);
      if (!prep.ok) {
        failed.push(`${name}: ${prep.error}`);
        if (prep.limitReached) {
          hitLimit = true;
          break;
        }
        continue;
      }
      try {
        const res = await fetch(prep.downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size === 0) throw new Error("empty file");
        zip.file(
          uniqueZipName(slugFilename(it.result!.title, `douyin-video-${i + 1}.mp4`), usedNames),
          blob,
        );
        added++;
      } catch {
        failed.push(t("dl.zip_failed_read", { name }));
      }
    }
    if (added === 0) {
      setZipRunning(false);
      setZipStatus(null);
      setZipSummary(
        `${t("dl.zip_none")} ${failed.slice(0, 3).join(" · ")}`,
      );
      if (hitLimit) onGoPlans();
      return;
    }
    setZipStatus(t("dl.zipping", { n: String(added), s: added === 1 ? "" : "s" }));
    try {
      // MP4s are already compressed, so STORE keeps zipping fast and light.
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const url = URL.createObjectURL(zipBlob);
      triggerBrowserDownload(url, "douyin-videos.zip");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setZipSummary(
        [
          t("dl.zip_ready", { n: String(added), s: added === 1 ? "" : "s" }),
          failed.length > 0
            ? t("dl.zip_skipped", { n: String(failed.length), list: failed.slice(0, 3).join(" · ") }) + (failed.length > 3 ? ` ${t("dl.and_more", { n: String(failed.length - 3) })}` : "")
            : null,
        ].filter(Boolean).join(" "),
      );
    } catch {
      setZipSummary(t("dl.zip_failed"));
    }
    queryClient.invalidateQueries({ queryKey: ["me"] });
    queryClient.invalidateQueries({ queryKey: ["history"] });
    setZipRunning(false);
    setZipStatus(null);
    if (hitLimit) onGoPlans();
  }

  const doneCount = items.filter((it) => it.status === "done").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <main className="flex min-w-0 flex-col gap-6">
        <PageHero icon="🎵" title={t("menu.douyin")} subtitle={t("dy.subtitle")} />
        <p className="mx-auto flex max-w-full flex-wrap items-center justify-center gap-2 border border-[rgba(251,191,36,0.4)] bg-[var(--warn-bg)] px-4 py-2 text-center text-sm font-bold text-[var(--warn-text)]" style={{ borderRadius: 999 }}>
          {t("dl.public_only")}
        </p>

        <SectionCard className="border-[rgba(0,233,154,0.35)] shadow-[0_0_45px_rgba(0,233,154,0.10)]">
          {/* Single / Bulk mode toggle */}
          <div className="flex gap-2" role="tablist" aria-label={t("dl.download_mode")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "single"}
              onClick={() => setMode("single")}
              className={`flex-1 px-4 py-2.5 text-sm font-extrabold ${mode === "single" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              {t("dl.single")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "bulk"}
              onClick={() => setMode("bulk")}
              className={`flex-1 px-4 py-2.5 text-sm font-extrabold ${mode === "bulk" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              {t("dl.bulk", { n: String(DOUYIN_BULK_MAX_LINKS) })}
            </button>
          </div>

          {mode === "single" && (
            <>
              <h2 className="mt-5 flex items-center gap-2 text-xl font-extrabold">
                <span className="text-[var(--accent)]">🔗</span> {t("dy.paste_heading")}
              </h2>
              <p className="mt-1 text-sm text-[var(--dim)]">
                {t("dy.paste_hint")}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <textarea
                  {...FIELDS.resolveDouyinLink.text}
                  id="douyin-link"
                  aria-label={t("dy.link_aria")}
                  value={linkText}
                  onChange={(e) => { setLinkText(e.target.value); if (linkError) setLinkError(null); }}
                  placeholder="https://v.douyin.com/xxxxx"
                  rows={2}
                  className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
                  style={{ borderRadius: "var(--radius)" }}
                />
                <div className="flex gap-2 sm:flex-col">
                  <button type="button" onClick={handlePaste} className="glass flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm font-bold sm:flex-none" style={{ borderRadius: "var(--radius)" }}>
                    {t("dl.paste")}
                  </button>
                  <button type="button" onClick={() => { setLinkText(""); setResult(null); setLinkError(null); }} className="flex-1 border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--dim)] sm:flex-none" style={{ borderRadius: "var(--radius)" }}>
                    {t("dl.clear")}
                  </button>
                </div>
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                {t("dy.tip_share_text")}
              </p>
              {linkError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{linkError}</p>}
              <button
                type="button"
                disabled={resolve.isPending}
                onClick={handleResolve}
                className="cta-gradient mt-3 w-full px-5 py-3.5 text-lg font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {resolve.isPending ? t("dl.fetching") : t("dl.get_video")}
              </button>
              <p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-sm font-semibold text-[var(--dim)]">
                <span><span className="text-[var(--accent)]">✓</span> {t("dl.free_start")}</span>
                <span aria-hidden="true" className="text-[var(--border)]">|</span>
                <span><span className="text-[var(--accent)]">⚡</span> {t("dl.original_mp4")}</span>
                <span aria-hidden="true" className="text-[var(--border)]">|</span>
                <span><span className="text-[var(--accent)]">✓</span> {t("dl.no_login")}</span>
              </p>
              {pasteMsg && <p className="mt-2 text-sm text-[var(--dim)]">{pasteMsg}</p>}

              {/* Single result */}
              {result && !result.ok && (
                <div className="mt-4 bg-[var(--err-bg)] p-4 text-sm font-semibold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }} role="alert">
                  {result.error}
                  {result.note && <p className="mt-1 font-normal">{result.note}</p>}
                  {result.sourceUrl && (
                    <p className="mt-2 break-all font-normal">
                      {t("dl.link_found")} <span className="font-mono text-xs">{result.sourceUrl}</span>
                      <br />
                      {t("dy.link_incomplete")}
                    </p>
                  )}
                </div>
              )}
              {result?.ok && chosenVideo && (
                <div className="mt-5">
                  <div className="flex flex-col items-center gap-1 text-center">
                    <span className="flex h-12 w-12 items-center justify-center bg-[var(--accent)] text-2xl font-extrabold text-[var(--accent-ink)] shadow-[0_0_28px_rgba(0,233,154,0.4)]" style={{ borderRadius: 999 }}>✓</span>
                    <h3 className="mt-1 text-2xl font-extrabold">{t("dl.ready")}</h3>
                    <p className="text-sm text-[var(--dim)]">{t("dl.ready_sub")}</p>
                  </div>
                  {result.note && <p className="mt-3 mb-2 text-sm text-[var(--dim)]">{result.note}</p>}
                  <video
                    key={chosenVideo.url}
                    src={chosenVideo.url}
                    poster={result.coverUrl ?? undefined}
                    controls
                    playsInline
                    width={chosenVideo.width ?? undefined}
                    height={chosenVideo.height ?? undefined}
                    className="mx-auto max-h-[75vh] w-auto max-w-full bg-black object-contain"
                    style={{
                      borderRadius: "var(--radius)",
                      ...(chosenVideo.width && chosenVideo.height
                        ? { aspectRatio: `${chosenVideo.width} / ${chosenVideo.height}` }
                        : {}),
                    }}
                  />
                  {chosenVideo.width && chosenVideo.height && (
                    <p className="mt-1 text-center text-xs text-[var(--dim)]">
                      {t("dl.file_size", { w: String(chosenVideo.width), h: String(chosenVideo.height) })}
                    </p>
                  )}
                  {result.title && <p className="mt-2 text-sm font-semibold">{result.title}</p>}

                  <p className="mt-4 text-sm font-bold">{t("dl.choose_quality")}</p>
                  <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="Video quality options">
                    {result.videos.map((v, i) => (
                      <button
                        key={v.url}
                        type="button"
                        role="radio"
                        aria-checked={i === selectedVideo}
                        onClick={() => setSelectedVideo(i)}
                        className={`flex items-center justify-between gap-2 border px-4 py-2.5 text-left text-sm font-semibold ${i === selectedVideo ? "border-[var(--accent)] bg-[var(--surface-alt)]" : "border-[var(--border)]"}`}
                        style={{ borderRadius: "var(--radius)" }}
                      >
                        <span className="min-w-0 flex-1 truncate">🎵 {v.label}</span>
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          {[v.width && v.height ? `${v.width}×${v.height}` : null, formatBytes(v.sizeBytes), "MP4"]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-[var(--dim)]">{t("dy.quality_note")}</p>
                  <button
                    type="button"
                    disabled={downloading === "main"}
                    onClick={() => onDownload(chosenVideo.url, "douyin-no-watermark.mp4", "main")}
                    className="cta-gradient mt-3 w-full px-5 py-3 text-base font-extrabold disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {downloading === "main" ? t("dl.preparing") : t("dl.download_mp4")}
                  </button>
                  {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
                  {prepared?.tag === "main" && (
                    <SavePanel prepared={prepared} onShare={() => onShare("main")} />
                  )}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => { setResult(null); setLinkText(""); setLinkError(null); setPasteMsg(null); }}
                      className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("dl.download_another")}
                    </button>
                    <button
                      type="button"
                      onClick={onGoHistory}
                      className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {t("dl.saved_history")}
                    </button>
                    <FavoriteButton downloadId={result.downloadId} label={chosenVideo.label} />
                  </div>
                  <p className="mt-3 flex flex-wrap items-center justify-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.08)] px-4 py-2.5 text-center text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>
                    {t("dl.tip_offline")}
                  </p>
                  <p className="mt-2 text-xs text-[var(--dim)]">
                    {t("dl.how_save")}
                  </p>
                  <p className="mt-2 text-xs text-[var(--dim)]">
                    {t("dy.personal_note")}
                  </p>
                </div>
              )}
              {result?.ok && <SmartLinkBanner smartLink={smartLink} />}
            </>
          )}

          {mode === "bulk" && (
            <>
              <div className="mt-5 flex flex-col items-center gap-1 border-2 border-dashed border-[var(--ad-border)] bg-[var(--surface-alt)] px-4 py-5 text-center" style={{ borderRadius: "var(--radius)" }}>
                <span className="text-4xl" aria-hidden="true">☁️</span>
                <p className="text-base font-extrabold">{t("dl.bulk_intro_title")}</p>
                <p className="text-sm text-[var(--dim)]">{t("dy.bulk_intro_text", { n: String(DOUYIN_BULK_MAX_LINKS) })}</p>
              </div>
              <label htmlFor="douyin-bulk-links" className="mt-4 block text-sm font-bold">{t("dy.bulk_label")}</label>
              <textarea
                id="douyin-bulk-links"
                aria-label={t("dy.bulk_links_aria")}
                value={bulkText}
                onChange={(e) => { setBulkText(e.target.value); if (bulkTextError) setBulkTextError(null); }}
                placeholder={"https://v.douyin.com/xxxxx\nhttps://v.douyin.com/yyyyy"}
                rows={6}
                className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
                style={{ borderRadius: "var(--radius)" }}
              />
              {bulkTextError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{bulkTextError}</p>}
              <button
                type="button"
                disabled={bulkRunning}
                onClick={handleBulk}
                className="cta-gradient mt-3 w-full px-5 py-3 text-base font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {bulkRunning ? t("dl.fetching_videos") : t("dl.fetch_all_n", { n: String(DOUYIN_BULK_MAX_LINKS) })}
              </button>
              {items.length > 0 && (
                <div className="mt-4" role="status">
                  <div className="flex justify-between text-sm font-bold">
                    <span>{bulkRunning ? t("dl.progress_working", { done: String(doneCount), total: String(items.length) }) : t("dl.progress_done", { done: String(doneCount), total: String(items.length) })}</span>
                    <span>{Math.round((doneCount / Math.max(1, items.length)) * 100)}%</span>
                  </div>
                  <div className="mt-1 h-3 w-full overflow-hidden bg-[var(--surface-alt)]" style={{ borderRadius: 999 }}>
                    <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${Math.round((doneCount / Math.max(1, items.length)) * 100)}%` }} />
                  </div>
                </div>
              )}
              {doneCount > 0 && (
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    disabled={batchRunning || zipRunning || bulkRunning}
                    onClick={handleDownloadAll}
                    className="flex-1 bg-[var(--accent)] px-4 py-3 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {batchRunning ? (batchStatus ?? t("dl.downloading")) : t("dl.download_all_n", { n: String(doneCount) })}
                  </button>
                  <button
                    type="button"
                    disabled={batchRunning || zipRunning || bulkRunning}
                    onClick={handleDownloadZip}
                    className="flex-1 border border-[var(--accent)] bg-[var(--surface)] px-4 py-3 text-sm font-extrabold text-[var(--accent)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {zipRunning ? (zipStatus ?? t("dl.preparing_zip")) : t("dl.download_zip_n", { n: String(doneCount) })}
                  </button>
                </div>
              )}
              {batchSummary && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{batchSummary}</p>}
              {zipSummary && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{zipSummary}</p>}
              {(batchRunning || zipRunning) && (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  {t("dl.limit_note")}
                </p>
              )}
              {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
              <ul className="mt-3 flex flex-col gap-3">
                {items.map((item, i) => {
                  const video = item.result?.ok ? item.result.videos[item.selectedVideo] : undefined;
                  const tag = `bulk-${i}`;
                  return (
                    <li key={i} className="glass card-hover border border-[var(--border)] bg-[var(--surface)] p-3" style={{ borderRadius: "var(--radius)" }}>
                      <div className="flex gap-3">
                        {item.result?.ok && item.result.coverUrl ? (
                          <img src={item.result.coverUrl} alt="" className="h-20 w-16 shrink-0 object-cover" style={{ borderRadius: 10 }} />
                        ) : (
                          <div className="flex h-20 w-16 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-2xl" style={{ borderRadius: 10 }}>🎵</div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate text-xs text-[var(--dim)]">{item.line}</p>
                            {item.status === "waiting" && <StatusPill tone="gray" label={t("dl.status_waiting")} />}
                            {item.status === "working" && <StatusPill tone="amber" label={t("dl.status_fetching")} pulse />}
                            {item.status === "done" && <StatusPill tone="green" label={t("dl.status_done")} />}
                            {item.status === "error" && <StatusPill tone="red" label={t("dl.status_error")} />}
                          </div>
                          {item.status === "waiting" && <p className="mt-1 text-sm font-semibold text-[var(--dim)]">{t("dl.waiting_turn")}</p>}
                          {item.status === "working" && <p className="mt-1 text-sm font-semibold">{t("dl.fetching")}</p>}
                          {item.status === "error" && item.result && !item.result.ok && (
                            <p className="mt-1 text-sm font-semibold text-[var(--err-text)]">{item.result.error}</p>
                          )}
                          {item.status === "done" && item.result?.ok && (
                            <>
                              <p className="mt-1 truncate text-sm font-bold">{item.result.title || "Douyin video"}</p>
                              {video ? (
                                <>
                                  <label className="mt-2 block text-xs font-bold text-[var(--dim)]" htmlFor={`douyin-bulk-quality-${i}`}>
                                    {t("dl.choose_quality_bulk")}
                                  </label>
                                  <select
                                    id={`douyin-bulk-quality-${i}`}
                                    aria-label={t("dl.export_quality_for", { n: String(i + 1) })}
                                    value={item.selectedVideo}
                                    onChange={(e) => {
                                      const next = Number(e.target.value);
                                      setItems((prev) => prev.map((it, j) => (j === i ? { ...it, selectedVideo: next } : it)));
                                    }}
                                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-semibold"
                                    style={{ borderRadius: "var(--radius)" }}
                                  >
                                    {item.result.videos.map((v, vi) => (
                                      <option key={v.url} value={vi}>
                                        {v.label}
                                        {[v.width && v.height ? ` ${v.width}×${v.height}` : null, formatBytes(v.sizeBytes) ? ` · ${formatBytes(v.sizeBytes)}` : null]
                                          .filter(Boolean)
                                          .join("")}
                                      </option>
                                    ))}
                                  </select>
                                  <p className="mt-1 text-xs text-[var(--dim)]">
                                    {[video.label, video.width && video.height ? `${video.width}×${video.height}` : null, formatBytes(video.sizeBytes), "MP4"].filter(Boolean).join(" · ")}
                                  </p>
                                  <button
                                    type="button"
                                    disabled={downloading === tag}
                                    onClick={() => onDownload(video.url, slugFilename(item.result!.title, `douyin-video-${i + 1}.mp4`), tag)}
                                    className="mt-1.5 bg-[var(--accent)] px-3 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                                    style={{ borderRadius: 8 }}
                                  >
                                    {downloading === tag ? t("dl.preparing") : t("dl.download_mp4")}
                                  </button>
                                  <span className="mt-1.5 inline-block">
                                    <FavoriteButton downloadId={item.result.downloadId} label={video.label} />
                                  </span>
                                </>
                              ) : (
                                <p className="mt-1 text-sm font-semibold">{t("dl.no_video_bulk")}</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {prepared?.tag === tag && (
                        <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
                      )}
                    </li>
                  );
                })}
              </ul>
              {items.length > 0 && <SmartLinkBanner smartLink={smartLink} />}
            </>
          )}
        </SectionCard>
      </main>

      {/* Sidebar */}
      <aside className="flex min-w-0 flex-col gap-6">
        <SectionCard>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>✓</span>
            Supported links
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {[
              "v.douyin.com/xxxxx",
              "douyin.com/video/…",
              "iesdouyin.com/share/video/…",
            ].map((link) => (
              <li key={link} className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-xs font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span>
                <span className="break-all">{link}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex items-start gap-2 border-t border-[var(--border)] pt-3 text-sm text-[var(--dim)]">
            <span className="text-[var(--accent)]">ℹ️</span> {t("dy.supported_note")}
          </p>
          <p className="mt-2 text-sm text-[var(--dim)]">{t("dy.personal_note")}</p>
        </SectionCard>
        <AdSlot label="Advertisement · Sidebar" sub="300 × 250" saved={sidebarAdSaved} code={sidebarAdCode} tall />
        <SectionCard>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>?</span>
            {t("home.need_help")}
          </h2>
          <div className="mt-3 flex flex-col">
            <button type="button" onClick={() => onGoHistory()} className="flex items-center justify-between border-b border-[var(--border)] py-2.5 text-left text-sm font-bold text-[var(--accent)]">
              <span>{t("menu.history")}</span><span aria-hidden="true">›</span>
            </button>
            <p className="py-2.5 text-sm text-[var(--dim)]">Tip: on a phone, open the playing video's ⋮ menu → Share → Save to save it straight to your gallery.</p>
          </div>
        </SectionCard>
      </aside>
    </div>
  );
}

function WhatIsJimengPage() {
  const t = useT();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="❓" title={t("menu.whatis")} subtitle={t("page.whatis_sub")} />
      <SectionCard className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
        <span className="flex h-24 w-24 shrink-0 items-center justify-center border border-[rgba(0,233,154,0.4)] bg-[rgba(0,233,154,0.08)] shadow-[0_0_40px_rgba(0,233,154,0.20)]" style={{ borderRadius: 24 }}>
          <Logo />
        </span>
        <div>
          <h2 className="text-lg font-extrabold">Jimeng AI (Dreamina)</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">Create amazing videos with AI — text-to-video, image-to-video and AI images in one place, powered by the Seedance model family.</p>
        </div>
      </SectionCard>
      <SectionCard>
        <h2 className="text-lg font-extrabold">What is Jimeng AI?</h2>
        <p className="mt-2 text-base leading-relaxed">
          Jimeng AI (jimeng.jianying.com) is ByteDance's AI creative platform — the same company behind TikTok and CapCut. You can create AI videos and images just by typing text or providing an image. It runs on the Seedance model family (Seedance 2.0 is its well-known video model), and text-to-video, image-to-video and AI image generation are all available in one place.
        </p>
        <p className="mt-2 text-base leading-relaxed">
          Jimeng is mainly for China; its international version is <strong>Dreamina</strong> (under CapCut) — so public Dreamina share links can also work with this downloader.
        </p>
      </SectionCard>
      <SectionCard>
        <h2 className="text-lg font-extrabold">Why is there a watermark?</h2>
        <p className="mt-2 text-base leading-relaxed">
          When you save a video from inside the Jimeng app, Jimeng adds its watermark to it (the AI badge at the top and the Jimeng @user mark at the bottom). But when a video is <strong>Published (Public)</strong>, Jimeng keeps its original master file on its server with no watermark on it. This downloader fetches that master file from the public share link — so you get a completely clean video.
        </p>
        <p className="mt-2 text-base leading-relaxed">
          The master file of private or draft videos is not public, so those links don't work here — you must Publish the video on Jimeng first.
        </p>
      </SectionCard>
      <SectionCard>
        <h2 className="text-lg font-extrabold">Why use this downloader?</h2>
        <ul className="mt-3 space-y-2 text-base">
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> Official &amp; Free</li>
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> No Watermark</li>
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> High Quality — original MP4 master file</li>
        </ul>
      </SectionCard>
      <p className="flex items-center justify-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.08)] px-4 py-2.5 text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>
        ✓ Tip: Only public videos can be downloaded.
      </p>
    </main>
  );
}

function HowToPage() {
  const t = useT();
  const steps = [
    { n: "1", icon: "🔗", title: "Copy Link", text: "Open Jimeng app, share video, and copy the link." },
    { n: "2", icon: "📋", title: "Paste Link", text: "Paste the link in our downloader box." },
    { n: "3", icon: "⬇", title: "Download", text: "Click the button and save your video." },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="📖" title={t("page.howto_title")} subtitle={t("page.howto_sub")} />
      <div className="grid gap-4 sm:grid-cols-3">
        {steps.map((step) => (
          <SectionCard key={step.n} className="card-hover text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center bg-[var(--accent)] text-xl font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>{step.n}</span>
            <p className="mt-3 text-3xl" aria-hidden="true">{step.icon}</p>
            <h2 className="mt-2 text-lg font-extrabold">{step.title}</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">{step.text}</p>
          </SectionCard>
        ))}
      </div>
      <SectionCard>
        <h2 className="text-xl font-extrabold">How to download — in detail</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-base">
          <li><strong>Copy the link:</strong> Open your video in the Jimeng AI app or site, first <strong>Publish (Public)</strong> it, then use the share arrow ↗ → link icon to copy the share link.</li>
          <li><strong>Paste it:</strong> Paste the link in the box on the Downloader page and tap “Get Video”. The video preview will play right here.</li>
          <li><strong>Choose a quality and download:</strong> Select the Origin (No Watermark) quality and tap “Download MP4” — the file is first prepared on this site's server, then the Save buttons appear below. On a phone, tap “Share and Save” and choose “Save to Files” or your Gallery app in the sheet; or use “Download Now” to save through your browser's download manager. (Direct downloads from Jimeng's CDN used to get stuck in the app, which is why the file is prepared on the server first.)</li>
        </ol>
      </SectionCard>
      <SectionCard>
        <h2 className="text-lg font-extrabold">Good to know</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">Another easy method that works on phones: open the playing video in the preview → tap the <strong>three dots (⋮)</strong> on the video → <strong>Share</strong> → then <strong>{t("common.save")}</strong> at the end — the video goes straight to your gallery, with no watermark.</p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">If a link doesn't work, the reason is usually that the video is still a draft/private, or the share link has expired — copy a fresh link from Jimeng and try again. Avatar (cast template) links also work, but they are usually only valid for 48 hours — copy one and paste it here right away.</p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">To fetch several videos at once, open <strong>{t("menu.bulk")}</strong> from the menu — paste one link per line and they will all be fetched one by one.</p>
      </SectionCard>
    </main>
  );
}

function FaqPage() {
  const t = useT();
  const [open, setOpen] = useState<number | null>(0);
  const faqs: { q: string; a: string }[] = [
    {
      q: "Is this downloader completely free?",
      a: "Downloading is free up to a daily limit (set by the site owner) — no login, no account and no fees. All you need is a public Jimeng share link. If you need more than the free daily limit, monthly plans are available on the Plans page.",
    },
    {
      q: "Why is my link not working?",
      a: "Common reasons: (1) the video is still a draft/private — Publish (Public) it on Jimeng first; (2) the share link is old/expired — copy a fresh link from the Jimeng app; (3) the link was copied incompletely — paste the full share text and the link will be extracted from it automatically. Avatar invite links are usually only valid for 48 hours.",
    },
    {
      q: "Why does the downloaded video have no watermark?",
      a: "Jimeng keeps two files for every published video: a display file (with the watermark) and an original master (origin) file that is completely clean. This tool always fetches the master file. If only the display file is available for a link, it is clearly labelled “File with watermark” in the quality list.",
    },
    {
      q: "Which links are supported?",
      a: "jimeng.jianying.com/s/xxxxx, public creations from jimeng.cn, and public links from dreamina.jianying.com and dreamina.capcut.com. Only public/published creations — private drafts, deleted or login-walled videos cannot be fetched.",
    },
    {
      q: "Do I need to add an API key?",
      a: "No. Jimeng has no official downloader API key and the downloader works without one. The key box is only for people who have their own key and endpoint from a third-party resolver service — if you add one, the video is fetched through it first, and if it fails the built-in method is used. A key makes no difference to the watermark.",
    },
    {
      q: "Why doesn't the file go straight to my gallery when I tap Download?",
      a: "Programmatic downloads often get stuck in a phone's in-app browser, so the file is first prepared on this site's server and then the Save buttons appear. “Share and Save” is the most reliable option — choose “Save to Files” or your Gallery app in the sheet. Or try the three dots (⋮) → Share → Save method on the preview video.",
    },
    {
      q: "Why do the videos in my old history have a watermark?",
      a: "The old history files were Jimeng's display files with the watermark burned in. The site now fetches the clean master file — to get a clean download, paste the same link again and fetch it fresh.",
    },
    {
      q: "Can I use these videos anywhere?",
      a: "Download videos for personal use only. All rights remain with their creators and ByteDance / Jimeng AI — do not repost someone else's video as your own or use it commercially.",
    },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="💬" title={t("page.faq_title")} subtitle={t("page.faq_sub")} />
      <SectionCard>
        <div className="flex flex-col">
          {faqs.map((f, i) => (
            <div key={f.q} className={i > 0 ? "border-t border-[var(--border)]" : ""}>
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="flex w-full items-center justify-between gap-3 py-4 text-left"
              >
                <span className="text-base font-extrabold">{f.q}</span>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center border text-lg font-bold ${open === i ? "rotate-45 border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`} style={{ borderRadius: 999 }}>+</span>
              </button>
              {open === i && (
                <p className="animate-fade-up pb-4 text-base leading-relaxed text-[var(--dim)]">{f.a}</p>
              )}
            </div>
          ))}
        </div>
      </SectionCard>
    </main>
  );
}

function SoraPage({ onGoHome }: { onGoHome: () => void }) {
  const t = useT();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🎬" title={t("menu.sora")} subtitle={t("page.sora_sub")} />
      <SectionCard className="py-10 text-center">
        <span className="mx-auto flex h-20 w-20 items-center justify-center border border-[rgba(251,191,36,0.45)] bg-[var(--warn-bg)] text-4xl" style={{ borderRadius: 999 }}>🎬</span>
        <p className="mt-5 inline-block border border-[rgba(251,191,36,0.45)] bg-[var(--warn-bg)] px-3 py-1 text-xs font-extrabold tracking-wide text-[var(--warn-text)] uppercase" style={{ borderRadius: 999 }}>
          Coming Soon
        </p>
        <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed">
          The Sora downloader is not available on this site yet. Sora is a separate platform and we don't currently have a verified, working downloader for it — so we won't add a fake or half-finished tool that takes your link and then fails.
        </p>
        <p className="mx-auto mt-2 max-w-lg text-base leading-relaxed">
          When a real, tested method becomes available, the Sora Downloader will appear right here in this menu. Until then, use the main downloader for Jimeng videos — it's completely free and works with no watermark.
        </p>
        <button
          type="button"
          onClick={onGoHome}
          className="cta-gradient mt-6 px-6 py-3 font-extrabold"
          style={{ borderRadius: "var(--radius)" }}
        >
          {t("page.sora_cta")}
        </button>
      </SectionCard>
    </main>
  );
}

function ClearHistoryButton() {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.clearHistory({}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["history"] }); setConfirming(false); },
  });
  if (!confirming)
    return <button type="button" onClick={() => setConfirming(true)} className="text-sm font-bold text-[var(--err-text)]">{t("history.clear_all")}</button>;
  return (
    <span className="flex items-center gap-2 text-sm">
      {t("history.confirm_clear")}
      <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="font-bold text-[var(--err-text)]">{t("history.confirm_yes")}</button>
      <button type="button" onClick={() => setConfirming(false)} className="font-bold text-[var(--dim)]">{t("history.confirm_no")}</button>
    </span>
  );
}

function DeleteHistoryButton({ id }: { id: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const mut = useMutation({
    mutationFn: () => api.deleteHistoryItem({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["history"] }),
  });
  return (
    <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)]" style={{ borderRadius: 8 }}>
      {t("history.delete")}
    </button>
  );
}

function ApiKeyBox({ settings }: { settings: ApiResponse<typeof api, "getSettings"> | undefined }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [base, setBase] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => await api.saveApiKey({ apiKey: key.trim(), apiBaseUrl: base.trim(), token: getToken() }),
    onSuccess: (r) => {
      setMsg(`Key saved (${r.hint}) — stored securely on the server.`);
      setKey("");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => setMsg(error.message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearApiKey({ token: getToken() }),
    onSuccess: () => { setMsg("Key removed."); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
  });

  function handleSaveKey() {
    if (key.trim().length < 4) {
      setKeyError("First paste an API key of at least 4 characters, then tap this button.");
      return;
    }
    setKeyError(null);
    save.mutate();
  }

  async function pasteInto(setter: (v: string) => void) {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setter(t.trim());
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="🔑"
        title="API Key Management"
        subtitle="Jimeng has no official downloader API key — the downloader works without one."
      />
      <SectionCard className="bg-[var(--admin-card)]">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center border border-[rgba(0,233,154,0.4)] bg-[rgba(0,233,154,0.10)] text-2xl shadow-[0_0_24px_rgba(0,233,154,0.15)]" style={{ borderRadius: 14 }} aria-hidden="true">
            🛡
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold">API Key <span className="text-sm font-semibold text-[var(--admin-dim)]">(optional)</span></h2>
            <p className="mt-1 text-sm text-[var(--admin-dim)]">
              If you have your own API key and endpoint from a third-party resolver service, add them here; the video will then be fetched through that service first, and if it fails the built-in method will be used.
            </p>
            {settings?.hasApiKey ? (
              <p className="mt-3 text-sm font-bold text-[var(--accent)]">✓ API key is set ({settings.apiKeyHint}) — saved on the server</p>
            ) : (
              <p className="mt-3 text-sm text-[var(--admin-dim)]">No key is set yet — the built-in downloader is running.</p>
            )}
            {settings?.apiBaseUrl && <p className="mt-1 break-all text-xs text-[var(--admin-dim)]">Endpoint: {settings.apiBaseUrl}</p>}
          </div>
        </div>
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <label htmlFor="api-base" className="text-sm font-bold">API endpoint (base URL)</label>
        <div className="mt-1 flex gap-2">
          <input {...FIELDS.saveApiKey.apiBaseUrl} id="api-base" aria-label="API endpoint base URL" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://example-api.com/resolve" className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm" style={{ borderRadius: "var(--radius)" }} />
          <button type="button" onClick={() => pasteInto(setBase)} className="border border-[var(--border)] px-3 text-sm font-bold" style={{ borderRadius: "var(--radius)" }}>Paste</button>
        </div>
        <label htmlFor="api-key" className="mt-3 block text-sm font-bold">API key</label>
        <div className="mt-1 flex gap-2">
          <input {...FIELDS.saveApiKey.apiKey} id="api-key" aria-label="API key" type="password" autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value); if (keyError) setKeyError(null); }} placeholder="Paste your API key" className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm" style={{ borderRadius: "var(--radius)" }} />
          <button type="button" onClick={() => pasteInto(setKey)} className="border border-[var(--border)] px-3 text-sm font-bold" style={{ borderRadius: "var(--radius)" }}>Paste</button>
        </div>
        {keyError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{keyError}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={save.isPending} onClick={handleSaveKey} className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
            {save.isPending ? "Saving…" : "Apply Key"}
          </button>
          {settings?.hasApiKey && (
            <button type="button" disabled={clear.isPending} onClick={() => clear.mutate()} className="border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }}>
              Remove key
            </button>
          )}
        </div>
        {msg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]">{msg}</p>}
        <p className="mt-3 text-xs text-[var(--admin-dim)]">The key is saved only on this site's server — never send it in chat. The full key is never shown again — only a hint with the last 4 characters is displayed.</p>
      </SectionCard>
    </div>
  );
}

function AdsSetup({ settings }: { settings: ApiResponse<typeof api, "getSettings"> | undefined }) {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="📢"
        title="Advertisement Settings"
        subtitle="Paste each slot's code here and save it — the code renders live in that slot on the site. Seven slots already have your Adsterra codes: Top Banner, Bottom Banner, Sidebar, Head Popunder, In-Content Native Banner, Social Bar, and Mobile Banner; change or remove any of them any time. No publisher ID is pre-filled — only add your own code."
      />
      <SmartLinkEditor settings={settings} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {AD_SLOTS.map((slot) => (
          <AdSlotEditor key={slot.key} slot={slot.key} label={slot.label} size={slot.size} saved={Boolean(settings?.adSlots[slot.key])} code={settings?.adCodes[slot.key] ?? null} />
        ))}
      </div>
      <p className="text-xs text-[var(--admin-dim)]">
        Saved code is injected into the slot on the site with real script elements, so ad scripts actually run — an empty slot keeps its dashed placeholder box.
      </p>
    </div>
  );
}

function AdSlotEditor({ slot, label, size, saved, code: savedCode }: { slot: AdSlotKey; label: string; size: string; saved: boolean; code: string | null }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const init = useRef(false);

  // Prefill from the saved value once it loads — the Top slot's Adsterra
  // banner is seeded server-side, so it shows here on first open. Only
  // mark initialised once a real value arrives; settings load async and
  // an empty slot legitimately stays empty.
  useEffect(() => {
    if (savedCode !== null && !init.current) {
      init.current = true;
      setCode(savedCode);
    }
  }, [savedCode]);

  const save = useMutation({
    mutationFn: async () => await api.saveAdCode({ slot, code, token: getToken() }),
    onSuccess: () => { setMsg("Code saved ✓"); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (error) => setMsg(error.message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAdCode({ slot, token: getToken() }),
    onSuccess: () => { setMsg("Code removed."); setCode(""); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
  });

  function handleSaveCode() {
    if (!code.trim()) {
      setCodeError("First paste this slot's AdSense code, then save.");
      return;
    }
    setCodeError(null);
    save.mutate();
  }

  return (
    <section className="glass border border-[var(--border)] bg-[var(--admin-card)] p-5" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-extrabold">📺 {label} <span className="text-sm font-semibold text-[var(--admin-dim)]">· {size}</span></p>
        {saved
          ? <StatusPill tone="green" label="✓ Code saved" />
          : <StatusPill tone="gray" label="No code added" />}
      </div>
      <label htmlFor={`ad-${slot}`} className="sr-only">{label} AdSense code</label>
      <textarea
        {...FIELDS.saveAdCode.code}
        id={`ad-${slot}`}
        value={code}
        onChange={(e) => { setCode(e.target.value); if (codeError) setCodeError(null); }}
        placeholder="Paste your AdSense code here…"
        rows={3}
        className="mt-3 w-full border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs"
        style={{ borderRadius: "var(--radius)" }}
      />
      {codeError && <p className="mt-1.5 text-sm font-semibold text-[var(--err-text)]" role="alert">{codeError}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={save.isPending} onClick={handleSaveCode} className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
          {save.isPending ? "Saving…" : "Save code"}
        </button>
        {saved && (
          <button type="button" disabled={clear.isPending} onClick={() => clear.mutate()} className="border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }}>
            Remove code
          </button>
        )}
      </div>
      {msg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]">{msg}</p>}
    </section>
  );
}

function SmartLinkEditor({ settings }: { settings: ApiResponse<typeof api, "getSettings"> | undefined }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const init = useRef(false);

  // Prefill from the saved value once it loads — the default link is
  // seeded server-side, so this shows the live link on first open.
  useEffect(() => {
    if (settings?.smartLink && !init.current) {
      init.current = true;
      setUrl(settings.smartLink.url ?? "");
      setEnabled(settings.smartLink.enabled);
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.saveSmartLink({ url, enabled, token: getToken() });
      if (!res.ok) throw new Error(res.error ?? "Could not save the smart link.");
      return res;
    },
    onSuccess: () => { setMsg("Smart link saved ✓"); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (error) => setMsg(error.message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearSmartLink({ token: getToken() }),
    onSuccess: () => { setMsg("Smart link removed."); setUrl(""); setEnabled(true); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
  });

  function handleSave() {
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError("First paste the smart link URL, then save.");
      return;
    }
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      setUrlError("That is not a valid link. Paste the full smart link URL starting with https://");
      return;
    }
    setUrlError(null);
    save.mutate();
  }

  const saved = Boolean(settings?.smartLink.url);
  return (
    <section className="glass border border-[var(--border)] bg-[var(--admin-card)] p-5" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-extrabold">🔗 Smart Link <span className="text-sm font-semibold text-[var(--admin-dim)]">· Adsterra</span></p>
        {saved && settings?.smartLink.enabled
          ? <StatusPill tone="green" label="✓ Showing on the downloader page" />
          : saved
            ? <StatusPill tone="gray" label="Saved but disabled" />
            : <StatusPill tone="gray" label="No smart link" />}
      </div>
      <p className="mt-2 text-sm text-[var(--admin-dim)]">
        One sponsored link, shown as a clearly labelled banner below the video result on the Jimeng downloader page. It opens in a new tab and never touches the download buttons.
      </p>
      <label htmlFor="smart-link-url" className="mt-3 block text-sm font-bold">Smart link URL</label>
      <input
        {...FIELDS.saveSmartLink.url}
        id="smart-link-url"
        value={url}
        onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(null); }}
        placeholder="https://…"
        className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-sm break-all"
        style={{ borderRadius: "var(--radius)" }}
      />
      {urlError && <p className="mt-1.5 text-sm font-semibold text-[var(--err-text)]" role="alert">{urlError}</p>}
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm font-bold">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Show the banner on the downloader page
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={save.isPending} onClick={handleSave} className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
          {save.isPending ? "Saving…" : "Save smart link"}
        </button>
        {saved && (
          <button type="button" disabled={clear.isPending} onClick={() => clear.mutate()} className="border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }}>
            Remove smart link
          </button>
        )}
      </div>
      {msg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]">{msg}</p>}
    </section>
  );
}

function AboutPage() {
  const t = useT();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="ℹ️" title={t("page.about_title")} subtitle={t("page.about_sub")} />
      <SectionCard>
        <h2 className="text-lg font-extrabold">What is this tool?</h2>
        <p className="mt-2 text-base leading-relaxed">
          This is a free online tool that fetches the original video file from Jimeng AI <strong>public share links</strong> — with no watermark overlay, in original MP4 quality. You create a video on Jimeng, publish it and copy the share link, paste it here, and download a clean MP4.
        </p>
        <p className="mt-2 text-base leading-relaxed">
          Jimeng AI is ByteDance's AI creative platform (jimeng.jianying.com), powered by the Seedance model family — text-to-video, image-to-video and AI images in one place. Its international version is Dreamina (CapCut), so public Dreamina links can also work here.
        </p>
      </SectionCard>
      <SectionCard>
        <h2 className="text-lg font-extrabold">How is it watermark-free?</h2>
        <p className="mt-2 text-base leading-relaxed">
          When a video is Published (Public) on Jimeng, Jimeng keeps its original file accessible on its CDN through the public share link. This tool fetches that original (origin) file — the file saved inside Jimeng has no watermark overlay on it. The original file of private or draft videos is not public, so those links don't work here.
        </p>
        <p className="mt-2 text-base leading-relaxed">
          One important difference: Jimeng keeps two files for every published video — a <strong>display file</strong>, with the AI badge (top) and Jimeng @user watermark (bottom) burned in and a Jimeng ending card appended at the end; and an <strong>original master (origin) file</strong> that is completely clean. This tool always fetches the master file — if only the display file is ever available, it is clearly labelled “File with watermark” in the quality list, never “No Watermark”.
        </p>
        <p className="mt-2 text-base leading-relaxed">
          No login, no account — all you need is a public link. Download videos for personal use only; all rights remain with the creator and ByteDance / Jimeng AI. This tool is not affiliated with Jimeng or ByteDance.
        </p>
      </SectionCard>
      <SectionCard>
        <h2 className="text-lg font-extrabold">Why use this downloader?</h2>
        <ul className="mt-3 space-y-2 text-base">
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> Free — up to the daily limit, no account needed</li>
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> No Watermark — the clean original master file</li>
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> Fast — files prepared server-side, then saved in one tap</li>
          <li className="flex items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.15)] text-sm font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }}>✓</span> Honest labels — a watermarked file is never called “No Watermark”</li>
        </ul>
      </SectionCard>
    </main>
  );
}

function PrivacyPage() {
  const t = useT();
  const topics: { icon: string; title: string; body: string }[] = [
    {
      icon: "🔗",
      title: "The link you paste",
      body: "When you paste a Jimeng share link, our server fetches that public link from Jimeng and extracts the video's original file address. A history of successful downloads only (link, title, video address, time) is saved on this site's server so you can download again — you can clear this history at any time with one click. At download time the video file is first brought to our server and served to you from there, and the file may remain cached on the server to make repeat downloads easier.",
    },
    {
      icon: "🔑",
      title: "API key",
      body: "If you add the optional API key, it is saved on this site's server and used only to fetch videos through the endpoint you provided. The full key is never shown on the page again — only a hint with the last 4 characters is displayed. You can delete the key at any time with “Remove key”.",
    },
    {
      icon: "✉️",
      title: "Contact form",
      body: "The name, email and message sent through the Contact page are saved on this site's server so we can reply to you. This information is never sold to any third party.",
    },
    {
      icon: "📢",
      title: "Advertising — Google AdSense",
      body: "Google AdSense ads may be shown on this site. Google and its partners use cookies to show ads based on your visits to this and other sites. You can turn off personalised advertising in Google Ads Settings (adssettings.google.com), or opt out of third-party cookies at aboutads.info. The “Ad Space” boxes on the page are exactly where ads are served.",
    },
    {
      icon: "©️",
      title: "Copyright",
      body: "All video rights belong to their creators and ByteDance / Jimeng AI. Only download your own or authorised public videos, and only for personal use.",
    },
    {
      icon: "📝",
      title: "Changes",
      body: "This policy may be updated over time; any new changes will be posted on this page.",
    },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🔒" title={t("menu.privacy")} subtitle={t("page.privacy_sub")} />
      {topics.map((t) => (
        <SectionCard key={t.title}>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span aria-hidden="true">{t.icon}</span> {t.title}
          </h2>
          <p className="mt-2 text-base leading-relaxed">{t.body}</p>
        </SectionCard>
      ))}
    </main>
  );
}

function ContactPage() {
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: async () => await api.submitContact({ name: name.trim(), email: email.trim(), message: message.trim() }),
    onSuccess: () => { setDone(true); setErr(null); setName(""); setEmail(""); setMessage(""); },
    onError: (error) => setErr(error.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) {
      setFormError("Please fill in your name, email and message, then send.");
      return;
    }
    setFormError(null);
    mut.mutate();
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="✉️" title={t("page.contact_title")} subtitle={t("page.contact_sub")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SectionCard className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.12)] text-xl" style={{ borderRadius: 12 }}>✉️</span>
          <div>
            <p className="text-base font-extrabold">{t("profile.email")}</p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">Send a message with the form below — we reply to the email address you enter.</p>
          </div>
        </SectionCard>
        <SectionCard className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.12)] text-xl" style={{ borderRadius: 12 }}>💬</span>
          <div>
            <p className="text-base font-extrabold">Live Chat</p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">Coming Soon — until then, the form below is the fastest way to reach us.</p>
          </div>
        </SectionCard>
      </div>
      <SectionCard>
        <p className="text-base text-[var(--dim)]">Have a problem, question or suggestion? Send a message using the form below — the message is saved on this site's server and we will try to reply.</p>
        {done && <p className="mt-3 bg-[var(--surface-alt)] p-3 text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>✓ Message received — thank you! We will reply soon.</p>}
        {err && <p className="mt-3 bg-[var(--err-bg)] p-3 text-sm font-semibold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }} role="alert">{err}</p>}
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="contact-name" className="text-sm font-bold">Your name</label>
            <input {...FIELDS.submitContact.name} id="contact-name" aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="contact-email" className="text-sm font-bold">{t("profile.email")}</label>
            <input {...FIELDS.submitContact.email} id="contact-email" aria-label={t("auth.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="contact-message" className="text-sm font-bold">{t("tickets.message")}</label>
            <textarea {...FIELDS.submitContact.message} id="contact-message" aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
          <button type="submit" disabled={mut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
            {mut.isPending ? t("plans.sending") : t("contact.send")}
          </button>
        </form>
      </SectionCard>
    </main>
  );
}

/* -------------------------------------------------------------------------
 * Help Center, Support Tickets, Report a Problem and the legal pages
 * (Phase 3, master spec).
 *
 * The Help Center shows only articles stored in the database (seeded
 * once with real articles; the admin manages them from Admin → Support)
 * and the search box genuinely filters them. Support tickets work for
 * logged-in customers (per account) and anonymous visitors (per
 * browser), like History and Favourites. There is no email service on
 * this site: ticket replies are delivered in-app, and the owner gets a
 * notification when the admin replies.
 * ------------------------------------------------------------------------- */

const TICKET_CATEGORIES: { value: string; label: string }[] = [
  { value: "billing", label: "Billing" },
  { value: "download", label: "Download problem" },
  { value: "account", label: "Account" },
  { value: "other", label: "Other" },
];

const REPORT_ISSUES: { value: string; label: string }[] = [
  { value: "Download failed", label: "Download failed" },
  { value: "Wrong video", label: "Wrong video" },
  { value: "Watermark in file", label: "Watermark in file" },
  { value: "Limit problem", label: "Limit problem" },
  { value: "Other", label: "Other" },
];

/** Ticket status pill. The user pages pass their translate function so
 *  the label follows the site language; the admin panel (English only)
 *  calls it without one and gets the English labels. */
function ticketStatusPill(status: string, t?: (key: string) => string) {
  if (status === "open") return <StatusPill tone="amber" label={t ? `● ${t("tickets.open")}` : "● Open"} pulse />;
  if (status === "answered") return <StatusPill tone="green" label={t ? `✓ ${t("tickets.answered")}` : "✓ Answered"} />;
  return <StatusPill tone="gray" label={t ? t("tickets.closed") : "Closed"} />;
}

function HelpCenterPage() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const articles = useQuery({ queryKey: ["help-articles"], queryFn: () => api.listHelpArticles({}) });
  const all = articles.data?.articles ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.body.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q),
      )
    : all;
  const categories = [...new Set(all.map((a) => a.category))];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🆘" title={t("menu.help")} subtitle={t("help.subtitle")} />
      <SectionCard>
        <label htmlFor="help-search" className="text-sm font-bold">{t("help.search_label")}</label>
        <input
          id="help-search"
          aria-label={t("help.search_aria")}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("help.search_example")}
          className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base"
          style={{ borderRadius: "var(--radius)" }}
        />
        {categories.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setQuery(c)}
                className="border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-1.5 text-xs font-extrabold"
                style={{ borderRadius: 999 }}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </SectionCard>
      {articles.isPending && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}
      {articles.data && filtered.length === 0 && (
        <SectionCard className="py-12 text-center">
          <p className="text-6xl" aria-hidden="true">🔍</p>
          <h2 className="mt-4 text-xl font-extrabold">{t("help.no_results_title")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
            {t("help.no_results_text", { q: query.trim() })}
          </p>
          {query.trim() && (
            <button type="button" onClick={() => setQuery("")} className="mt-4 text-sm font-bold text-[var(--accent)]">
              {t("help.show_all")}
            </button>
          )}
        </SectionCard>
      )}
      {filtered.length > 0 && (
        <SectionCard>
          <div className="flex flex-col">
            {filtered.map((a, i) => (
              <div key={a.id} className={i > 0 ? "border-t border-[var(--border)]" : ""}>
                <button
                  type="button"
                  onClick={() => setOpenId(openId === a.id ? null : a.id)}
                  aria-expanded={openId === a.id}
                  className="flex w-full items-center justify-between gap-3 py-4 text-left"
                >
                  <span>
                    <span className="block text-xs font-extrabold tracking-wide text-[var(--accent)] uppercase">{a.category}</span>
                    <span className="mt-0.5 block text-base font-extrabold">{a.title}</span>
                  </span>
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center border text-lg font-bold ${openId === a.id ? "rotate-45 border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"}`} style={{ borderRadius: 999 }}>+</span>
                </button>
                {openId === a.id && (
                  <p className="animate-fade-up pb-4 text-base leading-relaxed text-[var(--dim)] whitespace-pre-line">{a.body}</p>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </main>
  );
}

function SupportTicketsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("download");
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);

  const tickets = useQuery({
    queryKey: ["my-tickets"],
    queryFn: () => api.listMyTickets({ token: getUserToken(), anonId: getAnonId() }),
  });
  const detail = useQuery({
    queryKey: ["ticket", selectedId],
    queryFn: () => api.getTicket({ id: selectedId!, token: getUserToken(), anonId: getAnonId() }),
    enabled: selectedId !== null,
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.createTicket({ subject: subject.trim(), category: category as "billing" | "download" | "account" | "problem" | "other", message: message.trim(), token: getUserToken(), anonId: getAnonId() }),
    onSuccess: (data) => {
      if (data.ok && data.ticketId) {
        setSubject("");
        setMessage("");
        setFormError(null);
        queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
        setSelectedId(data.ticketId);
      } else {
        setFormError(data.error ?? t("tickets.create_failed"));
      }
    },
    onError: (error) => setFormError(error.message),
  });
  const replyMut = useMutation({
    mutationFn: () => api.replyTicket({ id: selectedId!, message: reply.trim(), token: getUserToken(), anonId: getAnonId() }),
    onSuccess: (data) => {
      if (data.ok) {
        setReply("");
        setReplyError(null);
        queryClient.invalidateQueries({ queryKey: ["ticket", selectedId] });
        queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
      } else {
        setReplyError(data.error ?? "Could not send the reply — please try again.");
      }
    },
    onError: (error) => setReplyError(error.message),
  });
  const closeMut = useMutation({
    mutationFn: () => api.closeTicket({ id: selectedId!, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: (data) => {
      if (data.ok) {
        setReplyError(null);
        queryClient.invalidateQueries({ queryKey: ["ticket", selectedId] });
        queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
      } else {
        setReplyError(data.error ?? "Could not close the ticket — please try again.");
      }
    },
    onError: (error) => setReplyError(error.message),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      setFormError("Please fill in a subject and a message, then send.");
      return;
    }
    setFormError(null);
    createMut.mutate();
  }

  const items = tickets.data?.tickets ?? [];
  const ticket = detail.data?.ticket ?? null;
  const messages = detail.data?.messages ?? [];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🎫" title={t("menu.tickets")} subtitle={t("tickets.subtitle")} />
      {selectedId === null ? (
        <>
          <SectionCard>
            <h2 className="text-lg font-extrabold">{t("tickets.new_title")}</h2>
            <form className="mt-4 flex flex-col gap-3" onSubmit={handleCreate}>
              <div>
                <label htmlFor="ticket-subject" className="text-sm font-bold">{t("tickets.subject")}</label>
                <input {...FIELDS.createTicket.subject} id="ticket-subject" aria-label={t("tickets.subject_aria")} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("tickets.subject_ph")} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
              </div>
              <div>
                <label htmlFor="ticket-category" className="text-sm font-bold">{t("tickets.category")}</label>
                <select id="ticket-category" aria-label={t("tickets.category_aria")} value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }}>
                  {TICKET_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ticket-message" className="text-sm font-bold">{t("tickets.message")}</label>
                <textarea {...FIELDS.createTicket.message} id="ticket-message" aria-label={t("tickets.message_aria")} value={message} onChange={(e) => setMessage(e.target.value)} rows={4} placeholder={t("tickets.message_ph")} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
              </div>
              {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
              <button type="submit" disabled={createMut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                {createMut.isPending ? t("tickets.opening") : t("tickets.open_btn")}
              </button>
            </form>
          </SectionCard>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-extrabold">{t("tickets.my_tickets")}</h2>
            <p className="text-sm font-bold text-[var(--dim)]">{tickets.data ? t("tickets.count", { n: String(items.length), s: items.length === 1 ? "" : "s" }) : t("common.loading")}</p>
          </div>
          {tickets.isPending && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          )}
          {tickets.data && items.length === 0 && (
            <SectionCard className="py-12 text-center">
              <p className="text-6xl" aria-hidden="true">🎫</p>
              <h2 className="mt-4 text-xl font-extrabold">{t("tickets.no_tickets_title")}</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
                {t("tickets.no_tickets_text")}
              </p>
            </SectionCard>
          )}
          <ul className="flex flex-col gap-3">
            {items.map((ticket) => (
              <li key={ticket.id} className="glass card-hover border border-[var(--border)] bg-[var(--surface)] p-4" style={{ borderRadius: "var(--radius)" }}>
                <button type="button" onClick={() => setSelectedId(ticket.id)} className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
                  <span className="min-w-0">
                    <span className="block truncate text-base font-extrabold">#{ticket.id} — {ticket.subject}</span>
                    <span className="mt-1 block text-xs text-[var(--dim)]">
                      {TICKET_CATEGORIES.find((c) => c.value === ticket.category)?.label ?? ticket.category} · {new Date(ticket.createdAt).toLocaleString()}
                    </span>
                  </span>
                  {ticketStatusPill(ticket.status, t)}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <button type="button" onClick={() => setSelectedId(null)} className="self-start text-sm font-bold text-[var(--accent)]">{t("tickets.back")}</button>
          {detail.isPending && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          )}
          {ticket && (
            <>
              <SectionCard>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-extrabold">#{ticket.id} — {ticket.subject}</h2>
                  {ticketStatusPill(ticket.status, t)}
                </div>
                <p className="mt-1 text-xs text-[var(--dim)]">
                  {TICKET_CATEGORIES.find((c) => c.value === ticket.category)?.label ?? ticket.category} · {t("tickets.opened", { date: new Date(ticket.createdAt).toLocaleString() })}
                </p>
              </SectionCard>
              <ul className="flex flex-col gap-3">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={`glass border bg-[var(--surface)] p-4 ${m.authorRole === "admin" ? "border-[rgba(0,233,154,0.45)]" : "border-[var(--border)]"}`}
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    <p className="text-xs font-extrabold tracking-wide text-[var(--accent)] uppercase">
                      {m.authorRole === "admin" ? t("tickets.admin_label") : t("tickets.you_label")}
                    </p>
                    <p className="mt-1 text-base leading-relaxed whitespace-pre-line">{m.message}</p>
                    <p className="mt-1 text-xs text-[var(--dim)]">{new Date(m.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
              {messages.length === 0 && (
                <SectionCard className="py-8 text-center">
                  <p className="text-sm text-[var(--dim)]">{t("tickets.no_messages")}</p>
                </SectionCard>
              )}
              <SectionCard>
                <h2 className="text-lg font-extrabold">{t("tickets.reply")}</h2>
                <form
                  className="mt-3 flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!reply.trim()) {
                      setReplyError(t("tickets.reply_empty"));
                      return;
                    }
                    setReplyError(null);
                    replyMut.mutate();
                  }}
                >
                  <textarea
                    {...FIELDS.replyTicket.message}
                    aria-label={t("tickets.reply_aria")}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={4}
                    placeholder={t("tickets.reply_ph")}
                    className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                  {replyError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{replyError}</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" disabled={replyMut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                      {replyMut.isPending ? t("common.sending") : t("tickets.send_reply")}
                    </button>
                    {ticket.status !== "closed" && (
                      <button type="button" disabled={closeMut.isPending} onClick={() => closeMut.mutate()} className="border border-[rgba(248,113,113,0.5)] px-5 py-2.5 font-extrabold text-[var(--err-text)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                        {t("tickets.close")}
                      </button>
                    )}
                  </div>
                  {ticket.status === "closed" && (
                    <p className="text-sm text-[var(--dim)]">{t("tickets.closed_note")}</p>
                  )}
                </form>
              </SectionCard>
            </>
          )}
          {!detail.isPending && !ticket && (
            <SectionCard className="py-12 text-center">
              <h2 className="text-xl font-extrabold">{t("tickets.not_found_title")}</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">{t("tickets.not_found_text")}</p>
              <button type="button" onClick={() => setSelectedId(null)} className="mt-4 text-sm font-bold text-[var(--accent)]">{t("tickets.back_plain")}</button>
            </SectionCard>
          )}
        </>
      )}
    </main>
  );
}

function ReportProblemPage({ onTicketCreated }: { onTicketCreated: () => void }) {
  const t = useT();
  const [issue, setIssue] = useState(REPORT_ISSUES[0]?.value ?? "Download failed");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const createMut = useMutation({
    mutationFn: () =>
      api.createTicket({ subject: issue, category: "problem", message: description.trim(), link: link.trim() || undefined, token: getUserToken(), anonId: getAnonId() }),
    onSuccess: (data) => {
      if (data.ok && data.ticketId) {
        setCreatedId(data.ticketId);
        setFormError(null);
        setDescription("");
        setLink("");
        queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
      } else {
        setFormError(data.error ?? t("report.send_failed"));
      }
    },
    onError: (error) => setFormError(error.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) {
      setFormError(t("report.describe_first"));
      return;
    }
    setFormError(null);
    createMut.mutate();
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="⚠️" title={t("menu.report")} subtitle={t("report.subtitle")} />
      {createdId !== null ? (
        <SectionCard className="py-10 text-center">
          <p className="text-6xl" aria-hidden="true">✓</p>
          <h2 className="mt-4 text-xl font-extrabold">{t("report.received_title", { id: String(createdId) })}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
            {t("report.received_text")}
          </p>
          <button type="button" onClick={onTicketCreated} className="cta-gradient mt-5 px-6 py-3 font-extrabold" style={{ borderRadius: "var(--radius)" }}>
            {t("report.view_tickets")}
          </button>
        </SectionCard>
      ) : (
        <SectionCard>
          <p className="text-base text-[var(--dim)]">{t("report.intro")}</p>
          <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="report-issue" className="text-sm font-bold">{t("report.issue")}</label>
              <select id="report-issue" aria-label={t("report.issue_aria")} value={issue} onChange={(e) => setIssue(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }}>
                {REPORT_ISSUES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="report-description" className="text-sm font-bold">{t("report.description_label")}</label>
              <textarea {...FIELDS.createTicket.message} id="report-description" aria-label={t("report.description_aria")} value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder={t("report.description_ph")} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
            </div>
            <div>
              <label htmlFor="report-link" className="text-sm font-bold">{t("report.link")}</label>
              <input id="report-link" aria-label={t("report.link_aria")} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://jimeng.jianying.com/s/xxxxx" className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
            </div>
            {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
            <button type="submit" disabled={createMut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
              {createMut.isPending ? t("common.sending") : t("report.send_btn")}
            </button>
          </form>
        </SectionCard>
      )}
    </main>
  );
}

function TermsPage() {
  const t = useT();
  const topics: { icon: string; title: string; body: string }[] = [
    {
      icon: "📜",
      title: "Acceptance of these terms",
      body: "By using Jimeng Video Downloader you agree to these Terms of Service. If you do not agree, please do not use the site. These terms may be updated over time; continued use after an update means you accept the new terms.",
    },
    {
      icon: "⬇",
      title: "What the service does",
      body: "This site fetches the original video file from a public Jimeng AI (or Dreamina) share link you paste, and serves it back to you as an MP4 download. Downloading is free up to a daily limit set by the site owner; monthly plans give you a larger download quota. There is no payment gateway on the site yet — plan purchases are arranged with the admin through a purchase request.",
    },
    {
      icon: "👤",
      title: "Personal use only",
      body: "Download videos for personal use only. You must only download your own videos, or public videos you are authorised to download. Do not repost someone else's video as your own, do not use downloaded videos commercially, and do not use this site to infringe anyone's rights.",
    },
    {
      icon: "🔑",
      title: "Accounts",
      body: "Downloads need no account. An account is only needed to buy a monthly plan. You are responsible for keeping your password safe and for everything done with your account. The site owner may suspend an account that abuses the service, for example by trying to bypass the download limits.",
    },
    {
      icon: "⚖️",
      title: "Availability and liability",
      body: "The service is provided “as is”, with no guarantee that it will always be available or that any particular link will work — Jimeng can change its site at any time, and some links (private drafts, deleted videos, expired share links) simply cannot be fetched. To the fullest extent allowed by law, the site owner is not liable for any loss or damage from using the service.",
    },
    {
      icon: "🛡",
      title: "Fair use",
      body: "Do not abuse the service: no automated scraping, no attempts to bypass limits or security, and no use of the service for anything unlawful. Abuse may lead to your account or browser being blocked from downloading.",
    },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="📜" title={t("menu.terms")} subtitle={t("page.terms_sub")} />
      {topics.map((t) => (
        <SectionCard key={t.title}>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span aria-hidden="true">{t.icon}</span> {t.title}
          </h2>
          <p className="mt-2 text-base leading-relaxed">{t.body}</p>
        </SectionCard>
      ))}
    </main>
  );
}

function CopyrightPage() {
  const t = useT();
  const topics: { icon: string; title: string; body: string }[] = [
    {
      icon: "©️",
      title: "Who owns the videos",
      body: "All video rights belong to their creators and to ByteDance / Jimeng AI. This site does not own any video it fetches, does not claim any rights over them, and is not affiliated with Jimeng or ByteDance.",
    },
    {
      icon: "👤",
      title: "Only download what you may use",
      body: "Only download your own videos, or public videos you are authorised to download, and only for personal use. Do not repost someone else's video as your own, do not sell it, and do not use it in commercial content without the creator's permission.",
    },
    {
      icon: "🚫",
      title: "No watermark removal as a service",
      body: "This tool fetches the original master file that Jimeng itself keeps for a published video. It does not strip, erase or alter any watermark from a video file — if a video's only available file carries a watermark, it is shown to you labelled “File with watermark”, never as a clean file.",
    },
    {
      icon: "📩",
      title: "Takedown requests",
      body: "If you are a rights holder and believe a video should not be downloadable here, send a message through the Contact page with the video link, a description of your work, and proof that you own the rights. We will review the request and remove access to the video where appropriate. Please note that the video file itself is hosted by Jimeng, not by this site — for a full removal from the internet, the video must also be removed or made private on Jimeng.",
    },
    {
      icon: "⚖️",
      title: "Repeat infringement",
      body: "Accounts or browsers that repeatedly download videos they have no right to use may be blocked from the service.",
    },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="©️" title={t("menu.copyright")} subtitle={t("page.copyright_sub")} />
      {topics.map((t) => (
        <SectionCard key={t.title}>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span aria-hidden="true">{t.icon}</span> {t.title}
          </h2>
          <p className="mt-2 text-base leading-relaxed">{t.body}</p>
        </SectionCard>
      ))}
    </main>
  );
}

function DisclaimerPage() {
  const t = useT();
  const topics: { icon: string; title: string; body: string }[] = [
    {
      icon: "ℹ️",
      title: "No affiliation",
      body: "Jimeng Video Downloader is an independent tool. It is not affiliated with, endorsed by, or connected to Jimeng AI, Dreamina, ByteDance, TikTok or CapCut in any way. “Jimeng”, “Dreamina” and “Seedance” are trademarks of their respective owners.",
    },
    {
      icon: "⚠️",
      title: "No guarantee",
      body: "The service is provided “as is” and “as available”. We do not guarantee that the site will always work, that any particular link will resolve, or that a downloaded file will match what you expect. Jimeng may change its website or links at any time, and private, deleted or expired links cannot be fetched.",
    },
    {
      icon: "📦",
      title: "Files come from Jimeng",
      body: "Downloaded files are the original files Jimeng keeps for a published video, fetched through its public share link. This site does not create, edit or re-encode the videos, and does not check whether a video is appropriate, lawful or correctly labelled — that is the responsibility of the person who created and published it.",
    },
    {
      icon: "👤",
      title: "Your responsibility",
      body: "You are responsible for how you use downloaded videos. Download only videos you are allowed to download, use them for personal use only, and follow the Terms of Service and the Copyright Policy.",
    },
    {
      icon: "🔗",
      title: "Third-party links",
      body: "This site links to Jimeng and may show third-party advertising. We are not responsible for the content, availability or privacy practices of third-party sites.",
    },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="⚖️" title={t("menu.disclaimer")} subtitle={t("page.disclaimer_sub")} />
      {topics.map((t) => (
        <SectionCard key={t.title}>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span aria-hidden="true">{t.icon}</span> {t.title}
          </h2>
          <p className="mt-2 text-base leading-relaxed">{t.body}</p>
        </SectionCard>
      ))}
    </main>
  );
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* -------------------------------------------------------------------------
 * Customer login / register, Plans and My Plan.
 *
 * Downloads are public and need no account. An account is only needed to
 * buy a monthly plan (more downloads than the free daily limit). There is
 * no payment gateway yet: the Buy button sends a purchase request to the
 * admin, who activates the plan after receiving the payment.
 * ------------------------------------------------------------------------- */

function AuthPage({ onLoggedIn, onAdminLoggedIn }: { onLoggedIn: (u: MeUser) => void; onAdminLoggedIn: (a: AdminUser) => void }) {
  const t = useT();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Admin 2FA: after the password checks out, the server asks for the
  // 6-digit authenticator code (totpRequired). The code step replaces
  // the password form; the email/password stay in state for the retry.
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "register" && !name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (mode === "register" && password.length < 8) {
      setError("The password must be at least 8 characters.");
      return;
    }
    if (totpRequired && !/^\d{6}$/.test(totpCode.trim())) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        const data = await api.register({ name: name.trim(), email: email.trim(), password });
        if (data.ok && data.token && data.user) {
          setUserToken(data.token);
          onLoggedIn(data.user);
        } else {
          setError(data.error ?? t("auth.create_failed"));
        }
      } else {
        // Unified login: admin credentials open the Admin Panel directly,
        // customer credentials open the User Panel.
        const data = await api.login({
          email: email.trim(),
          password,
          ...(totpRequired ? { totpCode: totpCode.trim() } : {}),
        });
        if (data.ok && data.token && data.role === "admin" && data.admin) {
          setToken(data.token);
          onAdminLoggedIn(data.admin);
        } else if (data.ok && data.token && data.role === "customer" && data.user) {
          setUserToken(data.token);
          onLoggedIn(data.user);
        } else if (data.totpRequired) {
          setTotpRequired(true);
          setTotpCode("");
          setError(null);
        } else {
          setError(data.error ?? t("auth.wrong"));
        }
      }
    } catch {
      setError(t("common.error_server"));
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5">
      <div className="animate-fade-up pt-4 text-center sm:pt-8">
        <span className="inline-block"><Logo /></span>
        <h1 className="text-gradient mt-4 text-3xl font-extrabold">{mode === "login" ? t("auth.login") : t("auth.create_title")}</h1>
        <p className="mx-auto mt-2 max-w-sm text-base text-[var(--dim)]">
          {t("auth.subtitle")}
        </p>
      </div>
      <SectionCard>
        <div className="flex gap-2" role="tablist" aria-label="Login or register">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => { setMode(m); setError(null); }}
              className={`flex-1 border px-4 py-2 text-sm font-extrabold ${mode === m ? "border-[var(--accent)] bg-[var(--surface-alt)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              {m === "login" ? t("auth.login") : t("auth.register")}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          {mode === "register" && (
            <div>
              <label htmlFor="auth-name" className="text-sm font-bold">{t("auth.name_label")}</label>
              <input
                {...FIELDS.register.name}
                id="auth-name"
                autoComplete="name"
                value={name}
                onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
                placeholder={t("auth.name_label")}
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
          )}
          <div>
            <label htmlFor="auth-email" className="text-sm font-bold">{t("profile.email")}</label>
            <input
              {...(mode === "register" ? FIELDS.register.email : FIELDS.login.email)}
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
              placeholder="you@example.com"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="auth-password" className="text-sm font-bold">{t("auth.password")}</label>
            <input
              {...(mode === "register" ? FIELDS.register.password : FIELDS.login.password)}
              id="auth-password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
              placeholder={mode === "register" ? t("auth.password_ph_register") : t("auth.password_ph_login")}
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {totpRequired && mode === "login" && (
            <div>
              <label htmlFor="auth-totp" className="text-sm font-bold">{t("auth.totp_label")}</label>
              <input
                id="auth-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={totpCode}
                onChange={(e) => { setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6)); if (error) setError(null); }}
                placeholder={t("auth.totp_ph")}
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center text-xl font-extrabold tracking-[0.4em]"
                style={{ borderRadius: "var(--radius)" }}
              />
              <p className="mt-1 text-xs text-[var(--dim)]">
                {t("auth.totp_hint")}
              </p>
              <button
                type="button"
                onClick={() => { setTotpRequired(false); setTotpCode(""); setError(null); }}
                className="mt-1 text-xs font-bold text-[var(--accent)]"
              >
                {t("auth.totp_back")}
              </button>
            </div>
          )}
          {error && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {busy ? t("auth.please_wait") : totpRequired ? t("auth.verify_code") : mode === "login" ? t("auth.login_btn") : t("auth.register_btn")}
          </button>
        </form>
      </SectionCard>
    </main>
  );
}

function PlansPage({ user, onNeedLogin }: { user: MeUser | null; onNeedLogin: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => api.listPlans({}) });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me({ token: getUserToken() }) });
  const requests = useQuery({
    queryKey: ["my-requests"],
    queryFn: () => api.myRequests({ token: getUserToken() }),
    enabled: !!user,
  });
  const [buyMsg, setBuyMsg] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [buyingId, setBuyingId] = useState<number | null>(null);

  async function handleBuy(planId: number) {
    if (!user) {
      onNeedLogin();
      return;
    }
    setBuyError(null);
    setBuyMsg(null);
    setBuyingId(planId);
    try {
      const data = await api.createPurchaseRequest({ planId, token: getUserToken() });
      if (data.ok && data.request) {
        setBuyMsg(
          data.duplicate
            ? t("plans.request_duplicate", { plan: data.request.planName })
            : t("plans.request_sent_new", { plan: data.request.planName, price: formatPrice(data.request.priceCents) }),
        );
        queryClient.invalidateQueries({ queryKey: ["my-requests"] });
      } else {
        setBuyError(data.error ?? t("plans.request_failed"));
      }
    } catch {
      setBuyError(t("common.error_server"));
    }
    setBuyingId(null);
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="💎" title={t("plans.title")} subtitle={t("plans.subtitle")} />
      <p className="text-center text-base text-[var(--dim)]">
        {t("plans.intro")}
      </p>
      <div>
        {!user && (
          <p className="mt-3 border border-[var(--accent)] bg-[var(--surface-alt)] p-3 text-sm font-semibold" style={{ borderRadius: "var(--radius)" }}>
            {t("plans.need_account_a")}{" "}
            <button type="button" onClick={onNeedLogin} className="font-extrabold text-[var(--accent)]">
              {t("plans.need_account_b")}
            </button>{" "}
            {t("plans.need_account_c")}
          </p>
        )}
        {me.data?.ok && me.data.plan && (
          <p className="mt-3 border border-[var(--accent)] bg-[var(--surface-alt)] p-3 text-sm font-semibold" style={{ borderRadius: "var(--radius)" }}>
            {t("plans.current_line", { plan: me.data.plan.planName, remaining: String(me.data.plan.remaining), total: String(me.data.plan.limitTotal), date: new Date(me.data.plan.expiresAt).toLocaleDateString() })}
          </p>
        )}
      </div>

      {buyMsg && <p className="bg-[var(--surface-alt)] p-3 text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }} role="status">{buyMsg}</p>}
      {buyError && <p className="bg-[var(--err-bg)] p-3 text-sm font-semibold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }} role="alert">{buyError}</p>}

      {plans.isPending && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      {plans.isError && <p className="text-sm font-semibold text-[var(--err-text)]">{t("plans.load_error")}</p>}
      {plans.data && plans.data.plans.length === 0 && (
        <p className="text-sm text-[var(--dim)]">{t("plans.none")}</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Free plan — always available; downloads need no account. */}
        <div className="glass card-hover relative flex flex-col border border-[var(--border)] bg-[var(--surface)] p-5" style={{ borderRadius: "var(--radius)" }}>
          <h2 className="text-xl font-extrabold">{t("plans.free_title")}</h2>
          <p className="mt-1 text-3xl font-extrabold">$0.00</p>
          <p className="text-sm text-[var(--dim)]">{t("plans.forever")}</p>
          <p className="mt-3 text-base font-bold">
            {me.data?.ok ? (me.data.freeDailyLimit === 0 ? t("plans.free_unlimited") : t("plans.per_day", { n: String(me.data.freeDailyLimit) })) : t("plans.per_day", { n: "10" })}
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("plans.no_watermark")}</li>
            <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("dl.original_mp4")}</li>
            <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("dl.no_login")}</li>
          </ul>
          <button type="button" disabled className="mt-4 w-full border border-[var(--accent)] bg-[rgba(0,233,154,0.10)] px-5 py-2.5 font-extrabold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>
            {me.data?.plan ? t("plans.free_title") : t("plans.current_plan")}
          </button>
        </div>
        {plans.data?.plans.map((plan) => {
          const isPopular = plan.name.toLowerCase() === "pro";
          const isCurrent = me.data?.plan?.planName === plan.name;
          return (
            <div key={plan.id} className={`glass card-hover relative flex flex-col border bg-[var(--surface)] p-5 ${isPopular ? "border-[var(--accent)] shadow-[0_0_35px_rgba(0,233,154,0.18)]" : "border-[var(--border)]"}`} style={{ borderRadius: "var(--radius)" }}>
              {isPopular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[var(--accent)] px-3 py-1 text-xs font-extrabold whitespace-nowrap text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>{t("plans.most_popular")}</span>
              )}
              <h2 className="text-xl font-extrabold">{plan.name}</h2>
              <p className="mt-1 text-3xl font-extrabold">{formatPrice(plan.priceCents)}</p>
              <p className="text-sm text-[var(--dim)]">{t("plans.for_days", { n: String(plan.durationDays) })}</p>
              <p className="mt-3 text-base font-bold">{t("plans.videos", { n: plan.downloadLimit.toLocaleString() })}</p>
              {plan.description && <p className="mt-1 text-sm text-[var(--dim)]">{plan.description}</p>}
              <ul className="mt-3 space-y-1.5 text-sm">
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("plans.no_watermark")}</li>
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("plans.original_quality")}</li>
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("plans.fast_download")}</li>
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> {t("plans.fallback")}</li>
              </ul>
              <button
                type="button"
                disabled={buyingId === plan.id || isCurrent}
                onClick={() => handleBuy(plan.id)}
                className="cta-gradient mt-4 w-full px-5 py-2.5 font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {isCurrent ? t("plans.current_plan") : buyingId === plan.id ? t("plans.sending") : t("plans.buy")}
              </button>
            </div>
          );
        })}
      </div>

      {user && requests.data && requests.data.requests.length > 0 && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">{t("plans.requests_title")}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {requests.data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="font-bold">{r.planName} — {formatPrice(r.priceCents)}</span>
                {r.status === "pending" && <StatusPill tone="amber" label={t("plans.status_pending")} />}
                {r.status === "paid" && <StatusPill tone="green" label={t("plans.status_paid")} />}
                {r.status === "activated" && <StatusPill tone="green" label={t("plans.status_active")} />}
                {r.status === "rejected" && <StatusPill tone="red" label={t("plans.status_rejected")} />}
                <span className="text-xs text-[var(--dim)]">{new Date(r.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </main>
  );
}

function MyPlanPage({ user, onGoPlans }: { user: MeUser; onGoPlans: () => void }) {
  const t = useT();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me({ token: getUserToken() }) });
  const requests = useQuery({ queryKey: ["my-requests"], queryFn: () => api.myRequests({ token: getUserToken() }) });
  const data = me.data;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="💎" title={t("menu.myplan")} subtitle={t("myplan.subtitle")} />
      <SectionCard className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center bg-[var(--accent)] text-2xl font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
          {user.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold">{user.name}</p>
          <p className="truncate text-sm text-[var(--dim)]">{user.email}</p>
        </div>
        <span className="ml-auto shrink-0">
          <StatusPill tone={data?.plan ? "green" : "gray"} label={data?.plan ? data.plan.planName : t("plans.free_plan")} />
        </span>
      </SectionCard>

      {data?.ok && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard value={String(data.downloadsToday)} label={t("myplan.downloads_today")} />
          <StatCard value={String(data.downloadsTotal)} label={t("myplan.downloads_total")} />
          <StatCard value={data.plan ? String(data.plan.remaining) : data.freeDailyLimit === 0 ? "∞" : String(data.freeRemaining)} label={t("myplan.downloads_left")} />
          <StatCard value={data.plan ? new Date(data.plan.expiresAt).toLocaleDateString() : data.freeDailyLimit === 0 ? "—" : `${data.freeDailyLimit}/day`} label={data.plan ? "Plan expires" : "Free daily limit"} />
        </div>
      )}

      {me.isPending && <p className="text-sm text-[var(--dim)]">{t("common.loading")}</p>}
      {data?.ok && data.plan && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">{t("myplan.plan_title", { plan: data.plan.planName })}</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            {t("myplan.plan_meta", { price: formatPrice(data.plan.priceCents), days: String(data.plan.durationDays), date: new Date(data.plan.startsAt).toLocaleDateString() })}
          </p>
          <div className="mt-4">
            <div className="flex justify-between text-sm font-bold">
              <span>{t("myplan.used", { used: data.plan.limitUsed.toLocaleString(), total: data.plan.limitTotal.toLocaleString() })}</span>
              <span>{t("myplan.left", { remaining: data.plan.remaining.toLocaleString() })}</span>
            </div>
            <div className="mt-1 h-3 w-full overflow-hidden bg-[var(--surface-alt)]" style={{ borderRadius: 999 }}>
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: `${Math.min(100, Math.round((data.plan.limitUsed / Math.max(1, data.plan.limitTotal)) * 100))}%` }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm">
            {t("myplan.expires_text", { date: new Date(data.plan.expiresAt).toLocaleDateString(), total: data.plan.limitTotal.toLocaleString() })}
          </p>
          <button
            type="button"
            onClick={onGoPlans}
            className="mt-4 bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)]"
            style={{ borderRadius: "var(--radius)" }}
          >
            {t("myplan.view_plans")}
          </button>
        </SectionCard>
      )}
      {data?.ok && !data.plan && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">{t("myplan.free_title")}</h2>
          <p className="mt-2 text-base">
            {t("myplan.free_prefix")}{" "}
            {data.freeDailyLimit === 0
              ? t("myplan.free_unlimited_text")
              : t("myplan.free_left_text", { remaining: String(data.freeRemaining), limit: String(data.freeDailyLimit) })}
          </p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            {t("myplan.free_more", { today: String(data.downloadsToday), total: String(data.downloadsTotal) })}
          </p>
          <button
            type="button"
            onClick={onGoPlans}
            className="mt-4 bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)]"
            style={{ borderRadius: "var(--radius)" }}
          >
            {t("myplan.see_plans")}
          </button>
        </SectionCard>
      )}

      {requests.data && requests.data.requests.length > 0 && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">{t("plans.requests_title")}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {requests.data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="font-bold">{r.planName} — {formatPrice(r.priceCents)}</span>
                {r.status === "pending" && <StatusPill tone="amber" label={t("plans.status_pending")} />}
                {r.status === "paid" && <StatusPill tone="green" label={t("plans.status_paid")} />}
                {r.status === "activated" && <StatusPill tone="green" label={t("plans.status_active")} />}
                {r.status === "rejected" && <StatusPill tone="red" label={t("plans.status_rejected")} />}
                <span className="text-xs text-[var(--dim)]">{new Date(r.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </main>
  );
}

/** Shared admin page header: icon badge + title + subtitle, with optional
 *  right-side content (count badge or action). Same visual language as
 *  the Dashboard hero. */
function AdminPageHead({ icon, title, subtitle, right }: { icon: string; title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="animate-fade-up flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center border border-[rgba(0,233,154,0.4)] bg-[rgba(0,233,154,0.10)] text-2xl shadow-[0_0_24px_rgba(0,233,154,0.15)]"
          style={{ borderRadius: 14 }}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h1 className="text-gradient text-2xl font-extrabold sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-[var(--admin-dim)]">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

/** Shared client-side pagination for admin lists. Shows a window of up
 *  to 5 page numbers plus Prev/Next. */
function AdminPagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  const btn = "border border-[var(--border)] px-3 py-1.5 text-sm font-bold disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" role="navigation" aria-label="Pagination">
      <button type="button" disabled={page === 1} onClick={() => onPage(page - 1)} className={btn} style={{ borderRadius: 10 }}>
        ‹ Prev
      </button>
      {start > 1 && <span className="text-sm text-[var(--admin-dim)]">…</span>}
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPage(p)}
          aria-current={p === page ? "page" : undefined}
          className={p === page ? "cta-gradient px-3 py-1.5 text-sm font-extrabold" : btn}
          style={{ borderRadius: 10 }}
        >
          {p}
        </button>
      ))}
      {end < totalPages && <span className="text-sm text-[var(--admin-dim)]">…</span>}
      <button type="button" disabled={page === totalPages} onClick={() => onPage(page + 1)} className={btn} style={{ borderRadius: 10 }}>
        Next ›
      </button>
    </div>
  );
}

type AdminTab = "dashboard" | "customers" | "plans" | "payments" | "ads" | "apikey" | "settings" | "support" | "logs" | "reports";

/** The admin sidebar has exactly these items. The reference image shows
 *  extra routes (Video Analytics, Revenue Reports, Notifications,
 *  Backup & Restore, Premium upsell…); none of those exist in this
 *  system, so none are added here. "Support" is real: it holds support
 *  ticket management and Help Center article management (Phase 3) plus
 *  broadcast announcements (Phase 4). "Logs" holds the real system log
 *  and the manual backup/restore (Phase 4); "Reports" holds real
 *  date-range analytics (Phase 4). */
const ADMIN_NAV: { key: AdminTab; label: string; icon: string }[] = [
  { key: "dashboard", label: "Dashboard", icon: "📊" },
  { key: "customers", label: "Customers", icon: "👥" },
  { key: "plans", label: "Plans", icon: "💎" },
  { key: "payments", label: "Payments", icon: "💳" },
  { key: "ads", label: "Ads", icon: "📢" },
  { key: "apikey", label: "API Key", icon: "🔑" },
  { key: "support", label: "Support", icon: "🎫" },
  { key: "logs", label: "Logs", icon: "📋" },
  { key: "reports", label: "Reports", icon: "📈" },
  { key: "settings", label: "Settings", icon: "⚙️" },
];

type AdminStatsResult = ApiResponse<typeof api, "adminStats">;

/** Admin shell: fixed sidebar on desktop, slide-in drawer on mobile,
 *  top header with admin profile dropdown, content area below. All
 *  seven admin tabs share the same design system (dark navy #050B12,
 *  emerald accent #00E99A, glassmorphism cards). */
function AdminPanel({ admin, onLoggedOut }: { admin: AdminUser; onLoggedOut: () => void }) {
  const [tab, setTab] = useState<AdminTab>("dashboard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({ token: getToken() }) });
  const stats = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => api.adminStats({ token: getToken() }),
  });

  useEffect(() => {
    if (!drawerOpen && !profileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        setProfileOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, profileOpen]);

  function goTab(next: AdminTab) {
    setTab(next);
    setDrawerOpen(false);
    window.scrollTo({ top: 0 });
  }

  const activeLabel = ADMIN_NAV.find((t) => t.key === tab)?.label ?? "Dashboard";
  const initial = (admin.name?.trim()?.[0] ?? "A").toUpperCase();
  const dataAsOf = stats.dataUpdatedAt ? new Date(stats.dataUpdatedAt).toLocaleString() : null;

  const nav = (
    <>
      <div className="px-5 pt-6 pb-4">
        <Logo />
        <p className="mt-3 inline-block border border-[rgba(0,233,154,0.4)] bg-[rgba(0,233,154,0.10)] px-3 py-1 text-[11px] font-extrabold tracking-[0.22em] text-[var(--accent)] uppercase" style={{ borderRadius: 999 }}>
          Admin Panel
        </p>
      </div>
      <nav aria-label="Admin sections" className="flex flex-col gap-1 px-3 py-2">
        {ADMIN_NAV.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => goTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={`flex items-center gap-3 px-4 py-3 text-left text-base font-bold ${tab === t.key ? "cta-gradient text-[var(--accent-ink)] shadow-[0_8px_24px_rgba(0,233,154,0.30)]" : "text-[var(--admin-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]"}`}
            style={{ borderRadius: 12 }}
          >
            <span aria-hidden="true" className="text-lg">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="mt-auto px-3 pt-4 pb-5">
        <button
          type="button"
          onClick={onLoggedOut}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-base font-bold text-[var(--err-text)] hover:bg-[var(--hover-bg)]"
          style={{ borderRadius: 12 }}
        >
          <span aria-hidden="true" className="text-lg">🚪</span> Logout
        </button>
        <p className="mt-4 px-4 text-center text-xs text-[var(--admin-dim)]">
          © 2025 Jimeng Downloader<br />All rights reserved.
        </p>
      </div>
    </>
  );

  return (
    <div className="animate-fade-up flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-[rgba(0,233,154,0.14)] bg-[var(--admin-sidebar)] lg:flex">
        {nav}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Admin menu">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setDrawerOpen(false)} />
          <div className="animate-drawer-in absolute top-0 left-0 flex h-full w-[82%] max-w-[320px] flex-col overflow-y-auto bg-[var(--admin-sidebar)] shadow-2xl">
            <div className="flex items-center justify-end px-4 pt-4">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="flex h-10 w-10 items-center justify-center bg-[var(--hover-bg)] text-lg font-bold"
                style={{ borderRadius: 10 }}
              >
                ✕
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="glass sticky top-0 z-20 border-b border-[var(--border)] bg-[rgba(5,11,18,0.88)]">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open admin menu"
              className="flex h-10 w-10 shrink-0 items-center justify-center border border-[var(--border)] bg-[var(--surface)] text-lg font-bold lg:hidden"
              style={{ borderRadius: 10 }}
            >
              ☰
            </button>
            <p className="min-w-0 flex-1 truncate text-lg font-extrabold">{activeLabel}</p>
            {dataAsOf && (
              <p className="hidden shrink-0 text-xs text-[var(--admin-dim)] md:block">Data as of {dataAsOf}</p>
            )}
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setProfileOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                className="flex items-center gap-2.5 border border-[var(--border)] bg-[var(--surface)] py-1.5 pr-3 pl-1.5"
                style={{ borderRadius: 999 }}
              >
                <span className="flex h-8 w-8 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
                  {initial}
                </span>
                <span className="hidden text-left sm:block">
                  <span className="block text-sm leading-tight font-extrabold">{admin.name || "Admin"}</span>
                  <span className="block max-w-44 truncate text-xs leading-tight text-[var(--admin-dim)]">{admin.email}</span>
                </span>
                <span aria-hidden="true" className="text-xs text-[var(--admin-dim)]">▾</span>
              </button>
              {profileOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setProfileOpen(false)} />
                  <div role="menu" className="glass absolute right-0 z-20 mt-2 w-64 border border-[var(--border)] bg-[var(--surface)] p-2 shadow-2xl" style={{ borderRadius: "var(--radius)" }}>
                    <div className="border-b border-[var(--border)] px-3 py-2.5">
                      <p className="truncate text-sm font-extrabold">{admin.name || "Admin"}</p>
                      <p className="truncate text-xs text-[var(--admin-dim)]">{admin.email}</p>
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onLoggedOut}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-bold text-[var(--err-text)] hover:bg-[var(--hover-bg)]"
                      style={{ borderRadius: 10 }}
                    >
                      🚪 Logout
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">
          {tab === "dashboard" && <AdminDashboard stats={stats} onNavigate={goTab} />}
          {tab === "customers" && <CustomersAdmin />}
          {tab === "plans" && <PlansAdmin />}
          {tab === "payments" && <PaymentsAdmin />}
          {tab === "ads" && <AdsSetup settings={settings.data} />}
          {tab === "apikey" && <ApiKeyBox settings={settings.data} />}
          {tab === "support" && <SupportAdmin />}
          {tab === "logs" && <LogsAdmin />}
          {tab === "reports" && <ReportsAdmin />}
          {tab === "settings" && <AdminSettings admin={admin} />}
        </main>

        <footer className="border-t border-[var(--border)] px-4 py-4 text-center text-xs text-[var(--admin-dim)]">
          © 2025 Jimeng Downloader — All rights reserved.
        </footer>
      </div>
    </div>
  );
}

/** Short "Nov 13" label for a YYYY-MM-DD day. */
function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function AdminStatCard({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <div className="card-hover glass border border-[var(--border)] bg-[var(--admin-card)] p-4" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.10)] text-xl" style={{ borderRadius: 12 }} aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-2xl leading-tight font-extrabold">{value}</p>
          <p className="truncate text-xs font-bold text-[var(--admin-dim)]">{label}</p>
        </div>
      </div>
    </div>
  );
}

/** Admin Dashboard — the front page of the Admin Panel. Every number
 *  comes from the real backend (adminStats + listPayments + listCustomers).
 *  Nothing here is invented: no growth percentages (there is no
 *  previous-period data), no second chart series (there is no per-day
 *  signup series), no system-status/backup card (there is no backup
 *  system), no upsell. */
function AdminDashboard({ stats, onNavigate }: {
  stats: {
    data: AdminStatsResult | undefined;
    isPending: boolean;
    isError: boolean;
    dataUpdatedAt: number;
  };
  onNavigate: (tab: AdminTab) => void;
}) {
  const payments = useQuery({ queryKey: ["admin-payments"], queryFn: () => api.listPayments({ token: getToken() }) });
  const customers = useQuery({ queryKey: ["admin-customers"], queryFn: () => api.listCustomers({ token: getToken() }) });
  const d = stats.data;
  const maxDay = d ? Math.max(1, ...d.last7Days.map((x) => x.downloads)) : 1;
  const recentPayments = (payments.data?.payments ?? []).slice(0, 5);
  const recentSignups = [...(customers.data?.customers ?? [])].sort((a, b) => b.id - a.id).slice(0, 5);

  const quickActions: { icon: string; label: string; tab: AdminTab }[] = [
    { icon: "👥", label: "Manage Customers", tab: "customers" },
    { icon: "💎", label: "Manage Plans", tab: "plans" },
    { icon: "💳", label: "View Payments", tab: "payments" },
    { icon: "📢", label: "Ads Setup", tab: "ads" },
    { icon: "🔑", label: "API Key", tab: "apikey" },
    { icon: "⚙️", label: "Settings", tab: "settings" },
  ];

  return (
    <div className="animate-fade-up flex flex-col gap-5">
      {/* Hero banner */}
      <section className="relative overflow-hidden border border-[rgba(0,233,154,0.25)] bg-[var(--admin-card)] p-6 shadow-lg shadow-black/30 sm:p-8" style={{ borderRadius: "var(--radius)" }}>
        <div aria-hidden="true" className="admin-hero-glow pointer-events-none absolute -top-16 right-8 h-56 w-56 rounded-full bg-[rgba(0,233,154,0.28)] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 left-1/4 h-48 w-48 rounded-full bg-[rgba(0,180,216,0.16)] blur-3xl" />
        <div className="relative flex items-center gap-5">
          <span className="hidden shrink-0 sm:block" aria-hidden="true">
            <svg width="72" height="72" viewBox="0 0 40 40">
              <defs>
                <linearGradient id="admin-hero-play" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#2bffa0" />
                  <stop offset="55%" stopColor="#00e99a" />
                  <stop offset="100%" stopColor="#00b4d8" />
                </linearGradient>
              </defs>
              <path d="M20 2 36 11v18L20 38 4 29V11Z" fill="url(#admin-hero-play)" opacity="0.18" />
              <path d="M15 11.5v17l14-8.5Z" fill="url(#admin-hero-play)" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-extrabold sm:text-3xl">Jimeng Video Downloader</h1>
            <p className="text-gradient mt-1 text-lg font-extrabold sm:text-xl">Admin Dashboard</p>
            <p className="mt-2 text-sm text-[var(--admin-dim)] sm:text-base">Manage your platform efficiently.</p>
          </div>
          <span className="hidden shrink-0 md:block" aria-hidden="true">
            <svg width="120" height="98" viewBox="0 0 160 130" className="opacity-90">
              <g transform="rotate(-7 80 33)">
                <rect x="18" y="24" width="124" height="18" rx="5" fill="#1b2c42" stroke="rgba(148,163,184,0.4)" />
                <g fill="#e8f1f8">
                  <polygon points="28,24 44,24 34,42 18,42" />
                  <polygon points="58,24 74,24 64,42 48,42" />
                  <polygon points="88,24 104,24 94,42 78,42" />
                  <polygon points="118,24 134,24 124,42 108,42" />
                </g>
              </g>
              <rect x="18" y="44" width="124" height="72" rx="10" fill="#0d1826" stroke="rgba(148,163,184,0.4)" />
              <path d="M66 62v36l32-18Z" fill="#e8f1f8" />
              <circle cx="128" cy="104" r="16" fill="#00e99a" />
              <path d="M128 96v13m-6-6 6 6 6-6" stroke="#03130a" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </section>

      {/* Statistics — all 11 real values from adminStats */}
      {stats.isPending && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-label="Loading dashboard">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="border border-[var(--border)] bg-[var(--admin-card)] p-4" style={{ borderRadius: "var(--radius)" }}>
              <Skeleton className="h-7 w-20" />
              <Skeleton className="mt-2 h-4 w-24" />
            </div>
          ))}
        </div>
      )}
      {stats.isError && (
        <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">
          Could not load the dashboard — your session may have expired. Log out and log in again.
        </p>
      )}
      {d && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <AdminStatCard icon="👥" value={String(d.totalCustomers)} label="Total Customers" />
          <AdminStatCard icon="🙂" value={String(d.freeUsers)} label="Free Users" />
          <AdminStatCard icon="💎" value={String(d.subscribedUsers)} label="Subscribed Users" />
          <AdminStatCard icon="🛒" value={String(d.plansSold)} label="Plans Sold" />
          <AdminStatCard icon="💰" value={formatPrice(d.totalRevenueCents)} label="Total Revenue" />
          <AdminStatCard icon="🧾" value={String(d.totalTransactions)} label="Transactions" />
          <AdminStatCard icon="⬇️" value={String(d.downloadsToday)} label="Downloads Today" />
          <AdminStatCard icon="📥" value={String(d.downloadsTotal)} label="Total Downloads" />
          <AdminStatCard icon="📊" value={`${d.mbToday} MB`} label="MB Used Today" />
          <AdminStatCard icon="💾" value={`${d.mbTotal} MB`} label="MB Used Total" />
          <AdminStatCard icon="🗄️" value={formatBytes(d.storageBytes) ?? "0 B"} label="Storage Used" />
        </div>
      )}

      {/* Downloads — last 7 days (downloads only, real data, zeros shown) */}
      {d && (
        <SectionCard className="bg-[var(--admin-card)]">
          <h2 className="text-lg font-extrabold">📊 Downloads — Last 7 Days</h2>
          {d.last7Days.every((x) => x.downloads === 0) ? (
            <p className="mt-3 text-sm text-[var(--admin-dim)]">No downloads in the last 7 days.</p>
          ) : (
            <div className="mt-4 flex items-end gap-2 sm:gap-3" role="img" aria-label={`Downloads per day for the last 7 days: ${d.last7Days.map((x) => `${shortDay(x.date)} ${x.downloads}`).join(", ")}`}>
              {d.last7Days.map((x) => (
                <div key={x.date} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <span className="text-xs font-extrabold sm:text-sm">{x.downloads}</span>
                  <div className="flex h-32 w-full items-end sm:h-40">
                    <div
                      className="bar-grow w-full rounded-t-md bg-gradient-to-t from-[#00b57e] to-[#00e99a]"
                      style={{ height: `${Math.max(x.downloads === 0 ? 1 : 4, (x.downloads / maxDay) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-bold whitespace-nowrap text-[var(--admin-dim)] sm:text-xs">{shortDay(x.date)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Quick Actions */}
      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">⚡ Quick Actions</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {quickActions.map((a) => (
            <button
              key={a.tab}
              type="button"
              onClick={() => onNavigate(a.tab)}
              className="card-hover flex flex-col items-center gap-2 border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-4 text-center"
              style={{ borderRadius: "var(--radius)" }}
            >
              <span className="text-2xl" aria-hidden="true">{a.icon}</span>
              <span className="text-sm font-extrabold">{a.label}</span>
            </button>
          ))}
        </div>
      </SectionCard>

      {/* Recent downloads */}
      {d && (
        <SectionCard className="bg-[var(--admin-card)]">
          <h2 className="text-lg font-extrabold">⬇️ Recent Downloads</h2>
          {d.recentDownloads.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--admin-dim)]">No downloads yet.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {d.recentDownloads.map((x) => (
                <li key={x.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-3" style={{ borderRadius: 12 }}>
                  <p className="truncate text-sm font-bold">{x.title || "Jimeng video"}</p>
                  <p className="truncate text-xs text-[var(--admin-dim)]">{x.sourceUrl}</p>
                  <p className="mt-0.5 text-xs text-[var(--admin-dim)]">{new Date(x.createdAt).toLocaleString()}</p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {/* Recent payments — from listPayments (newest first) */}
      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">💳 Recent Payments</h2>
        {payments.isPending && (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
        {payments.isError && (
          <p className="mt-3 text-sm font-semibold text-[var(--err-text)]">Could not load payments.</p>
        )}
        {payments.data && recentPayments.length === 0 && (
          <p className="mt-3 text-sm text-[var(--admin-dim)]">No payments recorded yet.</p>
        )}
        {payments.data && recentPayments.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {recentPayments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: 12 }}>
                <span className="min-w-0">
                  <span className="block truncate font-bold">{p.customerName} — {p.planName}</span>
                  <span className="block text-xs text-[var(--admin-dim)]">{new Date(p.createdAt).toLocaleString()}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusPill tone="green" label="Paid" />
                  <span className="font-extrabold text-[var(--accent)]">{formatPrice(p.amountCents)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {payments.data && recentPayments.length > 0 && (
          <button type="button" onClick={() => onNavigate("payments")} className="mt-3 text-sm font-extrabold text-[var(--accent)]">
            View all payments →
          </button>
        )}
      </SectionCard>

      {/* Recent signups — from listCustomers (newest first) */}
      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">🆕 Recent Signups</h2>
        {customers.isPending && (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
        {customers.isError && (
          <p className="mt-3 text-sm font-semibold text-[var(--err-text)]">Could not load customers.</p>
        )}
        {customers.data && recentSignups.length === 0 && (
          <p className="mt-3 text-sm text-[var(--admin-dim)]">No customers yet.</p>
        )}
        {customers.data && recentSignups.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {recentSignups.map((u) => (
              <li key={u.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: 12 }}>
                <p className="truncate font-bold">{u.name} <span className="font-normal text-[var(--admin-dim)]">({u.email})</span></p>
                <p className="mt-0.5 text-xs text-[var(--admin-dim)]">{new Date(u.joinedAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
        {customers.data && recentSignups.length > 0 && (
          <button type="button" onClick={() => onNavigate("customers")} className="mt-3 text-sm font-extrabold text-[var(--accent)]">
            View all customers →
          </button>
        )}
      </SectionCard>
    </div>
  );
}


/** Small stat tile used by the User Panel (My Plan page). Kept as-is. */
function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="border border-[var(--border)] bg-[var(--surface-alt)] p-3" style={{ borderRadius: "var(--radius)" }}>
      <p className="text-2xl font-extrabold break-words">{value}</p>
      <p className="text-xs font-bold text-[var(--dim)]">{label}</p>
    </div>
  );
}

type CustomerRow = ApiResponse<typeof api, "listCustomers">["customers"][number];

const CUSTOMERS_PAGE_SIZE = 10;

function CustomersAdmin() {
  const queryClient = useQueryClient();
  const customers = useQuery({ queryKey: ["admin-customers"], queryFn: () => api.listCustomers({ token: getToken() }) });
  const plans = useQuery({ queryKey: ["admin-plans"], queryFn: () => api.listAdminPlans({ token: getToken() }) });
  const adminSettings = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.getAdminSettings({ token: getToken() }) });
  const [openId, setOpenId] = useState<number | null>(null);
  const [assignPlanId, setAssignPlanId] = useState("");
  const [assignDays, setAssignDays] = useState("");
  const [assignLimit, setAssignLimit] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all");
  const [page, setPage] = useState(1);
  // Password reset (Phase 4): the admin sets a new password for a
  // customer — needed after a backup restore, when restored accounts
  // have no usable password. The new password is shown once, so the
  // admin can share it with the customer privately.
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
    queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
  }

  function pickPlan(planId: number) {
    setAssignPlanId(String(planId));
    const plan = plans.data?.plans.find((p) => p.id === planId);
    if (plan) {
      setAssignDays(String(plan.durationDays));
      setAssignLimit(String(plan.downloadLimit));
    }
  }

  async function handleAssign(customer: CustomerRow) {
    const planId = Number(assignPlanId);
    if (!planId) {
      setMsg("Choose a plan first.");
      return;
    }
    setBusyId(customer.id);
    setMsg(null);
    try {
      const data = await api.assignPlan({
        userId: customer.id,
        planId,
        durationDays: assignDays ? Number(assignDays) : undefined,
        downloadLimit: assignLimit ? Number(assignLimit) : undefined,
        token: getToken(),
      });
      if (data.ok) {
        const plan = plans.data?.plans.find((p) => p.id === planId);
        setMsg(`Plan ${plan?.name ?? ""} assigned to ${customer.name}.`);
        setAssignPlanId("");
        setAssignDays("");
        setAssignLimit("");
        invalidate();
      } else {
        setMsg(data.error ?? "Could not assign the plan.");
      }
    } catch {
      setMsg("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  async function handleStatus(customer: CustomerRow, status: "active" | "disabled") {
    setBusyId(customer.id);
    try {
      await api.setUserStatus({ userId: customer.id, status, token: getToken() });
      setMsg(status === "disabled" ? `${customer.name} is now suspended — their downloads are blocked.` : `${customer.name} is active again.`);
      invalidate();
    } catch {
      setMsg("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  async function handleDelete(customer: CustomerRow) {
    setBusyId(customer.id);
    try {
      const data = await api.deleteUser({ userId: customer.id, token: getToken() });
      if (data.ok) {
        setMsg(`${customer.name} deleted. Their recorded payments are kept for revenue history.`);
        setConfirmDeleteId(null);
        setOpenId(null);
        invalidate();
      } else {
        setMsg(data.error ?? "Could not delete the customer.");
      }
    } catch {
      setMsg("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  async function handleResetPassword(customer: CustomerRow) {
    if (resetPw.length < 8) {
      setResetMsg("The new password must be at least 8 characters.");
      return;
    }
    setBusyId(customer.id);
    setResetMsg(null);
    try {
      const data = await api.resetCustomerPassword({ userId: customer.id, newPassword: resetPw, token: getToken() });
      if (data.ok) {
        setMsg(`${customer.name}'s password was reset to “${resetPw}” — share it with them privately. Their sessions were signed out.`);
        setResetId(null);
        setResetPw("");
      } else {
        setResetMsg(data.error ?? "Could not reset the password.");
      }
    } catch {
      setResetMsg("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  const freeLimit = adminSettings.data?.freeDailyLimit ?? 10;
  const all = customers.data?.customers ?? [];
  const q = search.trim().toLowerCase();
  const filtered = all.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / CUSTOMERS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * CUSTOMERS_PAGE_SIZE, safePage * CUSTOMERS_PAGE_SIZE);

  function limitLabel(c: CustomerRow): string {
    if (c.plan) return c.plan.limitTotal.toLocaleString();
    return freeLimit === 0 ? "Unlimited" : `${freeLimit} / day`;
  }
  function remainingLabel(c: CustomerRow): string {
    if (c.plan) return `${c.plan.remaining.toLocaleString()} left`;
    if (freeLimit === 0) return "Unlimited";
    return `${Math.max(0, freeLimit - c.downloadsToday)} left today`;
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="👥"
        title="Customers Management"
        subtitle="Every registered customer, their plan and usage. Open a customer to assign or change their plan, suspend them, or delete the account."
        right={
          <span className="inline-flex items-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.10)] px-3 py-1.5 text-sm font-extrabold whitespace-nowrap text-[var(--accent)]" style={{ borderRadius: 999 }}>
            Total Customers: {customers.data ? customers.data.customers.length.toLocaleString() : "…"}
          </span>
        }
      />
      {msg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{msg}</p>}

      <SectionCard className="bg-[var(--admin-card)]">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--admin-dim)]">🔍</span>
            <input
              type="search"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search customers…"
              aria-label="Search customers"
              className="w-full border border-[var(--border)] bg-[var(--bg)] py-2.5 pr-3 pl-9 text-sm"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as "all" | "active" | "disabled"); setPage(1); }}
            aria-label="Filter by status"
            className="border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm font-bold"
            style={{ borderRadius: "var(--radius)" }}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Suspended</option>
          </select>
        </div>
      </SectionCard>

      {customers.isPending && (
        <div className="flex flex-col gap-3" aria-label="Loading customers">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border border-[var(--border)] bg-[var(--admin-card)] p-4" style={{ borderRadius: "var(--radius)" }}>
              <Skeleton className="h-6 w-48" />
              <Skeleton className="mt-3 h-4 w-full" />
            </div>
          ))}
        </div>
      )}
      {customers.isError && (
        <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">
          Could not load customers — your session may have expired. Log out and log in again.
        </p>
      )}
      {customers.data && filtered.length === 0 && (
        <SectionCard className="bg-[var(--admin-card)]">
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="text-4xl" aria-hidden="true">👥</span>
            <p className="text-base font-extrabold">No customers found</p>
            <p className="max-w-sm text-sm text-[var(--admin-dim)]">
              {all.length === 0
                ? "Accounts appear here once someone registers to buy a plan."
                : "Try a different search or status filter."}
            </p>
          </div>
        </SectionCard>
      )}

      <ul className="flex flex-col gap-3">
        {pageItems.map((c) => {
          const initial = (c.name.trim()[0] ?? "?").toUpperCase();
          return (
            <li key={c.id} className="card-hover glass border border-[var(--border)] bg-[var(--admin-card)] p-4" style={{ borderRadius: "var(--radius)" }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.10)] text-lg font-extrabold text-[var(--accent)]" style={{ borderRadius: 999 }} aria-hidden="true">
                    {initial}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-base font-extrabold">{c.name}</p>
                    <p className="truncate text-xs text-[var(--admin-dim)]">{c.email}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={c.status === "disabled" ? "red" : "green"} label={c.status === "disabled" ? "Suspended" : "Active"} />
                  {c.plan ? (
                    <StatusPill tone="green" label={`${c.plan.planName} · ${c.plan.remaining}/${c.plan.limitTotal} left`} />
                  ) : (
                    <StatusPill tone="gray" label="Free" />
                  )}
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-3 lg:grid-cols-6">
                <div>
                  <dt className="text-[11px] font-bold tracking-wide text-[var(--admin-dim)] uppercase">Remaining</dt>
                  <dd className="mt-0.5 text-sm font-extrabold">{remainingLabel(c)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold tracking-wide text-[var(--admin-dim)] uppercase">Download limit</dt>
                  <dd className="mt-0.5 text-sm font-extrabold">{limitLabel(c)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold tracking-wide text-[var(--admin-dim)] uppercase">Downloads today</dt>
                  <dd className="mt-0.5 text-sm font-extrabold">{c.downloadsToday}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold tracking-wide text-[var(--admin-dim)] uppercase">Total downloads</dt>
                  <dd className="mt-0.5 text-sm font-extrabold">{c.downloadsTotal}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold tracking-wide text-[var(--admin-dim)] uppercase">Joined</dt>
                  <dd className="mt-0.5 text-sm font-extrabold">{new Date(c.joinedAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-bold tracking-wide text-[var(--admin-dim)] uppercase">Plan expiry</dt>
                  <dd className="mt-0.5 text-sm font-extrabold">{c.plan ? new Date(c.plan.expiresAt).toLocaleDateString() : "—"}</dd>
                </div>
              </dl>

              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => { setOpenId(openId === c.id ? null : c.id); setConfirmDeleteId(null); }}
                  aria-expanded={openId === c.id}
                  className="border border-[var(--border)] px-4 py-2 text-sm font-bold hover:bg-[var(--hover-bg)]"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  {openId === c.id ? "Hide details ▲" : "View details ▼"}
                </button>
              </div>

              {openId === c.id && (
                <div className="mt-3 border-t border-[var(--border)] pt-3">
                  <p className="text-sm font-extrabold">Assign / change plan</p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <select
                      aria-label="Plan"
                      value={assignPlanId}
                      onChange={(e) => pickPlan(Number(e.target.value))}
                      className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      <option value="">Choose a plan…</option>
                      {plans.data?.plans.filter((p) => p.active).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {formatPrice(p.priceCents)} · {p.downloadLimit.toLocaleString()} videos / {p.durationDays} days
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <label className="flex-1 text-xs font-bold text-[var(--dim)]">
                      Duration (days)
                      <input
                        {...FIELDS.assignPlan.durationDays}
                        type="number"
                        min={1}
                        value={assignDays}
                        onChange={(e) => setAssignDays(e.target.value)}
                        placeholder="30"
                        className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                        style={{ borderRadius: "var(--radius)" }}
                      />
                    </label>
                    <label className="flex-1 text-xs font-bold text-[var(--dim)]">
                      Download limit (videos)
                      <input
                        {...FIELDS.assignPlan.downloadLimit}
                        type="number"
                        min={1}
                        value={assignLimit}
                        onChange={(e) => setAssignLimit(e.target.value)}
                        placeholder="1000"
                        className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                        style={{ borderRadius: "var(--radius)" }}
                      />
                    </label>
                  </div>
                  <p className="mt-1 text-xs text-[var(--dim)]">Duration and limit default to the plan's values — change them here to give this customer a custom deal. Assigning a new plan replaces the running subscription.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === c.id}
                      onClick={() => handleAssign(c)}
                      className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {busyId === c.id ? "Saving…" : "Assign plan"}
                    </button>
                    {c.status === "active" ? (
                      <button
                        type="button"
                        disabled={busyId === c.id}
                        onClick={() => handleStatus(c, "disabled")}
                        className="border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--err-text)] disabled:opacity-50"
                        style={{ borderRadius: "var(--radius)" }}
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === c.id}
                        onClick={() => handleStatus(c, "active")}
                        className="border border-[var(--border)] px-4 py-2 text-sm font-bold disabled:opacity-50"
                        style={{ borderRadius: "var(--radius)" }}
                      >
                        Unsuspend
                      </button>
                    )}
                    {confirmDeleteId === c.id ? (
                      <span className="flex items-center gap-2 text-sm">
                        Delete this customer?
                        <button type="button" disabled={busyId === c.id} onClick={() => handleDelete(c)} className="font-bold text-[var(--err-text)]">Yes, delete</button>
                        <button type="button" onClick={() => setConfirmDeleteId(null)} className="font-bold text-[var(--dim)]">No</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(c.id)}
                        className="border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--err-text)]"
                        style={{ borderRadius: "var(--radius)" }}
                      >
                        Delete
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setResetId(resetId === c.id ? null : c.id); setResetPw(""); setResetMsg(null); }}
                      className="border border-[var(--border)] px-4 py-2 text-sm font-bold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      Reset password
                    </button>
                  </div>
                  {resetId === c.id && (
                    <div className="mt-3 border border-[var(--border)] bg-[var(--surface-alt)] p-3" style={{ borderRadius: "var(--radius)" }}>
                      <p className="text-xs font-bold text-[var(--dim)]">
                        Set a new password for {c.name}. Their sessions are signed out immediately. The new password is shown once here — share it with the customer privately. Needed after a backup restore, when restored accounts have no usable password.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <input
                          type="text"
                          autoComplete="off"
                          value={resetPw}
                          onChange={(e) => setResetPw(e.target.value)}
                          placeholder="New password (min 8 characters)"
                          className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                          style={{ borderRadius: "var(--radius)" }}
                        />
                        <button
                          type="button"
                          disabled={busyId === c.id}
                          onClick={() => handleResetPassword(c)}
                          className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                          style={{ borderRadius: "var(--radius)" }}
                        >
                          {busyId === c.id ? "Saving…" : "Set password"}
                        </button>
                      </div>
                      {resetMsg && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{resetMsg}</p>}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {filtered.length > 0 && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-xs text-[var(--admin-dim)]">
            Showing {(safePage - 1) * CUSTOMERS_PAGE_SIZE + 1}–{Math.min(safePage * CUSTOMERS_PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()} customers
          </p>
          <AdminPagination page={safePage} totalPages={totalPages} onPage={setPage} />
        </div>
      )}
    </div>
  );
}

type AdminPlanRow = ApiResponse<typeof api, "listAdminPlans">["plans"][number];

function PlansAdmin() {
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ["admin-plans"], queryFn: () => api.listAdminPlans({ token: getToken() }) });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [days, setDays] = useState("30");
  const [limit, setLimit] = useState("1000");
  const [desc, setDesc] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["admin-plans"] });
    queryClient.invalidateQueries({ queryKey: ["plans"] });
    queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
  }

  function startEdit(plan: AdminPlanRow) {
    setEditingId(plan.id);
    setName(plan.name);
    setPrice((plan.priceCents / 100).toFixed(2));
    setDays(String(plan.durationDays));
    setLimit(String(plan.downloadLimit));
    setDesc(plan.description);
    setFormError(null);
    setMsg(null);
  }

  function resetForm() {
    setEditingId(null);
    setName("");
    setPrice("");
    setDays("30");
    setLimit("1000");
    setDesc("");
    setFormError(null);
  }

  function parsePriceDollars(v: string): number | null {
    const n = Math.round(Number(v) * 100);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function handleSave() {
    const priceCents = parsePriceDollars(price);
    const durationDays = Number(days);
    const downloadLimit = Number(limit);
    if (!name.trim()) {
      setFormError("Give the plan a name.");
      return;
    }
    if (priceCents === null) {
      setFormError("Enter a valid price in dollars (for example 4.99).");
      return;
    }
    if (!Number.isInteger(durationDays) || durationDays < 1) {
      setFormError("Duration must be at least 1 day.");
      return;
    }
    if (!Number.isInteger(downloadLimit) || downloadLimit < 1) {
      setFormError("Download limit must be at least 1 video.");
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      if (editingId === null) {
        const data = await api.createPlan({
          name: name.trim(),
          priceCents,
          durationDays,
          downloadLimit,
          description: desc.trim(),
          token: getToken(),
        });
        if (data.ok) {
          setMsg(`Plan “${name.trim()}” created.`);
          resetForm();
          invalidate();
        } else {
          setFormError(data.error ?? "Could not create the plan.");
        }
      } else {
        const data = await api.updatePlan({
          id: editingId,
          name: name.trim(),
          priceCents,
          durationDays,
          downloadLimit,
          description: desc.trim(),
          token: getToken(),
        });
        if (data.ok) {
          setMsg(`Plan “${name.trim()}” updated. Customers already on this plan keep their original terms.`);
          resetForm();
          invalidate();
        } else {
          setFormError(data.error ?? "Could not update the plan.");
        }
      }
    } catch {
      setFormError("No response from the server. Please try again in a moment.");
    }
    setBusy(false);
  }

  async function handleToggleActive(plan: AdminPlanRow) {
    try {
      await api.updatePlan({ id: plan.id, active: !plan.active, token: getToken() });
      setMsg(plan.active ? `Plan “${plan.name}” deactivated — it no longer shows on the Plans page.` : `Plan “${plan.name}” is active again.`);
      invalidate();
    } catch {
      setMsg("No response from the server. Please try again in a moment.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="💎"
        title="Subscription Plans"
        subtitle="Monthly plans customers can buy. Editing a plan never changes a customer's already-running subscription."
        right={
          <span className="inline-flex items-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.10)] px-3 py-1.5 text-sm font-extrabold whitespace-nowrap text-[var(--accent)]" style={{ borderRadius: 999 }}>
            {plans.data ? `${plans.data.plans.length} plans` : "…"}
          </span>
        }
      />
      {msg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{msg}</p>}

      {plans.isPending && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading plans">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border border-[var(--border)] bg-[var(--admin-card)] p-5" style={{ borderRadius: "var(--radius)" }}>
              <Skeleton className="h-7 w-28" />
              <Skeleton className="mt-3 h-9 w-24" />
              <Skeleton className="mt-3 h-4 w-full" />
            </div>
          ))}
        </div>
      )}
      {plans.isError && (
        <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">
          Could not load plans — your session may have expired. Log out and log in again.
        </p>
      )}
      {plans.data && plans.data.plans.length === 0 && (
        <SectionCard className="bg-[var(--admin-card)]">
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="text-4xl" aria-hidden="true">💎</span>
            <p className="text-base font-extrabold">No plans yet</p>
            <p className="max-w-sm text-sm text-[var(--admin-dim)]">Create your first plan below — it will appear on the public Plans page once active.</p>
          </div>
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {plans.data?.plans.map((p) => (
          <article key={p.id} className="card-hover glass relative border border-[var(--border)] bg-[var(--admin-card)] p-5" style={{ borderRadius: "var(--radius)" }}>
            {p.name === "Pro" && (
              <span className="cta-gradient absolute -top-3 left-5 px-3 py-1 text-xs font-extrabold whitespace-nowrap" style={{ borderRadius: 999 }}>
                ⭐ Most Popular
              </span>
            )}
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-lg font-extrabold">{p.name}</h3>
              <StatusPill tone={p.active ? "green" : "gray"} label={p.active ? "Active" : "Inactive"} />
            </div>
            <p className="mt-3 text-3xl font-extrabold">
              {formatPrice(p.priceCents)}
              <span className="text-sm font-bold text-[var(--admin-dim)]"> / month</span>
            </p>
            <p className="mt-1 text-sm font-bold text-[var(--accent)]">{p.downloadLimit.toLocaleString()} downloads · {p.durationDays} days</p>
            {p.description && <p className="mt-2 text-sm text-[var(--admin-dim)]">{p.description}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => startEdit(p)}
                className="border border-[var(--border)] px-4 py-2 text-sm font-bold hover:bg-[var(--hover-bg)]"
                style={{ borderRadius: "var(--radius)" }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => handleToggleActive(p)}
                className="border border-[var(--border)] px-4 py-2 text-sm font-bold hover:bg-[var(--hover-bg)]"
                style={{ borderRadius: "var(--radius)" }}
              >
                {p.active ? "Deactivate" : "Activate"}
              </button>
            </div>
          </article>
        ))}
      </div>

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">{editingId === null ? "Create a new plan" : "Edit plan"}</h2>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">
          {editingId === null
            ? "Active plans appear on the public Plans page. Inactive plans cannot be purchased."
            : "Saving changes only affects future purchases — customers already on this plan keep their original terms."}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label htmlFor="plan-name" className="text-sm font-bold">Plan name</label>
            <input
              {...FIELDS.createPlan.name}
              id="plan-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Starter"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="plan-price" className="text-sm font-bold">Price (USD)</label>
              <input
                id="plan-price"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="4.99"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
            <div>
              <label htmlFor="plan-days" className="text-sm font-bold">Duration (days)</label>
              <input
                {...FIELDS.createPlan.durationDays}
                id="plan-days"
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                placeholder="30"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
            <div>
              <label htmlFor="plan-limit" className="text-sm font-bold">Download limit (videos)</label>
              <input
                {...FIELDS.createPlan.downloadLimit}
                id="plan-limit"
                type="number"
                min={1}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="1000"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
          </div>
          <div>
            <label htmlFor="plan-desc" className="text-sm font-bold">Description</label>
            <input
              {...FIELDS.createPlan.description}
              id="plan-desc"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="1,000 video downloads for 30 days."
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleSave}
              className="bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
              style={{ borderRadius: "var(--radius)" }}
            >
              {busy ? "Saving…" : editingId === null ? "Create plan" : "Save changes"}
            </button>
            {editingId !== null && (
              <button
                type="button"
                onClick={resetForm}
                className="border border-[var(--border)] px-5 py-2.5 font-bold"
                style={{ borderRadius: "var(--radius)" }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

type PurchaseRequestRow = ApiResponse<typeof api, "listPurchaseRequests">["requests"][number];

const PAYMENTS_PAGE_SIZE = 10;

function PaymentsAdmin() {
  const queryClient = useQueryClient();
  const requests = useQuery({ queryKey: ["admin-requests"], queryFn: () => api.listPurchaseRequests({ token: getToken() }) });
  const payments = useQuery({ queryKey: ["admin-payments"], queryFn: () => api.listPayments({ token: getToken() }) });
  const customers = useQuery({ queryKey: ["admin-customers"], queryFn: () => api.listCustomers({ token: getToken() }) });
  const plans = useQuery({ queryKey: ["admin-plans"], queryFn: () => api.listAdminPlans({ token: getToken() }) });
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Per-request Mark-paid form values (amount defaults to the plan price).
  const [paidAmount, setPaidAmount] = useState<Record<number, string>>({});
  const [paidMethod, setPaidMethod] = useState<Record<number, string>>({});
  const [paidNote, setPaidNote] = useState<Record<number, string>>({});
  // Per-request Activate form values (duration/limit default to the plan).
  const [actDays, setActDays] = useState<Record<number, string>>({});
  const [actLimit, setActLimit] = useState<Record<number, string>>({});
  // Manual payment form.
  const [manCustomer, setManCustomer] = useState("");
  const [manPlan, setManPlan] = useState("");
  const [manAmount, setManAmount] = useState("");
  const [manMethod, setManMethod] = useState("Manual");
  const [manNote, setManNote] = useState("");
  const [manError, setManError] = useState<string | null>(null);
  // Recorded-payments search + pagination (client-side).
  const [paySearch, setPaySearch] = useState("");
  const [payPage, setPayPage] = useState(1);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["admin-requests"] });
    queryClient.invalidateQueries({ queryKey: ["admin-payments"] });
    queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
    queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
  }

  async function handleMarkPaid(req: PurchaseRequestRow) {
    const amountStr = paidAmount[req.id];
    const amountCents = amountStr ? Math.round(Number(amountStr) * 100) : undefined;
    if (amountStr && (!Number.isFinite(amountCents) || (amountCents ?? 0) <= 0)) {
      setMsg("Enter a valid amount in dollars.");
      return;
    }
    setBusyId(req.id);
    setMsg(null);
    try {
      const data = await api.markPaid({
        requestId: req.id,
        amountCents,
        method: paidMethod[req.id]?.trim() || "Manual",
        note: paidNote[req.id]?.trim() ?? "",
        token: getToken(),
      });
      if (data.ok) {
        setMsg(`Payment recorded for ${req.customerName} (${req.planName}). Now tap “Activate plan” to give them the plan.`);
        invalidate();
      } else {
        setMsg(data.error ?? "Could not mark as paid.");
      }
    } catch {
      setMsg("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  async function handleActivate(req: PurchaseRequestRow) {
    const days = actDays[req.id] ? Number(actDays[req.id]) : undefined;
    const limit = actLimit[req.id] ? Number(actLimit[req.id]) : undefined;
    if ((days !== undefined && (!Number.isInteger(days) || days < 1)) || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) {
      setMsg("Duration and limit must be positive numbers — leave them empty to use the plan's values.");
      return;
    }
    setBusyId(req.id);
    setMsg(null);
    try {
      const data = await api.activatePlan({
        requestId: req.id,
        durationDays: days,
        downloadLimit: limit,
        token: getToken(),
      });
      if (data.ok) {
        setMsg(`Plan ${req.planName} activated for ${req.customerName} — their download limit is raised now.`);
        invalidate();
      } else {
        setMsg(data.error ?? "Could not activate the plan.");
      }
    } catch {
      setMsg("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  async function handleManualPayment() {
    const userId = Number(manCustomer);
    const amountCents = Math.round(Number(manAmount) * 100);
    if (!userId) {
      setManError("Choose a customer first.");
      return;
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setManError("Enter a valid amount in dollars.");
      return;
    }
    if (!manMethod.trim()) {
      setManError("Enter how the customer paid (for example Cash, JazzCash, Bank transfer).");
      return;
    }
    setManError(null);
    setBusyId(-1);
    try {
      const data = await api.recordPayment({
        userId,
        planId: manPlan ? Number(manPlan) : undefined,
        amountCents,
        method: manMethod.trim(),
        note: manNote.trim(),
        token: getToken(),
      });
      if (data.ok) {
        setMsg("Payment recorded.");
        setManCustomer("");
        setManPlan("");
        setManAmount("");
        setManNote("");
        invalidate();
      } else {
        setManError(data.error ?? "Could not record the payment.");
      }
    } catch {
      setManError("No response from the server. Please try again in a moment.");
    }
    setBusyId(null);
  }

  const pending = requests.data?.requests.filter((r) => r.status === "pending") ?? [];
  // "Decided" here means activated or rejected — paid requests waiting to
  // activate already have their own section above, so they are not repeated.
  const decided = requests.data?.requests.filter((r) => r.status === "activated" || r.status === "rejected") ?? [];
  const pq = paySearch.trim().toLowerCase();
  const allPayments = payments.data?.payments ?? [];
  const filteredPayments = allPayments.filter((p) => {
    if (!pq) return true;
    return (
      p.customerName.toLowerCase().includes(pq) ||
      p.planName.toLowerCase().includes(pq) ||
      p.method.toLowerCase().includes(pq) ||
      p.note.toLowerCase().includes(pq)
    );
  });
  const payTotalPages = Math.max(1, Math.ceil(filteredPayments.length / PAYMENTS_PAGE_SIZE));
  const paySafePage = Math.min(payPage, payTotalPages);
  const payPageItems = filteredPayments.slice((paySafePage - 1) * PAYMENTS_PAGE_SIZE, paySafePage * PAYMENTS_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="💳"
        title="Payments"
        subtitle="Buy Request → Pending → Mark Paid → Activate Plan. There is no payment gateway yet — when a customer taps Buy, their request appears here as pending."
        right={
          <span className="inline-flex items-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.10)] px-3 py-1.5 text-sm font-extrabold whitespace-nowrap text-[var(--accent)]" style={{ borderRadius: 999 }}>
            {payments.data ? `${payments.data.totalTransactions} transactions` : "…"}
          </span>
        }
      />
      {msg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{msg}</p>}

      <div className="grid grid-cols-2 gap-3">
        <AdminStatCard icon="💰" value={payments.data ? formatPrice(payments.data.totalRevenueCents) : "…"} label="Total Revenue" />
        <AdminStatCard icon="🧾" value={payments.data ? String(payments.data.totalTransactions) : "…"} label="Transactions" />
      </div>

      <SectionCard className="bg-[var(--admin-card)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold">Pending purchase requests</h2>
          <StatusPill tone="amber" label={`${pending.length} pending`} pulse={pending.length > 0} />
        </div>
        {requests.isPending && (
          <div className="mt-3 flex flex-col gap-2" aria-label="Loading requests">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {pending.length === 0 && !requests.isPending && (
          <p className="mt-3 text-sm text-[var(--admin-dim)]">No pending requests — new Buy clicks from customers will appear here.</p>
        )}
        <ul className="mt-3 flex flex-col gap-3">
          {pending.map((req) => (
            <li key={req.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-4" style={{ borderRadius: "var(--radius)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold">
                  {req.customerName} <span className="font-normal break-all text-[var(--admin-dim)]">({req.customerEmail})</span> — {req.planName}
                </p>
                <p className="text-sm font-extrabold">{formatPrice(req.priceCents)}</p>
              </div>
              <p className="mt-1 text-xs text-[var(--admin-dim)]">Requested {new Date(req.createdAt).toLocaleString()}</p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="text-xs font-bold text-[var(--admin-dim)]">
                  Amount received (USD)
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={paidAmount[req.id] ?? (req.priceCents / 100).toFixed(2)}
                    onChange={(e) => setPaidAmount((p) => ({ ...p, [req.id]: e.target.value }))}
                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                </label>
                <label className="text-xs font-bold text-[var(--admin-dim)]">
                  Method
                  <input
                    type="text"
                    value={paidMethod[req.id] ?? "Manual"}
                    onChange={(e) => setPaidMethod((p) => ({ ...p, [req.id]: e.target.value }))}
                    placeholder="Manual"
                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                </label>
                <label className="text-xs font-bold text-[var(--admin-dim)]">
                  Note
                  <input
                    type="text"
                    value={paidNote[req.id] ?? ""}
                    onChange={(e) => setPaidNote((p) => ({ ...p, [req.id]: e.target.value }))}
                    placeholder="Optional note"
                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyId === req.id}
                  onClick={() => handleMarkPaid(req)}
                  className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  {busyId === req.id ? "Saving…" : "✓ Mark paid"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">Paid — waiting to activate</h2>
        {requests.data?.requests.filter((r) => r.status === "paid").length === 0 ? (
          <p className="mt-3 text-sm text-[var(--admin-dim)]">Nothing waiting — paid requests appear here until you activate their plan.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {requests.data?.requests.filter((r) => r.status === "paid").map((req) => (
              <li key={req.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-4" style={{ borderRadius: "var(--radius)" }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold">
                    {req.customerName} — {req.planName}
                  </p>
                  <p className="text-sm font-extrabold text-[var(--accent)]">{formatPrice(req.priceCents)} paid ✓</p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-xs font-bold text-[var(--admin-dim)]">
                    Duration (days) — empty = plan default
                    <input
                      type="number"
                      min={1}
                      value={actDays[req.id] ?? ""}
                      onChange={(e) => setActDays((p) => ({ ...p, [req.id]: e.target.value }))}
                      placeholder="Plan default"
                      className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                      style={{ borderRadius: "var(--radius)" }}
                    />
                  </label>
                  <label className="text-xs font-bold text-[var(--admin-dim)]">
                    Download limit — empty = plan default
                    <input
                      type="number"
                      min={1}
                      value={actLimit[req.id] ?? ""}
                      onChange={(e) => setActLimit((p) => ({ ...p, [req.id]: e.target.value }))}
                      placeholder="Plan default"
                      className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-normal text-[var(--text)]"
                      style={{ borderRadius: "var(--radius)" }}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={busyId === req.id}
                  onClick={() => handleActivate(req)}
                  className="mt-3 bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  {busyId === req.id ? "Activating…" : "🚀 Activate plan"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {decided.length > 0 && (
        <SectionCard className="bg-[var(--admin-card)]">
          <h2 className="text-lg font-extrabold">Decided requests</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {decided.map((req) => (
              <li key={req.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="font-bold">{req.customerName} — {req.planName} ({formatPrice(req.priceCents)})</span>
                {req.status === "activated" && <StatusPill tone="green" label="✓ Activated" />}
                {req.status === "rejected" && <StatusPill tone="red" label="✕ Rejected" />}
                <span className="text-xs text-[var(--admin-dim)]">{new Date(req.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">Record a manual payment</h2>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">For money you received directly (not through a Buy click) — it still counts towards revenue.</p>
        <div className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="man-customer" className="text-sm font-bold">Customer</label>
              <select
                id="man-customer"
                value={manCustomer}
                onChange={(e) => setManCustomer(e.target.value)}
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                style={{ borderRadius: "var(--radius)" }}
              >
                <option value="">Choose a customer…</option>
                {customers.data?.customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.email})</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="man-plan" className="text-sm font-bold">Plan (optional)</label>
              <select
                id="man-plan"
                value={manPlan}
                onChange={(e) => setManPlan(e.target.value)}
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                style={{ borderRadius: "var(--radius)" }}
              >
                <option value="">No plan / manual payment</option>
                {plans.data?.plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {formatPrice(p.priceCents)}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="man-amount" className="text-sm font-bold">Amount (USD)</label>
              <input
                {...FIELDS.recordPayment.amountCents}
                id="man-amount"
                type="number"
                min={0}
                step="0.01"
                value={manAmount}
                onChange={(e) => setManAmount(e.target.value)}
                placeholder="4.99"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
            <div>
              <label htmlFor="man-method" className="text-sm font-bold">Method</label>
              <input
                {...FIELDS.recordPayment.method}
                id="man-method"
                value={manMethod}
                onChange={(e) => setManMethod(e.target.value)}
                placeholder="Manual"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
          </div>
          <div>
            <label htmlFor="man-note" className="text-sm font-bold">Note</label>
            <input
              {...FIELDS.recordPayment.note}
              id="man-note"
              value={manNote}
              onChange={(e) => setManNote(e.target.value)}
              placeholder="Optional note"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {manError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{manError}</p>}
          <button
            type="button"
            disabled={busyId === -1}
            onClick={handleManualPayment}
            className="bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {busyId === -1 ? "Saving…" : "Record payment"}
          </button>
        </div>
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold">Recorded payments</h2>
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--admin-dim)]">🔍</span>
            <input
              type="search"
              value={paySearch}
              onChange={(e) => { setPaySearch(e.target.value); setPayPage(1); }}
              placeholder="Search payments…"
              aria-label="Search payments"
              className="w-full border border-[var(--border)] bg-[var(--bg)] py-2 pr-3 pl-9 text-sm"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
        </div>
        {payments.isPending && (
          <div className="mt-3 flex flex-col gap-2" aria-label="Loading payments">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}
        {payments.data && filteredPayments.length === 0 && (
          <p className="mt-3 text-sm text-[var(--admin-dim)]">
            {allPayments.length === 0 ? "No payments recorded yet." : "No payments match this search."}
          </p>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {payPageItems.map((p) => (
            <li key={p.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold">{p.customerName} — {p.planName}</span>
                <span className="font-extrabold text-[var(--accent)]">{formatPrice(p.amountCents)}</span>
              </div>
              <p className="mt-1 text-xs text-[var(--admin-dim)]">
                {p.method}{p.note ? ` · ${p.note}` : ""} · {new Date(p.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
        {filteredPayments.length > 0 && (
          <div className="mt-4 flex flex-col items-center gap-3">
            <p className="text-xs text-[var(--admin-dim)]">
              Showing {(paySafePage - 1) * PAYMENTS_PAGE_SIZE + 1}–{Math.min(paySafePage * PAYMENTS_PAGE_SIZE, filteredPayments.length)} of {filteredPayments.length.toLocaleString()} payments
            </p>
            <AdminPagination page={paySafePage} totalPages={payTotalPages} onPage={setPayPage} />
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function AdminSettings({ admin }: { admin: AdminUser }) {
  const queryClient = useQueryClient();
  const adminSettings = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.getAdminSettings({ token: getToken() }) });
  const [freeLimit, setFreeLimit] = useState("");
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [limitBusy, setLimitBusy] = useState(false);

  useEffect(() => {
    if (adminSettings.data && freeLimit === "") {
      setFreeLimit(String(adminSettings.data.freeDailyLimit));
    }
  }, [adminSettings.data, freeLimit]);

  async function handleSaveLimit() {
    const n = Number(freeLimit);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      setLimitError("Enter a whole number between 0 and 1000 (0 = unlimited).");
      return;
    }
    setLimitError(null);
    setLimitMsg(null);
    setLimitBusy(true);
    try {
      await api.saveAdminSettings({ freeDailyLimit: n, token: getToken() });
      setLimitMsg(n === 0 ? "Free daily limit removed — downloads are unlimited." : `Free daily limit set to ${n} downloads per day.`);
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch {
      setLimitError("No response from the server. Please try again in a moment.");
    }
    setLimitBusy(false);
  }

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 8) {
      setError("The new password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setError(null);
    setMsg(null);
    setBusy(true);
    try {
      const data = await api.adminChangePassword({ currentPassword: current, newPassword: next, token: getToken() });
      if (data.ok) {
        setMsg("Password changed. Your other sessions were signed out.");
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        setError(data.error ?? "Could not change the password.");
      }
    } catch {
      setError("No response from the server. Please try again in a moment.");
    }
    setBusy(false);
  }

  const initial = (admin.name?.trim()?.[0] ?? "A").toUpperCase();

  // Phase 5 — SEO: the title/description/keywords served in the HTML
  // meta tags and the sitemap. Stored in the settings table.
  const seoSettings = useQuery({ queryKey: ["seo-settings"], queryFn: () => api.getSeoSettings({ token: getToken() }) });
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [seoKeywords, setSeoKeywords] = useState("");
  const [seoMsg, setSeoMsg] = useState<string | null>(null);
  const [seoError, setSeoError] = useState<string | null>(null);
  const [seoBusy, setSeoBusy] = useState(false);
  const seoInit = useRef(false);

  useEffect(() => {
    if (seoSettings.data && !seoInit.current) {
      seoInit.current = true;
      setSeoTitle(seoSettings.data.title);
      setSeoDescription(seoSettings.data.description);
      setSeoKeywords(seoSettings.data.keywords);
    }
  }, [seoSettings.data]);

  async function handleSaveSeo() {
    if (!seoTitle.trim()) {
      setSeoError("Enter a site title.");
      return;
    }
    setSeoError(null);
    setSeoMsg(null);
    setSeoBusy(true);
    try {
      await api.saveSeoSettings({ title: seoTitle.trim(), description: seoDescription.trim(), keywords: seoKeywords.trim(), token: getToken() });
      setSeoMsg("SEO settings saved — the site title, meta description and sitemap now use the new text.");
      queryClient.invalidateQueries({ queryKey: ["seo-settings"] });
    } catch {
      setSeoError("No response from the server. Please try again in a moment.");
    }
    setSeoBusy(false);
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="⚙️"
        title="System Settings"
        subtitle="Free daily limit and your admin account."
      />

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">Free daily limit</h2>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">
          How many videos anyone can download for free each day — visitors without an account and logged-in users without a plan. When the limit is hit, the Plans page opens automatically. Set 0 for unlimited.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label htmlFor="free-limit" className="text-sm font-bold">
            Free downloads per day
            <input
              {...FIELDS.saveAdminSettings.freeDailyLimit}
              id="free-limit"
              type="number"
              min={0}
              max={1000}
              value={freeLimit}
              onChange={(e) => { setFreeLimit(e.target.value); if (limitError) setLimitError(null); }}
              placeholder="10"
              className="mt-1 w-32 border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </label>
          <button
            type="button"
            disabled={limitBusy || adminSettings.isPending}
            onClick={handleSaveLimit}
            className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {limitBusy ? "Saving…" : "Save limit"}
          </button>
        </div>
        {limitError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{limitError}</p>}
        {limitMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{limitMsg}</p>}
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">SEO — search title & description</h2>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">
          These words appear in Google search results and when the site is shared on social media. They are also used by the sitemap at /sitemap.xml. Keep the title under 60 characters and the description under 160.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label htmlFor="seo-title" className="text-sm font-bold">Site title</label>
            <input
              {...FIELDS.saveSeoSettings.title}
              id="seo-title"
              type="text"
              value={seoTitle}
              onChange={(e) => { setSeoTitle(e.target.value); if (seoError) setSeoError(null); }}
              placeholder="Jimeng Video Downloader — No Watermark"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="seo-description" className="text-sm font-bold">Meta description</label>
            <textarea
              {...FIELDS.saveSeoSettings.description}
              id="seo-description"
              rows={3}
              value={seoDescription}
              onChange={(e) => { setSeoDescription(e.target.value); if (seoError) setSeoError(null); }}
              placeholder="Download Jimeng AI videos without a watermark — free, no login required."
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="seo-keywords" className="text-sm font-bold">Keywords (comma-separated)</label>
            <input
              {...FIELDS.saveSeoSettings.keywords}
              id="seo-keywords"
              type="text"
              value={seoKeywords}
              onChange={(e) => { setSeoKeywords(e.target.value); if (seoError) setSeoError(null); }}
              placeholder="jimeng downloader, jimeng video download, no watermark"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {seoError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{seoError}</p>}
          {seoMsg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{seoMsg}</p>}
          <button
            type="button"
            disabled={seoBusy || seoSettings.isPending}
            onClick={handleSaveSeo}
            className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50 self-start"
            style={{ borderRadius: "var(--radius)" }}
          >
            {seoBusy ? "Saving…" : "Save SEO settings"}
          </button>
        </div>
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">Admin account</h2>
        <div className="mt-3 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center bg-[var(--accent)] text-lg font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }} aria-hidden="true">
            {initial}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-extrabold">{admin.name || "Admin"}</p>
            <p className="truncate text-sm text-[var(--admin-dim)]">{admin.email}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">Change admin password</h2>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">The new password must be at least 8 characters. Changing it signs out your other sessions.</p>
        <form onSubmit={handleChange} className="mt-4 flex flex-col gap-3">
          <div>
            <label htmlFor="pw-current" className="text-sm font-bold">Current password</label>
            <input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => { setCurrent(e.target.value); if (error) setError(null); }}
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="pw-new" className="text-sm font-bold">New password</label>
            <input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => { setNext(e.target.value); if (error) setError(null); }}
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="pw-confirm" className="text-sm font-bold">Confirm new password</label>
            <input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); if (error) setError(null); }}
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {error && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{error}</p>}
          {msg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{msg}</p>}
          <button
            type="submit"
            disabled={busy}
            className="bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      </SectionCard>

      <SecurityAdmin />
    </div>
  );
}

const SUPPORT_TICKETS_PAGE_SIZE = 10;

/** Admin → Support: support ticket management + Help Center article
 *  management. Tickets are real user-created rows; replies go to the
 *  owner in-app (a "support" notification) — there is no email service
 *  on this site, so nothing is emailed. */
function SupportAdmin() {
  const queryClient = useQueryClient();
  const [sub, setSub] = useState<"tickets" | "articles" | "broadcasts">("tickets");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "answered" | "closed">("open");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);

  const tickets = useQuery({
    queryKey: ["admin-tickets"],
    queryFn: () => api.listAllTickets({ token: getToken() }),
  });
  const detail = useQuery({
    queryKey: ["admin-ticket", selectedId],
    queryFn: () => api.getAdminTicket({ id: selectedId!, token: getToken() }),
    enabled: selectedId !== null,
  });
  const articles = useQuery({
    queryKey: ["help-articles"],
    queryFn: () => api.listHelpArticles({}),
  });

  const replyMut = useMutation({
    mutationFn: () => api.replyTicketAdmin({ id: selectedId!, message: reply.trim(), token: getToken() }),
    onSuccess: (data) => {
      if (data.ok) {
        setReply("");
        setReplyError(null);
        queryClient.invalidateQueries({ queryKey: ["admin-ticket", selectedId] });
        queryClient.invalidateQueries({ queryKey: ["admin-tickets"] });
      } else {
        setReplyError(data.error ?? "Could not send the reply — please try again.");
      }
    },
    onError: (error) => setReplyError(error.message),
  });
  const statusMut = useMutation({
    mutationFn: (status: "open" | "closed") => api.setTicketStatus({ id: selectedId!, status, token: getToken() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-ticket", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["admin-tickets"] });
    },
  });

  const all = tickets.data?.tickets ?? [];
  const q = search.trim().toLowerCase();
  const filtered = all.filter(
    (t) =>
      (statusFilter === "all" || t.status === statusFilter) &&
      (!q ||
        t.subject.toLowerCase().includes(q) ||
        t.customerName.toLowerCase().includes(q) ||
        t.customerEmail.toLowerCase().includes(q)),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / SUPPORT_TICKETS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * SUPPORT_TICKETS_PAGE_SIZE, safePage * SUPPORT_TICKETS_PAGE_SIZE);
  const openCount = all.filter((t) => t.status === "open").length;
  const ticket = detail.data?.ticket ?? null;
  const messages = detail.data?.messages ?? [];

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead icon="🎫" title="Support" subtitle="Answer support tickets and manage the Help Center articles." />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSub("tickets")}
          className={`px-4 py-2 text-sm font-extrabold ${sub === "tickets" ? "cta-gradient" : "border border-[var(--border)] bg-[var(--surface)]"}`}
          style={{ borderRadius: "var(--radius)" }}
        >
          Tickets{openCount > 0 ? ` (${openCount} open)` : ""}
        </button>
        <button
          type="button"
          onClick={() => setSub("articles")}
          className={`px-4 py-2 text-sm font-extrabold ${sub === "articles" ? "cta-gradient" : "border border-[var(--border)] bg-[var(--surface)]"}`}
          style={{ borderRadius: "var(--radius)" }}
        >
          Help articles
        </button>
        <button
          type="button"
          onClick={() => setSub("broadcasts")}
          className={`px-4 py-2 text-sm font-extrabold ${sub === "broadcasts" ? "cta-gradient" : "border border-[var(--border)] bg-[var(--surface)]"}`}
          style={{ borderRadius: "var(--radius)" }}
        >
          📢 Announcements
        </button>
      </div>

      {sub === "broadcasts" && <BroadcastAdmin />}

      {sub === "tickets" && selectedId === null && (
        <>
          <SectionCard>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label htmlFor="admin-ticket-search" className="text-sm font-bold">Search tickets</label>
                <input
                  id="admin-ticket-search"
                  aria-label="Search tickets"
                  type="search"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Subject, customer name or email…"
                  className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                  style={{ borderRadius: "var(--radius)" }}
                />
              </div>
              <div>
                <label htmlFor="admin-ticket-status" className="text-sm font-bold">Status</label>
                <select
                  id="admin-ticket-status"
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value as "all" | "open" | "answered" | "closed"); setPage(1); }}
                  className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 sm:w-40"
                  style={{ borderRadius: "var(--radius)" }}
                >
                  <option value="open">Open</option>
                  <option value="answered">Answered</option>
                  <option value="closed">Closed</option>
                  <option value="all">All</option>
                </select>
              </div>
            </div>
            <p className="mt-3 text-sm font-bold text-[var(--admin-dim)]">
              {tickets.data ? `${filtered.length} ticket${filtered.length === 1 ? "" : "s"} · ${openCount} open` : "Loading…"}
            </p>
          </SectionCard>
          {tickets.isPending && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          )}
          {tickets.data && filtered.length === 0 && (
            <SectionCard className="py-12 text-center">
              <p className="text-6xl" aria-hidden="true">🎫</p>
              <h2 className="mt-4 text-xl font-extrabold">No tickets here</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--admin-dim)]">
                {statusFilter === "open" ? "No open tickets — everything is answered or closed." : "No tickets match this filter."}
              </p>
            </SectionCard>
          )}
          <ul className="flex flex-col gap-3">
            {pageItems.map((t) => (
              <li key={t.id} className="glass card-hover border border-[var(--border)] bg-[var(--surface)] p-4" style={{ borderRadius: "var(--radius)" }}>
                <button type="button" onClick={() => setSelectedId(t.id)} className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
                  <span className="min-w-0">
                    <span className="block truncate text-base font-extrabold">#{t.id} — {t.subject}</span>
                    <span className="mt-1 block text-xs text-[var(--admin-dim)]">
                      {t.customerName}{t.customerEmail ? ` · ${t.customerEmail}` : ""} · {TICKET_CATEGORIES.find((c) => c.value === t.category)?.label ?? t.category} · {new Date(t.createdAt).toLocaleString()}
                    </span>
                  </span>
                  {ticketStatusPill(t.status)}
                </button>
              </li>
            ))}
          </ul>
          <AdminPagination page={safePage} totalPages={totalPages} onPage={setPage} />
        </>
      )}

      {sub === "tickets" && selectedId !== null && (
        <>
          <button type="button" onClick={() => setSelectedId(null)} className="self-start text-sm font-bold text-[var(--accent)]">← Back to tickets</button>
          {detail.isPending && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          )}
          {ticket && (
            <>
              <SectionCard>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-extrabold">#{ticket.id} — {ticket.subject}</h2>
                  {ticketStatusPill(ticket.status)}
                </div>
                <p className="mt-1 text-xs text-[var(--admin-dim)]">
                  {ticket.customerName}{ticket.customerEmail ? ` · ${ticket.customerEmail}` : ""} · {TICKET_CATEGORIES.find((c) => c.value === ticket.category)?.label ?? ticket.category} · Opened {new Date(ticket.createdAt).toLocaleString()}
                </p>
              </SectionCard>
              <ul className="flex flex-col gap-3">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className={`glass border bg-[var(--surface)] p-4 ${m.authorRole === "admin" ? "border-[rgba(0,233,154,0.45)]" : "border-[var(--border)]"}`}
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    <p className="text-xs font-extrabold tracking-wide text-[var(--accent)] uppercase">
                      {m.authorRole === "admin" ? "🛡 Admin" : "👤 Customer"}
                    </p>
                    <p className="mt-1 text-base leading-relaxed whitespace-pre-line">{m.message}</p>
                    <p className="mt-1 text-xs text-[var(--admin-dim)]">{new Date(m.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
              <SectionCard>
                <h2 className="text-lg font-extrabold">Reply as admin</h2>
                <p className="mt-1 text-sm text-[var(--admin-dim)]">The customer is notified in-app when you reply — no email is sent.</p>
                <form
                  className="mt-3 flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!reply.trim()) {
                      setReplyError("Write a reply first.");
                      return;
                    }
                    setReplyError(null);
                    replyMut.mutate();
                  }}
                >
                  <textarea
                    {...FIELDS.replyTicketAdmin.message}
                    aria-label="Admin reply"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={4}
                    placeholder="Write your reply…"
                    className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                  {replyError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{replyError}</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" disabled={replyMut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                      {replyMut.isPending ? "Sending…" : "Send reply"}
                    </button>
                    {ticket.status !== "closed" ? (
                      <button type="button" disabled={statusMut.isPending} onClick={() => statusMut.mutate("closed")} className="border border-[rgba(248,113,113,0.5)] px-5 py-2.5 font-extrabold text-[var(--err-text)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                        Close ticket
                      </button>
                    ) : (
                      <button type="button" disabled={statusMut.isPending} onClick={() => statusMut.mutate("open")} className="border border-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                        Reopen ticket
                      </button>
                    )}
                  </div>
                </form>
              </SectionCard>
            </>
          )}
          {!detail.isPending && !ticket && (
            <SectionCard className="py-12 text-center">
              <h2 className="text-xl font-extrabold">Ticket not found</h2>
              <button type="button" onClick={() => setSelectedId(null)} className="mt-4 text-sm font-bold text-[var(--accent)]">Back to tickets</button>
            </SectionCard>
          )}
        </>
      )}

      {sub === "articles" && <HelpArticlesAdmin articles={articles.data?.articles ?? []} loading={articles.isPending} />}
    </div>
  );
}

function HelpArticlesAdmin({ articles, loading }: { articles: { id: number; title: string; body: string; category: string }[]; loading: boolean }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("General");
  const [body, setBody] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const createMut = useMutation({
    mutationFn: () => api.createHelpArticle({ title: title.trim(), category: category.trim() || "General", body: body.trim(), token: getToken() }),
    onSuccess: (data) => {
      if (data.ok) {
        resetForm();
        queryClient.invalidateQueries({ queryKey: ["help-articles"] });
      } else {
        setFormError(data.error ?? "Could not save the article — please try again.");
      }
    },
    onError: (error) => setFormError(error.message),
  });
  const updateMut = useMutation({
    mutationFn: () => api.updateHelpArticle({ id: editingId!, title: title.trim(), category: category.trim() || "General", body: body.trim(), token: getToken() }),
    onSuccess: (data) => {
      if (data.ok) {
        resetForm();
        queryClient.invalidateQueries({ queryKey: ["help-articles"] });
      } else {
        setFormError(data.error ?? "Could not save the article — please try again.");
      }
    },
    onError: (error) => setFormError(error.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteHelpArticle({ id, token: getToken() }),
    onSuccess: () => {
      setDeletingId(null);
      queryClient.invalidateQueries({ queryKey: ["help-articles"] });
    },
  });

  function resetForm() {
    setEditingId(null);
    setTitle("");
    setCategory("General");
    setBody("");
    setFormError(null);
  }

  function startEdit(a: { id: number; title: string; body: string; category: string }) {
    setEditingId(a.id);
    setTitle(a.title);
    setCategory(a.category);
    setBody(a.body);
    setFormError(null);
  }

  return (
    <>
      <SectionCard>
        <h2 className="text-lg font-extrabold">{editingId === null ? "Add a Help Center article" : `Edit article #${editingId}`}</h2>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !body.trim()) {
              setFormError("Please fill in a title and a body, then save.");
              return;
            }
            setFormError(null);
            if (editingId === null) createMut.mutate();
            else updateMut.mutate();
          }}
        >
          <div>
            <label htmlFor="article-title" className="text-sm font-bold">Title</label>
            <input {...FIELDS.createHelpArticle.title} id="article-title" aria-label="Article title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. How do I download a video?" className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="article-category" className="text-sm font-bold">Category</label>
            <input {...FIELDS.createHelpArticle.category} id="article-category" aria-label="Article category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="General" className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="article-body" className="text-sm font-bold">Body</label>
            <textarea {...FIELDS.createHelpArticle.body} id="article-body" aria-label="Article body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Write the article…" className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={createMut.isPending || updateMut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
              {editingId === null ? (createMut.isPending ? "Adding…" : "Add article") : (updateMut.isPending ? "Saving…" : "Save changes")}
            </button>
            {editingId !== null && (
              <button type="button" onClick={resetForm} className="border border-[var(--border)] px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </SectionCard>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold">Articles</h2>
        <p className="text-sm font-bold text-[var(--admin-dim)]">{loading ? "Loading…" : `${articles.length} article${articles.length === 1 ? "" : "s"}`}</p>
      </div>
      {loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {!loading && articles.length === 0 && (
        <SectionCard className="py-12 text-center">
          <p className="text-6xl" aria-hidden="true">📖</p>
          <h2 className="mt-4 text-xl font-extrabold">No articles yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--admin-dim)]">Add the first article above — the Help Center shows only articles stored here.</p>
        </SectionCard>
      )}
      <ul className="flex flex-col gap-3">
        {articles.map((a) => (
          <li key={a.id} className="glass border border-[var(--border)] bg-[var(--surface)] p-4" style={{ borderRadius: "var(--radius)" }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-extrabold tracking-wide text-[var(--accent)] uppercase">{a.category}</p>
                <p className="mt-0.5 text-base font-extrabold">{a.title}</p>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--admin-dim)]">{a.body}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => startEdit(a)} className="border border-[var(--border)] px-3 py-1.5 text-xs font-extrabold" style={{ borderRadius: 8 }}>
                  Edit
                </button>
                {deletingId === a.id ? (
                  <>
                    <button type="button" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate(a.id)} className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)] disabled:opacity-50" style={{ borderRadius: 8 }}>
                      Confirm delete
                    </button>
                    <button type="button" onClick={() => setDeletingId(null)} className="border border-[var(--border)] px-3 py-1.5 text-xs font-extrabold" style={{ borderRadius: 8 }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setDeletingId(a.id)} className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)]" style={{ borderRadius: 8 }}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// PHASE 4 — Logs & Backup, Reports, Security, Broadcasts (master spec).
// All data is real and server-backed. Nothing here is seeded or faked:
// the log only ever shows events that actually happened after the
// system_logs table existed, and reports only aggregate real rows.
// ---------------------------------------------------------------------------

/** Downloads a text file (JSON backup, CSV report) through the browser. */
function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const lines = [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  downloadTextFile(filename, lines.join("\n"), "text/csv");
}

/** QR code drawn from the otpauth:// URL with the `qrcode` package —
 *  generated locally in the browser as SVG (no canvas needed, no
 *  external QR service — the secret must never be sent to a third
 *  party). */
function QrCode({ value }: { value: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: "svg", margin: 1, width: 220, color: { dark: "#050B12", light: "#FFFFFF" } })
      .then((s) => { if (!cancelled) setSvg(s); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [value]);
  if (failed) return <p className="text-sm text-[var(--err-text)]">Could not draw the QR code — use the secret text below instead.</p>;
  if (!svg) return <Skeleton className="h-56 w-56" />;
  // The SVG string is generated locally by the qrcode library from the
  // otpauth URL — it contains no user content, so inner HTML is safe.
  return <div className="h-56 w-56 [&>svg]:h-full [&>svg]:w-full" style={{ borderRadius: 12 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

type SystemLogRow = ApiResponse<typeof api, "listSystemLogs">["logs"][number];

const LOGS_PAGE_SIZE = 50;

/** Admin → Logs: the real system log (newest first, filter + search +
 *  pagination) and manual Backup & Restore. */
function LogsAdmin() {
  const queryClient = useQueryClient();
  const [actionFilter, setActionFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const logs = useQuery({
    queryKey: ["system-logs", actionFilter, search, page],
    queryFn: () =>
      api.listSystemLogs({
        action: actionFilter === "all" ? undefined : actionFilter,
        search: search.trim() || undefined,
        limit: LOGS_PAGE_SIZE,
        offset: (page - 1) * LOGS_PAGE_SIZE,
        token: getToken(),
      }),
  });

  const total = logs.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LOGS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const actions = logs.data?.actions ?? [];

  async function handleDownloadBackup() {
    setBackupError(null);
    setBackupMsg(null);
    setBackupBusy(true);
    try {
      const data = await api.exportBackup({ token: getToken() });
      if (data.ok) {
        downloadTextFile(data.filename, data.json, "application/json");
        setBackupMsg(`Backup downloaded as ${data.filename}. Keep the file safe — anyone with it can restore your data.`);
        queryClient.invalidateQueries({ queryKey: ["system-logs"] });
      } else {
        setBackupError(data.error ?? "Could not create the backup.");
      }
    } catch {
      setBackupError("No response from the server. Please try again in a moment.");
    }
    setBackupBusy(false);
  }

  async function handleRestoreFile(file: File) {
    setRestoreError(null);
    setRestoreMsg(null);
    setRestoreBusy(true);
    try {
      const text = await file.text();
      const data = await api.restoreBackup({ json: text, token: getToken() });
      if (data.ok && data.restored) {
        setRestoreMsg(
          `Backup restored: ${data.restored.users} users, ${data.restored.plans} plans, ${data.restored.downloads} downloads, ${data.restored.payments} payments, ${data.restored.tickets} tickets. Restored customer accounts have no usable password — reset each one from Customers → Reset password before they can log in. Your admin account was kept intact.`,
        );
        queryClient.invalidateQueries({ queryKey: ["system-logs"] });
        queryClient.invalidateQueries({ queryKey: ["admin-customers"] });
        queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
      } else {
        setRestoreError(data.error ?? "Could not restore the backup.");
      }
    } catch {
      setRestoreError("Could not read that file. Choose a backup JSON downloaded from this page.");
    }
    setRestoreBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="📋"
        title="System Logs"
        subtitle="Every real admin action, newest first. Nothing is seeded — an empty log just means nothing has happened yet."
      />
      <p className="border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.08)] p-3 text-sm font-semibold text-[var(--admin-dim)]" style={{ borderRadius: "var(--radius)" }}>
        ⚠️ Hosting note: this site runs on free hosting with no persistent disk, so the log and all other data live in the database and reset if the server restarts or redeploys. Download a backup (below) after important changes — there is no automatic scheduled backup to disk.
      </p>

      <SectionCard className="bg-[var(--admin-card)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="logs-search" className="text-sm font-bold">Search logs</label>
            <input
              id="logs-search"
              type="search"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Email, action or detail…"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="logs-action" className="text-sm font-bold">Action</label>
            <select
              id="logs-action"
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm sm:w-56"
              style={{ borderRadius: "var(--radius)" }}
            >
              <option value="all">All actions</option>
              {actions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-3 text-sm font-bold text-[var(--admin-dim)]">
          {logs.data ? `${total.toLocaleString()} event${total === 1 ? "" : "s"}` : "Loading…"}
        </p>
      </SectionCard>

      {logs.isPending && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}
      {logs.data && logs.data.logs.length === 0 && (
        <SectionCard className="py-12 text-center">
          <p className="text-6xl" aria-hidden="true">📋</p>
          <h2 className="mt-4 text-xl font-extrabold">No log events yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--admin-dim)]">
            Admin actions (logins, plan changes, payments, settings, ticket replies, announcements) appear here as they happen.
          </p>
        </SectionCard>
      )}
      <ul className="flex flex-col gap-2">
        {logs.data?.logs.map((l: SystemLogRow) => (
          <li key={l.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-extrabold text-[var(--accent)]">{l.action}</span>
              <span className="text-xs text-[var(--admin-dim)]">{new Date(l.createdAt).toLocaleString()}</span>
            </div>
            {l.detail && <p className="mt-1">{l.detail}</p>}
            {l.actorEmail && <p className="mt-0.5 text-xs text-[var(--admin-dim)]">{l.actorType} · {l.actorEmail}</p>}
          </li>
        ))}
      </ul>
      {total > 0 && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-xs text-[var(--admin-dim)]">
            Showing {(safePage - 1) * LOGS_PAGE_SIZE + 1}–{Math.min(safePage * LOGS_PAGE_SIZE, total)} of {total.toLocaleString()} events
          </p>
          <AdminPagination page={safePage} totalPages={totalPages} onPage={setPage} />
        </div>
      )}

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">💾 Backup &amp; Restore</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--admin-dim)]">
          Download a full backup of the database as a JSON file — users, plans, subscriptions, payments, downloads, favourites, notifications, tickets, articles, settings and the log itself. Password hashes, two-factor secrets and session tokens are <strong>never</strong> included in the file. The file also contains the saved API key and ad codes, so keep it private.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={backupBusy}
            onClick={handleDownloadBackup}
            className="bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {backupBusy ? "Preparing…" : "⬇ Download backup (JSON)"}
          </button>
        </div>
        {backupError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{backupError}</p>}
        {backupMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{backupMsg}</p>}

        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h3 className="text-base font-extrabold">Restore from a backup</h3>
          <p className="mt-1 text-sm leading-relaxed text-[var(--admin-dim)]">
            Upload a backup JSON downloaded from this page. It <strong>replaces all data</strong> (users, plans, payments, downloads, tickets, settings, log) with the backup's contents. Your admin account is kept intact with its real password, so you are never locked out, and your current session stays logged in. Restored customer accounts get no usable password — reset each one from Customers → Reset password before they can log in. Malformed files are rejected with an error and nothing is changed.
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm font-bold">
            <input
              type="checkbox"
              checked={restoreConfirmed}
              onChange={(e) => setRestoreConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            I understand this replaces all current data with the backup file.
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Choose a backup JSON file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleRestoreFile(f);
            }}
          />
          <button
            type="button"
            disabled={restoreBusy || !restoreConfirmed}
            onClick={() => fileRef.current?.click()}
            className="mt-3 border border-[var(--border)] px-5 py-2.5 font-extrabold disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {restoreBusy ? "Restoring…" : "Choose backup file…"}
          </button>
          {restoreError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{restoreError}</p>}
          {restoreMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{restoreMsg}</p>}
        </div>
      </SectionCard>
    </div>
  );
}

type ReportDay = ApiResponse<typeof api, "getReports">["days"][number];

/** Admin → Reports: real date-range analytics (UTC days) with CSV export. */
function ReportsAdmin() {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const reports = useQuery({
    queryKey: ["reports", from, to],
    queryFn: () => api.getReports({ from, to, token: getToken() }),
    enabled: valid,
  });
  const data = reports.data;
  const maxDownloads = Math.max(1, ...(data?.days.map((d) => d.downloads) ?? [1]));

  function loadRange() {
    if (!valid) {
      setRangeError("Pick a valid date range (from date on or before the to date).");
      return;
    }
    setRangeError(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHead
        icon="📈"
        title="Reports &amp; Analytics"
        subtitle="Real numbers from your downloads, payments and signups — nothing is invented. Days are UTC days; empty days show zero."
      />
      <SectionCard className="bg-[var(--admin-card)]">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-bold">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              style={{ borderRadius: "var(--radius)" }}
            />
          </label>
          <label className="text-sm font-bold">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              style={{ borderRadius: "var(--radius)" }}
            />
          </label>
          <button
            type="button"
            onClick={loadRange}
            disabled={reports.isFetching}
            className="bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {reports.isFetching ? "Loading…" : "Load report"}
          </button>
          <button
            type="button"
            onClick={() => { setFrom(defaultFrom); setTo(defaultTo); setRangeError(null); }}
            className="border border-[var(--border)] px-4 py-2.5 font-bold"
            style={{ borderRadius: "var(--radius)" }}
          >
            Last 30 days
          </button>
        </div>
        {rangeError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{rangeError}</p>}
        {data && !data.ok && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{data.error ?? "Could not load the report."}</p>}
      </SectionCard>

      {reports.isPending && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {data?.ok && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <AdminStatCard icon="⬇️" value={data.totals.downloads.toLocaleString()} label="Downloads" />
            <AdminStatCard icon="💰" value={formatPrice(data.totals.revenueCents)} label="Revenue" />
            <AdminStatCard icon="👤" value={data.totals.signups.toLocaleString()} label="New signups" />
            <AdminStatCard icon="💎" value={data.totals.plansSold.toLocaleString()} label="Plans sold" />
            <AdminStatCard icon="💾" value={`${data.totals.mbUsed.toFixed(1)} MB`} label="Bandwidth used" />
          </div>

          <SectionCard className="bg-[var(--admin-card)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-extrabold">Downloads per day</h2>
              <button
                type="button"
                onClick={() => downloadCsv(`downloads-${from}-to-${to}.csv`, ["date", "downloads", "revenue_usd", "signups"], data.days.map((d: ReportDay) => [d.date, d.downloads, (d.revenueCents / 100).toFixed(2), d.signups]))}
                className="border border-[var(--border)] px-4 py-2 text-sm font-extrabold"
                style={{ borderRadius: "var(--radius)" }}
              >
                ⬇ CSV — daily downloads
              </button>
            </div>
            <ul className="mt-4 flex flex-col gap-2">
              {data.days.map((d: ReportDay) => (
                <li key={d.date} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 font-bold text-[var(--admin-dim)]">{d.date}</span>
                  <span className="h-5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--hover-bg)]" aria-hidden="true">
                    <span
                      className="block h-full rounded-full bg-[var(--accent)]"
                      style={{ width: `${Math.max(d.downloads > 0 ? 2 : 0, (d.downloads / maxDownloads) * 100)}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right font-extrabold">{d.downloads.toLocaleString()}</span>
                  <span className="hidden w-24 shrink-0 text-right text-[var(--admin-dim)] sm:block">{formatPrice(d.revenueCents)}</span>
                  <span className="hidden w-20 shrink-0 text-right text-[var(--admin-dim)] sm:block">{d.signups} new</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadCsv(`revenue-${from}-to-${to}.csv`, ["date", "revenue_usd"], data.days.map((d: ReportDay) => [d.date, (d.revenueCents / 100).toFixed(2)]))}
                className="border border-[var(--border)] px-4 py-2 text-sm font-extrabold"
                style={{ borderRadius: "var(--radius)" }}
              >
                ⬇ CSV — revenue
              </button>
              <button
                type="button"
                onClick={() => downloadCsv(`signups-${from}-to-${to}.csv`, ["date", "signups"], data.days.map((d: ReportDay) => [d.date, d.signups]))}
                className="border border-[var(--border)] px-4 py-2 text-sm font-extrabold"
                style={{ borderRadius: "var(--radius)" }}
              >
                ⬇ CSV — signups
              </button>
            </div>
          </SectionCard>

          <SectionCard className="bg-[var(--admin-card)]">
            <h2 className="text-lg font-extrabold">Top customers by downloads</h2>
            {data.topCustomers.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--admin-dim)]">No logged-in customer downloads in this range.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {data.topCustomers.map((c) => (
                  <li key={c.userId} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                    <span className="min-w-0">
                      <span className="block truncate font-extrabold">{c.name}</span>
                      <span className="block truncate text-xs text-[var(--admin-dim)]">{c.email}</span>
                    </span>
                    <span className="font-extrabold text-[var(--accent)]">{c.downloads.toLocaleString()} downloads · {c.mb.toFixed(1)} MB</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

/** Admin → Settings → Security: admin 2FA (TOTP), active sessions with
 *  revocation, locked-out accounts, and the rate-limit rule. */
function SecurityAdmin() {
  const queryClient = useQueryClient();
  const security = useQuery({ queryKey: ["security-overview"], queryFn: () => api.getSecurityOverview({ token: getToken() }) });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [disablePw, setDisablePw] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disableMsg, setDisableMsg] = useState<string | null>(null);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disableBusy, setDisableBusy] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function handleStartSetup() {
    setSetupError(null);
    setSetupBusy(true);
    try {
      const data = await api.startTotpSetup({ token: getToken() });
      if (data.ok && data.secret && data.otpauthUrl) {
        setSetup({ secret: data.secret, otpauthUrl: data.otpauthUrl });
        setSetupCode("");
      } else {
        setSetupError(data.error ?? "Could not start 2FA setup.");
      }
    } catch {
      setSetupError("No response from the server. Please try again in a moment.");
    }
    setSetupBusy(false);
  }

  async function handleConfirmSetup() {
    if (!/^\d{6}$/.test(setupCode.trim())) {
      setSetupError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setSetupError(null);
    setSetupMsg(null);
    setSetupBusy(true);
    try {
      const data = await api.confirmTotpSetup({ code: setupCode.trim(), token: getToken() });
      if (data.ok) {
        setSetupMsg("Two-factor authentication is now ON. Your next admin login will ask for a code after the password.");
        setSetup(null);
        setSetupCode("");
        queryClient.invalidateQueries({ queryKey: ["security-overview"] });
      } else {
        setSetupError(data.error ?? "That code is not correct.");
      }
    } catch {
      setSetupError("No response from the server. Please try again in a moment.");
    }
    setSetupBusy(false);
  }

  async function handleDisable() {
    if (!disablePw || !/^\d{6}$/.test(disableCode.trim())) {
      setDisableError("Enter your current password and the 6-digit code.");
      return;
    }
    setDisableError(null);
    setDisableMsg(null);
    setDisableBusy(true);
    try {
      const data = await api.disableTotp({ password: disablePw, code: disableCode.trim(), token: getToken() });
      if (data.ok) {
        setDisableMsg("Two-factor authentication is now OFF.");
        setDisablePw("");
        setDisableCode("");
        queryClient.invalidateQueries({ queryKey: ["security-overview"] });
      } else {
        setDisableError(data.error ?? "Could not disable 2FA.");
      }
    } catch {
      setDisableError("No response from the server. Please try again in a moment.");
    }
    setDisableBusy(false);
  }

  async function handleRevoke(prefix: string) {
    setRevokeError(null);
    setRevokeMsg(null);
    setRevoking(prefix);
    try {
      const data = await api.revokeSession({ tokenPrefix: prefix, token: getToken() });
      if (data.ok) {
        setRevokeMsg("Session revoked — that user is signed out now.");
        queryClient.invalidateQueries({ queryKey: ["security-overview"] });
      } else {
        setRevokeError(data.error ?? "Could not revoke the session.");
      }
    } catch {
      setRevokeError("No response from the server. Please try again in a moment.");
    }
    setRevoking(null);
  }

  const totpEnabled = security.data?.totpEnabled ?? false;
  const sessions = security.data?.sessions ?? [];
  const locked = security.data?.lockedAccounts ?? [];

  return (
    <SectionCard className="bg-[var(--admin-card)]">
      <h2 className="text-lg font-extrabold">🔒 Security</h2>
      <p className="mt-1 text-sm text-[var(--admin-dim)]">
        Login rate limiting is always on: after 5 failed logins for one email within 15 minutes, that email is locked out for 15 minutes. A successful login clears the counter.
      </p>

      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <h3 className="text-base font-extrabold">Two-factor authentication (admin)</h3>
        {security.isPending ? (
          <Skeleton className="mt-2 h-10 w-full" />
        ) : totpEnabled ? (
          <>
            <p className="mt-1 text-sm font-semibold text-[var(--accent)]">✅ 2FA is ON — admin login needs a 6-digit code after the password.</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                autoComplete="current-password"
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
                placeholder="Current admin password"
                className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                style={{ borderRadius: "var(--radius)" }}
              />
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6-digit code"
                className="w-36 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                style={{ borderRadius: "var(--radius)" }}
              />
              <button
                type="button"
                disabled={disableBusy}
                onClick={handleDisable}
                className="border border-[rgba(248,113,113,0.5)] px-4 py-2 text-sm font-extrabold text-[var(--err-text)] disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {disableBusy ? "Disabling…" : "Disable 2FA"}
              </button>
            </div>
            {disableError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{disableError}</p>}
            {disableMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{disableMsg}</p>}
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--admin-dim)]">
              2FA is OFF. Turn it on to require a 6-digit code from an authenticator app (Google Authenticator, Authy, …) after the admin password. Customer accounts do not get 2FA.
            </p>
            {!setup && (
              <button
                type="button"
                disabled={setupBusy}
                onClick={handleStartSetup}
                className="mt-3 bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {setupBusy ? "Generating…" : "Enable two-factor authentication"}
              </button>
            )}
            {setup && (
              <div className="mt-3 border border-[var(--border)] bg-[var(--surface-alt)] p-4" style={{ borderRadius: "var(--radius)" }}>
                <p className="text-sm font-bold">1. Scan this QR code with your authenticator app</p>
                <div className="mt-3 flex justify-center bg-white p-3" style={{ borderRadius: 12, width: "fit-content" }}>
                  <QrCode value={setup.otpauthUrl} />
                </div>
                <p className="mt-3 text-sm font-bold">2. Or enter the secret manually</p>
                <p className="mt-1 break-all border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm select-all">{setup.secret}</p>
                <p className="mt-1 text-xs text-[var(--admin-dim)]">The QR code is drawn in your browser — the secret is never sent to any outside service. Keep it private like a password.</p>
                <p className="mt-3 text-sm font-bold">3. Enter the 6-digit code to confirm</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={setupCode}
                    onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6-digit code"
                    className="w-40 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center text-lg font-extrabold tracking-[0.3em]"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                  <button
                    type="button"
                    disabled={setupBusy}
                    onClick={handleConfirmSetup}
                    className="bg-[var(--accent)] px-4 py-2 text-sm font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {setupBusy ? "Verifying…" : "Confirm & turn on 2FA"}
                  </button>
                  <button type="button" onClick={() => { setSetup(null); setSetupCode(""); setSetupError(null); }} className="border border-[var(--border)] px-4 py-2 text-sm font-bold" style={{ borderRadius: "var(--radius)" }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {setupError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{setupError}</p>}
            {setupMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{setupMsg}</p>}
          </>
        )}
      </div>

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <h3 className="text-base font-extrabold">Active sessions</h3>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">Every signed-in session (admin + customers). Revoking a session signs that user out immediately. Your own current session cannot be revoked — use Logout instead.</p>
        {security.isPending ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : sessions.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--admin-dim)]">No active sessions.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {sessions.map((s) => (
              <li key={s.tokenPrefix + s.email} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="min-w-0">
                  <span className="block truncate font-extrabold">{s.email} {s.isCurrent && <span className="text-[var(--accent)]">(this session)</span>}</span>
                  <span className="block text-xs text-[var(--admin-dim)]">
                    {s.role} · session {s.tokenPrefix} · signed in {new Date(s.createdAt).toLocaleString()}
                    {s.lastSeenAt ? ` · last seen ${new Date(s.lastSeenAt).toLocaleString()}` : ""}
                  </span>
                </span>
                {!s.isCurrent && (
                  <button
                    type="button"
                    disabled={revoking === s.tokenPrefix}
                    onClick={() => handleRevoke(s.tokenPrefix)}
                    className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)] disabled:opacity-50"
                    style={{ borderRadius: 8 }}
                  >
                    {revoking === s.tokenPrefix ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revokeError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{revokeError}</p>}
        {revokeMsg && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{revokeMsg}</p>}
      </div>

      {locked.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h3 className="text-base font-extrabold">🔐 Locked out by failed logins</h3>
          <ul className="mt-3 flex flex-col gap-2">
            {locked.map((l) => (
              <li key={l.email} className="border border-[rgba(248,113,113,0.45)] bg-[rgba(248,113,113,0.08)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="font-extrabold">{l.email}</span>
                <span className="block text-xs text-[var(--admin-dim)]">
                  {l.failedCount} failed attempts · locked until {l.lockedUntil ? new Date(l.lockedUntil).toLocaleString() : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

/** Admin → Support → Announcements: write a broadcast that becomes a
 *  real in-app notification for every registered customer. No email —
 *  in-app only. */
function BroadcastAdmin() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const broadcasts = useQuery({ queryKey: ["broadcasts"], queryFn: () => api.listBroadcasts({ token: getToken() }) });

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !message.trim()) {
      setError("Write a title and a message first.");
      return;
    }
    setError(null);
    setMsg(null);
    setBusy(true);
    try {
      const data = await api.createBroadcast({ title: title.trim(), message: message.trim(), token: getToken() });
      if (data.ok) {
        setMsg(`Announcement sent to ${data.recipientCount} customer${data.recipientCount === 1 ? "" : "s"}. It appears in their Notifications (in-app only — no email is sent).`);
        setTitle("");
        setMessage("");
        queryClient.invalidateQueries({ queryKey: ["broadcasts"] });
      } else {
        setError(data.error ?? "Could not send the announcement.");
      }
    } catch {
      setError("No response from the server. Please try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">📢 Send an announcement</h2>
        <p className="mt-1 text-sm text-[var(--admin-dim)]">
          Write once, reach every registered customer as an in-app notification. Use it for maintenance notices, new features or plan news. No email is sent — customers see it in Notifications.
        </p>
        <form onSubmit={handleSend} className="mt-4 flex flex-col gap-3">
          <div>
            <label htmlFor="broadcast-title" className="text-sm font-bold">Title</label>
            <input
              id="broadcast-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="e.g. New: Bulk downloads are faster"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          <div>
            <label htmlFor="broadcast-message" className="text-sm font-bold">Message</label>
            <textarea
              id="broadcast-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Write the announcement…"
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {error && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{error}</p>}
          {msg && <p className="text-sm font-semibold text-[var(--accent)]" role="status">{msg}</p>}
          <button
            type="submit"
            disabled={busy}
            className="cta-gradient self-start px-5 py-2.5 font-extrabold disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {busy ? "Sending…" : "Send to all customers"}
          </button>
        </form>
      </SectionCard>

      <SectionCard className="bg-[var(--admin-card)]">
        <h2 className="text-lg font-extrabold">Past announcements</h2>
        {broadcasts.isPending && (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}
        {broadcasts.data && broadcasts.data.broadcasts.length === 0 && (
          <p className="mt-2 text-sm text-[var(--admin-dim)]">No announcements sent yet.</p>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {broadcasts.data?.broadcasts.map((b) => (
            <li key={b.id} className="border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
              <p className="font-extrabold">{b.title}</p>
              <p className="mt-1 whitespace-pre-line">{b.message}</p>
              <p className="mt-1 text-xs text-[var(--admin-dim)]">
                Sent to {b.recipientCount} customer{b.recipientCount === 1 ? "" : "s"} · {new Date(b.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
