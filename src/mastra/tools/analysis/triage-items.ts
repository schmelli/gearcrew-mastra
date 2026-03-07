/**
 * Mastra Tool: Triage Items
 * Uses the Analyst to triage flagged items and recommend actions
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Dynamic import to avoid circular dependency
async function getAnalyst() {
  const { getAnalystAgent } = await import('@/mastra/agents/analyst');
  return getAnalystAgent();
}

const TriagedItemSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  brand: z.string().optional(),
  priority: z.number(),
  recommendedAction: z.enum(['research', 'delete', 'review', 'skip']),
  reasoning: z.string(),
  scores: z.object({
    centrality: z.number(),
    completeness: z.number(),
    staleness: z.number(),
    orphanScore: z.number(),
  }),
});

const TriageItemsOutputSchema = z.object({
  items: z.array(TriagedItemSchema),
  summary: z.object({
    total: z.number(),
    byAction: z.record(z.number()),
    averagePriority: z.number(),
  }),
});

export const triageItemsTool = createTool({
  id: 'triage-items',
  description: 'Use the Analyst to triage flagged items and recommend actions (research, delete, review, skip)',
  inputSchema: z.object({
    limit: z.number().default(20).describe('Maximum items to triage'),
  }),
  outputSchema: TriageItemsOutputSchema,
  execute: async ({ context }) => {
    const { limit } = context;
    const analyst = await getAnalyst();
    const items = await analyst.findItemsNeedingEnrichment({ limit, maxCompleteness: 0.7 });

    const flagged = items.map(item => ({
      nodeId: item.nodeId,
      name: item.name,
      brand: item.brand,
      category: item.category,
      flagReason: item.flagReason,
    }));

    const triageResults = await analyst.triageFlaggedItems(flagged);

    // Transform results to match output schema
    // TriageResult has: itemId, itemName, priority (string), priorityScore (number), factors
    const byAction: Record<string, number> = {};
    let totalPriority = 0;

    for (const item of triageResults) {
      const action = item.recommendedAction;
      byAction[action] = (byAction[action] || 0) + 1;
      totalPriority += item.priorityScore;
    }

    return {
      items: triageResults.map((r, idx) => ({
        nodeId: r.itemId,
        name: r.itemName,
        brand: flagged[idx]?.brand, // Get brand from original input
        priority: r.priorityScore,
        recommendedAction: r.recommendedAction,
        reasoning: r.reasoning,
        scores: {
          centrality: r.factors.centrality,
          completeness: r.factors.dataCompleteness,
          staleness: r.factors.staleness,
          orphanScore: r.factors.isOrphan,
        },
      })),
      summary: {
        total: triageResults.length,
        byAction,
        averagePriority: triageResults.length > 0 ? totalPriority / triageResults.length : 0,
      },
    };
  },
});

export default triageItemsTool;
