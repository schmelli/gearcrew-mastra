/**
 * Mastra Tool: List Recent Workflows
 * Returns list of recent workflow runs with optional status filtering
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listWorkflowRuns } from '../memgraph/workflow-status';

const WorkflowRunSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  status: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  resultSummary: z.record(z.unknown()).optional(),
});

const ListRecentWorkflowsOutputSchema = z.object({
  runs: z.array(WorkflowRunSchema),
  total: z.number(),
});

export const listRecentWorkflowsTool = createTool({
  id: 'list-recent-workflows',
  description: 'List recent workflow runs with optional status filtering',
  inputSchema: z.object({
    status: z.enum(['running', 'completed', 'failed', 'suspended']).optional()
      .describe('Filter by workflow status'),
    limit: z.number().default(5).describe('Maximum number of results'),
  }),
  outputSchema: ListRecentWorkflowsOutputSchema,
  execute: async ({ context }) => {
    const { status, limit } = context;
    return await listWorkflowRuns({ status, limit });
  },
});

export default listRecentWorkflowsTool;
