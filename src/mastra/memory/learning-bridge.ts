/**
 * Learning System Bridge
 *
 * Memory Processor that connects the existing Learning System (Phase 7)
 * with Mastra's Memory system.
 *
 * This processor injects:
 * - Active correction rules as system context
 * - Relevant episodic memories for entity context
 * - Semantic patterns for inference
 */

import type { CoreMessage } from 'ai';

// ============================================================================
// Learning System Processor
// ============================================================================

interface ProcessorContext {
  threadId?: string;
  resourceId?: string;
  entityId?: string;
}

/**
 * Memory Processor Interface
 * Defines the contract for processors that can modify messages before/after LLM
 */
export interface MemoryProcessor {
  name: string;
  processInput?(messages: CoreMessage[], context?: ProcessorContext): Promise<CoreMessage[]>;
  processOutput?(messages: CoreMessage[], context?: ProcessorContext): Promise<CoreMessage[]>;
}

/**
 * Memory processor that bridges the Learning System with Mastra Memory.
 *
 * On input processing (before LLM):
 * - Injects active correction rules as system context
 * - Adds relevant past decisions for entity context
 * - Includes applicable semantic patterns
 *
 * On output processing (after LLM):
 * - Can record new decisions to episodic memory
 * - Can trigger pattern learning from responses
 */
export const learningSystemProcessor: MemoryProcessor = {
  name: 'learning-system-bridge',

  /**
   * Process messages before they are sent to the LLM.
   * Injects learning system context.
   */
  async processInput(messages: CoreMessage[], context?: ProcessorContext): Promise<CoreMessage[]> {
    // Dynamic import to avoid circular dependency
    const { getCorrectionRulesManager } = await import('./correction-rules');

    const rulesManager = getCorrectionRulesManager();
    await rulesManager.loadRules();

    // Build context additions
    const contextParts: string[] = [];

    // Add active correction rules
    const activeRules = await rulesManager.getActiveRules();
    if (activeRules.length > 0) {
      contextParts.push('## Active Correction Rules');
      contextParts.push('These rules have been learned from past feedback and should be followed:');
      for (const rule of activeRules.slice(0, 10)) {
        contextParts.push(`- **${rule.name}** (${rule.type}): ${rule.description || 'No description'}`);
        if (rule.action.type === 'block') {
          contextParts.push(`  → Action: Block/Reject`);
        } else if (rule.action.type === 'require_approval') {
          contextParts.push(`  → Action: Require human approval`);
        }
      }
      contextParts.push('');
    }

    // Add relevant episodic memories if we have an entity context
    if (context?.entityId) {
      const episodicMemories = await getRelevantEpisodicMemories(context.entityId, 5);
      if (episodicMemories.length > 0) {
        contextParts.push('## Past Decisions for This Entity');
        for (const memory of episodicMemories) {
          const outcome = memory.outcomeSuccessful !== undefined
            ? (memory.outcomeSuccessful ? '✓' : '✗')
            : '?';
          contextParts.push(`- ${memory.actionType}: ${memory.decision} ${outcome}`);
          if (memory.reasoning) {
            contextParts.push(`  Reason: ${memory.reasoning}`);
          }
        }
        contextParts.push('');
      }
    }

    // Add applicable semantic patterns
    const patterns = await getApplicablePatterns();
    if (patterns.length > 0) {
      contextParts.push('## Learned Patterns');
      contextParts.push('These patterns have been learned from the data:');
      for (const pattern of patterns.slice(0, 5)) {
        contextParts.push(`- If ${pattern.conditionField}="${pattern.conditionValue}" → ${pattern.inferenceField}="${pattern.inferenceValue}" (confidence: ${(pattern.confidence * 100).toFixed(0)}%)`);
      }
      contextParts.push('');
    }

    // If we have context to add, prepend it as a system message
    if (contextParts.length > 0) {
      const learningContext: CoreMessage = {
        role: 'system',
        content: `# Learning System Context\n\n${contextParts.join('\n')}`,
      };

      // Insert after any existing system messages
      const systemMessageIndex = messages.findIndex(m => m.role !== 'system');
      if (systemMessageIndex === -1) {
        // All messages are system messages, append at end
        return [...messages, learningContext];
      } else if (systemMessageIndex === 0) {
        // No system messages, prepend
        return [learningContext, ...messages];
      } else {
        // Insert after last system message
        return [
          ...messages.slice(0, systemMessageIndex),
          learningContext,
          ...messages.slice(systemMessageIndex),
        ];
      }
    }

    return messages;
  },

  /**
   * Process messages after LLM response.
   * Can be used to record decisions or trigger learning.
   */
  async processOutput(messages: CoreMessage[], _context?: ProcessorContext): Promise<CoreMessage[]> {
    // Currently, we don't modify output messages
    // Future: Could analyze responses to trigger learning
    return messages;
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get relevant episodic memories for an entity
 */
export async function getRelevantEpisodicMemories(
  entityId: string,
  limit: number = 5
): Promise<Array<{
  actionType: string;
  decision: string;
  reasoning?: string;
  outcomeSuccessful?: boolean;
}>> {
  const { getLibSQLClient } = await import('../index');
  const db = getLibSQLClient();

  try {
    const result = await db.execute({
      sql: `
        SELECT action_type, decision, reasoning, outcome_successful
        FROM episodic_memory
        WHERE entity_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `,
      args: [entityId, limit],
    });

    return result.rows.map(row => ({
      actionType: row.action_type as string,
      decision: row.decision as string,
      reasoning: row.reasoning as string | undefined,
      outcomeSuccessful: row.outcome_successful === null
        ? undefined
        : (row.outcome_successful as number) === 1,
    }));
  } catch {
    // Table might not exist yet
    return [];
  }
}

/**
 * Get applicable semantic patterns
 */
export async function getApplicablePatterns(): Promise<Array<{
  conditionField: string;
  conditionValue: string;
  inferenceField: string;
  inferenceValue: string;
  confidence: number;
}>> {
  const { getLibSQLClient } = await import('../index');
  const db = getLibSQLClient();

  try {
    const result = await db.execute({
      sql: `
        SELECT condition_field, condition_value, inference_field, inference_value, confidence
        FROM semantic_patterns
        WHERE confidence >= 0.7
        ORDER BY confidence DESC, supporting_evidence DESC
        LIMIT 10
      `,
      args: [],
    });

    return result.rows.map(row => ({
      conditionField: row.condition_field as string,
      conditionValue: row.condition_value as string,
      inferenceField: row.inference_field as string,
      inferenceValue: row.inference_value as string,
      confidence: row.confidence as number,
    }));
  } catch {
    // Table might not exist yet
    return [];
  }
}

export default learningSystemProcessor;
