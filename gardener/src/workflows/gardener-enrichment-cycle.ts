/**
 * Gardener-Enrichment-Cycle Workflow — hourly Phase-2 of the 3-layer architecture
 *
 * Reads top-N items from Supabase `gardener_work_queue` (filled by the
 * Sweeper), claims them atomically (status='claimed'), then dispatches each
 * item to the GardenerHaiku agent which has all the gap-filling tools at its
 * disposal (enrichGearItem, enrichGearItemWeight, enrichGearItemImage,
 * discoverProductUrl, classifyProductType, etc).
 *
 * Per-item flow:
 *   1. Claim row (UPDATE status='claimed', claimed_by_run, claimed_at)
 *   2. Build agent prompt with item context + gap inventory
 *   3. agent.generate() with maxSteps=40 — the agent decides which tools
 *      to call in which order, writes via enrichGearItem (atomic + provenance)
 *   4. Cost-cap pre-check between items: if cumulative > maxCostUsd → break
 *   5. Finalize row: status='done' if any gap was filled, 'failed' otherwise.
 *
 * The agent's writes go directly to Memgraph for confidence ≥0.85, or to
 * gardener_review_queue for confidence 0.5..0.85 (handled inside enrichGearItem).
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getSupabase } from "../lib/supabase.js";
import {
  createCostRef,
  shouldAbort,
  recordRunCost,
  dollars,
} from "../lib/enrichment-cost-tracker.js";
import { getWriteSession } from "../lib/memgraph.js";

const triggerSchema = z.object({
  /** Maximum items to process per cycle (default 8). */
  maxItems: z.number().int().positive().default(8),
  /** Hard cost ceiling in USD (default 2.00). */
  maxCostUsd: z.number().positive().default(2.0),
  /** Dry-run: claim items, build prompts, but skip agent.generate + writes. */
  dryRun: z.boolean().default(false),
});

const itemResultSchema = z.object({
  memgraph_node_id: z.string(),
  brand: z.string().nullable(),
  name: z.string().nullable(),
  gaps_in: z.array(z.string()),
  gaps_filled: z.array(z.string()),
  gaps_failed: z.array(z.string()),
  tool_calls: z.number(),
  cost_cents: z.number(),
  status: z.enum(["done", "failed"]),
  duration_seconds: z.number(),
  error: z.string().optional(),
});

const outputSchema = z.object({
  workflow_run_id: z.string(),
  items_claimed: z.number(),
  items_done: z.number(),
  items_failed: z.number(),
  total_cost_cents: z.number(),
  aborted_cost_cap: z.boolean(),
  duration_seconds: z.number(),
  dry_run: z.boolean(),
  per_item: z.array(itemResultSchema),
});

interface ClaimedItem {
  id: string;
  memgraph_node_id: string;
  brand: string | null;
  name: string | null;
  gaps: string[];
  priority_score: number;
  is_top50_brand: boolean;
}

