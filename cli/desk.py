"""Tradedesk CLI for AI agents: read the market and portfolios, propose orders, write to the journal.

Agents propose, the owner approves in the browser. This CLI has no command to approve, reject, change limits or
switch the kill switch - the server refuses those without a browser anyway.

  python cli/desk.py status [--json]
  python cli/desk.py quote SAP.DE [--json]
  python cli/desk.py watchlist [--json]
  python cli/desk.py portfolio --account agent-atlas [--json]
  python cli/desk.py propose --as Atlas --account agent-atlas --symbol SAP.DE --side buy --qty 3 \
      --confidence 0.7 --thesis "why" [--limit 195] [--stop 185] [--target 230] [--dry-run]
  python cli/desk.py proposals [--as Atlas] [--status pending|active|filled|rejected|stale|expired] [--json]
  python cli/desk.py journal --as Atlas [--symbol SAP.DE] [--kind note|thesis|review] "text"   ("-" reads stdin)
  python cli/desk.py notes [--as Atlas] [--symbol SAP.DE] [--limit 20]

Daytrading:
  python cli/desk.py brief --as Atlas [--json]      everything at once: sessions, your account and day stats, positions,
                                                    scanner, your open and recently decided proposals, chat to you
  python cli/desk.py scan [--sort change|gap|relvol|atr] [--json]
  python cli/desk.py analyze SAP.DE [--json]        EMA 9/21, VWAP, RSI 14 on 1-minute candles, ATR 14 daily, gap, rel. volume
  python cli/desk.py news SAP.DE [--json]

Chat (with the owner and the other agents; a message never approves anything):
  python cli/desk.py say --as Atlas [--to Nova] [--ref SAP.DE|#12] "text"   ("-" reads stdin; @Name mentions)
  python cli/desk.py read --as Atlas [--all] [--limit 50] [--json]           new messages since your last read
  python cli/desk.py wait --as Atlas [--timeout 600]                         block until someone writes to you or to
                                                                            everyone (incl. the desk's answer to your
                                                                            proposals); exit 0 with the messages, 3 on timeout

  python cli/desk.py --selftest

Server: TRADEDESK_URL, else http://127.0.0.1:<port from ~/.tradedesk/config.json, default 8095>.
Exit codes: 0 ok, 1 refused or failed (message on stderr), 2 server not reachable.
"""
import argparse
import json
import locale
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

TIMEOUT = 20


class DeskError(Exception):
    def __init__(self, msg: str, code: int = 1):
        super().__init__(msg)
        self.code = code


def home() -> Path:
    return Path(os.environ.get("TRADEDESK_HOME") or Path.home() / ".tradedesk")


def base_url() -> str:
    if os.environ.get("TRADEDESK_URL"):
        return os.environ["TRADEDESK_URL"].rstrip("/")
    port = 8095
    try:
        port = int(json.loads((home() / "config.json").read_text(encoding="utf-8")).get("port", 8095))
    except (OSError, ValueError, AttributeError):
        pass
    return f"http://127.0.0.1:{port}"


