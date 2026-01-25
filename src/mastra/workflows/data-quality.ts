/**
 * Data Quality Workflow
 * Handles product family detection and generic item cleanup
 *
 * Features:
 * 1. Product Family Detection - Groups items with same name but different variants
 * 2. Generic Item Cleanup - Verifies/enriches items without proper brands
 */

import { randomUUID } from 'crypto';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getAuditLogger } from '@/lib/audit-logger';
import { registerWorkflow } from '../index';
import { FirecrawlClient } from '../tools/firecrawl/web-search';
import { getAnalystAgent, FlaggedItem } from '../agents/analyst';
import { getResearcherAgent } from '../agents/researcher';
import { getCuratorAgent } from '../agents/curator';

// ============================================================================
// Types
// ============================================================================

interface DataQualityInput {
  workflowRunId?: string;
  tasks?: Array<'productFamilies' | 'genericCleanup' | 'agentPipeline'>;
  dryRun?: boolean;
  limit?: number;
  useAgentPipeline?: boolean; // Enable new agent-based processing
}

interface DataQualityOutput {
  workflowRunId: string;
  status: 'completed' | 'failed';
  productFamilies: {
    detected: number;
    created: number;
    items: Array<{ familyName: string; memberCount: number }>;
  };
  genericCleanup: {
    analyzed: number;
    enriched: number;
    deleted: number;
    flagged: number;
    items: Array<{ name: string; action: string; brand?: string }>;
  };
  agentPipeline?: {
    triaged: number;
    researched: number;
    curated: number;
    deleted: number;
    skipped: number;
    items: Array<{
      nodeId: string;
      name: string;
      action: 'researched' | 'curated' | 'deleted' | 'skipped' | 'review';
      priority: string;
      nodesCreated?: number;
      relationshipsCreated?: number;
    }>;
  };
  duration: number;
}

interface ProductFamilyCandidate {
  baseName: string;
  brand: string;
  members: Array<{
    nodeId: string;
    name: string;
    variant: string;
  }>;
}

interface GenericItemCandidate {
  nodeId: string;
  name: string;
  currentBrand: string | null;
}

// ============================================================================
// Product Family Detection
// ============================================================================

/**
 * Detect product families by finding items with similar names but different variants
 * Examples: "Ides -5° Mummy" and "Ides +5° Mummy" → Family "Ides Mummy"
 */
