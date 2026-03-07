/**
 * Morning Hygiene Workflow v2
 *
 * Mastra-native implementation using createWorkflow() and createStep().
 * Daily maintenance workflow for orphan detection and cleanup.
 *
 * Implements FR-001 (scheduled at 04:00 UTC), FR-002, FR-003, FR-004
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getAuditLogger } from '@/lib/audit-logger';
import { registerWorkflow } from '../index';

// ============================================================================
// Schemas
// ============================================================================

const OrphanClassificationSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  nodeType: z.string(),
  classification: z.enum(['empty', 'generic', 'valuable', 'small_island', 'large_island']),
  confidence: z.number(),
  reasoning: z.string(),
  hasValuableData: z.boolean(),
});

const WorkflowInputSchema = z.object({
  workflowRunId: z.string().optional(),
  scope: z.object({
    category: z.string().optional(),
    brandId: z.string().optional(),
  }).optional(),
  dryRun: z.boolean().default(false),
});

const WorkflowOutputSchema = z.object({
  workflowRunId: z.string(),
  status: z.enum(['completed', 'failed']),
  statistics: z.object({
    orphansDetected: z.number(),
    orphansDeleted: z.number(),
    orphansFlagged: z.number(),
    schemaViolations: z.number(),
    brandInNameFixed: z.number(),
  }),
  deletedOrphans: z.array(z.string()),
  flaggedOrphans: z.array(z.string()),
  duration: z.number(),
});

// ============================================================================
// Step 1: Detect Orphans
// ============================================================================

const detectOrphansStep = createStep({
  id: 'detect-orphans',
  inputSchema: WorkflowInputSchema,
  outputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    orphanCount: z.number(),
    toDelete: z.array(OrphanClassificationSchema),
    toFlag: z.array(OrphanClassificationSchema),
  }),
  execute: async ({ inputData }) => {
    const workflowRunId = inputData.workflowRunId ?? `morning-hygiene-${Date.now()}`;

    // Dynamic import to avoid circular dependency
    const { getAnalystAgent } = await import('../agents/analyst');
    const analyst = getAnalystAgent();
    const result = await analyst.analyzeOrphans();

    return {
      workflowRunId,
      dryRun: inputData.dryRun ?? false,
      orphanCount: result.data.orphanCount,
      toDelete: result.data.recommendations.toDelete.map(o => ({
        nodeId: o.nodeId,
        name: o.nodeId, // Use nodeId as name fallback (name not in ClassificationResult)
        nodeType: 'Unknown', // Not available in ClassificationResult
        classification: o.classification as 'empty' | 'generic' | 'valuable' | 'small_island' | 'large_island',
        confidence: o.confidence,
        reasoning: o.reasoning,
        hasValuableData: o.hasValuableKeywords, // Use hasValuableKeywords
      })),
      toFlag: result.data.recommendations.toFlag.map(o => ({
        nodeId: o.nodeId,
        name: o.nodeId, // Use nodeId as name fallback (name not in ClassificationResult)
        nodeType: 'Unknown', // Not available in ClassificationResult
        classification: o.classification as 'empty' | 'generic' | 'valuable' | 'small_island' | 'large_island',
        confidence: o.confidence,
        reasoning: o.reasoning,
        hasValuableData: o.hasValuableKeywords, // Use hasValuableKeywords
      })),
    };
  },
});

// ============================================================================
// Step 2: Delete Orphans
// ============================================================================

const deleteOrphansStep = createStep({
  id: 'delete-orphans',
  inputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    orphanCount: z.number(),
    toDelete: z.array(OrphanClassificationSchema),
    toFlag: z.array(OrphanClassificationSchema),
  }),
  outputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    toFlag: z.array(OrphanClassificationSchema),
    deletedIds: z.array(z.string()),
    deletedCount: z.number(),
    orphanCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { workflowRunId, dryRun, toDelete, toFlag, orphanCount } = inputData;
    const client = getMemgraphClient();
    const auditLogger = getAuditLogger();
    const deletedIds: string[] = [];

    for (const orphan of toDelete) {
      try {
        if (!dryRun) {
          // Get node data before deletion for audit
          const nodeData = await client.readOnlyQuery<{
            id: string;
            name: string;
            props: Record<string, unknown>;
          }>(`
            MATCH (n) WHERE n.id = $nodeId
            RETURN n.id AS id, n.name AS name, properties(n) AS props
          `, { nodeId: orphan.nodeId });

          const before = nodeData[0] ?? { id: orphan.nodeId, name: '', props: {} };

          // Delete the orphan node
          await client.writeTransaction(`
            MATCH (n) WHERE n.id = $nodeId
            DETACH DELETE n
          `, { nodeId: orphan.nodeId });

          // Log deletion to audit trail
          await auditLogger.logDelete(
            workflowRunId,
            'morning-hygiene',
            orphan.nodeId,
            'GearItem',
            { name: before.name, properties: before.props },
            {
              confidence: orphan.confidence,
              reasoning: orphan.reasoning,
            }
          );
        }
        deletedIds.push(orphan.nodeId);
      } catch (error) {
        console.error(`Failed to delete orphan ${orphan.nodeId}:`, error);
        await auditLogger.logError(
          workflowRunId,
          'morning-hygiene',
          orphan.nodeId,
          'GearItem',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return {
      workflowRunId,
      dryRun,
      toFlag,
      deletedIds,
      deletedCount: deletedIds.length,
      orphanCount,
    };
  },
});

// ============================================================================
// Step 3: Flag Orphans for Review
// ============================================================================

const flagOrphansStep = createStep({
  id: 'flag-orphans',
  inputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    toFlag: z.array(OrphanClassificationSchema),
    deletedIds: z.array(z.string()),
    deletedCount: z.number(),
    orphanCount: z.number(),
  }),
  outputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    deletedIds: z.array(z.string()),
    deletedCount: z.number(),
    orphanCount: z.number(),
    flaggedIds: z.array(z.string()),
    flaggedCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { workflowRunId, dryRun, toFlag, deletedIds, deletedCount, orphanCount } = inputData;
    const { getLibSQLClient } = await import('../index');
    const db = getLibSQLClient();
    const auditLogger = getAuditLogger();
    const client = getMemgraphClient();
    const flaggedIds: string[] = [];

    for (const orphan of toFlag) {
      try {
        if (!dryRun) {
          // Get full node data for context
          const nodeData = await client.readOnlyQuery<{
            id: string;
            name: string;
            props: Record<string, unknown>;
          }>(`
            MATCH (n) WHERE n.id = $nodeId
            RETURN n.id AS id, n.name AS name, properties(n) AS props
          `, { nodeId: orphan.nodeId });

          const node = nodeData[0];
          if (!node) continue;

          // Create gardening issue
          const issueId = randomUUID();
          await db.execute({
            sql: `
              INSERT INTO gardening_issues (id, type, severity, entity_id, title, description, status, detected_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              issueId,
              'orphan',
              orphan.hasValuableData ? 'medium' : 'low',
              orphan.nodeId,
              `Orphan node: ${orphan.name}`,
              orphan.reasoning,
              'open',
              'morning-hygiene',
              new Date().toISOString(),
            ],
          });

          // Create approval request
          const approvalId = randomUUID();
          await db.execute({
            sql: `
              INSERT INTO approval_requests (id, issue_id, workflow_run_id, proposed_action, candidates, reasoning, confidence, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              approvalId,
              issueId,
              workflowRunId,
              'delete',
              JSON.stringify([{
                nodeId: orphan.nodeId,
                nodeName: orphan.name,
                nodeProperties: node.props,
              }]),
              orphan.reasoning,
              orphan.confidence,
              'pending',
              new Date().toISOString(),
            ],
          });

          // Log flag action
          await auditLogger.logFlag(
            workflowRunId,
            'morning-hygiene',
            orphan.nodeId,
            'GearItem',
            {
              confidence: orphan.confidence,
              reasoning: orphan.reasoning,
              // Note: classification is not in the allowed flag metadata type
            }
          );
        }
        flaggedIds.push(orphan.nodeId);
      } catch (error) {
        console.error(`Failed to flag orphan ${orphan.nodeId}:`, error);
      }
    }

    return {
      workflowRunId,
      dryRun,
      deletedIds,
      deletedCount,
      orphanCount,
      flaggedIds,
      flaggedCount: flaggedIds.length,
    };
  },
});

// ============================================================================
// Step 4: Validate Schema
// ============================================================================

const validateSchemaStep = createStep({
  id: 'validate-schema',
  inputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    deletedIds: z.array(z.string()),
    deletedCount: z.number(),
    orphanCount: z.number(),
    flaggedIds: z.array(z.string()),
    flaggedCount: z.number(),
  }),
  outputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    deletedIds: z.array(z.string()),
    deletedCount: z.number(),
    orphanCount: z.number(),
    flaggedIds: z.array(z.string()),
    flaggedCount: z.number(),
    schemaViolations: z.number(),
    brandInNameFixed: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { getAnalystAgent } = await import('../agents/analyst');
    const analyst = getAnalystAgent();

    // Run schema validation
    const validation = await analyst.validateSchema();

    // Count violations that were detected (validation is AnalysisResult wrapping the data)
    const schemaViolations = validation.data.violations?.length ?? 0;

    // Brand-in-name fixes would be handled separately
    const brandInNameFixed = 0;

    return {
      ...inputData,
      schemaViolations,
      brandInNameFixed,
    };
  },
});

// ============================================================================
// Step 5: Finalize and Report
// ============================================================================

const finalizeStep = createStep({
  id: 'finalize',
  inputSchema: z.object({
    workflowRunId: z.string(),
    dryRun: z.boolean(),
    deletedIds: z.array(z.string()),
    deletedCount: z.number(),
    orphanCount: z.number(),
    flaggedIds: z.array(z.string()),
    flaggedCount: z.number(),
    schemaViolations: z.number(),
    brandInNameFixed: z.number(),
  }),
  outputSchema: WorkflowOutputSchema,
  execute: async ({ inputData }) => {
    const startTime = Date.now();

    return {
      workflowRunId: inputData.workflowRunId,
      status: 'completed' as const,
      statistics: {
        orphansDetected: inputData.orphanCount,
        orphansDeleted: inputData.deletedCount,
        orphansFlagged: inputData.flaggedCount,
        schemaViolations: inputData.schemaViolations,
        brandInNameFixed: inputData.brandInNameFixed,
      },
      deletedOrphans: inputData.deletedIds,
      flaggedOrphans: inputData.flaggedIds,
      duration: Date.now() - startTime,
    };
  },
});

// ============================================================================
// Workflow Definition
// ============================================================================

export const morningHygieneWorkflowV2 = createWorkflow({
  id: 'morning-hygiene-v2',
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowOutputSchema,
})
  .then(detectOrphansStep)
  .then(deleteOrphansStep)
  .then(flagOrphansStep)
  .then(validateSchemaStep)
  .then(finalizeStep)
  .commit();

// Register with workflow registry
registerWorkflow('morning-hygiene-v2', morningHygieneWorkflowV2);

// ============================================================================
// Exports
// ============================================================================

export {
  detectOrphansStep,
  deleteOrphansStep,
  flagOrphansStep,
  validateSchemaStep,
  finalizeStep,
};

export default morningHygieneWorkflowV2;
