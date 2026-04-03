import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helper functions (exported for unit tests)
// ---------------------------------------------------------------------------

export function normalizeGenderName(name: string): string {
  return name
    .replace(/\b(Men'?s?|Women'?s?|Damen|Herren|Männer|Unisex)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSizeName(name: string): string {
  return name
    .replace(/\b\d{1,3}\s*[Ll]\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGenerationName(name: string): string {
  return name
    .replace(/\b(20[12][0-9]|v\d|V\d|Gen\s?\d|II|III|IV|2nd|3rd|4th|\s[23]\s?$)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  dryRun: z.boolean().default(false),
  variantTypes: z.array(z.enum(["gender", "size", "generation"])).default(["gender", "size", "generation"]),
  limit: z.number().default(200),
});

const variantCandidateSchema = z.object({
  id1: z.string(),
  name1: z.string(),
  id2: z.string(),
  name2: z.string(),
  brand: z.string(),
  variantType: z.enum(["gender", "size", "generation"]),
  confidence: z.enum(["high", "medium", "low"]),
});

type VariantCandidate = z.infer<typeof variantCandidateSchema>;

const detectionOutputSchema = z.object({
  candidates: z.array(variantCandidateSchema),
  skipped: z.boolean(),
});

// ---------------------------------------------------------------------------
// Utility: parse rows from agent response text
// ---------------------------------------------------------------------------

function parseAgentRows(
  text: string,
): Array<{ id1: string; name1: string; id2: string; name2: string; brand: string }> {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : text;
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { rows?: unknown[] };
    if (Array.isArray(parsed.rows)) {
      return parsed.rows as Array<{
        id1: string;
        name1: string;
        id2: string;
        name2: string;
        brand: string;
      }>;
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

// ---------------------------------------------------------------------------
// Step 1: detect-gender-variants
// ---------------------------------------------------------------------------

const detectGenderVariants = createStep({
  id: "detect-gender-variants",
  description: "Find GearItem pairs that differ only in gender designation",
  inputSchema: triggerSchema,
  outputSchema: detectionOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData.variantTypes.includes("gender")) {
      return { candidates: [], skipped: true };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("Gardener");

    const fallback = { candidates: [] as VariantCandidate[], skipped: false };

    let result;
    try {
      result = await agent.generate(
        `Run the following graphQuery to find potential gender variants among GearItems.
Return the raw results as a JSON object with key "rows" containing an array of objects,
each having keys: id1, name1, id2, name2, brand.

Query:
MATCH (g1:GearItem)-[:PRODUCED_BY]->(b:OutdoorBrand)<-[:PRODUCED_BY]-(g2:GearItem)
WHERE id(g1) < id(g2)
  AND g1.productTypeSlug IS NOT NULL
  AND g1.productTypeSlug = g2.productTypeSlug
  AND (g1.name CONTAINS 'Men' OR g1.name CONTAINS 'Women' OR g1.name CONTAINS 'Damen' OR g1.name CONTAINS 'Herren')
  AND (g2.name CONTAINS 'Men' OR g2.name CONTAINS 'Women' OR g2.name CONTAINS 'Damen' OR g2.name CONTAINS 'Herren')
  AND g1.name <> g2.name
RETURN toString(id(g1)) as id1, g1.name as name1, toString(id(g2)) as id2, g2.name as name2, b.name as brand
LIMIT ${inputData.limit}

Return ONLY a JSON object: { "rows": [ { "id1": "...", "name1": "...", "id2": "...", "name2": "...", "brand": "..." }, ... ] }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[detect-gender-variants] agent.generate() failed:", err);
      return fallback;
    }

    const rows = parseAgentRows(result.text);
    const candidates: VariantCandidate[] = [];

    for (const row of rows) {
      const core1 = normalizeGenderName(row.name1);
      const core2 = normalizeGenderName(row.name2);
      if (!core1 || !core2) continue;

      const isVariant =
        core1 === core2 ||
        core1.toLowerCase().includes(core2.toLowerCase()) ||
        core2.toLowerCase().includes(core1.toLowerCase());

      if (isVariant) {
        candidates.push({
          id1: row.id1,
          name1: row.name1,
          id2: row.id2,
          name2: row.name2,
          brand: row.brand,
          variantType: "gender",
          confidence: "high",
        });
      }
    }

    return { candidates, skipped: false };
  },
});

// ---------------------------------------------------------------------------
// Step 2: detect-size-variants
// ---------------------------------------------------------------------------

const detectSizeVariants = createStep({
  id: "detect-size-variants",
  description: "Find GearItem pairs that differ only in volume/size (e.g. 35L vs 65L)",
  inputSchema: detectionOutputSchema,
  outputSchema: detectionOutputSchema,
  execute: async ({ inputData, mastra, getInitData }) => {
    const trigger = getInitData<typeof variantDetection>();

    if (!trigger.variantTypes.includes("size")) {
      return { candidates: [], skipped: true };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("Gardener");

    const fallback = { candidates: [] as VariantCandidate[], skipped: false };

    let result;
    try {
      result = await agent.generate(
        `Run the following graphQuery to find potential size variants among GearItems.
Return the raw results as a JSON object with key "rows".

Query:
MATCH (g1:GearItem)-[:PRODUCED_BY]->(b:OutdoorBrand)<-[:PRODUCED_BY]-(g2:GearItem)
WHERE id(g1) < id(g2)
  AND g1.productTypeSlug IS NOT NULL
  AND g1.productTypeSlug = g2.productTypeSlug
  AND g1.name =~ '.*([0-9]{1,3})[Ll].*'
  AND g2.name =~ '.*([0-9]{1,3})[Ll].*'
RETURN toString(id(g1)) as id1, g1.name as name1, toString(id(g2)) as id2, g2.name as name2, b.name as brand
LIMIT ${trigger.limit}

Return ONLY a JSON object: { "rows": [ { "id1": "...", "name1": "...", "id2": "...", "name2": "...", "brand": "..." }, ... ] }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[detect-size-variants] agent.generate() failed:", err);
      return fallback;
    }

    const rows = parseAgentRows(result.text);
    const candidates: VariantCandidate[] = [];

    for (const row of rows) {
      const core1 = normalizeSizeName(row.name1);
      const core2 = normalizeSizeName(row.name2);
      if (!core1 || !core2) continue;

      const isVariant =
        core1 === core2 ||
        core1.toLowerCase().includes(core2.toLowerCase()) ||
        core2.toLowerCase().includes(core1.toLowerCase());

      if (isVariant && row.name1 !== row.name2) {
        candidates.push({
          id1: row.id1,
          name1: row.name1,
          id2: row.id2,
          name2: row.name2,
          brand: row.brand,
          variantType: "size",
          confidence: "high",
        });
      }
    }

    return { candidates, skipped: false };
  },
});

// ---------------------------------------------------------------------------
// Step 3: detect-generation-variants
// ---------------------------------------------------------------------------

const detectGenerationVariants = createStep({
  id: "detect-generation-variants",
  description: "Find GearItem pairs that differ only in generation/year/version",
  inputSchema: detectionOutputSchema,
  outputSchema: detectionOutputSchema,
  execute: async ({ inputData, mastra, getInitData }) => {
    const trigger = getInitData<typeof variantDetection>();

    if (!trigger.variantTypes.includes("generation")) {
      return { candidates: [], skipped: true };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("Gardener");

    const fallback = { candidates: [] as VariantCandidate[], skipped: false };

    let result;
    try {
      result = await agent.generate(
        `Run the following graphQuery to find potential generation variants among GearItems.
Return the raw results as a JSON object with key "rows".

Query:
MATCH (g1:GearItem)-[:PRODUCED_BY]->(b:OutdoorBrand)<-[:PRODUCED_BY]-(g2:GearItem)
WHERE id(g1) < id(g2)
  AND g1.productTypeSlug IS NOT NULL
  AND g1.productTypeSlug = g2.productTypeSlug
  AND (g1.name =~ '.*(20[12][0-9]|v[0-9]| II| III| 2| 3).*' OR g2.name =~ '.*(20[12][0-9]|v[0-9]| II| III| 2| 3).*')
RETURN toString(id(g1)) as id1, g1.name as name1, toString(id(g2)) as id2, g2.name as name2, b.name as brand
LIMIT ${trigger.limit}

Return ONLY a JSON object: { "rows": [ { "id1": "...", "name1": "...", "id2": "...", "name2": "...", "brand": "..." }, ... ] }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[detect-generation-variants] agent.generate() failed:", err);
      return fallback;
    }

    const rows = parseAgentRows(result.text);
    const candidates: VariantCandidate[] = [];

    for (const row of rows) {
      const core1 = normalizeGenerationName(row.name1);
      const core2 = normalizeGenerationName(row.name2);
      if (!core1 || !core2) continue;

      const isVariant =
        core1 === core2 ||
        core1.toLowerCase().includes(core2.toLowerCase()) ||
        core2.toLowerCase().includes(core1.toLowerCase());

      if (isVariant && row.name1 !== row.name2) {
        candidates.push({
          id1: row.id1,
          name1: row.name1,
          id2: row.id2,
          name2: row.name2,
          brand: row.brand,
          variantType: "generation",
          confidence: "medium",
        });
      }
    }

    return { candidates, skipped: false };
  },
});

// ---------------------------------------------------------------------------
// Step 4: write-variant-edges
// ---------------------------------------------------------------------------

const writeVariantEdgesOutputSchema = z.object({
  written: z.number(),
  skipped: z.number(),
  candidates: z.array(variantCandidateSchema),
});

const writeVariantEdges = createStep({
  id: "write-variant-edges",
  description: "Write IS_VARIANT_OF edges for detected variant pairs (skipped in dryRun)",
  inputSchema: detectionOutputSchema,
  outputSchema: writeVariantEdgesOutputSchema,
  execute: async ({ inputData, mastra, getInitData, getStepResult }) => {
    const trigger = getInitData<typeof variantDetection>();

    const genderResult = getStepResult<z.infer<typeof detectionOutputSchema>>("detect-gender-variants");
    const sizeResult = getStepResult<z.infer<typeof detectionOutputSchema>>("detect-size-variants");
    const generationResult = getStepResult<z.infer<typeof detectionOutputSchema>>("detect-generation-variants");

    const allCandidates: VariantCandidate[] = [
      ...(genderResult?.candidates ?? []),
      ...(sizeResult?.candidates ?? []),
      ...(generationResult?.candidates ?? []),
    ];

    if (trigger.dryRun) {
      console.log(`[write-variant-edges] dryRun=true — would write ${allCandidates.length} edge pairs`);
      return { written: 0, skipped: allCandidates.length, candidates: allCandidates };
    }

    if (allCandidates.length === 0) {
      return { written: 0, skipped: 0, candidates: [] };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("Gardener");

    let written = 0;
    let skipped = 0;

    for (const candidate of allCandidates) {
      try {
        await agent.generate(
          `Run the following graphWrite query to create bidirectional IS_VARIANT_OF edges.

Query (use these literal values directly in the query — do NOT use parameters):
MATCH (g1:GearItem) WHERE toString(id(g1)) = '${candidate.id1}'
MATCH (g2:GearItem) WHERE toString(id(g2)) = '${candidate.id2}'
OPTIONAL MATCH (g1)-[existing:IS_VARIANT_OF]->(g2)
WITH g1, g2, existing
WHERE existing IS NULL
MERGE (g1)-[:IS_VARIANT_OF {
  variant_type: '${candidate.variantType}',
  confidence: '${candidate.confidence}',
  detected_at: datetime(),
  detection_method: 'name_similarity'
}]->(g2)
MERGE (g2)-[:IS_VARIANT_OF {
  variant_type: '${candidate.variantType}',
  confidence: '${candidate.confidence}',
  detected_at: datetime(),
  detection_method: 'name_similarity'
}]->(g1)

Confirm execution with a brief JSON: { "ok": true }`,
          { toolChoice: "required" },
        );
        written++;
      } catch (err) {
        console.error(`[write-variant-edges] Failed to write edge ${candidate.id1} <-> ${candidate.id2}:`, err);
        skipped++;
      }
    }

    return { written, skipped, candidates: allCandidates };
  },
});

// ---------------------------------------------------------------------------
// Step 5: summary
// ---------------------------------------------------------------------------

const summaryOutputSchema = z.object({
  detected: z.number(),
  written: z.number(),
  skipped: z.number(),
  byType: z.record(z.string(), z.number()),
});

const summaryStep = createStep({
  id: "summary",
  description: "Summarise variant detection results",
  inputSchema: writeVariantEdgesOutputSchema,
  outputSchema: summaryOutputSchema,
  execute: async ({ inputData, getStepResult }) => {
    const genderResult = getStepResult<z.infer<typeof detectionOutputSchema>>("detect-gender-variants");
    const sizeResult = getStepResult<z.infer<typeof detectionOutputSchema>>("detect-size-variants");
    const generationResult = getStepResult<z.infer<typeof detectionOutputSchema>>("detect-generation-variants");

    const genderCount = genderResult?.candidates?.length ?? 0;
    const sizeCount = sizeResult?.candidates?.length ?? 0;
    const generationCount = generationResult?.candidates?.length ?? 0;
    const detected = genderCount + sizeCount + generationCount;

    return {
      detected,
      written: inputData.written,
      skipped: inputData.skipped,
      byType: {
        gender: genderCount,
        size: sizeCount,
        generation: generationCount,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------

export const variantDetection = createWorkflow({
  id: "variant-detection",
  inputSchema: triggerSchema,
  outputSchema: summaryOutputSchema,
})
  .then(detectGenderVariants)
  .then(detectSizeVariants)
  .then(detectGenerationVariants)
  .then(writeVariantEdges)
  .then(summaryStep)
  .commit();
