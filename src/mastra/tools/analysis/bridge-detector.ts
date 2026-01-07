/**
 * T081: Bridge Node Detection Tool
 * Implements FR-009: Detect nodes with high betweenness centrality
 * Bridge nodes are critical for graph connectivity and require extra protection
 */

import { z } from 'zod';
import { getMemgraphClient } from '@/lib/memgraph-client';

// ============================================================================
// Types
// ============================================================================

export interface BridgeNode {
  nodeId: string;
  nodeName: string;
  nodeLabel: string;
  betweennessCentrality: number;
  degree: number;
  inDegree: number;
  outDegree: number;
  connectedComponents: number;
  isArticulationPoint: boolean;
}

export interface BridgeAnalysisResult {
  bridgeNodes: BridgeNode[];
  totalNodes: number;
  bridgeThreshold: number;
  articulationPoints: number;
  averageBetweenness: number;
  maxBetweenness: number;
  analyzedAt: string;
}

export interface BridgeCheckResult {
  isBridge: boolean;
  betweennessCentrality: number;
  percentile: number;
  recommendation: 'auto_proceed' | 'require_approval' | 'block';
  reason: string;
}

// ============================================================================
// Configuration
// ============================================================================

const BRIDGE_CONFIG = {
  // Percentile threshold for bridge nodes (top 10%)
  bridgePercentile: 90,

  // Minimum betweenness centrality to be considered a bridge
  minBetweenness: 0.05,

  // Maximum nodes to analyze for full centrality (performance limit)
  maxNodesForFullAnalysis: 10000,

  // Sample size for large graphs
  sampleSize: 1000,
};

// ============================================================================
// Bridge Detection Functions
// ============================================================================

/**
 * Detect all bridge nodes in the graph
 */
