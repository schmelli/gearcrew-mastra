/**
 * Memgraph ProductType Backfill — Phase A of the GearGraph Insights
 * 3-level-hierarchy follow-up.
 *
 * Problem: 8,358 of 8,423 :GearItem nodes have NO :HAS_PRODUCT_TYPE edge
 * (~99% coverage gap). 264 :ProductType nodes already exist. Without the
 * link, the insight-migration GENERIC bucket has nowhere to re-route tips
 * to and falls back onto the GearItem (626 fallback :Tip edges currently).
 *
 * Workflow logic:
 *   1. Fetch all :ProductType node names + descriptions once
 *   2. Fetch :GearItem nodes that:
 *        - have NO outgoing :HAS_PRODUCT_TYPE edge, AND
 *        - product_type_classified_at IS NULL (unless force=true)
 *      Pulls (brand, name, description, category_legacy) for the LLM.
 *   3. Batch-classify N items at a time via Gemini Flash. Confidence floor
 *      0.7 — below that we record a NONE classification.
 *   4. Apply mode:
 *        - For each result with confidence >= 0.7 and a non-null name:
 *            MATCH (g), MATCH (pt) by name, MERGE (g)-[:HAS_PRODUCT_TYPE]->(pt)
 *            stamp g.product_type_classified_at = datetime()
 *        - For NONE results: stamp g.product_type_classified_at only (so
 *          the item is skipped on subsequent runs without force=true).
 *   5. Cost cap aborts the run between batches if the limit is hit.
 *
 * Cost estimate: 8358 items / 30 per batch = ~280 Gemini calls × ~1¢ each ≈ $3.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import {
  classifyProductTypeBatch,
  type GearItemForClassification,
  type ProductTypeCandidate,
} from "../lib/memgraph-product-type-classifier.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
  batch_size: z.number().int().positive().default(30),
  force: z.boolean().default(false),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
  max_cost_cents: z.number().int().positive().default(1000),
});

const sampleSchema = z.object({
  memgraph_id: z.string(),
  brand: z.string(),
  name: z.string(),
  suggested_type: z.string().nullable(),
  confidence: z.number(),
  reasoning: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_targets: z.number(),
  candidate_count: z.number(),
  processed: z.number(),
  classified: z.number(),
  none: z.number(),
  edges_created: z.number(),
  failed: z.number(),
  cost_cents: z.number(),
  aborted_due_to_cost: z.boolean(),
  sample_classified: z.array(sampleSchema),
  sample_none: z.array(sampleSchema),
});

// ---------------------------------------------------------------------------
// Memgraph helpers
// ---------------------------------------------------------------------------

async function fetchCandidates(): Promise<ProductTypeCandidate[]> {
  const session = getReadSession();
  try {
    const r = await session.run(
      `MATCH (pt:ProductType)
       WHERE pt.name IS NOT NULL
       RETURN pt.name AS name,
              coalesce(pt.description, pt.summary, null) AS description
       ORDER BY pt.name`,
    );
    return r.records.map((rec) => ({
      name: String(rec.get("name")),
      description: rec.get("description") ?? null,
    }));
  } finally {
    await session.close();
  }
}

interface RawGearItem {
  memgraph_id: string;
  brand: string;
  name: string;
  description: string | null;
  category_legacy: string | null;
}

async function fetchGearItemsToClassify(
  limit: number | undefined,
  force: boolean,
): Promise<RawGearItem[]> {
  const session = getReadSession();
  try {
    const cooldownClause = force
      ? ""
      : "AND g.product_type_classified_at IS NULL";
    const limitClause = limit ? `LIMIT ${limit}` : "";

    const result = await session.run(
      `MATCH (g:GearItem)
       WHERE NOT EXISTS((g)-[:HAS_PRODUCT_TYPE]->(:ProductType))
         ${cooldownClause}
       RETURN ID(g) AS memgraph_id,
              coalesce(g.brand, '?') AS brand,
              coalesce(g.name, '?') AS name,
              coalesce(g.description, g.summary, null) AS description,
              coalesce(g.category, g.category_legacy, null) AS category_legacy
       ${limitClause}`,
    );

    return result.records.map((r) => ({
      memgraph_id: String(toNumber(r.get("memgraph_id"))),
      brand: String(r.get("brand") ?? "?"),
      name: String(r.get("name") ?? "?"),
      description: r.get("description") ?? null,
      category_legacy: r.get("category_legacy") ?? null,
    }));
  } finally {
    await session.close();
  }
}

async function applyClassification(
  memgraphId: string,
  typeName: string,
): Promise<boolean> {
  // Returns true if a HAS_PRODUCT_TYPE edge was created (or already existed).
  const session = getWriteSession();
  try {
    const r = await session.run(
      `MATCH (g:GearItem) WHERE ID(g) = $id
       MATCH (pt:ProductType {name: $name})
       MERGE (g)-[:HAS_PRODUCT_TYPE]->(pt)
       SET g.product_type_classified_at = datetime()
       RETURN ID(g) AS gid`,
      { id: parseInt(memgraphId, 10), name: typeName },
    );
    return r.records.length > 0;
  } finally {
    await session.close();
  }
}

async function stampNoneClassification(memgraphId: string): Promise<void> {
  const session = getWriteSession();
  try {
    await session.run(
      `MATCH (g:GearItem) WHERE ID(g) = $id
       SET g.product_type_classified_at = datetime()`,
      { id: parseInt(memgraphId, 10) },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Workflow step
// ---------------------------------------------------------------------------

const backfillStep = createStep({
  id: "memgraph-product-type-backfill",
  description:
    "Classify GearItems without HAS_PRODUCT_TYPE edges via Gemini Flash and link to existing :ProductType nodes",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    // 1. Fetch candidates
    const candidates = await fetchCandidates();
    console.log(
      `[product-type-backfill] fetched ${candidates.length} ProductType candidates`,
    );
    if (candidates.length === 0) {
      throw new Error(
        "[product-type-backfill] no :ProductType nodes found in Memgraph",
      );
    }

    // 2. Fetch gear items to classify
    const items = await fetchGearItemsToClassify(
      inputData.limit,
      inputData.force,
    );
    console.log(
      `[product-type-backfill] fetched ${items.length} GearItems to classify (mode=${inputData.mode}, batch_size=${inputData.batch_size}, force=${inputData.force})`,
    );

    if (items.length === 0) {
      return {
        mode: inputData.mode,
        total_targets: 0,
        candidate_count: candidates.length,
        processed: 0,
        classified: 0,
        none: 0,
        edges_created: 0,
        failed: 0,
        cost_cents: 0,
        aborted_due_to_cost: false,
        sample_classified: [],
        sample_none: [],
      };
    }

    // 3. Batch + classify
    let processed = 0;
    let classified = 0;
    let none = 0;
    let edgesCreated = 0;
    let failed = 0;
    let costCents = 0;
    let abortedDueToCost = false;

    const sampleClassified: z.infer<typeof sampleSchema>[] = [];
    const sampleNone: z.infer<typeof sampleSchema>[] = [];

    // Mastra v3 quirk: Zod .default() is NOT applied to inputData passed to
    // the step. Use nullish-coalesce as belt-and-braces for all input fields
    // that have defaults defined in triggerSchema.
    const batchSize = inputData.batch_size ?? 30;
    const maxCostCents = inputData.max_cost_cents ?? 1000;
    const totalBatches = Math.ceil(items.length / batchSize);

    for (let bi = 0; bi < totalBatches; bi += 1) {
      const batch = items.slice(bi * batchSize, (bi + 1) * batchSize);
      const llmInput: GearItemForClassification[] = batch.map((it) => ({
        memgraph_id: it.memgraph_id,
        brand: it.brand,
        name: it.name,
        description: it.description,
        category_legacy: it.category_legacy,
      }));

      try {
        const r = await classifyProductTypeBatch(llmInput, candidates);
        costCents += r.cost_cents;

        const itemById = new Map(batch.map((it) => [it.memgraph_id, it]));

        for (const cls of r.results) {
          const raw = itemById.get(cls.memgraph_id);
          if (!raw) {
            failed += 1;
            continue;
          }
          processed += 1;

          // Mastra v3 quirk: Zod .default() is NOT applied to inputData passed
          // to the step. Use nullish-coalesce as belt-and-braces.
          const threshold = inputData.confidence_threshold ?? 0.7;
          const meetsThreshold =
            cls.suggested_type_name !== null &&
            cls.confidence >= threshold;

          if (meetsThreshold && cls.suggested_type_name !== null) {
            classified += 1;
            if (sampleClassified.length < 10) {
              sampleClassified.push({
                memgraph_id: cls.memgraph_id,
                brand: raw.brand,
                name: raw.name,
                suggested_type: cls.suggested_type_name,
                confidence: cls.confidence,
                reasoning: cls.reasoning.slice(0, 200),
              });
            }
            if (inputData.mode === "apply") {
              try {
                const ok = await applyClassification(
                  cls.memgraph_id,
                  cls.suggested_type_name,
                );
                if (ok) edgesCreated += 1;
                else failed += 1;
              } catch (err) {
                failed += 1;
                console.warn(
                  `[product-type-backfill] apply failed for ${cls.memgraph_id}: ${err instanceof Error ? err.message : err}`,
                );
              }
            }
          } else {
            none += 1;
            if (sampleNone.length < 10) {
              sampleNone.push({
                memgraph_id: cls.memgraph_id,
                brand: raw.brand,
                name: raw.name,
                suggested_type: cls.suggested_type_name,
                confidence: cls.confidence,
                reasoning: cls.reasoning.slice(0, 200),
              });
            }
            if (inputData.mode === "apply") {
              try {
                await stampNoneClassification(cls.memgraph_id);
              } catch (err) {
                console.warn(
                  `[product-type-backfill] stamp-none failed for ${cls.memgraph_id}: ${err instanceof Error ? err.message : err}`,
                );
              }
            }
          }
        }

        console.log(
          `[product-type-backfill] batch ${bi + 1}/${totalBatches} done — processed=${processed} classified=${classified} none=${none} edges=${edgesCreated} cost=${costCents}¢`,
        );

        if (costCents >= maxCostCents) {
          abortedDueToCost = true;
          console.warn(
            `[product-type-backfill] cost cap reached: ${costCents}¢ ≥ ${maxCostCents}¢ — aborting`,
          );
          break;
        }
      } catch (err) {
        failed += batch.length;
        console.error(
          `[product-type-backfill] batch ${bi + 1}/${totalBatches} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      mode: inputData.mode,
      total_targets: items.length,
      candidate_count: candidates.length,
      processed,
      classified,
      none,
      edges_created: edgesCreated,
      failed,
      cost_cents: costCents,
      aborted_due_to_cost: abortedDueToCost,
      sample_classified: sampleClassified,
      sample_none: sampleNone,
    };
  },
});

export const memgraphProductTypeBackfill = createWorkflow({
  id: "memgraphProductTypeBackfill",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(backfillStep)
  .commit();
