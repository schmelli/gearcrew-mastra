/**
 * T068: Enricher Agent
 * Implements FR-020: Agent for autonomous data enrichment
 */

import { z } from 'zod';
import { FirecrawlClient, GearSpecs } from '../tools/firecrawl/web-search';
import { ContentExtractor } from '../tools/firecrawl/content-extractor';
import { getAuditLogger } from '@/lib/audit-logger';
import { getMemgraphClient } from '../tools/memgraph/client';

// Configuration
const ENRICHMENT_CONFIG = {
  confidenceThreshold: 0.6, // Minimum confidence to apply enrichment
  maxSearchAttempts: 3,
  batchSize: 10,
  rateLimit: {
    requestsPerMinute: 30,
    delayMs: 2000,
  },
};

// Schemas
export const EnrichmentRequestSchema = z.object({
  nodeId: z.string(),
  nodeType: z.enum(['Product', 'Brand', 'Category']),
  currentData: z.record(z.unknown()),
  missingFields: z.array(z.string()),
  priority: z.number().min(0).max(1).default(0.5),
});

export type EnrichmentRequest = z.infer<typeof EnrichmentRequestSchema>;

export const EnrichmentResultSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  enrichedFields: z.array(z.string()),
  skippedFields: z.array(z.string()),
  confidence: z.number(),
  source: z.string().optional(),
  error: z.string().optional(),
  appliedAt: z.string().optional(),
});

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

/**
 * Enricher Agent for autonomous data enrichment
 */
export class EnricherAgent {
  private firecrawl: FirecrawlClient;
  private extractor: ContentExtractor;
  private rateLimitQueue: number[] = [];

  constructor() {
    this.firecrawl = new FirecrawlClient();
    this.extractor = new ContentExtractor();
  }

