/**
 * Gardener-Sweeper Workflow — hourly Phase-1 of the 3-layer Gardener architecture
 *
 * The Sweeper does NOT do enrichment. It only **identifies** :GearItems with
 * gaps (missing properties, stale relationships, expired verifications) and
 * writes them into the Supabase `gardener_work_queue` for the Phase-2
 * Enrichment-Cycle to consume.
 *
 * Why deterministic + read-only? Because gap detection is a pure Cypher
 * computation — running an LLM agent for "is product_url null?" wastes tokens
 * and adds non-determinism. The Sweeper is the eyes; the Cycle is the hands.
 *
 * Run flow per cycle:
 *   1. Run gap-inventory Cypher against Memgraph (top N=500 candidates).
 *   2. Read existing queue rows for those Memgraph node ids.
 *   3. UPSERT: insert new items, refresh gaps+priority on queued/failed rows,
 *      preserve claimed/done items intact.
 *   4. Mark queued items not in current candidates as 'done' (their gaps
 *      were filled by the cycle in the meantime).
 *   5. Log: swept N, queued M new, refreshed K, resolved L.
 *
 * Cron-driven; safe to invoke manually for ad-hoc audits via dry-run mode.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { detectGapsForItems, type GapInventoryItem } from "../lib/gap-detector.js";
import { getSupabase } from "../lib/supabase.js";

const triggerSchema = z.object({
  /** Maximum number of items to write into the queue this run (default 500). */
  limit: z.number().int().positive().default(500),
  /** Skip cooldown filter — picks up every item with a gap, ignoring P7D/P30D windows. */
  ignoreCooldown: z.boolean().default(false),
  /** Dry-run: compute gaps but do not write to Supabase. */
  dryRun: z.boolean().default(false),
});

const sampleSchema = z.object({
  memgraph_node_id: z.string(),
  brand: z.string().nullable(),
  name: z.string().nullable(),
  gaps: z.array(z.string()),
  priority_score: z.number(),
  is_top50_brand: z.boolean(),
});

const outputSchema = z.object({
  candidates_found: z.number(),
  queue_inserted: z.number(),
  queue_refreshed: z.number(),
  queue_resolved: z.number(),
  duration_seconds: z.number(),
  dry_run: z.boolean(),
  sample_top: z.array(sampleSchema),
});

const sweepStep = createStep({
  id: "sweep-gaps-and-upsert",
  description:
    "Detect :GearItem nodes with gaps, UPSERT into gardener_work_queue, mark resolved entries as done",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData }) {
    const startedAt = Date.now();

    // --- Step 1: gap inventory from Memgraph ---
    const candidates = await detectGapsForItems({
      limit: inputData.limit,
      ignoreCooldown: inputData.ignoreCooldown,
    });

    console.log(
      `[Sweeper] swept ${candidates.length} candidates (limit=${inputData.limit} cooldown=${inputData.ignoreCooldown ? "ignored" : "honored"})`,
    );

    if (inputData.dryRun) {
      const duration = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[Sweeper] dry-run done in ${duration}s — no Supabase writes`,
      );
      return {
        candidates_found: candidates.length,
        queue_inserted: 0,
        queue_refreshed: 0,
        queue_resolved: 0,
        duration_seconds: duration,
        dry_run: true,
        sample_top: candidates.slice(0, 10).map(toSample),
      };
    }

    // --- Step 2: load existing queue rows ---
    const supa = getSupabase();
    const candidateIds = candidates.map((c) => c.memgraph_node_id);

    const existingByNodeId = await loadExistingQueueRows(supa, candidateIds);

    // --- Step 3: classify candidates: insert vs refresh vs leave ---
    const toInsert: QueueRow[] = [];
    const toRefresh: QueueRow[] = [];
    for (const cand of candidates) {
      const existing = existingByNodeId.get(cand.memgraph_node_id);
      const row = candidateToRow(cand);
      if (!existing) {
        toInsert.push(row);
      } else if (existing.status === "queued" || existing.status === "failed") {
        // Refresh gaps + priority; keep attempt_count if any.
        toRefresh.push({ ...row, status: existing.status });
      }
      // claimed / done / abandoned: leave intact
    }

    // --- Step 4: write inserts + refreshes ---
    let queueInserted = 0;
    let queueRefreshed = 0;

    if (toInsert.length > 0 || toRefresh.length > 0) {
      const allWrites = [...toInsert, ...toRefresh];
      // chunk to avoid Supabase payload limits
      const CHUNK = 200;
      for (let i = 0; i < allWrites.length; i += CHUNK) {
        const chunk = allWrites.slice(i, i + CHUNK);
        const { error } = await supa
          .from("gardener_work_queue")
          .upsert(chunk, { onConflict: "memgraph_node_id" });
        if (error) {
          throw new Error(
            `[Sweeper] gardener_work_queue upsert failed: ${error.message}`,
          );
        }
      }
      queueInserted = toInsert.length;
      queueRefreshed = toRefresh.length;
    }

    // --- Step 5: resolve queued/failed items that are no longer candidates ---
    // Only consider rows that were 'queued' or 'failed'; claimed/done/abandoned
    // are managed elsewhere.
    const candidateIdSet = new Set(candidateIds);
    const queueResolved = await resolveStaleEntries(
      supa,
      candidateIdSet,
    );

    const duration = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[Sweeper] done in ${duration}s — inserted=${queueInserted} refreshed=${queueRefreshed} resolved=${queueResolved}`,
    );

    return {
      candidates_found: candidates.length,
      queue_inserted: queueInserted,
      queue_refreshed: queueRefreshed,
      queue_resolved: queueResolved,
      duration_seconds: duration,
      dry_run: false,
      sample_top: candidates.slice(0, 10).map(toSample),
    };
  },
});

