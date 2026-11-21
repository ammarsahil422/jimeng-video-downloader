// Jimeng resolver — ported verbatim (logic-wise) from the Hatch-hosted
// version's server/src/actions.ts. No SDK: pure fetch + string parsing.
//
// WATERMARK (verified live 2026-11-16 by extracting frames from both files
// for two different published items): Jimeng's two item endpoints return
// DIFFERENT files for the same item.
// - POST /mweb/v1/get_item_info {"published_item_id": id} returns the
//   DISPLAY encode: origin_video.logo_type "display_watermark_ending", the
//   "AI生成" badge burned into the top-left, the "即梦 @user" watermark
//   burned into the bottom corner, and a ~4.4s Jimeng ending card appended
//   (14.49s file for a 10.04s video). The lr= URL param changes nothing —
//   the CDN serves byte-identical output for every lr value.
// - POST /mweb/v1/mget_item_info {"item_id_list": [id]} returns the TRUE
//   origin master (data.effect_item_list[0]): logo_type "", frames with no
//   badge and no watermark, exact duration, higher bitrate, plus clean
//   360p/480p/720p/"origin" transcodes on the vlabvod CDN.
// So mget_item_info is the PRIMARY endpoint and get_item_info is only a
// fallback; mediaFromItem additionally classifies every candidate by its
// logo_type so a watermarked display file is never labelled "No Watermark".

export const ALLOWED_HOSTS = new Set([
  "jimeng.jianying.com",
  "m.jimeng.jianying.com",
  "jimeng.cn",
  "www.jimeng.cn",
  "dreamina.jianying.com",
  "dreamina.capcut.com",
  "www.dreamina.capcut.com",
]);

export const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export type VideoOption = {
  url: string;
  label: string;
  kind: "origin" | "standard";
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
};
export type ImageOption = { url: string };

export type ResolveOk = {
  ok: true;
  sourceUrl: string;
  title: string;
  coverUrl: string | null;
  videos: VideoOption[];
  images: ImageOption[];
  usedCustomApi: boolean;
  note: string | null;
};
export type ResolveErr = {
  ok: false;
  sourceUrl: string;
  error: string;
  usedCustomApi: boolean;
  note: string | null;
};

/**
 * Extracts candidate URLs from pasted share text. Jimeng share messages are
 * mostly Chinese text around one URL, and the URL itself is often wrapped
 * across lines by the app / chat — including inside the `?t=` token, e.g.
 * `?t=8011 BA53 36` must be rejoined to `?t=8011BA5336`. So whitespace is
 * removed before matching (Chinese characters are not URL characters, so the
 * match still stops exactly at the end of the link).
 */
export function extractCandidateUrls(text: string): string[] {
  const compact = text.replace(/\s+/g, "");
  const matches = compact.match(
    /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi,
  );
  if (!matches) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const u = raw.replace(/[),.;]+$/, "");
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

function unescapeUrl(u: string): string {
  return u
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&")
    .replace(/\\u003d/gi, "=");
}

function metaContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
    "i",
  );
  const m = html.match(re) ?? html.match(re2);
  return m?.[1] ? unescapeUrl(m[1]) : null;
}

function qualityLabel(url: string, isOrigin: boolean): string {
  const res = url.match(/(2160|1440|1080|720|540|480|360)p?/i)?.[1] ?? null;
  const base = res ? `${res}p` : "Original quality";
  return isOrigin ? `${base} · Origin (No Watermark)` : base;
}

