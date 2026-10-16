# Architecture

One Node process (>= 24, TypeScript run directly), one SQLite database (`~/.tradedesk/desk.sqlite`, `node:sqlite`),
one page. Owner decisions and code rules are in `CLAUDE.md`; this file says where things live and how they flow.

## Modules

| Path | Content |
|---|---|
| `packages/shared/src/schema.ts` | zod schema per API answer; types are inferred from them. API shapes change here first |
| `packages/shared/src/portfolio.ts` | money (`cents()`), FIFO book (`buildBook`, incl. closed lots), valuation, risk check (`checkOrder`) |
| `packages/shared/src/trading.ts` | indicators (EMA, VWAP, RSI, ATR), sessions, day stats, position sizing, R |
| `packages/shared/src/analytics.ts` | analytics (closed trades with R, stats, drawdown, day results), overview ranges and asset classes |
| `packages/shared/src/csv.ts` | CSV import parser |
| `apps/server/src/index.ts` | start, config, wiring of market, feed and brokers, listen on 127.0.0.1 (+ Tailscale) |
| `apps/server/src/app.ts` | HTTP (Hono): host check, body limits, owner/agent split, routes, SSE stream, web app |
| `apps/server/src/auth.ts` | owner PIN (scrypt), sessions (SHA-256 of the token), lockout |
| `apps/server/src/desk.ts` | entry point, re-exports `Desk`, `DeskError`, `DEFAULT_LIMITS`, `Origin` from `src/desk/` |
| `apps/server/src/desk/` | the desk service, one class chain (below) |
| `apps/server/src/market.ts` | `Market`: Yahoo, fake exchange, off |
| `apps/server/src/feed.ts` | `QuoteFeed`: where prices come from (Yahoo through `Market`, IBKR snapshot) |
| `apps/server/src/broker.ts` | `Broker`: IBKR Client Portal Gateway, fake broker |
| `apps/server/src/http.ts` | the only HTTP client: `httpJson` (internet, timeout), `localJson` (localhost only, self-signed TLS) |
| `apps/server/src/db.ts` | migrations (numbered, append only, backup before each), small query helper |
| `apps/server/src/fixture.ts`, `selftest.ts` | throwaway workspace with fake exchange and broker for tests, self-test, Playwright |
| `cli/desk.py` | the agents' CLI (read, propose, journal, chat); no approve command |

`src/desk/` is a chain of abstract classes, each file one concern, each building on the one before; `Desk` is the
whole. Methods keep `this.…`; what a lower layer needs from a higher one is declared `abstract` there (e.g. `limits`
in `book.ts`, `sendToBroker`/`pollBroker` in `proposals.ts`).

```
core.ts       DeskCore      config, db, clock (now), events + chat posting, account/instrument/quote lookups, parse helpers
book.ts       DeskBook      FIFO ledger cache per account, summary, positions, trades, curve, snapshots, overview, allocation
risk.ts       DeskRisk      limits, daily loss, kill switch
market.ts     DeskMarket    quote refresh and storage, quote age and source, watchlist, search, charts, alerts, sessions, scan, analysis, news
proposals.ts  DeskProposals submit and check, approve, reject, cancel, manual fill, paper limit fills, expiry, stop/target reminders
broker.ts     DeskBroker    send, confirm IBKR's question, poll with recovery, order sync, executions, reconcile
manual.ts     DeskManual    manual trades, delete/restore, cash moves, CSV import
journal.ts    DeskJournal   journal, agents comparison, chat
analytics.ts  DeskAnalytics GET /api/analytics
desk.ts       Desk          cockpit, close reminder, tick, timer
```

## Data flow

- **Tick** (`Desk.tick`, one at a time): tracked symbols (watchlist, holdings, active proposals) → `QuoteFeed.snapshot`
  (plus FX for foreign currencies) → `quote`/`instrument`; daily stats for up to 3 symbols; `pollBroker` per broker
  account; then in one transaction: paper limit fills, expiry, alerts, stop/target reminders, close reminder, today's
  snapshot per account. Emits `tick`.
- **Timer** (`start`): checks every second; ticks every `liveIntervalSec` while a browser listens on the stream,
  otherwise every `quoteIntervalSec`, three times slower while the market errors. IBKR `/tickle` every 60 s on its own.
- **Writes** happen only inside the desk, synchronously in transactions (Node is single-threaded: a double click
  executes once). Status changes claim rows with `WHERE status = '…'`. Network calls (broker, quotes) run outside
  transactions.
- **Reads** (`overview`, `detail`, `cockpit`, `analytics`, …) build from the database; the FIFO book per account is
  cached until its trades change (count, max id, sum of active ids).
- **SSE** `GET /api/stream`: events `hello`, `event` (timeline), `tick` (something changed: refetch), `chat`, `ping`
  every 15 s. The browser refetches on `tick`; besides timeline and chat texts the stream carries no portfolio data. EventSource cannot send
  headers, so only this route accepts the session token as `?session=`.
