/**
 * T021: Analyst Agent
 * Non-LLM agent for graph structure analysis using algorithms
 * Per research.md: Analyst has no LLM (pure algorithms)
 * Implements Constitution Principle V: Mathematical Rigor
 */

import { detectOrphanComponents, getOrphansForDeletion, getValuableOrphans } from '../tools/analysis/wcc';
import { classifyOrphanNode, classifyComponent, getDeleteRecommendations, ClassificationResult } from '../tools/analysis/orphan-classifier';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { registerAgent } from '../index';

export interface AnalysisResult<T> {
  success: boolean;
  data: T;
  executedAt: string;
  duration: number;
}

/**
 * Analyst Agent - Pure algorithmic analysis, no LLM
 * Handles graph structure analysis using MAGE algorithms
 */
export class AnalystAgent {
  private readonly name = 'analyst';
  private readonly client = getMemgraphClient();

  constructor() {
    // Register with Mastra
    registerAgent(this.name, this);
  }

  /**
   * Analyze orphan components in the graph
   */
  async analyzeOrphans(): Promise<AnalysisResult<{
    totalComponents: number;
    orphanCount: number;
    classifications: ClassificationResult[];
    recommendations: {
      toDelete: ClassificationResult[];
      toFlag: ClassificationResult[];
    };
  }>> {
    const startTime = Date.now();

    const wccResult = await detectOrphanComponents();

    // Classify all orphan nodes
    const classifications: ClassificationResult[] = [];
    for (const component of wccResult.orphanComponents) {
      const componentClassifications = classifyComponent(component);
      classifications.push(...componentClassifications);
    }

    const recommendations = getDeleteRecommendations(classifications);

    return {
      success: true,
      data: {
        totalComponents: wccResult.components.length,
        orphanCount: wccResult.orphanCount,
        classifications,
        recommendations: {
          toDelete: recommendations.toDelete,
          toFlag: recommendations.toFlag,
        },
      },
      executedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  }

  /**
   * Detect supernode anomalies using degree centrality
   * Per FR-019: >3 standard deviations above mean
   */
  async detectSupernodes(): Promise<AnalysisResult<{
    supernodes: Array<{
      nodeId: string;
      nodeName: string;
      degree: number;
      degreesAboveMean: number;
    }>;
    meanDegree: number;
    stdDev: number;
    threshold: number;
  }>> {
    const startTime = Date.now();

    // Per research.md: Use MAGE degree_centrality
    const query = `
      CALL degree_centrality.get("undirected")
      YIELD node, degree
      WITH node, degree
      ORDER BY degree DESC
      RETURN
        node.id AS nodeId,
        node.name AS nodeName,
        degree
    `;

    const results = await this.client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
      degree: number;
    }>(query);

    if (results.length === 0) {
      return {
        success: true,
        data: {
          supernodes: [],
          meanDegree: 0,
          stdDev: 0,
          threshold: 0,
        },
        executedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    }

    // Calculate mean and standard deviation
    const degrees = results.map((r) => r.degree);
    const meanDegree = degrees.reduce((a, b) => a + b, 0) / degrees.length;
    const variance = degrees.reduce((sum, d) => sum + Math.pow(d - meanDegree, 2), 0) / degrees.length;
    const stdDev = Math.sqrt(variance);

    // Threshold: 3 standard deviations above mean
    const threshold = meanDegree + 3 * stdDev;

    const supernodes = results
      .filter((r) => r.degree > threshold)
      .map((r) => ({
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        degree: r.degree,
        degreesAboveMean: (r.degree - meanDegree) / stdDev,
      }));

    return {
      success: true,
      data: {
        supernodes,
        meanDegree,
        stdDev,
        threshold,
      },
      executedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  }

  /**
   * Detect bridge nodes using betweenness centrality
   * Per FR-009: Require human approval for destructive actions on bridge nodes
   */
  async detectBridgeNodes(): Promise<AnalysisResult<{
    bridgeNodes: Array<{
      nodeId: string;
      nodeName: string;
      betweennessCentrality: number;
    }>;
  }>> {
    const startTime = Date.now();

    // Per research.md: Use MAGE betweenness_centrality
    const query = `
      CALL betweenness_centrality.get(TRUE, TRUE)
      YIELD node, betweenness_centrality
      WITH node, betweenness_centrality
      WHERE betweenness_centrality > 0.1
      RETURN
        node.id AS nodeId,
        node.name AS nodeName,
        betweenness_centrality AS betweennessCentrality
      ORDER BY betweenness_centrality DESC
    `;

    const results = await this.client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
      betweennessCentrality: number;
    }>(query);

    return {
      success: true,
      data: {
        bridgeNodes: results,
      },
      executedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  }

  /**
   * Validate graph schema constraints
   * Per FR-020/FR-021: Validate nodes against schema requirements
   */
  async validateSchema(): Promise<AnalysisResult<{
    violations: Array<{
      nodeId: string;
      nodeName: string;
      violationType: string;
      details: string;
    }>;
    validatedCount: number;
    violationCount: number;
  }>> {
    const startTime = Date.now();

    const violations: Array<{
      nodeId: string;
      nodeName: string;
      violationType: string;
      details: string;
    }> = [];

    // Check for whitespace in names (per data-model.md validation rules)
    const whitespaceQuery = `
      MATCH (n:GearItem)
      WHERE n.name STARTS WITH ' ' OR n.name ENDS WITH ' '
      RETURN n.id AS nodeId, n.name AS nodeName
    `;
    const whitespaceResults = await this.client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
    }>(whitespaceQuery);

    for (const r of whitespaceResults) {
      violations.push({
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        violationType: 'schema_violation',
        details: 'Name has leading/trailing whitespace',
      });
    }

    // Check for invalid weight values
    const weightQuery = `
      MATCH (n:GearItem)
      WHERE n.weight_grams IS NOT NULL
        AND (n.weight_grams < 1 OR n.weight_grams > 50000)
      RETURN n.id AS nodeId, n.name AS nodeName, n.weight_grams AS weight
    `;
    const weightResults = await this.client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
      weight: number;
    }>(weightQuery);

    for (const r of weightResults) {
      violations.push({
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        violationType: 'schema_violation',
        details: `Weight ${r.weight}g is outside valid range (1-50000)`,
      });
    }

    // Check for missing brand references
    const brandQuery = `
      MATCH (n:GearItem)
      WHERE n.brand_id IS NOT NULL
        AND NOT EXISTS((n)-[:MANUFACTURED_BY]->(:OutdoorBrand))
      RETURN n.id AS nodeId, n.name AS nodeName, n.brand_id AS brandId
    `;
    const brandResults = await this.client.readOnlyQuery<{
      nodeId: string;
      nodeName: string;
      brandId: string;
    }>(brandQuery);

    for (const r of brandResults) {
      violations.push({
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        violationType: 'missing_data',
        details: `Brand ID ${r.brandId} has no corresponding brand node`,
      });
    }

    // Count total nodes validated
    const countQuery = `MATCH (n:GearItem) RETURN count(n) AS count`;
    const countResult = await this.client.readOnlyQuery<{ count: number }>(countQuery);
    const validatedCount = countResult[0]?.count ?? 0;

    return {
      success: true,
      data: {
        violations,
        validatedCount,
        violationCount: violations.length,
      },
      executedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  }

  /**
   * Get graph health summary
   */
  async getHealthSummary(): Promise<AnalysisResult<{
    totalNodes: number;
    totalRelationships: number;
    orphanCount: number;
    supernodeCount: number;
    bridgeNodeCount: number;
    schemaViolationCount: number;
  }>> {
    const startTime = Date.now();

    // Run all analyses in parallel
    const [orphans, supernodes, bridgeNodes, schema] = await Promise.all([
      this.analyzeOrphans(),
      this.detectSupernodes(),
      this.detectBridgeNodes(),
      this.validateSchema(),
    ]);

    // Get total counts
    const nodeCountQuery = `MATCH (n) RETURN count(n) AS count`;
    const relCountQuery = `MATCH ()-[r]->() RETURN count(r) AS count`;

    const [nodeCount, relCount] = await Promise.all([
      this.client.readOnlyQuery<{ count: number }>(nodeCountQuery),
      this.client.readOnlyQuery<{ count: number }>(relCountQuery),
    ]);

    return {
      success: true,
      data: {
        totalNodes: nodeCount[0]?.count ?? 0,
        totalRelationships: relCount[0]?.count ?? 0,
        orphanCount: orphans.data.orphanCount,
        supernodeCount: supernodes.data.supernodes.length,
        bridgeNodeCount: bridgeNodes.data.bridgeNodes.length,
        schemaViolationCount: schema.data.violationCount,
      },
      executedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  }
}

// Create singleton instance
let analystInstance: AnalystAgent | null = null;

export function getAnalystAgent(): AnalystAgent {
  if (!analystInstance) {
    analystInstance = new AnalystAgent();
  }
  return analystInstance;
}

export default AnalystAgent;
