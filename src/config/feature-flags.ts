/**
 * Feature Flags for Gradual Migration
 *
 * These flags allow switching between legacy and Mastra-native implementations
 * during the migration period.
 */

export const FEATURES = {
  /**
   * Use Mastra Agent class for Head Gardener
   * When true: Uses head-gardener-v2.ts with Mastra Agent
   * When false: Uses legacy head-gardener.ts with Vercel AI SDK
   * Default: true (V2 is now the standard)
   */
  USE_MASTRA_AGENTS: process.env.USE_MASTRA_AGENTS !== 'false',

  /**
   * Use Mastra createWorkflow() for workflows
   * When true: Uses *-v2.ts workflow files with createWorkflow()
   * When false: Uses legacy workflow implementations
   * Default: true (V2 is now the standard)
   */
  USE_MASTRA_WORKFLOWS: process.env.USE_MASTRA_WORKFLOWS !== 'false',

  /**
   * Use Mastra Memory for conversation management
   * When true: Uses Mastra Memory with thread management
   * When false: Uses legacy LibSQL direct queries
   * Default: false (Memory package not yet compatible with @mastra/core 0.24.x)
   */
  USE_MASTRA_MEMORY: process.env.USE_MASTRA_MEMORY === 'true',
} as const;

/**
 * Helper to check if all Mastra features are enabled
 */
export function isFullMastraMode(): boolean {
  return FEATURES.USE_MASTRA_AGENTS &&
    FEATURES.USE_MASTRA_WORKFLOWS &&
    FEATURES.USE_MASTRA_MEMORY;
}

/**
 * Log current feature flag status
 */
export function logFeatureFlags(): void {
  console.info('Feature Flags:', {
    USE_MASTRA_AGENTS: FEATURES.USE_MASTRA_AGENTS,
    USE_MASTRA_WORKFLOWS: FEATURES.USE_MASTRA_WORKFLOWS,
    USE_MASTRA_MEMORY: FEATURES.USE_MASTRA_MEMORY,
    fullMastraMode: isFullMastraMode(),
  });
}
