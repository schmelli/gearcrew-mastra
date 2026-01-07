/**
 * T039: GET /api/approvals - List pending approval requests
 * Per FR-007: Provide human review interface for mid-confidence duplicates
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getLibSQLClient } from '@/mastra/index';
import { ApprovalRequest } from '@/types';

const QuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional().default('pending'),
  workflowRunId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const params = QuerySchema.parse({
      status: searchParams.get('status') ?? undefined,
      workflowRunId: searchParams.get('workflowRunId') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      offset: searchParams.get('offset') ?? undefined,
    });

    const db = getLibSQLClient();

    // Build query based on filters
    let sql = 'SELECT * FROM approval_requests WHERE 1=1';
    const args: unknown[] = [];

    if (params.status !== 'all') {
      sql += ' AND status = ?';
      args.push(params.status);
    }

    if (params.workflowRunId) {
      sql += ' AND workflow_run_id = ?';
      args.push(params.workflowRunId);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(params.limit, params.offset);

    const result = await db.execute({ sql, args });

    // Get total count for pagination
    let countSql = 'SELECT COUNT(*) as total FROM approval_requests WHERE 1=1';
    const countArgs: unknown[] = [];

    if (params.status !== 'all') {
      countSql += ' AND status = ?';
      countArgs.push(params.status);
    }

    if (params.workflowRunId) {
      countSql += ' AND workflow_run_id = ?';
      countArgs.push(params.workflowRunId);
    }

    const countResult = await db.execute({ sql: countSql, args: countArgs });
    const total = (countResult.rows[0]?.total as number) ?? 0;

    const approvals: ApprovalRequest[] = result.rows.map((row) => ({
      id: row.id as string,
      workflowRunId: row.workflow_run_id as string,
      stepId: row.step_id as string,
      issueId: (row.issue_id as string) ?? '',
      proposedAction: row.proposed_action as 'merge' | 'delete' | 'enrich',
      candidates: JSON.parse(row.candidates as string),
      reasoning: row.reasoning as string,
      confidence: row.confidence as number,
      status: row.status as 'pending' | 'approved' | 'rejected',
      createdAt: row.created_at as string,
      resolvedAt: row.resolved_at as string | undefined,
      resolvedBy: row.resolved_by as string | undefined,
      resolutionNotes: row.resolution_notes as string | undefined,
    }));

    return NextResponse.json({
      approvals,
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + params.limit < total,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: { issues: error.issues },
        },
        { status: 400 }
      );
    }

    console.error('Error fetching approvals:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch approvals',
      },
      { status: 500 }
    );
  }
}
