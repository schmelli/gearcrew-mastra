/**
 * Quick Research for Import Enrichment — Gardener Copy
 * Phase 27 — ARCH-01: Migrated from winterberry lib/enrichment/quick-research-import.ts
 *
 * Provides instant brand extraction from a known brands list (70+ entries)
 * and a quick research function that combines local matching with
 * Serper Knowledge Graph fallback.
 *
 * Gardener-native: relative .js imports (ESM), no @/ aliases.
 */

import { searchKnowledgeGraph } from "./serper-knowledge-graph.js";

// =============================================================================
// Types
// =============================================================================

export interface BrandMatch {
  /** Canonical brand name (properly cased) */
  brand: string;
  /** Parent company (e.g. "Decathlon") or null for independent brands */
  parent: string | null;
}

export interface QuickResearchResult {
  brand: string | null;
  correctedName: string | null;
  description: string | null;
}

// =============================================================================
// Known Brands Registry
// =============================================================================

/**
 * Map of lowercase brand name/alias → BrandMatch.
 * Aliases (e.g. "thermarest" for "Therm-a-Rest") point to the same entry.
 */
const KNOWN_BRANDS: ReadonlyMap<string, BrandMatch> = new Map<
  string,
  BrandMatch
>([
  // --- Decathlon ecosystem ---
  ["kiprun", { brand: "Kiprun", parent: "Decathlon" }],
  ["forclaz", { brand: "Forclaz", parent: "Decathlon" }],
  ["quechua", { brand: "Quechua", parent: "Decathlon" }],
  ["solognac", { brand: "Solognac", parent: "Decathlon" }],
  ["simond", { brand: "Simond", parent: "Decathlon" }],
  ["domyos", { brand: "Domyos", parent: "Decathlon" }],
  ["btwin", { brand: "B'Twin", parent: "Decathlon" }],
  ["kalenji", { brand: "Kalenji", parent: "Decathlon" }],
  ["tribord", { brand: "Tribord", parent: "Decathlon" }],
  ["aptonia", { brand: "Aptonia", parent: "Decathlon" }],
  ["wedze", { brand: "Wedze", parent: "Decathlon" }],
  ["orao", { brand: "Orao", parent: "Decathlon" }],

  // --- Major outdoor brands ---
  ["msr", { brand: "MSR", parent: null }],
  ["osprey", { brand: "Osprey", parent: null }],
  ["nemo", { brand: "NEMO", parent: null }],
  ["therm-a-rest", { brand: "Therm-a-Rest", parent: null }],
  ["thermarest", { brand: "Therm-a-Rest", parent: null }],
  ["black diamond", { brand: "Black Diamond", parent: null }],
  ["sea to summit", { brand: "Sea to Summit", parent: null }],
  ["exped", { brand: "Exped", parent: null }],
  ["big agnes", { brand: "Big Agnes", parent: null }],
  ["zpacks", { brand: "Zpacks", parent: null }],
  ["gossamer gear", { brand: "Gossamer Gear", parent: null }],
  ["granite gear", { brand: "Granite Gear", parent: null }],
  ["rab", { brand: "Rab", parent: null }],
  ["montbell", { brand: "Montbell", parent: null }],
  ["mont-bell", { brand: "Montbell", parent: null }],
  ["katadyn", { brand: "Katadyn", parent: null }],
  ["sawyer", { brand: "Sawyer", parent: null }],
  ["petzl", { brand: "Petzl", parent: null }],
  ["brs", { brand: "BRS", parent: null }],
  ["soto", { brand: "SOTO", parent: null }],
  ["toaks", { brand: "TOAKS", parent: null }],
  ["locus gear", { brand: "Locus Gear", parent: null }],
  ["durston", { brand: "Durston", parent: null }],
  ["tarptent", { brand: "Tarptent", parent: null }],
  ["enlightened equipment", { brand: "Enlightened Equipment", parent: null }],
  ["cumulus", { brand: "Cumulus", parent: null }],
  ["aegismax", { brand: "Aegismax", parent: null }],
  ["naturehike", { brand: "Naturehike", parent: null }],
  ["paria", { brand: "Paria", parent: null }],
  ["snugpak", { brand: "Snugpak", parent: null }],
  ["haglöfs", { brand: "Haglöfs", parent: null }],
  ["haglofs", { brand: "Haglöfs", parent: null }],
  ["hilleberg", { brand: "Hilleberg", parent: null }],
  ["jetboil", { brand: "Jetboil", parent: null }],
  ["primus", { brand: "Primus", parent: null }],
  ["leki", { brand: "LEKI", parent: null }],
  ["salomon", { brand: "Salomon", parent: null }],
  ["mammut", { brand: "Mammut", parent: null }],
  ["deuter", { brand: "Deuter", parent: null }],
  ["vaude", { brand: "Vaude", parent: null }],
  ["jack wolfskin", { brand: "Jack Wolfskin", parent: null }],
  ["arc'teryx", { brand: "Arc'teryx", parent: null }],
  ["arcteryx", { brand: "Arc'teryx", parent: null }],
  ["patagonia", { brand: "Patagonia", parent: null }],
  ["the north face", { brand: "The North Face", parent: null }],
  ["north face", { brand: "The North Face", parent: null }],
  ["marmot", { brand: "Marmot", parent: null }],
  ["gregory", { brand: "Gregory", parent: null }],
  ["kelty", { brand: "Kelty", parent: null }],
  ["rei", { brand: "REI", parent: null }],
  ["cocoon", { brand: "Cocoon", parent: null }],
  ["buff", { brand: "Buff", parent: null }],
  ["garmin", { brand: "Garmin", parent: null }],
  ["nitecore", { brand: "Nitecore", parent: null }],
  ["anker", { brand: "Anker", parent: null }],
  ["nalgene", { brand: "Nalgene", parent: null }],
  ["platypus", { brand: "Platypus", parent: null }],
  ["cnoc", { brand: "CNOC", parent: null }],
  ["smartwater", { brand: "Smartwater", parent: null }],
  // UL / Cottage brands
  ["hyperlite mountain gear", { brand: "Hyperlite Mountain Gear", parent: null }],
  ["hyperlite", { brand: "Hyperlite Mountain Gear", parent: null }],
  ["hmg", { brand: "Hyperlite Mountain Gear", parent: null }],
  ["bonfus", { brand: "Bonfus", parent: null }],
  ["farlite", { brand: "Farlite", parent: null }],
  ["liteway", { brand: "Liteway", parent: null }],
  ["atom packs", { brand: "Atom Packs", parent: null }],
  ["palante", { brand: "Pa'lante", parent: null }],
  ["ula", { brand: "ULA Equipment", parent: null }],
  ["katabatic", { brand: "Katabatic Gear", parent: null }],
  ["nunatak", { brand: "Nunatak", parent: null }],
  ["timmermade", { brand: "Timmermade", parent: null }],
  ["borah gear", { brand: "Borah Gear", parent: null }],
  ["senchi", { brand: "Senchi Designs", parent: null }],
  ["waymark", { brand: "Waymark Gear Co", parent: null }],
  ["six moon designs", { brand: "Six Moon Designs", parent: null }],
  ["yama mountain gear", { brand: "Yama Mountain Gear", parent: null }],
  // More mainstream brands
  ["decathlon", { brand: "Decathlon", parent: null }],
  ["columbia", { brand: "Columbia", parent: null }],
  ["mountain hardwear", { brand: "Mountain Hardwear", parent: null }],
  ["outdoor research", { brand: "Outdoor Research", parent: null }],
  ["western mountaineering", { brand: "Western Mountaineering", parent: null }],
  ["neoair", { brand: "Therm-a-Rest", parent: null }],
  ["xlite", { brand: "Therm-a-Rest", parent: null }],
  // Clothing & accessories
  ["darn tough", { brand: "Darn Tough", parent: null }],
  ["saxx", { brand: "Saxx", parent: null }],
  ["icebreaker", { brand: "Icebreaker", parent: null }],
  ["smartwool", { brand: "Smartwool", parent: null }],
  ["injinji", { brand: "Injinji", parent: null }],
  ["drymax", { brand: "Drymax", parent: null }],
  ["revolution race", { brand: "Revolution Race", parent: null }],
  ["fjällräven", { brand: "Fjällräven", parent: null }],
  ["fjallraven", { brand: "Fjällräven", parent: null }],
  ["craghoppers", { brand: "Craghoppers", parent: null }],
  ["mountain equipment", { brand: "Mountain Equipment", parent: null }],
  // Cottage / UL additional
  ["hyberg", { brand: "Hyberg", parent: null }],
  ["ultralightworks", { brand: "Ultralightworks", parent: null }],
  ["gear swifts", { brand: "Gear Swifts", parent: null }],
  ["mld", { brand: "Mountain Laurel Designs", parent: null }],
  ["mountain laurel designs", { brand: "Mountain Laurel Designs", parent: null }],
  ["swd", { brand: "Superior Wilderness Designs", parent: null }],
  ["liteaf", { brand: "LiteAF", parent: null }],
  ["zimmerbuilt", { brand: "Zimmerbuilt", parent: null }],
  ["dandee", { brand: "Dandee", parent: null }],
  ["senchi designs", { brand: "Senchi Designs", parent: null }],
  ["thinlight", { brand: "Thinlight", parent: null }],
  ["nylofume", { brand: "Nylofume", parent: null }],
  // Electronics
  ["apple", { brand: "Apple", parent: null }],
  ["iphone", { brand: "Apple", parent: null }],
  ["samsung", { brand: "Samsung", parent: null }],
  ["suunto", { brand: "Suunto", parent: null }],
  ["coros", { brand: "COROS", parent: null }],
  ["olight", { brand: "Olight", parent: null }],
  ["fenix", { brand: "Fenix", parent: null }],
  ["goal zero", { brand: "Goal Zero", parent: null }],
  ["biolite", { brand: "BioLite", parent: null }],
]);

