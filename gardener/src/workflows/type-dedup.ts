/**
 * Type-Dedup Workflow — Phase 09 / DATA-03 (GEA-1084)
 *
 * Single-mode (`dry-run`) workflow that:
 *   1. fetchTopTypes  — read top-N ProductType-categories from Supabase
 *      (level=3) ordered by gear_items.product_type_id count.
 *   2. clusterTypes   — Vercel AI Gateway structured output (gemini-2.5-flash)
 *      via clusterProductTypes() — read-only, cost-capped at 200¢.
 *   3. detectGender   — regex on canonical_label + alias_labels:
 *        mens-only matches → gender_hint="mens"
 *        womens-only matches → gender_hint="womens"
 *        mixed or none → gender_hint=null
 *   4. filterAndSort  — drop clusters with llm_confidence < 0.95; sort
 *      remaining alphabetically by canonical_label.toLowerCase().
 *   5. annotateAffectedItemCount — sum item_counts of canonical+aliases.
 *   6. writeExport    — write {outputDir}/{run_id}.json. dry_run_test=true
 *      skips the write.
 *
 * NO apply mode: type-merge is a Gearshack-side Supabase migration (D-12).
 *
 * Linear-step pattern: same shape as brand-dedup. Single combined step
 * because Mastra v0.24 has no native branch primitive.
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath, isAbsolute } from "node:path";
import {
  clusterProductTypes,
  type TypeClusterProposal,
  type TypeSnapshot,
} from "../lib/type-clustering.js";
import { getSupabase } from "../lib/supabase.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COST_CENTS = 200;
const DEFAULT_TOP_N = 50;
const PRODUCT_TYPE_LEVEL = 3;
const CONFIDENCE_FLOOR = 0.95;
const EXPORT_URL_BASE =
  "https://geargraph.gearshack.app/gardener/exports/type-dedup";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  mode: z.literal("dry-run"),
  max_cost_cents: z.number().int().positive().default(DEFAULT_MAX_COST_CENTS),
  dry_run_test: z.boolean().default(false),
  output_dir_override: z.string().optional(),
  top_n: z.number().int().positive().default(DEFAULT_TOP_N),
});

const clusterOutputSchema = z.object({
  cluster_id: z.string(),
  canonical_category_id: z.string().uuid(),
  canonical_label: z.string(),
  alias_category_ids: z.array(z.string().uuid()),
  alias_labels: z.array(z.string()),
  gender_hint: z.enum(["mens", "womens"]).nullable(),
  llm_confidence: z.number(),
  llm_reasoning: z.string(),
  affected_item_count: z.number(),
});

const outputSchema = z.object({
  items_processed: z.number(),
  clusters: z.array(clusterOutputSchema),
  export_json_url: z.string(),
  cost_cents_used: z.number(),
  aborted_due_to_cost: z.boolean(),
  audit_log_ids: z.array(z.string()),
  workflow_run_id: z.string(),
});

type WorkflowOutput = z.infer<typeof outputSchema>;
type ClusterOutput = z.infer<typeof clusterOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawCategoryRow {
  id: string;
  label: string;
}

interface RawItemTypeCount {
  product_type_id: string | null;
}

/**
 * Step A — fetch top-N ProductType categories ranked by gear_items count.
 *
 * Strategy:
 *   1. Read all gear_items.product_type_id (non-null) — service-role bypass RLS.
 *      Aggregate counts in-memory (Supabase JS client doesn't support GROUP BY).
 *   2. Sort by count desc, slice top-N.
 *   3. Read categories.label for the resulting ids; filter level=3 (product_type).
 */
