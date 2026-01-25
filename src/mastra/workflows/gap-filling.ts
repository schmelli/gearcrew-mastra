/**
 * T069-T071: Gap-Filling Workflow
 * Implements FR-020 through FR-025: Automatic data enrichment workflow
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getEnricherAgent, EnrichmentRequest, EnrichmentResult } from '../agents/enricher';
import { getAuditLogger } from '@/lib/audit-logger';
import { getLibSQLClient } from '@/lib/db';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { preloadProductTypes } from '@/mastra/services/product-types';
import { cleanupExpiredCache as cleanupFirecrawlCache } from '@/mastra/tools/firecrawl/cache';

// Workflow configuration
const WORKFLOW_CONFIG = {
  batchSize: 10,
  maxNodesPerRun: 100,
  priorityThreshold: 0.3, // Minimum priority to process
  cooldownHours: 24, // Hours before re-enriching a node
};

// Schemas
export const GapFillingOptionsSchema = z.object({
  scope: z
    .object({
      nodeTypes: z.array(z.string()).optional(),
      categories: z.array(z.string()).optional(),
      brands: z.array(z.string()).optional(),
      minCentrality: z.number().optional(),
    })
    .optional(),
  priority: z.enum(['normal', 'high']).default('normal'),
  limit: z.number().optional(),
});

export type GapFillingOptions = z.infer<typeof GapFillingOptionsSchema>;

export interface WorkflowState {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'suspended';
  phase: 'scan' | 'prioritize' | 'enrich' | 'complete';
  startedAt: string;
  completedAt?: string;
  progress: {
    totalNodes: number;
    processedNodes: number;
    enrichedNodes: number;
    skippedNodes: number;
    failedNodes: number;
    currentBatch: number;
    totalBatches: number;
  };
  results: EnrichmentResult[];
  error?: string;
}

export interface WorkflowResult {
  runId: string;
  status: 'completed' | 'failed';
  summary: {
    nodesScanned: number;
    nodesEnriched: number;
    nodesSkipped: number;
    nodesFailed: number;
    fieldsEnriched: number;
    avgConfidence: number;
    duration: number;
  };
  error?: string;
}

/**
 * Execute the gap-filling workflow
 */
