/**
 * POST /api/approvals/review/batch
 * Bulk approve/reject approvals by filter criteria
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { getLibSQLClient } from '@/mastra/index';
import { getMemgraphClient } from '@/lib/memgraph-client';

interface BatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ approvalId: string; error: string }>;
}

/**
 * POST /api/approvals/review/batch
 *
 * Body:
 * - decision: 'approve' | 'reject'
 * - nodeType: Filter by node type (optional)
 * - action: Filter by proposed action (optional)
 * - minConfidence: Minimum confidence threshold 0-1 (optional, e.g. 0.95 for 95%)
 * - limit: Maximum items to process (default 50, max 500)
 * - notes: Notes for all decisions
 * - dryRun: If true, just return what would be affected (default false)
 */
export async function POST(request: NextRequest) {
  try {
    const db = getLibSQLClient();
    const body = await request.json();

    const {
      decision,
      nodeType,
      action: actionFilter,
      minConfidence,
      limit = 50,
      notes,
      dryRun = false,
    } = body;

    if (!['approve', 'reject', 'delete'].includes(decision)) {
      return NextResponse.json(
        { error: 'decision must be approve, reject, or delete' },
        { status: 400 }
      );
    }

    const maxLimit = Math.min(limit, 500);

    // Get pending approvals matching filter
    const pendingResult = await db.execute({
      sql: `
        SELECT id, candidates, proposed_action, workflow_run_id, confidence
        FROM approval_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `,
      args: [],
    });

    // Filter by criteria
    const matchingApprovals: Array<{
      id: string;
      nodeId: string;
      nodeName: string;
      nodeType: string;
      proposedAction: string;
      workflowRunId: string;
      nodeProperties: Record<string, unknown>;
      confidence: number;
    }> = [];

    for (const row of pendingResult.rows) {
      if (matchingApprovals.length >= maxLimit) break;

      try {
        const candidates = JSON.parse(row.candidates as string);
        const candidate = candidates[0];
        const candidateNodeType = candidate.nodeType ?? candidate.nodeProperties?.labels?.[0] ?? 'Unknown';
        const candidateConfidence = (row.confidence as number) ?? 0;

        // Apply filters
        if (nodeType && candidateNodeType !== nodeType) continue;
        if (actionFilter && row.proposed_action !== actionFilter) continue;
        if (minConfidence !== undefined && candidateConfidence < minConfidence) continue;

        matchingApprovals.push({
          id: row.id as string,
          nodeId: candidate.nodeId,
          nodeName: candidate.nodeName,
          nodeType: candidateNodeType,
          proposedAction: row.proposed_action as string,
          workflowRunId: row.workflow_run_id as string,
          nodeProperties: candidate.nodeProperties ?? {},
          confidence: candidateConfidence,
        });
      } catch {
        // Skip malformed entries
      }
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        wouldProcess: matchingApprovals.length,
        decision,
        filters: { nodeType, action: actionFilter, minConfidence, limit: maxLimit },
        preview: matchingApprovals.slice(0, 10).map(a => ({
          id: a.id,
          nodeName: a.nodeName,
          nodeType: a.nodeType,
          proposedAction: a.proposedAction,
          confidence: a.confidence,
        })),
        message: `Would ${decision} ${matchingApprovals.length} items${minConfidence ? ` with confidence >= ${(minConfidence * 100).toFixed(0)}%` : ''}`,
      });
    }

    // Process approvals
    const result: BatchResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    const resolvedAt = new Date().toISOString();
    const client = getMemgraphClient();

    // Status mapping for different decisions
    const statusMap: Record<string, string> = {
      approve: 'approved',
      reject: 'rejected',
      delete: 'deleted',
    };

    for (const approval of matchingApprovals) {
      result.processed++;

      try {
        // Update approval status
        await db.execute({
          sql: `
            UPDATE approval_requests
            SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?, resolution_notes = ?
            WHERE id = ?
          `,
          args: [
            statusMap[decision],
            resolvedAt,
            'batch-admin',
            decision,
            notes ?? `Batch ${decision}`,
            approval.id,
          ],
        });

        // Execute delete if decision is 'delete' OR if approved and action is delete
        if (decision === 'delete' || (decision === 'approve' && approval.proposedAction === 'delete')) {
          await client.writeTransaction(
            `MATCH (n) WHERE n.id = $nodeId OR toString(id(n)) = $nodeId DETACH DELETE n`,
            { nodeId: approval.nodeId }
          );
        }

        result.succeeded++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          approvalId: approval.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Get updated stats
    const statsResult = await db.execute({
      sql: `
        SELECT status, COUNT(*) as count
        FROM approval_requests
        GROUP BY status
      `,
      args: [],
    });

    const stats: Record<string, number> = {};
    for (const row of statsResult.rows) {
      stats[row.status as string] = row.count as number;
    }

    const decisionVerbs: Record<string, string> = {
      approve: 'Approved',
      reject: 'Rejected',
      delete: 'Deleted',
    };

    return NextResponse.json({
      success: result.failed === 0,
      result,
      stats: {
        pending: stats['pending'] ?? 0,
        approved: stats['approved'] ?? 0,
        rejected: stats['rejected'] ?? 0,
        deleted: stats['deleted'] ?? 0,
      },
      message: `${decisionVerbs[decision]} ${result.succeeded} of ${result.processed} items${
        result.failed > 0 ? ` (${result.failed} failed)` : ''
      }`,
    });
  } catch (error) {
    console.error('Error processing batch:', error);
    return NextResponse.json(
      { error: 'Failed to process batch', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
