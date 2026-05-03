/**
 * Enrichment-Lite Helpers — Phase 09 / DATA-05 + DATA-06 (GEA-1086 + GEA-1087)
 *
 * Supabase-side helpers for the enrichmentLite workflow:
 *
 *   1. fetchItemsMissingWeight(cap) — gear_items WHERE weight_grams IS NULL
 *   2. fetchItemsMissingImage(cap)  — gear_items WHERE primary_image_url IS NULL
 *   3. applyWeightUpdate(item, weight, run_id) — UPDATE gear_items + audit-log
 *   4. applyImageUpdate(item, url, source_url, run_id) — UPDATE gear_items + audit-log
 *   5. upsertEnrichmentGap(item_id, gap_type, error, run_id) — UPSERT enrichment_gaps
 *   6. recordEnrichmentRunCost(run_id, cost_cents, result_data) — best-effort
 *      gardener_workflow_runs UPDATE/INSERT
 *
 * NEVER throws on FK violations or missing rows — failures are returned, not raised.
 */

import { randomUUID } from "node:crypto";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemForWeight {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
}

export interface ItemForImage {
  id: string;
  name: string;
  brand: string | null;
  product_url: string | null;
}

export interface ApplyResult {
  ok: boolean;
  audit_log_id?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Read up to `cap` gear_items rows where weight_grams IS NULL. Pages to avoid
 * PostgREST's 1000-row default cap.
 */
export async function fetchItemsMissingWeight(
  cap: number,
): Promise<ItemForWeight[]> {
  const supa = getSupabase();
  const items: ItemForWeight[] = [];
  const PAGE = 1000;
  let from = 0;

  while (items.length < cap) {
    const remaining = cap - items.length;
    const pageSize = Math.min(PAGE, remaining);
    const { data, error } = await supa
      .from("gear_items")
      .select("id, name, brand, description")
      .is("weight_grams", null)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(
        `[enrichment] gear_items (missing weight) read failed: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    interface RawRow {
      id: string;
      name: string;
      brand: string | null;
      description: string | null;
    }
    for (const row of data as RawRow[]) {
      items.push({
        id: row.id,
        name: row.name,
        brand: row.brand,
        description: row.description,
      });
      if (items.length >= cap) break;
    }
    if (data.length < pageSize) break;
    from += data.length;
  }

  console.log(
    `[enrichment] fetched ${items.length} items missing weight (cap=${cap})`,
  );
  return items;
}

/**
 * Read up to `cap` gear_items rows where primary_image_url IS NULL.
 */
export async function fetchItemsMissingImage(
  cap: number,
): Promise<ItemForImage[]> {
  const supa = getSupabase();
  const items: ItemForImage[] = [];
  const PAGE = 1000;
  let from = 0;

  while (items.length < cap) {
    const remaining = cap - items.length;
    const pageSize = Math.min(PAGE, remaining);
    const { data, error } = await supa
      .from("gear_items")
      .select("id, name, brand, product_url")
      .is("primary_image_url", null)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(
        `[enrichment] gear_items (missing image) read failed: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    interface RawRow {
      id: string;
      name: string;
      brand: string | null;
      product_url: string | null;
    }
    for (const row of data as RawRow[]) {
      items.push({
        id: row.id,
        name: row.name,
        brand: row.brand,
        product_url: row.product_url,
      });
      if (items.length >= cap) break;
    }
    if (data.length < pageSize) break;
    from += data.length;
  }

  console.log(
    `[enrichment] fetched ${items.length} items missing image (cap=${cap})`,
  );
  return items;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * UPDATE gear_items.weight_grams + INSERT graph_audit_log.
 * Idempotency: WHERE weight_grams IS NULL guard.
 * Audit-log FK to auth.users(id) may fail — caught and reported as soft-fail.
 */
export async function applyWeightUpdate(
  itemId: string,
  itemName: string,
  weightGrams: number,
  confidence: number,
  reasoning: string,
  workflowRunId: string,
): Promise<ApplyResult> {
  const supa = getSupabase();

  // Step 1: UPDATE gear_items (idempotent guard).
  // Round-robin contract (quick-260428-jux): also stamp last_weight_enriched_at
  // so the cooldown advances on every successful weight write.
  const { data: updated, error: updErr } = await supa
    .from("gear_items")
    .update({
      weight_grams: weightGrams,
      last_weight_enriched_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .is("weight_grams", null)
    .select("id");

  if (updErr) {
    console.warn(
      `[enrichment] gear_items weight UPDATE failed for ${itemId}: ${updErr.message}`,
    );
    return { ok: false, reason: `update_failed: ${updErr.message}` };
  }

  const updatedRows = Array.isArray(updated) ? updated.length : 0;
  if (updatedRows === 0) {
    return { ok: false, reason: "already_has_weight_or_missing" };
  }

  // Step 2: INSERT graph_audit_log (best-effort — FK may fail)
  const auditId = randomUUID();
  const { error: auditErr } = await supa.from("graph_audit_log").insert({
    id: auditId,
    workflow_run_id: workflowRunId,
    operation_type: "item_enrich_weight",
    entity_type: "gear_item",
    entity_id: itemId,
    before: { weight_grams: null },
    after: {
      weight_grams: weightGrams,
      extraction_source: "gemini_flash_lite",
      confidence,
      reasoning: reasoning.slice(0, 240),
      item_name: itemName,
    },
    operator: "gardener:enrichment-lite",
  });

  if (auditErr) {
    console.warn(
      `[enrichment] graph_audit_log INSERT failed for ${itemId}: ${auditErr.message}`,
    );
    return { ok: true, reason: `audit_failed: ${auditErr.message}` };
  }

  return { ok: true, audit_log_id: auditId };
}

/**
 * UPDATE gear_items.primary_image_url + image_source_url + INSERT graph_audit_log.
 * Idempotency: WHERE primary_image_url IS NULL guard.
 */
export async function applyImageUpdate(
  itemId: string,
  itemName: string,
  imageUrl: string,
  sourceUrl: string,
  source: "og:image" | "itemprop:image" | "twitter:image" | "json-ld:product",
  workflowRunId: string,
): Promise<ApplyResult> {
  const supa = getSupabase();

  // Round-robin contract (quick-260428-jux): stamp last_image_enriched_at so
  // the cooldown advances on every successful image write.
  const { data: updated, error: updErr } = await supa
    .from("gear_items")
    .update({
      primary_image_url: imageUrl,
      image_source_url: sourceUrl,
      last_image_enriched_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .is("primary_image_url", null)
    .select("id");

  if (updErr) {
    console.warn(
      `[enrichment] gear_items image UPDATE failed for ${itemId}: ${updErr.message}`,
    );
    return { ok: false, reason: `update_failed: ${updErr.message}` };
  }

  const updatedRows = Array.isArray(updated) ? updated.length : 0;
  if (updatedRows === 0) {
    return { ok: false, reason: "already_has_image_or_missing" };
  }

  const auditId = randomUUID();
  const { error: auditErr } = await supa.from("graph_audit_log").insert({
    id: auditId,
    workflow_run_id: workflowRunId,
    operation_type: "item_enrich_image",
    entity_type: "gear_item",
    entity_id: itemId,
    before: { primary_image_url: null, image_source_url: null },
    after: {
      primary_image_url: imageUrl,
      image_source_url: sourceUrl,
      extraction_source: source,
      item_name: itemName,
    },
    operator: "gardener:enrichment-lite",
  });

  if (auditErr) {
    console.warn(
      `[enrichment] graph_audit_log INSERT failed for ${itemId}: ${auditErr.message}`,
    );
    return { ok: true, reason: `audit_failed: ${auditErr.message}` };
  }

  return { ok: true, audit_log_id: auditId };
}

/**
 * UPSERT enrichment_gaps row keyed by (gear_item_id, gap_type).
 * Increments attempt_count, sets next_retry_after to +7 days if attempt_count < 3,
 * else sets status='abandoned' and next_retry_after=NULL.
 */
export async function upsertEnrichmentGap(
  itemId: string,
  gapType: "weight" | "image",
  errorReason: string,
  workflowRunId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const supa = getSupabase();

  // Read current attempt_count to decide next_retry_after / status.
  const { data: existing, error: selErr } = await supa
    .from("enrichment_gaps")
    .select("id, attempt_count, status")
    .eq("gear_item_id", itemId)
    .eq("gap_type", gapType)
    .maybeSingle();

  if (selErr) {
    console.warn(
      `[enrichment] enrichment_gaps select failed for ${itemId}: ${selErr.message}`,
    );
    return { ok: false, reason: `select_failed: ${selErr.message}` };
  }

  const now = new Date();
  const prevAttempts = existing?.attempt_count ?? 0;
  const nextAttempts = prevAttempts + 1;
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const status = nextAttempts >= 3 ? "abandoned" : "pending";
  const nextRetry = nextAttempts >= 3 ? null : sevenDaysOut.toISOString();

  const row: Record<string, unknown> = {
    gear_item_id: itemId,
    gap_type: gapType,
    attempt_count: nextAttempts,
    last_attempted_at: now.toISOString(),
    last_error: errorReason.slice(0, 500),
    next_retry_after: nextRetry,
    last_workflow_run_id: workflowRunId,
    status,
    updated_at: now.toISOString(),
  };
  if (!existing) row.first_attempted_at = now.toISOString();

  const { error: upsertErr } = await supa
    .from("enrichment_gaps")
    .upsert(row, { onConflict: "gear_item_id,gap_type" });

  if (upsertErr) {
    console.warn(
      `[enrichment] enrichment_gaps UPSERT failed for ${itemId}: ${upsertErr.message}`,
    );
    return { ok: false, reason: `upsert_failed: ${upsertErr.message}` };
  }

  return { ok: true };
}

/**
 * Insert the gardener_workflow_runs row at the START of the run so that
 * subsequent FK references from graph_audit_log.workflow_run_id and
 * enrichment_gaps.last_workflow_run_id resolve. Best-effort — if the FK to
 * auth.users(id) fails (Gardener has no auth user), we retry without
 * `started_by`.
 */
export async function ensureWorkflowRunRow(
  workflowRunId: string,
  workflowId: string = "enrichment-lite",
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
        `[enrichment] gardener_workflow_runs pre-insert select failed (continuing): ${selErr.message}`,
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

    // Retry without started_by if FK to auth.users(id) violated.
    const isFkViolation =
      error.message?.toLowerCase().includes("foreign key") ?? false;
    if (isFkViolation && startedBy) {
      console.warn(
        `[enrichment] gardener_workflow_runs insert FK-violation on started_by — retrying without it`,
      );
      delete baseRow.started_by;
      const { error: retryErr } = await supa
        .from("gardener_workflow_runs")
        .insert(baseRow);
      if (retryErr) {
        console.warn(
          `[enrichment] gardener_workflow_runs retry insert failed (continuing): ${retryErr.message}`,
        );
      }
      return;
    }

    console.warn(
      `[enrichment] gardener_workflow_runs pre-insert failed (continuing): ${error.message}`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[enrichment] ensureWorkflowRunRow threw: ${reason}`);
  }
}

/**
 * Schema-drift-tolerant UPDATE/INSERT of gardener_workflow_runs after each
 * batch. NEVER throws — best-effort observability trail. FK to auth.users(id)
 * may fail (Gardener has no auth user) — log + continue.
 */
export async function recordEnrichmentRunCost(
  workflowRunId: string,
  costCents: number,
  resultData: Record<string, unknown>,
  workflowId: string = "enrichment-lite",
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
        `[enrichment] gardener_workflow_runs select failed (continuing): ${selectError.message}`,
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
          `[enrichment] gardener_workflow_runs UPDATE failed (continuing): ${updateError.message}`,
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
        `[enrichment] gardener_workflow_runs INSERT failed (continuing): ${insertError.message}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[enrichment] recordEnrichmentRunCost threw: ${reason}`);
  }
}

/**
 * Coverage helper — returns count of items + items with weight/image set.
 * Used for before/after coverage % calculation.
 */
export async function getCoverageCounts(): Promise<{
  total: number;
  withWeight: number;
  withImage: number;
}> {
  const supa = getSupabase();
  const [{ count: total, error: errTotal }, { count: withWeight, error: errW }, { count: withImage, error: errI }] =
    await Promise.all([
      supa.from("gear_items").select("id", { count: "exact", head: true }),
      supa
        .from("gear_items")
        .select("id", { count: "exact", head: true })
        .not("weight_grams", "is", null),
      supa
        .from("gear_items")
        .select("id", { count: "exact", head: true })
        .not("primary_image_url", "is", null),
    ]);

  if (errTotal || errW || errI) {
    throw new Error(
      `[enrichment] coverage count failed: ${errTotal?.message ?? errW?.message ?? errI?.message}`,
    );
  }

  return {
    total: total ?? 0,
    withWeight: withWeight ?? 0,
    withImage: withImage ?? 0,
  };
}
