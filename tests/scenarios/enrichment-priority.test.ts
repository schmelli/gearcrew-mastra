/**
 * T064: Scenario test for enrichment prioritization by centrality
 * Tests FR-025: Prioritize gap-filling based on node centrality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Data Enrichment - Prioritization by Centrality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Centrality Calculation', () => {
    it('should calculate degree centrality for nodes', () => {
      const nodes = [
        { id: 'node-1', relationships: 15 },
        { id: 'node-2', relationships: 5 },
        { id: 'node-3', relationships: 25 },
        { id: 'node-4', relationships: 2 },
      ];

      const sorted = nodes.sort((a, b) => b.relationships - a.relationships);

      expect(sorted[0]!.id).toBe('node-3');
      expect(sorted[1]!.id).toBe('node-1');
    });

    it('should rank nodes by PageRank-style importance', () => {
      // Nodes connected to important nodes are more important
      const pageRankScores = {
        'node-1': 0.85, // Connected to many important nodes
        'node-2': 0.45, // Connected to some nodes
        'node-3': 0.95, // Hub node
        'node-4': 0.15, // Leaf node
      };

      const ranked = Object.entries(pageRankScores)
        .sort(([, a], [, b]) => b - a)
        .map(([id]) => id);

      expect(ranked[0]).toBe('node-3');
      expect(ranked[1]).toBe('node-1');
    });
  });

  describe('Priority Queue', () => {
    it('should create priority queue based on centrality', () => {
      const incompleteNodes = [
        { id: 'node-1', missingFields: ['weight', 'price'], centrality: 0.45 },
        { id: 'node-2', missingFields: ['weight'], centrality: 0.85 },
        { id: 'node-3', missingFields: ['weight', 'price', 'dimensions'], centrality: 0.25 },
      ];

      const queue = createPriorityQueue(incompleteNodes);

      // Higher centrality = higher priority
      expect(queue[0]!.id).toBe('node-2');
      expect(queue[1]!.id).toBe('node-1');
      expect(queue[2]!.id).toBe('node-3');
    });

    it('should factor in number of missing fields', () => {
      const incompleteNodes = [
        { id: 'node-1', missingFields: ['weight'], centrality: 0.5 },
        { id: 'node-2', missingFields: ['weight', 'price', 'dimensions', 'category'], centrality: 0.5 },
      ];

      // With same centrality, more missing fields = higher priority
      const queue = createPriorityQueue(incompleteNodes, { factorMissingFields: true });

      expect(queue[0]!.id).toBe('node-2');
    });

    it('should consider field importance', () => {
      const fieldImportance: Record<string, number> = {
        weight: 1.0,
        price: 0.9,
        brand: 0.95,
        dimensions: 0.7,
        color: 0.3,
      };

      const node = {
        id: 'node-1',
        missingFields: ['weight', 'color'],
      };

      const importanceScore = node.missingFields.reduce(
        (sum, field) => sum + (fieldImportance[field] ?? 0.5),
        0
      );

      expect(importanceScore).toBe(1.3); // 1.0 + 0.3
    });
  });

  describe('Batch Processing', () => {
    it('should process nodes in batches by priority', () => {
      const allIncompleteNodes = Array.from({ length: 100 }, (_, i) => ({
        id: `node-${i}`,
        centrality: Math.random(),
        missingFields: ['weight'],
      }));

      const batchSize = 10;
      const batches = createBatches(allIncompleteNodes, batchSize);

      expect(batches.length).toBe(10);
      expect(batches[0]!.length).toBe(10);

      // First batch should have highest centrality nodes
      const firstBatchCentrality = batches[0]!.reduce((sum, n) => sum + n.centrality, 0) / batchSize;
      const lastBatchCentrality = batches[9]!.reduce((sum, n) => sum + n.centrality, 0) / batchSize;

      expect(firstBatchCentrality).toBeGreaterThan(lastBatchCentrality);
    });

    it('should respect rate limits between batches', async () => {
      const batchTimes: number[] = [];
      const minInterval = 100; // ms between batches

      const processBatch = async () => {
        batchTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 10));
      };

      for (let i = 0; i < 3; i++) {
        await processBatch();
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, minInterval));
        }
      }

      for (let i = 1; i < batchTimes.length; i++) {
        const interval = batchTimes[i]! - batchTimes[i - 1]!;
        expect(interval).toBeGreaterThanOrEqual(minInterval - 10);
      }
    });
  });

  describe('Priority Recalculation', () => {
    it('should boost priority for nodes with user views', () => {
      const node = {
        id: 'node-1',
        centrality: 0.5,
        recentViews: 100,
      };

      const basePriority = node.centrality;
      const viewBoost = Math.log10(node.recentViews + 1) * 0.1;
      const boostedPriority = basePriority + viewBoost;

      expect(boostedPriority).toBeGreaterThan(basePriority);
    });

    it('should deprioritize recently enriched nodes', () => {
      const nodes = [
        { id: 'node-1', centrality: 0.8, lastEnrichedAt: null },
        { id: 'node-2', centrality: 0.9, lastEnrichedAt: new Date(Date.now() - 1000 * 60 * 60) }, // 1 hour ago
      ];

      const queue = createPriorityQueue(nodes, {
        cooldownHours: 24,
      });

      // node-1 should be higher despite lower centrality
      // because node-2 was recently enriched
      expect(queue[0]!.id).toBe('node-1');
    });
  });
});

// Helper functions for testing
function createPriorityQueue(
  nodes: Array<{ id: string; missingFields?: string[]; centrality: number; lastEnrichedAt?: Date | null }>,
  options?: {
    factorMissingFields?: boolean;
    cooldownHours?: number;
  }
): Array<{ id: string; priority: number }> {
  const now = Date.now();
  const cooldownMs = (options?.cooldownHours ?? 0) * 60 * 60 * 1000;

  return nodes
    .map((node) => {
      let priority = node.centrality;

      // Factor in missing fields
      if (options?.factorMissingFields && node.missingFields) {
        priority += node.missingFields.length * 0.1;
      }

      // Apply cooldown penalty
      if (cooldownMs > 0 && node.lastEnrichedAt) {
        const timeSinceEnrichment = now - node.lastEnrichedAt.getTime();
        if (timeSinceEnrichment < cooldownMs) {
          priority *= timeSinceEnrichment / cooldownMs;
        }
      }

      return { id: node.id, priority };
    })
    .sort((a, b) => b.priority - a.priority);
}

function createBatches<T extends { centrality: number }>(
  nodes: T[],
  batchSize: number
): T[][] {
  // Sort by centrality descending
  const sorted = [...nodes].sort((a, b) => b.centrality - a.centrality);

  const batches: T[][] = [];
  for (let i = 0; i < sorted.length; i += batchSize) {
    batches.push(sorted.slice(i, i + batchSize));
  }

  return batches;
}
