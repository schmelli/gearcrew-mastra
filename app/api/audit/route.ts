/**
 * T052: GET /api/audit
 * Implements FR-026: Query audit log entries
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { z } from 'zod';
import { getAuditLogger } from '@/lib/audit-logger';
import { AuditAction, WorkflowType } from '@/types';

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  action: z.enum(['create', 'update', 'delete', 'merge', 'skip', 'flag', 'error']).optional(),
  entityId: z.string().optional(),
  workflowType: z.enum(['morning-hygiene', 'deep-deduplication', 'gap-filling', 'manual']).optional(),
  workflowRunId: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).optional().default(100),
});

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const params = QuerySchema.parse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      action: searchParams.get('action') ?? undefined,
      entityId: searchParams.get('entityId') ?? undefined,
      workflowType: searchParams.get('workflowType') ?? undefined,
      workflowRunId: searchParams.get('workflowRunId') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
    });

    const logger = getAuditLogger();

    const entries = await logger.query({
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
      action: params.action as AuditAction,
      entityId: params.entityId,
      workflowType: params.workflowType as WorkflowType,
      workflowRunId: params.workflowRunId,
      limit: params.limit,
    });

    // Calculate summary
    const byAction: Record<string, number> = {};
    const byWorkflowType: Record<string, number> = {};
    const uniqueEntityIds = new Set<string>();

    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byWorkflowType[entry.workflowType] = (byWorkflowType[entry.workflowType] ?? 0) + 1;
      uniqueEntityIds.add(entry.entityId);
    }

    return NextResponse.json({
      entries,
      total: entries.length,
      summary: {
        byAction,
        byWorkflowType,
        uniqueEntities: uniqueEntityIds.size,
      },
      query: {
        from: params.from,
        to: params.to,
        action: params.action,
        entityId: params.entityId,
        workflowType: params.workflowType,
        workflowRunId: params.workflowRunId,
        limit: params.limit,
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

    console.error('Error querying audit log:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to query audit log',
      },
      { status: 500 }
    );
  }
}
