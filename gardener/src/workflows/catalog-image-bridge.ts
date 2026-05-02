/**
 * Catalog → Memgraph Image-Bridge Workflow
 *
 * Quick-Task 260502-catalog-image-bridge.
 *
 * Lifts Memgraph image_url coverage by stamping `image_url` + `product_url`
 * + `supabase_id` onto :GearItem nodes that match a `catalog_products` row
 * by case-insensitive (brand, name).
 *
 * Re-uses the 3-stage matcher (`findMemgraphMatch`) from the existing
 * supabaseMemgraphBridge workflow. Only writes image_url/product_url when
 * the node currently has them as NULL — never clobbers existing values.
 *
 * Two modes:
 *   - "dry-run": report match counts + projected stamp counts, no writes
 *   - "apply":   stamp matched nodes
 *
 * No LLM calls, no cost. Read Supabase + Memgraph, write Memgraph only.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { getReadSession, getWriteSession } from "../lib/memgraph.js";
import {
  findMemgraphMatch,
  stampCatalogImage,
  ensureBridgeIndex,
  type SupabaseGearItem,
  type BridgeMatchResult,
} from "../lib/bridge-matcher.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
});

const sampleSchema = z.object({
  supabase_id: z.string(),
  brand: z.string(),
  name: z.string(),
  outcome: z.enum(["matched", "unmatched", "ambiguous"]),
  match_count: z.number(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_supabase_items: z.number(),
  matched: z.number(),
  unmatched: z.number(),
  ambiguous: z.number(),
  stamped: z.number(),
  image_url_filled: z.number(),
  product_url_filled: z.number(),
  index_created: z.boolean(),
  sample_unmatched: z.array(sampleSchema),
  sample_ambiguous: z.array(sampleSchema),
});

interface CatalogRow {
  id: string;
  name: string;
  product_url: string | null;
  image_url: string | null;
  catalog_brands: { name: string } | null;
}

const matchAndStampStep = createStep({
  id: "match-and-stamp-catalog-image",
  description:
    "Fetch Supabase catalog_products with image_url, find Memgraph matches by (brand, name), stamp image_url/product_url/supabase_id on matched nodes",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const supa = getSupabase();
    const startedAt = new Date().toISOString();

    // Supabase JS client paginates via `.range(from, to)` (max 1000 rows per
    // page by default). We page through all matching rows so the workflow
    // sees the full catalog, not just the first page.
    const PAGE = 1000;
    const cap = inputData.limit ?? Number.MAX_SAFE_INTEGER;
    const catalog: CatalogRow[] = [];
    let from = 0;
    while (catalog.length < cap) {
      const to = from + Math.min(PAGE, cap - catalog.length) - 1;
      const { data: page, error: fetchErr } = await supa
        .from("catalog_products")
        .select(
          "id, name, product_url, image_url, catalog_brands(name)",
        )
        .not("image_url", "is", null)
        .not("name", "is", null)
        .order("created_at", { ascending: true })
        .range(from, to);
      if (fetchErr) {
        throw new Error(
          `[catalog-image-bridge] Supabase fetch failed at range(${from},${to}): ${fetchErr.message}`,
        );
      }
      const rows = (page ?? []) as unknown as CatalogRow[];
      catalog.push(...rows);
      if (rows.length < PAGE) break; // last page
      from = to + 1;
    }

    // Map to the shape expected by findMemgraphMatch.
    const items: Array<SupabaseGearItem & { catalog: CatalogRow }> = catalog
      .filter((row) => row.catalog_brands?.name)
      .map((row) => ({
        id: row.id,
        brand: row.catalog_brands!.name,
        name: row.name,
        catalog: row,
      }));

    console.log(
      `[catalog-image-bridge] starting mode=${inputData.mode} items=${items.length} at=${startedAt}`,
    );

    let matched = 0;
    let unmatched = 0;
    let ambiguous = 0;
    let stamped = 0;
    let imageUrlFilled = 0;
    let productUrlFilled = 0;
    let indexCreated = false;
    const sampleUnmatched: BridgeMatchResult[] = [];
    const sampleAmbiguous: BridgeMatchResult[] = [];

    if (inputData.mode === "apply") {
      const idxSess = getWriteSession();
      try {
        await ensureBridgeIndex(idxSess);
        indexCreated = true;
      } finally {
        await idxSess.close();
      }
    }

    const readSess = getReadSession();
    const writeSess = inputData.mode === "apply" ? getWriteSession() : null;

    try {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const result = await findMemgraphMatch(readSess, item);

        switch (result.outcome) {
          case "matched":
            matched += 1;
            if (inputData.mode === "apply" && writeSess && result.memgraph_node_id !== null) {
              const outcome = await stampCatalogImage(
                writeSess,
                result.memgraph_node_id,
                {
                  supabase_id: item.id,
                  image_url: item.catalog.image_url,
                  product_url: item.catalog.product_url,
                },
              );
              stamped += 1;
              if (outcome.image_url_set) imageUrlFilled += 1;
              if (outcome.product_url_set) productUrlFilled += 1;
            }
            break;
          case "unmatched":
            unmatched += 1;
            if (sampleUnmatched.length < 20) sampleUnmatched.push(result);
            break;
          case "ambiguous":
            ambiguous += 1;
            if (sampleAmbiguous.length < 20) sampleAmbiguous.push(result);
            break;
        }

        if ((i + 1) % 200 === 0 || i === items.length - 1) {
          console.log(
            `[catalog-image-bridge] progress ${i + 1}/${items.length} matched=${matched} unmatched=${unmatched} ambiguous=${ambiguous} stamped=${stamped} image_filled=${imageUrlFilled} url_filled=${productUrlFilled}`,
          );
        }
      }
    } finally {
      await readSess.close();
      if (writeSess) await writeSess.close();
    }

    console.log(
      `[catalog-image-bridge] done mode=${inputData.mode} matched=${matched} unmatched=${unmatched} ambiguous=${ambiguous} stamped=${stamped} image_filled=${imageUrlFilled} url_filled=${productUrlFilled}`,
    );

    return {
      mode: inputData.mode,
      total_supabase_items: items.length,
      matched,
      unmatched,
      ambiguous,
      stamped,
      image_url_filled: imageUrlFilled,
      product_url_filled: productUrlFilled,
      index_created: indexCreated,
      sample_unmatched: sampleUnmatched.map((r) => ({
        supabase_id: r.supabase_id,
        brand: r.brand,
        name: r.name,
        outcome: r.outcome,
        match_count: r.match_count,
      })),
      sample_ambiguous: sampleAmbiguous.map((r) => ({
        supabase_id: r.supabase_id,
        brand: r.brand,
        name: r.name,
        outcome: r.outcome,
        match_count: r.match_count,
      })),
    };
  },
});

export const catalogImageBridge = createWorkflow({
  id: "catalogImageBridge",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(matchAndStampStep)
  .commit();
