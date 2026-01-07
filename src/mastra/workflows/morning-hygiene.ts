/**
 * T022-T026: Morning Hygiene Workflow
 * Daily maintenance workflow for orphan detection and cleanup
 * Implements FR-001 (scheduled at 04:00 UTC), FR-002, FR-003, FR-004
 */

import { Workflow, Step } from '@mastra/core';
import { randomUUID } from 'crypto';
import { getAnalystAgent } from '../agents/analyst';
import { getAuditLogger } from '@/lib/audit-logger';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getScheduler, SCHEDULES } from '@/lib/scheduler';
import { registerWorkflow } from '../index';
import {
  WorkflowRun,
  WorkflowStatistics,
  GardeningIssue,
  IssueType,
  Severity,
} from '@/types';
import { ClassificationResult } from '../tools/analysis/orphan-classifier';

// ============================================================================
// Workflow Input/Output Types
// ============================================================================

interface MorningHygieneInput {
  scope?: {
    category?: string;
    brandId?: string;
  };
  dryRun?: boolean;
}

interface MorningHygieneOutput {
  workflowRunId: string;
  status: 'completed' | 'failed';
  statistics: WorkflowStatistics;
  deletedOrphans: string[];
  flaggedOrphans: string[];
  schemaViolations: number;
  duration: number;
}

// ============================================================================
// Workflow Steps
// ============================================================================

/**
 * Step 1: Detect orphan components using WCC algorithm
 */
const detectOrphansStep = new Step({
  id: 'detect-orphans',
  execute: async ({ context }) => {
    const analyst = getAnalystAgent();
    const result = await analyst.analyzeOrphans();

    return {
      orphanAnalysis: result.data,
      recommendations: result.data.recommendations,
    };
  },
});

/**
 * Step 2: Delete empty/generic orphans (FR-003)
 */
