/**
 * T079: Safety Guards
 * Implements FR-030: Prevent catastrophic operations
 * Protects against destructive database operations
 */

import { z } from 'zod';

// ============================================================================
// Configuration
// ============================================================================

export const SafetyConfig = {
  // Maximum nodes that can be deleted in a single operation
  maxDeleteBatchSize: 100,

  // Maximum percentage of graph that can be affected by a single operation
  maxGraphImpactPercent: 5,

  // Minimum time between destructive operations (ms)
  destructiveOperationCooldown: 60000,

  // Require approval for operations affecting more than this many nodes
  approvalThreshold: 10,
};

// ============================================================================
// Dangerous Operation Patterns
// ============================================================================

const DANGEROUS_PATTERNS = {
  // Complete database destruction
  dropDatabase: /DROP\s+DATABASE/i,
  dropAll: /MATCH\s+\(n\)\s+DETACH\s+DELETE\s+n/i,

  // Unbounded deletions
  deleteAll: /DELETE\s+n\s*$/i,
  detachDeleteAll: /DETACH\s+DELETE\s+n\s*$/i,
  deleteWithoutWhere: /MATCH\s+\(n\)\s+DELETE/i,

  // Dangerous schema operations
  dropIndex: /DROP\s+INDEX/i,
  dropConstraint: /DROP\s+CONSTRAINT/i,

  // Load from untrusted sources
  loadCsv: /LOAD\s+CSV/i,

  // Procedure calls that could be dangerous
  callApoc: /CALL\s+apoc\./i,
  callDbms: /CALL\s+dbms\./i,

  // Infinite loops / resource exhaustion
  infiniteCreate: /FOREACH\s*\([^)]+\s+IN\s+RANGE\s*\(\s*1\s*,\s*\d{7,}/i,

  // SET without match (could affect everything)
  unboundedSet: /SET\s+\w+\s*=/i,
};

// Operations that require human approval
const APPROVAL_REQUIRED_PATTERNS = {
  // Large batch deletions
  batchDelete: /DELETE\s+\w+\s+WHERE/i,

  // Merge operations that could create duplicates
  unsafeCreate: /CREATE\s+\([^)]+\)/i,

  // Property modifications on multiple nodes
  batchSet: /MATCH\s+\([^)]+\)\s+WHERE[^S]+SET/i,
};

// ============================================================================
// Types
// ============================================================================

export interface SafetyCheckResult {
  safe: boolean;
  requiresApproval: boolean;
  blockedReason?: string;
  approvalReason?: string;
  matchedPatterns: string[];
  recommendations: string[];
}

export interface OperationMetrics {
  estimatedNodesAffected: number;
  percentageOfGraph: number;
  operationType: 'read' | 'write' | 'delete' | 'schema';
}

// ============================================================================
// Safety Guard Implementation
// ============================================================================

/**
 * Check if a Cypher query is safe to execute
 */
export function checkQuerySafety(
  query: string,
  graphSize?: number
): SafetyCheckResult {
  const result: SafetyCheckResult = {
    safe: true,
    requiresApproval: false,
    matchedPatterns: [],
    recommendations: [],
  };

  // Check for dangerous patterns
  for (const [patternName, pattern] of Object.entries(DANGEROUS_PATTERNS)) {
    if (pattern.test(query)) {
      result.safe = false;
      result.matchedPatterns.push(patternName);
      result.blockedReason = `Query contains dangerous pattern: ${patternName}`;
    }
  }

  // If already blocked, return
  if (!result.safe) {
    result.recommendations.push(
      'This query pattern is blocked for safety. Please use a more targeted approach.'
    );
    return result;
  }

  // Check for approval-required patterns
  for (const [patternName, pattern] of Object.entries(APPROVAL_REQUIRED_PATTERNS)) {
    if (pattern.test(query)) {
      result.requiresApproval = true;
      result.matchedPatterns.push(patternName);
      result.approvalReason = `Query requires approval: ${patternName}`;
    }
  }

  // Check for unbounded operations
  if (hasUnboundedOperation(query)) {
    result.requiresApproval = true;
    result.matchedPatterns.push('unbounded_operation');
    result.approvalReason = 'Query may affect an unbounded number of nodes';
    result.recommendations.push('Add LIMIT clause or more specific WHERE conditions');
  }

  // Check for DELETE without LIMIT
  if (hasDeleteWithoutLimit(query)) {
    result.requiresApproval = true;
    result.matchedPatterns.push('delete_without_limit');
    result.approvalReason = 'DELETE operation without LIMIT';
    result.recommendations.push('Add LIMIT clause to DELETE operations');
  }

  return result;
}

/**
 * Check if an operation would affect too much of the graph
 */
