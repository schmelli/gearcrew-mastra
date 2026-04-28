/**
 * Auto-Typing Apply Helpers — Phase 09 / DATA-04 (GEA-1085)
 *
 * Three apply-mode helpers used by the autoTypingFlash workflow:
 *
 *   1. applyHighConfidenceRetypes(items, workflowRunId)
 *      - For each item: UPDATE gear_items SET product_type_id = $suggested
 *        WHERE id = $gear_item_id AND product_type_id IS NULL (idempotency
 *        guard on re-runs).
 *      - INSERT graph_audit_log row with operation_type='item_retype'.
 *      - Per-item failures collected, NOT thrown.
 *
 *   2. upsertReviewQueue(items, workflowRunId)
 *      - UPSERT into items_needing_type_review keyed by gear_item_id.
 *      - SCHEMA NOTE: column is `suggested_type_id` (NOT
 *        `suggested_product_type_id`). suggested_label + reasoning are
 *        embedded in `llm_raw_response` jsonb (no dedicated columns).
 *
 *   3. recordCumulativeCostBestEffort(workflowRunId, costCents, resultData)
 *      - Schema-drift-tolerant UPDATE of gardener_workflow_runs.cost_cents +
 *        result_data. NEVER throws — wrapped in try/catch like brand-dedup.
 */

import { randomUUID } from "node:crypto";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Types (used by the workflow caller)
// ---------------------------------------------------------------------------

export interface HighConfidenceItem {
  gear_item_id: string;
  suggested_product_type_id: string;
  suggested_label: string | null;
  confidence: number;
  reasoning: string;
  before: {
    product_type_id: string | null;
    category_legacy: string | null;
  };
}

export interface ReviewQueueItem {
  gear_item_id: string;
  suggested_product_type_id: string | null;
  suggested_label: string | null;
  confidence: number;
  reasoning: string;
  batch_id?: string;
}

export interface ApplyHighConfResult {
  retyped: number;
  audit_log_ids: string[];
  failed: Array<{ gear_item_id: string; reason: string }>;
}

