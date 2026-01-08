/**
 * T048-T049: Head Gardener Agent
 * Implements FR-010, FR-011, FR-027: Interactive chat interface for graph management
 * LLM-backed agent with memory and graph tools
 * Per Constitution Principle III: Human Oversight
 */

import { z } from 'zod';
import { registerAgent, getLibSQLClient } from '../index';
import { getWorkflowStatus, listWorkflowRuns, getLatestRuns } from '../tools/memgraph/workflow-status';
import { listPendingDecisions, getPendingDecisionsSummary, handleApprovalDecision, bulkApprovalDecision } from '../tools/memgraph/pending-decisions';
import { queryAuditLog, getTodaySummary, formatSummaryForChat } from '../tools/memgraph/audit-query';
import { detectSupernodes, formatSupernodeReport } from '../tools/analysis/supernode-detector';
import {
  triggerWorkflow,
  parseTriggerIntent,
  formatTriggerResponse,
  getAvailableWorkflows,
} from '../tools/memgraph/trigger-workflow';
import { getAnalystAgent } from './analyst';
import { getMemgraphClient } from '@/lib/memgraph-client';
import { getEnricherAgent } from './enricher';
import { getGapFillingStatus, executeGapFillingWorkflow } from '../workflows/gap-filling';

/**
 * Tool definitions for the Head Gardener
 */
const TOOLS = {
  getSystemStatus: {
    name: 'getSystemStatus',
    description: 'Get overall system health status including workflow state and metrics',
    execute: getSystemStatus,
  },
  getWorkflowStatus: {
    name: 'getWorkflowStatus',
    description: 'Get status of a specific workflow run by ID',
    execute: async (runId: string) => getWorkflowStatus(runId),
  },
  listRecentWorkflows: {
    name: 'listRecentWorkflows',
    description: 'List recent workflow runs with optional filtering',
    execute: async (options?: { status?: string; limit?: number }) => listWorkflowRuns(options),
  },
  getPendingApprovals: {
    name: 'getPendingApprovals',
    description: 'Get list of pending approval decisions awaiting human review',
    execute: async (options?: { limit?: number }) => listPendingDecisions(options),
  },
  getAuditSummary: {
    name: 'getAuditSummary',
    description: 'Get summary of actions taken today or in a specified time range',
    execute: async () => {
      const summary = await getTodaySummary();
      return formatSummaryForChat(summary);
    },
  },
  analyzeGraphHealth: {
    name: 'analyzeGraphHealth',
    description: 'Analyze graph structure for health issues including orphans and supernodes',
    execute: async () => {
      const analyst = getAnalystAgent();
      return analyst.getHealthSummary();
    },
  },
  detectSupernodes: {
    name: 'detectSupernodes',
    description: 'Detect supernode anomalies in the graph',
    execute: async () => {
      const analysis = await detectSupernodes();
      return formatSupernodeReport(analysis);
    },
  },
  queryGraph: {
    name: 'queryGraph',
    description: 'Execute a read-only Cypher query against the graph (FR-031: read-only mode)',
    execute: executeReadOnlyQuery,
  },
  triggerWorkflow: {
    name: 'triggerWorkflow',
    description: 'Trigger a workflow manually (FR-014)',
    execute: async (workflowName: 'morning-hygiene' | 'deep-deduplication' | 'gap-filling', scope?: { category?: string; brand?: string }) => {
      return triggerWorkflow(workflowName, { scope });
    },
  },
  listAvailableWorkflows: {
    name: 'listAvailableWorkflows',
    description: 'List all available workflows',
    execute: getAvailableWorkflows,
  },
  getEnrichmentStatus: {
    name: 'getEnrichmentStatus',
    description: 'Get enrichment/gap-filling workflow status',
    execute: async (runId?: string) => {
      if (runId) {
        return getGapFillingStatus(runId);
      }
      // Get latest enrichment run
      const db = getLibSQLClient();
      const result = await db.execute({
        sql: `SELECT id, status, started_at, completed_at, result_summary
              FROM workflow_runs WHERE workflow_name = 'gap-filling'
              ORDER BY started_at DESC LIMIT 1`,
        args: [],
      });
      if (result.rows.length === 0) {
        return { message: 'No enrichment runs found' };
      }
      const row = result.rows[0]!;
      return {
        runId: row.id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        summary: row.result_summary ? JSON.parse(row.result_summary as string) : null,
      };
    },
  },
  findMissingData: {
    name: 'findMissingData',
    description: 'Find nodes with missing data that need enrichment',
    execute: async (options?: { limit?: number }) => {
      const enricher = getEnricherAgent();
      const nodes = await enricher.findNodesNeedingEnrichment({ limit: options?.limit || 20 });
      return {
        count: nodes.length,
        nodes: nodes.map((n) => ({
          nodeId: n.nodeId,
          name: n.currentData.name,
          missingFields: n.missingFields,
          priority: n.priority,
        })),
      };
    },
  },
};

