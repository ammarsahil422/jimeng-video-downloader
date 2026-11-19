import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "./safe-area";
import { api, type ApiResponse } from "./api";

type ResolveResult = ApiResponse<typeof api, "resolveLink">;
type View =
  | "home"
  | "history"
  | "whatis"
  | "howto"
  | "faq"
  | "bulk"
  | "sora"
  | "about"
  | "privacy"
  | "contact";
type AdSlotKey = "head" | "top" | "incontent" | "sidebar" | "bottom";

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

function AdSlot({ label, size, saved, tall }: { label: string; size: string; saved: boolean; tall?: boolean }) {
  return (
    <div
      role="complementary"
      aria-label={`Ad space: ${label}`}
      className={`flex flex-col items-center justify-center gap-1 border-2 border-dashed border-[var(--ad-border)] bg-[var(--surface-alt)] px-4 text-center ${tall ? "min-h-64 py-8" : "min-h-24 py-4"}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      <p className="text-xs font-bold tracking-widest text-[var(--dim)] uppercase">Ad Space — {label}</p>
      <p className="text-xs text-[var(--dim)]">{size}</p>
      {saved ? (
        <p className="text-xs font-semibold text-[var(--accent)]">✓ Your AdSense code is saved — your ad will appear here</p>
      ) : (
        <p className="text-xs text-[var(--dim)]">Your Google AdSense ad will appear here — paste your code in Ads Setup below</p>
      )}
    </div>
  );
}

function SectionCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`border border-[var(--border)] bg-[var(--surface)] p-5 ${className}`}
      style={{ borderRadius: "var(--radius)" }}
    >
      {children}
    </section>
  );
}

const MENU_ITEMS: { view: View; label: string; badge?: string }[] = [
  { view: "home", label: "Jimeng Downloader" },
  { view: "history", label: "Download History" },
  { view: "whatis", label: "What is Jimeng?" },
  { view: "howto", label: "How to Use" },
  { view: "faq", label: "FAQ" },
  { view: "bulk", label: "Bulk Download" },
  { view: "sora", label: "Sora Downloader", badge: "Coming Soon" },
  { view: "contact", label: "Contact" },
  { view: "about", label: "About" },
  { view: "privacy", label: "Privacy Policy" },
];

export function App() {
  const [view, setView] = useState<View>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const queryClient = useQueryClient();

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({}) });
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.listHistory({ limit: 30 }) });
  const historyCount = history.data?.items.length ?? 0;

  const [linkText, setLinkText] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [selectedVideo, setSelectedVideo] = useState(0);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSave | null>(null);
  const preparedBlobRef = useRef<{ tag: string; blob: Blob } | null>(null);
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);

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

  const resolve = useMutation({
    mutationFn: (text: string) => api.resolveLink({ text }),
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
      const prep = await api.prepareDownload({ url });
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
      } else {
        setDownloadNote(prep.error ?? "The file could not be prepared — please try again.");
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

  const chosenVideo = result?.ok ? result.videos[selectedVideo] : undefined;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      {/* Side menu drawer (reference: savevideoraw style) */}
      {menuOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Site menu">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setMenuOpen(false)} />
          <div className="absolute top-0 right-0 flex h-full w-[80%] max-w-[340px] flex-col overflow-y-auto bg-[var(--surface)] shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-5 pb-2">
              <span className="text-xl font-extrabold">Jimeng Downloader</span>
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
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.view}
                  type="button"
                  onClick={() => go(item.view)}
                  className={`flex items-center justify-between gap-2 px-3 py-3.5 text-left text-lg font-semibold ${view === item.view ? "text-[var(--accent)]" : ""}`}
                >
                  <span>{item.label}</span>
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
            </nav>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-4 pb-8">
        {/* Top banner ad slot */}
        <div className="pt-4">
          <AdSlot label="Top Banner" size="728 × 90 · Leaderboard" saved={Boolean(settings.data?.adSlots.top)} />
        </div>

        {/* Top bar: menu + history buttons */}
        <div className="flex items-center justify-between gap-2 py-4">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-extrabold"
            style={{ borderRadius: "var(--radius)" }}
          >
            ☰ Menu
          </button>
          <button
            type="button"
            onClick={() => go("history")}
            aria-label="Open download history"
            className={`border px-4 py-2 text-sm font-extrabold ${view === "history" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface)]"}`}
            style={{ borderRadius: "var(--radius)" }}
          >
            🕘 History{historyCount > 0 ? ` (${historyCount})` : ""}
          </button>
        </div>

        {view === "home" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <main className="flex min-w-0 flex-col gap-6">
              <div>
                <h1 className="text-3xl font-extrabold leading-tight">Jimeng Video Downloader — No Watermark</h1>
                <p className="mt-2 text-base text-[var(--dim)]">
                  Seedance 2.0 · Jimeng AI — Paste a public Jimeng share link and download the original MP4 with no watermark. Free, no login required.
                </p>
                <p className="mt-2 text-sm font-semibold text-[var(--warn-text)]">
                  ⚠️ Only Published (Public) videos work — a private draft link will not work. Videos are for personal use only; copyright belongs to the creator and ByteDance / Jimeng AI.
                </p>
              </div>

              {/* Downloader box */}
              <SectionCard>
                <label htmlFor="jimeng-link" className="text-sm font-bold">Paste your Jimeng share link</label>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Open the video in the Jimeng app → share arrow ↗ → link icon 🔗 → copy the link and paste it here. Links look like: <span className="font-mono text-xs">https://jimeng.jianying.com/s/xxxxx</span> — You can also paste Jimeng's full share text; the link will be extracted from it automatically.
                </p>
                <textarea
                  id="jimeng-link"
                  aria-label="Jimeng share link"
                  value={linkText}
                  onChange={(e) => { setLinkText(e.target.value); if (linkError) setLinkError(null); }}
                  placeholder="https://jimeng.jianying.com/s/xxxxx"
                  rows={3}
                  className="mt-3 w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
                  style={{ borderRadius: "var(--radius)" }}
                />
                {linkError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{linkError}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={handlePaste} className="border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm font-bold" style={{ borderRadius: "var(--radius)" }}>
                    📋 Paste
                  </button>
                  <button type="button" onClick={() => { setLinkText(""); setResult(null); setLinkError(null); }} className="border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--dim)]" style={{ borderRadius: "var(--radius)" }}>
                    Clear
                  </button>
                  <button
                    type="button"
                    disabled={resolve.isPending}
                    onClick={handleResolve}
                    className="flex-1 bg-[var(--accent)] px-5 py-2 text-base font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                    style={{ borderRadius: "var(--radius)" }}
                  >
                    {resolve.isPending ? "Fetching video…" : "⬇ Get Video — No Watermark"}
                  </button>
                </div>
                {pasteMsg && <p className="mt-2 text-sm text-[var(--dim)]">{pasteMsg}</p>}

                {/* Result */}
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
                    {result.note && <p className="mb-2 text-sm text-[var(--dim)]">{result.note}</p>}
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
                      onClick={() => handleDownload(chosenVideo.url, "jimeng-no-watermark.mp4", "main")}
                      className="mt-3 w-full bg-[var(--accent)] px-5 py-3 text-base font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
                      style={{ borderRadius: "var(--radius)" }}
                    >
                      {downloading === "main" ? "Preparing file…" : "⬇ Download MP4 — No Watermark"}
                    </button>
                    {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
                    {prepared?.tag === "main" && (
                      <SavePanel prepared={prepared} onShare={() => handleShareSave("main")} />
                    )}
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
                                onClick={() => handleDownload(img.url, `jimeng-image-${i + 1}.jpg`, `img-${i}`)}
                                className="mt-2 w-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                                style={{ borderRadius: "var(--radius)" }}
                              >
                                {downloading === `img-${i}` ? "…" : "⬇ Image download"}
                              </button>
                            </figure>
                          ))}
                        </div>
                        {prepared?.tag.startsWith("img-") && (
                          <SavePanel prepared={prepared} onShare={() => handleShareSave(prepared.tag)} />
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
                            onClick={() => handleDownload(img.url, `jimeng-image-${i + 1}.jpg`, `img-${i}`)}
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
                      <SavePanel prepared={prepared} onShare={() => handleShareSave(prepared.tag)} />
                    )}
                  </div>
                )}
              </SectionCard>

              <AdSlot label="In-Content" size="Responsive · In-article" saved={Boolean(settings.data?.adSlots.incontent)} />

              <AdsSetup settings={settings.data} />
            </main>

            {/* Sidebar */}
            <aside className="flex min-w-0 flex-col gap-6">
              <ApiKeyBox settings={settings.data} />
              <AdSlot label="Sidebar" size="300 × 250 · Rectangle" saved={Boolean(settings.data?.adSlots.sidebar)} tall />
              <SectionCard>
                <h2 className="text-lg font-extrabold">Supported links</h2>
                <ul className="mt-2 space-y-1 text-sm text-[var(--dim)]">
                  <li>• jimeng.jianying.com/s/xxxxx</li>
                  <li>• jimeng.cn — public creations</li>
                  <li>• dreamina.jianying.com</li>
                  <li>• dreamina.capcut.com</li>
                </ul>
                <p className="mt-2 text-sm text-[var(--dim)]">Only public/published creations — private drafts, deleted or login-walled videos cannot be fetched.</p>
              </SectionCard>
            </aside>
          </div>
        )}

        {view === "history" && (
          <HistoryPage
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
          />
        )}
        {view === "whatis" && <WhatIsJimengPage />}
        {view === "howto" && <HowToPage />}
        {view === "faq" && <FaqPage />}
        {view === "bulk" && (
          <BulkDownloadPage
            downloading={downloading}
            prepared={prepared}
            downloadNote={downloadNote}
            onDownload={handleDownload}
            onShare={handleShareSave}
          />
        )}
        {view === "sora" && <SoraPage onGoHome={() => go("home")} />}
        {view === "about" && <AboutPage />}
        {view === "privacy" && <PrivacyPage />}
        {view === "contact" && <ContactPage />}

        {/* Bottom ad slot */}
        <div className="mt-8">
          <AdSlot label="Bottom Banner" size="728 × 90 · Leaderboard" saved={Boolean(settings.data?.adSlots.bottom)} />
        </div>

        <footer className="mt-8 border-t border-[var(--border)] pt-5 pb-2 text-center">
          <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-bold">
            <button type="button" onClick={() => go("home")} className="py-1">Downloader</button>
            <button type="button" onClick={() => go("history")} className="py-1">History</button>
            <button type="button" onClick={() => go("howto")} className="py-1">How to Use</button>
            <button type="button" onClick={() => go("faq")} className="py-1">FAQ</button>
            <button type="button" onClick={() => go("bulk")} className="py-1">Bulk Download</button>
            <button type="button" onClick={() => go("about")} className="py-1">About</button>
            <button type="button" onClick={() => go("privacy")} className="py-1">Privacy Policy</button>
            <button type="button" onClick={() => go("contact")} className="py-1">Contact</button>
          </nav>
          <p className="mt-3 text-xs text-[var(--dim)]">
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
};

