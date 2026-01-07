/**
 * T086: Workflow State Persistence and Recovery
 * Implements FR-028: Recover workflow state on restart
 */

import { getLibSQLClient } from '@/mastra/index';
import { getAuditLogger } from './audit-logger';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowState {
  runId: string;
  workflowName: string;
  status: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  suspendedAt?: string;
  triggeredBy: string;
  currentStep?: string;
  stepData?: Record<string, unknown>;
  error?: string;
}

export interface RecoveryResult {
  recovered: number;
  failed: number;
  details: Array<{
    runId: string;
    workflowName: string;
    action: 'resumed' | 'marked_failed' | 'already_complete';
    error?: string;
  }>;
}

// ============================================================================
// State Persistence
// ============================================================================

/**
 * Save workflow state checkpoint
 */
export async function saveWorkflowCheckpoint(
  runId: string,
  step: string,
  data?: Record<string, unknown>
): Promise<void> {
  const db = getLibSQLClient();

  await db.execute({
    sql: `UPDATE workflow_runs
          SET current_step = ?,
              step_data = ?,
              updated_at = ?
          WHERE id = ?`,
    args: [step, data ? JSON.stringify(data) : null, new Date().toISOString(), runId],
  });
}

/**
 * Get workflow checkpoint data
 */
export async function getWorkflowCheckpoint(
  runId: string
): Promise<{ step: string; data: Record<string, unknown> } | null> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT current_step, step_data FROM workflow_runs WHERE id = ?`,
    args: [runId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  return {
    step: row.current_step as string,
    data: row.step_data ? JSON.parse(row.step_data as string) : {},
  };
}

// ============================================================================
// Recovery Functions
// ============================================================================

/**
 * Find interrupted workflows that need recovery
 */
export async function findInterruptedWorkflows(): Promise<WorkflowState[]> {
  const db = getLibSQLClient();

  // Find workflows that were running or suspended when the system stopped
  const result = await db.execute({
    sql: `SELECT id, workflow_name, status, started_at, suspended_at,
                 triggered_by, current_step, step_data, error
          FROM workflow_runs
          WHERE status IN ('running', 'suspended')
          ORDER BY started_at ASC`,
    args: [],
  });

  return result.rows.map((row) => ({
    runId: row.id as string,
    workflowName: row.workflow_name as string,
    status: row.status as WorkflowState['status'],
    startedAt: row.started_at as string,
    suspendedAt: row.suspended_at as string | undefined,
    triggeredBy: row.triggered_by as string,
    currentStep: row.current_step as string | undefined,
    stepData: row.step_data ? JSON.parse(row.step_data as string) : undefined,
    error: row.error as string | undefined,
  }));
}

/**
 * Recover interrupted workflows on startup
 */
export async function recoverInterruptedWorkflows(): Promise<RecoveryResult> {
  const logger = getAuditLogger();
  const interrupted = await findInterruptedWorkflows();
  const result: RecoveryResult = {
    recovered: 0,
    failed: 0,
    details: [],
  };

  for (const workflow of interrupted) {
    try {
      if (workflow.status === 'suspended') {
        // Suspended workflows stay suspended - they need human intervention
        result.details.push({
          runId: workflow.runId,
          workflowName: workflow.workflowName,
          action: 'already_complete',
        });
        continue;
      }

      // For running workflows, determine if they can be resumed
      const canResume = await canResumeWorkflow(workflow);

      if (canResume) {
        // Mark as resumable and trigger recovery
        await resumeWorkflow(workflow);
        result.recovered++;
        result.details.push({
          runId: workflow.runId,
          workflowName: workflow.workflowName,
          action: 'resumed',
        });

        await logger.logUpdate(
          workflow.runId,
          workflow.workflowName as 'morning-hygiene' | 'deep-deduplication' | 'gap-filling',
          workflow.runId,
          'WorkflowRun',
          { status: 'interrupted' },
          { status: 'recovered' },
          `Recovered workflow from step: ${workflow.currentStep || 'start'}`
        );
      } else {
        // Mark as failed due to unrecoverable state
        await markWorkflowFailed(
          workflow.runId,
          'Workflow interrupted and could not be recovered on restart'
        );
        result.failed++;
        result.details.push({
          runId: workflow.runId,
          workflowName: workflow.workflowName,
          action: 'marked_failed',
          error: 'Unrecoverable state',
        });

        await logger.logError(
          workflow.runId,
          workflow.workflowName as 'morning-hygiene' | 'deep-deduplication' | 'gap-filling',
          workflow.runId,
          'WorkflowRun',
          'Workflow could not be recovered after system restart'
        );
      }
    } catch (error) {
      result.failed++;
      result.details.push({
        runId: workflow.runId,
        workflowName: workflow.workflowName,
        action: 'marked_failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return result;
}

/**
 * Check if a workflow can be safely resumed
 */
async function canResumeWorkflow(workflow: WorkflowState): Promise<boolean> {
  // Check if we have checkpoint data
  if (!workflow.currentStep) {
    return false;
  }

  // Check workflow age - don't resume if too old (> 24 hours)
  const startTime = new Date(workflow.startedAt).getTime();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  if (Date.now() - startTime > maxAge) {
    return false;
  }

  // Check if the workflow type supports resumption
  const resumableWorkflows = ['morning-hygiene', 'deep-deduplication', 'gap-filling'];
  if (!resumableWorkflows.includes(workflow.workflowName)) {
    return false;
  }

  return true;
}

/**
 * Resume a workflow from its checkpoint
 */
async function resumeWorkflow(workflow: WorkflowState): Promise<void> {
  const db = getLibSQLClient();

  // Update status to indicate recovery in progress
  await db.execute({
    sql: `UPDATE workflow_runs
          SET status = 'running',
              updated_at = ?,
              result_summary = json_set(COALESCE(result_summary, '{}'), '$.recovered', true)
          WHERE id = ?`,
    args: [new Date().toISOString(), workflow.runId],
  });

  // Note: Actual workflow resumption would be triggered by the scheduler
  // This just marks it as ready to resume
  console.log(`Workflow ${workflow.runId} marked for resumption from step: ${workflow.currentStep}`);
}

/**
 * Mark a workflow as failed
 */
async function markWorkflowFailed(runId: string, error: string): Promise<void> {
  const db = getLibSQLClient();

  await db.execute({
    sql: `UPDATE workflow_runs
          SET status = 'failed',
              completed_at = ?,
              error = ?
          WHERE id = ?`,
    args: [new Date().toISOString(), error, runId],
  });
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * Get workflow system health status
 */
export async function getWorkflowSystemHealth(): Promise<{
  healthy: boolean;
  runningWorkflows: number;
  suspendedWorkflows: number;
  stuckWorkflows: number;
  oldestRunning?: {
    runId: string;
    workflowName: string;
    startedAt: string;
    runningFor: number; // minutes
  };
}> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT status, COUNT(*) as count
          FROM workflow_runs
          WHERE status IN ('running', 'suspended')
          GROUP BY status`,
    args: [],
  });

  let runningWorkflows = 0;
  let suspendedWorkflows = 0;

  for (const row of result.rows) {
    if (row.status === 'running') {
      runningWorkflows = row.count as number;
    } else if (row.status === 'suspended') {
      suspendedWorkflows = row.count as number;
    }
  }

  // Find stuck workflows (running for > 2 hours)
  const stuckResult = await db.execute({
    sql: `SELECT COUNT(*) as count
          FROM workflow_runs
          WHERE status = 'running'
            AND started_at < datetime('now', '-2 hours')`,
    args: [],
  });
  const stuckWorkflows = (stuckResult.rows[0]?.count as number) || 0;

  // Get oldest running workflow
  const oldestResult = await db.execute({
    sql: `SELECT id, workflow_name, started_at
          FROM workflow_runs
          WHERE status = 'running'
          ORDER BY started_at ASC
          LIMIT 1`,
    args: [],
  });

  let oldestRunning: {
    runId: string;
    workflowName: string;
    startedAt: string;
    runningFor: number;
  } | undefined;

  if (oldestResult.rows.length > 0) {
    const row = oldestResult.rows[0]!;
    const startedAt = row.started_at as string;
    const runningFor = Math.floor(
      (Date.now() - new Date(startedAt).getTime()) / 60000
    );
    oldestRunning = {
      runId: row.id as string,
      workflowName: row.workflow_name as string,
      startedAt,
      runningFor,
    };
  }

  return {
    healthy: stuckWorkflows === 0,
    runningWorkflows,
    suspendedWorkflows,
    stuckWorkflows,
    oldestRunning,
  };
}

// ============================================================================
// Startup Recovery
// ============================================================================

/**
 * Run recovery on application startup
 */
export async function runStartupRecovery(): Promise<RecoveryResult> {
  console.log('Running workflow recovery check...');
  const result = await recoverInterruptedWorkflows();

  if (result.recovered > 0 || result.failed > 0) {
    console.log(
      `Workflow recovery complete: ${result.recovered} recovered, ${result.failed} failed`
    );
  } else {
    console.log('No interrupted workflows found');
  }

  return result;
}

export default {
  saveWorkflowCheckpoint,
  getWorkflowCheckpoint,
  findInterruptedWorkflows,
  recoverInterruptedWorkflows,
  getWorkflowSystemHealth,
  runStartupRecovery,
};
