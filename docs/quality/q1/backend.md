# Q1 audit – backend function

Scope: `apps/server/src` (desk, broker, market, http, db, config, app), `packages/shared/src` (portfolio, trading, csv,
schema), `cli/desk.py`. Audit only, no source changed. Audited at commit `77e6da8` (2026-10-16).

Runs: `npm test` 6 files / 104 tests passed; `node apps/server/src/index.ts --selftest` 18/18 ok;
`python cli/desk.py --selftest` 16/16 ok. All of these pass while the findings below reproduce; none of the
blockers is covered by a test.

How the findings were reproduced:

- HTTP probes against a fixture server: `node apps/server/src/index.ts --fixture --port 8192` (own temp home), owner
  calls with `Origin: http://127.0.0.1:8192` and `Content-Type: application/json`, agent calls without an Origin.
  Script: `probe1.mjs <case>` (cases `overflow`, `backdate`, `csvdup`, `cash`, `stack2`, `ibkr`, `fields`).
- In-process simulations with `makeFixture({ now })` (fake market, fake broker, clock you can move) and, for the
  timeout case, a local fake Client Portal Gateway: `node sim.ts <case>`, started from `apps/server`.
- Both scripts are in the auditor's scratchpad (`.../scratchpad/audit-backend/`). Each finding below has the minimal
  request or steps, so it can be rerun without them.

## Summary

