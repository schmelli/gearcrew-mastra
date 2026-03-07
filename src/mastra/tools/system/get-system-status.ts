/**
 * Mastra Tool: Get System Status
 * Returns overall system health including workflow state, pending approvals, and graph metrics
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getLibSQLClient } from '@/lib/db';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getLatestRuns } from '../memgraph/workflow-status';
import { getTodaySummary } from '../memgraph/audit-query';

const SystemStatusOutputSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  memgraphConnected: z.boolean(),
  workflowsRunning: z.number(),
  pendingApprovals: z.number(),
  lastHygieneRun: z.string().nullable(),
  lastDeduplicationRun: z.string().nullable(),
  metrics: z.object({
    totalNodes: z.number(),
    totalRelationships: z.number(),
    orphanCount: z.number(),
    duplicatesDetected: z.number(),
    mergesExecuted24h: z.number(),
    deletions24h: z.number(),
  }),
  timestamp: z.string(),
});

export type SystemStatus = z.infer<typeof SystemStatusOutputSchema>;

export const getSystemStatusTool = createTool({
  id: 'get-system-status',
  description: 'Get overall system health status including workflow state, pending approvals, and graph metrics',
  inputSchema: z.object({}),
  outputSchema: SystemStatusOutputSchema,
  execute: async () => {
    const client = getMemgraphClient();
    const db = getLibSQLClient();

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

      // Get orphan count via WCC
      try {
        const wccResult = await client.readOnlyQuery<{ componentId: number; nodeCount: number }>(`
          CALL weakly_connected_components.get()
          YIELD node, component_id
          WITH component_id, count(node) AS nodeCount
          WHERE nodeCount = 1
          RETURN count(*) AS orphanCount
        `);
        orphanCount = wccResult[0]?.nodeCount ?? 0;
      } catch {
        // WCC not available, skip orphan count
      }
    } catch {
      memgraphConnected = false;
    }

    const workflowResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'`,
      args: [],
    });
    const workflowsRunning = (workflowResult.rows[0]?.count as number) ?? 0;

    const approvalResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`,
      args: [],
    });
    const pendingApprovals = (approvalResult.rows[0]?.count as number) ?? 0;

    const latestRuns = await getLatestRuns();
    const auditSummary = await getTodaySummary();

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (!memgraphConnected) {
      status = 'unhealthy';
    } else if (pendingApprovals > 10 || orphanCount > 20) {
      status = 'degraded';
    }

    return {
      status,
      memgraphConnected,
      workflowsRunning,
      pendingApprovals,
      lastHygieneRun: latestRuns['morning-hygiene']?.startedAt ?? null,
      lastDeduplicationRun: latestRuns['deep-deduplication']?.startedAt ?? null,
      metrics: {
        totalNodes,
        totalRelationships,
        orphanCount,
        duplicatesDetected: 0,
        mergesExecuted24h: auditSummary.merges,
        deletions24h: auditSummary.deletes,
      },
      timestamp: new Date().toISOString(),
    };
  },
});

export default getSystemStatusTool;
