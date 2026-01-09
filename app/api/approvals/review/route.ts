/**
 * GET/POST /api/approvals/review
 * Interactive review session API - stateless and remotely operable
 *
 * GET: Get the next item to review (with full context)
 * POST: Submit a decision for the current item
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { getLibSQLClient } from '@/mastra/index';
import { getMemgraphClient } from '@/lib/memgraph-client';

interface ReviewItem {
  approvalId: string;
  issueId: string;
  workflowRunId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  proposedAction: 'enrich' | 'delete' | 'merge';
  confidence: number;
  problem: string;
  currentData: Record<string, unknown>;
  suggestedResolution: string;
  createdAt: string;
  // Navigation info
  position: number;
  total: number;
  remaining: number;
}

interface ReviewStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  byNodeType: Record<string, number>;
  byAction: Record<string, number>;
}

/**
 * GET /api/approvals/review
 * Get the next item to review, or a specific item by ID
 *
 * Query params:
 * - id: Get a specific approval by ID
 * - nodeType: Filter by node type (GearItem, Insight, etc.)
 * - action: Filter by proposed action (enrich, delete, merge)
 * - skip: Number of items to skip (for manual navigation)
 */
export async function GET(request: NextRequest) {
  try {
    const db = getLibSQLClient();
    const searchParams = request.nextUrl.searchParams;

    const specificId = searchParams.get('id');
    const nodeTypeFilter = searchParams.get('nodeType');
    const actionFilter = searchParams.get('action');
    const skip = parseInt(searchParams.get('skip') ?? '0', 10);

    // Build query for pending approvals
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
        gi.title,
        gi.description
      FROM approval_requests ar
      LEFT JOIN gardening_issues gi ON ar.issue_id = gi.id
      WHERE ar.status = 'pending'
    `;
    const args: (string | number)[] = [];

    if (specificId) {
      sql += ' AND ar.id = ?';
      args.push(specificId);
    }

    if (actionFilter) {
      sql += ' AND ar.proposed_action = ?';
      args.push(actionFilter);
    }

    sql += ' ORDER BY ar.created_at ASC';

    if (!specificId) {
      sql += ' LIMIT 1 OFFSET ?';
      args.push(skip);
    }

    const result = await db.execute({ sql, args });

    if (result.rows.length === 0) {
      // Get stats even if no items
      const stats = await getReviewStats(db, nodeTypeFilter, actionFilter);
      return NextResponse.json({
        item: null,
        message: stats.pending === 0
          ? '🎉 All items reviewed! No pending approvals.'
          : 'No items match the current filter.',
        stats,
      });
    }

    const row = result.rows[0]!;
    const candidates = JSON.parse(row.candidates as string);
    const candidate = candidates[0];

    // Filter by node type if specified (post-query filter since it's in JSON)
    if (nodeTypeFilter && candidate.nodeType !== nodeTypeFilter) {
      // Find next matching item
      const filteredResult = await db.execute({
        sql: `
          SELECT ar.id, ar.candidates
          FROM approval_requests ar
          WHERE ar.status = 'pending'
          ORDER BY ar.created_at ASC
        `,
        args: [],
      });

      let matchingId: string | null = null;
      let skipped = 0;
      for (const r of filteredResult.rows) {
        const c = JSON.parse(r.candidates as string)[0];
        if (c.nodeType === nodeTypeFilter) {
          if (skipped >= skip) {
            matchingId = r.id as string;
            break;
          }
          skipped++;
        }
      }

      if (!matchingId) {
        const stats = await getReviewStats(db, nodeTypeFilter, actionFilter);
        return NextResponse.json({
          item: null,
          message: `No more ${nodeTypeFilter} items to review.`,
          stats,
        });
      }

      // Re-fetch the matching item
      const matchResult = await db.execute({
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
            gi.title,
            gi.description
          FROM approval_requests ar
          LEFT JOIN gardening_issues gi ON ar.issue_id = gi.id
          WHERE ar.id = ?
        `,
        args: [matchingId],
      });

      if (matchResult.rows.length > 0) {
        const matchRow = matchResult.rows[0]!;
        const matchCandidates = JSON.parse(matchRow.candidates as string);
        Object.assign(row, matchRow);
        Object.assign(candidates, matchCandidates);
        Object.assign(candidate, matchCandidates[0]);
      }
    }

    // Parse the reasoning to extract structured parts
    const reasoning = row.reasoning as string;
    const problemMatch = reasoning.match(/\*\*Problem:\*\*\n([^\n]+)/);
    const resolutionMatch = reasoning.match(/\*\*Suggested Resolution:\*\*\n([\s\S]+?)(?:\n\n|$)/);

    // Get total and position
    const countResult = await db.execute({
      sql: 'SELECT COUNT(*) as total FROM approval_requests WHERE status = ?',
      args: ['pending'],
    });
    const total = (countResult.rows[0]?.total as number) ?? 0;

    const positionResult = await db.execute({
      sql: `
        SELECT COUNT(*) as pos FROM approval_requests
        WHERE status = 'pending' AND created_at <= ?
      `,
      args: [row.created_at as string],
    });
    const position = (positionResult.rows[0]?.pos as number) ?? 1;

    const reviewItem: ReviewItem = {
      approvalId: row.approval_id as string,
      issueId: row.issue_id as string,
      workflowRunId: row.workflow_run_id as string,
      nodeId: candidate.nodeId,
      nodeName: candidate.nodeName,
      nodeType: candidate.nodeType ?? candidate.nodeProperties?.labels?.[0] ?? 'Unknown',
      proposedAction: row.proposed_action as 'enrich' | 'delete' | 'merge',
      confidence: row.confidence as number,
      problem: problemMatch?.[1] ?? reasoning.split('\n')[3] ?? 'Unknown issue',
      currentData: candidate.nodeProperties ?? {},
      suggestedResolution: resolutionMatch?.[1]?.trim() ?? 'Review and decide',
      createdAt: row.created_at as string,
      position,
      total,
      remaining: total - position,
    };

    const stats = await getReviewStats(db, nodeTypeFilter, actionFilter);

    return NextResponse.json({
      item: reviewItem,
      fullReasoning: reasoning,
      stats,
      filters: {
        nodeType: nodeTypeFilter,
        action: actionFilter,
        skip,
      },
    });
  } catch (error) {
    console.error('Error fetching review item:', error);
    return NextResponse.json(
      { error: 'Failed to fetch review item', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/approvals/review
 * Submit a decision for an approval
 *
 * Body:
 * - approvalId: The ID of the approval to decide on
 * - decision: 'approve' | 'reject' | 'skip'
 * - notes: Optional notes explaining the decision
 */
export async function POST(request: NextRequest) {
  try {
    const db = getLibSQLClient();
    const body = await request.json();

    const { approvalId, decision, notes } = body;

    if (!approvalId) {
      return NextResponse.json({ error: 'approvalId is required' }, { status: 400 });
    }

    if (!['approve', 'reject', 'skip'].includes(decision)) {
      return NextResponse.json(
        { error: 'decision must be approve, reject, or skip' },
        { status: 400 }
      );
    }

    // Get the approval details
    const approvalResult = await db.execute({
      sql: 'SELECT * FROM approval_requests WHERE id = ?',
      args: [approvalId],
    });

    if (approvalResult.rows.length === 0) {
      return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
    }

    const approval = approvalResult.rows[0]!;
    const candidates = JSON.parse(approval.candidates as string);
    const candidate = candidates[0];

    if (decision === 'skip') {
      // Just return success without changing status
      return NextResponse.json({
        success: true,
        message: 'Item skipped',
        approvalId,
        decision,
      });
    }

    // Update the approval status
    const resolvedAt = new Date().toISOString();
    await db.execute({
      sql: `
        UPDATE approval_requests
        SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?, resolution_notes = ?
        WHERE id = ?
      `,
      args: [
        decision === 'approve' ? 'approved' : 'rejected',
        resolvedAt,
        'admin', // Would be actual user in production
        decision,
        notes ?? null,
        approvalId,
      ],
    });

    // Update the associated issue
    await db.execute({
      sql: `
        UPDATE gardening_issues
        SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ?
        WHERE id = ?
      `,
      args: [
        decision === 'approve' ? 'resolved' : 'dismissed',
        'admin',
        resolvedAt,
        decision === 'approve'
          ? `Approved: ${approval.proposed_action}`
          : `Rejected: ${notes ?? 'No reason provided'}`,
        approval.issue_id,
      ],
    });

    // If approved, execute the proposed action
    let actionResult = null;
    if (decision === 'approve') {
      actionResult = await executeApprovedAction(
        approval.proposed_action as string,
        candidate.nodeId,
        candidate.nodeProperties,
        approval.workflow_run_id as string
      );
    }

    // Get updated stats
    const stats = await getReviewStats(db, null, null);

    return NextResponse.json({
      success: true,
      message: decision === 'approve'
        ? `✅ Approved: ${approval.proposed_action} for "${candidate.nodeName}"`
        : `❌ Rejected: "${candidate.nodeName}"`,
      approvalId,
      decision,
      actionResult,
      stats,
    });
  } catch (error) {
    console.error('Error processing review decision:', error);
    return NextResponse.json(
      { error: 'Failed to process decision', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * Get review statistics
 */
async function getReviewStats(
  db: ReturnType<typeof getLibSQLClient>,
  nodeTypeFilter: string | null,
  actionFilter: string | null
): Promise<ReviewStats> {
  // Get counts by status
  const statusResult = await db.execute({
    sql: `
      SELECT status, COUNT(*) as count
      FROM approval_requests
      GROUP BY status
    `,
    args: [],
  });

  let total = 0;
  let pending = 0;
  let approved = 0;
  let rejected = 0;

  for (const row of statusResult.rows) {
    const count = row.count as number;
    total += count;
    switch (row.status) {
      case 'pending': pending = count; break;
      case 'approved': approved = count; break;
      case 'rejected': rejected = count; break;
    }
  }

  // Get counts by action
  const actionResult = await db.execute({
    sql: `
      SELECT proposed_action, COUNT(*) as count
      FROM approval_requests
      WHERE status = 'pending'
      GROUP BY proposed_action
    `,
    args: [],
  });

  const byAction: Record<string, number> = {};
  for (const row of actionResult.rows) {
    byAction[row.proposed_action as string] = row.count as number;
  }

  // Get counts by node type (requires parsing JSON, so we sample)
  const typeResult = await db.execute({
    sql: `
      SELECT candidates FROM approval_requests
      WHERE status = 'pending'
      LIMIT 500
    `,
    args: [],
  });

  const byNodeType: Record<string, number> = {};
  for (const row of typeResult.rows) {
    try {
      const candidates = JSON.parse(row.candidates as string);
      const nodeType = candidates[0]?.nodeType ?? candidates[0]?.nodeProperties?.labels?.[0] ?? 'Unknown';
      byNodeType[nodeType] = (byNodeType[nodeType] ?? 0) + 1;
    } catch {
      byNodeType['Unknown'] = (byNodeType['Unknown'] ?? 0) + 1;
    }
  }

  return {
    total,
    pending,
    approved,
    rejected,
    byNodeType,
    byAction,
  };
}

/**
 * Execute the approved action
 */
async function executeApprovedAction(
  action: string,
  nodeId: string,
  nodeProperties: Record<string, unknown>,
  workflowRunId: string
): Promise<{ success: boolean; message: string }> {
  const client = getMemgraphClient();
  const { getAuditLogger } = await import('@/lib/audit-logger');
  const auditLogger = getAuditLogger();

  try {
    switch (action) {
      case 'delete': {
        // Delete the orphan node
        await client.writeTransaction(
          `MATCH (n) WHERE n.id = $nodeId OR toString(id(n)) = $nodeId DETACH DELETE n`,
          { nodeId }
        );

        await auditLogger.logDelete(
          workflowRunId,
          'manual-review',
          nodeId,
          (nodeProperties.labels as string[])?.[0] ?? 'Unknown',
          nodeProperties,
          { confidence: 1.0, reasoning: 'Manually approved for deletion' }
        );

        return { success: true, message: `Deleted node ${nodeId}` };
      }

      case 'enrich': {
        // For enrich, we just mark it as approved - actual enrichment happens later
        // Log that it's been approved for enrichment
        await auditLogger.logFlag(
          workflowRunId,
          'manual-review',
          nodeId,
          (nodeProperties.labels as string[])?.[0] ?? 'Unknown',
          { confidence: 1.0, reasoning: 'Approved for enrichment - queued for research' }
        );

        return { success: true, message: `Queued node ${nodeId} for enrichment` };
      }

      case 'merge': {
        // Merge requires additional context - mark as approved
        return { success: true, message: `Merge approved for node ${nodeId} - requires manual execution` };
      }

      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to execute ${action}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
