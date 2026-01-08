/**
 * T032-T038: Deep Deduplication Workflow
 * Implements FR-005 through FR-016 for duplicate detection and resolution
 * Uses Mastra workflow with suspend/resume for human-in-the-loop
 * Per Constitution Principle III: Human Oversight
 */

import { z } from 'zod';
import {
  CONFIDENCE_THRESHOLDS,
  DuplicateCandidate,
  ApprovalRequest,
  GardeningIssue,
} from '@/types';
import { scanForDuplicates, enrichCandidateWithRelationships } from '../tools/analysis/vector-similarity';
import { getResolverAgent, EvaluationResult } from '../agents/resolver';
import { getAuditLogger } from '@/lib/audit-logger';
import { registerWorkflow, getLibSQLClient } from '../index';

/**
 * Workflow context passed between steps
 */
interface DeduplicationContext {
  runId: string;
  startedAt: string;
  candidates: DuplicateCandidate[];
  evaluated: EvaluationResult[];
  autoMerged: string[];
  pendingApproval: ApprovalRequest[];
  rejected: string[];
  skipped: string[];
  errors: Array<{ candidateId: string; error: string }>;
}

/**
 * Step result types
 */
interface ScanResult {
  candidates: DuplicateCandidate[];
  scannedCount: number;
  duplicatesFound: number;
}

interface EvaluateResult {
  evaluated: EvaluationResult[];
  autoMergeCount: number;
  approvalCount: number;
  skipCount: number;
}

interface AutoMergeResult {
  merged: string[];
  errors: Array<{ candidateId: string; error: string }>;
}

interface SuspendResult {
  approvalRequests: ApprovalRequest[];
  suspendedAt: string;
}

interface ResumeResult {
  decision: 'approve' | 'reject';
  propertyResolutions?: Record<string, unknown>;
  notes?: string;
}

interface CompletionResult {
  summary: {
    scanned: number;
    duplicatesFound: number;
    autoMerged: number;
    approved: number;
    rejected: number;
    skipped: number;
    errors: number;
  };
  completedAt: string;
}

/**
 * T033: Scan step - detect duplicate candidates
 */
async function scanStep(): Promise<ScanResult> {
  const scanResult = await scanForDuplicates();

  return {
    candidates: scanResult.candidates,
    scannedCount: scanResult.scannedCount,
    duplicatesFound: scanResult.duplicatesFound,
  };
}

/**
 * T034: Evaluate step - route candidates by confidence
 */
async function evaluateStep(
  candidates: DuplicateCandidate[]
): Promise<EvaluateResult> {
  const resolver = getResolverAgent();
  const batchResult = await resolver.evaluateBatch(candidates);

  return {
    evaluated: batchResult.evaluated,
    autoMergeCount: batchResult.autoMerged.length,
    approvalCount: batchResult.pendingApproval.length,
    skipCount: batchResult.skipped.length,
  };
}

/**
 * T035: Auto-merge step - execute high-confidence merges
 * Per FR-006: Auto-merge when confidence > 98%
 */
