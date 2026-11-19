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

export type AdminUser = {
  id: number;
  name: string;
  email: string;
  role: string;
};

export type AdminStatsResult = {
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
};

/** Action signatures — these must match server/handlers.ts exactly. */
export type AuthUser = {
  id: number;
  name: string;
  email: string;
  role: string;
};

export type UserPlan = {
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
};

export type PlanRow = {
  id: number;
  name: string;
  priceCents: number;
  durationDays: number;
  downloadLimit: number;
  description: string;
};

export interface Actions {
  resolveLink: (args: {
    text: string;
    token?: string;
    anonId?: string;
  }) => Promise<ResolveResult>;
  prepareDownload: (args: {
    url: string;
    token?: string;
    anonId?: string;
  }) => Promise<{
    ok: boolean;
    downloadUrl: string | null;
    sizeBytes: number;
    error: string | null;
    limitReached: boolean;
  }>;
  getSettings: (args: { token?: string }) => Promise<SettingsResult>;
  saveApiKey: (args: {
    apiKey: string;
    apiBaseUrl: string;
    token?: string;
  }) => Promise<{ ok: true; hint: string }>;
  clearApiKey: (args: { token?: string }) => Promise<{ ok: true }>;
  saveAdCode: (args: {
    slot: "head" | "top" | "incontent" | "sidebar" | "bottom";
    code: string;
    token?: string;
  }) => Promise<{ ok: true }>;
  clearAdCode: (args: {
    slot: "head" | "top" | "incontent" | "sidebar" | "bottom";
    token?: string;
  }) => Promise<{ ok: true }>;
  listHistory: (args: {
    limit?: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ items: HistoryItem[] }>;
  deleteHistoryItem: (args: { id: number }) => Promise<{ ok: true }>;
  clearHistory: (args: Record<string, never>) => Promise<{ ok: true }>;
  submitContact: (args: {
    name: string;
    email: string;
    message: string;
  }) => Promise<{ ok: true }>;
  adminLogin: (args: {
    email: string;
    password: string;
  }) => Promise<{
    ok: boolean;
    token: string | null;
    error: string | null;
    admin: AdminUser | null;
  }>;
  adminLogout: (args: { token?: string }) => Promise<{ ok: true }>;
  adminMe: (args: { token?: string }) => Promise<{
    ok: boolean;
    admin: AdminUser | null;
  }>;
  adminStats: (args: { token?: string }) => Promise<AdminStatsResult>;
  adminChangePassword: (args: {
    currentPassword: string;
    newPassword: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  register: (args: {
    name: string;
    email: string;
    password: string;
  }) => Promise<{
    ok: boolean;
    token: string | null;
    error: string | null;
    user: AuthUser | null;
  }>;
  userLogin: (args: {
    email: string;
    password: string;
  }) => Promise<{
    ok: boolean;
    token: string | null;
    error: string | null;
    user: AuthUser | null;
  }>;
  me: (args: { token?: string }) => Promise<{
    ok: boolean;
    user: AuthUser | null;
    plan: UserPlan | null;
    downloadsToday: number;
    downloadsTotal: number;
    freeDailyLimit: number;
    freeRemaining: number;
  }>;
  logout: (args: { token?: string }) => Promise<{ ok: true }>;
  myRequests: (args: { token?: string }) => Promise<{
    requests: {
      id: number;
      planId: number;
      planName: string;
      priceCents: number;
      status: string;
      createdAt: string;
    }[];
  }>;
  listPlans: (args: Record<string, never>) => Promise<{ plans: PlanRow[] }>;
  listAdminPlans: (args: { token?: string }) => Promise<{
    plans: (PlanRow & { active: boolean; createdAt: string })[];
  }>;
  createPlan: (args: {
    name: string;
    priceCents: number;
    durationDays: number;
    downloadLimit: number;
    description?: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null; id: number | null }>;
  updatePlan: (args: {
    id: number;
    name?: string;
    priceCents?: number;
    durationDays?: number;
    downloadLimit?: number;
    description?: string;
    active?: boolean;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  createPurchaseRequest: (args: {
    planId: number;
    token?: string;
  }) => Promise<{
    ok: boolean;
    error: string | null;
    request: {
      id: number;
      planName: string;
      priceCents: number;
      status: string;
    } | null;
    duplicate: boolean;
  }>;
  listPurchaseRequests: (args: { token?: string }) => Promise<{
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
  }>;
  listPayments: (args: { token?: string }) => Promise<{
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
  }>;
  recordPayment: (args: {
    userId: number;
    planId?: number;
    amountCents: number;
    method: string;
    note?: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null; id: number | null }>;
  markPaid: (args: {
    requestId: number;
    amountCents?: number;
    method?: string;
    note?: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  activatePlan: (args: {
    requestId: number;
    durationDays?: number;
    downloadLimit?: number;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  assignPlan: (args: {
    userId: number;
    planId: number;
    durationDays?: number;
    downloadLimit?: number;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  listCustomers: (args: { token?: string }) => Promise<{
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
  }>;
  setUserStatus: (args: {
    userId: number;
    status: "active" | "disabled";
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  deleteUser: (args: {
    userId: number;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  getAdminSettings: (args: { token?: string }) => Promise<{
    freeDailyLimit: number;
    adminEmail: string;
  }>;
  saveAdminSettings: (args: {
    freeDailyLimit: number;
    token?: string;
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
