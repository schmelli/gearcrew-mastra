/**
 * Family-Canonical-Names Apply-Mode Memgraph Mutation Helper
 *
 * Split out from family-canonical-names.ts to keep both files under the
 * 500-line limit. This module ONLY mutates the graph — Supabase queue
 * updates and audit-log writes happen in family-canonical-names.ts.
 *
 * Per classification:
 *
 *   "genuine":
 *     SET f.canonical_name = $canonical_name on the :ProductFamily node.
 *     If brand_name is provided AND a single :OutdoorBrand matches by name
 *     (case-insensitive), also SET f.brand_id (memgraph internal id as
 *     string) and f.brand_name. Existing IS_VARIANT_OF edges remain
 *     untouched.
 *
 *   "generic":
 *     DETACH DELETE the :ProductFamily node — drops all incoming
 *     IS_VARIANT_OF edges and the family knot. Variants (GearItems) keep
 *     their data, only their family-link is severed.
 *
 *   "ambiguous":
 *     Should be filtered out before reaching this module. Throws if seen.
 *
 * Memgraph internal id() is consumed via toInteger($node_id) since
 * family_node_id was stringified at snapshot time. The id() is stable for
 * the lifetime of the running database — re-snapshot if Memgraph restarts
 * between dry-run and apply.
 */

import { getWriteSession, toNumber } from "../lib/memgraph.js";

export interface ApplyFamilyParams {
  family_node_id: string;
  classification: "genuine" | "generic";
  canonical_name: string | null;
  brand_name: string | null;
}

export interface ApplyFamilyResult {
  variants_unlinked: number;
}

const GENUINE_CYPHER_WITH_BRAND = `
MATCH (f:ProductFamily) WHERE id(f) = toInteger($node_id)
OPTIONAL MATCH (b:OutdoorBrand) WHERE toLower(b.name) = toLower($brand_name)
WITH f, b
SET f.canonical_name = $canonical_name
SET f.brand_name = CASE WHEN b IS NOT NULL THEN b.name ELSE f.brand_name END
SET f.brand_id = CASE WHEN b IS NOT NULL THEN toString(id(b)) ELSE f.brand_id END
RETURN id(f) AS fid, b.name AS resolved_brand
`;

const GENUINE_CYPHER_NO_BRAND = `
MATCH (f:ProductFamily) WHERE id(f) = toInteger($node_id)
SET f.canonical_name = $canonical_name
RETURN id(f) AS fid
`;

const GENERIC_CYPHER = `
MATCH (f:ProductFamily) WHERE id(f) = toInteger($node_id)
OPTIONAL MATCH (f)<-[r:IS_VARIANT_OF]-()
WITH f, count(r) AS unlinked_count
DETACH DELETE f
RETURN unlinked_count AS variants_unlinked
`;

export async function applyFamilyClassification(
  params: ApplyFamilyParams,
): Promise<ApplyFamilyResult> {
  const { family_node_id, classification, canonical_name, brand_name } = params;

  if (!family_node_id || family_node_id.trim().length === 0) {
    throw new Error(
      "[family-canonical-apply] family_node_id is required",
    );
  }

  const session = getWriteSession();
  try {
    if (classification === "genuine") {
      if (!canonical_name || canonical_name.trim().length === 0) {
        throw new Error(
          `[family-canonical-apply] genuine classification requires canonical_name (family_node_id=${family_node_id})`,
        );
      }

      const useBrandPath =
        typeof brand_name === "string" && brand_name.trim().length > 0;
      const cypher = useBrandPath
        ? GENUINE_CYPHER_WITH_BRAND
        : GENUINE_CYPHER_NO_BRAND;
      const cypherParams: Record<string, unknown> = {
        node_id: family_node_id,
        canonical_name,
      };
      if (useBrandPath) cypherParams.brand_name = brand_name;

      const res = await session.run(cypher, cypherParams);
      const record = res.records[0];
      if (!record) {
        throw new Error(
          `[family-canonical-apply] no :ProductFamily found with id=${family_node_id}`,
        );
      }
      const resolvedBrand = useBrandPath
        ? (record.get("resolved_brand") as string | null)
        : null;
      console.log(
        `[family-canonical-apply] genuine: family_node_id=${family_node_id} canonical_name="${canonical_name}" brand_resolved=${resolvedBrand ?? "(none)"}`,
      );
      return { variants_unlinked: 0 };
    }

    // GENERIC PATH — DETACH DELETE
    const res = await session.run(GENERIC_CYPHER, {
      node_id: family_node_id,
    });
    const record = res.records[0];
    const variants_unlinked = record
      ? toNumber(record.get("variants_unlinked"))
      : 0;

    console.log(
      `[family-canonical-apply] generic: family_node_id=${family_node_id} DETACH DELETED, ${variants_unlinked} IS_VARIANT_OF edges removed`,
    );
    return { variants_unlinked };
  } finally {
    await session.close();
  }
}