async function detectProductFamilies(
  workflowRunId: string,
  dryRun: boolean,
  limit: number = 100
): Promise<DataQualityOutput['productFamilies']> {
  const client = getMemgraphClient();
  const auditLogger = getAuditLogger();
  const result: DataQualityOutput['productFamilies'] = {
    detected: 0,
    created: 0,
    items: [],
  };

  // Find items with temperature variants (most common case)
  // Pattern: Same brand + similar name structure with different temp ratings
  const tempVariantQuery = `
    MATCH (g:GearItem)
    WHERE g.brand IS NOT NULL
      AND g.name IS NOT NULL
      AND (g.name CONTAINS '°' OR g.name CONTAINS 'deg')
    WITH g.brand AS brand, g
    ORDER BY brand, g.name
    RETURN brand,
           collect({
             nodeId: COALESCE(g.id, g.gearId, toString(id(g))),
             name: g.name
           }) AS items
    LIMIT toInteger($limit)
  `;

  const brandGroups = await client.readOnlyQuery<{
    brand: string;
    items: Array<{ nodeId: string; name: string }>;
  }>(tempVariantQuery, { limit: Math.floor(limit) });

  const families: ProductFamilyCandidate[] = [];

  for (const group of brandGroups) {
    // Extract base names by removing temperature/variant patterns
    const itemsByBaseName = new Map<string, Array<{ nodeId: string; name: string; variant: string }>>();

    for (const item of group.items) {
      // Extract base name by removing temperature ratings
      // Patterns: -5°, +10°F, 20°C, -15 °C, etc.
      const baseName = extractBaseName(item.name);
      const variant = extractVariant(item.name);

      if (!itemsByBaseName.has(baseName)) {
        itemsByBaseName.set(baseName, []);
      }
      itemsByBaseName.get(baseName)!.push({
        nodeId: item.nodeId,
        name: item.name,
        variant,
      });
    }

    // Only consider groups with 2+ members as families
    for (const [baseName, members] of itemsByBaseName) {
      if (members.length >= 2) {
        families.push({
          baseName,
          brand: group.brand,
          members,
        });
      }
    }
  }

  result.detected = families.length;

  // Create ProductFamily nodes and relationships
  for (const family of families) {
    try {
      const familyId = `family-${family.brand.toLowerCase().replace(/\s+/g, '-')}-${family.baseName.toLowerCase().replace(/\s+/g, '-')}`;
      const familyName = `${family.brand} ${family.baseName}`;

      if (!dryRun) {
        // Create or update ProductFamily node
        const createFamilyQuery = `
          MERGE (f:ProductFamily {id: $familyId})
          SET f.name = $familyName,
              f.brand = $brand,
              f.baseName = $baseName,
              f.memberCount = $memberCount,
              f.updatedAt = datetime()
          RETURN f.id AS id
        `;
        await client.writeTransaction(createFamilyQuery, {
          familyId,
          familyName,
          brand: family.brand,
          baseName: family.baseName,
          memberCount: family.members.length,
        });

        // Create VARIANT_OF relationships
        for (const member of family.members) {
          const linkQuery = `
            MATCH (g:GearItem), (f:ProductFamily {id: $familyId})
            WHERE g.id = $nodeId OR g.gearId = $nodeId OR toString(id(g)) = $nodeId
            MERGE (g)-[r:VARIANT_OF]->(f)
            SET r.variant = $variant,
                r.createdAt = datetime()
            RETURN r
          `;
          await client.writeTransaction(linkQuery, {
            familyId,
            nodeId: member.nodeId,
            variant: member.variant,
          });
        }

        // Audit log
        await auditLogger.logUpdate(
          workflowRunId,
          'data-quality',
          familyId,
          'ProductFamily',
          {},
          { name: familyName, memberCount: family.members.length },
          {
            confidence: 0.9,
            reasoning: `Created product family grouping ${family.members.length} variants`,
          }
        );

        result.created++;
      }

      result.items.push({
        familyName,
        memberCount: family.members.length,
      });
    } catch (error) {
      console.error(`Failed to create product family for ${family.baseName}:`, error);
    }
  }

  if (result.detected > 0) {
    console.info(`Detected ${result.detected} product families, created ${result.created}`);
  }

  return result;
}

/**
 * Extract base name by removing temperature/size/color variants
 */
function extractBaseName(name: string): string {
  return name
    // Remove temperature patterns: -5°, +10°F, 20°C, -15 °C, etc.
    .replace(/[+-]?\d+\s*°?\s*[FCfc]?\b/g, '')
    // Remove size indicators: S, M, L, XL, Regular, Long, Wide
    .replace(/\b(XXS|XS|S|M|L|XL|XXL|XXXL|Regular|Long|Short|Wide|Narrow)\b/gi, '')
    // Remove color indicators (common colors)
    .replace(/\b(Black|White|Grey|Gray|Red|Blue|Green|Yellow|Orange|Purple|Pink|Brown|Olive|Navy|Tan)\b/gi, '')
    // Clean up extra spaces and punctuation
    .replace(/\s+/g, ' ')
    .replace(/\s*[-/]\s*$/g, '')
    .trim();
}

/**
 * Extract variant identifier from name
 */
function extractVariant(name: string): string {
  const variants: string[] = [];

  // Temperature
  const tempMatch = name.match(/([+-]?\d+)\s*°?\s*([FCfc])?/);
  if (tempMatch) {
    variants.push(`${tempMatch[1]}°${tempMatch[2]?.toUpperCase() || ''}`);
  }

  // Size
  const sizeMatch = name.match(/\b(XXS|XS|S|M|L|XL|XXL|XXXL|Regular|Long|Short|Wide|Narrow)\b/i);
  if (sizeMatch && sizeMatch[1]) {
    variants.push(sizeMatch[1]);
  }

  return variants.join(' ') || 'Standard';
}

// ============================================================================
// Generic Item Cleanup
// ============================================================================

/**
 * Find and process generic items (Unknown/Generic/null brands)
 * Uses web search to verify if item name might be a brand
 */
