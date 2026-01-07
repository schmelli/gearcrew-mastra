/**
 * Mastra Instance Configuration
 * Central configuration for the Graph Gardening agent framework
 */

import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { createClient } from '@libsql/client';
import { MASTRA_MEMORY_CONFIG } from './memory/schemas';
// Import getCorrectionRulesManager lazily to avoid circular dependency and build-time initialization
import type { CorrectionRulesManager } from './memory/correction-rules';

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
// ============================================================================

let libsqlClient: ReturnType<typeof createClient> | null = null;

export function getLibSQLClient(): ReturnType<typeof createClient> {
  if (!libsqlClient) {
    libsqlClient = createClient({
      url: process.env.LIBSQL_URL ?? 'file:/data/memory.db',
    });
  }
  return libsqlClient;
}

// ============================================================================
// Shared Memory Context (FR-018)
// ============================================================================

export interface SharedMemoryContext {
  correctionRules: CorrectionRulesManager;
  sessionId: string;
  startedAt: string;
}

let sharedMemory: SharedMemoryContext | null = null;

/**
 * Get or create shared memory context for agents (FR-018)
 * This provides a unified memory context that all agents can access
 */
export async function getSharedMemoryContext(): Promise<SharedMemoryContext> {
  if (!sharedMemory) {
    // Dynamic import to avoid circular dependency and build-time initialization
    const { getCorrectionRulesManager } = await import('./memory/correction-rules');
    sharedMemory = {
      correctionRules: getCorrectionRulesManager(),
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
// Exports
// ============================================================================

export { MASTRA_MEMORY_CONFIG };
export default mastra;