export const gardenerSweeper = createWorkflow({
  id: "gardenerSweeper",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(sweepStep)
  .commit();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface QueueRow {
  memgraph_node_id: string;
  gear_id: string | null;
  brand: string | null;
  name: string | null;
  gaps: string[];
  priority_score: number;
  is_top50_brand: boolean;
  status: string;
}

interface ExistingQueueRow {
  memgraph_node_id: string;
  status: string;
  attempt_count: number;
}

function candidateToRow(c: GapInventoryItem): QueueRow {
  return {
    memgraph_node_id: c.memgraph_node_id,
    gear_id: c.gear_id,
    brand: c.brand,
    name: c.name,
    gaps: c.gaps,
    priority_score: c.priority_score,
    is_top50_brand: c.is_top50_brand,
    status: "queued",
  };
}

function toSample(c: GapInventoryItem): z.infer<typeof sampleSchema> {
  return {
    memgraph_node_id: c.memgraph_node_id,
    brand: c.brand,
    name: c.name,
    gaps: c.gaps,
    priority_score: c.priority_score,
    is_top50_brand: c.is_top50_brand,
  };
}

/**
 * Load existing queue rows for the given Memgraph node ids. Chunked to
 * stay within URL-length limits on the IN-clause (~200 ids per request).
 */
async function loadExistingQueueRows(
  supa: ReturnType<typeof getSupabase>,
  nodeIds: string[],
): Promise<Map<string, ExistingQueueRow>> {
  const result = new Map<string, ExistingQueueRow>();
  const CHUNK = 200;

  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const batch = nodeIds.slice(i, i + CHUNK);
    const { data, error } = await supa
      .from("gardener_work_queue")
      .select("memgraph_node_id, status, attempt_count")
      .in("memgraph_node_id", batch);

    if (error) {
      throw new Error(
        `[Sweeper] gardener_work_queue read failed: ${error.message}`,
      );
    }

    for (const row of (data ?? []) as ExistingQueueRow[]) {
      result.set(row.memgraph_node_id, row);
    }
  }

  return result;
}

/**
 * Mark queued/failed entries that are no longer in the current candidate
 * set as 'done' (their gaps were filled by the cycle since the last sweep).
 *
 * We DO NOT touch claimed (cycle in progress), done (already resolved), or
 * abandoned (3+ failures, needs human review).
 *
 * Fetches all queued/failed rows in pages, computes the diff client-side,
 * then issues a bulk UPDATE for resolved IDs only.
 */
async function resolveStaleEntries(
  supa: ReturnType<typeof getSupabase>,
  currentCandidateIds: Set<string>,
): Promise<number> {
  let resolved = 0;
  const PAGE = 1000;
  let offset = 0;

  for (;;) {
    const { data, error } = await supa
      .from("gardener_work_queue")
      .select("memgraph_node_id, status")
      .in("status", ["queued", "failed"])
      .range(offset, offset + PAGE - 1);

    if (error) {
      throw new Error(
        `[Sweeper] gardener_work_queue stale-scan failed: ${error.message}`,
      );
    }

    const rows = (data ?? []) as Array<{ memgraph_node_id: string; status: string }>;
    if (rows.length === 0) break;

    const stale = rows
      .filter((r) => !currentCandidateIds.has(r.memgraph_node_id))
      .map((r) => r.memgraph_node_id);

    if (stale.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < stale.length; i += CHUNK) {
        const batch = stale.slice(i, i + CHUNK);
        const nowIso = new Date().toISOString();
        const { error: updateErr } = await supa
          .from("gardener_work_queue")
          .update({ status: "done", resolved_at: nowIso })
          .in("memgraph_node_id", batch);
        if (updateErr) {
          throw new Error(
            `[Sweeper] gardener_work_queue stale-mark failed: ${updateErr.message}`,
          );
        }
        resolved += batch.length;
      }
    }

    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return resolved;
}