  /**
   * Enrich a single node with missing data
   */
  async enrichNode(request: EnrichmentRequest): Promise<EnrichmentResult> {
    const { nodeId, nodeType, currentData, missingFields } = request;

    // Check rate limit
    await this.waitForRateLimit();

    try {
      // Search for gear specifications
      const name = (currentData.name as string) || '';
      const brand = (currentData.brand as string) || undefined;

      if (!name) {
        return {
          nodeId,
          success: false,
          enrichedFields: [],
          skippedFields: missingFields,
          confidence: 0,
          error: 'Node has no name to search for',
        };
      }

      const searchResult = await this.firecrawl.searchGearSpecs(name, brand);

      if (!searchResult.success || !searchResult.specs) {
        return {
          nodeId,
          success: false,
          enrichedFields: [],
          skippedFields: missingFields,
          confidence: 0,
          error: searchResult.error || 'No specifications found',
        };
      }

      // Map found specs to missing fields
      const { enrichedFields, skippedFields, updates } = this.mapSpecsToFields(
        searchResult.specs,
        missingFields
      );

      // Check confidence threshold
      if ((searchResult.specs.confidence || 0) < ENRICHMENT_CONFIG.confidenceThreshold) {
        return {
          nodeId,
          success: false,
          enrichedFields: [],
          skippedFields: missingFields,
          confidence: searchResult.specs.confidence || 0,
          source: searchResult.sources?.[0],
          error: `Confidence ${searchResult.specs.confidence} below threshold ${ENRICHMENT_CONFIG.confidenceThreshold}`,
        };
      }

      // Apply updates to graph
      if (enrichedFields.length > 0) {
        await this.applyEnrichment(nodeId, nodeType, updates);
      }

      return {
        nodeId,
        success: enrichedFields.length > 0,
        enrichedFields,
        skippedFields,
        confidence: searchResult.specs.confidence || 0,
        source: searchResult.sources?.[0],
        appliedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        nodeId,
        success: false,
        enrichedFields: [],
        skippedFields: missingFields,
        confidence: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Process a batch of nodes for enrichment
   */
  async enrichBatch(requests: EnrichmentRequest[]): Promise<EnrichmentResult[]> {
    const results: EnrichmentResult[] = [];

    // Sort by priority (highest first)
    const sorted = [...requests].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const request of sorted) {
      const result = await this.enrichNode(request);
      results.push(result);

      // Log result
      const logger = getAuditLogger();
      if (result.success) {
        await logger.logUpdate(
          'gap-filling',
          'gap-filling',
          request.nodeId,
          request.nodeType,
          { enrichedFields: result.enrichedFields },
          result.enrichedFields.reduce(
            (acc, f) => ({ ...acc, [f]: null }),
            {}
          ),
          `Enriched ${result.enrichedFields.length} fields from ${result.source}`,
          { confidence: result.confidence }
        );
      } else {
        await logger.logSkip('gap-filling', 'gap-filling', request.nodeId, request.nodeType, result.error, {
          confidence: result.confidence,
        });
      }

      // Delay between requests
      await new Promise((r) => setTimeout(r, ENRICHMENT_CONFIG.rateLimit.delayMs));
    }

    return results;
  }

  /**
   * Find nodes that need enrichment based on centrality
   */
  async findNodesNeedingEnrichment(options?: {
    nodeType?: string;
    limit?: number;
    minCentrality?: number;
  }): Promise<EnrichmentRequest[]> {
    const client = getMemgraphClient();
    const { nodeType = 'Product', limit = 50, minCentrality = 0 } = options || {};

    // Query for nodes with missing fields, ordered by centrality
    const query = `
      MATCH (n:${nodeType})
      WHERE n.weight_grams IS NULL
         OR n.price IS NULL
         OR n.brand IS NULL
      WITH n, size((n)--()) as degree
      WHERE degree >= $minCentrality
      RETURN n.id as nodeId,
             n.name as name,
             n.brand as brand,
             n.weight_grams as weight,
             n.price as price,
             n.dimensions_cm as dimensions,
             n.capacity_liters as capacity,
             degree
      ORDER BY degree DESC
      LIMIT $limit
    `;

    const result = await client.executeRead(query, { minCentrality, limit });

    return result.records.map((record) => {
      const missingFields: string[] = [];
      if (!record.get('weight')) missingFields.push('weight');
      if (!record.get('price')) missingFields.push('price');
      if (!record.get('dimensions')) missingFields.push('dimensions');
      if (!record.get('capacity')) missingFields.push('capacity');

      const degree = record.get('degree').toNumber?.() || record.get('degree');
      const maxDegree = 100; // Normalize to 0-1 range

      return {
        nodeId: record.get('nodeId'),
        nodeType: nodeType as 'Product' | 'Brand' | 'Category',
        currentData: {
          name: record.get('name'),
          brand: record.get('brand'),
          weight: record.get('weight'),
          price: record.get('price'),
          dimensions: record.get('dimensions'),
          capacity: record.get('capacity'),
        },
        missingFields,
        priority: Math.min(degree / maxDegree, 1),
      };
    });
  }

  /**
   * Map extracted specs to node fields
   */
  private mapSpecsToFields(
    specs: GearSpecs,
    missingFields: string[]
  ): {
    enrichedFields: string[];
    skippedFields: string[];
    updates: Record<string, unknown>;
  } {
    const enrichedFields: string[] = [];
    const skippedFields: string[] = [];
    const updates: Record<string, unknown> = {};

    for (const field of missingFields) {
      switch (field) {
        case 'weight':
          if (specs.weight) {
            // Convert to grams
            const grams = this.convertToGrams(specs.weight.value, specs.weight.unit);
            updates.weight_grams = grams;
            enrichedFields.push('weight');
          } else {
            skippedFields.push('weight');
          }
          break;

        case 'price':
          if (specs.price) {
            updates.price = specs.price.value;
            updates.price_currency = specs.price.currency;
            enrichedFields.push('price');
          } else {
            skippedFields.push('price');
          }
          break;

        case 'dimensions':
          if (specs.dimensions) {
            // Convert to cm
            const cm = this.convertToCm(specs.dimensions);
            updates.dimensions_cm = cm;
            enrichedFields.push('dimensions');
          } else {
            skippedFields.push('dimensions');
          }
          break;

        case 'capacity':
          if (specs.capacity) {
            // Convert to liters
            const liters = this.convertToLiters(specs.capacity.value, specs.capacity.unit);
            updates.capacity_liters = liters;
            enrichedFields.push('capacity');
          } else {
            skippedFields.push('capacity');
          }
          break;

        case 'temperature':
          if (specs.temperatureRating) {
            // Convert to Celsius
            const celsius = this.convertToCelsius(
              specs.temperatureRating.value,
              specs.temperatureRating.unit
            );
            updates.temperature_rating_celsius = celsius;
            enrichedFields.push('temperature');
          } else {
            skippedFields.push('temperature');
          }
          break;

        case 'materials':
          if (specs.materials && specs.materials.length > 0) {
            updates.materials = specs.materials;
            enrichedFields.push('materials');
          } else {
            skippedFields.push('materials');
          }
          break;

        case 'brand':
          if (specs.brand) {
            updates.brand = specs.brand;
            enrichedFields.push('brand');
          } else {
            skippedFields.push('brand');
          }
          break;

        default:
          skippedFields.push(field);
      }
    }

    // Add metadata
    if (enrichedFields.length > 0) {
      updates.last_enriched_at = new Date().toISOString();
      updates.enrichment_source = specs.sourceUrl;
      updates.enrichment_confidence = specs.confidence;
    }

    return { enrichedFields, skippedFields, updates };
  }

  /**
   * Apply enrichment updates to the graph
   */
  private async applyEnrichment(
    nodeId: string,
    nodeType: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    const client = getMemgraphClient();

    // Build SET clause
    const setClause = Object.keys(updates)
      .map((key) => `n.${key} = $${key}`)
      .join(', ');

    const query = `
      MATCH (n:${nodeType} {id: $nodeId})
      SET ${setClause}
      RETURN n
    `;

    await client.executeWrite(query, { nodeId, ...updates });
  }

  /**
   * Wait for rate limit
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = 60000; // 1 minute

    // Clean old timestamps
    this.rateLimitQueue = this.rateLimitQueue.filter((t) => now - t < windowMs);

    // Check if at limit
    if (this.rateLimitQueue.length >= ENRICHMENT_CONFIG.rateLimit.requestsPerMinute) {
      const oldestRequest = this.rateLimitQueue[0]!;
      const waitTime = windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }

    // Record this request
    this.rateLimitQueue.push(Date.now());
  }

  /**
   * Unit conversion helpers
   */
  private convertToGrams(value: number, unit: string): number {
    switch (unit.toLowerCase()) {
      case 'kg':
        return value * 1000;
      case 'lb':
        return value * 453.592;
      case 'oz':
        return value * 28.3495;
      default:
        return value;
    }
  }

  private convertToCm(dimensions: {
    length: number;
    width: number;
    height?: number;
    unit: string;
  }): { length: number; width: number; height?: number } {
    const multiplier = dimensions.unit === 'in' ? 2.54 : dimensions.unit === 'mm' ? 0.1 : 1;
    return {
      length: dimensions.length * multiplier,
      width: dimensions.width * multiplier,
      height: dimensions.height ? dimensions.height * multiplier : undefined,
    };
  }

  private convertToLiters(value: number, unit: string): number {
    switch (unit.toLowerCase()) {
      case 'ml':
        return value / 1000;
      case 'cu in':
        return value * 0.0163871;
      default:
        return value;
    }
  }

  private convertToCelsius(value: number, unit: string): number {
    if (unit === 'F') {
      return (value - 32) * (5 / 9);
    }
    return value;
  }
}

/**
 * Create singleton instance
 */
let enricherInstance: EnricherAgent | null = null;

export function getEnricherAgent(): EnricherAgent {
  if (!enricherInstance) {
    enricherInstance = new EnricherAgent();
  }
  return enricherInstance;
}
