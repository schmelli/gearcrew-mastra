/**
 * Enrichment-Premium Workflow (enrichmentPremium) — Quick-Task 260428-ke7 (DATA-07)
 *
 * Companion to enrichmentLite. Generates two premium-tier enrichments:
 *
 *   target="description":
 *     - Round-robin candidates from gear_items_round_robin_description RPC.
 *     - Per item: Gemini Flash 200-400 word description from name + brand
 *       + weight + category + (existing description, if any).
 *     - Skip-if-existing-good heuristic short-circuits before LLM call.
 *     - Apply: UPDATE gear_items.description, stamp last_description_enriched_at,
 *       audit-log soft-fail.
 *
 *   target="insights":
 *     - Round-robin candidates via TS-side Top-50/long-tail sort (no RPC).
 *     - Per item: query Memgraph for linked VideoSource transcripts, run
 *       Gemini Flash extraction (max 3 insights/video, max 5 videos/item),
 *       MERGE Insight nodes + HAS_INSIGHT + DERIVED_FROM edges.
 *     - Apply: audit-log entry + touch last_insights_enriched_at. The actual
 *       insight nodes already live in Memgraph after extractor ran.
 *
 *   target="both" (default): description first, then insights.
 *
 * Two modes:
 *   "dry-run" — extract everything, return samples, NO Supabase / Memgraph writes.
 *   "apply"   — extract + write. Per-item cost-cap-abort BEFORE next LLM call.
 *
 * Cost cap: $10 (1000 cents) hard cap by default — premium target is more
 * expensive than enrichment-lite (longer prompts + multi-video insight calls).
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { generateDescriptionWithGemini } from "../lib/description-generator.js";
import { extractInsightsForItem } from "../lib/insights-extractor.js";
import {
  applyDescriptionUpdate,
  recordInsightsAudit,
  touchDescriptionEnrichmentTimestamp,
  touchInsightsEnrichmentTimestamp,
  ensurePremiumWorkflowRunRow,
  recordPremiumRunCost,
  getDescriptionCoverage,
} from "./enrichment-premium-helpers.js";
import {
  fetchItemsForDescriptionEnrichment,
  fetchItemsForInsightsEnrichment,
  type ItemForDescription,
  type ItemForInsights,
} from "./enrichment-premium-roundrobin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COST_CENTS = 1000; // $10 hard cap (premium tier)
const DEFAULT_LIMIT = 50;
const COST_RECORD_EVERY_N_ITEMS = 5;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  target: z.enum(["description", "insights", "both"]).default("both"),
  max_cost_cents: z.number().int().positive().default(DEFAULT_MAX_COST_CENTS),
  limit: z.number().int().positive().default(DEFAULT_LIMIT),
  dry_run_test: z.boolean().default(false),
  // retype_all currently a no-op flag — reserved for a future variant that
  // ignores the skip-if-good heuristic. We accept it for CLI compatibility.
  retype_all: z.boolean().default(false),
});

type TriggerInput = z.infer<typeof triggerSchema>;

const descriptionSampleSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  bucket: z.enum(["generated", "skipped_good", "failed"]),
  word_count: z.number().nullable(),
  cost_cents: z.number(),
  preview: z.string().nullable(),
  reason: z.string().nullable(),
});

const insightsSampleSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  bucket: z.enum(["created", "no_videos", "no_insights", "failed"]),
  videos_examined: z.number(),
  insights_created: z.number(),
  insights_existing: z.number(),
  cost_cents: z.number(),
  reason: z.string().nullable(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  target: z.enum(["description", "insights", "both"]),
  workflow_run_id: z.string(),

  description_items_processed: z.number(),
  descriptions_generated: z.number(),
  descriptions_skipped_good: z.number(),
  descriptions_failed: z.number(),
  description_audit_log_ids: z.array(z.string()),

  insights_items_processed: z.number(),
  insights_total_created: z.number(),
  insights_items_no_videos: z.number(),
  insights_items_no_insights: z.number(),
  insights_items_failed: z.number(),
  insights_audit_log_ids: z.array(z.string()),

  cost_cents_used: z.number(),
  aborted_due_to_cost: z.boolean(),

  description_coverage_before: z.object({
    total: z.number(),
    with_not_null: z.number(),
  }),
  description_coverage_after: z.object({
    total: z.number(),
    with_not_null: z.number(),
  }),

  bilanz_check: z.boolean(),
  sample_descriptions: z.array(descriptionSampleSchema),
  sample_insights: z.array(insightsSampleSchema),
});

type WorkflowOutput = z.infer<typeof outputSchema>;
type DescriptionSample = z.infer<typeof descriptionSampleSchema>;
type InsightsSample = z.infer<typeof insightsSampleSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DescriptionAccumulator {
  processed: number;
  generated: number;
  skipped_good: number;
  failed: number;
  audit_ids: string[];
  samples: DescriptionSample[];
}

interface InsightsAccumulator {
  processed: number;
  created_items: number; // items where >=1 new insight was created
  total_created: number; // sum of insights created across all items
  no_videos: number;
  no_insights: number;
  failed: number;
  audit_ids: string[];
  samples: InsightsSample[];
}

// ---------------------------------------------------------------------------
// Description loop
// ---------------------------------------------------------------------------

async function runDescriptionEnrichment(
  items: ItemForDescription[],
  inputData: TriggerInput,
  workflowRunId: string,
  costRef: { value: number },
): Promise<{ acc: DescriptionAccumulator; aborted: boolean }> {
  const acc: DescriptionAccumulator = {
    processed: 0,
    generated: 0,
    skipped_good: 0,
    failed: 0,
    audit_ids: [],
    samples: [],
  };
  let aborted = false;

  for (const item of items) {
    if (costRef.value > inputData.max_cost_cents) {
      console.warn(
        `[enrichment-premium] DESCRIPTION cost-cap-abort — ${costRef.value}¢ > ${inputData.max_cost_cents}¢`,
      );
      aborted = true;
      break;
    }

    acc.processed += 1;
    let bucket: DescriptionSample["bucket"] = "failed";
    let wordCount: number | null = null;
    let preview: string | null = null;
    let reason: string | null = null;
    let perItemCost = 0;

    try {
      const result = await generateDescriptionWithGemini({
        id: item.id,
        name: item.name,
        brand: item.brand,
        weight_grams: item.weight_grams,
        primary_image_url: item.primary_image_url,
        product_url: item.product_url,
        existing_description: item.description,
        // category_id is a uuid — we don't currently look up category name.
        // Pass null for category_label; the prompt can still produce a sensible
        // description from name+brand. Future task can join categories table.
        category_label: null,
      });
      perItemCost = result.cost_cents;
      costRef.value += result.cost_cents;

      if (result.skipped) {
        bucket = "skipped_good";
        acc.skipped_good += 1;
        reason = result.skip_reason ?? "skipped";
        // Touch cooldown so next batch doesn't re-pick.
        if (inputData.mode === "apply" && !inputData.dry_run_test) {
          await touchDescriptionEnrichmentTimestamp(item.id, workflowRunId);
        }
      } else if (result.description !== null) {
        bucket = "generated";
        acc.generated += 1;
        preview = result.description.slice(0, 200);
        wordCount = result.description.trim().split(/\s+/).filter(Boolean).length;
        if (inputData.mode === "apply" && !inputData.dry_run_test) {
          const apply = await applyDescriptionUpdate(
            item.id,
            item.name,
            result.description,
            workflowRunId,
          );
          if (apply.ok && apply.audit_log_id)
            acc.audit_ids.push(apply.audit_log_id);
          if (!apply.ok) {
            // Demote: counted as failed, not generated.
            acc.generated -= 1;
            acc.failed += 1;
            bucket = "failed";
            reason = `apply_failed: ${apply.reason ?? "unknown"}`;
            // Still touch cooldown so we don't loop on it.
            await touchDescriptionEnrichmentTimestamp(item.id, workflowRunId);
          }
        }
      } else {
        bucket = "failed";
        acc.failed += 1;
        reason = result.skip_reason ?? "no_description_returned";
        if (inputData.mode === "apply" && !inputData.dry_run_test) {
          await touchDescriptionEnrichmentTimestamp(item.id, workflowRunId);
        }
      }
    } catch (err) {
      bucket = "failed";
      acc.failed += 1;
      reason = `extract_threw: ${err instanceof Error ? err.message : String(err)}`;
      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        await touchDescriptionEnrichmentTimestamp(item.id, workflowRunId);
      }
    }

    if (acc.samples.length < 20) {
      acc.samples.push({
        item_id: item.id,
        item_name: item.name,
        bucket,
        word_count: wordCount,
        cost_cents: perItemCost,
        preview,
        reason,
      });
    }

    console.log(
      `[enrichment-premium] DESC ${acc.processed}/${items.length} "${item.name.slice(0, 40)}" → ${bucket}${wordCount !== null ? ` (${wordCount}w)` : ""}${reason ? ` [${reason.slice(0, 80)}]` : ""} cumCost=${costRef.value}¢`,
    );

    if (
      acc.processed % COST_RECORD_EVERY_N_ITEMS === 0 &&
      !inputData.dry_run_test &&
      inputData.mode === "apply"
    ) {
      await recordPremiumRunCost(workflowRunId, costRef.value, {
        phase: "description",
        description_processed: acc.processed,
        description_generated: acc.generated,
        description_skipped_good: acc.skipped_good,
        description_failed: acc.failed,
      });
    }
  }

  return { acc, aborted };
}

// ---------------------------------------------------------------------------
// Insights loop
// ---------------------------------------------------------------------------

async function runInsightsEnrichment(
  items: ItemForInsights[],
  inputData: TriggerInput,
  workflowRunId: string,
  costRef: { value: number },
): Promise<{ acc: InsightsAccumulator; aborted: boolean }> {
  const acc: InsightsAccumulator = {
    processed: 0,
    created_items: 0,
    total_created: 0,
    no_videos: 0,
    no_insights: 0,
    failed: 0,
    audit_ids: [],
    samples: [],
  };
  let aborted = false;

  for (const item of items) {
    if (costRef.value > inputData.max_cost_cents) {
      console.warn(
        `[enrichment-premium] INSIGHTS cost-cap-abort — ${costRef.value}¢ > ${inputData.max_cost_cents}¢`,
      );
      aborted = true;
      break;
    }

    acc.processed += 1;
    let bucket: InsightsSample["bucket"] = "failed";
    let videos = 0;
    let created = 0;
    let existing = 0;
    let perItemCost = 0;
    let reason: string | null = null;

    try {
      const result = await extractInsightsForItem({
        item_id: item.id,
        item_name: item.name,
        item_brand: item.brand,
      });
      perItemCost = result.cost_cents;
      costRef.value += result.cost_cents;
      videos = result.videos_examined;
      created = result.insights_created;
      existing = result.insights_existing;

      if (result.skipped) {
        bucket = "no_videos";
        acc.no_videos += 1;
        reason = result.skip_reason ?? "skipped";
      } else if (created === 0) {
        bucket = "no_insights";
        acc.no_insights += 1;
        reason = "all_insights_already_existed_or_zero_extracted";
      } else {
        bucket = "created";
        acc.created_items += 1;
        acc.total_created += created;
      }

      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        if (created > 0 || existing > 0) {
          const audit = await recordInsightsAudit(
            item.id,
            item.name,
            videos,
            created,
            existing,
            workflowRunId,
          );
          if (audit.ok && audit.audit_log_id)
            acc.audit_ids.push(audit.audit_log_id);
        }
        // Touch cooldown regardless of outcome — the round-robin advances
        // even on no_videos / no_insights so we don't keep re-picking.
        await touchInsightsEnrichmentTimestamp(item.id, workflowRunId);
      }
    } catch (err) {
      bucket = "failed";
      acc.failed += 1;
      reason = `extract_threw: ${err instanceof Error ? err.message : String(err)}`;
      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        await touchInsightsEnrichmentTimestamp(item.id, workflowRunId);
      }
    }

    if (acc.samples.length < 20) {
      acc.samples.push({
        item_id: item.id,
        item_name: item.name,
        bucket,
        videos_examined: videos,
        insights_created: created,
        insights_existing: existing,
        cost_cents: perItemCost,
        reason,
      });
    }

    console.log(
      `[enrichment-premium] INSIGHTS ${acc.processed}/${items.length} "${item.name.slice(0, 40)}" → ${bucket} (videos=${videos}, created=${created}, existing=${existing}) cumCost=${costRef.value}¢`,
    );

    if (
      acc.processed % COST_RECORD_EVERY_N_ITEMS === 0 &&
      !inputData.dry_run_test &&
      inputData.mode === "apply"
    ) {
      await recordPremiumRunCost(workflowRunId, costRef.value, {
        phase: "insights",
        insights_processed: acc.processed,
        insights_created: acc.total_created,
        insights_no_videos: acc.no_videos,
        insights_no_insights: acc.no_insights,
        insights_failed: acc.failed,
      });
    }
  }

  return { acc, aborted };
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

const routeAndExecute = createStep({
  id: "route-and-execute",
  description:
    "Fetch round-robin candidates → Gemini description gen + Memgraph insights extraction → dry-run sample OR apply Supabase + Memgraph writes",
  inputSchema: triggerSchema,
  outputSchema,
  execute: async ({ inputData }): Promise<WorkflowOutput> => {
    const workflow_run_id = randomUUID();
    console.log(
      `[enrichment-premium] start: run_id=${workflow_run_id} mode=${inputData.mode} target=${inputData.target} max_cost_cents=${inputData.max_cost_cents} limit=${inputData.limit} dry_run_test=${inputData.dry_run_test}`,
    );

    if (inputData.mode === "apply" && !inputData.dry_run_test) {
      await ensurePremiumWorkflowRunRow(
        workflow_run_id,
        "enrichment-premium",
        {
          mode: inputData.mode,
          target: inputData.target,
          max_cost_cents: inputData.max_cost_cents,
          limit: inputData.limit,
        },
      );
    }

    const coverageBefore = await getDescriptionCoverage();
    console.log(
      `[enrichment-premium] description coverage BEFORE: total=${coverageBefore.total} not_null=${coverageBefore.withGoodDescription}`,
    );

    const costRef = { value: 0 };
    let aborted = false;

    // --- Description pass ---
    let descAcc: DescriptionAccumulator = {
      processed: 0,
      generated: 0,
      skipped_good: 0,
      failed: 0,
      audit_ids: [],
      samples: [],
    };
    if (
      inputData.target === "description" ||
      inputData.target === "both"
    ) {
      const items = await fetchItemsForDescriptionEnrichment(inputData.limit);
      const out = await runDescriptionEnrichment(
        items,
        inputData,
        workflow_run_id,
        costRef,
      );
      descAcc = out.acc;
      if (out.aborted) aborted = true;
    }

    // --- Insights pass ---
    let insAcc: InsightsAccumulator = {
      processed: 0,
      created_items: 0,
      total_created: 0,
      no_videos: 0,
      no_insights: 0,
      failed: 0,
      audit_ids: [],
      samples: [],
    };
    if (
      !aborted &&
      (inputData.target === "insights" || inputData.target === "both")
    ) {
      const items = await fetchItemsForInsightsEnrichment(inputData.limit);
      const out = await runInsightsEnrichment(
        items,
        inputData,
        workflow_run_id,
        costRef,
      );
      insAcc = out.acc;
      if (out.aborted) aborted = true;
    }

    const coverageAfter = await getDescriptionCoverage();
    console.log(
      `[enrichment-premium] description coverage AFTER: total=${coverageAfter.total} not_null=${coverageAfter.withGoodDescription}`,
    );

    // Bilanz: per-target sums = processed.
    const descBilanz =
      descAcc.generated + descAcc.skipped_good + descAcc.failed ===
      descAcc.processed;
    // Each item lands in exactly one bucket: created_items, no_videos,
    // no_insights, or failed. Sum must equal processed.
    const insBilanz =
      insAcc.created_items +
        insAcc.no_videos +
        insAcc.no_insights +
        insAcc.failed ===
      insAcc.processed;
    const bilanz_check = descBilanz && insBilanz;
    if (!bilanz_check) {
      console.error(
        `[enrichment-premium] BILANZ-FAIL: desc=${descBilanz} (${descAcc.generated}+${descAcc.skipped_good}+${descAcc.failed} vs ${descAcc.processed}) ins=${insBilanz} (no_videos=${insAcc.no_videos} no_insights=${insAcc.no_insights} failed=${insAcc.failed} processed=${insAcc.processed})`,
      );
    }

    if (!inputData.dry_run_test && inputData.mode === "apply") {
      await recordPremiumRunCost(workflow_run_id, costRef.value, {
        mode: inputData.mode,
        target: inputData.target,
        description_processed: descAcc.processed,
        descriptions_generated: descAcc.generated,
        descriptions_skipped_good: descAcc.skipped_good,
        descriptions_failed: descAcc.failed,
        insights_processed: insAcc.processed,
        insights_created_total: insAcc.total_created,
        insights_no_videos: insAcc.no_videos,
        insights_no_insights: insAcc.no_insights,
        insights_failed: insAcc.failed,
        aborted_due_to_cost: aborted,
        status: aborted ? "aborted_cost_cap" : "completed",
      });
    }

    return {
      mode: inputData.mode,
      target: inputData.target,
      workflow_run_id,
      description_items_processed: descAcc.processed,
      descriptions_generated: descAcc.generated,
      descriptions_skipped_good: descAcc.skipped_good,
      descriptions_failed: descAcc.failed,
      description_audit_log_ids: descAcc.audit_ids,
      insights_items_processed: insAcc.processed,
      insights_total_created: insAcc.total_created,
      insights_items_no_videos: insAcc.no_videos,
      insights_items_no_insights: insAcc.no_insights,
      insights_items_failed: insAcc.failed,
      insights_audit_log_ids: insAcc.audit_ids,
      cost_cents_used: costRef.value,
      aborted_due_to_cost: aborted,
      description_coverage_before: {
        total: coverageBefore.total,
        with_not_null: coverageBefore.withGoodDescription,
      },
      description_coverage_after: {
        total: coverageAfter.total,
        with_not_null: coverageAfter.withGoodDescription,
      },
      bilanz_check,
      sample_descriptions: descAcc.samples,
      sample_insights: insAcc.samples,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const enrichmentPremium = createWorkflow({
  id: "enrichmentPremium",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(routeAndExecute)
  .commit();