function collectMedia(html: string): {
  videos: VideoOption[];
  images: ImageOption[];
} {
  const videoUrls = new Set<string>();
  const mp4Re = /https?:\/\/[^"'\\\s<>]+?\.mp4(?:\?[^"'\\\s<>]*)?/gi;
  for (const m of html.matchAll(mp4Re)) {
    const u = m[0];
    if (u) videoUrls.add(unescapeUrl(u));
  }
  // JSON fields that commonly carry the play/download URL
  const fieldRe =
    /"(?:origin_video|video_url|play_url|playUrl|download_url|main_url|url)"\s*:\s*"(https?:[^"]+?\.mp4[^"]*)"/gi;
  for (const m of html.matchAll(fieldRe)) {
    const u = m[1];
    if (u) videoUrls.add(unescapeUrl(u));
  }

  const videos: VideoOption[] = [...videoUrls].map((url) => {
    const isOrigin = /origin/i.test(url) || !/watermark/i.test(url);
    return {
      url,
      kind: isOrigin ? ("origin" as const) : ("standard" as const),
      label: qualityLabel(url, isOrigin),
      width: null,
      height: null,
      sizeBytes: null,
    };
  });
  // Origin / higher resolution first
  videos.sort((a, b) => {
    const score = (v: VideoOption) =>
      (v.kind === "origin" ? 1000 : 0) +
      (Number(v.label.match(/(\d+)p/)?.[1] ?? 0) || 0);
    return score(b) - score(a);
  });

  const imageUrls = new Set<string>();
  const imgFieldRe =
    /"(?:image_url|cover_url|cover|poster|thumbnail|display_url)"\s*:\s*"(https?:[^"]+?\.(?:jpe?g|png|webp)[^"]*)"/gi;
  for (const m of html.matchAll(imgFieldRe)) {
    const u = m[1];
    if (u) imageUrls.add(unescapeUrl(u));
  }
  const images: ImageOption[] = [...imageUrls]
    .filter((u) => !/favicon|logo|icon/i.test(u))
    .slice(0, 12)
    .map((url) => ({ url }));

  return { videos: videos.slice(0, 6), images };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strField(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function numField(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Item IDs worth asking the mweb API about, most trustworthy first. */
function extractItemIds(finalUrl: string, html: string): string[] {
  const ids: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && /^\d{10,22}$/.test(v) && !ids.includes(v)) ids.push(v);
  };
  try {
    const u = new URL(finalUrl);
    for (const k of [
      "id",
      "published_item_id",
      "item_id",
      "itemId",
      "work_id",
      "workId",
    ]) {
      push(u.searchParams.get(k));
    }
  } catch {
    /* not a URL — skip */
  }
  const patterns = [
    /[?&](?:id|published_item_id|item_id)=(\d{10,22})(?=[&#"']|$)/g,
    /"(?:published_item_id|item_id)"\s*:\s*"?(\d{10,22})"?/g,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) push(m[1]);
  }
  return ids.slice(0, 3);
}

async function postItemApi(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const headers = {
    "User-Agent": BROWSER_UA,
    "Content-Type": "application/json",
    Accept: "application/json",
    Referer: "https://jimeng.jianying.com/",
  };
  // One retry: a single transient timeout must not silently drop the
  // request to the watermarked display endpoint (observed live 2026-11-17:
  // mget timed out once right after a sandbox restart and the resolver fell
  // back to get_item_info's display file for that resolve).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        { method: "POST", headers, body: JSON.stringify(body) },
        15000,
      );
      return asRecord(await res.json().catch(() => null));
    } catch {
      /* retry once, then give up */
    }
  }
  return null;
}

async function fetchItemInfo(
  id: string,
): Promise<Record<string, unknown> | null> {
  // Batch endpoint FIRST: it returns the clean origin master (see the
  // watermark note above). get_item_info's display encode is the fallback.
  const batch = await postItemApi(
    "https://jimeng.jianying.com/mweb/v1/mget_item_info",
    { item_id_list: [id] },
  );
  const data = asRecord(batch?.data);
  if (data) {
    for (const key of ["effect_item_list", "item_list", "items"]) {
      const arr = data[key];
      if (Array.isArray(arr)) {
        const first = asRecord(arr[0]);
        if (first) return first;
      }
    }
    if (data.common_attr || data.video || data.image) return data;
  }
  const single = await postItemApi(
    "https://jimeng.jianying.com/mweb/v1/get_item_info",
    { published_item_id: id },
  );
  if (single && String(single.ret) === "0") {
    const item = asRecord(single.data);
    if (item) return item;
  }
  return null;
}

