import type {
  AnalyticsResponse,
  BacktestResult,
  DashboardStats,
  Group,
  GroupInput,
  LogEntry,
  Signal,
  Trade,
  WsEvent,
} from "@tttrading/shared";

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

export const api = {
  health: () =>
    req<{
      ok: boolean;
      env: string;
      live: boolean;
      shadowMode: boolean;
      authRequired: boolean;
      updateEnabled: boolean;
    }>("/api/health"),
  getSettings: () =>
    req<{
      shadowMode: boolean;
      anthropicConfigured: boolean;
      anthropicKeySource: string;
      anthropicModel: string;
    }>("/api/settings"),
  updateSettings: (shadowMode: boolean) =>
    req<{ shadowMode: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ shadowMode }),
    }),
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

  telegramHealth: () => req<TelegramHealth>("/api/telegram/health"),
  account: () => req<AccountInfo>("/api/account"),
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
  testOrder: (symbol: string, side: "long" | "short", notionalUsd: number, leverage: number) =>
    req<Trade>("/api/test-order", {
      method: "POST",
      body: JSON.stringify({ symbol, side, notionalUsd, leverage }),
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
