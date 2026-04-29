/**
 * Supabase ↔ Memgraph Bridge — matching logic.
 *
 * Memgraph uses (brand, name) as the GearItem merge key. Supabase uses UUID.
 * To enable cross-graph queries (especially insights extraction by user-item
 * UUID), we stamp `g.supabase_id` on Memgraph nodes that have a matching
 * Supabase row.
 *
 * Matching strategy:
 *   - Exact case-insensitive on (brand, name)
 *   - Returns first match (Memgraph MERGE on (brand, name) means duplicates
 *     should not exist, but if they do, the first ID wins and we report the
 *     ambiguous count).
 *
 * Idempotency: SET g.supabase_id = $uuid is safe to re-run.
 */

import { type Session } from "neo4j-driver";
import { toNumber } from "./memgraph.js";

export interface SupabaseGearItem {
  id: string;
  brand: string | null;
  name: string;
}

export interface BridgeMatchResult {
  supabase_id: string;
  brand: string;
  name: string;
  match_count: number; // 0 = no match, 1 = unique, 2+ = ambiguous
  memgraph_node_id: number | null; // Internal Neo4j ID of the (first) matched node
  outcome: "matched" | "unmatched" | "ambiguous";
}

/**
 * Look up a Supabase gear_item in Memgraph by case-insensitive (brand, name).
 * Read-only — does not mutate.
 */
export async function findMemgraphMatch(
  session: Session,
  item: SupabaseGearItem,
): Promise<BridgeMatchResult> {
  const brand = (item.brand ?? "").trim();
  const name = item.name.trim();

  if (!brand || !name) {
    return {
      supabase_id: item.id,
      brand,
      name,
      match_count: 0,
      memgraph_node_id: null,
      outcome: "unmatched",
    };
  }

  const result = await session.run(
    `MATCH (g:GearItem)
     WHERE toLower(g.brand) = toLower($brand)
       AND toLower(g.name) = toLower($name)
     RETURN ID(g) AS node_id
     LIMIT 5`,
    { brand, name },
  );

  const matchCount = result.records.length;
  const firstNodeId =
    matchCount > 0 ? toNumber(result.records[0]!.get("node_id")) : null;

  return {
    supabase_id: item.id,
    brand,
    name,
    match_count: matchCount,
    memgraph_node_id: firstNodeId,
    outcome:
      matchCount === 0
        ? "unmatched"
        : matchCount === 1
          ? "matched"
          : "ambiguous",
  };
}

/**
 * Stamp `g.supabase_id` on a Memgraph node by internal node ID.
 * Caller must have already verified the match via findMemgraphMatch.
 */
export async function stampSupabaseId(
  session: Session,
  memgraphNodeId: number,
  supabaseId: string,
): Promise<void> {
  await session.run(
    `MATCH (g:GearItem) WHERE ID(g) = $nodeId
     SET g.supabase_id = $supabaseId,
         g.bridge_stamped_at = datetime()`,
    { nodeId: memgraphNodeId, supabaseId },
  );
}

/**
 * Ensure a Memgraph index exists on :GearItem(supabase_id).
 * Idempotent — `CREATE INDEX IF NOT EXISTS` semantics in Memgraph.
 */
export async function ensureBridgeIndex(session: Session): Promise<void> {
  // Memgraph uses different index syntax than Neo4j — `CREATE INDEX ON :Label(prop)`
  try {
    await session.run("CREATE INDEX ON :GearItem(supabase_id)");
  } catch (err) {
    // Index may already exist — Memgraph throws on duplicate, which is fine.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes("already exists")) {
      throw err;
    }
  }
}