/** Builds preview media from one mweb item object (get_item_info shape). */
function mediaFromItem(item: Record<string, unknown>): {
  title: string;
  coverUrl: string | null;
  videos: VideoOption[];
  images: ImageOption[];
} {
  const common = asRecord(item.common_attr);
  const video = asRecord(item.video);
  const title = (
    strField(common?.title) ??
    strField(common?.description) ??
    ""
  )
    .replace(/\s+/g, " ")
    .slice(0, 200);
  const coverUrl = strField(video?.cover_url) ?? strField(common?.cover_url);

  // Rank every candidate file. A candidate is WATERMARKED when Jimeng marks
  // it with a logo_type (e.g. "display_watermark_ending" — the display
  // encode from get_item_info, with the AI生成 badge + 即梦 @user mark burned
  // in) or its URL carries that lr= marker; candidates with an empty
  // logo_type (everything mget_item_info returns) are the clean masters.
  // Clean files always sort first and only they may be labelled
  // "No Watermark"; watermarked display files sort last, labelled honestly.
  type Candidate = VideoOption & { rank: number; heightKey: number };
  const candidates: Candidate[] = [];
  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  const pushCandidate = (
    url: string | null,
    label: string,
    kind: VideoOption["kind"],
    rank: number,
    md5: string | null,
    rec: Record<string, unknown> | null,
  ) => {
    if (!url || seenUrls.has(url)) return;
    const key = md5 ?? url;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    seenUrls.add(url);
    const height = numField(rec?.height);
    candidates.push({
      url,
      label,
      kind,
      rank,
      heightKey: height ?? 0,
      width: numField(rec?.width),
      height,
      sizeBytes: numField(rec?.size),
    });
  };
  const isWatermarked = (
    rec: Record<string, unknown> | null,
    url: string | null,
  ): boolean => {
    const logo = strField(rec?.logo_type);
    if (logo) return true;
    return !!url && /display_watermark|watermark/i.test(url);
  };
  const defLabel = (
    defKey: string,
    rec: Record<string, unknown> | null,
  ): string => {
    if (defKey === "origin") {
      const def = strField(rec?.definition);
      return def && !/^origin$/i.test(def) ? `Original ${def}` : "Original";
    }
    return /p$/i.test(defKey) ? defKey : `${defKey}p`;
  };

  const origin = asRecord(video?.origin_video);
  const originUrl = strField(origin?.video_url);
  if (originUrl) {
    const wm = isWatermarked(origin, originUrl);
    const def = strField(origin?.definition) ?? "Original";
    pushCandidate(
      originUrl,
      wm
        ? `${def} · File with watermark (Jimeng display)`
        : `${def} · Origin (No Watermark)`,
      wm ? "standard" : "origin",
      // Clean origin_video is the default: same frame as the bigger master
      // transcode but ~half the bytes, so the server-side download prep
      // finishes much faster on a phone connection.
      wm ? 3 : 0,
      strField(origin?.md5),
      origin,
    );
  }
  const transcoded = asRecord(video?.transcoded_video);
  if (transcoded) {
    for (const [defKey, val] of Object.entries(transcoded)) {
      const rec = asRecord(val);
      const url = strField(rec?.video_url);
      if (!url) continue;
      const wm = isWatermarked(rec, url);
      const base = defLabel(defKey, rec);
      if (wm) {
        pushCandidate(
          url,
          `${base} · File with watermark (Jimeng display)`,
          "standard",
          3,
          strField(rec?.md5),
          rec,
        );
      } else if (defKey === "origin") {
        // The batch endpoint's "origin" transcode is the highest-bitrate
        // clean master — same frame as origin_video at ~2x the bytes, so it
        // is offered right after it rather than as the default.
        pushCandidate(
          url,
          `${base} · Origin (No Watermark)`,
          "origin",
          1,
          strField(rec?.md5),
          rec,
        );
      } else {
        pushCandidate(
          url,
          `${base} · No Watermark`,
          "origin",
          2,
          strField(rec?.md5),
          rec,
        );
      }
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || b.heightKey - a.heightKey);
  const videos: VideoOption[] = candidates.map(
    ({ rank: _rank, heightKey: _h, ...v }) => v,
  );

  // Sweep the raw item JSON for any other MP4 the structured fields missed.
  const jsonText = JSON.stringify(item);
  for (const extra of collectMedia(jsonText).videos) {
    if (seenUrls.has(extra.url)) continue;
    seenUrls.add(extra.url);
    const wm = /display_watermark|watermark/i.test(extra.url);
    videos.push(
      wm
        ? {
            ...extra,
            kind: "standard",
            label:
              extra.label.replace(/ · Origin \(No Watermark\)$/, "") +
              " · File with watermark (Jimeng display)",
          }
        : extra,
    );
  }

  const imageUrls = new Set<string>();
  if (coverUrl) imageUrls.add(coverUrl);
  for (const img of collectMedia(jsonText).images) imageUrls.add(img.url);
  const anyImgRe =
    /https?:\/\/[^"'\\\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'\\\s<>]*)?/gi;
  for (const m of jsonText.matchAll(anyImgRe)) {
    const u = m[0] ? unescapeUrl(m[0]) : "";
    // Skip avatar art and the cover_url_map resize variants of the cover
    // (the plain cover is already included) so the grid stays meaningful.
    if (u && !/avatar|faceu|logo|favicon|icon|-resize:/i.test(u))
      imageUrls.add(u);
  }
  const images: ImageOption[] = [...imageUrls]
    .slice(0, 12)
    .map((url) => ({ url }));

  return { title, coverUrl, videos, images };
}

async function resolveViaCustomApi(
  base: string,
  key: string,
  shareUrl: string,
): Promise<{
  videos: VideoOption[];
  images: ImageOption[];
  title: string;
  coverUrl: string | null;
} | null> {
  const sep = base.includes("?") ? "&" : "?";
  const res = await fetchWithTimeout(
    `${base}${sep}url=${encodeURIComponent(shareUrl)}`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Api-Key": key,
        Accept: "application/json",
        "User-Agent": BROWSER_UA,
      },
    },
  );
  if (!res.ok) return null;
  const data: unknown = await res.json().catch(() => null);
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const inner =
    rec.data && typeof rec.data === "object"
      ? (rec.data as Record<string, unknown>)
      : rec;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = inner[k] ?? rec[k];
      if (typeof v === "string" && v.startsWith("http")) return v;
    }
    return null;
  };
  const single = pick("video_url", "url", "download_url", "videoUrl");
  const videos: VideoOption[] = [];
  if (Array.isArray(inner.videos)) {
    for (const v of inner.videos) {
      if (typeof v === "string" && v.includes(".mp4"))
        videos.push({
          url: v,
          label: qualityLabel(v, true),
          kind: "origin",
          width: null,
          height: null,
          sizeBytes: null,
        });
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.url === "string")
          videos.push({
            url: o.url,
            label:
              typeof o.quality === "string"
                ? o.quality
                : qualityLabel(o.url, true),
            kind: "origin",
            width: null,
            height: null,
            sizeBytes: null,
          });
      }
    }
  }
  if (videos.length === 0 && single)
    videos.push({
      url: single,
      label: qualityLabel(single, true),
      kind: "origin",
      width: null,
      height: null,
      sizeBytes: null,
    });
  if (videos.length === 0) return null;
  const images: ImageOption[] = [];
  if (Array.isArray(inner.images)) {
    for (const v of inner.images) {
      if (typeof v === "string") images.push({ url: v });
    }
  }
  return {
    videos,
    images,
    title: typeof inner.title === "string" ? inner.title : "",
    coverUrl: pick("cover_url", "cover", "thumbnail"),
  };
}

