/**
 * Mastra Tool: Query Graph
 * Executes a read-only Cypher query against the graph database
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getMemgraphClient } from '@/lib/memgraph-client';

const QueryGraphOutputSchema = z.object({
  rows: z.array(z.unknown()),
  error: z.string().optional(),
});

export const queryGraphTool = createTool({
  id: 'query-graph',
  description: 'Execute a read-only Cypher query against the graph database',
  inputSchema: z.object({
    query: z.string().describe('Cypher query (read-only, no CREATE/DELETE/SET)'),
  }),
  outputSchema: QueryGraphOutputSchema,
  execute: async ({ context }) => {
    const { query } = context;
    const client = getMemgraphClient();

    const normalizedQuery = query.trim().toUpperCase();
    const dangerousKeywords = [
      'CREATE', 'DELETE', 'DETACH', 'SET', 'REMOVE', 'MERGE',
      'DROP', 'CALL', 'LOAD', 'FOREACH'
    ];

    for (const keyword of dangerousKeywords) {
      // Only block if keyword appears as a standalone word (not part of another word)
      const regex = new RegExp(`\\b${keyword}\\b`);
      if (regex.test(normalizedQuery)) {
        return {
          rows: [],
          error: `Query contains forbidden keyword: ${keyword}. Only read-only queries are allowed.`,
        };
      }
    }

    try {
      const results = await client.readOnlyQuery(query);
      return { rows: results };
    } catch (error) {
      return {
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export default queryGraphTool;
