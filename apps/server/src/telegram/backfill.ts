import type { Api } from "telegram";
import { log } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, trades as tradesRepo } from "../db/repositories.js";
import { parseSignal } from "../signals/parser.js";
import { assessRisk } from "../risk/score.js";
import { broadcast } from "../ws/hub.js";
import { getTelegramClient, normalizeChannel } from "./listener.js";

export interface BackfillResult {
  groupId: string;
  groupName: string;
  imported: number;
  error?: string;
}

/**
 * Resolve a group's channel string to a Telegram entity. Public channels
 * resolve by @handle; private channels are found by numeric id in the account's
 * dialog list (a bare id is otherwise misread as a PeerUser).
 */
async function resolveEntity(
  client: NonNullable<ReturnType<typeof getTelegramClient>>,
  channel: string,
): Promise<unknown> {
  const norm = normalizeChannel(channel);
  if (!/^\d+$/.test(norm)) return client.getEntity(channel);

  const dialogs = await client.getDialogs({});
  for (const d of dialogs) {
    const e = d.entity as { id?: unknown } | undefined;
    if (e && String(e.id) === norm) return e;
  }
  // Fallback: try the -100-marked channel id form.
  return client.getEntity(Number(`-100${norm}`));
}

/**
 * Import the last `days` of messages from a channel for analysis. Messages are
 * parsed + risk-scored and stored as "backfill" signals — they are NEVER
 * executed and don't create trades. Purely for learning / tuning.
 */
export async function backfillGroup(groupId: string, days = 30, maxMessages = 800): Promise<BackfillResult> {
  const group = groupsRepo.get(groupId);
  if (!group) return { groupId, groupName: "", imported: 0, error: "group not found" };

  const client = getTelegramClient();
  if (!client) return { groupId, groupName: group.name, imported: 0, error: "Telegram not connected" };

  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  let imported = 0;

  try {
    const entity = await resolveEntity(client, group.telegramChannel);
    const messages = await client.getMessages(
      entity as Parameters<typeof client.getMessages>[0],
      { limit: maxMessages },
    );
    const history = tradesRepo.forGroup(groupId);

    // getMessages returns newest-first; stop once we pass the cutoff.
    for (const m of messages as Api.Message[]) {
      const date = (m as { date?: number }).date ?? 0;
      if (date && date < cutoff) break;
      const text = (m as { message?: string }).message;
      if (!text) continue;

      const receivedAt = date ? new Date(date * 1000).toISOString() : undefined;
      // Skip messages already imported so re-running is idempotent.
      if (receivedAt && signalsRepo.existsSimilar(groupId, receivedAt, text)) continue;

      const parsed = await parseSignal(text);
      const risk = parsed ? assessRisk(group.settings, parsed, history) : undefined;
      const signal = signalsRepo.create({
        groupId,
        groupName: group.name,
        rawText: text,
        status: "backfill",
        parsed: parsed ?? undefined,
        risk,
        receivedAt,
      });
      broadcast({ type: "signal", signal });
      imported++;
    }
    log.info(`Backfill ${group.name}: imported ${imported} messages (${days}d).`);
    return { groupId, groupName: group.name, imported };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`Backfill ${group.name} failed: ${error}`);
    return { groupId, groupName: group.name, imported, error };
  }
}

/** Backfill every group. */
export async function backfillAll(days = 30): Promise<BackfillResult[]> {
  const out: BackfillResult[] = [];
  for (const g of groupsRepo.list()) {
    out.push(await backfillGroup(g.id, days));
  }
  return out;
}
