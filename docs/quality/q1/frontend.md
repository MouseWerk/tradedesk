# Q1 audit: frontend function (UI logic, data flow, robustness, performance)

Scope: `apps/web` at commit 77e6da8 (dist built from it). Method: code reading of every module plus a Playwright
script against an own fixture server (`--fixture --port 8193`, Chromium headless, de-DE, Europe/Berlin, 1440 px unless
noted); network delays, failures and response variants were injected with `page.route` or a small local proxy in
front of the fixture server (SSE cut). The script was deleted afterwards; screenshots and raw results are in the
session scratchpad (`audit-frontend/`). "Reproduced" means seen in the running app; "code-confirmed" means the cause is
read in the code but the effect was not observed; "unconfirmed" is a suspicion.

## Summary

| Id | Severity | Status | Title |
|---|---|---|---|
| F1 | major | fixed | Order calculator: submit enabled and confirm dialog shows the estimate of the previous quantity while the dry run is pending |
| F2 | major | fixed | Global `placeholderData` shows the previous symbol's indicators and chart (and the previous account) under the new header |
| F3 | major | fixed | Order ticket keeps the account from its first mount: deep link sends `accountId: ""`, after switching it preselects the other depot |
| F4 | major | fixed | Enter in the auto-focused quantity field sends broker orders (approve dialog, order ticket) |
| F5 | major | fixed | "Position schließen" always reports "geschlossen", also for `rejected`, `confirm` and `placed` |
| F6 | major | fixed | `parseDe("1.000")` is 1: German thousands separators are read as decimals in every money and quantity field |
| F7 | major | fixed | Live stream: nothing is reloaded after a reconnect (chat messages lost), and after an HTTP error it stays "Offline" for good |
| F8 | major | fixed | Failed or schema-mismatched queries show an endless skeleton; the error text never appears; top bar says "Vorschläge 0" |
| F9 | major | fixed | Arrow keys in the cockpit follow the API order, not the sorted scanner the owner sees |
| F10 | major | fixed | Order calculator cannot size non-EUR symbols that no account holds, and blames the stop |
| F11 | minor | fixed | Risk limits: a value typed into the next field is overwritten by the refetch of the previous commit |
| F12 | minor | fixed | Chat jumps to the bottom on every new message while you read the history |
| F13 | minor | fixed | Chat drawer (below 1280 px) is not a dialog: no Escape, no focus, module hotkeys act behind it |
| F14 | minor | fixed | Focus does not return to the triggering button after a dialog or confirmation closes |
| F15 | minor | fixed | Undo is pushed away by later toasts; toast timers restart on every new toast |
| F16 | minor | fixed | Unread badge on a fresh browser counts the whole chat history |
| F17 | minor | fixed | Notifications: denied permission gives no feedback; bell state never re-syncs; one notification per actor replaces the previous |
| F18 | minor | fixed | "Trade erfassen" with a cleared date sends `time: null`, the server books "now" silently; dialog errors survive closing |
| F19 | minor | fixed | Over-fetching: every action and every chat message refetches all active queries (and twice: action + SSE tick) |
| F20 | minor | fixed | Calculator entry stays at the price of the moment the symbol was selected; prices below 1 lose digits |
| F21 | minor | fixed | IBKR question without text: card and confirm dialog show empty quotes „“ and still offer "Bestätigen und senden" |
| F22 | polish | fixed | Invalid `?symbol=` / `?account=` silently fall back while the URL keeps the invalid value |
| F23 | polish | fixed | Chart reference lines keyed by label: duplicate React keys with two alerts or two positions |
| F24 | polish | fixed | Watchlist search: Enter adds the top hit of the previous (debounced) query |
| F25 | polish | fixed | SSE handlers call `JSON.parse` unguarded |

Counts: blocker 0, major 10, minor 11, polish 4.

Web fix pass (branch q1-web, commits 31f8ef0, 9c990be, cdf3ea7, e2e in 2c3e0a1): all 25 fixed in the web app; F10
works without a new server field (rate from positions, proposals or a dry run). Each finding below carries its status
line. Tests: unit tests in `apps/web/test` (`format`, `logic`, `contrast`, `texts`, `styles`), e2e checks in
`apps/web/e2e/run.mjs` (slow and failing responses via `page.route`).

