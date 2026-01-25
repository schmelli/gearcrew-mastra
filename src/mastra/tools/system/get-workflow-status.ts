/**
 * Mastra Tool: Get Workflow Status
 * Returns status of a specific workflow run by ID
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getWorkflowStatus as getWorkflowStatusFn } from '../memgraph/workflow-status';

const WorkflowStatusOutputSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  status: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  resultSummary: z.record(z.unknown()).optional(),
}).nullable();

export const getWorkflowStatusTool = createTool({
  id: 'get-workflow-status',
  description: 'Get status of a specific workflow run by its ID',
  inputSchema: z.object({
    runId: z.string().describe('The workflow run ID to check'),
  }),
  outputSchema: WorkflowStatusOutputSchema,
  execute: async ({ context }) => {
    const { runId } = context;
    return await getWorkflowStatusFn(runId);
  },
});

export default getWorkflowStatusTool;
