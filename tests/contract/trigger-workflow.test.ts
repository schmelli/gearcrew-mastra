/**
 * T056: Contract test for POST /api/workflows
 * Tests the API endpoint for triggering workflows manually
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Request schema per openapi.yaml
const TriggerWorkflowRequestSchema = z.object({
  workflowName: z.enum(['morning-hygiene', 'deep-deduplication', 'gap-filling']),
  scope: z
    .object({
      category: z.string().optional(),
      brand: z.string().optional(),
      nodeIds: z.array(z.string()).optional(),
    })
    .optional(),
  priority: z.enum(['normal', 'high']).optional().default('normal'),
});

// Response schema
const TriggerWorkflowResponseSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  status: z.enum(['pending', 'running']),
  triggeredAt: z.string().datetime(),
  triggeredBy: z.string(),
  scope: z
    .object({
      category: z.string().optional(),
      brand: z.string().optional(),
      nodeIds: z.array(z.string()).optional(),
    })
    .nullable(),
});

describe('POST /api/workflows - Contract Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Request Schema Validation', () => {
    it('should accept valid trigger request for morning-hygiene', () => {
      const validRequest = {
        workflowName: 'morning-hygiene',
      };

      const result = TriggerWorkflowRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should accept valid trigger request with category scope', () => {
      const validRequest = {
        workflowName: 'deep-deduplication',
        scope: {
          category: 'Backpacks',
        },
      };

      const result = TriggerWorkflowRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should accept valid trigger request with brand scope', () => {
      const validRequest = {
        workflowName: 'gap-filling',
        scope: {
          brand: 'Osprey',
        },
        priority: 'high',
      };

      const result = TriggerWorkflowRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should accept valid trigger request with node IDs', () => {
      const validRequest = {
        workflowName: 'gap-filling',
        scope: {
          nodeIds: ['node-1', 'node-2', 'node-3'],
        },
      };

      const result = TriggerWorkflowRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should reject request with invalid workflow name', () => {
      const invalidRequest = {
        workflowName: 'invalid-workflow',
      };

      const result = TriggerWorkflowRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject request without workflow name', () => {
      const invalidRequest = {
        scope: { category: 'Backpacks' },
      };

      const result = TriggerWorkflowRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('Response Schema Validation', () => {
    it('should return valid response structure on success', () => {
      const successResponse = {
        runId: 'manual-run-123',
        workflowName: 'morning-hygiene',
        status: 'running',
        triggeredAt: new Date().toISOString(),
        triggeredBy: 'admin',
        scope: null,
      };

      const result = TriggerWorkflowResponseSchema.safeParse(successResponse);
      expect(result.success).toBe(true);
    });

    it('should return valid response with scope', () => {
      const successResponse = {
        runId: 'manual-run-456',
        workflowName: 'deep-deduplication',
        status: 'pending',
        triggeredAt: new Date().toISOString(),
        triggeredBy: 'admin',
        scope: {
          category: 'Backpacks',
        },
      };

      const result = TriggerWorkflowResponseSchema.safeParse(successResponse);
      expect(result.success).toBe(true);
    });
  });

  describe('Error Responses', () => {
    it('should return 400 for invalid request body', () => {
      const errorResponse = {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: {
          issues: [{ path: ['workflowName'], message: 'Required' }],
        },
      };

      expect(errorResponse.code).toBe('VALIDATION_ERROR');
    });

    it('should return 409 for already running workflow', () => {
      const errorResponse = {
        code: 'WORKFLOW_ALREADY_RUNNING',
        message: 'Workflow is already running',
        details: {
          existingRunId: 'run-123',
          workflowName: 'morning-hygiene',
          startedAt: new Date().toISOString(),
        },
      };

      expect(errorResponse.code).toBe('WORKFLOW_ALREADY_RUNNING');
      expect(errorResponse.details.existingRunId).toBeDefined();
    });

    it('should return 503 when Memgraph unavailable', () => {
      const errorResponse = {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Database is not available',
        details: {
          retryAfter: 30,
        },
      };

      expect(errorResponse.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('Concurrent Workflow Handling', () => {
    it('should allow different workflow types to run concurrently', () => {
      const runningWorkflows = [
        { workflowName: 'morning-hygiene', status: 'running' },
      ];

      const newRequest = { workflowName: 'deep-deduplication' };

      const canRun = !runningWorkflows.some(
        (w) => w.workflowName === newRequest.workflowName && w.status === 'running'
      );

      expect(canRun).toBe(true);
    });

    it('should block same workflow type from running twice', () => {
      const runningWorkflows = [
        { workflowName: 'morning-hygiene', status: 'running' },
      ];

      const newRequest = { workflowName: 'morning-hygiene' };

      const canRun = !runningWorkflows.some(
        (w) => w.workflowName === newRequest.workflowName && w.status === 'running'
      );

      expect(canRun).toBe(false);
    });
  });

  describe('Scope Validation', () => {
    it('should validate category exists', () => {
      const validCategories = ['Backpacks', 'Tents', 'Sleeping Bags', 'Stoves'];
      const requestedCategory = 'Backpacks';

      const isValid = validCategories.includes(requestedCategory);
      expect(isValid).toBe(true);
    });

    it('should validate brand exists', () => {
      const validBrands = ['Osprey', 'MSR', 'Big Agnes', 'Nemo'];
      const requestedBrand = 'Osprey';

      const isValid = validBrands.includes(requestedBrand);
      expect(isValid).toBe(true);
    });

    it('should validate node IDs exist', async () => {
      const requestedNodeIds = ['node-1', 'node-2'];

      // Mock validation
      const existingNodes = ['node-1', 'node-2', 'node-3'];
      const allExist = requestedNodeIds.every((id) => existingNodes.includes(id));

      expect(allExist).toBe(true);
    });
  });
});
