/**
 * T053: GET /api/issues
 * Implements FR-007: List gardening issues for review
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { z } from 'zod';
import type { InValue } from '@libsql/client';
import { getLibSQLClient } from '@/mastra/index';
import { GardeningIssue } from '@/types';

const QuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'wont_fix', 'all']).optional().default('open'),
  issueType: z.enum([
    'potential_duplicate',
    'orphan_node',
    'missing_data',
    'schema_violation',
    'manual_review',
    'all'
  ]).optional().default('all'),
  severity: z.enum(['info', 'warning', 'error', 'all']).optional().default('all'),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const params = QuerySchema.parse({
      status: searchParams.get('status') ?? undefined,
      issueType: searchParams.get('issueType') ?? undefined,
      severity: searchParams.get('severity') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      offset: searchParams.get('offset') ?? undefined,
    });

    const db = getLibSQLClient();

    // Build query
    let sql = 'SELECT * FROM gardening_issues WHERE 1=1';
    const args: InValue[] = [];

    if (params.status !== 'all') {
      sql += ' AND status = ?';
      args.push(params.status);
    }

    if (params.issueType !== 'all') {
      sql += ' AND issue_type = ?';
      args.push(params.issueType);
    }

    if (params.severity !== 'all') {
      sql += ' AND severity = ?';
      args.push(params.severity);
    }

    sql += ' ORDER BY detected_at DESC LIMIT ? OFFSET ?';
    args.push(params.limit, params.offset);

    const result = await db.execute({ sql, args });

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM gardening_issues WHERE 1=1';
    const countArgs: InValue[] = [];

    if (params.status !== 'all') {
      countSql += ' AND status = ?';
      countArgs.push(params.status);
    }

    if (params.issueType !== 'all') {
      countSql += ' AND issue_type = ?';
      countArgs.push(params.issueType);
    }

    if (params.severity !== 'all') {
      countSql += ' AND severity = ?';
      countArgs.push(params.severity);
    }

    const countResult = await db.execute({ sql: countSql, args: countArgs });
    const total = (countResult.rows[0]?.total as number) ?? 0;

    // Get counts by type
    const byTypeResult = await db.execute({
      sql: `
        SELECT issue_type, COUNT(*) as count
        FROM gardening_issues
        WHERE status = 'open'
        GROUP BY issue_type
      `,
      args: [],
    });

    const byType: Record<string, number> = {};
    for (const row of byTypeResult.rows) {
      byType[row.issue_type as string] = row.count as number;
    }

    // Get counts by severity
    const bySeverityResult = await db.execute({
      sql: `
        SELECT severity, COUNT(*) as count
        FROM gardening_issues
        WHERE status = 'open'
        GROUP BY severity
      `,
      args: [],
    });

    const bySeverity: Record<string, number> = {};
    for (const row of bySeverityResult.rows) {
      bySeverity[row.severity as string] = row.count as number;
    }

    const issues: GardeningIssue[] = result.rows.map((row) => ({
      id: row.id as string,
      type: row.issue_type as GardeningIssue['type'],
      severity: row.severity as GardeningIssue['severity'],
      entities: JSON.parse((row.affected_nodes as string) || '[]'),
      suggestedAction: (row.description as string) || 'Review required',
      confidence: (row.confidence as number) ?? 0.5,
      status: row.status as GardeningIssue['status'],
      detectedAt: row.detected_at as string,
      workflowRunId: row.workflow_run_id as string,
      graphContext: row.graph_context ? JSON.parse(row.graph_context as string) : undefined,
    }));

    return NextResponse.json({
      issues,
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + params.limit < total,
      },
      summary: {
        byType,
        bySeverity,
        openCount: Object.values(byType).reduce((a, b) => a + b, 0),
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

    console.error('Error fetching issues:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch issues',
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/issues - Update issue status
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { issueId, status, resolution, resolvedBy } = z.object({
      issueId: z.string(),
      status: z.enum(['resolved', 'wont_fix']),
      resolution: z.string().optional(),
      resolvedBy: z.string().optional(),
    }).parse(body);

    const db = getLibSQLClient();

    await db.execute({
      sql: `
        UPDATE gardening_issues
        SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
        WHERE id = ?
      `,
      args: [status, resolution ?? null, resolvedBy ?? 'admin', new Date().toISOString(), issueId],
    });

    return NextResponse.json({
      success: true,
      issueId,
      newStatus: status,
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

    console.error('Error updating issue:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update issue',
      },
      { status: 500 }
    );
  }
}
