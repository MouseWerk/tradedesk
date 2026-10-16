# Q1 design audit

Scope: every module in light and dark at 390, 768, 1024, 1280, 1440 and 1920 px, chat open and closed at >= 1280 px,
all dialogs (Freigeben, Ablehnen, Neue Order, Trade erfassen, CSV importieren, Ein-/Auszahlung, Abgleich, Order-Rechner
with confirmation, Alarm, Order from Markt, Not-Aus from Trading and Risiko), the chat drawer below 1280 px, skeletons
with held API responses, keyboard paths and computed contrast. Fixture server (`--fixture --port 8191`, fake exchange,
throwaway data) and a temporary Playwright script; 110+ screenshots were taken and the ones named below were looked at.
Screenshots: `C:\Users\klein\AppData\Local\Temp\claude\F--GITHUB-aiworkdashboard\b31cf183-9962-4917-befd-a48eb60aeb34\scratchpad\audit-design\`
(called SHOTS below; names are `<theme>-<width>-<chat|nochat>-<view>[-full].png`, `dlg-*`, `drawer-*`, `skel-*`).

What already holds: no horizontal page scroll at any width or theme; no console errors or warnings on any view; the
focus ring is the neutral `--focus-ring` and only on `:focus-visible`; no accent- or status-colored borders, outlines,
glows or left bars were found (code grep and rendered checks); destructive confirmations start on "Abbrechen"; chart
tooltips stay inside the chart at both edges (SHOTS/dlg-light-chart-tooltip-right.png).

| Id | Severity | Status | Title |
|---|---|---|---|
| D1 | major | open | "Mit Interactive Brokers abgleichen…" always fails in the browser (403 "Nur im Browser") |
| D2 | major | open | Trading cockpit collapses to one or two columns at 1024–1600 px; order calculator far below the chart |
| D3 | major | open | Tables hide the most important columns (G/V, Wert, Heute) behind an unmarked inner scroll |
| D4 | major | open | Danger buttons in dark: white on `--err` is 2.68:1 (Not-Aus, live-money buttons) |
| D5 | major | open | Focus is lost (goes to body) after every dialog and confirmation closes |
| D6 | major | open | Chat drawer below 1280 px is not a dialog: no focus move, no Escape, no focus trap, hotkeys act behind it |
| D7 | major | open | Arrow up/down in Trading follows the API order, not the scanner order shown; hijacks arrows everywhere |
| D8 | major | open | All inputs and selects in dialogs render at 16 px instead of 13 px |
| D9 | major | open | Day-trader information design: approval shows no risk, cockpit hides pending decisions, overview no session state |
| D10 | major | open | IBKR Papier shows +50,56 € today and a rising curve with no positions or trades (unconfirmed: fixture or logic) |
| D11 | minor | open | Light theme: warn text on warn tints is below 4.5:1 (badges 4.16, warnings box 4.40) |
| D12 | minor | open | Scanner at 280–300 px: prices wrap ("61.250,00 / €"), symbols truncate with the name as tooltip |
| D13 | minor | open | Overview "Wartet auf dich" shows 3 of 4 without saying so and cuts the cards' buttons |
| D14 | minor | open | Skeletons: Trading skeleton overflows at 390 px (CLS 0.112); skeleton grids use other breakpoints than the final view |
| D15 | minor | open | Order-Rechner keeps showing the computed size and its risk after you type a different quantity |
| D16 | minor | open | Two different minus signs: `eur()` prints "-8,00 €", `signedEur()` prints "−8,00 €" |
| D17 | minor | open | Currency mix: positions in € next to stops in $, scanner in $ for the same symbol |
| D18 | minor | open | German text issues (grammar, English leftovers, quotes, redundant labels, missing thousands separator) |
| D19 | minor | open | Screen-reader names: list buttons do not say what they act on; search results not keyboard-navigable |
| D20 | minor | open | "Stornieren" and "Alarm löschen" act immediately without confirmation or undo |
| D21 | minor | open | Live-money submit in "Neue Order" uses the primary variant, the calculator uses danger |
| D22 | minor | open | Dialog validation errors are not tied to the field (no aria-invalid, no focus on the field) |
| D23 | minor | open | No skip link: 14 Tab stops before the first action of a view |
| D24 | polish | open | Empty grid slots and wrapping headers (5 stats as 3+2, agent cards, page head actions) |
| D25 | polish | open | Chart y-axis: highest prices sit above the top tick without a label |
| D26 | polish | open | Phone header: the pending button shrinks to a bare "4"; "0" while loading |

---

## D1 – Abgleich with IBKR always fails in the browser

- Where: Depots → IBKR Papier, `apps/web/src/modules/portfolio/BrokerPanel.tsx:20-29` (`getChecked` GET),
  `apps/web/src/lib/api.ts:12-13`, server `apps/server/src/app.ts:173-175` (GET calls `userOnly`), origin detection
  `app.ts:55-63`.
- Reproduce: any width, any theme. `/portfolio?account=ibkr` → "Mit Interactive Brokers abgleichen…". A red toast
  "Nur im Browser – das entscheidet der Mensch, nicht ein Agent." appears, no dialog
  (SHOTS/dlg-light-reconcile.png). `curl /api/accounts/ibkr/reconcile` → 403; with an `Origin` header → 200.
- Expected / actual: preview dialog with broker vs desk rows / refusal aimed at agents, shown to the owner.
- Root cause (confirmed): browsers do not send `Origin` on same-origin GET requests, so the server classifies the
  browser's GET as "cli" and `userOnly` refuses it. The e2e never clicks this button.
- Proposed fix: the preview is a read; drop `userOnly` from the GET (the POST that applies it keeps it), or send the
  preview as POST. Either way the error text must not tell the owner he is an agent.
- Test: e2e clicks "abgleichen…" on the fixture IBKR account and expects the dialog title "Abgleich mit Interactive
  Brokers"; server test: GET reconcile without `Origin` returns 200.
- Severity: major (a broker feature is unusable; hand to the logic/security team for the route decision).

## D2 – Trading cockpit layout breaks down below ~1600 px of content width

- Where: `apps/web/src/modules/trade/TradeView.tsx:264` and `:270` (container queries `@max-[1400px]`, `@max-[900px]`).
- Reproduce: dark, 1440 px, chat open (default) → `/trade?symbol=NVDA`: one column; the scanner spans the full
  width with prices 600 px away from symbols, the chart starts below the fold, the order calculator is ~1300 px down
  (SHOTS/dark-1440-chat-trade.png, dark-1440-chat-trade-full.png). 1440 px chat closed and 1280 px: two columns, the
  calculator and news move under the positions, below the fold (SHOTS/dlg-light-calc-confirm.png). Only at 1920 px
  without chat is the three-column cockpit shown (SHOTS/light-1920-nochat-trade.png).
- Expected / actual: scanner, chart and calculator side by side on a normal 1440 px laptop with the chat open / the
  calculator (the B/S hotkey target) needs scrolling, and B focuses an input outside the viewport.
- Root cause (confirmed): breakpoints are tuned for the container without the 232 px sidebar and 360 px chat; with
  both, a 1440 px window leaves ~790 px.
- Proposed fix: at 900–1400 px container keep chart + calculator in the first row (scanner as a narrower list or
  collapsible), put positions and news below; at < 900 px order: chart, calculator, scanner. Shrink the scanner row to
  a fixed-width grid so prices stay next to symbols. Consider collapsing the chat to an icon rail on Trading.
- Test: e2e at 1280 and 1440 px (chat open and closed) asserts the "Order-Rechner" section's top is within the first
  viewport and horizontally next to the chart.
- Severity: major.

## D3 – Important table columns hidden behind an inner horizontal scroll

- Where: `apps/web/src/ui/kit.tsx:119-129` (`Table`), used in `OverviewView.tsx:82`, `PortfolioView.tsx:133`,
  `trade/parts.tsx:91`, `:151`.
- Reproduce: (a) 390 px dark, Übersicht → table "Depots" shows only "Depot" and "Art"; Wert, Cash, Heute, Gesamt are
  off-screen (SHOTS/dark-390-nochat-overview-full.png). (b) 390 px Trading → Positionen show Wert, Depot, Stück only;
  G/V, R, Stop hidden (SHOTS/dark-390-nochat-trade-full.png). (c) 1280 px light, chat open, Depots → Trade Republic:
  G/V, Anteil, Stop / Ziel and the Trades columns "Ergebnis" and delete are cut at the card edge
  (SHOTS/light-1280-chat-portfolio-tr-full.png).
- Expected / actual: the money columns are always visible; secondary columns give way / the badge "Art" and name
  columns win, there is no shadow or fade showing more content exists.
- Root cause (confirmed): all columns `whitespace-nowrap`, no column priority, no responsive variant.
- Proposed fix: column priority per table (hide Art, Cash, Einstand, Depot first under a container width, or merge
  Stück/Einstand into a second line), sticky first column, an edge fade when scrollable; on phones render rows as
  two-line list items.
- Test: e2e at 390 and 1280+chat asserts the "G/V" / "Heute" header cells are inside the card's visible rect.
- Severity: major.

## D4 – Danger buttons in dark theme fail contrast

- Where: `apps/web/src/ui/kit.tsx:35` (`danger: bg-err text-white`), `styles.css:86` (`--err` dark
  `oklch(0.72 0.17 25)`).
- Reproduce: dark, any width, Trading "Not-Aus…" button, Risiko "Not-Aus…", confirm "Not-Aus einschalten"
  (SHOTS/dlg-dark-kill-confirm.png). Computed: white on `--err` = 2.68:1 (light theme 5.87:1).
- Expected / actual: >= 4.5:1 for 12–13 px labels / 2.68:1 on the most safety-critical button.
- Root cause (confirmed): the dark `--err` is lightened for text on dark surfaces and reused as a fill under white.
- Proposed fix: add `--danger-fill` / `--danger-fg` tokens (dark: darker red fill such as `oklch(0.55 0.19 25)` with
  white, or keep the light red fill with `--primary-fg` dark text), and add the pair to the contrast guard.
- Test: `styles.test.ts` contrast assertion for the danger fill/label pair in both themes.
- Severity: major.

## D5 – Focus is not returned after dialogs close

- Where: `apps/web/src/ui/overlay.tsx:29-48` (ConfirmProvider) and `:68-110` (FormDialog) – Radix `Dialog.Root`
  without `Dialog.Trigger`, opened from state.
- Reproduce: dark/light 1440 px. Orders → Tab to "Freigeben…" → Enter → Escape: `document.activeElement` is
  `body`. Same after "Ablehnen…", the Order-Rechner "Kaufen…" confirm and the Risiko Not-Aus confirm (measured in the
  interaction run).
- Expected / actual: focus back on the button that opened the dialog (`design/principles.md`, Interaction) / keyboard
  users restart at the top of the page (14 stops away, see D23).
- Root cause (confirmed): with no Trigger, Radix restores focus to nothing useful; the opener is not recorded.
- Proposed fix: record `document.activeElement` when opening (in `confirm()` and in each FormDialog via
  `onOpenAutoFocus`) and focus it in `onCloseAutoFocus`; or render the opener as `Dialog.Trigger asChild`.
- Test: e2e: focus "Freigeben…", Enter, Escape, assert the same button has focus; same for one confirm.
- Severity: major.

## D6 – Chat drawer below 1280 px is not modal

- Where: `apps/web/src/shell/Shell.tsx:122-127`, `ChatPanel.tsx:79`.
- Reproduce: dark, 390 and 1024 px, chat toggle: focus stays on the toggle; Escape does nothing (drawer stays open);
  Tab walks the page behind the overlay ("Vorschläge 4", "Neue Order…", "Freigeben…"); pressing "2" navigates to
  Trading behind the open drawer (SHOTS/drawer-390.png).
- Expected / actual: a modal drawer: focus into the textarea, Escape closes and returns focus to the toggle, Tab
  trapped, hotkeys inactive / none of that.
- Root cause (confirmed): plain `aside` plus a click overlay; the hotkey guard only checks `[role=dialog]`.
- Proposed fix: render the drawer with Radix Dialog (`Dialog.Content` as the panel, `aria-label="Chat"`), focus the
  textarea on open.
- Test: e2e at 1024 px: open drawer, assert focus inside, Escape closes, focus on `chat-toggle`, key "2" does not
  navigate while open.
- Severity: major.

## D7 – Arrow keys in Trading follow the wrong order and hijack focus

- Where: `apps/web/src/modules/trade/TradeView.tsx:224-240` (uses `rows`), `Scanner.tsx:233` (displays `sorted`).
- Reproduce: any theme, `/trade?symbol=NVDA`, scanner sorted by "Änderung" shows … SAP.DE, NVDA, ALV.DE …; ArrowDown
  goes to EUNL.DE (API order SAP.DE, ALV.DE, AAPL, MSFT, NVDA, EUNL.DE, BTC-EUR). Also with focus on the "Gap" tab of
  the sort control, ArrowDown switches the symbol instead of moving within the control.
- Expected / actual: next row as displayed; arrows inside a focused tablist/select/chart stay there / jumps to a
  symbol you cannot see, keyboard scrolling of the page is swallowed (`preventDefault`).
- Root cause (confirmed): the handler indexes the unsorted array; it ignores the focused element's role.
- Proposed fix: lift the sort state to TradeView (or pass the sorted list up) and navigate that; skip when the target
  is inside `[role=tablist]`, `svg[tabindex]`, a listbox or the chat.
- Test: unit/e2e: sort "Änderung", select NVDA, ArrowDown → URL symbol equals the next `scan-row` in DOM order.
- Severity: major.

## D8 – Dialog inputs render at 16 px

- Where: `apps/web/src/styles.css:127-132` (`input, select, textarea { font: inherit }`, unlayered).
- Reproduce: any theme, Orders → "Neue Order…", Depots → "Trade erfassen…", Freigeben dialog: computed font-size of
  every input/select in the dialog is 16 px, the same select in the page is 13 px. Visible as oversized "Kauf",
  "16.10.2026", "1", "2" (SHOTS/dlg-dark-trade-error.png, dlg-dark-approve.png).
- Expected / actual: 13 px like the rest of the UI / 16 px with the 32 px input height, looks unfinished.
- Root cause (confirmed): unlayered CSS beats Tailwind's `@layer utilities`, so `font: inherit` overrides
  `text-[13px]`; dialogs are portaled to `body` (16 px), the shell inherits 13 px, so it only shows in dialogs.
- Proposed fix: move the rule into `@layer base` (or use `font-family: inherit` only).
- Test: `styles.test.ts`: element resets live inside `@layer base`; e2e: font-size of an input in the Freigeben dialog
  equals 13 px.
- Severity: major.

## D9 – Information design for a day trader

- Where: `common.tsx:378-533` (ProposalCard and approve dialog), `TradeView.tsx:255,273-279`,
  `OverviewView.tsx:41-52`, `trade/parts.tsx:19-71`.
- Reproduce: 1440 px, Orders and Übersicht (SHOTS/light-1280-chat-orders-full.png, dark-1440-chat-overview-full.png,
  dlg-dark-approve.png).
- Expected / actual:
  - Approval: the decision needs "loss to stop in EUR incl. fees", R multiple to the target, % of the account and the
    remaining daily-loss headroom; the card and dialog show only estimate, price then/now and confidence. The thesis
    is hidden in the dialog.
  - Trading: pending proposals are shown only for the selected symbol; 4 pending decisions are invisible in the
    cockpit apart from the top-bar count. The daily loss stop is shown only after a loss exists ("Tagesverlust" in the
    day bar); headroom ("noch 812 € bis Stopp") is never visible. Open-risk sum of positions (sum of loss to stop) is
    missing; R and Stop are "–" for every fixture position with no hint to set a stop.
  - Übersicht: no session state (open/closed per exchange) and no kill-switch state, though it is the start page.
  - Noise: the "Depots" table on Übersicht repeats the sidebar; "Art" badges mix broker names and kinds; the timeline
    shows "4 Min." without "vor"; "CCC" (Yahoo's crypto code) is shown as an exchange name.
- Root cause: views were built per data source, not per decision.
- Proposed fix: add a risk line to ProposalCard and the approve dialog ("Risiko bis Stop 42,48 € · 0,2 % · 2,1 R");
  a compact "Wartet auf dich (4)" list in the cockpit's right column for all symbols; show daily-loss headroom and
  open risk in the day bar; session chips and kill state on Übersicht; map "CCC" to "Krypto".
- Test: e2e: a pending proposal with a stop shows text matching /Risiko bis Stop/; Trading lists pending proposals
  for other symbols.
- Severity: major (owner decision on scope; each item is small).

## D10 – IBKR Papier shows a day gain without positions

- Where: Übersicht stats and table, sidebar, Depots → IBKR Papier, Trading day bar and Tagesstatistik.
- Reproduce: any width. IBKR Papier: 0 positions, 0 trades, cash 25.000,00 €, "Gesamtrendite ±0,0 %" but
  "+50,56 € heute", sidebar "+0,2 %", and an equity curve rising from ~21.700 € to 25.000 €
  (SHOTS/light-768-nochat-portfolio-ibkr-full.png). The +50,56 € is part of "Heute +159,87 €" on Übersicht and Trading.
- Expected / actual: 0,00 € today and a flat curve / invented movement that inflates the headline P/L.
- Root cause (unconfirmed): either the fixture seeds a curve for this account, or `dayChangeCents` is computed against
  a curve point that does not match the book. Hand to the logic team.
- Proposed fix: day change = equity now − equity at the previous close from the same book; fixture curves consistent
  with trades.
- Test: unit: an account with only cash has `dayChangeCents === 0`.
- Severity: major (if it is logic, the headline number is wrong; if fixture only, minor).

## D11 – Light theme: warn text on warn tints below AA

- Where: `kit.tsx:17` (`warn: bg-warn/14 text-warn`), `common.tsx:436` (`bg-warn/10 text-warn`), PortfolioView
  `:346`; tokens `styles.css:57`.
- Reproduce: light, Orders: "wartet auf dich" badges (11 px) 4.16:1; proposal warnings box 4.40:1; sidebar pending
  badge 3.98:1 on hover tint. Dark passes (7.75).
- Expected / actual: 4.5:1 / below.
- Root cause (confirmed): `--warn` light `oklch(0.55 0.13 65)` is just at 5.0 on white; the tint lowers it.
- Proposed fix: darken light `--warn` to ~`oklch(0.5 0.12 65)` or use `--fg` text with a warn icon in tinted boxes.
- Test: contrast guard for `--warn` on `color-mix(--warn 14%, --surface)` in light.
- Severity: minor.

## D12 – Scanner rows break in the 280–300 px column

- Where: `apps/web/src/modules/trade/Scanner.tsx:256-264`.
- Reproduce: 1440 px chat closed (two-column cockpit): BTC-EUR row shows "BTC-E…" and the price wraps to "61.250,00"
  / "€" on two lines, so the row is taller than the others (SHOTS/dlg-dark-kill-confirm.png,
  dlg-light-chart-tooltip-right.png). Measured: `scannerWrapped: "61.250,00 €"`. The truncated symbol's tooltip
  shows the company name, not the symbol.
- Expected / actual: one-line rows; amounts never wrap (`Stat` already follows this rule).
- Root cause (confirmed): price span has no `whitespace-nowrap`/`shrink-0`; the symbol is the element that gives way.
- Proposed fix: `whitespace-nowrap shrink-0` on price and change; let the "Depot" badge drop first; title
  `${symbol} – ${name}`.
- Test: e2e at 1280/1440: every `scan-row` has the same height.
- Severity: minor.

## D13 – "Wartet auf dich" on Übersicht hides items and cuts buttons

- Where: `apps/web/src/modules/overview/OverviewView.tsx:74-78`.
- Reproduce: 1440 px chat open, dark: 4 pending, 3 rendered; the second card's "Freigeben…" is cut by the 340 px
  scroll box (SHOTS/dark-1440-chat-overview-full.png); 390 px: "gilt bis" and buttons cut
  (SHOTS/dark-390-nochat-overview-full.png).
- Expected / actual: all pending or "+1 weiterer" link; no half-visible actions in a nested scroller.
- Root cause (confirmed): `slice(0, 3)` plus `max-h-[340px] overflow-y-auto`.
- Proposed fix: show compact one-line rows (side, qty, symbol, author, risk, Freigeben…) for all pending, link
  "Alle 4 ansehen" when more than N.
- Test: e2e: number of items in "Wartet auf dich" equals the pending badge or a "weitere" link exists.
- Severity: minor.

## D14 – Skeletons overflow and differ from the final layout

- Where: `TradeView.tsx:242-252` (fixed `grid-cols-[320px_minmax(0,1fr)_340px]`), `OverviewView.tsx:21`
  (`max-lg:` viewport vs final `@max-[900px]` container), `PortfolioView.tsx:92` (`grid-cols-5 max-lg:grid-cols-2` vs
  final `@max-[1000px]:grid-cols-3 @max-[640px]:grid-cols-2`); `Shell.tsx:257` shows "Vorschläge 0" while loading.
- Reproduce: API responses held, 390 px dark `/trade`: `#main` scrolls sideways by 376 px, the skeleton is cut at the
  right (SHOTS/skel-390-trade.png); CLS after load 0.112 at 390 px, 0.051 at 1440 px.
