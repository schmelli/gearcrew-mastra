/**
 * Enrichment-Lite Workflow (enrichmentLite) — Phase 09 / DATA-05 + DATA-06
 *
 * Scope-reduced combined workflow for GEA-1086 (weight) + GEA-1087 (image).
 * Replaces the original Firecrawl-per-brand-adapter + Cloudinary-upload spec
 * with a minimal Gemini-Flash + og:image fetch flow appropriate for the
 * launch-time data volume (8 missing weights + 11 missing images out of 130).
 *
 * Two modes:
 *
 *   "dry-run":
 *     - Iterate items, attempt extraction (real LLM/HTTP calls — accumulate cost).
 *     - NO Supabase writes for gear_items / audit_log / enrichment_gaps.
 *     - Result returns sample of would-apply rows.
 *     - dry_run_test=true additionally skips gardener_workflow_runs cost-tracking.
 *
 *   "apply":
 *     - Same loop, but writes:
 *       - High-conf weight (≥0.85) → applyWeightUpdate (gear_items + audit_log)
 *       - Failed/low-conf weight → upsertEnrichmentGap (gap_type='weight')
 *       - og:image found → applyImageUpdate (gear_items + audit_log, no Cloudinary)
 *       - No og:image → upsertEnrichmentGap (gap_type='image')
 *     - Per-item cost-cap-abort BEFORE next item when cumCost > max_cost_cents.
 *     - After every Nth item: recordEnrichmentRunCost cost-tracking.
 *
 * Targets: 'weight', 'image', or 'both' (default).
 * Cost cap: $5 (500 cents) hard cap — way under spec's $100 because we skip
 * Firecrawl + Cloudinary entirely.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  extractWeightWithGemini,
  fetchOgImage,
} from "../lib/enrichment-extractors.js";
import {
  fetchItemsMissingWeight,
  fetchItemsMissingImage,
  applyWeightUpdate,
  applyImageUpdate,
  upsertEnrichmentGap,
  ensureWorkflowRunRow,
  recordEnrichmentRunCost,
  getCoverageCounts,
  type ItemForWeight,
  type ItemForImage,
} from "./enrichment-lite-helpers.js";
import {
  fetchItemsForWeightEnrichment,
  fetchItemsForImageEnrichment,
  touchWeightEnrichmentTimestamp,
  touchImageEnrichmentTimestamp,
} from "./enrichment-lite-roundrobin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COST_CENTS = 500; // $5 hard cap (scope-reduced)
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85; // GEA-1086 spec
const DEFAULT_LIMIT = 200; // safety guard
const DEFAULT_INTER_REQUEST_DELAY_MS = 500; // og:image fetch politeness
const COST_RECORD_EVERY_N_ITEMS = 5;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  target: z.enum(["weight", "image", "both"]).default("both"),
  max_cost_cents: z.number().int().positive().default(DEFAULT_MAX_COST_CENTS),
  confidence_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_CONFIDENCE_THRESHOLD),
  limit: z.number().int().positive().default(DEFAULT_LIMIT),
  inter_request_delay_ms: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_INTER_REQUEST_DELAY_MS),
  dry_run_test: z.boolean().default(false),
  // Round-robin (quick-260428-jux): "roundrobin" (default) prioritizes Top-50
  // brands first and respects per-type cooldowns (7d Top-50 / 30d long-tail).
  // "missing-only" preserves the original launch-flow behavior (re-pick any
  // item with NULL target field on every run) for back-compat manual triggers.
  selection_strategy: z
    .enum(["roundrobin", "missing-only"])
    .default("roundrobin"),
});

const sampleWeightSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  weight_grams: z.number().nullable(),
  confidence: z.number(),
  reasoning: z.string(),
  bucket: z.enum(["confident", "low_conf", "failed"]),
});

const sampleImageSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  product_url: z.string().nullable(),
  image_url: z.string().nullable(),
  source: z.string().nullable(),
  bucket: z.enum(["found", "no_url", "no_og_image", "fetch_error"]),
  error: z.string().optional(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  target: z.enum(["weight", "image", "both"]),
  workflow_run_id: z.string(),
  // Weight
  weight_items_processed: z.number(),
  weights_extracted_confident: z.number(),
  weight_low_conf: z.number(),
  weight_failed: z.number(),
  weight_gaps_recorded: z.number(),
  weight_audit_log_ids: z.array(z.string()),
  // Image
  image_items_processed: z.number(),
  images_extracted: z.number(),
  image_failed: z.number(),
  image_gaps_recorded: z.number(),
  image_audit_log_ids: z.array(z.string()),
  // Aggregate
  cost_cents_used: z.number(),
  aborted_due_to_cost: z.boolean(),
  coverage_before: z.object({
    total: z.number(),
    weight_pct: z.number(),
    image_pct: z.number(),
  }),
  coverage_after: z.object({
    total: z.number(),
    weight_pct: z.number(),
    image_pct: z.number(),
  }),
  bilanz_check: z.boolean(),
  sample_weights: z.array(sampleWeightSchema),
  sample_images: z.array(sampleImageSchema),
});

type WorkflowOutput = z.infer<typeof outputSchema>;
type SampleWeight = z.infer<typeof sampleWeightSchema>;
type SampleImage = z.infer<typeof sampleImageSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator * 1000.0) / denominator) / 10;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

interface WeightAccumulator {
  processed: number;
  confident: number;
  low_conf: number;
  failed: number;
  gaps: number;
  audit_ids: string[];
  samples: SampleWeight[];
}

interface ImageAccumulator {
  processed: number;
  extracted: number;
  failed: number;
  gaps: number;
  audit_ids: string[];
  samples: SampleImage[];
}

// ---------------------------------------------------------------------------
// Weight loop
// ---------------------------------------------------------------------------

async function runWeightEnrichment(
  items: ItemForWeight[],
  inputData: z.infer<typeof triggerSchema>,
  workflowRunId: string,
  costRef: { value: number },
): Promise<{ acc: WeightAccumulator; aborted: boolean }> {
  const acc: WeightAccumulator = {
    processed: 0,
    confident: 0,
    low_conf: 0,
    failed: 0,
    gaps: 0,
    audit_ids: [],
    samples: [],
  };
  let aborted = false;

  for (const item of items) {
    if (costRef.value > inputData.max_cost_cents) {
      console.warn(
        `[enrichment-lite] WEIGHT cost-cap-abort — ${costRef.value}¢ > ${inputData.max_cost_cents}¢`,
      );
      aborted = true;
      break;
    }

    acc.processed += 1;
    let bucket: SampleWeight["bucket"] = "failed";
    let weightGrams: number | null = null;
    let confidence = 0;
    let reasoning = "";

    try {
      const result = await extractWeightWithGemini(item);
      costRef.value += result.cost_cents;
      weightGrams = result.weight_grams;
      confidence = result.confidence;
      reasoning = result.reasoning;
    } catch (err) {
      reasoning = `extract_threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (
      weightGrams !== null &&
      confidence >= inputData.confidence_threshold
    ) {
      bucket = "confident";
      acc.confident += 1;
      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        const res = await applyWeightUpdate(
          item.id,
          item.name,
          weightGrams,
          confidence,
          reasoning,
          workflowRunId,
        );
        if (res.ok && res.audit_log_id) acc.audit_ids.push(res.audit_log_id);
        if (!res.ok) {
          acc.failed += 1;
          acc.confident -= 1;
          bucket = "failed";
          reasoning = `apply_failed: ${res.reason ?? "unknown"} (orig: ${reasoning.slice(0, 80)})`;
        }
      }
    } else if (weightGrams !== null) {
      bucket = "low_conf";
      acc.low_conf += 1;
      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        const gap = await upsertEnrichmentGap(
          item.id,
          "weight",
          `low_confidence_${confidence.toFixed(2)}: ${reasoning.slice(0, 200)}`,
          workflowRunId,
        );
        if (gap.ok) acc.gaps += 1;
        // Round-robin (quick-260428-jux): advance cooldown so next batch
        // does not immediately re-pick this item.
        await touchWeightEnrichmentTimestamp(item.id, workflowRunId);
      }
    } else {
      bucket = "failed";
      acc.failed += 1;
      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        const gap = await upsertEnrichmentGap(
          item.id,
          "weight",
          reasoning.slice(0, 200) || "no_extraction",
          workflowRunId,
        );
        if (gap.ok) acc.gaps += 1;
        await touchWeightEnrichmentTimestamp(item.id, workflowRunId);
      }
    }

    if (acc.samples.length < 20) {
      acc.samples.push({
        item_id: item.id,
        item_name: item.name,
        weight_grams: weightGrams,
        confidence,
        reasoning: reasoning.slice(0, 200),
        bucket,
      });
    }

    console.log(
      `[enrichment-lite] WEIGHT ${acc.processed}/${items.length} "${item.name.slice(0, 40)}" → ${bucket} (${weightGrams ?? "null"}g, conf=${confidence.toFixed(2)}, cumCost=${costRef.value}¢)`,
    );

    if (
      acc.processed % COST_RECORD_EVERY_N_ITEMS === 0 &&
      !inputData.dry_run_test
    ) {
      await recordEnrichmentRunCost(workflowRunId, costRef.value, {
        phase: "weight",
        weight_processed: acc.processed,
        weight_confident: acc.confident,
        weight_low_conf: acc.low_conf,
        weight_failed: acc.failed,
      });
    }
  }

  return { acc, aborted };
}

// ---------------------------------------------------------------------------
// Image loop
// ---------------------------------------------------------------------------

async function runImageEnrichment(
  items: ItemForImage[],
  inputData: z.infer<typeof triggerSchema>,
  workflowRunId: string,
  costRef: { value: number },
): Promise<{ acc: ImageAccumulator; aborted: boolean }> {
  const acc: ImageAccumulator = {
    processed: 0,
    extracted: 0,
    failed: 0,
    gaps: 0,
    audit_ids: [],
    samples: [],
  };
  let aborted = false;

  for (const item of items) {
    if (costRef.value > inputData.max_cost_cents) {
      console.warn(
        `[enrichment-lite] IMAGE cost-cap-abort — ${costRef.value}¢ > ${inputData.max_cost_cents}¢`,
      );
      aborted = true;
      break;
    }

    acc.processed += 1;
    let bucket: SampleImage["bucket"] = "no_url";
    let imageUrl: string | null = null;
    let source: string | null = null;
    let errorReason: string | undefined;

    if (!item.product_url) {
      bucket = "no_url";
      acc.failed += 1;
      if (inputData.mode === "apply" && !inputData.dry_run_test) {
        const gap = await upsertEnrichmentGap(
          item.id,
          "image",
          "no_product_url",
          workflowRunId,
        );
        if (gap.ok) acc.gaps += 1;
        // Round-robin (quick-260428-jux): advance cooldown.
        await touchImageEnrichmentTimestamp(item.id, workflowRunId);
      }
    } else {
      const result = await fetchOgImage(item.product_url);
      // og:image fetch is not metered — cost stays 0 for image-only items
      if (result.image_url) {
        bucket = "found";
        imageUrl = result.image_url;
        source = result.source;
        if (inputData.mode === "apply" && !inputData.dry_run_test) {
          const upd = await applyImageUpdate(
            item.id,
            item.name,
            result.image_url,
            item.product_url,
            result.source ?? "og:image",
            workflowRunId,
          );
          if (upd.ok) {
            acc.extracted += 1;
            if (upd.audit_log_id) acc.audit_ids.push(upd.audit_log_id);
          } else {
            acc.failed += 1;
            bucket = "fetch_error";
            errorReason = `apply_failed: ${upd.reason ?? "unknown"}`;
          }
        } else {
          acc.extracted += 1;
        }
      } else {
        bucket =
          result.error?.startsWith("http_") ||
          result.error?.startsWith("fetch_failed")
            ? "fetch_error"
            : "no_og_image";
        acc.failed += 1;
        errorReason = result.error;
        if (inputData.mode === "apply" && !inputData.dry_run_test) {
          const gap = await upsertEnrichmentGap(
            item.id,
            "image",
            result.error ?? "no_og_image_found",
            workflowRunId,
          );
          if (gap.ok) acc.gaps += 1;
          // Round-robin (quick-260428-jux): advance cooldown.
          await touchImageEnrichmentTimestamp(item.id, workflowRunId);
        }
      }
    }

    if (acc.samples.length < 20) {
      acc.samples.push({
        item_id: item.id,
        item_name: item.name,
        product_url: item.product_url,
        image_url: imageUrl,
        source,
        bucket,
        ...(errorReason ? { error: errorReason } : {}),
      });
    }

    console.log(
      `[enrichment-lite] IMAGE ${acc.processed}/${items.length} "${item.name.slice(0, 40)}" → ${bucket}${imageUrl ? ` (${source})` : ""}${errorReason ? ` [${errorReason}]` : ""}`,
    );

    if (item.product_url && acc.processed < items.length) {
      await delay(inputData.inter_request_delay_ms);
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
    "Fetch missing-weight + missing-image items → Gemini-extract weight + og:image fetch → dry-run sample OR apply Supabase writes",
  inputSchema: triggerSchema,
  outputSchema,
  execute: async ({ inputData }): Promise<WorkflowOutput> => {
    const workflow_run_id = randomUUID();
    console.log(
      `[enrichment-lite] start: run_id=${workflow_run_id} mode=${inputData.mode} target=${inputData.target} max_cost_cents=${inputData.max_cost_cents} limit=${inputData.limit} dry_run_test=${inputData.dry_run_test}`,
    );

    // Pre-create the gardener_workflow_runs row so subsequent FK references
    // from graph_audit_log.workflow_run_id and enrichment_gaps.last_workflow_run_id
    // resolve. Skip for dry-run-test (offline) and dry-run (no writes).
    if (inputData.mode === "apply" && !inputData.dry_run_test) {
      await ensureWorkflowRunRow(workflow_run_id, "enrichment-lite", {
        mode: inputData.mode,
        target: inputData.target,
        max_cost_cents: inputData.max_cost_cents,
        confidence_threshold: inputData.confidence_threshold,
        limit: inputData.limit,
      });
    }

    // Coverage before
    const coverageBefore = await getCoverageCounts();
    console.log(
      `[enrichment-lite] coverage BEFORE: total=${coverageBefore.total} weight=${coverageBefore.withWeight} (${pct(coverageBefore.withWeight, coverageBefore.total)}%) image=${coverageBefore.withImage} (${pct(coverageBefore.withImage, coverageBefore.total)}%)`,
    );

    const costRef = { value: 0 };
    let aborted = false;

    // Weight pass
    let weightAcc: WeightAccumulator = {
      processed: 0,
      confident: 0,
      low_conf: 0,
      failed: 0,
      gaps: 0,
      audit_ids: [],
      samples: [],
    };
    if (inputData.target === "weight" || inputData.target === "both") {
      const items =
        inputData.selection_strategy === "roundrobin"
          ? await fetchItemsForWeightEnrichment(inputData.limit)
          : await fetchItemsMissingWeight(inputData.limit);
      const out = await runWeightEnrichment(
        items,
        inputData,
        workflow_run_id,
        costRef,
      );
      weightAcc = out.acc;
      if (out.aborted) aborted = true;
    }

    // Image pass
    let imageAcc: ImageAccumulator = {
      processed: 0,
      extracted: 0,
      failed: 0,
      gaps: 0,
      audit_ids: [],
      samples: [],
    };
    if (
      !aborted &&
      (inputData.target === "image" || inputData.target === "both")
    ) {
      const items =
        inputData.selection_strategy === "roundrobin"
          ? await fetchItemsForImageEnrichment(inputData.limit)
          : await fetchItemsMissingImage(inputData.limit);
      const out = await runImageEnrichment(
        items,
        inputData,
        workflow_run_id,
        costRef,
      );
      imageAcc = out.acc;
      if (out.aborted) aborted = true;
    }

    // Coverage after
    const coverageAfter = await getCoverageCounts();
    console.log(
      `[enrichment-lite] coverage AFTER: total=${coverageAfter.total} weight=${coverageAfter.withWeight} (${pct(coverageAfter.withWeight, coverageAfter.total)}%) image=${coverageAfter.withImage} (${pct(coverageAfter.withImage, coverageAfter.total)}%)`,
    );

    // Bilanz: per-target sums must equal processed.
    const weightBilanz =
      weightAcc.confident + weightAcc.low_conf + weightAcc.failed ===
      weightAcc.processed;
    const imageBilanz =
      imageAcc.extracted + imageAcc.failed === imageAcc.processed;
    const bilanz_check = weightBilanz && imageBilanz;
    if (!bilanz_check) {
      console.error(
        `[enrichment-lite] BILANZ-FAIL: weight=${weightBilanz} (${weightAcc.confident}+${weightAcc.low_conf}+${weightAcc.failed} vs ${weightAcc.processed}) image=${imageBilanz} (${imageAcc.extracted}+${imageAcc.failed} vs ${imageAcc.processed})`,
      );
    }

    // Final cost-record
    if (!inputData.dry_run_test) {
      await recordEnrichmentRunCost(workflow_run_id, costRef.value, {
        mode: inputData.mode,
        target: inputData.target,
        weight_processed: weightAcc.processed,
        weight_confident: weightAcc.confident,
        weight_low_conf: weightAcc.low_conf,
        weight_failed: weightAcc.failed,
        weight_gaps: weightAcc.gaps,
        image_processed: imageAcc.processed,
        images_extracted: imageAcc.extracted,
        image_failed: imageAcc.failed,
        image_gaps: imageAcc.gaps,
        aborted_due_to_cost: aborted,
        status: aborted ? "aborted_cost_cap" : "completed",
      });
    }

    return {
      mode: inputData.mode,
      target: inputData.target,
      workflow_run_id,
      weight_items_processed: weightAcc.processed,
      weights_extracted_confident: weightAcc.confident,
      weight_low_conf: weightAcc.low_conf,
      weight_failed: weightAcc.failed,
      weight_gaps_recorded: weightAcc.gaps,
      weight_audit_log_ids: weightAcc.audit_ids,
      image_items_processed: imageAcc.processed,
      images_extracted: imageAcc.extracted,
      image_failed: imageAcc.failed,
      image_gaps_recorded: imageAcc.gaps,
      image_audit_log_ids: imageAcc.audit_ids,
      cost_cents_used: costRef.value,
      aborted_due_to_cost: aborted,
      coverage_before: {
        total: coverageBefore.total,
        weight_pct: pct(coverageBefore.withWeight, coverageBefore.total),
        image_pct: pct(coverageBefore.withImage, coverageBefore.total),
      },
      coverage_after: {
        total: coverageAfter.total,
        weight_pct: pct(coverageAfter.withWeight, coverageAfter.total),
        image_pct: pct(coverageAfter.withImage, coverageAfter.total),
      },
      bilanz_check,
      sample_weights: weightAcc.samples,
      sample_images: imageAcc.samples,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const enrichmentLite = createWorkflow({
  id: "enrichmentLite",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(routeAndExecute)
  .commit();
