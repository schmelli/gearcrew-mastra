/**
 * Mastra Tool: Analyze Orphans
 * Detects and classifies orphan nodes (disconnected from main graph)
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Dynamic import to avoid circular dependency
async function getAnalyst() {
  const { getAnalystAgent } = await import('@/mastra/agents/analyst');
  return getAnalystAgent();
}

const OrphanAnalysisOutputSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z.object({
    orphanCount: z.number(),
    orphansByType: z.record(z.number()),
    orphansByClassification: z.record(z.number()),
    orphans: z.array(z.object({
      nodeId: z.string(),
      name: z.string(),
      nodeType: z.string(),
      classification: z.string(),
      hasValuableData: z.boolean(),
    })).optional(),
    recommendations: z.array(z.string()),
  }),
  error: z.string().optional(),
});

export const analyzeOrphansTool = createTool({
  id: 'analyze-orphans',
  description: 'Detect and classify orphan nodes (disconnected from main graph)',
  inputSchema: z.object({}),
  outputSchema: OrphanAnalysisOutputSchema,
  execute: async (_ctx) => {
    // No input parameters needed
    const analyst = await getAnalyst();
    const result = await analyst.analyzeOrphans();

    // Transform result to match output schema
    const orphansByType: Record<string, number> = {};
    const orphansByClassification: Record<string, number> = {};
    const orphans: Array<{
      nodeId: string;
      name: string;
      nodeType: string;
      classification: string;
      hasValuableData: boolean;
    }> = [];

    for (const classification of result.data.classifications) {
      const classType = classification.classification;

      // ClassificationResult uses 'classification' not 'nodeType'
      orphansByClassification[classType] = (orphansByClassification[classType] || 0) + 1;

      orphans.push({
        nodeId: classification.nodeId,
        name: classification.nodeId, // Use nodeId as name fallback
        nodeType: 'Unknown', // Not available in ClassificationResult
        classification: classType,
        hasValuableData: classification.hasValuableKeywords,
      });
    }

    const recommendations: string[] = [];
    if (result.data.recommendations.toDelete.length > 0) {
      recommendations.push(`Delete ${result.data.recommendations.toDelete.length} empty/valueless orphans`);
    }
    if (result.data.recommendations.toFlag.length > 0) {
      recommendations.push(`Flag ${result.data.recommendations.toFlag.length} orphans for review`);
    }

    return {
      status: 'success' as const,
      data: {
        orphanCount: result.data.orphanCount,
        orphansByType,
        orphansByClassification,
        orphans,
        recommendations,
      },
    };
  },
});

export default analyzeOrphansTool;