- **Push quotes** (none today): a `QuoteFeed` that pushes calls `onQuotes` handlers; the desk stores them like a tick's
  quotes and emits `tick`. The tick's `snapshot` stays the fallback.

## Money rules

- Money in integer cents (EUR), rounded only in `cents()` (half away from zero; non-finite or unsafe values throw).
  Prices in the instrument's currency, `fx` = EUR per unit, quantities up to 6 decimals.
- FIFO lots in `buildBook`; cost includes the buy fee, proceeds are net of the sell fee. A sell can only sell what was
  held at its own time (`oversold` checks the whole book in time order).
- Values without a quote count at cost (`missingQuotes`). Manual (Trade Republic) trades are booked in EUR.
- A closed trade (analytics) is the part of a buy lot a sell closed; its shares of cost and proceeds add up exactly to
  the sell's realized result. R = result / (loss to the proposal's stop at the buy's rate + both fees).
- Results and drawdowns use equity minus deposits, so deposits and withdrawals are neither gain nor loss.

## Auth model

- The server answers only for its own host names (`127.0.0.1`, `localhost`, `[::1]` with its port; Tailscale
  addresses from `listen`): against DNS rebinding.
- Agents use the CLI without a session: they read and propose. Owner routes call `userOnly`: a valid PIN session in
  `X-Desk-Session` and, for changes, the desk's own `Origin`; changes need JSON (forces a CORS preflight).
- The first PIN needs a one-time setup code printed only to the server console. PIN as scrypt hash, session tokens
  as SHA-256, 30 days, lockout after 5 wrong PINs. Not a cookie (cookies do not separate ports).
- From another device (Tailscale) every request needs the session, reading included.

## Broker flow and recovery (IBKR)

1. Approve (owner) → risk check again, kill switch, `liveTrading` for live accounts → row `sending` (reserves cash).
2. `sendToBroker`: session (paper gateway never sends for a live account), conid, `POST /iserver/account/{acct}/orders`
   with `cOID = desk-<installId>-<id>`. Result: `placed`, `confirm` (IBKR's question, shown in IBKR's words), `rejected`,
   or unknown (timeout, dropped, 5xx): stays `sending`, never sent again.
3. Confirm (owner, within 15 min) → quote age, stale move, risk check and session again → `POST /iserver/reply/{id}`.
4. `pollBroker` (each tick): `sending` older than 60 s is looked up by its cOID (`placed`) or, after 5 min, rejected with
   "check at IBKR"; executions are booked once (`exec:<id>`), mapped to a proposal only when account, cOID and conid
   match, never at fx = 1; order status sync (filled, cancelled, rejected; PendingCancel and Inactive still work); a
   placed order missing from the list for 24 h expires.
5. Reconcile: preview of IBKR positions and cash against the book; applying books differences and marks executions up
   to now as taken over, so nothing is booked twice.

## Adding a broker

Implement `Broker` in `src/broker.ts` (session, keepAlive, resolve, place, confirm, cancel, orders, executions,
positions, cash), only through `localJson` (localhost) or `httpJson`. Map its statuses to working/filled/cancelled/
rejected and its transport failures to `unknown` (never "rejected" when the order may work). Add the config shape in
`config.ts`, wire it in `index.ts`, and write contract tests against a local fake server following the broker's
documented paths and bodies (see `test/ibkr.test.ts`).

## Adding a quote feed

Implement `QuoteFeed` in `src/feed.ts`: `snapshot(symbols)` must return full `QuoteData` (name, currency, exchange,
type, session) or delegate to a fallback feed, and set `source` and `delayed` per quote; a push source calls the
`onQuotes` handlers and honours `subscribe`. Add the value to `quotes` in `config.ts` (default stays `yahoo`), wire it
in `index.ts`, add the source to `QuoteSource`, and contract-test it against a local fake.

`IbkrQuoteFeed` (config `"quotes": "ibkr"`, off by default) is a skeleton: `GET /iserver/marketdata/snapshot?conids=…&fields=31,84,86,6509`
on the gateway of the first IBKR account, verified against IBKR's documentation page "Live Market Data Snapshot"
(fields 31 Last Price, 84 Bid, 86 Ask, 6509 Market Data Availability; `/iserver/accounts` must be called first; the
first request per contract only starts the stream). It overrides price, bid, ask and time of the Yahoo quote when IBKR
has data, keeps Yahoo for everything else (meta, sessions, FX, crypto, failures, prices more than 20 % apart). Open:

- TODO push: IBKR's websocket streaming instead of polling the snapshot (not verified here).
- TODO meta from IBKR (contract details, trading hours) so Yahoo is not needed for IBKR symbols.
- TODO show `lastError` of the feed in the UI.