Checked and fine (no finding): day P/L agrees between sidebar (per account), overview "Heute" (+160,85 €, +0,3 %),
cockpit day bar and `/api/overview` / `/api/cockpit` sums; pending count agrees between top bar, sidebar badge and
API (4); calculator defaults for SAP.DE (entry 201,25, stop = price − ½ ATR 199,48, budget 1 % of 20.260 € = 203 €,
24 shares capped by the 5.000 € order limit, loss to stop 44,48 € incl. both fees) match a server dry run
(`estimateCents` 483000, ok); BTC-EUR sizes fractionally (0,081632); sell side uses the held 8 ALV.DE; dry run is
debounced (5 keystrokes, 1 request) and aborted on change, so stale responses cannot overwrite newer ones; approval
estimate uses the server's current-price estimate; double Enter in the approve dialog posts once; kill switch makes a
close fail with the server's message; chart pointer over 390 one-minute candles (1.170 rects) stays frame-locked
(median 16,7 ms, p90 18,4 ms per move, no long tasks); event listeners did not grow over 42 module switches
(330 to 299); idle cockpit makes 8 requests per 15 s tick (no storm).

---

## F1 – Order calculator: stale dry run gates submit and fills the confirm text

- Status: fixed in cdf3ea7: `useDryRun` keys the result to the request body; submit is locked while the check for the current inputs is outstanding, the confirmation uses only the current check; the 2 R target is sent and shown. e2e with a held dry run.
- Severity: major
- Where: `apps/web/src/modules/trade/OrderCalc.tsx:155-173` (check kept while inputs change), `:183` (estimate in the
  confirm body), `:193` (takeProfit sent), `:270` (disabled rule)
- Reproduce: `/trade?symbol=SAP.DE`, Mein Papierdepot, Stück `1`, wait for the dry run. Make the dry run slow (1.5 s)
  and change Stück to `5000`, click "Kaufen…" immediately. Reproduced: the button is enabled and the dialog reads
  "Kauf 5.000 SAP.DE im Mein Papierdepot? Market zu etwa 201,25 € · Stop 199,48 € · **201,25 €** + 1,00 € Gebühr" –
  the estimate of 1 share. When the check arrives it lists four violations (cash, position 4966 %, risk 43 %, order
  value 1.006.250 €).
- Expected: while a dry run for the current inputs is outstanding the button is disabled (or the dialog waits for it),
  and the dialog shows the value for the quantity being sent. Without a check the dialog shows "0,00 €" today
  (`check?.estimateCents ?? 0`), which is wrong too. The 2 R target that is sent as `takeProfit` is not shown in the
  dialog.
- Actual: the previous `check` stays in state until the new response arrives; `check === null` (dry run failed or not
  yet run) also enables the button.
- Root cause (confirmed): `setCheck` is only called with the response; the inputs that produced the check are not
  remembered.
- Proposed fix: store the check together with the request key (`{ key: JSON.stringify(body), check }`); treat it as
  current only when the key matches the present inputs; disable submit and show "prüfe…" otherwise; in the confirm
  body compute the value from `q`, entry and fx when no current check exists, and list stop and target. Same pattern
  in `OrderTicket.tsx:109-122,151` (shows "Orderwert ≈" of the previous inputs).
- Test: e2e with a delayed `dryRun` route: change quantity, assert the submit button is disabled until the matching
  check arrives and that the dialog text contains the estimate of the new quantity.

## F2 – Previous symbol's (or account's) data shown under the new header

- Status: fixed in cdf3ea7: no global placeholderData; the chart keeps old candles only for the same symbol, chart and analysis are ignored when their symbol differs, Depots takes title and actions from the overview account. e2e with slow NVDA routes.
- Severity: major
- Where: `apps/web/src/lib/api.ts:9` (`placeholderData: (prev) => prev` for every query), used by `useAnalysis`
  (`IntradayChart.tsx:243`), `useChart` (`IntradayChart.tsx:242`, `MarketView.tsx:126`), `useAccount`
  (`PortfolioView.tsx:25-27`)
- Reproduce: `/trade?symbol=SAP.DE`, delay `/api/market/analysis/NVDA` and `/api/market/chart/NVDA` by 3 s, click NVDA
  in the scanner. Reproduced (screenshot `placeholder-nvda-header-sap-chart.png`): header "NVDA 132,70 $", but "ATR 14
  3,54", "VWAP 200,62 · Kurs darunter", "EMA 9/21 201,36 / 201,34", "Vortag 203,46" and the candle chart with the axis
  "202,00 $" are SAP's. After loading the values change to 2,20 / 132,04 / 132,76. Depots: switch Trade Republic to
  Mein Papierdepot with a slow `/api/accounts/papier`: the title stays "Trade Republic" and "Trade erfassen…", "CSV
  importieren…" (manual-account actions) stay clickable for the old account while the select shows the new one.
- Expected: a keyed query for another symbol or account never shows the previous key's data; show a skeleton or the
  old data visibly marked as loading.