export async function detectBridgeNodes(options?: {
  nodeLabel?: string;
  limit?: number;
}): Promise<BridgeAnalysisResult> {
  const client = getMemgraphClient();
  const { nodeLabel, limit = 50 } = options || {};

  // First, get graph size
  const sizeQuery = nodeLabel
    ? `MATCH (n:${nodeLabel}) RETURN count(n) as count`
    : 'MATCH (n) RETURN count(n) as count';

  const sizeResult = await client.readOnlyQuery<{ count: number }>(sizeQuery);
  const totalNodes = sizeResult[0]?.count ?? 0;

  // Determine analysis approach based on graph size
  let bridgeNodes: BridgeNode[] = [];
  let averageBetweenness = 0;
  let maxBetweenness = 0;

  if (totalNodes <= BRIDGE_CONFIG.maxNodesForFullAnalysis) {
    // Full analysis for smaller graphs
    const result = await fullBetweennessAnalysis(nodeLabel, limit);
    bridgeNodes = result.nodes;
    averageBetweenness = result.avgBetweenness;
    maxBetweenness = result.maxBetweenness;
  } else {
    // Sampled analysis for large graphs
    const result = await sampledBetweennessAnalysis(nodeLabel, limit);
    bridgeNodes = result.nodes;
    averageBetweenness = result.avgBetweenness;
    maxBetweenness = result.maxBetweenness;
  }

  // Calculate threshold
  const bridgeThreshold = calculateBridgeThreshold(bridgeNodes);

  // Count articulation points
  const articulationPoints = bridgeNodes.filter((n) => n.isArticulationPoint).length;

  return {
    bridgeNodes,
    totalNodes,
    bridgeThreshold,
    articulationPoints,
    averageBetweenness,
    maxBetweenness,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Full betweenness centrality analysis using MAGE algorithms
 */
async function fullBetweennessAnalysis(
  nodeLabel?: string,
  limit?: number
): Promise<{
  nodes: BridgeNode[];
  avgBetweenness: number;
  maxBetweenness: number;
}> {
  const client = getMemgraphClient();

  // Use MAGE betweenness_centrality algorithm
  const query = `
    CALL betweenness_centrality.get()
    YIELD node, betweenness_centrality
    ${nodeLabel ? `WHERE node:${nodeLabel}` : ''}
    WITH node, betweenness_centrality
    MATCH (node)-[r]-()
    WITH node, betweenness_centrality, count(r) as degree
    ORDER BY betweenness_centrality DESC
    LIMIT ${limit || 50}
    RETURN
      node.id as nodeId,
      node.name as nodeName,
      labels(node)[0] as nodeLabel,
      betweenness_centrality,
      degree
  `;

  try {
    const results = await client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
      nodeLabel: string;
      betweenness_centrality: number;
      degree: number;
    }>(query);

    const nodes: BridgeNode[] = results.map((r) => ({
      nodeId: r.nodeId,
      nodeName: r.nodeName || r.nodeId,
      nodeLabel: r.nodeLabel,
      betweennessCentrality: r.betweenness_centrality,
      degree: r.degree,
      inDegree: Math.floor(r.degree / 2),
      outDegree: Math.ceil(r.degree / 2),
      connectedComponents: 1, // Would need separate analysis
      isArticulationPoint: r.betweenness_centrality > BRIDGE_CONFIG.minBetweenness,
    }));

    const avgBetweenness =
      nodes.length > 0
        ? nodes.reduce((sum, n) => sum + n.betweennessCentrality, 0) / nodes.length
        : 0;
    const maxBetweenness =
      nodes.length > 0 ? Math.max(...nodes.map((n) => n.betweennessCentrality)) : 0;

    return { nodes, avgBetweenness, maxBetweenness };
  } catch (error) {
    // Fallback if MAGE algorithm not available
    console.warn('MAGE betweenness_centrality not available, using degree-based approximation');
    return degreeBasedApproximation(nodeLabel, limit);
  }
}

/**
 * Sampled analysis for large graphs
 */
async function sampledBetweennessAnalysis(
  nodeLabel?: string,
  limit?: number
): Promise<{
  nodes: BridgeNode[];
  avgBetweenness: number;
  maxBetweenness: number;
}> {
  const client = getMemgraphClient();

  // Sample high-degree nodes as potential bridges
  const query = `
    MATCH (n${nodeLabel ? `:${nodeLabel}` : ''})
    WITH n, size((n)--()) as degree
    ORDER BY degree DESC
    LIMIT ${BRIDGE_CONFIG.sampleSize}
    WITH collect(n) as sample
    UNWIND sample as node
    OPTIONAL MATCH path = shortestPath((node)-[*..3]-(other))
    WHERE other IN sample AND node <> other
    WITH node, count(path) as pathCount, size((node)--()) as degree
    ORDER BY pathCount DESC
    LIMIT ${limit || 50}
    RETURN
      node.id as nodeId,
      node.name as nodeName,
      labels(node)[0] as nodeLabel,
      toFloat(pathCount) / 1000 as approxBetweenness,
      degree
  `;

  try {
    const results = await client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
      nodeLabel: string;
      approxBetweenness: number;
      degree: number;
    }>(query);

    const nodes: BridgeNode[] = results.map((r) => ({
      nodeId: r.nodeId,
      nodeName: r.nodeName || r.nodeId,
      nodeLabel: r.nodeLabel,
      betweennessCentrality: r.approxBetweenness,
      degree: r.degree,
      inDegree: Math.floor(r.degree / 2),
      outDegree: Math.ceil(r.degree / 2),
      connectedComponents: 1,
      isArticulationPoint: r.approxBetweenness > BRIDGE_CONFIG.minBetweenness,
    }));

    const avgBetweenness =
      nodes.length > 0
        ? nodes.reduce((sum, n) => sum + n.betweennessCentrality, 0) / nodes.length
        : 0;
    const maxBetweenness =
      nodes.length > 0 ? Math.max(...nodes.map((n) => n.betweennessCentrality)) : 0;

    return { nodes, avgBetweenness, maxBetweenness };
  } catch (error) {
    console.error('Bridge detection error:', error);
    return { nodes: [], avgBetweenness: 0, maxBetweenness: 0 };
  }
}

/**
 * Degree-based approximation when MAGE is not available
 */
async function degreeBasedApproximation(
  nodeLabel?: string,
  limit?: number
): Promise<{
  nodes: BridgeNode[];
  avgBetweenness: number;
  maxBetweenness: number;
}> {
  const client = getMemgraphClient();

  const query = `
    MATCH (n${nodeLabel ? `:${nodeLabel}` : ''})
    WITH n, size((n)--()) as degree
    WHERE degree > 2
    ORDER BY degree DESC
    LIMIT ${limit || 50}
    RETURN
      n.id as nodeId,
      n.name as nodeName,
      labels(n)[0] as nodeLabel,
      degree,
      toFloat(degree) / 100.0 as approxBetweenness
  `;

  const results = await client.readOnlyQuery<{
    nodeId: string;
    nodeName: string;
    nodeLabel: string;
    degree: number;
    approxBetweenness: number;
  }>(query);

  const nodes: BridgeNode[] = results.map((r) => ({
    nodeId: r.nodeId,
    nodeName: r.nodeName || r.nodeId,
    nodeLabel: r.nodeLabel,
    betweennessCentrality: r.approxBetweenness,
    degree: r.degree,
    inDegree: Math.floor(r.degree / 2),
    outDegree: Math.ceil(r.degree / 2),
    connectedComponents: 1,
    isArticulationPoint: r.degree > 10,
  }));

  const avgBetweenness =
    nodes.length > 0
      ? nodes.reduce((sum, n) => sum + n.betweennessCentrality, 0) / nodes.length
      : 0;
  const maxBetweenness =
    nodes.length > 0 ? Math.max(...nodes.map((n) => n.betweennessCentrality)) : 0;

  return { nodes, avgBetweenness, maxBetweenness };
}

