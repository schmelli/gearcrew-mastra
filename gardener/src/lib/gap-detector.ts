/**
 * Gap-Detector — finds :GearItem nodes that need enrichment attention
 *
 * Phase-1 building block for the 3-layer Gardener architecture:
 *   Layer 1 (Sweeper) calls `detectGapsForItems` hourly to identify items with
 *   missing properties or stale relationships, scores them, and writes the
 *   top-N into the Supabase `gardener_work_queue`.
 *
 *   Layer 2 (Enrichment-Cycle) uses `detectGapsForItem` as a tool wrapper
 *   (`getEnrichmentGaps`) so the agent can ask "what's still missing on this
 *   specific item?" before deciding which research strategy to apply.
 *
 * Pure function — no side effects, no Supabase writes. Caller persists the
 * output. Cypher is Memgraph-3.x-compatible (no NULLS FIRST, no `(?i)`
 * regex flags, parametrized).
 *
 * Gap taxonomy (in priority-score weight order):
 *   product_url        4   — without it, image+weight scrapers can't run
 *   image_url          3   — UI shows placeholder
 *   weight_grams       3   — core spec for outdoor gear
 *   product_type       2   — needed for taxonomy navigation
 *   product_family     2   — relates variants together
 *   description        1   — nice-to-have, low impact
 *   insights           1   — only meaningful when transcripts exist
 *   stale_verification 2   — last_verified_at older than 90 days
 *   successor_check    2   — successor_check_at older than 30 days
 *
 * Plus boost terms:
 *   top50 brand        +5  — popular gear gets first attention
 *   recently added     +3  — created < 14 days ago, still raw
 *
 * Cooldowns enforced via WHERE clause:
 *   top-50 brand item: skip if last_enriched_at within 7 days
 *   long-tail item:    skip if last_enriched_at within 30 days
 */

import { getReadSession, toNumber } from "./memgraph.js";

export type GapTarget =
  | "product_url"
  | "image_url"
  | "weight_grams"
  | "product_type"
  | "product_family"
  | "description"
  | "insights"
  | "stale_verification"
  | "successor_check";

export interface GapInventoryItem {
  memgraph_node_id: string;
  gear_id: string | null;
  brand: string | null;
  name: string | null;
  gaps: GapTarget[];
  priority_score: number;
  is_top50_brand: boolean;
}

