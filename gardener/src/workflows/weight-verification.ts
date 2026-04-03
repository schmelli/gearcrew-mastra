import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession } from "../lib/memgraph.js";

// ---------------------------------------------------------------------------
// Helper exports (also used by tests)
// ---------------------------------------------------------------------------

export function extractWeightsFromText(text: string): number[] {
  const weights: number[] = [];

  // Gramm: "450g", "450 g", "450gram", "450 grams"
  const gramsRe = /(\d{2,5})\s*(?:g\b|gram[s]?)/gi;
  // Ounces: "15.9 oz", "15.9oz" -> convert x 28.3495
  const ozRe = /(\d{1,4}(?:[.,]\d+)?)\s*oz\b/gi;
  // Pounds+ounces: "1 lb 4 oz" / "1 lbs 4 oz" — processed first to avoid oz regex consuming the oz part
  // Important #7: lbs? handles both "lb" and "lbs" plural forms
  const lbOzRe = /(\d+)\s*lbs?\s*(\d+)\s*oz/gi;

  let m: RegExpExecArray | null;

  // Track ranges already consumed by the lb+oz pattern so oz regex skips them
  const consumedRanges: Array<[number, number]> = [];

  while ((m = lbOzRe.exec(text)) !== null) {
    const g = Math.round(
      parseInt(m[1], 10) * 453.592 + parseInt(m[2], 10) * 28.3495,
    );
    if (g >= 10 && g <= 50000) {
      weights.push(g);
      consumedRanges.push([m.index, m.index + m[0].length]);
    }
  }

  while ((m = gramsRe.exec(text)) !== null) {
    const g = parseInt(m[1], 10);
    if (g >= 10 && g <= 50000) weights.push(g);
  }

  while ((m = ozRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const overlaps = consumedRanges.some(([s, e]) => start < e && end > s);
    if (overlaps) continue;
    const g = Math.round(parseFloat(m[1].replace(",", ".")) * 28.3495);
    if (g >= 10 && g <= 50000) weights.push(g);
  }

  return weights;
}

// Critical #1: proper hostname-based trusted-domain check (prevents "notrei.com" spoofing via .includes())
function isTrustedDomain(url: string, trusted: string[]): boolean {
  try {
    const hostname = new URL(url).hostname;
    return trusted.some(d => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

// Critical #2: deduplicate sources by URL before cross-referencing
// Prevents a single page with "450g (15.9oz)" from counting twice toward the threshold
function deduplicateSourcesByUrl(sources: Array<{weight: number, url: string}>): Array<{weight: number, url: string}> {
  const seen = new Map<string, {weight: number, url: string}>();
  for (const s of sources) {
    const key = s.url || Math.random().toString(); // empty URLs each get unique key
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values());
}

export function crossReferenceWeights(
  existingWeight: number,
  sources: Array<{ weight: number; url: string }>,
): {
  verified: boolean;
  newWeight: number;
  newConfidence: "high" | "medium" | "low";
  agreingSources: string[];
} {
  const TOLERANCE = 0.1;
  const TRUSTED_DOMAINS = ["rei.com", "backcountry.com", "outdoorgearlab.com"];

  // Critical #2: deduplicate before cross-referencing
  const dedupedSources = deduplicateSourcesByUrl(sources);

  const agreeing = dedupedSources.filter(
    (s) => Math.abs(s.weight - existingWeight) / existingWeight <= TOLERANCE,
  );

  // Critical #1: use isTrustedDomain instead of .includes()
  const hasManufacturerSource = agreeing.some((s) =>
    isTrustedDomain(s.url, TRUSTED_DOMAINS),
  );

  if (agreeing.length >= 2 || (agreeing.length >= 1 && hasManufacturerSource)) {
    const sorted = agreeing.map((s) => s.weight).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      verified: true,
      newWeight: median,
      newConfidence: "high",
      agreingSources: agreeing.map((s) => s.url),
    };
  }
  if (agreeing.length === 1) {
    return {
      verified: true,
      newWeight: agreeing[0].weight,
      newConfidence: "medium",
      agreingSources: [agreeing[0].url],
    };
  }
  return {
    verified: false,
    newWeight: existingWeight,
    newConfidence: "low",
    agreingSources: [],
  };
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  dryRun: z.boolean().default(false),
  batchSize: z.number().int().positive().default(50),
  targetConfidence: z.enum(["low", "medium", "any"]).default("any"),
});

const gearItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  brandName: z.string(),
  currentWeight: z.number(),
  confidence: z.string().nullable(),
  productUrl: z.string().nullable(),
  typeSlug: z.string().nullable(),
});