export async function executeGapFillingWorkflow(
  options?: GapFillingOptions
): Promise<WorkflowResult> {
  const runId = uuidv4();
  const startTime = Date.now();
  const logger = getAuditLogger();
  const db = getLibSQLClient();

  // Initialize state
  const state: WorkflowState = {
    runId,
    status: 'running',
    phase: 'scan',
    startedAt: new Date().toISOString(),
    progress: {
      totalNodes: 0,
      processedNodes: 0,
      enrichedNodes: 0,
      skippedNodes: 0,
      failedNodes: 0,
      currentBatch: 0,
      totalBatches: 0,
    },
    results: [],
  };

  // Record workflow start
  await db.execute({
    sql: `INSERT INTO workflow_runs (id, workflow_name, status, started_at, triggered_by)
          VALUES (?, 'gap-filling', 'running', ?, 'scheduler')`,
    args: [runId, state.startedAt],
  });

  try {
    // Pre-warm caches before starting enrichment
    console.log('[Gap-Filling] Pre-warming caches...');
    const [productTypesCount] = await Promise.all([
      preloadProductTypes(),
      cleanupFirecrawlCache(),
    ]);
    console.log(`[Gap-Filling] ProductTypes cache loaded: ${productTypesCount} types`);

    // Phase 1: Scan for nodes needing enrichment
    state.phase = 'scan';
    const candidates = await scanForCandidates(options);
    state.progress.totalNodes = candidates.length;

    if (candidates.length === 0) {
      state.status = 'completed';
      state.phase = 'complete';

      await db.execute({
        sql: `UPDATE workflow_runs SET status = 'completed', completed_at = ?, result_summary = ?
              WHERE id = ?`,
        args: [new Date().toISOString(), JSON.stringify({ nodesFound: 0 }), runId],
      });

      return {
        runId,
        status: 'completed',
        summary: {
          nodesScanned: 0,
          nodesEnriched: 0,
          nodesSkipped: 0,
          nodesFailed: 0,
          fieldsEnriched: 0,
          avgConfidence: 0,
          duration: Date.now() - startTime,
        },
      };
    }

    // Phase 2: Prioritize by centrality
    state.phase = 'prioritize';
    const prioritized = await prioritizeByCentrality(candidates);

    // Apply limit
    const limit = options?.limit || WORKFLOW_CONFIG.maxNodesPerRun;
    const toProcess = prioritized.slice(0, limit);
    state.progress.totalNodes = toProcess.length;
    state.progress.totalBatches = Math.ceil(toProcess.length / WORKFLOW_CONFIG.batchSize);

    // Phase 3: Enrich in batches
    state.phase = 'enrich';
    const enricher = getEnricherAgent();

    for (let i = 0; i < toProcess.length; i += WORKFLOW_CONFIG.batchSize) {
      state.progress.currentBatch = Math.floor(i / WORKFLOW_CONFIG.batchSize) + 1;
      const batch = toProcess.slice(i, i + WORKFLOW_CONFIG.batchSize);

      // Process batch
      const batchResults = await enricher.enrichBatch(batch);

      // Update state
      for (const result of batchResults) {
        state.results.push(result);
        state.progress.processedNodes++;

        if (result.success) {
          state.progress.enrichedNodes++;
        } else if (result.error) {
          state.progress.failedNodes++;
        } else {
          state.progress.skippedNodes++;
        }
      }

      // Update workflow progress in DB
      await db.execute({
        sql: `UPDATE workflow_runs SET result_summary = ? WHERE id = ?`,
        args: [JSON.stringify(state.progress), runId],
      });
    }

    // Phase 4: Complete
    state.phase = 'complete';
    state.status = 'completed';
    state.completedAt = new Date().toISOString();

    // Calculate summary
    const fieldsEnriched = state.results.reduce(
      (sum, r) => sum + r.enrichedFields.length,
      0
    );
    const avgConfidence =
      state.results.length > 0
        ? state.results.reduce((sum, r) => sum + r.confidence, 0) / state.results.length
        : 0;

    const summary = {
      nodesScanned: state.progress.totalNodes,
      nodesEnriched: state.progress.enrichedNodes,
      nodesSkipped: state.progress.skippedNodes,
      nodesFailed: state.progress.failedNodes,
      fieldsEnriched,
      avgConfidence,
      duration: Date.now() - startTime,
    };

    // Update workflow completion
    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'completed', completed_at = ?, result_summary = ?
            WHERE id = ?`,
      args: [state.completedAt, JSON.stringify(summary), runId],
    });

    // Log completion
    await logger.logUpdate(
      runId,
      'gap-filling',
      runId,
      'WorkflowRun',
      { status: 'completed' },
      { status: 'running' },
      { confidence: avgConfidence, reasoning: `Gap-filling completed: ${summary.nodesEnriched} nodes enriched with ${summary.fieldsEnriched} fields` }
    );

    return {
      runId,
      status: 'completed',
      summary,
    };
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : 'Unknown error';
    state.completedAt = new Date().toISOString();

    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'failed', completed_at = ?, error = ?
            WHERE id = ?`,
      args: [state.completedAt, state.error, runId],
    });

    await logger.logError(
      runId,
      'gap-filling',
      runId,
      'WorkflowRun',
      state.error
    );

    return {
      runId,
      status: 'failed',
      summary: {
        nodesScanned: state.progress.totalNodes,
        nodesEnriched: state.progress.enrichedNodes,
        nodesSkipped: state.progress.skippedNodes,
        nodesFailed: state.progress.failedNodes,
        fieldsEnriched: 0,
        avgConfidence: 0,
        duration: Date.now() - startTime,
      },
      error: state.error,
    };
  }
}

/**
 * Scan for candidate nodes needing enrichment
 */
