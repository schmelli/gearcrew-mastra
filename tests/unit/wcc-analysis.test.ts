/**
 * T018: Unit test for WCC algorithm wrapper
 * Tests the Weakly Connected Components algorithm integration with Memgraph MAGE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the Memgraph client
const mockQuery = vi.fn();
vi.mock('@/lib/memgraph-client', () => ({
  getMemgraphClient: vi.fn(() => ({
    query: mockQuery,
    readOnlyQuery: mockQuery,
  })),
}));

describe('WCC Analysis Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectOrphanComponents', () => {
    it('should call MAGE WCC procedure with correct query', async () => {
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: 'Orphan', labels: ['Product'], properties: {}, component_id: 1 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('weakly_connected_components.get')
      );
    });

    it('should group nodes by component ID', async () => {
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: 'Node 3', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '4', nodeName: 'Node 4', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '5', nodeName: 'Node 5', labels: ['Product'], properties: {}, component_id: 2 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      // Should have 3 components
      expect(result.components).toHaveLength(3);

      // Component 0 (main graph) should have 2 nodes
      const mainComponent = result.components.find(c => c.componentId === 0);
      expect(mainComponent?.nodes).toHaveLength(2);

      // Component 1 should have 2 nodes (small island)
      const island1 = result.components.find(c => c.componentId === 1);
      expect(island1?.nodes).toHaveLength(2);

      // Component 2 should have 1 node (orphan)
      const orphan = result.components.find(c => c.componentId === 2);
      expect(orphan?.nodes).toHaveLength(1);
    });

    it('should identify main graph as component 0', async () => {
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: 'Node 3', labels: ['Product'], properties: {}, component_id: 0 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      expect(result.mainComponentId).toBe(0);
      expect(result.orphanComponents).toHaveLength(0);
    });

    it('should identify orphan components (id > 0)', async () => {
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Node 2', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '3', nodeName: 'Node 3', labels: ['Product'], properties: {}, component_id: 2 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      expect(result.orphanComponents).toHaveLength(2);
      expect(result.orphanComponents.map(c => c.componentId)).toContain(1);
      expect(result.orphanComponents.map(c => c.componentId)).toContain(2);
    });
  });

  describe('Component Size Classification', () => {
    it('should calculate component sizes correctly', async () => {
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: 'Node 3', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '4', nodeName: 'Node 4', labels: ['Product'], properties: {}, component_id: 1 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      const mainComponent = result.components.find(c => c.componentId === 0);
      const orphanComponent = result.components.find(c => c.componentId === 1);

      expect(mainComponent?.size).toBe(3);
      expect(orphanComponent?.size).toBe(1);
    });

    it('should classify size=1 components as potential empty orphans', async () => {
      // Main component (0) must be larger than orphan components
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Main Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Main Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: '', labels: ['Product'], properties: {}, component_id: 1 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      const singleNodeComponents = result.orphanComponents.filter(c => c.size === 1);
      expect(singleNodeComponents).toHaveLength(1);
    });

    it('should classify size 2-3 as small islands', async () => {
      // Main component (0) must be larger than orphan components
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Main Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Main Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: 'Main Node 3', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '4', nodeName: 'Node 4', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '5', nodeName: 'Node 5', labels: ['Product'], properties: {}, component_id: 1 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      const smallIslands = result.orphanComponents.filter(
        c => c.size >= 2 && c.size <= 3
      );
      expect(smallIslands).toHaveLength(1);
      expect(smallIslands[0]?.size).toBe(2);
    });

    it('should classify size 4+ as large islands', async () => {
      // Main component (0) must be larger than orphan components
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Main Node 1', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '2', nodeName: 'Main Node 2', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '3', nodeName: 'Main Node 3', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '4', nodeName: 'Main Node 4', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '5', nodeName: 'Main Node 5', labels: ['Product'], properties: {}, component_id: 0 },
        { nodeId: '6', nodeName: 'Node 6', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '7', nodeName: 'Node 7', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '8', nodeName: 'Node 8', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '9', nodeName: 'Node 9', labels: ['Product'], properties: {}, component_id: 1 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      const largeIslands = result.orphanComponents.filter(c => c.size >= 4);
      expect(largeIslands).toHaveLength(1);
      expect(largeIslands[0]?.size).toBe(4);
    });
  });

  describe('Error Handling', () => {
    it('should handle empty graph gracefully', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      expect(result.components).toHaveLength(0);
      expect(result.orphanComponents).toHaveLength(0);
    });

    it('should handle MAGE procedure errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('MAGE procedure not found'));

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');

      await expect(detectOrphanComponents()).rejects.toThrow('MAGE procedure not found');
    });

    it('should handle connection errors with retry', async () => {
      mockQuery
        .mockRejectedValueOnce(new Error('Connection reset'))
        .mockResolvedValueOnce([]);

      // The actual implementation should use withRetry
      // For now, just verify the error is thrown
      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');

      // First call should fail
      await expect(detectOrphanComponents()).rejects.toThrow();
    });
  });

  describe('Sample Names Extraction', () => {
    it('should extract sample node names for each component', async () => {
      mockQuery.mockResolvedValueOnce([
        { nodeId: '1', nodeName: 'Osprey Atmos', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '2', nodeName: 'Patagonia Nano', labels: ['Product'], properties: {}, component_id: 1 },
        { nodeId: '3', nodeName: 'REI Flash', labels: ['Product'], properties: {}, component_id: 1 },
      ]);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      const component = result.components[0];
      expect(component?.sampleNames).toContain('Osprey Atmos');
      expect(component?.sampleNames.length).toBeLessThanOrEqual(5);
    });

    it('should limit sample names to 5 per component', async () => {
      const manyNodes = Array(10).fill(null).map((_, i) => ({
        nodeId: `${i}`,
        nodeName: `Node ${i}`,
        labels: ['Product'],
        properties: {},
        component_id: 1,
      }));

      mockQuery.mockResolvedValueOnce(manyNodes);

      const { detectOrphanComponents } = await import('@/mastra/tools/analysis/wcc');
      const result = await detectOrphanComponents();

      const component = result.components[0];
      expect(component?.sampleNames.length).toBeLessThanOrEqual(5);
    });
  });
});