function HistoryPage({ downloading, prepared, downloadNote, onDownload, onShare }: DownloadFlowProps) {
  const history = useQuery({ queryKey: ["history"], queryFn: () => api.listHistory({ limit: 30 }) });
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-extrabold">My Download History</h1>
        {history.data && history.data.items.length > 0 && <ClearHistoryButton />}
      </div>
      <SectionCard>
        {history.data && history.data.items.length > 0 && (
          <p className="border border-[var(--warn-text)] bg-[var(--warn-bg)] p-3 text-sm font-semibold text-[var(--warn-text)]" style={{ borderRadius: "var(--radius)" }}>
            Note: Files in your earlier history may contain Jimeng's watermark (the AI badge at the top and the Jimeng @user mark at the bottom) — those were Jimeng's display files. The site now fetches the clean master file: to get a clean download, paste the same link again and fetch it fresh.
          </p>
        )}
        {history.isPending && <p className="mt-3 text-sm text-[var(--dim)]">Loading…</p>}
        {history.data && history.data.items.length === 0 && (
          <p className="text-sm text-[var(--dim)]">No downloads yet. As soon as you fetch your first video it will be saved here — even after you close and reopen the page.</p>
        )}
        {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
        <ul className="mt-3 flex flex-col gap-3">
          {history.data?.items.map((item) => (
            <li key={item.id} className="flex gap-3 border border-[var(--border)] p-3" style={{ borderRadius: "var(--radius)" }}>
              {item.coverUrl ? (
                <img src={item.coverUrl} alt="" className="h-16 w-12 shrink-0 object-cover" style={{ borderRadius: 8 }} />
              ) : (
                <div className="flex h-16 w-12 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-lg" style={{ borderRadius: 8 }}>🎬</div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{item.title || "Jimeng video"}</p>
                <p className="truncate text-xs text-[var(--dim)]">{item.sourceUrl}</p>
                <p className="text-xs text-[var(--dim)]">{new Date(item.createdAt).toLocaleString()}</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button type="button" disabled={downloading === `h-${item.id}`} onClick={() => onDownload(item.videoUrl, "jimeng-no-watermark.mp4", `h-${item.id}`)} className="bg-[var(--accent)] px-3 py-1 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: 8 }}>
                    {downloading === `h-${item.id}` ? "Preparing file…" : "⬇ Download again"}
                  </button>
                  <DeleteHistoryButton id={item.id} />
                </div>
                {prepared?.tag === `h-${item.id}` && (
                  <SavePanel prepared={prepared} onShare={() => onShare(prepared.tag)} />
                )}
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>
    </main>
  );
}

const BULK_MAX_LINKS = 10;

type BulkItem = {
  line: string;
  status: "waiting" | "working" | "done" | "error";
  result: ResolveResult | null;
};

function BulkDownloadPage({ downloading, prepared, downloadNote, onDownload, onShare }: DownloadFlowProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [textError, setTextError] = useState<string | null>(null);
  const [items, setItems] = useState<BulkItem[]>([]);
  const [running, setRunning] = useState(false);

  async function handleBulk() {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      setTextError("First paste Jimeng links in the box — one link per line.");
      return;
    }
    setTextError(null);
    const batch = lines.slice(0, BULK_MAX_LINKS);
    setItems(batch.map((line) => ({ line, status: "waiting", result: null })));
    setRunning(true);
    for (let i = 0; i < batch.length; i++) {
      const line = batch[i];
      if (!line) continue;
      setItems((prev) => prev.map((it, j) => (j === i ? { ...it, status: "working" } : it)));
      try {
        const data = await api.resolveLink({ text: line });
        setItems((prev) =>
          prev.map((it, j) => (j === i ? { ...it, status: data.ok ? "done" : "error", result: data } : it)),
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
    setRunning(false);
  }

  const doneCount = items.filter((it) => it.status === "done").length;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-3xl font-extrabold">Bulk Download</h1>
        <p className="mt-2 text-base text-[var(--dim)]">
          Fetch several Jimeng videos at once — paste one share link per line (up to {BULK_MAX_LINKS} links at a time). Links are resolved one by one and each video gets its own download button below. Every successful video is also saved to History.
        </p>
      </div>
      <SectionCard>
        <label htmlFor="bulk-links" className="text-sm font-bold">Jimeng links — one per line</label>
        <textarea
          id="bulk-links"
          aria-label="Bulk Jimeng links, one per line"
          value={text}
          onChange={(e) => { setText(e.target.value); if (textError) setTextError(null); }}
          placeholder={"https://jimeng.jianying.com/s/xxxxx\nhttps://jimeng.jianying.com/s/yyyyy"}
          rows={6}
          className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-base break-all"
          style={{ borderRadius: "var(--radius)" }}
        />
        {textError && <p className="mt-2 text-sm font-semibold text-[var(--err-text)]" role="alert">{textError}</p>}
        <button
          type="button"
          disabled={running}
          onClick={handleBulk}
          className="mt-3 w-full bg-[var(--accent)] px-5 py-3 text-base font-extrabold text-[var(--accent-ink)] disabled:opacity-50"
          style={{ borderRadius: "var(--radius)" }}
        >
          {running ? "Resolving links…" : `⬇ Fetch All Videos (up to ${BULK_MAX_LINKS})`}
        </button>
        {items.length > 0 && (
          <p className="mt-3 text-sm font-semibold text-[var(--dim)]" role="status">
            {running ? `Working… ${doneCount}/${items.length} done` : `Done: ${doneCount}/${items.length} videos fetched.`}
          </p>
        )}
        {downloadNote && <p className="mt-2 text-sm font-semibold text-[var(--accent)]" role="status">{downloadNote}</p>}
        <ul className="mt-3 flex flex-col gap-3">
          {items.map((item, i) => {
            const video = item.result?.ok ? item.result.videos[0] : undefined;
            const tag = `bulk-${i}`;
            return (
              <li key={i} className="border border-[var(--border)] p-3" style={{ borderRadius: "var(--radius)" }}>
                <div className="flex gap-3">
                  {item.result?.ok && item.result.coverUrl ? (
                    <img src={item.result.coverUrl} alt="" className="h-16 w-12 shrink-0 object-cover" style={{ borderRadius: 8 }} />
                  ) : (
                    <div className="flex h-16 w-12 shrink-0 items-center justify-center bg-[var(--surface-alt)] text-lg" style={{ borderRadius: 8 }}>🎬</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-[var(--dim)]">{item.line}</p>
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
                            <p className="text-xs text-[var(--dim)]">
                              {[video.label, video.width && video.height ? `${video.width}×${video.height}` : null, formatBytes(video.sizeBytes), "MP4"].filter(Boolean).join(" · ")}
                            </p>
                            <button
                              type="button"
                              disabled={downloading === tag}
                              onClick={() => onDownload(video.url, "jimeng-no-watermark.mp4", tag)}
                              className="mt-1.5 bg-[var(--accent)] px-3 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                              style={{ borderRadius: 8 }}
                            >
                              {downloading === tag ? "Preparing file…" : "⬇ Download MP4 — No Watermark"}
                            </button>
                          </>
                        ) : (
                          <p className="mt-1 text-sm font-semibold">No video was found for this link (it may be an image post) — paste it in the main Downloader to see the images.</p>
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
      </SectionCard>
    </main>
  );
}

function WhatIsJimengPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <h1 className="text-3xl font-extrabold">What is Jimeng?</h1>
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
    </main>
  );
}

function HowToPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <h1 className="text-3xl font-extrabold">How to Use</h1>
      <SectionCard>
        <h2 className="text-xl font-extrabold">How to download — 3 steps</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-base">
          <li><strong>Copy the link:</strong> Open your video in the Jimeng AI app or site, first <strong>Publish (Public)</strong> it, then use the share arrow ↗ → link icon to copy the share link.</li>
          <li><strong>Paste it:</strong> Paste the link in the box on the Downloader page and tap “Get Video”. The video preview will play right here.</li>
          <li><strong>Choose a quality and download:</strong> Select the Origin (No Watermark) quality and tap “Download MP4” — the file is first prepared on this site's server, then the Save buttons appear below. On a phone, tap “Share and Save” and choose “Save to Files” or your Gallery app in the sheet; or use “Download Now” to save through your browser's download manager. (Direct downloads from Jimeng's CDN used to get stuck in the app, which is why the file is prepared on the server first.)</li>
        </ol>
        <p className="mt-3 text-sm text-[var(--dim)]">Another easy method that works on phones: open the playing video in the preview → tap the <strong>three dots (⋮)</strong> on the video → <strong>Share</strong> → then <strong>Save</strong> at the end — the video goes straight to your gallery, with no watermark.</p>
        <p className="mt-3 text-sm text-[var(--dim)]">If a link doesn't work, the reason is usually that the video is still a draft/private, or the share link has expired — copy a fresh link from Jimeng and try again. Avatar (cast template) links also work, but they are usually only valid for 48 hours — copy one and paste it here right away.</p>
        <p className="mt-3 text-sm text-[var(--dim)]">To fetch several videos at once, open <strong>Bulk Download</strong> from the menu — paste one link per line and they will all be fetched one by one.</p>
      </SectionCard>
    </main>
  );
}

function FaqPage() {
  const faqs: { q: string; a: string }[] = [
    {
      q: "Is this downloader completely free?",
      a: "Yes — no login, no account and no fees. All you need is a public Jimeng share link.",
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
      <h1 className="text-3xl font-extrabold">FAQ — Common Questions</h1>
      <SectionCard>
        <div className="flex flex-col gap-5">
          {faqs.map((f) => (
            <div key={f.q}>
              <h2 className="text-base font-extrabold">{f.q}</h2>
              <p className="mt-1 text-base leading-relaxed text-[var(--dim)]">{f.a}</p>
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
      <h1 className="text-3xl font-extrabold">Sora Downloader</h1>
      <SectionCard>
        <p className="inline-block border border-[var(--border)] px-2.5 py-1 text-xs font-extrabold tracking-wide text-[var(--dim)] uppercase" style={{ borderRadius: 999 }}>
          Coming Soon
        </p>
        <p className="mt-3 text-base leading-relaxed">
          The Sora downloader is not available on this site yet. Sora is a separate platform and we don't currently have a verified, working downloader for it — so we won't add a fake or half-finished tool that takes your link and then fails.
        </p>
        <p className="mt-2 text-base leading-relaxed">
          When a real, tested method becomes available, the Sora Downloader will appear right here in this menu. Until then, use the main downloader for Jimeng videos — it's completely free and works with no watermark.
        </p>
        <button
          type="button"
          onClick={onGoHome}
          className="mt-4 bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)]"
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
    <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="border border-[var(--border)] px-3 py-1 text-xs font-bold text-[var(--dim)]" style={{ borderRadius: 8 }}>
      Remove
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
    mutationFn: async () => await api.saveApiKey({ apiKey: key.trim(), apiBaseUrl: base.trim() }),
    onSuccess: (r) => {
      setMsg(`Key saved (${r.hint}) — stored securely on the server.`);
      setKey("");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => setMsg(error.message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearApiKey({}),
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
    <SectionCard>
      <h2 className="text-lg font-extrabold">API Key <span className="text-sm font-semibold text-[var(--dim)]">(optional)</span></h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Jimeng has no official downloader API key — the downloader works without a key too. If you have your own API key and endpoint from a third-party resolver service, add them here; the video will then be fetched through that service first, and if it fails the built-in method will be used.
      </p>
      {settings?.hasApiKey ? (
        <p className="mt-3 text-sm font-bold text-[var(--accent)]">✓ API key is set ({settings.apiKeyHint}) — saved on the server</p>
      ) : (
        <p className="mt-3 text-sm text-[var(--dim)]">No key is set yet — the built-in downloader is running.</p>
      )}
      {settings?.apiBaseUrl && <p className="mt-1 break-all text-xs text-[var(--dim)]">Endpoint: {settings.apiBaseUrl}</p>}

      <label htmlFor="api-base" className="mt-4 block text-sm font-bold">API endpoint (base URL)</label>
      <div className="mt-1 flex gap-2">
        <input id="api-base" aria-label="API endpoint base URL" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://example-api.com/resolve" className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm" style={{ borderRadius: "var(--radius)" }} />
        <button type="button" onClick={() => pasteInto(setBase)} className="border border-[var(--border)] px-3 text-sm font-bold" style={{ borderRadius: "var(--radius)" }}>Paste</button>
      </div>
      <label htmlFor="api-key" className="mt-3 block text-sm font-bold">API key</label>
      <div className="mt-1 flex gap-2">
        <input id="api-key" aria-label="API key" type="password" autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value); if (keyError) setKeyError(null); }} placeholder="Paste your API key" className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm" style={{ borderRadius: "var(--radius)" }} />
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
      <p className="mt-2 text-xs text-[var(--dim)]">The key is saved only on this site's server — never send it in chat. The full key is never shown again — only a hint with the last 4 characters is displayed.</p>
    </SectionCard>
  );
}

function AdsSetup({ settings }: { settings: ApiResponse<typeof api, "getSettings"> | undefined }) {
  return (
    <SectionCard>
      <h2 className="text-xl font-extrabold">Ads Setup — Google AdSense</h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Once your AdSense is approved, paste each slot's code here and save it. The code is stored only on the server and the slot is marked “code saved” — the empty Ad Space boxes on the page are exactly where the ads will appear. No publisher ID is pre-filled here — only add your own code.
      </p>
      <div className="mt-4 flex flex-col gap-5">
        {AD_SLOTS.map((slot) => (
          <AdSlotEditor key={slot.key} slot={slot.key} label={slot.label} size={slot.size} saved={Boolean(settings?.adSlots[slot.key])} />
        ))}
      </div>
    </SectionCard>
  );
}

function AdSlotEditor({ slot, label, size, saved }: { slot: AdSlotKey; label: string; size: string; saved: boolean }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => await api.saveAdCode({ slot, code }),
    onSuccess: () => { setMsg("Code saved ✓"); setCode(""); queryClient.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (error) => setMsg(error.message),
  });
  const clear = useMutation({
    mutationFn: () => api.clearAdCode({ slot }),
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
    <div className="border border-[var(--border)] p-4" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-extrabold">{label} <span className="font-semibold text-[var(--dim)]">· {size}</span></p>
        {saved
          ? <span className="text-xs font-bold text-[var(--accent)]">✓ Code saved</span>
          : <span className="text-xs font-semibold text-[var(--dim)]">No code added</span>}
      </div>
      <label htmlFor={`ad-${slot}`} className="sr-only">{label} AdSense code</label>
      <textarea
        id={`ad-${slot}`}
        value={code}
        onChange={(e) => { setCode(e.target.value); if (codeError) setCodeError(null); }}
        placeholder="Paste your AdSense code here…"
        rows={3}
        className="mt-2 w-full border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs"
        style={{ borderRadius: "var(--radius)" }}
      />
      {codeError && <p className="mt-1.5 text-sm font-semibold text-[var(--err-text)]" role="alert">{codeError}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={save.isPending} onClick={handleSaveCode} className="bg-[var(--accent)] px-4 py-1.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
          {save.isPending ? "Saving…" : "Save code"}
        </button>
        {saved && (
          <button type="button" disabled={clear.isPending} onClick={() => clear.mutate()} className="border border-[var(--border)] px-4 py-1.5 text-sm font-bold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }}>
            Remove code
          </button>
        )}
      </div>
      {msg && <p className="mt-1.5 text-sm font-semibold text-[var(--accent)]">{msg}</p>}
    </div>
  );
}

function AboutPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <h1 className="text-3xl font-extrabold">About — Jimeng Video Downloader</h1>
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
    </main>
  );
}

function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5">
      <h1 className="text-3xl font-extrabold">Privacy Policy</h1>
      <SectionCard>
        <div className="space-y-4 text-base leading-relaxed">
          <div>
            <h2 className="font-extrabold">The link you paste</h2>
            <p className="mt-1">When you paste a Jimeng share link, our server fetches that public link from Jimeng and extracts the video's original file address. A history of successful downloads only (link, title, video address, time) is saved on this site's server so you can download again — you can clear this history at any time with one click. At download time the video file is first brought to our server and served to you from there, and the file may remain cached on the server to make repeat downloads easier.</p>
          </div>
          <div>
            <h2 className="font-extrabold">API key</h2>
            <p className="mt-1">If you add the optional API key, it is saved on this site's server and used only to fetch videos through the endpoint you provided. The full key is never shown on the page again — only a hint with the last 4 characters is displayed. You can delete the key at any time with “Remove key”.</p>
          </div>
          <div>
            <h2 className="font-extrabold">Contact form</h2>
            <p className="mt-1">The name, email and message sent through the Contact page are saved on this site's server so we can reply to you. This information is never sold to any third party.</p>
          </div>
          <div>
            <h2 className="font-extrabold">Advertising — Google AdSense</h2>
            <p className="mt-1">Google AdSense ads may be shown on this site. Google and its partners use cookies to show ads based on your visits to this and other sites. You can turn off personalised advertising in Google Ads Settings (adssettings.google.com), or opt out of third-party cookies at aboutads.info. The “Ad Space” boxes on the page are exactly where ads are served.</p>
          </div>
          <div>
            <h2 className="font-extrabold">Copyright</h2>
            <p className="mt-1">All video rights belong to their creators and ByteDance / Jimeng AI. Only download your own or authorised public videos, and only for personal use.</p>
          </div>
          <div>
            <h2 className="font-extrabold">Changes</h2>
            <p className="mt-1">This policy may be updated over time; any new changes will be posted on this page.</p>
          </div>
        </div>
      </SectionCard>
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
      <h1 className="text-3xl font-extrabold">Contact</h1>
      <SectionCard>
        <p className="text-base text-[var(--dim)]">Have a problem, question or suggestion? Send a message using the form below — the message is saved on this site's server and we will try to reply.</p>
        {done && <p className="mt-3 bg-[var(--surface-alt)] p-3 text-sm font-bold text-[var(--accent)]" style={{ borderRadius: "var(--radius)" }}>✓ Message received — thank you! We will reply soon.</p>}
        {err && <p className="mt-3 bg-[var(--err-bg)] p-3 text-sm font-semibold text-[var(--err-text)]" style={{ borderRadius: "var(--radius)" }} role="alert">{err}</p>}
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="contact-name" className="text-sm font-bold">Your name</label>
            <input id="contact-name" aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="contact-email" className="text-sm font-bold">Email</label>
            <input id="contact-email" aria-label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          <div>
            <label htmlFor="contact-message" className="text-sm font-bold">Message</label>
            <textarea id="contact-message" aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2" style={{ borderRadius: "var(--radius)" }} />
          </div>
          {formError && <p className="text-sm font-semibold text-[var(--err-text)]" role="alert">{formError}</p>}
          <button type="submit" disabled={mut.isPending} className="bg-[var(--accent)] px-5 py-2.5 font-extrabold text-[var(--accent-ink)] disabled:opacity-50" style={{ borderRadius: "var(--radius)" }}>
            {mut.isPending ? "Sending…" : "Send message"}
          </button>
        </form>
      </SectionCard>
    </main>
  );
}
