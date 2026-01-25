/**
 * POST /api/init - Initialize the database schema
 * Run once on first deployment
 */

import { NextResponse } from 'next/server';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { getLibSQLClient } from '@/lib/db';

const SCHEMA = `
-- Drop existing tables to ensure clean schema (safe for dev/testing)
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS semantic_memory;
DROP TABLE IF EXISTS episodic_memory;
DROP TABLE IF EXISTS working_memory;
DROP TABLE IF EXISTS gardening_issues;
DROP TABLE IF EXISTS correction_rules;
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS workflow_runs;

-- Workflow Runs Table
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  triggered_by TEXT NOT NULL DEFAULT 'system',
  started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  completed_at TEXT,
  result_summary TEXT,
  context TEXT,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Approval Requests Table
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  issue_id TEXT,
  proposed_action TEXT NOT NULL,
  candidates TEXT NOT NULL,
  reasoning TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT,
  resolution_notes TEXT,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
);

-- Correction Rules Table
CREATE TABLE IF NOT EXISTS correction_rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  condition_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  times_applied INTEGER DEFAULT 0,
  last_applied TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  active INTEGER DEFAULT 1
);

-- Gardening Issues Table
CREATE TABLE IF NOT EXISTS gardening_issues (
  id TEXT PRIMARY KEY,
  issue_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT,
  affected_nodes TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL,
  workflow_run_id TEXT,
  graph_context TEXT,
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
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

-- Audit Log Table
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  workflow_run_id TEXT,
  workflow_type TEXT,
  reasoning TEXT,
  before_state TEXT,
  after_state TEXT,
  metadata TEXT DEFAULT '{}'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_name ON workflow_runs(workflow_name);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow ON approval_requests(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_correction_rules_active ON correction_rules(active);
CREATE INDEX IF NOT EXISTS idx_correction_rules_type ON correction_rules(type);
CREATE INDEX IF NOT EXISTS idx_gardening_issues_status ON gardening_issues(status);
CREATE INDEX IF NOT EXISTS idx_gardening_issues_type ON gardening_issues(issue_type);
CREATE INDEX IF NOT EXISTS idx_episodic_memory_type ON episodic_memory(type);
CREATE INDEX IF NOT EXISTS idx_episodic_memory_timestamp ON episodic_memory(timestamp);
CREATE INDEX IF NOT EXISTS idx_semantic_memory_category ON semantic_memory(category);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_id);
`;

export async function POST() {
  try {
    const db = getLibSQLClient();

    // Split schema into individual statements
    const statements = SCHEMA
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    let created = 0;
    for (const sql of statements) {
      await db.execute({ sql: sql + ';', args: [] });
      created++;
    }

    return NextResponse.json({
      success: true,
      message: `Database initialized successfully`,
      statementsExecuted: created,
    });
  } catch (error) {
    console.error('Error initializing database:', error);
    return NextResponse.json(
      {
        code: 'INIT_ERROR',
        message: 'Failed to initialize database',
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'POST to this endpoint to initialize the database',
  });
}