const cycleStep = createStep({
  id: "claim-and-enrich",
  description:
    "Claim top-N items from gardener_work_queue, dispatch each to GardenerHaiku for autonomous gap-filling, track cost, finalize row status",
  inputSchema: triggerSchema,
  outputSchema,
  async execute({ inputData, mastra }) {
    if (!mastra) throw new Error("Mastra context required");

    const workflow_run_id = `cycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
    const costRef = createCostRef("gardener-cycle");
    const maxCostCents = Math.round(inputData.maxCostUsd * 100);

    console.log(
      `[Gardener-Cycle] run=${workflow_run_id} maxItems=${inputData.maxItems} maxCost=${dollars(maxCostCents)} dryRun=${inputData.dryRun}`,
    );

    // --- Step 1: Claim top-N items ---
    const claimed = await claimItems(workflow_run_id, inputData.maxItems);
    if (claimed.length === 0) {
      console.log(`[Gardener-Cycle] no queued items — nothing to do`);
      return {
        workflow_run_id,
        items_claimed: 0,
        items_done: 0,
        items_failed: 0,
        total_cost_cents: 0,
        aborted_cost_cap: false,
        duration_seconds: 0,
        dry_run: inputData.dryRun,
        per_item: [],
      };
    }

    console.log(`[Gardener-Cycle] claimed ${claimed.length} items`);

    // --- Step 2: Per-item agent loop ---
    const agent = mastra.getAgent("GardenerHaiku");
    const perItem: z.infer<typeof itemResultSchema>[] = [];
    let abortedCostCap = false;

    for (const item of claimed) {
      // Pre-item cost check
      if (shouldAbort(costRef, maxCostCents)) {
        console.log(
          `[Gardener-Cycle] cost-cap reached (${dollars(costRef.cents)}), releasing remaining items`,
        );
        abortedCostCap = true;
        // Release the rest back to queue
        await releaseItem(item.id);
        continue;
      }

      const itemStart = Date.now();
      const result = await processItem({
        item,
        agent,
        workflow_run_id,
        dryRun: inputData.dryRun,
        costRef,
      });
      const durationSec = Math.round((Date.now() - itemStart) / 1000);

      perItem.push({
        memgraph_node_id: item.memgraph_node_id,
        brand: item.brand,
        name: item.name,
        gaps_in: item.gaps,
        gaps_filled: result.gaps_filled,
        gaps_failed: result.gaps_failed,
        tool_calls: result.tool_calls,
        cost_cents: result.cost_cents,
        status: result.status,
        duration_seconds: durationSec,
        error: result.error,
      });

      if (!inputData.dryRun) {
        await finalizeItem(item.id, result, costRef.cents);
      }
    }

    const itemsDone = perItem.filter((p) => p.status === "done").length;
    const itemsFailed = perItem.filter((p) => p.status === "failed").length;
    const duration = Math.round((Date.now() - startedAt) / 1000);

    console.log(
      `[Gardener-Cycle] done in ${duration}s — claimed=${claimed.length} done=${itemsDone} failed=${itemsFailed} cost=${dollars(costRef.cents)} aborted_cap=${abortedCostCap}`,
    );

    // --- Step 3: Telemetry write ---
    if (!inputData.dryRun) {
      await recordRunCost(
        costRef,
        workflow_run_id,
        "gardenerEnrichmentCycle",
        abortedCostCap ? "aborted_cost_cap" : "completed",
        {
          items_claimed: claimed.length,
          items_done: itemsDone,
          items_failed: itemsFailed,
        },
      );
    }

    return {
      workflow_run_id,
      items_claimed: claimed.length,
      items_done: itemsDone,
      items_failed: itemsFailed,
      total_cost_cents: costRef.cents,
      aborted_cost_cap: abortedCostCap,
      duration_seconds: duration,
      dry_run: inputData.dryRun,
      per_item: perItem,
    };
  },
});

export const gardenerEnrichmentCycle = createWorkflow({
  id: "gardenerEnrichmentCycle",
  inputSchema: triggerSchema,
  outputSchema,
})
  .then(cycleStep)
  .commit();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Atomically claim top-N queued items. Uses a Supabase RPC-like pattern via
 * UPDATE...RETURNING to emulate FOR UPDATE SKIP LOCKED. The two-step approach
 * (select + bulk-update) is simpler than raw SQL and good enough at our scale
 * (one cycle every hour, no concurrent runs).
 */
async function claimItems(
  workflow_run_id: string,
  maxItems: number,
): Promise<ClaimedItem[]> {
  const supa = getSupabase();
  const { data: candidates, error: selectErr } = await supa
    .from("gardener_work_queue")
    .select(
      "id, memgraph_node_id, brand, name, gaps, priority_score, is_top50_brand",
    )
    .eq("status", "queued")
    .order("priority_score", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(maxItems);

  if (selectErr) {
    throw new Error(`[Gardener-Cycle] queue select failed: ${selectErr.message}`);
  }
  if (!candidates || candidates.length === 0) return [];

  const ids = candidates.map((c) => c.id);
  const { error: updateErr } = await supa
    .from("gardener_work_queue")
    .update({
      status: "claimed",
      claimed_by_run: workflow_run_id,
      claimed_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "queued"); // Defensive: only flip if still queued

  if (updateErr) {
    throw new Error(`[Gardener-Cycle] queue claim failed: ${updateErr.message}`);
  }

  return candidates.map((c) => ({
    id: c.id,
    memgraph_node_id: c.memgraph_node_id,
    brand: c.brand,
    name: c.name,
    gaps: c.gaps ?? [],
    priority_score: c.priority_score,
    is_top50_brand: c.is_top50_brand ?? false,
  }));
}

/** Release a claimed item back to queued (used when cost-cap aborts). */
async function releaseItem(rowId: string): Promise<void> {
  const supa = getSupabase();
  await supa
    .from("gardener_work_queue")
    .update({
      status: "queued",
      claimed_by_run: null,
      claimed_at: null,
    })
    .eq("id", rowId);
}

interface ItemProcessResult {
  status: "done" | "failed";
  gaps_filled: string[];
  gaps_failed: string[];
  tool_calls: number;
  cost_cents: number;
  error?: string;
}

/**
 * Build a prompt for one item, run the agent, capture the outcome.
 * Cost is approximated from tool-call count + estimated tokens (Mastra
 * doesn't expose Anthropic usage detail in agent.generate output).
 */
async function processItem(args: {
  item: ClaimedItem;
  agent: ReturnType<typeof getAgentLike>;
  workflow_run_id: string;
  dryRun: boolean;
  costRef: ReturnType<typeof createCostRef>;
}): Promise<ItemProcessResult> {
  const { item, agent, workflow_run_id, dryRun, costRef } = args;

  const prompt = buildItemPrompt(item, workflow_run_id);

  if (dryRun) {
    console.log(
      `[Gardener-Cycle] dry-run item=${item.memgraph_node_id} (${item.brand}/${item.name}) gaps=${item.gaps.join(",")}`,
    );
    return {
      status: "done",
      gaps_filled: [],
      gaps_failed: item.gaps,
      tool_calls: 0,
      cost_cents: 0,
    };
  }

  let toolCalls = 0;
  let response: unknown;
  try {
    response = await agent.generate(prompt, {
      toolChoice: "auto",
      maxSteps: 40,
    });
    const r = response as { toolCalls?: unknown[] };
    toolCalls = r.toolCalls?.length ?? 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[Gardener-Cycle] agent failed for item=${item.memgraph_node_id}: ${reason}`,
    );
    return {
      status: "failed",
      gaps_filled: [],
      gaps_failed: item.gaps,
      tool_calls: 0,
      cost_cents: 0,
      error: reason.slice(0, 500),
    };
  }

  // Cost approximation: Haiku 4.5 ~ $1/$5 per Mtoken. Each agent step is
  // ~3-5k input + ~0.5k output tokens. With toolCalls iterations we estimate.
  const estimatedCostCents = Math.round(toolCalls * 0.4); // ~0.4¢ per tool call
  costRef.cents += estimatedCostCents;

  // Re-detect gaps to see what was actually filled.
  const { gapsFilled, gapsFailed } = await diffGapsAfterRun(
    item.memgraph_node_id,
    item.gaps,
  );

  const status: "done" | "failed" = gapsFilled.length > 0 ? "done" : "failed";
  return {
    status,
    gaps_filled: gapsFilled,
    gaps_failed: gapsFailed,
    tool_calls: toolCalls,
    cost_cents: estimatedCostCents,
  };
}

