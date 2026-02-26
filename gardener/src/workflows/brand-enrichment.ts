import { Workflow, Step } from "@mastra/core/workflows";
import { z } from "zod";

const assessBrand = new Step({
  id: "assess-brand",
  description: "Check what data already exists for this brand in the graph",
  outputSchema: z.object({
    brand: z.string(),
    exists: z.boolean(),
    productCount: z.number(),
    familyCount: z.number(),
    technologyCount: z.number(),
    hasDescription: z.boolean(),
    hasWebsite: z.boolean(),
    hasCountry: z.boolean(),
    completenessScore: z.number(),
    gaps: z.array(z.string()),
  }),
  execute: async ({ context, mastra }) => {
    const brandName = context.triggerData.brandName;
    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
      `Query the GearGraph for brand "${brandName}".
      Get: the brand node properties, count of products (GearItem),
      count of product families, count of technologies,
      and whether it has a description, website URL, and country.

      Use the graphQuery tool to run these queries:
      1. MATCH (b:OutdoorBrand {name: $name}) RETURN b — to get brand properties
      2. MATCH (g:GearItem {brand: $name}) RETURN count(g) AS productCount — to count products
      3. MATCH (b:OutdoorBrand {name: $name})-[:MANUFACTURES]->(f:ProductFamily) RETURN count(f) AS familyCount
      4. MATCH (b:OutdoorBrand {name: $name})-[:DEVELOPS_TECHNOLOGY]->(t:Technology) RETURN count(t) AS techCount

      Then calculate a completeness score (0.0-1.0) and list the gaps.
      Gaps include: missing description, missing website, missing country, missing yearFounded,
      no products, no product families, no technologies.

      Return ONLY a JSON object matching this schema:
      {
        brand: string,
        exists: boolean,
        productCount: number,
        familyCount: number,
        technologyCount: number,
        hasDescription: boolean,
        hasWebsite: boolean,
        hasCountry: boolean,
        completenessScore: number (0.0-1.0),
        gaps: string[]
      }`,
      { toolChoice: "required" },
    );

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Fall through to default
    }

    return {
      brand: brandName,
      exists: false,
      productCount: 0,
      familyCount: 0,
      technologyCount: 0,
      hasDescription: false,
      hasWebsite: false,
      hasCountry: false,
      completenessScore: 0,
      gaps: ["brand not found in graph"],
    };
  },
});

const researchGaps = new Step({
  id: "research-gaps",
  description:
    "Scrape manufacturer website and search for missing information",
  outputSchema: z.object({
    action: z.enum(["skip", "enrich"]),
    reason: z.string().optional(),
    data: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const assessment = context.getStepResult<{
      completenessScore: number;
      brand: string;
      gaps: string[];
    }>("assess-brand");

    if (assessment.completenessScore > 0.8) {
      return {
        action: "skip" as const,
        reason: "Brand is sufficiently complete",
      };
    }

    const agent = mastra!.getAgent("Gardener");

    const research = await agent.generate(
      `The brand "${assessment.brand}" has these gaps: ${assessment.gaps.join(", ")}
      Completeness: ${(assessment.completenessScore * 100).toFixed(0)}%

      Research the missing information. Priority:
      1. If brand has a website, scrape it first (use webScrape)
      2. Search for the brand + "outdoor gear" to find reviews and product lists (use webSearch)
      3. Focus on: product catalog, technologies, founding info, headquarters

      For each piece of information you find, note the source URL.
      Return structured data for each gap you can fill as JSON.`,
      { toolChoice: "auto" },
    );

    return { action: "enrich" as const, data: research.text };
  },
});

const validateAndWrite = new Step({
  id: "validate-and-write",
  description:
    "Validate researched data against ontology and write to graph",
  outputSchema: z.object({
    written: z.number(),
    skipped: z.boolean(),
    details: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const research = context.getStepResult<{
      action: string;
      data?: string;
    }>("research-gaps");

    if (research.action === "skip") {
      return { written: 0, skipped: true };
    }

    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
      `You have researched data for brand enrichment:
      ${research.data}

      Now:
      1. Use getOntology to load the schema
      2. Use validateSchema to check each piece of data
      3. Generate MERGE-based Cypher queries for valid data
      4. Use graphWrite to execute each query
      5. Use graphQuery to verify the writes

      Important:
      - Use MERGE, never CREATE
      - Include sourceUrl and updatedAt on all new properties
      - Set updatedAt to current datetime: datetime()
      - Parameterize all queries (use $params)
      - Report how many successful writes you made`,
      { toolChoice: "auto" },
    );

    const countMatch = result.text.match(/(\d+)\s*(?:successful|writes|nodes|properties)/i);
    const writeCount = countMatch ? parseInt(countMatch[1], 10) : 0;

    return { written: writeCount, skipped: false, details: result.text };
  },
});

const verifyImprovement = new Step({
  id: "verify-improvement",
  description: "Re-assess brand completeness after enrichment",
  outputSchema: z.object({
    brand: z.string(),
    scoreBefore: z.number(),
    scoreAfter: z.number(),
    improved: z.boolean(),
  }),
  execute: async ({ context, mastra }) => {
    const brandName = context.triggerData.brandName;
    const before = context.getStepResult<{
      completenessScore: number;
    }>("assess-brand").completenessScore;

    const writeResult = context.getStepResult<{
      skipped: boolean;
    }>("validate-and-write");

    if (writeResult.skipped) {
      return {
        brand: brandName,
        scoreBefore: before,
        scoreAfter: before,
        improved: false,
      };
    }

    const agent = mastra!.getAgent("Gardener");

    const after = await agent.generate(
      `Re-assess the completeness of brand "${brandName}" in the GearGraph.
      Previous score was ${(before * 100).toFixed(0)}%.
      Query the graph and calculate the new completeness score.

      Use graphQuery to check:
      1. Brand properties (description, website, country, yearFounded)
      2. Product count
      3. Product family count
      4. Technology count

      Return ONLY a JSON object: { "completenessScore": <number 0.0-1.0> }`,
      { toolChoice: "required" },
    );

    let scoreAfter = before;
    try {
      const jsonMatch = after.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        scoreAfter = parsed.completenessScore ?? before;
      }
    } catch {
      // Keep before score
    }

    return {
      brand: brandName,
      scoreBefore: before,
      scoreAfter,
      improved: scoreAfter > before,
    };
  },
});

export const brandEnrichment = new Workflow({
  name: "brand-enrichment",
  triggerSchema: z.object({
    brandName: z.string().describe("The brand name to enrich"),
  }),
})
  .step(assessBrand)
  .then(researchGaps)
  .then(validateAndWrite)
  .then(verifyImprovement)
  .commit();