type AttemptOutcome =
  | { kind: "ok"; result: ResolveOk }
  | { kind: "notfound" }
  | { kind: "blocked"; status: number }
  | { kind: "nomedia"; pageTitle: string }
  | { kind: "network" };

const BROWSER_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://jimeng.jianying.com/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

/** URL variants worth trying for one share link, most faithful first. */
function shareUrlVariants(shareUrl: string): string[] {
  const variants: string[] = [shareUrl];
  try {
    const u = new URL(shareUrl);
    const host = u.hostname.toLowerCase();
    const swap = (h: string) => {
      const c = new URL(shareUrl);
      c.hostname = h;
      return c.toString();
    };
    if (host === "jimeng.jianying.com")
      variants.push(swap("m.jimeng.jianying.com"));
    if (host === "m.jimeng.jianying.com")
      variants.push(swap("jimeng.jianying.com"));
    if (u.search) {
      const bare = new URL(shareUrl);
      bare.search = "";
      variants.push(bare.toString());
    }
  } catch {
    /* keep the single original URL */
  }
  return [...new Set(variants)];
}

async function attemptResolve(url: string): Promise<AttemptOutcome> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: BROWSER_HEADERS, redirect: "follow" },
      25000,
    );
  } catch {
    return { kind: "network" };
  }

  const body = await res.text().catch(() => "");
  const trimmed = body.trim();

  // Jimeng returns HTTP 200 + {"message":"404 not found"} for codes its
  // short-link service does not recognise (expired / incompletely copied).
  if (trimmed.startsWith("{") && /404|not found/i.test(trimmed)) {
    return { kind: "notfound" };
  }
  // Bot-protection / verification walls: say so instead of "no video".
  // The captcha text check only applies to SMALL pages — Jimeng's normal
  // share landing page is a large app shell that merely loads a captcha SDK.
  if (
    res.status === 403 ||
    res.status === 412 ||
    res.status === 429 ||
    (body.length < 10000 &&
      /captcha|verify you are human|访问验证|滑动验证|安全验证/i.test(body))
  ) {
    return { kind: "blocked", status: res.status };
  }

  // Primary path: the share link redirects to a JS landing page whose URL
  // carries the item id; the page's own data API returns the origin video.
  const finalUrl = res.url || url;
  for (const id of extractItemIds(finalUrl, body)) {
    const item = await fetchItemInfo(id);
    if (!item) continue;
    const media = mediaFromItem(item);
    if (media.videos.length > 0 || media.images.length > 0) {
      const topIsWatermarked = media.videos[0]?.kind === "standard";
      return {
        kind: "ok",
        result: {
          ok: true,
          sourceUrl: url,
          title: media.title,
          coverUrl: media.coverUrl,
          videos: media.videos,
          images: media.images,
          usedCustomApi: false,
          note: topIsWatermarked
            ? "Note: The clean (no-watermark) master file for this video was not available from Jimeng — the file that was found does contain Jimeng's watermark, so it is clearly labelled “File with watermark” in the quality list."
            : null,
        },
      };
    }
  }

  const title =
    metaContent(body, "og:title") ??
    body.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ??
    "";
  const coverUrl = metaContent(body, "og:image");
  const ogVideo =
    metaContent(body, "og:video") ?? metaContent(body, "og:video:url");
  const { videos, images } = collectMedia(body);
  if (ogVideo && !videos.some((v) => v.url === ogVideo)) {
    videos.unshift({
      url: ogVideo,
      label: qualityLabel(ogVideo, true),
      kind: "origin",
      width: null,
      height: null,
      sizeBytes: null,
    });
  }
  if (coverUrl && !images.some((i) => i.url === coverUrl)) {
    images.unshift({ url: coverUrl });
  }

  if (videos.length === 0) {
    return { kind: "nomedia", pageTitle: title.replace(/\s+/g, " ").slice(0, 120) };
  }

  return {
    kind: "ok",
    result: {
      ok: true,
      sourceUrl: url,
      title: title.replace(/\s+/g, " ").slice(0, 200),
      coverUrl,
      videos,
      images: images.slice(0, 12),
      usedCustomApi: false,
      note: null,
    },
  };
}

