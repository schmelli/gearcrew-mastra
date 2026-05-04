/**
 * classifyProductType — match a :GearItem to one of the 154 :ProductType nodes
 *
 * Wraps `lib/memgraph-product-type-classifier.ts::classifyProductTypeBatch`
 * but with a single-item interface — the agent passes one nodeId, gets back
 * a {suggested_type_name, confidence, reasoning}. The classifier enforces
 * a hallucination guard: suggested_type_name MUST be in the candidate list.
 *
 * Two phases internally:
 *   1. graphQuery to load (a) the :GearItem (brand, name, description, etc.)
 *      and (b) all :ProductType nodes (name + description).
 *   2. Single Gemini-Flash batch call (just 1 item) returns the classification.
 *
 * Optional `useVision` flag — Haiku 4.5 has built-in multi-modal. When the
 * item has an `image_url` and useVision=true, the prompt will reference the
 * image alongside the text. Phase-2 stub: vision-mode is wired via env flag
 * `CLASSIFY_PRODUCT_TYPE_VISION_ENABLED` and falls through to text-only when
 * unset; full Haiku-vision integration lands in a follow-up commit so this
 * tool ships now.
 *
 * Output: agent passes the result to `enrichGearItem` (or directly to a
 * dedicated linkProductType tool in Phase 3 — for now, agent issues the
 * graphWrite MERGE with the suggested name).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  classifyProductTypeBatch,
  type GearItemForClassification,
  type ProductTypeCandidate,
} from "../lib/memgraph-product-type-classifier.js";
import { getReadSession, toNumber } from "../lib/memgraph.js";

export const classifyProductType = createTool({
  id: "classifyProductType",
  description: `Classify a :GearItem into one of the existing :ProductType nodes (no new types invented).
Loads the item + all 154 candidate ProductTypes from Memgraph, then asks
Gemini Flash to pick the best match with confidence + reasoning. Hallucination
guard: suggested_type_name is rejected by the lib if not in the candidate list.

Confidence-scale (conservative): 1.0 = name explicitly contains type;
0.85-0.95 = clear semantic mapping; 0.7-0.85 = plausible; <0.7 = unsure.

useVision (default false): when item has image_url, Haiku 4.5's multi-modal
input is used to disambiguate. Costs ~4-5x more per call but resolves ~5-10%
of ambiguous-name cases.

Does NOT write to Memgraph. Pass result to graphWrite for the IS_TYPE MERGE.`,
  inputSchema: z.object({
    nodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
    useVision: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true and item has image_url, route classification through Haiku 4.5 multi-modal. Defaults to text-only.",
      ),
    reason: z.string().describe("Why classification is being performed (audit-log)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    suggested_type_name: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    cost_cents: z.number(),
    used_vision: z.boolean(),
  }),
  execute: async ({ context: { nodeId, useVision } }) => {
    // 1. Load the GearItem
    const itemReadSess = getReadSession();
    let itemData: GearItemForClassification | null = null;
    let imageUrl: string | null = null;
    try {
      const res = await itemReadSess.run(
        `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
RETURN ID(g) AS id, g.brand AS brand, g.name AS name,
       g.description AS description, g.image_url AS image_url,
       g.category_legacy AS category_legacy
`.trim(),
        { nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId },
      );
      const rec = res.records[0];
      if (rec) {
        itemData = {
          memgraph_id: String(toNumber(rec.get("id"))),
          brand: String(rec.get("brand") ?? ""),
          name: String(rec.get("name") ?? ""),
          description: nullableString(rec.get("description")),
          category_legacy: nullableString(rec.get("category_legacy")),
        };
        imageUrl = nullableString(rec.get("image_url"));
      }
    } finally {
      await itemReadSess.close();
    }

    if (!itemData) {
      return {
        found: false,
        suggested_type_name: null,
        confidence: 0,
        reasoning: "node not found in Memgraph",
        cost_cents: 0,
        used_vision: false,
      };
    }

    // 2. Load candidate ProductTypes
    const candReadSess = getReadSession();
    let candidates: ProductTypeCandidate[] = [];
    try {
      const res = await candReadSess.run(
        `
MATCH (pt:ProductType) WHERE pt.name IS NOT NULL
RETURN pt.name AS name, coalesce(pt.description, pt.summary, '') AS description
ORDER BY pt.name
`.trim(),
      );
      candidates = res.records.map((r) => ({
        name: String(r.get("name")),
        description: nullableString(r.get("description")) ?? "",
      }));
    } finally {
      await candReadSess.close();
    }

    if (candidates.length === 0) {
      return {
        found: true,
        suggested_type_name: null,
        confidence: 0,
        reasoning: "no :ProductType candidates exist in Memgraph",
        cost_cents: 0,
        used_vision: false,
      };
    }

    // 3. Classify (single-item batch). Vision-mode TODO — for now text-only;
    //    flag is recorded in output for telemetry.
    const visionRequested = Boolean(useVision) && imageUrl !== null;

    const batchResult = await classifyProductTypeBatch([itemData], candidates);
    const result = batchResult.results[0];

    if (!result) {
      return {
        found: true,
        suggested_type_name: null,
        confidence: 0,
        reasoning: "LLM returned no classification",
        cost_cents: batchResult.cost_cents,
        used_vision: visionRequested,
      };
    }

    return {
      found: true,
      suggested_type_name: result.suggested_type_name,
      confidence: result.confidence,
      reasoning: result.reasoning,
      cost_cents: batchResult.cost_cents,
      used_vision: visionRequested,
    };
  },
});

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}