/**
 * Compare original gap list against the current Memgraph state to see which
 * gaps the agent actually filled. Uses a cheap inline Cypher rather than the
 * full gap-detector to avoid second-pass priority-score recomputation.
 */
async function diffGapsAfterRun(
  memgraph_node_id: string,
  originalGaps: string[],
): Promise<{ gapsFilled: string[]; gapsFailed: string[] }> {
  const session = getWriteSession();
  try {
    const res = await session.run(
      `
MATCH (g:GearItem) WHERE ID(g) = toInteger($id)
OPTIONAL MATCH (g)-[:IS_TYPE]->(pt:ProductType)
WITH g, count(DISTINCT pt) > 0 AS has_type
OPTIONAL MATCH (g)-[:IS_VARIANT_OF]->(pf:ProductFamily)
WITH g, has_type, count(DISTINCT pf) > 0 AS has_family
OPTIONAL MATCH (g)-[:HAS_INSIGHT]->(ins:Insight)
WITH g, has_type, has_family, count(DISTINCT ins) > 0 AS has_insight
RETURN
  (g.product_url IS NOT NULL AND g.product_url <> '') AS has_url,
  (g.image_url IS NOT NULL AND g.image_url <> '') AS has_image,
  (g.weight_grams IS NOT NULL AND g.weight_grams > 0) AS has_weight,
  has_type, has_family, has_insight,
  (g.description IS NOT NULL AND size(coalesce(g.description, '')) >= 200) AS has_description
`.trim(),
      { id: typeof memgraph_node_id === "string" ? Number(memgraph_node_id) : memgraph_node_id },
    );
    const rec = res.records[0];
    if (!rec) {
      return { gapsFilled: [], gapsFailed: originalGaps };
    }
    const stillMissing = new Set<string>();
    if (originalGaps.includes("product_url") && !rec.get("has_url")) stillMissing.add("product_url");
    if (originalGaps.includes("image_url") && !rec.get("has_image")) stillMissing.add("image_url");
    if (originalGaps.includes("weight_grams") && !rec.get("has_weight")) stillMissing.add("weight_grams");
    if (originalGaps.includes("product_type") && !rec.get("has_type")) stillMissing.add("product_type");
    if (originalGaps.includes("product_family") && !rec.get("has_family")) stillMissing.add("product_family");
    if (originalGaps.includes("description") && !rec.get("has_description")) stillMissing.add("description");
    if (originalGaps.includes("insights") && !rec.get("has_insight")) stillMissing.add("insights");
    // stale_verification + successor_check: not directly observable post-run
    // without their respective property writes; treat as unfilled.
    if (originalGaps.includes("stale_verification")) stillMissing.add("stale_verification");
    if (originalGaps.includes("successor_check")) stillMissing.add("successor_check");

    const gapsFilled = originalGaps.filter((g) => !stillMissing.has(g));
    const gapsFailed = originalGaps.filter((g) => stillMissing.has(g));
    return { gapsFilled, gapsFailed };
  } finally {
    await session.close();
  }
}

