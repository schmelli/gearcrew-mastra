/**
 * Round-Robin Enrichment Helpers — Quick-Task 260428-jux
 *
 * Companion module to `enrichment-lite-helpers.ts`. Implements fair
 * round-robin candidate selection so the Gardener does not over-enrich
 * Top-50 brands while starving the long-tail.
 *
 * Selection contract:
 *   - Top-50-brand items: re-enrich earliest 7d after last_*_enriched_at.
 *   - Long-tail items:    re-enrich earliest 30d after last_*_enriched_at.
 *   - NULL columns =      never enriched -> highest priority (NULLS FIRST).
 *
 * The CASE-ORDER-BY priority cannot be expressed via PostgREST, so we invoke
 * the SECURITY-DEFINER SQL functions defined in migration
 * 20260428000001_add_enrichment_timestamp_columns.sql:
 *   - gear_items_round_robin_weight(top_brands text[], cap int)
 *   - gear_items_round_robin_image(top_brands text[], cap int)
 *
 * Touch-helpers bump last_*_enriched_at without changing the value column,
 * used when an enrichment attempt yielded no result and we want the cooldown
 * to advance so the same item is not re-picked next batch.
 */

import { getSupabase } from "../lib/supabase.js";
import { TOP_50_BRANDS } from "../lib/top-brands.js";
import type {
  ItemForWeight,
  ItemForImage,
} from "./enrichment-lite-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoundRobinWeightRow {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
}

interface RoundRobinImageRow {
  id: string;
  name: string;
  brand: string | null;
  product_url: string | null;
}

export interface TouchResult {
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Reads — round-robin priority via SQL function
// ---------------------------------------------------------------------------

/**
 * Fetch up to `cap` items eligible for weight enrichment, prioritized by
 * Top-50 brand membership and oldest cooldown. Eligibility =
 *   (weight_grams IS NULL) OR (cooldown expired per Top-50/long-tail interval).
 */
export async function fetchItemsForWeightEnrichment(
  cap: number,
): Promise<ItemForWeight[]> {
  const supa = getSupabase();
  const topBrandsArray = [...TOP_50_BRANDS];

  const { data, error } = await supa.rpc("gear_items_round_robin_weight", {
    top_brands: topBrandsArray,
    cap,
  });

  if (error) {
    throw new Error(
      `[enrichment-rr] gear_items_round_robin_weight RPC failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as RoundRobinWeightRow[];
  const items: ItemForWeight[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    description: r.description,
  }));

  console.log(
    `[enrichment-rr] fetched ${items.length} items for weight enrichment (cap=${cap}, top-50-first=${countTopBrandPrefix(items)})`,
  );
  return items;
}

/**
 * Fetch up to `cap` items eligible for image enrichment, prioritized by
 * Top-50 brand membership and oldest cooldown. Eligibility =
 *   (primary_image_url IS NULL) OR (cooldown expired per Top-50/long-tail interval).
 */
export async function fetchItemsForImageEnrichment(
  cap: number,
): Promise<ItemForImage[]> {
  const supa = getSupabase();
  const topBrandsArray = [...TOP_50_BRANDS];

  const { data, error } = await supa.rpc("gear_items_round_robin_image", {
    top_brands: topBrandsArray,
    cap,
  });

  if (error) {
    throw new Error(
      `[enrichment-rr] gear_items_round_robin_image RPC failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as RoundRobinImageRow[];
  const items: ItemForImage[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    product_url: r.product_url,
  }));

  console.log(
    `[enrichment-rr] fetched ${items.length} items for image enrichment (cap=${cap}, top-50-first=${countTopBrandPrefix(items)})`,
  );
  return items;
}

// ---------------------------------------------------------------------------
// Touch helpers — advance cooldown without changing value column
// ---------------------------------------------------------------------------

/**
 * Bump only `gear_items.last_weight_enriched_at = now()` for the given item.
 * Used when a weight-enrichment attempt yielded no usable result (no LLM
 * extraction, low-confidence below threshold, fetch failure) and we still
 * want the cooldown clock to advance so the same item is not immediately
 * re-picked in the next batch.
 *
 * NEVER throws. Returns ok=false on Supabase error.
 */
export async function touchWeightEnrichmentTimestamp(
  itemId: string,
  workflowRunId: string,
): Promise<TouchResult> {
  return touchTimestamp(
    itemId,
    "last_weight_enriched_at",
    workflowRunId,
    "weight",
  );
}

/**
 * Bump only `gear_items.last_image_enriched_at = now()` for the given item.
 * See `touchWeightEnrichmentTimestamp` for rationale.
 */
export async function touchImageEnrichmentTimestamp(
  itemId: string,
  workflowRunId: string,
): Promise<TouchResult> {
  return touchTimestamp(
    itemId,
    "last_image_enriched_at",
    workflowRunId,
    "image",
  );
}

async function touchTimestamp(
  itemId: string,
  column:
    | "last_weight_enriched_at"
    | "last_image_enriched_at"
    | "last_description_enriched_at"
    | "last_insights_enriched_at",
  workflowRunId: string,
  kind: "weight" | "image" | "description" | "insights",
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
        `[enrichment-rr] touch ${column} failed for ${itemId} (run=${workflowRunId}): ${error.message}`,
      );
      return { ok: false, reason: `touch_failed: ${error.message}` };
    }

    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[enrichment-rr] touchTimestamp(${kind}) threw for ${itemId} (run=${workflowRunId}): ${reason}`,
    );
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Internal — diagnostics
// ---------------------------------------------------------------------------

function countTopBrandPrefix(
  items: readonly { brand: string | null }[],
): number {
  let n = 0;
  const lookup = new Set(TOP_50_BRANDS.map((b) => b.toLowerCase()));
  for (const it of items) {
    if (it.brand && lookup.has(it.brand.toLowerCase())) n += 1;
    else break;
  }
  return n;
}
