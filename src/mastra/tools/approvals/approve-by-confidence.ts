/**
 * Mastra Tool: Approve By Confidence
 * Approves all pending items above a confidence threshold
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listPendingDecisions, handleApprovalDecision } from '../memgraph/pending-decisions';

const ApproveByConfidenceOutputSchema = z.object({
  approved: z.number(),
  threshold: z.number(),
  results: z.array(z.object({
    item: z.string(),
    confidence: z.number(),
    success: z.boolean(),
    message: z.string(),
    workflowRunId: z.string().optional(),
    remainingApprovals: z.number().optional(),
  })),
});

export const approveByConfidenceTool = createTool({
  id: 'approve-by-confidence',
  description: 'Approve all pending items above a confidence threshold',
  inputSchema: z.object({
    threshold: z.number().min(0).max(1).describe('Minimum confidence (0-1) to approve'),
    notes: z.string().optional(),
  }),
  outputSchema: ApproveByConfidenceOutputSchema,
  execute: async ({ context }) => {
    const { threshold, notes } = context;
    const pending = await listPendingDecisions({ limit: 100 });
    const toApprove = pending.decisions.filter(d => d.confidence >= threshold);
    const results = [];

    for (const item of toApprove) {
      const result = await handleApprovalDecision(item.approvalId, 'approve', notes);
      results.push({ item: item.title, confidence: item.confidence, ...result });
    }

    return { approved: results.length, threshold, results };
  },
});

export default approveByConfidenceTool;
