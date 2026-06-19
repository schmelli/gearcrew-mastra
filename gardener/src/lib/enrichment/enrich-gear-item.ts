/**
 * Core Enrichment Orchestrator — Gardener Copy
 * Phase 27 — ARCH-01: Migrated from winterberry lib/enrichment/enrich-gear-item.ts
 *
 * Orchestrates parallel Serper KG + Catalog search (direct Supabase query),
 * then LLM fallback for remaining gaps.
 *
 * Gardener-native: getSupabase(), raw-fetch AI, relative .js imports, no @/ aliases.
 *
 * D-07 / D-08 Supabase write contract (UI-status-only write):
 *   ON SUCCESS: updates gear_items fields + enrichment_ui_state='done'
 *   ON ERROR:   updates enrichment_ui_state='failed'
 *   enrichment_status is NEVER written — reserved for Phase 29 recountAndGate.
 *
 * T-27-07: every Supabase update on gear_items is scoped .eq('user_id', userId)
 *          to prevent cross-user writes.
 * T-27-10: enrichment_status is NEVER written by this module (grep gate).
 */

import { getSupabase } from "../supabase.js";
import { searchKnowledgeGraph } from "./serper-knowledge-graph.js";
import { extractWithLlm } from "./llm-extraction.js";
import type { KnowledgeGraphResult } from "./serper-knowledge-graph.js";
import type { LlmEnrichmentResult } from "./llm-extraction.js";

// =============================================================================
// Types
// =============================================================================

export interface EnrichableItem {
  name: string;
  brand: string | null;
  description: string | null;
  weightGrams: number | null;
  productTypeId: string | null;
  brandUrl: string | null;
  modelNumber: string | null;
  materials: string | null;
  size: string | null;
  color: string | null;
}

/** Catalog product shape from direct Supabase query */
interface CatalogProductRow {
  id: string;
  name: string;
  description: string | null;
  weight_grams: number | null;
  product_type_id: string | null;
  catalog_brands?: { name: string }[] | { name: string } | null;
}

/** Fields that can be enriched on gear_items (DB column names).
 *  enrichment_status is intentionally excluded (Phase 29 only, T-27-10).
 *  enrichment_ui_state is set by markSuccess/markFailed, not in this payload.
 */
interface EnrichmentUpdatePayload {
  brand?: string;
  description?: string;
  weight_grams?: number;
  brand_url?: string;
  model_number?: string;
  materials?: string;
  size?: string;
  color?: string;
  enrichment_ui_state: "done";
}

// =============================================================================
// Constants
// =============================================================================

const OVERALL_TIMEOUT_MS = 30_000;

class EnrichmentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichmentTimeoutError";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EnrichmentTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// =============================================================================
// Query Builder
// =============================================================================

function buildSearchQuery(name: string, brand: string | null): string {
  const base = brand ? `${brand} ${name}` : name;
  return `"${base}" outdoor gear specifications`;
}

// =============================================================================
// Catalog Search (direct Supabase query — no fuzzyProductSearch PostgREST dep)
// =============================================================================

interface CatalogSearchResult {
  brand: string | null;
  description: string | null;
  weightGrams: number | null;
  productTypeId: string | null;
  score: number;
}

/**
 * Direct catalog_products query against Supabase.
 * Replaces winterberry's fuzzyProductSearch (which depended on @/lib/supabase/catalog).
 * Uses ILIKE for case-insensitive match — no PostgREST join syntax.
 * T-27-07: service-role reads are safe (read-only here, no user_id scope needed on SELECT).
 */