export interface UpsertReviewResult {
  upserted: number;
  failed: Array<{ gear_item_id: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// applyHighConfidenceRetypes
// ---------------------------------------------------------------------------

/**
 * UPDATE each gear_item with the high-confidence ProductType, then write a
 * graph_audit_log row. The WHERE-product_type_id-IS-NULL guard makes the
 * UPDATE idempotent on re-runs (already-typed items are skipped silently).
 */
export async function applyHighConfidenceRetypes(
  items: HighConfidenceItem[],
  workflowRunId: string,
): Promise<ApplyHighConfResult> {
  if (items.length === 0) {
    return { retyped: 0, audit_log_ids: [], failed: [] };
  }

  const supa = getSupabase();
  const audit_log_ids: string[] = [];
  const failed: Array<{ gear_item_id: string; reason: string }> = [];
  let retyped = 0;

  for (const item of items) {
    // Step 1: UPDATE gear_items (idempotency guard via WHERE product_type_id IS NULL).
    const { data: updated, error: updErr } = await supa
      .from("gear_items")
      .update({ product_type_id: item.suggested_product_type_id })
      .eq("id", item.gear_item_id)
      .is("product_type_id", null)
      .select("id");

    if (updErr) {
      console.warn(
        `[auto-typing] gear_items UPDATE failed for ${item.gear_item_id}: ${updErr.message}`,
      );
      failed.push({ gear_item_id: item.gear_item_id, reason: updErr.message });
      continue;
    }

    const updatedRows = Array.isArray(updated) ? updated.length : 0;
    if (updatedRows === 0) {
      // Row already typed (idempotency hit) or deleted between fetch and apply.
      console.log(
        `[auto-typing] skip ${item.gear_item_id} — already typed or removed (no rows updated)`,
      );
      continue;
    }

    retyped += 1;

    // Step 2: INSERT graph_audit_log row.
    const auditId = randomUUID();
    const { error: auditErr } = await supa.from("graph_audit_log").insert({
      id: auditId,
      workflow_run_id: workflowRunId,
      operation_type: "item_retype",
      entity_type: "gear_item",
      entity_id: item.gear_item_id,
      before: {
        product_type_id: item.before.product_type_id,
        category_legacy: item.before.category_legacy,
      },
      after: {
        product_type_id: item.suggested_product_type_id,
        label: item.suggested_label,
      },
      operator: "gardener:auto",
    });

    if (auditErr) {
      console.warn(
        `[auto-typing] graph_audit_log INSERT failed for ${item.gear_item_id}: ${auditErr.message}`,
      );
      failed.push({
        gear_item_id: item.gear_item_id,
        reason: `audit_log: ${auditErr.message}`,
      });
      // We do NOT roll back the gear_items UPDATE — the retype succeeded;
      // missing audit row is a soft failure that operators can backfill.
      continue;
    }

    audit_log_ids.push(auditId);
  }

  console.log(
    `[auto-typing] applyHighConfidenceRetypes: retyped=${retyped}/${items.length}, audit_ids=${audit_log_ids.length}, failed=${failed.length}`,
  );

  return { retyped, audit_log_ids, failed };
}

// ---------------------------------------------------------------------------
// upsertReviewQueue
// ---------------------------------------------------------------------------

/**
 * UPSERT each low-confidence item into items_needing_type_review keyed by
 * gear_item_id. Idempotent on re-runs.
 *
 * SCHEMA-DRIFT NOTE: Plan handoff hints at `suggested_product_type_id` column
 * but actual migration uses `suggested_type_id`. There are NO `suggested_label`
 * or `llm_reasoning` columns — both are embedded into `llm_raw_response` jsonb.
 */
export async function upsertReviewQueue(
  items: ReviewQueueItem[],
  workflowRunId: string,
): Promise<UpsertReviewResult> {
  if (items.length === 0) {
    return { upserted: 0, failed: [] };
  }

  const supa = getSupabase();
  const failed: Array<{ gear_item_id: string; reason: string }> = [];
  let upserted = 0;

  for (const item of items) {
    const row = {
      gear_item_id: item.gear_item_id,
      suggested_type_id: item.suggested_product_type_id,
      llm_confidence: item.confidence,
      llm_raw_response: {
        suggested_label: item.suggested_label,
        reasoning: item.reasoning,
        model: "google/gemini-2.5-flash",
        batch_id: item.batch_id ?? null,
      },
      status: "pending",
      workflow_run_id: workflowRunId,
    };

    const { error } = await supa
      .from("items_needing_type_review")
      .upsert(row, { onConflict: "gear_item_id" });

    if (error) {
      console.warn(
        `[auto-typing] items_needing_type_review UPSERT failed for ${item.gear_item_id}: ${error.message}`,
      );
      failed.push({ gear_item_id: item.gear_item_id, reason: error.message });
      continue;
    }

    upserted += 1;
  }

  console.log(
    `[auto-typing] upsertReviewQueue: upserted=${upserted}/${items.length}, failed=${failed.length}`,
  );

  return { upserted, failed };
}

// ---------------------------------------------------------------------------
// recordCumulativeCostBestEffort
// ---------------------------------------------------------------------------

/**
 * Schema-drift-tolerant UPDATE of gardener_workflow_runs.cost_cents +
 * result_data after each batch. NEVER throws — the actual workflow result
 * is the value, this row is just an audit/observability trail.
 *
 * If the row doesn't exist yet (first batch), we INSERT instead of UPDATE.
 * If the table or any column is missing, we log + continue.
 */
export async function recordCumulativeCostBestEffort(
  workflowRunId: string,
  costCents: number,
  resultData: Record<string, unknown>,
): Promise<void> {
  try {
    const supa = getSupabase();

    // Try UPDATE first (row may have been inserted at workflow-start by Mastra
    // or by a prior batch in this run).
    const { data: existing, error: selectError } = await supa
      .from("gardener_workflow_runs")
      .select("id")
      .eq("id", workflowRunId)
      .maybeSingle();

    if (selectError) {
      console.warn(
        `[auto-typing] gardener_workflow_runs select failed (continuing): ${selectError.message}`,
      );
      return;
    }

    if (existing?.id) {
      const { error: updateError } = await supa
        .from("gardener_workflow_runs")
        .update({
          cost_cents: costCents,
          result_data: resultData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", workflowRunId);
      if (updateError) {
        console.warn(
          `[auto-typing] gardener_workflow_runs UPDATE failed (continuing): ${updateError.message}`,
        );
      }
      return;
    }

    // INSERT — first cost-record for this run. Best-effort; FK to auth.users(id)
    // may fail (Gardener has no auth user) — log + continue.
    const startedBy = process.env.GARDENER_SYSTEM_USER_ID;
    const baseRow: Record<string, unknown> = {
      id: workflowRunId,
      workflow_id: "auto-typing-flash",
      run_id: workflowRunId,
      started_at: new Date().toISOString(),
      status: "running",
      params: { mode: "apply" },
      dry_run: false,
      cost_cents: costCents,
      result_data: resultData,
    };
    if (startedBy) baseRow.started_by = startedBy;

    const { error: insertError } = await supa
      .from("gardener_workflow_runs")
      .insert(baseRow);
    if (insertError) {
      console.warn(
        `[auto-typing] gardener_workflow_runs INSERT failed (continuing): ${insertError.message}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[auto-typing] recordCumulativeCostBestEffort threw: ${reason}`,
    );
  }
}
