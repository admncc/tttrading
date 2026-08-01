import type { WsEvent } from "@tttrading/shared";

/** Minimal shape we need from a WebSocket connection. */
export interface SocketLike {
  send(data: string): void;
  readyState: number;
}

const OPEN = 1;
const clients = new Set<SocketLike>();

export function register(ws: SocketLike): void {
  clients.add(ws);
}

export function unregister(ws: SocketLike): void {
  clients.delete(ws);
}

export function clientCount(): number {
  return clients.size;
}

/** Fan out an event to every connected desk client. */
export function broadcast(event: WsEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    try {
      if (ws.readyState === OPEN) ws.send(data);
    } catch {
      clients.delete(ws);
    }
  }
}