export async function resolveBuiltIn(
  shareUrl: string,
): Promise<ResolveOk | ResolveErr> {
  const variants = shareUrlVariants(shareUrl);
  let sawNotFound = false;
  let sawNoMedia: string | null = null;
  let blockedStatus: number | null = null;

  for (const variant of variants) {
    // One retry per variant for transient network failures.
    let outcome = await attemptResolve(variant);
    if (outcome.kind === "network") outcome = await attemptResolve(variant);
    if (outcome.kind === "ok") return outcome.result;
    if (outcome.kind === "notfound") sawNotFound = true;
    else if (outcome.kind === "blocked") blockedStatus = outcome.status;
    else if (outcome.kind === "nomedia" && sawNoMedia === null)
      sawNoMedia = outcome.pageTitle;
  }

  // Report exactly what failed, most specific cause first.
  if (blockedStatus !== null) {
    return {
      ok: false,
      sourceUrl: shareUrl,
      error: `Jimeng blocked our server's request (HTTP ${blockedStatus} — bot protection / verification wall). That's why the video for this link could not be fetched. Please try again in a while.`,
      usedCustomApi: false,
      note: null,
    };
  }
  if (sawNoMedia !== null) {
    return {
      ok: false,
      sourceUrl: shareUrl,
      error:
        "The link opened on Jimeng and Jimeng's data API was also tried, but no video file was found for this item — it may be an image-only post, the video may not be Published (Public) yet, or the link may belong to an avatar/template feature whose video is not public. Copy the share link of a published video from the Jimeng app and try again.",
      usedCustomApi: false,
      note: null,
    };
  }
  if (sawNotFound) {
    return {
      ok: false,
      sourceUrl: shareUrl,
      error:
        "Jimeng did not recognise this link's code (404) — the link has expired, or the code was copied incompletely. Open the video in the Jimeng app, tap Share, copy the FULL share text again and paste it here (paste it together with the Chinese text — the link will be extracted automatically).",
      usedCustomApi: false,
      note: null,
    };
  }
  return {
    ok: false,
    sourceUrl: shareUrl,
    error:
      "Could not connect to Jimeng — our server's request did not reach Jimeng (network block / timeout), despite trying several ways. Please try again in a while.",
    usedCustomApi: false,
    note: null,
  };
}

