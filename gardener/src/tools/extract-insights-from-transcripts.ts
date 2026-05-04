/**
 * extractInsightsFromTranscripts — pull :Insight nodes from VideoSource transcripts
 *
 * Wraps `lib/insights-extractor.ts::extractInsightsForItem` which:
 *   1. Queries Memgraph for VideoSources linked to the item via :EXTRACTED_FROM
 *   2. Skips videos without a usable transcript
 *   3. Per video: Gemini Flash extracts up to 3 insights (text, category, sentiment)
 *   4. MERGEs :Insight nodes + (g)-[:HAS_INSIGHT]->(i) + (i)-[:DERIVED_FROM]->(v)
 *
 * The MERGE handles dedup — already-existing insights are reported as
 * existing rather than created. The whole flow writes Memgraph directly
 * (relationship target, not a property) so the agent doesn't need to call
 * enrichGearItem for it.
 *
 * Cost: ~1¢ per video × max 5 videos = ~5¢ per call.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getReadSession, toNumber } from "../lib/memgraph.js";
import { extractInsightsForItem } from "../lib/insights-extractor.js";

export const extractInsightsFromTranscripts = createTool({
  id: "extractInsightsFromTranscripts",
  description: `Extract :Insight nodes from VideoSource transcripts linked to a :GearItem.
Loads up to 5 videos with transcripts ≥100 chars, asks Gemini Flash to extract
up to 3 high-quality insights per video (categorized as tip|trick|warning|
usage|comparison|alternative), then MERGEs the :Insight nodes + HAS_INSIGHT
+ DERIVED_FROM edges into Memgraph.

Already-existing insights are deduped automatically (counted as 'existing' in
the result rather than 'created'). Skipped if no videos / no transcripts.

Writes directly to Memgraph (relationship-target, not a property write).
Cost: ~1¢/video, capped at 5 videos = ~5¢/call.`,
  inputSchema: z.object({
    nodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
    reason: z.string().describe("Why insights are being extracted (audit-log)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    videos_examined: z.number(),
    insights_created: z.number(),
    insights_existing: z.number(),
    cost_cents: z.number(),
    skipped: z.boolean(),
    skip_reason: z.string().optional(),
    samples: z
      .array(
        z.object({
          video_url: z.string(),
          text: z.string(),
          category: z.string(),
          sentiment: z.string(),
          created: z.boolean(),
        }),
      )
      .max(15),
  }),
  execute: async ({ context: { nodeId } }) => {
    // Step 1: load item identity (the lib reads videos from Memgraph itself)
    const session = getReadSession();
    let itemName: string | null = null;
    let itemBrand: string | null = null;
    try {
      const res = await session.run(
        `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
RETURN ID(g) AS id, g.name AS name, g.brand AS brand LIMIT 1
`.trim(),
        { nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId },
      );
      const rec = res.records[0];
      if (rec) {
        itemName = String(rec.get("name") ?? "");
        itemBrand = nullableString(rec.get("brand"));
      }
    } finally {
      await session.close();
    }

    if (!itemName) {
      return {
        found: false,
        videos_examined: 0,
        insights_created: 0,
        insights_existing: 0,
        cost_cents: 0,
        skipped: true,
        skip_reason: "node_not_found",
        samples: [],
      };
    }

    // Step 2: extract — this lib does its own Memgraph read for videos +
    // writes for insights. Cost-cap is per-video inside the lib.
    const result = await extractInsightsForItem({
      item_id: String(typeof nodeId === "string" ? Number(nodeId) : nodeId),
      item_name: itemName,
      item_brand: itemBrand,
    });

    return {
      found: true,
      videos_examined: result.videos_examined,
      insights_created: result.insights_created,
      insights_existing: result.insights_existing,
      cost_cents: result.cost_cents,
      skipped: result.skipped,
      skip_reason: result.skip_reason,
      samples: result.samples.slice(0, 15),
    };
  },
});

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}
