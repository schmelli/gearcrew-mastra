/**
 * T022-T026: Morning Hygiene Workflow
 * Daily maintenance workflow for orphan detection and cleanup
 * Implements FR-001 (scheduled at 04:00 UTC), FR-002, FR-003, FR-004
 */

import { randomUUID } from 'crypto';
import { getAnalystAgent } from '../agents/analyst';
import { getAuditLogger } from '@/lib/audit-logger';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getScheduler, SCHEDULES } from '@/lib/scheduler';
import { registerWorkflow } from '../index';
import {
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
  workflowRunId?: string;
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

interface OrphanAnalysisResult {
  orphanCount: number;
  recommendations: {
    toDelete: ClassificationResult[];
    toFlag: ClassificationResult[];
  };
}

// ============================================================================
// Workflow Step Functions
// ============================================================================

/**
 * Step 1: Detect orphan components using WCC algorithm
 */
async function detectOrphans(): Promise<OrphanAnalysisResult> {
  const analyst = getAnalystAgent();
  const result = await analyst.analyzeOrphans();

  return {
    orphanCount: result.data.orphanCount,
    recommendations: result.data.recommendations,
  };
}

/**
 * Step 2: Delete empty/generic orphans (FR-003)
 */
async function deleteOrphans(
  workflowRunId: string,
  recommendations: { toDelete: ClassificationResult[] },
  dryRun: boolean
): Promise<{ deletedIds: string[]; deletedCount: number }> {
  const client = getMemgraphClient();
  const auditLogger = getAuditLogger();
  const deletedIds: string[] = [];

  for (const orphan of recommendations.toDelete) {
    try {
      if (!dryRun) {
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

  return { deletedIds, deletedCount: deletedIds.length };
}

/**
 * Step 3: Flag valuable orphans for review (FR-004)
 */
async function flagOrphans(
  workflowRunId: string,
  recommendations: { toFlag: ClassificationResult[] },
  dryRun: boolean
): Promise<{ flaggedIds: string[]; flaggedCount: number }> {
  const auditLogger = getAuditLogger();
  const flaggedIds: string[] = [];

  for (const orphan of recommendations.toFlag) {
    try {
      // Create a gardening issue for review
      const issue: GardeningIssue = {
        id: randomUUID(),
        type: 'orphan' as IssueType,
        severity: (orphan.classification === 'large_island' ? 'high' : 'medium') as Severity,
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

      if (!dryRun) {
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

  return { flaggedIds, flaggedCount: flaggedIds.length };
}

/**
 * Step 4: Validate schema constraints
 */
async function validateSchema(
  workflowRunId: string
): Promise<{ violationCount: number; autoFixedCount: number }> {
  const analyst = getAnalystAgent();
  const result = await analyst.validateSchema();
  const auditLogger = getAuditLogger();
  const client = getMemgraphClient();
  let autoFixedCount = 0;

  // Auto-fix whitespace violations
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
    violationCount: result.data.violationCount,
    autoFixedCount,
  };
}

// ============================================================================
// Main Workflow Execution
// ============================================================================

/**
 * Execute the morning hygiene workflow
 */
export async function executeMorningHygieneWorkflow(
  options?: MorningHygieneInput
): Promise<MorningHygieneOutput> {
  const startTime = Date.now();
  const workflowRunId = options?.workflowRunId ?? randomUUID();
  const dryRun = options?.dryRun ?? false;

  console.info(`Starting morning hygiene workflow: ${workflowRunId}`);

  try {
    // Step 1: Detect orphans
    const orphanAnalysis = await detectOrphans();

    // Step 2: Delete empty/generic orphans
    const { deletedIds } = await deleteOrphans(
      workflowRunId,
      { toDelete: orphanAnalysis.recommendations.toDelete },
      dryRun
    );

    // Step 3: Flag valuable orphans
    const { flaggedIds } = await flagOrphans(
      workflowRunId,
      { toFlag: orphanAnalysis.recommendations.toFlag },
      dryRun
    );

    // Step 4: Validate schema
    const { violationCount, autoFixedCount } = await validateSchema(workflowRunId);

    // Generate statistics
    const duration = Date.now() - startTime;
    const statistics: WorkflowStatistics = {
      itemsProcessed: orphanAnalysis.orphanCount,
      issuesDetected: orphanAnalysis.orphanCount + violationCount,
      autoFixed: deletedIds.length + autoFixedCount,
      flaggedForReview: flaggedIds.length,
      errors: 0,
    };

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
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`Morning hygiene failed: ${workflowRunId}`, error);

    return {
      workflowRunId,
      status: 'failed',
      statistics: {
        itemsProcessed: 0,
        issuesDetected: 0,
        autoFixed: 0,
        flaggedForReview: 0,
        errors: 1,
      },
      deletedOrphans: [],
      flaggedOrphans: [],
      schemaViolations: 0,
      duration,
    };
  }
}

// Register workflow
registerWorkflow('morning-hygiene', executeMorningHygieneWorkflow);

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
        const result = await executeMorningHygieneWorkflow({ workflowRunId });
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
  return executeMorningHygieneWorkflow(options);
}

export default executeMorningHygieneWorkflow;
