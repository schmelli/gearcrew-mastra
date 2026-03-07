/**
 * T048-T049: Head Gardener Agent (Phase 6 - True LLM Reasoning)
 * Implements FR-010, FR-011, FR-027: Interactive chat interface for graph management
 *
 * REBUILT: Now uses Vercel AI SDK with @ai-sdk/deepseek for proper tool calling
 * Per Constitution Principle III: Human Oversight
 */

import { z } from 'zod';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, tool, CoreMessage } from 'ai';

// Initialize DeepSeek client using @ai-sdk/deepseek
const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});

import { registerAgent } from '../index';
import { getLibSQLClient } from '@/lib/db';
import { getWorkflowStatus, listWorkflowRuns, getLatestRuns } from '../tools/memgraph/workflow-status';
import {
  listPendingDecisions,
  handleApprovalDecision,
} from '../tools/memgraph/pending-decisions';
import { getTodaySummary, formatSummaryForChat } from '../tools/memgraph/audit-query';
import { detectSupernodes, formatSupernodeReport } from '../tools/analysis/supernode-detector';
import {
  triggerWorkflow,
  formatTriggerResponse,
  getAvailableWorkflows,
} from '../tools/memgraph/trigger-workflow';
import { getAnalystAgent } from './analyst';
import { getResearcherAgent } from './researcher';
import { getCuratorAgent } from './curator';
import { getMemgraphClient } from '@/lib/memgraph-client';

// ============================================================================
// System Prompt for LLM Reasoning
// ============================================================================

const SYSTEM_PROMPT = `You are the Head Gardener, a conversational AI assistant that manages a graph database of outdoor gear products. You coordinate a team of specialized agents:

- **Analyst**: For graph analysis, orphan detection, supernode identification, schema validation, and triage
- **Researcher**: For web research to find missing product data (technologies, usage scenarios, feedback patterns)
- **Curator**: For executing all graph modifications (enrichment, merges, deletions)
- **Resolver**: For handling duplicate detection and merging decisions

You have access to various tools to help manage the graph. When users ask questions, use your tools to gather information and provide helpful responses.

IMPORTANT GUIDELINES:
1. Always be helpful and explain what you're doing
2. For approval actions, clearly state what will be approved/rejected
3. For destructive operations, confirm with the user first
4. Provide concrete suggestions for next steps
5. Keep responses concise but informative
6. Use markdown formatting for readability

When users ask about system status, health, or workflows, use the appropriate tools to get real data.
When users want to approve or reject items, use the approval tools.
When users want to trigger workflows, use the workflow tools.`;

// ============================================================================
// Tool Definitions for LLM
// Uses Vercel AI SDK tool() helper with automatic Zod→JSON Schema conversion
// ============================================================================