// Douyin resolver
//
// Verified live end-to-end 2026-11-21 (test video v.douyin.com/uMHo9UvlQFM/
// → ID 7645140600261463348, a 212s food video; the full chain below —
// ttwid mint, share page, _ROUTER_DATA parse, playwm→play swap, ratio
// probes — returned real no-watermark MP4 tiers from the zjcdn CDN).
// The chain, exactly as verified:
//  1. Video ID: follow the v.douyin.com short link's 302 to
//     iesdouyin.com/share/video/<id>/, or parse douyin.com/video/<id>
//     directly.
//  2. Mint an anonymous ttwid cookie: POST
//     ttwid.bytedance.com/ttwid/union/register/ with the EXACT JSON body
//     below and an iOS User-Agent. (The old iesdouyin iteminfo API is
//     dead — HTTP 200 with a 0-byte body — and is NOT used.)
//  3. Fetch iesdouyin.com/share/video/<id>/ with the ttwid cookie and
//     parse window._ROUTER_DATA, depth-first searching for the item
//     whose video.play_addr carries the play URL.
//  4. No watermark: swap playwm → play in the play URL.
//  5. Quality tiers: probe the ratio ladder (720p, 1080p, 480p, 360p)
//     with 2-byte ranged GETs + Referer and dedupe by the Content-Range
//     total size — some ratios collapse to one tier (480p and 360p
//     returned the 1080p file's size in testing), so only tiers with a
//     distinct size are offered. Nothing is invented: a tier exists only
//     because Douyin's own CDN confirmed its size.
// Without a ttwid the share page is an anti-bot shell (no play_addr), so
// the ttwid is rotated and the fetch retried once when a shell comes
// back; transient network failures also get one retry. One ttwid is
// cached and reused across resolves (including a whole Bulk batch).
// ---------------------------------------------------------------------------

export const DOUYIN_HOSTS = new Set([
  "v.douyin.com",
  "www.douyin.com",
  "douyin.com",
  "www.iesdouyin.com",
  "iesdouyin.com",
]);

export const DOUYIN_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";

const DOUYIN_RATIO_LADDER = ["720p", "1080p", "480p", "360p"] as const;

let douyinTtwidCache: { value: string; mintedAt: number } | null = null;
const DOUYIN_TTWID_TTL_MS = 30 * 60 * 1000;

async function mintDouyinTtwid(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      "https://ttwid.bytedance.com/ttwid/union/register/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": DOUYIN_UA },
        body: JSON.stringify({
          region: "cn",
          aid: 1768,
          needFid: false,
          service: "www.ixigua.com",
          migrate_info: { ticket: "", source: "node" },
          cbUrlProtocol: "https",
          union: true,
        }),
      },
      15000,
    );
    const cookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    for (const c of cookies) {
      const m = c.match(/ttwid=([^;]+)/);
      if (m?.[1]) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function getDouyinTtwid(forceFresh: boolean): Promise<string | null> {
  if (
    !forceFresh &&
    douyinTtwidCache &&
    Date.now() - douyinTtwidCache.mintedAt < DOUYIN_TTWID_TTL_MS
  ) {
    return douyinTtwidCache.value;
  }
  const fresh = await mintDouyinTtwid();
  if (fresh) douyinTtwidCache = { value: fresh, mintedAt: Date.now() };
  return fresh;
}

function douyinIdFromUrl(url: string): string | null {
  const m = url.match(/\/(?:share\/)?video\/(\d{10,22})/);
  return m?.[1] ?? null;
}

/** The video ID for a Douyin share link: parsed directly from
 *  douyin.com/video/<id> links, otherwise read off the short link's
 *  redirect target (v.douyin.com → iesdouyin.com/share/video/<id>/). */
async function resolveDouyinVideoId(shareUrl: string): Promise<string | null> {
  const direct = douyinIdFromUrl(shareUrl);
  if (direct) return direct;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        shareUrl,
        { headers: { "User-Agent": DOUYIN_UA }, redirect: "follow" },
        20000,
      );
      const fromFinal = douyinIdFromUrl(res.url || "");
      if (fromFinal) return fromFinal;
      const body = await res.text().catch(() => "");
      const inBody = body.match(/share\/video\/(\d{10,22})/);
      if (inBody?.[1]) return inBody[1];
      return null;
    } catch {
      /* one retry on transient network failure */
    }
  }
  return null;
}

