// Standard-Universum für den Scanner: große, liquide Aktien, die der Desk neben der Watchlist alle paar Minuten abfragt
// (Yahoo-Schreibweise). Marktdaten, keine Empfehlung; Indexmitglieder wechseln – ein Symbol ohne Kurs fällt einfach
// heraus. In config.json ersetzt "universe": [...] die Liste, "universe": [] schaltet sie ab.
export const DEFAULT_UNIVERSE: readonly string[] = [
	// DAX
	"ADS.DE", "AIR.DE", "ALV.DE", "BAS.DE", "BAYN.DE", "BEI.DE", "BMW.DE", "BNR.DE", "CBK.DE", "CON.DE", "DB1.DE", "DBK.DE",
	"DHL.DE", "DTE.DE", "DTG.DE", "ENR.DE", "EOAN.DE", "FME.DE", "FRE.DE", "HEI.DE", "HEN3.DE", "HNR1.DE", "IFX.DE", "MBG.DE",
	"MRK.DE", "MTX.DE", "MUV2.DE", "P911.DE", "PAH3.DE", "QIA.DE", "RHM.DE", "RWE.DE", "SAP.DE", "SHL.DE", "SIE.DE", "SRT3.DE",
	"SY1.DE", "VNA.DE", "VOW3.DE", "ZAL.DE",
	// MDAX und TecDAX (Auswahl)
	"AIXA.DE", "AFX.DE", "BOSS.DE", "EVK.DE", "EVT.DE", "FRA.DE", "FNTN.DE", "G24.DE", "HAG.DE", "HLAG.DE", "HOT.DE", "JUN3.DE",
	"KGX.DE", "LEG.DE", "LHA.DE", "NDX1.DE", "NEM.DE", "PUM.DE", "R3NK.DE", "RAA.DE", "S92.DE", "SMHN.DE", "TKA.DE", "TLX.DE",
	"TMV.DE", "UTDI.DE", "WAF.DE",
	// Europa
	"ASML.AS", "MC.PA", "OR.PA", "TTE.PA", "SAN.PA", "AIR.PA", "BNP.PA", "SU.PA", "NOVO-B.CO", "NESN.SW", "ROG.SW", "NOVN.SW",
	"SHEL.L", "AZN.L", "HSBA.L", "ULVR.L",
	// USA
	"AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK-B", "JPM", "V", "MA", "UNH", "XOM", "LLY", "JNJ",
	"WMT", "PG", "HD", "COST", "NFLX", "AMD", "ORCL", "CRM", "ADBE", "PEP", "KO", "MRK", "ABBV", "BAC", "CSCO", "INTC", "QCOM",
	"TXN", "IBM", "CAT", "GE", "BA", "DIS", "NKE", "MCD", "PFE", "T", "VZ", "UBER", "PLTR", "COIN", "MU", "SHOP", "PYPL",
];
