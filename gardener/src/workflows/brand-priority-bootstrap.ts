/**
 * Brand-Priority Bootstrap — one-time / occasionally-rerun migration that
 * stamps the canonical Top-50 list (`lib/top-brands.ts`) onto :OutdoorBrand
 * nodes as `b.is_top50 = true`.
 *
 * Why a workflow and not a script? Because we need it triggerable from the
 * same Mastra HTTP-API the rest of the gardener uses, with the same logging
 * and error-surface. It's idempotent — running it again only flips the flag
 * for newly-matching brands and clears it on any brand that fell out of the
 * canonical list. Safe to invoke whenever the top-brands list changes.
 *
 * The match is case-insensitive against `b.name` (canonical-list casing is
 * not always identical to graph casing — "Therm-a-Rest" vs "Therm-A-Rest").
 *
 * No LLM, no cost, no side effects beyond Memgraph property writes.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";
import { TOP_50_BRANDS } from "../lib/top-brands.js";

const triggerSchema = z.object({
  /** Dry-run: report match counts but do not modify Memgraph. */
  dryRun: z.boolean().default(false),
});

const outputSchema = z.object({
  total_brands_canonical: z.number(),
  matched_in_graph: z.number(),
  newly_marked: z.number(),
  unmarked_no_longer_top50: z.number(),
  unmatched_in_graph: z.array(z.string()),
  dry_run: z.boolean(),
});

const bootstrapStep = createStep({
  id: "stamp-top50-flag",
  description:
    "Match TOP_50_BRANDS canonical list to :OutdoorBrand nodes case-insensitively, set b.is_top50=true; clear flag on brands that fell out of the list.",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const dryRun = inputData.dryRun;

    // ---- Step 1: lookup Memgraph node IDs for every canonical brand ----
    // Cypher has no IN-with-toLower aggregation, so we pass the lowercased
    // canonical list and match on toLower(b.name). Returning name preserves
    // the graph-side casing for diagnostic output.
    const lowerNames: string[] = TOP_50_BRANDS.map((b) => b.toLowerCase());
    const lookupCypher = `
MATCH (b:OutdoorBrand)
WHERE toLower(b.name) IN $lowerNames
RETURN ID(b) AS node_id, b.name AS name, coalesce(b.is_top50, false) AS already_top50
`.trim();

    const readSess = getReadSession();
    let matched: Array<{ node_id: number; name: string; already_top50: boolean }> = [];
    try {
      const res = await readSess.run(lookupCypher, { lowerNames });
      matched = res.records.map((r) => ({
        node_id: toNumber(r.get("node_id")),
        name: String(r.get("name")),
        already_top50: Boolean(r.get("already_top50")),
      }));
    } finally {
      await readSess.close();
    }

    // Brands in the canonical list that are NOT in the graph (data hint —
    // either brand renamed, missing :OutdoorBrand node, or casing-drift
    // beyond what toLower covers).
    const matchedLower = new Set(matched.map((m) => m.name.toLowerCase()));
    const unmatched_in_graph = TOP_50_BRANDS.filter(
      (canonical) => !matchedLower.has(canonical.toLowerCase()),
    );

    // ---- Step 2: find existing top50 nodes that are no longer in the list ----
    const staleCypher = `
MATCH (b:OutdoorBrand)
WHERE coalesce(b.is_top50, false) = true
  AND NOT toLower(b.name) IN $lowerNames
RETURN ID(b) AS node_id, b.name AS name
`.trim();

    const readSess2 = getReadSession();
    let stale: Array<{ node_id: number; name: string }> = [];
    try {
      const res = await readSess2.run(staleCypher, { lowerNames });
      stale = res.records.map((r) => ({
        node_id: toNumber(r.get("node_id")),
        name: String(r.get("name")),
      }));
    } finally {
      await readSess2.close();
    }

    const newlyMarked = matched.filter((m) => !m.already_top50).length;

    // ---- Step 3: apply changes (unless dry-run) ----
    if (!dryRun) {
      const writeSess = getWriteSession();
      try {
        if (matched.length > 0) {
          await writeSess.run(
            `
UNWIND $ids AS id
MATCH (b:OutdoorBrand) WHERE ID(b) = id
SET b.is_top50 = true, b.priority_tier = 'top50'
`.trim(),
            { ids: matched.map((m) => m.node_id) },
          );
        }
        if (stale.length > 0) {
          await writeSess.run(
            `
UNWIND $ids AS id
MATCH (b:OutdoorBrand) WHERE ID(b) = id
SET b.is_top50 = false, b.priority_tier = 'longtail'
`.trim(),
            { ids: stale.map((s) => s.node_id) },
          );
        }
      } finally {
        await writeSess.close();
      }
    }

    console.log(
      `[brand-priority-bootstrap] dryRun=${dryRun} canonical=${TOP_50_BRANDS.length} matched=${matched.length} newly_marked=${newlyMarked} unmarked_stale=${stale.length} unmatched_in_graph=${unmatched_in_graph.length}`,
    );
    if (unmatched_in_graph.length > 0) {
      console.log(
        `[brand-priority-bootstrap] unmatched canonical brands (not in graph or casing-drift): ${unmatched_in_graph.join(", ")}`,
      );
    }

    return {
      total_brands_canonical: TOP_50_BRANDS.length,
      matched_in_graph: matched.length,
      newly_marked: newlyMarked,
      unmarked_no_longer_top50: stale.length,
      unmatched_in_graph,
      dry_run: dryRun,
    };
  },
});

export const brandPriorityBootstrap = createWorkflow({
  id: "brandPriorityBootstrap",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(bootstrapStep)
  .commit();
