# Tradedesk

A local trading desk for you and your AI agents: your real portfolios (Trade Republic by hand, Interactive Brokers
through its API), paper portfolios, a day-trading cockpit, order proposals that only you can approve, risk limits with
a kill switch, a chat and a journal where agents explain themselves. Built like the AI Work Dashboard: local, one
page, German UI.

Kurz auf Deutsch: Agenten (Claude-Code-Sitzungen) schlagen Orders vor, du gibst frei. Für Trade Republic führst du
freigegebene Orders selbst in der App aus. Bei Interactive Brokers geht die freigegebene Order über die API an den
Broker – mit echtem Geld nur, wenn du `liveTrading` einschaltest. Jeder Agent handelt ein eigenes Papierdepot mit
echten Kursen, damit du siehst, wer gut entscheidet. Keine Anlageberatung.

## What it shows

| Module | Content |
|---|---|
| Trading | Day-trading cockpit: sessions per exchange (pre-market, open, after-hours), today's P/L, realized, trades and hit rate, kill switch; scanner (change, gap, relative volume, ATR, position in the day range); 1-minute chart with EMA 9/21, VWAP and volume, lines for entry, stop, target, limits and alerts; order calculator (shares from risk budget and stop incl. both fees, capped by the account limits, targets at 1–3 R); positions with R multiple; open proposals; news; day statistics per account. Keys: arrow up/down switch the symbol, B/S open the calculator |
| Übersicht | Your wealth across your own accounts, today and total P/L, equity curve, what waits for you, all accounts, timeline |
| Depots | Per account: positions (FIFO cost, value, P/L, weight, stop/target), equity curve, trades, deposits. Manual accounts: record trades, CSV import, deposits; paper accounts: orders |
| Markt | Watchlist with search, candlestick chart (1 day to 5 years) with limit and alert lines, alerts, agent notes per symbol |
| Orders | Proposals with thesis, confidence, price at proposal vs. now, warnings; approve (may only shrink), reject with reason, record a broker execution, cancel; history |
| Agenten | Return of each agent against yours, hit rate, approvals and rejections, journal, how to connect an agent |
| Risiko | Kill switch; per account: max order value, max position weight, risk per trade (loss to the stop incl. fees), daily loss stop, max open proposals per agent, stop required for agent buys |
| Chat | One room for you, the agents and the desk (side panel, key C). Agents write with `say` and read with `read`; the desk posts the outcome of every proposal to its author. A chat message never approves anything |

## How a proposal flows

1. An agent runs `python cli/desk.py propose …`. The server checks it before it exists: the agent must be listed in
   `config.json`, may only propose for its own paper account or yours, the symbol must be on the watchlist or held
   (no invented tickers), confidence must reach `minConfidence`, and the risk check must pass (cash, no short
   selling, position weight, order value, daily loss, open proposals, stop below / target above the price). What
   fails is not created; `--dry-run` shows the check without saving.
2. You see it under Orders. Approving re-reads the price first: if it moved more than `staleMovePct` since the
   proposal, nothing happens and the proposal becomes "Kurs bewegt". The risk check runs again. You may approve fewer
   shares, never more. Two clicks execute once.
3. Paper account: filled at the current price (limit orders once the limit is reached). Manual account (Trade
   Republic): "beim Broker" – you place the order in the app, then enter price and fee from the statement. Broker
   account (Interactive Brokers): the order goes to IBKR as a day order; if IBKR asks back (price or size warning),
   the proposal shows IBKR's text and waits for you to confirm or cancel; fills come back automatically.
4. Stop loss and target are reminders in the timeline, never automatic orders.

The CLI has no command to approve, reject, change limits or switch the kill switch, and the server refuses those
calls without your browser session (see "Owner login" below): every owner route needs the session token, and every
change additionally the desk's own `Origin`. Agents call the API without a session; they can read (brief, scan,
portfolio, chat) and propose, nothing more. The server answers only for `127.0.0.1:<port>`, `localhost:<port>` and
`[::1]:<port>` (Host header), so a web page that points its own name at 127.0.0.1 reads nothing. Agents run as your OS
user, so this guards against an agent that calls the API (for example after a prompt injection in news or chat), not
against a program that edits the database.

## Setup

Requirements: Node.js 24 or newer, Python 3.10+ for the agent CLI.

```bash
git clone https://github.com/mauricekleindienst/tradedesk
cd tradedesk
npm ci
npm run build
mkdir ~/.tradedesk && cp config.example.json ~/.tradedesk/config.json   # then edit accounts and agents
npm start                                                                # http://127.0.0.1:8095
```

Windows: `pwsh start.ps1` installs, builds when needed and starts.

### Owner login (PIN)

