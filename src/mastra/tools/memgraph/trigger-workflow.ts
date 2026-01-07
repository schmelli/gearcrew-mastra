/**
 * T057-T058: Trigger Workflow Tool
 * Implements FR-014: Manual workflow triggering
 * Implements FR-015: Scope filtering by category/brand
 */

import { z } from 'zod';
import { getLibSQLClient } from '@/mastra/index';
import { executeMorningHygieneWorkflow } from '../../workflows/morning-hygiene';
import { executeDeduplicationWorkflow } from '../../workflows/deep-deduplication';

export const WorkflowScopeSchema = z.object({
  category: z.string().optional(),
  brand: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
});

export type WorkflowScope = z.infer<typeof WorkflowScopeSchema>;

export interface TriggerResult {
  runId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'failed';
  triggeredAt: string;
  triggeredBy: string;
  scope: WorkflowScope | null;
  error?: string;
}

/**
 * Check if a workflow is already running
 */
export async function isWorkflowRunning(workflowName: string): Promise<{
  running: boolean;
  runId?: string;
  startedAt?: string;
}> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `
      SELECT id, started_at FROM workflow_runs
      WHERE workflow_name = ? AND status = 'running'
      LIMIT 1
    `,
    args: [workflowName],
  });

  if (result.rows.length > 0) {
    return {
      running: true,
      runId: result.rows[0]!.id as string,
      startedAt: result.rows[0]!.started_at as string,
    };
  }

  return { running: false };
}

/**
 * Trigger a workflow manually
 */
export async function triggerWorkflow(
  workflowName: 'morning-hygiene' | 'deep-deduplication' | 'gap-filling',
  options?: {
    scope?: WorkflowScope;
    priority?: 'normal' | 'high';
    triggeredBy?: string;
  }
): Promise<TriggerResult> {
  const { scope, priority = 'normal', triggeredBy = 'admin' } = options ?? {};

  // Check if already running
  const runningCheck = await isWorkflowRunning(workflowName);
  if (runningCheck.running) {
    return {
      runId: runningCheck.runId!,
      workflowName,
      status: 'failed',
      triggeredAt: new Date().toISOString(),
      triggeredBy,
      scope: scope ?? null,
      error: `Workflow ${workflowName} is already running (run ID: ${runningCheck.runId})`,
    };
  }

  // Generate run ID
  const runId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const triggeredAt = new Date().toISOString();

  try {
    // Create workflow run record
    const db = getLibSQLClient();
    await db.execute({
      sql: `
        INSERT INTO workflow_runs (id, workflow_name, status, started_at, context)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        runId,
        workflowName,
        'running',
        triggeredAt,
        JSON.stringify({
          triggeredBy,
          priority,
          scope,
          manual: true,
        }),
      ],
    });

    // Execute workflow asynchronously based on type
    executeWorkflowAsync(workflowName, runId, scope);

    return {
      runId,
      workflowName,
      status: 'running',
      triggeredAt,
      triggeredBy,
      scope: scope ?? null,
    };
  } catch (error) {
    return {
      runId,
      workflowName,
      status: 'failed',
      triggeredAt,
      triggeredBy,
      scope: scope ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute workflow asynchronously (fire and forget)
 */
async function executeWorkflowAsync(
  workflowName: string,
  runId: string,
  scope?: WorkflowScope
): Promise<void> {
  const db = getLibSQLClient();

  try {
    switch (workflowName) {
      case 'morning-hygiene':
        await executeMorningHygieneWorkflow({ workflowRunId: runId, scope });
        break;

      case 'deep-deduplication':
        await executeDeduplicationWorkflow(runId);
        break;

      case 'gap-filling':
        // Gap-filling workflow will be implemented in Phase 7
        throw new Error('Gap-filling workflow not yet implemented');

      default:
        throw new Error(`Unknown workflow: ${workflowName}`);
    }
  } catch (error) {
    // Update workflow run with error
    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'failed', error = ? WHERE id = ?`,
      args: [error instanceof Error ? error.message : String(error), runId],
    });
  }
}

/**
 * Get available workflows and their descriptions
 */
