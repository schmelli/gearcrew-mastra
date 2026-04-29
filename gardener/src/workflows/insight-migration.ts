/**
 * Insight Migration — Phase 2 of the 3-level insights restructure.
 *
 * Reads classification_scope (set by Phase 1: tip-classification) and
 * restructures the graph:
 *
 *   SPECIFIC → :Insight → :ProductInsight; HAS_TIP → HAS_INSIGHT (at GearItem)
 *   FAMILY   → :Insight → :ProductInsight; edge re-routed
 *              FROM (GearItem)-[:HAS_TIP]->
 *              TO   (ProductFamily)-[:HAS_INSIGHT]->
 *              Fallback: if no ProductFamily, treat as SPECIFIC (keep at GearItem)
 *   GENERIC  → :Insight → :Tip; edge re-routed
 *              FROM (GearItem)-[:HAS_TIP]->
 *              TO   (ProductType)-[:HAS_TIP]->
 *              Fallback: if no ProductType, keep at GearItem
 *   AMBIGUOUS → unchanged (preserved for human review)
 *
 * Modes:
 *   "dry-run": count what would migrate, no graph changes
 *   "apply":   migrate
 *
 * Idempotency: queries match :Insight label. Once a node is relabeled to
 * :ProductInsight or :Tip, it's no longer matched by subsequent runs.
 *
 * Targets:
 *   "specific" | "family" | "generic" | "all"
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { getReadSession, getWriteSession, toNumber } from "../lib/memgraph.js";

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  target: z
    .enum(["specific", "family", "generic", "all"])
    .default("all"),
  limit: z.number().int().positive().optional(),
});

const targetResultSchema = z.object({
  candidates: z.number(),
  migrated: z.number(),
  fallback_no_parent: z.number(), // family with no ProductFamily, OR generic with no ProductType
  failed: z.number(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  target: z.enum(["specific", "family", "generic", "all"]),
  specific: targetResultSchema,
  family: targetResultSchema,
  generic: targetResultSchema,
  duration_seconds: z.number(),
});

interface MigrationCounts {
  candidates: number;
  migrated: number;
  fallback_no_parent: number;
  failed: number;
}

const empty = (): MigrationCounts => ({
  candidates: 0,
  migrated: 0,
  fallback_no_parent: 0,
  failed: 0,
});

// ---------------------------------------------------------------------------
// SPECIFIC: relabel + edge-type change at GearItem
// ---------------------------------------------------------------------------

async function migrateSpecific(
  dryRun: boolean,
  limit?: number,
): Promise<MigrationCounts> {
  const counts = empty();

  // 1. Count candidates first.
  const readSess = getReadSession();
  try {
    const r = await readSess.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(i:Insight)
       WHERE i.classification_scope = 'SPECIFIC'
       RETURN count(i) AS c`,
    );
    counts.candidates = toNumber(r.records[0]?.get("c"));
  } finally {
    await readSess.close();
  }
  if (dryRun || counts.candidates === 0) return counts;

  // 2. Apply: process in chunks of 100 to avoid Memgraph long-tx issues.
  const chunkSize = 100;
  const totalToProcess = limit
    ? Math.min(limit, counts.candidates)
    : counts.candidates;

  while (counts.migrated + counts.failed < totalToProcess) {
    const batchLimit = Math.min(
      chunkSize,
      totalToProcess - (counts.migrated + counts.failed),
    );
    const writeSess = getWriteSession();
    try {
      const r = await writeSess.run(
        `MATCH (g:GearItem)-[oldEdge:HAS_TIP]->(i:Insight)
         WHERE i.classification_scope = 'SPECIFIC'
         WITH g, oldEdge, i LIMIT ${batchLimit}
         SET i:ProductInsight
         REMOVE i:Insight
         DELETE oldEdge
         WITH g, i
         MERGE (g)-[:HAS_INSIGHT]->(i)
         RETURN count(i) AS migrated`,
      );
      const migrated = toNumber(r.records[0]?.get("migrated"));
      counts.migrated += migrated;
      if (migrated === 0) break; // no more to do
      console.log(
        `[migration:specific] migrated +${migrated} (total ${counts.migrated}/${totalToProcess})`,
      );
    } catch (err) {
      counts.failed += batchLimit;
      console.error(
        `[migration:specific] batch failed:`,
        err instanceof Error ? err.message : err,
      );
      break;
    } finally {
      await writeSess.close();
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// FAMILY: re-route to ProductFamily; fallback to GearItem
// ---------------------------------------------------------------------------

async function migrateFamily(
  dryRun: boolean,
  limit?: number,
): Promise<MigrationCounts> {
  const counts = empty();

  const readSess = getReadSession();
  try {
    const r = await readSess.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(i:Insight)
       WHERE i.classification_scope = 'FAMILY'
       RETURN count(i) AS c`,
    );
    counts.candidates = toNumber(r.records[0]?.get("c"));
  } finally {
    await readSess.close();
  }
  if (dryRun || counts.candidates === 0) return counts;

  const chunkSize = 100;
  const totalToProcess = limit
    ? Math.min(limit, counts.candidates)
    : counts.candidates;

  while (counts.migrated + counts.fallback_no_parent + counts.failed < totalToProcess) {
    const batchLimit = Math.min(
      chunkSize,
      totalToProcess - (counts.migrated + counts.fallback_no_parent + counts.failed),
    );
    const writeSess = getWriteSession();
    try {
      // Two-stage approach: stage 1 routes to ProductFamily where it exists;
      // stage 2 picks the leftovers and routes them to GearItem (fallback).
      // We do them in a single run() with two queries via session.run only
      // executes one query — so split into separate calls per stage.

      // Stage 1: with ProductFamily
      const r1 = await writeSess.run(
        `MATCH (g:GearItem)-[oldEdge:HAS_TIP]->(i:Insight)
         WHERE i.classification_scope = 'FAMILY'
         MATCH (pf:ProductFamily)-[:HAS_VARIANT]->(g)
         WITH g, oldEdge, i, pf LIMIT ${batchLimit}
         SET i:ProductInsight
         REMOVE i:Insight
         DELETE oldEdge
         WITH i, pf
         MERGE (pf)-[:HAS_INSIGHT]->(i)
         RETURN count(i) AS migrated`,
      );
      const migrated = toNumber(r1.records[0]?.get("migrated"));
      counts.migrated += migrated;

      // Stage 2: fallback (no ProductFamily) — treat as SPECIFIC
      const remaining = batchLimit - migrated;
      if (remaining > 0) {
        const r2 = await writeSess.run(
          `MATCH (g:GearItem)-[oldEdge:HAS_TIP]->(i:Insight)
           WHERE i.classification_scope = 'FAMILY'
             AND NOT EXISTS((:ProductFamily)-[:HAS_VARIANT]->(g))
           WITH g, oldEdge, i LIMIT ${remaining}
           SET i:ProductInsight
           REMOVE i:Insight
           DELETE oldEdge
           WITH g, i
           MERGE (g)-[:HAS_INSIGHT]->(i)
           RETURN count(i) AS fallback`,
        );
        const fallback = toNumber(r2.records[0]?.get("fallback"));
        counts.fallback_no_parent += fallback;
      }

      const totalThisBatch = migrated + (counts.fallback_no_parent + counts.migrated - (counts.migrated + counts.fallback_no_parent - migrated - counts.fallback_no_parent));
      // Defensive: if both stages produced 0, break out
      if (migrated === 0 && (batchLimit - migrated) === 0) break;
      if (migrated === 0 && counts.fallback_no_parent === 0 && counts.candidates > 0) {
        // Stage 1 returned 0; stage 2 might too. Re-check loop condition next iteration.
      }

      console.log(
        `[migration:family] migrated=+${migrated} fallback=+${remaining > 0 ? "(stage 2 ran)" : "0"} (totals: migrated=${counts.migrated} fallback=${counts.fallback_no_parent})`,
      );

      // Sanity: if neither stage made progress, break to avoid infinite loop
      if (totalThisBatch === 0) break;
    } catch (err) {
      counts.failed += batchLimit;
      console.error(
        `[migration:family] batch failed:`,
        err instanceof Error ? err.message : err,
      );
      break;
    } finally {
      await writeSess.close();
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// GENERIC: re-route to ProductType; fallback to GearItem
// ---------------------------------------------------------------------------

async function migrateGeneric(
  dryRun: boolean,
  limit?: number,
): Promise<MigrationCounts> {
  const counts = empty();

  const readSess = getReadSession();
  try {
    const r = await readSess.run(
      `MATCH (g:GearItem)-[:HAS_TIP]->(i:Insight)
       WHERE i.classification_scope = 'GENERIC'
       RETURN count(i) AS c`,
    );
    counts.candidates = toNumber(r.records[0]?.get("c"));
  } finally {
    await readSess.close();
  }
  if (dryRun || counts.candidates === 0) return counts;

  const chunkSize = 100;
  const totalToProcess = limit
    ? Math.min(limit, counts.candidates)
    : counts.candidates;

  while (counts.migrated + counts.fallback_no_parent + counts.failed < totalToProcess) {
    const batchLimit = Math.min(
      chunkSize,
      totalToProcess - (counts.migrated + counts.fallback_no_parent + counts.failed),
    );
    const writeSess = getWriteSession();
    try {
      // Stage 1: with ProductType
      const r1 = await writeSess.run(
        `MATCH (g:GearItem)-[oldEdge:HAS_TIP]->(i:Insight)
         WHERE i.classification_scope = 'GENERIC'
         MATCH (g)-[:HAS_PRODUCT_TYPE]->(pt:ProductType)
         WITH g, oldEdge, i, pt LIMIT ${batchLimit}
         SET i:Tip
         REMOVE i:Insight
         DELETE oldEdge
         WITH i, pt
         MERGE (pt)-[:HAS_TIP]->(i)
         RETURN count(i) AS migrated`,
      );
      const migrated = toNumber(r1.records[0]?.get("migrated"));
      counts.migrated += migrated;

      // Stage 2: fallback — keep on GearItem as :Tip
      const remaining = batchLimit - migrated;
      if (remaining > 0) {
        const r2 = await writeSess.run(
          `MATCH (g:GearItem)-[oldEdge:HAS_TIP]->(i:Insight)
           WHERE i.classification_scope = 'GENERIC'
             AND NOT EXISTS((g)-[:HAS_PRODUCT_TYPE]->())
           WITH g, oldEdge, i LIMIT ${remaining}
           SET i:Tip
           REMOVE i:Insight
           DELETE oldEdge
           WITH g, i
           MERGE (g)-[:HAS_TIP]->(i)
           RETURN count(i) AS fallback`,
        );
        const fallback = toNumber(r2.records[0]?.get("fallback"));
        counts.fallback_no_parent += fallback;
      }

      console.log(
        `[migration:generic] migrated=+${migrated} (totals: migrated=${counts.migrated} fallback=${counts.fallback_no_parent})`,
      );

      if (migrated === 0 && (batchLimit - migrated) === 0) break;
      if ((migrated + (remaining > 0 ? 1 : 0)) === 0) break;
    } catch (err) {
      counts.failed += batchLimit;
      console.error(
        `[migration:generic] batch failed:`,
        err instanceof Error ? err.message : err,
      );
      break;
    } finally {
      await writeSess.close();
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Workflow step
// ---------------------------------------------------------------------------

const migrateStep = createStep({
  id: "migrate-insights",
  description:
    "Migrate classified Insight nodes to :Tip / :ProductInsight per their classification_scope",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const startedAt = Date.now();
    const dryRun = inputData.mode === "dry-run";

    let specific = empty();
    let family = empty();
    let generic = empty();

    if (inputData.target === "specific" || inputData.target === "all") {
      console.log(`[migration] starting SPECIFIC (${inputData.mode})`);
      specific = await migrateSpecific(dryRun, inputData.limit);
    }
    if (inputData.target === "family" || inputData.target === "all") {
      console.log(`[migration] starting FAMILY (${inputData.mode})`);
      family = await migrateFamily(dryRun, inputData.limit);
    }
    if (inputData.target === "generic" || inputData.target === "all") {
      console.log(`[migration] starting GENERIC (${inputData.mode})`);
      generic = await migrateGeneric(dryRun, inputData.limit);
    }

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

    console.log(
      `[migration] done in ${durationSeconds}s — ` +
        `specific=${specific.migrated}/${specific.candidates}, ` +
        `family=${family.migrated}/${family.candidates} (+${family.fallback_no_parent} fallback), ` +
        `generic=${generic.migrated}/${generic.candidates} (+${generic.fallback_no_parent} fallback)`,
    );

    return {
      mode: inputData.mode,
      target: inputData.target,
      specific,
      family,
      generic,
      duration_seconds: durationSeconds,
    };
  },
});

export const insightMigration = createWorkflow({
  id: "insightMigration",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(migrateStep)
  .commit();
