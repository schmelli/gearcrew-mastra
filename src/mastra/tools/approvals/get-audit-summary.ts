/**
 * Mastra Tool: Get Audit Summary
 * Returns summary of actions taken today (creates, updates, merges, deletes)
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getTodaySummary, formatSummaryForChat } from '../memgraph/audit-query';

const AuditSummaryOutputSchema = z.object({
  raw: z.object({
    period: z.string(),
    totalActions: z.number(),
    creates: z.number(),
    updates: z.number(),
    deletes: z.number(),
    merges: z.number(),
    skips: z.number(),
    flags: z.number(),
    errors: z.number(),
    uniqueEntities: z.number(),
  }),
  formatted: z.string(),
});

export const getAuditSummaryTool = createTool({
  id: 'get-audit-summary',
  description: 'Get summary of actions taken today (creates, updates, merges, deletes)',
  inputSchema: z.object({}),
  outputSchema: AuditSummaryOutputSchema,
  execute: async () => {
    const summary = await getTodaySummary();
    return { raw: summary, formatted: formatSummaryForChat(summary) };
  },
});

export default getAuditSummaryTool;
