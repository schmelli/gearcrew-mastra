/**
 * Mastra Instance Configuration
 * Central configuration for the Graph Gardening agent framework
 *
 * This module provides:
 * - Mastra instance with LibSQL storage
 * - Agent and workflow registries
 * - Shared memory context
 * - Feature flags for gradual migration
 */

import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { MASTRA_MEMORY_CONFIG } from './memory/schemas';
// Import getCorrectionRulesManager lazily to avoid circular dependency and build-time initialization
import type { CorrectionRulesManager } from './memory/correction-rules';
import { FEATURES } from '@/config/feature-flags';

// ============================================================================
// LibSQL Storage Configuration (Lazy Initialization)
// ============================================================================

let storage: LibSQLStore | null = null;

function getStorage(): LibSQLStore {
  if (!storage) {
    storage = new LibSQLStore({
      url: process.env.LIBSQL_URL ?? 'file:/data/memory.db',
    });
  }
  return storage;
}

// ============================================================================
// Mastra Instance (Lazy Initialization)
// ============================================================================

let mastraInstance: Mastra | null = null;

export function getMastra(): Mastra {
  if (!mastraInstance) {
    mastraInstance = new Mastra({
      storage: getStorage(),
    });
  }
  return mastraInstance;
}

// For backward compatibility - accessing this will throw at build time,
// so only use getMastra() in API routes
export const mastra = null as unknown as Mastra;

// ============================================================================
// Initialization
// ============================================================================

let initialized = false;

/**
 * Initialize Mastra with database schema
 */
export async function initializeMastra(): Promise<void> {
  if (initialized) {
    return;
  }

  try {
    // Execute schema creation
    // Note: LibSQLStore handles this automatically, but we log for visibility
    console.info('Mastra initialized with LibSQL storage');
    initialized = true;
  } catch (error) {
    console.error('Failed to initialize Mastra:', error);
    throw error;
  }
}

// ============================================================================
// Workflow Registry
// ============================================================================

// Workflows will be registered here after they are defined
// This allows for dynamic workflow registration and retrieval

const workflowRegistry: Map<string, unknown> = new Map();

export function registerWorkflow(name: string, workflow: unknown): void {
  workflowRegistry.set(name, workflow);
}

export function getWorkflow(name: string): unknown {
  return workflowRegistry.get(name);
}

export function listWorkflows(): string[] {
  return Array.from(workflowRegistry.keys());
}

// ============================================================================
// Agent Registry
// ============================================================================

const agentRegistry: Map<string, unknown> = new Map();

export function registerAgent(name: string, agent: unknown): void {
  agentRegistry.set(name, agent);
}

export function getAgent(name: string): unknown {
  return agentRegistry.get(name);
}

export function listAgents(): string[] {
  return Array.from(agentRegistry.keys());
}

// ============================================================================
// Exports
// ============================================================================

// ============================================================================
// LibSQL Client for Direct Access
// Re-exported from @/lib/db to avoid circular imports
// ============================================================================

export { getLibSQLClient } from '@/lib/db';

// ============================================================================
// Shared Memory Context (FR-018) with Learning System (Phase 7)
// ============================================================================

import type * as LearningModule from './memory/learning';

export interface SharedMemoryContext {
  correctionRules: CorrectionRulesManager;
  learning: typeof LearningModule;
  sessionId: string;
  startedAt: string;
}

let sharedMemory: SharedMemoryContext | null = null;

/**
 * Get or create shared memory context for agents (FR-018)
 * This provides a unified memory context that all agents can access
 * Now includes the Phase 7 Learning System
 */
export async function getSharedMemoryContext(): Promise<SharedMemoryContext> {
  if (!sharedMemory) {
    // Dynamic imports to avoid circular dependency and build-time initialization
    const { getCorrectionRulesManager } = await import('./memory/correction-rules');
    const learning = await import('./memory/learning');
    sharedMemory = {
      correctionRules: getCorrectionRulesManager(),
      learning,
      sessionId: `session-${Date.now()}`,
      startedAt: new Date().toISOString(),
    };
  }
  return sharedMemory;
}

/**
 * Reset shared memory context (for testing or session restart)
 */
export function resetSharedMemoryContext(): void {
  sharedMemory = null;
}

// ============================================================================
// V2 Agent Getters (Mastra-native)
// ============================================================================

/**
 * Get Head Gardener agent - returns v2 (Mastra) or v1 (legacy) based on feature flag
 */
export async function getHeadGardener() {
  if (FEATURES.USE_MASTRA_AGENTS) {
    const { getHeadGardenerAgentV2 } = await import('./agents/head-gardener-v2');
    return getHeadGardenerAgentV2();
  } else {
    const { getHeadGardenerAgent } = await import('./agents/head-gardener');
    return getHeadGardenerAgent();
  }
}

/**
 * Get Researcher agent - returns v2 (Mastra) or v1 (legacy) based on feature flag
 */
export async function getResearcher() {
  if (FEATURES.USE_MASTRA_AGENTS) {
    const { getResearcherAgentV2 } = await import('./agents/researcher-v2');
    return getResearcherAgentV2();
  } else {
    const { getResearcherAgent } = await import('./agents/researcher');
    return getResearcherAgent();
  }
}

// ============================================================================
// V2 Workflow Getters (Mastra-native)
// ============================================================================

/**
 * Get Morning Hygiene workflow - returns v2 (Mastra) or v1 (legacy) based on feature flag
 * Note: v1 returns a function, v2 returns a Mastra Workflow object
 * Returns a Promise that resolves to the workflow
 */
export function getMorningHygieneWorkflow(): Promise<unknown> {
  if (FEATURES.USE_MASTRA_WORKFLOWS) {
    return import('./workflows/morning-hygiene-v2').then(m => m.morningHygieneWorkflowV2);
  } else {
    return import('./workflows/morning-hygiene').then(m => m.executeMorningHygieneWorkflow);
  }
}

// ============================================================================
// Exports
// ============================================================================

export { MASTRA_MEMORY_CONFIG };

// Note: Removed broad re-exports of './tools' and './memory' to avoid circular dependencies.
// Import directly from '@/mastra/tools' or '@/mastra/memory' instead.

// Re-export feature flags
export { FEATURES } from '@/config/feature-flags';

export default mastra;