Every owner action (approve, confirm, cancel, fill, kill switch, limits, trades, cash, import, reconcile, watchlist and
alerts) needs your browser session. On the first start without a PIN, the desk prints a one-time setup code to its
own console, and only there:

```
PIN festlegen: Einrichtungscode K7QX2MPA – im Browser eingeben und eine PIN (4–12 Ziffern) wählen.
```

Open http://127.0.0.1:8095, enter the code and choose a PIN of 4 to 12 digits. The code lives only in the server's
memory (never in the database, a log file, the API or the chat) and a new one appears on every start until a PIN is
set, so an agent cannot set the PIN before you. The PIN is stored only as a salted scrypt hash. Logging in returns a
session token valid for 30 days; the desk page keeps it in its own localStorage and sends it as the `X-Desk-Session`
header. It is deliberately not a cookie: browsers do not separate cookies by port, so a server another program starts
on 127.0.0.1 would receive it. The database keeps only the SHA-256 of the token, and logging out deletes it. Five wrong PINs lock the login for 60 seconds, each further five for twice as long.

API (JSON): `GET /api/auth` → `{ pinSet, authenticated }`; `POST /api/auth/setup` `{ code, pin }` (only while no PIN
is set); `POST /api/auth/login` `{ pin }`; `POST /api/auth/logout`. Forgot the PIN: stop the desk and run
`node apps/server/src/index.ts --reset-pin` (deletes the PIN and all sessions); the next start prints a new code.
The fixture server (`--fixture`, self-test, tests) uses the test PIN `2468`.

### From your phone (Tailscale)

The desk can also listen on this computer's Tailscale address, so your own Tailscale devices reach it, e.g.
http://100.121.124.65:8095 from the phone. Only Tailscale addresses (100.64.0.0/10) are accepted, never the LAN or
`0.0.0.0`; Tailscale encrypts the connection and only your devices are in your tailnet.

1. Set your PIN first (the desk binds the Tailscale address only once a PIN exists).
2. In `config.json`: `"listen": ["100.121.124.65"]` (your PC's address from `tailscale ip -4`), restart the desk.
3. Allow the port in the Windows firewall for the tailnet only (PowerShell as administrator):
   `New-NetFirewallRule -DisplayName "Tradedesk (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 8095 -RemoteAddress 100.64.0.0/10 -Action Allow`
4. On the phone open the address and log in with your PIN.

From another device every request needs your PIN session, reading included; the agents' CLI only works on this
computer.

### config.json

| Key | Meaning |
|---|---|
| `user` | Your name; the only one who approves |
| `port` | Default 8095 |
| `market` | `yahoo` (free quotes from Yahoo Finance, unofficial, often delayed) or `off` (no network; positions valued at cost) |
| `quotes` | Price source: `yahoo` (default) or `ibkr` (snapshots from the Client Portal Gateway of your first IBKR account, Yahoo as fallback; needs IBKR market data subscriptions, otherwise IBKR sends delayed or no data). Every quote carries its source and age |
| `accounts` | Your accounts: `kind` `manual` (you trade at the broker and record it here), `paper`, or `broker` (Interactive Brokers: `ibAccount`, optional `gateway`, `conids`); `feeEur` per order; `startCashEur` |
| `listen` | Extra addresses besides 127.0.0.1, Tailscale only (100.64.0.0/10), e.g. `["100.121.124.65"]` for the phone |
| `liveTrading` | `false` by default; must be `true` before orders go to a real-money broker account |
| `agents` | Agent names; each gets a paper account `agent-<name>` with `startCashEur` |
| `minConfidence` | 0–1; agent proposals below it are not created |
| `staleMovePct` | Max price move between proposal and approval |
| `proposalTtlHours` | Undecided proposals expire after this |
| `quoteIntervalSec` | Quote refresh without a browser open, default 60 |
| `liveIntervalSec` | Quote and 1-minute chart refresh while a browser is open, default 15 (Yahoo may throttle much faster polling) |
| `maxQuoteAgeSec` | During trading hours no proposal, approval, broker confirmation or limit fill uses a quote (or exchange rate) older than this, default 120 |

Day trading with these quotes: Yahoo is free but unofficial and not a professional real-time feed; quotes for some
exchanges are delayed, and the dashboard shows the time of every quote. Trade Republic orders are entered by hand in
its app, so the desk is a planning, risk and review tool for that account, not an execution engine.

Symbols use Yahoo's spelling: `SAP.DE`, `EUNL.DE`, `AAPL`, `BTC-EUR`. Prices of manual accounts are entered in EUR
(Trade Republic trades in EUR even for US shares); positions are valued at the current quote times the exchange rate.

### Trade Republic

Trade Republic has no official API. The unofficial libraries log in with your phone number and PIN and may break
or violate the terms, so the desk does not use them. Instead:

- record trades by hand ("Trade erfassen…") or import a CSV:
  `datum;symbol;seite;stueck;kurs;gebuehr;waehrung;notiz` (German or English headers, `;` with decimal comma or `,`),
  importing the same file twice skips known lines (two identical lines in one file are two executions); a line in a
  foreign currency needs the rate of its trade day, column `fx` (EUR per unit, e.g. `0,9612` for USD) or `betrag_eur`
  (value in EUR without fee) – it is never booked at today's rate; dates in the future, impossible dates and sells
  that were not covered at their own time are refused with the line number;
- approved proposals for the Trade Republic account wait as "beim Broker" until you enter the execution.

### Interactive Brokers

Orders go through IBKR's Client Portal Web API via the **Client Portal Gateway** running on your computer
(`https://localhost:5000`). You log in there yourself in the browser; the desk never sees credentials and only talks
to a gateway on localhost.

1. Install Java and the Client Portal Gateway from IBKR, start it, open https://localhost:5000 and log in (start with
   your paper account, `DU…`).
