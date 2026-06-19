/**
 * Serper Knowledge Graph Parser — Gardener Copy
 * Phase 27 — ARCH-01: Migrated from winterberry lib/enrichment/serper-knowledge-graph.ts
 *
 * Calls Serper's general Google Search API and extracts structured
 * product data from the Knowledge Graph response + organic snippets.
 *
 * Gardener-native: no @/ imports, console.log/error instead of module logger.
 * T-27-09: SERPER_API_KEY read only from gardener .env — never echoed in response.
 */

// =============================================================================
// Inline decodeHtmlEntities (from winterberry lib/html-entities.ts)
// =============================================================================

function decodeHtmlEntities(str: string): string {
  const decoded = str
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Auml;/g, "Ä")
    .replace(/&uuml;/gi, "ü")
    .replace(/&ouml;/gi, "ö")
    .replace(/&auml;/gi, "ä")
    .replace(/&szlig;/gi, "ß");

  // Numeric entities (decimal + hex), including double-encoded patterns after &amp; decode.
  return decoded
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

// =============================================================================
// Types
// =============================================================================

export interface KnowledgeGraphResult {
  brand: string | null;
  description: string | null;
  weightGrams: number | null;
  materials: string | null;
  attributes: Record<string, string>;
  /** Top-3 organic snippets for LLM fallback context */
  searchSnippets: string[];
}

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface SerperKnowledgeGraph {
  title?: string;
  description?: string;
  attributes?: Record<string, string>;
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
  knowledgeGraph?: SerperKnowledgeGraph;
}

// =============================================================================
// Constants
// =============================================================================

const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";
const SERPER_TIMEOUT_MS = 10_000;

/** Attribute keys (DE + EN) that indicate the product weight */
const WEIGHT_KEYS = ["gewicht", "weight", "packgewicht", "gesamtgewicht"];

/** Attribute keys (DE + EN) that indicate materials */
const MATERIAL_KEYS = ["material", "materialien", "obermaterial"];

/** Attribute keys (DE + EN) that indicate brand */
const BRAND_KEYS = ["marke", "brand", "hersteller"];

// =============================================================================
// Weight Parsing
// =============================================================================

/**
 * Parse a weight string like "1.2 kg", "850 g", "2 lbs", "14 oz" into grams.
 * Returns null if the string cannot be parsed.
 */
function parseWeightToGrams(raw: string): number | null {
  if (!raw) return null;

  const normalized = raw.trim().toLowerCase().replace(",", ".");

  // Match number + optional unit
  const match = normalized.match(
    /^([\d.]+)\s*(kg|g|gr|gram|grams|lbs?|pounds?|oz|ounces?)?$/,
  );
  if (!match) return null;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2] ?? "g";

  switch (unit) {
    case "kg":
      return Math.round(value * 1000);
    case "g":
    case "gr":
    case "gram":
    case "grams":
      return Math.round(value);
    case "lb":
    case "lbs":
    case "pound":
    case "pounds":
      return Math.round(value * 453.592);
    case "oz":
    case "ounce":
    case "ounces":
      return Math.round(value * 28.3495);
    default:
      return null;
  }
}

// =============================================================================
// Attribute Extraction Helpers
// =============================================================================

/**
 * Find a value from attributes where the key matches one of the candidate keys
 * (case-insensitive). Returns the first match or null.
 */
function findAttribute(
  attributes: Record<string, string>,
  candidateKeys: string[],
): string | null {
  for (const [key, value] of Object.entries(attributes)) {
    if (candidateKeys.includes(key.toLowerCase().trim())) {
      const decoded = decodeHtmlEntities(value.trim());
      return decoded || null;
    }
  }
  return null;
}

// =============================================================================
// Empty Result
// =============================================================================

function emptyResult(): KnowledgeGraphResult {
  return {
    brand: null,
    description: null,
    weightGrams: null,
    materials: null,
    attributes: {},
    searchSnippets: [],
  };
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Search Google via Serper.dev and extract structured product data
 * from the Knowledge Graph response and organic snippets.
 *
 * Returns an empty result on any error — never throws.
 */
export async function searchKnowledgeGraph(
  query: string,
): Promise<KnowledgeGraphResult> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.error("[serper-knowledge-graph] SERPER_API_KEY is not set");
    return emptyResult();
  }

  if (!query.trim()) {
    return emptyResult();
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(SERPER_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          gl: "de",
          hl: "de",
          num: 5,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.error(
        `[serper-knowledge-graph] API error: HTTP ${response.status} ${response.statusText}`,
      );
      return emptyResult();
    }

    let data: SerperSearchResponse;
    try {
      data = (await response.json()) as SerperSearchResponse;
    } catch (parseError) {
      console.error(
        "[serper-knowledge-graph] Invalid JSON response",
        parseError instanceof Error ? parseError.message : String(parseError),
      );
      return emptyResult();
    }

    // --- Extract Knowledge Graph data ---
    const kg = data.knowledgeGraph;
    const kgAttributes = kg?.attributes ?? {};

    // Decode all attribute values
    const decodedAttributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(kgAttributes)) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      decodedAttributes[decodeHtmlEntities(key)] = decodeHtmlEntities(value);
    }

    // Brand: from KG attributes only.
    const brand = findAttribute(decodedAttributes, BRAND_KEYS);

    // Description
    const description = kg?.description
      ? decodeHtmlEntities(kg.description)
      : null;

    // Weight
    const weightRaw = findAttribute(decodedAttributes, WEIGHT_KEYS);
    const weightGrams = weightRaw ? parseWeightToGrams(weightRaw) : null;

    // Materials
    const materials = findAttribute(decodedAttributes, MATERIAL_KEYS);

    // --- Collect top-3 organic snippets ---
    const organicResults = data.organic ?? [];
    const searchSnippets = organicResults
      .slice(0, 3)
      .map((r) => decodeHtmlEntities(r.snippet))
      .filter(Boolean);

    return {
      brand,
      description,
      weightGrams,
      materials,
      attributes: decodedAttributes,
      searchSnippets,
    };
  } catch (error) {
    // AbortError = timeout, other errors = network issues etc.
    console.error(
      "[serper-knowledge-graph] Search failed",
      error instanceof Error ? error.message : String(error),
    );
    return emptyResult();
  }
}
