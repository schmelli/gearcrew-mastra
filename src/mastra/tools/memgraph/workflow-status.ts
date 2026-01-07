/**
 * T044: Workflow Status Tool
 * Implements FR-010: Allow querying workflow execution status
 */

import type { InValue } from '@libsql/client';
import { getLibSQLClient } from '@/mastra/index';
import { WorkflowRun, WorkflowRunSchema } from '@/types';

export interface WorkflowStatusResult {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  resultSummary?: Record<string, unknown>;
}

export interface WorkflowListResult {
  runs: WorkflowStatusResult[];
  total: number;
}

/**
 * Get status of a specific workflow run
 */
export async function getWorkflowStatus(runId: string): Promise<WorkflowStatusResult | null> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: 'SELECT * FROM workflow_runs WHERE id = ?',
    args: [runId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  return {
    runId: row.id as string,
    workflowName: row.workflow_name as string,
    status: row.status as string,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | undefined,
    error: row.error as string | undefined,
    resultSummary: row.result_summary ? JSON.parse(row.result_summary as string) : undefined,
  };
}

/**
 * List recent workflow runs with optional filtering
 */
export async function listWorkflowRuns(options?: {
  workflowName?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkflowListResult> {
  const db = getLibSQLClient();
  const { workflowName, status, limit = 20, offset = 0 } = options ?? {};

  let sql = 'SELECT * FROM workflow_runs WHERE 1=1';
  const args: InValue[] = [];

  if (workflowName) {
    sql += ' AND workflow_name = ?';
    args.push(workflowName);
  }

  if (status) {
    sql += ' AND status = ?';
    args.push(status);
  }

  sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  const result = await db.execute({ sql, args });

  // Get total count
  let countSql = 'SELECT COUNT(*) as total FROM workflow_runs WHERE 1=1';
  const countArgs: InValue[] = [];

  if (workflowName) {
    countSql += ' AND workflow_name = ?';
    countArgs.push(workflowName);
  }

  if (status) {
    countSql += ' AND status = ?';
    countArgs.push(status);
  }

  const countResult = await db.execute({ sql: countSql, args: countArgs });
  const total = (countResult.rows[0]?.total as number) ?? 0;

  const runs = result.rows.map((row) => ({
    runId: row.id as string,
    workflowName: row.workflow_name as string,
    status: row.status as string,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | undefined,
    error: row.error as string | undefined,
    resultSummary: row.result_summary ? JSON.parse(row.result_summary as string) : undefined,
  }));

  return { runs, total };
}

/**
 * Get the most recent run of each workflow type
 */
export async function getLatestRuns(): Promise<Record<string, WorkflowStatusResult | null>> {
  const db = getLibSQLClient();

  const workflowNames = ['morning-hygiene', 'deep-deduplication', 'gap-filling'];
  const results: Record<string, WorkflowStatusResult | null> = {};

  for (const name of workflowNames) {
    const result = await db.execute({
      sql: `
        SELECT * FROM workflow_runs
        WHERE workflow_name = ?
        ORDER BY started_at DESC
        LIMIT 1
      `,
      args: [name],
    });

    if (result.rows.length > 0) {
      const row = result.rows[0]!;
      results[name] = {
        runId: row.id as string,
        workflowName: row.workflow_name as string,
        status: row.status as string,
        startedAt: row.started_at as string,
        completedAt: row.completed_at as string | undefined,
        error: row.error as string | undefined,
        resultSummary: row.result_summary ? JSON.parse(row.result_summary as string) : undefined,
      };
    } else {
      results[name] = null;
    }
  }

  return results;
}

/**
 * Count workflows by status
 */
export async function countByStatus(): Promise<Record<string, number>> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `
      SELECT status, COUNT(*) as count
      FROM workflow_runs
      GROUP BY status
    `,
    args: [],
  });

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.status as string] = row.count as number;
  }

  return counts;
}

/**
 * Get currently running workflows
 */
export async function getRunningWorkflows(): Promise<WorkflowStatusResult[]> {
  const { runs } = await listWorkflowRuns({ status: 'running' });
  return runs;
}

/**
 * Get suspended workflows awaiting approval
 */
export async function getSuspendedWorkflows(): Promise<WorkflowStatusResult[]> {
  const { runs } = await listWorkflowRuns({ status: 'suspended' });
  return runs;
}

export default {
  getWorkflowStatus,
  listWorkflowRuns,
  getLatestRuns,
  countByStatus,
  getRunningWorkflows,
  getSuspendedWorkflows,
};
