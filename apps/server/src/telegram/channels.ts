/**
 * List all channels/groups the connected account can read, with their handle
 * and numeric id — so you know exactly what to enter as a group's
 * "Telegram channel". Run with:
 *   pnpm --filter @tttrading/server tg:channels
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  if (!config.telegram.session || !config.telegram.apiId) {
    console.error("Telegram not configured (need TG_API_ID / TG_API_HASH / TG_SESSION).");
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(config.telegram.session),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 },
  );
  await client.connect();

  const dialogs = await client.getDialogs({});
  console.log("\nChannels / groups this account can read:");
  console.log("(use the @handle if present, otherwise the id)\n");

  for (const d of dialogs) {
    if (!d.isChannel && !d.isGroup) continue;
    const e = d.entity as { username?: string; id?: unknown; title?: string } | undefined;
    const handle = e?.username ? `@${e.username}` : "(private — use id)";
    const id = String(e?.id ?? "");
    const title = d.title ?? e?.title ?? "";
    console.log(`- ${title}`);
    console.log(`    handle: ${handle}`);
    console.log(`    id:     ${id}\n`);
  }

  await client.disconnect();
  process.exit(0);
}

void main();
