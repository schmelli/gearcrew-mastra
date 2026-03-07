/**
 * Mastra Tool: Research Item
 * Uses the Researcher agent to gather comprehensive data about a specific product
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Dynamic import to avoid circular dependency
async function getResearcher() {
  const { getResearcherAgent } = await import('@/mastra/agents/researcher');
  return getResearcherAgent();
}

const ResearchItemOutputSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  status: z.enum(['success', 'partial', 'failed']),
  findings: z.object({
    brand: z.string().optional(),
    weight: z.number().optional(),
    price: z.number().optional(),
    category: z.string().optional(),
    description: z.string().optional(),
    materials: z.array(z.string()).optional(),
    technologies: z.array(z.string()).optional(),
    dimensions: z.object({
      length: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    }).optional(),
    usageScenarios: z.array(z.string()).optional(),
    feedbackPatterns: z.array(z.object({
      sentiment: z.enum(['positive', 'negative', 'neutral']),
      topic: z.string(),
      frequency: z.number(),
    })).optional(),
  }).passthrough(),
  sources: z.array(z.object({
    url: z.string(),
    trustScore: z.number(),
    fieldsFound: z.array(z.string()),
  })),
  confidence: z.number(),
  error: z.string().optional(),
});

export const researchItemTool = createTool({
  id: 'research-item',
  description: 'Use the Researcher agent to gather comprehensive data about a specific product',
  inputSchema: z.object({
    nodeId: z.string().describe('The node ID to research'),
    nodeName: z.string().describe('The product name'),
    brand: z.string().optional(),
    category: z.string().optional(),
  }),
  outputSchema: ResearchItemOutputSchema,
  execute: async ({ context }) => {
    const { nodeId, nodeName, brand, category } = context;
    const researcher = await getResearcher();
    const result = await researcher.researchItem({
      nodeId,
      nodeName,
      brand,
      category,
      missingFields: ['brand', 'weight', 'price', 'category'],
      priority: 0.8,
    });

    // Transform ResearchFindings to match output schema
    const status: 'success' | 'partial' | 'failed' = result.success
      ? (result.overallConfidence > 0.5 ? 'success' : 'partial')
      : 'failed';

    return {
      nodeId: result.nodeId,
      nodeName,
      status,
      findings: {
        brand: result.brand?.name,
        weight: result.specs?.weight?.value,
        price: result.specs?.price?.value,
        category,
        description: undefined,
        materials: result.specs?.materials?.map(m => m.name),
        technologies: result.technologies?.map(t => t.name),
        dimensions: result.specs?.dimensions
          ? {
              length: result.specs.dimensions.length,
              width: result.specs.dimensions.width,
              height: result.specs.dimensions.height,
            }
          : undefined,
        usageScenarios: result.usageScenarios?.map(u => u.activity),
        feedbackPatterns: result.feedbackPatterns
          ? [
              ...result.feedbackPatterns.commonPraise.map(p => ({
                sentiment: 'positive' as const,
                topic: p,
                frequency: 1,
              })),
              ...result.feedbackPatterns.commonComplaints.map(c => ({
                sentiment: 'negative' as const,
                topic: c,
                frequency: 1,
              })),
            ]
          : undefined,
      },
      sources: result.sources.map(s => ({
        url: s.url,
        trustScore: s.trustScore,
        fieldsFound: s.dataTypes,
      })),
      confidence: result.overallConfidence,
      error: result.error,
    };
  },
});

export default researchItemTool;