const fetchOutputSchema = z.object({
  items: z.array(gearItemSchema),
  total: z.number(),
});

const weightSourceSchema = z.object({
  weight: z.number(),
  url: z.string(),
});

const searchOutputSchema = z.object({
  searchResults: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sources: z.array(weightSourceSchema),
    }),
  ),
});

const scrapeOutputSchema = z.object({
  scrapeResults: z.array(
    z.object({
      id: z.string(),
      sources: z.array(weightSourceSchema),
    }),
  ),
});

const verificationResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  oldWeight: z.number(),
  newWeight: z.number(),
  oldConfidence: z.string(),
  newConfidence: z.enum(["high", "medium", "low"]),
  upgraded: z.boolean(),
  agreingSources: z.array(z.string()),
});

const crossRefOutputSchema = z.object({
  verificationResults: z.array(verificationResultSchema),
});

const writeOutputSchema = z.object({
  written: z.number(),
  skipped: z.boolean(),
});

const summaryOutputSchema = z.object({
  itemsChecked: z.number(),
  upgraded: z.object({
    toHigh: z.number(),
    toMedium: z.number(),
  }),
  unchanged: z.number(),
  avgConfidenceGain: z.number(),
  dryRun: z.boolean(),
});

type GearItem = z.infer<typeof gearItemSchema>;
type VerificationResult = z.infer<typeof verificationResultSchema>;

// ---------------------------------------------------------------------------
// Step 1: fetch-unverified-items
// ---------------------------------------------------------------------------

const fetchUnverifiedItems = createStep({
  id: "fetch-unverified-items",
  description:
    "Fetch GearItems with weight_grams set but confidence != 'high' from Memgraph",
  inputSchema: triggerSchema,
  outputSchema: fetchOutputSchema,
  execute: async ({ inputData }) => {
    const { batchSize, targetConfidence } = inputData;

    let confidenceFilter = "";
    if (targetConfidence === "low") {
      confidenceFilter =
        "AND (g.weightConfidence IS NULL OR g.weightConfidence = 'low')";
    } else if (targetConfidence === "medium") {
      confidenceFilter = "AND g.weightConfidence = 'medium'";
    }

    // Critical #3: coalesce(g.weight_grams, g.weightGrams) to include legacy field
    // Critical #9: searched CASE (WHEN IS NULL) — simple CASE (WHEN null) is never true in Cypher
    const query = `
MATCH (g:GearItem)-[:PRODUCED_BY]->(b:OutdoorBrand)
WHERE coalesce(g.weight_grams, g.weightGrams) IS NOT NULL
  AND coalesce(g.weight_grams, g.weightGrams) > 10
  AND (g.weightConfidence IS NULL OR g.weightConfidence <> 'high')
  ${confidenceFilter}
RETURN toString(id(g)) as id, g.name as name, b.name as brand_name,
       coalesce(g.weight_grams, g.weightGrams) as current_weight,
       g.weightConfidence as confidence,
       g.productUrl as product_url,
       g.productTypeSlug as type_slug
ORDER BY
  CASE
    WHEN g.weightConfidence IS NULL THEN 1
    WHEN g.weightConfidence = 'low' THEN 0
    ELSE 2
  END,
  coalesce(g.weight_grams, g.weightGrams) DESC
LIMIT ${batchSize}
`;

    // Critical #4: use shared getReadSession() — removes hardcoded password
    let items: GearItem[] = [];
    const session = getReadSession();
    try {
      const result = await session.run(query);
      items = result.records.map((r) => {
        const rawWeight = r.get("current_weight");
        const currentWeight =
          typeof rawWeight === "object" &&
          rawWeight !== null &&
          "low" in rawWeight
            ? (rawWeight as { low: number }).low
            : (rawWeight as number);
        return {
          id: r.get("id") as string,
          name: r.get("name") as string,
          brandName: r.get("brand_name") as string,
          currentWeight,
          confidence: r.get("confidence") as string | null,
          productUrl: r.get("product_url") as string | null,
          typeSlug: r.get("type_slug") as string | null,
        };
      });
    } finally {
      await session.close();
    }

    return { items, total: items.length };
  },
});

