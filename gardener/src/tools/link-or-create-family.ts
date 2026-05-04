/**
 * linkOrCreateFamily — MERGE :ProductFamily with correct schema
 *
 * The :ProductFamily node + (g)-[:IS_VARIANT_OF]->(f) + (f)-[:PRODUCED_BY]->(b)
 * pattern is non-trivial (canonical_name, brand_id from :OutdoorBrand,
 * familyId uniqueness). When the agent tries to do this with raw graphWrite
 * it often gets the schema wrong (forgets PRODUCED_BY, omits canonical_name,
 * or creates duplicates). This tool encapsulates the convention.
 *
 * Idempotent: if the family already exists for that brand, just adds the
 * IS_VARIANT_OF edge. If both family and edge already exist, returns
 * created=false / edge_created=false but reports success.
 *
 * Does NOT use enrichGearItem (relationship target, not property). Caller
 * may follow up with enrichGearItem(target='product_family', ...) if it
 * wants to record the action in the cooldown tracker.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getWriteSession, toNumber } from "../lib/memgraph.js";

export const linkOrCreateFamily = createTool({
  id: "linkOrCreateFamily",
  description: `Link a :GearItem to a :ProductFamily, creating the family if it doesn't exist yet.
The MERGE chain enforces the canonical schema:
  MERGE (b:OutdoorBrand {name: brandName})  // must exist
  MERGE (f:ProductFamily {familyId: brand-name slug})
    ON CREATE SET f.canonical_name = familyName, f.created_at = datetime()
  MERGE (g)-[:IS_VARIANT_OF]->(f)
  MERGE (f)-[:PRODUCED_BY]->(b)

The familyId is computed deterministically from brand + family name (lowercase
slug). If the brand doesn't exist as :OutdoorBrand yet, this tool returns
brand_not_found=true without creating anything — the agent must first ensure
the brand exists before linking its families.`,
  inputSchema: z.object({
    itemNodeId: z
      .union([z.string(), z.number()])
      .describe("Memgraph internal node ID of the :GearItem"),
    familyName: z
      .string()
      .min(1)
      .describe("Canonical family name (e.g. 'Hubba Hubba', 'Atom', 'NeoAir')"),
    brandName: z
      .string()
      .min(1)
      .describe("Brand the family belongs to (must already exist as :OutdoorBrand)"),
    reason: z.string().describe("Why this link is being made (audit-log)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    family_node_id: z.string().nullable(),
    family_id: z.string().nullable(),
    family_created: z.boolean(),
    edge_created: z.boolean(),
    brand_not_found: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ context: { itemNodeId, familyName, brandName } }) => {
    const familyId = slugify(`${brandName}-${familyName}`);

    const session = getWriteSession();
    try {
      // Step 1: verify brand exists. Don't create — that's an OutdoorBrand
      // discovery decision that belongs to a different workflow.
      const brandCheck = await session.run(
        `
MATCH (b:OutdoorBrand) WHERE toLower(b.name) = toLower($brandName)
RETURN ID(b) AS id, b.name AS name LIMIT 1
`.trim(),
        { brandName },
      );
      if (brandCheck.records.length === 0) {
        return {
          success: false,
          family_node_id: null,
          family_id: null,
          family_created: false,
          edge_created: false,
          brand_not_found: true,
          error: `:OutdoorBrand '${brandName}' does not exist; create it before linking families`,
        };
      }
      const canonicalBrand = String(brandCheck.records[0]!.get("name"));

      // Step 2: MERGE the family + the two edges in one transaction.
      const result = await session.run(
        `
MATCH (g:GearItem) WHERE ID(g) = toInteger($itemNodeId)
MATCH (b:OutdoorBrand) WHERE toLower(b.name) = toLower($brandName)
MERGE (f:ProductFamily {familyId: $familyId})
  ON CREATE SET
    f.canonical_name = $familyName,
    f.brand_name = $canonicalBrand,
    f.created_at = datetime()
WITH g, b, f,
  CASE WHEN f.created_at = datetime() THEN true ELSE false END AS family_created
MERGE (g)-[item_edge:IS_VARIANT_OF]->(f)
MERGE (f)-[brand_edge:PRODUCED_BY]->(b)
RETURN
  ID(f) AS family_node_id,
  f.familyId AS family_id,
  family_created
`.trim(),
        {
          itemNodeId: typeof itemNodeId === "string" ? Number(itemNodeId) : itemNodeId,
          familyName,
          familyId,
          brandName,
          canonicalBrand,
        },
      );

      const rec = result.records[0];
      if (!rec) {
        return {
          success: false,
          family_node_id: null,
          family_id: null,
          family_created: false,
          edge_created: false,
          brand_not_found: false,
          error: `MERGE returned no records — :GearItem ID ${itemNodeId} not found?`,
        };
      }

      const counters = result.summary.counters.updates();
      return {
        success: true,
        family_node_id: String(toNumber(rec.get("family_node_id"))),
        family_id: String(rec.get("family_id")),
        family_created: Boolean(rec.get("family_created")),
        edge_created: counters.relationshipsCreated > 0,
        brand_not_found: false,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        family_node_id: null,
        family_id: null,
        family_created: false,
        edge_created: false,
        brand_not_found: false,
        error: reason.slice(0, 500),
      };
    } finally {
      await session.close();
    }
  },
});

/**
 * Build a deterministic familyId slug from "brand-name". Lowercase, hyphens,
 * strip non-alphanumerics. e.g. "MSR-Hubba Hubba NX" → "msr-hubba-hubba-nx".
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