async function cleanupGenericItems(
  workflowRunId: string,
  dryRun: boolean,
  limit: number = 50
): Promise<DataQualityOutput['genericCleanup']> {
  const client = getMemgraphClient();
  const auditLogger = getAuditLogger();
  const firecrawl = new FirecrawlClient();

  const result: DataQualityOutput['genericCleanup'] = {
    analyzed: 0,
    enriched: 0,
    deleted: 0,
    flagged: 0,
    items: [],
  };

  // Find items with Unknown/Generic/null brands
  const genericQuery = `
    MATCH (g:GearItem)
    WHERE g.brand IS NULL
       OR g.brand = ''
       OR g.brand = 'Unknown'
       OR g.brand = 'Generic'
       OR g.brand = 'unknown'
       OR g.brand = 'generic'
    RETURN COALESCE(g.id, g.gearId, toString(id(g))) AS nodeId,
           g.name AS name,
           g.brand AS currentBrand
    LIMIT toInteger($limit)
  `;

  const genericItems = await client.readOnlyQuery<GenericItemCandidate>(genericQuery, { limit: Math.floor(limit) });

  console.info(`Found ${genericItems.length} generic items to analyze`);

  for (const item of genericItems) {
    result.analyzed++;

    try {
      // Determine if this is a brand or generic term
      const analysis = await analyzeItemName(item.name, firecrawl);

      if (analysis.isBrand) {
        // The item name contains or is a brand - enrich it
        if (!dryRun) {
          const enrichQuery = `
            MATCH (g:GearItem)
            WHERE g.id = $nodeId OR g.gearId = $nodeId OR toString(id(g)) = $nodeId
            SET g.brand = $brand,
                g.enrichedAt = datetime(),
                g.enrichmentSource = 'web-search'
            RETURN g.name AS name
          `;
          await client.writeTransaction(enrichQuery, {
            nodeId: item.nodeId,
            brand: analysis.brand,
          });

          await auditLogger.logUpdate(
            workflowRunId,
            'data-quality',
            item.nodeId,
            'GearItem',
            { brand: item.currentBrand },
            { brand: analysis.brand },
            {
              confidence: analysis.confidence,
              reasoning: `Identified brand "${analysis.brand}" via web search: ${analysis.reason}`,
            }
          );
        }

        result.enriched++;
        result.items.push({
          name: item.name,
          action: 'enriched',
          brand: analysis.brand,
        });
      } else if (analysis.isGeneric) {
        // This is truly a generic item - flag for deletion
        if (!dryRun) {
          await auditLogger.logFlag(
            workflowRunId,
            'data-quality',
            item.nodeId,
            'GearItem',
            {
              confidence: analysis.confidence,
              reasoning: `Generic item without brand: ${analysis.reason}. Suggested: delete`,
            }
          );
        }

        result.flagged++;
        result.items.push({
          name: item.name,
          action: 'flagged-for-deletion',
        });
      } else {
        // Uncertain - flag for review
        if (!dryRun) {
          await auditLogger.logFlag(
            workflowRunId,
            'data-quality',
            item.nodeId,
            'GearItem',
            {
              confidence: analysis.confidence,
              reasoning: `Needs manual review: ${analysis.reason}. Suggested: review`,
            }
          );
        }

        result.flagged++;
        result.items.push({
          name: item.name,
          action: 'flagged-for-review',
        });
      }
    } catch (error) {
      console.error(`Failed to analyze item ${item.name}:`, error);
    }

    // Rate limiting for API calls
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.info(`Generic cleanup: analyzed=${result.analyzed}, enriched=${result.enriched}, flagged=${result.flagged}`);

  return result;
}

/**
 * Analyze an item name to determine if it's a brand or generic term
 */
async function analyzeItemName(
  name: string,
  firecrawl: FirecrawlClient
): Promise<{
  isBrand: boolean;
  isGeneric: boolean;
  brand?: string;
  confidence: number;
  reason: string;
}> {
  // Known generic terms that are definitely not brands
  const genericTerms = [
    'water bottle', 'bottle', 'cup', 'mug', 'spoon', 'fork', 'knife', 'spork',
    'towel', 'cloth', 'rag', 'sponge', 'soap', 'shampoo', 'toothbrush',
    'beanie', 'hat', 'cap', 'gloves', 'socks', 'underwear', 'boxers', 'briefs',
    'pants', 'shorts', 'shirt', 't-shirt', 'jacket', 'fleece', 'hoodie',
    'tent stakes', 'stakes', 'guylines', 'cord', 'rope', 'strap', 'buckle',
    'carabiner', 'clip', 'hook', 'loop', 'elastic', 'velcro',
    'bandana', 'scarf', 'buff', 'gaiter', 'balaclava',
    'lighter', 'matches', 'fire starter', 'tinder',
    'first aid', 'bandages', 'band-aids', 'tape', 'gauze', 'antiseptic',
    'sunscreen', 'lip balm', 'bug spray', 'insect repellent',
    'headlamp', 'flashlight', 'lantern',
    'compass', 'map', 'whistle', 'mirror',
    'stuff sack', 'dry bag', 'compression sack',
    'pillow', 'eye mask', 'ear plugs',
  ];

  const lowerName = name.toLowerCase();

  // Check if it's a known generic term
  for (const term of genericTerms) {
    if (lowerName === term || lowerName.includes(term)) {
      return {
        isBrand: false,
        isGeneric: true,
        confidence: 0.95,
        reason: `Matches generic term "${term}"`,
      };
    }
  }

  // Known brands that might be confused (like "Buff" which is actually a brand)
  const knownBrands: Record<string, string> = {
    'buff': 'BUFF',
    'nalgene': 'Nalgene',
    'camelbak': 'CamelBak',
    'klean kanteen': 'Klean Kanteen',
    'hydroflask': 'Hydro Flask',
    'jetboil': 'Jetboil',
    'msr': 'MSR',
    'lifestraw': 'LifeStraw',
    'sawyer': 'Sawyer',
    'petzl': 'Petzl',
    'black diamond': 'Black Diamond',
    'sea to summit': 'Sea to Summit',
    'osprey': 'Osprey',
    'gregory': 'Gregory',
    'deuter': 'Deuter',
  };

  // Check known brands
  for (const [key, brand] of Object.entries(knownBrands)) {
    if (lowerName.includes(key)) {
      return {
        isBrand: true,
        isGeneric: false,
        brand,
        confidence: 0.95,
        reason: `Recognized brand "${brand}"`,
      };
    }
  }

  // Web search to verify
  try {
    const searchQuery = `"${name}" outdoor gear brand company`;
    const searchResult = await firecrawl.search(searchQuery, {
      limit: 3,
    });

    if (searchResult.success && searchResult.results.length > 0) {
      // Analyze search results for brand indicators
      const combinedContent = searchResult.results
        .map(r => `${r.title} ${r.description || ''}`)
        .join(' ')
        .toLowerCase();

      // Look for brand indicators
      const brandIndicators = [
        'brand', 'company', 'manufacturer', 'made by', 'official',
        'founded', 'headquarters', '®', '™', 'inc', 'llc', 'ltd',
      ];

      let brandScore = 0;
      for (const indicator of brandIndicators) {
        if (combinedContent.includes(indicator)) {
          brandScore++;
        }
      }

      // Look for generic indicators
      const genericIndicators = [
        'generic', 'no-name', 'unbranded', 'any brand', 'various',
      ];

      let genericScore = 0;
      for (const indicator of genericIndicators) {
        if (combinedContent.includes(indicator)) {
          genericScore++;
        }
      }

      if (brandScore > genericScore && brandScore >= 2) {
        // Try to extract brand name from first word(s)
        const words = name.split(' ');
        const potentialBrand = words[0];

        return {
          isBrand: true,
          isGeneric: false,
          brand: potentialBrand,
          confidence: Math.min(0.5 + brandScore * 0.1, 0.85),
          reason: `Web search found ${brandScore} brand indicators`,
        };
      } else if (genericScore > brandScore) {
        return {
          isBrand: false,
          isGeneric: true,
          confidence: Math.min(0.5 + genericScore * 0.1, 0.85),
          reason: `Web search found ${genericScore} generic indicators`,
        };
      }
    }
  } catch (error) {
    console.warn(`Web search failed for "${name}":`, error);
  }

  // Uncertain - needs manual review
  return {
    isBrand: false,
    isGeneric: false,
    confidence: 0.3,
    reason: 'Could not determine - needs manual review',
  };
}

// ============================================================================
// Agent Pipeline Processing (NEW)
// ============================================================================

/**
 * Process items using the new agent pipeline
 * Flow: Analyst (triage) -> Researcher (gather data) -> Curator (write to graph)
 */
async function processWithAgentPipeline(
  workflowRunId: string,
  dryRun: boolean,
  limit: number
): Promise<NonNullable<DataQualityOutput['agentPipeline']>> {
  const analyst = getAnalystAgent();
  const researcher = getResearcherAgent();
  const curator = getCuratorAgent();
  const auditLogger = getAuditLogger();

  const result: NonNullable<DataQualityOutput['agentPipeline']> = {
    triaged: 0,
    researched: 0,
    curated: 0,
    deleted: 0,
    skipped: 0,
    items: [],
  };

  console.info(`[Agent Pipeline] Starting with limit=${limit}, dryRun=${dryRun}`);

  // Step 1: Find items needing enrichment using Analyst
  const itemsNeedingEnrichment = await analyst.findItemsNeedingEnrichment({
    limit,
    maxCompleteness: 0.7,
  });

  console.info(`[Agent Pipeline] Found ${itemsNeedingEnrichment.length} items needing enrichment`);

  // Convert to FlaggedItem format for triage
  const flaggedItems: FlaggedItem[] = itemsNeedingEnrichment.map(item => ({
    nodeId: item.nodeId,
    name: item.name,
    brand: item.brand,
    category: item.category,
    flagReason: item.flagReason,
  }));

  // Step 2: Triage flagged items
  const triageResults = await analyst.triageFlaggedItems(flaggedItems);
  result.triaged = triageResults.length;

  console.info(`[Agent Pipeline] Triaged ${triageResults.length} items`);

  // Group by recommended action
  const toResearch = triageResults.filter(t => t.recommendedAction === 'research');
  const toDelete = triageResults.filter(t => t.recommendedAction === 'delete');
  const toReview = triageResults.filter(t => t.recommendedAction === 'review');
  const toSkip = triageResults.filter(t => t.recommendedAction === 'skip');

  console.info(`[Agent Pipeline] Triage results: research=${toResearch.length}, delete=${toDelete.length}, review=${toReview.length}, skip=${toSkip.length}`);

  // Step 3: Research items marked for research
  for (const item of toResearch) {
    const originalItem = flaggedItems.find(f => f.nodeId === item.itemId);
    if (!originalItem) continue;

    try {
      console.info(`[Agent Pipeline] Researching: ${item.itemName}`);

      // Use Researcher to gather comprehensive data
      const findings = await researcher.researchItem({
        nodeId: item.itemId,
        nodeName: item.itemName,
        brand: originalItem.brand,
        category: originalItem.category,
        missingFields: ['brand', 'weight', 'price', 'category'],
        priority: item.priorityScore / 100,
      });

      result.researched++;

      if (findings.success && findings.overallConfidence >= 0.6) {
        // Step 4: Apply via Curator
        if (!dryRun) {
          const curationResult = await curator.enrichFromResearch(
            item.itemId,
            findings,
            workflowRunId
          );

          if (curationResult.success) {
            result.curated++;
            result.items.push({
              nodeId: item.itemId,
              name: item.itemName,
              action: 'curated',
              priority: item.priority,
              nodesCreated: curationResult.createdNodes.length,
              relationshipsCreated: curationResult.createdRelationships.length,
            });

            console.info(`[Agent Pipeline] Curated ${item.itemName}: ${curationResult.operationsCount} operations`);
          } else {
            result.items.push({
              nodeId: item.itemId,
              name: item.itemName,
              action: 'researched',
              priority: item.priority,
            });
          }
        } else {
          result.items.push({
            nodeId: item.itemId,
            name: item.itemName,
            action: 'researched',
            priority: item.priority,
          });
          console.info(`[Agent Pipeline] [DRY RUN] Would curate ${item.itemName}`);
        }
      } else {
        // Research didn't yield enough confidence
        result.items.push({
          nodeId: item.itemId,
          name: item.itemName,
          action: 'review',
          priority: item.priority,
        });
        console.info(`[Agent Pipeline] Low confidence for ${item.itemName}, flagging for review`);
      }
    } catch (error) {
      console.error(`[Agent Pipeline] Error processing ${item.itemName}:`, error);
      result.items.push({
        nodeId: item.itemId,
        name: item.itemName,
        action: 'review',
        priority: item.priority,
      });
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  // Step 5: Delete items marked for deletion
  for (const item of toDelete) {
    if (!dryRun) {
      try {
        const deleteResult = await curator.deleteOrphan(
          item.itemId,
          'orphan_low_completeness',
          workflowRunId
        );

        if (deleteResult.success) {
          result.deleted++;
          result.items.push({
            nodeId: item.itemId,
            name: item.itemName,
            action: 'deleted',
            priority: item.priority,
          });
          console.info(`[Agent Pipeline] Deleted orphan: ${item.itemName}`);
        }
      } catch (error) {
        console.error(`[Agent Pipeline] Error deleting ${item.itemName}:`, error);
      }
    } else {
      result.deleted++;
      result.items.push({
        nodeId: item.itemId,
        name: item.itemName,
        action: 'deleted',
        priority: item.priority,
      });
      console.info(`[Agent Pipeline] [DRY RUN] Would delete: ${item.itemName}`);
    }
  }

  // Step 6: Log items for review
  for (const item of toReview) {
    if (!dryRun) {
      await auditLogger.logFlag(
        workflowRunId,
        'data-quality',
        item.itemId,
        'GearItem',
        {
          confidence: item.priorityScore / 100,
          reasoning: `${item.reasoning}. Suggested: review`,
        }
      );
    }
    result.items.push({
      nodeId: item.itemId,
      name: item.itemName,
      action: 'review',
      priority: item.priority,
    });
  }

  // Step 7: Record skipped items
  for (const item of toSkip) {
    result.skipped++;
    result.items.push({
      nodeId: item.itemId,
      name: item.itemName,
      action: 'skipped',
      priority: item.priority,
    });
  }

  console.info(`[Agent Pipeline] Complete: researched=${result.researched}, curated=${result.curated}, deleted=${result.deleted}, skipped=${result.skipped}`);

  return result;
}

// ============================================================================
// Main Workflow Execution
// ============================================================================

export async function executeDataQualityWorkflow(
  options?: DataQualityInput
): Promise<DataQualityOutput> {
  const startTime = Date.now();
  const workflowRunId = options?.workflowRunId ?? randomUUID();
  const dryRun = options?.dryRun ?? false;
  const limit = typeof options?.limit === 'number' ? Math.floor(options.limit) : 100;
  const tasks = options?.tasks ?? ['productFamilies', 'genericCleanup'];
  const useAgentPipeline = options?.useAgentPipeline ?? false;

  console.info(`Starting data quality workflow: ${workflowRunId} (useAgentPipeline=${useAgentPipeline})`);

  const output: DataQualityOutput = {
    workflowRunId,
    status: 'completed',
    productFamilies: { detected: 0, created: 0, items: [] },
    genericCleanup: { analyzed: 0, enriched: 0, deleted: 0, flagged: 0, items: [] },
    duration: 0,
  };

  try {
    // Run product family detection
    if (tasks.includes('productFamilies')) {
      output.productFamilies = await detectProductFamilies(workflowRunId, dryRun, limit);
    }

    // Run generic item cleanup (legacy mode)
    if (tasks.includes('genericCleanup') && !useAgentPipeline) {
      output.genericCleanup = await cleanupGenericItems(workflowRunId, dryRun, limit);
    }

    // Run agent pipeline (new mode) - replaces genericCleanup
    if (tasks.includes('agentPipeline') || useAgentPipeline) {
      output.agentPipeline = await processWithAgentPipeline(workflowRunId, dryRun, limit);
    }

    output.duration = Date.now() - startTime;

    console.info(`Data quality workflow completed in ${output.duration}ms:`, {
      families: output.productFamilies.detected,
      enriched: output.genericCleanup.enriched,
      flagged: output.genericCleanup.flagged,
      agentPipeline: output.agentPipeline ? {
        triaged: output.agentPipeline.triaged,
        curated: output.agentPipeline.curated,
        deleted: output.agentPipeline.deleted,
      } : undefined,
    });

    return output;
  } catch (error) {
    console.error(`Data quality workflow failed: ${workflowRunId}`, error);

    return {
      ...output,
      status: 'failed',
      duration: Date.now() - startTime,
    };
  }
}

// Register workflow
registerWorkflow('data-quality', executeDataQualityWorkflow);

export { detectProductFamilies, cleanupGenericItems };
export default executeDataQualityWorkflow;
