import { Workflow, Step } from "@mastra/core/workflows";
import { z } from "zod";

const getExistingProducts = new Step({
  id: "get-existing-products",
  description: "Get all existing products for a brand from the graph",
  outputSchema: z.object({
    brand: z.string(),
    existingProducts: z.array(
      z.object({
        name: z.string(),
        gearId: z.string().optional(),
      }),
    ),
    productCount: z.number(),
    website: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const brandName = context.triggerData.brandName;
    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
      `Query the GearGraph for all products from brand "${brandName}".

      Run these graphQuery queries:
      1. MATCH (g:GearItem {brand: $name}) RETURN g.name AS name, g.gearId AS gearId
         with params: { name: "${brandName}" }
      2. MATCH (b:OutdoorBrand {name: $name}) RETURN b.website AS website
         with params: { name: "${brandName}" }

      Return ONLY a JSON object:
      {
        "brand": "${brandName}",
        "existingProducts": [{ "name": "...", "gearId": "..." }, ...],
        "productCount": <number>,
        "website": "<url or null>"
      }`,
      { toolChoice: "required" },
    );

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }

    return {
      brand: brandName,
      existingProducts: [],
      productCount: 0,
    };
  },
});

const scrapeProductCatalog = new Step({
  id: "scrape-product-catalog",
  description: "Scrape manufacturer website for product catalog",
  outputSchema: z.object({
    discoveredProducts: z.array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
        category: z.string().optional(),
      }),
    ),
    source: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const existing = context.getStepResult<{
      brand: string;
      website?: string;
      existingProducts: Array<{ name: string }>;
    }>("get-existing-products");

    const agent = mastra!.getAgent("Gardener");

    const existingNames = existing.existingProducts
      .map((p) => p.name)
      .join(", ");

    const result = await agent.generate(
      `Discover new products for brand "${existing.brand}".

      Existing products already in the graph: ${existingNames || "none"}
      ${existing.website ? `Brand website: ${existing.website}` : "No website on file."}

      Steps:
      1. ${existing.website ? `Scrape the brand website using webScrape: ${existing.website}` : `Search for "${existing.brand} outdoor gear products" using webSearch`}
      2. Also search for "${existing.brand} new products 2025 2026" using webSearch
      3. Compile a list of products found that are NOT in the existing products list

      Return ONLY a JSON object:
      {
        "discoveredProducts": [{ "name": "...", "url": "...", "category": "..." }, ...],
        "source": "<primary source URL>"
      }`,
      { toolChoice: "auto" },
    );

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through
    }

    return { discoveredProducts: [], source: "unknown" };
  },
});

const diffProducts = new Step({
  id: "diff-products",
  description: "Determine which discovered products are truly new",
  outputSchema: z.object({
    newProducts: z.array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
        category: z.string().optional(),
      }),
    ),
    alreadyExists: z.number(),
  }),
  execute: async ({ context }) => {
    const existing = context.getStepResult<{
      existingProducts: Array<{ name: string }>;
    }>("get-existing-products");

    const discovered = context.getStepResult<{
      discoveredProducts: Array<{
        name: string;
        url?: string;
        category?: string;
      }>;
    }>("scrape-product-catalog");

    const existingNamesLower = new Set(
      existing.existingProducts.map((p) => p.name.toLowerCase()),
    );

    const newProducts = discovered.discoveredProducts.filter(
      (p) => !existingNamesLower.has(p.name.toLowerCase()),
    );

    return {
      newProducts,
      alreadyExists:
        discovered.discoveredProducts.length - newProducts.length,
    };
  },
});

const researchAndWriteNew = new Step({
  id: "research-and-write-new",
  description:
    "Research specs for new products, validate, and write to graph",
  outputSchema: z.object({
    productsAdded: z.number(),
    productsSkipped: z.number(),
    details: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const brand = context.triggerData.brandName;
    const diff = context.getStepResult<{
      newProducts: Array<{
        name: string;
        url?: string;
        category?: string;
      }>;
    }>("diff-products");

    if (diff.newProducts.length === 0) {
      return {
        productsAdded: 0,
        productsSkipped: 0,
        details: "No new products to add",
      };
    }

    const agent = mastra!.getAgent("Gardener");

    // Process in batches of 5 to avoid overwhelming the agent
    const batchSize = 5;
    let totalAdded = 0;
    let totalSkipped = 0;
    const allDetails: string[] = [];

    for (let i = 0; i < diff.newProducts.length; i += batchSize) {
      const batch = diff.newProducts.slice(i, i + batchSize);
      const productList = batch
        .map(
          (p) =>
            `- ${p.name}${p.url ? ` (${p.url})` : ""}${p.category ? ` [${p.category}]` : ""}`,
        )
        .join("\n");

      const result = await agent.generate(
        `Add these new products for brand "${brand}" to the GearGraph:
        ${productList}

        For each product:
        1. Use getOntology to check the schema
        2. If the product has a URL, use webScrape to get specs (weight, price, description, features)
        3. If no URL, use webSearch to find specs: "${brand} <product name> specs weight price"
        4. Use validateSchema to check the data
        5. Generate a gearId in format "brand-slug_product-slug" (lowercase, hyphens)
        6. Use graphWrite with MERGE to add the product:
           MERGE (g:GearItem {gearId: $gearId})
           SET g.name = $name, g.brand = $brand, g.weight_grams = $weight, ...
        7. Also MERGE the PRODUCED_BY relationship:
           MATCH (g:GearItem {gearId: $gearId}), (b:OutdoorBrand {name: $brand})
           MERGE (g)-[:PRODUCED_BY]->(b)
        8. Verify with graphQuery

        Report how many products you successfully added vs skipped.`,
        { toolChoice: "auto" },
      );

      const addedMatch = result.text.match(/(\d+)\s*(?:added|created|successfully)/i);
      const skippedMatch = result.text.match(/(\d+)\s*(?:skipped|failed)/i);
      totalAdded += addedMatch ? parseInt(addedMatch[1], 10) : 0;
      totalSkipped += skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
      allDetails.push(result.text);
    }

    return {
      productsAdded: totalAdded,
      productsSkipped: totalSkipped,
      details: allDetails.join("\n---\n"),
    };
  },
});

const verifyProductCount = new Step({
  id: "verify-product-count",
  description: "Verify the new product count matches expectations",
  outputSchema: z.object({
    brand: z.string(),
    productsBefore: z.number(),
    productsAfter: z.number(),
    newlyAdded: z.number(),
  }),
  execute: async ({ context, mastra }) => {
    const brandName = context.triggerData.brandName;
    const before = context.getStepResult<{
      productCount: number;
    }>("get-existing-products").productCount;

    const agent = mastra!.getAgent("Gardener");

    const result = await agent.generate(
      `Count the total products for brand "${brandName}" in the GearGraph now.
      Query: MATCH (g:GearItem {brand: $name}) RETURN count(g) AS count
      Params: { name: "${brandName}" }

      Return ONLY: { "count": <number> }`,
      { toolChoice: "required" },
    );

    let after = before;
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        after = JSON.parse(jsonMatch[0]).count ?? before;
      }
    } catch {
      // Keep before count
    }

    return {
      brand: brandName,
      productsBefore: before,
      productsAfter: after,
      newlyAdded: after - before,
    };
  },
});

export const productDiscovery = new Workflow({
  name: "product-discovery",
  triggerSchema: z.object({
    brandName: z.string().describe("The brand to discover products for"),
  }),
})
  .step(getExistingProducts)
  .then(scrapeProductCatalog)
  .then(diffProducts)
  .then(researchAndWriteNew)
  .then(verifyProductCount)
  .commit();
