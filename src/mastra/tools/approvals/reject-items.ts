/**
 * Mastra Tool: Reject Items
 * Rejects pending items by their indices from getPendingApprovals
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listPendingDecisions, handleApprovalDecision } from '../memgraph/pending-decisions';

const RejectItemsOutputSchema = z.object({
  rejected: z.number(),
  results: z.array(z.object({
    item: z.string(),
    success: z.boolean(),
    message: z.string(),
    workflowRunId: z.string().optional(),
    remainingApprovals: z.number().optional(),
  })),
});

export const rejectItemsTool = createTool({
  id: 'reject-items',
  description: 'Reject pending items. Use this when user says "reject", "deny", "skip", or similar',
  inputSchema: z.object({
    indices: z.array(z.number()).describe('0-indexed positions of items to reject (from getPendingApprovals)'),
    notes: z.string().optional().describe('Optional notes for the rejection'),
  }),
  outputSchema: RejectItemsOutputSchema,
  execute: async ({ context }) => {
    const { indices, notes } = context;
    const pending = await listPendingDecisions({ limit: 100 });
    const results = [];

    for (const idx of indices) {
      if (idx >= 0 && idx < pending.decisions.length) {
        const item = pending.decisions[idx]!;
        const result = await handleApprovalDecision(item.approvalId, 'reject', notes);
        results.push({ item: item.title, ...result });
      }
    }

    return { rejected: results.length, results };
  },
});

export default rejectItemsTool;
