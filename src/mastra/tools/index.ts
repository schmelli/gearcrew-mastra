/**
 * Mastra Tools Central Index
 * Exports all Mastra tools using the createTool() pattern
 *
 * This provides a unified interface for all tools that can be used with Mastra Agents.
 */

// System Tools
export {
  getSystemStatusTool,
  getWorkflowStatusTool,
  listRecentWorkflowsTool,
} from './system';

// Approval Tools
export {
  getPendingApprovalsTool,
  approveItemsTool,
  rejectItemsTool,
  approveByConfidenceTool,
  getAuditSummaryTool,
} from './approvals';

// Analysis Tools (Mastra pattern)
export {
  analyzeGraphHealthTool,
  analyzeOrphansTool,
  detectSupernodesTool,
  triageItemsTool,
  findMissingDataTool,
} from './analysis';

// Workflow Tools
export {
  triggerWorkflowTool,
  listAvailableWorkflowsTool,
} from './workflows';

// Graph Tools
export {
  queryGraphTool,
} from './graph';

// Research Tools
export {
  researchItemTool,
} from './research';

// Re-export existing tools for backward compatibility
export * from './analysis/wcc';
export * from './analysis/orphan-classifier';
export * from './analysis/supernode-detector';
export * from './analysis/bridge-detector';
export * from './analysis/vector-similarity';
export * from './memgraph/workflow-status';
export * from './memgraph/pending-decisions';
export * from './memgraph/trigger-workflow';
export * from './memgraph/audit-query';
export * from './firecrawl/web-search';
export * from './firecrawl/content-extractor';
export * from './firecrawl/cache';

/**
 * All Mastra tools as a single object for easy registration with an Agent
 */
import { getSystemStatusTool } from './system/get-system-status';
import { getWorkflowStatusTool } from './system/get-workflow-status';
import { listRecentWorkflowsTool } from './system/list-recent-workflows';
import { getPendingApprovalsTool } from './approvals/get-pending-approvals';
import { approveItemsTool } from './approvals/approve-items';
import { rejectItemsTool } from './approvals/reject-items';
import { approveByConfidenceTool } from './approvals/approve-by-confidence';
import { getAuditSummaryTool } from './approvals/get-audit-summary';
import { analyzeGraphHealthTool } from './analysis/analyze-graph-health';
import { analyzeOrphansTool } from './analysis/analyze-orphans';
import { detectSupernodesTool } from './analysis/detect-supernodes.tool';
import { triageItemsTool } from './analysis/triage-items';
import { findMissingDataTool } from './analysis/find-missing-data';
import { triggerWorkflowTool } from './workflows/trigger-workflow.tool';
import { listAvailableWorkflowsTool } from './workflows/list-available-workflows';
import { queryGraphTool } from './graph/query-graph';
import { researchItemTool } from './research/research-item';

export const headGardenerToolkit = {
  getSystemStatus: getSystemStatusTool,
  getWorkflowStatus: getWorkflowStatusTool,
  listRecentWorkflows: listRecentWorkflowsTool,
  getPendingApprovals: getPendingApprovalsTool,
  approveItems: approveItemsTool,
  rejectItems: rejectItemsTool,
  approveByConfidence: approveByConfidenceTool,
  getAuditSummary: getAuditSummaryTool,
  analyzeGraphHealth: analyzeGraphHealthTool,
  analyzeOrphans: analyzeOrphansTool,
  detectSupernodes: detectSupernodesTool,
  triageItems: triageItemsTool,
  findMissingData: findMissingDataTool,
  triggerWorkflow: triggerWorkflowTool,
  listAvailableWorkflows: listAvailableWorkflowsTool,
  queryGraph: queryGraphTool,
  researchItem: researchItemTool,
};
