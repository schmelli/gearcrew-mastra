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
 * Strip a brand prefix from a name. Handles cases like:
 *   "MSR Hubba Hubba NX 2" + brand="MSR" → "Hubba Hubba NX 2"
 *   "NITECORE NB20000 Power Bank" + brand="NITECORE" → "NB20000 Power Bank"
 * If the name does not start with the brand (case-insensitive), returns the
 * trimmed original.
 */
function stripBrandPrefix(name: string, brand: string): string {
  const lowerName = name.trim().toLowerCase();
  const lowerBrand = brand.trim().toLowerCase();
  if (!lowerBrand || !lowerName.startsWith(lowerBrand)) return name.trim();
  // Strip the brand and any leading separator (space, dash, slash, comma)
  return name
    .trim()
    .substring(brand.length)
    .replace(/^[\s\-/,]+/, "")
    .trim();
}

/**
 * Look up a Supabase gear_item in Memgraph.
 *
 * Match strategy (in order):
 *   1. EXACT case-insensitive (brand, name)
 *   2. EXACT (brand, stripped_name) — handles "MSR Hubba Hubba" → "Hubba Hubba"
 *   3. STARTS-WITH bidirectional (brand, stripped_name) — handles
 *      "Hubba Hubba 2" ↔ "Hubba Hubba NX 2"
 *
 * Returns the first found match; if multiple GearItems match the same query,
 * outcome is "ambiguous".
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

  // Compute stripped name once; reused across stages 2 & 3.
  const stripped = stripBrandPrefix(name, brand);

  // Stage 1+2+3 in a single query: try exact name, exact stripped, then
  // STARTS-WITH bidirectional. We assign a `priority` so callers can pick the
  // strongest match.
  const result = await session.run(
    `MATCH (g:GearItem)
     WHERE toLower(g.brand) = toLower($brand)
       AND (
         toLower(g.name) = toLower($name)
         OR toLower(g.name) = toLower($stripped)
         OR toLower(g.name) STARTS WITH toLower($stripped)
         OR toLower($stripped) STARTS WITH toLower(g.name)
       )
     RETURN ID(g) AS node_id,
            CASE
              WHEN toLower(g.name) = toLower($name) THEN 0
              WHEN toLower(g.name) = toLower($stripped) THEN 1
              WHEN toLower(g.name) STARTS WITH toLower($stripped)
                OR toLower($stripped) STARTS WITH toLower(g.name) THEN 2
              ELSE 9
            END AS priority
     ORDER BY priority ASC
     LIMIT 5`,
    { brand, name, stripped },
  );

  const matchCount = result.records.length;
  const firstNodeId =
    matchCount > 0 ? toNumber(result.records[0]!.get("node_id")) : null;

  // Determine ambiguity: if multiple records share the SAME priority (e.g.,
  // 2 different exact-stripped matches), it's ambiguous. Otherwise the
  // priority ordering picks the strongest, which is fine.
  let outcome: BridgeMatchResult["outcome"] = "unmatched";
  if (matchCount === 1) {
    outcome = "matched";
  } else if (matchCount > 1) {
    const topPriority = toNumber(result.records[0]!.get("priority"));
    const tiedAtTop = result.records.filter(
      (r) => toNumber(r.get("priority")) === topPriority,
    ).length;
    outcome = tiedAtTop === 1 ? "matched" : "ambiguous";
  }

  return {
    supabase_id: item.id,
    brand,
    name,
    match_count: matchCount,
    memgraph_node_id: firstNodeId,
    outcome,
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

export interface CatalogImagePayload {
  supabase_id: string;
  image_url: string | null;
  product_url: string | null;
}

export interface CatalogStampOutcome {
  image_url_set: boolean;
  product_url_set: boolean;
}

/**
 * Stamp catalog data onto a matched Memgraph GearItem.
 *
 * COALESCE-semantics: image_url and product_url are written ONLY if the
 * node currently has them as NULL — Memgraph data wins over catalog data
 * when both exist. supabase_id is always overwritten.
 *
 * Returns flags indicating which fields were actually set, so the caller
 * can report image-coverage delta accurately. We RETURN the boolean checks
 * before SET to read pre-state, then SET unconditionally on the COALESCE.
 */
export async function stampCatalogImage(
  session: Session,
  memgraphNodeId: number,
  payload: CatalogImagePayload,
): Promise<CatalogStampOutcome> {
  const result = await session.run(
    `MATCH (g:GearItem) WHERE ID(g) = $nodeId
     WITH g, g.image_url AS prev_image, g.product_url AS prev_url
     SET g.image_url     = COALESCE(g.image_url, $imageUrl),
         g.product_url   = COALESCE(g.product_url, $productUrl),
         g.supabase_id   = $supabaseId,
         g.bridge_source = 'catalog_products',
         g.bridge_stamped_at = datetime()
     RETURN prev_image IS NULL AND $imageUrl IS NOT NULL AS image_set,
            prev_url   IS NULL AND $productUrl IS NOT NULL AS url_set`,
    {
      nodeId: memgraphNodeId,
      imageUrl: payload.image_url,
      productUrl: payload.product_url,
      supabaseId: payload.supabase_id,
    },
  );
  const rec = result.records[0];
  return {
    image_url_set: Boolean(rec?.get("image_set")),
    product_url_set: Boolean(rec?.get("url_set")),
  };
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
