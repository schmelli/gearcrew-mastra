/**
 * Reroute Fallback Tips — Phase B of the GearGraph Insights follow-up.
 *
 * After Phase A (memgraph-product-type-backfill) creates HAS_PRODUCT_TYPE
 * edges for previously-untyped GearItems, the existing 626 :Tip nodes that
 * were "fallback-attached" directly to GearItem nodes (because the GearItem
 * had no ProductType at migration time) need to be re-routed:
 *
 *   BEFORE: (g:GearItem)-[:HAS_TIP]->(t:Tip)        // fallback
 *   AFTER:  (pt:ProductType)-[:HAS_TIP]->(t:Tip)    // proper generic-tip placement
 *
 * Conditions for rerouting a (g)-[:HAS_TIP]->(t) edge:
 *   - The GearItem now has at least one HAS_PRODUCT_TYPE edge.
 *   - That ProductType doesn't already have the same Tip attached.
 *
 * Pure graph operation — NO LLM cost.
 *
 * Modes:
 *   "dry-run": count what would migrate, no graph changes
 *   "apply":   reroute
 *
 * Tip-nodes whose GearItem still has no ProductType are LEFT ALONE
 * (they remain as fallbacks until Phase A picks them up later).
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  limit: z.number().int().positive().optional(),
});

const sampleSchema = z.object({
  tip_id: z.string(),
  gear_item: z.string(),
  product_type: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  total_fallback_tips: z.number(),
  reroutable: z.number(),
  rerouted: z.number(),
  edges_deleted: z.number(),
  edges_created: z.number(),
  failed: z.number(),
  duration_seconds: z.number(),
  sample_reroutable: z.array(sampleSchema),
});

// ---------------------------------------------------------------------------
// Memgraph helpers
// ---------------------------------------------------------------------------

async function countFallbackTips(): Promise<number> {
  const session = getReadSession();
  try {
    const r = await session.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(t:Tip)
       RETURN count(*) AS c`,
    );
    return toNumber(r.records[0]?.get("c"));
  } finally {
    await session.close();
  }
}

interface ReroutableSample {
  tip_id: string;
  gear_item: string;
  product_type: string;
}

async function listReroutable(
  limit: number | undefined,
): Promise<{ count: number; samples: ReroutableSample[] }> {
  const session = getReadSession();
  try {
    const countResult = await session.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(t:Tip)
       MATCH (g)-[:HAS_PRODUCT_TYPE]->(:ProductType)
       RETURN count(DISTINCT t) AS c`,
    );
    const count = toNumber(countResult.records[0]?.get("c"));

    const sampleResult = await session.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(t:Tip)
       MATCH (g)-[:HAS_PRODUCT_TYPE]->(pt:ProductType)
       RETURN ID(t) AS tid,
              coalesce(g.brand, '?') AS brand,
              coalesce(g.name, '?') AS name,
              pt.name AS pt_name
       LIMIT 10`,
    );
    const samples: ReroutableSample[] = sampleResult.records.map((r) => ({
      tip_id: String(toNumber(r.get("tid"))),
      gear_item: `${String(r.get("brand") ?? "?")} / ${String(r.get("name") ?? "?")}`,
      product_type: String(r.get("pt_name") ?? "?"),
    }));

    // Optional limit cap on count for caller — if limit is supplied, also reflect
    // it in the count so dry-run + limit reports a consistent number.
    const effectiveCount = limit ? Math.min(count, limit) : count;
    return { count: effectiveCount, samples };
  } finally {
    await session.close();
  }
}

interface RerouteCounts {
  rerouted: number;
  edges_deleted: number;
  edges_created: number;
  failed: number;
}

async function rerouteBatch(batchLimit: number): Promise<RerouteCounts> {
  // Single Cypher pass: for each (g)-[oldEdge:HAS_TIP]->(t) where g has a
  // ProductType, MERGE a new edge from each of the GearItem's ProductTypes
  // to the Tip, then delete the old edge from GearItem.
  //
  // Memgraph caveat: MERGE on multiple ProductType matches (a GearItem
  // could in principle have multiple HAS_PRODUCT_TYPE edges) — we collect
  // them with collect(pt) and FOREACH over the list.
  const session = getWriteSession();
  try {
    const r = await session.run(
      `MATCH (g:GearItem)-[oldEdge:HAS_TIP]->(t:Tip)
       MATCH (g)-[:HAS_PRODUCT_TYPE]->(pt:ProductType)
       WITH g, oldEdge, t, collect(DISTINCT pt) AS pts LIMIT ${batchLimit}
       FOREACH (p IN pts | MERGE (p)-[:HAS_TIP]->(t))
       DELETE oldEdge
       RETURN count(DISTINCT t) AS rerouted,
              count(oldEdge) AS deleted,
              sum(size(pts)) AS created`,
    );
    const rec = r.records[0];
    return {
      rerouted: toNumber(rec?.get("rerouted")),
      edges_deleted: toNumber(rec?.get("deleted")),
      edges_created: toNumber(rec?.get("created")),
      failed: 0,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Workflow step
// ---------------------------------------------------------------------------

const rerouteStep = createStep({
  id: "reroute-fallback-tips",
  description:
    "Re-route :Tip nodes from GearItem to ProductType when the GearItem now has a HAS_PRODUCT_TYPE edge",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const startedAt = Date.now();

    // 1. Count + sample
    const totalFallback = await countFallbackTips();
    const { count: reroutable, samples } = await listReroutable(
      inputData.limit,
    );

    console.log(
      `[reroute-fallback-tips] fallback :Tip total=${totalFallback}, reroutable=${reroutable} (mode=${inputData.mode})`,
    );

    if (inputData.mode === "dry-run" || reroutable === 0) {
      return {
        mode: inputData.mode,
        total_fallback_tips: totalFallback,
        reroutable,
        rerouted: 0,
        edges_deleted: 0,
        edges_created: 0,
        failed: 0,
        duration_seconds: Math.round((Date.now() - startedAt) / 1000),
        sample_reroutable: samples,
      };
    }

    // 2. Apply in chunks of 100
    const chunkSize = 100;
    const cap = inputData.limit ?? reroutable;
    let rerouted = 0;
    let edgesDeleted = 0;
    let edgesCreated = 0;
    let failed = 0;

    while (rerouted + failed < cap) {
      const batchLimit = Math.min(chunkSize, cap - (rerouted + failed));
      try {
        const r = await rerouteBatch(batchLimit);
        rerouted += r.rerouted;
        edgesDeleted += r.edges_deleted;
        edgesCreated += r.edges_created;
        if (r.rerouted === 0) break; // nothing more to do
        console.log(
          `[reroute-fallback-tips] +${r.rerouted} rerouted (deleted=${r.edges_deleted}, created=${r.edges_created}; totals: ${rerouted}/${cap})`,
        );
      } catch (err) {
        failed += batchLimit;
        console.error(
          `[reroute-fallback-tips] batch failed:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }

    return {
      mode: inputData.mode,
      total_fallback_tips: totalFallback,
      reroutable,
      rerouted,
      edges_deleted: edgesDeleted,
      edges_created: edgesCreated,
      failed,
      duration_seconds: Math.round((Date.now() - startedAt) / 1000),
      sample_reroutable: samples,
    };
  },
});

export const rerouteFallbackTips = createWorkflow({
  id: "rerouteFallbackTips",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(rerouteStep)
  .commit();
