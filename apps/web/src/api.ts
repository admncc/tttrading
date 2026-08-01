import type {
  DashboardStats,
  Group,
  GroupInput,
  Signal,
  Trade,
  WsEvent,
} from "@tttrading/shared";

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
    req<{ ok: boolean; env: string; live: boolean; authRequired: boolean }>("/api/health"),
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
};

/** Open a WebSocket to the desk API and invoke handler on each event. */
export function openWs(onEvent: (e: WsEvent) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
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
