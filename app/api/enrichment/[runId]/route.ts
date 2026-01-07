/**
 * T073: Enrichment Run Status Endpoint
 * GET /api/enrichment/:runId - Get detailed enrichment run status
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getGapFillingStatus } from '@/mastra/workflows/gap-filling';
import { getAuditLogger } from '@/lib/audit-logger';
import { getLibSQLClient } from '@/mastra/index';

interface RouteParams {
  params: Promise<{ runId: string }>;
}

/**
 * GET /api/enrichment/:runId - Get enrichment run details
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { runId } = await params;

  try {
    // Get workflow status
    const status = await getGapFillingStatus(runId);

    if (!status) {
      return NextResponse.json(
        {
          code: 'NOT_FOUND',
          message: 'Enrichment run not found',
          details: { runId },
        },
        { status: 404 }
      );
    }

    // Get audit entries for this run
    const logger = getAuditLogger();
    const auditEntries = await logger.query({
      workflowRunId: runId,
      limit: 100,
    });

    // Get enrichment statistics
    const db = getLibSQLClient();
    const statsResult = await db.execute({
      sql: `SELECT
              COUNT(CASE WHEN action = 'update' THEN 1 END) as enriched,
              COUNT(CASE WHEN action = 'skip' THEN 1 END) as skipped,
              COUNT(CASE WHEN action = 'error' THEN 1 END) as failed
            FROM audit_log
            WHERE workflow_run_id = ?`,
      args: [runId],
    });

    const stats = statsResult.rows[0] || { enriched: 0, skipped: 0, failed: 0 };

    // Get enriched nodes details
    const enrichedNodes = auditEntries
      .filter((e) => e.action === 'update')
      .map((e) => ({
        nodeId: e.entityId,
        enrichedFields: (e.afterState as Record<string, unknown>)?.enrichedFields || [],
        confidence: e.metadata?.confidence,
        source: (e.afterState as Record<string, unknown>)?.source,
        timestamp: e.timestamp,
      }));

    // Get skipped nodes reasons
    const skippedNodes = auditEntries
      .filter((e) => e.action === 'skip')
      .map((e) => ({
        nodeId: e.entityId,
        reason: e.reasoning,
        confidence: e.metadata?.confidence,
        timestamp: e.timestamp,
      }));

    // Get failed nodes errors
    const failedNodes = auditEntries
      .filter((e) => e.action === 'error')
      .map((e) => ({
        nodeId: e.entityId,
        error: e.reasoning,
        timestamp: e.timestamp,
      }));

    // Calculate field statistics
    const fieldStats: Record<string, number> = {};
    for (const node of enrichedNodes) {
      for (const field of node.enrichedFields as string[]) {
        fieldStats[field] = (fieldStats[field] || 0) + 1;
      }
    }

    return NextResponse.json({
      runId: status.runId,
      status: status.status,
      phase: status.phase,
      startedAt: status.startedAt,
      completedAt: status.completedAt,
      error: status.error,
      progress: status.progress,
      statistics: {
        totalProcessed:
          (stats.enriched as number) + (stats.skipped as number) + (stats.failed as number),
        enriched: stats.enriched as number,
        skipped: stats.skipped as number,
        failed: stats.failed as number,
        fieldBreakdown: fieldStats,
      },
      enrichedNodes: enrichedNodes.slice(0, 20), // Limit to prevent large responses
      skippedNodes: skippedNodes.slice(0, 20),
      failedNodes: failedNodes.slice(0, 20),
      hasMoreResults: enrichedNodes.length > 20 || skippedNodes.length > 20 || failedNodes.length > 20,
    });
  } catch (error) {
    console.error('Error fetching enrichment details:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch enrichment details',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/enrichment/:runId - Cancel a running enrichment
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
          message: 'Enrichment run not found',
        },
        { status: 404 }
      );
    }

    const currentStatus = result.rows[0]!.status as string;

    if (currentStatus !== 'running') {
      return NextResponse.json(
        {
          code: 'INVALID_STATE',
          message: `Cannot cancel enrichment in ${currentStatus} state`,
        },
        { status: 409 }
      );
    }

    // Update status to cancelled
    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'cancelled', completed_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), runId],
    });

    return NextResponse.json({
      success: true,
      runId,
      message: 'Enrichment workflow cancelled',
    });
  } catch (error) {
    console.error('Error cancelling enrichment:', error);
    return NextResponse.json(
      {
        code: 'INTERNAL_ERROR',
        message: 'Failed to cancel enrichment',
      },
      { status: 500 }
    );
  }
}
