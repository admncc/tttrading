import type {
  AnalyticsResponse,
  BacktestResult,
  DashboardStats,
  Group,
  GroupInput,
  LogEntry,
  SecondOpinion,
  Signal,
  Trade,
  WsEvent,
} from "@tttrading/shared";

export type { SecondOpinion } from "@tttrading/shared";

export type CapTier = "large" | "mid" | "small";
export interface InsightTrade {
  symbol: string;
  tier: CapTier;
  channel: string;
  side: "long" | "short";
  net: number;
  at: string;
  openedAt: string;
}

export interface AccountInfo {
  connected: boolean;
  simulating: boolean;
  env: string;
  address: string | null;
  signer?: string | null;
  accountValue?: number;
  withdrawable?: number;
  totalMarginUsed?: number;
  spotUsdc?: number;
  positions: {
    symbol: string;
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
  }[];
  error?: string;
}

export interface HlVenue {
  name: string;
  enabled: boolean;
  live: boolean;
  privateKeyConfigured: boolean;
  keySource: string;
  accountAddress: string | null;
  signer: string | null;
}

export interface ExchangesConfig {
  env: string;
  priority: string[];
  hyperliquid: HlVenue;
  hyperliquidTestnet: HlVenue;
  aster: {
    name: "aster";
    enabled: boolean;
    live: boolean;
    user: string | null;
    signer: string | null;
    privateKeyConfigured: boolean;
    keySource: string;
    baseUrl: string;
  };
  mexc: {
    name: "mexc";
    enabled: boolean;
    live: boolean;
    apiKeyConfigured: boolean;
    apiSecretConfigured: boolean;
    keySource: string;
    baseUrl: string;
    note: string;
  };
}

export interface ExchangesPatch {
  priority?: string[];
  hyperliquid?: { enabled?: boolean; privateKey?: string; accountAddress?: string };
  hyperliquidTestnet?: { enabled?: boolean; privateKey?: string; accountAddress?: string };
  aster?: { enabled?: boolean; user?: string; signer?: string; privateKey?: string; baseUrl?: string };
  mexc?: { enabled?: boolean; apiKey?: string; apiSecret?: string; baseUrl?: string };
}

export interface TelegramHealth {
  configured: boolean;
  connected: boolean;
  startedAt: string | null;
  lastPollCycleAt: string | null;
  pollIntervalSec: number;
  groups: {
    groupId: string;
    name: string;
    channel: string;
    lastMessageAt?: string;
    lastPolledAt?: string;
    lastError?: string;
    recoveredCount: number;
  }[];
}

/* -------------------------------- auth -------------------------------- */

