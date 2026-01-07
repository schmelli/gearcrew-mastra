/**
 * T047: Supernode Detector Tool
 * Implements FR-019: Detect graph anomalies (supernodes)
 * Supernodes are nodes with >3 standard deviations above mean degree
 */

import { getMemgraphClient } from '@/lib/memgraph-client';

export interface SupernodeResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  degree: number;
  inDegree: number;
  outDegree: number;
  deviationsAboveMean: number;
  percentile: number;
}

export interface SupernodeAnalysis {
  supernodes: SupernodeResult[];
  statistics: {
    totalNodes: number;
    meanDegree: number;
    medianDegree: number;
    stdDev: number;
    threshold: number;
    maxDegree: number;
    minDegree: number;
  };
  healthIndicator: 'healthy' | 'warning' | 'critical';
}

/**
 * Detect supernode anomalies in the graph
 * Per FR-019: Nodes with degree >3 standard deviations above mean
 */
export async function detectSupernodes(): Promise<SupernodeAnalysis> {
  const client = getMemgraphClient();

  // Get degree centrality for all nodes
  const degreeQuery = `
    CALL degree_centrality.get("undirected")
    YIELD node, degree
    WITH node, degree
    ORDER BY degree DESC
    RETURN
      node.id AS nodeId,
      node.name AS nodeName,
      labels(node)[0] AS nodeType,
      degree
  `;

  const degreeResults = await client.readOnlyQuery<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    degree: number;
  }>(degreeQuery);

  if (degreeResults.length === 0) {
    return {
      supernodes: [],
      statistics: {
        totalNodes: 0,
        meanDegree: 0,
        medianDegree: 0,
        stdDev: 0,
        threshold: 0,
        maxDegree: 0,
        minDegree: 0,
      },
      healthIndicator: 'healthy',
    };
  }

  // Calculate statistics
  const degrees = degreeResults.map((r) => r.degree);
  const totalNodes = degrees.length;
  const meanDegree = degrees.reduce((a, b) => a + b, 0) / totalNodes;

  // Calculate variance and standard deviation
  const variance = degrees.reduce((sum, d) => sum + Math.pow(d - meanDegree, 2), 0) / totalNodes;
  const stdDev = Math.sqrt(variance);

  // Calculate median
  const sortedDegrees = [...degrees].sort((a, b) => a - b);
  const medianDegree =
    totalNodes % 2 === 0
      ? (sortedDegrees[totalNodes / 2 - 1]! + sortedDegrees[totalNodes / 2]!) / 2
      : sortedDegrees[Math.floor(totalNodes / 2)]!;

  const maxDegree = Math.max(...degrees);
  const minDegree = Math.min(...degrees);

  // Threshold: 3 standard deviations above mean
  const threshold = meanDegree + 3 * stdDev;

  // Find supernodes (> threshold)
  const supernodes: SupernodeResult[] = [];

  for (const result of degreeResults) {
    if (result.degree > threshold) {
      const deviationsAboveMean = (result.degree - meanDegree) / stdDev;

      // Calculate percentile
      const rank = sortedDegrees.filter((d) => d <= result.degree).length;
      const percentile = (rank / totalNodes) * 100;

      // Get in/out degree
      const directedQuery = `
        MATCH (n)
        WHERE n.id = $nodeId
        OPTIONAL MATCH (n)-[out]->()
        OPTIONAL MATCH ()-[in]->(n)
        WITH n, count(DISTINCT out) AS outDegree, count(DISTINCT in) AS inDegree
        RETURN outDegree, inDegree
      `;

      const directedResult = await client.readOnlyQuery<{
        outDegree: number;
        inDegree: number;
      }>(directedQuery, { nodeId: result.nodeId });

      supernodes.push({
        nodeId: result.nodeId,
        nodeName: result.nodeName,
        nodeType: result.nodeType,
        degree: result.degree,
        inDegree: directedResult[0]?.inDegree ?? 0,
        outDegree: directedResult[0]?.outDegree ?? 0,
        deviationsAboveMean,
        percentile,
      });
    }
  }

  // Determine health indicator
  let healthIndicator: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (supernodes.length > 5) {
    healthIndicator = 'critical';
  } else if (supernodes.length > 0) {
    healthIndicator = 'warning';
  }

  return {
    supernodes,
    statistics: {
      totalNodes,
      meanDegree,
      medianDegree,
      stdDev,
      threshold,
      maxDegree,
      minDegree,
    },
    healthIndicator,
  };
}

/**
 * Get top N nodes by degree (not necessarily supernodes)
 */
