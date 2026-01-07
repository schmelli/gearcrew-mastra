/**
 * T060-T061: GET and POST /api/workflows
 * Implements FR-014: Manual workflow triggering
 * Implements FR-015: Scope filtering
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { z } from 'zod';
import {
  triggerWorkflow,
  isWorkflowRunning,
  getAvailableWorkflows,
  WorkflowScopeSchema,
} from '@/mastra/tools/memgraph/trigger-workflow';
import { listWorkflowRuns, countByStatus } from '@/mastra/tools/memgraph/workflow-status';

const TriggerRequestSchema = z.object({
  workflowName: z.enum(['morning-hygiene', 'deep-deduplication', 'gap-filling']),
  scope: WorkflowScopeSchema.optional(),
  priority: z.enum(['normal', 'high']).optional().default('normal'),
});

/**
 * GET /api/workflows - List workflow runs
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const workflowName = searchParams.get('workflowName') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const limit = parseInt(searchParams.get('limit') ?? '20', 10);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const result = await listWorkflowRuns({
      workflowName,
      status,
      limit,
      offset,
    });

    // Get status counts
    const statusCounts = await countByStatus();

    // Get available workflows
    const availableWorkflows = getAvailableWorkflows();

    return NextResponse.json({
      runs: result.runs,
      total: result.total,
      pagination: {
        limit,
        offset,
        hasMore: offset + limit < result.total,
      },
      statusCounts,
      availableWorkflows,
    });
  } catch (error) {
    console.error('Error listing workflows:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to list workflows',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/workflows - Trigger a workflow manually
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workflowName, scope, priority } = TriggerRequestSchema.parse(body);

    // Check if workflow is already running
    const runningCheck = await isWorkflowRunning(workflowName);
    if (runningCheck.running) {
      return NextResponse.json(
        {
          code: 'WORKFLOW_ALREADY_RUNNING',
          message: `Workflow ${workflowName} is already running`,
          details: {
            existingRunId: runningCheck.runId,
            startedAt: runningCheck.startedAt,
          },
        },
        { status: 409 }
      );
    }

    // Trigger the workflow
    const result = await triggerWorkflow(workflowName, {
      scope,
      priority,
      triggeredBy: 'api', // Would be extracted from auth in production
    });

    if (result.status === 'failed') {
      return NextResponse.json(
        {
          code: 'TRIGGER_FAILED',
          message: result.error ?? 'Failed to trigger workflow',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      runId: result.runId,
      workflowName: result.workflowName,
      status: result.status,
      triggeredAt: result.triggeredAt,
      triggeredBy: result.triggeredBy,
      scope: result.scope,
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

    console.error('Error triggering workflow:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to trigger workflow',
      },
      { status: 500 }
    );
  }
}
