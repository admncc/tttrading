import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import type { Group } from "@tttrading/shared";
import { config, telegramReady } from "../config.js";
import { log } from "../logger.js";
import { groups as groupsRepo } from "../db/repositories.js";
import { handleIncoming } from "../execution/engine.js";

let client: TelegramClient | null = null;

/** The connected Telegram client, or null when the listener isn't running. */
export function getTelegramClient(): TelegramClient | null {
  return client;
}

export function normalizeChannel(channel: string): string {
  return channel
    .replace(/^@/, "")
    .replace(/^https:\/\/t\.me\//, "")
    .replace(/^-100/, "") // collapse Telegram's marked channel id to the bare id
    .toLowerCase();
}

/** Find the group whose configured channel matches this message's chat. */
async function matchGroup(event: NewMessageEvent): Promise<Group | undefined> {
  const all = groupsRepo.list();
  try {
    const chat = await event.getChat();
    const username = (chat as { username?: string })?.username?.toLowerCase();
    const chatId = String((chat as { id?: unknown })?.id ?? event.chatId ?? "");
    return all.find((g) => {
      const norm = normalizeChannel(g.telegramChannel);
      return norm === username || norm === chatId || g.telegramChannel === chatId;
    });
  } catch {
    return undefined;
  }
}

async function onMessage(event: NewMessageEvent): Promise<void> {
  const text = event.message?.text;
  if (!text) return;
  const group = await matchGroup(event);
  if (!group) return; // message from a channel we don't track
  try {
    await handleIncoming(group, text);
  } catch (err) {
    log.error("Failed to handle Telegram message:", err instanceof Error ? err.message : err);
  }
}

/** Connect to Telegram and start listening. No-op when creds are missing. */
export async function startTelegram(): Promise<void> {
  if (!telegramReady()) {
    log.warn(
      "Telegram not configured (TG_API_ID / TG_API_HASH / TG_SESSION). " +
        "Listener disabled — use the desk's manual signal input to test.",
    );
    return;
  }

  const session = new StringSession(config.telegram.session);
  client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  const me = await client.getMe();
  const name = (me as { username?: string; firstName?: string })?.username ??
    (me as { firstName?: string })?.firstName ?? "unknown";
  log.info(`Telegram connected as ${name}.`);

  client.addEventHandler((e) => void onMessage(e), new NewMessage({}));

  const channels = groupsRepo.list().map((g) => g.telegramChannel);
  log.info(`Listening for signals in: ${channels.join(", ") || "(no groups yet)"}`);
}

export async function stopTelegram(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
  }
}
