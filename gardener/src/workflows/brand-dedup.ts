/**
 * Brand-Dedup Workflow — Phase 09 / DATA-02 (GEA-1083)
 *
 * Two modes (selected via inputData.mode):
 *
 *   "dry-run":
 *     1. loadSnapshot — read top-brands-snapshot.json from filesystem or URL
 *     2. clusterBrands — Vercel AI Gateway structured output (gemini-2.5-flash)
 *     3. insertQueue — write each cluster as brand_dedup_queue row (status='pending')
 *                      Skipped when dry_run_test=true (local smoke-test mode).
 *     4. recordRun — append gardener_workflow_runs row with cost_cents
 *                    (Schema-Drift-tolerant; auth.users(id) FK constraint may
 *                    block service-role inserts — wrapped in try/catch.)
 *
 *   "apply":
 *     1. fetchCluster — fetch + validate brand_dedup_queue row by cluster_id;
 *                       enforce status ∈ ('approved','modified') per D-10.
 *     2. mergeGraph — re-point GearItem MADE_BY edges + create HAS_ALIAS_OF
 *                     edges in Memgraph (see brand-dedup-apply.ts).
 *     3. markApplied — update brand_dedup_queue.status='applied' +
 *                      applied_workflow_run_id.
 *     4. recordRun — append gardener_workflow_runs row with cost_cents=0.
 *
 * Linear-step pattern: same shape as youtube-playlist-ingest.ts. Branching
 * happens INSIDE one `routeAndExecute` step that switches on inputData.mode
 * (Mastra workflows don't have native branch primitives in v0.24.x).
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath, isAbsolute } from "node:path";
import {
  clusterBrands,
  BrandSnapshotSchema,
  type BrandClusterProposal,
} from "../lib/brand-clustering.js";
import { applyBrandClusterMerge } from "./brand-dedup-apply.js";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DEFAULT_SNAPSHOT_PATH =
  "/Users/schmelli/Coding/gearshack-winterberry/.planning/phases/09-geargraph-data-foundation/top-brands-snapshot.json";
const DEFAULT_MAX_COST_CENTS = 1000; // $10 hard cap per CONTEXT D-15

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  top_brands_snapshot_url: z.string().optional(),
  cluster_id: z.string().uuid().optional(),
  max_cost_cents: z.number().int().positive().default(DEFAULT_MAX_COST_CENTS),
  dry_run_test: z.boolean().default(false),
});

const aliasOutputSchema = z.object({
  name: z.string(),
  item_count: z.number().optional(),
  country_hint: z.string().optional(),
});

const clusterOutputSchema = z.object({
  cluster_id: z.string(),
  canonical_candidate: z.string(),
  aliases: z.array(aliasOutputSchema),
  llm_confidence: z.number(),
  llm_reasoning: z.string(),
});

/**
 * Single relaxed output schema (per plan Step C — discriminated union is
 * awkward in Mastra v0.24). Fields not relevant to the executed mode stay
 * undefined.
 */
const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  // dry-run fields
  clusters: z.array(clusterOutputSchema).optional(),
  total_clusters: z.number().optional(),
  total_items_affected: z.number().optional(),
  estimated_cost_cents: z.number().optional(),
  failed_inserts: z.array(z.string()).optional(),
  // apply fields
  cluster_id: z.string().optional(),
  merged_items: z.number().optional(),
  alias_edges_created: z.number().optional(),
  // shared
  cost_cents_used: z.number(),
  aborted_due_to_cost: z.boolean(),
  workflow_run_id: z.string(),
});

type WorkflowOutput = z.infer<typeof outputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSnapshot(snapshotUrl: string | undefined): Promise<unknown> {
  const path = snapshotUrl ?? DEFAULT_SNAPSHOT_PATH;

  // Heuristic: starts with http(s) → fetch; else → filesystem read.
  if (path.startsWith("http://") || path.startsWith("https://")) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(
        `Snapshot fetch failed: ${res.status} ${res.statusText} for ${path}`,
      );
    }
    return res.json();
  }

  const absPath = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
  const raw = await readFile(absPath, "utf-8");
  return JSON.parse(raw);
}

interface QueueInsertRow {
  cluster_id: string;
  canonical_candidate: string;
  aliases: BrandClusterProposal["aliases"];
  llm_confidence: number;
  llm_reasoning: string;
  item_counts: Record<string, number>;
  status: "pending";
}

function clusterToQueueRow(cluster: BrandClusterProposal): QueueInsertRow {
  const item_counts: Record<string, number> = {};
  for (const alias of cluster.aliases) {
    if (typeof alias.item_count === "number") {
      item_counts[alias.name] = alias.item_count;
    }
  }
  return {
    cluster_id: cluster.cluster_id,
    canonical_candidate: cluster.canonical_candidate,
    aliases: cluster.aliases,
    llm_confidence: cluster.llm_confidence,
    llm_reasoning: cluster.llm_reasoning,
    item_counts,
    status: "pending",
  };
}

