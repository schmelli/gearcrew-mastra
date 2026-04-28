/**
 * Enrichment-Premium Helpers — Quick-Task 260428-ke7 (DATA-07)
 *
 * Supabase-side writes for the enrichmentPremium workflow:
 *
 *   1. applyDescriptionUpdate(itemId, name, description, run_id)
 *      - UPDATE gear_items.description (only if NULL or len < 300)
 *      - stamp last_description_enriched_at
 *      - INSERT graph_audit_log (best-effort soft-fail)
 *
 *   2. touchDescriptionEnrichmentTimestamp(itemId, run_id)
 *      - UPDATE gear_items.last_description_enriched_at = now()
 *      - Used when description-attempt yielded nothing (LLM failed, word-count
 *        out of range, or skipped='existing_description_good_enough').
 *
 *   3. touchInsightsEnrichmentTimestamp(itemId, run_id)
 *      - UPDATE gear_items.last_insights_enriched_at = now()
 *      - Used after every insights-attempt regardless of outcome (so cooldown
 *        advances even when no videos were linked or no insights extracted).
 *
 *   4. recordPremiumRunCost(run_id, cost_cents, result_data)
 *      - UPDATE/INSERT gardener_workflow_runs (best-effort, soft-fail).
 *
 * Mirrors the enrichment-lite-helpers.ts patterns exactly. NEVER throws on FK
 * violations or missing rows — failures are returned, not raised. The audit-log
 * FK to auth.users(id) may fail for Gardener-driven runs; that's logged and
 * caller can continue.
 */

import { randomUUID } from "node:crypto";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyResult {
  ok: boolean;
  audit_log_id?: string;
  reason?: string;
}

