/**
 * Mastra Tool: Trigger Workflow
 * Manually triggers a workflow (morning-hygiene, deep-deduplication, etc.)
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { triggerWorkflow, formatTriggerResponse } from '../memgraph/trigger-workflow';

const WorkflowScopeSchema = z.object({
  category: z.string().optional(),
  brand: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
});

const TriggerWorkflowOutputSchema = z.object({
  raw: z.object({
    runId: z.string(),
    workflowName: z.string(),
    status: z.enum(['pending', 'running', 'failed']),
    triggeredAt: z.string(),
    triggeredBy: z.string(),
    scope: WorkflowScopeSchema.nullable(),
    error: z.string().optional(),
  }),
  formatted: z.string(),
});

export const triggerWorkflowTool = createTool({
  id: 'trigger-workflow',
  description: 'Manually trigger a workflow (morning-hygiene, deep-deduplication, data-quality, gap-filling, embedding-generation)',
  inputSchema: z.object({
    workflowName: z.enum(['morning-hygiene', 'deep-deduplication', 'data-quality', 'gap-filling', 'embedding-generation'])
      .describe('Which workflow to run'),
    scope: z.object({
      category: z.string().optional(),
      brand: z.string().optional(),
    }).optional().describe('Optional scope filter'),
    options: z.record(z.unknown()).optional().describe('Workflow-specific options'),
  }),
  outputSchema: TriggerWorkflowOutputSchema,
  execute: async ({ context }) => {
    const { workflowName, scope, options } = context;
    const result = await triggerWorkflow(workflowName, { scope, workflowOptions: options });
    return { raw: result, formatted: formatTriggerResponse(result) };
  },
});

export default triggerWorkflowTool;