def call(method: str, path: str, body=None):
    url = base_url() + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except ValueError:
            payload = {}
        raise DeskError(payload.get("msg") or f"HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise DeskError(f"Tradedesk not reachable at {url} ({e}). Is it running? (npm start in the tradedesk repo)", 2) from None


def money(cents) -> str:
    if cents is None:
        return "-"
    return f"{cents / 100:,.2f} EUR".replace(",", "X").replace(".", ",").replace("X", ".")


def pct(v) -> str:
    return "-" if v is None else f"{v:+.1f} %".replace(".", ",")


def num(v) -> str:
    if v is None:
        return "-"
    s = f"{v:,.6f}".rstrip("0").rstrip(".")
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def read_stdin() -> str:
    """Text von stdin ("-") immer als UTF-8 lesen. Windows dekodiert stdin sonst in der ANSI-Codepage, und aus
    „vorbörslich“ wird „vorbÃ¶rslich“. Was kein UTF-8 ist (Tastatur in einer alten Konsole), fällt auf die Codepage zurück."""
    raw = sys.stdin.buffer.read() if hasattr(sys.stdin, "buffer") else sys.stdin.read().encode("utf-8")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode(locale.getpreferredencoding(False), errors="replace")
    return text.lstrip("\ufeff")


def chat_since(since: int, limit: int = 100, pages: int = 50):
    """Alle Nachrichten nach since, seitenweise in Reihenfolge – auch wenn in einem Schwall mehr als limit kamen."""
    msgs = []
    for _ in range(pages):
        page = call("GET", f"/api/chat?since={since}&limit={limit}")
        msgs += page
        if len(page) < limit:
            break
        since = max(m["id"] for m in page)
    return msgs


def out(args, data, text: str):
    print(json.dumps(data, ensure_ascii=False, indent=2) if getattr(args, "json", False) else text)


def cmd_status(args):
    ping = call("GET", "/api/ping")
    ov = call("GET", "/api/overview")
    lines = [f"Tradedesk v{ping['version']} - owner {ov['user']}, market {ov['market']}" + (f" ({ov['marketError']})" if ov.get("marketError") else ""),
             "KILL SWITCH ON - nothing will be approved or executed" if ov["killSwitch"] else "trading active",
             f"agents: {', '.join(ping['agents']) or '-'}", "accounts:"]
    for a in ov["accounts"]:
        lines.append(f"  {a['id']:<16} {a['name']:<24} {a['kind']:<6} owner {a['owner']:<10} equity {money(a['equityCents'])}  cash {money(a['cashCents'])}  return {pct(a['returnPct'])}")
    lines.append(f"pending proposals: {ov['pending']}")
    out(args, {"ping": ping, "overview": ov}, "\n".join(lines))


def cmd_quote(args):
    q = call("GET", "/api/market/quote/" + urllib.parse.quote(args.symbol.upper(), safe=""))
    note = "" if q["watched"] else "  (not on the watchlist - you may only propose it if it is held in the account)"
    out(args, q, f"{q['symbol']} {q['name']}: {num(q['price'])} {q['currency']} (= {num(round(q['priceEur'], 4))} EUR){note}")


def cmd_watchlist(args):
    items = call("GET", "/api/market/watchlist")
    lines = [f"{w['symbol']:<10} {num(w['price']):>12} {w['currency']:<4} {pct(w['changePct']):>9}  {'held ' if w['held'] else ''}{w['name']}" for w in items]
    out(args, items, "\n".join(lines) or "watchlist is empty")


def cmd_portfolio(args):
    d = call("GET", "/api/accounts/" + urllib.parse.quote(args.account, safe=""))
    a = d["account"]
    lines = [f"{a['name']} ({a['id']}): equity {money(a['equityCents'])}, cash {money(a['cashCents'])}, unrealized {money(a['unrealizedCents'])}, realized {money(a['realizedCents'])}, return {pct(a['returnPct'])}"]
    for p in d["positions"]:
        lines.append(f"  {p['symbol']:<10} {num(p['qty']):>12} x avg {num(round(p['avgPrice'], 4))} EUR  value {money(p['valueCents'])}  P/L {pct(p['unrealizedPct'])}  weight {num(round(p['weightPct'], 1))} %")
    r = d["risk"]
    lines.append(f"limits: max order {money(r['maxOrderCents']) if r['maxOrderCents'] else 'none'}, max position {num(r['maxPositionPct'])} %, daily loss stop {num(r['dailyLossPct'])} %, max open proposals {r['maxOpenProposals']}")
    out(args, d, "\n".join(lines))


def cmd_propose(args):
    body = {"author": args.as_, "accountId": args.account, "symbol": args.symbol.upper(), "side": args.side, "qty": args.qty, "confidence": args.confidence, "thesis": args.thesis,
            "orderType": "limit" if args.limit is not None else "market"}
    for key, val in (("limitPrice", args.limit), ("stopLoss", args.stop), ("takeProfit", args.target)):
        if val is not None:
            body[key] = val
    path = "/api/proposals" + ("?dryRun=1" if args.dry_run else "")
    try:
        r = call("POST", path, body)
    except DeskError as e:
        raise DeskError(f"not proposed: {e}") from None
    c = r["check"]
    lines = []
    if args.dry_run:
        lines.append(f"dry run: {'would be accepted' if r['ok'] else 'would be refused'} - estimate {money(c['estimateCents'])} + fee {money(c['feeCents'])}")
    else:
        p = r["proposal"]
        lines.append(f"proposal #{p['id']} created: {p['side']} {num(p['qty'])} {p['symbol']} for {p['accountId']}, estimate {money(p['estimateCents'])} - waiting for the owner")
    lines += [f"  refused: {v}" for v in c["violations"]] + [f"  warning: {w}" for w in c["warnings"]]
    out(args, r, "\n".join(lines))
    if not r["ok"]:
        raise DeskError("", 1)


def cmd_proposals(args):
    q = {"limit": "50"}
    if args.as_:
        q["author"] = args.as_
    if args.status:
        q["status"] = args.status
    items = call("GET", "/api/proposals?" + urllib.parse.urlencode(q))
    lines = []
    for p in items:
        reason = f" - {p['reason']}" if p["reason"] else ""
        lines.append(f"#{p['id']:<4} {p['status']:<9} {p['author']:<10} {p['side']:<4} {num(p['approvedQty'] or p['qty']):>10} {p['symbol']:<10} {p['accountId']}{reason}")
    out(args, items, "\n".join(lines) or "no proposals")


def cmd_journal(args):
    text = read_stdin() if args.text == "-" else args.text
    body = {"author": args.as_, "text": text, "kind": args.kind}
    if args.symbol:
        body["symbol"] = args.symbol.upper()
    r = call("POST", "/api/journal", body)
    out(args, r, f"journal #{r['entry']['id']} saved")


def cmd_notes(args):
    q = {"limit": str(args.limit)}
    if args.as_:
        q["author"] = args.as_
    if args.symbol:
        q["symbol"] = args.symbol.upper()
    items = call("GET", "/api/journal?" + urllib.parse.urlencode(q))
    out(args, items, "\n\n".join(f"{j['author']} [{j['kind']}{' ' + j['symbol'] if j['symbol'] else ''}]\n{j['text']}" for j in items) or "no notes")


def cmd_scan(args):
    rows = call("GET", "/api/market/scan")
    key = {"change": lambda r: abs(r["changePct"] or 0), "gap": lambda r: abs(r["gapPct"] or 0), "relvol": lambda r: r["relVolume"] or 0, "atr": lambda r: r["atrPct"] or 0}[args.sort]
    rows = sorted(rows, key=key, reverse=True)
    lines = [f"{'symbol':<10} {'state':<6} {'price':>12} {'chg':>8} {'gap':>8} {'relvol':>7} {'atr%':>6} {'range':>6}"]
    for r in rows:
        rv = "-" if r["relVolume"] is None else f"{r['relVolume']:.1f}x"
        rp = "-" if r["rangePos"] is None else f"{r['rangePos'] * 100:.0f}%"
        atr = "-" if r["atrPct"] is None else f"{r['atrPct']:.1f}"
        lines.append(f"{r['symbol']:<10} {r['state']:<6} {num(r['price']):>12} {pct(r['changePct']):>8} {pct(r['gapPct']):>8} {rv:>7} {atr:>6} {rp:>6}{'  held' if r['held'] else ''}")
    out(args, rows, "\n".join(lines))


def cmd_analyze(args):
    a = call("GET", "/api/market/analysis/" + urllib.parse.quote(args.symbol.upper(), safe=""))
    def r(v, d=2):
        return "-" if v is None else f"{v:.{d}f}"
    lines = [f"{a['symbol']} {a['name']} ({a['currency']}, {a['state']}) price {r(a['price'])} chg {pct(a['changePct'])} gap {pct(a['gapPct'])}",
             f"day open {r(a['dayOpen'])} high {r(a['dayHigh'])} low {r(a['dayLow'])} prev close {r(a['prevClose'])}",
             f"1m: EMA9 {r(a['ema9'])}  EMA21 {r(a['ema21'])}  VWAP {r(a['vwap'])}  RSI14 {r(a['rsi14'], 0)}  ({a['candles']} candles)",
             f"daily ATR14 {r(a['atr14'])}  rel. volume {r(a['relVolume'], 1)}x"]
    out(args, a, "\n".join(lines))


def cmd_news(args):
    items = call("GET", "/api/market/news/" + urllib.parse.quote(args.symbol.upper(), safe=""))
    out(args, items, "\n".join(f"- {n['title']} ({n['publisher']})\n  {n['link']}" for n in items) or "no news")


def seen_file(name: str) -> Path:
    return home() / f"seen_{''.join(c for c in name.lower() if c.isalnum()) or 'x'}.txt"


def read_seen(name: str) -> int:
    try:
        return int(seen_file(name).read_text(encoding="utf-8").strip() or 0)
    except (OSError, ValueError):
        return 0


def write_seen(name: str, last: int):
    try:
        home().mkdir(parents=True, exist_ok=True)
        tmp = seen_file(name).with_suffix(".tmp")
        tmp.write_text(str(last), encoding="utf-8")
        os.replace(tmp, seen_file(name))
    except OSError:
        pass


def chat_line(m) -> str:
    to = f" -> {', '.join(m['to'])}" if m["to"] else ""
    ref = f" [{m['ref']}]" if m["ref"] else ""
    return f"#{m['id']} {m['author']}{to}{ref}: {m['text']}"


def cmd_say(args):
    text = read_stdin() if args.text == "-" else args.text
    body = {"author": args.as_, "text": text, "to": args.to or []}
    if args.ref:
        body["ref"] = args.ref
    r = call("POST", "/api/chat", body)
    out(args, r, f"sent #{r['message']['id']}" + (f" to {', '.join(r['message']['to'])}" if r["message"]["to"] else " to everyone"))


def cmd_read(args):
    msgs = call("GET", f"/api/chat?limit={args.limit}") if args.all else chat_since(read_seen(args.as_), args.limit)
    me = args.as_.lower()
    if not args.all:
        msgs = [m for m in msgs if m["author"].lower() != me]
    if msgs:
        write_seen(args.as_, max(m["id"] for m in msgs))
    lines = [("* " if any(t.lower() == me for t in m["to"]) else "  ") + chat_line(m) for m in msgs]
    out(args, msgs, "\n".join(lines) or "no new messages")


def cmd_wait(args):
    """Polls the chat (every few seconds) until there is something for this agent; marks it read like `read`."""
    me = args.as_.lower()
    since = read_seen(args.as_)
    deadline = time.time() + max(5, args.timeout)
    while True:
        msgs = chat_since(since)
        mine = [m for m in msgs if m["author"].lower() != me and (not m["to"] or any(t.lower() == me for t in m["to"]))]
        if msgs:
            since = max(m["id"] for m in msgs)
        if mine:
            write_seen(args.as_, since)
            out(args, mine, "\n".join(("* " if any(t.lower() == me for t in m["to"]) else "  ") + chat_line(m) for m in mine))
            return
        if time.time() >= deadline:
            write_seen(args.as_, since)
            if not args.json:
                print("nothing new")
            raise DeskError("", 3)
        time.sleep(min(args.every, max(0.5, deadline - time.time())))


def cmd_brief(args):
    me = args.as_
    ping = call("GET", "/api/ping")
    if me.lower() not in [a.lower() for a in ping["agents"]]:
        raise DeskError(f"unknown agent {me} - known: {', '.join(ping['agents']) or '-'}")
    me = next(a for a in ping["agents"] if a.lower() == me.lower())
    cp = call("GET", "/api/cockpit")
    props = call("GET", "/api/proposals?" + urllib.parse.urlencode({"author": me, "limit": "20"}))
    msgs = chat_since(read_seen(me))
    msgs = [m for m in msgs if m["author"] != me and (not m["to"] or me in m["to"])]
    own = next((d for d in cp["days"] if d["owner"] == me), None)
    data = {"me": me, "killSwitch": cp["killSwitch"], "market": cp["market"], "sessions": cp["sessions"], "myAccount": own,
            "positions": [p for p in cp["positions"] if own and p["accountId"] == own["accountId"]],
            "ownerAccounts": [d for d in cp["days"] if d["owner"] == "user"], "scan": cp["scan"], "proposals": props, "chat": msgs}
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        lines = [f"brief for {me} - market {cp['market']}" + ("  KILL SWITCH ON" if cp["killSwitch"] else "")]
        lines.append("sessions: " + ", ".join(f"{s['exchange']} {s['state']}" for s in cp["sessions"]) if cp["sessions"] else "sessions: -")
        if own:
            st = own["stats"]
            lines.append(f"my account {own['accountId']}: equity {money(own['equityCents'])}, cash {money(own['cashCents'])}, today {money(own['dayChangeCents'])}, realized {money(st['realizedCents'])}, trades {st['trades']}, closed {st['closed']} ({st['wins']}W/{st['losses']}L)")
        for p in data["positions"]:
            r = "-" if p["r"] is None else f"{p['r']:+.1f}R"
            lines.append(f"  pos {p['symbol']:<10} {num(p['qty'])} avg {num(round(p['avgPrice'], 4))} EUR  P/L {money(p['unrealizedCents'])} {r}  stop {num(p['stopLoss'])}")
        lines.append("scanner (top 8 by |change|):")
        for r in sorted(cp["scan"], key=lambda r: abs(r["changePct"] or 0), reverse=True)[:8]:
            rv = "-" if r["relVolume"] is None else f"{r['relVolume']:.1f}x"
            lines.append(f"  {r['symbol']:<10} {r['state']:<6} {num(r['price']):>12} {pct(r['changePct']):>8} gap {pct(r['gapPct'])} rv {rv}")
        lines.append("my proposals:")
        for p in props[:8]:
            lines.append(f"  #{p['id']} {p['status']:<9} {p['side']} {num(p['approvedQty'] or p['qty'])} {p['symbol']}" + (f" - {p['reason']}" if p["reason"] else ""))
        lines.append(f"chat for me ({len(msgs)} new):")
        lines += ["  " + chat_line(m) for m in msgs[-10:]]
        print("\n".join(lines))


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="desk.py", description="Tradedesk CLI for agents (propose, never approve).")
    ap.add_argument("--selftest", action="store_true")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("status")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("quote")
    s.add_argument("symbol")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("watchlist")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("portfolio")
    s.add_argument("--account", required=True)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("propose")
    s.add_argument("--as", dest="as_", required=True)
    s.add_argument("--account", required=True)
    s.add_argument("--symbol", required=True)
    s.add_argument("--side", choices=["buy", "sell"], required=True)
    s.add_argument("--qty", type=float, required=True)
    s.add_argument("--confidence", type=float, required=True, help="0..1; below the owner's minimum nothing is proposed")
    s.add_argument("--thesis", required=True)
    s.add_argument("--limit", type=float)
    s.add_argument("--stop", type=float)
    s.add_argument("--target", type=float)
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("proposals")
    s.add_argument("--as", dest="as_")
    s.add_argument("--status")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("journal")
    s.add_argument("--as", dest="as_", required=True)
    s.add_argument("--symbol")
    s.add_argument("--kind", choices=["note", "thesis", "review"], default="note")
    s.add_argument("text")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("scan")
    s.add_argument("--sort", choices=["change", "gap", "relvol", "atr"], default="change")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("analyze")
    s.add_argument("symbol")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("news")
    s.add_argument("symbol")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("brief")
    s.add_argument("--as", dest="as_", required=True)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("say")
    s.add_argument("--as", dest="as_", required=True)
    s.add_argument("--to", action="append")
    s.add_argument("--ref")
    s.add_argument("text")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("read")
    s.add_argument("--as", dest="as_", required=True)
    s.add_argument("--all", action="store_true", help="whole history, not only new messages")
    s.add_argument("--limit", type=int, default=50)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("wait")
    s.add_argument("--as", dest="as_", required=True)
    s.add_argument("--timeout", type=float, default=600)
    s.add_argument("--every", type=float, default=5, help=argparse.SUPPRESS)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("notes")
    s.add_argument("--as", dest="as_")
    s.add_argument("--symbol")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--json", action="store_true")
    return ap


