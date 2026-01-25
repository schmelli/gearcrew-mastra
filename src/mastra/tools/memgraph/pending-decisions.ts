/**
 * T045: Pending Decisions Tool
 * Implements FR-010: List decisions awaiting human approval
 */

import type { InValue } from '@libsql/client';
import { getLibSQLClient } from '@/lib/db';
import { ApprovalRequest, GardeningIssue } from '@/types';

export interface PendingDecision {
  approvalId: string;
  issueId: string;
  workflowRunId: string;
  workflowName: string;
  proposedAction: 'merge' | 'delete' | 'enrich';
  title: string;
  description: string;
  confidence: number;
  candidates: Array<{
    nodeId: string;
    nodeName: string;
    nodeProperties: Record<string, unknown>;
  }>;
  conflictingProperties?: string[];
  createdAt: string;
  waitingDays: number;
}

export interface PendingDecisionsResult {
  decisions: PendingDecision[];
  total: number;
  oldestWaitingDays: number;
  byAction: Record<string, number>;
}

/**
 * List all pending decisions awaiting human approval
 */
export async function listPendingDecisions(options?: {
  proposedAction?: 'merge' | 'delete' | 'enrich';
  minConfidence?: number;
  maxConfidence?: number;
  limit?: number;
  offset?: number;
}): Promise<PendingDecisionsResult> {
  const db = getLibSQLClient();
  const { proposedAction, minConfidence, maxConfidence, limit = 20, offset = 0 } = options ?? {};

  let sql = `
    SELECT
      ar.id AS approval_id,
      ar.issue_id,
      ar.workflow_run_id,
      ar.proposed_action,
      ar.candidates,
      ar.reasoning,
      ar.confidence,
      ar.created_at,
      ar.step_id,
      gi.title,
      gi.description,
      wr.workflow_name
    FROM approval_requests ar
    LEFT JOIN gardening_issues gi ON ar.issue_id = gi.id
    LEFT JOIN workflow_runs wr ON ar.workflow_run_id = wr.id
    WHERE ar.status = 'pending'
  `;
  const args: InValue[] = [];

  if (proposedAction) {
    sql += ' AND ar.proposed_action = ?';
    args.push(proposedAction);
  }

  if (minConfidence !== undefined) {
    sql += ' AND ar.confidence >= ?';
    args.push(minConfidence);
  }

  if (maxConfidence !== undefined) {
    sql += ' AND ar.confidence <= ?';
    args.push(maxConfidence);
  }

  sql += ' ORDER BY ar.created_at ASC LIMIT ? OFFSET ?';
  args.push(limit, offset);

  const result = await db.execute({ sql, args });

  // Get total count
  let countSql = `
    SELECT COUNT(*) as total FROM approval_requests ar
    WHERE ar.status = 'pending'
  `;
  const countArgs: InValue[] = [];

  if (proposedAction) {
    countSql += ' AND ar.proposed_action = ?';
    countArgs.push(proposedAction);
  }

  if (minConfidence !== undefined) {
    countSql += ' AND ar.confidence >= ?';
    countArgs.push(minConfidence);
  }

  if (maxConfidence !== undefined) {
    countSql += ' AND ar.confidence <= ?';
    countArgs.push(maxConfidence);
  }

  const countResult = await db.execute({ sql: countSql, args: countArgs });
  const total = (countResult.rows[0]?.total as number) ?? 0;

  // Get counts by action
  const byActionResult = await db.execute({
    sql: `
      SELECT proposed_action, COUNT(*) as count
      FROM approval_requests
      WHERE status = 'pending'
      GROUP BY proposed_action
    `,
    args: [],
  });

  const byAction: Record<string, number> = {};
  for (const row of byActionResult.rows) {
    byAction[row.proposed_action as string] = row.count as number;
  }

  const now = Date.now();
  let oldestWaitingDays = 0;

  const decisions = result.rows.map((row) => {
    const createdAt = row.created_at as string;
    const waitingDays = Math.floor(
      (now - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (waitingDays > oldestWaitingDays) {
      oldestWaitingDays = waitingDays;
    }

    const candidates = JSON.parse(row.candidates as string);

    return {
      approvalId: row.approval_id as string,
      issueId: row.issue_id as string,
      workflowRunId: row.workflow_run_id as string,
      workflowName: (row.workflow_name as string) ?? 'unknown',
      proposedAction: row.proposed_action as 'merge' | 'delete' | 'enrich',
      title: (row.title as string) ?? `${row.proposed_action} decision`,
      description: (row.description as string) ?? (row.reasoning as string),
      confidence: row.confidence as number,
      candidates: candidates.map((c: Record<string, unknown>) => ({
        nodeId: c.nodeId,
        nodeName: c.nodeName,
        nodeProperties: c.nodeProperties ?? c.properties ?? {},
      })),
      createdAt,
      waitingDays,
    };
  });

  return {
    decisions,
    total,
    oldestWaitingDays,
    byAction,
  };
}

/**
 * Get a single pending decision by ID
 */
export async function getPendingDecision(approvalId: string): Promise<PendingDecision | null> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `
      SELECT
        ar.id AS approval_id,
        ar.issue_id,
        ar.workflow_run_id,
        ar.proposed_action,
        ar.candidates,
        ar.reasoning,
        ar.confidence,
        ar.created_at,
        ar.step_id,
        gi.title,
        gi.description,
        wr.workflow_name
      FROM approval_requests ar
      LEFT JOIN gardening_issues gi ON ar.issue_id = gi.id
      LEFT JOIN workflow_runs wr ON ar.workflow_run_id = wr.id
      WHERE ar.id = ? AND ar.status = 'pending'
    `,
    args: [approvalId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  const createdAt = row.created_at as string;
  const waitingDays = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  const candidates = JSON.parse(row.candidates as string);

  return {
    approvalId: row.approval_id as string,
    issueId: row.issue_id as string,
    workflowRunId: row.workflow_run_id as string,
    workflowName: (row.workflow_name as string) ?? 'unknown',
    proposedAction: row.proposed_action as 'merge' | 'delete' | 'enrich',
    title: (row.title as string) ?? `${row.proposed_action} decision`,
    description: (row.description as string) ?? (row.reasoning as string),
    confidence: row.confidence as number,
    candidates: candidates.map((c: Record<string, unknown>) => ({
      nodeId: c.nodeId,
      nodeName: c.nodeName,
      nodeProperties: c.nodeProperties ?? c.properties ?? {},
    })),
    createdAt,
    waitingDays,
  };
}

/**
 * Get summary of pending decisions
 */
export async function getPendingDecisionsSummary(): Promise<{
  total: number;
  byAction: Record<string, number>;
  byConfidenceRange: Record<string, number>;
  oldestWaitingDays: number;
  averageWaitingDays: number;
}> {
  const db = getLibSQLClient();

  // Total and by action
  const byActionResult = await db.execute({
    sql: `
      SELECT proposed_action, COUNT(*) as count
      FROM approval_requests
      WHERE status = 'pending'
      GROUP BY proposed_action
    `,
    args: [],
  });

  const byAction: Record<string, number> = {};
  let total = 0;
  for (const row of byActionResult.rows) {
    const count = row.count as number;
    byAction[row.proposed_action as string] = count;
    total += count;
  }

  // By confidence range
  const confidenceResult = await db.execute({
    sql: `
      SELECT
        CASE
          WHEN confidence >= 0.95 THEN '95-100%'
          WHEN confidence >= 0.90 THEN '90-95%'
          WHEN confidence >= 0.85 THEN '85-90%'
          ELSE '80-85%'
        END as range,
        COUNT(*) as count
      FROM approval_requests
      WHERE status = 'pending'
      GROUP BY range
    `,
    args: [],
  });

  const byConfidenceRange: Record<string, number> = {};
  for (const row of confidenceResult.rows) {
    byConfidenceRange[row.range as string] = row.count as number;
  }

  // Waiting time stats
  const waitingResult = await db.execute({
    sql: `
      SELECT
        MIN(created_at) as oldest,
        created_at
      FROM approval_requests
      WHERE status = 'pending'
    `,
    args: [],
  });

  let oldestWaitingDays = 0;
  let averageWaitingDays = 0;

  if (waitingResult.rows.length > 0 && waitingResult.rows[0]?.oldest) {
    const oldest = new Date(waitingResult.rows[0].oldest as string);
    oldestWaitingDays = Math.floor((Date.now() - oldest.getTime()) / (1000 * 60 * 60 * 24));
  }

  // Calculate average
  const allDatesResult = await db.execute({
    sql: `SELECT created_at FROM approval_requests WHERE status = 'pending'`,
    args: [],
  });

  if (allDatesResult.rows.length > 0) {
    const totalDays = allDatesResult.rows.reduce((sum, row) => {
      const created = new Date(row.created_at as string);
      const days = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
      return sum + days;
    }, 0);
    averageWaitingDays = Math.round(totalDays / allDatesResult.rows.length);
  }

  return {
    total,
    byAction,
    byConfidenceRange,
    oldestWaitingDays,
    averageWaitingDays,
  };
}

/**
 * Handle an approval decision (approve or reject)
 */
export async function handleApprovalDecision(
  approvalId: string,
  decision: 'approve' | 'reject',
  notes?: string
): Promise<{
  success: boolean;
  message: string;
  workflowRunId?: string;
  remainingApprovals?: number;
}> {
  const db = getLibSQLClient();

  // Find the approval request
  const approvalResult = await db.execute({
    sql: `
      SELECT ar.*, wr.workflow_name, ar.workflow_run_id
      FROM approval_requests ar
      LEFT JOIN workflow_runs wr ON ar.workflow_run_id = wr.id
      WHERE ar.id = ? AND ar.status = 'pending'
    `,
    args: [approvalId],
  });

  if (approvalResult.rows.length === 0) {
    return {
      success: false,
      message: `Approval request ${approvalId} not found or already resolved`,
    };
  }

  const approval = approvalResult.rows[0]!;
  const workflowRunId = approval.workflow_run_id as string;
  const stepId = approval.step_id as string;

  // Import the resume function dynamically to avoid circular imports
  const { resumeDeduplicationWorkflow, getPendingApprovals } = await import('@/mastra/workflows/deep-deduplication');

  try {
    // Resume the workflow with the decision
    const result = await resumeDeduplicationWorkflow(
      workflowRunId,
      approvalId,
      decision,
      { notes }
    );

    // Check remaining approvals
    const remainingApprovals = await getPendingApprovals(workflowRunId);

    const candidates = JSON.parse(approval.candidates as string);
    const nodeNames = candidates.map((c: { nodeName?: string }) => c.nodeName || 'Unknown').join(' / ');

    return {
      success: true,
      message: decision === 'approve'
        ? `✅ Approved merge of: ${nodeNames}`
        : `❌ Rejected merge of: ${nodeNames}`,
      workflowRunId,
      remainingApprovals: remainingApprovals.length,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to process decision: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Approve or reject all pending approvals for a workflow
 */
export async function bulkApprovalDecision(
  workflowRunId: string,
  decision: 'approve' | 'reject',
  notes?: string
): Promise<{
  success: boolean;
  processed: number;
  failed: number;
  message: string;
}> {
  const db = getLibSQLClient();

  // Get all pending approvals for this workflow
  const pendingResult = await db.execute({
    sql: `SELECT id FROM approval_requests WHERE workflow_run_id = ? AND status = 'pending'`,
    args: [workflowRunId],
  });

  let processed = 0;
  let failed = 0;

  for (const row of pendingResult.rows) {
    const result = await handleApprovalDecision(row.id as string, decision, notes);
    if (result.success) {
      processed++;
    } else {
      failed++;
    }
  }

  return {
    success: failed === 0,
    processed,
    failed,
    message: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${processed} items${failed > 0 ? `, ${failed} failed` : ''}`,
  };
}

export default {
  listPendingDecisions,
  getPendingDecision,
  getPendingDecisionsSummary,
  handleApprovalDecision,
  bulkApprovalDecision,
};