export interface TouchResult {
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Description writes
// ---------------------------------------------------------------------------

/**
 * UPDATE gear_items.description + stamp last_description_enriched_at + audit log.
 *
 * Idempotency guard: only writes when existing description IS NULL OR length
 * < 300. This protects against overwriting a manually curated long description
 * even if the workflow's skip-heuristic missed it.
 */
export async function applyDescriptionUpdate(
  itemId: string,
  itemName: string,
  description: string,
  workflowRunId: string,
): Promise<ApplyResult> {
  const supa = getSupabase();
  const nowIso = new Date().toISOString();

  // We split the guard into two passes: first read existing description so we
  // can attach a `before` snapshot to the audit log. Then UPDATE with a
  // belt-and-braces .or filter so a concurrent write doesn't clobber.
  const { data: existing, error: selErr } = await supa
    .from("gear_items")
    .select("description")
    .eq("id", itemId)
    .maybeSingle();

  if (selErr) {
    console.warn(
      `[enrichment-premium] gear_items pre-read failed for ${itemId}: ${selErr.message}`,
    );
    return { ok: false, reason: `pre_read_failed: ${selErr.message}` };
  }
  if (!existing) {
    return { ok: false, reason: "item_not_found" };
  }

  const beforeDesc = existing.description as string | null;
  const beforeLen = beforeDesc ? beforeDesc.length : 0;
  if (beforeLen >= 300) {
    return { ok: false, reason: "description_already_long_enough" };
  }

  const { data: updated, error: updErr } = await supa
    .from("gear_items")
    .update({
      description,
      last_description_enriched_at: nowIso,
    })
    .eq("id", itemId)
    .or("description.is.null,description.eq.")
    .select("id");

  // Some Supabase clients reject the .or() above when length filter is needed
  // — so attempt a fall-back scoped UPDATE if the typed filter rejected zero
  // rows AND the read showed the row was eligible (len < 300).
  if (updErr) {
    console.warn(
      `[enrichment-premium] description UPDATE failed for ${itemId}: ${updErr.message}`,
    );
    return { ok: false, reason: `update_failed: ${updErr.message}` };
  }

  let updatedRows = Array.isArray(updated) ? updated.length : 0;
  if (updatedRows === 0 && beforeLen < 300) {
    // Retry without .or filter — the previous filter excluded short non-empty
    // descriptions. Re-check len in JS first.
    const { data: retry, error: retryErr } = await supa
      .from("gear_items")
      .update({
        description,
        last_description_enriched_at: nowIso,
      })
      .eq("id", itemId)
      .select("id");
    if (retryErr) {
      return { ok: false, reason: `retry_failed: ${retryErr.message}` };
    }
    updatedRows = Array.isArray(retry) ? retry.length : 0;
  }

  if (updatedRows === 0) {
    return { ok: false, reason: "no_rows_updated" };
  }

  // Audit log (best-effort)
  const auditId = randomUUID();
  const { error: auditErr } = await supa.from("graph_audit_log").insert({
    id: auditId,
    workflow_run_id: workflowRunId,
    operation_type: "item_enrich_description",
    entity_type: "gear_item",
    entity_id: itemId,
    before: { description_length: beforeLen },
    after: {
      description_length: description.length,
      description_preview: description.slice(0, 200),
      extraction_source: "gemini_flash_premium",
      item_name: itemName,
    },
    operator: "gardener:enrichment-premium",
  });

  if (auditErr) {
    console.warn(
      `[enrichment-premium] graph_audit_log INSERT failed for ${itemId}: ${auditErr.message}`,
    );
    return { ok: true, reason: `audit_failed: ${auditErr.message}` };
  }

  return { ok: true, audit_log_id: auditId };
}

// ---------------------------------------------------------------------------
// Insights apply (audit log only — Memgraph writes happen in extractor)
// ---------------------------------------------------------------------------

/**
 * Record an audit-log entry summarizing an insights-extraction round for
 * one gear_item. The actual Insight nodes + edges already exist in Memgraph
 * (written by insights-extractor.extractInsightsForItem).
 *
 * Best-effort: returns ok=true even if audit insert fails (with reason).
 */
export async function recordInsightsAudit(
  itemId: string,
  itemName: string,
  videosExamined: number,
  insightsCreated: number,
  insightsExisting: number,
  workflowRunId: string,
): Promise<ApplyResult> {
  const supa = getSupabase();
  const auditId = randomUUID();
  const { error: auditErr } = await supa.from("graph_audit_log").insert({
    id: auditId,
    workflow_run_id: workflowRunId,
    operation_type: "item_enrich_insights",
    entity_type: "gear_item",
    entity_id: itemId,
    before: { insights_count_baseline: null },
    after: {
      videos_examined: videosExamined,
      insights_created: insightsCreated,
      insights_already_existing: insightsExisting,
      extraction_source: "memgraph+gemini_flash_premium",
      item_name: itemName,
    },
    operator: "gardener:enrichment-premium",
  });

  if (auditErr) {
    console.warn(
      `[enrichment-premium] insights graph_audit_log INSERT failed for ${itemId}: ${auditErr.message}`,
    );
    return { ok: true, reason: `audit_failed: ${auditErr.message}` };
  }

  return { ok: true, audit_log_id: auditId };
}

// ---------------------------------------------------------------------------
// Touch helpers — advance cooldown
// ---------------------------------------------------------------------------

/**
 * Bump only `gear_items.last_description_enriched_at = now()`. Used when the
 * description attempt yielded no usable result (or skipped because the
 * existing description was already good).
 */
export async function touchDescriptionEnrichmentTimestamp(
  itemId: string,
  workflowRunId: string,
): Promise<TouchResult> {
  return touchTimestamp(itemId, "last_description_enriched_at", workflowRunId);
}

/**
 * Bump only `gear_items.last_insights_enriched_at = now()`. Used after every
 * insights attempt — even no_videos / no_insights — so cooldown advances and
 * round-robin doesn't immediately re-pick the same item.
 */
export async function touchInsightsEnrichmentTimestamp(
  itemId: string,
  workflowRunId: string,
): Promise<TouchResult> {
  return touchTimestamp(itemId, "last_insights_enriched_at", workflowRunId);
}

async function touchTimestamp(
  itemId: string,
  column: "last_description_enriched_at" | "last_insights_enriched_at",
  workflowRunId: string,
): Promise<TouchResult> {
  try {
    const supa = getSupabase();
    const nowIso = new Date().toISOString();

    const { error } = await supa
      .from("gear_items")
      .update({ [column]: nowIso })
      .eq("id", itemId);

    if (error) {
      console.warn(
        `[enrichment-premium] touch ${column} failed for ${itemId} (run=${workflowRunId}): ${error.message}`,
      );
      return { ok: false, reason: `touch_failed: ${error.message}` };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[enrichment-premium] touchTimestamp(${column}) threw for ${itemId} (run=${workflowRunId}): ${reason}`,
    );
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// gardener_workflow_runs lifecycle (mirror enrichment-lite-helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Insert the gardener_workflow_runs row at the START of the run so that
 * subsequent FK references from graph_audit_log.workflow_run_id resolve.
 * Best-effort — FK to auth.users(id) may fail (Gardener has no auth user),
 * so we retry without `started_by`.
 */
export async function ensurePremiumWorkflowRunRow(
  workflowRunId: string,
  workflowId: string = "enrichment-premium",
  params: Record<string, unknown> = {},
): Promise<void> {
  try {
    const supa = getSupabase();

    const { data: existing, error: selErr } = await supa
      .from("gardener_workflow_runs")
      .select("id")
      .eq("id", workflowRunId)
      .maybeSingle();
    if (selErr) {
      console.warn(
        `[enrichment-premium] gardener_workflow_runs pre-insert select failed (continuing): ${selErr.message}`,
      );
      return;
    }
    if (existing?.id) return;

    const startedBy = process.env.GARDENER_SYSTEM_USER_ID;
    const baseRow: Record<string, unknown> = {
      id: workflowRunId,
      workflow_id: workflowId,
      run_id: workflowRunId,
      started_at: new Date().toISOString(),
      status: "running",
      params,
      dry_run: false,
      cost_cents: 0,
      result_data: { phase: "starting" },
    };
    if (startedBy) baseRow.started_by = startedBy;

    const { error } = await supa
      .from("gardener_workflow_runs")
      .insert(baseRow);
    if (!error) return;

    const isFkViolation =
      error.message?.toLowerCase().includes("foreign key") ?? false;
    if (isFkViolation && startedBy) {
      console.warn(
        `[enrichment-premium] gardener_workflow_runs FK-violation on started_by — retrying without it`,
      );
      delete baseRow.started_by;
      const { error: retryErr } = await supa
        .from("gardener_workflow_runs")
        .insert(baseRow);
      if (retryErr) {
        console.warn(
          `[enrichment-premium] gardener_workflow_runs retry insert failed (continuing): ${retryErr.message}`,
        );
      }
      return;
    }

    console.warn(
      `[enrichment-premium] gardener_workflow_runs pre-insert failed (continuing): ${error.message}`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[enrichment-premium] ensurePremiumWorkflowRunRow threw: ${reason}`,
    );
  }
}

/**
 * Best-effort cost-record after each batch / at end of run.
 */
export async function recordPremiumRunCost(
  workflowRunId: string,
  costCents: number,
  resultData: Record<string, unknown>,
  workflowId: string = "enrichment-premium",
): Promise<void> {
  try {
    const supa = getSupabase();

    const { data: existing, error: selectError } = await supa
      .from("gardener_workflow_runs")
      .select("id")
      .eq("id", workflowRunId)
      .maybeSingle();

    if (selectError) {
      console.warn(
        `[enrichment-premium] gardener_workflow_runs select failed: ${selectError.message}`,
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
          `[enrichment-premium] gardener_workflow_runs UPDATE failed: ${updateError.message}`,
        );
      }
      return;
    }

    const startedBy = process.env.GARDENER_SYSTEM_USER_ID;
    const baseRow: Record<string, unknown> = {
      id: workflowRunId,
      workflow_id: workflowId,
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
        `[enrichment-premium] gardener_workflow_runs INSERT failed: ${insertError.message}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[enrichment-premium] recordPremiumRunCost threw: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Coverage helpers — for before/after % reporting
// ---------------------------------------------------------------------------

export async function getDescriptionCoverage(): Promise<{
  total: number;
  withGoodDescription: number;
}> {
  const supa = getSupabase();

  const totalRes = await supa
    .from("gear_items")
    .select("id", { count: "exact", head: true });
  if (totalRes.error) {
    throw new Error(
      `[enrichment-premium] coverage total failed: ${totalRes.error.message}`,
    );
  }

  // "Good" = description IS NOT NULL AND char_length(description) >= 300.
  // PostgREST cannot express char_length filter via .filter(...) reliably
  // (no exposed function name) — but it can express "not null" + we use the
  // computed column trick: filter on description not null first, then a JS
  // post-pass would require fetching all rows. Compromise: return only
  // total + not_null count; the workflow logs improvement deltas instead of
  // an absolute "good description" % to avoid false precision.
  const notNullRes = await supa
    .from("gear_items")
    .select("id", { count: "exact", head: true })
    .not("description", "is", null);
  if (notNullRes.error) {
    throw new Error(
      `[enrichment-premium] coverage description-not-null failed: ${notNullRes.error.message}`,
    );
  }

  return {
    total: totalRes.count ?? 0,
    withGoodDescription: notNullRes.count ?? 0,
  };
}
