// Standalone typed RPC client. Posts {action, args} to ./actions and
// returns the typed response — the same wire protocol the Hatch-hosted
// version used, now served by this package's own Bun server (server.ts).
// No SDK, no host page: plain fetch.

export type ApiResponse<T, K extends keyof T> = T[K] extends (
  args: never,
) => Promise<infer R>
  ? R
  : never;

export type ApiRequest<T, K extends keyof T> = T[K] extends (
  args: infer A,
) => unknown
  ? A
  : never;

export type VideoOption = {
  url: string;
  label: string;
  kind: "origin" | "standard";
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
};

export type ResolveResult = {
  ok: boolean;
  sourceUrl: string;
  title: string;
  coverUrl: string | null;
  videos: VideoOption[];
  images: { url: string }[];
  usedCustomApi: boolean;
  note: string | null;
  error: string | null;
};

export type AdSlots = {
  head: boolean;
  top: boolean;
  incontent: boolean;
  sidebar: boolean;
  bottom: boolean;
};

export type SettingsResult = {
  apiKeyHint: string | null;
  hasApiKey: boolean;
  apiBaseUrl: string | null;
  adSlots: AdSlots;
};

export type HistoryItem = {
  id: number;
  sourceUrl: string;
  title: string;
  videoUrl: string;
  coverUrl: string | null;
  createdAt: string;
};

/** Action signatures — these must match server/handlers.ts exactly. */
export interface Actions {
  resolveLink: (args: { text: string }) => Promise<ResolveResult>;
  prepareDownload: (args: { url: string }) => Promise<{
    ok: boolean;
    downloadUrl: string | null;
    sizeBytes: number;
    error: string | null;
  }>;
  getSettings: (args: Record<string, never>) => Promise<SettingsResult>;
  saveApiKey: (args: {
    apiKey: string;
    apiBaseUrl: string;
  }) => Promise<{ ok: true; hint: string }>;
  clearApiKey: (args: Record<string, never>) => Promise<{ ok: true }>;
  saveAdCode: (args: {
    slot: "head" | "top" | "incontent" | "sidebar" | "bottom";
    code: string;
  }) => Promise<{ ok: true }>;
  clearAdCode: (args: {
    slot: "head" | "top" | "incontent" | "sidebar" | "bottom";
  }) => Promise<{ ok: true }>;
  listHistory: (args: { limit?: number }) => Promise<{ items: HistoryItem[] }>;
  deleteHistoryItem: (args: { id: number }) => Promise<{ ok: true }>;
  clearHistory: (args: Record<string, never>) => Promise<{ ok: true }>;
  submitContact: (args: {
    name: string;
    email: string;
    message: string;
  }) => Promise<{ ok: true }>;
}

function resolveEndpoint(): string {
  const href = globalThis.location?.href;
  if (typeof href !== "string" || href.length === 0) return "./actions";
  const base = new URL(href);
  base.hash = "";
  base.search = "";
  return new URL("./actions", base).toString();
}

function createActionClient(): Actions {
  const endpoint = resolveEndpoint();
  return new Proxy({} as Actions, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "then" || name === "catch" || name === "finally")
        return undefined;
      return async (args: Record<string, unknown>) => {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: name, args: args ?? {} }),
        });
        const body = (await res.json().catch(() => null)) as {
          data?: unknown;
          error?: unknown;
        } | null;
        if (!res.ok || (body && body.error)) {
          throw new Error(
            `action ${name} error: ${String(body?.error ?? res.status)}`,
          );
        }
        return body?.data;
      };
    },
  });
}

export const api = createActionClient();
