import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getWriteSession } from "../lib/memgraph.js";

export const graphWrite = createTool({
  id: "graphWrite",
  description: `Execute a write Cypher query against the GearGraph Memgraph database.
CRITICAL: Always use MERGE, never CREATE, to prevent duplicates.
CRITICAL: Always validate with the validateSchema tool before writing.
CRITICAL: Include source provenance (sourceUrl, updatedAt) on new data.
After writing, always verify with a graphQuery read-back.`,
  inputSchema: z.object({
    query: z.string().describe("The Cypher MERGE/SET query to execute"),
    params: z
      .record(z.any())
      .optional()
      .describe("Query parameters"),
    reason: z
      .string()
      .describe("Why this write is being performed (for audit log)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    nodesCreated: z.number(),
    propertiesSet: z.number(),
    relationshipsCreated: z.number(),
    summary: z.string(),
  }),
  execute: async ({ context: { query, params, reason } }) => {
    const upper = query.toUpperCase();
    if (
      upper.includes("DELETE") ||
      upper.includes("DETACH DELETE") ||
      upper.includes("DROP") ||
      upper.includes("REMOVE")
    ) {
      throw new Error(
        "Destructive operations (DELETE/DROP/REMOVE) are not allowed. Use data-quality-audit workflow for corrections.",
      );
    }

    const session = getWriteSession();
    try {
      const result = await session.run(query, params || {});
      const counters = result.summary.counters.updates();

      console.log(
        `[Gardener Write] ${reason} | Nodes+${counters.nodesCreated} Rels+${counters.relationshipsCreated}`,
      );

      return {
        success: true,
        nodesCreated: counters.nodesCreated,
        propertiesSet: counters.propertiesSet,
        relationshipsCreated: counters.relationshipsCreated,
        summary: `Created ${counters.nodesCreated} nodes, ${counters.relationshipsCreated} relationships, set ${counters.propertiesSet} properties`,
      };
    } finally {
      await session.close();
    }
  },
});
