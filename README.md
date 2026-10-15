# Tradedesk

A local trading desk for you and your AI agents: your real portfolio (for example at Trade Republic), paper
portfolios, watchlist and candlestick charts, order proposals that only you can approve, risk limits with a kill
switch, and a journal where agents explain themselves. Built like the AI Work Dashboard: local, one page, German UI.

Kurz auf Deutsch: Agenten schlagen Orders vor, du gibst frei. Echtes Geld bewegt der Desk nie – für Trade Republic
führst du freigegebene Orders selbst in der App aus und trägst die Ausführung ein. Jeder Agent handelt ein eigenes
Papierdepot mit echten Kursen, damit du siehst, wer gut entscheidet. Keine Anlageberatung.

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
   Republic): "beim Broker ausführen" – you place the order in the app, then enter price and fee from the statement.
4. Stop loss and target are reminders in the timeline, never automatic orders.

The CLI has no command to approve, reject, change limits or switch the kill switch, and the server refuses those
calls unless they come from the browser (a request with a local `Origin`). Agents run as your OS user, so this
guards against mistakes, not against a hostile program on your computer.

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

### config.json

| Key | Meaning |
|---|---|
| `user` | Your name; the only one who approves |
| `port` | Default 8095 |
| `market` | `yahoo` (free quotes from Yahoo Finance, unofficial, often delayed) or `off` (no network; positions valued at cost) |
| `accounts` | Your accounts: `kind` `manual` (you trade at the broker and record it here) or `paper`; `feeEur` per order; `startCashEur` |
| `agents` | Agent names; each gets a paper account `agent-<name>` with `startCashEur` |
| `minConfidence` | 0–1; agent proposals below it are not created |
| `staleMovePct` | Max price move between proposal and approval |
| `proposalTtlHours` | Undecided proposals expire after this |
| `quoteIntervalSec` | Quote refresh without a browser open, default 60 |
| `liveIntervalSec` | Quote and 1-minute chart refresh while a browser is open, default 15 (Yahoo may throttle much faster polling) |

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
  importing the same file twice skips known lines;
- approved proposals for the Trade Republic account wait as "beim Broker ausführen" until you enter the execution.

A broker with an official API (for example Interactive Brokers) can be added later behind the same approval flow.

### Agents

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
```

`TRADEDESK_URL` overrides the server address. Exit code 1 means refused (reason on stderr), 2 not reachable.

## Development

```bash
npm run dev          # server on 8096 with the real data folder
npm run dev:web      # Vite on 5175, proxies /api to 8096
node apps/server/src/index.ts --fixture --port 8097   # throwaway data and a fake exchange, no network
```

Checks: see `CLAUDE.md`. Data lives in `~/.tradedesk` (`config.json`, `desk.sqlite`); migrations are numbered and
additive, and the database is copied to `desk.sqlite.v<n>.bak` before each migration.
