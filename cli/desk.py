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
  python cli/desk.py --selftest

Server: TRADEDESK_URL, else http://127.0.0.1:<port from ~/.tradedesk/config.json, default 8095>.
Exit codes: 0 ok, 1 refused or failed (message on stderr), 2 server not reachable.
"""
import argparse
import json
import os
import sys
import threading
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
    text = sys.stdin.read() if args.text == "-" else args.text
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
    s = sub.add_parser("notes")
    s.add_argument("--as", dest="as_")
    s.add_argument("--symbol")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--json", action="store_true")
    return ap


COMMANDS = {"status": cmd_status, "quote": cmd_quote, "watchlist": cmd_watchlist, "portfolio": cmd_portfolio, "propose": cmd_propose,
            "proposals": cmd_proposals, "journal": cmd_journal, "notes": cmd_notes}


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
            return self.reply(404, {"ok": False, "msg": "not found"})

    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ["TRADEDESK_URL"] = f"http://127.0.0.1:{srv.server_address[1]}"
    results = []

    def check(name, ok):
        results.append((name, ok))

    import contextlib
    import io

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
        os.environ["TRADEDESK_URL"] = "http://127.0.0.1:9"
        code, _, e = run(["status"])
        check("unreachable server exits 2", code == 2 and "not reachable" in e)
    finally:
        srv.shutdown()
    for name, ok in results:
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    failed = sum(1 for _, ok in results if not ok)
    print(f"{failed} of {len(results)} failed" if failed else f"all {len(results)} ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
