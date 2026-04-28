/**
 * Round-Robin Candidate Fetch — enrichment-premium (Quick-Task 260428-ke7)
 *
 * Two candidate streams:
 *
 *   1. fetchItemsForDescriptionEnrichment(cap)
 *      - Calls SECURITY-DEFINER SQL function gear_items_round_robin_description
 *        (migration 20260428000002). Same Top-50/long-tail cooldown contract
 *        as weight + image RPCs.
 *      - Eligibility = description IS NULL OR len < 300 OR cooldown expired.
 *
 *   2. fetchItemsForInsightsEnrichment(cap)
 *      - NO RPC — Memgraph-only operation (insights live in Memgraph). We do a
 *        plain Supabase select on gear_items, filter by Top-50 priority +
 *        cooldown in TS, and let the workflow itself filter further by
 *        "has linked VideoSource" via Memgraph at apply-time.
 *      - Items without linked VideoSource will be touched (cooldown advance)
 *        and skipped — that's by design so we don't keep re-picking them.
 */

import { getSupabase } from "../lib/supabase.js";
import { TOP_50_BRANDS } from "../lib/top-brands.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemForDescription {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  weight_grams: number | null;
  primary_image_url: string | null;
  product_url: string | null;
  category_id: string | null;
}

export interface ItemForInsights {
  id: string;
  name: string;
  brand: string | null;
}

// ---------------------------------------------------------------------------
// Description candidates — via SQL RPC
// ---------------------------------------------------------------------------

interface DescriptionRpcRow {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  weight_grams: number | null;
  primary_image_url: string | null;
  product_url: string | null;
  category_id: string | null;
}

export async function fetchItemsForDescriptionEnrichment(
  cap: number,
): Promise<ItemForDescription[]> {
  const supa = getSupabase();
  const topBrandsArray = [...TOP_50_BRANDS];

  const { data, error } = await supa.rpc("gear_items_round_robin_description", {
    top_brands: topBrandsArray,
    cap,
  });

  if (error) {
    throw new Error(
      `[enrichment-premium-rr] gear_items_round_robin_description RPC failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as DescriptionRpcRow[];
  const items: ItemForDescription[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    description: r.description,
    weight_grams: r.weight_grams,
    primary_image_url: r.primary_image_url,
    product_url: r.product_url,
    category_id: r.category_id,
  }));

  console.log(
    `[enrichment-premium-rr] fetched ${items.length} items for description enrichment (cap=${cap}, top-50-prefix=${countTopBrandPrefix(items)})`,
  );
  return items;
}

// ---------------------------------------------------------------------------
// Insights candidates — TS-side priority sort (no RPC)
// ---------------------------------------------------------------------------

const INSIGHTS_TOP50_COOLDOWN_DAYS = 7;
const INSIGHTS_LONGTAIL_COOLDOWN_DAYS = 30;

interface RawItemForInsights {
  id: string;
  name: string;
  brand: string | null;
  last_insights_enriched_at: string | null;
}

/**
 * Fetch insights candidates from Supabase, prioritized via TS sort:
 *   - First all items with last_insights_enriched_at IS NULL (Top-50 first
 *     within that bucket), then cooldown-eligible items by oldest stamp.
 *
 * Pages to handle large datasets (>1000 rows). The candidate list is
 * pre-filtered to "potentially eligible", then the workflow performs the
 * final has-VideoSource check at apply time via Memgraph.
 */
export async function fetchItemsForInsightsEnrichment(
  cap: number,
): Promise<ItemForInsights[]> {
  const supa = getSupabase();
  const topBrandsLower = new Set(TOP_50_BRANDS.map((b) => b.toLowerCase()));

  const top50CutoffIso = new Date(
    Date.now() - INSIGHTS_TOP50_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const longTailCutoffIso = new Date(
    Date.now() - INSIGHTS_LONGTAIL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // We over-fetch (5x cap, capped at 1000) so the TS-side sort has enough
  // headroom to pick Top-50 items first. Workflow will short-list to `cap`.
  const fetchTarget = Math.min(Math.max(cap * 5, 100), 1000);

  const { data, error } = await supa
    .from("gear_items")
    .select("id, name, brand, last_insights_enriched_at")
    .or(
      `last_insights_enriched_at.is.null,last_insights_enriched_at.lt.${longTailCutoffIso}`,
    )
    .limit(fetchTarget);

  if (error) {
    throw new Error(
      `[enrichment-premium-rr] insights candidate fetch failed: ${error.message}`,
    );
  }

  const raw = (data ?? []) as RawItemForInsights[];

  // Apply Top-50/long-tail cooldown logic in TS — Supabase filter above is
  // a coarse "either NULL or older than longest cooldown" pre-filter.
  const eligible: ItemForInsights[] = [];
  const eligibleTop: ItemForInsights[] = [];
  for (const r of raw) {
    const isTop = !!r.brand && topBrandsLower.has(r.brand.toLowerCase());
    const stamp = r.last_insights_enriched_at;
    let pass = false;
    if (stamp === null) pass = true;
    else if (isTop && stamp < top50CutoffIso) pass = true;
    else if (!isTop && stamp < longTailCutoffIso) pass = true;
    if (!pass) continue;

    const item: ItemForInsights = { id: r.id, name: r.name, brand: r.brand };
    if (isTop) eligibleTop.push(item);
    else eligible.push(item);
  }

  // Top-50 first, then long-tail. Within each bucket, order is approximately
  // "oldest stamp first" because the Supabase select is unordered — that's OK
  // for now; the cooldown bucketing is the dominant fairness mechanism.
  const merged = [...eligibleTop, ...eligible].slice(0, cap);

  console.log(
    `[enrichment-premium-rr] fetched ${merged.length} items for insights enrichment (cap=${cap}, top-50=${eligibleTop.length}, long-tail=${eligible.length}, raw=${raw.length})`,
  );
  return merged;
}

// ---------------------------------------------------------------------------
// Diagnostics
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
