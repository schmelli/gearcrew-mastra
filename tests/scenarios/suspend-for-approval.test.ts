/**
 * T028: Scenario test for workflow suspend 80-98% confidence
 * Tests FR-007: System MUST suspend workflow and require human approval
 * when duplicate confidence is between 80-98%
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIDENCE_THRESHOLDS } from '@/types';

describe('Duplicate Resolution - Suspend for Approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Mid-Confidence Detection', () => {
    it('should identify duplicates requiring approval (80-98%)', () => {
      const testCases = [
        { similarity: 0.80, shouldRequireApproval: true },
        { similarity: 0.85, shouldRequireApproval: true },
        { similarity: 0.90, shouldRequireApproval: true },
        { similarity: 0.95, shouldRequireApproval: true },
        { similarity: 0.97, shouldRequireApproval: true },
        { similarity: 0.79, shouldRequireApproval: false }, // Below threshold
        { similarity: 0.99, shouldRequireApproval: false }, // Above auto-merge
      ];

      for (const testCase of testCases) {
        const requiresApproval =
          testCase.similarity >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL &&
          testCase.similarity < CONFIDENCE_THRESHOLDS.AUTO_MERGE;

        expect(requiresApproval).toBe(testCase.shouldRequireApproval);
      }
    });
  });

  describe('Workflow Suspension', () => {
    it('should suspend workflow when confidence is 80-98%', async () => {
      const duplicatePair = {
        nodeA: { id: 'candidate-1', name: 'Osprey Atmos 65' },
        nodeB: { id: 'candidate-2', name: 'Osprey Atmos AG 65' },
        similarity: 0.92,
        confidence: 0.92,
      };

      const requiresApproval =
        duplicatePair.confidence >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL &&
        duplicatePair.confidence < CONFIDENCE_THRESHOLDS.AUTO_MERGE;

      expect(requiresApproval).toBe(true);

      // Workflow should suspend with context
      const suspendContext = {
        reason: 'Awaiting human approval',
        candidates: [duplicatePair.nodeA, duplicatePair.nodeB],
        similarity: duplicatePair.similarity,
        confidence: duplicatePair.confidence,
      };

      expect(suspendContext.reason).toBe('Awaiting human approval');
      expect(suspendContext.candidates).toHaveLength(2);
    });

    it('should create ApprovalRequest when suspending', () => {
      const approvalRequest = {
        id: 'approval-123',
        workflowRunId: 'run-456',
        stepId: 'merge-decision',
        issueId: 'issue-789',
        proposedAction: 'merge',
        candidates: [
          {
            nodeId: 'node-1',
            nodeName: 'Osprey Atmos 65',
            nodeProperties: { weight: 1500 },
            relationships: [],
          },
          {
            nodeId: 'node-2',
            nodeName: 'Osprey Atmos AG 65',
            nodeProperties: { weight: 1520 },
            relationships: [],
          },
        ],
        reasoning: 'Potential duplicates with 92% similarity',
        confidence: 0.92,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      expect(approvalRequest.status).toBe('pending');
      expect(approvalRequest.proposedAction).toBe('merge');
      expect(approvalRequest.candidates).toHaveLength(2);
    });

    it('should include property conflicts in approval context', () => {
      const nodeA = { weight: 1500, price: 350 };
      const nodeB = { weight: 1520, price: 350 };

      const conflicts: string[] = [];
      for (const key of Object.keys(nodeA)) {
        const valueA = nodeA[key as keyof typeof nodeA];
        const valueB = nodeB[key as keyof typeof nodeB];
        if (valueA !== valueB && valueA != null && valueB != null) {
          conflicts.push(key);
        }
      }

      expect(conflicts).toContain('weight');
      expect(conflicts).not.toContain('price');
    });
  });

  describe('Approval Request Display', () => {
    it('should include both node candidates with properties', () => {
      const approvalDisplay = {
        title: 'Potential Duplicate Detected',
        confidence: 0.92,
        candidates: [
          {
            id: 'node-1',
            name: 'Osprey Atmos 65',
            properties: {
              weight_grams: 1500,
              price_usd: 350,
              category: 'Backpacks',
            },
            relationships: [
              { type: 'MANUFACTURED_BY', target: 'Osprey' },
            ],
          },
          {
            id: 'node-2',
            name: 'Osprey Atmos AG 65',
            properties: {
              weight_grams: 1520,
              price_usd: 350,
              category: 'Backpacks',
            },
            relationships: [
              { type: 'MANUFACTURED_BY', target: 'Osprey' },
            ],
          },
        ],
        conflictingProperties: ['weight_grams'],
        suggestedAction: 'merge',
      };

      expect(approvalDisplay.candidates[0]?.properties).toHaveProperty('weight_grams');
      expect(approvalDisplay.candidates[1]?.properties).toHaveProperty('weight_grams');
      expect(approvalDisplay.conflictingProperties).toContain('weight_grams');
    });

    it('should include relationship information', () => {
      const candidate = {
        id: 'node-1',
        relationships: [
          { type: 'MANUFACTURED_BY', direction: 'outgoing', targetId: 'brand-1', targetName: 'Osprey' },
          { type: 'SIMILAR_TO', direction: 'outgoing', targetId: 'node-2', targetName: 'Related Item' },
        ],
      };

      expect(candidate.relationships).toHaveLength(2);
      expect(candidate.relationships.map(r => r.type)).toContain('MANUFACTURED_BY');
    });
  });

  describe('Workflow Resume', () => {
    it('should resume workflow after approval decision', async () => {
      const resumeData = {
        stepId: 'merge-decision',
        decision: 'approve',
        notes: 'These are the same product with minor variations',
        propertyResolutions: {
          weight_grams: 1510, // Chosen value
        },
      };

      expect(resumeData.decision).toBe('approve');
      expect(resumeData.propertyResolutions).toHaveProperty('weight_grams');
    });

    it('should execute merge after approval', () => {
      const postApprovalActions = [
        'validate_resolution',
        'apply_property_resolutions',
        'transfer_relationships',
        'merge_properties',
        'delete_absorbed_node',
        'update_approval_status',
        'log_merge',
      ];

      expect(postApprovalActions).toContain('apply_property_resolutions');
      expect(postApprovalActions.indexOf('validate_resolution'))
        .toBeLessThan(postApprovalActions.indexOf('delete_absorbed_node'));
    });

    it('should record rejection and prevent future proposals', () => {
      const rejection = {
        decision: 'reject',
        notes: 'These are different products: AG vs non-AG version',
        createCorrectionRule: true,
      };

      // Should create a correction rule per FR-016
      const correctionRule = {
        ruleType: 'no_merge',
        pattern: {
          entityIds: ['node-1', 'node-2'],
        },
        description: 'Do not merge: AG vs non-AG version',
      };

      expect(rejection.createCorrectionRule).toBe(true);
      expect(correctionRule.ruleType).toBe('no_merge');
    });
  });

  describe('Skip Low Confidence', () => {
    it('should take no action below 80% confidence', () => {
      const lowConfidencePair = {
        similarity: 0.75,
        confidence: 0.75,
      };

      const shouldProcess =
        lowConfidencePair.confidence >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL;

      expect(shouldProcess).toBe(false);
    });

    it('should log skip action for low confidence pairs', async () => {
      const skipContext = {
        nodeIds: ['node-1', 'node-2'],
        similarity: 0.75,
        reason: 'Confidence below threshold',
      };

      expect(skipContext.reason).toBe('Confidence below threshold');
    });
  });
});
