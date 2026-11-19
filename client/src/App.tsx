import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import JSZip from "jszip";
import { SafeAreaTopScrim } from "./safe-area";
import { api, type ApiResponse } from "./api";

const FIELDS = {
  resolveLink: { text: {} },
  saveApiKey: { apiKey: {}, apiBaseUrl: {} },
  saveAdCode: { code: {} },
  submitContact: { name: {}, email: {}, message: {} },
  register: { name: {}, email: {}, password: {} },
  login: { email: {}, password: {} },
  userLogin: { email: {}, password: {} },
  assignPlan: { durationDays: {}, downloadLimit: {} },
  createPlan: { name: {}, durationDays: {}, downloadLimit: {}, description: {} },
  recordPayment: { amountCents: {}, method: {}, note: {} },
  saveAdminSettings: { freeDailyLimit: {} },
} as const;

type ResolveResult = ApiResponse<typeof api, "resolveLink">;
type AdminMeResult = ApiResponse<typeof api, "adminMe">;
type AdminUser = NonNullable<AdminMeResult["admin"]>;
type MeResult = ApiResponse<typeof api, "me">;
type MeUser = NonNullable<MeResult["user"]>;
type View =
  | "home"
  | "jimeng"
  | "history"
  | "plans"
  | "auth"
  | "myplan"
  | "whatis"
  | "howto"
  | "faq"
  | "bulk"
  | "sora"
  | "about"
  | "privacy"
  | "contact"
  | "admin";
type AdSlotKey = "head" | "top" | "incontent" | "sidebar" | "bottom";

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