- Expected / actual: skeleton with the final grid and sizes, CLS < 0.05.
- Root cause (confirmed): skeleton grids written separately from the real grids.
- Proposed fix: reuse the same grid classes for skeleton and content; reserve the chart height; show "–" instead of
  "0" for pending while loading.
- Test: e2e with delayed API: `#main.scrollWidth <= clientWidth` during loading; CLS budget 0.05.
- Severity: minor.

## D15 – Order-Rechner shows the computed size after a manual quantity

- Where: `apps/web/src/modules/trade/OrderCalc.tsx:436` (hint), `:450-454` (sizing line), `:441-448` (targets).
- Reproduce: Trading NVDA, press B, type 10: the line still says "40 Stk. ≈ 4.883,36 €, Verlust bis Stop 42,48 €",
  while the confirmation says "Kauf 10 NVDA … 1.220,84 €" (SHOTS/dlg-light-calc-confirm.png). Ziel 1–3 R values carry
  no currency ("133,80") while entry/stop are USD.
- Expected / actual: risk line for the quantity that will be sent / for a different quantity.
- Root cause (confirmed): the line uses `sizing`, not `q`.
- Proposed fix: compute value and loss-to-stop from `q`; keep "Rechner: 40" as the hint only; format targets with
  `price(t, row.currency)`.