async function fetchTopTypes(topN: number): Promise<{
  snapshot: TypeSnapshot;
  items_processed: number;
}> {
  const supa = getSupabase();

  // Step 1: pull all product_type_id assignments. Page through to avoid
  // PostgREST default-1000-row cap.
  const counts = new Map<string, number>();
  const PAGE = 1000;
  let from = 0;
  let totalRows = 0;
  for (;;) {
    const { data, error } = await supa
      .from("gear_items")
      .select("product_type_id")
      .not("product_type_id", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(
        `[type-dedup] gear_items read failed: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    for (const row of data as RawItemTypeCount[]) {
      const id = row.product_type_id;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      totalRows += 1;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(
    `[type-dedup] read ${totalRows} gear_items rows → ${counts.size} distinct product_type_ids`,
  );

  // Step 2: top-N by count
  const sortedIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  const topIds = sortedIds.map((e) => e[0]);

  if (topIds.length === 0) {
    return { snapshot: { types: [] }, items_processed: 0 };
  }

  // Step 3: hydrate labels for top-N — filter level=3 (product_type).
  const { data: catData, error: catErr } = await supa
    .from("categories")
    .select("id, label, level")
    .in("id", topIds)
    .eq("level", PRODUCT_TYPE_LEVEL);
  if (catErr) {
    throw new Error(`[type-dedup] categories read failed: ${catErr.message}`);
  }

  const labelById = new Map<string, string>();
  for (const row of (catData ?? []) as RawCategoryRow[]) {
    labelById.set(row.id, row.label);
  }

  const types = topIds
    .filter((id) => labelById.has(id))
    .map((id) => ({
      id,
      name: labelById.get(id) ?? "",
      item_count: counts.get(id) ?? 0,
    }));

  console.log(
    `[type-dedup] hydrated ${types.length} top-${topN} product_types (level=${PRODUCT_TYPE_LEVEL})`,
  );

  return {
    snapshot: { types },
    items_processed: types.reduce((s, t) => s + t.item_count, 0),
  };
}

// Gender-detection regex — covers English + German conventions.
const MENS_REGEX = /\b(men'?s|herren|m[äa]nner|mens?)\b/i;
const WOMENS_REGEX = /\b(women'?s|damen|frauen|womens?)\b/i;

/**
 * Step C — detect gender_hint from canonical + alias labels.
 * Returns "mens" if any label matches mens-regex AND none matches womens-regex.
 * Returns "womens" if any label matches womens-regex AND none matches mens-regex.
 * Returns null otherwise (mixed or no match).
 */
function detectGenderHint(
  canonicalLabel: string,
  aliasLabels: string[],
): "mens" | "womens" | null {
  const all = [canonicalLabel, ...aliasLabels];
  let hasMens = false;
  let hasWomens = false;
  for (const label of all) {
    if (MENS_REGEX.test(label)) hasMens = true;
    if (WOMENS_REGEX.test(label)) hasWomens = true;
  }
  if (hasMens && !hasWomens) return "mens";
  if (hasWomens && !hasMens) return "womens";
  return null;
}

/**
 * Step E — sum item_counts for canonical + aliases via the snapshot lookup.
 */
function sumAffectedItemCount(
  cluster: TypeClusterProposal,
  itemCountById: Map<string, number>,
): number {
  let sum = itemCountById.get(cluster.canonical_category_id) ?? 0;
  for (const aid of cluster.alias_category_ids) {
    sum += itemCountById.get(aid) ?? 0;
  }
  return sum;
}

interface WriteExportResult {
  url: string;
  absPath: string;
  written: boolean;
}

/**
 * Step F — write {outputDir}/{run_id}.json. Skipped when dry_run_test=true.
 *
 * outputDir resolution:
 *   1. inputData.output_dir_override (absolute or cwd-relative)
 *   2. env TYPE_DEDUP_EXPORT_DIR (absolute path)
 *   3. /tmp/exports/type-dedup (writable in any container, no bind-mount required)
 *
 * Per Plan-Task-3 Option B: operator extracts files via `docker cp` for the
 * first 1-2 reviews; static-file-serving via nginx is deferred. URL in
 * EXPORT_URL_BASE remains a deterministic placeholder until nginx is wired up.
 */
async function writeExport(
  runId: string,
  payload: unknown,
  options: { dryRunTest: boolean; outputDirOverride: string | undefined },
): Promise<WriteExportResult> {
  const url = `${EXPORT_URL_BASE}/${runId}.json`;
  if (options.dryRunTest) {
    console.log(
      `[type-dedup] dry_run_test=true — skipping export-file write (would-be url: ${url})`,
    );
    return { url, absPath: "", written: false };
  }

  let outputDir: string;
  if (options.outputDirOverride) {
    outputDir = isAbsolute(options.outputDirOverride)
      ? options.outputDirOverride
      : resolvePath(process.cwd(), options.outputDirOverride);
  } else if (process.env.TYPE_DEDUP_EXPORT_DIR) {
    outputDir = process.env.TYPE_DEDUP_EXPORT_DIR;
  } else {
    outputDir = "/tmp/exports/type-dedup";
  }

  await mkdir(outputDir, { recursive: true });
  const absPath = resolvePath(outputDir, `${runId}.json`);
  await writeFile(absPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`[type-dedup] wrote export → ${absPath} (url: ${url})`);
  return { url, absPath, written: true };
}

// ---------------------------------------------------------------------------
// Step: routeAndExecute (single combined step — Mastra v0.24 pattern)
// ---------------------------------------------------------------------------

const routeAndExecute = createStep({
  id: "route-and-execute",
  description:
    "Read top-N product_types from Supabase → LLM-cluster → detect gender → filter+sort → annotate → write JSON export",
  inputSchema: triggerSchema,
  outputSchema,
  execute: async ({ inputData }): Promise<WorkflowOutput> => {
    const workflow_run_id = randomUUID();
    console.log(
      `[type-dedup] dry-run start: run_id=${workflow_run_id} top_n=${inputData.top_n} max_cost_cents=${inputData.max_cost_cents} dry_run_test=${inputData.dry_run_test}`,
    );

    // Step A — fetch top-N types
    const { snapshot, items_processed } = await fetchTopTypes(inputData.top_n);

    if (snapshot.types.length === 0) {
      console.warn("[type-dedup] no product_types found — returning empty");
      const emptyExport = await writeExport(
        workflow_run_id,
        {
          items_processed: 0,
          clusters: [],
          run_id: workflow_run_id,
          generated_at: new Date().toISOString(),
        },
        {
          dryRunTest: inputData.dry_run_test,
          outputDirOverride: inputData.output_dir_override,
        },
      );
      return {
        items_processed: 0,
        clusters: [],
        export_json_url: emptyExport.url,
        cost_cents_used: 0,
        aborted_due_to_cost: false,
        audit_log_ids: [],
        workflow_run_id,
      };
    }

    // Step B — LLM cluster
    const clusterResult = await clusterProductTypes(snapshot, {
      maxCostCents: inputData.max_cost_cents,
    });

    // Build item_count lookup for Step E
    const itemCountById = new Map<string, number>();
    for (const t of snapshot.types) itemCountById.set(t.id, t.item_count);

    // Steps C + D + E in one pass
    const annotated: ClusterOutput[] = [];
    for (const c of clusterResult.clusters) {
      if (c.llm_confidence < CONFIDENCE_FLOOR) {
        console.log(
          `[type-dedup] dropping cluster "${c.canonical_label}" — confidence=${c.llm_confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}`,
        );
        continue;
      }
      const gender_hint = detectGenderHint(c.canonical_label, c.alias_labels);
      const affected_item_count = sumAffectedItemCount(c, itemCountById);
      annotated.push({
        cluster_id: c.cluster_id,
        canonical_category_id: c.canonical_category_id,
        canonical_label: c.canonical_label,
        alias_category_ids: c.alias_category_ids,
        alias_labels: c.alias_labels,
        gender_hint,
        llm_confidence: c.llm_confidence,
        llm_reasoning: c.llm_reasoning,
        affected_item_count,
      });
    }

    // Sort alphabetically by canonical_label (case-insensitive)
    annotated.sort((a, b) =>
      a.canonical_label.toLowerCase().localeCompare(b.canonical_label.toLowerCase()),
    );

    console.log(
      `[type-dedup] clusters: raw=${clusterResult.clusters.length}, post-filter=${annotated.length} (confidence-floor=${CONFIDENCE_FLOOR})`,
    );

    // Step F — write export
    const exportPayload = {
      items_processed,
      clusters: annotated,
      run_id: workflow_run_id,
      generated_at: new Date().toISOString(),
      cost_cents_used: clusterResult.cost_cents_used,
      aborted_due_to_cost: clusterResult.aborted_due_to_cost,
    };
    const exp = await writeExport(workflow_run_id, exportPayload, {
      dryRunTest: inputData.dry_run_test,
      outputDirOverride: inputData.output_dir_override,
    });

    return {
      items_processed,
      clusters: annotated,
      export_json_url: exp.url,
      cost_cents_used: clusterResult.cost_cents_used,
      aborted_due_to_cost: clusterResult.aborted_due_to_cost,
      audit_log_ids: [],
      workflow_run_id,
    };
  },
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const typeDedup = createWorkflow({
  id: "typeDedup",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(routeAndExecute)
  .commit();