async function insertClustersToQueue(
  clusters: BrandClusterProposal[],
): Promise<{ inserted: number; failed: string[] }> {
  if (clusters.length === 0) return { inserted: 0, failed: [] };

  const supa = getSupabase();
  const failed: string[] = [];
  let inserted = 0;

  for (const cluster of clusters) {
    const row = clusterToQueueRow(cluster);
    const { error } = await supa.from("brand_dedup_queue").insert(row);
    if (error) {
      console.warn(
        `[brand-dedup] queue insert failed for cluster=${cluster.cluster_id} canonical="${cluster.canonical_candidate}": ${error.message}`,
      );
      failed.push(cluster.cluster_id);
    } else {
      inserted += 1;
    }
  }

  return { inserted, failed };
}

interface RunRecordParams {
  workflow_run_id: string;
  mode: "dry-run" | "apply";
  cost_cents: number;
  result_data: Record<string, unknown>;
  cluster_id?: string;
}

/**
 * Schema-Drift-tolerant insert into gardener_workflow_runs. Failures are
 * logged but never throw — the actual workflow result is the value, this
 * row is just an audit trail.
 *
 * KNOWN constraint: started_by is `not null references auth.users(id)`. The
 * Gardener service runs without an auth user, so this insert may fail. We
 * try with a stable nil UUID first; if FK fails we log and continue.
 */
async function recordWorkflowRun(params: RunRecordParams): Promise<void> {
  try {
    const supa = getSupabase();
    const startedBy = process.env.GARDENER_SYSTEM_USER_ID;
    const baseRow: Record<string, unknown> = {
      id: params.workflow_run_id,
      workflow_id: "brand-dedup",
      run_id: params.workflow_run_id,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "completed",
      params: { mode: params.mode, cluster_id: params.cluster_id },
      dry_run: params.mode === "dry-run",
      cost_cents: params.cost_cents,
      result_data: params.result_data,
    };
    if (startedBy) baseRow.started_by = startedBy;

    const { error } = await supa.from("gardener_workflow_runs").insert(baseRow);
    if (error) {
      console.warn(
        `[brand-dedup] gardener_workflow_runs insert failed (continuing): ${error.message}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[brand-dedup] gardener_workflow_runs insert threw: ${reason}`);
  }
}

interface QueueRow {
  cluster_id: string;
  canonical_candidate: string;
  modified_canonical: string | null;
  aliases: unknown;
  status: string;
}

async function fetchQueueRow(clusterId: string): Promise<QueueRow> {
  const supa = getSupabase();
  const { data, error } = await supa
    .from("brand_dedup_queue")
    .select("cluster_id, canonical_candidate, modified_canonical, aliases, status")
    .eq("cluster_id", clusterId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[brand-dedup] failed to load brand_dedup_queue row for cluster_id=${clusterId}: ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `[brand-dedup] no brand_dedup_queue row found for cluster_id=${clusterId}`,
    );
  }
  return data as QueueRow;
}

