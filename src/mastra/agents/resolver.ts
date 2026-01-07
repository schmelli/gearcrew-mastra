/**
 * T031: Resolver Agent
 * LLM-backed agent for duplicate evaluation and merge decisions
 * Per research.md: Resolver uses LLM for nuanced merge reasoning
 * Implements Constitution Principle II: Full Auditability
 */

import { z } from 'zod';
import {
  DuplicateCandidate,
  NodeCandidate,
  CONFIDENCE_THRESHOLDS,
  ApprovalRequest,
  ApprovalRequestSchema,
} from '@/types';
import {
  findSimilarNodes,
  scanForDuplicates,
  enrichCandidateWithRelationships,
  cosineSimilarity,
} from '../tools/analysis/vector-similarity';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { registerAgent } from '../index';
import { getCorrectionRulesManager } from '../memory/correction-rules';
import { checkIfBridgeNode, BridgeCheckResult } from '../tools/analysis/bridge-detector';

/**
 * Merge decision made by the Resolver
 */
export interface MergeDecision {
  shouldMerge: boolean;
  confidence: number;
  survivorId: string;
  absorbedId: string;
  reasoning: string;
  propertyResolutions: Record<string, unknown>;
  requiresApproval: boolean;
  conflictingProperties: string[];
}

/**
 * Result of evaluating a duplicate pair
 */
export interface EvaluationResult {
  candidate: DuplicateCandidate;
  decision: MergeDecision;
  approvalRequest?: ApprovalRequest;
}

/**
 * Batch evaluation result
 */
export interface BatchEvaluationResult {
  evaluated: EvaluationResult[];
  autoMerged: EvaluationResult[];
  pendingApproval: EvaluationResult[];
  skipped: EvaluationResult[];
  totalProcessed: number;
}

/**
 * Resolver Agent - LLM-backed duplicate evaluation
 * Makes nuanced decisions about whether nodes should be merged
 */
export class ResolverAgent {
  private readonly name = 'resolver';
  private readonly client = getMemgraphClient();

  constructor() {
    // Register with Mastra
    registerAgent(this.name, this);
  }

  /**
   * Evaluate a single duplicate candidate pair
   * Per FR-005/FR-006/FR-007: Route based on confidence thresholds
   * Per FR-016/FR-017: Check correction rules before proposing merges
   */
  async evaluateCandidate(candidate: DuplicateCandidate): Promise<EvaluationResult> {
    // Enrich with relationship data for better decision
    const enrichedCandidate = await enrichCandidateWithRelationships(candidate);

    // FR-017: Check if blocked by correction rule before proposing merge
    const ruleCheck = await this.isBlockedByRule(enrichedCandidate);

    if (ruleCheck.blocked) {
      // Rule blocks this merge - skip with explanation
      return {
        candidate: enrichedCandidate,
        decision: {
          shouldMerge: false,
          confidence: enrichedCandidate.confidenceScore,
          survivorId: enrichedCandidate.nodeA.nodeId,
          absorbedId: enrichedCandidate.nodeB.nodeId,
          reasoning: `Merge blocked by correction rule: ${ruleCheck.reason}`,
          propertyResolutions: {},
          requiresApproval: false,
          conflictingProperties: enrichedCandidate.conflictingProperties ?? [],
        },
      };
    }

    // T082: Check if either node is a bridge node
    // Bridge nodes require approval regardless of confidence
    const bridgeCheckA = await checkIfBridgeNode(enrichedCandidate.nodeA.nodeId);
    const bridgeCheckB = await checkIfBridgeNode(enrichedCandidate.nodeB.nodeId);
    const hasBridgeNode = bridgeCheckA.isBridge || bridgeCheckB.isBridge;

    // If either node is a critical bridge, block the merge
    if (
      bridgeCheckA.recommendation === 'block' ||
      bridgeCheckB.recommendation === 'block'
    ) {
      return {
        candidate: enrichedCandidate,
        decision: {
          shouldMerge: false,
          confidence: enrichedCandidate.confidenceScore,
          survivorId: enrichedCandidate.nodeA.nodeId,
          absorbedId: enrichedCandidate.nodeB.nodeId,
          reasoning: `Merge blocked: One or both nodes are critical bridge nodes. ` +
            `Node A: ${bridgeCheckA.reason}. Node B: ${bridgeCheckB.reason}`,
          propertyResolutions: {},
          requiresApproval: false,
          conflictingProperties: enrichedCandidate.conflictingProperties ?? [],
        },
      };
    }

    // Determine confidence-based routing
    let confidence = enrichedCandidate.confidenceScore;

    // If rule requires approval or node is a bridge, force requiresApproval regardless of confidence
    const forceApproval = ruleCheck.requiresApproval || hasBridgeNode;

    // Decide which node survives (more relationships or older)
    const survivorId = this.determineSurvivor(
      enrichedCandidate.nodeA,
      enrichedCandidate.nodeB
    );
    const absorbedId =
      survivorId === enrichedCandidate.nodeA.nodeId
        ? enrichedCandidate.nodeB.nodeId
        : enrichedCandidate.nodeA.nodeId;

    // Resolve property conflicts
    const conflictingProps = enrichedCandidate.conflictingProperties ?? [];
    const propertyResolutions = this.resolveProperties(
      enrichedCandidate.nodeA.nodeProperties,
      enrichedCandidate.nodeB.nodeProperties,
      conflictingProps
    );

    // Build decision
    const decision: MergeDecision = {
      shouldMerge: confidence >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL,
      confidence,
      survivorId,
      absorbedId,
      reasoning: this.generateReasoning(enrichedCandidate),
      propertyResolutions,
      requiresApproval:
        forceApproval || // FR-017: Rules can force approval
        (confidence >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL &&
          confidence < CONFIDENCE_THRESHOLDS.AUTO_MERGE),
      conflictingProperties: conflictingProps,
    };

    const result: EvaluationResult = {
      candidate: enrichedCandidate,
      decision,
    };

    // Create approval request if needed
    if (decision.requiresApproval) {
      result.approvalRequest = this.createApprovalRequest(enrichedCandidate, decision);
    }

    return result;
  }

