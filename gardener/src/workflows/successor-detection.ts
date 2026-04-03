import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { getReadSession, getWriteSession } from "../lib/memgraph.js";
import { sanitizeWebContent } from "../lib/utils.js";

// Minor #7: Anthropic client as lazy module-level singleton (avoids throwing
// during test module loading when ANTHROPIC_API_KEY is not set in the test env).
let _anthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
    _anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ─── Helper functions (exported for tests) ────────────────────────────────────

/**
 * Detect version-signal tokens in a product name.
 * Returns "year", "version", "generation", or null.
 */
export function detectVersionSignal(name: string): "year" | "version" | "generation" | null {
  if (/20\d{2}/.test(name)) return "year"; // Minor #9: future-proof year regex
  if (/\bv[2-9]\b/i.test(name)) return "version";
  if (/\b(Gen\s*[0-9]|[2-9]nd\s*Gen|[2-9]rd\s*Gen|[2-9]th\s*Gen|II|III|IV|VI|VII|VIII)\b/.test(name))
    return "generation";
  return null;
}

const SUCCESSOR_KEYWORDS = [
  "replaces",
  "successor",
  "replaced by",
  "supersedes",
  "next generation",
  "updated version",
  "discontinued",
  "upgrade from",
  "new version of",
];

/**
 * Extract successor relation from Serper snippets via keyword matching.
 * Returns "1_supersedes_2", "2_supersedes_1", or "none".
 */
