/**
 * Enrichment-Cost-Tracker — shared cost accumulator + per-run telemetry
 *
 * Today every workflow has its own ad-hoc `let costCents = 0; if (... > cap)
 * abort` pattern. This lib consolidates that into:
 *
 *   1. A shared mutable reference (`createCostRef`) so multiple parallel
 *      sub-tasks within one cycle can contribute to the same budget.
 *
 *   2. A pre-action gate (`shouldAbort`) called BEFORE each LLM/HTTP call
 *      that would spend money. Returns true once cumulative cost crosses
 *      `max_cost_cents`.
 *
 *   3. A best-effort telemetry write (`recordRunCost`) that upserts the row
 *      in Supabase `gardener_workflow_runs` so admin dashboards and the next
 *      cycle's cost-cap math can see what was spent. Failure to write
 *      telemetry never throws — it logs and returns.
 *
 * The Supabase target `gardener_workflow_runs` table already exists (see
 * brand-dedup, family-canonical, auto-typing-apply usages — all write run
 * telemetry there). This lib just centralizes the column conventions so all
 * workflows use the same shape.
 */

import { getSupabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Cost reference (mutable accumulator)
// ---------------------------------------------------------------------------

export interface CostRef {
  /** Cumulative cents spent within this cycle so far. */
  cents: number;
  /** Started-at timestamp (Unix ms) for duration reporting. */
  started_at: number;
  /** Optional label embedded in log lines. */
  label: string;
}

/** Create a fresh accumulator. Pass a label that shows up in logs. */
export function createCostRef(label = "cost-tracker"): CostRef {
  return { cents: 0, started_at: Date.now(), label };
}

/** Add cents to the accumulator. Returns the new total. */
export function addCost(ref: CostRef, cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) return ref.cents;
  ref.cents += Math.round(cents);
  return ref.cents;
}

/**
 * Pre-action cap check. Pass `max_cost_cents` (the workflow's cost ceiling).
 * Returns true once cumulative cost has reached or crossed the cap.
 *
 * Concurrency note: the cap is a soft ceiling that may overshoot by
 * `concurrency` calls in the worst case. That's an acceptable trade-off
 * for parallel sub-tasks; if you need a hard guarantee, hold the workflow
 * to concurrency=1 around expensive calls.
 */
export function shouldAbort(ref: CostRef, max_cost_cents: number): boolean {
  if (!Number.isFinite(max_cost_cents) || max_cost_cents <= 0) return false;
  return ref.cents >= max_cost_cents;
}

/** Convert cents to dollars (display-only). */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Run telemetry
// ---------------------------------------------------------------------------

export interface WorkflowRunTelemetry {
  workflow_run_id: string;
  workflow_id: string; // e.g. 'gardenerEnrichmentCycle'
  status: "running" | "completed" | "failed" | "aborted_cost_cap";
  cost_cents: number;
  duration_seconds?: number;
  result_data?: Record<string, unknown>;
  error_message?: string;
}

/**
 * Best-effort UPSERT into `gardener_workflow_runs`. Never throws — failures
 * are logged so the workflow continues even if telemetry is broken.
 *
 * Writes the canonical run row used by all workflows. Schema (existing):
 *   workflow_run_id (uuid PK), workflow_id (text), status (text),
 *   cost_cents (int), duration_seconds (int), result_data (jsonb),
 *   error_message (text), started_at, ended_at, created_at, updated_at.
 */
export async function recordRunCost(
  ref: CostRef,
  workflow_run_id: string,
  workflow_id: string,
  status: WorkflowRunTelemetry["status"] = "running",
  result_data?: Record<string, unknown>,
  error_message?: string,
): Promise<void> {
  const supa = getSupabase();
  const duration_seconds = Math.round((Date.now() - ref.started_at) / 1000);

  const row: Record<string, unknown> = {
    workflow_run_id,
    workflow_id,
    status,
    cost_cents: ref.cents,
    duration_seconds,
  };
  if (result_data !== undefined) row.result_data = result_data;
  if (error_message !== undefined) row.error_message = error_message;
  if (status === "completed" || status === "failed" || status === "aborted_cost_cap") {
    row.ended_at = new Date().toISOString();
  }

  try {
    const { error } = await supa
      .from("gardener_workflow_runs")
      .upsert(row, { onConflict: "workflow_run_id" });
    if (error) {
      console.warn(
        `[cost-tracker:${ref.label}] gardener_workflow_runs upsert failed: ${error.message}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[cost-tracker:${ref.label}] supabase write failed: ${reason}`);
  }
}

/**
 * Convenience: log a periodic cost-progress line. Useful inside long loops.
 */
export function logCostProgress(
  ref: CostRef,
  processed: number,
  total: number,
  max_cost_cents?: number,
): void {
  const elapsed = ((Date.now() - ref.started_at) / 1000).toFixed(0);
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const capStr =
    max_cost_cents !== undefined
      ? `${dollars(ref.cents)}/${dollars(max_cost_cents)}`
      : dollars(ref.cents);
  console.log(
    `[${ref.label}] ${processed}/${total} (${pct}%) cost=${capStr} elapsed=${elapsed}s`,
  );
}
