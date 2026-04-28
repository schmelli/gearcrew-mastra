/**
 * Brand-Dedup Apply-Mode Memgraph Mutation Helper
 *
 * Split out from brand-dedup.ts to keep both files under the 500-line CLAUDE.md
 * limit. This module ONLY mutates the graph — Supabase queue updates and
 * audit-log writes happen in brand-dedup.ts orchestration steps.
 *
 * Idempotent merge pattern (Memgraph, no Neo4j-specific syntax):
 *   For each alias name:
 *     1. MATCH alias + canonical OutdoorBrand nodes (case-insensitive)
 *     2. Re-point every (g:GearItem)-[:MADE_BY]->alias edge to canonical
 *        (MERGE the new edge so re-running this is a no-op)
 *     3. DELETE the old alias→canonical relationships
 *     4. MERGE alias-[:HAS_ALIAS_OF]->canonical for autocomplete-resolution
 *     5. Set alias.item_count = 0 to mark it merged-away
 *
 * Self-merge skip: if alias.toLowerCase() === canonical.toLowerCase() the
 * alias IS the canonical — we count it as 0 merged_items / 0 alias_edges.
 */

import { getWriteSession, toNumber } from "../lib/memgraph.js";

export interface ApplyResult {
  merged_items: number;
  alias_edges_created: number;
}

const APPLY_CYPHER = `
MATCH (alias:OutdoorBrand) WHERE toLower(alias.name) = toLower($aliasName)
MATCH (canonical:OutdoorBrand) WHERE toLower(canonical.name) = toLower($canonicalName)
OPTIONAL MATCH (g:GearItem)-[r:MADE_BY]->(alias)
WITH alias, canonical, collect({item: g, oldRel: r}) AS edges
FOREACH (edge IN edges |
  FOREACH (item IN CASE WHEN edge.item IS NULL THEN [] ELSE [edge.item] END |
    MERGE (item)-[:MADE_BY]->(canonical)
    DELETE edge.oldRel
  )
)
WITH alias, canonical, size(edges) AS movedEdges
MERGE (alias)-[:HAS_ALIAS_OF]->(canonical)
SET alias.item_count = 0
RETURN canonical.name AS canonical, movedEdges AS merged_items
`;

/**
 * Apply a brand-cluster merge to Memgraph: for each alias, re-point its
 * GearItems' MADE_BY edges to the canonical brand and create a HAS_ALIAS_OF
 * back-reference so future autocomplete can resolve "Thermarest" → "Therm-a-Rest".
 *
 * @param canonical  Canonical brand name (must exist as OutdoorBrand node)
 * @param aliases    List of alias names. Self-references are skipped silently.
 * @returns          { merged_items, alias_edges_created }
 */
export async function applyBrandClusterMerge(
  canonical: string,
  aliases: string[],
): Promise<ApplyResult> {
  if (!canonical || canonical.trim().length === 0) {
    throw new Error("applyBrandClusterMerge: canonical name is required");
  }

  const session = getWriteSession();
  let merged_items = 0;
  let alias_edges_created = 0;

  try {
    for (const aliasName of aliases) {
      if (!aliasName || aliasName.trim().length === 0) {
        console.warn(`[brand-dedup-apply] skipping empty alias for canonical=${canonical}`);
        continue;
      }
      if (aliasName.toLowerCase() === canonical.toLowerCase()) {
        // Self-merge — alias IS the canonical, no-op.
        continue;
      }

      const res = await session.run(APPLY_CYPHER, {
        aliasName,
        canonicalName: canonical,
      });

      const record = res.records[0];
      if (!record) {
        console.warn(
          `[brand-dedup-apply] no result for alias="${aliasName}" → canonical="${canonical}" — likely missing OutdoorBrand node, skipping`,
        );
        continue;
      }
      const moved = toNumber(record.get("merged_items"));
      merged_items += moved;
      alias_edges_created += 1;

      console.log(
        `[brand-dedup-apply] merged alias="${aliasName}" → canonical="${canonical}" (${moved} GearItem edges re-pointed)`,
      );
    }
  } finally {
    await session.close();
  }

  return { merged_items, alias_edges_created };
}