const headGardenerTools = {
  getSystemStatus: tool({
    description: 'Get overall system health status including workflow state, pending approvals, and graph metrics',
    parameters: z.object({}),
    execute: async () => {
      return await getSystemStatus();
    },
  }),

  getWorkflowStatus: tool({
    description: 'Get status of a specific workflow run by its ID',
    parameters: z.object({
      runId: z.string().describe('The workflow run ID to check'),
    }),
    execute: async ({ runId }) => {
      return await getWorkflowStatus(runId);
    },
  }),

  listRecentWorkflows: tool({
    description: 'List recent workflow runs with optional status filtering',
    parameters: z.object({
      status: z.enum(['running', 'completed', 'failed', 'suspended']).optional()
        .describe('Filter by workflow status'),
      limit: z.number().default(5).describe('Maximum number of results'),
    }),
    execute: async ({ status, limit }) => {
      return await listWorkflowRuns({ status, limit });
    },
  }),

  getPendingApprovals: tool({
    description: 'Get list of pending approval decisions awaiting human review (duplicates, merges)',
    parameters: z.object({
      limit: z.number().default(10).describe('Maximum number of results'),
    }),
    execute: async ({ limit }) => {
      return await listPendingDecisions({ limit });
    },
  }),

  approveItems: tool({
    description: 'Approve pending items. Use this when user says "approve", "accept", "yes", or similar',
    parameters: z.object({
      indices: z.array(z.number()).describe('0-indexed positions of items to approve (from getPendingApprovals)'),
      notes: z.string().optional().describe('Optional notes for the approval'),
    }),
    execute: async ({ indices, notes }) => {
      const pending = await listPendingDecisions({ limit: 100 });
      const results = [];
      for (const idx of indices) {
        if (idx >= 0 && idx < pending.decisions.length) {
          const item = pending.decisions[idx]!;
          const result = await handleApprovalDecision(item.approvalId, 'approve', notes);
          results.push({ item: item.title, ...result });
        }
      }
      return { approved: results.length, results };
    },
  }),

  rejectItems: tool({
    description: 'Reject pending items. Use this when user says "reject", "deny", "skip", or similar',
    parameters: z.object({
      indices: z.array(z.number()).describe('0-indexed positions of items to reject (from getPendingApprovals)'),
      notes: z.string().optional().describe('Optional notes for the rejection'),
    }),
    execute: async ({ indices, notes }) => {
      const pending = await listPendingDecisions({ limit: 100 });
      const results = [];
      for (const idx of indices) {
        if (idx >= 0 && idx < pending.decisions.length) {
          const item = pending.decisions[idx]!;
          const result = await handleApprovalDecision(item.approvalId, 'reject', notes);
          results.push({ item: item.title, ...result });
        }
      }
      return { rejected: results.length, results };
    },
  }),

  approveByConfidence: tool({
    description: 'Approve all pending items above a confidence threshold',
    parameters: z.object({
      threshold: z.number().min(0).max(1).describe('Minimum confidence (0-1) to approve'),
      notes: z.string().optional(),
    }),
    execute: async ({ threshold, notes }) => {
      const pending = await listPendingDecisions({ limit: 100 });
      const toApprove = pending.decisions.filter(d => d.confidence >= threshold);
      const results = [];
      for (const item of toApprove) {
        const result = await handleApprovalDecision(item.approvalId, 'approve', notes);
        results.push({ item: item.title, confidence: item.confidence, ...result });
      }
      return { approved: results.length, threshold, results };
    },
  }),

  getAuditSummary: tool({
    description: 'Get summary of actions taken today (creates, updates, merges, deletes)',
    parameters: z.object({}),
    execute: async () => {
      const summary = await getTodaySummary();
      return { raw: summary, formatted: formatSummaryForChat(summary) };
    },
  }),

  analyzeGraphHealth: tool({
    description: 'Analyze graph structure for health issues including orphans, supernodes, and schema violations',
    parameters: z.object({}),
    execute: async () => {
      const analyst = getAnalystAgent();
      return await analyst.getHealthSummary();
    },
  }),

  analyzeOrphans: tool({
    description: 'Detect and classify orphan nodes (disconnected from main graph)',
    parameters: z.object({}),
    execute: async () => {
      const analyst = getAnalystAgent();
      return await analyst.analyzeOrphans();
    },
  }),

  detectSupernodes: tool({
    description: 'Detect supernode anomalies (nodes with unusually high connections)',
    parameters: z.object({}),
    execute: async () => {
      const analysis = await detectSupernodes();
      return { raw: analysis, formatted: formatSupernodeReport(analysis) };
    },
  }),

  triageItems: tool({
    description: 'Use the Analyst to triage flagged items and recommend actions (research, delete, review, skip)',
    parameters: z.object({
      limit: z.number().default(20).describe('Maximum items to triage'),
    }),
    execute: async ({ limit }) => {
      const analyst = getAnalystAgent();
      const items = await analyst.findItemsNeedingEnrichment({ limit, maxCompleteness: 0.7 });
      const flagged = items.map(item => ({
        nodeId: item.nodeId,
        name: item.name,
        brand: item.brand,
        category: item.category,
        flagReason: item.flagReason,
      }));
      return await analyst.triageFlaggedItems(flagged);
    },
  }),

  triggerWorkflow: tool({
    description: 'Manually trigger a workflow (morning-hygiene, deep-deduplication, data-quality, embedding-generation)',
    parameters: z.object({
      workflowName: z.enum(['morning-hygiene', 'deep-deduplication', 'data-quality', 'gap-filling', 'embedding-generation'])
        .describe('Which workflow to run'),
      scope: z.object({
        category: z.string().optional(),
        brand: z.string().optional(),
      }).optional().describe('Optional scope filter'),
      options: z.record(z.unknown()).optional().describe('Workflow-specific options'),
    }),
    execute: async ({ workflowName, scope, options }) => {
      const result = await triggerWorkflow(workflowName, { scope, workflowOptions: options });
      return { raw: result, formatted: formatTriggerResponse(result) };
    },
  }),

  listAvailableWorkflows: tool({
    description: 'List all available workflows and their descriptions',
    parameters: z.object({}),
    execute: async () => {
      return getAvailableWorkflows();
    },
  }),

  queryGraph: tool({
    description: 'Execute a read-only Cypher query against the graph database',
    parameters: z.object({
      query: z.string().describe('Cypher query (read-only, no CREATE/DELETE/SET)'),
    }),
    execute: async ({ query }) => {
      return await executeReadOnlyQuery(query);
    },
  }),

  findMissingData: tool({
    description: 'Find nodes with missing data that could benefit from enrichment',
    parameters: z.object({
      limit: z.number().default(20),
    }),
    execute: async ({ limit }) => {
      const analyst = getAnalystAgent();
      const items = await analyst.findItemsNeedingEnrichment({ limit, maxCompleteness: 0.7 });
      return {
        count: items.length,
        items: items.map(item => ({
          nodeId: item.nodeId,
          name: item.name,
          completeness: `${Math.round(item.completeness * 100)}%`,
          flagReason: item.flagReason,
        })),
      };
    },
  }),

  researchItem: tool({
    description: 'Use the Researcher agent to gather comprehensive data about a specific product',
    parameters: z.object({
      nodeId: z.string().describe('The node ID to research'),
      nodeName: z.string().describe('The product name'),
      brand: z.string().optional(),
      category: z.string().optional(),
    }),
    execute: async ({ nodeId, nodeName, brand, category }) => {
      const researcher = getResearcherAgent();
      return await researcher.researchItem({
        nodeId,
        nodeName,
        brand,
        category,
        missingFields: ['brand', 'weight', 'price', 'category'],
        priority: 0.8,
      });
    },
  }),
};

