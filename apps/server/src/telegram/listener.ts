import { TelegramClient, type Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import type { Group } from "@tttrading/shared";
import { config, telegramReady } from "../config.js";
import { log, event as logEvent } from "../logger.js";
import { groups as groupsRepo, settings as settingsRepo, messageImages as messageImagesRepo } from "../db/repositories.js";
import { handleIncoming } from "../execution/engine.js";
import { llmReady, type SignalImage } from "../signals/llm.js";

let client: TelegramClient | null = null;

/** True if the message carries a photo (cheap sync check, no download). */
function hasPhoto(msg: Api.Message | undefined): boolean {
  if (!msg) return false;
  const m = msg as unknown as { photo?: unknown; media?: { className?: string } };
  return !!m.photo || m.media?.className === "MessageMediaPhoto";
}

/** True if the message carries a PDF document attachment. */
function hasPdf(msg: Api.Message | undefined): boolean {
  if (!msg) return false;
  const doc = (msg as unknown as { media?: { document?: { mimeType?: string; attributes?: { fileName?: string }[] } } })
    .media?.document;
  if (!doc) return false;
  if ((doc.mimeType ?? "").toLowerCase() === "application/pdf") return true;
  return (doc.attributes ?? []).some((a) => typeof a?.fileName === "string" && a.fileName.toLowerCase().endsWith(".pdf"));
}

/** True if the message has any attachment we handle (photo or PDF). */
function hasAttachment(msg: Api.Message | undefined): boolean {
  return hasPhoto(msg) || hasPdf(msg);
}

/**
 * Download a message's chart photo. Downloaded for BOTH storage (shown in the
 * Messages tab) and LLM vision; the vision gate is applied separately at the
 * call site. Skips oversized images to bound cost/storage.
 */
async function extractImage(msg: Api.Message | undefined): Promise<SignalImage | undefined> {
  if (!msg || !client || !hasAttachment(msg)) return undefined;
  const pdf = !hasPhoto(msg) && hasPdf(msg);
  const cap = pdf ? 12_000_000 : 4_000_000; // PDFs run larger than chart snaps
  // Reject on the DECLARED size before downloading, so an untrusted channel
  // can't make us pull a 500 MB "document" into memory just to discard it.
  const declared = Number(
    (msg as unknown as { media?: { document?: { size?: number | bigint } } }).media?.document?.size ?? 0,
  );
  if (declared > cap) {
    log.warn(`Attachment declared ${declared} bytes (> ${cap}) — skipping without download.`);
    return undefined;
  }
  try {
    const buf = await client.downloadMedia(msg, {});
    if (!buf || !Buffer.isBuffer(buf)) return undefined;
    if (buf.length > cap) {
      log.warn(`Attachment too large (${buf.length} bytes) — skipping.`);
      return undefined;
    }
    return { dataBase64: buf.toString("base64"), mediaType: pdf ? "application/pdf" : "image/jpeg" };
  } catch (err) {
    log.warn("Attachment download failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** The image to hand the LLM for vision (only when vision is enabled + a key). */
function visionImage(image: SignalImage | undefined): SignalImage | undefined {
  return image && config.anthropic.vision && llmReady() ? image : undefined;
}

/** Persist a downloaded chart image against its signal record (for Messages). */
function storeImage(signalId: string | undefined, image: SignalImage | undefined): void {
  if (!signalId || !image) return;
  try {
    messageImagesRepo.save(signalId, image.mediaType, Buffer.from(image.dataBase64, "base64"));
  } catch (err) {
    log.warn("Failed to store chart image:", err instanceof Error ? err.message : err);
  }
}
let pollTimer: ReturnType<typeof setInterval> | undefined;

/* ------------------------------- health -------------------------------- */

interface GroupHealth {
  lastMessageAt?: string; // last message actually processed (live or poll)
  lastPolledAt?: string; // last successful poll sweep of this channel
  lastError?: string;
  recoveredCount: number; // messages recovered by the catch-up poller
}
const groupHealth = new Map<string, GroupHealth>();
let startedAt: string | null = null;
let lastPollCycleAt: string | null = null;

function gh(groupId: string): GroupHealth {
  let h = groupHealth.get(groupId);
  if (!h) {
    h = { recoveredCount: 0 };
    groupHealth.set(groupId, h);
  }
  return h;
}

export interface ListenerHealth {
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

/** Operational snapshot of the Telegram listener for the desk. */
export function getListenerHealth(): ListenerHealth {
  return {
    configured: telegramReady(),
    connected: !!client?.connected,
    startedAt,
    lastPollCycleAt,
    pollIntervalSec: Math.round(POLL_INTERVAL_MS / 1000),
    groups: groupsRepo.list().map((g) => {
      const h = groupHealth.get(g.id);
      return {
        groupId: g.id,
        name: g.name,
        channel: g.telegramChannel,
        lastMessageAt: h?.lastMessageAt,
        lastPolledAt: h?.lastPolledAt,
        lastError: h?.lastError,
        recoveredCount: h?.recoveredCount ?? 0,
      };
    }),
  };
}

/** How often the catch-up poller sweeps each channel for missed messages. */
const POLL_INTERVAL_MS = 30_000;
/** How many recent messages to fetch per channel per poll / prime. */
const POLL_LIMIT = 30;
/** Max messages to page back per group per cycle when covering a gap. */
const MAX_CATCHUP = 200;

/* ----------------------- adjacent-message merging ---------------------- */
// Channels sometimes send the chart as a SEPARATE message right before/after the
// text (or as a Telegram album). Each on its own loses information — the TP
// levels are only drawn on the chart. We merge such neighbours into ONE signal.

/** Max seconds between two neighbours for them to belong to the same signal. */
const MERGE_WINDOW_S = 90;
/** Live debounce: wait this long after a message for a straggler chart/text. */
const MERGE_DEBOUNCE_MS = 5000;

interface MergeItem {
  id: number;
  text: string;
  msg: Api.Message;
  date: number; // unix seconds
  groupedId?: string; // Telegram album id (same id = one album)
}
interface Bundle {
  items: MergeItem[];
  texts: string[];
}

function toMergeItem(msg: Api.Message, text: string): MergeItem {
  const id = (msg as { id?: number }).id ?? 0;
  const date = Number((msg as { date?: number }).date ?? 0) || Math.floor(Date.now() / 1000);
  const gid = (msg as unknown as { groupedId?: unknown }).groupedId;
  return { id, text, msg, date, groupedId: gid != null ? String(gid) : undefined };
}

/** Whether `it` belongs to the bundle we're currently building. */
function canMerge(b: Bundle, it: MergeItem): boolean {
  const prev = b.items[b.items.length - 1]!;
  // Same Telegram album always merges.
  if (it.groupedId && prev.groupedId && it.groupedId === prev.groupedId) return true;
  // Otherwise require time-adjacency…
  if (Math.abs(it.date - prev.date) > MERGE_WINDOW_S) return false;
  // …and only ABSORB an attachment-only neighbour into a text (or a text into a
  // run of images). Never fuse two text-bearing messages — those are two signals.
  const bundleHasText = b.texts.length > 0;
  const itemHasText = !!it.text.trim();
  if (bundleHasText && itemHasText) return false;
  return true;
}

/** Group an ordered message list into merge bundles (one signal each). */
function mergeBundles(items: MergeItem[]): Bundle[] {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const bundles: Bundle[] = [];
  for (const it of sorted) {
    const last = bundles[bundles.length - 1];
    if (last && canMerge(last, it)) {
      last.items.push(it);
      if (it.text.trim()) last.texts.push(it.text);
    } else {
      bundles.push({ items: [it], texts: it.text.trim() ? [it.text] : [] });
    }
  }
  return bundles;
}

/** Process one merged bundle as a single signal (combined text + primary chart). */
async function processBundle(group: Group, bundle: Bundle): Promise<void> {
  const text = bundle.texts.join("\n\n").trim();
  // Primary attachment for vision + display: prefer a photo (chart) over a PDF.
  const imgItem =
    bundle.items.find((i) => hasPhoto(i.msg)) ?? bundle.items.find((i) => hasAttachment(i.msg));
  try {
    if (bundle.items.length > 1) {
      logEvent(
        "message",
        `Merged ${bundle.items.length} adjacent messages from ${group.name} into one signal`,
        { ids: bundle.items.map((i) => i.id), hasImage: !!imgItem },
        { groupId: group.id },
      );
    }
    const image = imgItem ? await extractImage(imgItem.msg) : undefined;
    const sig = await handleIncoming(group, text, visionImage(image));
    storeImage(sig?.id, image);
    gh(group.id).lastMessageAt = new Date().toISOString();
  } catch (err) {
    // Keep the claims (at-most-once): handleIncoming may already have placed a
    // real order before throwing, so retrying could DOUBLE a live position.
    log.error("Failed to handle Telegram bundle:", err instanceof Error ? err.message : err);
  }
}

// Live-path debounce buffer: hold a channel's just-arrived messages briefly so a
// chart sent immediately before/after the text lands in the same bundle.
interface Pending {
  group: Group;
  items: MergeItem[];
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();

function bufferLive(group: Group, it: MergeItem): void {
  const p = pending.get(group.id);
  if (p) {
    p.group = group;
    p.items.push(it);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => void flushLive(group.id), MERGE_DEBOUNCE_MS);
    return;
  }
  pending.set(group.id, {
    group,
    items: [it],
    timer: setTimeout(() => void flushLive(group.id), MERGE_DEBOUNCE_MS),
  });
}

async function flushLive(groupId: string): Promise<void> {
  const p = pending.get(groupId);
  if (!p) return;
  pending.delete(groupId);
  // Claim each id NOW (at-most-once): a message the catch-up poller already
  // grabbed during the debounce window fails its claim and is dropped here, so it
  // is never double-processed; anything we didn't reach before a restart stays
  // unclaimed and the poller recovers it.
  const claimed = p.items.filter(
    (it) => it.id === 0 || settingsRepo.claimTelegramMessage(p.group.id, it.id),
  );
  if (claimed.length === 0) return;
  for (const bundle of mergeBundles(claimed)) {
    await processBundle(p.group, bundle);
  }
}

/** Resolved-entity cache so we don't call getDialogs() every poll. Keyed by the
 *  channel STRING so editing a group's channel naturally uses a fresh entry. */
const entityCache = new Map<string, unknown>();
let polling = false;
let pollStartedAt = 0;

async function resolveEntityCached(tg: TelegramClient, g: { id: string; telegramChannel: string }): Promise<unknown> {
  const cached = entityCache.get(g.telegramChannel);
  if (cached) return cached;
  const entity = await resolveEntity(tg, g.telegramChannel);
  entityCache.set(g.telegramChannel, entity);
  return entity;
}

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

/**
 * Resolve a group's channel string to a Telegram entity. Public channels
 * resolve by @handle; private channels are found by numeric id in the account's
 * dialog list (a bare id is otherwise misread as a PeerUser).
 */
export async function resolveEntity(
  tg: TelegramClient,
  channel: string,
): Promise<unknown> {
  const norm = normalizeChannel(channel);
  if (!/^\d+$/.test(norm)) return tg.getEntity(channel);

  const dialogs = await tg.getDialogs({});
  for (const d of dialogs) {
    const e = d.entity as { id?: unknown } | undefined;
    if (e && String(e.id) === norm) return e;
  }
  // Fallback: try the -100-marked channel id form.
  return tg.getEntity(Number(`-100${norm}`));
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
  const text = event.message?.text ?? "";
  const attach = hasAttachment(event.message);
  if (!text && !attach) return; // nothing actionable
  const group = await matchGroup(event);
  if (!group) return; // message from a channel we don't track
  // Buffer briefly so a chart sent separately (immediately before/after the text,
  // or as an album) merges into the same signal. We DON'T claim the id here — the
  // claim happens at flush time (see flushLive), so a restart during the debounce
  // leaves the message UNclaimed for the poller to recover instead of stranding a
  // claimed-but-unprocessed message. A message the poller grabs during the window
  // simply fails the flush-time claim and is skipped (no double-processing).
  bufferLive(group, toMergeItem(event.message as Api.Message, text));
}

/**
 * Seed each group's "seen" set with the current latest message ids WITHOUT
 * processing them, so the poller only ever acts on messages that arrive AFTER
 * startup (pre-startup history is imported via backfill, not executed).
 */
async function primeGroups(tg: TelegramClient): Promise<void> {
  for (const g of groupsRepo.list()) {
    try {
      const entity = await resolveEntity(tg, g.telegramChannel);
      const messages = await tg.getMessages(entity as Parameters<typeof tg.getMessages>[0], {
        limit: POLL_LIMIT,
      });
      for (const m of messages as Api.Message[]) {
        const id = (m as { id?: number }).id;
        if (typeof id === "number") settingsRepo.markTelegramMessageSeen(g.id, id);
      }
      settingsRepo.ensureTelegramSeen(g.id); // mark primed even if 0 messages
    } catch (err) {
      log.warn(`Telegram prime ${g.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Catch-up poller: a safety net for the live event stream. GramJS can silently
 * stop delivering updates after an idle disconnect; this sweep re-fetches each
 * channel's recent messages and processes any not already handled — closing the
 * gap that caused overnight messages to be missed.
 */
async function pollOnce(): Promise<void> {
  const tg = client;
  if (!tg) return;
  // Watchdog: if a previous cycle is still marked running but has exceeded a
  // generous timeout (a hung getMessages), assume it's wedged and start fresh —
  // otherwise the catch-up net silently stays off forever.
  if (polling) {
    if (Date.now() - pollStartedAt < POLL_INTERVAL_MS * 5) return;
    log.warn("Telegram poll cycle exceeded watchdog timeout — restarting it.");
  }
  polling = true;
  pollStartedAt = Date.now();
  try {
    await pollCycle(tg);
  } finally {
    polling = false;
  }
}

async function pollCycle(tg: TelegramClient): Promise<void> {
  // Reconnect if the connection dropped while idle.
  try {
    if (!tg.connected) {
      log.warn("Telegram disconnected — reconnecting…");
      await tg.connect();
      log.info("Telegram reconnected.");
    }
  } catch (err) {
    log.warn("Telegram reconnect failed:", err instanceof Error ? err.message : err);
    return;
  }

  for (const g of groupsRepo.list()) {
    try {
      const entity = await resolveEntityCached(tg, g);

      // A group added at runtime has no seen-set: prime it (mark current
      // messages seen) WITHOUT processing, so old history isn't executed live.
      if (!settingsRepo.hasTelegramSeen(g.id)) {
        const recent = (await tg.getMessages(entity as Parameters<typeof tg.getMessages>[0], {
          limit: POLL_LIMIT,
        })) as Api.Message[];
        for (const m of recent) {
          const id = (m as { id?: number }).id;
          if (typeof id === "number") settingsRepo.markTelegramMessageSeen(g.id, id);
        }
        settingsRepo.ensureTelegramSeen(g.id); // primed even if the channel is empty
        gh(g.id).lastPolledAt = new Date().toISOString();
        log.info(`Primed new group ${g.name} (${recent.length} msgs marked seen).`);
        continue;
      }

      // Page back from newest until we reach already-seen messages (covers gaps
      // larger than POLL_LIMIT), bounded by MAX_CATCHUP to cap cost.
      const fresh: { id: number; text: string; msg: Api.Message }[] = [];
      let offsetId = 0;
      let hitSeen = false;
      while (fresh.length < MAX_CATCHUP && !hitSeen) {
        const opts: Record<string, number> = { limit: POLL_LIMIT };
        if (offsetId) opts.offsetId = offsetId;
        const batch = (await tg.getMessages(
          entity as Parameters<typeof tg.getMessages>[0],
          opts,
        )) as Api.Message[];
        if (batch.length === 0) break;
        let anyNew = false;
        for (const m of batch) {
          const id = (m as { id?: number }).id;
          if (typeof id !== "number") continue;
          const text = (m as { message?: string }).message ?? "";
          const attach = hasAttachment(m);
          if (settingsRepo.claimTelegramMessage(g.id, id)) {
            anyNew = true;
            // Recover messages that carry text OR an attachment (image / PDF).
            if (text || attach) fresh.push({ id, text, msg: m });
          } else {
            hitSeen = true; // reached the already-processed region
          }
        }
        if (!anyNew || batch.length < POLL_LIMIT) break;
        offsetId = Math.min(...batch.map((m) => (m as { id?: number }).id ?? Infinity));
      }
      if (fresh.length >= MAX_CATCHUP) {
        log.warn(`Catch-up for ${g.name} hit the ${MAX_CATCHUP}-message cap; older gap not paged.`);
      }

      // Merge adjacent recovered messages (albums, or a chart sent just before/
      // after the text) into single signals, then process oldest-first.
      const bundles = mergeBundles(fresh.map((f) => toMergeItem(f.msg, f.text)));
      for (const b of bundles) {
        logEvent(
          "message",
          `Catch-up: recovered ${b.items.length > 1 ? `${b.items.length} merged messages` : "missed message"} from ${g.name}`,
          { ids: b.items.map((i) => i.id) },
          { groupId: g.id },
        );
        await processBundle(g, b);
        gh(g.id).recoveredCount += b.items.length;
      }
      const h = gh(g.id);
      h.lastPolledAt = new Date().toISOString();
      h.lastError = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      gh(g.id).lastError = msg;
      entityCache.delete(g.telegramChannel); // force re-resolve next cycle (cache is keyed by channel)
      log.warn(`Telegram poll ${g.name} failed:`, msg);
    }
  }
  lastPollCycleAt = new Date().toISOString();
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
  startedAt = new Date().toISOString();
  const me = await client.getMe();
  const name = (me as { username?: string; firstName?: string })?.username ??
    (me as { firstName?: string })?.firstName ?? "unknown";
  log.info(`Telegram connected as ${name}.`);

  client.addEventHandler((e) => void onMessage(e), new NewMessage({}));

  const channels = groupsRepo.list().map((g) => g.telegramChannel);
  log.info(`Listening for signals in: ${channels.join(", ") || "(no groups yet)"}`);

  // Prime the seen-set to "now", then start the catch-up poller.
  await primeGroups(client);
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  log.info(`Telegram catch-up poller every ${Math.round(POLL_INTERVAL_MS / 1000)}s.`);
}

export async function stopTelegram(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  // Drop any pending merge buffers so their timers can't fire after shutdown.
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  if (client) {
    await client.disconnect();
    client = null;
  }
}