- Root cause (confirmed): `placeholderData` keeps the last data of any key in the same observer; `isLoading` is false,
  so the components render it as current.
- Proposed fix: remove the global default; use `keepPreviousData` only for queries whose key does not identify an
  entity (none today), or compare `data.symbol === symbol` / `data.account.id === accountId` before rendering and show
  the skeleton otherwise. In Depots derive the action buttons from the overview account (`accounts.find(id)`), not
  from the detail.
- Test: e2e: delay the NVDA analysis route, switch symbol, assert the VWAP field is "–" or a skeleton until the
  response arrives (never the SAP value); same for the account switch.

## F3 – Order ticket: account state from the first mount

- Status: fixed in cdf3ea7: the ticket sets account, symbol and side from the page on every open and refuses to submit without an account. e2e: deep link and account switch.
- Severity: major
- Where: `apps/web/src/modules/orders/OrderTicket.tsx:86` (`useState(accountId …)` evaluated once), `:100-106` (open
  resets symbol and side, not the account); `apps/web/src/modules/portfolio/PortfolioView.tsx:109` (ticket always
  mounted, first with `accounts = []`)
- Reproduce 1: open `/portfolio?account=ibkr` directly, click "Order…". Reproduced: the select shows "Mein
  Papierdepot", no dry run runs, submit label "Kaufen"; Enter posts
  `{"accountId":"","symbol":"SAP.DE","side":"buy","qty":1,"orderType":"market"}` (intercepted).
- Reproduce 2: `/portfolio?account=papier`, switch the page select to IBKR Papier, click "Order…". Reproduced: the
  page shows IBKR, the ticket title is "Neue Order (Papier)" with "Mein Papierdepot" selected
  (`ticket-after-account-switch.png`).
- Expected: the ticket opens on the account of the page (or the `accountId` prop) every time and never sends an empty
  account; the select shows exactly the state that is sent.
- Root cause (confirmed): state initialised from props before the overview loaded and never re-synced.
- Proposed fix: in the `open` effect also `setAcc(accountId && paper.some(...) ? accountId : paper[0]?.id ?? "")`; add
  `accountId` and the account list to the dependencies; refuse submit when `selected` is undefined.
- Test: e2e for both paths asserting the selected option and the posted `accountId`.

## F4 – Enter in the first field sends a broker order

- Status: fixed in cdf3ea7: owner decision 2026-10-16 – broker approve dialog, ticket and calculator open a second confirmation starting on Abbrechen; Enter sends nothing. e2e for approve and ticket.
- Severity: major (owner decision whether Enter may send)
- Where: `apps/web/src/ui/overlay.tsx:337-342` (form submit on Enter), `apps/web/src/modules/common.tsx:264` (approve:
  quantity field `autoFocus`), `apps/web/src/modules/orders/OrderTicket.tsx:182` (ticket: quantity `autoFocus`,
  defaults to `1`), submit labels "An Interactive Brokers senden" / "Mit echtem Geld senden"
- Reproduce: Orders, IBKR card "Freigeben…" – focus is in "Stück" – press Enter. Reproduced: the approve request is
  sent at once (one POST; a second Enter is blocked by `busy`). Ticket on Depots: "Order…", Enter, the order is posted
  with quantity 1 Market.
- Expected: per `design/principles.md` (consequential confirmations start on Cancel, Enter does not do the
  irreversible thing) and the calculator's own flow (confirm dialog that starts on "Abbrechen"), sending to a broker
  needs an explicit click or a second confirmation; at least for `live` accounts.
- Root cause (confirmed): the FormDialog is used as the final confirmation, and implicit form submission makes Enter
  the send button.
- Proposed fix: for broker accounts (always for `live`) let the dialog's submit open the existing `useConfirm` dialog
  (starts on Abbrechen) with side, quantity, type, estimate and "echtes Geld"; or make the form not submit on Enter
  when the target is a broker. Record the decision in CLAUDE.md.
- Test: e2e: open approve on the IBKR card, press Enter, assert no `/approve` request and that a confirmation
  starting on "Abbrechen" is shown.

## F5 – Closing a position always says "geschlossen"

- Status: fixed in cdf3ea7: `orderResultText` maps the returned status (shared with calculator, ticket and approve); unit test and e2e with a routed rejection.
- Severity: major
- Where: `apps/web/src/modules/trade/parts.tsx:86`
- Reproduce: cockpit, Positionen, "Schließen…" on ALV.DE, confirm; respond to `POST /api/proposals` with HTTP 200 and
  `proposal.status` `rejected` (reason "Tagesverlust-Grenze erreicht") or `confirm`. Reproduced: both times the toast
  reads "ALV.DE geschlossen." (With the kill switch on the server answers 4xx and the toast correctly shows its
  message.)
