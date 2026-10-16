# Working on Tradedesk

Local trading desk for the owner and his AI agents (README.md). TypeScript monorepo in the style of the AI Work
Dashboard: `apps/server` (Hono on Node >= 24, `node:sqlite`, desk service in `src/desk.ts`, market data in
`src/market.ts`), `apps/web` (React 19, Vite, Tailwind 4, TanStack Router/Query), `packages/shared` (zod contracts +
pure portfolio and risk logic), `cli/desk.py` (Python CLI the agents use). Follow
https://github.com/mauricekleindienst/AICodeGuidelines (read its CLAUDE.md first, especially
`engineering/ai-features.md`); this file wins where it is more specific.

## Owner decisions (standing)

- Commits are authored as `Maurice Kleindienst <kleindiema@gmail.com>`. No co-author or session trailers, no
  assistant or model names in commits, code, comments or docs.
- No pull requests unless asked. No force push, branch deletion or history rewrite without an explicit request.
- The repository is private; still no portfolio data in git (config.json and the database live in `~/.tradedesk`).
- UI texts German with "du"; code, identifiers and commit messages English. No emojis anywhere.
- Agents propose, the owner approves. There is no auto-approval; adding one is an owner decision recorded here.
- Trade Republic has no official API and the unofficial ones need the owner's PIN: not used. Manual accounts are
  recorded by hand or CSV; approved proposals wait until the owner enters the execution.
- Interactive Brokers is the live broker (owner decision 2026-10-15), through the Client Portal Gateway on localhost
  only; the owner logs in there, the desk never handles credentials. Every order needs the owner's click; IBKR's
  questions are shown in IBKR's words and confirmed by the owner. Real-money accounts stay locked until
  `"liveTrading": true`; a paper gateway session never sends for a live account.
- Agents are Claude Code sessions using `cli/desk.py` (`/desk-agent <Name>`, rules in `docs/AGENTS.md`), not API
  agents inside the desk (owner decision 2026-10-15).
- Quotes from Yahoo Finance (free, unofficial). The UI says "Keine Anlageberatung" and that quotes may be delayed.
  A paid real-time feed is an owner decision; the market sits behind `Market` in `src/market.ts`.
- Day trading defaults: risk per trade 1 % of the account (loss to the stop incl. both fees), agents must set a stop on
  buys, positions opened today get a reminder 15 minutes before the close. Stops and targets are reminders, never
  automatic orders.
- Chat: owner, agents and the desk in one room. Agent text is untrusted data, rendered as text only. A chat message
  never approves, rejects or executes anything; decisions stay on the buttons.

## Code rules

- Match the surrounding style and comment density (comments are German).
- API shapes change in `packages/shared/src/schema.ts` first; types are inferred from the zod schemas.
- Money in integer cents (EUR), rounded only in `cents()`; prices in the instrument's currency; quantities up to 6
  decimals. FIFO lots in `buildBook`.
- Every model-originated value is checked by code: agent names and accounts from config, symbols from the watchlist
  or holdings, the risk check in `checkOrder` before saving, again at approval and again at a limit fill. Approval
  re-reads the quote, claims atomically (`WHERE status = 'pending'`), may only shrink the quantity.
- Owner-only routes call `userOnly` (browser `Origin`); the CLI never gets an approve command.
- Broker access only through `src/broker.ts` and `localJson` (localhost only); contract tests in `test/ibkr.test.ts`
  follow IBKR's documented paths and bodies.
- Only `src/http.ts` calls `fetch` on the server; `desk.ts` takes the clock from `now()` (both guarded by tests).
- Migrations in `src/db.ts`: append only, never edit a released one.
- Design: tokens from `apps/web/src/styles.css`; gains and losses in text and fills (`text-ok`/`text-err`) with a
  sign, never as borders; no accent- or status-colored borders, outlines, glows or left bars; focus ring only
  `:focus-visible` with `--focus-ring` (guarded by `styles.test.ts`). Chart series colors are validated with the
  dataviz palette validator; light-mode slots below 3:1 always come with a legend and labels.

## Checks

```
npm run typecheck
npm test
npm run selftest
npm run build && npm run e2e
python cli/desk.py --selftest
```

Never kill processes by name or pattern; kill only PIDs you started.