const AD_SLOTS: { key: AdSlotKey; label: string; size: string }[] = [
  { key: "top", label: "Top Banner", size: "728 × 90 · Leaderboard" },
  { key: "incontent", label: "In-Content", size: "Responsive · In-article" },
  { key: "sidebar", label: "Sidebar", size: "300 × 250 · Rectangle" },
  { key: "bottom", label: "Bottom Banner", size: "728 × 90 · Leaderboard" },
  { key: "head", label: "Head Code (ads.txt / meta verification)", size: "Site-wide code" },
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
  const size = formatBytes(prepared.sizeBytes);
  return (
    <div
      className="mt-3 border border-[var(--accent)] bg-[var(--surface-alt)] p-3"
      style={{ borderRadius: "var(--radius)" }}
    >
      <p className="text-sm font-bold">
        ✓ File is ready{size ? ` (${size})` : ""} — now save it using one of these options:
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <a
          href={prepared.url}
          download={prepared.filename}
          className="flex-1 bg-[var(--accent)] px-4 py-2.5 text-center text-sm font-extrabold text-[var(--accent-ink)]"
          style={{ borderRadius: "var(--radius)" }}
        >
          ⬇ Download Now
        </a>
        <button
          type="button"
          onClick={onShare}
          className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
          style={{ borderRadius: "var(--radius)" }}
        >
          📤 Share and Save
        </button>
        <a
          href={prepared.url}
          target="_blank"
          rel="noopener"
          className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-center text-sm font-extrabold"
          style={{ borderRadius: "var(--radius)" }}
        >
          Open file in new tab
        </a>
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        On a phone, “Share and Save” is the most reliable option — in the sheet that opens, choose “Save to Files” or your Gallery app. “Download Now” saves the file through your browser's download manager.
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

/** Design-style ad placeholder: "ADVERTISEMENT · TOP BANNER 728 × 90".
 *  The slot stays a placeholder until the admin saves an AdSense code for
 *  it — the saved code is only marked, the box itself never renders ads
 *  from this preview. */
function AdSlot({ label, sub, saved, tall }: { label: string; sub?: string; saved: boolean; tall?: boolean }) {
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
  const items = [
    { icon: "⚡", title: "Lightning Fast", sub: "Download" },
    { icon: "🛡", title: "Secure & Safe", sub: "No Risk" },
    { icon: "📱", title: "Fully Responsive", sub: "All Devices" },
    { icon: "💎", title: "Modern Design", sub: "Premium Look" },
    { icon: "⭐", title: "Free Forever", sub: "No Hidden Fees" },
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
  return (
    <div className="cta-gradient flex flex-col items-center justify-between gap-3 px-6 py-5 text-center sm:flex-row sm:text-left" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-black/20 text-xl text-[var(--accent-ink)]" style={{ borderRadius: 12 }}>▶</span>
        <div>
          <p className="text-xl font-extrabold text-[var(--accent-ink)]">Jimeng Video Downloader</p>
          <p className="text-sm font-bold text-[var(--accent-ink)]/80">Your Ultimate Jimeng Download Tool</p>
        </div>
      </div>
      <p className="text-sm font-extrabold whitespace-nowrap text-[var(--accent-ink)]">Free · No Watermark · Original MP4</p>
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
        <span className="text-lg font-extrabold tracking-wide text-white">JIMENG</span>
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
  { view: "home", label: "Home", icon: "🏠" },
  { view: "jimeng", label: "Jimeng Downloader", icon: "🎬" },
  { view: "history", label: "Download History", icon: "🕘" },
  { view: "plans", label: "Plans", icon: "💎" },
  { view: "whatis", label: "What is Jimeng?", icon: "❓" },
  { view: "howto", label: "How to Use", icon: "📖" },
  { view: "faq", label: "FAQ", icon: "💬" },
  { view: "bulk", label: "Bulk Download", icon: "📦" },
  { view: "sora", label: "Sora Downloader", icon: "🎬", badge: "Coming Soon" },
  { view: "contact", label: "Contact", icon: "✉️" },
  { view: "about", label: "About", icon: "ℹ️" },
  { view: "privacy", label: "Privacy Policy", icon: "🔒" },
];

export function App() {
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

      {/* Side menu drawer (reference: savevideoraw style) */}
      {menuOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Site menu">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setMenuOpen(false)} />
          <div className="glass absolute top-0 right-0 flex h-full w-[80%] max-w-[340px] flex-col overflow-y-auto bg-[var(--surface)] shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-5 pb-2">
              <Logo compact />
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
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
                      <p className="text-base font-extrabold">Guest User</p>
                      <p className="text-xs text-[var(--dim)]">Welcome!</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => go("auth")}
                    className="cta-gradient mt-3 w-full px-4 py-2.5 text-sm font-extrabold"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    🔑 Login / Register
                  </button>
                </div>
              )}
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.view}
                  type="button"
                  onClick={() => go(item.view)}
                  className={`flex items-center justify-between gap-2 px-3 py-3.5 text-left text-lg font-semibold ${view === item.view ? "text-[var(--accent)]" : ""}`}
                >
                  <span>{item.icon} {item.label}</span>
                  {item.view === "history" && historyCount > 0 && (
                    <span className="bg-[var(--accent)] px-2 py-0.5 text-xs font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
                      {historyCount}
                    </span>
                  )}
                  {item.badge && (
                    <span className="border border-[var(--border)] px-2 py-0.5 text-xs font-bold text-[var(--dim)]" style={{ borderRadius: 999 }}>
                      {item.badge}
                    </span>
                  )}
                </button>
              ))}
              {user && !admin && (
                <button
                  type="button"
                  onClick={() => go("myplan")}
                  className={`flex items-center justify-between gap-2 px-3 py-3.5 text-left text-lg font-semibold ${view === "myplan" ? "text-[var(--accent)]" : ""}`}
                >
                  <span>💎 My Plan</span>
                </button>
              )}
              {admin && (
                <button
                  type="button"
                  onClick={handleLogout}
                  className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-3.5 text-left text-lg font-semibold text-[var(--err-text)]"
                >
                  <span>🚪 Logout</span>
                </button>
              )}
              {user && !admin && (
                <button
                  type="button"
                  onClick={handleUserLogout}
                  className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-3.5 text-left text-lg font-semibold text-[var(--err-text)]"
                >
                  <span>🚪 Logout</span>
                </button>
              )}
            </nav>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-7xl px-4 pb-8">
        {/* Top banner ad slot */}
        <div className="pt-4">
          <AdSlot label="Advertisement · Top Banner 728 × 90" saved={Boolean(settings.data?.adSlots.top)} />
        </div>

        {/* Header: logo + menu + history (design) */}
        <header className="flex items-center justify-between gap-3 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={() => go("home")} aria-label="Jimeng Downloader — home" className="shrink-0">
              <Logo />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              className="glass flex items-center gap-2 border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-extrabold"
              style={{ borderRadius: "var(--radius)" }}
            >
              ☰ Menu <span aria-hidden="true" className="text-xs">▾</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => go("history")}
            aria-label="Open download history"
            className={`glass flex items-center gap-2 border px-4 py-2 text-sm font-extrabold ${view === "history" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
            style={{ borderRadius: "var(--radius)" }}
          >
            🕘 History
            <span className="flex h-5 min-w-5 items-center justify-center bg-[var(--accent)] px-1 text-xs font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
              {historyCount}
            </span>
          </button>
        </header>

        {view === "home" && (
          <>
            {/* Hero (design) */}
            <section className="relative overflow-hidden py-6 text-center sm:py-10">
              <HeroArt />
              <div className="relative">
                <p className="inline-block border border-[var(--accent)] bg-[rgba(0,233,154,0.08)] px-4 py-1.5 text-xs font-extrabold tracking-[0.18em] text-[var(--accent)]" style={{ borderRadius: 999 }}>
                  SEEDANCE 2.0 · JIMENG AI
                </p>
                <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-extrabold leading-tight sm:text-5xl">
                  Jimeng Video Downloader — <span className="text-gradient">No Watermark</span>
                </h1>
                <p className="mx-auto mt-3 max-w-2xl text-base text-[var(--dim)] sm:text-lg">
                  Choose a downloader below — paste a public link and download the original MP4. Free, no login required.
                </p>
                <p className="mx-auto mt-4 text-sm font-semibold text-[var(--dim)]">Jimeng is live now — more downloaders coming soon.</p>
                {meQuery.data?.ok && meQuery.data.user && (
                  <p className="mt-3 text-sm font-semibold text-[var(--accent)]">
                    {meQuery.data.plan
                      ? `💎 ${meQuery.data.plan.planName} plan — ${meQuery.data.plan.remaining} of ${meQuery.data.plan.limitTotal} downloads left (until ${new Date(meQuery.data.plan.expiresAt).toLocaleDateString()})`
                      : meQuery.data.freeDailyLimit === 0
                        ? "Free plan — unlimited downloads today."
                        : `Free plan — ${meQuery.data.freeRemaining} of ${meQuery.data.freeDailyLimit} free downloads left today.`}
                  </p>
                )}
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <main className="flex min-w-0 flex-col gap-6">

              {/* Choose a downloader */}
              <section>
                <h2 className="text-2xl font-extrabold">Choose a downloader</h2>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Pick a platform below — paste a public link and download the original video. Free, no login required.
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="glass card-hover flex flex-col border border-[rgba(0,233,154,0.35)] bg-[var(--surface)] p-5 shadow-[0_0_45px_rgba(0,233,154,0.10)]" style={{ borderRadius: "var(--radius)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-3xl" aria-hidden="true">🎬</span>
                      <StatusPill tone="green" label="● LIVE" pulse />
                    </div>
                    <h3 className="mt-3 text-xl font-extrabold">Jimeng Video Downloader</h3>
                    <p className="mt-1 flex-1 text-sm leading-relaxed text-[var(--dim)]">
                      Paste a public Jimeng share link and download the original MP4 — no watermark. Single video, or Bulk up to 10 videos at once.
                    </p>
                    <button
                      type="button"
                      onClick={() => go("jimeng")}
                      className="cta-gradient mt-4 w-full px-5 py-3 text-base font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      Open Downloader →
                    </button>
                  </div>
                  <div className="glass flex flex-col border border-[var(--border)] bg-[var(--surface)] p-5" style={{ borderRadius: "var(--radius)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-3xl" aria-hidden="true">🎥</span>
                      <StatusPill tone="amber" label="Coming Soon" />
                    </div>
                    <h3 className="mt-3 text-xl font-extrabold">Sora Downloader</h3>
                    <p className="mt-1 flex-1 text-sm leading-relaxed text-[var(--dim)]">
                      Download videos from Sora. We are still verifying a working method, so there is no tool here yet — nothing fake, nothing half-finished.
                    </p>
                    <button
                      type="button"
                      disabled
                      className="mt-4 w-full cursor-not-allowed border border-[var(--border)] bg-[var(--surface-alt)] px-5 py-3 text-base font-extrabold text-[var(--dim)]"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      Coming Soon
                    </button>
                  </div>
                </div>
              </section>
            </main>

            {/* Sidebar */}
            <aside className="flex min-w-0 flex-col gap-6">
              <AdSlot label="Advertisement · Sidebar" sub="300 × 250" saved={Boolean(settings.data?.adSlots.sidebar)} tall />
              <SectionCard>
                <h2 className="flex items-center gap-2 text-lg font-extrabold">
                  <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>?</span>
                  Need help?
                </h2>
                <div className="mt-3 flex flex-col">
                  <button type="button" onClick={() => go("howto")} className="flex items-center justify-between border-b border-[var(--border)] py-2.5 text-left text-sm font-bold text-[var(--accent)]">
                    <span>📖 How to Use</span><span aria-hidden="true">›</span>
                  </button>
                  <button type="button" onClick={() => go("faq")} className="flex items-center justify-between py-2.5 text-left text-sm font-bold text-[var(--accent)]">
                    <span>💬 FAQ</span><span aria-hidden="true">›</span>
                  </button>
                </div>
              </SectionCard>
            </aside>
            </div>

            {/* In-content ad (design: full width, below the downloader) */}
            <div className="mt-6">
              <AdSlot label="Advertisement · In-Content" saved={Boolean(settings.data?.adSlots.incontent)} />
            </div>

            {/* How it works (design) */}
            <section className="mt-10">
              <h2 className="text-2xl font-extrabold">🚀 How it works</h2>
              <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-stretch">
                {[
                  { n: "1", icon: "🎬", title: "Choose a downloader", text: "Pick Jimeng from the downloaders above." },
                  { n: "2", icon: "📋", title: "Paste your link", text: "Paste a public share link in the box." },
                  { n: "3", icon: "⬇", title: "Preview & download", text: "Enjoy your video!" },
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
        {view === "plans" && (
          <PlansPage
            user={user}
            onNeedLogin={() => go("auth")}
          />
        )}
        {view === "auth" && !userChecked && (
          <main className="mx-auto max-w-3xl py-16 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="mt-3 text-base text-[var(--dim)]">Loading…</p>
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
            <p className="mt-3 text-base text-[var(--dim)]">Loading…</p>
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
            initialMode="single"
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
            onGoPlans={() => go("plans")}
            onGoHistory={() => go("history")}
            sidebarAdSaved={Boolean(settings.data?.adSlots.sidebar)}
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
          />
        )}
        {view === "admin" && !adminChecked && (
          <main className="mx-auto max-w-3xl py-16 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="mt-3 text-base text-[var(--dim)]">Loading…</p>
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

        <footer className="mt-10 border-t border-[var(--border)] pt-6 text-center">
          <BrandBanner />
          <nav aria-label="Footer" className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-bold">
            <button type="button" onClick={() => go("jimeng")} className="py-1">Downloader</button>
            <button type="button" onClick={() => go("history")} className="py-1">History</button>
            <button type="button" onClick={() => go("plans")} className="py-1">Plans</button>
            <button type="button" onClick={() => go("howto")} className="py-1">How to Use</button>
            <button type="button" onClick={() => go("faq")} className="py-1">FAQ</button>
            <button type="button" onClick={() => go("bulk")} className="py-1">Bulk Download</button>
            <button type="button" onClick={() => go("about")} className="py-1">About</button>
            <button type="button" onClick={() => go("privacy")} className="py-1">Privacy Policy</button>
            <button type="button" onClick={() => go("contact")} className="py-1">Contact</button>
          </nav>
          {/* Bottom banner ad slot (design: below the footer links) */}
          <div className="mt-6">
            <AdSlot label="Advertisement · Bottom Banner 728 × 90" saved={Boolean(settings.data?.adSlots.bottom)} />
          </div>
          <p className="mt-4 pb-2 text-xs text-[var(--dim)] italic">
            Personal use only. All video copyrights belong to their creators and ByteDance / Jimeng AI. This tool is not affiliated with Jimeng.
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
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.listHistory({ limit: 30, token: getUserToken(), anonId: getAnonId() }) });
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🕘" title="Your Download History" subtitle="View and manage your downloaded videos" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-bold text-[var(--dim)]">
          {history.data ? `${history.data.items.length} video${history.data.items.length === 1 ? "" : "s"} saved` : "Loading…"}
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
          <h2 className="mt-4 text-xl font-extrabold">No downloads yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
            As soon as you fetch your first video it will be saved here — even after you close and reopen the page.
          </p>
          <button
            type="button"
            onClick={onGoHome}
            className="cta-gradient mt-5 px-6 py-3 text-base font-extrabold"
            style={{ borderRadius: "var(--radius)" }}
          >
            ⬇ Go to Downloader
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
                <p className="truncate text-base font-extrabold">{item.title || "Jimeng video"}</p>
                <p className="truncate text-xs text-[var(--dim)]">{item.sourceUrl}</p>
                <p className="text-xs text-[var(--dim)]">{new Date(item.createdAt).toLocaleString()}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={downloading === `h-${item.id}`} onClick={() => onDownload(item.videoUrl, "jimeng-no-watermark.mp4", `h-${item.id}`)} className="bg-[var(--accent)] px-4 py-1.5 text-xs font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: 8 }}>
                    {downloading === `h-${item.id}` ? "Preparing file…" : "⬇ Download"}
                  </button>
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
}: JimengDownloaderPageProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"single" | "bulk">(initialMode);

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
      setSelectedVideo(0);
      if (data.ok) queryClient.invalidateQueries({ queryKey: ["history"] });
    },
    onError: () => {
      setResult({
        ok: false, sourceUrl: "", title: "", coverUrl: null, videos: [], images: [],
        usedCustomApi: false, note: null,
        error: "No response from the server. Please try again in a moment.",
      });
    },
  });

  function handleResolve() {
    if (!linkText.trim()) {
      setLinkError("First paste a Jimeng share link in the box above, then tap this button.");
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
        setPasteMsg("Link pasted ✓");
      } else setPasteMsg("Clipboard is empty — copy the link from Jimeng first.");
    } catch {
      setPasteMsg("Auto-paste didn't work — long-press in the box or press Ctrl+V to paste.");
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
      setBulkTextError("First paste Jimeng links in the box — one link per line.");
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
          prev.map((it, j) => (j === i ? { ...it, status: data.ok ? "done" : "error", result: data, selectedVideo: 0 } : it)),
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
                    usedCustomApi: false, note: null,
                    error: "No response from the server. Please try again in a moment.",
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
      return { ok: false, error: prep.error ?? "The file could not be prepared.", limitReached: prep.limitReached };
    } catch {
      return { ok: false, error: "No response from the server.", limitReached: false };
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
      const name = it.result!.title || `Video ${i + 1}`;
      setBatchStatus(`Downloading ${n + 1}/${targets.length}… ${name}`);
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
        `Download All finished: ${okCount} of ${targets.length} video${targets.length === 1 ? "" : "s"} started.`,
        failed.length > 0 ? `Could not start ${failed.length}: ${failed.slice(0, 3).join(" · ")}${failed.length > 3 ? ` (and ${failed.length - 3} more)` : ""}` : null,
        "If a download did not start in your browser, use that video's own Download button below.",
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
      const name = it.result!.title || `Video ${i + 1}`;
      setZipStatus(`Preparing ${n + 1}/${targets.length}… ${name}`);
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
        failed.push(`${name}: the prepared file could not be read.`);
      }
    }
    if (added === 0) {
      setZipRunning(false);
      setZipStatus(null);
      setZipSummary(
        `ZIP could not be created — none of the videos could be prepared. ${failed.slice(0, 3).join(" · ")}`,
      );
      if (hitLimit) onGoPlans();
      return;
    }
    setZipStatus(`Zipping ${added} video${added === 1 ? "" : "s"}…`);
    try {
      // MP4s are already compressed, so STORE keeps zipping fast and light.
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const url = URL.createObjectURL(zipBlob);
      triggerBrowserDownload(url, "jimeng-videos.zip");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setZipSummary(
        [
          `ZIP ready with ${added} video${added === 1 ? "" : "s"} — if the download did not start, tap “Download ZIP” again.`,
          failed.length > 0 ? `Skipped ${failed.length}: ${failed.slice(0, 3).join(" · ")}${failed.length > 3 ? ` (and ${failed.length - 3} more)` : ""}` : null,
        ].filter(Boolean).join(" "),
      );
    } catch {
      setZipSummary("The ZIP could not be created — please try again, or use the individual Download buttons below.");
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
        <PageHero icon="🎬" title="Jimeng Downloader" subtitle="Paste a public Jimeng share link and download the original MP4 — no watermark" />
        <p className="mx-auto inline-flex items-center gap-2 border border-[rgba(251,191,36,0.4)] bg-[var(--warn-bg)] px-4 py-2 text-sm font-bold text-[var(--warn-text)]" style={{ borderRadius: 999 }}>
          ⚠ Only Published (Public) videos work. Private drafts cannot be downloaded.
        </p>

        <SectionCard className="border-[rgba(0,233,154,0.35)] shadow-[0_0_45px_rgba(0,233,154,0.10)]">
          {/* Single / Bulk mode toggle */}
          <div className="flex gap-2" role="tablist" aria-label="Download mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "single"}
              onClick={() => setMode("single")}
              className={`flex-1 px-4 py-2.5 text-sm font-extrabold ${mode === "single" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              Single — 1 video
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "bulk"}
              onClick={() => setMode("bulk")}
              className={`flex-1 px-4 py-2.5 text-sm font-extrabold ${mode === "bulk" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "border border-[var(--border)] bg-[var(--surface)]"}`}
              style={{ borderRadius: "var(--radius)" }}
            >
              Bulk — up to {BULK_MAX_LINKS} videos
            </button>
          </div>

          {mode === "single" && (
            <>
              <h2 className="mt-5 flex items-center gap-2 text-xl font-extrabold">
                <span className="text-[var(--accent)]">🔗</span> Paste your Jimeng share link
              </h2>
              <p className="mt-1 text-sm text-[var(--dim)]">
                Open the video in Jimeng → tap Share → Link → Copy
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <textarea
                  {...FIELDS.resolveLink.text}
                  id="jimeng-link"
                  aria-label="Jimeng share link"
                  value={linkText}
                  onChange={(e) => { setLinkText(e.target.value); if (linkError) setLinkError(null); }}
                  placeholder="https://jimeng.jianying.com/s/xxxxx"
                  rows={2}
                  className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
                  style={{ borderRadius: "var(--radius)" }}
                />
                <div className="flex gap-2 sm:flex-col">
                  <button type="button" onClick={handlePaste} className="glass flex-1 border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm font-bold sm:flex-none" style={{ borderRadius: "var(--radius)" }}>
                    📋 Paste
                  </button>
                  <button type="button" onClick={() => { setLinkText(""); setResult(null); setLinkError(null); }} className="flex-1 border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--dim)] sm:flex-none" style={{ borderRadius: "var(--radius)" }}>
                    🗑 Clear
                  </button>
                </div>
              </div>
              <p className="mt-2 text-xs text-[var(--dim)]">
                Tip: you can also paste Jimeng's full share text — the link is extracted from it automatically.
              </p>
              {linkError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{linkError}</p>}
              <button
                type="button"
                disabled={resolve.isPending}
                onClick={handleResolve}
                className="cta-gradient mt-3 w-full px-5 py-3.5 text-lg font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {resolve.isPending ? "Fetching video…" : "⬇ Get Video — No Watermark"}
              </button>
              <p className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-sm font-semibold text-[var(--dim)]">
                <span><span className="text-[var(--accent)]">✓</span> Free to start</span>
                <span aria-hidden="true" className="text-[var(--border)]">|</span>
                <span><span className="text-[var(--accent)]">⚡</span> Original MP4</span>
                <span aria-hidden="true" className="text-[var(--border)]">|</span>
                <span><span className="text-[var(--accent)]">✓</span> No login required</span>
              </p>
              {pasteMsg && <p className="mt-2 text-sm text-[var(--dim)]">{pasteMsg}</p>}

              {/* Single result */}
              {result && !result.ok && (
                <div className="mt-4 bg-[var(--err-bg)] p-4 text-sm font-semibold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }} role="alert">
                  {result.error}
                  {result.note && <p className="mt-1 font-normal">{result.note}</p>}
                  {result.sourceUrl && (
                    <p className="mt-2 break-all font-normal">
                      This link was found in your text: <span className="font-mono text-xs">{result.sourceUrl}</span>
                      <br />
                      If this link looks incomplete (especially the last part), copy the full share text from the Jimeng app again and paste it here.
                    </p>
                  )}
                </div>
              )}
              {result?.ok && chosenVideo && (
                <div className="mt-5">
                  <div className="flex flex-col items-center gap-1 text-center">
                    <span className="flex h-12 w-12 items-center justify-center bg-[var(--accent)] text-2xl font-extrabold text-[var(--accent-ink)] shadow-[0_0_28px_rgba(0,233,154,0.4)]" style={{ borderRadius: 999 }}>✓</span>
                    <h3 className="mt-1 text-2xl font-extrabold">Download Ready!</h3>
                    <p className="text-sm text-[var(--dim)]">Your video is ready to download</p>
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
                      Actual file size: {chosenVideo.width} × {chosenVideo.height}px — full frame, no cropping. Any black bars at the edges in the preview come from the player, not the video.
                    </p>
                  )}
                  {result.title && <p className="mt-2 text-sm font-semibold">{result.title}</p>}

                  <p className="mt-4 text-sm font-bold">Choose quality / file:</p>
                  <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="Video quality options">
                    {result.videos.map((v, i) => (
                      <button
                        key={v.url}
                        type="button"
                        role="radio"
                        aria-checked={i === selectedVideo}
                        onClick={() => setSelectedVideo(i)}
                        className={`flex items-center justify-between border px-4 py-2.5 text-left text-sm font-semibold ${i === selectedVideo ? "border-[var(--accent)] bg-[var(--surface-alt)]" : "border-[var(--border)]"}`}
                        style={{ borderRadius: "var(--radius)" }}
                      >
                        <span>🎬 {v.label}</span>
                        <span className="text-xs text-[var(--dim)]">
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
                    {downloading === "main" ? "Preparing file…" : "⬇ Download MP4 — No Watermark"}
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
                      ↻ Download Another
                    </button>
                    <button
                      type="button"
                      onClick={onGoHistory}
                      className="flex-1 border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-extrabold"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      🕘 Saved to History — view it
                    </button>
                  </div>
                  <p className="mt-3 flex items-center justify-center gap-2 border border-[rgba(0,233,154,0.35)] bg-[rgba(0,233,154,0.08)] px-4 py-2.5 text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>
                    ✓ Tip: Save this video for offline viewing!
                  </p>
                  <p className="mt-2 text-xs text-[var(--dim)]">
                    When you tap Download, the file is first prepared on this site's server, then the Save buttons above will appear — tap one of them. You can also often long-press the playing video to get a “Download video” option.
                  </p>

                  {result.images.length > 0 && (
                    <>
                      <p className="mt-5 text-sm font-bold">Images / cover from this link:</p>
                      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {result.images.map((img, i) => (
                          <figure key={img.url} className="border border-[var(--border)] p-2" style={{ borderRadius: "var(--radius)" }}>
                            <img src={img.url} alt={`Jimeng image ${i + 1}`} className="h-28 w-full bg-[var(--surface-alt)] object-contain" loading="lazy" />
                            <button
                              type="button"
                              disabled={downloading === `img-${i}`}
                              onClick={() => onDownload(img.url, `jimeng-image-${i + 1}.jpg`, `img-${i}`)}
                              className="mt-2 w-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                              style={{ borderRadius: "var(--radius)" }}
                            >
                              {downloading === `img-${i}` ? "…" : "⬇ Image download"}
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
                  <p className="text-sm font-semibold">No video was found for this link — this is an image post. The images are below:</p>
                  {result.title && <p className="mt-2 text-sm font-semibold">{result.title}</p>}
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {result.images.map((img, i) => (
                      <figure key={img.url} className="border border-[var(--border)] p-2" style={{ borderRadius: "var(--radius)" }}>
                        <img src={img.url} alt={`Jimeng image ${i + 1}`} className="h-28 w-full bg-[var(--surface-alt)] object-contain" loading="lazy" />
                        <button
                          type="button"
                          disabled={downloading === `img-${i}`}
                          onClick={() => onDownload(img.url, `jimeng-image-${i + 1}.jpg`, `img-${i}`)}
                          className="mt-2 w-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                          style={{ borderRadius: "var(--radius)" }}
                        >
                          {downloading === `img-${i}` ? "…" : "⬇ Image download"}
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
            </>
          )}

          {mode === "bulk" && (
            <>
              <div className="mt-5 flex flex-col items-center gap-1 border-2 border-dashed border-[var(--ad-border)] bg-[var(--surface-alt)] px-4 py-5 text-center" style={{ borderRadius: "var(--radius)" }}>
                <span className="text-4xl" aria-hidden="true">☁️</span>
                <p className="text-base font-extrabold">Upload or Paste Multiple Links</p>
                <p className="text-sm text-[var(--dim)]">Supports multiple Jimeng links — one per line, up to {BULK_MAX_LINKS} at a time. Links are resolved one by one and each video gets its own download button below. Every successful video is also saved to History.</p>
              </div>
              <label htmlFor="bulk-links" className="mt-4 block text-sm font-bold">Jimeng links — one per line</label>
              <textarea
                id="bulk-links"
                aria-label="Bulk Jimeng links, one per line"
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
                {bulkRunning ? "Resolving links…" : `⬇ Fetch All Videos (up to ${BULK_MAX_LINKS})`}
              </button>
              {items.length > 0 && (
                <div className="mt-4" role="status">
                  <div className="flex justify-between text-sm font-bold">
                    <span>{bulkRunning ? `Working… ${doneCount}/${items.length} done` : `Done: ${doneCount}/${items.length} videos fetched.`}</span>
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
                    {batchRunning ? (batchStatus ?? "Downloading…") : `⬇ Download All (${doneCount})`}
                  </button>
                  <button
                    type="button"
                    disabled={batchRunning || zipRunning || bulkRunning}
                    onClick={handleDownloadZip}
                    className="flex-1 border border-[var(--accent)] bg-[var(--surface)] px-4 py-3 text-sm font-extrabold text-[var(--accent)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {zipRunning ? (zipStatus ?? "Preparing ZIP…") : `🗜 Download ZIP (${doneCount})`}
                  </button>
                </div>
              )}
              {batchSummary && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{batchSummary}</p>}
              {zipSummary && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{zipSummary}</p>}
              {(batchRunning || zipRunning) && (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  Each video counts toward your free daily limit. If a download does not start in your browser, use that video's own Download button below.
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
                            {item.status === "waiting" && <StatusPill tone="gray" label="⏳ Waiting" />}
                            {item.status === "working" && <StatusPill tone="amber" label="Fetching…" pulse />}
                            {item.status === "done" && <StatusPill tone="green" label="✓ Done" />}
                            {item.status === "error" && <StatusPill tone="red" label="✕ Error" />}
                          </div>
                          {item.status === "waiting" && <p className="mt-1 text-sm font-semibold text-[var(--dim)]">Waiting for its turn…</p>}
                          {item.status === "working" && <p className="mt-1 text-sm font-semibold">Fetching video…</p>}
                          {item.status === "error" && item.result && !item.result.ok && (
                            <p className="mt-1 text-sm font-semibold text-[var(--err-text)]">{item.result.error}</p>
                          )}
                          {item.status === "done" && item.result?.ok && (
                            <>
                              <p className="mt-1 truncate text-sm font-bold">{item.result.title || "Jimeng video"}</p>
                              {video ? (
                                <>
                                  <label className="mt-2 block text-xs font-bold text-[var(--dim)]" htmlFor={`bulk-quality-${i}`}>
                                    Export quality
                                  </label>
                                  <select
                                    id={`bulk-quality-${i}`}
                                    aria-label={`Export quality for video ${i + 1}`}
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
                                    {downloading === tag ? "Preparing file…" : "⬇ Download MP4 — No Watermark"}
                                  </button>
                                </>
                              ) : (
                                <p className="mt-1 text-sm font-semibold">No video was found for this link (it may be an image post) — paste it in Single mode to see the images.</p>
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
        <AdSlot label="Advertisement · Sidebar" sub="300 × 250" saved={sidebarAdSaved} tall />
        <SectionCard>
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <span className="flex h-6 w-6 items-center justify-center bg-[var(--accent)] text-sm font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>?</span>
            Need help?
          </h2>
          <div className="mt-3 flex flex-col">
            <button type="button" onClick={() => onGoHistory()} className="flex items-center justify-between border-b border-[var(--border)] py-2.5 text-left text-sm font-bold text-[var(--accent)]">
              <span>🕘 Download History</span><span aria-hidden="true">›</span>
            </button>
            <p className="py-2.5 text-sm text-[var(--dim)]">Tip: on a phone, open the playing video's ⋮ menu → Share → Save to save it straight to your gallery.</p>
          </div>
        </SectionCard>
      </aside>
    </div>
  );
}
function WhatIsJimengPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="❓" title="What is Jimeng?" subtitle="ByteDance's AI video platform — and how this downloader works with it" />
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
  const steps = [
    { n: "1", icon: "🔗", title: "Copy Link", text: "Open Jimeng app, share video, and copy the link." },
    { n: "2", icon: "📋", title: "Paste Link", text: "Paste the link in our downloader box." },
    { n: "3", icon: "⬇", title: "Download", text: "Click the button and save your video." },
  ];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="📖" title="How to Use Jimeng Downloader" subtitle="Three easy steps — copy, paste, download" />
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
        <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">Another easy method that works on phones: open the playing video in the preview → tap the <strong>three dots (⋮)</strong> on the video → <strong>Share</strong> → then <strong>Save</strong> at the end — the video goes straight to your gallery, with no watermark.</p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">If a link doesn't work, the reason is usually that the video is still a draft/private, or the share link has expired — copy a fresh link from Jimeng and try again. Avatar (cast template) links also work, but they are usually only valid for 48 hours — copy one and paste it here right away.</p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">To fetch several videos at once, open <strong>Bulk Download</strong> from the menu — paste one link per line and they will all be fetched one by one.</p>
      </SectionCard>
    </main>
  );
}

function FaqPage() {
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
      <PageHero icon="💬" title="Frequently Asked Questions" subtitle="Everything you need to know about the downloader" />
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
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="🎬" title="Sora Downloader" subtitle="Download videos from Sora — coming soon" />
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
          Go to Jimeng Downloader
        </button>
      </SectionCard>
    </main>
  );
}

function ClearHistoryButton() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.clearHistory({}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["history"] }); setConfirming(false); },
  });
  if (!confirming)
    return <button type="button" onClick={() => setConfirming(true)} className="text-sm font-bold text-[var(--err-text)]">Clear all history</button>;
  return (
    <span className="flex items-center gap-2 text-sm">
      Are you sure?
      <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="font-bold text-[var(--err-text)]">Yes, clear it</button>
      <button type="button" onClick={() => setConfirming(false)} className="font-bold text-[var(--dim)]">No</button>
    </span>
  );
}

function DeleteHistoryButton({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const mut = useMutation({
    mutationFn: () => api.deleteHistoryItem({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["history"] }),
  });
  return (
    <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="border border-[rgba(248,113,113,0.5)] px-3 py-1.5 text-xs font-extrabold text-[var(--err-text)]" style={{ borderRadius: 8 }}>
      🗑 Delete
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
        subtitle="Once your AdSense is approved, paste each slot's code here and save it. No publisher ID is pre-filled — only add your own code."
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {AD_SLOTS.map((slot) => (
          <AdSlotEditor key={slot.key} slot={slot.key} label={slot.label} size={slot.size} saved={Boolean(settings?.adSlots[slot.key])} />
        ))}
      </div>
      <p className="text-xs text-[var(--admin-dim)]">
        The code is stored only on the server and the slot is marked “code saved” — the empty Ad Space boxes on the page are exactly where the ads will appear.
      </p>
    </div>
  );
}

function AdSlotEditor({ slot, label, size, saved }: { slot: AdSlotKey; label: string; size: string; saved: boolean }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => await api.saveAdCode({ slot, code, token: getToken() }),
    onSuccess: () => { setMsg("Code saved ✓"); setCode(""); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (error) => setMsg(error.message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAdCode({ slot, token: getToken() }),
    onSuccess: () => { setMsg("Code removed."); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
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

function AboutPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="ℹ️" title="About — Jimeng Video Downloader" subtitle="A free tool for saving your own public Jimeng videos, clean" />
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
      <PageHero icon="🔒" title="Privacy Policy" subtitle="How this site handles your links, keys and messages" />
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
      <PageHero icon="✉️" title="Contact Us" subtitle="We are here to help you!" />
      <div className="grid gap-4 sm:grid-cols-2">
        <SectionCard className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-[rgba(0,233,154,0.12)] text-xl" style={{ borderRadius: 12 }}>✉️</span>
          <div>
            <p className="text-base font-extrabold">Email</p>
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
            <label htmlFor="contact-email" className="text-sm font-bold">Email</label>
            <input {...FIELDS.submitContact.email} id="contact-email" aria-label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="contact-message" className="text-sm font-bold">Message</label>
            <textarea {...FIELDS.submitContact.message} id="contact-message" aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
          <button type="submit" disabled={mut.isPending} className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
            {mut.isPending ? "Sending…" : "Send message"}
          </button>
        </form>
      </SectionCard>
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
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        const data = await api.register({ name: name.trim(), email: email.trim(), password });
        if (data.ok && data.token && data.user) {
          setUserToken(data.token);
          onLoggedIn(data.user);
        } else {
          setError(data.error ?? "Could not create the account — please try again.");
        }
      } else {
        // Unified login: admin credentials open the Admin Panel directly,
        // customer credentials open the User Panel.
        const data = await api.login({ email: email.trim(), password });
        if (data.ok && data.token && data.role === "admin" && data.admin) {
          setToken(data.token);
          onAdminLoggedIn(data.admin);
        } else if (data.ok && data.token && data.role === "customer" && data.user) {
          setUserToken(data.token);
          onLoggedIn(data.user);
        } else {
          setError(data.error ?? "Incorrect email or password.");
        }
      }
    } catch {
      setError("No response from the server. Please try again in a moment.");
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5">
      <div className="animate-fade-up pt-4 text-center sm:pt-8">
        <span className="inline-block"><Logo /></span>
        <h1 className="text-gradient mt-4 text-3xl font-extrabold">{mode === "login" ? "Login" : "Create an account"}</h1>
        <p className="mx-auto mt-2 max-w-sm text-base text-[var(--dim)]">
          Downloads are free and need no login. An account is only needed if you want to buy a monthly plan for more downloads.
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
              {m === "login" ? "Login" : "Register"}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          {mode === "register" && (
            <div>
              <label htmlFor="auth-name" className="text-sm font-bold">Your name</label>
              <input
                {...FIELDS.register.name}
                id="auth-name"
                autoComplete="name"
                value={name}
                onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
                placeholder="Your name"
                className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                style={{ borderRadius: "var(--radius)" }}
              />
            </div>
          )}
          <div>
            <label htmlFor="auth-email" className="text-sm font-bold">Email</label>
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
            <label htmlFor="auth-password" className="text-sm font-bold">Password</label>
            <input
              {...(mode === "register" ? FIELDS.register.password : FIELDS.login.password)}
              id="auth-password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
              placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
              className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
              style={{ borderRadius: "var(--radius)" }}
            />
          </div>
          {error && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="cta-gradient px-5 py-2.5 font-extrabold disabled:opacity-50"
            style={{ borderRadius: "var(--radius)" }}
          >
            {busy ? "Please wait…" : mode === "login" ? "🔑 Log in" : "Create my account"}
          </button>
        </form>
      </SectionCard>
    </main>
  );
}

function PlansPage({ user, onNeedLogin }: { user: MeUser | null; onNeedLogin: () => void }) {
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
            ? `You already have a pending request for the ${data.request.planName} plan — the admin will activate it after receiving your payment.`
            : `Request sent for the ${data.request.planName} plan (${formatPrice(data.request.priceCents)}). Payment coming soon — the admin will activate your plan after receiving the payment.`,
        );
        queryClient.invalidateQueries({ queryKey: ["my-requests"] });
      } else {
        setBuyError(data.error ?? "Could not send the request — please try again.");
      }
    } catch {
      setBuyError("No response from the server. Please try again in a moment.");
    }
    setBuyingId(null);
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="💎" title="Choose Your Plan" subtitle="Get more downloads and enjoy premium features" />
      <p className="text-center text-base text-[var(--dim)]">
        Downloading is free up to the daily limit. Need more? Buy a monthly plan — a plan gives you a fixed number of downloads for its duration (for example 1,000 videos in 30 days). When the plan runs out or expires, you fall back to the free daily limit automatically.
      </p>
      <div>
        {!user && (
          <p className="mt-3 border border-[var(--accent)] bg-[var(--surface-alt)] p-3 text-sm font-semibold" style={{ borderRadius: "var(--radius)" }}>
            To buy a plan you need an account —{" "}
            <button type="button" onClick={onNeedLogin} className="font-extrabold text-[var(--accent)]">
              log in or register
            </button>{" "}
            first. Downloads themselves stay free and need no login.
          </p>
        )}
        {me.data?.ok && me.data.plan && (
          <p className="mt-3 border border-[var(--accent)] bg-[var(--surface-alt)] p-3 text-sm font-semibold" style={{ borderRadius: "var(--radius)" }}>
            💎 Your current plan: {me.data.plan.planName} — {me.data.plan.remaining} of {me.data.plan.limitTotal} downloads left, until {new Date(me.data.plan.expiresAt).toLocaleDateString()}.
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
      {plans.isError && <p className="text-sm font-semibold text-[var(--err-text)]">Could not load the plans — please try again in a moment.</p>}
      {plans.data && plans.data.plans.length === 0 && (
        <p className="text-sm text-[var(--dim)]">No plans are available right now — please check back later.</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Free plan — always available; downloads need no account. */}
        <div className="glass card-hover relative flex flex-col border border-[var(--border)] bg-[var(--surface)] p-5" style={{ borderRadius: "var(--radius)" }}>
          <h2 className="text-xl font-extrabold">Free Plan</h2>
          <p className="mt-1 text-3xl font-extrabold">$0.00</p>
          <p className="text-sm text-[var(--dim)]">forever</p>
          <p className="mt-3 text-base font-bold">
            {me.data?.ok ? (me.data.freeDailyLimit === 0 ? "Unlimited downloads" : `${me.data.freeDailyLimit} Downloads/Day`) : "10 Downloads/Day"}
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> No Watermark</li>
            <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> Original MP4</li>
            <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> No login required</li>
          </ul>
          <button type="button" disabled className="mt-4 w-full border border-[var(--accent)] bg-[rgba(0,233,154,0.10)] px-5 py-2.5 font-extrabold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>
            {me.data?.plan ? "Free Plan" : "Current Plan"}
          </button>
        </div>
        {plans.data?.plans.map((plan) => {
          const isPopular = plan.name.toLowerCase() === "pro";
          const isCurrent = me.data?.plan?.planName === plan.name;
          return (
            <div key={plan.id} className={`glass card-hover relative flex flex-col border bg-[var(--surface)] p-5 ${isPopular ? "border-[var(--accent)] shadow-[0_0_35px_rgba(0,233,154,0.18)]" : "border-[var(--border)]"}`} style={{ borderRadius: "var(--radius)" }}>
              {isPopular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[var(--accent)] px-3 py-1 text-xs font-extrabold whitespace-nowrap text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>⭐ Most Popular</span>
              )}
              <h2 className="text-xl font-extrabold">{plan.name}</h2>
              <p className="mt-1 text-3xl font-extrabold">{formatPrice(plan.priceCents)}</p>
              <p className="text-sm text-[var(--dim)]">for {plan.durationDays} days</p>
              <p className="mt-3 text-base font-bold">{plan.downloadLimit.toLocaleString()} video downloads</p>
              {plan.description && <p className="mt-1 text-sm text-[var(--dim)]">{plan.description}</p>}
              <ul className="mt-3 space-y-1.5 text-sm">
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> No Watermark</li>
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> Original MP4 quality</li>
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> Fast server-side download</li>
                <li className="flex items-center gap-2"><span className="text-[var(--accent)]">✓</span> Falls back to Free when used up</li>
              </ul>
              <button
                type="button"
                disabled={buyingId === plan.id || isCurrent}
                onClick={() => handleBuy(plan.id)}
                className="cta-gradient mt-4 w-full px-5 py-2.5 font-extrabold disabled:opacity-50"
                style={{ borderRadius: "var(--radius)" }}
              >
                {isCurrent ? "Current Plan" : buyingId === plan.id ? "Sending…" : "Buy"}
              </button>
            </div>
          );
        })}
      </div>

      {user && requests.data && requests.data.requests.length > 0 && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">Your purchase requests</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {requests.data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="font-bold">{r.planName} — {formatPrice(r.priceCents)}</span>
                {r.status === "pending" && <StatusPill tone="amber" label="⏳ Pending" />}
                {r.status === "paid" && <StatusPill tone="green" label="✓ Paid" />}
                {r.status === "activated" && <StatusPill tone="green" label="✓ Active" />}
                {r.status === "rejected" && <StatusPill tone="red" label="✕ Rejected" />}
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
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me({ token: getUserToken() }) });
  const requests = useQuery({ queryKey: ["my-requests"], queryFn: () => api.myRequests({ token: getUserToken() }) });
  const data = me.data;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <PageHero icon="💎" title="My Plan" subtitle="Your account dashboard" />
      <SectionCard className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center bg-[var(--accent)] text-2xl font-extrabold text-[var(--accent-ink)]" style={{ borderRadius: 999 }}>
          {user.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold">{user.name}</p>
          <p className="truncate text-sm text-[var(--dim)]">{user.email}</p>
        </div>
        <span className="ml-auto shrink-0">
          <StatusPill tone={data?.plan ? "green" : "gray"} label={data?.plan ? data.plan.planName : "Free Plan"} />
        </span>
      </SectionCard>

      {data?.ok && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard value={String(data.downloadsToday)} label="Downloads today" />
          <StatCard value={String(data.downloadsTotal)} label="Total downloads" />
          <StatCard value={data.plan ? String(data.plan.remaining) : data.freeDailyLimit === 0 ? "∞" : String(data.freeRemaining)} label="Downloads left" />
          <StatCard value={data.plan ? new Date(data.plan.expiresAt).toLocaleDateString() : data.freeDailyLimit === 0 ? "—" : `${data.freeDailyLimit}/day`} label={data.plan ? "Plan expires" : "Free daily limit"} />
        </div>
      )}

      {me.isPending && <p className="text-sm text-[var(--dim)]">Loading…</p>}
      {data?.ok && data.plan && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">💎 {data.plan.planName} plan</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            {formatPrice(data.plan.priceCents)} · {data.plan.durationDays} days · started {new Date(data.plan.startsAt).toLocaleDateString()}
          </p>
          <div className="mt-4">
            <div className="flex justify-between text-sm font-bold">
              <span>{data.plan.limitUsed.toLocaleString()} of {data.plan.limitTotal.toLocaleString()} downloads used</span>
              <span>{data.plan.remaining.toLocaleString()} left</span>
            </div>
            <div className="mt-1 h-3 w-full overflow-hidden bg-[var(--surface-alt)]" style={{ borderRadius: 999 }}>
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: `${Math.min(100, Math.round((data.plan.limitUsed / Math.max(1, data.plan.limitTotal)) * 100))}%` }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm">
            Expires on <strong>{new Date(data.plan.expiresAt).toLocaleDateString()}</strong> — or earlier, when the {data.plan.limitTotal.toLocaleString()} downloads are used up. After that you fall back to the free daily limit automatically.
          </p>
          <button
            type="button"
            onClick={onGoPlans}
            className="mt-4 bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)]"
            style={{ borderRadius: "var(--radius)" }}
          >
            View all plans
          </button>
        </SectionCard>
      )}
      {data?.ok && !data.plan && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">Free plan</h2>
          <p className="mt-2 text-base">
            You are on the free plan —{" "}
            {data.freeDailyLimit === 0
              ? "unlimited downloads today."
              : `${data.freeRemaining} of ${data.freeDailyLimit} free downloads left today.`}
          </p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            Downloads today: {data.downloadsToday} · Total downloads: {data.downloadsTotal}. Need more than the daily limit? A monthly plan gives you up to 10,000 downloads.
          </p>
          <button
            type="button"
            onClick={onGoPlans}
            className="mt-4 bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)]"
            style={{ borderRadius: "var(--radius)" }}
          >
            See plans
          </button>
        </SectionCard>
      )}

      {requests.data && requests.data.requests.length > 0 && (
        <SectionCard>
          <h2 className="text-lg font-extrabold">Your purchase requests</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {requests.data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border border-[var(--border)] p-3 text-sm" style={{ borderRadius: "var(--radius)" }}>
                <span className="font-bold">{r.planName} — {formatPrice(r.priceCents)}</span>
                {r.status === "pending" && <StatusPill tone="amber" label="⏳ Pending" />}
                {r.status === "paid" && <StatusPill tone="green" label="✓ Paid" />}
                {r.status === "activated" && <StatusPill tone="green" label="✓ Active" />}
                {r.status === "rejected" && <StatusPill tone="red" label="✕ Rejected" />}
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

type AdminTab = "dashboard" | "customers" | "plans" | "payments" | "ads" | "apikey" | "settings";

/** The admin sidebar has exactly these items — the reference image shows
 *  extra routes (Video Analytics, Revenue Reports, Notifications, Support
 *  Tickets, Backup & Restore, Premium upsell…); none of those exist in
 *  this system, so none are added here. */
const ADMIN_NAV: { key: AdminTab; label: string; icon: string }[] = [
  { key: "dashboard", label: "Dashboard", icon: "📊" },
  { key: "customers", label: "Customers", icon: "👥" },
  { key: "plans", label: "Plans", icon: "💎" },
  { key: "payments", label: "Payments", icon: "💳" },
  { key: "ads", label: "Ads", icon: "📢" },
  { key: "apikey", label: "API Key", icon: "🔑" },
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
            className={`flex items-center gap-3 px-4 py-3 text-left text-base font-bold ${tab === t.key ? "cta-gradient text-[var(--accent-ink)] shadow-[0_8px_24px_rgba(0,233,154,0.30)]" : "text-[var(--admin-dim)] hover:bg-white/5 hover:text-white"}`}
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
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-base font-bold text-[var(--err-text)] hover:bg-white/5"
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
                className="flex h-10 w-10 items-center justify-center bg-white/5 text-lg font-bold"
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
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-bold text-[var(--err-text)] hover:bg-white/5"
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
                  className="border border-[var(--border)] px-4 py-2 text-sm font-bold hover:bg-white/5"
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
                  </div>
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
                className="border border-[var(--border)] px-4 py-2 text-sm font-bold hover:bg-white/5"
                style={{ borderRadius: "var(--radius)" }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => handleToggleActive(p)}
                className="border border-[var(--border)] px-4 py-2 text-sm font-bold hover:bg-white/5"
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
    </div>
  );
}
