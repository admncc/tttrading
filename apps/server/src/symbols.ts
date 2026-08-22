/**
 * Cross-venue symbol aliases. The same asset trades under different tickers on
 * different venues — notably metals: Hyperliquid lists GOLD / SILVER, Aster
 * lists XAU / XAG. They are the SAME instrument, so internally we canonicalize
 * to one ticker (so conflict detection, same-coin isolation, exposure and
 * management all treat them as one), and each connector falls back to its own
 * ticker via the alias list when it can't find the canonical one.
 */
const GROUPS: string[][] = [
  ["GOLD", "XAU"], // canonical first
  ["SILVER", "XAG"],
  // "k"/"1000" meme coins: the raw price is so small that venues list a
  // 1000-unit contract — Hyperliquid as kSHIB, Binance-style venues (Aster) as
  // 1000SHIB. Same asset; the price is ×1000. Canonical is the raw ticker, and
  // the engine's existing magnitude-snap converts a raw-scale signal price to
  // the venue's ×1000 scale automatically (size derives from the venue mid).
  ["SHIB", "KSHIB", "1000SHIB"],
  ["PEPE", "KPEPE", "1000PEPE"],
  ["BONK", "KBONK", "1000BONK"],
  ["FLOKI", "KFLOKI", "1000FLOKI"],
  ["LUNC", "KLUNC", "1000LUNC"],
  ["DOGS", "KDOGS", "1000DOGS"],
  ["NEIRO", "KNEIRO", "1000NEIRO"],
];

const CANON = new Map<string, string>(); // member → canonical (group[0])
const ALIASES = new Map<string, string[]>(); // member → every member of its group
for (const g of GROUPS) {
  for (const m of g) {
    CANON.set(m, g[0]!);
    ALIASES.set(m, g);
  }
}

/** Canonical internal ticker for a symbol (e.g. XAU → GOLD, XAG → SILVER). */
export function canonicalSymbol(s: string): string {
  const u = s.trim().toUpperCase();
  return CANON.get(u) ?? u;
}

/** All venue tickers that mean the same asset, incl. the symbol itself. */
export function symbolAliases(s: string): string[] {
  const u = s.trim().toUpperCase();
  return ALIASES.get(u) ?? [u];
}

/** True if two symbols denote the same asset (identity or metal alias). */
export function sameAsset(a: string, b: string): boolean {
  return canonicalSymbol(a) === canonicalSymbol(b);
}
