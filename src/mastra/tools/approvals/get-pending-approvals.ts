/**
 * Mastra Tool: Get Pending Approvals
 * Returns list of pending approval decisions awaiting human review
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listPendingDecisions } from '../memgraph/pending-decisions';

const PendingDecisionSchema = z.object({
  approvalId: z.string(),
  issueId: z.string(),
  workflowRunId: z.string(),
  workflowName: z.string(),
  proposedAction: z.enum(['merge', 'delete', 'enrich']),
  title: z.string(),
  description: z.string(),
  confidence: z.number(),
  candidates: z.array(z.object({
    nodeId: z.string(),
    nodeName: z.string(),
    nodeProperties: z.record(z.unknown()),
  })),
  conflictingProperties: z.array(z.string()).optional(),
  createdAt: z.string(),
  waitingDays: z.number(),
});

const GetPendingApprovalsOutputSchema = z.object({
  decisions: z.array(PendingDecisionSchema),
  total: z.number(),
  oldestWaitingDays: z.number(),
  byAction: z.record(z.number()),
});

export const getPendingApprovalsTool = createTool({
  id: 'get-pending-approvals',
  description: 'Get list of pending approval decisions awaiting human review (duplicates, merges)',
  inputSchema: z.object({
    limit: z.number().default(10).describe('Maximum number of results'),
  }),
  outputSchema: GetPendingApprovalsOutputSchema,
  execute: async ({ context }) => {
    const { limit } = context;
    return await listPendingDecisions({ limit });
  },
});

export default getPendingApprovalsTool;
