/**
 * LibSQL Storage Configuration for Mastra
 * Implements persistent workflow state and memory per research.md
 */

import { z } from 'zod';

// ============================================================================
// Memory Schemas for Mastra's Three-Layer Memory System
// ============================================================================

/**
 * Working Memory - Current context and immediate state
 */
export const WorkingMemorySchema = z.object({
  currentWorkflowId: z.string().uuid().optional(),
  currentStepId: z.string().optional(),
  pendingApprovals: z.array(z.string().uuid()),
  lastActivityAt: z.string().datetime(),
  sessionContext: z.record(z.unknown()),
});
export type WorkingMemory = z.infer<typeof WorkingMemorySchema>;

/**
 * Episodic Memory - Past workflow runs and decisions
 */
export const EpisodicMemoryEntrySchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['workflow_completed', 'decision_made', 'error_occurred', 'pattern_learned']),
  timestamp: z.string().datetime(),
  workflowType: z.string().optional(),
  summary: z.string(),
  entities: z.array(z.string()),
  outcome: z.enum(['success', 'failure', 'pending']),
  metadata: z.record(z.unknown()),
});
export type EpisodicMemoryEntry = z.infer<typeof EpisodicMemoryEntrySchema>;

/**
 * Semantic Memory - Learned patterns and correction rules
 */
export const SemanticMemoryEntrySchema = z.object({
  id: z.string().uuid(),
  category: z.enum(['correction_rule', 'entity_pattern', 'workflow_pattern']),
  content: z.string(),
  embedding: z.array(z.number()).optional(),
  confidence: z.number().min(0).max(1),
  usageCount: z.number().default(0),
  lastUsedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()),
});
export type SemanticMemoryEntry = z.infer<typeof SemanticMemoryEntrySchema>;

// ============================================================================
// LibSQL Table Schemas (for Mastra configuration)
// ============================================================================

/**
 * SQL schema for workflow state persistence
 */
export const LIBSQL_SCHEMA = `
-- Workflow Runs Table
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT,
  statistics TEXT NOT NULL DEFAULT '{}',
  suspended_steps TEXT,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Approval Requests Table
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  proposed_action TEXT NOT NULL,
  candidates TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
);

-- Correction Rules Table
CREATE TABLE IF NOT EXISTS correction_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  description TEXT NOT NULL,
  source_decision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  active INTEGER DEFAULT 1,
  FOREIGN KEY (source_decision_id) REFERENCES approval_requests(id)
);

-- Gardening Issues Table
CREATE TABLE IF NOT EXISTS gardening_issues (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  entities TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  graph_context TEXT,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
);

-- Working Memory Table
CREATE TABLE IF NOT EXISTS working_memory (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  current_workflow_id TEXT,
  current_step_id TEXT,
  pending_approvals TEXT DEFAULT '[]',
  last_activity_at TEXT,
  session_context TEXT DEFAULT '{}'
);

-- Episodic Memory Table
CREATE TABLE IF NOT EXISTS episodic_memory (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  workflow_type TEXT,
  summary TEXT NOT NULL,
  entities TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- Semantic Memory Table
CREATE TABLE IF NOT EXISTS semantic_memory (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  confidence REAL NOT NULL,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- Confidence Calibration Table (Phase 7: Learning System)
CREATE TABLE IF NOT EXISTS confidence_calibration (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  historical_accuracy REAL NOT NULL DEFAULT 0.5,
  sample_size INTEGER NOT NULL DEFAULT 0,
  adjusted_threshold REAL NOT NULL DEFAULT 0.85,
  last_updated TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, action_type)
);

-- Enhanced Episodic Memory Table (replaces basic version)
DROP TABLE IF EXISTS episodic_memory;
CREATE TABLE IF NOT EXISTS episodic_memory (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('auto_approved', 'human_approved', 'human_rejected', 'skipped')),
  workflow_run_id TEXT,
  confidence REAL,
  reasoning TEXT,
  outcome_successful INTEGER,
  outcome_notes TEXT,
  metadata TEXT DEFAULT '{}'
);

-- Semantic Patterns Table (for learned conventions)
CREATE TABLE IF NOT EXISTS semantic_patterns (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL CHECK(pattern_type IN ('brand_convention', 'category_default', 'naming_pattern', 'relationship_rule', 'field_inference')),
  condition_field TEXT NOT NULL,
  condition_value TEXT NOT NULL,
  inference_field TEXT NOT NULL,
  inference_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  supporting_evidence INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Firecrawl Response Cache Table
CREATE TABLE IF NOT EXISTS firecrawl_cache (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL UNIQUE,
  query_text TEXT NOT NULL,
  response_json TEXT NOT NULL,
  source_urls TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Config Cache Table (for ProductTypes, etc.)
CREATE TABLE IF NOT EXISTS config_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_type ON workflow_runs(workflow_type);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow ON approval_requests(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_correction_rules_active ON correction_rules(active);
CREATE INDEX IF NOT EXISTS idx_correction_rules_type ON correction_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_gardening_issues_status ON gardening_issues(status);
CREATE INDEX IF NOT EXISTS idx_gardening_issues_type ON gardening_issues(type);
CREATE INDEX IF NOT EXISTS idx_episodic_memory_type ON episodic_memory(action_type);
CREATE INDEX IF NOT EXISTS idx_episodic_memory_timestamp ON episodic_memory(timestamp);
CREATE INDEX IF NOT EXISTS idx_episodic_memory_entity ON episodic_memory(entity_name);
CREATE INDEX IF NOT EXISTS idx_semantic_memory_category ON semantic_memory(category);
CREATE INDEX IF NOT EXISTS idx_confidence_calibration_agent ON confidence_calibration(agent_id, action_type);
CREATE INDEX IF NOT EXISTS idx_semantic_patterns_type ON semantic_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_semantic_patterns_condition ON semantic_patterns(condition_field, condition_value);
CREATE INDEX IF NOT EXISTS idx_firecrawl_cache_hash ON firecrawl_cache(query_hash);
CREATE INDEX IF NOT EXISTS idx_firecrawl_cache_expires ON firecrawl_cache(expires_at);
`;

/**
 * Mastra Memory configuration for LibSQL
 */
export const MASTRA_MEMORY_CONFIG = {
  provider: 'libsql' as const,
  options: {
    url: process.env.LIBSQL_URL ?? 'file:/data/memory.db',
  },
  schema: LIBSQL_SCHEMA,
};

export default MASTRA_MEMORY_CONFIG;
