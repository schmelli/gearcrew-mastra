/**
 * GET /api/approvals/review/stats
 * Get detailed review statistics and available filters
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { getLibSQLClient } from '@/mastra/index';

export async function GET() {
  try {
    const db = getLibSQLClient();

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
    let deleted = 0;

    for (const row of statusResult.rows) {
      const count = row.count as number;
      total += count;
      switch (row.status) {
        case 'pending': pending = count; break;
        case 'approved': approved = count; break;
        case 'rejected': rejected = count; break;
        case 'deleted': deleted = count; break;
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

    // Get counts by node type
    const typeResult = await db.execute({
      sql: `
        SELECT candidates FROM approval_requests
        WHERE status = 'pending'
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

    // Get recent activity
    const recentResult = await db.execute({
      sql: `
        SELECT resolved_at, resolution
        FROM approval_requests
        WHERE resolved_at IS NOT NULL
        ORDER BY resolved_at DESC
        LIMIT 10
      `,
      args: [],
    });

    const recentActivity = recentResult.rows.map(row => ({
      resolvedAt: row.resolved_at as string,
      resolution: row.resolution as string,
    }));

    // Calculate progress (approved + rejected + deleted = processed)
    const processed = approved + rejected + deleted;
    const progress = total > 0 ? Math.round((processed / total) * 100) : 0;

    return NextResponse.json({
      summary: {
        total,
        pending,
        approved,
        rejected,
        deleted,
        progress: `${progress}%`,
      },
      breakdown: {
        byNodeType: Object.entries(byNodeType)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => ({ type, count })),
        byAction: Object.entries(byAction)
          .sort((a, b) => b[1] - a[1])
          .map(([action, count]) => ({ action, count })),
      },
      recentActivity,
      availableFilters: {
        nodeTypes: Object.keys(byNodeType).sort(),
        actions: Object.keys(byAction).sort(),
      },
    });
  } catch (error) {
    console.error('Error fetching review stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stats', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