const deleteOrphansStep = new Step({
  id: 'delete-orphans',
  execute: async ({ context }) => {
    const { orphanAnalysis, recommendations, workflowRunId, dryRun } = context.stepResults['detect-orphans'] as {
      orphanAnalysis: { orphanCount: number };
      recommendations: { toDelete: ClassificationResult[]; toFlag: ClassificationResult[] };
      workflowRunId?: string;
      dryRun?: boolean;
    };

    const runId = workflowRunId ?? context.inputData?.workflowRunId ?? randomUUID();
    const isDryRun = dryRun ?? context.inputData?.dryRun ?? false;

    const client = getMemgraphClient();
    const auditLogger = getAuditLogger();
    const deletedIds: string[] = [];

    for (const orphan of recommendations.toDelete) {
      try {
        if (!isDryRun) {
          // Get node data before deletion for audit
          const nodeQuery = `
            MATCH (n) WHERE n.id = $nodeId
            RETURN n.id AS id, n.name AS name, properties(n) AS props
          `;
          const nodeData = await client.readOnlyQuery<{
            id: string;
            name: string;
            props: Record<string, unknown>;
          }>(nodeQuery, { nodeId: orphan.nodeId });

          const before = nodeData[0] ?? { id: orphan.nodeId, name: '', props: {} };

          // Delete the orphan node
          const deleteQuery = `
            MATCH (n) WHERE n.id = $nodeId
            DETACH DELETE n
          `;
          await client.writeTransaction(deleteQuery, { nodeId: orphan.nodeId });

          // T026: Log deletion to audit trail
          await auditLogger.logDelete(
            runId,
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
          runId,
          'morning-hygiene',
          orphan.nodeId,
          'GearItem',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return {
      deletedIds,
      deletedCount: deletedIds.length,
      workflowRunId: runId,
    };
  },
});

/**
 * Step 3: Flag valuable orphans for review (FR-004)
 */
const flagOrphansStep = new Step({
  id: 'flag-orphans',
  execute: async ({ context }) => {
    const { recommendations } = context.stepResults['detect-orphans'] as {
      recommendations: { toDelete: ClassificationResult[]; toFlag: ClassificationResult[] };
    };
    const { workflowRunId, dryRun } = context.stepResults['delete-orphans'] as {
      workflowRunId: string;
      dryRun?: boolean;
    };

    const isDryRun = dryRun ?? context.inputData?.dryRun ?? false;
    const auditLogger = getAuditLogger();
    const flaggedIds: string[] = [];

    for (const orphan of recommendations.toFlag) {
      try {
        // Create a gardening issue for review
        const issue: GardeningIssue = {
          id: randomUUID(),
          type: 'orphan' as IssueType,
          severity: orphan.classification === 'large_island' ? 'high' : 'medium' as Severity,
          entities: [orphan.nodeId],
          suggestedAction: 'Review and resolve orphan node',
          confidence: orphan.confidence,
          status: 'open',
          detectedAt: new Date().toISOString(),
          workflowRunId,
          graphContext: {
            classification: orphan.classification,
            detectedKeywords: orphan.detectedKeywords,
            reasoning: orphan.reasoning,
          },
        };

        if (!isDryRun) {
          // Log flagging action
          await auditLogger.logFlag(
            workflowRunId,
            'morning-hygiene',
            orphan.nodeId,
            'GearItem',
            {
              confidence: orphan.confidence,
              reasoning: orphan.reasoning,
              issueId: issue.id,
            }
          );
        }

        flaggedIds.push(orphan.nodeId);
      } catch (error) {
        console.error(`Failed to flag orphan ${orphan.nodeId}:`, error);
      }
    }

    return {
      flaggedIds,
      flaggedCount: flaggedIds.length,
    };
  },
});

/**
 * Step 4: Validate schema constraints
 */
const validateSchemaStep = new Step({
  id: 'validate-schema',
  execute: async ({ context }) => {
    const analyst = getAnalystAgent();
    const result = await analyst.validateSchema();

    const { workflowRunId } = context.stepResults['delete-orphans'] as {
      workflowRunId: string;
    };

    const auditLogger = getAuditLogger();

    // Auto-fix whitespace violations
    const client = getMemgraphClient();
    let autoFixedCount = 0;

    for (const violation of result.data.violations) {
      if (violation.details.includes('whitespace')) {
        try {
          // Auto-fix by trimming whitespace
          const fixQuery = `
            MATCH (n) WHERE n.id = $nodeId
            SET n.name = trim(n.name)
            RETURN n.name AS newName
          `;
          await client.writeTransaction(fixQuery, { nodeId: violation.nodeId });

          await auditLogger.logUpdate(
            workflowRunId,
            'morning-hygiene',
            violation.nodeId,
            'GearItem',
            { name: violation.nodeName },
            { name: violation.nodeName.trim() },
            {
              confidence: 1.0,
              reasoning: 'Auto-fixed: Trimmed leading/trailing whitespace',
            }
          );

          autoFixedCount++;
        } catch (error) {
          console.error(`Failed to auto-fix ${violation.nodeId}:`, error);
        }
      }
    }

    return {
      violations: result.data.violations,
      violationCount: result.data.violationCount,
      autoFixedCount,
    };
  },
});

/**
 * Step 5: Generate summary report
 */
const generateReportStep = new Step({
  id: 'generate-report',
  execute: async ({ context }) => {
    const startTime = context.metadata?.startTime as number ?? Date.now();
    const { deletedIds, workflowRunId } = context.stepResults['delete-orphans'] as {
      deletedIds: string[];
      workflowRunId: string;
    };
    const { flaggedIds } = context.stepResults['flag-orphans'] as {
      flaggedIds: string[];
    };
    const { violationCount, autoFixedCount } = context.stepResults['validate-schema'] as {
      violationCount: number;
      autoFixedCount: number;
    };
    const { orphanAnalysis } = context.stepResults['detect-orphans'] as {
      orphanAnalysis: { orphanCount: number };
    };

    const statistics: WorkflowStatistics = {
      itemsProcessed: orphanAnalysis.orphanCount,
      issuesDetected: orphanAnalysis.orphanCount + violationCount,
      autoFixed: deletedIds.length + autoFixedCount,
      flaggedForReview: flaggedIds.length,
      errors: 0,
    };

    const duration = Date.now() - startTime;

    const output: MorningHygieneOutput = {
      workflowRunId,
      status: 'completed',
      statistics,
      deletedOrphans: deletedIds,
      flaggedOrphans: flaggedIds,
      schemaViolations: violationCount,
      duration,
    };

    console.info(`Morning hygiene completed in ${duration}ms:`, {
      deleted: deletedIds.length,
      flagged: flaggedIds.length,
      schemaViolations: violationCount,
      autoFixed: autoFixedCount,
    });

    return output;
  },
});

// ============================================================================
// Workflow Definition
// ============================================================================

export const morningHygieneWorkflow = new Workflow({
  name: 'morning-hygiene',
  description: 'Daily maintenance workflow for orphan detection and cleanup',
})
  .then(detectOrphansStep)
  .then(deleteOrphansStep)
  .then(flagOrphansStep)
  .then(validateSchemaStep)
  .then(generateReportStep);

// Register workflow
registerWorkflow('morning-hygiene', morningHygieneWorkflow);

// ============================================================================
// Scheduler Integration (T025)
// ============================================================================

/**
 * Schedule the morning hygiene workflow
 * Per FR-001: Daily at 04:00 UTC
 */
export function scheduleMorningHygiene(): void {
  const scheduler = getScheduler();

  scheduler.schedule(
    'morning-hygiene',
    SCHEDULES.MORNING_HYGIENE,
    async () => {
      const workflowRunId = randomUUID();
      console.info(`Starting scheduled morning hygiene: ${workflowRunId}`);

      try {
        const result = await morningHygieneWorkflow.execute({
          inputData: { workflowRunId },
          metadata: { startTime: Date.now() },
        });

        console.info(`Scheduled morning hygiene completed: ${workflowRunId}`, result);
      } catch (error) {
        console.error(`Scheduled morning hygiene failed: ${workflowRunId}`, error);
      }
    },
    { description: 'Daily orphan cleanup and schema validation' }
  );
}

/**
 * Manually trigger the morning hygiene workflow
 */
export async function runMorningHygiene(
  options?: MorningHygieneInput
): Promise<MorningHygieneOutput> {
  const workflowRunId = randomUUID();

  const result = await morningHygieneWorkflow.execute({
    inputData: {
      workflowRunId,
      ...options,
    },
    metadata: { startTime: Date.now() },
  });

  return result as MorningHygieneOutput;
}

export default morningHygieneWorkflow;
