/**
 * Mastra Tool: Find Missing Data
 * Finds nodes with missing data that could benefit from enrichment
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Dynamic import to avoid circular dependency
async function getAnalyst() {
  const { getAnalystAgent } = await import('@/mastra/agents/analyst');
  return getAnalystAgent();
}

const MissingDataItemSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  completeness: z.string(),
  flagReason: z.string(),
});

const FindMissingDataOutputSchema = z.object({
  count: z.number(),
  items: z.array(MissingDataItemSchema),
});

export const findMissingDataTool = createTool({
  id: 'find-missing-data',
  description: 'Find nodes with missing data that could benefit from enrichment',
  inputSchema: z.object({
    limit: z.number().default(20),
  }),
  outputSchema: FindMissingDataOutputSchema,
  execute: async ({ context }) => {
    const { limit } = context;
    const analyst = await getAnalyst();
    const items = await analyst.findItemsNeedingEnrichment({ limit, maxCompleteness: 0.7 });

    return {
      count: items.length,
      items: items.map(item => ({
        nodeId: item.nodeId,
        name: item.name,
        completeness: `${Math.round(item.completeness * 100)}%`,
        flagReason: item.flagReason,
      })),
    };
  },
});

export default findMissingDataTool;