| Id | Severity | Status | Title |
|----|----------|--------|-------|
| B1 | blocker | open | Any local process (an agent's shell) passes `userOnly` by sending an `Origin` header and approves its own orders |
| B2 | blocker | open | Overflow: `cents()` turns Infinity into 0, so a limit of 1e308 gets past every risk limit, shows "0,00 €" and fills |
| B3 | blocker | open | A gateway timeout on place/confirm is booked as "rejected" while the order works at IBKR; nothing recovers it |
| B4 | major | open | Approved but unfilled orders (placed/sending/confirm/open) reserve no cash and no position, so stacked approvals get past cash and position limits |
| B5 | major | open | Confirming IBKR's question skips the risk, stale and session checks, and "confirm" never expires |
| B6 | major | open | Approval and submit use a quote of any age; when a single symbol fails it stays hidden (market shows "live") |
| B7 | major | open | `cOID = desk-<id>` is not unique across databases; executions are mapped to a proposal without checking the conid |
| B8 | major | open | Reconcile, then an execution import, books the same IBKR fill twice |
| B9 | major | open | A backdated sell (manual trade, CSV, fill) passes the holdings check but FIFO books it before the buy: money created |
| B10 | major | open | IBKR `PendingCancel` is taken as final "cancelled", `Inactive` as "rejected"; later fills no longer update the proposal |
| B11 | major | open | A placed IBKR order that drops out of `/iserver/account/orders` stays "placed" forever |
| B12 | major | open | An IBKR execution in USD with no FX quote is booked at fx = 1 |
| B13 | major | open | The risk check at a limit fill leaves out the stop: risk per trade and stop rules are not checked again |
| B14 | major | open | `tick()` is O(filled stop proposals × trades): 18.5 s of event-loop blocking at 1 500 × 4 000 |
| B15 | major | open | "Abgleich prüfen" is broken in the browser: GET reconcile requires an Origin, which browsers do not send on same-origin GET |
| B16 | major | open | Host header is not checked: a DNS-rebinding page can read the whole portfolio, chat and SSE stream |
| B17 | major | open | CSV import values historic foreign-currency trades at today's FX rate |
| B18 | minor | open | CSV: two identical executions on the same day are silently dropped as duplicates; invalid and future dates are accepted |
| B19 | minor | open | `cashMove` accepts 1e308 (account turns into `null` for good), books -0,005 € as 0, rounds outside `cents()` |
| B20 | minor | open | IBKR keepAlive runs on the quote cadence (up to 3600 s, ×3 during a market error) instead of its own short cadence |
| B21 | minor | open | Chat `since` + `limit` returns the newest N, so `desk.py wait/read` loses older messages in a burst |
| B22 | minor | open | Reconcile compares IBKR "BASE" cash with EUR without checking the base currency (unconfirmed) |
| B23 | minor | open | IBKR commission is multiplied by the instrument's FX rate; its currency is assumed, not read (unconfirmed) |
| B24 | minor | open | The pre-migration backup copies only the main file of a WAL database (unconfirmed) |
| B25 | minor | open | No request body size limit: a 50 MB JSON body is read and parsed |
| B26 | minor | open | `maxOpenProposals` is counted per account and author, not per author as documented |
| B27 | minor | open | Stop and target reminders come from any old filled buy of the symbol, also after the position was closed and bought again |
| B28 | minor | open | Paper market orders and limits fill while the exchange is closed, at the last close |
| B29 | minor | open | IBKR partial fill then cancel: the proposal shows "storniert" with the full quantity, its fill is not recorded on it |
| B30 | polish | open | Broken JSON reads as `{}` (misleading message); approve with qty < 0.0000005 rejects the proposal instead of 400 |
| B31 | polish | open | `detail()`/`cockpit()` rebuild the FIFO book 3–4 times per account per request; N+1 queries in `positions()`/`toProposal()` |

Count: 3 blocker, 14 major, 12 minor, 2 polish.

---

## B1 – Agents can approve their own orders by sending an Origin header (blocker)

- **Where:** `apps/server/src/app.ts:55-64` (`c.set("origin", origin ? "web" : "cli")`), `app.ts:72-74` (`userOnly`),
  and every owner route that relies on it (approve, confirm, fill, cancel, kill switch, limits, reconcile, trades, cash).
- **Reproduce** (fixture server, the way an agent's Bash would do it):
  ```
  curl -s -X POST http://127.0.0.1:8192/api/proposals/1/approve -H "Content-Type: application/json" -d "{}"
  # -> 403 "Nur im Browser ..."
  curl -s -X POST http://127.0.0.1:8192/api/proposals/1/approve -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:8192" -d "{}"
  # -> 200 {"ok":true,"proposal":{"id":1,...,"status":"filled"}}
  curl -s -X PUT http://127.0.0.1:8192/api/risk/kill -H "Content-Type: application/json" -H "Origin: http://localhost:1" -d "{\"on\":false}"
  # -> 200, the kill switch is off (any port is accepted)
  ```
- **Expected / actual:** only the owner's click approves (CLAUDE.md: "Every order needs the owner's click"). In practice
  any process on the machine approves, confirms IBKR questions, turns off the kill switch or raises limits. The agents
  are Claude Code sessions with a shell, so they can send the header. A prompt injection in news or chat text is
  enough to make one do it.
- **Root cause (confirmed):** the Origin header is a CSRF defence against browsers. It does not authenticate anyone
  against a non-browser client.
- **Proposed fix:** give the owner a secret that agents cannot read. At startup, create a random token in a file that
  agent sessions cannot read (or keep it only in memory). Hand it to the browser in an HttpOnly, SameSite=Strict cookie
  on `GET /` (or through a one-time login link the server prints). Owner routes then need the cookie plus a matching
  CSRF header. Keep the Origin check as a second layer. Also restrict `LOCAL_ORIGIN` to the desk's own port. Record the
  trust model in CLAUDE.md: agents run as the same OS user, so a file in `~/.tradedesk` alone does not protect it. A
  per-start token printed to the console, or an OS keychain entry, does.
- **Test:** an HTTP test where a request with `Origin: http://127.0.0.1:<port>` but without the owner cookie or token
  gets 403 on approve, confirm, kill, limits, fill, cancel and reconcile.

## B2 – Overflow in the risk check: limit 1e308 passes, shows 0 € and fills (blocker)

- **Where:** `packages/shared/src/portfolio.ts:6-10` (`cents()` returns 0 for non-finite values),
  `portfolio.ts:195-219` (`checkOrder` compares estimate and risk against limits), `ProposalInputSchema`
  (`schema.ts:207-211`, `positive().finite()` without an upper bound).
- **Reproduce** (agent, no Origin, then the owner's approve):
  ```
  POST /api/proposals {"author":"Atlas","accountId":"agent-atlas","symbol":"SAP.DE","side":"buy","qty":100000,
                       "orderType":"limit","limitPrice":1e308,"stopLoss":1,"confidence":0.9,"thesis":"x"}
  -> 200 ok:true, check.estimateCents 0, violations [], proposal.estimateCents 0 (UI: "0,00 €")
  POST /api/proposals/<id>/approve (owner) -> 200 status "filled", fillPrice 201.25
  agent-atlas cash: 568 125 -> -2 011 931 975 cents (-20,1 Mio. €)
  ```
- **Expected / actual:** a violation (order too large, not enough cash). Actually all limits pass (cash, max order,
  position, risk per trade). The owner sees a 0 € order, and approving it buys 100 000 shares at market. On IBKR it
  would send `LMT BUY 100000 @ 1e308`, which is a marketable order.
- **Root cause (confirmed):** `qty * 1e308 * fx` = Infinity, `cents(Infinity)` = 0, so the check fails open. Any
  non-finite intermediate value does the same.
- **Proposed fix:** a non-finite value must be a violation, never 0. `checkOrder` should reject any estimate or risk
  that is not finite. `cents()` should throw (or return NaN and let callers refuse) instead of returning 0. Put sane
  upper bounds in the schema (qty ≤ 1e7, prices ≤ 1e7). Refuse limits more than X % from the quote (for example 50 %)
  instead of only warning. In the paper engine, fill a limit buy at min(limit, price) and check the estimate at the
  fill price.
- **Test:** `checkOrder` with `limitPrice: 1e308` (and a stop of 1e308) gives `ok: false`. A desk test confirms that
  proposal is never created. A property test runs `checkOrder` over extreme doubles and checks that `estimateCents` is
  finite whenever `ok` is true.

## B3 – Timeout on place/confirm is booked as rejected while the order works at IBKR (blocker)

- **Where:** `apps/server/src/broker.ts:175-179` (place: every exception becomes `{kind:"rejected"}`),
  `broker.ts:182-187` (confirm, same), `desk.ts:752-753` / `desk.ts:767-770` (applyPlace sets `rejected`),
  `desk.ts:802-807` (recovery only looks at `sending`).
- **Reproduce:** `node sim.ts timeout` starts a local fake gateway. It accepts `POST /iserver/account/DU123456/orders`,
  lists the order (`order_ref: desk-4`, Submitted) and answers only after 12 s. The desk's limit is 10 s.
  ```
  after approve (gateway slow): rejected  "Interactive Brokers: nicht erreichbar (keine Antwort nach 10 s)"
  gateway has working order: [{ orderId: 555, order_ref: 'desk-4', status: 'Submitted' }]
  after poll 10 min later: rejected  brokerOrderId null
  ```
- **Expected / actual:** an unknown outcome must stay "sending" (unknown) until `orders()` finds or misses the cOID.
  Actually the desk tells the owner and the agent "abgelehnt" while a real order is working. When it fills, the
  execution is booked, but the proposal stays rejected with no cancel button. The owner may approve a second proposal
  and end up with a double position.
- **Root cause (confirmed):** transport errors (timeout, connection reset, HTTP 5xx) are mixed up with an answer from
  the broker.
- **Proposed fix:** `place`/`confirm` return a third kind, `unknown`, for transport errors and 5xx. `applyPlace`
  leaves the row in `sending` with `decided_at` set to now. The existing recovery in `pollBroker` then finds the cOID
  or, after 5 minutes, tells the owner to check. Only an explicit `error` body from IBKR counts as rejected. Also catch
  an exception from `broker.place` in `sendToBroker` (today it reaches the route as a 500).
- **Test:** a contract test against the fake gateway with a delayed or dropped response. After approve the status is
  `sending`, and after `pollBroker` it is `placed` with the order id.

## B4 – Approved orders reserve nothing: stacked approvals get past cash and position caps (major)

- **Where:** `desk.ts:488-508` (`check` reads only booked trades), `desk.ts:536` (only pending proposals are counted,
  and only for `maxOpenProposals`), `desk.ts:598-600` (manual: `placed`), `desk.ts:595` (broker: `sending`/`placed`).
- **Reproduce** (`probe1.mjs stack2`, manual account `tr`, cash 9 619,70 €, equity 19 339,80 €, max position 25 %):
  three agent proposals `buy 11 MSFT, stop 404` (4 239,27 € each, 21.9 % each), all accepted, all approved, all
  `placed`. Together that is 12 717,81 € against 9 619,70 € cash and 66 % of the account in one symbol. The same goes
  for IBKR (`sending`/`placed`/`confirm`) and for two sells of the whole holding.
- **Expected / actual:** each approval checks against holdings plus everything already approved and not yet done.
  Actually only booked trades count.
- **Root cause (confirmed):** there is no reservation for active orders.
- **Proposed fix:** in `check`, subtract the value and fees of active buys (`placed`, `sending`, `confirm`, `open`,
  using `approved_qty`) from cash. Add them to the position value of the symbol. For sells, subtract active sells from
  `heldQty`. Do this at submit (also count pending proposals for the position cap, or at least warn) and at approval.
- **Test:** a desk test approves two proposals for a manual account that each fit alone but not together. The second
  approval ends as `rejected` with a cash or position violation.

## B5 – Confirm sends without checks again; "confirm" never expires (major)

- **Where:** `desk.ts:774-785` (`confirmBroker` checks only the kill switch and liveTrading), `desk.ts:1367` (`expire`
  covers only `pending/open/placed`).
- **Reproduce:** `node sim.ts confirm-norecheck` and `confirm-expiry`.
  ```
  approve (replyAbove=1) -> confirm
  10 days later, SAP +30 %, maxOrderCents 1 000, maxPositionPct 1, tick -> still "confirm"
  confirmBroker -> placed, broker order 1001   (market order sent)
  confirm-expiry: 60 days later -> still "confirm"
  ```
- **Expected / actual:** confirming is the moment the order is actually sent, so the full approval checks (quote
  freshness, stale move, `checkOrder`, paper/live session) must run again, and an unanswered question must expire.
  Actually a days-old market order goes out unchecked.
- **Root cause (confirmed):** confirm was added as a transport step, not as a decision.
- **Proposed fix:** run `refresh` + stale check + `check()` + session paper/live check in `confirmBroker` before
  claiming the row. Let `expire()` also handle `confirm` (for example after 15 minutes; IBKR reply ids are short-lived
  anyway), and handle `sending` through the recovery.
- **Test:** confirm after a 5 % move goes to `stale`. Confirm after tighter limits goes to `rejected`. A tick after
  the TTL expires a `confirm` row.

## B6 – Quotes of any age at approval and submit; a failing symbol stays hidden (major)

- **Where:** `desk.ts:623` (`approve` refreshes but does not check the result), `desk.ts:180-183` (`ensureFresh`),
  `desk.ts:134-140` (`priced` has no age limit), `market.ts:152` (an error is reported only when all symbols fail),
  `desk.ts:608` (paper fill at that price).
- **Reproduce:** `node sim.ts stale-quote`. A proposal for ALV.DE is made, then the market fails (`failing = true`) and
  the real price drops from 352.10 to 250.
  ```
  approve 20 h later while market fails: filled, fill at 352.1, market state error
  submit with 20 h old quote: ok true, check.price 352.1
  ```
  With Yahoo, a 429 or error for just the approved symbol leaves `marketState` at "live" (`quotes.length > 0`).
- **Expected / actual:** when the quote is older than, say, 2 minutes, approval refuses ("kein aktueller Kurs") for
  market orders and for every IBKR order. Actually the risk check, the stale check and the paper fill all use a
  hours-old price.
- **Root cause (confirmed):** freshness is never checked. `fetched_at` exists but is not used for decisions.
- **Proposed fix:** `priced()` gets a `maxAgeMs` option. `submit`, `execute`, `confirmBroker` and `fillLimits`
  require `now - fetched_at <= QUOTE_FRESH_MS * 2` (FX too). Report errors per symbol from `quotes()` and show them
  (`missingQuotes` and a market warning when some symbols fail).
- **Test:** `market.failing = true`, move the clock 10 minutes, approve: the result is `rejected` with a
  quote-age reason, and nothing is filled.

## B7 – Client order id not unique across databases; executions mapped without a conid check (major)

- **Where:** `desk.ts:752` (`cOID: desk-${id}`, proposal id is `INTEGER PRIMARY KEY`, restarts at 1 in a new or
  restored DB), `desk.ts:829-831` (`importExecution` takes `proposal.symbol` without comparing `e.conid` with
  `proposal.broker_conid`), `desk.ts:803` / `desk.ts:810` (recovery and status matched by cOID only).
- **Reproduce:** `node sim.ts coid`. An execution from an earlier database `{cOID:"desk-4", conid: AAPL, qty 50,
  price 190}` sits in IBKR's 7-day trade list.
  ```
  ibkr proposal 4 SAP.DE
  booked trades ibkr: [['SAP.DE', 50, 190, 'proposal', 4]]   (an AAPL fill booked as SAP.DE)
  ```
  The same happens after restoring `desk.sqlite.v2.bak`, after a fresh `~/.tradedesk`, or when two desks (for example
  a test instance with a real gateway) share one IBKR account. IBKR also rejects duplicate cOIDs for the account, so
  the new order `desk-4` is refused.
- **Expected / actual:** a cOID that is unique forever. An execution is linked to a proposal only if the account,
  cOID and conid all match.
- **Root cause (confirmed):** the id is unique only within one database file.
- **Proposed fix:** store an installation id (random, in the `setting` table) and use
  `desk-<install>-<id>-<attempt>`. In `importExecution` require `e.conid === proposal.broker_conid`. Otherwise treat
  it as foreign (`symbolOfConid`) and raise an event.
- **Test:** an execution whose cOID matches but whose conid differs is not booked under the proposal's symbol.
  `sendToBroker` sends a cOID that contains the installation id.

## B8 – Reconcile, then execution import: the same fill booked twice (major)

- **Where:** `desk.ts:832-838` (an unmapped execution is skipped without remembering its id), `desk.ts:876-886`
  (`applyReconcile` books the difference and `rememberConid`), `desk.ts:808` (the next poll then imports the old
  execution).
- **Reproduce:** `node sim.ts reconcile-double`. A TWS buy of 10 AAPL (no cOID, unknown conid) leads to the event
  "Kontrakt ohne Symbol". The owner adds the conid to config and runs "Abgleich übernehmen", then the next tick runs.
  ```
  after applyReconcile: AAPL 10 -> after next tick: AAPL 20   (broker holds 10)
  reconcile differences now: 2 [['AAPL', 10, 20]]
  ```
  This is exactly the way the event text advises ("in config.json unter conids zuordnen, dann ... abgleichen").
- **Expected / actual:** the broker shows 10, the desk shows 10. Actually the desk shows 20, with 2 300 € more cost and
  cash 2 300 € too low.
- **Root cause (confirmed):** reconcile entries and execution imports do not know about each other.
- **Proposed fix:** when `applyReconcile` books a difference, mark the open executions of that conid from the current
  `executions()` list as consumed (insert their `exec:<id>` keys, or record a reconcile watermark time per conid and
  skip executions before it). Better still, have reconcile first import the mapped executions and book only the
  remaining difference.
- **Test:** the sequence above ends with deskQty = brokerQty and `differences = 0`.

## B9 – Backdated sell creates money (major)

- **Where:** `desk.ts:917` (`recordTrade` checks the sell against holdings **today**), `desk.ts:912` and `desk.ts:671`
  (any `time > 0` is accepted), `csv.ts` (`importCsv` does not check sells at all), `portfolio.ts:76-106` (FIFO sorted
  by time: a sell before any lot books `soldQty = 0`, but `sellsCents` gets the full proceeds).
- **Reproduce** (`probe1.mjs backdate`, owner):
  ```
  POST /api/accounts/tr/trades {"symbol":"ALV.DE","side":"buy","qty":10,"price":300}
  POST /api/accounts/tr/trades {"symbol":"ALV.DE","side":"sell","qty":10,"price":300,"time":<now - 1 day>}
  -> realizedCents 0, ALV.DE position still 10, cash +2 999 €, equity 16 280,05 € -> 19 279,05 €
  ```
- **Expected / actual:** either the sell is refused (no holdings at that time) or FIFO matches it. Actually the shares
  stay and the proceeds are credited: equity +3 000 € from nothing. Deleting a buy that later sells depend on gives the
  same kind of mismatch.
- **Root cause (confirmed):** validation uses the current book, valuation uses time order. Also `buildBook` adds
  unmatched sell proceeds to cash.
- **Proposed fix:** check a new trade by rebuilding the book with it included and refusing when any sell would oversell
  at its own time. Do the same for CSV rows, for `fill` and before `deleteTrade` of a buy. Refuse `time` before the
  first deposit or in the far past. In `buildBook`, return the oversold quantity so the API can flag it instead of
  crediting it silently.
- **Test:** `recordTrade` of a sell dated before the buy gets 400. `buildBook` with a sell before the buy reports the
  oversell.

## B10 – PendingCancel taken as final cancel, Inactive as rejected (major)

- **Where:** `broker.ts:88-94` (`ibkrStatus`), enshrined in `test/ibkr.test.ts:116`, used in `desk.ts:817-819`.
- **Reproduce:** `node sim.ts pendingcancel` gives `PendingCancel → cancelled | Inactive → rejected`. In `pollBroker`
  the proposal goes `placed → cancelled` while IBKR is still working the cancel. If the order fills in that window, the
  execution is booked but the proposal stays "storniert" (the UPDATE requires `status = 'placed'`). No stop reminder
  follows (`checkStops` needs `filled`), and the agent is told it was cancelled. `Inactive` in IBKR can be temporary
  (for example outside regular trading hours, or waiting on a precaution check).
- **Expected / actual:** only `Cancelled`/`ApiCancelled` count as final. `PendingCancel`/`PendingSubmit`/`Inactive`
  count as working (Inactive with a warning).
- **Root cause (confirmed):** the mapping is too eager. Also a final status is never corrected by later executions.
- **Proposed fix:** map `pendingcancel` to working. Change the test. In `pollBroker`, once an execution of a
  cancelled/rejected proposal arrives, set it to `filled` (or a partial status) and tell the owner.
- **Test:** `ibkrStatus("PendingCancel") === "working"`. A desk test: cancel, poll with PendingCancel, then Filled
  gives proposal `filled`.

## B11 – A placed IBKR order that drops off the order list stays "placed" forever (major)

- **Where:** `desk.ts:809-811` (`if (!o) continue`), `desk.ts:1367` (`expire` skips `broker_order_id IS NOT NULL`).
- **Reproduce:** `node sim.ts placed-stuck`. A limit order is `placed`, then the fake broker forgets it (as IBKR does
  with a DAY order the next session). 30 days and a tick later it is still `placed` and in `status=active`.
- **Expected / actual:** after the order's lifetime (DAY: the next session) an order that is no longer listed counts as
  expired or cancelled, after a check against the executions. Actually it stays an active order forever, its symbol is
  quoted on every tick, and the owner's "Storno" sends a DELETE for an order that no longer exists.
- **Root cause (confirmed):** missing from the list is treated as "no news".
- **Proposed fix:** remember `last_seen_at` per placed order. When an order has not been seen for more than one session
  (or more than 24 h) and its executions do not cover the quantity, set it to `expired` with the reason "bei IBKR nicht
  mehr gelistet – dort prüfen" and raise an event. Call `/iserver/account/orders?force=true` once after startup.
- **Test:** the fake broker drops the order, the clock moves 2 days, a tick runs: status `expired`, with an event.

## B12 – USD execution without FX booked at fx = 1 (major)

- **Where:** `desk.ts:840-843` (`const fx = this.fx(currency) ?? 1`), and the same in `applyReconcile`
  (`desk.ts:885`).
- **Reproduce:** `node sim.ts fx-missing` (USDEUR=X deleted, market failing, execution of 10 MSFT at 418.90 USD):
  `[[10, 418.9, 'USD', 1, 418900]]`. The trade is booked at 4 189,00 € instead of about 3 854 €, permanently, with no
  warning.
- **Expected / actual:** without an FX rate the execution is not booked yet (it is retried on the next poll; IBKR
  keeps 7 days) or is booked at a rate from the broker. Actually it is silently booked about 9 % wrong.
- **Root cause (confirmed):** a fallback value used for money.
- **Proposed fix:** skip the import (it stays idempotent through the `exec:` key) until `fx` is known, and raise an
  event once. Better: use IBKR's own `net_amount`/FX from the trade or the ledger. Also use the FX rate at execution
  time, not at import time.
- **Test:** an execution with no FX quote is not booked. After the FX quote arrives, it is booked once at the correct
  rate.

## B13 – Limit fill check does not include the stop (major)

- **Where:** `desk.ts:1351` (`this.check(a, { side, qty, orderType: "market", symbol })`, without `stopLoss`,
  `takeProfit` or `byAgent`).
- **Reproduce:** `node sim.ts limitfill-risk`. An agent's limit buy of 2 ALV.DE at 340 with stop 300 is approved and
  `open`. The owner tightens `maxRiskPct` to 0.1 %, then the price crosses to 339 and a tick runs: the order is
  `filled`. The risk is 80 € = 0.76 % of 10 456 €, and the limit is 0.1 %.
- **Expected / actual:** CLAUDE.md says the risk check runs "again at a limit fill". The stop and risk-per-trade parts
  are left out, and so is the agent's require-stop rule.
- **Root cause (confirmed):** incomplete arguments.
- **Proposed fix:** pass `stopLoss: r.stop_loss, takeProfit: r.take_profit` and `byAgent: r.author !== cfg.user`
  (orderType market is fine, because the fill uses the current price).
- **Test:** the scenario above ends `cancelled` with the risk-per-trade reason.

## B14 – tick() is O(filled stop proposals × trades) and blocks the event loop (major)

- **Where:** `desk.ts:1383-1386` (`checkStops`: for each filled buy with an unfired stop or target, `this.book()`
  rebuilds the whole FIFO book). Such rows never leave the query when the position was sold before the stop.
- **Reproduce:** `node sim.ts perf` (4 000 trades and 1 500 filled stop proposals in agent-atlas, roughly 3 agents
  × 10 day trades × 50 days):
  ```
  overview() 18.8 ms, cockpit() 87.0 ms, detail() 39.4 ms, agentsData() 27.5 ms
  tick() 18 519.9 ms (synchronous, blocks the event loop)
  ```
  For those 18 s per tick, the API, the SSE stream, approvals and IBKR polling all stand still. With the 15 s live
  cadence the desk is busy all the time.
- **Expected / actual:** a tick takes milliseconds. Actually it grows quadratically.
- **Root cause (confirmed):** the book is rebuilt per row, and finished reminders are never closed.
- **Proposed fix:** build each account's book once per tick (cache by account within the tick, or memoise on the
  trade table version). Close the reminder (`stop_hit_at = -1` or a `closed_at`) once the position the proposal opened
  is gone. Also cache `summary()` per tick for `cockpit`/`overview`.
- **Test:** a performance test with 5 000 trades and 2 000 filled proposals: `tick()` under 200 ms. A unit test:
  after the position is sold, the proposal no longer appears in `checkStops`.

## B15 – Reconcile preview cannot work in a browser (major)

- **Where:** `app.ts:173-176` (`GET /api/accounts/:id/reconcile` calls `userOnly`). `app.ts:62` treats a request with
  no Origin as an agent. Browsers send no Origin on a same-origin GET. The caller is
  `apps/web/src/modules/portfolio/BrokerPanel.tsx:23`.
- **Reproduce:** in the built-in browser on `http://127.0.0.1:8192/`:
  `await fetch('/api/accounts/ibkr/reconcile', {headers:{Accept:'application/json'}})` gives **403**
  "Nur im Browser – das entscheidet der Mensch, nicht ein Agent."
- **Expected / actual:** "Abgleich prüfen" shows the comparison. Actually it always fails, so "Abgleich übernehmen"
  can only be used blind. The unit test calls `desk.reconcile` directly, and e2e does not cover it.
- **Root cause (confirmed):** an Origin check used on a GET.
- **Proposed fix:** make the preview `POST /api/accounts/:id/reconcile/preview` (it has side effects anyway:
  `pollBroker` books executions). Or base `userOnly` on the owner token from B1.
- **Test:** an e2e test (Playwright) clicks "Abgleich prüfen" and sees the table. An HTTP test checks that the preview
  route is not a GET.

## B16 – No Host check: DNS rebinding reads the portfolio (major)

- **Where:** `app.ts:55-64` checks the Origin only for non-GET requests and never checks `Host`. The server binds to
  127.0.0.1 (`index.ts:166`), which does not protect against DNS rebinding.
- **Reproduce:** `curl -s http://127.0.0.1:8192/api/overview -H "Host: evil.example:8192"` returns 200 with all
  accounts. A web page on `evil.example` that rebinds to 127.0.0.1 is same-origin to itself. It can GET
  `/api/overview`, `/api/accounts/tr`, `/api/chat` and `/api/stream` and read the answers. Its POSTs are refused
  (Origin evil.example).
- **Expected / actual:** only `Host: 127.0.0.1:<port>` / `localhost:<port>` is accepted. Actually any host is.
- **Root cause (confirmed):** the Host header is not checked.
- **Proposed fix:** middleware for all routes that answers 421/403 unless the Host is in
  `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}`.
- **Test:** a GET with `Host: evil.example` gets 403 on `/api/overview` and on `/`.

## B17 – CSV import uses today's FX rate for historic trades (major)

- **Where:** `desk.ts:957` and `desk.ts:964` (`fx = quoteRow(fxSymbol(currency)).price`, the current rate).
- **Reproduce** (by reading, plus the `csvdup` probe for the path): a line
  `2025-01-02;AAPL;kauf;10;180,00;1,00;USD` imported today is booked at today's USD/EUR (fixture 0.92) instead of the
  rate on 2025-01-02. That shifts cost basis, realized P/L and tax figures by the FX move since then (several percent).
- **Expected / actual:** historic trades are valued at the rate of their date, or the CSV must give the EUR amount.
- **Root cause (confirmed):** the only FX source is the live quote.
- **Proposed fix:** accept an `fx` or `betrag_eur` column, and refuse foreign-currency lines without it. Or load the
  historic daily FX from Yahoo (`USDEUR=X` 1d candles) for the trade date. Show the rate used in the import result.
- **Test:** importing a USD row with an `fx` column books `value_cents = qty*price*fx`. A USD row without it is
  refused with a clear message.

## B18 – CSV: identical trades dropped, invalid and future dates accepted (minor)

- **Where:** `csv.ts:115` (`key = time|symbol|side|qty|price|fee`), `csv.ts:60-66` (`new Date(2026, 1, 30)` rolls
  over, and there is no end anchor on the ISO pattern), `desk.ts:962-972` (no future-date check).
- **Reproduce** (`probe1.mjs csvdup`): two identical lines `2026-03-02;SAP.DE;kauf;1;180,00;0`, one line
  `2026-02-30;...` and one `2027-01-01;...` give `imported 3, skipped 1, errors []`. The second real buy is lost, Feb
  30 becomes Mar 2, and a trade dated 2027 is booked.
- **Proposed fix:** make the key line-occurrence aware (for example `key#n` for the n-th identical row within the
  file). Check day and month after building the date. Refuse dates in the future.
- **Test:** a parser test with two identical rows imports 2, and importing the same file again imports 0. `30.02.2026`
  is an error.

## B19 – cashMove: Infinity, sub-cent and rounding (minor)

- **Where:** `desk.ts:940-941` (checks `amountEur` is finite, but not `amount`; `Math.round` instead of `cents()`),
  also `desk.ts:670`, `desk.ts:911` and `csv.ts:115` for fees.
- **Reproduce** (`probe1.mjs cash`, owner): `amountEur: 1e308` gives 200 and stores Infinity. From then on `papier`
  shows `cashCents: null, equityCents: null` (this breaks the response schema) and every check on that account fails.
  It can only be repaired in SQL. `1e20` stores 1e22 cents (beyond 2^53). `-0.005` gives `amountCents 0` (a 0 €
  "Auszahlung" is booked). `10.005` gives 1001.
- **Proposed fix:** use `cents()` everywhere. Require `Number.isSafeInteger(amount)` and `amount !== 0`, and set a
  sane bound (for example 100 Mio. €).
- **Test:** cashMove with 1e308 and with -0.004 gets 400.

## B20 – IBKR keepAlive tied to the quote cadence (minor)

- **Where:** `desk.ts:1326` (`pollBroker`, the only `tickle`, runs inside `tick`), `desk.ts:1417` (interval
  `quoteIntervalSec`, ×3 during a market error), `config.ts:108` (`quoteIntervalSec` up to 3600).
- **Reproduce (by reading):** with no browser open, `quoteIntervalSec: 300`, or 120 during a Yahoo failure (×3 = 360
  s), the gateway gets no request for more than about 5 minutes and drops the brokerage session. Fills are then only
  noticed on the next login, and approvals fail with "nicht angemeldet".
- **Proposed fix:** a separate broker timer, every 60 s (the IBKR recommendation), independent of market state. Clamp
  it so it never exceeds 4 minutes.
- **Test:** a desk with `quoteIntervalSec: 3600` and a fake broker that counts `keepAlive` calls: at least 1 per
  minute.

## B21 – Chat paging drops older messages (minor)

- **Where:** `desk.ts:1278-1285` (`WHERE id > ? ORDER BY id DESC LIMIT ?`), used by `cli/desk.py:266-297`
  (`read`/`wait`, which then set `since` to the max).
- **Reproduce:** post 5 messages, then `GET /api/chat?since=<before>&limit=2` returns only `msg 4`, `msg 5`. The CLI
  marks everything up to 5 as read, so messages 1–3 (possibly the desk's "#12 abgelehnt" for this agent) are never
  shown.
- **Proposed fix:** when `since` is given, return the oldest N (`ORDER BY id ASC LIMIT ?`) and add `more: true`. The
  CLI then loops until it has caught up.
- **Test:** an API test where `since` + `limit` returns the next N in order. A CLI selftest with more than `limit` new
  messages shows all of them.

## B22 – Reconcile cash compared without its currency (minor, unconfirmed against a real gateway)

- **Where:** `broker.ts:223-227` (`ledger.BASE.cashbalance`, currency hard-coded as "BASE"), `desk.ts:867-889`
  (compared with EUR cents, and the difference is booked as a cash_move).
- **Risk:** for an account with base currency USD, "Abgleich übernehmen" books a USD amount as EUR.
- **Fix:** read `ledger.EUR` (or the BASE entry's `currency` field) and refuse when the base is not EUR. **Test:** a
  ledger with base USD shows an error and books no cash_move.

## B23 – Commission currency assumed (minor, unconfirmed)

- **Where:** `desk.ts:843` (`feeCents = commission * fx(instrument currency)`), `broker.ts:35` (the comment says
  "Kontowährung").
- **Risk:** the comment and the code disagree. If IBKR reports the commission in the base currency (EUR) for a USD
  trade, the fee is booked about 8 % low, and the other way round.
- **Fix:** take the commission currency from the trade record (or from `/iserver/account/trades` `comission_currency`
  if present) and convert with that. **Test:** a contract test with an EUR commission on a USD trade.

## B24 – Migration backup of a WAL database copies only the main file (minor, unconfirmed)

- **Where:** `db.ts:365-366` and `db.ts:395` (`copyFileSync(file, …bak)` after opening in WAL mode, without a
  checkpoint).
- **Risk:** after a crash, committed pages that are still only in `desk.sqlite-wal` are missing from the `.bak`. The
  backup is then older than it looks, or inconsistent.
- **Fix:** `raw.exec("PRAGMA wal_checkpoint(TRUNCATE)")` before copying, or `VACUUM INTO '<bak>'`. **Test:** write in
  WAL without a checkpoint, reopen with a pending migration, and check that the `.bak` contains the row.

## B25 – No body size limit (minor)

- **Where:** `app.ts:75` (`c.req.json()` without a limit).
- **Reproduce** (`probe1.mjs fields`): `POST /api/chat` with a 50 MB JSON body gives 200 after reading and parsing
  everything. Any agent can tie up memory and the event loop.
- **Fix:** Hono `bodyLimit` (for example 2.5 MB for import, 64 KB elsewhere). **Test:** a 3 MB chat body gets 413.

## B26 – maxOpenProposals per account instead of per author (minor)

- **Where:** `desk.ts:536` (`WHERE account_id = ? AND author = ?`). `schema.ts:103` and the UI say "je Autor".
- **Effect:** with 3 owner accounts plus its own, an agent can keep 4 × limit proposals pending.
- **Fix:** count per author over all accounts (or rename the limit). **Test:** with limit 1, an agent's pending
  proposals on two different accounts give one violation.

## B27 – Stale stop reminders on a position bought again (minor)

- **Where:** `desk.ts:1383-1398` (any filled buy whose stop has not fired and whose symbol is held again). In
  `positions()` (`desk.ts:240-243`) the shown stop is that of the last filled proposal, even when the current lots
  came from a manual trade.
- **Effect:** an old closed trade's stop (for example 300) fires "Stop-Loss erreicht" for today's position bought by
  hand at 250.
- **Fix:** close the reminders of a proposal when its lots are gone (see B14). **Test:** buy, sell all, buy again by
  hand, then the price falls below the old stop: no reminder.

## B28 – Paper fills while the exchange is closed (minor)

- **Where:** `desk.ts:603-611` and `desk.ts:1344-1361` (no `sessionOf` check).
- **Effect:** on a Saturday an agent's paper market order fills at Friday's close, with knowledge of weekend news.
  Agent performance on paper (the owner's basis for trust) looks better than it is.
- **Fix:** paper market orders only while the session is open (otherwise "open" until the next open). Limits fill only
  on quotes with `market_time` inside the session. **Test:** the fixture clock on a Saturday: an approved market order
  stays open.

## B29 – Partial fill then cancel loses the partial state (minor)

- **Where:** `desk.ts:814-820` (only `filled`/`cancelled`/`rejected`; `approved_qty`/`fill_price` are not updated from
  `filledQty`/`avgPrice`).
- **Effect:** 3 of 10 filled, then cancelled: the proposal says "storniert, 10 Stück", while the trades show 3.
- **Fix:** store `filled_qty` and `avg_price`, and show "teilweise ausgeführt". **Test:** fake broker partial fill +
  cancel: the proposal shows 3/10.

## B30 – Small input handling issues (polish)

- `app.ts:75`: broken JSON is read as `{}`. `POST /api/proposals` with body `{` answers "author – expected string,
  received undefined". It should answer 400 "Ungültiges JSON".
- `desk.ts:620-621`: `approve {qty: 1e-7}` passes `> 0`, rounds to 0, and the proposal ends `rejected` ("Stückzahl muss
  größer als 0"). It should be a 400 that leaves the proposal pending.
- `desk.ts:516`: unknown fields (`status`, `approvedQty`) are dropped silently but stored in `raw`. That is harmless.
  Consider `.strict()` for agent input, so typos like `stoploss` are refused instead of being treated as "no stop".

## B31 – Repeated computation per request (polish)

- `detail()` builds the FIFO book 3 times (summary, positions, trades). `cockpit()` builds it about 4 times per account
  plus `remindClose → cockpit()` inside the tick. `positions()` runs 3 queries per holding, and `toProposal()` runs 2–3
  per row (300 rows gives about 900 queries). This is measured fine today (cockpit 87 ms at 4 000 trades) but grows
  linearly per request. Cache the book per account per `trade` change (a version counter).

---

## Checked and fine

- Double click and approve/reject/cancel/tick races: `execute` claims `WHERE status = 'pending'` inside a synchronous
  transaction, and the second click gets 409 (selftest "double click executes once" and a manual check). `fill`,
  `confirm` and `cancel` claim the same way.
- Approval only shrinks the quantity (`desk.ts:620`). The stale check covers agent proposals.
- The liveTrading gate is on `execute` (approve and the owner's own web orders) and on `confirmBroker`. A paper session
  with a live account is refused at send. The live/paper flag comes from the account number (`config.ts:75`), so a
  config typo cannot turn a live account into "paper".
- Selling what is not held is refused at submit, approval and the manual fill. Agents may only propose for their own
  account or the owner's.
- The symbol regex is applied at every entry (normalizeSymbol, CSV, conids). The allow-list is the watchlist or the
  holdings.
- `localJson` allows only localhost, as checked by its test.
- Migrations are positional, run in a transaction per step, detect a downgrade, and back up before migrating (but see
  B24).
- Day boundaries use the local calendar date (`startOfDay`, `dayKey`), so they are DST-safe. Day change subtracts
  deposits.
- Chat: mentions only of known names, agent text is stored as plain text, the role comes from the origin, and a chat
  message has no path to approve anything.
- CLI exit codes: 0 ok, 1 refused or error, 2 not reachable, 3 wait timeout. The CLI never sends an Origin (selftest).

## Missing tests (for the paths above)

1. An owner route with a spoofed Origin but without the owner secret gets 403 (B1).
2. `checkOrder`/`submit` with extreme doubles (1e308, a stop near 0, qty 1e9) and an assertion that the estimate is
   finite (B2).
3. Gateway timeout or 5xx on place and on confirm leaves the row in `sending`, and recovery finds the cOID (B3).
4. Two approvals that only fit one at a time, for manual and IBKR accounts (B4).
5. Confirm after a price move, a limit change or the TTL (B5).
6. Approval while the market fails and the quote is older than the freshness limit (B6).
7. An execution with a matching cOID but a different conid, and a cOID with an installation id (B7).
8. The reconcile-then-poll sequence ends with `differences = 0` (B8).
9. A backdated sell, a CSV with a sell before its buy, and deleting a buy that later sells depend on (B9).
10. The ibkrStatus table for PendingCancel/Inactive/PendingSubmit, and a fill after PendingCancel (B10).
11. A placed order missing from the order list for more than one session (B11).
12. Execution import without FX (B12). A limit fill with risk per trade (B13). Tick performance at scale (B14).
13. An e2e test of "Abgleich prüfen" in the browser (B15). A request with a foreign Host header (B16). A historic FX
    case in CSV import (B17).
14. Chat `since` with more than `limit` new messages, in the API and in the CLI (B21).
