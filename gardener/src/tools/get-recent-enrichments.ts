/**
 * getRecentEnrichments — cooldown-check tool to prevent enrichment loops
 *
 * Before working on a target the Gardener-Haiku agent should check if that
 * target was recently enriched (within 7d on top-50 items, 30d on long-tail)
 * or marked abandoned (3+ failures). The tool exposes per-target attempt
 * timestamps + cooldown booleans so the agent can short-circuit without
 * burning tokens on already-fresh data.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getRecentEnrichments as getRecentEnrichmentsFromLib,
  COOLDOWN_TARGETS,
} from "../lib/cooldown-tracker.js";

const targetEnum = z.enum(COOLDOWN_TARGETS);

export const getRecentEnrichments = createTool({
  id: "getRecentEnrichments",
  description: `Check enrichment cooldown status for a :GearItem across all targets.
Returns per-target attempt counters, last attempt/discovery timestamps, error
messages, and an `+"`in_cooldown`"+` boolean derived from the canonical cooldown
windows (7d top-50, 30d long-tail) and abandoned backoff (30d after 3+ fails).

Use BEFORE working on a target — if `+"`in_cooldown=true`"+` for that target,
skip and pick another gap.`,
  inputSchema: z.object({
    nodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    memgraph_node_id: z.string().nullable(),
    is_top50_brand: z.boolean(),
    last_enriched_at: z.string().nullable(),
    per_target: z.array(
      z.object({
        target: targetEnum,
        attempt_count: z.number(),
        last_attempted_at: z.string().nullable(),
        last_error: z.string().nullable(),
        discovered_at: z.string().nullable(),
        abandoned_at: z.string().nullable(),
        in_cooldown: z.boolean(),
        cooldown_reason: z.string().nullable(),
      }),
    ),
  }),
  execute: async ({ context: { nodeId } }) => {
    const result = await getRecentEnrichmentsFromLib(nodeId);
    if (!result) {
      return {
        found: false,
        memgraph_node_id: null,
        is_top50_brand: false,
        last_enriched_at: null,
        per_target: [],
      };
    }
    return {
      found: true,
      memgraph_node_id: result.memgraph_node_id,
      is_top50_brand: result.is_top50_brand,
      last_enriched_at: result.last_enriched_at,
      per_target: result.per_target,
    };
  },
});
