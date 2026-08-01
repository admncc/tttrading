# TT Trading Desk

A self-hosted trading bot **and** desk for [Hyperliquid](https://hyperliquid.xyz):

- **Reads signals** from your Telegram channels and executes them automatically.
- **Parses** messages with a fast regex parser and an optional **Claude LLM
  fallback** for messy/free-text signals.
- **Executes per group**: each trading group has its own leverage, trade size,
  execution mode (auto vs. manual confirmation), margin mode and slippage.
- **Desk dashboard**: live stats of all trades, performance per group, an equity
  curve, a signal queue with one-click confirm/reject, and a settings editor.
- **Safe by default**: starts on Hyperliquid **testnet**; runs in **paper**
  (simulated) mode until you add a signing key.

> ⚠️ Trading involves real financial risk. Start on `testnet` or `paper`,
> read the code, and only switch to `mainnet` once you trust the behaviour.

---

## Architecture

```
tttrading/
├── packages/shared        # shared TypeScript domain types (the API contract)
└── apps/
    ├── server             # Node + Fastify backend
    │   ├── telegram/      # GramJS user client -> listens to channels
    │   ├── signals/       # regex + LLM signal parsing
    │   ├── hyperliquid/   # @nktkas/hyperliquid connector (orders, leverage)
    │   ├── execution/     # engine: rules, auto/confirm, entry + SL/TP brackets
    │   ├── stats/         # performance aggregation
    │   ├── db/            # SQLite (better-sqlite3) + repositories + seed
    │   └── api/           # REST + WebSocket
    └── web                # React + Vite dashboard (the "desk")
```

**Data flow:** Telegram message → parser (regex → LLM) → execution engine
(applies the group's settings) → Hyperliquid order → trade record in SQLite →
pushed live to the desk over WebSocket.

---

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io) 9+ (`npm i -g pnpm`)

## Setup

```bash
pnpm install
cp .env.example .env      # then edit .env (see below)
```

### Run (two dev servers)

```bash
pnpm dev
```

- API + bot: http://localhost:4000
- Desk UI:  http://localhost:5173 (proxies `/api` and `/ws` to the API)

On first run with `SEED_DEMO=true` the database is populated with two demo
groups and sample trades, so the dashboard has data immediately. Set
`SEED_DEMO=false` for a clean start.

You can run the pieces separately with `pnpm dev:server` and `pnpm dev:web`.

---

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `TRADING_ENV` | `testnet` \| `mainnet` \| `paper` |
| `SEED_DEMO` | Seed demo data on an empty DB |
| `HL_PRIVATE_KEY` | Hyperliquid API/agent wallet key. Blank ⇒ orders simulated |
| `HL_ACCOUNT_ADDRESS` | Account to read positions for (defaults to wallet) |
| `TG_API_ID`, `TG_API_HASH` | Telegram API creds from https://my.telegram.org |
| `TG_SESSION` | Telegram string session (see below) |
| `ANTHROPIC_API_KEY` | Enables the LLM signal-parsing fallback |
| `ANTHROPIC_MODEL` | Defaults to `claude-sonnet-5` |

### Telegram login

Signals are read via a **user** session (bots can't read arbitrary channels),
using [GramJS](https://gram.js.org). Create API credentials at
https://my.telegram.org, put `TG_API_ID` / `TG_API_HASH` in `.env`, then:

```bash
pnpm --filter @tttrading/server tg:login
```

Follow the prompts (phone, code, optional 2FA) and paste the printed session
string into `TG_SESSION`. Add the channels you want to trade as **Groups** in
the desk (Groups & Settings → New group), using the channel `@handle`.

### Hyperliquid

1. Create an API wallet in the Hyperliquid app (or use your main key for
   testing) and set `HL_PRIVATE_KEY`.
2. Keep `TRADING_ENV=testnet` while validating. Fund the testnet account from
   the Hyperliquid testnet faucet.
3. Switch to `mainnet` only when you're confident.

With no key (or `TRADING_ENV=paper`) the connector still reads **live prices**
and simulates fills, so you can validate parsing and the desk end-to-end
without risking funds.

---

## Using the desk

- **Overview** – KPIs (realized PnL, win rate, profit factor…), cumulative PnL
  curve, and per-group performance.
- **Signals** – live feed of incoming signals with the parsed interpretation;
  a queue to confirm/reject signals from `confirm`-mode groups; and a box to
  paste a raw message to test parsing + routing end-to-end.
- **Trades** – all trades with filters; a 🛡 marks positions protected by live
  SL/TP orders. Closing sends a reduce-only order (live) and cancels any
  resting SL/TP; in paper mode the exit is just recorded.
- **Groups & Settings** – per-group leverage, trade size (USDC), execution mode
  (auto / confirm), margin mode, max slippage, single-TP auto-split, and an
  optional symbol allow-list.

### Take-profit auto-split

Some providers post a single target and expect you to scale out over several
levels; others give TP1–TP4 explicitly. Per group you can enable **auto-split**:
when a signal carries only one take-profit, the desk generates N equally-spaced
levels between the entry and that target and scales the position out evenly
across them (e.g. 1/3 at each of 3 levels). Signals that already list multiple
TPs are used as-is. This is engine-side, so it works whether the signal was
parsed by regex or by the LLM.

Example (single target → 3 levels): `SHORT $ETH Entry: CMP till 3361,
Target 2721, SL 3457` becomes TP1 3147.67 / TP2 2934.33 / TP3 2721.00.

### Example: your requested setup

Create a group with **Leverage = 4**, **Trade size = 5000 USDC**,
**Execution = Auto**. Every signal from that channel is then opened at x4 with a
5,000 USDC notional automatically. Use **Confirm** on groups you want to review
by hand before anything is sent.

---

## Signal formats

The regex parser understands common layouts, e.g.:

```
🟢 LONG BTC
Entry: 62000
SL: 60500
TP1: 64000  TP2: 65000
Leverage: 4x
```

or one-liners like `SHORT $ETH @ 3200 sl 3300 tp 3000`. Anything the regex
can't confidently parse is passed to the LLM (if `ANTHROPIC_API_KEY` is set),
which extracts symbol / side / entry / SL / TP in any language.

---

## Build & typecheck

```bash
pnpm typecheck
pnpm build
pnpm start          # runs the built server (serve the web build separately)
```

### Reconciliation & break-even

In live mode a background monitor polls the exchange every
`MONITOR_INTERVAL_MS` and:

- detects when SL/TP trigger orders fill externally and **closes the trade
  with the real PnL** (and shows TP progress, e.g. "1/3 hit"), and
- **moves the stop-loss to break-even** once the configured number of TP levels
  has filled (per-group `breakevenAfterTp`, e.g. after TP1).

Trigger a pass by hand with `POST /api/reconcile`.

### Risk traffic light (Ampel)

Every actionable signal is scored **green / yellow / red** from the channel's
historical performance (win rate, profit factor, recent trend, sample size) plus
signal characteristics (missing stop-loss, risk/reward, leverage). The score and
the reasons behind it are shown on signals and trades in the desk.

Per channel you can enable **"block red trades"**: red signals are not executed,
but a **shadow trade** records what they *would* have done (using the same TP
scale-out and break-even rules). The Overview shows a **classification audit** —
how many blocked reds would have lost and the net PnL blocking avoided — so you
can tell whether the filter is helping or costing you. Shadow trades are kept
out of the real performance figures.

## Roadmap / not yet included

- Authentication on the desk API (run on a trusted network for now).
- Alerting (Telegram/email) on fills and errors.
- Authentication on the desk API (run it on a trusted network for now).
- Alerting (Telegram/email) on fills and errors.