export function extractSuccessorFromSnippets(
  snippets: string[],
  name1: string,
  name2: string,
): "1_supersedes_2" | "2_supersedes_1" | "none" {
  const n1 = name1.toLowerCase().slice(0, 20);
  const n2 = name2.toLowerCase().slice(0, 20);

  for (const rawSnippet of snippets) {
    const snippet = rawSnippet.toLowerCase();
    const hasKeyword = SUCCESSOR_KEYWORDS.some((kw) => snippet.includes(kw));
    if (!hasKeyword) continue;

    const mentionsN1 = snippet.includes(n1.slice(0, 15));
    const mentionsN2 = snippet.includes(n2.slice(0, 15));

    if (!mentionsN1 && !mentionsN2) continue;

    // Important #6: "replaced by" handling takes priority over positive keyword patterns.
    // "replaced by X" means X is the NEWER product.
    // Process this BEFORE the generic positive-keyword block to avoid mis-classifying
    // snippets that contain both "replaced by" and "successor".
    if (snippet.includes("replaced by")) {
      const replacedByIdx = snippet.indexOf("replaced by");

      if (mentionsN1 && mentionsN2) {
        const n1Idx = snippet.indexOf(n1.slice(0, 15));
        const n2Idx = snippet.indexOf(n2.slice(0, 15));

        // When n1 is a prefix of n2 (or vice versa) they land at the same index.
        // Use the LONGER match as the more specific one.
        if (n1Idx === n2Idx) {
          // n1 is longer (e.g. "Nemo Tensor V2") and n2 is a prefix (e.g. "Nemo Tensor").
          // Check whether the FULL n1 appears after "replaced by".
          const n1Full = snippet.indexOf(n1); // full 20-char slice
          if (n1Full > replacedByIdx) {
            return "1_supersedes_2"; // n1 named after "replaced by" -> n1 is newer
          }
          return "2_supersedes_1"; // the shared prefix appears before "replaced by" -> n2 (prefix) is older
        }

        if (n1Idx > replacedByIdx && n2Idx < replacedByIdx) {
          return "1_supersedes_2"; // n1 appears after "replaced by" -> n1 is newer
        }
        if (n2Idx > replacedByIdx && n1Idx < replacedByIdx) {
          return "2_supersedes_1"; // n2 appears after "replaced by" -> n2 is newer
        }
        // Both on the same side; fall through
      } else if (mentionsN1 && !mentionsN2) {
        const n1Idx = snippet.indexOf(n1.slice(0, 15));
        if (n1Idx > replacedByIdx) {
          return "1_supersedes_2"; // n1 is after "replaced by" -> n1 is newer
        }
        return "2_supersedes_1"; // n1 is before "replaced by" -> n1 is older, n2 implied newer
      } else if (mentionsN2 && !mentionsN1) {
        const n2Idx = snippet.indexOf(n2.slice(0, 15));
        if (n2Idx > replacedByIdx) {
          return "2_supersedes_1"; // n2 is after "replaced by" -> n2 is newer
        }
        return "1_supersedes_2"; // n2 is before "replaced by" -> n2 is older, n1 implied newer
      }
    }

    const kwIdx = SUCCESSOR_KEYWORDS.map((kw) => snippet.indexOf(kw))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0] ?? Infinity;

    // Pattern: "name1 replaces/supersedes/..." -> name1 is the newer one
    if (mentionsN1) {
      const posKeywords = ["replaces", "supersedes", "successor", "updated version", "next generation", "upgrade from"];
      const hasPosKeyword = posKeywords.some((kw) => snippet.includes(kw));
      if (hasPosKeyword) {
        const n1Idx = snippet.indexOf(n1.slice(0, 15));
        if (n1Idx !== -1 && n1Idx < kwIdx) {
          return "1_supersedes_2";
        }
      }
    }

    // Pattern: "name2 replaces/supersedes/..." -> name2 is the newer one
    if (mentionsN2) {
      const posKeywords = ["replaces", "supersedes", "successor", "updated version", "next generation", "upgrade from"];
      const hasPosKeyword = posKeywords.some((kw) => snippet.includes(kw));
      if (hasPosKeyword) {
        const n2Idx = snippet.indexOf(n2.slice(0, 15));
        if (n2Idx !== -1 && n2Idx < kwIdx) {
          return "2_supersedes_1";
        }
      }
    }

    // Pattern: "nameX discontinued" -> nameX is the OLDER product
    if (snippet.includes("discontinued")) {
      if (mentionsN2 && !mentionsN1) {
        return "1_supersedes_2"; // n2 is discontinued (older)
      } else if (mentionsN1 && !mentionsN2) {
        return "2_supersedes_1"; // n1 is discontinued (older)
      } else if (mentionsN1 && mentionsN2) {
        const n1Idx = snippet.indexOf(n1.slice(0, 15));
        const n2Idx = snippet.indexOf(n2.slice(0, 15));
        if (n1Idx < n2Idx) return "2_supersedes_1";
        if (n2Idx < n1Idx) return "1_supersedes_2";
      }
    }

    // Fallback: keyword hit with only one name mentioned (positive succession keywords)
    // The mentioned product is the active/newer subject
    if (mentionsN1 && !mentionsN2) return "1_supersedes_2";
    if (mentionsN2 && !mentionsN1) return "2_supersedes_1";
  }

  return "none";
}

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  dryRun: z.boolean().default(false),
  batchSize: z.number().default(30),
  minConfidence: z.enum(["high", "medium"]).default("medium"),
});

const pairSchema = z.object({
  id1: z.string(),
  name1: z.string(),
  id2: z.string(),
  name2: z.string(),
  brand: z.string(),
});

const versionCandidatesOutput = z.object({
  pairs: z.array(pairSchema),
  batchSize: z.number(),
  dryRun: z.boolean(),
  minConfidence: z.enum(["high", "medium"]),
});

const similarityCandidatesOutput = z.object({
  versionPairs: z.array(pairSchema),
  similarityPairs: z.array(pairSchema),
  batchSize: z.number(),
  dryRun: z.boolean(),
  minConfidence: z.enum(["high", "medium"]),
});

const verifiedPairSchema = pairSchema.extend({
  relation: z.enum(["1_supersedes_2", "2_supersedes_1", "none"]),
  confidence: z.enum(["high", "medium", "low"]),
  sourceUrl: z.string(),
  method: z.enum(["serper_search", "haiku_arbitration"]),
  snippets: z.array(z.string()),
});

const serperOutput = z.object({
  verified: z.array(verifiedPairSchema),
  dryRun: z.boolean(),
  minConfidence: z.enum(["high", "medium"]),
});

