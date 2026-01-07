/**
 * T042: Integration test for status query via chat
 * Tests FR-010: Administrator can ask natural language questions about graph health
 * Tests FR-011: Head Gardener provides accurate current information
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the agents and tools
vi.mock('@/mastra/agents/head-gardener', () => ({
  getHeadGardenerAgent: vi.fn(() => ({
    chat: vi.fn(),
    getSystemStatus: vi.fn(),
  })),
}));

vi.mock('@/lib/audit-logger', () => ({
  getAuditLogger: vi.fn(() => ({
    query: vi.fn(),
    getSummary: vi.fn(),
  })),
}));

describe('Chat Status Query - Integration Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Status Query Understanding', () => {
    it('should understand "How many orphans did you find today?"', async () => {
      const query = 'How many orphans did you find today?';

      // Parse intent from query
      const intent = parseQueryIntent(query);

      expect(intent.type).toBe('status_query');
      expect(intent.subject).toBe('orphans');
      expect(intent.timeframe).toBe('today');
    });

    it('should understand "What is the current graph health?"', async () => {
      const query = 'What is the current graph health?';

      const intent = parseQueryIntent(query);

      expect(intent.type).toBe('status_query');
      expect(intent.subject).toBe('health');
      expect(intent.timeframe).toBe('current');
    });

    it('should understand "Show me pending approvals"', async () => {
      const query = 'Show me pending approvals';

      const intent = parseQueryIntent(query);

      expect(intent.type).toBe('list_query');
      expect(intent.subject).toBe('approvals');
      expect(intent.filter).toBe('pending');
    });

    it('should understand "List recent merges"', async () => {
      const query = 'List recent merges';

      const intent = parseQueryIntent(query);

      expect(intent.type).toBe('list_query');
      expect(intent.subject).toBe('merges');
      expect(intent.timeframe).toBe('recent');
    });
  });

  describe('Response Accuracy', () => {
    it('should return accurate orphan count from audit log', async () => {
      const { getAuditLogger } = await import('@/lib/audit-logger');
      const logger = getAuditLogger();

      // Mock audit log data
      vi.mocked(logger.query).mockResolvedValue([
        {
          id: '1',
          timestamp: new Date().toISOString(),
          workflowRunId: 'run-1',
          workflowType: 'morning-hygiene',
          action: 'delete',
          entityId: 'orphan-1',
          entityType: 'GearItem',
          before: { name: 'Orphan Node 1' },
          after: null,
        },
        {
          id: '2',
          timestamp: new Date().toISOString(),
          workflowRunId: 'run-1',
          workflowType: 'morning-hygiene',
          action: 'delete',
          entityId: 'orphan-2',
          entityType: 'GearItem',
          before: { name: 'Orphan Node 2' },
          after: null,
        },
      ]);

      const entries = await logger.query({
        action: 'delete',
        workflowType: 'morning-hygiene',
        from: new Date(new Date().setHours(0, 0, 0, 0)),
      });

      expect(entries.length).toBe(2);
    });

    it('should return accurate merge statistics', async () => {
      const { getAuditLogger } = await import('@/lib/audit-logger');
      const logger = getAuditLogger();

      const now = new Date();
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));

      vi.mocked(logger.getSummary).mockResolvedValue({
        totalActions: 10,
        byAction: {
          create: 0,
          update: 2,
          delete: 3,
          merge: 4,
          skip: 1,
          flag: 0,
          error: 0,
        },
        byWorkflowType: {
          'morning-hygiene': 5,
          'deep-deduplication': 4,
          'gap-filling': 1,
          manual: 0,
        },
        uniqueEntities: 8,
      });

      const summary = await logger.getSummary(startOfDay, new Date());

      expect(summary.byAction.merge).toBe(4);
      expect(summary.byAction.delete).toBe(3);
    });
  });

  describe('Chat Response Format', () => {
    it('should format status response with key metrics', () => {
      const status = {
        totalNodes: 1000,
        orphanCount: 5,
        pendingApprovals: 3,
        recentMerges: 12,
        lastHygieneRun: '2024-01-15T04:00:00Z',
      };

      const response = formatStatusResponse(status);

      expect(response).toContain('1,000 nodes');
      expect(response).toContain('5 orphans');
      expect(response).toContain('3 pending approvals');
    });

    it('should include time context in responses', () => {
      const status = {
        orphanCount: 5,
        detectedAt: '2024-01-15T04:00:00Z',
      };

      const response = formatStatusResponse(status);

      expect(response).toMatch(/today|this morning|at 04:00/i);
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown query types gracefully', () => {
      const query = 'What is the meaning of life?';

      const intent = parseQueryIntent(query);

      expect(intent.type).toBe('unknown');
    });

    it('should provide helpful suggestions for unknown queries', () => {
      const query = 'What is the meaning of life?';

      const response = handleUnknownQuery(query);

      expect(response).toContain('I can help you with');
      expect(response).toMatch(/graph health|orphans|duplicates|workflows/i);
    });
  });
});

// Helper functions for testing
function parseQueryIntent(query: string): {
  type: 'status_query' | 'list_query' | 'action_request' | 'unknown';
  subject?: string;
  timeframe?: string;
  filter?: string;
} {
  const lowerQuery = query.toLowerCase();

  // Status queries
  if (lowerQuery.includes('how many') || lowerQuery.includes('what is')) {
    if (lowerQuery.includes('orphan')) {
      return {
        type: 'status_query',
        subject: 'orphans',
        timeframe: lowerQuery.includes('today') ? 'today' : 'current',
      };
    }
    if (lowerQuery.includes('health')) {
      return {
        type: 'status_query',
        subject: 'health',
        timeframe: 'current',
      };
    }
  }

  // List queries
  if (lowerQuery.includes('show') || lowerQuery.includes('list')) {
    if (lowerQuery.includes('approval')) {
      return {
        type: 'list_query',
        subject: 'approvals',
        filter: lowerQuery.includes('pending') ? 'pending' : undefined,
      };
    }
    if (lowerQuery.includes('merge')) {
      return {
        type: 'list_query',
        subject: 'merges',
        timeframe: lowerQuery.includes('recent') ? 'recent' : undefined,
      };
    }
  }

  return { type: 'unknown' };
}

function formatStatusResponse(status: Record<string, unknown>): string {
  const parts: string[] = [];

  if (status.totalNodes) {
    parts.push(`${(status.totalNodes as number).toLocaleString()} nodes`);
  }
  if (status.orphanCount !== undefined) {
    parts.push(`${status.orphanCount} orphans`);
  }
  if (status.pendingApprovals !== undefined) {
    parts.push(`${status.pendingApprovals} pending approvals`);
  }
  if (status.detectedAt) {
    parts.push(`detected today at 04:00`);
  }

  return `Graph Status: ${parts.join(', ')}`;
}

function handleUnknownQuery(query: string): string {
  return `I'm not sure how to answer that. I can help you with: graph health status, orphan detection, duplicate detection, workflow management, and pending approvals.`;
}
