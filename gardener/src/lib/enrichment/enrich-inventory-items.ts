/**
 * enrichInventoryItems — Background catalog enrichment for CSV-imported gear
 * Gardener Copy — Phase 27 — ARCH-01: Migrated from winterberry lib/enrichment/enrich-inventory-items.ts
 *
 * Runs background enrichment for freshly-inserted gear_items rows.
 * Uses quickResearchItem to resolve a brand from the item name.
 *
 * Gardener-native: getSupabase(), relative .js imports, p-limit already installed.
 *
 * UI-status-only write: sets enrichment_ui_state='done' after research (success or no-result).
 * enrichment_status is NEVER written (T-27-10, Phase 29 only).
 *
 * T-27-07: every update is scoped .eq('id', row.id).eq('user_id', userId)
 *          — no cross-user write surface.
 */

import pLimit from "p-limit";
import { getSupabase } from "../supabase.js";
import { quickResearchItem } from "./quick-research-import.js";

/** The gear_items columns the enrichment reads back for each inserted row. */
interface EnrichTargetRow {
  id: string;
  name: string;
  brand: string | null;
  product_type_id: string | null;
}

/** Concurrency cap for background research. */
const ENRICH_CONCURRENCY = 3;

/**
 * Background-enrich the given freshly-inserted gear_items rows.
 *
 * For each inserted id (re-fetched user-scoped to confirm ownership), run
 * quickResearchItem to resolve a brand from the item name and, when found,
 * write gear_items.brand + enrichment_ui_state='done'.
 *
 * Items that already have a brand or yield no research result are still
 * marked with enrichment_ui_state='done' so the UI settles.
 *
 * @param userId - The owning user's id; every read/write is scoped to it (T-27-07).
 * @param insertedIds - The ids returned from the user-scoped CSV insert.
 */
export async function enrichInventoryItems(
  userId: string,
  insertedIds: string[],
): Promise<void> {
  if (insertedIds.length === 0) return;

  const supa = getSupabase();

  // Re-read the inserted rows, scoped to BOTH the id set AND the owning user
  // (defense in depth — T-27-07).
  const { data, error } = await supa
    .from("gear_items")
    .select("id, name, brand, product_type_id")
    .eq("user_id", userId)
    .in("id", insertedIds);

  if (error || !data) return;

  const targets = data as EnrichTargetRow[];
  const limit = pLimit(ENRICH_CONCURRENCY);

  await Promise.allSettled(
    targets.map((row) =>
      limit(async () => {
        // Skip rows that already carry a brand — nothing to enrich.
        if (row.brand && row.brand.trim().length > 0) {
          // Still mark as done so UI settles
          await supa
            .from("gear_items")
            .update({ enrichment_ui_state: "done" })
            .eq("id", row.id)
            .eq("user_id", userId);
          return;
        }
        if (!row.name.trim()) return;

        // enrichment_status is intentionally excluded (T-27-10)
        const updates: { brand?: string; enrichment_ui_state: string } = {
          enrichment_ui_state: "done",
        };

        try {
          const result = await quickResearchItem(row.name, null);
          if (result?.brand) {
            updates.brand = result.brand;
          }
        } catch (researchError) {
          console.error(
            "[enrichInventoryItems] research failed for",
            row.id,
            researchError instanceof Error
              ? researchError.message
              : String(researchError),
          );
        }

        // T-27-07: strictly scoped to this user's own inserted row
        await supa
          .from("gear_items")
          .update(updates)
          .eq("id", row.id)
          .eq("user_id", userId);
      }),
    ),
  );
}