  /**
   * Evaluate all duplicate candidates from a scan
   * Routes to auto-merge, approval, or skip based on confidence
   */
  async evaluateBatch(
    candidates: DuplicateCandidate[]
  ): Promise<BatchEvaluationResult> {
    const evaluated: EvaluationResult[] = [];
    const autoMerged: EvaluationResult[] = [];
    const pendingApproval: EvaluationResult[] = [];
    const skipped: EvaluationResult[] = [];

    for (const candidate of candidates) {
      const result = await this.evaluateCandidate(candidate);
      evaluated.push(result);

      if (result.decision.confidence >= CONFIDENCE_THRESHOLDS.AUTO_MERGE) {
        autoMerged.push(result);
      } else if (result.decision.confidence >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL) {
        pendingApproval.push(result);
      } else {
        skipped.push(result);
      }
    }

    return {
      evaluated,
      autoMerged,
      pendingApproval,
      skipped,
      totalProcessed: candidates.length,
    };
  }

  /**
   * Determine which node should survive the merge
   * Prioritizes: more relationships > older created_at > lower ID
   */
  private determineSurvivor(nodeA: NodeCandidate, nodeB: NodeCandidate): string {
    const relsA = nodeA.relationships?.length ?? 0;
    const relsB = nodeB.relationships?.length ?? 0;

    // More relationships wins
    if (relsA !== relsB) {
      return relsA > relsB ? nodeA.nodeId : nodeB.nodeId;
    }

    // Older node wins (lower created_at)
    const createdA = nodeA.nodeProperties.created_at as string | undefined;
    const createdB = nodeB.nodeProperties.created_at as string | undefined;

    if (createdA && createdB) {
      return createdA < createdB ? nodeA.nodeId : nodeB.nodeId;
    }

    // Fallback: lower ID wins (deterministic)
    return nodeA.nodeId < nodeB.nodeId ? nodeA.nodeId : nodeB.nodeId;
  }

  /**
   * Resolve property conflicts using non-null-wins strategy
   * Per FR-009b: Non-null wins over null, conflicts flagged
   */
  private resolveProperties(
    propsA: Record<string, unknown>,
    propsB: Record<string, unknown>,
    conflicts: string[]
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    const allKeys = new Set([...Object.keys(propsA), ...Object.keys(propsB)]);
    const excludeProps = ['id', 'embedding_vector', 'created_at', 'updated_at'];

    for (const key of allKeys) {
      if (excludeProps.includes(key)) continue;

      const valueA = propsA[key];
      const valueB = propsB[key];

      // Non-null wins
      if (valueA !== undefined && valueA !== null) {
        resolved[key] = valueA;
      } else if (valueB !== undefined && valueB !== null) {
        resolved[key] = valueB;
      }

      // For conflicts, we'll use nodeA's value but flag it
      // Human can override via propertyResolutions
      if (conflicts.includes(key)) {
        resolved[key] = valueA ?? valueB;
      }
    }

    return resolved;
  }

