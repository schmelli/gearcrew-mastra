/**
 * Head Gardener Agent v2
 *
 * Mastra-native implementation of the Head Gardener agent.
 * Uses Mastra Agent class with Memory integration and all migrated tools.
 *
 * Migration from: head-gardener.ts (Vercel AI SDK tool() pattern)
 * To: Mastra Agent class with createTool() pattern
 */

import { Agent } from '@mastra/core/agent';
import { headGardenerToolkit } from '../tools';
import { registerAgent } from '../index';
// Note: Memory integration pending @mastra/memory package version alignment
// import { getConversationMemory } from '../memory/mastra-memory';

// ============================================================================
// Model Configuration - Vercel AI Gateway
// ============================================================================

// Using Vercel AI Gateway for cost-effective model access
// Gemini 3 Flash: Fast, efficient, pro-grade reasoning at flash-level latency
// 30% less tokens and 3x faster than Gemini 2.5
// Gateway URL format: https://ai-gateway.vercel.sh/v1
const VERCEL_AI_GATEWAY_MODEL = {
  url: process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v1',
  id: 'google/gemini-3-flash' as const,
  apiKey: process.env.AI_GATEWAY_API_KEY ?? '',
};

// ============================================================================
// System Prompt
// ============================================================================

const SYSTEM_PROMPT = `You are the Head Gardener, a conversational AI assistant that manages a graph database of outdoor gear products. You coordinate a team of specialized agents:

- **Analyst**: For graph analysis, orphan detection, supernode identification, schema validation, and triage
- **Researcher**: For web research to find missing product data (technologies, usage scenarios, feedback patterns)
- **Curator**: For executing all graph modifications (enrichment, merges, deletions)
- **Resolver**: For handling duplicate detection and merging decisions

You have access to various tools to help manage the graph. When users ask questions, use your tools to gather information and provide helpful responses.

## Available Tools

### System Status
- **getSystemStatus**: Get overall health including workflows, approvals, graph metrics
- **getWorkflowStatus**: Check status of a specific workflow run
- **listRecentWorkflows**: List recent workflow runs with optional filtering

### Approvals
- **getPendingApprovals**: List pending decisions awaiting human review
- **approveItems**: Approve items by their index position
- **rejectItems**: Reject items by their index position
- **approveByConfidence**: Auto-approve all items above a confidence threshold
- **getAuditSummary**: Get summary of today's actions

### Analysis
- **analyzeGraphHealth**: Comprehensive health check (orphans, supernodes, violations)
- **analyzeOrphans**: Detect and classify orphan nodes
- **detectSupernodes**: Find nodes with unusually high connections
- **triageItems**: Get prioritized list of items needing attention
- **findMissingData**: Find nodes that could benefit from enrichment

### Workflows
- **triggerWorkflow**: Manually start a workflow (morning-hygiene, deep-deduplication, etc.)
- **listAvailableWorkflows**: Show all available workflows and their descriptions

### Graph
- **queryGraph**: Execute read-only Cypher queries

### Research
- **researchItem**: Use the Researcher to gather comprehensive product data

## Guidelines

1. Always be helpful and explain what you're doing
2. For approval actions, clearly state what will be approved/rejected
3. For destructive operations, confirm with the user first
4. Provide concrete suggestions for next steps
5. Keep responses concise but informative
6. Use markdown formatting for readability
7. Follow any correction rules from the Learning System
8. Reference past decisions when relevant`;

// ============================================================================
// Agent Configuration
// ============================================================================

let headGardenerAgentInstance: Agent | null = null;

/**
 * Get the Head Gardener Agent instance (lazy initialization)
 */
export function getHeadGardenerAgentV2(): Agent {
  if (!headGardenerAgentInstance) {
    // Use Gemini 3 Flash via Vercel AI Gateway
    // Excellent for tool calling, very fast and cost-effective
    // Pro-grade reasoning at flash-level latency
    headGardenerAgentInstance = new Agent({
      id: 'head-gardener-v2',
      name: 'Head Gardener',
      instructions: SYSTEM_PROMPT,
      model: VERCEL_AI_GATEWAY_MODEL,
      tools: headGardenerToolkit,
      // Note: Memory integration pending @mastra/memory package version alignment
      // memory: getConversationMemory(),
    });

    // Register with the agent registry
    registerAgent('head-gardener-v2', headGardenerAgentInstance);
  }

  return headGardenerAgentInstance;
}

// ============================================================================
// Convenience Types and Interfaces
// ============================================================================

export interface ChatOptions {
  threadId?: string;
  resourceId?: string;
  memoryOptions?: {
    lastMessages?: number;
    semanticRecall?: {
      topK?: number;
      messageRange?: number | { before: number; after: number };
    };
  };
}

export interface ChatResponse {
  text: string;
  threadId?: string;
  toolCalls?: Array<{
    toolName: string;
    args: unknown;
    result: unknown;
  }>;
}

// ============================================================================
// High-Level API
// ============================================================================

/**
 * Send a message to the Head Gardener and get a response.
 *
 * @param message - The user's message
 * @param options - Optional chat configuration (threadId, resourceId, memoryOptions)
 * @returns The agent's response with tool call details
 */
export async function chat(message: string, options?: ChatOptions): Promise<ChatResponse> {
  const agent = getHeadGardenerAgentV2();

  const response = await agent.generate(message, {
    threadId: options?.threadId,
    resourceId: options?.resourceId ?? 'default-user',
  });

  return {
    text: response.text,
    threadId: options?.threadId,
    toolCalls: response.toolResults?.map(tr => ({
      toolName: tr.payload.toolName,
      args: tr.payload.args,
      result: tr.payload.result,
    })),
  };
}

/**
 * Stream a response from the Head Gardener.
 *
 * @param message - The user's message
 * @param options - Optional chat configuration
 * @returns An async iterator of text chunks
 */
export async function streamChat(message: string, options?: ChatOptions) {
  const agent = getHeadGardenerAgentV2();

  const stream = await agent.stream(message, {
    threadId: options?.threadId,
    resourceId: options?.resourceId ?? 'default-user',
  });

  return stream;
}

// ============================================================================
// Exports
// ============================================================================

export { headGardenerToolkit };
export default getHeadGardenerAgentV2;
