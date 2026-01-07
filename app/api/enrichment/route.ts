/**
 * T072: Enrichment API Endpoint
 * Implements FR-020: Manual enrichment triggering
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  executeGapFillingWorkflow,
  getGapFillingStatus,
  GapFillingOptionsSchema,
} from '@/mastra/workflows/gap-filling';
import { getLibSQLClient } from '@/mastra/index';

const TriggerRequestSchema = z.object({
  scope: GapFillingOptionsSchema.shape.scope.optional(),
  priority: z.enum(['normal', 'high']).optional().default('normal'),
  limit: z.number().min(1).max(500).optional(),
});

/**
 * GET /api/enrichment - Get enrichment run history
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const runId = searchParams.get('runId');

    if (runId) {
      // Get specific run status
      const status = await getGapFillingStatus(runId);

      if (!status) {
        return NextResponse.json(
          {
            code: 'NOT_FOUND',
            message: 'Enrichment run not found',
          },
          { status: 404 }
        );
      }

      return NextResponse.json(status);
    }

    // List recent enrichment runs
    const db = getLibSQLClient();
    const limit = parseInt(searchParams.get('limit') ?? '20', 10);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const result = await db.execute({
      sql: `SELECT id, workflow_name, status, started_at, completed_at,
                   triggered_by, result_summary, error
            FROM workflow_runs
            WHERE workflow_name = 'gap-filling'
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?`,
      args: [limit, offset],
    });

    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as total FROM workflow_runs WHERE workflow_name = 'gap-filling'`,
      args: [],
    });

    const runs = result.rows.map((row) => ({
      runId: row.id as string,
      status: row.status as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | null,
      triggeredBy: row.triggered_by as string,
      summary: row.result_summary ? JSON.parse(row.result_summary as string) : null,
      error: row.error as string | null,
    }));

    return NextResponse.json({
      runs,
      total: countResult.rows[0]?.total as number,
      pagination: {
        limit,
        offset,
        hasMore: offset + limit < (countResult.rows[0]?.total as number),
      },
    });
  } catch (error) {
    console.error('Error fetching enrichment runs:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch enrichment runs',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/enrichment - Trigger enrichment workflow
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const options = TriggerRequestSchema.parse(body);

    // Check if already running
    const db = getLibSQLClient();
    const running = await db.execute({
      sql: `SELECT id, started_at FROM workflow_runs
            WHERE workflow_name = 'gap-filling' AND status = 'running'`,
      args: [],
    });

    if (running.rows.length > 0) {
      return NextResponse.json(
        {
          code: 'WORKFLOW_ALREADY_RUNNING',
          message: 'Gap-filling workflow is already running',
          details: {
            existingRunId: running.rows[0]!.id,
            startedAt: running.rows[0]!.started_at,
          },
        },
        { status: 409 }
      );
    }

    // Start workflow (non-blocking)
    const workflowPromise = executeGapFillingWorkflow({
      scope: options.scope,
      priority: options.priority,
      limit: options.limit,
    });

    // Return immediately with run ID
    // Get the run ID from DB (it's created at workflow start)
    await new Promise((r) => setTimeout(r, 100)); // Brief wait for workflow to start

    const latestRun = await db.execute({
      sql: `SELECT id, started_at FROM workflow_runs
            WHERE workflow_name = 'gap-filling' AND status = 'running'
            ORDER BY started_at DESC LIMIT 1`,
      args: [],
    });

    if (latestRun.rows.length === 0) {
      // Workflow already completed or failed immediately
      const result = await workflowPromise;
      return NextResponse.json({
        runId: result.runId,
        status: result.status,
        summary: result.summary,
      });
    }

    return NextResponse.json({
      runId: latestRun.rows[0]!.id as string,
      status: 'running',
      message: 'Enrichment workflow started',
      startedAt: latestRun.rows[0]!.started_at as string,
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

    console.error('Error triggering enrichment:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to trigger enrichment workflow',
      },
      { status: 500 }
    );
  }
}
