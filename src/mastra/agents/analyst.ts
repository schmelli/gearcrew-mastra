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

// ============================================================================
// Triage System Types
// ============================================================================

export interface FlaggedItem {
  nodeId: string;
  name: string;
  brand?: string;
  category?: string;
  flagReason: string;
  flaggedAt?: string;
}

export interface TriageResult {
  itemId: string;
  itemName: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  priorityScore: number; // 0-100
  recommendedAction: 'research' | 'delete' | 'review' | 'skip';
  factors: {
    centrality: number;     // 0-40 pts
    dataCompleteness: number; // 0-30 pts
    staleness: number;      // 0-20 pts
    isOrphan: number;       // 0-10 pts
  };
  reasoning: string;
}

export interface CompletenessResult {
  nodeId: string;
  score: number; // 0-1
  missingFields: string[];
  presentFields: string[];
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
    // Using OPTIONAL MATCH instead of EXISTS for Memgraph compatibility
    const brandQuery = `
      MATCH (n:GearItem)
      WHERE n.brand_id IS NOT NULL
      OPTIONAL MATCH (n)-[:MANUFACTURED_BY]->(brand:OutdoorBrand)
      WITH n, brand
      WHERE brand IS NULL
      RETURN n.gearId AS nodeId, n.name AS nodeName, n.brand_id AS brandId
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

  // ============================================================================
  // Triage System Methods
  // ============================================================================

  /**
   * Triage flagged items to determine priority and recommended action
   * Priority Scoring Algorithm:
   * - centrality (0-40 pts): Node degree / max degree in graph
   * - dataCompleteness (0-30 pts): Based on missing fields
   * - staleness (0-20 pts): Days since last update
   * - isOrphan (0-10 pts): Isolated vs connected
   */
  async triageFlaggedItems(flags: FlaggedItem[]): Promise<TriageResult[]> {
    if (flags.length === 0) return [];

    const results: TriageResult[] = [];

    // Get max degree for normalization
    const maxDegreeQuery = `
      MATCH (n:GearItem)
      RETURN max(size((n)--()) ) AS maxDegree
    `;
    const maxDegreeResult = await this.client.readOnlyQuery<{ maxDegree: number }>(maxDegreeQuery);
    const maxDegree = maxDegreeResult[0]?.maxDegree ?? 1;

    // Process each flagged item
    for (const flag of flags) {
      const triageResult = await this.triageSingleItem(flag, maxDegree);
      results.push(triageResult);
    }

    // Sort by priority score (highest first)
    return results.sort((a, b) => b.priorityScore - a.priorityScore);
  }

  /**
   * Triage a single flagged item
   */
  private async triageSingleItem(flag: FlaggedItem, maxDegree: number): Promise<TriageResult> {
    // Get node details
    const nodeQuery = `
      MATCH (n:GearItem {id: $nodeId})
      OPTIONAL MATCH (n)--()
      WITH n, count(*) as degree
      RETURN
        n.id as nodeId,
        n.name as name,
        n.brand as brand,
        n.weight_grams as weight,
        n.price_usd as price,
        n.category as category,
        n.last_enriched_at as lastEnrichedAt,
        n.createdAt as createdAt,
        degree
    `;

    const nodeResults = await this.client.readOnlyQuery<{
      nodeId: string;
      name: string;
      brand: string | null;
      weight: number | null;
      price: number | null;
      category: string | null;
      lastEnrichedAt: string | null;
      createdAt: string | null;
      degree: number;
    }>(nodeQuery, { nodeId: flag.nodeId });

    const node = nodeResults[0];

    if (!node) {
      // Node not found
      return {
        itemId: flag.nodeId,
        itemName: flag.name,
        priority: 'low',
        priorityScore: 0,
        recommendedAction: 'skip',
        factors: { centrality: 0, dataCompleteness: 0, staleness: 0, isOrphan: 0 },
        reasoning: 'Node not found in graph',
      };
    }

    // Calculate factors

    // 1. Centrality (0-40 pts): Node degree normalized
    const centralityScore = Math.round((node.degree / maxDegree) * 40);

    // 2. Data completeness (0-30 pts): Based on important fields
    const completeness = await this.calculateCompleteness(flag.nodeId);
    // Inverse: more missing = higher priority = higher score
    const completenessScore = Math.round((1 - completeness.score) * 30);

    // 3. Staleness (0-20 pts): Days since last update
    const lastUpdate = node.lastEnrichedAt || node.createdAt;
    let stalenessScore = 0;
    if (lastUpdate) {
      const daysSinceUpdate = Math.floor(
        (Date.now() - new Date(lastUpdate).getTime()) / (1000 * 60 * 60 * 24)
      );
      // Max score at 30+ days
      stalenessScore = Math.min(Math.round((daysSinceUpdate / 30) * 20), 20);
    } else {
      // No update date = very stale
      stalenessScore = 20;
    }

    // 4. IsOrphan (0-10 pts): Isolated = higher priority
    const isOrphanScore = node.degree <= 1 ? 10 : node.degree <= 3 ? 5 : 0;

    // Total score
    const priorityScore = centralityScore + completenessScore + stalenessScore + isOrphanScore;

    // Determine priority level
    let priority: 'critical' | 'high' | 'medium' | 'low';
    if (priorityScore >= 70) {
      priority = 'critical';
    } else if (priorityScore >= 50) {
      priority = 'high';
    } else if (priorityScore >= 30) {
      priority = 'medium';
    } else {
      priority = 'low';
    }

    // Determine recommended action
    let recommendedAction: 'research' | 'delete' | 'review' | 'skip';
    let reasoning: string;

    if (node.degree === 0 && completeness.score < 0.3) {
      // Isolated and very incomplete - delete candidate
      recommendedAction = 'delete';
      reasoning = `Orphan node with low completeness (${Math.round(completeness.score * 100)}%). Safe to delete.`;
    } else if (completeness.missingFields.length > 0 && centralityScore > 20) {
      // Well-connected but incomplete - research candidate
      recommendedAction = 'research';
      reasoning = `High centrality node missing: ${completeness.missingFields.join(', ')}. Worth enriching.`;
    } else if (flag.flagReason.includes('generic') || flag.flagReason.includes('no brand')) {
      // Generic items need research to verify
      recommendedAction = 'research';
      reasoning = `Flagged as generic. Research needed to verify or delete.`;
    } else if (centralityScore > 30) {
      // Very high centrality - manual review
      recommendedAction = 'review';
      reasoning = `High-impact node (degree: ${node.degree}). Manual review recommended.`;
    } else if (completeness.score >= 0.8) {
      // Mostly complete, low centrality - skip
      recommendedAction = 'skip';
      reasoning = `Already ${Math.round(completeness.score * 100)}% complete with low impact.`;
    } else {
      // Default to research
      recommendedAction = 'research';
      reasoning = `Missing ${completeness.missingFields.length} fields. Research recommended.`;
    }

    return {
      itemId: flag.nodeId,
      itemName: node.name || flag.name,
      priority,
      priorityScore,
      recommendedAction,
      factors: {
        centrality: centralityScore,
        dataCompleteness: completenessScore,
        staleness: stalenessScore,
        isOrphan: isOrphanScore,
      },
      reasoning,
    };
  }

  /**
   * Calculate data completeness for a node
   */
  async calculateCompleteness(nodeId: string): Promise<CompletenessResult> {
    const query = `
      MATCH (n:GearItem {id: $nodeId})
      RETURN
        n.name as name,
        n.brand as brand,
        n.weight_grams as weight,
        n.price_usd as price,
        n.category as category,
        n.description as description,
        n.materials as materials,
        n.colors as colors,
        n.dimensions_cm as dimensions
    `;

    const results = await this.client.readOnlyQuery<Record<string, unknown>>(query, { nodeId });
    const node = results[0];

    if (!node) {
      return {
        nodeId,
        score: 0,
        missingFields: ['node_not_found'],
        presentFields: [],
      };
    }

    // Define important fields with weights
    const fieldWeights: Record<string, number> = {
      name: 0.15,
      brand: 0.20,
      weight: 0.15,
      price: 0.15,
      category: 0.10,
      description: 0.10,
      materials: 0.05,
      colors: 0.05,
      dimensions: 0.05,
    };

    const missingFields: string[] = [];
    const presentFields: string[] = [];
    let score = 0;

    for (const [field, weight] of Object.entries(fieldWeights)) {
      const value = node[field];
      if (value !== null && value !== undefined && value !== '') {
        presentFields.push(field);
        score += weight;
      } else {
        missingFields.push(field);
      }
    }

    return {
      nodeId,
      score: Math.min(score, 1), // Cap at 1
      missingFields,
      presentFields,
    };
  }

  /**
   * Find items that need enrichment based on completeness and centrality
   */
  async findItemsNeedingEnrichment(options?: {
    limit?: number;
    minCentrality?: number;
    maxCompleteness?: number;
  }): Promise<Array<FlaggedItem & { completeness: number; degree: number }>> {
    const { limit = 50, minCentrality = 0, maxCompleteness = 0.7 } = options || {};

    const query = `
      MATCH (n:GearItem)
      WITH n, size((n)--()) as degree
      WHERE degree >= $minCentrality
      RETURN
        n.id as nodeId,
        n.name as name,
        n.brand as brand,
        n.category as category,
        n.weight_grams as weight,
        n.price_usd as price,
        n.description as description,
        degree
      ORDER BY degree DESC
      LIMIT $limit
    `;

    const results = await this.client.readOnlyQuery<{
      nodeId: string;
      name: string;
      brand: string | null;
      category: string | null;
      weight: number | null;
      price: number | null;
      description: string | null;
      degree: number;
    }>(query, { minCentrality, limit: limit * 2 }); // Get extra to filter

    const items: Array<FlaggedItem & { completeness: number; degree: number }> = [];

    for (const r of results) {
      // Quick completeness calculation
      let presentCount = 0;
      if (r.name) presentCount++;
      if (r.brand) presentCount++;
      if (r.weight) presentCount++;
      if (r.price) presentCount++;
      if (r.category) presentCount++;
      if (r.description) presentCount++;

      const completeness = presentCount / 6;

      if (completeness <= maxCompleteness) {
        const missingFields: string[] = [];
        if (!r.brand) missingFields.push('brand');
        if (!r.weight) missingFields.push('weight');
        if (!r.price) missingFields.push('price');
        if (!r.category) missingFields.push('category');

        items.push({
          nodeId: r.nodeId,
          name: r.name || 'Unknown',
          brand: r.brand ?? undefined,
          category: r.category ?? undefined,
          flagReason: `Incomplete data (${Math.round(completeness * 100)}%): missing ${missingFields.join(', ')}`,
          completeness,
          degree: r.degree,
        });
      }

      if (items.length >= limit) break;
    }

    return items;
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