async function finalizeItem(
  rowId: string,
  result: ItemProcessResult,
  cumulativeCostCents: number,
): Promise<void> {
  const supa = getSupabase();
  const nowIso = new Date().toISOString();
  const summary = {
    gaps_filled: result.gaps_filled,
    gaps_failed: result.gaps_failed,
    tool_calls: result.tool_calls,
    cost_cents: result.cost_cents,
    cumulative_cost_cents: cumulativeCostCents,
    error: result.error,
  };
  // increment attempt_count via raw column update (Supabase JS doesn't support raw)
  const { data: current } = await supa
    .from("gardener_work_queue")
    .select("attempt_count")
    .eq("id", rowId)
    .maybeSingle();
  const newAttemptCount = ((current?.attempt_count as number | undefined) ?? 0) + 1;

  await supa
    .from("gardener_work_queue")
    .update({
      status: result.status,
      resolved_at: result.status === "done" ? nowIso : null,
      resolution_summary: summary,
      attempt_count: newAttemptCount,
      last_error: result.error ?? null,
    })
    .eq("id", rowId);
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildItemPrompt(item: ClaimedItem, workflow_run_id: string): string {
  const itemRef = item.brand && item.name
    ? `${item.brand} ${item.name}`
    : (item.name ?? item.brand ?? `node ${item.memgraph_node_id}`);
  const tier = item.is_top50_brand ? "Top-50 brand" : "long-tail brand";

  return `You are filling enrichment gaps on a single :GearItem in the GearGraph (Memgraph).

Item: **${itemRef}** (${tier}, priority_score=${item.priority_score})
Memgraph node ID: ${item.memgraph_node_id}
Open gaps: ${item.gaps.join(", ")}
Workflow run: ${workflow_run_id}

## Your job

Fill as many of the open gaps as you reasonably can. **Do not invent values.**
Each write must be backed by evidence from a manufacturer or trusted retailer URL.

## Tools at your disposal

- \`getEnrichmentGaps({nodeId})\` — confirm the gap inventory and read priority context
- \`getRecentEnrichments({nodeId})\` — check cooldowns and previous attempt errors
- \`discoverProductUrl({brand, name})\` — Serper Google-search ranked toward the manufacturer domain
- \`enrichGearItemImage({productUrl})\` — extract og:image / Twitter / JSON-LD product image
- \`enrichGearItemWeight({productUrl})\` — 5-stage weight extractor (JSON-LD → DL → label → Firecrawl → LLM)
- \`classifyProductType({nodeId})\` — match to one of the 154 :ProductType candidates
- \`webSearch({query})\` — generic Serper search for free-form recherche
- \`webScrape({url, extractSchema})\` — Firecrawl structured extraction
- \`graphQuery({query})\` — read-only Cypher (e.g. lookup the brand's other items)
- \`enrichGearItem({nodeId, target, value, source, confidence, evidence_url, reason})\`
  ← **the only way you write spec-property updates.** Confidence ≥0.85 writes
  to Memgraph; 0.5-0.85 routes to gardener_review_queue for human review;
  <0.5 drops with a cooldown touch. Always provide evidence_url when not
  pure synthesis.
- \`graphWrite({query, params, reason})\` — for non-property updates
  (e.g. MERGE :IS_TYPE relationship after classifyProductType)

## Recommended order

1. If \`product_url\` is missing → \`discoverProductUrl\`, then \`enrichGearItem(target='product_url', ...)\`.
2. Once a product URL exists, image + weight gaps are best filled by:
   - \`enrichGearItemImage\` → \`enrichGearItem(target='image_url', ...)\`
   - \`enrichGearItemWeight\` → \`enrichGearItem(target='weight_grams', ...)\`
3. \`product_type\` gap → \`classifyProductType\`, then \`graphWrite\` to
   MERGE the \`(g)-[:IS_TYPE]->(pt:ProductType {name: $name})\` edge.
4. \`description\` gap is lower priority — only if cost budget remains.

## Confidence guidance

- 0.95 = manufacturer-domain page with structured data (JSON-LD weight, og:image)
- 0.85 = manufacturer page with prose mention OR retailer with brand-trusted page
- 0.70 = retailer page with consistent value but no structured data
- 0.50 = LLM body-prose extraction without cross-reference
- <0.50 = ambiguous, don't write

## Hard rules

- Never invent a product URL. Use \`discoverProductUrl\` or skip the item.
- Never write a value without an \`evidence_url\` unless source='agent_synthesis' (only valid for description).
- If a gap target is in cooldown (per \`getRecentEnrichments\`), skip it.
- If a brand is "Amazon" or similarly generic and no manufacturer URL exists, skip the item — these are unfillable from web sources.
- Do not call any tool more than 3 times for the same gap. If still failing, move on.

Begin.`;
}

// Type helper to avoid pulling in the full Mastra agent type
function getAgentLike(): { generate: (...a: unknown[]) => Promise<unknown> } {
  throw new Error("type-only helper");
}
