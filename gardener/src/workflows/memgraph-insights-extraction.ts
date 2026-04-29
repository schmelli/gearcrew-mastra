/**
 * Memgraph-native Insights Extraction Workflow.
 *
 * Companion to enrichmentPremium target=insights, but operates on the
 * Memgraph-only GearItems (no Supabase row) — i.e. items with EXTRACTED_FROM
 * edges to VideoSources but NOT yet bridged via supabase_id.
 *
 * Pipeline per item:
 *   1. Find candidates: (g:GearItem)-[:EXTRACTED_FROM]->(v:VideoSource)
 *      with usable transcripts AND no existing :HAS_INSIGHT edge.
 *   2. Per item, call Gemini Flash on top-N transcripts and merge
 *      :ProductInsight + :HAS_INSIGHT + :DERIVED_FROM edges into Memgraph.
 *
 * Cost cap: aborts when totalCostCents >= maxCostCents.
 * Idempotent: re-runs skip already-:HAS_INSIGHT items via candidate filter.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import {
  extractInsightsForNodeId,
  fetchCandidateItems,
  type MemgraphInsightsExtractResult,
} from "../lib/memgraph-insights-extractor.js";

const triggerSchema = z.object({
  limit: z.number().int().positive().default(100),
  dryRun: z.boolean().default(false),
  maxCostCents: z.number().int().positive().default(2000),
});

const candidateSampleSchema = z.object({
  node_id: z.number(),
  brand: z.string().nullable(),
  name: z.string(),
});

const sampleResultSchema = z.object({
  node_id: z.number(),
  brand: z.string().nullable(),
  name: z.string(),
  videos_examined: z.number(),
  insights_created: z.number(),
  insights_existing: z.number(),
  cost_cents: z.number(),
  skipped: z.boolean(),
  skip_reason: z.string().optional(),
});

const outputSchema = z.object({
  total_candidates: z.number(),
  items_processed: z.number(),
  items_skipped: z.number(),
  total_insights_created: z.number(),
  total_insights_existing: z.number(),
  total_cost_cents: z.number(),
  total_input_tokens: z.number(),
  total_output_tokens: z.number(),
  aborted_cost_cap: z.boolean(),
  dry_run: z.boolean(),
  candidate_samples: z.array(candidateSampleSchema),
  result_samples: z.array(sampleResultSchema),
});

const extractStep = createStep({
  id: "memgraph-insights-extraction",
  description:
    "Extract :ProductInsight nodes for Memgraph-only GearItems with video transcripts but no :HAS_INSIGHT yet",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    // 1. Candidates: GearItems with usable transcripts + no insights yet.
    const candidates = await fetchCandidateItems(inputData.limit);

    console.log(
      `[memgraph-insights] ${candidates.length} candidates (limit=${inputData.limit}), dryRun=${inputData.dryRun}, maxCostCents=${inputData.maxCostCents}`,
    );

    if (inputData.dryRun || candidates.length === 0) {
      return {
        total_candidates: candidates.length,
        items_processed: 0,
        items_skipped: 0,
        total_insights_created: 0,
        total_insights_existing: 0,
        total_cost_cents: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        aborted_cost_cap: false,
        dry_run: inputData.dryRun,
        candidate_samples: candidates.slice(0, 20),
        result_samples: [],
      };
    }

    // 2. Process candidates with cost-cap abort.
    let processed = 0;
    let skipped = 0;
    let totalCreated = 0;
    let totalExisting = 0;
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let abortedCostCap = false;
    const resultSamples: Array<z.infer<typeof sampleResultSchema>> = [];

    for (let i = 0; i < candidates.length; i += 1) {
      if (totalCost >= inputData.maxCostCents) {
        console.warn(
          `[memgraph-insights] cost-cap hit (${totalCost} >= ${inputData.maxCostCents}) — aborting at item ${i + 1}/${candidates.length}`,
        );
        abortedCostCap = true;
        break;
      }

      const item = candidates[i]!;
      const tag = `[${i + 1}/${candidates.length}] ${item.brand ?? "?"}/${item.name.slice(0, 30)}`;
      let result: MemgraphInsightsExtractResult;
      try {
        result = await extractInsightsForNodeId(item);
      } catch (err) {
        console.error(
          `${tag}: ✗ extractor failed`,
          err instanceof Error ? err.message : err,
        );
        skipped += 1;
        continue;
      }

      totalCreated += result.insights_created;
      totalExisting += result.insights_existing;
      totalCost += result.cost_cents;
      totalIn += result.input_tokens;
      totalOut += result.output_tokens;

      if (result.skipped) {
        skipped += 1;
        console.log(`${tag}: skipped (${result.skip_reason ?? "unknown"})`);
      } else {
        processed += 1;
        console.log(
          `${tag}: ✓ ${result.videos_examined} videos → +${result.insights_created} new / ${result.insights_existing} dup (${result.cost_cents}¢)`,
        );
      }

      if (resultSamples.length < 20) {
        resultSamples.push({
          node_id: item.node_id,
          brand: item.brand,
          name: item.name,
          videos_examined: result.videos_examined,
          insights_created: result.insights_created,
          insights_existing: result.insights_existing,
          cost_cents: result.cost_cents,
          skipped: result.skipped,
          skip_reason: result.skip_reason,
        });
      }
    }

    console.log(
      `[memgraph-insights] done processed=${processed} skipped=${skipped} insights_created=${totalCreated} insights_existing=${totalExisting} cost_cents=${totalCost} aborted_cost_cap=${abortedCostCap}`,
    );

    return {
      total_candidates: candidates.length,
      items_processed: processed,
      items_skipped: skipped,
      total_insights_created: totalCreated,
      total_insights_existing: totalExisting,
      total_cost_cents: totalCost,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      aborted_cost_cap: abortedCostCap,
      dry_run: false,
      candidate_samples: candidates.slice(0, 20),
      result_samples: resultSamples,
    };
  },
});

export const memgraphInsightsExtraction = createWorkflow({
  id: "memgraphInsightsExtraction",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(extractStep)
  .commit();
