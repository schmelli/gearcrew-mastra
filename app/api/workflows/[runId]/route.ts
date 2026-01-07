/**
 * T062: GET /api/workflows/:runId
 * Get status and details of a specific workflow run
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getWorkflowStatus } from '@/mastra/tools/memgraph/workflow-status';
import { getAuditLogger } from '@/lib/audit-logger';
import { getLibSQLClient } from '@/mastra/index';

interface RouteParams {
  params: Promise<{ runId: string }>;
}

/**
 * GET /api/workflows/:runId - Get workflow run details
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  try {
    // Get workflow status
    const status = await getWorkflowStatus(runId);

    if (!status) {
      return NextResponse.json(
        {
          code: 'NOT_FOUND',
          message: 'Workflow run not found',
          details: { runId },
        },
        { status: 404 }
      );
    }

    // Get audit entries for this run
    const logger = getAuditLogger();
    const auditEntries = await logger.query({ workflowRunId: runId, limit: 50 });

    // Get pending approvals if any
    const db = getLibSQLClient();
    const approvalsResult = await db.execute({
      sql: `SELECT * FROM approval_requests WHERE workflow_run_id = ?`,
      args: [runId],
    });

    const approvals = approvalsResult.rows.map((row) => ({
      id: row.id as string,
      stepId: row.step_id as string,
      proposedAction: row.proposed_action as string,
      confidence: row.confidence as number,
      status: row.status as string,
      createdAt: row.created_at as string,
      resolvedAt: row.resolved_at as string | null,
    }));

    // Get issues created by this run
    const issuesResult = await db.execute({
      sql: `SELECT * FROM gardening_issues WHERE workflow_run_id = ?`,
      args: [runId],
    });

    const issues = issuesResult.rows.map((row) => ({
      id: row.id as string,
      issueType: row.issue_type as string,
      severity: row.severity as string,
      title: row.title as string,
      status: row.status as string,
      detectedAt: row.detected_at as string,
      resolvedAt: row.resolved_at as string | null,
    }));

    // Calculate summary metrics from audit
    const metrics = {
      creates: auditEntries.filter((e) => e.action === 'create').length,
      updates: auditEntries.filter((e) => e.action === 'update').length,
      deletes: auditEntries.filter((e) => e.action === 'delete').length,
      merges: auditEntries.filter((e) => e.action === 'merge').length,
      skips: auditEntries.filter((e) => e.action === 'skip').length,
      flags: auditEntries.filter((e) => e.action === 'flag').length,
      errors: auditEntries.filter((e) => e.action === 'error').length,
    };

    return NextResponse.json({
      runId: status.runId,
      workflowName: status.workflowName,
      status: status.status,
      startedAt: status.startedAt,
      completedAt: status.completedAt,
      error: status.error,
      resultSummary: status.resultSummary,
      metrics,
      approvals: {
        total: approvals.length,
        pending: approvals.filter((a) => a.status === 'pending').length,
        approved: approvals.filter((a) => a.status === 'approved').length,
        rejected: approvals.filter((a) => a.status === 'rejected').length,
        items: approvals,
      },
      issues: {
        total: issues.length,
        open: issues.filter((i) => i.status === 'open').length,
        resolved: issues.filter((i) => i.status === 'resolved').length,
        items: issues,
      },
      recentAuditEntries: auditEntries.slice(0, 10).map((e) => ({
        id: e.id,
        action: e.action,
        entityId: e.entityId,
        entityType: e.entityType,
        timestamp: e.timestamp,
        reasoning: e.reasoning,
      })),
    });
  } catch (error) {
    console.error('Error fetching workflow details:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch workflow details',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/workflows/:runId - Cancel a running workflow
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  try {
    const db = getLibSQLClient();

    // Check if workflow exists and is running
    const result = await db.execute({
      sql: `SELECT status FROM workflow_runs WHERE id = ?`,
      args: [runId],
    });

    if (result.rows.length === 0) {
      return NextResponse.json(
        {
          code: 'NOT_FOUND',
          message: 'Workflow run not found',
        },
        { status: 404 }
      );
    }

    const currentStatus = result.rows[0]!.status as string;

    if (currentStatus !== 'running' && currentStatus !== 'suspended') {
      return NextResponse.json(
        {
          code: 'INVALID_STATE',
          message: `Cannot cancel workflow in ${currentStatus} state`,
        },
        { status: 409 }
      );
    }

    // Update status to cancelled
    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'cancelled', completed_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), runId],
    });

    // Cancel any pending approvals
    await db.execute({
      sql: `UPDATE approval_requests SET status = 'cancelled' WHERE workflow_run_id = ? AND status = 'pending'`,
      args: [runId],
    });

    return NextResponse.json({
      success: true,
      runId,
      message: 'Workflow cancelled',
    });
  } catch (error) {
    console.error('Error cancelling workflow:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to cancel workflow',
      },
      { status: 500 }
    );
  }
}
