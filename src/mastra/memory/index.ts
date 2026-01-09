/**
 * Memory Module Index
 * Exports all memory-related functionality
 */

// Schemas
export { MASTRA_MEMORY_CONFIG, LIBSQL_SCHEMA } from './schemas';
export type {
  WorkingMemory,
  EpisodicMemoryEntry,
  SemanticMemoryEntry,
} from './schemas';

// Correction Rules
export {
  CorrectionRuleTypeSchema,
  CorrectionRuleSchema,
  CorrectionRulesManager,
  getCorrectionRulesManager,
} from './correction-rules';
export type {
  CorrectionRuleType,
  CorrectionRule,
  RuleMatchResult,
} from './correction-rules';

// Learning System (Phase 7)
export {
  updateConfidenceCalibration,
  shouldAutoApprove,
  getAllCalibrations,
  recordEpisodicMemory,
  recallSimilarDecisions,
  getEntityDecisionHistory,
  learnPattern,
  findRelevantPatterns,
  getHighConfidencePatterns,
  makeInformedDecision,
  learnFromApproval,
  learnFromSuccessfulOperation,
  getLearningStatistics,
} from './learning';
export type {
  ConfidenceCalibration,
  EpisodicMemoryRecord,
  SemanticPattern,
  DecisionResult,
  ApprovalDecision,
} from './learning';
