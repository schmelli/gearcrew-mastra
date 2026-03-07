/**
 * Mastra Memory Configuration
 *
 * Note: Full Memory integration requires @mastra/memory package which has a
 * version conflict with current @mastra/core (0.24.x vs 1.x requirement).
 *
 * This module provides memory-related configuration that can be used
 * once the packages are aligned, or with manual thread management.
 */

import { LibSQLStore, LibSQLVector } from '@mastra/libsql';

// ============================================================================
// Memory Configuration
// ============================================================================

const MEMORY_DB_URL = process.env.LIBSQL_URL ?? 'file:/data/memory.db';

/**
 * Working Memory Template for Head Gardener sessions
 *
 * This template defines the structured information the agent should maintain
 * throughout a conversation session.
 */
const WORKING_MEMORY_TEMPLATE = `# Session Context

## Current User
- User ID:
- Preferences:
- Communication Style:

## Active Workflow
- Workflow Name:
- Run ID:
- Status:
- Started At:

## Recent Decisions
- Last Approval Action:
- Items Approved Count:
- Items Rejected Count:

## Graph State
- Total Nodes:
- Pending Approvals:
- Health Status:
- Last Hygiene Run:

## Session Notes
- Current Task:
- Open Questions:
- Action Items:

## User Preferences
- Confidence Threshold:
- Auto-approve Setting:
- Notification Preferences:
`;

// ============================================================================
// Storage Configuration (for future Memory integration)
// ============================================================================

let storageInstance: LibSQLStore | null = null;
let vectorInstance: LibSQLVector | null = null;

/**
 * Get the LibSQL storage instance for conversation persistence.
 */
export function getStorage(): LibSQLStore {
  if (!storageInstance) {
    storageInstance = new LibSQLStore({
      url: MEMORY_DB_URL,
    });
  }
  return storageInstance;
}

/**
 * Get the LibSQL vector instance for semantic search.
 */
export function getVector(): LibSQLVector {
  if (!vectorInstance) {
    vectorInstance = new LibSQLVector({
      connectionUrl: MEMORY_DB_URL,
    });
  }
  return vectorInstance;
}

// ============================================================================
// Memory Configuration for Agents
// ============================================================================

/**
 * Memory configuration options for the Head Gardener agent.
 *
 * Note: These options are prepared for when Memory package becomes available.
 * Currently, agents operate without persistent memory.
 */
export const conversationMemoryConfig = {
  lastMessages: 20,
  semanticRecall: {
    topK: 5,
    messageRange: {
      before: 2,
      after: 1,
    },
  },
  workingMemory: {
    enabled: true,
    template: WORKING_MEMORY_TEMPLATE,
  },
  threads: {
    generateTitle: true,
  },
};

// ============================================================================
// Research Memory Configuration
// ============================================================================

const RESEARCH_WORKING_MEMORY_TEMPLATE = `# Research Session

## Current Research
- Product Name:
- Node ID:
- Brand:
- Category:

## Search Progress
- Queries Executed:
- Sources Found:
- Data Quality:

## Findings
- Fields Found:
- Confidence:
- Conflicting Data:

## Session Notes
- Search Strategy:
- Next Steps:
`;

/**
 * Memory configuration options for the Researcher agent.
 */
export const researchMemoryConfig = {
  lastMessages: 10,
  semanticRecall: {
    topK: 3,
    messageRange: {
      before: 1,
      after: 1,
    },
  },
  workingMemory: {
    enabled: true,
    template: RESEARCH_WORKING_MEMORY_TEMPLATE,
  },
};

// ============================================================================
// Placeholder Functions
// ============================================================================

/**
 * Placeholder for conversation memory.
 * Returns undefined until @mastra/memory is available with compatible version.
 */
export function getConversationMemory(): undefined {
  // Memory integration pending version alignment
  return undefined;
}

/**
 * Placeholder for research memory.
 * Returns undefined until @mastra/memory is available with compatible version.
 */
export function getResearchMemory(): undefined {
  // Memory integration pending version alignment
  return undefined;
}

// ============================================================================
// Exports
// ============================================================================

export {
  WORKING_MEMORY_TEMPLATE,
  RESEARCH_WORKING_MEMORY_TEMPLATE,
  MEMORY_DB_URL,
};