- Test: unit/e2e: type a quantity, the risk line contains that quantity.
- Severity: minor (it is the risk number the trader reads last).

## D16 – Two minus signs

- Where: `apps/web/src/lib/format.ts:5-7` (`eur()` via Intl → U+002D) vs `:10-13` (`signedEur` → U+2212).
- Reproduce: Trading → Tagesstatistik, Papierdepot Atlas: "Ø Verlust -8,00 €" next to "−36,68 €" in the same table
  (SHOTS/dark-1440-chat-trade-full.png).
- Expected / actual: one minus glyph everywhere (the file comment promises the real minus).
- Root cause (confirmed): `eur()` passes negative values straight to Intl.
- Proposed fix: replace `-` with `−` in `eur()` for negatives (or always use `signedEur` for P/L values).
- Test: unit: `eur(-800)` contains "−" and no "-".
- Severity: minor.

## D17 – Currency mix between views and within rows

- Where: `trade/parts.tsx:122-128` (Einstand/Kurs via `price(x)` = €, Stop via `price(x, p.currency)`),
  `PortfolioView.tsx:159-172` (same), `ScanRow`/chart in native currency.
- Reproduce: Trading 1920 px: scanner "AAPL 231,40 $", positions "AAPL Einstand 188,50 € Kurs 212,89 €"; a stop set
  on AAPL would show "$" in the same row. Orders card "Stop / Ziel 395,00 $ / 470,00 $" next to "≈ 1.541,55 €".