export function getAvailableWorkflows(): Array<{
  name: string;
  description: string;
  schedule: string;
  supportsScope: boolean;
}> {
  return [
    {
      name: 'morning-hygiene',
      description: 'Detects and cleans up orphan nodes, validates schema, reports anomalies',
      schedule: 'Daily at 04:00 UTC',
      supportsScope: true,
    },
    {
      name: 'deep-deduplication',
      description: 'Detects duplicate nodes via semantic similarity, proposes merges',
      schedule: 'Weekly on Sundays at 02:00 UTC',
      supportsScope: true,
    },
    {
      name: 'gap-filling',
      description: 'Finds and fills missing product data from external sources',
      schedule: 'On-demand or when nodes flagged incomplete',
      supportsScope: true,
    },
  ];
}

/**
 * Parse trigger intent from natural language
 */
export function parseTriggerIntent(message: string): {
  isTrigger: boolean;
  workflowType?: 'morning-hygiene' | 'deep-deduplication' | 'gap-filling';
  scope?: WorkflowScope;
  immediate?: boolean;
} {
  const lowerMessage = message.toLowerCase();

  // Check for trigger keywords
  const triggerKeywords = ['run', 'start', 'trigger', 'execute', 'launch'];
  const hasTrigger = triggerKeywords.some((kw) => lowerMessage.includes(kw));

  if (!hasTrigger) {
    return { isTrigger: false };
  }

  // Determine workflow type
  let workflowType: 'morning-hygiene' | 'deep-deduplication' | 'gap-filling' | undefined;

  if (lowerMessage.includes('hygiene') || lowerMessage.includes('cleanup') || lowerMessage.includes('orphan')) {
    workflowType = 'morning-hygiene';
  } else if (lowerMessage.includes('dedup') || lowerMessage.includes('duplicate')) {
    workflowType = 'deep-deduplication';
  } else if (lowerMessage.includes('gap') || lowerMessage.includes('enrich') || lowerMessage.includes('fill')) {
    workflowType = 'gap-filling';
  }

  // Check for immediate execution
  const immediate = lowerMessage.includes('now') || lowerMessage.includes('immediately');

  // Parse scope
  const scope: WorkflowScope = {};

  // Category pattern
  const categoryMatch = message.match(/(?:on|for)\s+(\w+)(?:\s+category)?/i);
  if (categoryMatch && !['node', 'workflow'].includes(categoryMatch[1]!.toLowerCase())) {
    scope.category = categoryMatch[1];
  }

  // Brand pattern
  const brandMatch = message.match(/for\s+(\w+)\s+(?:products|brand)/i);
  if (brandMatch) {
    scope.brand = brandMatch[1];
  }

  // Node ID pattern
  const nodeMatch = message.match(/(?:node|nodes?)\s+([\w-]+(?:\s*,\s*[\w-]+)*)/i);
  if (nodeMatch) {
    scope.nodeIds = nodeMatch[1]!.split(/\s*,\s*/);
  }

  return {
    isTrigger: true,
    workflowType,
    scope: Object.keys(scope).length > 0 ? scope : undefined,
    immediate,
  };
}

/**
 * Format trigger response for chat
 */
export function formatTriggerResponse(result: TriggerResult): string {
  if (result.status === 'failed') {
    return `Failed to start workflow: ${result.error}`;
  }

  let response = `**${result.workflowName}** workflow started\n`;
  response += `Run ID: \`${result.runId}\`\n`;
  response += `Status: ${result.status}\n`;

  if (result.scope) {
    if (result.scope.category) {
      response += `Scope: ${result.scope.category} category\n`;
    }
    if (result.scope.brand) {
      response += `Scope: ${result.scope.brand} brand\n`;
    }
    if (result.scope.nodeIds) {
      response += `Scope: ${result.scope.nodeIds.length} specific nodes\n`;
    }
  }

  response += `\nYou can check progress with "Status of workflow ${result.runId}"`;

  return response;
}

export default {
  triggerWorkflow,
  isWorkflowRunning,
  getAvailableWorkflows,
  parseTriggerIntent,
  formatTriggerResponse,
};
