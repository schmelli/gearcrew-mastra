/**
 * Mastra Tool: List Available Workflows
 * Lists all available workflows and their descriptions
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getAvailableWorkflows } from '../memgraph/trigger-workflow';

const WorkflowInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  schedule: z.string(),
  supportsScope: z.boolean(),
});

const ListAvailableWorkflowsOutputSchema = z.array(WorkflowInfoSchema);

export const listAvailableWorkflowsTool = createTool({
  id: 'list-available-workflows',
  description: 'List all available workflows and their descriptions',
  inputSchema: z.object({}),
  outputSchema: ListAvailableWorkflowsOutputSchema,
  execute: async () => {
    return getAvailableWorkflows();
  },
});

export default listAvailableWorkflowsTool;
