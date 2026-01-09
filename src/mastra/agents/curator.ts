/**
 * Curator Agent
 * Phase 2 of Consolidated Agent Architecture
 *
 * Responsibilities:
 * - Accept JSON from Researcher, Resolver, or Analyst
 * - Generate schema-compliant Cypher
 * - Execute ALL graph writes
 * - Create RICH graph structure with proper nodes and relationships
 * - Audit logging for every change
 *
 * Uses existing node types: GearItem, ProductFamily, OutdoorBrand, Technology,
 * UsageScenario, Insight, PerformanceContext, FeedbackPattern, DataSource,
 * TemperatureRange, WeatherCondition, MarketSegment, ProductType
 */

import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getAuditLogger } from '@/lib/audit-logger';
import type { ResearchFindings } from './researcher';
import {
  makeInformedDecision,
  learnFromSuccessfulOperation,
  recordEpisodicMemory,
  type DecisionResult,
} from '../memory/learning';

// ============================================================================
// Curation Request Schemas
// ============================================================================

export const CurationActionSchema = z.enum([
  'update_properties',
  'create_node',
  'create_relationship',
  'delete_node',
  'merge_nodes',
  'create_family',
  'link_brand',
  'link_technology',
  'add_usage_scenario',
  'add_insight',
  'add_feedback_pattern',
  'add_performance_context',
  'add_temperature_range',
  'add_weather_condition',
  'add_comparison',
  'add_data_source',
]);

export type CurationAction = z.infer<typeof CurationActionSchema>;

