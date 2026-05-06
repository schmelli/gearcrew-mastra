/**
 * Top-50 Brand Priority List for Round-Robin Enrichment
 *
 * Used by enrichmentLite (and future enrichmentPremium) to prioritize Top-50
 * brand items first when fetching candidates. Items from these brands get a
 * 7-day cooldown; long-tail items get 30-day cooldown.
 *
 * Sourced from:
 *   .planning/phases/09-geargraph-data-foundation/top-brands-snapshot.json
 *   (generated 2026-04-23T18:20:39Z, source_query=
 *    union(top_50_by_item_count_desc, eu_priority_11))
 *
 * 61 entries: top-50 by item count + 11 EU-priority brands.
 *
 * NOTE: Values are embedded as a static const at build time — do NOT load the
 * JSON at runtime to avoid cwd-relative path pitfalls in Docker / ts-node.
 *
 * Schema-drift discipline: gear_items.brand may have casing/diacritics drift
 * vs. this canonical list. `isTopBrand` performs case-insensitive comparison
 * against the canonical brand name for resilience.
 */

export const TOP_50_BRANDS: readonly string[] = [
  // Top by item_count (50 entries)
  "Sea to Summit",
  "Fjällräven",
  "Hilleberg",
  "Anfibio",
  "TOAKS Outdoor",
  "Cumulus",
  "Montane",
  "Therm-a-Rest",
  "Haglöfs",
  "HIKO",
  "Huckepacks",
  "Mountain Hardwear",
  "NEMO Equipment",
  "Nitecore",
  "Soto",
  "Trangia",
  "Warbonnet Outdoors",
  "Wild Sky Gear",
  "ESEE Knives",
  "Forclaz",
  "GERBER",
  "Hydrapak",
  "Patagonia",
  "Platypus",
  "Primus",
  "Snugpak",
  "Trek'n Eat",
  "3F UL Gear",
  "Amazon",
  "Arc'teryx",
  "AsTucas",
  "BRS",
  "Clif",
  "Deuter Sport GmbH",
  "Durston Gear",
  "Exped",
  "Fire Maple",
  "Flextail",
  "Garmin",
  "GramXpert",
  "GSI Outdoors",
  "Helinox",
  "Icebreaker",
  "Jetboil",
  "Katadyn",
  "Merino.tech",
  "MSR",
  "MYOG",
  "Naturehike",
  // EU priority brands (11 entries — `source: "eu_priority"`)
  "Bergans",
  "Berghaus",
  "Helsport",
  "Jack Wolfskin",
  "Klättermusen",
  "Lundhags",
  "Mammut",
  "Norrøna",
  "Ortovox",
  "Salewa",
  "Vaude",
  // Phase-10 additions (GEA-1091) — Bikepacking + Packrafting coverage push
  "Alpacka Raft",
  "Apidura",
  "Kokopelli",
  "Miss Grape",
  "MRS",
  "Restrap",
  "Revelate Designs",
  "Tailfin",
] as const;

const TOP_50_BRANDS_LOWER: ReadonlySet<string> = new Set(
  TOP_50_BRANDS.map((b) => b.toLowerCase()),
);

/**
 * Case-insensitive check whether a brand string matches the Top-50 priority
 * list. Returns false for null/undefined/empty.
 *
 * Use this for fairness/priority decisions in workflow orchestration. For SQL
 * round-robin queries, pass `TOP_50_BRANDS as string[]` to a `brand = ANY($1)`
 * predicate — Postgres `ANY` does exact-match, so item-side casing must agree
 * with the canonical list. The `gear_items.brand` column generally already
 * follows canonical casing (the Brand Normalizer enforces it on insert), so
 * exact-match is acceptable for the dominant case.
 */
export function isTopBrand(brand: string | null | undefined): boolean {
  if (!brand) return false;
  return TOP_50_BRANDS_LOWER.has(brand.toLowerCase());
}
