/**
 * T020: Orphan Classification Tool
 * Classifies orphan nodes as empty/generic/valuable per data-model.md
 * Implements FR-003 (auto-delete empty) and FR-004 (preserve valuable)
 */

import { OrphanClassification, OrphanNode, VALUABLE_KEYWORDS } from '@/types';
import { Component, NodeInfo } from './wcc';

export interface ClassificationResult {
  nodeId: string;
  classification: OrphanClassification;
  hasValuableKeywords: boolean;
  confidence: number;
  reasoning: string;
  detectedKeywords: string[];
}

/**
 * Generic terms that indicate non-valuable content
 */
const GENERIC_TERMS = [
  'item',
  'unknown',
  'other',
  'misc',
  'miscellaneous',
  'general',
  'test',
  'temp',
  'temporary',
  'undefined',
  'null',
  'n/a',
  'na',
  'none',
  'tbd',
  'placeholder',
  'sample',
  'example',
  'default',
];

/**
 * Classify a single orphan node
 */
export function classifyOrphanNode(
  node: NodeInfo,
  componentSize: number
): ClassificationResult {
  // Handle island sizes first
  if (componentSize >= 4) {
    return {
      nodeId: node.id,
      classification: 'large_island',
      hasValuableKeywords: false,
      confidence: 0.95,
      reasoning: `Component has ${componentSize} nodes, flagged as large island for human review`,
      detectedKeywords: [],
    };
  }

  if (componentSize >= 2) {
    return {
      nodeId: node.id,
      classification: 'small_island',
      hasValuableKeywords: false,
      confidence: 0.90,
      reasoning: `Component has ${componentSize} nodes, flagged as small island for review`,
      detectedKeywords: [],
    };
  }

  // Size = 1: Analyze content
  const textContent = extractTextContent(node);
  const detectedKeywords = findValuableKeywords(textContent);
  const hasValuable = detectedKeywords.length > 0;

  // Check for empty content
  if (isEmptyNode(node)) {
    return {
      nodeId: node.id,
      classification: 'empty',
      hasValuableKeywords: false,
      confidence: 0.99,
      reasoning: 'Node has no name and no meaningful properties',
      detectedKeywords: [],
    };
  }

  // Check for valuable keywords
  if (hasValuable) {
    return {
      nodeId: node.id,
      classification: 'valuable',
      hasValuableKeywords: true,
      confidence: Math.min(0.45 + (detectedKeywords.length * 0.1), 1.0),
      reasoning: `Contains valuable keywords: ${detectedKeywords.join(', ')}`,
      detectedKeywords,
    };
  }

  // Check for generic content
  const genericScore = calculateGenericScore(textContent);
  if (genericScore > 0.5) {
    return {
      nodeId: node.id,
      classification: 'generic',
      hasValuableKeywords: false,
      confidence: Math.min(0.85 + (genericScore * 0.1), 1.0),
      reasoning: `Content appears generic (score: ${(genericScore * 100).toFixed(0)}%)`,
      detectedKeywords: [],
    };
  }

  // Default to valuable if content exists but isn't clearly generic
  return {
    nodeId: node.id,
    classification: 'valuable',
    hasValuableKeywords: false,
    confidence: 0.60,
    reasoning: 'Node has non-generic content that may be valuable',
    detectedKeywords: [],
  };
}

/**
 * Classify all nodes in a component
 */
export function classifyComponent(component: Component): ClassificationResult[] {
  return component.nodes.map((node) =>
    classifyOrphanNode(node, component.size)
  );
}

/**
 * Batch classify orphan nodes
 */
export function classifyOrphans(
  nodes: Array<{ node: NodeInfo; componentSize: number }>
): ClassificationResult[] {
  return nodes.map(({ node, componentSize }) =>
    classifyOrphanNode(node, componentSize)
  );
}

/**
 * Extract all text content from a node for analysis
 */
function extractTextContent(node: NodeInfo): string {
  const parts: string[] = [];

  if (node.name) {
    parts.push(node.name);
  }

  for (const value of Object.values(node.properties)) {
    if (value !== null && value !== undefined) {
      parts.push(String(value));
    }
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Check if node is effectively empty
 */
function isEmptyNode(node: NodeInfo): boolean {
  const hasName = node.name && node.name.trim() !== '';

  // Filter out metadata properties
  const metadataProps = ['id', 'created_at', 'updated_at', 'embedding_vector'];
  const meaningfulProps = Object.entries(node.properties).filter(
    ([key, value]) =>
      !metadataProps.includes(key) &&
      value !== null &&
      value !== undefined &&
      String(value).trim() !== ''
  );

  return !hasName && meaningfulProps.length === 0;
}

/**
 * Find valuable keywords in text content
 */
function findValuableKeywords(textContent: string): string[] {
  const found: string[] = [];
  const lowerContent = textContent.toLowerCase();

  for (const keyword of VALUABLE_KEYWORDS) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      found.push(keyword);
    }
  }

  return found;
}

/**
 * Calculate how "generic" the content is (0-1 score)
 */
function calculateGenericScore(textContent: string): number {
  if (!textContent.trim()) {
    return 1.0; // Empty content is fully generic
  }

  const words = textContent.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return 1.0;
  }

  // Count generic words
  let genericCount = 0;
  for (const word of words) {
    if (GENERIC_TERMS.some((term) => word.includes(term))) {
      genericCount++;
    }
  }

  // Also check for number-only content (e.g., "Item 123")
  const numberOnlyWords = words.filter((w) => /^\d+$/.test(w)).length;
  const effectiveGenericCount = genericCount + numberOnlyWords * 0.5;

  return Math.min(effectiveGenericCount / words.length, 1.0);
}

/**
 * Get deletion recommendations for orphan nodes
 */
export function getDeleteRecommendations(
  results: ClassificationResult[]
): {
  toDelete: ClassificationResult[];
  toFlag: ClassificationResult[];
  toSkip: ClassificationResult[];
} {
  const toDelete: ClassificationResult[] = [];
  const toFlag: ClassificationResult[] = [];
  const toSkip: ClassificationResult[] = [];

  for (const result of results) {
    switch (result.classification) {
      case 'empty':
      case 'generic':
        // Auto-delete empty and generic orphans per FR-003
        toDelete.push(result);
        break;

      case 'valuable':
      case 'small_island':
      case 'large_island':
        // Flag valuable content for review per FR-004
        toFlag.push(result);
        break;

      default:
        toSkip.push(result);
    }
  }

  return { toDelete, toFlag, toSkip };
}

/**
 * Convert classification result to OrphanNode type
 */
export function toOrphanNode(
  node: NodeInfo,
  componentId: number,
  componentSize: number,
  classification: ClassificationResult
): OrphanNode {
  return {
    nodeId: node.id,
    componentId,
    componentSize,
    classification: classification.classification,
    properties: node.properties,
    hasValuableKeywords: classification.hasValuableKeywords,
  };
}

export default {
  classifyOrphanNode,
  classifyComponent,
  classifyOrphans,
  getDeleteRecommendations,
  toOrphanNode,
};
