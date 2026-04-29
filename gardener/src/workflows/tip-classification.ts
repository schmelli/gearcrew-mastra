/**
 * Tip Classification Workflow
 *
 * Phase 1 of the insights-restructure plan. Iterates over existing :Insight
 * nodes connected via HAS_TIP edges, classifies each as GENERIC/FAMILY/
 * SPECIFIC/AMBIGUOUS via Gemini Flash, and stamps the classification back
 * onto the Insight node as new properties.
 *
 * Properties added per node:
 *   classification_scope: "GENERIC" | "FAMILY" | "SPECIFIC" | "AMBIGUOUS"
 *   classification_confidence: number 0..1
 *   classification_reasoning: string
 *   classified_at: datetime
 *
 * NO structural migration in this phase — only metadata. Migration to
 * separate :Tip and :ProductInsight labels happens in a Phase 2 workflow
 * after the user reviews a sample.
 *
 * Modes:
 *   "dry-run": classify N tips, show sample distribution, do NOT write
 *   "apply":   classify all tips (or up to limit), write back to Memgraph
 *
 * Idempotency: items with classification_scope already set are skipped
 * unless force=true.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import {
  classifyTipBatch,
  type TipForClassification,
} from "../lib/tip-classifier.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
  batch_size: z.number().int().positive().default(50),
  force: z.boolean().default(false),
  max_cost_cents: z.number().int().positive().default(1000),
});

const sampleSchema = z.object({
  insight_id: z.string(),
  insight_text: z.string(),
  gear_item: z.string(),
  classification: z.enum(["GENERIC", "FAMILY", "SPECIFIC", "AMBIGUOUS"]),
  confidence: z.number(),
  reasoning: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_targets: z.number(),
  processed: z.number(),
  written: z.number(),
  failed: z.number(),
  cost_cents: z.number(),
  aborted_due_to_cost: z.boolean(),
  distribution: z.object({
    GENERIC: z.number(),
    FAMILY: z.number(),
    SPECIFIC: z.number(),
    AMBIGUOUS: z.number(),
  }),
  sample_per_bucket: z.object({
    GENERIC: z.array(sampleSchema),
    FAMILY: z.array(sampleSchema),
    SPECIFIC: z.array(sampleSchema),
    AMBIGUOUS: z.array(sampleSchema),
  }),
});

interface RawTip {
  insight_id: string;
  insight_text: string;
  gear_item_brand: string;
  gear_item_name: string;
  product_family_name: string | null;
  product_type_name: string | null;
  family_sibling_count: number;
}

async function fetchTipsToClassify(
  limit: number | undefined,
  force: boolean,
): Promise<RawTip[]> {
  const session = getReadSession();
  try {
    // We pull HAS_TIP edges. For each tip, we additionally surface
    //   - the GearItem's ProductFamily (if any) and the family sibling count
    //   - the GearItem's ProductType (if any)
    // These give the LLM enough context to make scope decisions.
    const filterClause = force
      ? ""
      : "AND i.classification_scope IS NULL";
    const limitClause = limit ? `LIMIT ${limit}` : "";

    const result = await session.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(i:Insight)
       WHERE coalesce(i.content, i.summary, i.text) IS NOT NULL
         ${filterClause}
       OPTIONAL MATCH (pf:ProductFamily)-[:HAS_VARIANT]->(g)
       OPTIONAL MATCH (g)-[:HAS_PRODUCT_TYPE]->(pt:ProductType)
       OPTIONAL MATCH (pf)-[:HAS_VARIANT]->(sibling:GearItem)
       WITH i, g, pf, pt, count(DISTINCT sibling) AS sib_count
       RETURN ID(i) AS insight_id,
              coalesce(i.content, i.summary, i.text) AS insight_text,
              g.brand AS brand,
              g.name AS name,
              pf.name AS family_name,
              pt.name AS type_name,
              sib_count
       ${limitClause}`,
    );

    return result.records.map((r) => ({
      insight_id: String(toNumber(r.get("insight_id"))),
      insight_text: String(r.get("insight_text") ?? ""),
      gear_item_brand: String(r.get("brand") ?? "?"),
      gear_item_name: String(r.get("name") ?? "?"),
      product_family_name: r.get("family_name") ?? null,
      product_type_name: r.get("type_name") ?? null,
      family_sibling_count: toNumber(r.get("sib_count")),
    }));
  } finally {
    await session.close();
  }
}

async function writeClassification(
  insightId: string,
  scope: string,
  confidence: number,
  reasoning: string,
): Promise<void> {
  const session = getWriteSession();
  try {
    await session.run(
      `MATCH (i:Insight) WHERE ID(i) = $id
       SET i.classification_scope = $scope,
           i.classification_confidence = $confidence,
           i.classification_reasoning = $reasoning,
           i.classified_at = datetime()`,
      {
        id: parseInt(insightId, 10),
        scope,
        confidence,
        reasoning: reasoning.slice(0, 500),
      },
    );
  } finally {
    await session.close();
  }
}

const classifyStep = createStep({
  id: "classify-tips",
  description:
    "Classify existing HAS_TIP insights into GENERIC/FAMILY/SPECIFIC/AMBIGUOUS via Gemini Flash",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    // 1. Fetch
    const tips = await fetchTipsToClassify(inputData.limit, inputData.force);
    console.log(
      `[tip-classification] fetched ${tips.length} tips to classify (mode=${inputData.mode}, batch_size=${inputData.batch_size})`,
    );

    if (tips.length === 0) {
      return {
        mode: inputData.mode,
        total_targets: 0,
        processed: 0,
        written: 0,
        failed: 0,
        cost_cents: 0,
        aborted_due_to_cost: false,
        distribution: {
          GENERIC: 0,
          FAMILY: 0,
          SPECIFIC: 0,
          AMBIGUOUS: 0,
        },
        sample_per_bucket: {
          GENERIC: [],
          FAMILY: [],
          SPECIFIC: [],
          AMBIGUOUS: [],
        },
      };
    }

    // 2. Batch + classify
    let processed = 0;
    let written = 0;
    let failed = 0;
    let costCents = 0;
    let abortedDueToCost = false;

    const distribution = { GENERIC: 0, FAMILY: 0, SPECIFIC: 0, AMBIGUOUS: 0 };
    const samplePerBucket: Record<string, typeof outputSchema._type.sample_per_bucket.GENERIC> = {
      GENERIC: [],
      FAMILY: [],
      SPECIFIC: [],
      AMBIGUOUS: [],
    };

    const batchSize = inputData.batch_size;
    const totalBatches = Math.ceil(tips.length / batchSize);

    for (let bi = 0; bi < totalBatches; bi += 1) {
      const batch = tips.slice(bi * batchSize, (bi + 1) * batchSize);
      const batchInput: TipForClassification[] = batch.map((t) => ({
        insight_id: t.insight_id,
        insight_text: t.insight_text,
        gear_item_brand: t.gear_item_brand,
        gear_item_name: t.gear_item_name,
        product_family_name: t.product_family_name,
        product_type_name: t.product_type_name,
        family_sibling_count: t.family_sibling_count,
      }));

      try {
        const r = await classifyTipBatch(batchInput);
        costCents += r.cost_cents;

        // Index raw inputs by insight_id for sample collection
        const tipById = new Map(batch.map((t) => [t.insight_id, t]));

        for (const cls of r.classifications) {
          const raw = tipById.get(cls.insight_id);
          if (!raw) {
            failed += 1;
            continue;
          }
          processed += 1;
          distribution[cls.classification] += 1;

          if (samplePerBucket[cls.classification].length < 5) {
            samplePerBucket[cls.classification].push({
              insight_id: cls.insight_id,
              insight_text: raw.insight_text.slice(0, 200),
              gear_item: `${raw.gear_item_brand} / ${raw.gear_item_name}`,
              classification: cls.classification,
              confidence: cls.confidence,
              reasoning: cls.reasoning,
            });
          }

          if (inputData.mode === "apply") {
            try {
              await writeClassification(
                cls.insight_id,
                cls.classification,
                cls.confidence,
                cls.reasoning,
              );
              written += 1;
            } catch (err) {
              failed += 1;
              console.warn(
                `[tip-classification] write failed for ${cls.insight_id}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }

        console.log(
          `[tip-classification] batch ${bi + 1}/${totalBatches} done — processed=${processed} written=${written} cost=${costCents}¢ dist=` +
            `G:${distribution.GENERIC}/F:${distribution.FAMILY}/S:${distribution.SPECIFIC}/A:${distribution.AMBIGUOUS}`,
        );

        if (costCents >= inputData.max_cost_cents) {
          abortedDueToCost = true;
          console.warn(
            `[tip-classification] cost cap reached: ${costCents}¢ ≥ ${inputData.max_cost_cents}¢ — aborting`,
          );
          break;
        }
      } catch (err) {
        failed += batch.length;
        console.error(
          `[tip-classification] batch ${bi + 1}/${totalBatches} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      mode: inputData.mode,
      total_targets: tips.length,
      processed,
      written,
      failed,
      cost_cents: costCents,
      aborted_due_to_cost: abortedDueToCost,
      distribution,
      sample_per_bucket: {
        GENERIC: samplePerBucket.GENERIC,
        FAMILY: samplePerBucket.FAMILY,
        SPECIFIC: samplePerBucket.SPECIFIC,
        AMBIGUOUS: samplePerBucket.AMBIGUOUS,
      },
    };
  },
});

export const tipClassification = createWorkflow({
  id: "tipClassification",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(classifyStep)
  .commit();