const resolvedPairSchema = pairSchema.extend({
  relation: z.enum(["1_supersedes_2", "2_supersedes_1", "none"]),
  confidence: z.enum(["high", "medium", "low"]),
  sourceUrl: z.string(),
  method: z.enum(["serper_search", "haiku_arbitration"]),
});

const arbitrateOutput = z.object({
  resolved: z.array(resolvedPairSchema),
  dryRun: z.boolean(),
  minConfidence: z.enum(["high", "medium"]),
});

const writeOutput = z.object({
  written: z.number(),
  skipped: z.number(),
  dryRun: z.boolean(),
  candidatesChecked: z.number(),
  supersessionFound: z.number(),
});

const summaryOutput = z.object({
  candidatesChecked: z.number(),
  supersessionFound: z.number(),
  written: z.number(),
  skipped: z.number(),
});

// ─── Serper helper ─────────────────────────────────────────────────────────────

async function serperSearch(
  query: string,
  num = 5,
): Promise<{ organic: Array<{ title?: string; snippet?: string; link?: string }> }> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("SERPER_API_KEY environment variable is required");

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num }),
  });

  if (!response.ok) {
    throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<{
    organic: Array<{ title?: string; snippet?: string; link?: string }>;
  }>;
}

async function verifyPairViaSerper(
  name1: string,
  name2: string,
  brand: string,
): Promise<{
  relation: "1_supersedes_2" | "2_supersedes_1" | "none";
  confidence: "high" | "medium" | "low";
  sourceUrl: string;
  method: "serper_search" | "haiku_arbitration";
  snippets: string[];
}> {
  const query = `${brand} "${name1}" OR "${name2}" replaces successor discontinued`;

  let data: { organic: Array<{ title?: string; snippet?: string; link?: string }> };
  try {
    data = await serperSearch(query, 5);
  } catch {
    return { relation: "none", confidence: "low", sourceUrl: "", method: "serper_search", snippets: [] };
  }

  const organic = data.organic ?? [];
  // Important #5: sanitize both snippet and title before pattern matching
  const snippets = organic.map(
    (r) => `${sanitizeWebContent(r.snippet ?? "")} ${sanitizeWebContent(r.title ?? "")}`,
  );
  const sourceUrl = organic[0]?.link ?? "";
  const relation = extractSuccessorFromSnippets(snippets, name1, name2);

  return {
    relation,
    confidence: relation !== "none" ? "high" : "low",
    sourceUrl,
    method: "serper_search",
    snippets,
  };
}

