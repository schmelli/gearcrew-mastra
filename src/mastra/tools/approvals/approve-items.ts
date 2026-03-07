/**
 * Mastra Tool: Approve Items
 * Approves pending items by their indices from getPendingApprovals
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listPendingDecisions, handleApprovalDecision } from '../memgraph/pending-decisions';

const ApproveItemsOutputSchema = z.object({
  approved: z.number(),
  results: z.array(z.object({
    item: z.string(),
    success: z.boolean(),
    message: z.string(),
    workflowRunId: z.string().optional(),
    remainingApprovals: z.number().optional(),
  })),
});

export const approveItemsTool = createTool({
  id: 'approve-items',
  description: 'Approve pending items. Use this when user says "approve", "accept", "yes", or similar',
  inputSchema: z.object({
    indices: z.array(z.number()).describe('0-indexed positions of items to approve (from getPendingApprovals)'),
    notes: z.string().optional().describe('Optional notes for the approval'),
  }),
  outputSchema: ApproveItemsOutputSchema,
  execute: async ({ context }) => {
    const { indices, notes } = context;
    const pending = await listPendingDecisions({ limit: 100 });
    const results = [];

    for (const idx of indices) {
      if (idx >= 0 && idx < pending.decisions.length) {
        const item = pending.decisions[idx]!;
        const result = await handleApprovalDecision(item.approvalId, 'approve', notes);
        results.push({ item: item.title, ...result });
      }
    }

    return { approved: results.length, results };
  },
});

export default approveItemsTool;
