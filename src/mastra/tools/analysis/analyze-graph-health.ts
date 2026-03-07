/**
 * Mastra Tool: Analyze Graph Health
 * Analyzes graph structure for health issues including orphans, supernodes, and schema violations
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Dynamic import to avoid circular dependency
async function getAnalyst() {
  const { getAnalystAgent } = await import('@/mastra/agents/analyst');
  return getAnalystAgent();
}

const GraphHealthOutputSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  totalNodes: z.number(),
  totalRelationships: z.number(),
  orphanCount: z.number(),
  supernodeCount: z.number(),
  schemaViolations: z.number(),
  completenessAverage: z.number(),
  issues: z.array(z.object({
    type: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    count: z.number(),
    description: z.string(),
  })),
  timestamp: z.string(),
});

export const analyzeGraphHealthTool = createTool({
  id: 'analyze-graph-health',
  description: 'Analyze graph structure for health issues including orphans, supernodes, and schema violations',
  inputSchema: z.object({}),
  outputSchema: GraphHealthOutputSchema,
  execute: async (_ctx) => {
    // No input parameters needed
    const analyst = await getAnalyst();
    const result = await analyst.getHealthSummary();

    // Transform result to match output schema
    const issues: Array<{ type: string; severity: 'low' | 'medium' | 'high' | 'critical'; count: number; description: string }> = [];

    if (result.data.orphanCount > 0) {
      issues.push({
        type: 'orphans',
        severity: result.data.orphanCount > 50 ? 'high' : result.data.orphanCount > 10 ? 'medium' : 'low',
        count: result.data.orphanCount,
        description: `${result.data.orphanCount} orphan nodes detected`,
      });
    }

    if (result.data.supernodeCount > 0) {
      issues.push({
        type: 'supernodes',
        severity: result.data.supernodeCount > 10 ? 'high' : 'medium',
        count: result.data.supernodeCount,
        description: `${result.data.supernodeCount} supernode anomalies detected`,
      });
    }

    if (result.data.schemaViolationCount > 0) {
      issues.push({
        type: 'schema_violations',
        severity: 'high',
        count: result.data.schemaViolationCount,
        description: `${result.data.schemaViolationCount} schema violations detected`,
      });
    }

    const status: 'healthy' | 'degraded' | 'unhealthy' =
      issues.some(i => i.severity === 'critical' || i.severity === 'high')
        ? 'unhealthy'
        : issues.some(i => i.severity === 'medium')
          ? 'degraded'
          : 'healthy';

    return {
      status,
      totalNodes: result.data.totalNodes,
      totalRelationships: result.data.totalRelationships,
      orphanCount: result.data.orphanCount,
      supernodeCount: result.data.supernodeCount,
      schemaViolations: result.data.schemaViolationCount,
      completenessAverage: 0.7, // Default value as it's not in the original response
      issues,
      timestamp: new Date().toISOString(),
    };
  },
});

export default analyzeGraphHealthTool;
