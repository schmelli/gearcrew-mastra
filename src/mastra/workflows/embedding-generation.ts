/**
 * Embedding Generation Workflow
 * Generates and stores vector embeddings for GearItem nodes
 * Required for duplicate detection via semantic similarity
 */

import { randomUUID } from 'crypto';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getLibSQLClient } from '@/mastra/index';
import { getAuditLogger } from '@/lib/audit-logger';
import { registerWorkflow } from '../index';
import {
  generateEmbedding,
  createGearItemEmbeddingText,
  EMBEDDING_CONFIG,
} from '@/lib/embeddings';

// ============================================================================
// Configuration
// ============================================================================

const VECTOR_INDEX_NAME = 'gear_embedding_idx';
const BATCH_SIZE = 50; // Process nodes in batches to avoid memory issues

// ============================================================================
// Types
// ============================================================================

interface EmbeddingWorkflowInput {
  workflowRunId?: string;
  limit?: number; // Max nodes to process (for testing/incremental runs)
  forceRegenerate?: boolean; // Regenerate even if embedding exists
}

interface EmbeddingWorkflowOutput {
  workflowRunId: string;
  status: 'completed' | 'failed';
  nodesProcessed: number;
  embeddingsGenerated: number;
  errors: number;
  indexCreated: boolean;
  duration: number;
}

interface GearItemNode {
  gearId: string;
  name: string;
  description: string | null;
  productType: string | null;
  brand: string | null;
}

// ============================================================================
// Vector Index Management
// ============================================================================

/**
 * Ensure the vector index exists in Memgraph
 */
async function ensureVectorIndex(): Promise<boolean> {
  const client = getMemgraphClient();

  try {
    // Check if index already exists
    const checkQuery = `SHOW INDEX INFO`;
    const indexes = await client.readOnlyQuery<{ name: string }>(checkQuery);

    const indexExists = indexes.some((idx) => idx.name === VECTOR_INDEX_NAME);

    if (!indexExists) {
      // Create the vector index
      const createQuery = `
        CREATE VECTOR INDEX ${VECTOR_INDEX_NAME}
        ON :GearItem(embedding_vector)
        WITH CONFIG {
          "dimension": ${EMBEDDING_CONFIG.dimensions},
          "capacity": 100000,
          "metric": "cosine"
        }
      `;

      await client.writeTransaction(createQuery);
      console.info(`Created vector index: ${VECTOR_INDEX_NAME}`);
      return true;
    }

    console.info(`Vector index already exists: ${VECTOR_INDEX_NAME}`);
    return false;
  } catch (error) {
    // Index creation might fail if Memgraph version doesn't support it
    console.error('Failed to create vector index:', error);
    throw error;
  }
}

// ============================================================================
// Embedding Generation Steps
// ============================================================================

/**
 * Get GearItem nodes that need embeddings
 */
async function getNodesNeedingEmbeddings(
  limit: number,
  forceRegenerate: boolean
): Promise<GearItemNode[]> {
  const client = getMemgraphClient();

  const query = forceRegenerate
    ? `
        MATCH (n:GearItem)
        WHERE n.gearId IS NOT NULL AND n.name IS NOT NULL
        RETURN
          n.gearId AS gearId,
          n.name AS name,
          n.description AS description,
          n.productType AS productType,
          n.brand AS brand
        LIMIT toInteger($limit)
      `
    : `
        MATCH (n:GearItem)
        WHERE n.embedding_vector IS NULL AND n.gearId IS NOT NULL AND n.name IS NOT NULL
        RETURN
          n.gearId AS gearId,
          n.name AS name,
          n.description AS description,
          n.productType AS productType,
          n.brand AS brand
        LIMIT toInteger($limit)
      `;

  const results = await client.readOnlyQuery<GearItemNode>(query, { limit });
  return results;
}

/**
 * Store embedding on a node
 */
async function storeEmbedding(
  gearId: string,
  embedding: number[]
): Promise<void> {
  const client = getMemgraphClient();

  // Memgraph stores vectors as lists
  const query = `
    MATCH (n:GearItem {gearId: $gearId})
    SET n.embedding_vector = $embedding,
        n.embedding_updated_at = datetime()
    RETURN n.gearId AS gearId
  `;

  await client.writeTransaction(query, {
    gearId,
    embedding,
  });
}

// ============================================================================
// Main Workflow Execution
// ============================================================================

/**
 * Execute the embedding generation workflow
 */