async function searchCatalog(
  itemName: string,
  limit = 3,
): Promise<CatalogSearchResult[]> {
  try {
    const supa = getSupabase();
    const { data, error } = await supa
      .from("catalog_products")
      .select(
        "id, name, description, weight_grams, product_type_id, catalog_brands(name)",
      )
      .ilike("name", `%${itemName.slice(0, 40)}%`)
      .limit(limit);

    if (error || !data) {
      console.warn(
        "[enrich-gear-item] catalog query failed:",
        error?.message ?? "no data",
      );
      return [];
    }

    return (data as CatalogProductRow[]).map((row, idx) => {
      // Supabase returns join as array when using select with related table
      const brandsRaw = row.catalog_brands;
      const brandName = Array.isArray(brandsRaw)
        ? (brandsRaw[0]?.name ?? null)
        : (brandsRaw as { name: string } | null)?.name ?? null;
      return {
        brand: brandName,
        description: row.description,
        weightGrams: row.weight_grams,
        productTypeId: row.product_type_id,
        score: 1 - idx * 0.1, // simple positional scoring
      };
    });
  } catch (err) {
    console.warn(
      "[enrich-gear-item] catalog search threw:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

// =============================================================================
// Merge Helpers
// =============================================================================

function mergeCatalogResult(
  state: EnrichableItem,
  catalog: CatalogSearchResult,
): void {
  if (!state.brand && catalog.brand) {
    state.brand = catalog.brand;
  }
  if (!state.description && catalog.description) {
    state.description = catalog.description;
  }
  if (state.weightGrams === null && catalog.weightGrams !== null) {
    state.weightGrams = catalog.weightGrams;
  }
  if (!state.productTypeId && catalog.productTypeId) {
    state.productTypeId = catalog.productTypeId;
  }
}

function mergeKgResult(
  state: EnrichableItem,
  kg: KnowledgeGraphResult,
): void {
  if (!state.brand && kg.brand) state.brand = kg.brand;
  if (!state.description && kg.description) state.description = kg.description;
  if (state.weightGrams === null && kg.weightGrams !== null)
    state.weightGrams = kg.weightGrams;
  if (!state.materials && kg.materials) state.materials = kg.materials;
}

function mergeLlmResult(
  state: EnrichableItem,
  llm: LlmEnrichmentResult,
): void {
  if (!state.brand && llm.brand) state.brand = llm.brand;
  if (!state.description && llm.description) state.description = llm.description;
  if (state.weightGrams === null && llm.weightGrams !== null)
    state.weightGrams = llm.weightGrams;
  if (!state.materials && llm.materials) state.materials = llm.materials;
  if (!state.modelNumber && llm.modelNumber) state.modelNumber = llm.modelNumber;
  if (!state.size && llm.size) state.size = llm.size;
  if (!state.color && llm.color) state.color = llm.color;
}

function hasCriticalGaps(state: EnrichableItem): boolean {
  return !state.brand || !state.description || state.weightGrams === null;
}

// =============================================================================
// Diff Builder
// =============================================================================

function buildUpdatePayload(
  original: EnrichableItem,
  enriched: EnrichableItem,
): EnrichmentUpdatePayload {
  // enrichment_ui_state: 'done' is always included (UI-status-only write, D-08)
  // enrichment_status is NEVER included (T-27-10, Phase 29 only)
  const payload: EnrichmentUpdatePayload = { enrichment_ui_state: "done" };

  if (!original.brand && enriched.brand) payload.brand = enriched.brand;
  if (!original.description && enriched.description)
    payload.description = enriched.description;
  if (original.weightGrams === null && enriched.weightGrams !== null)
    payload.weight_grams = enriched.weightGrams;
  if (!original.brandUrl && enriched.brandUrl)
    payload.brand_url = enriched.brandUrl;
  if (!original.modelNumber && enriched.modelNumber)
    payload.model_number = enriched.modelNumber;
  if (!original.materials && enriched.materials)
    payload.materials = enriched.materials;
  if (!original.size && enriched.size) payload.size = enriched.size;
  if (!original.color && enriched.color) payload.color = enriched.color;

  return payload;
}

// =============================================================================
// Core Enrichment Logic
// =============================================================================

async function runEnrichment(
  itemId: string,
  userId: string,
  item: EnrichableItem,
): Promise<void> {
  console.log(
    `[enrich-gear-item] Starting enrichment itemId=${itemId} name="${item.name}"`,
  );

  const state: EnrichableItem = { ...item };
  const query = buildSearchQuery(item.name, item.brand);

  // --- Parallel Serper KG + Catalog search ---
  const [kgSettled, catalogSettled] = await Promise.allSettled([
    searchKnowledgeGraph(query),
    searchCatalog(item.name),
  ]);

  const kgResult: KnowledgeGraphResult | null =
    kgSettled.status === "fulfilled" ? kgSettled.value : null;
  const catalogResults: CatalogSearchResult[] =
    catalogSettled.status === "fulfilled" ? catalogSettled.value : [];

  if (kgSettled.status === "rejected") {
    console.warn(
      "[enrich-gear-item] KG search rejected:",
      kgSettled.reason instanceof Error
        ? kgSettled.reason.message
        : String(kgSettled.reason),
    );
  }
  if (catalogSettled.status === "rejected") {
    console.warn(
      "[enrich-gear-item] Catalog search rejected:",
      catalogSettled.reason instanceof Error
        ? catalogSettled.reason.message
        : String(catalogSettled.reason),
    );
  }

  // Merge with priority: Catalog > KG > existing
  const topCatalogMatch = catalogResults[0] ?? null;
  if (topCatalogMatch) {
    mergeCatalogResult(state, topCatalogMatch);
  }
  if (kgResult) {
    mergeKgResult(state, kgResult);
  }

  // --- LLM fallback if critical gaps remain ---
  if (hasCriticalGaps(state)) {
    const llmResult = await extractWithLlm({
      name: item.name,
      brand: state.brand,
      category: state.productTypeId,
      searchSnippets: kgResult?.searchSnippets ?? [],
      knowledgeGraphAttributes: kgResult?.attributes ?? {},
    });
    mergeLlmResult(state, llmResult);
  }

  // --- Build and apply update ---
  const payload = buildUpdatePayload(item, state);
  const changedFieldCount = Object.keys(payload).length - 1; // minus enrichment_ui_state
  console.log(
    `[enrich-gear-item] Updating gear item itemId=${itemId} changedFields=${changedFieldCount}`,
  );

  // T-27-07: scoped by both id AND user_id — defense-in-depth ownership check
  const supa = getSupabase();
  const { error: updateError } = await supa
    .from("gear_items")
    .update(payload)
    .eq("id", itemId)
    .eq("user_id", userId);

  if (updateError) {
    console.error(
      "[enrich-gear-item] DB update failed:",
      updateError.message,
    );
    // Escalate so the outer catch sets enrichment_ui_state='failed'
    throw new Error(`DB update failed: ${updateError.message}`);
  }

  console.log(
    `[enrich-gear-item] Enrichment complete itemId=${itemId} changedFields=${changedFieldCount}`,
  );
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Enrich a gear item by running parallel Serper KG + Catalog search,
 * then LLM fallback for remaining gaps.
 *
 * UI-status-only write: sets enrichment_ui_state='done' on success,
 * 'failed' on any error. enrichment_status is NEVER written (T-27-10).
 * Never throws.
 */
export async function enrichGearItem(
  itemId: string,
  userId: string,
  item: EnrichableItem,
): Promise<void> {
  try {
    await withTimeout(
      runEnrichment(itemId, userId, item),
      OVERALL_TIMEOUT_MS,
      "enrichGearItem",
    );
  } catch (error) {
    console.error(
      "[enrich-gear-item] Enrichment failed, marking failed",
      { itemId, itemName: item.name },
      error instanceof Error ? error.message : String(error),
    );
    // T-27-07: user_id scope on failure write
    await markFailed(itemId, userId);
  }
}

/**
 * Mark enrichment as failed — UI-status-only write.
 * Sets enrichment_ui_state='failed' scoped by user_id (T-27-07).
 * Never throws.
 */
async function markFailed(itemId: string, userId: string): Promise<void> {
  try {
    // T-27-07: both id and user_id scoped
    await getSupabase()
      .from("gear_items")
      .update({ enrichment_ui_state: "failed" })
      .eq("id", itemId)
      .eq("user_id", userId);
  } catch (fallbackError) {
    console.error(
      "[enrich-gear-item] Failed to mark enrichment_ui_state='failed' (fallback):",
      fallbackError instanceof Error
        ? fallbackError.message
        : String(fallbackError),
    );
  }
}
