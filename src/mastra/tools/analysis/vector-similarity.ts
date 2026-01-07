/**
 * T030: Vector Similarity Tool
 * Implements FR-005: Identify potential duplicate nodes using semantic similarity
 * Uses Memgraph MAGE vector_search for embedding comparison
 */

import { getMemgraphClient } from '@/lib/memgraph-client';
import { CONFIDENCE_THRESHOLDS, DuplicateCandidate, NodeCandidate } from '@/types';

export interface SimilarityResult {
  nodeId: string;
  nodeName: string;
  similarity: number;
  properties: Record<string, unknown>;
}

export interface DuplicateScanResult {
  candidates: DuplicateCandidate[];
  scannedCount: number;
  duplicatesFound: number;
  autoMergeCount: number;
  approvalRequiredCount: number;
  skippedCount: number;
}

/**
 * Find nodes similar to a given query embedding
 */
export async function findSimilarNodes(
  queryEmbedding: number[],
  topK: number = 10,
  minSimilarity: number = CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL
): Promise<SimilarityResult[]> {
  const client = getMemgraphClient();

  // Use MAGE vector_search per research.md
  const query = `
    CALL vector_search.search("gear_embeddings", $topK, $embedding)
    YIELD node, similarity
    WHERE similarity >= $minSimilarity
    RETURN
      node.id AS nodeId,
      node.name AS nodeName,
      similarity,
      properties(node) AS properties
    ORDER BY similarity DESC
  `;

  const results = await client.readOnlyQuery<SimilarityResult>(query, {
    topK,
    embedding: queryEmbedding,
    minSimilarity,
  });

  return results;
}

/**
 * Calculate cosine similarity between two embedding vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Scan for potential duplicates across all nodes with embeddings
 */
export async function scanForDuplicates(): Promise<DuplicateScanResult> {
  const client = getMemgraphClient();

  // Get all nodes with embeddings
  const nodesQuery = `
    MATCH (n:GearItem)
    WHERE n.embedding_vector IS NOT NULL
    RETURN
      n.id AS nodeId,
      n.name AS nodeName,
      n.embedding_vector AS embedding,
      properties(n) AS properties
    ORDER BY n.id
  `;

  const nodes = await client.readOnlyQuery<{
    nodeId: string;
    nodeName: string;
    embedding: number[];
    properties: Record<string, unknown>;
  }>(nodesQuery);

  const candidates: DuplicateCandidate[] = [];
  const processedPairs = new Set<string>();

  // Compare each pair of nodes
  for (let i = 0; i < nodes.length; i++) {
    const nodeA = nodes[i]!;

    for (let j = i + 1; j < nodes.length; j++) {
      const nodeB = nodes[j]!;

      // Skip if already processed
      const pairKey = [nodeA.nodeId, nodeB.nodeId].sort().join('|');
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      // Calculate similarity
      const similarity = cosineSimilarity(nodeA.embedding, nodeB.embedding);

      // Only include if above threshold
      if (similarity >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL) {
        const conflictingProperties = findConflictingProperties(
          nodeA.properties,
          nodeB.properties
        );

        candidates.push({
          nodeA: {
            nodeId: nodeA.nodeId,
            nodeName: nodeA.nodeName,
            nodeProperties: nodeA.properties,
            relationships: [], // Would need separate query
          },
          nodeB: {
            nodeId: nodeB.nodeId,
            nodeName: nodeB.nodeName,
            nodeProperties: nodeB.properties,
            relationships: [],
          },
          similarity,
          confidenceScore: calculateConfidenceScore(similarity, conflictingProperties),
          conflictingProperties,
        });
      }
    }
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Categorize by confidence
  const autoMerge = candidates.filter(
    (c) => c.confidenceScore >= CONFIDENCE_THRESHOLDS.AUTO_MERGE
  );
  const approvalRequired = candidates.filter(
    (c) =>
      c.confidenceScore >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL &&
      c.confidenceScore < CONFIDENCE_THRESHOLDS.AUTO_MERGE
  );
  const skipped = candidates.filter(
    (c) => c.confidenceScore < CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL
  );

  return {
    candidates,
    scannedCount: nodes.length,
    duplicatesFound: candidates.length,
    autoMergeCount: autoMerge.length,
    approvalRequiredCount: approvalRequired.length,
    skippedCount: skipped.length,
  };
}

/**
 * Find properties that conflict between two nodes
 */
export function findConflictingProperties(
  propsA: Record<string, unknown>,
  propsB: Record<string, unknown>
): string[] {
  const conflicts: string[] = [];
  const excludeProps = ['id', 'embedding_vector', 'created_at', 'updated_at'];

  const allKeys = new Set([...Object.keys(propsA), ...Object.keys(propsB)]);

  for (const key of allKeys) {
    if (excludeProps.includes(key)) continue;

    const valueA = propsA[key];
    const valueB = propsB[key];

    // Only flag as conflict if both have non-null different values
    if (
      valueA !== undefined &&
      valueA !== null &&
      valueB !== undefined &&
      valueB !== null &&
      JSON.stringify(valueA) !== JSON.stringify(valueB)
    ) {
      conflicts.push(key);
    }
  }

  return conflicts;
}

/**
 * Calculate confidence score considering similarity and conflicts
 */
export function calculateConfidenceScore(
  similarity: number,
  conflictingProperties: string[]
): number {
  // Start with raw similarity
  let confidence = similarity;

  // Reduce confidence for each conflicting property
  const conflictPenalty = 0.02 * conflictingProperties.length;
  confidence -= conflictPenalty;

  // Critical property conflicts reduce confidence more
  const criticalProps = ['brand_id', 'category'];
  const criticalConflicts = conflictingProperties.filter((p) =>
    criticalProps.includes(p)
  );
  confidence -= 0.05 * criticalConflicts.length;

  // Clamp to valid range
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Get node relationships for merge display
 */
export async function getNodeRelationships(
  nodeId: string
): Promise<Array<{ type: string; direction: 'incoming' | 'outgoing'; targetId: string; targetName: string }>> {
  const client = getMemgraphClient();

  const query = `
    MATCH (n)-[r]->(target)
    WHERE n.id = $nodeId
    RETURN type(r) AS type, 'outgoing' AS direction, target.id AS targetId, target.name AS targetName
    UNION
    MATCH (source)-[r]->(n)
    WHERE n.id = $nodeId
    RETURN type(r) AS type, 'incoming' AS direction, source.id AS targetId, source.name AS targetName
  `;

  const results = await client.readOnlyQuery<{
    type: string;
    direction: 'incoming' | 'outgoing';
    targetId: string;
    targetName: string;
  }>(query, { nodeId });

  return results;
}

/**
 * Enrich duplicate candidate with relationship data
 */
export async function enrichCandidateWithRelationships(
  candidate: DuplicateCandidate
): Promise<DuplicateCandidate> {
  const [relsA, relsB] = await Promise.all([
    getNodeRelationships(candidate.nodeA.nodeId),
    getNodeRelationships(candidate.nodeB.nodeId),
  ]);

  return {
    ...candidate,
    nodeA: {
      ...candidate.nodeA,
      relationships: relsA,
    },
    nodeB: {
      ...candidate.nodeB,
      relationships: relsB,
    },
  };
}

export default {
  findSimilarNodes,
  scanForDuplicates,
  cosineSimilarity,
  findConflictingProperties,
  calculateConfidenceScore,
  getNodeRelationships,
  enrichCandidateWithRelationships,
};
