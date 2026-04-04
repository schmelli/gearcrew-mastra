/**
 * Brand-Category Scan Workflow
 * Phase 2: Autonomous brand-by-brand, category-by-category graph maintenance.
 *
 * Each tick processes ONE brand+category combination:
 *   1. Pick next target (least-recently-audited brand/category)
 *   2. Load current graph state for that combination
 *   3. Let the agent research & update the graph
 *   4. Mark brand/category as audited
 *   5. Write a CycleReport node
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import { MAX_STEPS } from "../agents/gardener-v3.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  brandSlug: z
    .string()
    .optional()
    .describe("Specific brand to scan (optional — if empty, picks next from queue)"),
  categorySlug: z
    .string()
    .optional()
    .describe("Specific category to scan (optional — if empty, picks next for brand)"),
});

const targetOutputSchema = z.object({
  brandName: z.string().optional(),
  brandSlug: z.string().optional(),
  brandWebsite: z.string().optional(),
  categoryName: z.string().optional(),
  categorySlug: z.string().optional(),
  skipped: z.boolean(),
  reason: z.string().optional(),
  cycleId: z.string(),
  startedAt: z.string(),
});

const graphStateOutputSchema = z.object({
  brandName: z.string(),
  brandWebsite: z.string().optional(),
  categoryName: z.string(),
  products: z.array(
    z.object({
      name: z.string(),
      gearId: z.string().optional(),
      weight: z.number().nullable().optional(),
      price: z.number().nullable().optional(),
      description: z.string().nullable().optional(),
      productUrl: z.string().nullable().optional(),
      discontinued: z.boolean().nullable().optional(),
      lastVerified: z.string().nullable().optional(),
    }),
  ),
  productCount: z.number(),
  cycleId: z.string(),
  startedAt: z.string(),
  skipped: z.boolean(),
});

const scanOutputSchema = z.object({
  agentResponse: z.string(),
  toolCallCount: z.number(),
  brandName: z.string(),
  categoryName: z.string(),
  cycleId: z.string(),
  startedAt: z.string(),
  skipped: z.boolean(),
  error: z.boolean(),
});

const auditOutputSchema = z.object({
  brandName: z.string(),
  categoryName: z.string(),
  brandFullyAudited: z.boolean(),
  cycleId: z.string(),
  startedAt: z.string(),
  toolCallCount: z.number(),
  skipped: z.boolean(),
  error: z.boolean(),
});

const reportOutputSchema = z.object({
  cycleId: z.string(),
  outcome: z.string(),
  brandName: z.string().optional(),
  categoryName: z.string().optional(),
  toolCallCount: z.number(),
});

// ---------------------------------------------------------------------------
// Step 1: pick-next-target
// ---------------------------------------------------------------------------

const pickNextTarget = createStep({
  id: "pick-next-target",
  description: "Select the next brand+category to scan (least-recently-audited first)",
  inputSchema: triggerSchema,
  outputSchema: targetOutputSchema,
  execute: async ({ inputData }) => {
    const cycleId = randomUUID();
    const startedAt = new Date().toISOString();

    let brandName: string | undefined;
    let brandSlug: string | undefined;
    let brandWebsite: string | undefined;

    const session = getReadSession();
    try {
      // --- Resolve brand ---
      if (inputData.brandSlug) {
        const res = await session.run(
          `MATCH (b:OutdoorBrand {slug: $slug})
           RETURN b.name AS brandName, b.slug AS brandSlug, b.website AS brandWebsite`,
          { slug: inputData.brandSlug },
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          brandName = rec.get("brandName") as string;
          brandSlug = rec.get("brandSlug") as string;
          brandWebsite = (rec.get("brandWebsite") as string) ?? undefined;
        }
      } else {
        const res = await session.run(
          `MATCH (b:OutdoorBrand)
           OPTIONAL MATCH (b)-[:MANUFACTURES_ITEM]->(g:GearItem)
           WITH b, count(g) AS productCount
           WHERE productCount > 0
           ORDER BY b.last_audited_at ASC NULLS FIRST
           LIMIT 1
           RETURN b.name AS brandName, b.slug AS brandSlug, b.website AS brandWebsite,
                  b.last_audited_at AS lastAuditedAt, productCount`,
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          brandName = rec.get("brandName") as string;
          brandSlug = rec.get("brandSlug") as string;
          brandWebsite = (rec.get("brandWebsite") as string) ?? undefined;
        }
      }

      if (!brandName) {
        return {
          skipped: true,
          reason: "No brands to scan",
          cycleId,
          startedAt,
        };
      }

      // --- Resolve category ---
      let categoryName: string | undefined;
      let categorySlug: string | undefined;

      if (inputData.categorySlug) {
        const res = await session.run(
          `MATCH (pt:ProductType {slug: $slug})
           RETURN pt.name AS categoryName, pt.slug AS categorySlug`,
          { slug: inputData.categorySlug },
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          categoryName = rec.get("categoryName") as string;
          categorySlug = rec.get("categorySlug") as string;
        }
      } else {
        // Find next un-audited category for this brand
        // Uses AUDITED_CATEGORY relationship (brand-specific) instead of global ProductType property
        const res = await session.run(
          `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)-[:IS_TYPE]->(pt:ProductType)
           WITH DISTINCT pt, b
           OPTIONAL MATCH (b)-[audit:AUDITED_CATEGORY]->(pt)
           ORDER BY audit.at ASC NULLS FIRST
           LIMIT 1
           RETURN pt.name AS categoryName, pt.slug AS categorySlug`,
          { brandName },
        );
        if (res.records.length > 0) {
          const rec = res.records[0]!;
          categoryName = rec.get("categoryName") as string;
          categorySlug = rec.get("categorySlug") as string;
        }
      }

      if (!categoryName) {
        // All categories audited — mark brand as fully audited
        const writeSession = getWriteSession();
        try {
          await writeSession.run(
            `MATCH (b:OutdoorBrand {name: $brandName})
             SET b.last_audited_at = datetime()`,
            { brandName },
          );
        } finally {
          await writeSession.close();
        }

        return {
          brandName,
          brandSlug,
          brandWebsite,
          skipped: true,
          reason: "Brand fully audited",
          cycleId,
          startedAt,
        };
      }

      console.log(`[pick-next-target] Selected: ${brandName} / ${categoryName}`);

      return {
        brandName,
        brandSlug,
        brandWebsite,
        categoryName,
        categorySlug,
        skipped: false,
        cycleId,
        startedAt,
      };
    } finally {
      await session.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Step 2: load-graph-state
// ---------------------------------------------------------------------------

const loadGraphState = createStep({
  id: "load-graph-state",
  description: "Load existing products for the target brand+category from the graph",
  inputSchema: targetOutputSchema,
  outputSchema: graphStateOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.skipped) {
      return {
        brandName: inputData.brandName ?? "",
        brandWebsite: inputData.brandWebsite,
        categoryName: inputData.categoryName ?? "",
        products: [],
        productCount: 0,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: true,
      };
    }

    const session = getReadSession();
    try {
      const res = await session.run(
        `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)-[:IS_TYPE]->(pt:ProductType {name: $categoryName})
         RETURN g.name AS name, g.gearId AS gearId, g.weight_grams AS weight,
                g.price_usd AS price, g.description AS description, g.productUrl AS productUrl,
                g.discontinued AS discontinued, g.last_verified_at AS lastVerified
         ORDER BY g.name`,
        { brandName: inputData.brandName, categoryName: inputData.categoryName },
      );

      const products = res.records.map((rec) => ({
        name: rec.get("name") as string,
        gearId: (rec.get("gearId") as string) ?? undefined,
        weight: toNumber(rec.get("weight")) || null,
        price: toNumber(rec.get("price")) || null,
        description: (rec.get("description") as string) ?? null,
        productUrl: (rec.get("productUrl") as string) ?? null,
        discontinued: (rec.get("discontinued") as boolean) ?? null,
        lastVerified: rec.get("lastVerified")?.toString() ?? null,
      }));

      return {
        brandName: inputData.brandName!,
        brandWebsite: inputData.brandWebsite,
        categoryName: inputData.categoryName!,
        products,
        productCount: products.length,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: false,
      };
    } finally {
      await session.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Step 3: scan-category (agent call)
// ---------------------------------------------------------------------------

const scanCategory = createStep({
  id: "scan-category",
  description: "Let the GardenerV3 agent research and update the category",
  inputSchema: graphStateOutputSchema,
  outputSchema: scanOutputSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.skipped) {
      return {
        agentResponse: "Skipped — no target to scan.",
        toolCallCount: 0,
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: true,
        error: false,
      };
    }

    if (!mastra) throw new Error("Mastra context is required");
    const agent = mastra.getAgent("GardenerV3");

    const productList =
      inputData.products.length > 0
        ? inputData.products
            .map(
              (p) =>
                `- ${p.name} (${p.gearId ?? "NO_ID"}) | Gewicht: ${p.weight ?? "FEHLT"} | Preis: ${p.price ?? "FEHLT"} | URL: ${p.productUrl ?? "FEHLT"}`,
            )
            .join("\n")
        : "(keine Produkte im Graph)";

    const prompt = `Prüfe die Produktkategorie "${inputData.categoryName}" der Brand "${inputData.brandName}".

Brand-Website: ${inputData.brandWebsite || "nicht bekannt"}

Aktuell im Graph (${inputData.productCount} Produkte):
${productList}

Deine Aufgaben:
1. Recherchiere welche aktuellen ${inputData.categoryName}-Produkte ${inputData.brandName} anbietet
2. Ergänze fehlende Produkte via MERGE
3. Erkenne Nachfolger-Produkte und setze SUPERSEDES/SUPERSEDED_BY-Kanten
4. Trage fehlende Spezifikationen nach (Gewicht, Preis, URL, Beschreibung)
5. Setze last_verified_at = datetime() auf alle geprüften Items

Beginne mit getOntology, dann graphQuery zum Verifizieren, dann webSearch/webScrape zum Recherchieren.`;

    try {
      const result = await agent.generate(prompt, { toolChoice: "auto", maxSteps: MAX_STEPS });

      return {
        agentResponse: result.text ?? "",
        toolCallCount: result.steps?.length ?? 0,
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: false,
        error: false,
      };
    } catch (err) {
      console.error("[scan-category] agent.generate() failed:", err);
      return {
        agentResponse: `Error: ${err instanceof Error ? err.message : String(err)}`,
        toolCallCount: 0,
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        skipped: false,
        error: true,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Step 4: mark-audited
// ---------------------------------------------------------------------------

const markAudited = createStep({
  id: "mark-audited",
  description: "Mark the category (and optionally brand) as audited in the graph",
  inputSchema: scanOutputSchema,
  outputSchema: auditOutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.skipped || inputData.error) {
      return {
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        brandFullyAudited: false,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        toolCallCount: inputData.toolCallCount,
        skipped: inputData.skipped,
        error: inputData.error,
      };
    }

    const session = getWriteSession();
    try {
      // Mark category as audited FOR THIS BRAND (brand-specific relationship)
      await session.run(
        `MATCH (b:OutdoorBrand {name: $brandName}), (pt:ProductType {name: $categoryName})
         MERGE (b)-[audit:AUDITED_CATEGORY]->(pt)
         SET audit.at = datetime()`,
        { brandName: inputData.brandName, categoryName: inputData.categoryName },
      );

      // Check if ALL categories for this brand are now audited (within last 7 days)
      const res = await session.run(
        `MATCH (b:OutdoorBrand {name: $brandName})-[:MANUFACTURES_ITEM]->(g:GearItem)-[:IS_TYPE]->(pt:ProductType)
         WITH b, collect(DISTINCT pt) AS categories
         OPTIONAL MATCH (b)-[audit:AUDITED_CATEGORY]->(pt2) WHERE pt2 IN categories
         WITH b, size(categories) AS total, count(audit) AS audited,
              [a IN collect(audit.at) WHERE a IS NOT NULL AND a > datetime() - duration('P7D')] AS recentAudits
         WHERE size(recentAudits) = total
         SET b.last_audited_at = datetime()
         RETURN b.name AS brandAudited`,
        { brandName: inputData.brandName },
      );

      const brandFullyAudited = res.records.length > 0;

      if (brandFullyAudited) {
        console.log(`[mark-audited] Brand "${inputData.brandName}" fully audited (all categories within 7d)`);
      }

      return {
        brandName: inputData.brandName,
        categoryName: inputData.categoryName,
        brandFullyAudited,
        cycleId: inputData.cycleId,
        startedAt: inputData.startedAt,
        toolCallCount: inputData.toolCallCount,
        skipped: false,
        error: false,
      };
    } finally {
      await session.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Step 5: write-report
// ---------------------------------------------------------------------------

const writeReport = createStep({
  id: "write-report",
  description: "Write a CycleReport node to the graph for observability",
  inputSchema: auditOutputSchema,
  outputSchema: reportOutputSchema,
  execute: async ({ inputData }) => {
    const outcome = inputData.error ? "error" : inputData.skipped ? "skipped" : "completed";

    const session = getWriteSession();
    try {
      await session.run(
        `MERGE (r:CycleReport {cycleId: $cycleId})
         SET r.startedAt = datetime($startedAt),
             r.completedAt = datetime(),
             r.brandName = $brandName,
             r.categoryName = $categoryName,
             r.toolCalls = $toolCallCount,
             r.outcome = $outcome`,
        {
          cycleId: inputData.cycleId,
          startedAt: inputData.startedAt,
          brandName: inputData.brandName,
          categoryName: inputData.categoryName,
          toolCallCount: inputData.toolCallCount,
          outcome,
        },
      );
    } finally {
      await session.close();
    }

    return {
      cycleId: inputData.cycleId,
      outcome,
      brandName: inputData.brandName,
      categoryName: inputData.categoryName,
      toolCallCount: inputData.toolCallCount,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow export
// ---------------------------------------------------------------------------

export const brandCategoryScan = createWorkflow({
  id: "brandCategoryScan",
  inputSchema: triggerSchema,
  outputSchema: reportOutputSchema,
})
  .then(pickNextTarget)
  .then(loadGraphState)
  .then(scanCategory)
  .then(markAudited)
  .then(writeReport)
  .commit();
