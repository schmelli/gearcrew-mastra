/**
 * Auto-Typing Workflow (autoTypingFlash) — Phase 09 / DATA-04 (GEA-1085)
 *
 * Classifies untyped gear_items (product_type_id IS NULL) into one of the
 * existing Top-50 ProductType-Categories via Gemini 2.5 Flash. Two modes:
 *
 *   "dry-run":
 *     - Classify items in 50-item batches, accumulate cost.
 *     - NO Supabase writes for gear_items / audit_log / review_queue.
 *     - Result returns sample of high-conf + low-conf rows for review.
 *     - dry_run_test=true additionally skips gardener_workflow_runs cost-tracking.
 *
 *   "apply":
 *     - Same batch loop + cost accumulation.
 *     - Per-batch cost-cap-abort BEFORE next batch when cumCost > max_cost_cents.
 *     - High-conf (≥confidence_threshold) → applyHighConfidenceRetypes
 *       (UPDATE gear_items + INSERT graph_audit_log).
 *     - Low-conf → upsertReviewQueue (items_needing_type_review UPSERT).
 *     - After every batch: recordCumulativeCostBestEffort UPDATE on
 *       gardener_workflow_runs.cost_cents.
 *
 * Linear-step pattern: same single-step routeAndExecute shape as
 * brand-dedup.ts and type-dedup.ts.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { classifyBatch } from "../lib/auto-typing.js";
import {
  applyHighConfidenceRetypes,
  upsertReviewQueue,
  recordCumulativeCostBestEffort,
} from "./auto-typing-apply.js";
import {
  fetchUntypedItems,
  fetchCandidateCategories,
  buildSampleResults,
  sampleResultSchema,
  type BatchAccumulator,
} from "./auto-typing-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 60;
const DEFAULT_MAX_COST_CENTS = 1000; // $10 hard cap per CONTEXT D-15
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_TOP_N_CANDIDATES = 50;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  batch_size: z.number().int().positive().default(DEFAULT_BATCH_SIZE),
  max_batches: z.number().int().positive().default(DEFAULT_MAX_BATCHES),
  max_cost_cents: z.number().int().positive().default(DEFAULT_MAX_COST_CENTS),
  confidence_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_CONFIDENCE_THRESHOLD),
  limit: z.number().int().positive().optional(),
  dry_run_test: z.boolean().default(false),
  retype_all: z.boolean().default(false),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  workflow_run_id: z.string(),
  items_processed: z.number(),
  items_typed_confidently: z.number(),
  items_in_review_queue: z.number(),
  items_failed: z.number(),
  cost_cents_used: z.number(),
  aborted_due_to_cost: z.boolean(),
  audit_log_ids: z.array(z.string()),
  batches_processed: z.number(),
  bilanz_check: z.boolean(),
  sample_results: z.array(sampleResultSchema),
});

type WorkflowOutput = z.infer<typeof outputSchema>;

// ---------------------------------------------------------------------------
// Step: routeAndExecute
// ---------------------------------------------------------------------------

const routeAndExecute = createStep({
  id: "route-and-execute",
  description:
    "Fetch untyped gear_items + candidate categories → batch-classify with Gemini → dry-run sample OR apply Supabase writes",
  inputSchema: triggerSchema,
  outputSchema,
  execute: async ({ inputData }): Promise<WorkflowOutput> => {
    const workflow_run_id = randomUUID();
    console.log(
      `[auto-typing] start: run_id=${workflow_run_id} mode=${inputData.mode} batch_size=${inputData.batch_size} max_batches=${inputData.max_batches} max_cost_cents=${inputData.max_cost_cents} confidence_threshold=${inputData.confidence_threshold} limit=${inputData.limit ?? "none"} dry_run_test=${inputData.dry_run_test}`,
    );

    // Step 1 — fetch untyped items (cap = min(limit, max_batches * batch_size))
    const cap = Math.min(
      inputData.limit ?? Number.MAX_SAFE_INTEGER,
      inputData.max_batches * inputData.batch_size,
    );
    const items = await fetchUntypedItems(cap, inputData.retype_all ?? false);

    if (items.length === 0) {
      console.warn(
        "[auto-typing] no untyped gear_items found — returning empty result",
      );
      return {
        mode: inputData.mode,
        workflow_run_id,
        items_processed: 0,
        items_typed_confidently: 0,
        items_in_review_queue: 0,
        items_failed: 0,
        cost_cents_used: 0,
        aborted_due_to_cost: false,
        audit_log_ids: [],
        batches_processed: 0,
        bilanz_check: true,
        sample_results: [],
      };
    }

    // Step 2 — fetch candidate categories (Top-50 by item count)
    const candidates = await fetchCandidateCategories(DEFAULT_TOP_N_CANDIDATES);
    if (candidates.length === 0) {
      throw new Error(
        "[auto-typing] no candidate categories found (level=3 with item-count) — cannot classify",
      );
    }

    // Item-name + category_legacy lookup for sample-result rendering and
    // audit-log "before" payload.
    const itemNameById = new Map<string, string>();
    const itemCategoryLegacyById = new Map<string, string | null>();
    for (const it of items) {
      itemNameById.set(it.id, it.name);
      itemCategoryLegacyById.set(it.id, it.category_legacy);
    }

    // Step 3 — batch-classify loop
    const acc: BatchAccumulator = {
      high: [],
      low: [],
      failed: [],
      cost_cents: 0,
      audit_log_ids: [],
      batches_processed: 0,
      items_processed: 0,
    };

    const totalBatches = Math.ceil(items.length / inputData.batch_size);
    const batchCount = Math.min(totalBatches, inputData.max_batches);
    let aborted_due_to_cost = false;

    for (let b = 0; b < batchCount; b += 1) {
      const slice = items.slice(
        b * inputData.batch_size,
        (b + 1) * inputData.batch_size,
      );
      const batchId = `${workflow_run_id}:${b + 1}`;

      const result = await classifyBatch(
        { items: slice, candidates },
        {},
      );

      acc.cost_cents += result.cost_cents;
      acc.batches_processed += 1;
      acc.items_processed += slice.length;

      // Sort each item into high/low/failed.
      for (const r of result.results) {
        if (
          r.suggested_product_type_id === null ||
          r.confidence === 0 ||
          r.suggested_label === null
        ) {
          acc.failed.push({
            result: r,
            reason: "null_or_zero_confidence",
            item_name: itemNameById.get(r.item_id) ?? "",
          });
        } else if (r.confidence >= inputData.confidence_threshold) {
          acc.high.push({
            gear_item_id: r.item_id,
            suggested_product_type_id: r.suggested_product_type_id,
            suggested_label: r.suggested_label,
            confidence: r.confidence,
            reasoning: r.reasoning,
            before: {
              product_type_id: null,
              category_legacy: itemCategoryLegacyById.get(r.item_id) ?? null,
            },
          });
        } else {
          acc.low.push({
            gear_item_id: r.item_id,
            suggested_product_type_id: r.suggested_product_type_id,
            suggested_label: r.suggested_label,
            confidence: r.confidence,
            reasoning: r.reasoning,
            batch_id: batchId,
          });
        }
      }

      // Items the LLM did not return at all → count as failed.
      const returnedIds = new Set(result.results.map((r) => r.item_id));
      for (const it of slice) {
        if (!returnedIds.has(it.id)) {
          acc.failed.push({
            result: {
              item_id: it.id,
              suggested_product_type_id: null,
              suggested_label: null,
              confidence: 0,
              reasoning: "no_llm_result_for_item",
            },
            reason: "missing_from_llm_response",
            item_name: it.name,
          });
        }
      }

      console.log(
        `[auto-typing] batch ${b + 1}/${batchCount}: high=${acc.high.length} low=${acc.low.length} failed=${acc.failed.length}, cumCost=${acc.cost_cents}¢/${inputData.max_cost_cents}¢`,
      );

      // Best-effort cost-tracking on gardener_workflow_runs after every batch.
      if (!inputData.dry_run_test) {
        await recordCumulativeCostBestEffort(workflow_run_id, acc.cost_cents, {
          mode: inputData.mode,
          items_processed: acc.items_processed,
          items_typed_confidently: acc.high.length,
          items_in_review_queue: acc.low.length,
          items_failed: acc.failed.length,
          batches_processed: acc.batches_processed,
        });
      }

      // Cost-cap check BEFORE the next batch (we already paid for THIS batch's
      // tokens — process its results above, then break).
      if (acc.cost_cents > inputData.max_cost_cents) {
        console.warn(
          `[auto-typing] COST-CAP-ABORT — ${acc.cost_cents}¢ > ${inputData.max_cost_cents}¢ after batch ${b + 1}`,
        );
        aborted_due_to_cost = true;
        break;
      }
    }

    // Step 4 — applyOrSimulate
    if (inputData.mode === "apply" && !inputData.dry_run_test) {
      console.log(
        `[auto-typing] APPLY: high=${acc.high.length} retypes, low=${acc.low.length} review-queue upserts`,
      );
      const applyRes = await applyHighConfidenceRetypes(
        acc.high,
        workflow_run_id,
      );
      acc.audit_log_ids.push(...applyRes.audit_log_ids);
      for (const f of applyRes.failed) {
        acc.failed.push({
          result: {
            item_id: f.gear_item_id,
            suggested_product_type_id: null,
            suggested_label: null,
            confidence: 0,
            reasoning: `apply_failed: ${f.reason}`,
          },
          reason: "apply_high_conf_failed",
          item_name: itemNameById.get(f.gear_item_id) ?? "",
        });
      }

      const reviewRes = await upsertReviewQueue(acc.low, workflow_run_id);
      for (const f of reviewRes.failed) {
        acc.failed.push({
          result: {
            item_id: f.gear_item_id,
            suggested_product_type_id: null,
            suggested_label: null,
            confidence: 0,
            reasoning: `review_upsert_failed: ${f.reason}`,
          },
          reason: "review_queue_failed",
          item_name: itemNameById.get(f.gear_item_id) ?? "",
        });
      }

      const items_typed_confidently = applyRes.retyped;
      const items_in_review_queue = reviewRes.upserted;
      const items_failed = acc.failed.length;
      const total =
        items_typed_confidently + items_in_review_queue + items_failed;
      const bilanz_check = total === acc.items_processed;
      if (!bilanz_check) {
        console.error(
          `[auto-typing] BILANZ-FAIL: ${items_typed_confidently} + ${items_in_review_queue} + ${items_failed} = ${total} ≠ items_processed=${acc.items_processed}`,
        );
      }

      await recordCumulativeCostBestEffort(workflow_run_id, acc.cost_cents, {
        mode: "apply",
        items_processed: acc.items_processed,
        items_typed_confidently,
        items_in_review_queue,
        items_failed,
        batches_processed: acc.batches_processed,
        audit_log_ids: acc.audit_log_ids,
        aborted_due_to_cost,
        status: aborted_due_to_cost ? "aborted_cost_cap" : "completed",
      });

      return {
        mode: "apply",
        workflow_run_id,
        items_processed: acc.items_processed,
        items_typed_confidently,
        items_in_review_queue,
        items_failed,
        cost_cents_used: acc.cost_cents,
        aborted_due_to_cost,
        audit_log_ids: acc.audit_log_ids,
        batches_processed: acc.batches_processed,
        bilanz_check,
        sample_results: buildSampleResults(acc, itemNameById),
      };
    }

    // dry-run path — NO Supabase writes for gear_items / audit_log / review_queue.
    const items_typed_confidently = acc.high.length;
    const items_in_review_queue = acc.low.length;
    const items_failed = acc.failed.length;
    const total =
      items_typed_confidently + items_in_review_queue + items_failed;
    const bilanz_check = total === acc.items_processed;
    if (!bilanz_check) {
      console.error(
        `[auto-typing] BILANZ-FAIL: ${items_typed_confidently} + ${items_in_review_queue} + ${items_failed} = ${total} ≠ items_processed=${acc.items_processed}`,
      );
    }

    if (!inputData.dry_run_test) {
      await recordCumulativeCostBestEffort(workflow_run_id, acc.cost_cents, {
        mode: "dry-run",
        items_processed: acc.items_processed,
        items_typed_confidently,
        items_in_review_queue,
        items_failed,
        batches_processed: acc.batches_processed,
        aborted_due_to_cost,
        status: aborted_due_to_cost ? "aborted_cost_cap" : "completed",
      });
    }

    return {
      mode: "dry-run",
      workflow_run_id,
      items_processed: acc.items_processed,
      items_typed_confidently,
      items_in_review_queue,
      items_failed,
      cost_cents_used: acc.cost_cents,
      aborted_due_to_cost,
      audit_log_ids: [],
      batches_processed: acc.batches_processed,
      bilanz_check,
      sample_results: buildSampleResults(acc, itemNameById),
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const autoTypingFlash = createWorkflow({
  id: "autoTypingFlash",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(routeAndExecute)
  .commit();