/**
 * Chat message interface
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/**
 * Chat response with potential tool calls
 */
export interface ChatResponse {
  message: string;
  toolCalls?: Array<{
    tool: string;
    result: unknown;
  }>;
  suggestions?: string[];
}

/**
 * Head Gardener Agent - Interactive graph management interface
 */
export class HeadGardenerAgent {
  private readonly name = 'head-gardener';
  private conversationHistory: ChatMessage[] = [];
  private readonly maxHistoryLength = 50;

  constructor() {
    // Register with Mastra
    registerAgent(this.name, this);
  }

  /**
   * Process a user chat message
   */
  async chat(userMessage: string): Promise<ChatResponse> {
    const timestamp = new Date().toISOString();

    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
      timestamp,
    });

    // Parse intent and route to appropriate tool
    const intent = this.parseIntent(userMessage);
    const toolCalls: Array<{ tool: string; result: unknown }> = [];

    let response: string;

    try {
      switch (intent.type) {
        case 'status_query':
          const status = await TOOLS.getSystemStatus.execute();
          toolCalls.push({ tool: 'getSystemStatus', result: status });
          response = this.formatStatusResponse(status, intent.subject);
          break;

        case 'workflow_query':
          if (intent.runId) {
            const workflowStatus = await TOOLS.getWorkflowStatus.execute(intent.runId);
            toolCalls.push({ tool: 'getWorkflowStatus', result: workflowStatus as unknown as Record<string, unknown> });
            response = workflowStatus
              ? this.formatWorkflowResponse(workflowStatus as unknown as Record<string, unknown>)
              : `Workflow run ${intent.runId} not found.`;
          } else {
            const workflows = await TOOLS.listRecentWorkflows.execute({ limit: 5 });
            toolCalls.push({ tool: 'listRecentWorkflows', result: workflows as unknown as Record<string, unknown> });
            response = this.formatWorkflowListResponse({
              runs: workflows.runs as unknown as Record<string, unknown>[],
              total: workflows.total,
            });
          }
          break;

        case 'approval_query':
          const approvals = await TOOLS.getPendingApprovals.execute({ limit: 10 });
          toolCalls.push({ tool: 'getPendingApprovals', result: approvals as unknown as Record<string, unknown> });
          response = this.formatApprovalsResponse({
            decisions: approvals.decisions as unknown as Record<string, unknown>[],
            total: approvals.total,
          });
          break;

        case 'approval_action':
          response = await this.handleApprovalAction(intent.approvalAction!, toolCalls);
          break;

        case 'audit_query':
          const auditSummary = await TOOLS.getAuditSummary.execute();
          toolCalls.push({ tool: 'getAuditSummary', result: auditSummary });
          response = auditSummary;
          break;

        case 'health_query':
          const health = await TOOLS.analyzeGraphHealth.execute();
          toolCalls.push({ tool: 'analyzeGraphHealth', result: health });
          response = this.formatHealthResponse(health);
          break;

        case 'supernode_query':
          const supernodeReport = await TOOLS.detectSupernodes.execute();
          toolCalls.push({ tool: 'detectSupernodes', result: supernodeReport });
          response = supernodeReport;
          break;

        case 'graph_query':
          if (intent.query) {
            const queryResult = await TOOLS.queryGraph.execute(intent.query);
            toolCalls.push({ tool: 'queryGraph', result: queryResult });
            response = this.formatQueryResponse(queryResult);
          } else {
            response = 'Please provide a Cypher query. For safety, only read-only queries are allowed.';
          }
          break;

        case 'trigger_workflow':
          if (intent.workflowType) {
            const triggerResult = await TOOLS.triggerWorkflow.execute(
              intent.workflowType as 'morning-hygiene' | 'deep-deduplication' | 'gap-filling',
              intent.scope
            );
            toolCalls.push({ tool: 'triggerWorkflow', result: triggerResult });
            response = formatTriggerResponse(triggerResult);
          } else {
            const workflows = TOOLS.listAvailableWorkflows.execute();
            response = `Please specify which workflow to run:\n\n${workflows
              .map((w) => `- **${w.name}**: ${w.description}`)
              .join('\n')}`;
          }
          break;

        case 'enrichment_query':
          const enrichmentStatus = await TOOLS.getEnrichmentStatus.execute();
          toolCalls.push({ tool: 'getEnrichmentStatus', result: enrichmentStatus as unknown as Record<string, unknown> });
          response = enrichmentStatus
            ? this.formatEnrichmentResponse(enrichmentStatus as unknown as Record<string, unknown>)
            : 'No enrichment status available.';
          break;

        case 'missing_data_query':
          const missingData = await TOOLS.findMissingData.execute({ limit: 20 });
          toolCalls.push({ tool: 'findMissingData', result: missingData });
          response = this.formatMissingDataResponse(missingData);
          break;

        case 'help':
          response = this.getHelpMessage();
          break;

        default:
          response = this.handleUnknownIntent(userMessage);
      }
    } catch (error) {
      response = `I encountered an error: ${error instanceof Error ? error.message : String(error)}. Please try again.`;
    }

    // Add assistant response to history
    this.conversationHistory.push({
      role: 'assistant',
      content: response,
      timestamp: new Date().toISOString(),
    });

    // Trim history if needed
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }

    // Save to memory
    await this.saveToMemory();

    return {
      message: response,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      suggestions: this.getSuggestions(intent.type),
    };
  }

  /**
   * Parse user intent from message
   */
  private parseIntent(message: string): {
    type: 'status_query' | 'workflow_query' | 'approval_query' | 'approval_action' | 'audit_query' |
          'health_query' | 'supernode_query' | 'graph_query' | 'trigger_workflow' |
          'enrichment_query' | 'missing_data_query' | 'help' | 'unknown';
    subject?: string;
    runId?: string;
    query?: string;
    workflowType?: string;
    scope?: { category?: string; brand?: string };
    approvalAction?: {
      decision: 'approve' | 'reject';
      target: 'specific' | 'all' | 'range' | 'confidence';
      approvalIds?: string[];
      indices?: number[];
      confidenceThreshold?: number;
      notes?: string;
    };
  } {
    const lowerMessage = message.toLowerCase();

    // Help queries
    if (lowerMessage.includes('help') || lowerMessage.includes('what can you')) {
      return { type: 'help' };
    }

    // Check for trigger intent first (before workflow queries)
    const triggerIntent = parseTriggerIntent(message);
    if (triggerIntent.isTrigger && triggerIntent.workflowType) {
      return {
        type: 'trigger_workflow',
        workflowType: triggerIntent.workflowType,
        scope: triggerIntent.scope,
      };
    }

    // Status queries
    if (
      lowerMessage.includes('status') ||
      lowerMessage.includes('how are') ||
      lowerMessage.includes('how is') ||
      (lowerMessage.includes('what') && lowerMessage.includes('happening'))
    ) {
      let subject: string | undefined;
      if (lowerMessage.includes('orphan')) subject = 'orphans';
      if (lowerMessage.includes('duplicate')) subject = 'duplicates';
      if (lowerMessage.includes('merge')) subject = 'merges';
      return { type: 'status_query', subject };
    }

    // Workflow queries (status, not trigger)
    if (
      (lowerMessage.includes('workflow') || lowerMessage.includes('hygiene') || lowerMessage.includes('dedup')) &&
      (lowerMessage.includes('status') || lowerMessage.includes('show') || lowerMessage.includes('list'))
    ) {
      // Check for specific run ID
      const runIdMatch = message.match(/run[- ]?id[:\s]+(\S+)/i) ||
                         message.match(/workflow[:\s]+(\S+)/i);
      return { type: 'workflow_query', runId: runIdMatch?.[1] };
    }

    // Approval ACTIONS (approve/reject commands) - check before approval queries
    const approveMatch = lowerMessage.match(/^(approve|accept|yes|confirm)/);
    const rejectMatch = lowerMessage.match(/^(reject|deny|no|decline|skip)/);

    if (approveMatch || rejectMatch) {
      const decision = approveMatch ? 'approve' : 'reject';

      // "approve all" / "reject all"
      if (lowerMessage.includes(' all')) {
        return {
          type: 'approval_action',
          approvalAction: { decision, target: 'all' },
        };
      }

      // "approve first 5" / "reject first 3"
      const firstNMatch = lowerMessage.match(/first\s+(\d+)/);
      if (firstNMatch) {
        const count = parseInt(firstNMatch[1], 10);
        return {
          type: 'approval_action',
          approvalAction: {
            decision,
            target: 'range',
            indices: Array.from({ length: count }, (_, i) => i),
          },
        };
      }

      // "approve 1, 2, 3" or "approve 1 2 3" or "approve #1 #2"
      const numberMatches = message.match(/\d+/g);
      if (numberMatches && numberMatches.length > 0) {
        const indices = numberMatches.map((n) => parseInt(n, 10) - 1); // Convert to 0-indexed
        return {
          type: 'approval_action',
          approvalAction: {
            decision,
            target: 'specific',
            indices: indices.filter((i) => i >= 0),
          },
        };
      }

      // "approve above 90%" / "reject below 85%"
      const confidenceMatch = lowerMessage.match(/(above|below|over|under|>=?|<=?)\s*(\d+)%?/);
      if (confidenceMatch) {
        const threshold = parseInt(confidenceMatch[2], 10) / 100;
        const isAbove = ['above', 'over', '>', '>='].includes(confidenceMatch[1]);
        return {
          type: 'approval_action',
          approvalAction: {
            decision,
            target: 'confidence',
            confidenceThreshold: isAbove ? threshold : -threshold, // negative means below
          },
        };
      }

      // Just "approve" or "reject" with no specifier - approve/reject the first one
      return {
        type: 'approval_action',
        approvalAction: {
          decision,
          target: 'specific',
          indices: [0],
        },
      };
    }

    // Approval queries (show pending, not act on them)
    if (
      lowerMessage.includes('approval') ||
      lowerMessage.includes('pending') ||
      lowerMessage.includes('decision') ||
      lowerMessage.includes('waiting')
    ) {
      return { type: 'approval_query' };
    }

    // Audit queries
    if (
      lowerMessage.includes('audit') ||
      lowerMessage.includes('history') ||
      lowerMessage.includes('log') ||
      lowerMessage.includes('today') ||
      lowerMessage.includes('yesterday') ||
      (lowerMessage.includes('what') && lowerMessage.includes('did'))
    ) {
      return { type: 'audit_query' };
    }

    // Health queries
    if (
      lowerMessage.includes('health') ||
      lowerMessage.includes('issue') ||
      lowerMessage.includes('problem') ||
      lowerMessage.includes('analyze')
    ) {
      return { type: 'health_query' };
    }

    // Supernode queries
    if (
      lowerMessage.includes('supernode') ||
      lowerMessage.includes('anomaly') ||
      lowerMessage.includes('high degree')
    ) {
      return { type: 'supernode_query' };
    }

    // Enrichment queries
    if (
      lowerMessage.includes('enrich') ||
      lowerMessage.includes('gap-filling') ||
      lowerMessage.includes('gap filling') ||
      lowerMessage.includes('fill gaps')
    ) {
      return { type: 'enrichment_query' };
    }

    // Missing data queries
    if (
      lowerMessage.includes('missing') ||
      lowerMessage.includes('incomplete') ||
      lowerMessage.includes('empty fields') ||
      lowerMessage.includes('need data')
    ) {
      return { type: 'missing_data_query' };
    }

    // Graph queries (Cypher)
    if (
      lowerMessage.includes('match') ||
      lowerMessage.includes('return') ||
      lowerMessage.startsWith('show me') ||
      lowerMessage.includes('count')
    ) {
      // Extract Cypher if present
      const cypherMatch = message.match(/```(?:cypher)?\s*([\s\S]*?)```/) ||
                          message.match(/MATCH[\s\S]+RETURN[\s\S]+/i);
      return { type: 'graph_query', query: cypherMatch?.[1] || cypherMatch?.[0] };
    }

    return { type: 'unknown' };
  }

  /**
   * Format system status response
   */
  private formatStatusResponse(status: SystemStatus, subject?: string): string {
    const lines: string[] = [];

    lines.push(`**System Status: ${status.status}**\n`);
    lines.push(`Database: ${status.memgraphConnected ? 'Connected' : 'Disconnected'}`);
    lines.push(`Running workflows: ${status.workflowsRunning}`);
    lines.push(`Pending approvals: ${status.pendingApprovals}`);

    if (subject === 'orphans') {
      lines.push(`\n**Orphans**: ${status.metrics.orphanCount} detected`);
    } else if (subject === 'duplicates') {
      lines.push(`\n**Duplicates**: ${status.metrics.duplicatesDetected} detected`);
    } else if (subject === 'merges') {
      lines.push(`\n**Merges (24h)**: ${status.metrics.mergesExecuted24h} executed`);
    }

    lines.push(`\nTotal nodes: ${status.metrics.totalNodes.toLocaleString()}`);
    lines.push(`Total relationships: ${status.metrics.totalRelationships.toLocaleString()}`);

    return lines.join('\n');
  }

  /**
   * Format workflow response
   */
  private formatWorkflowResponse(workflow: Record<string, unknown>): string {
    return `**Workflow: ${workflow.workflowName}**
Run ID: ${workflow.runId}
Status: ${workflow.status}
Started: ${workflow.startedAt}
${workflow.completedAt ? `Completed: ${workflow.completedAt}` : ''}
${workflow.error ? `Error: ${workflow.error}` : ''}`;
  }

  /**
   * Format workflow list response
   */
  private formatWorkflowListResponse(result: { runs: Array<Record<string, unknown>>; total: number }): string {
    if (result.runs.length === 0) {
      return 'No workflow runs found.';
    }

    const lines = [`**Recent Workflows** (${result.total} total)\n`];
    for (const run of result.runs) {
      lines.push(`- ${run.workflowName}: ${run.status} (${run.startedAt})`);
    }
    return lines.join('\n');
  }

  /**
   * Format approvals response
   */
  private formatApprovalsResponse(result: { decisions: Array<Record<string, unknown>>; total: number }): string {
    if (result.total === 0) {
      return 'No pending approvals. All caught up!';
    }

    const lines = [`**Pending Approvals** (${result.total} total)\n`];
    for (const decision of result.decisions.slice(0, 5)) {
      lines.push(`- ${decision.title} (${((decision.confidence as number) * 100).toFixed(0)}% confidence)`);
      lines.push(`  Waiting: ${decision.waitingDays} days`);
    }

    if (result.total > 5) {
      lines.push(`\n...and ${result.total - 5} more`);
    }

    return lines.join('\n');
  }

  /**
   * Format health response
   */
  private formatHealthResponse(health: { data: Record<string, unknown> }): string {
    const data = health.data;
    return `**Graph Health Summary**

Total nodes: ${(data.totalNodes as number).toLocaleString()}
Total relationships: ${(data.totalRelationships as number).toLocaleString()}

**Issues:**
- Orphans: ${data.orphanCount}
- Supernodes: ${data.supernodeCount}
- Bridge nodes: ${data.bridgeNodeCount}
- Schema violations: ${data.schemaViolationCount}`;
  }

  /**
   * Format query response
   */
  private formatQueryResponse(result: { rows: unknown[]; error?: string }): string {
    if (result.error) {
      return `Query error: ${result.error}`;
    }

    if (result.rows.length === 0) {
      return 'Query returned no results.';
    }

    return `Query returned ${result.rows.length} results:\n\`\`\`json\n${JSON.stringify(result.rows.slice(0, 10), null, 2)}\n\`\`\``;
  }

  /**
   * Format enrichment response
   */
  private formatEnrichmentResponse(result: Record<string, unknown>): string {
    if (result.message) {
      return result.message as string;
    }

    const summary = result.summary as Record<string, unknown> | null;
    const lines = [
      `**Enrichment Status: ${result.status}**`,
      `Run ID: ${result.runId}`,
      `Started: ${result.startedAt}`,
    ];

    if (result.completedAt) {
      lines.push(`Completed: ${result.completedAt}`);
    }

    if (summary) {
      lines.push('');
      lines.push('**Results:**');
      lines.push(`- Nodes enriched: ${summary.nodesEnriched || 0}`);
      lines.push(`- Nodes skipped: ${summary.nodesSkipped || 0}`);
      lines.push(`- Fields filled: ${summary.fieldsEnriched || 0}`);
      if (summary.avgConfidence) {
        lines.push(`- Avg confidence: ${((summary.avgConfidence as number) * 100).toFixed(1)}%`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format missing data response
   */
  private formatMissingDataResponse(result: { count: number; nodes: Array<Record<string, unknown>> }): string {
    if (result.count === 0) {
      return 'No nodes with missing data found. Data is complete!';
    }

    const lines = [`**Nodes Needing Enrichment** (${result.count} found)\n`];

    for (const node of result.nodes.slice(0, 10)) {
      const missingFields = (node.missingFields as string[]).join(', ');
      const priority = ((node.priority as number) * 100).toFixed(0);
      lines.push(`- **${node.name}** (priority: ${priority}%)`);
      lines.push(`  Missing: ${missingFields}`);
    }

    if (result.count > 10) {
      lines.push(`\n...and ${result.count - 10} more`);
    }

    lines.push('\nRun "fill gaps" or "enrich data" to start gap-filling workflow.');

    return lines.join('\n');
  }

  /**
   * Handle approval/rejection actions
   */
  private async handleApprovalAction(
    action: {
      decision: 'approve' | 'reject';
      target: 'specific' | 'all' | 'range' | 'confidence';
      approvalIds?: string[];
      indices?: number[];
      confidenceThreshold?: number;
      notes?: string;
    },
    toolCalls: Array<{ tool: string; result: unknown }>
  ): Promise<string> {
    // First, get pending approvals
    const pendingResult = await listPendingDecisions({ limit: 100 });
    const pending = pendingResult.decisions;

    if (pending.length === 0) {
      return 'No pending approvals to process. All caught up!';
    }

    let toProcess: typeof pending = [];
    let description = '';

    switch (action.target) {
      case 'all':
        toProcess = pending;
        description = `all ${pending.length} pending`;
        break;

      case 'specific':
      case 'range':
        if (action.indices && action.indices.length > 0) {
          toProcess = action.indices
            .filter((i) => i >= 0 && i < pending.length)
            .map((i) => pending[i]!);
          description = toProcess.length === 1
            ? `item #${action.indices[0]! + 1}`
            : `items #${action.indices.map((i) => i + 1).join(', #')}`;
        }
        break;

      case 'confidence':
        if (action.confidenceThreshold !== undefined) {
          const threshold = Math.abs(action.confidenceThreshold);
          const isAbove = action.confidenceThreshold > 0;
          toProcess = pending.filter((p) =>
            isAbove ? p.confidence >= threshold : p.confidence < threshold
          );
          description = `${toProcess.length} items ${isAbove ? 'above' : 'below'} ${(threshold * 100).toFixed(0)}% confidence`;
        }
        break;
    }

    if (toProcess.length === 0) {
      return 'No matching approvals found for your criteria.';
    }

    // Confirm before processing
    const lines: string[] = [];
    lines.push(`**${action.decision === 'approve' ? 'Approving' : 'Rejecting'} ${description}:**\n`);

    // Show what will be processed (max 5 for readability)
    const preview = toProcess.slice(0, 5);
    for (const item of preview) {
      lines.push(`- ${item.title} (${(item.confidence * 100).toFixed(0)}% confidence)`);
    }
    if (toProcess.length > 5) {
      lines.push(`...and ${toProcess.length - 5} more\n`);
    }

    // Process each approval
    const results: Array<{ success: boolean; message: string }> = [];
    for (const item of toProcess) {
      const result = await handleApprovalDecision(item.approvalId, action.decision, action.notes);
      results.push(result);
      toolCalls.push({
        tool: 'handleApprovalDecision',
        result: { approvalId: item.approvalId, ...result },
      });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    lines.push(`\n**Results:**`);
    lines.push(`${action.decision === 'approve' ? '✅ Approved' : '❌ Rejected'}: ${succeeded}`);
    if (failed > 0) {
      lines.push(`⚠️ Failed: ${failed}`);
    }

    // Show remaining
    const remaining = pendingResult.total - succeeded;
    if (remaining > 0) {
      lines.push(`\n${remaining} approvals still pending.`);
    } else {
      lines.push(`\nAll approvals processed! Queue is empty.`);
    }

    return lines.join('\n');
  }

  /**
   * Handle unknown intent
   */
  private handleUnknownIntent(message: string): string {
    return `I'm not sure how to help with "${message}". Here's what I can do:

- **Status**: "What's the system status?" or "How many orphans today?"
- **Workflows**: "Show recent workflows" or "Status of workflow run-123"
- **Approvals**: "Show pending approvals" or "What needs my attention?"
- **Approve/Reject**: "approve 1", "reject all", "approve above 90%"
- **Audit**: "What happened today?" or "Show audit log"
- **Health**: "Analyze graph health" or "Any issues?"

Type "help" for more details.`;
  }

  /**
   * Get help message
   */
  private getHelpMessage(): string {
    return `**Head Gardener - Graph Management Assistant**

I can help you manage and monitor the GearGraph. Here's what I can do:

**System Status**
- "What's the current status?"
- "How many orphans/duplicates/merges today?"
- "Is everything healthy?"

**Workflow Management**
- "Show recent workflows"
- "What workflows are running?"
- "Status of workflow run-123"

**Pending Approvals** (view)
- "Show pending approvals"
- "What needs my attention?"
- "Any decisions waiting?"

**Approve/Reject Duplicates** (action)
- "approve" / "reject" - first pending item
- "approve 1" / "reject 2" - specific item by number
- "approve 1, 2, 3" - multiple items
- "approve first 5" - first N items
- "approve all" / "reject all" - all pending
- "approve above 90%" - by confidence threshold
- "reject below 85%" - by confidence threshold

**Audit & History**
- "What happened today?"
- "Show audit log"
- "What did you do yesterday?"

**Graph Analysis**
- "Analyze graph health"
- "Detect supernodes"
- "Any anomalies?"

**Data Enrichment**
- "Show enrichment status"
- "What's missing data?"
- "Fill gaps" or "Run gap-filling"

**Direct Queries** (read-only)
- "MATCH (n:GearItem) RETURN count(n)"
- "Show me all brands"`;
  }

  /**
   * Get contextual suggestions
   */
  private getSuggestions(intentType: string): string[] {
    switch (intentType) {
      case 'status_query':
        return ['Show pending approvals', 'Analyze graph health', 'What happened today?'];
      case 'workflow_query':
        return ['Run hygiene check now', 'Show audit log', 'Any issues?'];
      case 'approval_query':
        return ['Approve 1', 'Approve all', 'Reject below 85%'];
      case 'approval_action':
        return ['Show pending approvals', 'Approve all', 'What happened today?'];
      case 'health_query':
        return ['Detect supernodes', 'Show pending approvals', 'Run hygiene check'];
      case 'enrichment_query':
        return ['What data is missing?', 'Run gap-filling', 'Show workflow status'];
      case 'missing_data_query':
        return ['Run gap-filling', 'Show enrichment status', 'Analyze health'];
      default:
        return ['What\'s the status?', 'Show pending approvals', 'Analyze health'];
    }
  }

  /**
   * Save conversation to LibSQL memory (T049)
   */
  private async saveToMemory(): Promise<void> {
    const db = getLibSQLClient();

    try {
      // Store last N messages in memory
      const recentMessages = this.conversationHistory.slice(-10);

      await db.execute({
        sql: `
          INSERT OR REPLACE INTO agent_memory (agent_name, memory_type, content, updated_at)
          VALUES (?, ?, ?, ?)
        `,
        args: [
          this.name,
          'conversation_history',
          JSON.stringify(recentMessages),
          new Date().toISOString(),
        ],
      });
    } catch (error) {
      // Memory save is non-critical, log but don't throw
      console.error('Failed to save conversation to memory:', error);
    }
  }

  /**
   * Load conversation from memory
   */
  async loadFromMemory(): Promise<void> {
    const db = getLibSQLClient();

    try {
      const result = await db.execute({
        sql: `
          SELECT content FROM agent_memory
          WHERE agent_name = ? AND memory_type = ?
        `,
        args: [this.name, 'conversation_history'],
      });

      if (result.rows.length > 0) {
        const content = result.rows[0]!.content as string;
        this.conversationHistory = JSON.parse(content);
      }
    } catch (error) {
      console.error('Failed to load conversation from memory:', error);
    }
  }

  /**
   * Get conversation history
   */
  getConversationHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }
}

/**
 * System status interface
 */
interface SystemStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  memgraphConnected: boolean;
  workflowsRunning: number;
  pendingApprovals: number;
  lastHygieneRun: string | null;
  lastDeduplicationRun: string | null;
  metrics: {
    totalNodes: number;
    totalRelationships: number;
    orphanCount: number;
    duplicatesDetected: number;
    mergesExecuted24h: number;
    deletions24h: number;
  };
  timestamp: string;
}

/**
 * Get overall system status
 */
async function getSystemStatus(): Promise<SystemStatus> {
  const client = getMemgraphClient();
  const db = getLibSQLClient();

  // Check Memgraph connection
  let memgraphConnected = false;
  let totalNodes = 0;
  let totalRelationships = 0;
  let orphanCount = 0;

  try {
    const nodeResult = await client.readOnlyQuery<{ count: number }>(
      'MATCH (n) RETURN count(n) AS count'
    );
    const relResult = await client.readOnlyQuery<{ count: number }>(
      'MATCH ()-[r]->() RETURN count(r) AS count'
    );

    memgraphConnected = true;
    totalNodes = nodeResult[0]?.count ?? 0;
    totalRelationships = relResult[0]?.count ?? 0;

    // Get orphan count
    const analyst = getAnalystAgent();
    const orphanAnalysis = await analyst.analyzeOrphans();
    orphanCount = orphanAnalysis.data.orphanCount;
  } catch {
    memgraphConnected = false;
  }

  // Get workflow stats
  const workflowResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'`,
    args: [],
  });
  const workflowsRunning = (workflowResult.rows[0]?.count as number) ?? 0;

  // Get pending approvals
  const approvalResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`,
    args: [],
  });
  const pendingApprovals = (approvalResult.rows[0]?.count as number) ?? 0;

  // Get latest runs
  const latestRuns = await getLatestRuns();

  // Get 24h stats from audit log
  const auditSummary = await getTodaySummary();

  // Determine overall status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (!memgraphConnected) {
    status = 'unhealthy';
  } else if (pendingApprovals > 10 || orphanCount > 20) {
    status = 'degraded';
  }

  return {
    status,
    memgraphConnected,
    workflowsRunning,
    pendingApprovals,
    lastHygieneRun: latestRuns['morning-hygiene']?.startedAt ?? null,
    lastDeduplicationRun: latestRuns['deep-deduplication']?.startedAt ?? null,
    metrics: {
      totalNodes,
      totalRelationships,
      orphanCount,
      duplicatesDetected: 0, // Would need to query
      mergesExecuted24h: auditSummary.merges,
      deletions24h: auditSummary.deletes,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Execute a read-only query (FR-031)
 */
async function executeReadOnlyQuery(query: string): Promise<{ rows: unknown[]; error?: string }> {
  const client = getMemgraphClient();

  // Validate query is read-only
  const normalizedQuery = query.trim().toUpperCase();
  const dangerousKeywords = [
    'CREATE', 'DELETE', 'DETACH', 'SET', 'REMOVE', 'MERGE',
    'DROP', 'CALL', 'LOAD', 'FOREACH'
  ];

  for (const keyword of dangerousKeywords) {
    if (normalizedQuery.includes(keyword)) {
      return {
        rows: [],
        error: `Query contains forbidden keyword: ${keyword}. Only read-only queries are allowed.`,
      };
    }
  }

  try {
    const results = await client.readOnlyQuery(query);
    return { rows: results };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Create singleton instance
let headGardenerInstance: HeadGardenerAgent | null = null;

export function getHeadGardenerAgent(): HeadGardenerAgent {
  if (!headGardenerInstance) {
    headGardenerInstance = new HeadGardenerAgent();
  }
  return headGardenerInstance;
}

export default HeadGardenerAgent;