/** Extracts the JSON object assigned to window._ROUTER_DATA by
 *  bracket-matching from the first "{" after the assignment (the object
 *  contains nested braces and escaped quotes, so a regex won't do). */
function extractRouterData(html: string): unknown | null {
  const marker = "window._ROUTER_DATA";
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf("{", idx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === undefined) break;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Depth-first search for the item object whose video.play_addr carries
 *  a url_list — the shape the share page's own JS reads. */
function findDouyinItem(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const rec = node as Record<string, unknown>;
  const video = asRecord(rec.video);
  const playAddr = asRecord(video?.play_addr);
  if (playAddr && Array.isArray(playAddr.url_list)) return rec;
  for (const v of Object.values(rec)) {
    const found = findDouyinItem(v);
    if (found) return found;
  }
  return null;
}

async function fetchDouyinSharePage(
  videoId: string,
  ttwid: string,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://www.iesdouyin.com/share/video/${videoId}/`,
      {
        headers: {
          "User-Agent": DOUYIN_UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
          Cookie: `ttwid=${ttwid}`,
        },
      },
      25000,
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Total file size for one play URL, from a 2-byte ranged GET: the
 *  Content-Range total after the 302 to the CDN. Null when the CDN does
 *  not confirm a size (that ratio is then not offered as a tier). */
async function probeDouyinTierSize(playUrl: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        playUrl,
        {
          headers: {
            "User-Agent": DOUYIN_UA,
            Referer: "https://www.iesdouyin.com/",
            Range: "bytes=0-1",
          },
          redirect: "follow",
        },
        20000,
      );
      const contentRange = res.headers.get("content-range");
      const contentType = res.headers.get("content-type") ?? "";
      try {
        await res.body?.cancel();
      } catch {
        /* headers are all we needed */
      }
      if (!contentType.includes("video")) return null;
      const m = contentRange?.match(/\/(\d+)\s*$/);
      if (m?.[1]) return Number(m[1]);
      // A 200 answer to a ranged request means the CDN ignored the
      // range and is sending the whole file — its Content-Length is
      // the total size.
      const len = Number(res.headers.get("content-length") ?? 0);
      if (res.status === 200 && len > 0) return len;
      return null;
    } catch {
      /* one retry on transient network failure */
    }
  }
  return null;
}

/** The quality tiers for one Douyin item: the ratio ladder probed
 *  against Douyin's CDN and deduped by total size. 720p sorts first
 *  (the default — Douyin files are big: 1080p can be ~98 MB), the rest
 *  follow by height. When no probe confirms a size, the single URL
 *  Douyin itself returned is offered as-is rather than inventing tiers. */