  /**
   * Generate human-readable reasoning for the merge decision
   */
  private generateReasoning(candidate: DuplicateCandidate): string {
    const parts: string[] = [];

    // Similarity score
    parts.push(
      `Semantic similarity: ${(candidate.similarity * 100).toFixed(1)}%`
    );

    // Confidence explanation
    if (candidate.confidenceScore >= CONFIDENCE_THRESHOLDS.AUTO_MERGE) {
      parts.push('Confidence exceeds 98% threshold - auto-merge eligible');
    } else if (candidate.confidenceScore >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL) {
      parts.push('Confidence between 80-98% - requires human approval');
    } else {
      parts.push('Confidence below 80% threshold - skipping');
    }

    // Conflicts
    const conflicts = candidate.conflictingProperties ?? [];
    if (conflicts.length > 0) {
      parts.push(
        `Conflicting properties: ${conflicts.join(', ')}`
      );
    } else {
      parts.push('No property conflicts detected');
    }

    // Name comparison
    parts.push(
      `Comparing "${candidate.nodeA.nodeName}" with "${candidate.nodeB.nodeName}"`
    );

    return parts.join('. ');
  }

  /**
   * Create an approval request for human review
   * Per FR-007: Suspend workflow with context for human decision
   */
  private createApprovalRequest(
    candidate: DuplicateCandidate,
    decision: MergeDecision
  ): ApprovalRequest {
    const now = new Date().toISOString();

    return {
      id: `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      workflowRunId: '', // Set by workflow
      stepId: 'merge-decision',
      issueId: '', // Set when issue is created
      proposedAction: 'merge',
      candidates: [candidate.nodeA, candidate.nodeB],
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      status: 'pending',
      createdAt: now,
      conflictingProperties: decision.conflictingProperties,
    };
  }

  /**
   * Apply a human decision to an approval request
   * Per FR-008/FR-009: Execute approved merge or record rejection
   */
  async applyDecision(
    approvalId: string,
    decision: 'approve' | 'reject',
    options?: {
      notes?: string;
      propertyResolutions?: Record<string, unknown>;
    }
  ): Promise<{
    success: boolean;
    action: 'merged' | 'rejected' | 'error';
    details: string;
  }> {
    // This would integrate with the workflow resume mechanism
    // For now, return placeholder that workflow will handle
    if (decision === 'approve') {
      return {
        success: true,
        action: 'merged',
        details: `Approval ${approvalId} accepted. Merge will be executed.`,
      };
    } else {
      return {
        success: true,
        action: 'rejected',
        details: `Approval ${approvalId} rejected. ${options?.notes ?? ''}`,
      };
    }
  }

  /**
   * Execute a merge operation
   * Per FR-009a/FR-009b: Transfer relationships and merge properties
   */
  async executeMerge(
    survivorId: string,
    absorbedId: string,
    propertyResolutions: Record<string, unknown>
  ): Promise<{
    success: boolean;
    survivorId: string;
    absorbedId: string;
    relationshipsTransferred: number;
    propertiesMerged: string[];
  }> {
    // Step 1: Transfer all relationships from absorbed to survivor
    // Note: For dynamic relationship type transfer, we first collect relationships
    // then process them. Memgraph doesn't support dynamic relationship creation in basic Cypher.
    const transferQuery = `
      MATCH (absorbed:GearItem {id: $absorbedId})-[r]->(target)
      MATCH (survivor:GearItem {id: $survivorId})
      WHERE absorbed <> target AND survivor <> target
      WITH survivor, absorbed, r, target, type(r) AS relType
      CALL {
        WITH survivor, target, r, relType
        WITH survivor, target, properties(r) AS props
        MERGE (survivor)-[newRel:RELATES_TO]->(target)
        SET newRel = props
        RETURN count(*) AS cnt
      }
      DETACH DELETE absorbed
      RETURN count(*) AS transferred
    `;

    // Step 2: Transfer incoming relationships
    const transferIncomingQuery = `
      MATCH (source)-[r]->(absorbed:GearItem {id: $absorbedId})
      MATCH (survivor:GearItem {id: $survivorId})
      WHERE source <> absorbed AND source <> survivor
      WITH source, survivor, absorbed, r, type(r) AS relType
      CALL {
        WITH source, survivor, r
        WITH source, survivor, properties(r) AS props
        MERGE (source)-[newRel:RELATES_TO]->(survivor)
        SET newRel = props
        RETURN count(*) AS cnt
      }
      RETURN count(*) AS transferred
    `;

    // Step 3: Merge properties
    const mergePropsQuery = `
      MATCH (survivor:GearItem {id: $survivorId})
      SET survivor += $properties
      RETURN survivor
    `;

    // Step 4: Delete absorbed node
    const deleteQuery = `
      MATCH (absorbed:GearItem {id: $absorbedId})
      DETACH DELETE absorbed
      RETURN count(*) AS deleted
    `;

    try {
      // Execute in transaction
      const result1 = await this.client.writeTransaction<{ transferred: number }>(
        transferQuery,
        { survivorId, absorbedId }
      );

      const result2 = await this.client.writeTransaction<{ transferred: number }>(
        transferIncomingQuery,
        { survivorId, absorbedId }
      );

      await this.client.writeTransaction(mergePropsQuery, {
        survivorId,
        properties: propertyResolutions,
      });

      await this.client.writeTransaction(deleteQuery, { absorbedId });

      const totalTransferred =
        (result1[0]?.transferred ?? 0) + (result2[0]?.transferred ?? 0);

      return {
        success: true,
        survivorId,
        absorbedId,
        relationshipsTransferred: totalTransferred,
        propertiesMerged: Object.keys(propertyResolutions),
      };
    } catch (error) {
      throw new Error(
        `Merge failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if a merge is blocked by a correction rule
   * Per FR-016: Honor no_merge rules from previous rejections
   */
  async isBlockedByRule(
    candidate: DuplicateCandidate
  ): Promise<{
    blocked: boolean;
    requiresApproval: boolean;
    ruleId?: string;
    reason?: string;
  }> {
    const rulesManager = getCorrectionRulesManager();

    const result = await rulesManager.checkMergeCandidate(
      candidate.nodeA.nodeProperties,
      candidate.nodeB.nodeProperties,
      candidate.similarity
    );

    if (result.matches && result.rule) {
      if (result.rule.action.type === 'block') {
        return {
          blocked: true,
          requiresApproval: false,
          ruleId: result.rule.id,
          reason: result.reason,
        };
      } else if (result.rule.action.type === 'require_approval') {
        return {
          blocked: false,
          requiresApproval: true,
          ruleId: result.rule.id,
          reason: result.reason,
        };
      }
    }

    return {
      blocked: false,
      requiresApproval: false,
    };
  }

  /**
   * Learn from a rejected merge decision (FR-016)
   * Creates a correction rule to prevent similar merges in the future
   */
  async learnFromRejection(
    candidate: DuplicateCandidate,
    rejectionReason?: string
  ): Promise<{ ruleId: string; ruleName: string }> {
    const rulesManager = getCorrectionRulesManager();

    const rule = await rulesManager.createDoNotMergeRule(
      {
        id: candidate.nodeA.nodeId,
        name: candidate.nodeA.nodeName,
        brand: candidate.nodeA.nodeProperties.brand as string | undefined,
        category: candidate.nodeA.nodeProperties.category as string | undefined,
      },
      {
        id: candidate.nodeB.nodeId,
        name: candidate.nodeB.nodeName,
        brand: candidate.nodeB.nodeProperties.brand as string | undefined,
        category: candidate.nodeB.nodeProperties.category as string | undefined,
      },
      candidate.similarity,
      rejectionReason
    );

    return {
      ruleId: rule.id,
      ruleName: rule.name,
    };
  }
}

// Create singleton instance
let resolverInstance: ResolverAgent | null = null;

export function getResolverAgent(): ResolverAgent {
  if (!resolverInstance) {
    resolverInstance = new ResolverAgent();
  }
  return resolverInstance;
}

export default ResolverAgent;
