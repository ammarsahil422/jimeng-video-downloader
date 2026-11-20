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
  downloadId: number | null;
};

export type FavoriteItem = {
  id: number;
  downloadId: number;
  title: string;
  coverUrl: string | null;
  videoUrl: string;
  qualityLabel: string;
  sourceUrl: string;
  createdAt: string;
};

export type NotificationItem = {
  id: number;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
};

export type HelpArticleItem = {
  id: number;
  title: string;
  body: string;
  category: string;
  createdAt: string;
};

export type TicketCategory =
  | "billing"
  | "download"
  | "account"
  | "problem"
  | "other";

export type TicketItem = {
  id: number;
  subject: string;
  category: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketMessageItem = {
  id: number;
  authorRole: string;
  message: string;
  createdAt: string;
};

export type AdminTicketItem = TicketItem & {
  customerName: string;
  customerEmail: string;
};

// Phase 4 — system logs, broadcasts, reports, security overview.

export type SystemLogItem = {
  id: number;
  actorType: string;
  actorEmail: string | null;
  action: string;
  detail: string;
  createdAt: string;
};

export type BroadcastItem = {
  id: number;
  title: string;
  message: string;
  recipientCount: number;
  createdAt: string;
};

export type ReportsResult = {
  ok: boolean;
  error: string | null;
  days: {
    date: string;
    downloads: number;
    revenueCents: number;
    signups: number;
  }[];
  totals: {
    downloads: number;
    revenueCents: number;
    signups: number;
    plansSold: number;
    mbUsed: number;
  };
  topCustomers: {
    userId: number;
    name: string;
    email: string;
    downloads: number;
    mb: number;
  }[];
};

export type SecurityOverview = {
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
};

export type DownloadQualityPref = "best" | "original" | "720p" | "480p" | "360p";
export type DownloadModePref = "single" | "bulk";
export type ThemePref = "dark" | "light";
export type LangPref = "en" | "ur";

export type AdSlots = {
  head: boolean;
  top: boolean;
  incontent: boolean;
  sidebar: boolean;
  bottom: boolean;
  socialbar: boolean;
  mobile: boolean;
};

export type AdCodes = {
  head: string | null;
  top: string | null;
  incontent: string | null;
  sidebar: string | null;
  bottom: string | null;
  socialbar: string | null;
  mobile: string | null;
};

export type SettingsResult = {
  apiKeyHint: string | null;
  hasApiKey: boolean;
  apiBaseUrl: string | null;
  adSlots: AdSlots;
  adCodes: AdCodes;
  smartLink: { url: string | null; enabled: boolean };
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
    slot: "head" | "top" | "incontent" | "sidebar" | "bottom" | "socialbar" | "mobile";
    code: string;
    token?: string;
  }) => Promise<{ ok: true }>;
  clearAdCode: (args: {
    slot: "head" | "top" | "incontent" | "sidebar" | "bottom" | "socialbar" | "mobile";
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
    totpCode?: string;
  }) => Promise<{
    ok: boolean;
    token: string | null;
    error: string | null;
    admin: AdminUser | null;
    totpRequired: boolean;
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
  login: (args: {
    email: string;
    password: string;
    totpCode?: string;
  }) => Promise<{
    ok: boolean;
    role: "admin" | "customer" | null;
    token: string | null;
    error: string | null;
    admin: AdminUser | null;
    user: AuthUser | null;
    totpRequired: boolean;
  }>;
  me: (args: { token?: string }) => Promise<{
    ok: boolean;
    user: AuthUser | null;
    plan: UserPlan | null;
    downloadsToday: number;
    downloadsTotal: number;
    freeDailyLimit: number;
    freeRemaining: number;
    joinedAt: string | null;
  }>;
  toggleFavorite: (args: {
    downloadId: number;
    label?: string;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: boolean; favorited: boolean; error: string | null }>;
  listFavorites: (args: {
    limit?: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ items: FavoriteItem[] }>;
  removeFavorite: (args: {
    id: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: true }>;
  updateProfileName: (args: {
    name: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  changeUserPassword: (args: {
    currentPassword: string;
    newPassword: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  getDownloadSettings: (args: { token?: string }) => Promise<{
    defaultQuality: DownloadQualityPref;
    defaultMode: DownloadModePref;
    theme: ThemePref;
    language: LangPref;
  }>;
  saveDownloadSettings: (args: {
    defaultQuality: DownloadQualityPref;
    defaultMode: DownloadModePref;
    theme?: ThemePref;
    language?: LangPref;
    token?: string;
  }) => Promise<{ ok: true }>;
  getSiteSeo: (args: Record<string, never>) => Promise<{
    title: string;
    description: string;
    keywords: string;
  }>;
  getSeoSettings: (args: { token?: string }) => Promise<{
    title: string;
    description: string;
    keywords: string;
  }>;
  saveSeoSettings: (args: {
    title: string;
    description: string;
    keywords?: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  saveSmartLink: (args: {
    url: string;
    enabled: boolean;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  clearSmartLink: (args: { token?: string }) => Promise<{ ok: true }>;
  listNotifications: (args: {
    limit?: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ items: NotificationItem[]; unreadCount: number }>;
  markNotificationRead: (args: {
    id: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: true }>;
  markAllNotificationsRead: (args: {
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: true }>;
  deleteNotification: (args: {
    id: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: true }>;
  listHelpArticles: (args: Record<string, never>) => Promise<{
    articles: HelpArticleItem[];
  }>;
  createHelpArticle: (args: {
    title: string;
    category: string;
    body: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null; id: number | null }>;
  updateHelpArticle: (args: {
    id: number;
    title?: string;
    category?: string;
    body?: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  deleteHelpArticle: (args: {
    id: number;
    token?: string;
  }) => Promise<{ ok: true }>;
  createTicket: (args: {
    subject: string;
    category: TicketCategory;
    message: string;
    link?: string;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: boolean; error: string | null; ticketId: number | null }>;
  listMyTickets: (args: {
    token?: string;
    anonId?: string;
  }) => Promise<{ tickets: TicketItem[] }>;
  getTicket: (args: {
    id: number;
    token?: string;
    anonId?: string;
  }) => Promise<{
    ticket: TicketItem | null;
    messages: TicketMessageItem[];
  }>;
  replyTicket: (args: {
    id: number;
    message: string;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  closeTicket: (args: {
    id: number;
    token?: string;
    anonId?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  listAllTickets: (args: { token?: string }) => Promise<{
    tickets: AdminTicketItem[];
  }>;
  getAdminTicket: (args: {
    id: number;
    token?: string;
  }) => Promise<{
    ticket: AdminTicketItem | null;
    messages: TicketMessageItem[];
  }>;
  replyTicketAdmin: (args: {
    id: number;
    message: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  setTicketStatus: (args: {
    id: number;
    status: "open" | "closed";
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  // Phase 4 — System Logs, Backup & Restore, Reports, Security, Broadcasts.
  listSystemLogs: (args: {
    action?: string;
    search?: string;
    limit?: number;
    offset?: number;
    token?: string;
  }) => Promise<{
    logs: SystemLogItem[];
    total: number;
    actions: string[];
  }>;
  exportBackup: (args: { token?: string }) => Promise<{
    ok: boolean;
    error: string | null;
    filename: string;
    json: string;
  }>;
  restoreBackup: (args: {
    json: string;
    token?: string;
  }) => Promise<{
    ok: boolean;
    error: string | null;
    restored: {
      users: number;
      plans: number;
      downloads: number;
      payments: number;
      tickets: number;
    } | null;
  }>;
  getReports: (args: {
    from: string;
    to: string;
    token?: string;
  }) => Promise<ReportsResult>;
  createBroadcast: (args: {
    title: string;
    message: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null; recipientCount: number }>;
  listBroadcasts: (args: { token?: string }) => Promise<{
    broadcasts: BroadcastItem[];
  }>;
  getSecurityOverview: (args: { token?: string }) => Promise<SecurityOverview>;
  revokeSession: (args: {
    tokenPrefix: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  startTotpSetup: (args: { token?: string }) => Promise<{
    ok: boolean;
    error: string | null;
    secret: string | null;
    otpauthUrl: string | null;
  }>;
  confirmTotpSetup: (args: {
    code: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  disableTotp: (args: {
    password: string;
    code: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
  resetCustomerPassword: (args: {
    userId: number;
    newPassword: string;
    token?: string;
  }) => Promise<{ ok: boolean; error: string | null }>;
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