async function buildDouyinVideos(
  item: Record<string, unknown>,
): Promise<VideoOption[]> {
  const video = asRecord(item.video);
  const playAddr = asRecord(video?.play_addr);
  const urlList = Array.isArray(playAddr?.url_list) ? playAddr.url_list : [];
  const rawPlay = strField(urlList[0]);
  if (!rawPlay) return [];
  const basePlay = rawPlay.replace("playwm", "play");
  const srcW = numField(video?.width);
  const srcH = numField(video?.height);

  const tiers: { ratio: string; url: string; sizeBytes: number }[] = [];
  const seenSizes = new Set<number>();
  for (const ratio of DOUYIN_RATIO_LADDER) {
    let u: URL;
    try {
      u = new URL(basePlay);
    } catch {
      break;
    }
    u.searchParams.set("ratio", ratio);
    const size = await probeDouyinTierSize(u.toString());
    if (size === null || size <= 0) continue;
    if (seenSizes.has(size)) continue; // collapsed tier — same file
    seenSizes.add(size);
    tiers.push({ ratio, url: u.toString(), sizeBytes: size });
  }

  if (tiers.length === 0) {
    let ratioParam: string | null = null;
    try {
      ratioParam = new URL(basePlay).searchParams.get("ratio");
    } catch {
      ratioParam = null;
    }
    return [
      {
        url: basePlay,
        label: ratioParam
          ? `${ratioParam} · No Watermark`
          : "Original quality · No Watermark",
        kind: "origin",
        width: srcW,
        height: srcH,
        sizeBytes: null,
      },
    ];
  }

  const heightOf = (ratio: string) => Number(ratio.replace(/p$/i, "")) || 0;
  tiers.sort((a, b) => {
    if (a.ratio === "720p") return -1;
    if (b.ratio === "720p") return 1;
    return heightOf(b.ratio) - heightOf(a.ratio);
  });
  return tiers.map((t) => {
    const h = heightOf(t.ratio);
    return {
      url: t.url,
      label: `${t.ratio} · No Watermark`,
      kind: "origin" as const,
      width:
        srcW && srcH && h > 0 ? Math.round((srcW * h) / srcH) : null,
      height: h > 0 ? h : null,
      sizeBytes: t.sizeBytes,
    };
  });
}

export async function resolveDouyinBuiltIn(
  shareUrl: string,
): Promise<ResolveOk | ResolveErr> {
  const videoId = await resolveDouyinVideoId(shareUrl);
  if (!videoId) {
    return {
      ok: false,
      sourceUrl: shareUrl,
      error:
        "The video ID could not be found in this Douyin link — the link may have expired or been copied incompletely. Open the video in the Douyin app, tap Share, copy the full share link again and paste it here.",
      usedCustomApi: false,
      note: null,
    };
  }

  let item: Record<string, unknown> | null = null;
  let sawShell = false;
  let ttwid = await getDouyinTtwid(false);
  for (let attempt = 0; attempt < 2 && !item; attempt++) {
    if (!ttwid) break;
    const html = await fetchDouyinSharePage(videoId, ttwid);
    if (html) {
      const data = extractRouterData(html);
      const found = data ? findDouyinItem(data) : null;
      if (found) {
        item = found;
        break;
      }
      // Anti-bot shell (no play_addr): rotate the ttwid and retry once.
      sawShell = true;
      ttwid = await getDouyinTtwid(true);
    }
  }

  if (!item) {
    if (!ttwid) {
      return {
        ok: false,
        sourceUrl: shareUrl,
        error:
          "Could not connect to Douyin — the anonymous session Douyin requires could not be created from our server. Please try again in a while.",
        usedCustomApi: false,
        note: null,
      };
    }
    return {
      ok: false,
      sourceUrl: shareUrl,
      error: sawShell
        ? "Douyin returned an anti-bot page instead of the video data, even after a retry with a fresh session. Please try again in a while."
        : "No video was found for this Douyin link — it may be private, deleted, or not a video post. Copy the share link of a public Douyin video and try again.",
      usedCustomApi: false,
      note: null,
    };
  }

  const video = asRecord(item.video);
  const author = asRecord(item.author);
  const desc = (strField(item.desc) ?? "").replace(/\s+/g, " ").slice(0, 200);
  const nickname = strField(author?.nickname);
  const title = desc || (nickname ? `Douyin video by ${nickname}` : "Douyin video");
  const firstUrl = (rec: Record<string, unknown> | null): string | null =>
    strField(Array.isArray(rec?.url_list) ? rec.url_list[0] : null);
  const coverUrl =
    firstUrl(asRecord(video?.cover)) ??
    firstUrl(asRecord(video?.origin_cover)) ??
    firstUrl(asRecord(video?.dynamic_cover));

  const videos = await buildDouyinVideos(item);
  if (videos.length === 0) {
    return {
      ok: false,
      sourceUrl: shareUrl,
      error:
        "Douyin returned this video's page but no playable video file — it may be an image post or a restricted video. Copy the share link of a public Douyin video and try again.",
      usedCustomApi: false,
      note: null,
    };
  }

  return {
    ok: true,
    sourceUrl: shareUrl,
    title,
    coverUrl,
    videos,
    images: [],
    usedCustomApi: false,
    note: null,
  };
}

export { fetchWithTimeout, resolveViaCustomApi };

