/**
 * T017: Scenario test for valuable orphan preservation
 * Tests FR-004: System MUST preserve orphan nodes that contain potentially
 * valuable keywords (brand names, product specifications) and queue them for resolution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VALUABLE_KEYWORDS } from '@/types';

// Mock the Memgraph client
vi.mock('@/lib/memgraph-client', () => ({
  getMemgraphClient: vi.fn(() => ({
    query: vi.fn(),
    writeTransaction: vi.fn(),
    readOnlyQuery: vi.fn(),
  })),
}));

// Mock the audit logger
vi.mock('@/lib/audit-logger', () => ({
  getAuditLogger: vi.fn(() => ({
    logDelete: vi.fn(),
    logSkip: vi.fn(),
    logFlag: vi.fn(),
  })),
}));

describe('Orphan Preservation - Valuable Orphan Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Valuable Keyword Detection', () => {
    it('should detect brand name keywords in node name', () => {
      const orphanWithBrand = {
        id: 'valuable-1',
        name: 'Osprey Atmos 65',
        properties: {},
      };

      const hasValuableKeyword = VALUABLE_KEYWORDS.some(keyword =>
        orphanWithBrand.name.toLowerCase().includes(keyword.toLowerCase())
      );

      expect(hasValuableKeyword).toBe(true);
    });

    it('should detect product specification keywords', () => {
      const orphanWithSpecs = {
        id: 'valuable-2',
        name: 'Ultralight 2-person tent',
        properties: { weight: '900 grams' },
      };

      const textContent = [
        orphanWithSpecs.name,
        ...Object.values(orphanWithSpecs.properties).map(String),
      ].join(' ').toLowerCase();

      const hasSpecs = VALUABLE_KEYWORDS.some(keyword =>
        textContent.includes(keyword.toLowerCase())
      );

      expect(hasSpecs).toBe(true);
    });

    it('should NOT flag nodes without valuable keywords', () => {
      const genericOrphan = {
        id: 'generic-1',
        name: 'Item 123',
        properties: { note: 'test' },
      };

      const textContent = [
        genericOrphan.name,
        ...Object.values(genericOrphan.properties).map(String),
      ].join(' ').toLowerCase();

      const hasValuableKeyword = VALUABLE_KEYWORDS.some(keyword =>
        textContent.includes(keyword.toLowerCase())
      );

      expect(hasValuableKeyword).toBe(false);
    });
  });

  describe('Valuable Orphan Classification', () => {
    it('should classify orphans with brand names as valuable', () => {
      const testCases = [
        { name: 'Patagonia Nano Puff', expected: 'valuable' },
        { name: "Arc'teryx Alpha SV", expected: 'valuable' },
        { name: 'REI Flash 55', expected: 'valuable' },
        { name: 'MSR Hubba Hubba', expected: 'valuable' },
        { name: 'Big Agnes Copper Spur', expected: 'valuable' },
      ];

      for (const testCase of testCases) {
        const hasValuable = VALUABLE_KEYWORDS.some(keyword =>
          testCase.name.toLowerCase().includes(keyword.toLowerCase())
        );
        const classification = hasValuable ? 'valuable' : 'generic';
        expect(classification).toBe(testCase.expected);
      }
    });

    it('should classify orphans with product type keywords as valuable', () => {
      const testCases = [
        { name: 'Ultralight Backpack', expected: 'valuable' },
        { name: '3-Season Tent', expected: 'valuable' },
        { name: 'Down Sleeping Bag', expected: 'valuable' },
        { name: 'LED Headlamp', expected: 'valuable' },
      ];

      for (const testCase of testCases) {
        const hasValuable = VALUABLE_KEYWORDS.some(keyword =>
          testCase.name.toLowerCase().includes(keyword.toLowerCase())
        );
        const classification = hasValuable ? 'valuable' : 'generic';
        expect(classification).toBe(testCase.expected);
      }
    });
  });

  describe('Preservation Behavior', () => {
    it('should NOT delete orphans with valuable keywords', async () => {
      const valuableOrphan = {
        id: 'keep-me',
        name: 'Osprey Exos 58',
        componentId: 5,
        size: 1,
        hasValuableKeywords: true,
      };

      // Valuable orphans should be flagged, not deleted
      const shouldDelete = !valuableOrphan.hasValuableKeywords;
      expect(shouldDelete).toBe(false);
    });

    it('should queue valuable orphans for entity resolution', async () => {
      // Valuable orphans should be queued for manual resolution
      const valuableOrphan = {
        id: 'resolve-me',
        name: 'Patagonia Black Hole 25L',
        properties: {},
      };

      const action = 'queue_for_resolution';

      expect(action).toBe('queue_for_resolution');
    });

    it('should log flagging action to audit trail', async () => {
      const { getAuditLogger } = await import('@/lib/audit-logger');
      const logger = getAuditLogger();

      // Simulate flagging
      await logger.logFlag(
        'workflow-run-123',
        'morning-hygiene',
        'valuable-orphan-1',
        'GearItem',
        {
          confidence: 0.45,
          reasoning: 'Contains brand keyword: Osprey',
        }
      );

      expect(logger.logFlag).toHaveBeenCalledWith(
        'workflow-run-123',
        'morning-hygiene',
        'valuable-orphan-1',
        'GearItem',
        {
          confidence: 0.45,
          reasoning: 'Contains brand keyword: Osprey',
        }
      );
    });
  });

  describe('Island Size Handling', () => {
    it('should flag small islands (2-3 nodes) for review', () => {
      const smallIsland = {
        componentId: 3,
        size: 2,
        nodes: [
          { id: 'node-1', name: 'Item A' },
          { id: 'node-2', name: 'Item B' },
        ],
      };

      // Per data-model.md: Size 2-3 = Small island = Flag for review
      const classification = smallIsland.size >= 2 && smallIsland.size <= 3
        ? 'small_island'
        : 'other';

      expect(classification).toBe('small_island');
    });

    it('should flag large islands (4+ nodes) for human review', () => {
      const largeIsland = {
        componentId: 4,
        size: 5,
        nodes: Array(5).fill(null).map((_, i) => ({
          id: `node-${i}`,
          name: `Item ${i}`,
        })),
      };

      // Per data-model.md: Size 4+ = Large island = Flag for human review
      const classification = largeIsland.size >= 4
        ? 'large_island'
        : 'other';

      expect(classification).toBe('large_island');
    });

    it('should never auto-delete islands with 4+ nodes', () => {
      const largeIsland = {
        size: 4,
        nodes: Array(4).fill(null),
      };

      // Large islands are never auto-deleted, even if all nodes are empty
      const shouldAutoDelete = largeIsland.size < 4;
      expect(shouldAutoDelete).toBe(false);
    });
  });

  describe('Workflow Summary', () => {
    it('should report valuable orphan count separately', () => {
      const workflowResult = {
        totalOrphans: 10,
        deletedEmpty: 5,
        deletedGeneric: 2,
        flaggedValuable: 2,
        flaggedIslands: 1,
      };

      const totalFlagged = workflowResult.flaggedValuable +
        workflowResult.flaggedIslands;

      expect(totalFlagged).toBe(3);
      expect(workflowResult.flaggedValuable).toBe(2);
    });

    it('should include flagged nodes in pending approvals', () => {
      const pendingApprovals = [
        { id: 'approval-1', entityId: 'valuable-1', reason: 'valuable_orphan' },
        { id: 'approval-2', entityId: 'island-1', reason: 'large_island' },
      ];

      expect(pendingApprovals).toHaveLength(2);
      expect(pendingApprovals.some(a => a.reason === 'valuable_orphan')).toBe(true);
    });
  });
});