const TOKEN_KEY = "tt_token";
let token: string | null = localStorage.getItem(TOKEN_KEY);
let onAuthError: (() => void) | null = null;

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken(): string | null {
  return token;
}
export function setAuthErrorHandler(cb: () => void): void {
  onAuthError = cb;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  // Only declare a JSON body when we actually send one — otherwise Fastify
  // rejects the empty body (DELETE, no-body POSTs) with a 400.
  if (init?.body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    onAuthError?.();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

/** URL of a message's attached chart image (token in the query — <img> can't set headers). */
export function messageImageUrl(signalId: string): string {
  return `/api/messages/${signalId}/image${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export const api = {
  health: () =>
    req<{
      ok: boolean;
      env: string;
      activeNetwork: string;
      live: boolean;
      shadowMode: boolean;
      tradingPaused: boolean;
      authRequired: boolean;
      updateEnabled: boolean;
      exchanges: { name: string; live: boolean }[];
    }>("/api/health"),
  getSettings: () =>
    req<{
      shadowMode: boolean;
      tradingPaused: boolean;
      dailyLossLimitUsd: number;
      maxOpenTrades: number;
      maxExposureUsd: number;
      liveMaxOrderUsd: number;
      splitOpposingVenues: boolean;
      anthropicConfigured: boolean;
      anthropicKeySource: string;
      anthropicModel: string;
      autoRefine: boolean;
      parseMode: "regex" | "llm";
      llmMemory: string;
      diagnosticEnabled: boolean;
      diagnosticToken: string;
      alertsConfigured: boolean;
      alertOnSystem: boolean;
      alertOnTrades: boolean;
      alertOnClassify: boolean;
    }>("/api/settings"),
  updateSettings: (patch: {
    shadowMode?: boolean;
    tradingPaused?: boolean;
    dailyLossLimitUsd?: number;
    maxOpenTrades?: number;
    maxExposureUsd?: number;
    liveMaxOrderUsd?: number;
    splitOpposingVenues?: boolean;
    autoRefine?: boolean;
    parseMode?: "regex" | "llm";
    llmMemory?: string;
    diagnosticEnabled?: boolean;
    diagnosticRegenerateToken?: boolean;
    alertOnSystem?: boolean;
    alertOnTrades?: boolean;
    alertOnClassify?: boolean;
  }) =>
    req<{
      shadowMode: boolean;
      parseMode: "regex" | "llm";
      llmMemory: string;
      diagnosticEnabled: boolean;
      diagnosticToken: string;
    }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  killSwitch: () =>
    req<{ ok: boolean; closed: number; canceled: number }>("/api/kill", { method: "POST" }),
  readiness: () =>
    req<{
      env: string;
      accountValue?: number;
      ready: boolean;
      checks: { key: string; ok: boolean; label: string }[];
    }>("/api/readiness"),
  riskInsights: () =>
    req<{ generatedAt: string; totalClosed: number; trades: InsightTrade[] }>("/api/risk-insights"),
  rules: () =>
    req<{
      note: string;
      entry: { name: string; pattern: string; description: string }[];
      management: { name: string; kind: string; pattern: string; description: string }[];
    }>("/api/rules"),
  downloadBackup: () => downloadFile("/api/backup", "tttrading-backup.sqlite"),
  saveAnthropic: (anthropicKey: string | undefined, anthropicModel: string | undefined) =>
    req<{ anthropicConfigured: boolean; anthropicModel: string }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ anthropicKey, anthropicModel }),
    }),

  checkUpdate: () =>
    req<{ enabled: boolean; current?: string; behind?: number; commits?: string[]; error?: string }>(
      "/api/update/check",
    ),
  applyUpdate: () => req<{ ok: boolean; message: string }>("/api/update", { method: "POST" }),

  exportGroup: (id: string, name: string) => downloadFile(`/api/groups/${id}/export`, `${name}.txt`),
  exportAll: () => downloadFile("/api/export", "all-channels.txt"),

  backtest: (id: string, horizonDays = 14) =>
    req<BacktestResult>(`/api/groups/${id}/backtest`, {
      method: "POST",
      body: JSON.stringify({ horizonDays }),
    }),

  exchanges: () => req<ExchangesConfig>("/api/exchanges"),
  saveExchanges: (patch: ExchangesPatch) =>
    req<ExchangesConfig>("/api/exchanges", { method: "PUT", body: JSON.stringify(patch) }),
  setHlNetwork: (network: "mainnet" | "testnet") =>
    req<ExchangesConfig>("/api/exchanges/hl-network", {
      method: "POST",
      body: JSON.stringify({ network }),
    }),

  telegramHealth: () => req<TelegramHealth>("/api/telegram/health"),
  account: () => req<AccountInfo>("/api/account"),
  prices: () => req<Record<string, number>>("/api/prices"),
  sendReport: (period: "daily" | "weekly") =>
    req<{ ok: boolean; period: string }>(`/api/report/send?period=${period}`, { method: "POST" }),
  analytics: (opts: { from?: string; to?: string; includeShadow?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
    if (opts.includeShadow) p.set("includeShadow", "true");
    const qs = p.toString();
    return req<AnalyticsResponse>(`/api/analytics${qs ? `?${qs}` : ""}`);
  },
  testOrder: (
    symbol: string,
    side: "long" | "short",
    notionalUsd: number,
    leverage: number,
    exchange?: string,
  ) =>
    req<Trade>("/api/test-order", {
      method: "POST",
      body: JSON.stringify({ symbol, side, notionalUsd, leverage, ...(exchange ? { exchange } : {}) }),
    }),
  transferUsd: (amount: number, toPerp: boolean) =>
    req<{ ok: boolean }>("/api/account/transfer", {
      method: "POST",
      body: JSON.stringify({ amount, toPerp }),
    }),

  suggestInstructions: (id: string) =>
    req<{ instructions: string; rationale: string; sampleSize: number; error?: string }>(
      `/api/groups/${id}/suggest-instructions`,
      { method: "POST" },
    ),

  backfill: (days: number) =>
    req<{ groupId: string; groupName: string; imported: number; error?: string }[]>("/api/backfill", {
      method: "POST",
      body: JSON.stringify({ days }),
    }),
  login: (password: string) =>
    req<{ token: string | null; authRequired: boolean }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  groups: () => req<Group[]>("/api/groups"),
  createGroup: (g: GroupInput) => req<Group>("/api/groups", { method: "POST", body: JSON.stringify(g) }),
  updateGroup: (id: string, g: GroupInput) =>
    req<Group>(`/api/groups/${id}`, { method: "PUT", body: JSON.stringify(g) }),
  deleteGroup: (id: string) => req<{ ok: boolean }>(`/api/groups/${id}`, { method: "DELETE" }),

  signals: (limit = 200) => req<Signal[]>(`/api/signals?limit=${limit}`),
  pendingSignals: () => req<Signal[]>("/api/signals/pending"),
  confirmSignal: (id: string) => req<Signal>(`/api/signals/${id}/confirm`, { method: "POST" }),
  rejectSignal: (id: string) => req<Signal>(`/api/signals/${id}/reject`, { method: "POST" }),
  simulate: (groupId: string, text: string) =>
    req<Signal>("/api/signals/simulate", { method: "POST", body: JSON.stringify({ groupId, text }) }),

  trades: (limit = 500) => req<Trade[]>(`/api/trades?limit=${limit}`),
  closeTrade: (id: string, exitPrice?: number) =>
    req<Trade>(`/api/trades/${id}/close`, { method: "POST", body: JSON.stringify({ exitPrice }) }),
  setTradeStop: (id: string, price: number) =>
    req<Trade>(`/api/trades/${id}/stop`, { method: "POST", body: JSON.stringify({ price }) }),
  setTradeTakeProfits: (id: string, prices: number[]) =>
    req<Trade>(`/api/trades/${id}/take-profits`, { method: "POST", body: JSON.stringify({ prices }) }),
  bookPartial: (id: string, fraction: number) =>
    req<Trade>(`/api/trades/${id}/partial`, { method: "POST", body: JSON.stringify({ fraction }) }),
  archiveTrade: (id: string, archived: boolean) =>
    req<Trade>(`/api/trades/${id}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  syncTrade: (id: string) =>
    req<{ ok: boolean; changed?: boolean; live?: boolean; venue?: string; note?: string; trade?: Trade }>(
      `/api/trades/${id}/sync`,
      { method: "POST" },
    ),

  secondOpinions: (limit = 500) => req<SecondOpinion[]>(`/api/second-opinions?limit=${limit}`),

  stats: () => req<DashboardStats>("/api/stats"),

  logs: (limit = 300, category?: string) =>
    req<LogEntry[]>(`/api/logs?limit=${limit}${category ? `&category=${category}` : ""}`),
  clearLogs: () => req<{ ok: boolean }>("/api/logs", { method: "DELETE" }),
};

/** Fetch a file with auth and trigger a browser download. */
async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    setToken(null);
    onAuthError?.();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const cd = res.headers.get("Content-Disposition") ?? "";
  const name = cd.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Open a WebSocket to the desk API and invoke handler on each event.
 * `onReconnect` fires each time the socket (re)opens so the caller can
 * re-sync state that may have changed while the socket was down.
 */
export function openWs(onEvent: (e: WsEvent) => void, onReconnect?: () => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
    ws.onopen = () => onReconnect?.();
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as WsEvent);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 2000);
    };
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