- Expected: like `OrderCalc.tsx:194-203`: rejected shows the reason, `confirm` says IBKR asks back under Orders,
  `placed`/`sending` say "an IBKR gesendet", only a fill says "geschlossen".
- Root cause (confirmed): the success text is a fixed string, the response is not inspected.
- Proposed fix: pass a function as `ok` that maps `res.proposal.status`; share it with the calculator.
- Test: e2e with routed responses per status asserting the toast text; unit test for the mapping function.

## F6 – German thousands separators read as decimals

- Status: fixed in 31f8ef0: thousands dot, German decimals, single-dot decimals; English order refused with "Bitte deutsches Format: 1.234,50". Unit tests incl. edge cases, e2e: "1.000" in Max. Orderwert saves 100.000 cents.
- Severity: major
- Where: `apps/web/src/lib/format.ts:218-223` (`parseDe`), used by every money/quantity field (risk limits, cash,
  trade capture, fill price, calculator, ticket, alerts)
- Reproduce: `parseDe("1.000")` → 1, `"12.000"` → 12, `"1,234.5"` → 1.2345 (node). In the app: Risiko, Mein
  Papierdepot, "Max. Orderwert (€)" = `1.000`, Enter. Reproduced: saved as `maxOrderCents: 100` (1 €), toast "Max.
  Orderwert … geändert". Trade erfassen with "Kurs je Stück (EUR)" `1.234` sends `price: 1.234`.
- Expected: in a German UI `1.000` is one thousand; ambiguous input is refused with a message rather than silently
  divided by 1000 (a fill price of 1,23 € instead of 1.234,00 € per share corrupts FIFO cost and P/L).
- Root cause (confirmed): without a comma every dot is taken as a decimal point.
- Proposed fix: treat `^\d{1,3}(\.\d{3})+$` as thousands; reject inputs that mix `.` and `,` in English order
  (`1,234.5`) with "Bitte deutsches Format: 1.234,50"; keep `1.5` / `104.50` (dot followed by 1, 2 or 4+ digits) as
  decimal. Show the parsed value next to money fields ("= 1.000,00 €").
- Test: unit tests for `parseDe` (`1.000`, `1.234,5`, `1.5`, `104.50`, `1,234.5`, `0,000001`); e2e risk field.

## F7 – Live stream reconnect: no catch-up, and permanent "Offline" after an HTTP error

- Status: fixed in cdf3ea7: after any error the next open reloads every query (chat included); a stream closed by an HTTP error is rebuilt with 1/2/5/10 s back-off. e2e: 503 phase, back to "Kurse …", the message sent during the gap appears.
- Severity: major
- Where: `apps/web/src/lib/api.ts:111-145` (`useLive`), `:73` (chat `staleTime: Infinity`, only SSE appends),
  server stream without replay (`apps/server/src/app.ts:216-240`)
