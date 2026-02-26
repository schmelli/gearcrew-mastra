import { Workflow, Step } from "@mastra/core/workflows";
import { z } from "zod";

const candidateSchema = z.object({
  sourceGearId: z.string(),
  sourceName: z.string(),
  targetGearId: z.string(),
  targetName: z.string(),
  relationshipType: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
});

const findCompetitors = new Step({
  id: "find-competitors",
  description:
    "Find GearItems in same category + price range without COMPETES_WITH edges",
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
  }),
  execute: async ({ context, mastra }) => {
    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
      `Find potential COMPARE_TO / ALTERNATIVE_TO relationships between GearItems.

      Run this graphQuery:
      MATCH (g1:GearItem), (g2:GearItem)
      WHERE g1.category = g2.category
        AND g1.brand <> g2.brand
        AND id(g1) < id(g2)
        AND NOT (g1)-[:COMPARE_TO]-(g2)
        AND NOT (g1)-[:ALTERNATIVE_TO]-(g2)
        AND g1.price_usd IS NOT NULL AND g2.price_usd IS NOT NULL
        AND abs(g1.price_usd - g2.price_usd) / g1.price_usd < 0.3
      RETURN g1.gearId AS g1Id, g1.name AS g1Name, g1.brand AS g1Brand,
             g2.gearId AS g2Id, g2.name AS g2Name, g2.brand AS g2Brand,
             g1.category AS category, g1.price_usd AS p1, g2.price_usd AS p2
      LIMIT 20

      For each pair, determine if they are truly alternatives/competitors.
      Consider: same product type, similar use case, comparable specs.

      Return ONLY a JSON object:
      {
        "candidates": [
          {
            "sourceGearId": "...",
            "sourceName": "...",
            "targetGearId": "...",
            "targetName": "...",
            "relationshipType": "ALTERNATIVE_TO",
            "confidence": "high|medium|low",
            "reasoning": "..."
          },
          ...
        ]
      }`,
      { toolChoice: "required" },
    );

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }

    return { candidates: [] };
  },
});

const findPairings = new Step({
  id: "find-pairings",
  description:
    "Find GearItems commonly used together without PAIRS_WITH edges",
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
  }),
  execute: async ({ context, mastra }) => {
    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
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
            "sourceGearId": "...",
            "sourceName": "...",
            "targetGearId": "...",
            "targetName": "...",
            "relationshipType": "PAIRS_WITH",
            "confidence": "high|medium|low",
            "reasoning": "..."
          },
          ...
        ]
      }`,
      { toolChoice: "required" },
    );

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }

    return { candidates: [] };
  },
});

const findFamilyAlternatives = new Step({
  id: "find-family-alternatives",
  description:
    "Find ProductFamilies without ALTERNATIVE_TO connections",
  outputSchema: z.object({
    candidates: z.array(candidateSchema),
  }),
  execute: async ({ context, mastra }) => {
    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
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

      Return ONLY a JSON object:
      {
        "candidates": [...]
      }`,
      { toolChoice: "required" },
    );

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }

    return { candidates: [] };
  },
});

const validateAndWriteRelationships = new Step({
  id: "validate-and-write-relationships",
  description:
    "Validate candidate relationships against ontology and write to graph",
  outputSchema: z.object({
    written: z.number(),
    skipped: z.number(),
    details: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const competitors = context.getStepResult<{
      candidates: Array<{
        sourceGearId: string;
        targetGearId: string;
        relationshipType: string;
        confidence: string;
      }>;
    }>("find-competitors");

    const pairings = context.getStepResult<{
      candidates: Array<{
        sourceGearId: string;
        targetGearId: string;
        relationshipType: string;
        confidence: string;
      }>;
    }>("find-pairings");

    const familyAlts = context.getStepResult<{
      candidates: Array<{
        sourceGearId: string;
        targetGearId: string;
        relationshipType: string;
        confidence: string;
      }>;
    }>("find-family-alternatives");

    // Combine all candidates, filter to medium+ confidence
    const allCandidates = [
      ...competitors.candidates,
      ...pairings.candidates,
      ...familyAlts.candidates,
    ].filter((c) => c.confidence !== "low");

    if (allCandidates.length === 0) {
      return {
        written: 0,
        skipped: 0,
        details: "No high/medium confidence candidates found",
      };
    }

    const agent = mastra!.getAgent("Gardener");

    const candidateList = allCandidates
      .map(
        (c) =>
          `- (${c.sourceGearId})-[:${c.relationshipType}]->(${c.targetGearId}) [${c.confidence}]`,
      )
      .join("\n");

    const result = await agent.generate(
      `Write these validated relationships to the GearGraph:
      ${candidateList}

      For each relationship:
      1. Use getOntology to verify the relationship type is valid
      2. Use validateSchema to check compliance
      3. Use graphWrite with MERGE:
         MATCH (g1:GearItem {gearId: $sourceId}), (g2:GearItem {gearId: $targetId})
         MERGE (g1)-[:RELATIONSHIP_TYPE {createdAt: datetime(), source: 'gardener-relationship-weave'}]->(g2)
      4. Verify with graphQuery

      Report total relationships written.`,
      { toolChoice: "auto" },
    );

    const writtenMatch = result.text.match(/(\d+)\s*(?:written|created|merged)/i);

    return {
      written: writtenMatch ? parseInt(writtenMatch[1], 10) : 0,
      skipped: allCandidates.length - (writtenMatch ? parseInt(writtenMatch[1], 10) : 0),
      details: result.text,
    };
  },
});

export const relationshipWeave = new Workflow({
  name: "relationship-weave",
  triggerSchema: z.object({
    types: z
      .array(z.enum(["competitors", "pairings", "alternatives"]))
      .default(["competitors", "pairings", "alternatives"])
      .describe("Which relationship types to discover"),
  }),
})
  .step(findCompetitors)
  .then(findPairings)
  .then(findFamilyAlternatives)
  .then(validateAndWriteRelationships)
  .commit();
