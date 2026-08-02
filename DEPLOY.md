# Deploying TT Trading Desk to a test server

The API also serves the built desk, so a deployment is **one process on one
port** (default `4000`). Two ways to run it: Docker Compose (recommended) or
bare Node. Both use the same `.env`.

> Start with `TRADING_ENV=testnet` (or `paper`) and a funded **testnet** wallet.
> Only switch to `mainnet` once you trust the behaviour.

---

## 1. Get the code onto the server

```bash
git clone <your-repo-url> tttrading
cd tttrading
git checkout claude/hyperliquid-trading-bot-desk-5zpuia
cp .env.example .env
```

Then edit `.env` (see the table in `README.md`). At minimum set:

- `TRADING_ENV=testnet`
- `DESK_PASSWORD=<a strong password>` and a stable `AUTH_SECRET=<random string>`
- Hyperliquid: `HL_PRIVATE_KEY` (testnet API wallet)
- Telegram: `TG_API_ID`, `TG_API_HASH`, and later `TG_SESSION` (see §4)
- Optional: `ANTHROPIC_API_KEY` (LLM fallback), alert bot vars (§5)

Generate a good `AUTH_SECRET`:

```bash
openssl rand -hex 32
```

---

## 2a. Run with Docker Compose (recommended)

Requires Docker + the Compose plugin.

```bash
docker compose up -d --build
docker compose logs -f          # watch startup
```

- Desk: `http://<server>:4000`
- The SQLite DB is persisted in `./data` on the host.
- Update after pulling new code: `docker compose up -d --build`.
- Stop: `docker compose down`.

To run the one-time Telegram login inside the container, see §4.

## 2b. Run bare (Node + systemd)

Requires Node.js 21+ (the Hyperliquid SDK's signing path needs
`ArrayBuffer.prototype.transfer`, added in Node 21; use 22 LTS) and pnpm
(`npm i -g pnpm`).

```bash
pnpm install --frozen-lockfile
pnpm build
# quick test:
node apps/server/dist/index.js
```

Run it as a service with systemd — create `/etc/systemd/system/tttrading.service`:

```ini
[Unit]
Description=TT Trading Desk
After=network.target

[Service]
WorkingDirectory=/opt/tttrading
ExecStart=/usr/bin/node apps/server/dist/index.js
EnvironmentFile=/opt/tttrading/.env
Environment=WEB_DIST=/opt/tttrading/apps/web/dist
Environment=DB_PATH=/opt/tttrading/data/tttrading.sqlite
Restart=always
RestartSec=3
User=tttrading

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tttrading
sudo journalctl -u tttrading -f
```

(pm2 works too: `pm2 start apps/server/dist/index.js --name tttrading`.)

---

## 3. HTTPS / reverse proxy

Put the desk behind a reverse proxy for TLS. The WebSocket lives at `/ws`, so
the proxy must forward upgrades. Example nginx:

```nginx
server {
  listen 443 ssl;
  server_name desk.example.com;
  # ssl_certificate ...; ssl_certificate_key ...;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

Use certbot (Let's Encrypt) for the certificate. With `DESK_PASSWORD` set, the
desk requires login and all API/WS access needs a valid token.

---

## 4. Connecting your Telegram account

Reading arbitrary channels needs a **user** session (not a bot). This is a
one-time interactive login that produces a `TG_SESSION` string.

1. Create API credentials at https://my.telegram.org → set `TG_API_ID` and
   `TG_API_HASH` in `.env`.
2. Run the login helper and follow the prompts (phone number, the code Telegram
   sends you, optional 2FA password):

   - **Bare:** `pnpm --filter @tttrading/server tg:login`
   - **Docker:** `docker compose run --rm desk pnpm --filter @tttrading/server tg:login`

3. Copy the printed session string into `TG_SESSION` in `.env`.
4. Restart the desk (`docker compose up -d` or `systemctl restart tttrading`).
5. In the desk → **Groups & Settings**, add each channel as a group using its
   `@handle` (or numeric id). Incoming messages then appear live under the
   **Messages** tab, and parsed signals under **Signals**.

> The login is interactive and tied to your phone — only you can complete it.
> Keep `TG_SESSION` secret; it grants access to your Telegram account.

---

## 5. Alerts (optional)

Fills, errors and (optionally) blocked trades can be pushed to a Telegram
**bot** chat:

1. Create a bot via [@BotFather](https://t.me/BotFather) → get the bot token.
2. Start a chat with your bot (or add it to a group/channel) and get the chat id
   (e.g. via [@userinfobot](https://t.me/userinfobot) or the getUpdates API).
3. Set in `.env`:

   ```
   ALERT_TG_BOT_TOKEN=123456:ABC...
   ALERT_TG_CHAT_ID=<chat id>
   ALERT_ON_FILL=true
   ALERT_ON_ERROR=true
   ALERT_ON_BLOCKED=false
   ```

You'll get a "started" message on boot when it's configured correctly.

---

## Health check

```bash
curl http://localhost:4000/api/health
# {"ok":true,"env":"testnet","live":true,"authRequired":true,...}
```