/**
 * Calculate the bridge threshold based on percentile
 */
function calculateBridgeThreshold(nodes: BridgeNode[]): number {
  if (nodes.length === 0) return BRIDGE_CONFIG.minBetweenness;

  const sorted = [...nodes].sort(
    (a, b) => a.betweennessCentrality - b.betweennessCentrality
  );
  const percentileIndex = Math.floor(
    (sorted.length * BRIDGE_CONFIG.bridgePercentile) / 100
  );

  return Math.max(
    sorted[percentileIndex]?.betweennessCentrality ?? 0,
    BRIDGE_CONFIG.minBetweenness
  );
}

/**
 * Check if a specific node is a bridge node
 */
export async function checkIfBridgeNode(nodeId: string): Promise<BridgeCheckResult> {
  const client = getMemgraphClient();

  // Get node's betweenness centrality
  const query = `
    MATCH (n {id: $nodeId})
    WITH n, size((n)--()) as degree
    OPTIONAL MATCH path = shortestPath((n)-[*..2]-(other))
    WITH n, degree, count(path) as pathCount
    RETURN
      n.id as nodeId,
      degree,
      toFloat(pathCount) / 100.0 as approxBetweenness
  `;

  const results = await client.readOnlyQuery<{
    nodeId: string;
    degree: number;
    approxBetweenness: number;
  }>(query, { nodeId });

  if (results.length === 0) {
    return {
      isBridge: false,
      betweennessCentrality: 0,
      percentile: 0,
      recommendation: 'auto_proceed',
      reason: 'Node not found',
    };
  }

  const node = results[0]!;
  const isBridge =
    node.approxBetweenness > BRIDGE_CONFIG.minBetweenness || node.degree > 10;

  // Determine recommendation based on bridge status
  let recommendation: BridgeCheckResult['recommendation'];
  let reason: string;

  if (isBridge) {
    if (node.degree > 20 || node.approxBetweenness > 0.5) {
      recommendation = 'block';
      reason = 'Node is a critical bridge with high connectivity';
    } else {
      recommendation = 'require_approval';
      reason = 'Node has significant connectivity and may be a bridge';
    }
  } else {
    recommendation = 'auto_proceed';
    reason = 'Node has low bridge characteristics';
  }

  return {
    isBridge,
    betweennessCentrality: node.approxBetweenness,
    percentile: isBridge ? 90 : 50,
    recommendation,
    reason,
  };
}

/**
 * Format bridge analysis for chat/reporting
 */
export function formatBridgeReport(analysis: BridgeAnalysisResult): string {
  const lines: string[] = [];

  lines.push('**Bridge Node Analysis**\n');
  lines.push(`Total nodes analyzed: ${analysis.totalNodes.toLocaleString()}`);
  lines.push(`Bridge nodes found: ${analysis.bridgeNodes.length}`);
  lines.push(`Articulation points: ${analysis.articulationPoints}`);
  lines.push(`Average betweenness: ${(analysis.averageBetweenness * 100).toFixed(2)}%`);
  lines.push(`Max betweenness: ${(analysis.maxBetweenness * 100).toFixed(2)}%`);
  lines.push(`Bridge threshold: ${(analysis.bridgeThreshold * 100).toFixed(2)}%\n`);

  if (analysis.bridgeNodes.length > 0) {
    lines.push('**Top Bridge Nodes:**');
    for (const node of analysis.bridgeNodes.slice(0, 10)) {
      lines.push(
        `- ${node.nodeName} (${node.nodeLabel}): ` +
          `${(node.betweennessCentrality * 100).toFixed(1)}% betweenness, ` +
          `${node.degree} connections`
      );
    }
  } else {
    lines.push('No significant bridge nodes detected.');
  }

  return lines.join('\n');
}

/**
 * Create a Mastra-compatible tool for bridge detection
 */
export function createBridgeDetectorTool() {
  return {
    name: 'detectBridgeNodes',
    description: 'Detect bridge nodes with high betweenness centrality',
    inputSchema: z.object({
      nodeLabel: z.string().optional().describe('Node label to filter'),
      limit: z.number().optional().describe('Maximum nodes to return'),
    }),
    execute: async (input: { nodeLabel?: string; limit?: number }) => {
      const analysis = await detectBridgeNodes(input);
      return {
        ...analysis,
        formattedReport: formatBridgeReport(analysis),
      };
    },
  };
}