export const CurationSourceSchema = z.object({
  agent: z.enum(['researcher', 'resolver', 'analyst', 'manual']),
  workflowRunId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type CurationSource = z.infer<typeof CurationSourceSchema>;

export const CurationRequestSchema = z.object({
  action: CurationActionSchema,
  nodeId: z.string().optional(),
  data: z.record(z.unknown()),
  source: CurationSourceSchema,
});

export type CurationRequest = z.infer<typeof CurationRequestSchema>;

export interface CurationResult {
  success: boolean;
  operationsCount: number;
  createdNodes: string[];
  createdRelationships: string[];
  errors: string[];
}

// ============================================================================
// Curator Agent Class
// ============================================================================

export class CuratorAgent {
  private auditLogger = getAuditLogger();

  /**
   * Enrich a GearItem from comprehensive research findings
   * This is the main method that creates rich graph structure
   */
  async enrichFromResearch(
    nodeId: string,
    findings: ResearchFindings,
    workflowRunId: string
  ): Promise<CurationResult> {
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    try {
      // 1. Update basic properties on GearItem
      if (findings.specs) {
        await this.updateGearItemProperties(nodeId, findings.specs, workflowRunId);
        result.operationsCount++;
      }

      // 2. Create/link Brand using PRODUCED_BY
      if (findings.brand?.verified) {
        const brandResult = await this.linkToBrand(
          nodeId,
          findings.brand.name,
          findings.brand.websiteUrl,
          workflowRunId
        );
        result.operationsCount += brandResult.operationsCount;
        result.createdNodes.push(...brandResult.createdNodes);
        result.createdRelationships.push(...brandResult.createdRelationships);
      }

      // 3. Create/link ProductFamily using IS_VARIANT_OF
      if (findings.productFamily) {
        const familyResult = await this.linkToProductFamily(
          nodeId,
          findings.productFamily,
          findings.brand?.name,
          workflowRunId
        );
        result.operationsCount += familyResult.operationsCount;
        result.createdNodes.push(...familyResult.createdNodes);
        result.createdRelationships.push(...familyResult.createdRelationships);
      }

      // 4. Create Technology nodes and USES_TECHNOLOGY relationships
      for (const tech of findings.technologies ?? []) {
        const techResult = await this.linkToTechnology(nodeId, tech, workflowRunId);
        result.operationsCount += techResult.operationsCount;
        result.createdNodes.push(...techResult.createdNodes);
        result.createdRelationships.push(...techResult.createdRelationships);
      }

      // 5. Create UsageScenario nodes and SUITABLE_FOR relationships
      for (const scenario of findings.usageScenarios ?? []) {
        const scenarioResult = await this.linkToUsageScenario(nodeId, scenario, workflowRunId);
        result.operationsCount += scenarioResult.operationsCount;
        result.createdNodes.push(...scenarioResult.createdNodes);
        result.createdRelationships.push(...scenarioResult.createdRelationships);
      }

      // 6. Create Insight nodes and HAS_TIP relationships
      for (const insight of findings.insights ?? []) {
        const insightResult = await this.createInsight(nodeId, insight, workflowRunId);
        result.operationsCount += insightResult.operationsCount;
        result.createdNodes.push(...insightResult.createdNodes);
        result.createdRelationships.push(...insightResult.createdRelationships);
      }

      // 7. Create FeedbackPattern node and HAS_FEEDBACK relationship
      if (findings.feedbackPatterns) {
        const feedbackResult = await this.createFeedbackPattern(
          nodeId,
          findings.feedbackPatterns,
          workflowRunId
        );
        result.operationsCount += feedbackResult.operationsCount;
        result.createdNodes.push(...feedbackResult.createdNodes);
        result.createdRelationships.push(...feedbackResult.createdRelationships);
      }

      // 8. Create PerformanceContext and HAS_PERFORMANCE_METRICS
      if (findings.performanceMetrics) {
        const perfResult = await this.createPerformanceContext(
          nodeId,
          findings.performanceMetrics,
          workflowRunId
        );
        result.operationsCount += perfResult.operationsCount;
        result.createdNodes.push(...perfResult.createdNodes);
        result.createdRelationships.push(...perfResult.createdRelationships);
      }

      // 9. Create TemperatureRange and HAS_TEMP_RANGE
      if (findings.temperatureRange) {
        const tempResult = await this.createTemperatureRange(
          nodeId,
          findings.temperatureRange,
          workflowRunId
        );
        result.operationsCount += tempResult.operationsCount;
        result.createdNodes.push(...tempResult.createdNodes);
        result.createdRelationships.push(...tempResult.createdRelationships);
      }

      // 10. Create WeatherCondition and PERFORMS_IN relationships
      for (const weather of findings.weatherPerformance ?? []) {
        const weatherResult = await this.linkToWeatherCondition(nodeId, weather, workflowRunId);
        result.operationsCount += weatherResult.operationsCount;
        result.createdNodes.push(...weatherResult.createdNodes);
        result.createdRelationships.push(...weatherResult.createdRelationships);
      }

      // 11. Link to ProductType using IS_TYPE
      if (findings.productType) {
        const typeResult = await this.linkToProductType(nodeId, findings.productType, workflowRunId);
        result.operationsCount += typeResult.operationsCount;
        result.createdRelationships.push(...typeResult.createdRelationships);
      }

      // 12. Create comparison relationships
      for (const comparison of findings.comparisons ?? []) {
        const compResult = await this.createComparison(nodeId, comparison, workflowRunId);
        result.operationsCount += compResult.operationsCount;
        result.createdRelationships.push(...compResult.createdRelationships);
      }

      // 13. Create DataSource for attribution
      for (const source of findings.sources) {
        const sourceResult = await this.linkToDataSource(
          nodeId,
          source,
          workflowRunId
        );
        result.operationsCount += sourceResult.operationsCount;
        result.createdNodes.push(...sourceResult.createdNodes);
        result.createdRelationships.push(...sourceResult.createdRelationships);
      }

      // Audit log
      await this.auditLogger.logUpdate(
        workflowRunId,
        'data-quality',
        nodeId,
        'GearItem',
        { enriched: false },
        {
          enriched: true,
          operationsCount: result.operationsCount,
          createdNodes: result.createdNodes.length,
          createdRelationships: result.createdRelationships.length,
        },
        {
          confidence: findings.overallConfidence,
          reasoning: `Enriched from ${findings.sources.length} sources`,
          source: 'curator',
        }
      );

      return result;
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  /**
   * Update basic properties on a GearItem node
   */
  private async updateGearItemProperties(
    nodeId: string,
    specs: NonNullable<ResearchFindings['specs']>,
    workflowRunId: string
  ): Promise<void> {
    const client = getMemgraphClient();
    const updates: Record<string, unknown> = {};

    if (specs.weight) {
      updates.weight_grams = this.convertToGrams(specs.weight.value, specs.weight.unit);
    }
    if (specs.price) {
      updates.price_usd = specs.price.currency === 'USD' ? specs.price.value : specs.price.value;
    }
    if (specs.materials?.length) {
      updates.materials = specs.materials.map(m => m.name).join(', ');
    }
    if (specs.colors?.length) {
      updates.colors = specs.colors;
    }
    if (specs.sizes?.length) {
      updates.sizes = specs.sizes;
    }

    updates.last_enriched_at = new Date().toISOString();
    updates.enrichment_workflow_run = workflowRunId;

    if (Object.keys(updates).length === 0) return;

    const setClause = Object.keys(updates)
      .map(key => `n.${key} = $${key}`)
      .join(', ');

    await client.writeTransaction(
      `MATCH (n:GearItem {id: $nodeId}) SET ${setClause}`,
      { nodeId, ...updates }
    );
  }

  /**
   * Find or create brand and link with PRODUCED_BY
   */
  async linkToBrand(
    gearItemId: string,
    brandName: string,
    websiteUrl: string | undefined,
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    // Find or create brand
    const brandId = `brand-${brandName.toLowerCase().replace(/\s+/g, '-')}`;
    const brandQuery = `
      MERGE (b:OutdoorBrand {name: $brandName})
      ON CREATE SET
        b.id = $brandId,
        b.website = $websiteUrl,
        b.createdAt = datetime()
      ON MATCH SET
        b.updatedAt = datetime()
      RETURN b.id as id, b.createdAt = datetime() as isNew
    `;

    const brandResult = await client.writeTransaction<{ id: string; isNew: boolean }>(
      brandQuery,
      { brandName, brandId, websiteUrl }
    );

    if (brandResult[0]?.isNew) {
      result.createdNodes.push(brandId);
    }
    result.operationsCount++;

    // Create PRODUCED_BY relationship
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (b:OutdoorBrand {name: $brandName})
      MERGE (g)-[r:PRODUCED_BY]->(b)
      SET r.updatedAt = datetime()
      WITH g, b, r
      MERGE (b)-[r2:MANUFACTURES_ITEM]->(g)
      SET r2.updatedAt = datetime()
      RETURN type(r) as relType
    `;

    await client.writeTransaction(relQuery, { gearItemId, brandName });
    result.createdRelationships.push('PRODUCED_BY', 'MANUFACTURES_ITEM');
    result.operationsCount++;

    return result;
  }

  /**
   * Find or create ProductFamily and link with IS_VARIANT_OF
   */
  async linkToProductFamily(
    gearItemId: string,
    family: NonNullable<ResearchFindings['productFamily']>,
    brandName: string | undefined,
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const familyId = `family-${family.name.toLowerCase().replace(/\s+/g, '-')}`;

    // Create or update ProductFamily node
    const familyQuery = `
      MERGE (f:ProductFamily {name: $familyName})
      ON CREATE SET
        f.id = $familyId,
        f.positioning = $positioning,
        f.pricePoint = $pricePoint,
        f.createdAt = datetime()
      ON MATCH SET
        f.positioning = $positioning,
        f.pricePoint = $pricePoint,
        f.updatedAt = datetime()
      RETURN f.id as id
    `;

    await client.writeTransaction(familyQuery, {
      familyName: family.name,
      familyId,
      positioning: family.positioning,
      pricePoint: family.pricePoint,
    });
    result.createdNodes.push(familyId);
    result.operationsCount++;

    // Link GearItem to ProductFamily
    const variantRelQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (f:ProductFamily {name: $familyName})
      MERGE (g)-[r:IS_VARIANT_OF]->(f)
      SET r.createdAt = coalesce(r.createdAt, datetime())
      WITH g, f
      MERGE (f)-[r2:HAS_VARIANT]->(g)
      SET r2.createdAt = coalesce(r2.createdAt, datetime())
    `;

    await client.writeTransaction(variantRelQuery, { gearItemId, familyName: family.name });
    result.createdRelationships.push('IS_VARIANT_OF', 'HAS_VARIANT');
    result.operationsCount++;

    // If brand exists, link to family
    if (brandName) {
      const brandFamilyQuery = `
        MATCH (b:OutdoorBrand {name: $brandName}), (f:ProductFamily {name: $familyName})
        MERGE (b)-[r:MANUFACTURES]->(f)
        SET r.createdAt = coalesce(r.createdAt, datetime())
      `;
      await client.writeTransaction(brandFamilyQuery, { brandName, familyName: family.name });
      result.createdRelationships.push('MANUFACTURES');
      result.operationsCount++;
    }

    return result;
  }

  /**
   * Find or create Technology and link with USES_TECHNOLOGY
   */
  async linkToTechnology(
    gearItemId: string,
    tech: { name: string; description: string; performanceRatings?: Record<string, string | number> },
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const techId = `tech-${tech.name.toLowerCase().replace(/\s+/g, '-')}`;

    // Create or update Technology node
    const techQuery = `
      MERGE (t:Technology {name: $techName})
      ON CREATE SET
        t.id = $techId,
        t.description = $description,
        t.createdAt = datetime()
      ON MATCH SET
        t.description = coalesce($description, t.description),
        t.updatedAt = datetime()
      RETURN t.id as id
    `;

    await client.writeTransaction(techQuery, {
      techName: tech.name,
      techId,
      description: tech.description,
    });
    result.createdNodes.push(techId);
    result.operationsCount++;

    // Link GearItem to Technology
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (t:Technology {name: $techName})
      MERGE (g)-[r:USES_TECHNOLOGY]->(t)
      SET r.updatedAt = datetime()
    `;

    await client.writeTransaction(relQuery, { gearItemId, techName: tech.name });
    result.createdRelationships.push('USES_TECHNOLOGY');
    result.operationsCount++;

    return result;
  }

  /**
   * Find or create UsageScenario and link with SUITABLE_FOR
   */
  async linkToUsageScenario(
    gearItemId: string,
    scenario: { activity: string; suitability: string; notes?: string; priority?: number },
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const scenarioId = `scenario-${scenario.activity.toLowerCase().replace(/\s+/g, '-')}`;

    // Create or find UsageScenario node
    const scenarioQuery = `
      MERGE (u:UsageScenario {activity: $activity})
      ON CREATE SET
        u.id = $scenarioId,
        u.createdAt = datetime()
      RETURN u.id as id
    `;

    await client.writeTransaction(scenarioQuery, {
      activity: scenario.activity,
      scenarioId,
    });
    result.createdNodes.push(scenarioId);
    result.operationsCount++;

    // Link with suitability rating
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (u:UsageScenario {activity: $activity})
      MERGE (g)-[r:SUITABLE_FOR]->(u)
      SET r.suitability = $suitability,
          r.notes = $notes,
          r.priority = $priority,
          r.updatedAt = datetime()
    `;

    await client.writeTransaction(relQuery, {
      gearItemId,
      activity: scenario.activity,
      suitability: scenario.suitability,
      notes: scenario.notes ?? null,
      priority: scenario.priority ?? 1,
    });
    result.createdRelationships.push('SUITABLE_FOR');
    result.operationsCount++;

    return result;
  }

  /**
   * Create Insight node and link with HAS_TIP
   */
  async createInsight(
    gearItemId: string,
    insight: { type: string; content: string; sourceUrl?: string },
    workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const insightId = uuid();

    // Create Insight node
    const insightQuery = `
      CREATE (i:Insight {
        id: $insightId,
        type: $type,
        content: $content,
        sourceUrl: $sourceUrl,
        createdAt: datetime()
      })
      RETURN i.id as id
    `;

    await client.writeTransaction(insightQuery, {
      insightId,
      type: insight.type,
      content: insight.content,
      sourceUrl: insight.sourceUrl ?? null,
    });
    result.createdNodes.push(insightId);
    result.operationsCount++;

    // Link to GearItem
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (i:Insight {id: $insightId})
      CREATE (g)-[r:HAS_TIP]->(i)
      SET r.createdAt = datetime()
    `;

    await client.writeTransaction(relQuery, { gearItemId, insightId });
    result.createdRelationships.push('HAS_TIP');
    result.operationsCount++;

    // If source URL exists, create DataSource attribution
    if (insight.sourceUrl) {
      const sourceResult = await this.linkToDataSource(
        insightId,
        { url: insight.sourceUrl, title: 'Insight source', trustScore: 0.7, dataTypes: [insight.type] },
        workflowRunId,
        'Insight'
      );
      result.operationsCount += sourceResult.operationsCount;
      result.createdNodes.push(...sourceResult.createdNodes);
      result.createdRelationships.push(...sourceResult.createdRelationships);
    }

    return result;
  }

  /**
   * Create FeedbackPattern node and link with HAS_FEEDBACK
   */
  async createFeedbackPattern(
    gearItemId: string,
    feedback: { commonPraise: string[]; commonComplaints: string[]; overallSentiment?: string },
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const feedbackId = uuid();

    // Create FeedbackPattern node
    const feedbackQuery = `
      CREATE (f:FeedbackPattern {
        id: $feedbackId,
        commonPraise: $commonPraise,
        commonComplaints: $commonComplaints,
        overallSentiment: $sentiment,
        createdAt: datetime()
      })
      RETURN f.id as id
    `;

    await client.writeTransaction(feedbackQuery, {
      feedbackId,
      commonPraise: feedback.commonPraise,
      commonComplaints: feedback.commonComplaints,
      sentiment: feedback.overallSentiment ?? null,
    });
    result.createdNodes.push(feedbackId);
    result.operationsCount++;

    // Link to GearItem
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (f:FeedbackPattern {id: $feedbackId})
      CREATE (g)-[r:HAS_FEEDBACK]->(f)
      SET r.createdAt = datetime()
    `;

    await client.writeTransaction(relQuery, { gearItemId, feedbackId });
    result.createdRelationships.push('HAS_FEEDBACK');
    result.operationsCount++;

    return result;
  }

  /**
   * Create PerformanceContext node and link with HAS_PERFORMANCE_METRICS
   */
  async createPerformanceContext(
    gearItemId: string,
    metrics: NonNullable<ResearchFindings['performanceMetrics']>,
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const perfId = uuid();

    // Create PerformanceContext node
    const perfQuery = `
      CREATE (p:PerformanceContext {
        id: $perfId,
        durabilityRating: $durability,
        comfortRating: $comfort,
        weatherResistance: $weather,
        easeOfUseRating: $easeOfUse,
        packEfficiency: $packEfficiency,
        maintenanceRequirements: $maintenance,
        createdAt: datetime()
      })
      RETURN p.id as id
    `;

    await client.writeTransaction(perfQuery, {
      perfId,
      durability: metrics.durabilityRating ?? null,
      comfort: metrics.comfortRating ?? null,
      weather: metrics.weatherResistance ?? null,
      easeOfUse: metrics.easeOfUseRating ?? null,
      packEfficiency: metrics.packEfficiency ?? null,
      maintenance: metrics.maintenanceRequirements ?? null,
    });
    result.createdNodes.push(perfId);
    result.operationsCount++;

    // Link to GearItem
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (p:PerformanceContext {id: $perfId})
      CREATE (g)-[r:HAS_PERFORMANCE_METRICS]->(p)
      SET r.createdAt = datetime()
    `;

    await client.writeTransaction(relQuery, { gearItemId, perfId });
    result.createdRelationships.push('HAS_PERFORMANCE_METRICS');
    result.operationsCount++;

    return result;
  }

  /**
   * Create TemperatureRange node and link with HAS_TEMP_RANGE
   */
  async createTemperatureRange(
    gearItemId: string,
    tempRange: NonNullable<ResearchFindings['temperatureRange']>,
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const tempId = uuid();

    // Convert to Celsius if needed
    const minTempC = tempRange.unit === 'F'
      ? (tempRange.minTemp - 32) * (5 / 9)
      : tempRange.minTemp;
    const maxTempC = tempRange.unit === 'F'
      ? (tempRange.maxTemp - 32) * (5 / 9)
      : tempRange.maxTemp;

    // Create TemperatureRange node
    const tempQuery = `
      CREATE (t:TemperatureRange {
        id: $tempId,
        minTempCelsius: $minTemp,
        maxTempCelsius: $maxTemp,
        optimalRange: $optimalRange,
        reasoning: $reasoning,
        createdAt: datetime()
      })
      RETURN t.id as id
    `;

    await client.writeTransaction(tempQuery, {
      tempId,
      minTemp: minTempC,
      maxTemp: maxTempC,
      optimalRange: tempRange.optimalRange ?? null,
      reasoning: tempRange.reasoning ?? null,
    });
    result.createdNodes.push(tempId);
    result.operationsCount++;

    // Link to GearItem
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (t:TemperatureRange {id: $tempId})
      CREATE (g)-[r:HAS_TEMP_RANGE]->(t)
      SET r.createdAt = datetime()
    `;

    await client.writeTransaction(relQuery, { gearItemId, tempId });
    result.createdRelationships.push('HAS_TEMP_RANGE');
    result.operationsCount++;

    return result;
  }

  /**
   * Find or create WeatherCondition and link with PERFORMS_IN
   */
  async linkToWeatherCondition(
    gearItemId: string,
    weather: { condition: string; suitability: string; notes?: string },
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const weatherId = `weather-${weather.condition.toLowerCase().replace(/\s+/g, '-')}`;

    // Find or create WeatherCondition node
    const weatherQuery = `
      MERGE (w:WeatherCondition {name: $condition})
      ON CREATE SET
        w.id = $weatherId,
        w.createdAt = datetime()
      RETURN w.id as id
    `;

    await client.writeTransaction(weatherQuery, {
      condition: weather.condition,
      weatherId,
    });
    result.createdNodes.push(weatherId);
    result.operationsCount++;

    // Link with PERFORMS_IN
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (w:WeatherCondition {name: $condition})
      MERGE (g)-[r:PERFORMS_IN]->(w)
      SET r.suitability = $suitability,
          r.notes = $notes,
          r.updatedAt = datetime()
    `;

    await client.writeTransaction(relQuery, {
      gearItemId,
      condition: weather.condition,
      suitability: weather.suitability,
      notes: weather.notes ?? null,
    });
    result.createdRelationships.push('PERFORMS_IN');
    result.operationsCount++;

    return result;
  }

  /**
   * Find or create ProductType and link with IS_TYPE
   */
  async linkToProductType(
    gearItemId: string,
    productType: string,
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const typeId = `type-${productType.toLowerCase().replace(/\s+/g, '-')}`;

    // Find or create ProductType node
    const typeQuery = `
      MERGE (t:ProductType {name: $productType})
      ON CREATE SET
        t.id = $typeId,
        t.createdAt = datetime()
      RETURN t.id as id
    `;

    await client.writeTransaction(typeQuery, { productType, typeId });
    result.operationsCount++;

    // Link with IS_TYPE
    const relQuery = `
      MATCH (g:GearItem {id: $gearItemId}), (t:ProductType {name: $productType})
      MERGE (g)-[r:IS_TYPE]->(t)
      SET r.updatedAt = datetime()
    `;

    await client.writeTransaction(relQuery, { gearItemId, productType });
    result.createdRelationships.push('IS_TYPE');
    result.operationsCount++;

    return result;
  }

  /**
   * Create comparison relationship to another product
   */
  async createComparison(
    gearItemId: string,
    comparison: {
      targetName: string;
      type: 'COMPARE_TO' | 'ALTERNATIVE_TO' | 'PAIRS_WITH' | 'UPGRADE_PATH';
      difference?: string;
      useCase?: string;
      tradeoff?: string;
      reason?: string;
    },
    _workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    // Find target by name (case-insensitive partial match)
    const findQuery = `
      MATCH (target:GearItem)
      WHERE toLower(target.name) CONTAINS toLower($targetName)
      RETURN target.id as id
      LIMIT 1
    `;

    const targets = await client.readOnlyQuery<{ id: string }>(
      findQuery,
      { targetName: comparison.targetName }
    );

    if (targets.length === 0) {
      // Target not found, skip
      return result;
    }

    const targetId = targets[0]!.id;

    // Create relationship based on type
    const relQuery = `
      MATCH (source:GearItem {id: $gearItemId}), (target:GearItem {id: $targetId})
      MERGE (source)-[r:${comparison.type}]->(target)
      SET r.difference = $difference,
          r.useCase = $useCase,
          r.tradeoff = $tradeoff,
          r.reason = $reason,
          r.updatedAt = datetime()
    `;

    await client.writeTransaction(relQuery, {
      gearItemId,
      targetId,
      difference: comparison.difference ?? null,
      useCase: comparison.useCase ?? null,
      tradeoff: comparison.tradeoff ?? null,
      reason: comparison.reason ?? null,
    });
    result.createdRelationships.push(comparison.type);
    result.operationsCount++;

    return result;
  }

  /**
   * Find or create DataSource and link with HAS_DATA_SOURCE
   */
  async linkToDataSource(
    entityId: string,
    source: { url: string; title: string; trustScore: number; dataTypes: string[] },
    _workflowRunId: string,
    entityType: string = 'GearItem'
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    // Extract domain from URL for unique ID
    let domain: string;
    try {
      domain = new URL(source.url).hostname;
    } catch {
      domain = source.url.substring(0, 50);
    }
    const sourceId = `source-${domain.replace(/\./g, '-')}`;

    // Find or create DataSource node
    const sourceQuery = `
      MERGE (d:DataSource {url: $url})
      ON CREATE SET
        d.id = $sourceId,
        d.title = $title,
        d.domain = $domain,
        d.trustScore = $trustScore,
        d.createdAt = datetime()
      ON MATCH SET
        d.trustScore = CASE WHEN $trustScore > d.trustScore THEN $trustScore ELSE d.trustScore END,
        d.updatedAt = datetime()
      RETURN d.id as id
    `;

    await client.writeTransaction(sourceQuery, {
      url: source.url,
      sourceId,
      title: source.title,
      domain,
      trustScore: source.trustScore,
    });
    result.createdNodes.push(sourceId);
    result.operationsCount++;

    // Link to entity
    const relQuery = `
      MATCH (e:${entityType} {id: $entityId}), (d:DataSource {url: $url})
      MERGE (e)-[r:HAS_DATA_SOURCE]->(d)
      SET r.dateAttributed = datetime(),
          r.confidence = CASE WHEN $trustScore > 0.8 THEN 'high' ELSE 'medium' END,
          r.dataTypes = $dataTypes
    `;

    await client.writeTransaction(relQuery, {
      entityId,
      url: source.url,
      trustScore: source.trustScore,
      dataTypes: source.dataTypes.join(','),
    });
    result.createdRelationships.push('HAS_DATA_SOURCE');
    result.operationsCount++;

    return result;
  }

  /**
   * Execute a merge operation from Resolver
   */
  async executeMerge(
    primaryNodeId: string,
    secondaryNodeId: string,
    mergedProperties: Record<string, unknown>,
    workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    try {
      // 1. Get current state for audit
      const beforeQuery = `
        MATCH (n:GearItem {id: $nodeId})
        RETURN properties(n) as props
      `;
      const primaryBefore = await client.readOnlyQuery<{ props: Record<string, unknown> }>(
        beforeQuery,
        { nodeId: primaryNodeId }
      );
      const secondaryBefore = await client.readOnlyQuery<{ props: Record<string, unknown> }>(
        beforeQuery,
        { nodeId: secondaryNodeId }
      );

      // 2. Update primary node with merged properties
      const setClause = Object.keys(mergedProperties)
        .map(key => `n.${key} = $${key}`)
        .join(', ');

      if (setClause) {
        await client.writeTransaction(
          `MATCH (n:GearItem {id: $nodeId}) SET ${setClause}, n.mergedAt = datetime()`,
          { nodeId: primaryNodeId, ...mergedProperties }
        );
        result.operationsCount++;
      }

      // 3. Transfer relationships from secondary to primary
      const transferRelsQuery = `
        MATCH (secondary:GearItem {id: $secondaryId})-[r]->(target)
        WHERE NOT (target:GearItem AND target.id = $primaryId)
        WITH secondary, r, target, type(r) as relType, properties(r) as props
        MATCH (primary:GearItem {id: $primaryId})
        CALL {
          WITH primary, target, relType, props
          WITH primary, target, relType, props
          WHERE relType = 'PRODUCED_BY'
          MERGE (primary)-[newR:PRODUCED_BY]->(target)
          SET newR = props
          RETURN 1 as cnt
          UNION ALL
          WITH primary, target, relType, props
          WHERE relType = 'IS_VARIANT_OF'
          MERGE (primary)-[newR:IS_VARIANT_OF]->(target)
          SET newR = props
          RETURN 1 as cnt
          UNION ALL
          WITH primary, target, relType, props
          WHERE relType = 'USES_TECHNOLOGY'
          MERGE (primary)-[newR:USES_TECHNOLOGY]->(target)
          SET newR = props
          RETURN 1 as cnt
          UNION ALL
          WITH primary, target, relType, props
          WHERE relType = 'SUITABLE_FOR'
          MERGE (primary)-[newR:SUITABLE_FOR]->(target)
          SET newR = props
          RETURN 1 as cnt
          UNION ALL
          WITH primary, target, relType, props
          WHERE relType = 'HAS_TIP'
          MERGE (primary)-[newR:HAS_TIP]->(target)
          SET newR = props
          RETURN 1 as cnt
        }
        RETURN count(*) as transferred
      `;
      await client.writeTransaction(transferRelsQuery, {
        primaryId: primaryNodeId,
        secondaryId: secondaryNodeId,
      });
      result.operationsCount++;

      // 4. Delete secondary node
      await client.writeTransaction(
        'MATCH (n:GearItem {id: $nodeId}) DETACH DELETE n',
        { nodeId: secondaryNodeId }
      );
      result.operationsCount++;

      // 5. Audit log
      await this.auditLogger.logMerge(
        workflowRunId,
        'deep-deduplication',
        primaryNodeId,
        secondaryNodeId,
        primaryBefore[0]?.props ?? {},
        secondaryBefore[0]?.props ?? {},
        mergedProperties,
        { confidence: 1.0, reasoning: 'Curator executed merge' }
      );

      return result;
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  /**
   * Delete an orphan node
   */
  async deleteOrphan(
    nodeId: string,
    classification: string,
    workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    try {
      // Get node state before deletion
      const beforeQuery = `
        MATCH (n:GearItem {id: $nodeId})
        RETURN properties(n) as props
      `;
      const before = await client.readOnlyQuery<{ props: Record<string, unknown> }>(
        beforeQuery,
        { nodeId }
      );

      // Delete the node
      await client.writeTransaction(
        'MATCH (n:GearItem {id: $nodeId}) DETACH DELETE n',
        { nodeId }
      );
      result.operationsCount++;

      // Audit log
      await this.auditLogger.logDelete(
        workflowRunId,
        'morning-hygiene',
        nodeId,
        'GearItem',
        before[0]?.props ?? {},
        { confidence: 1.0, reasoning: `Deleted orphan with classification: ${classification}` }
      );

      return result;
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  /**
   * Create a new ProductFamily with variants
   */
  async createProductFamily(
    familyName: string,
    brandName: string,
    variantIds: string[],
    workflowRunId: string
  ): Promise<CurationResult> {
    const client = getMemgraphClient();
    const result: CurationResult = {
      success: true,
      operationsCount: 0,
      createdNodes: [],
      createdRelationships: [],
      errors: [],
    };

    const familyId = `family-${familyName.toLowerCase().replace(/\s+/g, '-')}`;

    // Create ProductFamily node
    const familyQuery = `
      MERGE (f:ProductFamily {name: $familyName})
      ON CREATE SET
        f.id = $familyId,
        f.createdAt = datetime()
      RETURN f.id as id
    `;

    await client.writeTransaction(familyQuery, { familyName, familyId });
    result.createdNodes.push(familyId);
    result.operationsCount++;

    // Link brand to family
    if (brandName) {
      const brandFamilyQuery = `
        MATCH (b:OutdoorBrand {name: $brandName}), (f:ProductFamily {name: $familyName})
        MERGE (b)-[r:MANUFACTURES]->(f)
        SET r.createdAt = coalesce(r.createdAt, datetime())
      `;
      await client.writeTransaction(brandFamilyQuery, { brandName, familyName });
      result.createdRelationships.push('MANUFACTURES');
      result.operationsCount++;
    }

    // Link all variants to family
    for (const variantId of variantIds) {
      const variantQuery = `
        MATCH (g:GearItem {id: $variantId}), (f:ProductFamily {name: $familyName})
        MERGE (g)-[r:IS_VARIANT_OF]->(f)
        SET r.createdAt = coalesce(r.createdAt, datetime())
        WITH g, f
        MERGE (f)-[r2:HAS_VARIANT]->(g)
        SET r2.createdAt = coalesce(r2.createdAt, datetime())
      `;
      await client.writeTransaction(variantQuery, { variantId, familyName });
      result.createdRelationships.push('IS_VARIANT_OF', 'HAS_VARIANT');
      result.operationsCount++;
    }

    // Audit log
    await this.auditLogger.logCreate(
      workflowRunId,
      'data-quality',
      familyId,
      'ProductFamily',
      { name: familyName, variantCount: variantIds.length },
      { confidence: 1.0, reasoning: `Created product family with ${variantIds.length} variants` }
    );

    return result;
  }

  /**
   * Helper: Convert weight to grams
   */
  private convertToGrams(value: number, unit: string): number {
    switch (unit.toLowerCase()) {
      case 'kg':
        return value * 1000;
      case 'lb':
      case 'lbs':
        return value * 453.592;
      case 'oz':
        return value * 28.3495;
      default:
        return value;
    }
  }

  // ============================================================================
  // Learning-Aware Operations (Phase 7)
  // ============================================================================

  /**
   * Execute enrichment with learning system integration
   * Consults memory before executing and learns from outcome
   */
  async enrichFromResearchWithLearning(
    nodeId: string,
    nodeName: string,
    findings: ResearchFindings,
    workflowRunId: string
  ): Promise<{ result: CurationResult; decision: DecisionResult }> {
    // Consult learning system before executing
    const curationRequest = {
      action: 'update_properties' as const,
      nodeId,
      data: {
        brand: findings.brand?.name,
        category: findings.productType,
        ...findings.specs,
      },
      source: {
        agent: 'researcher' as const,
        workflowRunId,
        confidence: findings.overallConfidence,
        reasoning: `Research from ${findings.sources.length} sources`,
      },
    };

    const decision = await makeInformedDecision(
      'curator',
      'enrich',
      nodeName,
      curationRequest,
      findings.overallConfidence
    );

    // Record the decision in episodic memory
    await recordEpisodicMemory({
      entityId: nodeId,
      entityName: nodeName,
      actionType: 'enrich',
      decision: decision.blocked
        ? 'skipped'
        : decision.autoApproved
          ? 'auto_approved'
          : 'human_approved',
      workflowRunId,
      confidence: findings.overallConfidence,
      reasoning: decision.reason,
    });

    // If blocked, return early
    if (decision.blocked) {
      return {
        result: {
          success: false,
          operationsCount: 0,
          createdNodes: [],
          createdRelationships: [],
          errors: [decision.reason || 'Blocked by correction rule'],
        },
        decision,
      };
    }

    // Execute the enrichment
    const result = await this.enrichFromResearch(nodeId, findings, workflowRunId);

    // Learn from successful operation
    if (result.success) {
      await learnFromSuccessfulOperation(
        nodeId,
        nodeName,
        'enrich',
        { brand: findings.brand?.name, category: findings.productType },
        {
          weightUnit: findings.specs?.weight?.unit,
          priceCurrency: findings.specs?.price?.currency,
          weight: findings.specs?.weight?.value,
          waterproofRating: findings.performanceMetrics?.weatherResistance,
        }
      );
    }

    return { result, decision };
  }

  /**
   * Execute merge with learning system integration
   */
  async executeMergeWithLearning(
    primaryNodeId: string,
    primaryNodeName: string,
    secondaryNodeId: string,
    secondaryNodeName: string,
    mergedProperties: Record<string, unknown>,
    similarity: number,
    workflowRunId: string
  ): Promise<{ result: CurationResult; decision: DecisionResult }> {
    // Consult learning system before executing
    const curationRequest = {
      action: 'merge_nodes' as const,
      nodeId: primaryNodeId,
      data: {
        secondaryNodeId,
        mergedProperties,
        similarity,
      },
      source: {
        agent: 'resolver' as const,
        workflowRunId,
        confidence: similarity,
        reasoning: `Merge candidates with ${(similarity * 100).toFixed(1)}% similarity`,
      },
    };

    const decision = await makeInformedDecision(
      'curator',
      'merge',
      primaryNodeName,
      curationRequest,
      similarity
    );

    // Record the decision
    await recordEpisodicMemory({
      entityId: primaryNodeId,
      entityName: `${primaryNodeName} + ${secondaryNodeName}`,
      actionType: 'merge',
      decision: decision.blocked
        ? 'skipped'
        : decision.autoApproved
          ? 'auto_approved'
          : 'human_approved',
      workflowRunId,
      confidence: similarity,
      reasoning: decision.reason,
      metadata: { secondaryNodeId, similarity },
    });

    // If blocked, return early
    if (decision.blocked) {
      return {
        result: {
          success: false,
          operationsCount: 0,
          createdNodes: [],
          createdRelationships: [],
          errors: [decision.reason || 'Blocked by correction rule'],
        },
        decision,
      };
    }

    // Execute the merge
    const result = await this.executeMerge(
      primaryNodeId,
      secondaryNodeId,
      mergedProperties,
      workflowRunId
    );

    return { result, decision };
  }

  /**
   * Execute delete with learning system integration
   */
  async deleteOrphanWithLearning(
    nodeId: string,
    nodeName: string,
    classification: string,
    confidence: number,
    workflowRunId: string
  ): Promise<{ result: CurationResult; decision: DecisionResult }> {
    // Consult learning system before executing
    const curationRequest = {
      action: 'delete_node' as const,
      nodeId,
      data: { classification },
      source: {
        agent: 'analyst' as const,
        workflowRunId,
        confidence,
        reasoning: `Orphan classification: ${classification}`,
      },
    };

    const decision = await makeInformedDecision(
      'curator',
      'delete',
      nodeName,
      curationRequest,
      confidence
    );

    // Record the decision
    await recordEpisodicMemory({
      entityId: nodeId,
      entityName: nodeName,
      actionType: 'delete',
      decision: decision.blocked
        ? 'skipped'
        : decision.autoApproved
          ? 'auto_approved'
          : 'human_approved',
      workflowRunId,
      confidence,
      reasoning: decision.reason,
      metadata: { classification },
    });

    // If blocked, return early
    if (decision.blocked) {
      return {
        result: {
          success: false,
          operationsCount: 0,
          createdNodes: [],
          createdRelationships: [],
          errors: [decision.reason || 'Blocked by correction rule'],
        },
        decision,
      };
    }

    // Execute the delete
    const result = await this.deleteOrphan(nodeId, classification, workflowRunId);

    return { result, decision };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let curatorInstance: CuratorAgent | null = null;

export function getCuratorAgent(): CuratorAgent {
  if (!curatorInstance) {
    curatorInstance = new CuratorAgent();
  }
  return curatorInstance;
}