export async function executeEmbeddingWorkflow(
  options?: EmbeddingWorkflowInput
): Promise<EmbeddingWorkflowOutput> {
  const startTime = Date.now();
  const workflowRunId = options?.workflowRunId ?? `embed-${Date.now()}`;
  const limit = options?.limit ?? 10000;
  const forceRegenerate = options?.forceRegenerate ?? false;
  const wasTriggeredExternally = !!options?.workflowRunId;

  const db = getLibSQLClient();
  const auditLogger = getAuditLogger();

  console.info(`Starting embedding generation workflow: ${workflowRunId}`);

  let nodesProcessed = 0;
  let embeddingsGenerated = 0;
  let errors = 0;
  let indexCreated = false;

  try {
    // Only create workflow run record if not triggered via API
    if (!wasTriggeredExternally) {
      await db.execute({
        sql: `INSERT INTO workflow_runs (id, workflow_name, triggered_by, started_at, status)
              VALUES (?, ?, ?, ?, ?)`,
        args: [workflowRunId, 'embedding-generation', 'system', new Date().toISOString(), 'running'],
      });
    }

    // Step 1: Ensure vector index exists
    console.info('Step 1: Ensuring vector index exists...');
    try {
      indexCreated = await ensureVectorIndex();
    } catch (error) {
      console.warn('Vector index creation failed, continuing without index:', error);
    }

    // Step 2: Get nodes needing embeddings
    console.info('Step 2: Finding nodes needing embeddings...');
    const nodes = await getNodesNeedingEmbeddings(limit, forceRegenerate);
    nodesProcessed = nodes.length;

    console.info(`Found ${nodes.length} nodes needing embeddings`);

    if (nodes.length === 0) {
      console.info('No nodes need embeddings. Workflow complete.');
    } else {
      // Step 3: Generate and store embeddings in batches
      console.info('Step 3: Generating embeddings...');

      for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
        const batch = nodes.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(nodes.length / BATCH_SIZE);

        console.info(`Processing batch ${batchNum}/${totalBatches} (${batch.length} nodes)...`);

        for (const node of batch) {
          try {
            // Create embedding text from node properties
            // Map productType to type for the embedding text function
            const embeddingText = createGearItemEmbeddingText({
              name: node.name,
              description: node.description,
              brand: node.brand,
              type: node.productType,
            });

            // Generate embedding via Vercel AI Gateway
            const embedding = await generateEmbedding(embeddingText);

            // Store embedding on node using gearId
            await storeEmbedding(node.gearId, embedding);

            embeddingsGenerated++;

            // Log to audit trail
            await auditLogger.logUpdate(
              workflowRunId,
              'embedding-generation',
              node.gearId,
              'GearItem',
              { embedding_vector: null },
              { embedding_vector: '[vector]', embedding_updated_at: new Date().toISOString() },
              {
                confidence: 1.0,
                reasoning: `Generated ${EMBEDDING_CONFIG.dimensions}-dim embedding from: ${embeddingText.substring(0, 100)}...`,
              }
            );
          } catch (error) {
            errors++;
            console.error(`Failed to generate embedding for node ${node.gearId}:`, error);
            await auditLogger.logError(
              workflowRunId,
              'embedding-generation',
              node.gearId,
              'GearItem',
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        // Rate limiting: small delay between batches
        if (i + BATCH_SIZE < nodes.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }

    // Update workflow status
    const duration = Date.now() - startTime;

    await db.execute({
      sql: `UPDATE workflow_runs
            SET status = ?, completed_at = ?, result_summary = ?
            WHERE id = ?`,
      args: [
        'completed',
        new Date().toISOString(),
        JSON.stringify({
          nodesProcessed,
          embeddingsGenerated,
          errors,
          indexCreated,
        }),
        workflowRunId,
      ],
    });

    console.info(`Embedding generation completed in ${duration}ms:`, {
      nodesProcessed,
      embeddingsGenerated,
      errors,
      indexCreated,
    });

    return {
      workflowRunId,
      status: 'completed',
      nodesProcessed,
      embeddingsGenerated,
      errors,
      indexCreated,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`Embedding generation failed: ${workflowRunId}`, error);

    await db.execute({
      sql: `UPDATE workflow_runs
            SET status = ?, completed_at = ?, error = ?
            WHERE id = ?`,
      args: [
        'failed',
        new Date().toISOString(),
        error instanceof Error ? error.message : String(error),
        workflowRunId,
      ],
    });

    return {
      workflowRunId,
      status: 'failed',
      nodesProcessed,
      embeddingsGenerated,
      errors: errors + 1,
      indexCreated,
      duration,
    };
  }
}

// Register workflow
registerWorkflow('embedding-generation', executeEmbeddingWorkflow);

/**
 * Manually trigger embedding generation
 */
export async function runEmbeddingGeneration(
  options?: EmbeddingWorkflowInput
): Promise<EmbeddingWorkflowOutput> {
  return executeEmbeddingWorkflow(options);
}

export default executeEmbeddingWorkflow;