/**
 * Decathlon model prefix patterns.
 */
const DECATHLON_PREFIX_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  brand: string;
}> = [
  { pattern: /^MT\d/i, brand: "Forclaz" },
  { pattern: /^MH\d/i, brand: "Quechua" },
  { pattern: /^NH\d/i, brand: "Quechua" },
  { pattern: /^SH\d/i, brand: "Quechua" },
  { pattern: /^FH\d/i, brand: "Quechua" },
  { pattern: /^A\d{2,}/i, brand: "Quechua" },
];

// =============================================================================
// Sorted brand keys for multi-word prefix matching (longest first)
// =============================================================================

const SORTED_BRAND_KEYS: readonly string[] = [...KNOWN_BRANDS.keys()].sort(
  (a, b) => {
    const wordDiff = b.split(" ").length - a.split(" ").length;
    if (wordDiff !== 0) return wordDiff;
    return b.length - a.length;
  },
);

// =============================================================================
// extractKnownBrand
// =============================================================================

/**
 * Instantly extract a brand from a product name using the known brands list
 * and Decathlon model prefix patterns. No API calls.
 */
export function extractKnownBrand(productName: string): BrandMatch | null {
  if (!productName?.trim()) return null;

  const normalized = productName.trim().toLowerCase();

  // Strategy 1: Check known brand names (longest match first)
  for (const key of SORTED_BRAND_KEYS) {
    if (normalized.startsWith(key)) {
      const nextChar = normalized[key.length];
      if (nextChar === undefined || nextChar === " " || nextChar === "-") {
        return KNOWN_BRANDS.get(key) ?? null;
      }
    }
  }

  // Strategy 2: Check Decathlon model prefix patterns on the first word
  const firstWord = normalized.split(/\s+/)[0];
  if (firstWord) {
    for (const { pattern, brand } of DECATHLON_PREFIX_PATTERNS) {
      if (pattern.test(firstWord)) {
        return { brand, parent: "Decathlon" };
      }
    }
  }

  return null;
}

