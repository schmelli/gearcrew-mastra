/**
 * Auto-Typing Helpers — Phase 09 / DATA-04 (GEA-1085)
 *
 * Side-helpers for autoTypingFlash workflow that don't belong in the
 * apply-mode file (no Supabase writes here, just reads + sample-result
 * shaping).
 */

import { z } from "zod";
import type { LLMItemResult } from "../lib/auto-typing.js";
import type {
  HighConfidenceItem,
  ReviewQueueItem,
} from "./auto-typing-apply.js";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Constants exported for the main workflow
// ---------------------------------------------------------------------------

export const PRODUCT_TYPE_LEVEL = 3;

// ---------------------------------------------------------------------------
// Sample-result schema (shared with workflow output)
// ---------------------------------------------------------------------------

export const sampleResultSchema = z.object({
  gear_item_id: z.string().uuid(),
  item_name: z.string(),
  suggested_product_type_id: z.string().uuid().nullable(),
  suggested_label: z.string().nullable(),
  confidence: z.number(),
  reasoning: z.string(),
  bucket: z.enum(["high", "low", "failed"]),
});

export type SampleResult = z.infer<typeof sampleResultSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UntypedItem {
  id: string;
  name: string;
  brand: string | null;
  category_legacy: string | null;
  weight_grams: number | null;
  description: string | null;
}

export interface Candidate {
  id: string;
  name: string;
}

interface RawItemTypeCount {
  product_type_id: string | null;
}

interface RawCategoryRow {
  id: string;
  label: string;
}

export interface BatchAccumulator {
  high: HighConfidenceItem[];
  low: ReviewQueueItem[];
  failed: Array<{ result: LLMItemResult; reason: string; item_name: string }>;
  cost_cents: number;
  audit_log_ids: string[];
  batches_processed: number;
  items_processed: number;
}

// ---------------------------------------------------------------------------
// Supabase reads
// ---------------------------------------------------------------------------

/**
 * Read up to `cap` gear_items rows where product_type_id IS NULL. Page through
 * to avoid PostgREST's default 1000-row cap.
 */
export async function fetchUntypedItems(cap: number): Promise<UntypedItem[]> {
  const supa = getSupabase();
  const items: UntypedItem[] = [];
  const PAGE = 1000;
  let from = 0;

  while (items.length < cap) {
    const remaining = cap - items.length;
    const pageSize = Math.min(PAGE, remaining);
    const { data, error } = await supa
      .from("gear_items")
      .select("id, name, brand, category_legacy, weight_grams, description")
      .is("product_type_id", null)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(
        `[auto-typing] gear_items read failed: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    for (const row of data as UntypedItem[]) {
      items.push(row);
      if (items.length >= cap) break;
    }
    if (data.length < pageSize) break;
    from += data.length;
  }

  console.log(
    `[auto-typing] fetched ${items.length} untyped gear_items (cap=${cap})`,
  );
  return items;
}

/**
 * Read top-N categories ranked by gear_items.product_type_id count, level=3.
 * Mirrors fetchTopTypes from type-dedup.ts.
 */
export async function fetchCandidateCategories(
  topN: number,
): Promise<Candidate[]> {
  const supa = getSupabase();
  const counts = new Map<string, number>();
  const PAGE = 1000;
  let from = 0;

  for (;;) {
    const { data, error } = await supa
      .from("gear_items")
      .select("product_type_id")
      .not("product_type_id", "is", null)
      .range(from, from + PAGE - 1);

    if (error) {
      throw new Error(
        `[auto-typing] candidate count read failed: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    for (const row of data as RawItemTypeCount[]) {
      const id = row.product_type_id;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const topIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map((e) => e[0]);

  if (topIds.length === 0) return [];

  const { data: catData, error: catErr } = await supa
    .from("categories")
    .select("id, label, level")
    .in("id", topIds)
    .eq("level", PRODUCT_TYPE_LEVEL);

  if (catErr) {
    throw new Error(
      `[auto-typing] categories read failed: ${catErr.message}`,
    );
  }

  const labelById = new Map<string, string>();
  for (const row of (catData ?? []) as RawCategoryRow[]) {
    labelById.set(row.id, row.label);
  }

  const candidates: Candidate[] = topIds
    .filter((id) => labelById.has(id))
    .map((id) => ({ id, name: labelById.get(id) ?? "" }));

  console.log(
    `[auto-typing] hydrated ${candidates.length} candidate categories (top-${topN}, level=${PRODUCT_TYPE_LEVEL})`,
  );
  return candidates;
}

// ---------------------------------------------------------------------------
// Sample-result selection
// ---------------------------------------------------------------------------

export function buildSampleResults(
  acc: BatchAccumulator,
  itemNameById: Map<string, string>,
): SampleResult[] {
  const samples: SampleResult[] = [];
  for (const it of acc.high.slice(0, 10)) {
    samples.push({
      gear_item_id: it.gear_item_id,
      item_name: itemNameById.get(it.gear_item_id) ?? "",
      suggested_product_type_id: it.suggested_product_type_id,
      suggested_label: it.suggested_label,
      confidence: it.confidence,
      reasoning: it.reasoning,
      bucket: "high",
    });
  }
  for (const it of acc.low.slice(0, 10)) {
    samples.push({
      gear_item_id: it.gear_item_id,
      item_name: itemNameById.get(it.gear_item_id) ?? "",
      suggested_product_type_id: it.suggested_product_type_id,
      suggested_label: it.suggested_label,
      confidence: it.confidence,
      reasoning: it.reasoning,
      bucket: "low",
    });
  }
  for (const f of acc.failed.slice(0, 5)) {
    samples.push({
      gear_item_id: f.result.item_id,
      item_name: f.item_name,
      suggested_product_type_id: f.result.suggested_product_type_id,
      suggested_label: f.result.suggested_label,
      confidence: f.result.confidence,
      reasoning: `${f.reason}: ${f.result.reasoning.slice(0, 120)}`,
      bucket: "failed",
    });
  }
  return samples;
}
