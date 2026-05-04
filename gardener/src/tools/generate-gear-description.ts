/**
 * generateGearDescription — Gemini Flash 200-400 word description generator
 *
 * Wraps `lib/description-generator.ts::generateDescriptionWithGemini` with
 * a Memgraph-aware front. Loads the :GearItem context from Memgraph,
 * applies the skip-if-good heuristic (existing description ≥200 chars),
 * generates a fresh description via Gemini Flash if needed, and returns
 * the result. Does NOT write — caller passes to `enrichGearItem` with
 * target='description'.
 *
 * Cost: ~1¢ per generation (Gemini Flash, ~3k input + ~600 output tokens).
 * Skipped if existing description is already long enough.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getReadSession, toNumber } from "../lib/memgraph.js";
import {
  generateDescriptionWithGemini,
  type DescriptionInputItem,
} from "../lib/description-generator.js";

export const generateGearDescription = createTool({
  id: "generateGearDescription",
  description: `Generate a 200-400-word English description for a :GearItem via Gemini Flash.
Loads item context (brand, name, weight, category, existing description, etc.)
from Memgraph, then runs the skip-if-good heuristic (existing description
≥200 chars triggers skip). Returns the generated description + cost.

Does NOT write to Memgraph. Pass result to enrichGearItem with
target='description'. Suggested confidence is 0.85 (high, but agent can
adjust if the source data was thin).`,
  inputSchema: z.object({
    nodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Skip the existing-description-good heuristic and regenerate"),
    reason: z.string().describe("Why a description is being generated (audit-log)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    description: z.string().nullable(),
    word_count: z.number().nullable(),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
    cost_cents: z.number(),
    suggested_confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
  }),
  execute: async ({ context: { nodeId, force } }) => {
    // 1. Load item context from Memgraph
    const session = getReadSession();
    let input: DescriptionInputItem | null = null;
    try {
      const res = await session.run(
        `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
OPTIONAL MATCH (g)-[:IS_TYPE]->(pt:ProductType)
RETURN
  ID(g) AS id,
  g.name AS name,
  g.brand AS brand,
  g.weight_grams AS weight_grams,
  g.image_url AS primary_image_url,
  g.product_url AS product_url,
  g.description AS existing_description,
  pt.name AS category_label
LIMIT 1
`.trim(),
        { nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId },
      );
      const rec = res.records[0];
      if (rec) {
        input = {
          id: String(toNumber(rec.get("id"))),
          name: String(rec.get("name") ?? ""),
          brand: nullableString(rec.get("brand")),
          weight_grams: nullableNumber(rec.get("weight_grams")),
          primary_image_url: nullableString(rec.get("primary_image_url")),
          product_url: nullableString(rec.get("product_url")),
          existing_description: force ? null : nullableString(rec.get("existing_description")),
          category_label: nullableString(rec.get("category_label")),
        };
      }
    } finally {
      await session.close();
    }

    if (!input) {
      return {
        found: false,
        description: null,
        word_count: null,
        skipped: false,
        cost_cents: 0,
        suggested_confidence: 0,
      };
    }

    // 2. Generate (or skip)
    const result = await generateDescriptionWithGemini(input);

    // Confidence calibration: existing description was already good → skipped
    // (no value to write). Fresh LLM-generation → 0.85 (high but not certain
    // because we can't fact-check the prose without a parallel scrape).
    const suggested = result.skipped ? 0 : 0.85;

    return {
      found: true,
      description: result.description,
      word_count: result.description ? wordCount(result.description) : null,
      skipped: result.skipped,
      skip_reason: result.skip_reason,
      cost_cents: result.cost_cents,
      suggested_confidence: suggested,
      reasoning: result.reasoning,
    };
  },
});

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  return toNumber(value) || null;
}