export function checkImpactSafety(
  metrics: OperationMetrics
): SafetyCheckResult {
  const result: SafetyCheckResult = {
    safe: true,
    requiresApproval: false,
    matchedPatterns: [],
    recommendations: [],
  };

  // Check node count threshold
  if (metrics.estimatedNodesAffected > SafetyConfig.maxDeleteBatchSize) {
    if (metrics.operationType === 'delete') {
      result.safe = false;
      result.blockedReason = `Operation would affect ${metrics.estimatedNodesAffected} nodes, exceeding max batch size of ${SafetyConfig.maxDeleteBatchSize}`;
      result.recommendations.push('Break into smaller batches');
    } else {
      result.requiresApproval = true;
      result.approvalReason = `Operation would affect ${metrics.estimatedNodesAffected} nodes`;
    }
  }

  // Check percentage threshold
  if (metrics.percentageOfGraph > SafetyConfig.maxGraphImpactPercent) {
    if (metrics.operationType === 'delete') {
      result.safe = false;
      result.blockedReason = `Operation would affect ${metrics.percentageOfGraph}% of graph, exceeding ${SafetyConfig.maxGraphImpactPercent}% limit`;
      result.recommendations.push('Use more targeted selection criteria');
    } else {
      result.requiresApproval = true;
      result.approvalReason = `Operation would affect ${metrics.percentageOfGraph}% of graph`;
    }
  }

  // Check approval threshold
  if (
    metrics.estimatedNodesAffected > SafetyConfig.approvalThreshold &&
    metrics.operationType !== 'read'
  ) {
    result.requiresApproval = true;
    result.approvalReason = `Operation affects more than ${SafetyConfig.approvalThreshold} nodes`;
  }

  return result;
}

/**
 * Validate a node deletion batch
 */
export function validateDeletionBatch(
  nodeIds: string[],
  totalGraphSize: number
): SafetyCheckResult {
  const percentageAffected = (nodeIds.length / totalGraphSize) * 100;

  return checkImpactSafety({
    estimatedNodesAffected: nodeIds.length,
    percentageOfGraph: percentageAffected,
    operationType: 'delete',
  });
}

/**
 * Check if a query has unbounded operations
 */
function hasUnboundedOperation(query: string): boolean {
  const normalizedQuery = query.toUpperCase();

  // Check for MATCH without WHERE that affects all nodes
  if (
    /MATCH\s*\(\w+\)(?!\s*WHERE)/.test(normalizedQuery) &&
    !/LIMIT/.test(normalizedQuery)
  ) {
    // Unless it's just a count or read
    if (/SET|DELETE|DETACH|REMOVE/.test(normalizedQuery)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if query has DELETE without LIMIT
 */
function hasDeleteWithoutLimit(query: string): boolean {
  const normalizedQuery = query.toUpperCase();

  if (/DELETE/.test(normalizedQuery) && !/LIMIT/.test(normalizedQuery)) {
    return true;
  }

  return false;
}

/**
 * Sanitize a query by adding safety limits
 */
export function sanitizeQuery(query: string): string {
  let sanitized = query.trim();

  // Add LIMIT if not present and query has potential write operations
  if (!/LIMIT\s+\d+/i.test(sanitized)) {
    const hasWriteOp = /(DELETE|SET|REMOVE|CREATE|MERGE)/i.test(sanitized);
    if (hasWriteOp) {
      // Add LIMIT before RETURN or at end
      if (/RETURN/i.test(sanitized)) {
        sanitized = sanitized.replace(
          /RETURN/i,
          `LIMIT ${SafetyConfig.maxDeleteBatchSize} RETURN`
        );
      } else {
        sanitized += ` LIMIT ${SafetyConfig.maxDeleteBatchSize}`;
      }
    }
  }

  return sanitized;
}

// ============================================================================
// Operation Rate Limiting
// ============================================================================

const operationTimestamps: Map<string, number> = new Map();

/**
 * Check if a destructive operation is allowed based on cooldown
 */
export function checkOperationCooldown(operationType: string): {
  allowed: boolean;
  waitTime: number;
} {
  const lastOperation = operationTimestamps.get(operationType);
  const now = Date.now();

  if (lastOperation) {
    const elapsed = now - lastOperation;
    if (elapsed < SafetyConfig.destructiveOperationCooldown) {
      return {
        allowed: false,
        waitTime: SafetyConfig.destructiveOperationCooldown - elapsed,
      };
    }
  }

  return { allowed: true, waitTime: 0 };
}

/**
 * Record an operation timestamp
 */
export function recordOperation(operationType: string): void {
  operationTimestamps.set(operationType, Date.now());
}

/**
 * Clear operation cooldowns (for testing)
 */
export function clearCooldowns(): void {
  operationTimestamps.clear();
}

// ============================================================================
// Bridge Node Protection
// ============================================================================

/**
 * Check if a node is a bridge node (high betweenness centrality)
 * Bridge nodes require approval regardless of confidence (T082)
 */
export async function isBridgeNode(
  nodeId: string,
  getBetweenness: (id: string) => Promise<number>
): Promise<{ isBridge: boolean; centrality: number }> {
  const BRIDGE_THRESHOLD = 0.1; // Top 10% of betweenness centrality

  try {
    const centrality = await getBetweenness(nodeId);
    return {
      isBridge: centrality > BRIDGE_THRESHOLD,
      centrality,
    };
  } catch {
    // If we can't determine, treat as potentially a bridge
    return {
      isBridge: true,
      centrality: -1,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

export default {
  checkQuerySafety,
  checkImpactSafety,
  validateDeletionBatch,
  sanitizeQuery,
  checkOperationCooldown,
  recordOperation,
  isBridgeNode,
  SafetyConfig,
};
