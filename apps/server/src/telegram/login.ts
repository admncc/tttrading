/**
 * One-time helper to log into Telegram and print a StringSession value.
 * Run with:  pnpm --filter @tttrading/server tg:login
 * Then copy the printed session into TG_SESSION in your .env.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config } from "../config.js";

async function main(): Promise<void> {
  if (!config.telegram.apiId || !config.telegram.apiHash) {
    console.error("Set TG_API_ID and TG_API_HASH in .env first (from https://my.telegram.org).");
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  const client = new TelegramClient(
    new StringSession(""),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 },
  );

  await client.start({
    phoneNumber: async () => rl.question("Phone number (with country code): "),
    password: async () => rl.question("2FA password (blank if none): "),
    phoneCode: async () => rl.question("Login code you received: "),
    onError: (err) => console.error(err),
  });

  console.log("\nLogin successful. Add this to your .env as TG_SESSION:\n");
  console.log(String(client.session.save()));
  await rl.close();
  await client.disconnect();
  process.exit(0);
}

void main();