// ---------------------------------------------------------------------------
// Step 2: search-weights
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serperSearchWeights(
  itemName: string,
  brandName: string,
): Promise<Array<{ weight: number; url: string }>> {
  const queries = [
    `"${itemName}" "${brandName}" weight grams specifications`,
    `${brandName} ${itemName} specs weight oz g`,
  ];

  const found: Array<{ weight: number; url: string }> = [];

  for (const q of queries) {
    await sleep(300);
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q, num: 5 }),
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        organic?: Array<{ snippet?: string; link?: string }>;
        answerBox?: { snippet?: string };
        knowledgeGraph?: { description?: string };
      };

      const snippets: Array<{ text: string; url: string }> = [];

      // Important #8: use sentinel URL instead of "" to prevent empty-string URLs
      // from appearing in weightSource and from triggering the 2-source threshold
      if (data.answerBox?.snippet) {
        snippets.push({ text: data.answerBox.snippet, url: "serper:answerBox" });
      }
      if (data.knowledgeGraph?.description) {
        snippets.push({ text: data.knowledgeGraph.description, url: "serper:knowledgeGraph" });
      }
      for (const r of data.organic ?? []) {
        if (r.snippet) {
          snippets.push({ text: r.snippet, url: r.link ?? "serper:organic:unknown" });
        }
      }

      for (const s of snippets) {
        const weights = extractWeightsFromText(s.text);
        for (const w of weights) {
          found.push({ weight: w, url: s.url });
        }
      }
    } catch {
      // ignore individual query failures
    }
  }

  return found;
}

const searchWeightsStep = createStep({
  id: "search-weights",
  description: "Search Serper for weight data for each unverified item",
  inputSchema: fetchOutputSchema,
  outputSchema: searchOutputSchema,
  execute: async ({ inputData }) => {
    const { items } = inputData;

    const searchResults: z.infer<typeof searchOutputSchema>["searchResults"] =
      [];

    for (const item of items) {
      const sources = await serperSearchWeights(item.name, item.brandName);
      searchResults.push({ id: item.id, name: item.name, sources });
    }

    return { searchResults };
  },
});

// ---------------------------------------------------------------------------
// Step 3: scrape-manufacturer
// ---------------------------------------------------------------------------

async function scrapeManufacturerPage(
  productUrl: string,
): Promise<Array<{ weight: number; url: string }>> {
  try {
    const firecrawlRes = await fetch("http://localhost:3002/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_LOCAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: productUrl, formats: ["markdown"] }),
    });

    if (!firecrawlRes.ok) return [];

    const data = (await firecrawlRes.json()) as {
      data?: { markdown?: string };
    };
    const markdown = data.data?.markdown ?? "";
    if (!markdown) return [];

    const weights = extractWeightsFromText(markdown);
    return weights.map((w) => ({ weight: w, url: productUrl }));
  } catch {
    return [];
  }
}

const scrapeManufacturerStep = createStep({
  id: "scrape-manufacturer",
  description:
    "Scrape manufacturer product pages via local Firecrawl for items with productUrl",
  inputSchema: searchOutputSchema,
  outputSchema: scrapeOutputSchema,
  execute: async ({ inputData, getStepResult }) => {
    const fetchResult = getStepResult<z.infer<typeof fetchOutputSchema>>(
      "fetch-unverified-items",
    );
    const items = fetchResult?.items ?? [];

    const scrapeResults: z.infer<typeof scrapeOutputSchema>["scrapeResults"] =
      [];

    for (const item of items) {
      if (item.productUrl) {
        const sources = await scrapeManufacturerPage(item.productUrl);
        scrapeResults.push({ id: item.id, sources });
      } else {
        scrapeResults.push({ id: item.id, sources: [] });
      }
    }

    return { scrapeResults };
  },
});

// ---------------------------------------------------------------------------
// Step 4: cross-reference
// ---------------------------------------------------------------------------

const crossReferenceStep = createStep({
  id: "cross-reference",
  description:
    "Cross-reference weights from search + scrape results against existing values",
  inputSchema: scrapeOutputSchema,
  outputSchema: crossRefOutputSchema,
  execute: async ({ inputData, getStepResult }) => {
    const fetchResult = getStepResult<z.infer<typeof fetchOutputSchema>>(
      "fetch-unverified-items",
    );
    const searchResult = getStepResult<z.infer<typeof searchOutputSchema>>(
      "search-weights",
    );

    const items = fetchResult?.items ?? [];
    const searchResults = searchResult?.searchResults ?? [];
    const { scrapeResults } = inputData;

    const verificationResults: VerificationResult[] = [];

    for (const item of items) {
      const searchSources =
        searchResults.find((r) => r.id === item.id)?.sources ?? [];
      const scrapeSources =
        scrapeResults.find((r) => r.id === item.id)?.sources ?? [];

      const allSources = [...searchSources, ...scrapeSources];
      const result = crossReferenceWeights(item.currentWeight, allSources);

      const oldConfidence = item.confidence ?? "low";
      const confidenceOrder = { low: 0, medium: 1, high: 2 } as const;
      const oldLevel =
        confidenceOrder[oldConfidence as keyof typeof confidenceOrder] ?? 0;
      const newLevel = confidenceOrder[result.newConfidence];
      const upgraded = newLevel > oldLevel;

      verificationResults.push({
        id: item.id,
        name: item.name,
        oldWeight: item.currentWeight,
        newWeight: result.newWeight,
        oldConfidence,
        newConfidence: result.newConfidence,
        upgraded,
        agreingSources: result.agreingSources,
      });
    }

    return { verificationResults };
  },
});

