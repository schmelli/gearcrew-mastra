/**
 * getEnrichmentGaps — agent self-awareness tool
 *
 * Returns the structured gap inventory for one specific :GearItem so the
 * Gardener-Haiku agent can decide WHAT to enrich before WHICH research
 * strategy to apply. Cooldown is intentionally ignored — the agent already
 * decided to ask about this item; cooldown filtering is a sweeper-side concern.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { detectGapsForItem } from "../lib/gap-detector.js";

export const getEnrichmentGaps = createTool({
  id: "getEnrichmentGaps",
  description: `Inspect a :GearItem and return its current enrichment gap inventory.
Use this BEFORE deciding what to enrich. Returns:
  - gaps: array of missing/stale targets (e.g. ['weight_grams','image_url'])
  - priority_score: composite score reflecting top-50 boost + gap severity + freshness
  - is_top50_brand: whether the item's brand is on the canonical Top-50 list
Possible gap targets:
  product_url | image_url | weight_grams | product_type | product_family |
  description | insights | stale_verification | successor_check`,
  inputSchema: z.object({
    nodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    memgraph_node_id: z.string().nullable(),
    gear_id: z.string().nullable(),
    brand: z.string().nullable(),
    name: z.string().nullable(),
    gaps: z.array(z.string()),
    priority_score: z.number(),
    is_top50_brand: z.boolean(),
  }),
  execute: async ({ context: { nodeId } }) => {
    const result = await detectGapsForItem(nodeId);
    if (!result) {
      return {
        found: false,
        memgraph_node_id: null,
        gear_id: null,
        brand: null,
        name: null,
        gaps: [],
        priority_score: 0,
        is_top50_brand: false,
      };
    }
    return {
      found: true,
      memgraph_node_id: result.memgraph_node_id,
      gear_id: result.gear_id,
      brand: result.brand,
      name: result.name,
      gaps: result.gaps,
      priority_score: result.priority_score,
      is_top50_brand: result.is_top50_brand,
    };
  },
});
