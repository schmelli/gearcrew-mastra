/**
 * enrichGearItemWeight — multi-stage weight extractor as agent tool
 *
 * Wraps `lib/enrichment-extractors.ts::fetchProductWeight` which runs the
 * 5-stage pipeline:
 *   1. Static fetch + JSON-LD Product schema (schema.org QuantitativeValue)
 *   2. additionalProperty Weight in JSON-LD
 *   3. <dt>Weight</dt><dd>... or <th>...<td> definition-list pattern
 *   4. "Weight: X" label-pattern in body text
 *   5. Firecrawl fallback (rendered HTML for JS-blocked / Cloudflare sites)
 *   6. LLM body-prose extraction (final fallback for unstructured text)
 *
 * Returns the extracted weight + source + confidence so the agent can pass
 * them to `enrichGearItem` for the actual write. Does NOT write to Memgraph
 * itself — keeps the Schreib-Disziplin centralized.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchProductWeight } from "../lib/enrichment-extractors.js";

export const enrichGearItemWeight = createTool({
  id: "enrichGearItemWeight",
  description: `Extract product weight in grams from a manufacturer/retailer URL.
Runs a 5-stage extraction chain: JSON-LD Product schema → additionalProperty
→ DL/TR pattern → "Weight: X" label pattern → Firecrawl rendered HTML → LLM
body-prose. Returns weight_grams + source + confidence; does NOT write to
Memgraph. Use enrichGearItem to persist the value.

Conservative range guard: rejects values outside [1g, 50000g] so shipping/dim
weights don't pollute the graph.`,
  inputSchema: z.object({
    productUrl: z.string().url().describe("Manufacturer or retailer product page URL"),
    reason: z.string().describe("Why weight is being fetched (audit-log)"),
  }),
  outputSchema: z.object({
    weight_grams: z.number().nullable(),
    source: z.string().nullable(),
    confidence: z.enum(["deterministic", "llm"]).nullable(),
    raw_text: z.string().optional(),
    error: z.string().optional(),
    suggested_confidence: z.number().min(0).max(1),
  }),
  execute: async ({ context: { productUrl } }) => {
    const result = await fetchProductWeight(productUrl);
    // Map deterministic→0.95, llm→0.75 as default suggestion. Agent can override.
    const suggested =
      result.confidence === "deterministic"
        ? 0.95
        : result.confidence === "llm"
          ? 0.75
          : 0;
    return {
      weight_grams: result.weight_grams,
      source: result.source,
      confidence: result.confidence ?? null,
      raw_text: result.raw_text,
      error: result.error,
      suggested_confidence: suggested,
    };
  },
});