// ---------------------------------------------------------------------------
// Step 5: write-verified-weights
// ---------------------------------------------------------------------------

const writeVerifiedWeightsStep = createStep({
  id: "write-verified-weights",
  description:
    "Write upgraded weight data back to Memgraph (skipped in dryRun mode)",
  inputSchema: crossRefOutputSchema,
  outputSchema: writeOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const trigger = getInitData<typeof weightVerification>();
    const { dryRun } = trigger;
    const { verificationResults } = inputData;

    if (dryRun) {
      console.log("[write-verified-weights] dryRun=true - skipping DB writes.");
      return { written: 0, skipped: true };
    }

    const toWrite = verificationResults.filter((r) => r.upgraded);
    if (toWrite.length === 0) {
      return { written: 0, skipped: false };
    }

    // Critical #4: use shared getWriteSession() — removes hardcoded password
    let written = 0;
    let skipped = 0;
    const session = getWriteSession();
    try {
      for (const r of toWrite) {
        const source = r.agreingSources.join(", ");
        const result = await session.run(
          `MATCH (g:GearItem) WHERE toString(id(g)) = $id
           SET g.weight_grams = $weight,
               g.weightConfidence = $confidence,
               g.weightSource = $source,
               g.weightVerifiedAt = datetime()`,
          {
            id: r.id,
            weight: r.newWeight,
            confidence: r.newConfidence,
            source,
          },
        );
        const propsSet = result.summary.counters.updates().propertiesSet;
        if (propsSet === 0) {
          console.warn(`[write-verified-weights] No node matched for id=${r.id} (${r.name}) — skipped`);
          skipped++;
        } else {
          written++;
          console.log(`[write-verified-weights] Wrote ${r.id} (${r.name}): ${r.newWeight}g → ${r.newConfidence}`);
        }
      }
    } finally {
      await session.close();
    }

    return { written, skipped: false };
  },
});

// ---------------------------------------------------------------------------
// Step 6: summary
// ---------------------------------------------------------------------------

const summaryStep = createStep({
  id: "summary",
  description: "Produce a summary of the verification run",
  inputSchema: writeOutputSchema,
  outputSchema: summaryOutputSchema,
  execute: async ({ inputData, getStepResult, getInitData }) => {
    const trigger = getInitData<typeof weightVerification>();
    const { dryRun } = trigger;
    const crossRefResult = getStepResult<z.infer<typeof crossRefOutputSchema>>(
      "cross-reference",
    );
    const verificationResults = crossRefResult?.verificationResults ?? [];

    const confidenceScore = { low: 0, medium: 1, high: 2 } as const;

    let toHigh = 0;
    let toMedium = 0;
    let unchanged = 0;
    let totalGain = 0;

    for (const r of verificationResults) {
      if (r.upgraded) {
        if (r.newConfidence === "high") toHigh++;
        else if (r.newConfidence === "medium") toMedium++;
        const oldScore =
          confidenceScore[r.oldConfidence as keyof typeof confidenceScore] ?? 0;
        const newScore = confidenceScore[r.newConfidence];
        totalGain += newScore - oldScore;
      } else {
        unchanged++;
      }
    }

    const upgradedCount = toHigh + toMedium;
    const avgConfidenceGain =
      upgradedCount > 0
        ? parseFloat((totalGain / upgradedCount).toFixed(3))
        : 0;

    console.log(
      `[summary] checked=${verificationResults.length} toHigh=${toHigh} toMedium=${toMedium} unchanged=${unchanged} dryRun=${dryRun}`,
    );

    return {
      itemsChecked: verificationResults.length,
      upgraded: { toHigh, toMedium },
      unchanged,
      avgConfidenceGain,
      dryRun,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------

export const weightVerification = createWorkflow({
  id: "weight-verification",
  inputSchema: triggerSchema,
  outputSchema: summaryOutputSchema,
})
  .then(fetchUnverifiedItems)
  .then(searchWeightsStep)
  .then(scrapeManufacturerStep)
  .then(crossReferenceStep)
  .then(writeVerifiedWeightsStep)
  .then(summaryStep)
  .commit();