- Expected / actual: one rule – native currency for prices (with € value columns) or € with the native price as a
  visible second line, never mixed silently; column header says which ("Kurs ($)").
- Root cause (confirmed): positions are converted to EUR for the book, stops are stored native.
- Proposed fix: show native prices in Einstand/Kurs/Stop (book values in Wert/G/V stay €), tooltip with the € value.
- Test: e2e: for a USD position, Einstand, Kurs and Stop cells use the same currency symbol.
- Severity: minor.

## D18 – German texts

- Where and reproduce (all confirmed in screenshots or code):
  - "Kauf 10 NVDA im Mein Papierdepot?" (`OrderCalc.tsx:379`), "… zum Marktkurs im {Depot}" (`trade/parts.tsx:85`) –
    use "in „Mein Papierdepot“" or "Depot: …".
  - English leftovers: "Market" as order type in cards (`common.tsx:404`), segmented controls (`OrderTicket.tsx:380`,
    `OrderCalc.tsx:458`), "Market-Tagesorder" (`common.tsx:503`), "Market zu etwa" – owner decision whether
    "Market" is the accepted German trading term; if not "Bestens".
  - Broken quotes: `(„kind": „paper“)` in `OrderTicket.tsx:338`.
  - Redundant: "Alarm unter 120,00 $ (darunter)" (`charts.tsx:425-429` + label) – write "Alarm 120,00 $ (unter dem
    Bereich)".
  - Risiko inputs show "5000" without thousands separator (`RiskView.tsx:338`); hint "Verlust bis Stop, 0 = keine"
    ends mid-phrase (`:340`).
  - Timeline "4 Min." drops "vor" (`OverviewView.tsx:118`).
  - "Limit = Einstieg" (`OrderCalc.tsx:458`) reads like a formula; "Limit zum Einstieg".
  - Trading top bar "CCC Offen bis 23:59" (exchange code).
