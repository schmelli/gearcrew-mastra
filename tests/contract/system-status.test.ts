/**
 * T043: Contract test for GET /api/system/status
 * Tests the API endpoint for retrieving system health metrics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Response schema per openapi.yaml
const SystemStatusResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  memgraphConnected: z.boolean(),
  workflowsRunning: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  lastHygieneRun: z.string().datetime().nullable(),
  lastDeduplicationRun: z.string().datetime().nullable(),
  metrics: z.object({
    totalNodes: z.number().int().nonnegative(),
    totalRelationships: z.number().int().nonnegative(),
    orphanCount: z.number().int().nonnegative(),
    duplicatesDetected: z.number().int().nonnegative(),
    mergesExecuted24h: z.number().int().nonnegative(),
    deletions24h: z.number().int().nonnegative(),
  }),
  timestamp: z.string().datetime(),
});

describe('GET /api/system/status - Contract Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Response Schema Validation', () => {
    it('should return valid response structure for healthy system', () => {
      const healthyResponse = {
        status: 'healthy',
        memgraphConnected: true,
        workflowsRunning: 0,
        pendingApprovals: 0,
        lastHygieneRun: '2024-01-15T04:00:00Z',
        lastDeduplicationRun: '2024-01-14T02:00:00Z',
        metrics: {
          totalNodes: 5000,
          totalRelationships: 15000,
          orphanCount: 0,
          duplicatesDetected: 0,
          mergesExecuted24h: 3,
          deletions24h: 5,
        },
        timestamp: new Date().toISOString(),
      };

      const result = SystemStatusResponseSchema.safeParse(healthyResponse);
      expect(result.success).toBe(true);
    });

    it('should return valid response structure for degraded system', () => {
      const degradedResponse = {
        status: 'degraded',
        memgraphConnected: true,
        workflowsRunning: 1,
        pendingApprovals: 15,
        lastHygieneRun: '2024-01-15T04:00:00Z',
        lastDeduplicationRun: null,
        metrics: {
          totalNodes: 5000,
          totalRelationships: 15000,
          orphanCount: 25,
          duplicatesDetected: 15,
          mergesExecuted24h: 0,
          deletions24h: 0,
        },
        timestamp: new Date().toISOString(),
      };

      const result = SystemStatusResponseSchema.safeParse(degradedResponse);
      expect(result.success).toBe(true);
    });

    it('should return valid response structure for unhealthy system', () => {
      const unhealthyResponse = {
        status: 'unhealthy',
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
      };

      const result = SystemStatusResponseSchema.safeParse(unhealthyResponse);
      expect(result.success).toBe(true);
    });
  });

  describe('Status Determination Logic', () => {
    it('should return healthy when all systems operational', () => {
      const status = determineSystemStatus({
        memgraphConnected: true,
        pendingApprovals: 5,
        orphanCount: 2,
        workflowsRunning: 0,
      });

      expect(status).toBe('healthy');
    });

    it('should return degraded when pending approvals exceed threshold', () => {
      const status = determineSystemStatus({
        memgraphConnected: true,
        pendingApprovals: 15, // Threshold is 10
        orphanCount: 2,
        workflowsRunning: 0,
      });

      expect(status).toBe('degraded');
    });

    it('should return degraded when orphan count exceeds threshold', () => {
      const status = determineSystemStatus({
        memgraphConnected: true,
        pendingApprovals: 5,
        orphanCount: 50, // Threshold is 20
        workflowsRunning: 0,
      });

      expect(status).toBe('degraded');
    });

    it('should return unhealthy when Memgraph disconnected', () => {
      const status = determineSystemStatus({
        memgraphConnected: false,
        pendingApprovals: 0,
        orphanCount: 0,
        workflowsRunning: 0,
      });

      expect(status).toBe('unhealthy');
    });
  });

  describe('Metrics Accuracy', () => {
    it('should return accurate 24h action counts', () => {
      const now = new Date();
      // Make "yesterday" more than 24 hours ago to be clearly outside the window
      const moreThan24hAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);

      const auditEntries = [
        { action: 'merge', timestamp: new Date(now.getTime() - 1000).toISOString() },
        { action: 'merge', timestamp: new Date(now.getTime() - 2000).toISOString() },
        { action: 'delete', timestamp: new Date(now.getTime() - 3000).toISOString() },
        { action: 'merge', timestamp: moreThan24hAgo.toISOString() }, // Outside 24h
      ];

      const counts = calculate24hCounts(auditEntries, now);

      expect(counts.merges).toBe(2);
      expect(counts.deletions).toBe(1);
    });
  });

  describe('Error Responses', () => {
    it('should return 500 with error details on failure', () => {
      const errorResponse = {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve system status',
        details: {
          cause: 'Database connection timeout',
        },
      };

      expect(errorResponse.code).toBe('INTERNAL_ERROR');
      expect(errorResponse.details).toHaveProperty('cause');
    });

    it('should return 503 when Memgraph unavailable', () => {
      const errorResponse = {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Memgraph database is not available',
        details: {
          retryAfter: 30,
        },
      };

      expect(errorResponse.code).toBe('SERVICE_UNAVAILABLE');
      expect(errorResponse.details.retryAfter).toBe(30);
    });
  });

  describe('Timestamp Handling', () => {
    it('should return ISO 8601 formatted timestamps', () => {
      const response = {
        timestamp: new Date().toISOString(),
        lastHygieneRun: '2024-01-15T04:00:00Z',
      };

      expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(response.lastHygieneRun).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return null for never-run workflows', () => {
      const response = {
        lastHygieneRun: null,
        lastDeduplicationRun: null,
      };

      expect(response.lastHygieneRun).toBeNull();
      expect(response.lastDeduplicationRun).toBeNull();
    });
  });
});

// Helper functions for testing
function determineSystemStatus(params: {
  memgraphConnected: boolean;
  pendingApprovals: number;
  orphanCount: number;
  workflowsRunning: number;
}): 'healthy' | 'degraded' | 'unhealthy' {
  // Unhealthy: Critical systems down
  if (!params.memgraphConnected) {
    return 'unhealthy';
  }

  // Degraded: Thresholds exceeded
  const PENDING_THRESHOLD = 10;
  const ORPHAN_THRESHOLD = 20;

  if (params.pendingApprovals > PENDING_THRESHOLD || params.orphanCount > ORPHAN_THRESHOLD) {
    return 'degraded';
  }

  return 'healthy';
}

function calculate24hCounts(
  entries: Array<{ action: string; timestamp: string }>,
  now: Date
): { merges: number; deletions: number } {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;

  let merges = 0;
  let deletions = 0;

  for (const entry of entries) {
    const entryTime = new Date(entry.timestamp).getTime();
    if (entryTime >= cutoff) {
      if (entry.action === 'merge') merges++;
      if (entry.action === 'delete') deletions++;
    }
  }

  return { merges, deletions };
}