export async function getTopNodesByDegree(limit: number = 10): Promise<SupernodeResult[]> {
  const client = getMemgraphClient();

  const query = `
    CALL degree_centrality.get("undirected")
    YIELD node, degree
    WITH node, degree
    ORDER BY degree DESC
    LIMIT $limit
    RETURN
      node.id AS nodeId,
      node.name AS nodeName,
      labels(node)[0] AS nodeType,
      degree
  `;

  const results = await client.readOnlyQuery<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    degree: number;
  }>(query, { limit });

  // Calculate statistics for context
  const allDegreesQuery = `
    CALL degree_centrality.get("undirected")
    YIELD node, degree
    RETURN degree
  `;

  const allDegrees = await client.readOnlyQuery<{ degree: number }>(allDegreesQuery);
  const degrees = allDegrees.map((r) => r.degree);
  const totalNodes = degrees.length;
  const meanDegree = degrees.reduce((a, b) => a + b, 0) / totalNodes;
  const variance = degrees.reduce((sum, d) => sum + Math.pow(d - meanDegree, 2), 0) / totalNodes;
  const stdDev = Math.sqrt(variance);

  const sortedDegrees = [...degrees].sort((a, b) => a - b);

  return results.map((r) => {
    const deviationsAboveMean = (r.degree - meanDegree) / stdDev;
    const rank = sortedDegrees.filter((d) => d <= r.degree).length;
    const percentile = (rank / totalNodes) * 100;

    return {
      nodeId: r.nodeId,
      nodeName: r.nodeName,
      nodeType: r.nodeType,
      degree: r.degree,
      inDegree: 0, // Would need separate query
      outDegree: 0,
      deviationsAboveMean,
      percentile,
    };
  });
}

/**
 * Analyze a specific node's connectivity
 */
export async function analyzeNodeConnectivity(nodeId: string): Promise<{
  node: SupernodeResult | null;
  isSupernode: boolean;
  neighbors: Array<{ nodeId: string; nodeName: string; relationshipType: string }>;
}> {
  const client = getMemgraphClient();

  // Get node degree info
  const nodeQuery = `
    MATCH (n)
    WHERE n.id = $nodeId
    OPTIONAL MATCH (n)-[r]-(neighbor)
    WITH n, count(r) AS degree,
         collect({nodeId: neighbor.id, nodeName: neighbor.name, type: type(r)}) AS neighbors
    RETURN
      n.id AS nodeId,
      n.name AS nodeName,
      labels(n)[0] AS nodeType,
      degree,
      neighbors
  `;

  const result = await client.readOnlyQuery<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    degree: number;
    neighbors: Array<{ nodeId: string; nodeName: string; type: string }>;
  }>(nodeQuery, { nodeId });

  if (result.length === 0) {
    return { node: null, isSupernode: false, neighbors: [] };
  }

  const nodeData = result[0]!;

  // Get overall statistics to determine if supernode
  const analysis = await detectSupernodes();
  const isSupernode = analysis.supernodes.some((s) => s.nodeId === nodeId);

  const deviationsAboveMean =
    (nodeData.degree - analysis.statistics.meanDegree) / analysis.statistics.stdDev;

  return {
    node: {
      nodeId: nodeData.nodeId,
      nodeName: nodeData.nodeName,
      nodeType: nodeData.nodeType,
      degree: nodeData.degree,
      inDegree: 0,
      outDegree: 0,
      deviationsAboveMean,
      percentile: 0,
    },
    isSupernode,
    neighbors: nodeData.neighbors.map((n) => ({
      nodeId: n.nodeId,
      nodeName: n.nodeName,
      relationshipType: n.type,
    })),
  };
}

/**
 * Format supernode analysis for chat response
 */
export function formatSupernodeReport(analysis: SupernodeAnalysis): string {
  const lines: string[] = [];

  lines.push('**Supernode Analysis**\n');
  lines.push(`Total nodes analyzed: ${analysis.statistics.totalNodes}`);
  lines.push(`Mean degree: ${analysis.statistics.meanDegree.toFixed(2)}`);
  lines.push(`Standard deviation: ${analysis.statistics.stdDev.toFixed(2)}`);
  lines.push(`Supernode threshold: ${analysis.statistics.threshold.toFixed(2)}`);
  lines.push(`Health status: ${analysis.healthIndicator}\n`);

  if (analysis.supernodes.length === 0) {
    lines.push('No supernodes detected.');
  } else {
    lines.push(`**${analysis.supernodes.length} Supernodes Detected:**`);
    for (const node of analysis.supernodes) {
      lines.push(
        `- ${node.nodeName} (${node.nodeType}): degree ${node.degree}, ` +
          `${node.deviationsAboveMean.toFixed(1)}σ above mean`
      );
    }
  }

  return lines.join('\n');
}

export default {
  detectSupernodes,
  getTopNodesByDegree,
  analyzeNodeConnectivity,
  formatSupernodeReport,
};
