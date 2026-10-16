// Einstieg in den Desk. Die Teile liegen unter src/desk/ (Grundlage, Depots, Risiko, Markt, Vorschläge, Broker,
// manuelle Depots, Journal und Chat, Takt) – Übersicht in docs/ARCHITECTURE.md.
export { Desk } from "./desk/desk.ts";
export { DEFAULT_LIMITS, DeskError, type Origin } from "./desk/core.ts";
