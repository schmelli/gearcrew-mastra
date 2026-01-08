/**
 * T051: GET /api/system/status
 * Implements FR-029: System health metrics endpoint
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering to prevent database initialization during build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getLibSQLClient } from '@/mastra/index';
import { getAuditLogger } from '@/lib/audit-logger';
import { getAnalystAgent } from '@/mastra/agents/analyst';
import { getLatestRuns } from '@/mastra/tools/memgraph/workflow-status';

interface SystemStatusResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  statusReasons: string[];
  memgraphConnected: boolean;
  workflowsRunning: number;
  pendingApprovals: number;
  lastHygieneRun: string | null;
  lastDeduplicationRun: string | null;
  metrics: {
    totalNodes: number;
    totalRelationships: number;
    orphanCount: number;
    duplicatesDetected: number;
    mergesExecuted24h: number;
    deletions24h: number;
  };
  timestamp: string;
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    const client = getMemgraphClient();
    const db = getLibSQLClient();
    const logger = getAuditLogger();

    // Check Memgraph connection
    let memgraphConnected = false;
    let totalNodes = 0;
    let totalRelationships = 0;
    let orphanCount = 0;

    try {
      const nodeResult = await client.readOnlyQuery<{ count: number }>(
        'MATCH (n) RETURN count(n) AS count'
      );
      const relResult = await client.readOnlyQuery<{ count: number }>(
        'MATCH ()-[r]->() RETURN count(r) AS count'
      );

      memgraphConnected = true;
      totalNodes = nodeResult[0]?.count ?? 0;
      totalRelationships = relResult[0]?.count ?? 0;

      // Get orphan count from analyst
      try {
        const analyst = getAnalystAgent();
        const orphanAnalysis = await analyst.analyzeOrphans();
        orphanCount = orphanAnalysis.data.orphanCount;
      } catch {
        // Analyst might fail, use 0
        orphanCount = 0;
      }
    } catch {
      memgraphConnected = false;
    }

    // Get workflow stats
    let workflowsRunning = 0;
    let pendingApprovals = 0;

    try {
      const workflowResult = await db.execute({
        sql: `SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'`,
        args: [],
      });
      workflowsRunning = (workflowResult.rows[0]?.count as number) ?? 0;

      const approvalResult = await db.execute({
        sql: `SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`,
        args: [],
      });
      pendingApprovals = (approvalResult.rows[0]?.count as number) ?? 0;
    } catch {
      // DB might not have tables yet
    }

    // Get latest workflow runs
    let lastHygieneRun: string | null = null;
    let lastDeduplicationRun: string | null = null;

    try {
      const latestRuns = await getLatestRuns();
      lastHygieneRun = latestRuns['morning-hygiene']?.startedAt ?? null;
      lastDeduplicationRun = latestRuns['deep-deduplication']?.startedAt ?? null;
    } catch {
      // Runs might not exist
    }

    // Get 24h audit stats
    let mergesExecuted24h = 0;
    let deletions24h = 0;

    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const summary = await logger.getSummary(yesterday, new Date());
      mergesExecuted24h = summary.byAction.merge ?? 0;
      deletions24h = summary.byAction.delete ?? 0;
    } catch {
      // Audit log might be empty
    }

    // Determine overall status with reasons
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const statusReasons: string[] = [];

    if (!memgraphConnected) {
      status = 'unhealthy';
      statusReasons.push('Cannot connect to Memgraph database');
    } else {
      // Check for degraded conditions
      if (orphanCount > 100) {
        status = 'degraded';
        statusReasons.push(`${orphanCount} orphan nodes detected (threshold: 100)`);
      }
      if (pendingApprovals > 10) {
        status = 'degraded';
        statusReasons.push(`${pendingApprovals} pending approvals require attention (threshold: 10)`);
      }
      // Additional checks for healthy status context
      if (status === 'healthy') {
        if (orphanCount > 0) {
          statusReasons.push(`${orphanCount} orphan nodes present (within acceptable range)`);
        }
        if (workflowsRunning > 0) {
          statusReasons.push(`${workflowsRunning} workflow(s) currently running`);
        }
        if (statusReasons.length === 0) {
          statusReasons.push('All systems operating normally');
        }
      }
    }

    const response: SystemStatusResponse = {
      status,
      statusReasons,
      memgraphConnected,
      workflowsRunning,
      pendingApprovals,
      lastHygieneRun,
      lastDeduplicationRun,
      metrics: {
        totalNodes,
        totalRelationships,
        orphanCount,
        duplicatesDetected: 0, // Would need dedicated tracking
        mergesExecuted24h,
        deletions24h,
      },
      timestamp: new Date().toISOString(),
    };

    // Add timing header
    const duration = Date.now() - startTime;

    return NextResponse.json(response, {
      headers: {
        'X-Response-Time': `${duration}ms`,
      },
    });
  } catch (error) {
    console.error('Error getting system status:', error);

    // Return unhealthy status on error
    return NextResponse.json(
      {
        status: 'unhealthy',
        statusReasons: [error instanceof Error ? error.message : 'Unknown system error'],
        memgraphConnected: false,
        workflowsRunning: 0,
        pendingApprovals: 0,
        lastHygieneRun: null,
        lastDeduplicationRun: null,
        metrics: {
          totalNodes: 0,
          totalRelationships: 0,
          orphanCount: 0,
          duplicatesDetected: 0,
          mergesExecuted24h: 0,
          deletions24h: 0,
        },
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 }
    );
  }
}
