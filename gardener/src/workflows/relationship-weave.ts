import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { extractJson } from "../lib/utils.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  types: z
    .array(z.enum(["competitors", "pairings", "alternatives"]))
    .default(["competitors", "pairings", "alternatives"])
    .describe("Which relationship types to discover"),
});

const candidateSchema = z.object({
  sourceGearId: z.string(),
  sourceName: z.string(),
  targetGearId: z.string(),
  targetName: z.string(),
  relationshipType: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
});

const candidatesSchema = z.object({
  candidates: z.array(candidateSchema),
  skipped: z.boolean(),
});

const writeRelSchema = z.object({
  written: z.number(),
  skipped: z.number(),
  details: z.string(),
});

// ─── Steps ───────────────────────────────────────────────────────────────────

const findCompetitors = createStep({
  id: "find-competitors",
  inputSchema: triggerSchema,
  outputSchema: candidatesSchema,
  execute: async ({ inputData, mastra }) => {
    if (!inputData.types.includes("competitors")) {
      return { candidates: [], skipped: true };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("gardener");

    const fallback = { candidates: [] as Array<z.infer<typeof candidateSchema>>, skipped: false };

    let result;
    try {
      result = await agent.generate(
        `Find potential COMPARE_TO / ALTERNATIVE_TO relationships between GearItems.

      Run this graphQuery (index-friendly, category-based approach):
      MATCH (g1:GearItem)
      WHERE g1.category IS NOT NULL AND g1.price_usd IS NOT NULL
      WITH g1.category AS cat, collect(g1) AS items
      WHERE size(items) > 1
      UNWIND items AS g1
      UNWIND items AS g2
      WHERE g1.brand <> g2.brand AND id(g1) < id(g2)
        AND abs(g1.price_usd - g2.price_usd) / g1.price_usd < 0.3
        AND NOT (g1)-[:COMPARE_TO]-(g2)
        AND NOT (g1)-[:ALTERNATIVE_TO]-(g2)
      RETURN g1.gearId AS g1Id, g1.name AS g1Name, g2.gearId AS g2Id, g2.name AS g2Name, g1.category AS category
      LIMIT 20

      For each pair, determine if they are truly alternatives/competitors.
      Consider: same product type, similar use case, comparable specs.

      Return ONLY a JSON object:
      {
        "candidates": [
          {
            "sourceGearId": "...", "sourceName": "...",
            "targetGearId": "...", "targetName": "...",
            "relationshipType": "ALTERNATIVE_TO",
            "confidence": "high|medium|low",
            "reasoning": "..."
          }
        ]
      }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[find-competitors] agent.generate() failed:", err);
      return fallback;
    }

    const parsed = extractJson(result.text);
    if (parsed && typeof parsed === "object") {
      return { ...(parsed as { candidates: Array<z.infer<typeof candidateSchema>> }), skipped: false };
    }
    return fallback;
  },
});

const findPairings = createStep({
  id: "find-pairings",
  inputSchema: candidatesSchema,
  outputSchema: candidatesSchema,
  execute: async ({ mastra, getInitData }) => {
    const { types } = getInitData<z.infer<typeof triggerSchema>>();
    if (!types.includes("pairings")) {
      return { candidates: [], skipped: true };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("gardener");

    const fallback = { candidates: [] as Array<z.infer<typeof candidateSchema>>, skipped: false };

    let result;
    try {
      result = await agent.generate(
        `Find potential PAIRS_WITH relationships between GearItems.

      Common pairings in outdoor gear:
      - Tent + Sleeping bag
      - Backpack + Rain cover
      - Stove + Fuel canister
      - Trekking poles + Tarp/shelter
      - Water filter + Water bottle

      Run graphQuery to find items in complementary categories without PAIRS_WITH:
      MATCH (g1:GearItem), (g2:GearItem)
      WHERE g1.brand = g2.brand
        AND g1.category <> g2.category
        AND id(g1) < id(g2)
        AND NOT (g1)-[:PAIRS_WITH]-(g2)
      RETURN g1.gearId AS g1Id, g1.name AS g1Name, g1.category AS cat1,
             g2.gearId AS g2Id, g2.name AS g2Name, g2.category AS cat2,
             g1.brand AS brand
      LIMIT 30

      Evaluate which pairs logically go together. Only suggest pairings with
      high or medium confidence.

      Return ONLY a JSON object:
      {
        "candidates": [
          {
            "sourceGearId": "...", "sourceName": "...",
            "targetGearId": "...", "targetName": "...",
            "relationshipType": "PAIRS_WITH",
            "confidence": "high|medium|low",
            "reasoning": "..."
          }
        ]
      }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[find-pairings] agent.generate() failed:", err);
      return fallback;
    }

    const parsed = extractJson(result.text);
    if (parsed && typeof parsed === "object") {
      return { ...(parsed as { candidates: Array<z.infer<typeof candidateSchema>> }), skipped: false };
    }
    return fallback;
  },
});

const findFamilyAlternatives = createStep({
  id: "find-family-alternatives",
  inputSchema: candidatesSchema,
  outputSchema: candidatesSchema,
  execute: async ({ mastra, getInitData }) => {
    const { types } = getInitData<z.infer<typeof triggerSchema>>();
    if (!types.includes("alternatives")) {
      return { candidates: [], skipped: true };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("gardener");

    const fallback = { candidates: [] as Array<z.infer<typeof candidateSchema>>, skipped: false };

    let result;
    try {
      result = await agent.generate(
        `Find potential ALTERNATIVE_TO relationships between GearItems
      from different ProductFamilies in the same product type.

      Run graphQuery:
      MATCH (g1:GearItem)-[:IS_VARIANT_OF]->(f1:ProductFamily),
            (g2:GearItem)-[:IS_VARIANT_OF]->(f2:ProductFamily)
      WHERE f1 <> f2
        AND g1.category = g2.category
        AND id(g1) < id(g2)
        AND NOT (g1)-[:ALTERNATIVE_TO]-(g2)
      RETURN g1.gearId AS g1Id, g1.name AS g1Name, f1.name AS fam1,
             g2.gearId AS g2Id, g2.name AS g2Name, f2.name AS fam2,
             g1.category AS category
      LIMIT 20

      Evaluate which items from different families are true alternatives.

      Return ONLY a JSON object: { "candidates": [...] }`,
        { toolChoice: "required" },
      );
    } catch (err) {
      console.error("[find-family-alternatives] agent.generate() failed:", err);
      return fallback;
    }

    const parsed = extractJson(result.text);
    if (parsed && typeof parsed === "object") {
      return { ...(parsed as { candidates: Array<z.infer<typeof candidateSchema>> }), skipped: false };
    }
    return fallback;
  },
});

const validateAndWriteRelationships = createStep({
  id: "validate-and-write-relationships",
  inputSchema: candidatesSchema,
  outputSchema: writeRelSchema,
  execute: async ({ inputData: familyAlts, mastra, getStepResult }) => {
    const competitors = getStepResult(findCompetitors);
    const pairings = getStepResult(findPairings);

    const allCandidates = [
      ...competitors.candidates,
      ...pairings.candidates,
      ...familyAlts.candidates,
    ].filter((c) => c.confidence !== "low");

    if (allCandidates.length === 0) {
      return { written: 0, skipped: 0, details: "No high/medium confidence candidates found" };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("gardener");

    const candidateList = allCandidates
      .map((c) => `- (${c.sourceGearId})-[:${c.relationshipType}]->(${c.targetGearId}) [${c.confidence}]`)
      .join("\n");

    let result;
    try {
      result = await agent.generate(
        `Write these validated relationships to the GearGraph:
      ${candidateList}

      Each line above is formatted as: (sourceGearId)-[:RELATIONSHIP_TYPE]->(targetGearId) [confidence]
      The RELATIONSHIP_TYPE in each line (e.g. ALTERNATIVE_TO, PAIRS_WITH, COMPARE_TO) is the exact
      Cypher relationship type to use for that specific relationship.

      For each relationship:
      1. Use getOntology to verify the relationship type from that line is valid in the ontology
      2. Use validateSchema to check compliance
      3. Use graphWrite with MERGE, substituting the actual relationship type from that line.
         For example, for a PAIRS_WITH relationship:
         MATCH (g1:GearItem {gearId: $sourceId}), (g2:GearItem {gearId: $targetId})
         MERGE (g1)-[:PAIRS_WITH {createdAt: datetime(), source: 'gardener-relationship-weave'}]->(g2)
      4. Verify with graphQuery

      End your response with a JSON summary: { "writesSucceeded": <number>, "writesFailed": <number> }`,
        { toolChoice: "auto", maxSteps: 50 },
      );
    } catch (err) {
      console.error("[validate-and-write-relationships] agent.generate() failed:", err);
      return { written: 0, skipped: allCandidates.length, details: "Agent error during relationship writes" };
    }

    const parsed = extractJson(result.text) as { writesSucceeded?: number } | null;
    const writeCount = parsed?.writesSucceeded ?? 0;

    return { written: writeCount, skipped: allCandidates.length - writeCount, details: result.text };
  },
});

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const relationshipWeave = createWorkflow({
  id: "relationship-weave",
  inputSchema: triggerSchema,
  outputSchema: writeRelSchema,
})
  .then(findCompetitors)
  .then(findPairings)
  .then(findFamilyAlternatives)
  .then(validateAndWriteRelationships)
  .commit();