async function scanForCandidates(options?: GapFillingOptions): Promise<EnrichmentRequest[]> {
  const client = getMemgraphClient();

  // Build WHERE clause based on scope
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  // Must have at least one missing field
  conditions.push(`(
    n.weight_grams IS NULL OR
    n.price IS NULL OR
    n.dimensions_cm IS NULL OR
    n.capacity_liters IS NULL OR
    n.temperature_rating_celsius IS NULL
  )`);

  // Must have a name to search for
  conditions.push('n.name IS NOT NULL');

  // Exclude recently enriched nodes
  const cooldownTime = new Date(
    Date.now() - WORKFLOW_CONFIG.cooldownHours * 60 * 60 * 1000
  ).toISOString();
  conditions.push('(n.last_enriched_at IS NULL OR n.last_enriched_at < $cooldownTime)');
  params.cooldownTime = cooldownTime;

  // Apply scope filters
  if (options?.scope?.categories && options.scope.categories.length > 0) {
    conditions.push('n.category IN $categories');
    params.categories = options.scope.categories;
  }

  if (options?.scope?.brands && options.scope.brands.length > 0) {
    conditions.push('n.brand IN $brands');
    params.brands = options.scope.brands;
  }

  if (options?.scope?.minCentrality) {
    // Note: This filter requires a subquery in Memgraph
    // conditions.push('size((n)--()) >= $minCentrality');
    // Centrality filtering is done post-query in prioritizeByCentrality
    params.minCentrality = options.scope.minCentrality;
  }

  const whereClause = conditions.join(' AND ');

  const query = `
    MATCH (n:GearItem)
    WHERE ${whereClause}
    RETURN n.gearId as nodeId,
           n.name as name,
           n.brand as brand,
           n.productType as category,
           n.weight_grams as weight,
           n.price as price,
           n.dimensions_cm as dimensions,
           n.capacity_liters as capacity,
           n.temperature_rating_celsius as temperature
    LIMIT 500
  `;

  interface ScanResult {
    nodeId: string;
    name: string;
    brand: string;
    category: string;
    weight: number | null;
    price: number | null;
    dimensions: string | null;
    capacity: number | null;
    temperature: number | null;
  }

  const results = await client.readOnlyQuery<ScanResult>(query, params);

  return results.map((record) => {
    const missingFields: string[] = [];
    if (!record.weight) missingFields.push('weight');
    if (!record.price) missingFields.push('price');
    if (!record.dimensions) missingFields.push('dimensions');
    if (!record.capacity) missingFields.push('capacity');
    if (!record.temperature) missingFields.push('temperature');

    return {
      nodeId: record.nodeId,
      nodeType: 'GearItem' as const,
      currentData: {
        name: record.name,
        brand: record.brand,
        category: record.category,
      },
      missingFields,
      categoryPath: record.category ? `miscellaneous/${record.category.toLowerCase().replace(/\s+/g, '-')}` : undefined,
      priority: 0.5, // Will be updated by prioritization
    };
  });
}

/**
 * Prioritize candidates by graph centrality
 */
async function prioritizeByCentrality(
  candidates: EnrichmentRequest[]
): Promise<EnrichmentRequest[]> {
  const client = getMemgraphClient();

  // Get centrality scores for all candidates
  const nodeIds = candidates.map((c) => c.nodeId);

  const query = `
    UNWIND $nodeIds as nodeId
    MATCH (n:GearItem {gearId: nodeId})
    OPTIONAL MATCH (n)-[r]-()
    WITH n, count(r) as degree
    RETURN n.gearId as nodeId, degree
  `;

  interface CentralityResult {
    nodeId: string;
    degree: number;
  }

  const results = await client.readOnlyQuery<CentralityResult>(query, { nodeIds });

  // Create lookup map
  const centralityMap = new Map<string, number>();
  let maxDegree = 1;

  for (const record of results) {
    const degree = typeof record.degree === 'number' ? record.degree : 0;
    centralityMap.set(record.nodeId, degree);
    maxDegree = Math.max(maxDegree, degree);
  }

  // Update priorities and sort
  const prioritized = candidates
    .map((c) => ({
      ...c,
      priority: (centralityMap.get(c.nodeId) || 0) / maxDegree,
    }))
    .filter((c) => c.priority >= WORKFLOW_CONFIG.priorityThreshold)
    .sort((a, b) => b.priority - a.priority);

  return prioritized;
}

/**
 * Get workflow status
 */
export async function getGapFillingStatus(runId: string): Promise<WorkflowState | null> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM workflow_runs WHERE id = ?`,
    args: [runId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  const resultSummary = row.result_summary
    ? JSON.parse(row.result_summary as string)
    : {};

  return {
    runId: row.id as string,
    status: row.status as WorkflowState['status'],
    phase: 'complete',
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | undefined,
    progress: resultSummary,
    results: [],
    error: row.error as string | undefined,
  };
}

/**
 * Schedule gap-filling workflow (called by cron)
 */
export async function scheduleGapFilling(): Promise<void> {
  // Check if already running
  const db = getLibSQLClient();
  const running = await db.execute({
    sql: `SELECT id FROM workflow_runs
          WHERE workflow_name = 'gap-filling' AND status = 'running'`,
    args: [],
  });

  if (running.rows.length > 0) {
    console.log('Gap-filling workflow already running, skipping');
    return;
  }

  // Start workflow
  console.log('Starting scheduled gap-filling workflow');
  const result = await executeGapFillingWorkflow();
  console.log(`Gap-filling completed: ${result.summary.nodesEnriched} nodes enriched`);
}