async function autoMergeStep(
  evaluated: EvaluationResult[],
  runId: string
): Promise<AutoMergeResult> {
  const resolver = getResolverAgent();
  const logger = getAuditLogger();
  const merged: string[] = [];
  const errors: Array<{ candidateId: string; error: string }> = [];

  // Filter to auto-merge eligible
  const autoMergeEligible = evaluated.filter(
    (e) => e.decision.confidence >= CONFIDENCE_THRESHOLDS.AUTO_MERGE
  );

  for (const evaluation of autoMergeEligible) {
    try {
      // Check for blocking rules
      const blocked = await resolver.isBlockedByRule(evaluation.candidate);

      if (blocked.blocked) {
        errors.push({
          candidateId: `${evaluation.candidate.nodeA.nodeId}|${evaluation.candidate.nodeB.nodeId}`,
          error: `Blocked by rule ${blocked.ruleId}: ${blocked.reason}`,
        });
        continue;
      }

      // Execute merge
      const mergeResult = await resolver.executeMerge(
        evaluation.decision.survivorId,
        evaluation.decision.absorbedId,
        evaluation.decision.propertyResolutions
      );

      if (mergeResult.success) {
        merged.push(mergeResult.absorbedId);

        // Log to audit trail
        await logger.logMerge(
          runId,
          'deep-deduplication',
          mergeResult.absorbedId,
          'GearItem',
          {
            name: evaluation.candidate.nodeB.nodeName,
            properties: evaluation.candidate.nodeB.nodeProperties,
          },
          {
            merged: true,
            survivorId: mergeResult.survivorId,
            relationshipsTransferred: mergeResult.relationshipsTransferred,
          },
          {
            confidence: evaluation.decision.confidence,
            reasoning: evaluation.decision.reasoning,
            autoMerge: true,
          }
        );
      }
    } catch (error) {
      errors.push({
        candidateId: `${evaluation.candidate.nodeA.nodeId}|${evaluation.candidate.nodeB.nodeId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { merged, errors };
}

/**
 * T036: Suspend step - create approval requests for human review
 * Per FR-007: Suspend for 80-98% confidence
 */
async function suspendStep(
  evaluated: EvaluationResult[],
  runId: string
): Promise<SuspendResult> {
  const approvalRequests: ApprovalRequest[] = [];
  const db = getLibSQLClient();

  // Filter to approval-required
  const needsApproval = evaluated.filter(
    (e) =>
      e.decision.confidence >= CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL &&
      e.decision.confidence < CONFIDENCE_THRESHOLDS.AUTO_MERGE
  );

  for (const evaluation of needsApproval) {
    if (evaluation.approvalRequest) {
      const request = {
        ...evaluation.approvalRequest,
        workflowRunId: runId,
      };

      // Store approval request in LibSQL
      await db.execute({
        sql: `
          INSERT INTO approval_requests (
            id, workflow_run_id, step_id, proposed_action,
            candidates, reasoning, confidence, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          request.id,
          request.workflowRunId,
          request.stepId,
          request.proposedAction,
          JSON.stringify(request.candidates),
          request.reasoning,
          request.confidence,
          request.status,
          request.createdAt,
        ],
      });

      // Create gardening issue for the approval
      const issueId = `issue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await db.execute({
        sql: `
          INSERT INTO gardening_issues (
            id, issue_type, severity, title, description,
            affected_nodes, detected_at, status, workflow_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          issueId,
          'potential_duplicate',
          'warning',
          `Potential duplicate: ${evaluation.candidate.nodeA.nodeName} / ${evaluation.candidate.nodeB.nodeName}`,
          evaluation.decision.reasoning,
          JSON.stringify([
            evaluation.candidate.nodeA.nodeId,
            evaluation.candidate.nodeB.nodeId,
          ]),
          new Date().toISOString(),
          'open',
          runId,
        ],
      });

      // Update approval request with issue ID
      request.issueId = issueId;
      await db.execute({
        sql: `UPDATE approval_requests SET issue_id = ? WHERE id = ?`,
        args: [issueId, request.id],
      });

      approvalRequests.push(request);
    }
  }

  return {
    approvalRequests,
    suspendedAt: new Date().toISOString(),
  };
}

/**
 * T037: Resume step - process human decision
 * Per FR-008/FR-009: Execute approved merge or record rejection
 */
async function resumeStep(
  approvalRequest: ApprovalRequest,
  humanDecision: ResumeResult,
  runId: string
): Promise<{
  action: 'merged' | 'rejected';
  details: string;
}> {
  const resolver = getResolverAgent();
  const logger = getAuditLogger();
  const db = getLibSQLClient();

  if (humanDecision.decision === 'approve') {
    // Get the candidates
    const nodeA = approvalRequest.candidates[0]!;
    const nodeB = approvalRequest.candidates[1]!;

    // Determine survivor (use stored decision or recalculate)
    const survivorId = nodeA.nodeId; // Simplified - would use stored decision
    const absorbedId = nodeB.nodeId;

    // Apply property resolutions from human
    const propertyResolutions = humanDecision.propertyResolutions ?? {};

    // Execute merge
    const mergeResult = await resolver.executeMerge(
      survivorId,
      absorbedId,
      propertyResolutions
    );

    // Update approval status
    await db.execute({
      sql: `
        UPDATE approval_requests
        SET status = 'approved', resolved_at = ?, resolution_notes = ?
        WHERE id = ?
      `,
      args: [new Date().toISOString(), humanDecision.notes ?? '', approvalRequest.id],
    });

    // Update issue status
    await db.execute({
      sql: `UPDATE gardening_issues SET status = 'resolved', resolved_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), approvalRequest.issueId],
    });

    // Log to audit trail
    await logger.logMerge(
      runId,
      'deep-deduplication',
      absorbedId,
      'GearItem',
      { name: nodeB.nodeName, properties: nodeB.nodeProperties },
      {
        merged: true,
        survivorId,
        relationshipsTransferred: mergeResult.relationshipsTransferred,
      },
      {
        confidence: approvalRequest.confidence,
        humanApproved: true,
        reasoning: humanDecision.notes,
      }
    );

    return {
      action: 'merged',
      details: `Merged ${nodeB.nodeName} into ${nodeA.nodeName}`,
    };
  } else {
    // Rejection - create correction rule per FR-016
    const nodeA = approvalRequest.candidates[0]!;
    const nodeB = approvalRequest.candidates[1]!;

    const ruleId = `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const now = new Date().toISOString();
    await db.execute({
      sql: `
        INSERT INTO correction_rules (
          id, type, name, description, condition_json, action_json, source, confidence, created_at, updated_at, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        ruleId,
        'no_merge',
        `No merge: ${nodeA.nodeName} / ${nodeB.nodeName}`,
        humanDecision.notes ?? 'User rejected merge',
        JSON.stringify({ entityIds: [nodeA.nodeId, nodeB.nodeId] }),
        JSON.stringify({ action: 'skip_merge' }),
        'human_decision',
        1.0,
        now,
        now,
        1,
      ],
    });

    // Update approval status
    await db.execute({
      sql: `
        UPDATE approval_requests
        SET status = 'rejected', resolved_at = ?, resolution_notes = ?
        WHERE id = ?
      `,
      args: [new Date().toISOString(), humanDecision.notes ?? '', approvalRequest.id],
    });

    // Update issue status
    await db.execute({
      sql: `UPDATE gardening_issues SET status = 'wont_fix', resolved_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), approvalRequest.issueId],
    });

    // Log rejection
    await logger.logSkip(
      runId,
      'deep-deduplication',
      [nodeA.nodeId, nodeB.nodeId],
      'GearItem',
      `Merge rejected: ${humanDecision.notes ?? 'No reason provided'}`,
      { correctionRuleId: ruleId }
    );

    return {
      action: 'rejected',
      details: `Rejected merge of ${nodeA.nodeName} and ${nodeB.nodeName}. Created no_merge rule.`,
    };
  }
}

