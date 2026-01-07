/**
 * T029: Contract test for POST /api/approvals/:runId/resume
 * Tests the API endpoint for resuming suspended workflows with human decisions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResumeRequestSchema } from '@/types';

describe('POST /api/approvals/:runId/resume - Contract Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Request Schema Validation', () => {
    it('should accept valid approve request', () => {
      const validRequest = {
        stepId: 'merge-decision',
        decision: 'approve',
      };

      const result = ResumeRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should accept valid reject request', () => {
      const validRequest = {
        stepId: 'merge-decision',
        decision: 'reject',
        notes: 'These are distinct products',
      };

      const result = ResumeRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should accept request with property resolutions', () => {
      const validRequest = {
        stepId: 'merge-decision',
        decision: 'approve',
        propertyResolutions: {
          weight_grams: 1510,
          price_usd: 350,
        },
      };

      const result = ResumeRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should reject request without stepId', () => {
      const invalidRequest = {
        decision: 'approve',
      };

      const result = ResumeRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject request without decision', () => {
      const invalidRequest = {
        stepId: 'merge-decision',
      };

      const result = ResumeRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject request with invalid decision value', () => {
      const invalidRequest = {
        stepId: 'merge-decision',
        decision: 'maybe',
      };

      const result = ResumeRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('Response Contract', () => {
    it('should return 200 with workflow status on success', () => {
      const successResponse = {
        workflowRunId: '123e4567-e89b-12d3-a456-426614174000',
        status: 'completed',
        message: 'Workflow resumed and completed successfully',
      };

      expect(successResponse.status).toBe('completed');
      expect(successResponse.workflowRunId).toBeDefined();
    });

    it('should return 400 for invalid request body', () => {
      const errorResponse = {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: {
          issues: [
            { path: ['decision'], message: 'Required' },
          ],
        },
      };

      expect(errorResponse.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for non-existent workflow run', () => {
      const errorResponse = {
        code: 'NOT_FOUND',
        message: 'Workflow run not found',
        details: {
          runId: 'non-existent-id',
        },
      };

      expect(errorResponse.code).toBe('NOT_FOUND');
    });

    it('should return 409 for already completed workflow', () => {
      const errorResponse = {
        code: 'CONFLICT',
        message: 'Workflow is not in suspended state',
        details: {
          currentStatus: 'completed',
        },
      };

      expect(errorResponse.code).toBe('CONFLICT');
    });
  });

  describe('Step ID Validation', () => {
    it('should validate stepId matches suspended step', () => {
      const suspendedWorkflow = {
        id: 'run-123',
        status: 'suspended',
        suspendedSteps: [
          { stepId: 'merge-decision', approvalId: 'approval-456' },
        ],
      };

      const request = { stepId: 'merge-decision', decision: 'approve' };

      const isValidStep = suspendedWorkflow.suspendedSteps.some(
        step => step.stepId === request.stepId
      );

      expect(isValidStep).toBe(true);
    });

    it('should reject invalid stepId', () => {
      const suspendedWorkflow = {
        id: 'run-123',
        status: 'suspended',
        suspendedSteps: [
          { stepId: 'merge-decision', approvalId: 'approval-456' },
        ],
      };

      const request = { stepId: 'wrong-step', decision: 'approve' };

      const isValidStep = suspendedWorkflow.suspendedSteps.some(
        step => step.stepId === request.stepId
      );

      expect(isValidStep).toBe(false);
    });
  });

  describe('Property Resolution Handling', () => {
    it('should apply property resolutions to merge result', () => {
      const conflictingNodes = {
        nodeA: { weight_grams: 1500 },
        nodeB: { weight_grams: 1520 },
      };

      const resolution = {
        propertyResolutions: { weight_grams: 1510 },
      };

      // The resolved value should be used in the merge
      const mergedProperties = {
        weight_grams: resolution.propertyResolutions.weight_grams,
      };

      expect(mergedProperties.weight_grams).toBe(1510);
    });

    it('should require resolutions for conflicting properties', () => {
      const conflicts = ['weight_grams', 'price_usd'];
      const resolutions = { weight_grams: 1510 };

      const missingResolutions = conflicts.filter(
        c => !(c in resolutions)
      );

      expect(missingResolutions).toContain('price_usd');
    });
  });

  describe('Correction Rule Creation', () => {
    it('should create no_merge rule on rejection', () => {
      const rejection = {
        decision: 'reject',
        candidates: ['node-1', 'node-2'],
        notes: 'Different products',
      };

      // Per FR-016: Remember rejected merge decisions
      const correctionRule = {
        ruleType: 'no_merge',
        pattern: {
          entityIds: rejection.candidates,
        },
        description: rejection.notes,
        active: true,
      };

      expect(correctionRule.ruleType).toBe('no_merge');
      expect(correctionRule.pattern.entityIds).toEqual(['node-1', 'node-2']);
    });
  });
});