function extractAliasNames(rawAliases: unknown): string[] {
  if (!Array.isArray(rawAliases)) return [];
  const names: string[] = [];
  for (const a of rawAliases) {
    if (a && typeof a === "object" && "name" in a) {
      const name = (a as { name: unknown }).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

async function markClusterApplied(
  clusterId: string,
  workflowRunId: string,
): Promise<void> {
  const supa = getSupabase();
  const { error } = await supa
    .from("brand_dedup_queue")
    .update({
      status: "applied",
      applied_workflow_run_id: workflowRunId,
      updated_at: new Date().toISOString(),
    })
    .eq("cluster_id", clusterId);

  if (!error) return;

  // FK on applied_workflow_run_id → gardener_workflow_runs(id) may fail when
  // recordWorkflowRun's insert was blocked by its own FK on auth.users(id).
  // The Memgraph merge already succeeded — we don't want to lose that work over
  // a missing audit-trail row. Retry without the FK reference.
  if (error.code === "23503" || /foreign key constraint/i.test(error.message)) {
    console.warn(
      `[brand-dedup] applied_workflow_run_id FK missing (recordWorkflowRun likely failed); marking applied without run-id reference`,
    );
    const { error: retryError } = await supa
      .from("brand_dedup_queue")
      .update({
        status: "applied",
        applied_workflow_run_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("cluster_id", clusterId);
    if (!retryError) return;
    throw new Error(
      `[brand-dedup] failed to mark cluster=${clusterId} as applied (retry without FK also failed): ${retryError.message}`,
    );
  }

  throw new Error(
    `[brand-dedup] failed to mark cluster=${clusterId} as applied: ${error.message}`,
  );
}

// ---------------------------------------------------------------------------
// Step: routeAndExecute (single combined step — Mastra v0.24 has no branch primitive)
// ---------------------------------------------------------------------------

const routeAndExecute = createStep({
  id: "route-and-execute",
  description:
    "Route on inputData.mode → dry-run cluster + queue write OR apply cluster merge in Memgraph",
  inputSchema: triggerSchema,
  outputSchema,
  execute: async ({ inputData }): Promise<WorkflowOutput> => {
    const workflow_run_id = randomUUID();

    if (inputData.mode === "dry-run") {
      // ----- DRY-RUN PATH -----
      const rawSnapshot = await loadSnapshot(inputData.top_brands_snapshot_url);
      const snapshot = BrandSnapshotSchema.parse(rawSnapshot);

      console.log(
        `[brand-dedup] dry-run: ${snapshot.brands.length} brands loaded from ${
          inputData.top_brands_snapshot_url ?? DEFAULT_SNAPSHOT_PATH
        }`,
      );

      const clusterResult = await clusterBrands(snapshot, {
        maxCostCents: inputData.max_cost_cents,
      });

      const total_items_affected = clusterResult.clusters.reduce((sum, c) => {
        return (
          sum +
          c.aliases.reduce(
            (s, a) => s + (typeof a.item_count === "number" ? a.item_count : 0),
            0,
          )
        );
      }, 0);

      let failed_inserts: string[] = [];
      if (clusterResult.aborted_due_to_cost && clusterResult.clusters.length === 0) {
        // Pre-call abort — nothing to write.
        console.warn("[brand-dedup] dry-run aborted before LLM call (cost cap)");
      } else if (inputData.dry_run_test) {
        console.log(
          "[brand-dedup] dry_run_test=true — skipping Supabase brand_dedup_queue inserts",
        );
      } else {
        const ins = await insertClustersToQueue(clusterResult.clusters);
        failed_inserts = ins.failed;
        console.log(
          `[brand-dedup] dry-run inserted ${ins.inserted}/${clusterResult.clusters.length} cluster rows (failed=${ins.failed.length})`,
        );
      }

      // Audit row — best-effort, never blocks.
      if (!inputData.dry_run_test) {
        await recordWorkflowRun({
          workflow_run_id,
          mode: "dry-run",
          cost_cents: clusterResult.cost_cents_used,
          result_data: {
            total_clusters: clusterResult.clusters.length,
            total_items_affected,
            estimated_cost_cents: clusterResult.estimated_cost_cents,
            aborted_due_to_cost: clusterResult.aborted_due_to_cost,
            failed_inserts,
          },
        });
      }

      return {
        mode: "dry-run",
        clusters: clusterResult.clusters,
        total_clusters: clusterResult.clusters.length,
        total_items_affected,
        estimated_cost_cents: clusterResult.estimated_cost_cents,
        failed_inserts,
        cost_cents_used: clusterResult.cost_cents_used,
        aborted_due_to_cost: clusterResult.aborted_due_to_cost,
        workflow_run_id,
      };
    }

    // ----- APPLY PATH -----
    if (!inputData.cluster_id) {
      throw new Error(
        "[brand-dedup] mode='apply' requires inputData.cluster_id",
      );
    }
    const clusterId = inputData.cluster_id;

    const queueRow = await fetchQueueRow(clusterId);
    if (queueRow.status !== "approved" && queueRow.status !== "modified") {
      throw new Error(
        `[brand-dedup] Cluster ${clusterId} not approved (status=${queueRow.status}) — apply blocked by D-10 human-review-gate`,
      );
    }

    const effectiveCanonical =
      queueRow.status === "modified" && queueRow.modified_canonical
        ? queueRow.modified_canonical
        : queueRow.canonical_candidate;

    const aliasNames = extractAliasNames(queueRow.aliases);
    console.log(
      `[brand-dedup] apply: cluster=${clusterId} canonical="${effectiveCanonical}" aliases=${aliasNames.length}`,
    );

    const merge = await applyBrandClusterMerge(effectiveCanonical, aliasNames);

    await markClusterApplied(clusterId, workflow_run_id);

    await recordWorkflowRun({
      workflow_run_id,
      mode: "apply",
      cost_cents: 0,
      cluster_id: clusterId,
      result_data: {
        cluster_id: clusterId,
        merged_items: merge.merged_items,
        alias_edges_created: merge.alias_edges_created,
        canonical: effectiveCanonical,
      },
    });

    return {
      mode: "apply",
      cluster_id: clusterId,
      merged_items: merge.merged_items,
      alias_edges_created: merge.alias_edges_created,
      cost_cents_used: 0,
      aborted_due_to_cost: false,
      workflow_run_id,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const brandDedup = createWorkflow({
  id: "brandDedup",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(routeAndExecute)
  .commit();