// ============================================================================
// Chat Message Interface
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  toolCalls?: Array<{ tool: string; result: unknown }>;
}

export interface ChatResponse {
  message: string;
  toolCalls?: Array<{ tool: string; result: unknown }>;
  suggestions?: string[];
}

// ============================================================================
// Head Gardener Agent - True LLM Reasoning
// ============================================================================

export class HeadGardenerAgent {
  private readonly name = 'head-gardener';
  private conversationHistory: ChatMessage[] = [];
  private readonly maxHistoryLength = 50;

  constructor() {
    registerAgent(this.name, this);
  }

  /**
   * Process a user chat message using Vercel AI SDK with tools
   */
  async chat(userMessage: string): Promise<ChatResponse> {
    const timestamp = new Date().toISOString();

    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
      timestamp,
    });

    // Build messages for AI SDK (CoreMessage format)
    const messages: CoreMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    // Add recent conversation history for context (truncated to fit context window)
    const recentHistory = this.conversationHistory.slice(-10);
    for (const msg of recentHistory) {
      // Truncate long messages to avoid context overflow
      // User messages: keep full (usually short)
      // Assistant messages: truncate if too long (may contain tool results)
      const maxContentLength = msg.role === 'user' ? 2000 : 4000;
      let content = msg.content;

      if (content.length > maxContentLength) {
        content = content.substring(0, maxContentLength) + '\n\n[... truncated for context ...]';
      }

      messages.push({
        role: msg.role as 'user' | 'assistant',
        content,
      });
    }

    try {
      // Use generateText with tools - AI SDK handles tool calling automatically
      const result = await generateText({
        model: deepseek('deepseek-chat'),
        messages,
        tools: headGardenerTools,
        maxSteps: 5, // Allow up to 5 tool calls in a single request
      });

      // Collect tool calls from all steps for the response
      const toolCalls = result.steps.flatMap(step =>
        step.toolCalls.map(call => ({
          tool: call.toolName,
          result: call.args,
        }))
      );

      const responseContent = result.text || 'I processed your request.';

      // Add assistant response to history
      this.conversationHistory.push({
        role: 'assistant',
        content: responseContent,
        timestamp: new Date().toISOString(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      // Trim history if needed
      if (this.conversationHistory.length > this.maxHistoryLength) {
        this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
      }

      // Save to memory
      await this.saveToMemory();

      return {
        message: responseContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        suggestions: this.getSuggestions(toolCalls),
      };
    } catch (error) {
      // Log detailed error for debugging
      console.error('Head Gardener LLM error:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      const errorMessage = `I encountered an error: ${error instanceof Error ? error.message : String(error)}. Please try again.`;

      this.conversationHistory.push({
        role: 'assistant',
        content: errorMessage,
        timestamp: new Date().toISOString(),
      });

      return {
        message: errorMessage,
        suggestions: ['What is the system status?', 'Show pending approvals', 'Analyze graph health'],
      };
    }
  }

  /**
   * Get contextual suggestions based on the tools that were called
   */
  private getSuggestions(toolCalls: Array<{ tool: string; result: unknown }>): string[] {
    // Provide contextual suggestions based on what tools were used
    const usedTools = new Set(toolCalls.map(tc => tc.tool));

    if (usedTools.has('getSystemStatus')) {
      return ['Show pending approvals', 'Analyze orphan nodes', 'Run morning hygiene workflow'];
    }
    if (usedTools.has('getPendingApprovals')) {
      return ['Approve all with confidence > 0.9', 'Reject item 0', 'Show system status'];
    }
    if (usedTools.has('analyzeOrphans') || usedTools.has('analyzeGraphHealth')) {
      return ['Triage flagged items', 'Find missing data', 'Run data quality workflow'];
    }
    if (usedTools.has('triggerWorkflow')) {
      return ['Show workflow status', 'List recent workflows', 'Show system status'];
    }

    // Default suggestions
    return ['What is the system status?', 'Show pending approvals', 'Analyze graph health'];
  }

  /**
   * Save conversation to LibSQL memory (with truncation to prevent bloat)
   */
  private async saveToMemory(): Promise<void> {
    const db = getLibSQLClient();

    try {
      // Truncate messages before saving to prevent memory bloat
      const recentMessages = this.conversationHistory.slice(-10).map(msg => ({
        ...msg,
        // Truncate long content when persisting
        content: msg.content.length > 5000
          ? msg.content.substring(0, 5000) + '\n\n[... truncated ...]'
          : msg.content,
        // Don't persist full tool call results - just the tool names
        toolCalls: msg.toolCalls?.map(tc => ({
          tool: tc.tool,
          result: typeof tc.result === 'object' ? '[result data]' : tc.result,
        })),
      }));

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
        sql: `SELECT content FROM agent_memory WHERE agent_name = ? AND memory_type = ?`,
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

// ============================================================================
// System Status
// ============================================================================

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

async function getSystemStatus(): Promise<SystemStatus> {
  const client = getMemgraphClient();
  const db = getLibSQLClient();

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

    const analyst = getAnalystAgent();
    const orphanAnalysis = await analyst.analyzeOrphans();
    orphanCount = orphanAnalysis.data.orphanCount;
  } catch {
    memgraphConnected = false;
  }

  const workflowResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM workflow_runs WHERE status = 'running'`,
    args: [],
  });
  const workflowsRunning = (workflowResult.rows[0]?.count as number) ?? 0;

  const approvalResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`,
    args: [],
  });
  const pendingApprovals = (approvalResult.rows[0]?.count as number) ?? 0;

  const latestRuns = await getLatestRuns();
  const auditSummary = await getTodaySummary();

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
      duplicatesDetected: 0,
      mergesExecuted24h: auditSummary.merges,
      deletions24h: auditSummary.deletes,
    },
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Read-Only Query Execution
// ============================================================================

async function executeReadOnlyQuery(query: string): Promise<{ rows: unknown[]; error?: string }> {
  const client = getMemgraphClient();

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

// ============================================================================
// Singleton Instance
// ============================================================================

let headGardenerInstance: HeadGardenerAgent | null = null;

export function getHeadGardenerAgent(): HeadGardenerAgent {
  if (!headGardenerInstance) {
    headGardenerInstance = new HeadGardenerAgent();
  }
  return headGardenerInstance;
}

export default HeadGardenerAgent;