- Test: text guard over the UI strings: no "im Mein", no `„…"` mixes, no number inputs without grouping.
- Severity: minor.

## D19 – Screen-reader names and search keyboard

- Where: `common.tsx:467-490` (Freigeben…/Ablehnen…/Stornieren), `trade/parts.tsx:131` (Schließen…),
  `MarketView.tsx:207` ("Alarm löschen"), `MarketView.tsx:70-85` (search listbox).
- Reproduce: Tab order on Orders lists "Freigeben… | Ablehnen…" four times with identical names; ArrowDown in the
  search box keeps focus in the input; hits already on the watchlist (SAP.DE, AAPL) still show "+"
  (SHOTS/dlg-dark-search.png).
- Expected / actual: "Kauf 2 SAP.DE freigeben…", "Alarm unter 120,00 $ löschen", "ALV.DE schließen…"; arrow keys move
  through options, Enter takes the highlighted one / generic names, no option navigation.
- Proposed fix: `aria-label` with the proposal label on each action; `aria-activedescendant` listbox pattern; mark
  watched hits "auf der Watchlist".
- Test: e2e: every button inside `[data-testid=proposal]` has an accessible name containing the symbol.
- Severity: minor.

## D20 – Immediate destructive actions

- Where: `common.tsx:356` + `:486-490` ("Stornieren", sends a cancel to the broker for placed IBKR orders),
  `MarketView.tsx:207` (alarm delete).