export interface DetectGapsOptions {
  /** Maximum number of items to return (default 500). */
  limit?: number;
  /** Minimum priority_score to include (default 1). Use 0 to include items with only a freshness boost. */
  minPriorityScore?: number;
  /**
   * Skip the cooldown filter — useful for one-off audit runs or for the
   * tool-call form (`getEnrichmentGaps` for a single nodeId where the agent
   * wants the gap inventory regardless of recent enrichment activity).
   */
  ignoreCooldown?: boolean;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_MIN_PRIORITY = 1;

/**
 * Sweeper variant: returns up to `limit` items ranked by priority_score DESC.
 * Honors cooldowns by default; pass `ignoreCooldown: true` for a full audit.
 */
export async function detectGapsForItems(
  opts: DetectGapsOptions = {},
): Promise<GapInventoryItem[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const minPriority = opts.minPriorityScore ?? DEFAULT_MIN_PRIORITY;
  const ignoreCooldown = opts.ignoreCooldown ?? false;

  const session = getReadSession();
  try {
    const result = await session.run(BUILD_GAP_QUERY({ ignoreCooldown }), {
      limit: BigInt(limit),
      minPriority: minPriority,
    });
    return result.records.map(recordToGapItem);
  } finally {
    await session.close();
  }
}

/**
 * Tool-call variant: returns the gap inventory for one specific item by its
 * Memgraph internal ID. Always ignores cooldown — the agent has a reason to ask.
 */
export async function detectGapsForItem(
  nodeId: string | number,
): Promise<GapInventoryItem | null> {
  const session = getReadSession();
  try {
    const result = await session.run(SINGLE_ITEM_GAP_QUERY, {
      nodeId: typeof nodeId === "string" ? Number(nodeId) : nodeId,
    });
    if (result.records.length === 0) return null;
    return recordToGapItem(result.records[0]!);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Cypher
// ---------------------------------------------------------------------------

/**
 * Build the gap inventory + priority score query. Two variants share most of
 * the body via a flag, because the cooldown clause must be embedded in the
 * MATCH-WHERE chain (Memgraph doesn't accept a runtime flag inside duration()).
 */
function BUILD_GAP_QUERY(args: { ignoreCooldown: boolean }): string {
  const cooldownClause = args.ignoreCooldown
    ? ""
    : `AND (
         g.last_enriched_at IS NULL
         OR (coalesce(b.is_top50, false) AND g.last_enriched_at < datetime() - duration('P7D'))
         OR (NOT coalesce(b.is_top50, false) AND g.last_enriched_at < datetime() - duration('P30D'))
       )`;

  return `
MATCH (g:GearItem)
OPTIONAL MATCH (g)-[:PRODUCED_BY]->(b:OutdoorBrand)
WITH g, b,
  [
    CASE WHEN g.product_url IS NULL OR g.product_url = '' THEN 'product_url' END,
    CASE WHEN g.image_url IS NULL OR g.image_url = '' THEN 'image_url' END,
    CASE WHEN g.weight_grams IS NULL OR g.weight_grams = 0 THEN 'weight_grams' END,
    CASE WHEN NOT EXISTS((g)-[:IS_TYPE]->(:ProductType)) THEN 'product_type' END,
    CASE WHEN NOT EXISTS((g)-[:IS_VARIANT_OF]->(:ProductFamily)) THEN 'product_family' END,
    CASE WHEN g.description IS NULL OR size(coalesce(g.description, '')) < 200 THEN 'description' END,
    CASE
      WHEN NOT EXISTS((g)-[:HAS_INSIGHT]->(:Insight))
       AND EXISTS((g)-[:EXTRACTED_FROM]->(:VideoSource))
      THEN 'insights'
    END,
    CASE
      WHEN g.last_verified_at IS NULL OR g.last_verified_at < datetime() - duration('P90D')
      THEN 'stale_verification'
    END,
    CASE
      WHEN g.successor_check_at IS NULL OR g.successor_check_at < datetime() - duration('P30D')
      THEN 'successor_check'
    END
  ] AS raw_gaps
WITH g, b, [x IN raw_gaps WHERE x IS NOT NULL] AS gaps
WHERE size(gaps) > 0
  ${cooldownClause}
WITH g, b, gaps,
  (
    (CASE WHEN coalesce(b.is_top50, false) THEN 5 ELSE 0 END)
    + (CASE WHEN 'product_url' IN gaps THEN 4 ELSE 0 END)
    + (CASE WHEN 'image_url' IN gaps THEN 3 ELSE 0 END)
    + (CASE WHEN 'weight_grams' IN gaps THEN 3 ELSE 0 END)
    + (CASE WHEN 'product_type' IN gaps THEN 2 ELSE 0 END)
    + (CASE WHEN 'description' IN gaps THEN 1 ELSE 0 END)
    + (CASE WHEN 'product_family' IN gaps THEN 2 ELSE 0 END)
    + (CASE WHEN 'insights' IN gaps THEN 1 ELSE 0 END)
    + (CASE WHEN 'stale_verification' IN gaps THEN 2 ELSE 0 END)
    + (CASE WHEN 'successor_check' IN gaps THEN 1 ELSE 0 END)
    + (CASE
         WHEN g.created_at IS NOT NULL AND g.created_at > datetime() - duration('P14D')
         THEN 3 ELSE 0
       END)
  ) AS priority_score
WHERE priority_score >= toInteger($minPriority)
RETURN
  ID(g) AS memgraph_node_id,
  g.gearId AS gear_id,
  g.brand AS brand,
  g.name AS name,
  gaps,
  priority_score,
  coalesce(b.is_top50, false) AS is_top50_brand
ORDER BY priority_score DESC, g.created_at ASC
LIMIT toInteger($limit)
`.trim();
}

/**
 * Single-item gap lookup. Used by the `getEnrichmentGaps` tool. Cooldown is
 * intentionally ignored — the agent already decided to ask about this item.
 */
const SINGLE_ITEM_GAP_QUERY = `
MATCH (g:GearItem) WHERE ID(g) = toInteger($nodeId)
OPTIONAL MATCH (g)-[:PRODUCED_BY]->(b:OutdoorBrand)
WITH g, b,
  [
    CASE WHEN g.product_url IS NULL OR g.product_url = '' THEN 'product_url' END,
    CASE WHEN g.image_url IS NULL OR g.image_url = '' THEN 'image_url' END,
    CASE WHEN g.weight_grams IS NULL OR g.weight_grams = 0 THEN 'weight_grams' END,
    CASE WHEN NOT EXISTS((g)-[:IS_TYPE]->(:ProductType)) THEN 'product_type' END,
    CASE WHEN NOT EXISTS((g)-[:IS_VARIANT_OF]->(:ProductFamily)) THEN 'product_family' END,
    CASE WHEN g.description IS NULL OR size(coalesce(g.description, '')) < 200 THEN 'description' END,
    CASE
      WHEN NOT EXISTS((g)-[:HAS_INSIGHT]->(:Insight))
       AND EXISTS((g)-[:EXTRACTED_FROM]->(:VideoSource))
      THEN 'insights'
    END,
    CASE
      WHEN g.last_verified_at IS NULL OR g.last_verified_at < datetime() - duration('P90D')
      THEN 'stale_verification'
    END,
    CASE
      WHEN g.successor_check_at IS NULL OR g.successor_check_at < datetime() - duration('P30D')
      THEN 'successor_check'
    END
  ] AS raw_gaps
WITH g, b, [x IN raw_gaps WHERE x IS NOT NULL] AS gaps,
  (CASE WHEN coalesce(b.is_top50, false) THEN 5 ELSE 0 END) AS top50_boost
WITH g, b, gaps, top50_boost,
  (
    top50_boost
    + (CASE WHEN 'product_url' IN gaps THEN 4 ELSE 0 END)
    + (CASE WHEN 'image_url' IN gaps THEN 3 ELSE 0 END)
    + (CASE WHEN 'weight_grams' IN gaps THEN 3 ELSE 0 END)
    + (CASE WHEN 'product_type' IN gaps THEN 2 ELSE 0 END)
    + (CASE WHEN 'description' IN gaps THEN 1 ELSE 0 END)
    + (CASE WHEN 'product_family' IN gaps THEN 2 ELSE 0 END)
    + (CASE WHEN 'insights' IN gaps THEN 1 ELSE 0 END)
    + (CASE WHEN 'stale_verification' IN gaps THEN 2 ELSE 0 END)
    + (CASE WHEN 'successor_check' IN gaps THEN 1 ELSE 0 END)
    + (CASE
         WHEN g.created_at IS NOT NULL AND g.created_at > datetime() - duration('P14D')
         THEN 3 ELSE 0
       END)
  ) AS priority_score
RETURN
  ID(g) AS memgraph_node_id,
  g.gearId AS gear_id,
  g.brand AS brand,
  g.name AS name,
  gaps,
  priority_score,
  coalesce(b.is_top50, false) AS is_top50_brand
`.trim();

// ---------------------------------------------------------------------------
// Record mapping
// ---------------------------------------------------------------------------

interface MgRecord {
  get(key: string): unknown;
}

function recordToGapItem(record: MgRecord): GapInventoryItem {
  const rawNodeId = record.get("memgraph_node_id");
  const memgraph_node_id = String(toNumber(rawNodeId));

  const rawGaps = record.get("gaps");
  const gaps: GapTarget[] = Array.isArray(rawGaps)
    ? (rawGaps.filter((g): g is GapTarget => typeof g === "string") as GapTarget[])
    : [];

  return {
    memgraph_node_id,
    gear_id: nullableString(record.get("gear_id")),
    brand: nullableString(record.get("brand")),
    name: nullableString(record.get("name")),
    gaps,
    priority_score: toNumber(record.get("priority_score")),
    is_top50_brand: Boolean(record.get("is_top50_brand")),
  };
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return String(value);
}