/**
 * T038: Complete step - generate summary report
 */
async function completeStep(
  context: DeduplicationContext
): Promise<CompletionResult> {
  const db = getLibSQLClient();

  // Count approved approvals
  const approvedResult = await db.execute({
    sql: `
      SELECT COUNT(*) as count FROM approval_requests
      WHERE workflow_run_id = ? AND status = 'approved'
    `,
    args: [context.runId],
  });
  const approvedCount = (approvedResult.rows[0]?.count as number) ?? 0;

  // Count rejected
  const rejectedResult = await db.execute({
    sql: `
      SELECT COUNT(*) as count FROM approval_requests
      WHERE workflow_run_id = ? AND status = 'rejected'
    `,
    args: [context.runId],
  });
  const rejectedCount = (rejectedResult.rows[0]?.count as number) ?? 0;

  const summary = {
    scanned: context.candidates.length > 0
      ? context.evaluated.length
      : 0,
    duplicatesFound: context.candidates.length,
    autoMerged: context.autoMerged.length,
    approved: approvedCount,
    rejected: rejectedCount,
    skipped: context.skipped.length,
    errors: context.errors.length,
  };

  // Update workflow run status
  await db.execute({
    sql: `
      UPDATE workflow_runs
      SET status = 'completed', completed_at = ?, result_summary = ?
      WHERE id = ?
    `,
    args: [new Date().toISOString(), JSON.stringify(summary), context.runId],
  });

  return {
    summary,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Main workflow execution
 * Orchestrates all steps with suspend/resume support
 */
export async function executeDeduplicationWorkflow(
  runId?: string
): Promise<CompletionResult> {
  const db = getLibSQLClient();
  const workflowRunId = runId ?? `dedup-${Date.now()}`;
  const wasTriggeredExternally = !!runId; // If runId provided, record already exists

  // Initialize context
  const context: DeduplicationContext = {
    runId: workflowRunId,
    startedAt: new Date().toISOString(),
    candidates: [],
    evaluated: [],
    autoMerged: [],
    pendingApproval: [],
    rejected: [],
    skipped: [],
    errors: [],
  };

  // Only create workflow run record if not triggered via API (which already creates it)
  if (!wasTriggeredExternally) {
    await db.execute({
      sql: `
        INSERT INTO workflow_runs (id, workflow_name, status, started_at, context)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        context.runId,
        'deep-deduplication',
        'running',
        context.startedAt,
        JSON.stringify(context),
      ],
    });
  }

  try {
    // Step 1: Scan for duplicates
    const scanResult = await scanStep();
    context.candidates = scanResult.candidates;

    if (scanResult.duplicatesFound === 0) {
      // No duplicates found - complete early
      return await completeStep(context);
    }

    // Step 2: Evaluate candidates
    const evalResult = await evaluateStep(context.candidates);
    context.evaluated = evalResult.evaluated;

    // Step 3: Auto-merge high confidence
    const autoMergeResult = await autoMergeStep(evalResult.evaluated, context.runId);
    context.autoMerged = autoMergeResult.merged;
    context.errors = autoMergeResult.errors;

    // Step 4: Create approval requests for mid-confidence
    const suspendResult = await suspendStep(evalResult.evaluated, context.runId);
    context.pendingApproval = suspendResult.approvalRequests;

    // Track skipped
    context.skipped = evalResult.evaluated
      .filter((e) => e.decision.confidence < CONFIDENCE_THRESHOLDS.REQUIRE_APPROVAL)
      .map((e) => `${e.candidate.nodeA.nodeId}|${e.candidate.nodeB.nodeId}`);

    // If there are pending approvals, the workflow is suspended
    if (context.pendingApproval.length > 0) {
      await db.execute({
        sql: `UPDATE workflow_runs SET status = 'suspended', context = ? WHERE id = ?`,
        args: [JSON.stringify(context), context.runId],
      });

      // Return partial result - workflow will be resumed later
      return {
        summary: {
          scanned: scanResult.scannedCount,
          duplicatesFound: scanResult.duplicatesFound,
          autoMerged: context.autoMerged.length,
          approved: 0,
          rejected: 0,
          skipped: context.skipped.length,
          errors: context.errors.length,
        },
        completedAt: '', // Not complete yet
      };
    }

    // Step 5: Complete workflow
    return await completeStep(context);
  } catch (error) {
    // Update workflow as failed
    await db.execute({
      sql: `UPDATE workflow_runs SET status = 'failed', error = ? WHERE id = ?`,
      args: [error instanceof Error ? error.message : String(error), context.runId],
    });

    throw error;
  }
}

/**
 * Resume a suspended workflow with human decision
 */
export async function resumeDeduplicationWorkflow(
  runId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
  options?: {
    propertyResolutions?: Record<string, unknown>;
    notes?: string;
  }
): Promise<{ action: 'merged' | 'rejected'; details: string }> {
  const db = getLibSQLClient();

  // Get the approval request
  const approvalResult = await db.execute({
    sql: `SELECT * FROM approval_requests WHERE id = ? AND workflow_run_id = ?`,
    args: [approvalId, runId],
  });

  if (approvalResult.rows.length === 0) {
    throw new Error(`Approval request ${approvalId} not found for workflow ${runId}`);
  }

  const row = approvalResult.rows[0]!;
  const approvalRequest: ApprovalRequest = {
    id: row.id as string,
    workflowRunId: row.workflow_run_id as string,
    stepId: row.step_id as string,
    issueId: row.issue_id as string,
    proposedAction: row.proposed_action as 'merge' | 'delete' | 'enrich',
    candidates: JSON.parse(row.candidates as string),
    reasoning: row.reasoning as string,
    confidence: row.confidence as number,
    status: row.status as 'pending' | 'approved' | 'rejected',
    createdAt: row.created_at as string,
  };

  // Process the decision
  const result = await resumeStep(approvalRequest, {
    decision,
    propertyResolutions: options?.propertyResolutions,
    notes: options?.notes,
  }, runId);

  // Check if all approvals are resolved
  const pendingResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM approval_requests WHERE workflow_run_id = ? AND status = 'pending'`,
    args: [runId],
  });
  const pendingCount = (pendingResult.rows[0]?.count as number) ?? 0;

  if (pendingCount === 0) {
    // All approvals resolved - complete the workflow
    const contextResult = await db.execute({
      sql: `SELECT context FROM workflow_runs WHERE id = ?`,
      args: [runId],
    });

    if (contextResult.rows.length > 0) {
      const context = JSON.parse(contextResult.rows[0]!.context as string) as DeduplicationContext;
      await completeStep(context);
    }
  }

  return result;
}

/**
 * Get pending approvals for a workflow
 */
export async function getPendingApprovals(
  runId: string
): Promise<ApprovalRequest[]> {
  const db = getLibSQLClient();

  const result = await db.execute({
    sql: `SELECT * FROM approval_requests WHERE workflow_run_id = ? AND status = 'pending'`,
    args: [runId],
  });

  return result.rows.map((row) => ({
    id: row.id as string,
    workflowRunId: row.workflow_run_id as string,
    stepId: row.step_id as string,
    issueId: row.issue_id as string,
    proposedAction: row.proposed_action as 'merge' | 'delete' | 'enrich',
    candidates: JSON.parse(row.candidates as string),
    reasoning: row.reasoning as string,
    confidence: row.confidence as number,
    status: row.status as 'pending' | 'approved' | 'rejected',
    createdAt: row.created_at as string,
  }));
}

// Register workflow
registerWorkflow('deep-deduplication', {
  execute: executeDeduplicationWorkflow,
  resume: resumeDeduplicationWorkflow,
  getPendingApprovals,
});

export default {
  executeDeduplicationWorkflow,
  resumeDeduplicationWorkflow,
  getPendingApprovals,
};
