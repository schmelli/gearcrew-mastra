/**
 * T040: POST /api/approvals/:runId/resume - Resume suspended workflow with decision
 * Per FR-008/FR-009: Execute approved merge or record rejection
 * Per Contract Test T029: Implements resume workflow API
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ResumeRequestSchema } from '@/types';
import { resumeDeduplicationWorkflow, getPendingApprovals } from '@/mastra/workflows/deep-deduplication';
import { getLibSQLClient } from '@/mastra/index';

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  try {
    // Parse and validate request body
    const body = await request.json();
    const validatedBody = ResumeRequestSchema.parse(body);

    const db = getLibSQLClient();

    // Verify workflow exists and is suspended
    const workflowResult = await db.execute({
      sql: 'SELECT status FROM workflow_runs WHERE id = ?',
      args: [runId],
    });

    if (workflowResult.rows.length === 0) {
      return NextResponse.json(
        {
          code: 'NOT_FOUND',
          message: 'Workflow run not found',
          details: { runId },
        },
        { status: 404 }
      );
    }

    const workflowStatus = workflowResult.rows[0]!.status as string;

    if (workflowStatus !== 'suspended') {
      return NextResponse.json(
        {
          code: 'CONFLICT',
          message: 'Workflow is not in suspended state',
          details: { currentStatus: workflowStatus },
        },
        { status: 409 }
      );
    }

    // Find the approval request for this stepId
    const approvalResult = await db.execute({
      sql: `
        SELECT id FROM approval_requests
        WHERE workflow_run_id = ? AND step_id = ? AND status = 'pending'
      `,
      args: [runId, validatedBody.stepId],
    });

    if (approvalResult.rows.length === 0) {
      return NextResponse.json(
        {
          code: 'NOT_FOUND',
          message: 'No pending approval found for this step',
          details: { runId, stepId: validatedBody.stepId },
        },
        { status: 404 }
      );
    }

    const approvalId = approvalResult.rows[0]!.id as string;

    // Resume the workflow with the decision
    const result = await resumeDeduplicationWorkflow(
      runId,
      approvalId,
      validatedBody.decision,
      {
        propertyResolutions: validatedBody.propertyResolutions,
        notes: validatedBody.notes,
      }
    );

    // Check if workflow is now complete
    const pendingApprovals = await getPendingApprovals(runId);
    const workflowComplete = pendingApprovals.length === 0;

    // Get updated workflow status
    const updatedWorkflow = await db.execute({
      sql: 'SELECT status FROM workflow_runs WHERE id = ?',
      args: [runId],
    });

    const newStatus = updatedWorkflow.rows[0]?.status as string;

    return NextResponse.json({
      workflowRunId: runId,
      status: workflowComplete ? 'completed' : newStatus,
      message: workflowComplete
        ? 'Workflow resumed and completed successfully'
        : `Decision recorded. ${pendingApprovals.length} approvals remaining.`,
      result: {
        action: result.action,
        details: result.details,
      },
      pendingApprovals: pendingApprovals.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: { issues: error.issues },
        },
        { status: 400 }
      );
    }

    console.error('Error resuming workflow:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to resume workflow',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/approvals/:runId/resume - Get pending approvals for a workflow
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  try {
    const db = getLibSQLClient();

    // Verify workflow exists
    const workflowResult = await db.execute({
      sql: 'SELECT * FROM workflow_runs WHERE id = ?',
      args: [runId],
    });

    if (workflowResult.rows.length === 0) {
      return NextResponse.json(
        {
          code: 'NOT_FOUND',
          message: 'Workflow run not found',
          details: { runId },
        },
        { status: 404 }
      );
    }

    const workflow = workflowResult.rows[0]!;
    const pendingApprovals = await getPendingApprovals(runId);

    return NextResponse.json({
      workflowRunId: runId,
      workflowName: workflow.workflow_name as string,
      status: workflow.status as string,
      startedAt: workflow.started_at as string,
      pendingApprovals: pendingApprovals.map((approval) => ({
        id: approval.id,
        stepId: approval.stepId,
        proposedAction: approval.proposedAction,
        candidates: approval.candidates,
        reasoning: approval.reasoning,
        confidence: approval.confidence,
        createdAt: approval.createdAt,
        conflictingProperties: approval.conflictingProperties,
      })),
    });
  } catch (error) {
    console.error('Error fetching workflow approvals:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch workflow approvals',
      },
      { status: 500 }
    );
  }
}