2. Add the account to `config.json`:
   `{ "id": "ibkr", "name": "IBKR", "kind": "broker", "ibAccount": "DU1234567", "feeEur": 2, "startCashEur": 0 }`
   (`gateway` defaults to `https://localhost:5000`; `conids` maps symbols to IBKR contract ids where the automatic
   lookup is ambiguous, for example `{ "SAP.DE": 14204 }`).
3. Restart the desk. Under Depots the account shows the connection; "Mit IBKR abgleichen…" previews positions and
   cash at IBKR against the desk and books the differences only when you confirm.
4. Real money: accounts not starting with `D` are live. Orders to them are refused until `"liveTrading": true` is
   set in `config.json`, and refused if the gateway is logged into a paper session. The kill switch and every risk
   limit apply to broker orders too. Crypto and FX are not traded through IBKR by the desk.

The gateway session times out without activity; the desk pings it while running, but IBKR logs you out daily, so
log in again in the morning before trading.

### Agents

Agents are Claude Code sessions. Open Claude Code in this repository and run `/desk-agent Atlas` (one per agent), or
`/loop 10m /desk-agent Atlas` to keep it going through the day. Rules and commands: `docs/AGENTS.md`.

```bash
python cli/desk.py status
python cli/desk.py quote SAP.DE
python cli/desk.py watchlist
python cli/desk.py portfolio --account agent-atlas
python cli/desk.py propose --as Atlas --account agent-atlas --symbol SAP.DE --side buy --qty 3 \
    --confidence 0.7 --stop 185 --target 230 --thesis "why" [--limit 195] [--dry-run]
python cli/desk.py proposals --as Atlas            # see decisions and rejection reasons
python cli/desk.py journal --as Atlas --symbol SAP.DE --kind thesis "text"
python cli/desk.py notes --symbol SAP.DE
```

Day trading and chat:

```bash
python cli/desk.py brief --as Atlas                # sessions, own account and day stats, positions, scanner, own proposals, chat to me
python cli/desk.py scan --sort relvol
python cli/desk.py analyze NVDA                    # EMA 9/21, VWAP, RSI 14 (1-minute), ATR 14 (daily), gap, relative volume
python cli/desk.py news NVDA
python cli/desk.py say --as Atlas --ref NVDA "@Nova gap and go?"
python cli/desk.py read --as Atlas                 # new messages since the last read, * = addressed to me
python cli/desk.py wait --as Atlas --timeout 600   # block until someone writes to you (exit 3 on timeout)
```

`TRADEDESK_URL` overrides the server address. Exit code 1 means refused (reason on stderr), 2 not reachable.

## Development

```bash
npm run dev          # server on 8096 with the real data folder
npm run dev:web      # Vite on 5175, proxies /api to 8096
node apps/server/src/index.ts --fixture --port 8097   # throwaway data and a fake exchange, no network
```

Architecture (modules, tick, SSE, money rules, auth, broker recovery, adding a broker or quote feed):
`docs/ARCHITECTURE.md`.

Read API used by the web app besides the views' own routes: `GET /api/overview` (incl. `allocation` by symbol and asset
class and `changes` for 1W/1M/3M/YTD/1Y/all), `GET /api/analytics?account=<id|mine|all>&from=YYYY-MM-DD&to=YYYY-MM-DD`
(closed FIFO trades with R, equity curve with drawdown, daily results, stats by weekday, hour, author and symbol; shapes
and definitions in `packages/shared/src/schema.ts`), `GET /api/market/quote/<symbol>` (incl. `quote` with source and
age).

Checks: see `CLAUDE.md`. Data lives in `~/.tradedesk` (`config.json`, `desk.sqlite`); migrations are numbered and
additive, and the database is copied to `desk.sqlite.v<n>.bak` before each migration.
