/**
 * Mastra Tool: Detect Supernodes
 * Detects supernode anomalies (nodes with unusually high connections)
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { detectSupernodes, formatSupernodeReport } from './supernode-detector';

const SupernodeResultSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  nodeType: z.string(),
  degree: z.number(),
  inDegree: z.number(),
  outDegree: z.number(),
  deviationsAboveMean: z.number(),
  percentile: z.number(),
});

const DetectSupernodesOutputSchema = z.object({
  raw: z.object({
    supernodes: z.array(SupernodeResultSchema),
    statistics: z.object({
      totalNodes: z.number(),
      meanDegree: z.number(),
      medianDegree: z.number(),
      stdDev: z.number(),
      threshold: z.number(),
      maxDegree: z.number(),
      minDegree: z.number(),
    }),
    healthIndicator: z.enum(['healthy', 'warning', 'critical']),
  }),
  formatted: z.string(),
});

export const detectSupernodesTool = createTool({
  id: 'detect-supernodes',
  description: 'Detect supernode anomalies (nodes with unusually high connections)',
  inputSchema: z.object({}),
  outputSchema: DetectSupernodesOutputSchema,
  execute: async () => {
    const analysis = await detectSupernodes();
    return { raw: analysis, formatted: formatSupernodeReport(analysis) };
  },
});

export default detectSupernodesTool;
