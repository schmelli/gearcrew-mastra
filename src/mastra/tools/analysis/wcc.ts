/**
 * T019: WCC (Weakly Connected Components) Graph Algorithm Tool
 * Detects disconnected orphan components using Memgraph MAGE
 * Implements FR-002: Detect disconnected nodes using graph connectivity analysis
 */

import { getMemgraphClient } from '@/lib/memgraph-client';
import { OrphanClassification } from '@/types';

export interface NodeInfo {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  labels: string[];
}

export interface Component {
  componentId: number;
  size: number;
  nodes: NodeInfo[];
  sampleNames: string[];
  classification?: OrphanClassification;
}

export interface WccResult {
  components: Component[];
  mainComponentId: number;
  orphanComponents: Component[];
  totalNodes: number;
  orphanCount: number;
}

/**
 * Detect orphan components using Weakly Connected Components algorithm
 * Per research.md: Uses MAGE weakly_connected_components.get()
 */
export async function detectOrphanComponents(): Promise<WccResult> {
  const client = getMemgraphClient();

  // Run WCC algorithm to get all components
  // Use coalesce to handle nodes without explicit id property
  const query = `
    CALL weakly_connected_components.get()
    YIELD node, component_id
    WITH node, component_id
    RETURN
      coalesce(node.id, toString(id(node))) AS nodeId,
      node.name AS nodeName,
      labels(node) AS labels,
      properties(node) AS properties,
      component_id
    ORDER BY component_id, node.name
  `;

  const results = await client.readOnlyQuery<{
    nodeId: string;
    nodeName: string;
    labels: string[];
    properties: Record<string, unknown>;
    component_id: number;
  }>(query);

  // Group nodes by component
  const componentMap = new Map<number, NodeInfo[]>();

  for (const row of results) {
    // Skip nodes without valid IDs
    if (!row.nodeId) {
      console.warn('Skipping node without ID in WCC analysis');
      continue;
    }

    const componentId = row.component_id;
    if (!componentMap.has(componentId)) {
      componentMap.set(componentId, []);
    }
    componentMap.get(componentId)!.push({
      id: row.nodeId,
      name: row.nodeName ?? '',
      properties: row.properties ?? {},
      labels: row.labels ?? [],
    });
  }

  // Build component list
  const components: Component[] = [];
  let mainComponentId = 0;
  let maxSize = 0;

  for (const [componentId, nodes] of componentMap) {
    const component: Component = {
      componentId,
      size: nodes.length,
      nodes,
      sampleNames: nodes.slice(0, 5).map((n) => n.name).filter(Boolean),
    };

    components.push(component);

    // Track largest component (main graph)
    if (nodes.length > maxSize) {
      maxSize = nodes.length;
      mainComponentId = componentId;
    }
  }

  // Identify orphan components (not the main graph)
  const orphanComponents = components.filter((c) => c.componentId !== mainComponentId);

  // Classify orphan components
  for (const component of orphanComponents) {
    component.classification = classifyComponent(component);
  }

  return {
    components,
    mainComponentId,
    orphanComponents,
    totalNodes: results.length,
    orphanCount: orphanComponents.reduce((sum, c) => sum + c.size, 0),
  };
}

/**
 * Classify a component based on size and content
 * Per data-model.md orphan classification rules
 */
function classifyComponent(component: Component): OrphanClassification {
  if (component.size >= 4) {
    return 'large_island';
  }

  if (component.size >= 2) {
    return 'small_island';
  }

  // Size = 1: Check content
  const node = component.nodes[0];
  if (!node) {
    return 'empty';
  }

  // Check if empty (no name, no meaningful properties)
  const hasName = node.name && node.name.trim() !== '';
  const hasProperties = Object.keys(node.properties).length > 0;

  if (!hasName && !hasProperties) {
    return 'empty';
  }

  // Check for generic content
  if (isGenericContent(node)) {
    return 'generic';
  }

  // Check for valuable keywords
  if (hasValuableKeywords(node)) {
    return 'valuable';
  }

  return 'generic';
}

/**
 * Check if node content is generic (not worth preserving)
 */
function isGenericContent(node: NodeInfo): boolean {
  const genericTerms = [
    'item',
    'unknown',
    'other',
    'misc',
    'general',
    'test',
    'temp',
    'undefined',
    'null',
    'n/a',
  ];

  const textContent = [
    node.name.toLowerCase(),
    ...Object.values(node.properties).map((v) => String(v).toLowerCase()),
  ].join(' ');

  // Check if content is mostly generic terms
  const words = textContent.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const genericWordCount = words.filter((word) =>
    genericTerms.some((term) => word.includes(term))
  ).length;

  return genericWordCount / words.length > 0.5;
}

/**
 * Check if node contains valuable keywords
 * Per data-model.md VALUABLE_KEYWORDS list
 */
function hasValuableKeywords(node: NodeInfo): boolean {
  const valuableKeywords = [
    // Brand names
    'osprey', 'patagonia', 'arc\'teryx', 'arcteryx', 'rei', 'msr',
    'big agnes', 'nemo', 'thermarest', 'jetboil', 'black diamond', 'petzl',
    'gregory', 'deuter', 'kelty', 'mountainsmith', 'gossamer gear',
    // Product types
    'backpack', 'tent', 'sleeping bag', 'sleeping pad', 'stove',
    'headlamp', 'trekking poles', 'water filter', 'bear canister',
    // Specifications
    'grams', 'liters', 'denier', 'waterproof', 'ultralight', 'down',
    'synthetic', 'carbon fiber', 'titanium', 'cuben fiber', 'dyneema',
  ];

  const textContent = [
    node.name.toLowerCase(),
    ...Object.values(node.properties).map((v) => String(v).toLowerCase()),
  ].join(' ');

  return valuableKeywords.some((keyword) => textContent.includes(keyword));
}

/**
 * Get orphan nodes ready for deletion (empty/generic, size=1)
 */
export async function getOrphansForDeletion(): Promise<NodeInfo[]> {
  const result = await detectOrphanComponents();

  return result.orphanComponents
    .filter((c) => c.size === 1 && (c.classification === 'empty' || c.classification === 'generic'))
    .flatMap((c) => c.nodes);
}

/**
 * Get valuable orphans for review queue
 */
export async function getValuableOrphans(): Promise<Component[]> {
  const result = await detectOrphanComponents();

  return result.orphanComponents.filter(
    (c) => c.classification === 'valuable' || c.classification === 'small_island' || c.classification === 'large_island'
  );
}

export default {
  detectOrphanComponents,
  getOrphansForDeletion,
  getValuableOrphans,
};
