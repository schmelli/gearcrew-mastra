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

    // Block destructive operations
    const destructivePatterns = [
      /\bDELETE\b/,
      /\bDETACH\s+DELETE\b/,
      /\bDROP\b/,
      /\bREMOVE\b/,
      /\bFOREACH\b/,
      /\bCALL\s+\{/,  // Subquery calls that could bypass restrictions
    ];
    for (const pattern of destructivePatterns) {
      if (pattern.test(upper)) {
        throw new Error(
          "Destructive operations (DELETE/DETACH DELETE/DROP/REMOVE/FOREACH/CALL subquery) are not allowed. Use data-quality-audit workflow for corrections.",
        );
      }
    }

    // Enforce that write queries must contain MERGE (non-destructive upsert pattern)
    if (!upper.includes("MERGE")) {
      throw new Error(
        "Write queries must use MERGE to prevent duplicates. CREATE is not permitted.",
      );
    }

    // Limit query length to prevent excessively complex injected queries
    if (query.length > 4000) {
      throw new Error(
        "Query exceeds maximum allowed length (4000 characters). Break large writes into smaller batches.",
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