- Reproduce: Orders with a placed/open order or Markt with an alarm: one click acts, no confirmation, no undo
  (code-confirmed; the fixture has no open limit in view).
- Expected / actual: undo toast (alarm) or a confirmation starting on "Abbrechen" (broker cancel).
- Test: e2e: delete an alarm, toast has "Rückgängig".
- Severity: minor.

## D21 – Live-money submit variant inconsistent

- Where: `overlay.tsx:98` (FormDialog submit always `primary`), `OrderTicket.tsx:352` ("Mit echtem Geld senden");
  calculator uses `danger` (`OrderCalc.tsx:470`).
- Reproduce: code-confirmed; the fixture has no live account (unconfirmed visually).
- Proposed fix: `submitVariant` prop on FormDialog, danger for live accounts (after D4 is fixed).
- Severity: minor.

## D22 – Validation errors not tied to fields

- Where: `overlay.tsx:89-93`, `kit.tsx:103-114` (`Field` error has no id/`aria-describedby`, input no
  `aria-invalid`).
- Reproduce: "Trade erfassen…" → "Erfassen" with an empty symbol: the alert appears at the bottom, the field is not
  marked and focus stays on the button (SHOTS/dlg-dark-trade-error.png).
- Proposed fix: field-level errors with `aria-invalid` and focus on the first invalid field.
- Severity: minor.

