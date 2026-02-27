import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getReadSession } from "../lib/memgraph.js";

export const graphQuery = createTool({
  id: "graphQuery",
  description: `Execute a read-only Cypher query against the GearGraph Memgraph database.
Use this to check what data already exists before making changes.
Common queries:
- Check brand completeness: MATCH (b:OutdoorBrand {name: $name}) OPTIONAL MATCH (b)-[r]->() RETURN b, count(r)
- Find brands needing enrichment: MATCH (b:OutdoorBrand) WHERE NOT (b)-[:MANUFACTURES]->() RETURN b.name
- Count items per brand: MATCH (g:GearItem {brand: $brand}) RETURN count(g)
- Check for duplicates: MATCH (g:GearItem) WHERE g.name CONTAINS $term RETURN g.name, g.brand, g.gearId`,
  inputSchema: z.object({
    query: z.string().describe("The Cypher query to execute (READ-only)"),
    params: z
      .record(z.any())
      .optional()
      .describe("Query parameters (use $param syntax in query)"),
  }),
  outputSchema: z.object({
    records: z.array(z.record(z.any())),
    summary: z.string(),
  }),
  execute: async ({ context: { query, params } }) => {
    const session = getReadSession();
    try {
      const result = await session.run(query, params || {});
      const records = result.records.map((r) => r.toObject());
      return {
        records,
        summary: `Returned ${records.length} records`,
      };
    } finally {
      await session.close();
    }
  },
});