// =============================================================================
// quickResearchItem
// =============================================================================

/**
 * Quick research for a single item: tries instant brand extraction first,
 * then falls back to Serper Knowledge Graph search.
 */
export async function quickResearchItem(
  refName: string | null,
  refCategory: string | null,
): Promise<QuickResearchResult | null> {
  if (!refName?.trim()) return null;

  const name = refName.trim();

  // Step 1: Try instant brand extraction
  const localMatch = extractKnownBrand(name);

  // Step 2: Build search query and call Serper Knowledge Graph
  const searchQuery = refCategory
    ? `${name} ${refCategory} outdoor gear`
    : `${name} outdoor gear`;

  const kgResult = await searchKnowledgeGraph(searchQuery);

  // Determine brand: local match takes priority, then KG result, then first-word heuristic
  let brand = localMatch?.brand ?? kgResult.brand ?? null;

  // Fallback: extract first word(s) as brand candidate if still unknown
  if (!brand) {
    brand = extractFirstWordAsBrand(name);
  }

  const description = kgResult.description ?? null;

  if (!brand && !description) {
    return null;
  }

  return {
    brand,
    correctedName: null,
    description,
  };
}

// =============================================================================
// First-Word Brand Extraction Fallback
// =============================================================================

/** Common words that are NOT brand names (lowercase) */
const NON_BRAND_WORDS = new Set([
  // German generic
  "der", "die", "das", "ein", "eine", "kleine", "kleiner", "großer", "große",
  "leicht", "leichte", "leichter", "schwer", "schwere", "lang", "kurz",
  "set", "paar", "extra", "ersatz", "neu", "alt",
  // English generic
  "the", "a", "an", "small", "large", "light", "heavy", "long", "short",
  "mini", "micro", "ultra", "super", "pro", "max", "big",
  // Gear categories
  "hiking", "camping", "trekking", "outdoor", "trail", "rain", "down",
  "fleece", "wool", "merino", "synthetic", "waterproof", "windproof",
  // Non-product items
  "personalausweis", "geldkarte", "geld", "bargeld", "schlüssel",
  "taschentücher", "toilettenpapier", "zahnbürste", "zahnpasta",
  "sonnencreme", "lippenpflege", "erste", "hilfe", "notfall",
]);

function extractFirstWordAsBrand(productName: string): string | null {
  const words = productName.trim().split(/\s+/);
  if (words.length < 2) return null;

  const firstWord = words[0];
  if (!firstWord) return null;

  if (
    firstWord[0] !== firstWord[0].toUpperCase() ||
    firstWord[0] === firstWord[0].toLowerCase()
  ) {
    return null;
  }

  if (NON_BRAND_WORDS.has(firstWord.toLowerCase())) return null;

  if (/^\d/.test(firstWord)) return null;

  if (words.length >= 3 && words[1]) {
    const secondWord = words[1];
    if (
      secondWord[0] === secondWord[0].toUpperCase() &&
      secondWord[0] !== secondWord[0].toLowerCase() &&
      !NON_BRAND_WORDS.has(secondWord.toLowerCase()) &&
      !/^(Gr\.|XS|S|M|L|XL|XXL|\d)/.test(secondWord)
    ) {
      return `${firstWord} ${secondWord}`;
    }
  }

  return firstWord;
}