## D23 – No skip link

- Where: `Shell.tsx:106-128`.
- Reproduce: Orders, Tab from the top: 13 stops (7 modules, 3 depots, 3 header buttons, "Vorschläge") before
  "Neue Order…".
- Proposed fix: visually hidden "Zum Inhalt" link focusing `#main`; or F6 between Navigation, Inhalt, Chat
  (`design/principles.md`).
- Severity: minor.

## D24 – Empty slots and wrapping headers

- Reproduce: Depots at 1280 px chat open: 5 stats as 3 + 2 with an empty slot; page head actions wrap and leave
  "Ein-/Auszahlung…" alone on a second line (SHOTS/light-1280-chat-portfolio-tr-full.png); Agenten at 1920 px: two
  agent cards fill 40 % of the row (SHOTS/light-1920-chat-agents-full.png).
- Proposed fix: `grid-cols-[repeat(auto-fit,minmax(…))]` for stats and agent cards; collapse secondary page actions
  to icons with tooltips before wrapping.
- Severity: polish.

## D25 – Chart y-axis top without label

- Where: `apps/web/src/ui/charts.tsx:145-153`, `:209-211`, `:338-340`.
- Reproduce: Trading NVDA 1 T: candles reach ~132,9 $ above the top label 132,50 $, only three ticks; Depots Verlauf
  two ticks (SHOTS/light-1920-nochat-trade.png, light-1280-chat-portfolio-tr-full.png).
- Proposed fix: extend the domain to the next tick above/below (`lo = ticks[0]`, `hi = ticks.at(-1)` after
  `niceTicks(lo0, hi0)` with ceil/floor), aim for 4–6 ticks by height.
- Severity: polish.

## D26 – Phone header

- Where: `Shell.tsx:255-258`.
- Reproduce: 390 px: the top-right primary button reads only "4" (label sr-only), next to the chat unread badge "5"
  (SHOTS/dark-390-nochat-overview-full.png); stat labels truncate ("Vermögen (deine D…") with a hover-only tooltip.
- Proposed fix: icon plus count (list icon), shorter stat labels on phones.
- Severity: polish.
