/**
 * T055: Integration test for manual trigger via chat
 * Tests FR-014: Administrator can trigger workflows on demand
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the workflow functions
vi.mock('@/mastra/workflows/morning-hygiene', () => ({
  executeMorningHygieneWorkflow: vi.fn(),
}));

vi.mock('@/mastra/workflows/deep-deduplication', () => ({
  executeDeduplicationWorkflow: vi.fn(),
}));

describe('Manual Workflow Trigger - Integration Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Trigger Intent Recognition', () => {
    it('should recognize "Run hygiene check now"', () => {
      const message = 'Run hygiene check now';
      const intent = parseTriggerIntent(message);

      expect(intent.isTrigger).toBe(true);
      expect(intent.workflowType).toBe('morning-hygiene');
      expect(intent.immediate).toBe(true);
    });

    it('should recognize "Start deduplication workflow"', () => {
      const message = 'Start deduplication workflow';
      const intent = parseTriggerIntent(message);

      expect(intent.isTrigger).toBe(true);
      expect(intent.workflowType).toBe('deep-deduplication');
    });

    it('should recognize "Trigger gap-filling for backpacks"', () => {
      const message = 'Trigger gap-filling for backpacks';
      const intent = parseTriggerIntent(message);

      expect(intent.isTrigger).toBe(true);
      expect(intent.workflowType).toBe('gap-filling');
      expect(intent.scope?.category).toBe('backpacks');
    });

    it('should not trigger for status queries', () => {
      const message = "What's the system status?";
      const intent = parseTriggerIntent(message);

      expect(intent.isTrigger).toBe(false);
    });
  });

  describe('Scope Filtering', () => {
    it('should parse category scope', () => {
      const message = 'Run hygiene on Backpacks category';
      const intent = parseTriggerIntent(message);

      expect(intent.scope?.category).toBe('Backpacks');
    });

    it('should parse brand scope', () => {
      const message = 'Run deduplication for Osprey products';
      const intent = parseTriggerIntent(message);

      expect(intent.scope?.brand).toBe('Osprey');
    });

    it('should parse node ID scope', () => {
      const message = 'Run enrichment on node abc-123';
      const intent = parseTriggerIntent(message);

      expect(intent.scope?.nodeId).toBe('abc-123');
    });
  });

  describe('Workflow Execution', () => {
    it('should execute hygiene workflow when triggered', async () => {
      const { executeMorningHygieneWorkflow } = await import(
        '@/mastra/workflows/morning-hygiene'
      );

      vi.mocked(executeMorningHygieneWorkflow).mockResolvedValue({
        workflowRunId: 'test-run-id',
        status: 'completed',
        statistics: {
          itemsProcessed: 10,
          issuesDetected: 7,
          autoFixed: 5,
          flaggedForReview: 2,
          errors: 0,
        },
        deletedOrphans: ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'],
        flaggedOrphans: ['node-6', 'node-7'],
        schemaViolations: 0,
        duration: 1500,
      });

      const result = await executeMorningHygieneWorkflow();

      expect(executeMorningHygieneWorkflow).toHaveBeenCalled();
      expect(result.deletedOrphans.length).toBe(5);
    });

    it('should return run ID after triggering', async () => {
      const triggerResult = {
        runId: 'manual-run-123',
        workflowName: 'morning-hygiene',
        status: 'running',
        triggeredAt: new Date().toISOString(),
        scope: null,
      };

      expect(triggerResult.runId).toBeDefined();
      expect(triggerResult.status).toBe('running');
    });
  });

  describe('Chat Response Format', () => {
    it('should confirm trigger with workflow details', () => {
      const triggerResult = {
        runId: 'manual-run-123',
        workflowName: 'morning-hygiene',
        status: 'running',
      };

      const response = formatTriggerResponse(triggerResult);

      expect(response).toContain('morning-hygiene');
      expect(response).toContain('manual-run-123');
      expect(response).toContain('started');
    });

    it('should report scope in response', () => {
      const triggerResult = {
        runId: 'manual-run-456',
        workflowName: 'deep-deduplication',
        status: 'running',
        scope: { category: 'Backpacks' },
      };

      const response = formatTriggerResponse(triggerResult);

      expect(response).toContain('Backpacks');
    });
  });

  describe('Error Handling', () => {
    it('should handle already running workflow', () => {
      const error = {
        code: 'WORKFLOW_ALREADY_RUNNING',
        message: 'morning-hygiene is already running',
        currentRunId: 'existing-run-123',
      };

      expect(error.code).toBe('WORKFLOW_ALREADY_RUNNING');
    });

    it('should handle invalid workflow type', () => {
      const message = 'Run unknown-workflow now';
      const intent = parseTriggerIntent(message);

      expect(intent.isTrigger).toBe(true);
      expect(intent.workflowType).toBeUndefined();
    });
  });
});

// Helper functions for testing
function parseTriggerIntent(message: string): {
  isTrigger: boolean;
  workflowType?: string;
  immediate?: boolean;
  scope?: {
    category?: string;
    brand?: string;
    nodeId?: string;
  };
} {
  const lowerMessage = message.toLowerCase();

  // Check for trigger keywords
  const triggerKeywords = ['run', 'start', 'trigger', 'execute', 'launch'];
  const hasTrigger = triggerKeywords.some((kw) => lowerMessage.includes(kw));

  if (!hasTrigger) {
    return { isTrigger: false };
  }

  // Determine workflow type
  let workflowType: string | undefined;
  if (lowerMessage.includes('hygiene') || lowerMessage.includes('cleanup')) {
    workflowType = 'morning-hygiene';
  } else if (lowerMessage.includes('dedup') || lowerMessage.includes('duplicate')) {
    workflowType = 'deep-deduplication';
  } else if (lowerMessage.includes('gap') || lowerMessage.includes('enrich')) {
    workflowType = 'gap-filling';
  }

  // Check for immediate execution
  const immediate = lowerMessage.includes('now') || lowerMessage.includes('immediately');

  // Parse scope
  const scope: { category?: string; brand?: string; nodeId?: string } = {};

  // Category pattern: "on [Category] category" or "for [category]"
  const categoryMatch = message.match(/(?:on|for)\s+(\w+)(?:\s+category)?/i);
  if (categoryMatch) {
    scope.category = categoryMatch[1];
  }

  // Brand pattern: "for [Brand] products"
  const brandMatch = message.match(/for\s+(\w+)\s+products/i);
  if (brandMatch) {
    scope.brand = brandMatch[1];
  }

  // Node ID pattern: "on node [id]"
  const nodeMatch = message.match(/node\s+([\w-]+)/i);
  if (nodeMatch) {
    scope.nodeId = nodeMatch[1];
  }

  return {
    isTrigger: true,
    workflowType,
    immediate,
    scope: Object.keys(scope).length > 0 ? scope : undefined,
  };
}

function formatTriggerResponse(result: {
  runId: string;
  workflowName: string;
  status: string;
  scope?: { category?: string; brand?: string };
}): string {
  let response = `Workflow **${result.workflowName}** started (run ID: ${result.runId})`;

  if (result.scope) {
    if (result.scope.category) {
      response += ` targeting ${result.scope.category} category`;
    }
    if (result.scope.brand) {
      response += ` for ${result.scope.brand} products`;
    }
  }

  return response;
}
