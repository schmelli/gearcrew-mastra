import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getSession } from "../lib/memgraph";

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
    nodesModified: z.number(),
    relationshipsCreated: z.number(),
    summary: z.string(),
  }),
  execute: async ({ context: { query, params, reason } }) => {
    const upper = query.toUpperCase();
    if (
      upper.includes("DELETE") ||
      upper.includes("DETACH DELETE") ||
      upper.includes("DROP")
    ) {
      throw new Error(
        "Destructive operations (DELETE/DROP) are not allowed. Use data-quality-audit workflow for corrections.",
      );
    }

    const session = getSession();
    try {
      const result = await session.run(query, params || {});
      const counters = result.summary.counters.updates();

      console.log(
        `[Gardener Write] ${reason} | Nodes+${counters.nodesCreated} Rels+${counters.relationshipsCreated}`,
      );

      return {
        success: true,
        nodesCreated: counters.nodesCreated,
        nodesModified: counters.propertiesSet,
        relationshipsCreated: counters.relationshipsCreated,
        summary: `Created ${counters.nodesCreated} nodes, ${counters.relationshipsCreated} relationships, set ${counters.propertiesSet} properties`,
      };
    } finally {
      await session.close();
    }
  },
});