- Reproduce (proxy in front of the fixture server, page on the proxy):
  1. Cut the stream with a network error for 6 s, post an agent chat message meanwhile, restore. Reproduced: status
     "Verbinde…" then back to "Kurse gerade eben", but the missed chat message never appears (only later messages);
     after reconnect no query was refetched (only the chart's own interval).
  2. Same with the proxy answering 503 while down. Reproduced: status "Offline" and it stays "Offline" after the
     server is back (EventSource closes for good on a non-200 response); proposals, risk, agents and chat no longer
     update until a manual reload.
- Expected: on every (re)open invalidate all queries and refetch the chat; if the EventSource is CLOSED, recreate it
  with back-off; the status shows how old the data is.
- Root cause (confirmed): `open` only sets the state; no reconnect for CLOSED; chat cache is only fed by SSE.
- Proposed fix: on `open`/`hello` after the first one call `qc.invalidateQueries()` (chat included); on `error` with
  `readyState === CLOSED` close and recreate after 1/2/5/10 s; optionally pass `Last-Event-ID`/`since` for chat.
- Test: e2e with a cuttable proxy (as used here): message posted while cut appears after reconnect; 503 phase ends
  "live" again.

## F8 – Errors never shown; endless skeleton; "Vorschläge 0"

- Status: fixed in cdf3ea7: `error && !data` shows "Daten nicht verfügbar" with Neu laden in every module; German text when the server is unreachable; top bar "–" when the count is unknown; the sidebar says "Server nicht erreichbar · Stand hh:mm" when a refetch fails. e2e: overview 500 and cockpit schema mismatch.
- Severity: major
- Where: `apps/web/src/modules/overview/OverviewView.tsx:172`, `apps/web/src/modules/trade/TradeView.tsx:45`,
  `apps/web/src/modules/risk/RiskView.tsx:124`, `apps/web/src/modules/agents/AgentsView.tsx:21`,
  `apps/web/src/modules/orders/OrdersView.tsx:46`, `apps/web/src/shell/Shell.tsx:257` (`data?.pending ?? 0`)
- Reproduce: `/api/overview` answers 500 → Übersicht shows grey skeletons indefinitely (screenshot `overview-500.png`),
  sidebar "Kurse –", top bar "Vorschläge 0" although 4 proposals wait. `/api/cockpit` with `scan[0].price` as a string
  (schema mismatch) → Trading shows skeletons only; the prepared message "Server und App passen nicht zusammen … Seite
  neu laden" (`api.ts:20`) is never visible. Also: once data exists, a failing refetch keeps showing the old prices
  without any hint.
- Expected: `error && !data` renders the module fallback with the message and "Neu laden"; the top bar shows "–" when
  the count is unknown; stale data after failed refetches is marked ("Stand 10:42, Server nicht erreichbar").
- Root cause (confirmed): views branch on `isLoading || !data` only; `ModuleError` is only reached by thrown render
  errors.
- Proposed fix: shared `useView(query)` helper or `throwOnError: (e, q) => q.state.data === undefined` so the route
  error component shows; `pending` unknown → "–".
- Test: e2e with routed 500 and schema mismatch for overview and cockpit asserting the error text and the retry
  button; the existing `e2e/run.mjs` only covers the happy path.

## F9 – Scanner arrow keys follow a different order than shown

- Status: fixed in cdf3ea7: see D7.
- Severity: major
- Where: `apps/web/src/modules/trade/TradeView.tsx:31-34` (uses `rows` = API order) vs
  `apps/web/src/modules/trade/Scanner.tsx:301` (displays `sorted`)
- Reproduce: `/trade`, sort "Änderung" (default). Reproduced: visible order AAPL, BTC-EUR, MSFT, SAP.DE, NVDA, ALV.DE,
  EUNL.DE; selected SAP.DE; ArrowDown selects ALV.DE (API order SAP.DE, ALV.DE, …) instead of NVDA. The selected row
  is also not scrolled into view, and the sorted list reorders on every tick.
- Expected: ArrowDown/Up move to the visually next/previous row of the current sort and keep it visible.
- Root cause (confirmed): sort state lives inside `Scanner`; the hotkey handler navigates the unsorted array.
- Proposed fix: lift `sort` into `TradeView` (or let `Scanner` own the keyboard handling with a roving tabindex) and
  navigate `sorted`; `scrollIntoView({ block: "nearest" })` on selection.
- Test: e2e: read the visible order, press ArrowDown, assert the URL symbol equals the second visible row. The current
  e2e only asserts that the symbol changed.

## F10 – Calculator cannot size non-EUR symbols without a position

- Status: fixed in cdf3ea7 without a server change: the rate comes from any position or proposal in that currency, otherwise from a dry run (`estimateCents` / quantity × price); the hint names the actual reason (no rate, stop, budget, cash). If the backend adds `fx` to the scan row, the calculator can use it directly. Unit tests and e2e with USD positions and proposals removed.
- Severity: major
- Where: `apps/web/src/modules/trade/OrderCalc.tsx:113` (fx only from a position of that symbol), `:147-149`,
  `:236` (hint)
- Reproduce: cockpit with no position in AAPL (cockpit response routed without USD positions; in the fixture every USD
  symbol is held by some account, in real use a newly watched US stock is not). Reproduced: entry 231,40, stop 229,22,
  budget 203 – "Stück" stays empty and the hint says "Stop unter Einstieg setzen" although the stop is below entry
  (`calc-usd-without-position.png`). The same misleading hint appears when the budget is too small for one share
  (`positionSize` returns null for qty 0).
- Expected: sizing works for every watchlist symbol; the hint names the actual reason ("Kein Wechselkurs USD/EUR",
  "Budget reicht nicht für 1 Stück").
- Root cause (confirmed): fx is derived as `position.price / position.nativePrice`; there is no fx in the cockpit
  scan; the fx of an agent's position is used when there is one.
- Proposed fix: add `fx` (EUR per unit) to `ScanRowSchema` in `packages/shared` (server already has `this.fx()`), use
  it; return a reason from `positionSize` or check the cases in the component.
- Test: unit test for the reason; e2e with a USD symbol not held asserting a quantity appears.

## F11 – Risk limits: next field's input overwritten

- Status: fixed in cdf3ea7: only fields whose server value changed and that are not being edited are reset. e2e with a slow /api/risk.
- Severity: minor
- Where: `apps/web/src/modules/risk/RiskView.tsx:187` (`useEffect(() => setVals(all fields), [limits])`)
- Reproduce: Risiko, Mein Papierdepot: "Max. Orderwert" `6000`, Tab, type `33` into "Max. Position" right away
  (risk refetch 400 ms). Reproduced: the field returns to `25` after the refetch, the blur then commits nothing; server
  keeps 25 % while the toast for the order value appears.
- Expected: a field being edited (dirty or focused) keeps its text.
- Root cause (confirmed): the effect resets all fields when any limit changes.
- Proposed fix: reset only fields whose server value changed and that are not focused/dirty; or keep a per-field
  "editing" flag.
- Test: e2e as above with a delayed `/api/risk`.

## F12 – Chat yanks to the bottom while reading

- Status: fixed in cdf3ea7: sticks to the bottom only when you were there or wrote yourself; otherwise "n neue Nachrichten" jumps down. e2e.
- Severity: minor
- Where: `apps/web/src/shell/ChatPanel.tsx:53-56`
- Reproduce: 40 long messages, scroll the chat list to the top, an agent writes. Reproduced: `scrollTop` 4617 of 4617
  (bottom) 1.5 s later.
- Expected: stick to the bottom only when the list was at the bottom; otherwise keep the position and show "Neue
  Nachrichten" to jump down. Own messages may always scroll.
- Root cause (confirmed): layout effect scrolls unconditionally on `shown.length`.
- Proposed fix: remember `atBottom` in an `onScroll` handler (threshold ~40 px) and scroll only then.
- Test: e2e as above asserting `scrollTop` unchanged and the jump button visible.

## F13 – Chat drawer is not a dialog

- Status: fixed in cdf3ea7: see D6.
- Severity: minor
- Where: `apps/web/src/shell/Shell.tsx:122-127` (drawer), `:97` (hotkeys check only `[role=dialog]`)
- Reproduce: 1000 px wide, press `c`. Reproduced: drawer opens, focus stays in the page; Escape does not close it;
  `3` navigates to Orders behind the overlay; no `role=dialog`.
- Expected: focus moves to the message field, Escape closes the drawer (and only the drawer), focus returns to the chat
  button, hotkeys inactive while it is open (overlay blocks the mouse already).
- Proposed fix: render the drawer with Radix Dialog (modal) like the other overlays.
- Test: e2e at 1000 px: `c`, assert focus in "Nachricht", Escape closes, `3` with the drawer open does not navigate.

## F14 – Focus not returned after dialogs

- Status: fixed in cdf3ea7: see D5.
- Severity: minor
- Where: `apps/web/src/ui/overlay.tsx:292-311` (confirm) and `:331-372` (FormDialog), opened without `Dialog.Trigger`
- Reproduce: Orders, focus "Ablehnen…" with the keyboard, Enter, Escape. Reproduced: `document.activeElement` is
  `body`. Same for the "Not-Aus…" confirmation in the cockpit and after the approve dialog.
- Expected: focus returns to the button that opened it (`design/principles.md`, Interaction).
- Proposed fix: remember `document.activeElement` when opening (confirm provider and FormDialog `open` edge) and focus
  it in `onCloseAutoFocus`, unless it is gone.
- Test: e2e: keyboard-open each dialog type, Escape, assert focus on the trigger.

## F15 – Undo pushed away; toast timers restart

- Status: fixed in cdf3ea7: toasts with an action are never displaced by later info toasts, each toast keeps its own timer; unit test for `pushToast`.
- Severity: minor
- Where: `apps/web/src/ui/overlay.tsx:393` (`xs.slice(-3)`), `:400` (new `onDone` per render) with `:408-411` (timer
  effect depends on it)
- Reproduce: Depots, Trade Republic, delete a trade (toast with "Rückgängig"), then four other actions with toasts
  (four deposits of 1 €). Reproduced: the undo toast is gone after the fourth, the trade stays deleted. Each new toast
  also restarts the 5/8 s timers of all visible toasts.
- Expected: a pending undo is never displaced by later info toasts (`quality/perfection-pass.md`, Logic); timers run
  from each toast's own start.
- Proposed fix: keep toasts with an action out of the eviction (evict the oldest without action first); stable
  `onDone` via `useCallback` keyed by id.
- Test: e2e as above asserting "Rückgängig" still visible; unit-level test of the reducer.

## F16 – Unread badge counts the whole history on a fresh browser

- Status: fixed in cdf3ea7: without a stored value everything up to the first chat load counts as read. e2e in a fresh context.
- Severity: minor
- Where: `apps/web/src/shell/Shell.tsx:61-79` (`desk.chatSeen` defaults to 0)
- Reproduce: new profile at 1000 px (chat closed by default). Reproduced: "Chat (C), 48 ungelesen".
- Expected: on first use, everything older than the page load counts as read (initialise `seen` to the last id of the
  first chat load).
- Test: e2e in a fresh context asserting no badge until a new message arrives.

## F17 – Notifications permission and state

- Status: fixed in cdf3ea7: blocked permission shows a toast, the bell re-reads the permission on focus and visibility, the tag is per event. e2e for the blocked case.
- Severity: minor
- Where: `apps/web/src/shell/Shell.tsx:226,240`, `apps/web/src/lib/api.ts:88-106`
- Reproduce: permission "denied" (headless default), click the bell. Reproduced: nothing visible happens
  (`aria-pressed` false, no toast).
- Expected: a toast "Benachrichtigungen sind im Browser blockiert – in den Website-Einstellungen erlauben"; the bell
  re-reads `Notification.permission` on focus/visibility (revoked permission keeps showing "an" today, code-confirmed);
  `tag: title` (`api.ts:102`) makes a second proposal from the same agent replace the first notification
  (code-confirmed) – use the event id as tag.
- Test: e2e with denied permission asserting the toast.

## F18 – Trade capture: cleared date, sticky errors

- Status: fixed in cdf3ea7: empty or future date is refused at the field, nothing is sent; errors are cleared when any dialog opens. e2e.
- Severity: minor
- Where: `apps/web/src/modules/portfolio/PortfolioView.tsx:276-277`, `:265-266` (state never reset on open)
- Reproduce: "Trade erfassen…", fill symbol/qty/price, clear "Datum", "Erfassen". Reproduced: body contains
  `"time":null` (NaN serialised); the server (`desk.ts:671`) then books the trade at the current time without telling.
  Validation errors set with `setErr` (all FormDialogs here and in `CashDialog`, `AlertDialog`) stay when the dialog is
  closed and reopened (code-confirmed). `max={today()}` is computed once per render (stale after midnight).
- Expected: "Datum fehlt" validation; errors cleared on open.
- Test: e2e: clear the date, assert the message and no request.

## F19 – Over-fetching after actions and chat

- Status: fixed in cdf3ea7: chat send reloads nothing; actions reload only when no tick arrives within 1,2 s; tick invalidation uses `cancelRefetch: false`. e2e request budget for chat send (tick-aware). The polling intervals of overview, cockpit and analysis are unchanged.
- Severity: minor
- Where: `apps/web/src/modules/common.tsx:45` (every action invalidates everything except chart/search),
  `apps/web/src/lib/api.ts:117-122` (every SSE tick/event invalidates all active queries), plus `refetchInterval` on
  overview/cockpit/brokers/analysis
- Measured: sending one chat message triggers 9 GETs (overview, chat ×300 messages, cockpit, proposals, agents,
  analysis, watchlist, risk, news) in addition to the SSE append; idle cockpit refetches risk, agents and watchlist
  every 15 s. A server mutation emits a tick (`desk.ts`), so each action is reloaded twice (action `finally` and the
  tick 150 ms later). Unconfirmed: with events faster than the server answers, `invalidateQueries` (default
  `cancelRefetch: true`) cancels in-flight requests each 150 ms and slow endpoints could starve.
- Proposed fix: invalidate by domain (chat send → nothing, the SSE append is enough; risk change → risk, cockpit;
  approve → proposals, overview, cockpit, account); rely on the SSE tick for the rest; `cancelRefetch: false` for the
  tick-driven invalidation.
- Test: e2e request budget: chat send makes 1 POST and no GET; one tick refetches at most the queries of the view.

## F20 – Calculator entry and precision

- Status: fixed in cdf3ea7: for market orders the entry follows the live price until you edit it ("Kurs übernehmen" resets), inputs use the price digit rule. e2e with a changed cockpit price.
- Severity: minor
- Where: `apps/web/src/modules/trade/OrderCalc.tsx:127-132` (entry and stop only set on symbol change), `:105`
  (`toFixed(2)`)
- Code-confirmed (fixture prices are static): for a market order the sizing, risk and 1–3 R targets use the price
  from the moment the symbol was selected, while the confirm dialog shows the current price; minutes later on a moving
  stock the shown loss to stop is wrong. Prices below 1 (pennies, some crypto) are cut to 2 decimals although `price()`
  shows 4.
- Proposed fix: for market orders follow `row.price` until the user edits the entry (dirty flag) and show "Kurs
  übernommen 10:42"; format with the same digit rule as `price()`.
- Test: unit/e2e with a fake market tick changing the price.

## F21 – IBKR question without text

- Status: fixed in cdf3ea7: without text the card says "Rückfrage ohne Text – bitte im Gateway prüfen" and offers only Stornieren. e2e with a routed proposal.
- Severity: minor
- Where: `apps/web/src/modules/common.tsx:114` and `:212`
- Reproduce: proposal list routed with an IBKR proposal in status `confirm` and `brokerMessage: null`. Reproduced: card
  "Interactive Brokers fragt nach: „“", the confirm dialog shows „“ and "Bestätigen und senden". Unconfirmed whether
  the server can store `confirm` without a message.
- Expected: CLAUDE.md says IBKR's questions are shown in IBKR's words and confirmed by the owner; without text there is
  nothing to confirm – show "Rückfrage ohne Text, bitte im Gateway prüfen" and offer only "Stornieren".
- Test: e2e with the routed response.

## F22 – Invalid search params

- Status: fixed in cdf3ea7: Trading, Depots and Markt replace an unknown symbol or account in the address and say so. e2e for Trading.
- Severity: polish
- Where: `apps/web/src/modules/trade/TradeView.tsx:24`, `apps/web/src/modules/portfolio/PortfolioView.tsx:24`,
  `apps/web/src/main.tsx:28`
- Reproduce: `/trade?symbol=GIBTSNICHT`. Reproduced: shows SAP.DE, URL keeps `GIBTSNICHT` (a shared link then means
  something else than shown); same for `/portfolio?account=nope`.
- Proposed fix: replace the URL with the shown symbol/account and show a short note "GIBTSNICHT ist nicht auf der
  Watchlist".

## F23 – Duplicate keys for chart reference lines

- Status: fixed in 9c990be: keys are label, value and index.
- Severity: polish
- Where: `apps/web/src/ui/charts.tsx:296` and `:306` (`key={r.label}`); refs from `IntradayChart.tsx:256-262`,
  `MarketView.tsx:133-134`
- Code-confirmed: two active alerts above (or two positions, two open limits) share the label "Alarm über"; the
  production build prints no warning (checked), but React may reuse or drop the wrong line on updates.
- Proposed fix: key by `${label}-${value}-${index}`.

## F24 – Search Enter uses stale hits

- Status: fixed in cdf3ea7: Enter takes the highlighted hit only when the hits belong to the current input; arrow keys move through options, the list closes on blur. e2e with a slow search.
- Severity: polish
- Where: `apps/web/src/modules/market/MarketView.tsx:66`
- Unconfirmed (code): Enter within 300 ms of typing adds `hits[0]` of the previous debounced query. Also: the result
  list has `role=listbox` but no arrow-key navigation and stays open when focus leaves.
- Proposed fix: only accept Enter when `debounced === q.trim()` and not fetching; arrow keys over options.

## F25 – Unguarded JSON.parse in SSE handlers

- Status: fixed in cdf3ea7: SSE payloads are parsed with a guarded `parse`.
- Severity: polish
- Where: `apps/web/src/lib/api.ts:130` and `:134`
- Code-confirmed: a malformed `event`/`chat` payload throws inside the listener (uncaught error in the console); use
  `try` around the parse like the schema check.

---

## E2E coverage gaps (`apps/web/e2e/run.mjs`)

Covered today: layout per module/theme/width, console errors, approve with narrowing, Trade Republic fill, IBKR
approve, calculator buy via hotkey B, ArrowDown changes the symbol, chat live/HTML-as-text/Enter, kill switch confirm
starts on "Abbrechen", focus ring token.

Not covered (each would have caught a finding above or guards an owner rule):

- reject with reason, cancel, IBKR question confirm/cancel (F21), approve Enter behaviour (F4);
- calculator: dry-run gating and confirm text (F1), sizing for a USD symbol without position (F10), sell side, limit
  order, fractional crypto, account switch;
- order ticket from Depots deep link and after switching accounts (F3), from Markt;
- closing a position and its toast per status (F5);
- symbol/account switch with slow responses (F2); arrow order against the visible sort (F9);
- server down / 500 / schema mismatch per module (F8); SSE cut and reconnect, missed chat (F7);
- risk limits edit, Enter, undo, German number input (F6, F11); trade capture, CSV import (twice, with errors), cash,
  delete with undo and toast stacking (F15, F18);
- chat scroll anchoring, unread count, mentions, drawer Escape/focus/hotkeys (F12, F13, F16);
- Escape layering and focus return for every dialog (F14); notifications permission (F17);
- request budget per action and per tick (F19);
- no unit tests for `parseDe`, `positionSize` reasons, or the status-to-toast mapping.