COMMANDS = {"status": cmd_status, "quote": cmd_quote, "watchlist": cmd_watchlist, "portfolio": cmd_portfolio, "propose": cmd_propose,
            "proposals": cmd_proposals, "journal": cmd_journal, "notes": cmd_notes, "scan": cmd_scan, "analyze": cmd_analyze, "news": cmd_news,
            "brief": cmd_brief, "say": cmd_say, "read": cmd_read, "wait": cmd_wait}


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")   # Windows-Konsole: Umlaute aus den Server-Meldungen
    ap = parser()
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    if not args.cmd:
        ap.print_help()
        return 1
    try:
        COMMANDS[args.cmd](args)
        return 0
    except DeskError as e:
        if str(e):
            print(str(e), file=sys.stderr)
        return e.code


# ---------------------------------------------------------------- selftest: fake server, no network, no real data

def selftest() -> int:
    seen = []
    chat_extra = []

    class Fake(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, payload):
            raw = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            seen.append(("GET", self.path, None, self.headers.get("Origin")))
            if self.path == "/api/ping":
                return self.reply(200, {"ok": True, "version": 1, "user": "Owner", "agents": ["Atlas"], "accounts": []})
            if self.path == "/api/overview":
                return self.reply(200, {"user": "Owner", "market": "live", "marketError": None, "killSwitch": False, "pending": 1,
                                        "accounts": [{"id": "agent-atlas", "name": "Papierdepot Atlas", "kind": "paper", "owner": "Atlas", "equityCents": 1000000, "cashCents": 500000, "returnPct": 1.5}]})
            if self.path.startswith("/api/market/quote/"):
                return self.reply(200, {"symbol": "SAP.DE", "name": "SAP SE", "currency": "EUR", "price": 201.25, "fx": 1, "priceEur": 201.25, "watched": True})
            if self.path.startswith("/api/chat"):
                # wie der Server: mit since die nächsten limit in Reihenfolge, ohne since die neuesten limit
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                limit = int(q.get("limit", ["200"])[0])
                msgs = [{"id": 4, "time": 1, "author": "Nova", "role": "agent", "text": "@Atlas Gap bei SAP?", "to": ["Atlas"], "ref": "SAP.DE"},
                        {"id": 5, "time": 2, "author": "Owner", "role": "user", "text": "an alle", "to": [], "ref": None}] + chat_extra
                if "since" not in q:
                    return self.reply(200, msgs[-limit:])
                since = int(q["since"][0])
                return self.reply(200, [m for m in msgs if m["id"] > since][:limit])
            if self.path == "/api/market/scan":
                return self.reply(200, [{"symbol": "SAP.DE", "state": "open", "price": 201.25, "changePct": 2.2, "gapPct": 0.5, "relVolume": 1.8, "atrPct": 2.1, "rangePos": 0.8, "held": False},
                                        {"symbol": "NVDA", "state": "pre", "price": 217.0, "changePct": -4.0, "gapPct": -3.0, "relVolume": None, "atrPct": None, "rangePos": None, "held": True}])
            if self.path.startswith("/api/proposals"):
                return self.reply(200, [{"id": 7, "status": "rejected", "author": "Atlas", "side": "buy", "qty": 3, "approvedQty": None, "symbol": "SAP.DE", "accountId": "agent-atlas", "reason": "zu teuer"}])
            return self.reply(404, {"ok": False, "msg": "not found"})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            seen.append(("POST", self.path, body, self.headers.get("Origin")))
            check = {"ok": True, "violations": [], "warnings": [], "estimateCents": 60375, "feeCents": 100, "price": 201.25}
            if self.path.startswith("/api/proposals"):
                if body.get("symbol") == "TSLA":
                    return self.reply(422, {"ok": False, "msg": "TSLA steht nicht auf der Watchlist und nicht im Depot.", "check": {**check, "ok": False}})
                if "dryRun=1" in self.path:
                    return self.reply(200, {"ok": True, "check": check, "proposal": None})
                return self.reply(200, {"ok": True, "check": check, "proposal": {"id": 8, "side": body["side"], "qty": body["qty"], "symbol": body["symbol"], "accountId": body["accountId"], "estimateCents": 60375}})
            if self.path == "/api/journal":
                return self.reply(200, {"ok": True, "entry": {"id": 3}})
            if self.path == "/api/chat":
                return self.reply(200, {"ok": True, "message": {"id": 9, "to": body.get("to") or [], "author": body["author"]}})
            return self.reply(404, {"ok": False, "msg": "not found"})

    import tempfile
    tmpdir = tempfile.mkdtemp(prefix="desk-cli-")
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ["TRADEDESK_URL"] = f"http://127.0.0.1:{srv.server_address[1]}"
    results = []

    def check(name, ok):
        results.append((name, ok))

    import contextlib
    import io
    import subprocess

    def run(argv):
        o, e = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
            code = main(argv)
        return code, o.getvalue(), e.getvalue()

    try:
        code, o, _ = run(["status"])
        check("status lists the agent account", code == 0 and "agent-atlas" in o and "trading active" in o)
        code, o, _ = run(["quote", "sap.de"])
        check("quote upper-cases the symbol", code == 0 and "SAP SE" in o and seen[-1][1] == "/api/market/quote/SAP.DE")
        code, o, _ = run(["propose", "--as", "Atlas", "--account", "agent-atlas", "--symbol", "sap.de", "--side", "buy", "--qty", "3", "--confidence", "0.7", "--thesis", "t", "--limit", "195", "--stop", "180"])
        body = seen[-1][2]
        check("propose sends a limit order with stop", code == 0 and "#8" in o and body["orderType"] == "limit" and body["limitPrice"] == 195 and body["stopLoss"] == 180 and "takeProfit" not in body)
        check("CLI never sends an Origin header", all(s[3] is None for s in seen))
        code, o, _ = run(["propose", "--as", "Atlas", "--account", "agent-atlas", "--symbol", "SAP.DE", "--side", "buy", "--qty", "1", "--confidence", "0.9", "--thesis", "t", "--dry-run"])
        check("dry run hits dryRun=1", code == 0 and "would be accepted" in o and seen[-1][1].endswith("dryRun=1"))
        code, _, e = run(["propose", "--as", "Atlas", "--account", "agent-atlas", "--symbol", "TSLA", "--side", "buy", "--qty", "1", "--confidence", "0.9", "--thesis", "t"])
        check("refused proposal exits 1 with the reason", code == 1 and "Watchlist" in e)
        code, o, _ = run(["proposals", "--as", "Atlas"])
        check("proposals show the rejection reason", code == 0 and "zu teuer" in o)
        code, o, _ = run(["journal", "--as", "Atlas", "--symbol", "sap.de", "Notiz mit Umlauten äöü"])
        check("journal posts text and symbol", code == 0 and seen[-1][2]["symbol"] == "SAP.DE" and "äöü" in seen[-1][2]["text"])
        check("no approve command exists", "approve" not in COMMANDS)
        code, o, _ = run(["scan", "--sort", "change"])
        check("scan sorts by absolute change", code == 0 and o.splitlines()[1].startswith("NVDA"))
        code, o, _ = run(["say", "--as", "Atlas", "--to", "Nova", "--ref", "SAP.DE", "Gap sieht gut aus"])
        check("say sends recipients and ref", code == 0 and seen[-1][2]["to"] == ["Nova"] and seen[-1][2]["ref"] == "SAP.DE")
        os.environ["TRADEDESK_HOME"] = tmpdir
        code, o, _ = run(["read", "--as", "Atlas"])
        check("read marks messages to me", code == 0 and "* #4 Nova -> Atlas" in o and "#5 Owner" in o)
        code, o, _ = run(["read", "--as", "Atlas"])
        check("read shows only new messages the second time", code == 0 and "no new messages" in o)
        code, o, _ = run(["wait", "--as", "Atlas", "--timeout", "0.2", "--every", "0.1"])
        check("wait times out with exit 3 when nothing is new", code == 3 and "nothing new" in o)
        code, o, _ = run(["wait", "--as", "Nova", "--timeout", "2", "--every", "0.1"])
        check("wait returns messages for everyone at once", code == 0 and "#5 Owner" in o)
        chat_extra.extend({"id": i, "time": i, "author": "Nova", "role": "agent", "text": f"Schwall {i}", "to": [], "ref": None} for i in range(6, 13))
        code, o, _ = run(["read", "--as", "Atlas", "--limit", "2"])
        check("read pages through a burst larger than --limit and loses nothing", code == 0 and all(f"#{i} Nova" in o for i in range(6, 13)) and read_seen("Atlas") == 12)
        code, o, _ = run(["read", "--as", "Atlas", "--limit", "2"])
        check("after the burst nothing is new", code == 0 and "no new messages" in o)
        # echter Prozess wie unter Windows: Text über stdin ("-") als UTF-8, auch wenn die Konsole eine ANSI-Codepage hat
        word = "vorbörslich – Größe über 5 €"
        for cmd in (["say", "--as", "Atlas", "-"], ["journal", "--as", "Atlas", "-"]):
            env = {k: v for k, v in os.environ.items() if k not in ("PYTHONUTF8", "PYTHONIOENCODING")}
            r = subprocess.run([sys.executable, os.path.abspath(__file__), *cmd], input=(word + "\n").encode("utf-8"), env=env, capture_output=True, timeout=30)
            check(f"{cmd[0]} reads umlauts from stdin as UTF-8", r.returncode == 0 and seen[-1][2]["text"].strip() == word)
        code, o, _ = run(["say", "--as", "Atlas", word])
        check("say sends umlauts from argv unchanged", code == 0 and seen[-1][2]["text"] == word)
        os.environ["TRADEDESK_URL"] = "http://127.0.0.1:9"
        code, _, e = run(["status"])
        check("unreachable server exits 2", code == 2 and "not reachable" in e)
    finally:
        srv.shutdown()
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    for name, ok in results:
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    failed = sum(1 for _, ok in results if not ok)
    print(f"{failed} of {len(results)} failed" if failed else f"all {len(results)} ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
