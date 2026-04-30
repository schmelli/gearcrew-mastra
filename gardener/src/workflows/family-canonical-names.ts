/**
 * Family-Canonical-Names Workflow — Quick-Task 260430-fam
 *
 * Classifies all :ProductFamily nodes in Memgraph as `genuine` (real
 * manufacturer line: Hilleberg Nallo, Big Agnes Copper Spur), `generic`
 * (category umbrella: "Backpacks", "Sleeping Mats"), or `ambiguous`.
 *
 * Two modes:
 *
 *   "dry-run":
 *     1. snapshotFromMemgraph — read all :ProductFamily nodes + variant
 *        counts + variant brands + product types
 *     2. classifyFamilies — Vercel AI Gateway structured output
 *     3. insertQueue — write each proposal to family_canonical_queue
 *        (skipped when dry_run_test=true)
 *     4. recordRun — append gardener_workflow_runs row (best-effort)
 *
 *   "apply":
 *     1. fetchProposal — fetch + validate family_canonical_queue row by id
 *        Enforces status ∈ ('approved','modified') per human-review-gate.
 *     2. applyMutation — for genuine: SET canonical_name + brand_id +
 *        brand_name on Memgraph. For generic: DETACH DELETE the
 *        :ProductFamily node + IS_VARIANT_OF edges.
 *     3. markApplied — update queue.status='applied'
 *     4. recordRun — append audit row
 *
 * Pattern bewusst symmetrisch zu brand-dedup.ts (Phase 09 / DATA-02). Single
 * combined step `routeAndExecute` weil Mastra v0.24 keine native Branch-
 * Primitive hat.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  classifyFamilies,
  FamilySnapshotSchema,
  type FamilyClassificationProposal,
  type FamilySnapshotEntry,
} from "../lib/family-classification.js";
import { applyFamilyClassification } from "./family-canonical-names-apply.js";
import { getReadSession, toNumber } from "../lib/memgraph.js";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COST_CENTS = 1000; // $10

const triggerSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  queue_id: z.string().uuid().optional(),
  max_cost_cents: z.number().int().positive().default(DEFAULT_MAX_COST_CENTS),
  dry_run_test: z.boolean().default(false),
  family_limit: z.number().int().positive().optional(),
});

const proposalOutputSchema = z.object({
  family_node_id: z.string(),
  classification: z.enum(["genuine", "generic", "ambiguous"]),
  proposed_canonical_name: z.string().nullable(),
  proposed_brand_name: z.string().nullable(),
  llm_confidence: z.number(),
  llm_reasoning: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  // dry-run fields
  proposals: z.array(proposalOutputSchema).optional(),
  total_proposals: z.number().optional(),
  total_families_snapshotted: z.number().optional(),
  estimated_cost_cents: z.number().optional(),
  failed_inserts: z.array(z.string()).optional(),
  distribution: z
    .object({
      genuine: z.number(),
      generic: z.number(),
      ambiguous: z.number(),
    })
    .optional(),
  // apply fields
  queue_id: z.string().optional(),
  family_node_id: z.string().optional(),
  classification: z.enum(["genuine", "generic", "ambiguous"]).optional(),
  variants_unlinked: z.number().optional(),
  // shared
  cost_cents_used: z.number(),
  aborted_due_to_cost: z.boolean(),
  workflow_run_id: z.string(),
});

type WorkflowOutput = z.infer<typeof outputSchema>;

// ---------------------------------------------------------------------------
// Memgraph snapshot
// ---------------------------------------------------------------------------

const SNAPSHOT_CYPHER = `
MATCH (f:ProductFamily)
OPTIONAL MATCH (f)<-[:IS_VARIANT_OF]-(g:GearItem)
OPTIONAL MATCH (g)-[:MANUFACTURES_ITEM|PRODUCED_BY]-(b:OutdoorBrand)
OPTIONAL MATCH (g)-[:HAS_PRODUCT_TYPE]->(t:ProductType)
WITH f, g, b.name AS brand_name, t.name AS type_name
WITH f, g, brand_name, collect(DISTINCT type_name) AS types_for_g
WITH f, g, brand_name, types_for_g
WITH f, brand_name, count(DISTINCT g) AS items_for_brand,
     collect(DISTINCT types_for_g) AS types_lists
WITH f, collect({name: brand_name, count: items_for_brand}) AS brand_groups,
     reduce(acc = [], xs IN types_lists | acc + xs) AS all_types
WITH f, brand_groups,
     [b IN brand_groups WHERE b.name IS NOT NULL] AS variant_brands,
     [t IN all_types WHERE t IS NOT NULL] AS flat_types
WITH f, variant_brands, flat_types,
     reduce(s = 0, b IN variant_brands | s + b.count) AS total_variants
RETURN
  toString(id(f)) AS family_node_id,
  coalesce(f.name, '(unnamed)') AS family_name,
  total_variants AS variant_count,
  variant_brands,
  [t IN flat_types | t] AS product_types
ORDER BY family_name
`;

interface RawSnapshotRow {
  family_node_id: string;
  family_name: string;
  variant_count: unknown;
  variant_brands: Array<{ name: unknown; count: unknown }> | unknown;
  product_types: unknown;
}

function dedupTypes(types: unknown): string[] {
  if (!Array.isArray(types)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of types) {
    if (typeof t === "string" && t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function normalizeBrandList(
  raw: unknown,
): Array<{ name: string; count: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; count: number }> = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      "name" in item &&
      typeof (item as { name: unknown }).name === "string"
    ) {
      const name = (item as { name: string }).name;
      const count = toNumber((item as { count: unknown }).count);
      out.push({ name, count });
    }
  }
  return out;
}

async function snapshotFamiliesFromMemgraph(
  limit?: number,
): Promise<FamilySnapshotEntry[]> {
  const session = getReadSession();
  try {
    const cypher = limit ? `${SNAPSHOT_CYPHER}\nLIMIT ${limit}` : SNAPSHOT_CYPHER;
    const result = await session.run(cypher);

    return result.records.map((r) => {
      const row: RawSnapshotRow = {
        family_node_id: r.get("family_node_id"),
        family_name: r.get("family_name"),
        variant_count: r.get("variant_count"),
        variant_brands: r.get("variant_brands"),
        product_types: r.get("product_types"),
      };
      return {
        family_node_id: String(row.family_node_id),
        family_name: String(row.family_name),
        variant_count: toNumber(row.variant_count),
        variant_brands: normalizeBrandList(row.variant_brands),
        product_types: dedupTypes(row.product_types),
      };
    });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Supabase queue helpers
// ---------------------------------------------------------------------------

interface QueueInsertRow {
  family_node_id: string;
  family_name: string;
  classification: "genuine" | "generic" | "ambiguous";
  proposed_canonical_name: string | null;
  proposed_brand_name: string | null;
  variant_count: number;
  variant_brand_names: string[];
  llm_confidence: number;
  llm_reasoning: string;
  status: "pending";
}

function proposalToQueueRow(
  proposal: FamilyClassificationProposal,
  snapshot: FamilySnapshotEntry,
): QueueInsertRow {
  return {
    family_node_id: proposal.family_node_id,
    family_name: snapshot.family_name,
    classification: proposal.classification,
    proposed_canonical_name: proposal.proposed_canonical_name,
    proposed_brand_name: proposal.proposed_brand_name,
    variant_count: snapshot.variant_count,
    variant_brand_names: snapshot.variant_brands.map((b) => b.name),
    llm_confidence: proposal.llm_confidence,
    llm_reasoning: proposal.llm_reasoning,
    status: "pending",
  };
}

async function insertProposalsToQueue(
  proposals: FamilyClassificationProposal[],
  snapshotById: Map<string, FamilySnapshotEntry>,
): Promise<{ inserted: number; failed: string[] }> {
  if (proposals.length === 0) return { inserted: 0, failed: [] };

  const supa = getSupabase();
  const failed: string[] = [];
  let inserted = 0;

  for (const proposal of proposals) {
    const snap = snapshotById.get(proposal.family_node_id);
    if (!snap) {
      console.warn(
        `[family-canonical] snapshot lookup miss for family_node_id=${proposal.family_node_id} — skipping queue insert`,
      );
      failed.push(proposal.family_node_id);
      continue;
    }
    const row = proposalToQueueRow(proposal, snap);
    const { error } = await supa.from("family_canonical_queue").insert(row);
    if (error) {
      console.warn(
        `[family-canonical] queue insert failed for family_node_id=${proposal.family_node_id} name="${snap.family_name}": ${error.message}`,
      );
      failed.push(proposal.family_node_id);
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
  queue_id?: string;
}

async function recordWorkflowRun(params: RunRecordParams): Promise<void> {
  try {
    const supa = getSupabase();
    const startedBy = process.env.GARDENER_SYSTEM_USER_ID;
    const baseRow: Record<string, unknown> = {
      id: params.workflow_run_id,
      workflow_id: "family-canonical-names",
      run_id: params.workflow_run_id,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: "completed",
      params: { mode: params.mode, queue_id: params.queue_id },
      dry_run: params.mode === "dry-run",
      cost_cents: params.cost_cents,
      result_data: params.result_data,
    };
    if (startedBy) baseRow.started_by = startedBy;

    const { error } = await supa.from("gardener_workflow_runs").insert(baseRow);
    if (error) {
      console.warn(
        `[family-canonical] gardener_workflow_runs insert failed (continuing): ${error.message}`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[family-canonical] gardener_workflow_runs insert threw: ${reason}`,
    );
  }
}

interface QueueRow {
  id: string;
  family_node_id: string;
  family_name: string;
  classification: string;
  proposed_canonical_name: string | null;
  proposed_brand_name: string | null;
  modified_canonical_name: string | null;
  modified_classification: string | null;
  status: string;
}

async function fetchQueueRow(queueId: string): Promise<QueueRow> {
  const supa = getSupabase();
  const { data, error } = await supa
    .from("family_canonical_queue")
    .select(
      "id, family_node_id, family_name, classification, proposed_canonical_name, proposed_brand_name, modified_canonical_name, modified_classification, status",
    )
    .eq("id", queueId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[family-canonical] failed to load family_canonical_queue row id=${queueId}: ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `[family-canonical] no family_canonical_queue row found for id=${queueId}`,
    );
  }
  return data as QueueRow;
}

async function markQueueRowApplied(
  queueId: string,
  workflowRunId: string,
): Promise<void> {
  const supa = getSupabase();
  const { error } = await supa
    .from("family_canonical_queue")
    .update({
      status: "applied",
      applied_workflow_run_id: workflowRunId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  if (error) {
    throw new Error(
      `[family-canonical] failed to mark queue row id=${queueId} as applied: ${error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step: routeAndExecute
// ---------------------------------------------------------------------------

const routeAndExecute = createStep({
  id: "route-and-execute",
  description:
    "Route on inputData.mode → dry-run snapshot+classify+queue OR apply per-family Memgraph mutation",
  inputSchema: triggerSchema,
  outputSchema,
  execute: async ({ inputData }): Promise<WorkflowOutput> => {
    const workflow_run_id = randomUUID();

    if (inputData.mode === "dry-run") {
      // ----- DRY-RUN PATH -----
      const snapshotEntries = await snapshotFamiliesFromMemgraph(
        inputData.family_limit,
      );
      const snapshot = FamilySnapshotSchema.parse({ families: snapshotEntries });

      console.log(
        `[family-canonical] dry-run: ${snapshot.families.length} ProductFamilies snapshotted from Memgraph`,
      );

      const classifyResult = await classifyFamilies(snapshot, {
        maxCostCents: inputData.max_cost_cents,
      });

      const distribution = classifyResult.proposals.reduce(
        (acc, p) => {
          acc[p.classification] = (acc[p.classification] ?? 0) + 1;
          return acc;
        },
        { genuine: 0, generic: 0, ambiguous: 0 } as Record<string, number>,
      );

      const snapshotById = new Map(
        snapshot.families.map((f) => [f.family_node_id, f]),
      );

      let failed_inserts: string[] = [];
      if (
        classifyResult.aborted_due_to_cost &&
        classifyResult.proposals.length === 0
      ) {
        console.warn(
          "[family-canonical] dry-run aborted before LLM call (cost cap)",
        );
      } else if (inputData.dry_run_test) {
        console.log(
          "[family-canonical] dry_run_test=true — skipping Supabase family_canonical_queue inserts",
        );
      } else {
        const ins = await insertProposalsToQueue(
          classifyResult.proposals,
          snapshotById,
        );
        failed_inserts = ins.failed;
        console.log(
          `[family-canonical] dry-run inserted ${ins.inserted}/${classifyResult.proposals.length} queue rows (failed=${ins.failed.length})`,
        );
      }

      if (!inputData.dry_run_test) {
        await recordWorkflowRun({
          workflow_run_id,
          mode: "dry-run",
          cost_cents: classifyResult.cost_cents_used,
          result_data: {
            total_proposals: classifyResult.proposals.length,
            total_families_snapshotted: snapshot.families.length,
            distribution,
            estimated_cost_cents: classifyResult.estimated_cost_cents,
            aborted_due_to_cost: classifyResult.aborted_due_to_cost,
            failed_inserts,
          },
        });
      }

      return {
        mode: "dry-run",
        proposals: classifyResult.proposals,
        total_proposals: classifyResult.proposals.length,
        total_families_snapshotted: snapshot.families.length,
        estimated_cost_cents: classifyResult.estimated_cost_cents,
        failed_inserts,
        distribution: {
          genuine: distribution.genuine ?? 0,
          generic: distribution.generic ?? 0,
          ambiguous: distribution.ambiguous ?? 0,
        },
        cost_cents_used: classifyResult.cost_cents_used,
        aborted_due_to_cost: classifyResult.aborted_due_to_cost,
        workflow_run_id,
      };
    }

    // ----- APPLY PATH -----
    if (!inputData.queue_id) {
      throw new Error(
        "[family-canonical] mode='apply' requires inputData.queue_id",
      );
    }
    const queueId = inputData.queue_id;

    const queueRow = await fetchQueueRow(queueId);
    if (queueRow.status !== "approved" && queueRow.status !== "modified") {
      throw new Error(
        `[family-canonical] Queue row ${queueId} not approved (status=${queueRow.status}) — apply blocked by human-review-gate`,
      );
    }

    // Effective values: prefer modified_* over proposed_*
    const effectiveClassification = (
      queueRow.modified_classification ?? queueRow.classification
    ) as "genuine" | "generic" | "ambiguous";
    const effectiveCanonical =
      queueRow.modified_canonical_name ?? queueRow.proposed_canonical_name;

    if (effectiveClassification === "ambiguous") {
      throw new Error(
        `[family-canonical] Queue row ${queueId} has effective classification='ambiguous' — admin must set genuine or generic via modified_classification before apply`,
      );
    }

    console.log(
      `[family-canonical] apply: queue_id=${queueId} family_node_id=${queueRow.family_node_id} name="${queueRow.family_name}" classification=${effectiveClassification}`,
    );

    const mutation = await applyFamilyClassification({
      family_node_id: queueRow.family_node_id,
      classification: effectiveClassification,
      canonical_name: effectiveCanonical,
      brand_name: queueRow.proposed_brand_name,
    });

    await markQueueRowApplied(queueId, workflow_run_id);

    await recordWorkflowRun({
      workflow_run_id,
      mode: "apply",
      cost_cents: 0,
      queue_id: queueId,
      result_data: {
        queue_id: queueId,
        family_node_id: queueRow.family_node_id,
        classification: effectiveClassification,
        canonical_name: effectiveCanonical,
        variants_unlinked: mutation.variants_unlinked,
      },
    });

    return {
      mode: "apply",
      queue_id: queueId,
      family_node_id: queueRow.family_node_id,
      classification: effectiveClassification,
      variants_unlinked: mutation.variants_unlinked,
      cost_cents_used: 0,
      aborted_due_to_cost: false,
      workflow_run_id,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const familyCanonical = createWorkflow({
  id: "familyCanonical",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(routeAndExecute)
  .commit();