async function arbitrateViaHaiku(
  name1: string,
  name2: string,
  brand: string,
  snippets: string[],
): Promise<{
  relation: "1_supersedes_2" | "2_supersedes_1" | "none";
  confidence: "high" | "medium" | "low";
}> {
  // Minor #7: uses lazy module-level singleton
  const anthropic = getAnthropicClient();
  const contextText = snippets
    .slice(0, 3)
    .map((s) => s.slice(0, 300))
    .join(" | ");

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Outdoor gear products:
A: "${name1}" by ${brand}
B: "${name2}" by ${brand}

Web context: ${contextText}

Is A the successor of B, B the successor of A, or are they unrelated?
Reply ONLY with valid JSON: {"relation": "A_supersedes_B" | "B_supersedes_A" | "none", "confidence": "high" | "medium" | "low"}`,
        },
      ],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { relation: "none", confidence: "low" };

    const parsed = JSON.parse(jsonMatch[0]) as {
      relation: string;
      confidence: string;
    };

    // Important #4: Runtime validation of enum values
    const VALID_CONFIDENCE = ["high", "medium", "low"] as const;
    const VALID_RELATIONS = ["A_supersedes_B", "B_supersedes_A", "none"] as const;

    const confidence = VALID_CONFIDENCE.includes(parsed.confidence as any)
      ? parsed.confidence as "high" | "medium" | "low"
      : "low";
    const rawRelation = VALID_RELATIONS.includes(parsed.relation as any)
      ? parsed.relation as typeof VALID_RELATIONS[number]
      : "none";

    let relation: "1_supersedes_2" | "2_supersedes_1" | "none" = "none";
    if (rawRelation === "A_supersedes_B") relation = "1_supersedes_2";
    else if (rawRelation === "B_supersedes_A") relation = "2_supersedes_1";

    return { relation, confidence };
  } catch {
    return { relation: "none", confidence: "low" };
  }
}

// ─── Step 1: fetch-version-candidates ─────────────────────────────────────────

const fetchVersionCandidates = createStep({
  id: "fetch-version-candidates",
  description: "Fetch GearItem pairs with version signals (year, vN, Gen N, Roman numerals)",
  inputSchema: triggerSchema,
  outputSchema: versionCandidatesOutput,
  execute: async ({ inputData }) => {
    const { batchSize, dryRun, minConfidence } = inputData;
    const session = getReadSession();

    try {
      // Critical #2: filter pairs where SUPERSEDES/SUPERSEDED_BY edges already exist
      const result = await session.run(
        `MATCH (g:GearItem)-[:PRODUCED_BY]->(b:OutdoorBrand)
WHERE g.name =~ '.*(20[12][0-9]|\\bv[2-9]\\b|\\bV[2-9]\\b|Gen [0-9]|\\bII\\b|\\bIII\\b|2nd Gen|3rd Gen).*'
WITH b.name as brand, g.productTypeSlug as slug, collect(g) as items
WHERE size(items) > 1
UNWIND items as g1
UNWIND items as g2
WITH g1, g2, brand
WHERE id(g1) < id(g2)
  AND NOT (g1)-[:SUPERSEDES]->(g2)
  AND NOT (g2)-[:SUPERSEDES]->(g1)
  AND NOT (g1)-[:SUPERSEDED_BY]->(g2)
  AND NOT (g2)-[:SUPERSEDED_BY]->(g1)
RETURN toString(id(g1)) as id1, g1.name as name1,
       toString(id(g2)) as id2, g2.name as name2, brand
LIMIT $batchSize`,
        { batchSize },
      );

      const pairs = result.records.map((r) => ({
        id1: r.get("id1") as string,
        name1: r.get("name1") as string,
        id2: r.get("id2") as string,
        name2: r.get("name2") as string,
        brand: r.get("brand") as string,
      }));

      console.log(`[fetch-version-candidates] Found ${pairs.length} pairs`);
      return { pairs, batchSize, dryRun, minConfidence };
    } finally {
      await session.close();
    }
  },
});

// ─── Step 2: fetch-similarity-candidates ──────────────────────────────────────

const fetchSimilarityCandidates = createStep({
  id: "fetch-similarity-candidates",
  description: "Fetch name-similar GearItem pairs in same brand+productType without SUPERSEDES edges",
  inputSchema: versionCandidatesOutput,
  outputSchema: similarityCandidatesOutput,
  execute: async ({ inputData }) => {
    const { pairs: versionPairs, batchSize, dryRun, minConfidence } = inputData;
    const session = getReadSession();

    try {
      const result = await session.run(
        `MATCH (g1:GearItem)-[:PRODUCED_BY]->(b:OutdoorBrand)<-[:PRODUCED_BY]-(g2:GearItem)
WHERE id(g1) < id(g2)
  AND g1.productTypeSlug IS NOT NULL
  AND g1.productTypeSlug = g2.productTypeSlug
  AND size(g1.name) > 8 AND size(g2.name) > 8
  AND (
    (size(g1.name) < size(g2.name) AND g2.name CONTAINS substring(g1.name, 0, toInteger(size(g1.name) * 0.85)))
    OR
    (size(g2.name) < size(g1.name) AND g1.name CONTAINS substring(g2.name, 0, toInteger(size(g2.name) * 0.85)))
  )
  AND NOT (g1)-[:SUPERSEDES]->(g2)
  AND NOT (g2)-[:SUPERSEDES]->(g1)
RETURN toString(id(g1)) as id1, g1.name as name1,
       toString(id(g2)) as id2, g2.name as name2, b.name as brand
LIMIT $batchSize`,
        { batchSize },
      );

      const similarityPairs = result.records.map((r) => ({
        id1: r.get("id1") as string,
        name1: r.get("name1") as string,
        id2: r.get("id2") as string,
        name2: r.get("name2") as string,
        brand: r.get("brand") as string,
      }));

      console.log(`[fetch-similarity-candidates] Found ${similarityPairs.length} pairs`);
      return { versionPairs, similarityPairs, batchSize, dryRun, minConfidence };
    } finally {
      await session.close();
    }
  },
});

// ─── Step 3: verify-via-serper ────────────────────────────────────────────────

const verifyViaSerperStep = createStep({
  id: "verify-via-serper",
  description: "Search Serper for each candidate pair to classify succession relationships",
  inputSchema: similarityCandidatesOutput,
  outputSchema: serperOutput,
  execute: async ({ inputData }) => {
    const { versionPairs, similarityPairs, dryRun, minConfidence } = inputData;

    // Merge and de-duplicate
    const seen = new Set<string>();
    const allPairs = [...versionPairs, ...similarityPairs].filter((p) => {
      const key = `${p.id1}:${p.id2}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[verify-via-serper] Checking ${allPairs.length} unique pairs`);

    const verified: z.infer<typeof verifiedPairSchema>[] = [];
    for (let i = 0; i < allPairs.length; i++) {
      // Minor #8: skip rate-limit sleep on first call
      if (i > 0) await new Promise((r) => setTimeout(r, 300));

      const pair = allPairs[i];
      const result = await verifyPairViaSerper(pair.name1, pair.name2, pair.brand);
      verified.push({ ...pair, ...result });
    }

    return { verified, dryRun, minConfidence };
  },
});

// ─── Step 4: arbitrate-uncertain ──────────────────────────────────────────────

const arbitrateUncertain = createStep({
  id: "arbitrate-uncertain",
  description: "Use Claude Haiku to arbitrate pairs that Serper left unresolved (low confidence with snippets)",
  inputSchema: serperOutput,
  outputSchema: arbitrateOutput,
  execute: async ({ inputData }) => {
    const { verified, dryRun, minConfidence } = inputData;

    const resolved: z.infer<typeof resolvedPairSchema>[] = [];

    for (const item of verified) {
      if (item.relation !== "none") {
        // Already resolved by Serper
        resolved.push({
          id1: item.id1,
          name1: item.name1,
          id2: item.id2,
          name2: item.name2,
          brand: item.brand,
          relation: item.relation,
          confidence: item.confidence,
          sourceUrl: item.sourceUrl,
          method: item.method,
        });
        continue;
      }

      if (item.snippets.length > 0) {
        await new Promise((r) => setTimeout(r, 300));
        const haiku = await arbitrateViaHaiku(item.name1, item.name2, item.brand, item.snippets);
        resolved.push({
          id1: item.id1,
          name1: item.name1,
          id2: item.id2,
          name2: item.name2,
          brand: item.brand,
          relation: haiku.relation,
          confidence: haiku.confidence,
          sourceUrl: item.sourceUrl,
          method: "haiku_arbitration",
        });
      } else {
        resolved.push({
          id1: item.id1,
          name1: item.name1,
          id2: item.id2,
          name2: item.name2,
          brand: item.brand,
          relation: item.relation,
          confidence: item.confidence,
          sourceUrl: item.sourceUrl,
          method: item.method,
        });
      }
    }

    return { resolved, dryRun, minConfidence };
  },
});

// ─── Step 5: write-successor-edges ────────────────────────────────────────────

const confidenceRank: Record<string, number> = { high: 2, medium: 1, low: 0 };

const writeSuccessorEdges = createStep({
  id: "write-successor-edges",
  description: "Write SUPERSEDES and SUPERSEDED_BY edges to Memgraph for confirmed pairs above minConfidence",
  inputSchema: arbitrateOutput,
  outputSchema: writeOutput,
  execute: async ({ inputData }) => {
    const { resolved, dryRun, minConfidence } = inputData;

    const minRank = confidenceRank[minConfidence] ?? 1;
    const actionable = resolved.filter(
      (r) => r.relation !== "none" && (confidenceRank[r.confidence] ?? 0) >= minRank,
    );

    const candidatesChecked = resolved.length;
    const supersessionFound = resolved.filter((r) => r.relation !== "none").length;

    if (dryRun) {
      console.log(`[write-successor-edges] DRY RUN - would write ${actionable.length} edge pairs`);
      for (const r of actionable) {
        const [newerName, olderName] =
          r.relation === "1_supersedes_2"
            ? [r.name1, r.name2]
            : [r.name2, r.name1];
        console.log(`  DRY: (${newerName})-[:SUPERSEDES {${r.confidence}}]->(${olderName})`);
      }
      return { written: 0, skipped: actionable.length, dryRun: true, candidatesChecked, supersessionFound };
    }

    let written = 0;
    let skipped = 0;
    const session = getWriteSession();

    try {
      for (const r of actionable) {
        const [newerId, olderId] =
          r.relation === "1_supersedes_2" ? [r.id1, r.id2] : [r.id2, r.id1];

        try {
          // Critical #1: MERGE without mutable properties to prevent duplicates on re-run.
          // Use ON CREATE SET for immutable fields, ON MATCH SET for updatable fields.
          const result = await session.run(
            `MATCH (g1:GearItem) WHERE toString(id(g1)) = $newerId
MATCH (g2:GearItem) WHERE toString(id(g2)) = $olderId
MERGE (g1)-[r1:SUPERSEDES]->(g2)
ON CREATE SET r1.confidence = $confidence,
              r1.source_url = $sourceUrl,
              r1.detected_at = datetime(),
              r1.detection_method = $method
ON MATCH SET  r1.confidence = $confidence,
              r1.source_url = $sourceUrl,
              r1.detection_method = $method
MERGE (g2)-[r2:SUPERSEDED_BY]->(g1)
ON CREATE SET r2.confidence = $confidence,
              r2.source_url = $sourceUrl,
              r2.detected_at = datetime(),
              r2.detection_method = $method
ON MATCH SET  r2.confidence = $confidence,
              r2.source_url = $sourceUrl,
              r2.detection_method = $method`,
            { newerId, olderId, confidence: r.confidence, sourceUrl: r.sourceUrl, method: r.method },
          );
          // Critical #3: only increment written if nodes were actually found/matched
          const created = result.summary.counters.updates().relationshipsCreated;
          if (created > 0) {
            written++;
          } else {
            skipped++;
            console.warn(`[write-successor-edges] No nodes found for pair ${newerId} -> ${olderId}`);
          }
        } catch (err) {
          console.error(`[write-successor-edges] Failed ${newerId}->${olderId}:`, err);
          skipped++;
        }
      }
    } finally {
      await session.close();
    }

    return { written, skipped, dryRun: false, candidatesChecked, supersessionFound };
  },
});

// ─── Step 6: summary ──────────────────────────────────────────────────────────

const summaryStep = createStep({
  id: "summary",
  description: "Emit a run summary",
  inputSchema: writeOutput,
  outputSchema: summaryOutput,
  execute: async ({ inputData }) => {
    const { written, skipped, candidatesChecked, supersessionFound } = inputData;
    console.log(
      `[summary] checked=${candidatesChecked} found=${supersessionFound} written=${written} skipped=${skipped}`,
    );
    return { candidatesChecked, supersessionFound, written, skipped };
  },
});

// ─── Workflow ──────────────────────────────────────────────────────────────────

export const successorDetection = createWorkflow({
  id: "successor-detection",
  description: "Detects product succession relationships and writes SUPERSEDES/SUPERSEDED_BY edges",
  inputSchema: triggerSchema,
  outputSchema: summaryOutput,
  steps: [
    fetchVersionCandidates,
    fetchSimilarityCandidates,
    verifyViaSerperStep,
    arbitrateUncertain,
    writeSuccessorEdges,
    summaryStep,
  ],
})
  .then(fetchVersionCandidates)
  .then(fetchSimilarityCandidates)
  .then(verifyViaSerperStep)
  .then(arbitrateUncertain)
  .then(writeSuccessorEdges)
  .then(summaryStep)
  .commit();
