# Glossar

Ein Begriff je Sache, überall gleich: in der Web-App, in den Meldungen des Servers, im Chat, in der CLI und in den
Docs (AICodeGuidelines `design/writing.md`). Die Texte stehen in den Katalogen `apps/web/src/i18n/de.ts`,
`apps/server/src/i18n/de.ts` und `packages/shared/src/i18n/de.ts`; `apps/web/test/i18n.test.ts` und
`apps/server/test/i18n.test.ts` prüfen, dass keine Variante aus der rechten Spalte darin vorkommt. Erlaubte
Schreibweisen (linke Spalte) zählen dabei nicht als Variante, auch nicht als Teil einer Zusammensetzung
(„Order-Rechner“ enthält „Rechner“, ist aber ein eigener Begriff).

Anrede ist „du“, Anführungszeichen „…“, Auslassung direkt am Wort („Freigeben…“), Minus als „−“, Bereiche mit
Halbgeviertstrich („4–12 Ziffern“), Dezimalkomma („1,5 %“), Tausenderpunkt („1.000 Trades“). Plural ausgeschrieben
(„1 Trade“, „2 Trades“), nie „Trade(s)“.

| Begriff | Bedeutung | Nicht verwenden |
|---|---|---|
| `Depot`, `Depots` | ein Eintrag des Desks mit Positionen und Cash: Papierdepot, Trade Republic (manuell) oder ein Broker-Depot (IBKR) | `Account`, `Desk-Konto`, `echtes Konto`, `Portfolio` |
| `Papierdepot` | Depot, das nur der Desk simuliert (`kind: "paper"`); kein Broker, kein Geld | `Spieldepot`, `Demodepot`, `Testdepot`, `Paper-Depot` |
| `Papierkonto`, `IBKR-Konto`, `Kontonummer` | das Konto beim Broker selbst (IBKR Paper Trading bzw. die Kontonummer U…/DU…), nicht das Depot im Desk | `Paperkonto`, `Paper-Account` |
| `Echtes Geld`, `echtes Geld`, `echtem Geld` | ein Broker-Depot mit `live: true`; Orders gehen an die Börse | `Echtgeld`, `reales Geld`, `Live-Geld` |
| `Vorschlag`, `Vorschläge` | eine Order, die ein Agent (oder du) vorschlägt und die auf deine Freigabe wartet | `Proposal`, `Antrag`, `Orderwunsch` |
| `Freigeben`, `freigeben`, `Freigabe`, `freigegeben` | deine Entscheidung, einen Vorschlag auszuführen bzw. zu senden | `Genehmigen`, `genehmigen`, `Genehmigung`, `Approve`, `akzeptieren` |
| `Ablehnen`, `ablehnen`, `abgelehnt` | deine Entscheidung gegen einen Vorschlag; auch die Antwort eines Brokers, der eine Order nicht annimmt | `Verwerfen`, `verwerfen`, `zurückweisen`, `Reject` |
| `Order`, `Orders` | ein Auftrag an die Börse (Market oder Limit), aus einem Vorschlag oder dem Order-Ticket | `Auftrag`, `Aufträge`, `Ordre` |
| `Trade`, `Trades` | ein gebuchter Kauf oder Verkauf im Depot; in der Auswertung der geschlossene Teil einer Position | `Transaktion`, `Geschäft` |
| `Ausführung`, `ausgeführt` | der tatsächliche Kauf oder Verkauf an der Börse (Kurs, Stückzahl, Gebühr) | `Fill`, `Execution`, `gefüllt` |
| `Stornieren`, `stornieren`, `storniert`, `Storno` | eine offene Order oder ein offenes Limit zurücknehmen | `canceln`, `gecancelt`, `annullieren` |
| `Not-Aus` | sperrt alle Freigaben und Ausführungen; Vorschläge kommen weiter an | `Notaus`, `Not-Stopp`, `Notstopp`, `Kill-Switch`, `Notbremse` |
| `Risiko bis Stop` | möglicher Verlust bis zum Stop-Loss inklusive beider Gebühren | `Risiko bis zum Stop`, `Stop-Risiko`, `Risiko zum Stop` |
| `Stop`, `Stop-Loss` | Kurs, bei dem du aussteigen willst; nur Erinnerung, nie eine automatische Order | `Stopp-Loss`, `Stoploss`, `Stop Loss` |
| `Kursziel`, `Ziel` | Kurs, bei dem du Gewinne mitnehmen willst; ebenfalls nur Erinnerung | `Take-Profit`, `Gewinnziel` |
| `Tagesverlust-Stopp`, `Tagesverlust` | Grenze für den Verlust eines Tages in % des Depots; danach keine Käufe mehr | `Tagesverlust-Stop`, `Tagesverlustgrenze`, `Daily Loss` |
| `Einstand` | durchschnittlicher Kaufkurs einer Position inklusive Gebühren | `Einstandskurs`, `Durchschnittskurs`, `Einkaufskurs` |
| `Einstieg` | geplanter Kaufkurs im Order-Rechner (noch keine Position) | `Einstiegspreis`, `Entry` |
| `Kurs`, `Kurse` | Preis eines Wertpapiers an der Börse | `Preis`, `Quote`, `Notierung` |
| `Gebühr`, `Gebühren` | Kosten einer Order beim Broker | `Fee`, `Provision`, `Ordergebühr` |
| `Watchlist` | deine Liste beobachteter Werte | `Merkliste`, `Beobachtungsliste` |
| `Scanner` | Rangliste der Watchlist-Werte für den Tageshandel | `Screener` |
| `Auswertung` | Seite und Zahlen zu geschlossenen Trades (Trefferquote, R, Drawdown) | `Statistik`, `Analytics`, `Reporting` |
| `Agent`, `Agenten` | eine Claude-Code-Sitzung mit `cli/desk.py`, die liest und vorschlägt | `Bot`, `KI-Agent`, `Assistent` |
| `Computer` | das Gerät, auf dem der Desk läuft | `Rechner`, `PC` |
| `Order-Rechner` | Bereich im Cockpit: Stückzahl aus Risiko-Budget und Stop; Produktname, steht immer ganz da | `Rechner`, `Positionsrechner`, `Ordersrechner` |

## Entscheidungen

- **„Computer“ statt „Rechner“** (Owner-Regel): „Rechner“ steht nie allein, weder für das Gerät noch als Kurzform des
  Order-Rechners. „Order-Rechner“ ist der Produktname des Bereichs im Cockpit (Rechner im Sinn von Taschenrechner) und
  wird immer ganz geschrieben, auch im Hinweis zur berechneten Stückzahl („Order-Rechner: 40“).
- **Depot und Konto**: Was der Desk führt, ist ein Depot. „Konto“ heißt nur das Konto beim Broker (IBKR-Konto,
  Papierkonto, Kontonummer) – so steht es in IBKRs eigener Oberfläche.
- **Stop und Stopp**: „Stop“ (Stop-Loss) ist der eingeführte Börsenbegriff; „Tagesverlust-Stopp“ ist der deutsche
  Begriff für die Tagesgrenze und bleibt so.
- Suchwörter der Befehlspalette (`de.nav.keywords`) sind absichtlich Synonyme, auch aus der rechten Spalte („Konto“
  findet die Depots, „Statistik“ die Auswertung); der Glossar-Test nimmt sie aus.
